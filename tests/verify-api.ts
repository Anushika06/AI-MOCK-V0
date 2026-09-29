/**
 * Application API end to end (Fastify inject, real database), as the single
 * local user: mock generation API, exam-taking, server-authoritative deadline,
 * deterministic scoring, results, history, question flags, practice and timing.
 */
import assert from 'node:assert';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import { db, pool } from '../src/db/index.js';
import {
  attempts, attemptAnswers, mocks, mockQuestions, questionFlags, questions, users,
} from '../src/db/schema.js';
import { createJobExecutionService } from '../src/modules/generation/container.js';
import { DemoQuestionWriter } from '../src/modules/generation/llm/offline.writers.js';
import { LOCAL_USER_EMAIL } from '../src/modules/users/current-user.js';
import { attemptService } from '../src/modules/attempts/attempt.service.js';
import { examProfileService } from '../src/modules/exams/exam.service.js';

type Opt = 'A' | 'B' | 'C' | 'D';
const wrongOf = (o: string): Opt => (o === 'A' ? 'B' : 'A');

async function runTests() {
  const app = await buildApp();
  const profile = await examProfileService.getActiveExamProfile('super-tet-primary');
  // This suite tests the API, not the bank: let the demo writer produce whole papers.
  const executor = createJobExecutionService({ writer: new DemoQuestionWriter() }, { newPerMock: 120, maxNewPerMock: 120, maxCallsPerMock: 12 });

  // There is no sign-in: every request acts as the local user.
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({
      method: method as any,
      url,
      ...(payload !== undefined ? { payload: payload as any } : {}),
    });
    return { status: res.statusCode, body: res.body ? res.json() : null, raw: res.body };
  };

  /** Moves an attempt's window into the past so its deadline has passed. */
  const expire = (attemptId: string) => db.update(attempts)
    .set({ startedAt: sql`now() - interval '5 hours'`, deadlineAt: sql`now() - interval '1 minute'` })
    .where(eq(attempts.id, attemptId));

  try {
    console.log('Starting API verification...');

    // ── Local user ────────────────────────────────────────────────────────────
    console.log('Test 1: No sign-in — every request acts as the one local user...');
    const list0 = await call('GET', '/api/mocks');
    assert.strictEqual(list0.status, 200);
    const [local] = await db.select().from(users).where(eq(users.email, LOCAL_USER_EMAIL));
    assert.ok(local, 'local user created on first request');
    await call('GET', '/api/mocks');
    assert.strictEqual((await db.select().from(users).where(eq(users.email, LOCAL_USER_EMAIL))).length, 1, 'same local user every time');
    assert.strictEqual((await call('GET', '/api/health')).status, 200);
    assert.strictEqual((await call('GET', '/api/exams/super-tet-primary')).body.totalQuestions, profile.totalQuestions);
    assert.strictEqual((await call('GET', '/api/auth/me')).status, 404, 'no account endpoints');
    console.log('  ✅ Test 1 passed');

    // ── Mock generation API ───────────────────────────────────────────────────
    console.log('Test 2: Create mock, progress, READY...');
    assert.strictEqual((await call('POST', '/api/mocks', { language: 'fr' })).status, 400);
    const created = await call('POST', '/api/mocks', { title: 'API mock', language: 'en' });
    assert.strictEqual(created.status, 202);
    assert.strictEqual(created.body.status, 'GENERATING');
    assert.strictEqual(created.body.language, 'en');
    assert.strictEqual(created.body.exam.totalQuestions, profile.totalQuestions);
    const mockId: string = created.body.id;

    const progress = await call('GET', `/api/mocks/${mockId}/generation`);
    assert.strictEqual(progress.status, 200);
    assert.strictEqual(progress.body.generation.status, 'PENDING');
    assert.deepStrictEqual(progress.body.subjects.map((s: any) => s.subject), profile.sectionsConfig.map((s) => s.name));

    assert.strictEqual((await call('POST', `/api/mocks/${mockId}/attempts`)).body.code, 'MOCK_NOT_READY');
    assert.strictEqual((await call('GET', '/api/mocks/not-a-uuid')).status, 400);

    await executor.executeJob(progress.body.generation.jobId);

    const ready = await call('GET', `/api/mocks/${mockId}`);
    assert.strictEqual(ready.body.status, 'READY');
    assert.strictEqual(ready.body.generation.percent, 100);
    assert.strictEqual(ready.body.sections.reduce((n: number, s: any) => n + s.questionCount, 0), profile.totalQuestions);
    const list = await call('GET', '/api/mocks');
    assert.ok(list.body.mocks.some((m: any) => m.id === mockId && m.status === 'READY'));
    assert.strictEqual((await call('POST', `/api/mocks/${mockId}/generation/retry`)).body.code, 'GENERATION_NOT_FAILED');
    console.log('  ✅ Test 2 passed');

    // ── Start / resume attempt; no answer leakage ─────────────────────────────
    console.log('Test 3: Start + resume attempt; questions never expose answers...');
    const start = await call('POST', `/api/mocks/${mockId}/attempts`);
    assert.strictEqual(start.status, 201);
    const attemptId: string = start.body.attempt.id;
    const durationMs = new Date(start.body.attempt.deadlineAt).getTime() - new Date(start.body.attempt.startedAt).getTime();
    assert.strictEqual(durationMs, profile.durationMinutes * 60_000, 'deadline = start + profile duration');
    const again = await call('POST', `/api/mocks/${mockId}/attempts`);
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.attempt.id, attemptId, 'resumes the same attempt');
    assert.strictEqual(again.body.resumed, true);

    const exam = await call('GET', `/api/attempts/${attemptId}`);
    assert.strictEqual(exam.status, 200);
    assert.strictEqual(exam.body.questions.length, profile.totalQuestions);
    const keys = new Set<string>();
    JSON.parse(exam.raw, (k, v) => { keys.add(k); return v; });
    assert.ok(![...keys].some((k) => /^(correctOption|correctAnswer|correct_option|isCorrect|is_correct|outcome)$/.test(k)),`exam payload must not contain answer keys: ${[...keys].join(',')}`);
    assert.ok(exam.body.questions.every((q: any) => q.options.length === 4));
    console.log('  ✅ Test 3 passed');

    // ── Answers ───────────────────────────────────────────────────────────────
    console.log('Test 4: Answer validation and persistence (refresh-safe)...');
    const qIds: string[] = exam.body.questions.map((q: any) => q.questionId);
    const key = new Map((await db.select({ id: questions.id, c: questions.correctOption }).from(questions)
      .where(inArray(questions.id, qIds))).map((r) => [r.id, r.c]));

    const put = (id: string, answers: unknown) => call('PUT', `/api/attempts/${id}/answers`, { answers });
    assert.strictEqual((await put(attemptId, [{ questionId: qIds[0], selectedOption: 'E' }])).status, 400);
    assert.strictEqual((await put(attemptId, [{ questionId: '00000000-0000-4000-8000-000000000000', selectedOption: 'A' }])).body.code, 'QUESTION_NOT_IN_MOCK');
    assert.strictEqual((await put(attemptId, [])).status, 400);

    // 10 correct, 5 wrong, 1 answered-then-cleared.
    const correctSet = qIds.slice(0, 10).map((id) => ({ questionId: id, selectedOption: key.get(id) }));
    const wrongSet = qIds.slice(10, 15).map((id) => ({ questionId: id, selectedOption: wrongOf(key.get(id)!) }));
    assert.strictEqual((await put(attemptId, [...correctSet, ...wrongSet])).status, 200);
    // Change of mind: answer 1 first wrong, then right (last write wins).
    await put(attemptId, [{ questionId: qIds[0], selectedOption: wrongOf(key.get(qIds[0])!) }]);
    await put(attemptId, [{ questionId: qIds[0], selectedOption: key.get(qIds[0]) }]);
    await put(attemptId, [{ questionId: qIds[15], selectedOption: 'A' }]);
    await put(attemptId, [{ questionId: qIds[15], selectedOption: null }]);

    const refreshed = await call('GET', `/api/attempts/${attemptId}`);
    assert.strictEqual(Object.keys(refreshed.body.answers).length, 15, 'saved answers survive a refresh');
    assert.strictEqual(refreshed.body.answers[qIds[0]], key.get(qIds[0]));
    assert.strictEqual(refreshed.body.answers[qIds[15]], undefined, 'cleared answer');
    assert.strictEqual((await call('GET', `/api/attempts/${attemptId}/result`)).body.code, 'ATTEMPT_IN_PROGRESS');
    console.log('  ✅ Test 4 passed');

    // ── Submit + deterministic score ──────────────────────────────────────────
    console.log('Test 5: Submit → deterministic server-side score; idempotent; closed afterwards...');
    const submit = await call('POST', `/api/attempts/${attemptId}/submit`, { score: 9999 });
    assert.strictEqual(submit.status, 200);
    const expectedScore = 10 * profile.marksPerCorrect - (profile.negativeMarking ? 5 * profile.negativeMarksPerQuestion! : 0);
    assert.strictEqual(submit.body.attempt.status, 'SUBMITTED');
    assert.strictEqual(submit.body.attempt.score, expectedScore, 'client-sent score ignored');
    assert.deepStrictEqual(
      [submit.body.attempt.totalCorrect, submit.body.attempt.totalIncorrect, submit.body.attempt.totalUnattempted],
      [10, 5, profile.totalQuestions - 15],
    );
    const resubmit = await call('POST', `/api/attempts/${attemptId}/submit`);
    assert.strictEqual(resubmit.body.alreadySubmitted, true);
    assert.strictEqual(resubmit.body.attempt.score, expectedScore);
    assert.strictEqual((await put(attemptId, [{ questionId: qIds[20], selectedOption: 'A' }])).body.code, 'ATTEMPT_CLOSED');

    const graded = await db.select().from(attemptAnswers).where(eq(attemptAnswers.attemptId, attemptId));
    for (const g of graded) {
      assert.strictEqual(g.isCorrect, g.selectedAnswer === null ? null : g.selectedAnswer === key.get(g.questionId));
    }
    console.log('  ✅ Test 5 passed');

    // ── Results ───────────────────────────────────────────────────────────────
    console.log('Test 6: Results with question-wise review...');
    const result = await call('GET', `/api/attempts/${attemptId}/result`);
    assert.strictEqual(result.status, 200);
    const s = result.body.summary;
    assert.deepStrictEqual([s.score, s.correct, s.incorrect, s.unattempted, s.attempted], [expectedScore, 10, 5, profile.totalQuestions - 15, 15]);
    assert.strictEqual(s.totalMarks, profile.totalMarks);
    assert.strictEqual(s.accuracy, 66.67);
    assert.ok(result.body.attempt.timeTakenSeconds >= 0);
    assert.strictEqual(result.body.questions.length, profile.totalQuestions);
    const q0 = result.body.questions[0];
    assert.strictEqual(q0.correctOption, key.get(q0.questionId));
    assert.strictEqual(q0.selectedOption, key.get(q0.questionId));
    assert.strictEqual(q0.outcome, 'CORRECT');
    assert.strictEqual(result.body.questions[10].outcome, 'INCORRECT');
    assert.strictEqual(result.body.questions[15].outcome, 'UNATTEMPTED');
    assert.strictEqual(result.body.sections.reduce((n: number, x: any) => n + x.total, 0), profile.totalQuestions);
    console.log('  ✅ Test 6 passed');

    // ── Flags ─────────────────────────────────────────────────────────────────
    console.log('Test 7: Question flagging...');
    const flagUrl = `/api/questions/${qIds[3]}/flag`;
    assert.strictEqual((await call('PUT', flagUrl, { reason: 'NOT_A_REASON' })).status, 400);
    const flag = await call('PUT', flagUrl, { reason: 'WRONG_ANSWER', comment: 'Option B is also right', attemptId });
    assert.strictEqual(flag.status, 200);
    assert.strictEqual(flag.body.flag.reason, 'WRONG_ANSWER');
    await call('PUT', flagUrl, { reason: 'AMBIGUOUS_QUESTION' });
    const rows = await db.select().from(questionFlags).where(eq(questionFlags.questionId, qIds[3]));
    assert.strictEqual(rows.length, 1, 're-flagging updates instead of duplicating');
    assert.strictEqual(rows[0].reason, 'AMBIGUOUS_QUESTION');
    assert.strictEqual((await db.select().from(questions).where(eq(questions.id, qIds[3])))[0].isFlagged, true);
    const flaggedResult = await call('GET', `/api/attempts/${attemptId}/result`);
    assert.strictEqual(flaggedResult.body.questions[3].flag.reason, 'AMBIGUOUS_QUESTION');
    assert.strictEqual((await call('DELETE', flagUrl)).status, 200);
    assert.strictEqual((await db.select().from(questions).where(eq(questions.id, qIds[3])))[0].isFlagged, false);
    assert.strictEqual((await call('DELETE', flagUrl)).status, 404);
    await call('PUT', flagUrl, { reason: 'TYPO_OR_TRANSLATION' }); // keep one for history view
    console.log('  ✅ Test 7 passed');

    // ── Deadline enforcement ──────────────────────────────────────────────────
    console.log('Test 8: Answers after the deadline are rejected and the attempt auto-submits...');
    const retake = await call('POST', `/api/mocks/${mockId}/attempts`);
    assert.strictEqual(retake.status, 201, 'retake creates a new attempt');
    const retakeId: string = retake.body.attempt.id;
    assert.notStrictEqual(retakeId, attemptId);
    await put(retakeId, qIds.slice(0, 3).map((id) => ({ questionId: id, selectedOption: wrongOf(key.get(id)!) })));
    await expire(retakeId);
    const late = await put(retakeId, [{ questionId: qIds[4], selectedOption: key.get(qIds[4]) }]);
    assert.strictEqual(late.status, 409);
    assert.strictEqual(late.body.code, 'ATTEMPT_CLOSED');
    const [closed] = await db.select().from(attempts).where(eq(attempts.id, retakeId));
    assert.strictEqual(closed.status, 'AUTO_SUBMITTED');
    assert.strictEqual(closed.submittedAt!.getTime(), closed.deadlineAt.getTime(), 'auto-submit time = deadline');
    const negative = profile.negativeMarking ? -3 * profile.negativeMarksPerQuestion! : 0;
    assert.strictEqual(Number(closed.score), negative, 'only pre-deadline answers count; negative scores allowed');
    assert.strictEqual(closed.totalIncorrect, 3);
    console.log('  ✅ Test 8 passed');

    console.log('Test 9: Late manual submit becomes AUTO_SUBMITTED; sweeper closes abandoned attempts...');
    const late2 = (await call('POST', `/api/mocks/${mockId}/attempts`)).body.attempt.id as string;
    await expire(late2);
    const lateSubmit = await call('POST', `/api/attempts/${late2}/submit`);
    assert.strictEqual(lateSubmit.body.attempt.status, 'AUTO_SUBMITTED', 'server, not client, decides the status');

    const abandoned = (await call('POST', `/api/mocks/${mockId}/attempts`)).body.attempt.id as string;
    await expire(abandoned);
    assert.ok((await attemptService.finalizeExpiredAttempts()) >= 1);
    const [swept] = await db.select().from(attempts).where(eq(attempts.id, abandoned));
    assert.strictEqual(swept.status, 'AUTO_SUBMITTED');
    assert.strictEqual(Number(swept.score), 0);

    // Refresh after expiry: exam endpoint reports the closed state, no questions.
    const afterExpiry = await call('GET', `/api/attempts/${abandoned}`);
    assert.strictEqual(afterExpiry.body.attempt.status, 'AUTO_SUBMITTED');
    assert.strictEqual(afterExpiry.body.questions.length, 0);
    console.log('  ✅ Test 9 passed');

    // ── History ───────────────────────────────────────────────────────────────
    console.log('Test 10: Attempt history...');
    const history = await call('GET', '/api/attempts');
    assert.strictEqual(history.body.attempts.length, 4);
    assert.ok(history.body.attempts.every((a: any) => a.status !== 'IN_PROGRESS'));
    const first = history.body.attempts.find((a: any) => a.id === attemptId);
    assert.strictEqual(first.score, expectedScore);
    assert.strictEqual(first.mock.title, 'API mock');
    assert.strictEqual(first.accuracy, 66.67);
    const detail = await call('GET', `/api/mocks/${mockId}`);
    assert.strictEqual(detail.body.attempts.length, 4);
    console.log('  ✅ Test 10 passed');

    console.log('Test 11: Concurrent generation limit...');
    const g1 = await call('POST', '/api/mocks', {});
    const g2 = await call('POST', '/api/mocks', {});
    const g3 = await call('POST', '/api/mocks', {});
    assert.deepStrictEqual([g1.status, g2.status, g3.status], [202, 202, 429]);
    console.log('  ✅ Test 11 passed');

    // ── Time per question ─────────────────────────────────────────────────────
    console.log('Test 12: Time per question — cumulative, max-wins, capped, never touches answers...');
    const timed = (await call('POST', `/api/mocks/${mockId}/attempts`)).body.attempt.id as string;
    assert.strictEqual((await put(timed, [{ questionId: qIds[0], timeSpentSeconds: 40 }])).status, 200);
    await put(timed, [{ questionId: qIds[0], selectedOption: key.get(qIds[0]) }]);
    await put(timed, [{ questionId: qIds[0], timeSpentSeconds: 10 }]); // stale retry: ignored
    await put(timed, [{ questionId: qIds[1], timeSpentSeconds: 86_400 }]); // capped to duration
    assert.strictEqual((await put(timed, [{ questionId: qIds[2], timeSpentSeconds: 100_000 }])).status, 400);
    assert.strictEqual((await put(timed, [{ questionId: qIds[2] }])).status, 400);
    const timedExam = await call('GET', `/api/attempts/${timed}`);
    assert.strictEqual(timedExam.body.timeSpent[qIds[0]], 40);
    assert.strictEqual(timedExam.body.answers[qIds[0]], key.get(qIds[0]), 'time-only saves keep the answer');
    assert.strictEqual(timedExam.body.timeSpent[qIds[1]], profile.durationMinutes * 60);
    assert.strictEqual(timedExam.body.answers[qIds[1]], undefined, 'time-only row is not an answer');
    await call('POST', `/api/attempts/${timed}/submit`);
    const timedResult = await call('GET', `/api/attempts/${timed}/result`);
    assert.strictEqual(timedResult.body.questions[0].timeSpentSeconds, 40);
    assert.strictEqual(timedResult.body.summary.trackedTimeSeconds, 40 + profile.durationMinutes * 60);
    assert.deepStrictEqual([timedResult.body.summary.correct, timedResult.body.summary.incorrect], [1, 0], 'time never affects scoring');
    assert.strictEqual(
      timedResult.body.sections.reduce((n: number, s: any) => n + s.timeSpentSeconds, 0),
      timedResult.body.summary.trackedTimeSeconds,
    );
    console.log('  ✅ Test 12 passed');

    // ── Topic analysis ────────────────────────────────────────────────────────
    console.log('Test 13: Topic-wise analysis and weak topics...');
    const topicsBody = (await call('GET', `/api/attempts/${attemptId}/result`)).body;
    assert.strictEqual(topicsBody.topics.reduce((n: number, t: any) => n + t.total, 0), profile.totalQuestions);
    assert.strictEqual(topicsBody.topics.reduce((n: number, t: any) => n + t.correct, 0), 10);
    assert.ok(topicsBody.weakTopics.length > 0 && topicsBody.weakTopics.length <= 5);
    assert.ok(topicsBody.weakTopics.every((t: any) => t.correct / t.total < 0.5));
    console.log('  ✅ Test 13 passed');

    // ── Practice sets ─────────────────────────────────────────────────────────
    console.log('Test 14: Practice set from mistakes...');
    const practice = await call('POST', `/api/attempts/${attemptId}/practice`, { scope: 'INCORRECT' });
    assert.strictEqual(practice.status, 201);
    assert.strictEqual(practice.body.questionCount, 5);
    const practiceAgain = await call('POST', `/api/attempts/${attemptId}/practice`, { scope: 'INCORRECT' });
    assert.deepStrictEqual([practiceAgain.status, practiceAgain.body.mockId], [200, practice.body.mockId], 'one practice set per attempt');
    assert.strictEqual((await call('GET', `/api/attempts/${attemptId}/result`)).body.practiceMockId, practice.body.mockId);

    const pm = await call('GET', `/api/mocks/${practice.body.mockId}`);
    assert.deepStrictEqual([pm.body.kind, pm.body.status, pm.body.sourceAttemptId], ['PRACTICE', 'READY', attemptId]);
    assert.deepStrictEqual(
      [pm.body.exam.totalQuestions, pm.body.exam.totalMarks, pm.body.exam.durationMinutes],
      [5, 5 * profile.marksPerCorrect, Math.ceil((5 * profile.durationMinutes) / profile.totalQuestions)],
    );
    const pStart = await call('POST', `/api/mocks/${practice.body.mockId}/attempts`);
    assert.strictEqual(pStart.status, 201);
    const pDuration = new Date(pStart.body.attempt.deadlineAt).getTime() - new Date(pStart.body.attempt.startedAt).getTime();
    assert.strictEqual(pDuration, pm.body.exam.durationMinutes * 60_000, 'practice deadline uses its own duration');
    const pAttempt = pStart.body.attempt.id as string;
    assert.strictEqual((await call('POST', `/api/attempts/${pAttempt}/practice`, {})).body.code, 'ATTEMPT_IN_PROGRESS');
    const pExam = await call('GET', `/api/attempts/${pAttempt}`);
    assert.deepStrictEqual(pExam.body.questions.map((q: any) => q.questionId), qIds.slice(10, 15), 'the wrong answers, in order');
    await put(pAttempt, qIds.slice(10, 15).map((id) => ({ questionId: id, selectedOption: key.get(id) })));
    await call('POST', `/api/attempts/${pAttempt}/submit`);
    const pResult = await call('GET', `/api/attempts/${pAttempt}/result`);
    assert.deepStrictEqual(
      [pResult.body.summary.score, pResult.body.summary.totalMarks, pResult.body.summary.percentage],
      [5 * profile.marksPerCorrect, 5 * profile.marksPerCorrect, 100],
    );
    assert.strictEqual((await call('POST', `/api/attempts/${pAttempt}/practice`, { scope: 'INCORRECT' })).body.code, 'NOTHING_TO_PRACTICE');
    const listed = (await call('GET', '/api/mocks')).body.mocks.find((m: any) => m.id === practice.body.mockId);
    assert.deepStrictEqual([listed.kind, listed.exam.totalQuestions, listed.generation], ['PRACTICE', 5, null]);
    const hist = (await call('GET', '/api/attempts')).body.attempts.find((a: any) => a.id === pAttempt);
    assert.deepStrictEqual([hist.mock.kind, hist.exam.totalMarks], ['PRACTICE', 5 * profile.marksPerCorrect]);
    console.log('  ✅ Test 14 passed');

    console.log('\nAPI verification passed completely!');
  } catch (error) {
    console.error('API test failed:', error);
    process.exitCode = 1;
  } finally {
    // Remove everything the local user created in this run (test database only).
    const [local] = await db.select({ id: users.id }).from(users).where(eq(users.email, LOCAL_USER_EMAIL));
    if (local) {
      const owned = await db.select({ id: mockQuestions.questionId }).from(mockQuestions)
        .innerJoin(mocks, eq(mocks.id, mockQuestions.mockId))
        .where(eq(mocks.createdByUserId, local.id));
      await db.delete(questionFlags).where(eq(questionFlags.userId, local.id));
      await db.delete(attempts).where(eq(attempts.userId, local.id)); // cascades attempt_answers
      await db.delete(mocks).where(eq(mocks.createdByUserId, local.id));
      // Bank questions are shared: only delete those no other mock still uses.
      if (owned.length) {
        await db.delete(questions).where(and(
          inArray(questions.id, owned.map((o) => o.id)),
          sql`not exists (select 1 from mock_questions mq where mq.question_id = ${questions.id})`,
        ));
      }
    }
    await app.close();
    await pool.end();
  }
}

runTests();
