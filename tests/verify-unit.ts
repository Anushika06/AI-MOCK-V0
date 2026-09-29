/**
 * Pure unit checks — no database connection is opened.
 * (DATABASE_URL must still be syntactically valid because config/env.ts validates it.)
 *
 *   npx tsx tests/verify-unit.ts
 */
import assert from 'node:assert';
import { scoreAttempt, accuracyPercent } from '../src/modules/attempts/scoring.js';
import { computeSectionLayout, paperSectionsFromQuestions } from '../src/modules/exams/section.layout.js';
import { validateExamProfile } from '../src/modules/exams/types.js';
import {
  superTetPrimary2026,
} from '../src/modules/exams/profiles/super-tet-primary.js';
import { apportion, planSection } from '../src/modules/generation/section.plan.js';
import { OptionBalancer, hasPositionDependentOptions, placeCorrectOption } from '../src/modules/generation/option.balance.js';
import { seededRandom } from '../src/common/random.js';
import {
  QuotaExhaustedError, RequestLimiter, isQuotaExhausted, isRetryableProviderError, parseRetryDelayMs, withGeminiRetry,
} from '../src/modules/generation/llm/gemini.client.js';
import { parseItems } from '../src/modules/generation/llm/gemini.writer.js';
import { DemoQuestionWriter, FakeQuestionWriter } from '../src/modules/generation/llm/offline.writers.js';
import { buildAuthoringPrompt, loadAuthoringSpec, parseAuthoringSpec } from '../src/modules/generation/authoring.prompt.js';
import { fingerprint, isDuplicate, normalizeText, validateItem } from '../src/modules/generation/question.quality.js';
import {
  CallBudget, CallBudgetExhaustedError, type GeneratedQuestion, type WriteRequest, type WriteSlot,
} from '../src/modules/generation/question.types.js';
import { aggregateByTopic, weakestTopics } from '../src/modules/attempts/scoring.js';
import { effectiveExamSummary, practiceDurationMinutes } from '../src/modules/exams/exam.summary.js';

function asProfileRow(seed: typeof superTetPrimary2026) {
  return {
    ...seed,
    id: '00000000-0000-4000-8000-000000000001',
    description: seed.description ?? null,
    negativeMarksPerQuestion: seed.negativeMarksPerQuestion ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}


async function run() {
  console.log('Starting unit verification...');

  // ── Official profile ───────────────────────────────────────────────────────
  console.log('Test 1: Seed profile passes validateExamProfile and match the official 2026 scheme...');
  const profile = validateExamProfile(asProfileRow(superTetPrimary2026));
  assert.strictEqual(profile.totalQuestions, 120);
  assert.strictEqual(profile.totalMarks, 360);
  assert.strictEqual(profile.durationMinutes, 120);
  assert.strictEqual(profile.marksPerCorrect, 3);
  assert.strictEqual(profile.negativeMarking, true);
  assert.strictEqual(profile.negativeMarksPerQuestion, 1);
  assert.deepStrictEqual(profile.paperLanguages, ['hi', 'en']);
  assert.deepStrictEqual(
    profile.sectionsConfig.map((s) => [s.name, s.questionCount]),
    [
      ['General Knowledge & Current Affairs', 25],
      ['Logical Reasoning', 5],
      ['Language (Hindi, Sanskrit, English)', 30],
      ['Science', 8],
      ['Mathematics', 16],
      ['Environment & Social Studies', 8],
      ['Teaching Skills', 8],
      ['Child Psychology', 8],
      ['Information Technology', 4],
      ['Life Skills / Management & Attitude', 8],
    ],
  );
  for (const topics of Object.values(profile.canonicalTopics)) {
    for (const t of topics) assert.ok(t.length <= 100, `topic too long for varchar(100): ${t}`);
  }
  console.log('  ✅ Test 1 passed');

  // ── Layout ─────────────────────────────────────────────────────────────────
  console.log('Test 2: Section layout gives contiguous fixed blocks in profile order...');
  const layout = computeSectionLayout(profile);
  assert.strictEqual(layout[0].startNumber, 1);
  assert.strictEqual(layout.at(-1)!.endNumber, profile.totalQuestions);
  for (let i = 1; i < layout.length; i++) {
    assert.strictEqual(layout[i].startNumber, layout[i - 1].endNumber + 1);
  }
  const maths = layout.find((s) => s.name === 'Mathematics')!;
  assert.deepStrictEqual([maths.startNumber, maths.endNumber], [69, 84]);
  const grouped = paperSectionsFromQuestions([
    { number: 1, subject: 'A' }, { number: 2, subject: 'A' }, { number: 3, subject: 'B' },
  ]);
  assert.deepStrictEqual(grouped.map((g) => [g.name, g.startNumber, g.endNumber, g.questionCount]), [['A', 1, 2, 2], ['B', 3, 3, 1]]);
  console.log('  ✅ Test 2 passed');

  // ── Scoring ────────────────────────────────────────────────────────────────
  console.log('Test 3: Deterministic scoring with negative marking...');
  const paper = [
    { questionId: 'q1', correctOption: 'A', subject: 'Maths' },
    { questionId: 'q2', correctOption: 'B', subject: 'Maths' },
    { questionId: 'q3', correctOption: 'C', subject: 'GK' },
    { questionId: 'q4', correctOption: 'D', subject: 'GK' },
    { questionId: 'q5', correctOption: 'A', subject: 'GK' },
  ];
  const answers = new Map<string, string | null>([
    ['q1', 'A'],   // correct
    ['q2', 'C'],   // incorrect
    ['q3', 'C'],   // correct
    ['q4', null],  // cleared → unattempted
    ['q99', 'A'],  // not in paper → ignored
    // q5 missing → unattempted
  ]);
  const official = { marksPerCorrect: 3, negativeMarking: true, negativeMarksPerQuestion: 1 };
  const r = scoreAttempt(paper, answers, official);
  assert.deepStrictEqual([r.correct, r.incorrect, r.unattempted, r.score], [2, 1, 2, 5]); // 2×3 − 1×1
  assert.deepStrictEqual(r.perQuestion.map((q) => q.outcome), ['CORRECT', 'INCORRECT', 'CORRECT', 'UNATTEMPTED', 'UNATTEMPTED']);
  const gk = r.perSection.find((s) => s.subject === 'GK')!;
  assert.deepStrictEqual([gk.total, gk.correct, gk.incorrect, gk.unattempted, gk.score], [3, 1, 0, 2, 3]);
  // Same input → same output
  assert.deepStrictEqual(scoreAttempt(paper, answers, official), r);
  // All wrong → negative score allowed
  const allWrong = scoreAttempt(paper, new Map(paper.map((q) => [q.questionId, q.correctOption === 'A' ? 'B' : 'A'])), official);
  assert.strictEqual(allWrong.score, -5);
  // A profile without negative marking
  const noNegative = scoreAttempt(paper, answers, { marksPerCorrect: 1, negativeMarking: false, negativeMarksPerQuestion: null });
  assert.strictEqual(noNegative.score, 2);
  // Fractional marks stay exact
  const frac = scoreAttempt(paper, answers, { marksPerCorrect: 1, negativeMarking: true, negativeMarksPerQuestion: 0.33 });
  assert.strictEqual(frac.score, 1.67);
  // Garbage selections are treated as unattempted, never as correct
  const garbage = scoreAttempt(paper, new Map([['q1', 'a'], ['q2', 'Z']]), official);
  assert.deepStrictEqual([garbage.correct, garbage.incorrect, garbage.unattempted], [0, 0, 5]);
  assert.strictEqual(accuracyPercent(2, 1), 66.67);
  assert.strictEqual(accuracyPercent(0, 0), null);
  console.log('  ✅ Test 3 passed');

  // ── Local quality validation ───────────────────────────────────────────────
  console.log('Test 4: Local validator accepts good items and rejects bad ones individually...');
  const slot = (n: number, subject: string, topic: string, difficulty: 'easy' | 'medium' | 'hard' = 'medium'): WriteSlot =>
    ({ slot: n, subject, topic, difficulty, level: 'Class 12' });
  const slots = new Map([
    [1, slot(1, 'Child Psychology', 'Learning Theories and their Classroom Application', 'hard')],
    [2, slot(2, 'Language (Hindi, Sanskrit, English)', 'English Grammar')],
    [3, slot(3, 'Mathematics', 'Percentage')],
  ]);
  const good = {
    slot: 1,
    questionText: "'समीपस्थ विकास का क्षेत्र' (ZPD) सम्प्रत्यय किसने दिया?",
    options: { A: 'जीन पियाजे', B: 'लेव वाइगोत्स्की', C: 'बी० एफ० स्किनर', D: 'कोहलबर्ग' },
    explanation: 'ZPD वाइगोत्स्की का सम्प्रत्यय है।',
    correctAnswer: 'B',
  };
  const ok = validateItem(good, slots, 'hi');
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepStrictEqual([ok.question.subject, ok.question.topic, ok.question.difficulty], ['Child Psychology', 'Learning Theories and their Classroom Application', 'hard'], 'slot is authoritative');
  const reason = (raw: unknown, language: 'hi' | 'en' = 'hi') => {
    const r = validateItem(raw, slots, language);
    return r.ok ? 'ok' : r.reason;
  };
  assert.strictEqual(reason({ ...good, slot: 9 }), 'unknown slot 9');
  assert.strictEqual(reason({ ...good, correctAnswer: 'E' }), 'correctAnswer is not A–D');
  assert.strictEqual(reason({ ...good, options: { ...good.options, D: 'जीन पियाजे' } }), 'duplicate options');
  assert.strictEqual(reason({ ...good, options: { ...good.options, C: '  ' } }), 'empty option');
  assert.strictEqual(reason({ ...good, options: { ...good.options, C: 'A और B दोनों' } }), 'option refers to another option by letter');
  assert.strictEqual(reason({ ...good, options: { ...good.options, B: 'Both A and C' } }), 'option refers to another option by letter');
  assert.strictEqual(reason({ ...good, options: { ...good.options, A: 'उपर्युक्त सभी' } }), '"all/none of the above" option not in position D');
  assert.strictEqual(reason({ ...good, options: { ...good.options, D: 'इनमें से कोई नहीं' } }), 'ok', 'allowed as option D');
  assert.strictEqual(reason({ ...good, questionText: 'Who gave the concept of ZPD in child development?' }), 'question is not in Hindi');
  assert.strictEqual(reason({ ...good, questionText: 'Answer: B — ZPD किसने दिया?' }), 'answer leaked into the stem');
  assert.strictEqual(reason({ ...good, questionText: '**ZPD** सम्प्रत्यय किसने दिया था?' }), 'markdown in question text');
  assert.strictEqual(reason({ ...good, options: { ...good.options, A: '(a) पियाजे' } }), 'option text carries its own letter label');
  assert.strictEqual(reason({ ...good, options: { ...good.options, A: 'A: पियाजे' } }), 'option text carries its own letter label');
  assert.strictEqual(reason({ ...good, options: { ...good.options, D: 'C. राजगोपालाचारी' } }), 'ok', 'a single initial is not a label');
  assert.strictEqual(reason({ ...good, options: { ...good.options, C: 'B. F. स्किनर' } }), 'ok', 'initials are not a letter label');
  assert.strictEqual(reason({ nonsense: true }), 'malformed item');
  // Checker false positives found while importing the seed bank.
  const reasoningSlots = new Map([[1, slot(1, 'Logical Reasoning', 'Number Series')], [2, slot(2, 'Mathematics', 'Factorisation')]]);
  const rs = (raw: unknown, language: 'hi' | 'en' = 'hi') => { const r = validateItem(raw, reasoningSlots, language); return r.ok ? 'ok' : r.reason; };
  assert.strictEqual(rs({ slot: 1, questionText: '2, 6, 12, 20, 30, ?', options: { A: '40', B: '42', C: '44', D: '48' }, explanation: 'n(n+1): 6 × 7 = 42', correctAnswer: 'B' }), 'ok', 'symbol-only stem');
  assert.strictEqual(rs({ slot: 1, questionText: 'A, B, C में से केवल एक सच बोलता है। कौन सच बोलता है?', options: { A: 'केवल A', B: 'केवल B', C: 'A और C', D: 'कोई नहीं' }, explanation: 'B', correctAnswer: 'B' }), 'ok', 'people named by letters');
  assert.strictEqual(rs({ slot: 1, questionText: "'P @ Q' का अर्थ P > Q तथा 'P # Q' का अर्थ P < Q है। यदि A @ B, तो", options: { A: 'A > B', B: 'A < B', C: 'A = B', D: 'A ≥ B' }, explanation: 'A > B', correctAnswer: 'A' }), 'ok', 'inequalities are not HTML');
  assert.strictEqual(rs({ slot: 2, questionText: 'x² − 9 के गुणनखण्ड हैं', options: { A: '(x − 3)²', B: '(x − 3)(x + 3)', C: '(x − 9)(x + 1)', D: '(x + 3)²' }, explanation: 'a² − b² = (a − b)(a + b)', correctAnswer: 'B' }), 'ok', 'options differing only by signs');
  assert.strictEqual(reason({ ...good, questionText: 'ZPD <b>सम्प्रत्यय</b> किसने दिया?' }), 'placeholder or markup text');
  // English Grammar stays in English in a Hindi paper; Hindi topics stay Hindi in an English paper.
  const english = { slot: 2, questionText: 'Choose the correct article: ___ hour ago.', options: { A: 'a', B: 'an', C: 'the', D: 'no article' }, explanation: 'Hour begins with a vowel sound.', correctAnswer: 'B' };
  assert.strictEqual(reason(english, 'hi'), 'ok');
  assert.strictEqual(reason(good, 'en'), 'question is not in English');
  // Calculations: the worked explanation must reach the keyed value.
  const mathItem = { slot: 3, questionText: 'किसी संख्या का 20% यदि 120 है, तो उसी संख्या का 120% कितना होगा?', options: { A: '600', B: '720', C: '640', D: '840' }, explanation: 'संख्या = 120 × 100/20 = 600; 600 का 120% = 720', correctAnswer: 'B' };
  assert.strictEqual(reason(mathItem), 'ok');
  assert.strictEqual(reason({ ...mathItem, correctAnswer: 'A' }), 'explanation ends on a different option');
  assert.strictEqual(reason({ ...mathItem, correctAnswer: 'D' }), 'explanation does not reach the keyed value');
  console.log('  ✅ Test 4 passed');

  // ── prompt.md + prompt builder ─────────────────────────────────────────────
  console.log('Test 5: prompt.md covers every section and the prompt carries only what the batch needs...');
  const spec = loadAuthoringSpec();
  for (const section of profile.sectionsConfig) assert.ok(spec.subjects.has(section.name), `prompt.md has guidance for ${section.name}`);
  assert.ok(spec.languages.has('hi') && spec.languages.has('en'));
  assert.ok(/Final quality checklist/i.test(spec.general) && /Official exam pattern/i.test(spec.general));
  const request: WriteRequest = {
    examName: profile.name,
    language: 'hi',
    slots: [slot(1, 'Mathematics', 'Percentage', 'hard'), slot(2, 'Child Psychology', 'Individual Differences', 'easy')],
    avoid: { 'Mathematics › Percentage': ['किसी संख्या का 20% …'] },
  };
  const prompt = buildAuthoringPrompt(request, spec);
  assert.ok(prompt.includes('| 1 | Mathematics | Percentage | hard | Class 12 |'));
  assert.ok(prompt.includes('## Mathematics') && prompt.includes('## Child Psychology'));
  assert.ok(!prompt.includes('## Information Technology'), 'other subjects are not sent');
  assert.ok(prompt.includes('Paper medium: Hindi') && !prompt.includes('Paper medium: English'));
  assert.ok(prompt.includes('किसी संख्या का 20% …') && prompt.includes('exactly 2 original'));
  assert.ok(!prompt.includes('<!--'), 'no markup leaks into the prompt');
  const tiny = parseAuthoringSpec('Intro\n<!-- subject: X -->\nX rules\n<!-- /subject -->\nOutro');
  assert.deepStrictEqual([tiny.general, tiny.subjects.get('X')], ['Intro\n\nOutro', 'X rules']);
  console.log('  ✅ Test 5 passed');

  // ── Section plan ───────────────────────────────────────────────────────────
  console.log('Test 6: Section plan spreads topics and applies the difficulty mix exactly...');
  assert.deepStrictEqual(apportion(16, [30, 50, 20]), [5, 8, 3]);
  assert.deepStrictEqual(apportion(25, [30, 50, 20]), [8, 12, 5]);
  assert.deepStrictEqual(apportion(4, [30, 50, 20]), [1, 2, 1]);
  for (const section of profile.sectionsConfig) {
    const plan = planSection(profile, section.name, section.questionCount, seededRandom(section.name));
    assert.strictEqual(plan.length, section.questionCount);
    const topics = profile.canonicalTopics[section.name];
    assert.ok(plan.every((s) => topics.includes(s.topic)));
    const perTopic = new Map<string, number>();
    for (const s of plan) perTopic.set(s.topic, (perTopic.get(s.topic) ?? 0) + 1);
    const counts = [...perTopic.values()];
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `${section.name}: topics used evenly`);
    assert.strictEqual(perTopic.size, Math.min(topics.length, section.questionCount), `${section.name}: max topic coverage`);
    const [e, m, h] = apportion(section.questionCount, [30, 50, 20]);
    assert.deepStrictEqual(
      ['easy', 'medium', 'hard'].map((d) => plan.filter((s) => s.difficulty === d).length),
      [e, m, h],
      `${section.name}: difficulty mix`,
    );
  }
  // Same seed → same plan (resumed sections can reuse banked batches)
  assert.deepStrictEqual(planSection(profile, 'Mathematics', 16, seededRandom('job:Mathematics')),
    planSection(profile, 'Mathematics', 16, seededRandom('job:Mathematics')));
  // A profile without a distribution → no difficulty constraint
  const noMix = { ...profile, difficultyConfig: { ...profile.difficultyConfig, distribution: undefined } };
  assert.ok(planSection(noMix, 'Mathematics', 20).every((s) => s.difficulty === undefined));
  console.log('  ✅ Test 6 passed');

  // ── Duplicate detection + response parsing ────────────────────────────────
  console.log('Test 7: Local duplicate detection and tolerant response parsing...');
  assert.strictEqual(normalizeText('  "कवि" का  स्त्रीलिंग है? '), 'कवि का स्त्रीलिंग है');
  const bank = [fingerprint("'कवि' का स्त्रीलिंग है", 'कवयित्री'), fingerprint('What is 20% of 150?', '30')];
  assert.ok(isDuplicate(fingerprint('कवि का स्त्रीलिंग है।', 'कवयित्री'), bank), 'same stem after normalisation');
  assert.ok(isDuplicate(fingerprint('What is 20 % of 150 ?', '30'), bank));
  assert.ok(isDuplicate(fingerprint('Then what is 20% of 150?', '30'), bank), 'near-identical stem, same answer');
  assert.ok(!isDuplicate(fingerprint('What is 30% of 150?', '45'), bank), 'different question');
  const passage = 'गद्यांश: '.concat('शिक्षा जीवन का आधार है और समाज की प्रगति का मार्ग है। '.repeat(8));
  const bankPassage = [fingerprint(`${passage}\nगद्यांश का उपयुक्त शीर्षक है`, 'शिक्षा का महत्व')];
  assert.ok(!isDuplicate(fingerprint(`${passage}\nगद्यांश के अनुसार समाज की प्रगति का मार्ग है`, 'शिक्षा'), bankPassage), 'same passage, different question');
  const itemJson = { slot: 1, questionText: 'x', options: { A: 'a', B: 'b', C: 'c', D: 'd' }, explanation: 'e', correctAnswer: 'A' };
  assert.strictEqual(parseItems(JSON.stringify({ questions: [itemJson, itemJson] })).length, 2);
  assert.strictEqual(parseItems('```json\n' + JSON.stringify({ questions: [itemJson] }) + '\n```').length, 1);
  const full = JSON.stringify({ questions: [itemJson, { ...itemJson, slot: 2, questionText: 'has "quotes" and {braces}' }, { ...itemJson, slot: 3 }] });
  const truncated = full.slice(0, full.length - 30);
  assert.deepStrictEqual(parseItems(truncated).map((i: any) => i.slot), [1, 2], 'complete items of a cut-off response are kept');
  assert.deepStrictEqual(parseItems(undefined), []);
  assert.deepStrictEqual(parseItems('not json'), []);
  console.log('  ✅ Test 7 passed');

  // ── Answer balancing ───────────────────────────────────────────────────────
  console.log('Test 8: Option balancing keeps texts/correctness and spreads answer letters...');
  const base: GeneratedQuestion = {
    subject: 'Mathematics', topic: 'Percentage', difficulty: 'medium', language: 'en',
    questionText: 'Q', options: { A: 'a', B: 'b', C: 'c', D: 'd' }, correctAnswer: 'A',
  };
  const allA = Array.from({ length: 30 }, (_, i) => ({
    ...base,
    questionText: `Q${i}`,
    options: { A: `right ${i}`, B: `w1 ${i}`, C: `w2 ${i}`, D: `w3 ${i}` },
    correctAnswer: 'A' as const,
  }));
  const balancer = new OptionBalancer(seededRandom('balance'));
  const balanced = balancer.balance(allA);
  balanced.forEach((q, i) => {
    assert.strictEqual(q.options[q.correctAnswer], `right ${i}`, 'correct text still marked correct');
    assert.deepStrictEqual(Object.values(q.options).sort(), Object.values(allA[i].options).sort(), 'same option texts');
  });
  const letters = Object.values(balancer.distribution);
  assert.ok(Math.max(...letters) - Math.min(...letters) <= 1, `balanced: ${JSON.stringify(balancer.distribution)}`);
  const dependent = { ...allA[0], options: { A: 'Red', B: 'Blue', C: 'Both A and B', D: 'None of the above' }, correctAnswer: 'C' as const };
  assert.ok(hasPositionDependentOptions(dependent));
  assert.deepStrictEqual(new OptionBalancer().balance([dependent])[0], dependent, 'position-dependent options untouched');
  assert.ok(hasPositionDependentOptions({ ...dependent, options: { A: 'क', B: 'ख', C: 'उपर्युक्त सभी', D: 'घ' } }));
  assert.ok(!hasPositionDependentOptions(allA[0]));
  assert.ok(!hasPositionDependentOptions({ ...allA[0], options: { A: 'option available', B: 'Vitamin C', C: 'x', D: 'y' } }));
  const moved = placeCorrectOption(allA[0], 'D', seededRandom('x'));
  assert.deepStrictEqual([moved.correctAnswer, moved.options.D], ['D', 'right 0']);
  const numeric = { ...base, options: { A: '₹720', B: '₹600', C: '₹1,250', D: '₹640' }, correctAnswer: 'A' as const };
  const sorted = new OptionBalancer().balance([numeric])[0];
  assert.deepStrictEqual(Object.values(sorted.options), ['₹600', '₹640', '₹720', '₹1,250'], 'numeric options ascending');
  assert.strictEqual(sorted.options[sorted.correctAnswer], '₹720', 'key follows its value');
  assert.deepStrictEqual(Object.values(new OptionBalancer().balance([{ ...base, options: { A: '3/4', B: '1/2', C: '2/3', D: '5/6' } }])[0].options), ['1/2', '2/3', '3/4', '5/6']);
  console.log('  ✅ Test 8 passed');

  // ── Gemini request policy: pacing, bounded retries, quota breaker, budget ──
  console.log('Test 9: Gemini limiter, bounded retries, daily-quota breaker, per-mock budget...');
  assert.strictEqual(parseRetryDelayMs({ message: '{"error":{"code":429,"details":[{"retryDelay":"31s"}]}}' }), 31000);
  assert.strictEqual(parseRetryDelayMs({ message: 'Quota exceeded. Please retry in 12.5s.' }), 12500);
  assert.strictEqual(parseRetryDelayMs({ message: 'bad request' }), null);
  assert.ok(isRetryableProviderError({ status: 429 }) && isRetryableProviderError({ status: 503 }) && isRetryableProviderError({ name: 'AbortError' }));
  assert.ok(!isRetryableProviderError({ status: 400 }));
  const perDay = Object.assign(new Error('429 RESOURCE_EXHAUSTED quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier'), { status: 429 });
  const perMinute = Object.assign(new Error('429 RESOURCE_EXHAUSTED quotaId: GenerateRequestsPerMinutePerProjectPerModel "retryDelay": "1s"'), { status: 429 });
  assert.ok(isQuotaExhausted(perDay) && !isQuotaExhausted(perMinute));
  assert.ok(isQuotaExhausted(Object.assign(new Error('"retryDelay": "3600s"'), { status: 429 })), 'a very long wait counts as exhausted');

  const fastLimiter = () => new RequestLimiter(0, 2);
  let tries = 0;
  const budget = new CallBudget(5);
  const value = await withGeminiRetry(async () => {
    tries++;
    if (tries < 3) throw Object.assign(new Error('rate limited'), { status: 429 });
    return 'ok';
  }, budget, { maxRetries: 2, baseDelayMs: 1, limiter: fastLimiter() });
  assert.deepStrictEqual([value, tries, budget.spent], ['ok', 3, 3], 'every retry costs one call of the budget');
  let badTries = 0;
  await assert.rejects(withGeminiRetry(async () => { badTries++; throw Object.assign(new Error('bad'), { status: 400 }); }, new CallBudget(5), { baseDelayMs: 1, limiter: fastLimiter() }));
  assert.strictEqual(badTries, 1, 'non-retryable errors fail fast');
  let capped = 0;
  await assert.rejects(withGeminiRetry(async () => { capped++; throw Object.assign(new Error('busy'), { status: 503 }); }, new CallBudget(10), { maxRetries: 2, baseDelayMs: 1, limiter: fastLimiter() }));
  assert.strictEqual(capped, 3, 'retries are bounded');
  let budgetTries = 0;
  const small = new CallBudget(2);
  await assert.rejects(withGeminiRetry(async () => { budgetTries++; throw Object.assign(new Error('busy'), { status: 503 }); }, small, { maxRetries: 5, baseDelayMs: 1, limiter: fastLimiter() }));
  assert.deepStrictEqual([budgetTries, small.remaining], [2, 0], 'the budget caps retries too');
  assert.throws(() => small.take(), CallBudgetExhaustedError);

  const breaker = fastLimiter();
  let quotaCalls = 0;
  await assert.rejects(withGeminiRetry(async () => { quotaCalls++; throw perDay; }, new CallBudget(10), { maxRetries: 3, baseDelayMs: 1, limiter: breaker }), QuotaExhaustedError);
  assert.strictEqual(quotaCalls, 1, 'daily quota is never retried');
  assert.ok(breaker.blockedForMs > 0);
  let afterTrip = 0;
  await assert.rejects(withGeminiRetry(async () => { afterTrip++; return 1; }, new CallBudget(10), { limiter: breaker }), QuotaExhaustedError);
  assert.strictEqual(afterTrip, 0, 'no network call while the breaker is tripped');

  const paced = new RequestLimiter(40, 1);
  const startedAt: number[] = [];
  const t0 = Date.now();
  await Promise.all([1, 2, 3].map(() => paced.run(async () => { startedAt.push(Date.now() - t0); })));
  assert.ok(startedAt[2] >= 75, `requests are spaced by the minimum interval: ${startedAt}`);
  const wide = new RequestLimiter(0, 2);
  let inFlight = 0;
  let peak = 0;
  await Promise.all([1, 2, 3, 4, 5].map(() => wide.run(async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
  })));
  assert.strictEqual(peak, 2, 'concurrency is capped');
  console.log('  ✅ Test 9 passed');

  // ── Offline writers produce valid items for every section ──────────────────
  console.log('Test 10: Demo and fake writers produce items that pass the local validator...');
  for (const writer of [new DemoQuestionWriter(), new FakeQuestionWriter()]) {
    for (const language of ['hi', 'en'] as const) {
      const allSlots = profile.sectionsConfig.flatMap((s, k) => profile.canonicalTopics[s.name].slice(0, 2).map((topic, j) => slot(k * 2 + j + 1, s.name, topic)));
      const b = new CallBudget(1);
      const { items } = await writer.write({ examName: profile.name, language, slots: allSlots, avoid: {} }, b);
      const map = new Map(allSlots.map((s) => [s.slot, s]));
      for (const item of items) {
        const r = validateItem(item, map, language);
        assert.ok(r.ok, `${writer.name}/${language}: ${JSON.stringify(r)}`);
      }
      assert.strictEqual(items.length, allSlots.length);
      assert.strictEqual(b.spent, 1, 'one request per batch');
    }
  }
  console.log('  ✅ Test 10 passed');

  // ── Topic analysis + practice sizing ───────────────────────────────────────
  console.log('Test 11: Topic analysis, weak topics, practice set sizing...');
  const topicStats = aggregateByTopic([
    { subject: 'Maths', topic: 'Fractions', outcome: 'CORRECT', timeSpentSeconds: 30 },
    { subject: 'Maths', topic: 'Fractions', outcome: 'INCORRECT', timeSpentSeconds: 50 },
    { subject: 'Maths', topic: 'Interest', outcome: 'UNATTEMPTED' },
    { subject: 'Maths', topic: 'Interest', outcome: 'INCORRECT' },
    { subject: 'GK', topic: 'Sports', outcome: 'CORRECT' },
  ]);
  const fractions = topicStats.find((t) => t.topic === 'Fractions')!;
  assert.deepStrictEqual([fractions.total, fractions.correct, fractions.incorrect, fractions.accuracy, fractions.timeSpentSeconds], [2, 1, 1, 50, 80]);
  assert.deepStrictEqual(weakestTopics(topicStats).map((t) => t.topic), ['Interest']);
  assert.strictEqual(practiceDurationMinutes(profile, 7), 7); // 120 min / 120 Q
  const practiceExam = effectiveExamSummary(profile, { kind: 'PRACTICE', durationMinutes: 7 }, 7);
  assert.deepStrictEqual([practiceExam.totalQuestions, practiceExam.totalMarks, practiceExam.durationMinutes], [7, 21, 7]);
  assert.strictEqual(effectiveExamSummary(profile, { kind: 'FULL', durationMinutes: null }, 120).totalMarks, 360);
  console.log('  ✅ Test 11 passed');

  console.log('\nUnit verification passed completely!');
}

run().catch((e) => {
  console.error('Unit test failed:', e);
  process.exit(1);
});
