import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAsync, useInterval } from '../hooks';
import {
  formatDateTime, formatDuration, formatMarks, generationStep, LANGUAGE_SHORT, markingRule, questionSourceLine,
} from '../format';
import { AttemptStatusBadge, Badge, ErrorBanner, Ring, Spinner } from '../components/ui';
import type { GenerationStatus, MockDetail } from '../types';

export function MockPage() {
  const { mockId = '' } = useParams();
  const detail = useAsync(() => api.getMock(mockId), [mockId]);
  const mock = detail.data;

  if (detail.loading && !mock) return <Spinner />;
  if (!mock) return <ErrorBanner error={detail.error ?? 'This test could not be found.'} onRetry={detail.reload} />;

  return (
    <div className="stack-lg">
      <div className="page-head">
        <Link to="/" className="back-link">Home</Link>
        <h1>{mock.title} {mock.kind === 'PRACTICE' && <Badge tone="info">Practice</Badge>}</h1>
        <div className="muted small">
          <span lang={mock.language}>{LANGUAGE_SHORT[mock.language]}</span> medium, created {formatDateTime(mock.createdAt)}
          {mock.kind === 'PRACTICE' && mock.sourceAttemptId && (
            <>. Built from <Link to={`/attempts/${mock.sourceAttemptId}/result`}>this result</Link></>
          )}
        </div>
      </div>

      {mock.status !== 'READY'
        ? <GenerationPanel mock={mock} onReady={detail.reload} />
        : <ReadyPanel mock={mock} />}
    </div>
  );
}

function GenerationPanel({ mock, onReady }: { mock: MockDetail; onReady: () => void }) {
  const status = useAsync(() => api.generationStatus(mock.id), [mock.id]);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<unknown>(null);
  const readyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gen = status.data?.generation;
  const active = !gen || gen.status === 'PENDING' || gen.status === 'IN_PROGRESS';

  const isReady = status.data?.mock.status === 'READY';
  // Let the dial reach 100% before switching to the start screen.
  useEffect(() => {
    if (isReady && !readyTimer.current) readyTimer.current = setTimeout(onReady, 900);
  }, [isReady, onReady]);
  useEffect(() => () => { if (readyTimer.current) clearTimeout(readyTimer.current); }, []);

  useInterval(() => {
    api.generationStatus(mock.id)
      .then((s: GenerationStatus) => status.setData(s))
      .catch(() => { /* transient; next tick retries */ });
  }, 2500, active);

  async function retry() {
    setRetrying(true);
    setRetryError(null);
    try {
      status.setData(await api.retryGeneration(mock.id));
    } catch (e) {
      setRetryError(e);
    } finally {
      setRetrying(false);
    }
  }

  if (!status.data) return status.error ? <ErrorBanner error={status.error} onRetry={status.reload} /> : <Spinner />;
  const g = status.data.generation;
  const failed = g.status === 'FAILED';
  const done = isReady;
  const percent = done ? 100 : g.percent;
  const sources = questionSourceLine(g);

  return (
    <section className={`board gen-board ${failed ? 'gen-failed' : ''}`} aria-busy={!failed && !done}>
      <div className="gen-top">
        <Ring percent={percent} size={156} stroke={12} label="Paper preparation progress" className={failed ? '' : 'ring-live'}>
          <span className="ring-value">{Math.round(percent)}<small>%</small></span>
        </Ring>
        <div className="gen-copy">
          <h2>{failed ? 'We couldn’t finish this paper' : done ? 'Your paper is ready' : 'Preparing your paper'}</h2>
          {!failed && (
            <p className="gen-step" aria-live="polite">
              {!done && <span className="pulse-dot" aria-hidden="true" />}
              {done ? 'Opening your test…' : generationStep(g)}
            </p>
          )}
          <p className="gen-count">
            <strong>{g.questionsReady ?? 0}</strong> of {g.totalQuestions} questions ready
          </p>
          {sources && <p className="gen-sources">{sources}</p>}
          {failed ? (
            <>
              <p>The questions already prepared are kept. Try again to complete the rest.</p>
              <div className="gen-actions">
                <button className="btn btn-accent" disabled={retrying} onClick={retry}>{retrying ? 'Trying again…' : 'Try again'}</button>
              </div>
              {g.errorMessage && (
                <details className="gen-details">
                  <summary>What happened?</summary>
                  <p>{g.errorMessage}</p>
                </details>
              )}
            </>
          ) : (
            !done && <p className="gen-note">This takes a few minutes. You can leave this page; we’ll keep going.</p>
          )}
          <ErrorBanner error={retryError} />
        </div>
      </div>

      {status.data.subjects.length > 0 && (
        <ul className="subject-chips" aria-label="Progress by section">
          {status.data.subjects.map((s) => {
            const pct = s.targetCount ? (s.generatedCount / s.targetCount) * 100 : 0;
            const state = s.status === 'COMPLETED' ? 'done' : s.status === 'FAILED' ? 'failed' : s.status === 'IN_PROGRESS' ? 'active' : 'waiting';
            return (
              <li key={s.subject} className={`subject-chip chip-${state}`}>
                <div className="subject-chip-head">
                  <span className="subject-name">{s.subject}</span>
                  <span className="subject-count">
                    {state === 'done' ? '✓' : `${s.generatedCount}/${s.targetCount}`}
                  </span>
                </div>
                <div className="mini-bar"><span style={{ width: `${Math.min(100, pct)}%` }} /></div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ReadyPanel({ mock }: { mock: MockDetail }) {
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inProgress = mock.attempts.find((a) => a.status === 'IN_PROGRESS');
  const exam = mock.exam;

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const { attempt } = await api.startAttempt(mock.id);
      navigate(`/attempts/${attempt.id}`);
    } catch (e) {
      setError(e);
      setStarting(false);
    }
  }

  return (
    <div className="stack-lg reveal">
      <section className="board start-board">
        <div className="start-copy">
          <h2>{inProgress ? 'Pick up where you left off' : 'Your paper is ready'}</h2>
          <div className="start-facts">
            <div><strong>{exam.totalQuestions}</strong><span>questions</span></div>
            <div><strong>{exam.durationMinutes}</strong><span>minutes</span></div>
            <div><strong>{exam.totalMarks}</strong><span>marks</span></div>
          </div>
          <p className="start-rule">{markingRule(exam)}.</p>
        </div>
        <div className="start-cta">
          <button className="btn btn-accent btn-large" disabled={starting} onClick={start}>
            {starting ? 'Starting…' : inProgress ? `Resume test (${formatDuration(inProgress.remainingSeconds)} left)` : mock.attempts.length ? 'Take it again' : 'Start test'}
          </button>
          <ErrorBanner error={error} />
        </div>
      </section>

      <div className="grid-2">
        <section className="card">
          <h3>Before you begin</h3>
          <ul className="instructions">
            <li>Each question has four options and one correct answer.</li>
            <li>The timer starts when you begin and keeps running even if you close the page.</li>
            <li>Answers save as you pick them. You can change or clear them until you submit.</li>
            <li>When time runs out, your saved answers are submitted for you.</li>
            <li>Keyboard: A–D or 1–4 to answer, arrow keys to move between questions.</li>
          </ul>
        </section>

        <section className="card">
          <h3>Sections</h3>
          <ul className="section-list">
            {mock.sections.map((s) => (
              <li key={s.name}>
                <span>{s.name}</span>
                <span className="muted small">Q{s.startNumber}–{s.endNumber}</span>
                <strong>{s.questionCount}</strong>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {mock.attempts.length > 0 && (
        <section className="card">
          <h3>Your attempts</h3>
          <ul className="attempt-list">
            {mock.attempts.map((a) => (
              <li key={a.id}>
                <span className="small">{formatDateTime(a.startedAt)}</span>
                <AttemptStatusBadge status={a.status} />
                <span className="attempt-score">{a.score === null ? '' : <><strong>{formatMarks(a.score)}</strong>/{exam.totalMarks}</>}</span>
                {a.status === 'IN_PROGRESS'
                  ? <Link className="btn btn-small btn-primary" to={`/attempts/${a.id}`}>Resume</Link>
                  : <Link className="btn btn-small" to={`/attempts/${a.id}/result`}>View result</Link>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
