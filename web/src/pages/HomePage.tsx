import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAsync, useInterval } from '../hooks';
import { formatDateTime, formatMarks, generationStep, LANGUAGE_SHORT, markingRule } from '../format';
import { Badge, EmptyState, ErrorBanner, ProgressBar, Spinner } from '../components/ui';
import type { ExamProfile, HistoryItem, Language, MockListItem } from '../types';

const EXAM_ID = 'super-tet-primary';
const LANGUAGE_KEY = 'supertet.language';

function rememberedLanguage(): Language {
  try {
    const v = localStorage.getItem(LANGUAGE_KEY);
    return v === 'en' || v === 'hi' ? v : 'hi';
  } catch {
    return 'hi';
  }
}

export function HomePage() {
  const profile = useAsync(() => api.examProfile(EXAM_ID), []);
  const mocks = useAsync(() => api.listMocks(), []);
  const history = useAsync(() => api.history(), []);
  const generating = mocks.data?.mocks.some((m) => m.status === 'GENERATING') ?? false;

  // Keep progress on the list fresh while a paper is being prepared.
  useInterval(() => {
    api.listMocks().then((d) => mocks.setData(d)).catch(() => {});
  }, 3000, generating);

  return (
    <div className="stack-lg">
      <GenerateBoard profile={profile.data} />

      {history.data && <SummaryStrip attempts={history.data.attempts} />}

      <section>
        <div className="section-head">
          <h2>Your tests</h2>
          <Link to="/history" className="small">See all attempts</Link>
        </div>
        {mocks.loading && !mocks.data && <Spinner />}
        <ErrorBanner error={mocks.error} onRetry={mocks.reload} />
        {mocks.data && mocks.data.mocks.length === 0 && (
          <EmptyState title="No tests yet">Your first paper takes a few minutes to prepare. Press “Generate New Test” to begin.</EmptyState>
        )}
        {mocks.data && mocks.data.mocks.length > 0 && (
          <ul className="test-list">
            {mocks.data.mocks.map((m) => <TestRow key={m.id} mock={m} />)}
          </ul>
        )}
      </section>

      {profile.data && <PatternDetails profile={profile.data} />}
      <ErrorBanner error={profile.error} onRetry={profile.reload} />
    </div>
  );
}

function GenerateBoard({ profile }: { profile: ExamProfile | null }) {
  const navigate = useNavigate();
  // The paper is prepared only in the chosen medium; the choice is remembered.
  const [language, setLanguage] = useState<Language>(rememberedLanguage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const languages = profile?.paperLanguages ?? ['hi', 'en'];

  function chooseLanguage(l: Language) {
    setLanguage(l);
    try { localStorage.setItem(LANGUAGE_KEY, l); } catch { /* storage unavailable */ }
  }

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const mock = await api.createMock({ examId: EXAM_ID, language });
      navigate(`/mocks/${mock.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <section className="board hero-board">
      <div className="hero-copy">
        <h1>Ready for today’s practice?</h1>
        <p>
          A complete Super TET paper, just like the real one
          {profile ? ` — ${profile.totalQuestions} questions in ${profile.durationMinutes} minutes.` : '.'}
        </p>
      </div>
      <div className="hero-actions">
        <fieldset className="medium-toggle">
          <legend>Paper medium</legend>
          <div className="segmented segmented-board">
            {languages.map((l) => (
              <label key={l} className={language === l ? 'active' : ''} lang={l}>
                <input type="radio" name="language" value={l} checked={language === l} onChange={() => chooseLanguage(l)} />
                {LANGUAGE_SHORT[l]}
              </label>
            ))}
          </div>
        </fieldset>
        <button className="btn btn-accent btn-large" disabled={busy} onClick={generate}>
          {busy ? 'Starting…' : 'Generate New Test'}
        </button>
      </div>
      <ErrorBanner error={error} />
    </section>
  );
}

function SummaryStrip({ attempts }: { attempts: HistoryItem[] }) {
  const finished = attempts
    .filter((a) => a.status !== 'IN_PROGRESS' && a.score !== null)
    .sort((a, b) => Date.parse(b.submittedAt ?? b.startedAt) - Date.parse(a.submittedAt ?? a.startedAt));
  if (finished.length === 0) return null;
  const best = finished.reduce((top, a) => (a.score! / a.exam.totalMarks > top.score! / top.exam.totalMarks ? a : top));
  const last = finished[0];

  return (
    <section className="summary-strip" aria-label="Your progress">
      <div>
        <span className="summary-value">{finished.length}</span>
        <span className="summary-label">{finished.length === 1 ? 'test taken' : 'tests taken'}</span>
      </div>
      <div>
        <span className="summary-value">{formatMarks(best.score)}<small>/{best.exam.totalMarks}</small></span>
        <span className="summary-label">best score</span>
      </div>
      <div>
        <Link to={`/attempts/${last.id}/result`} className="summary-link">
          <span className="summary-value">{formatMarks(last.score)}<small>/{last.exam.totalMarks}</small></span>
          <span className="summary-label">last test</span>
        </Link>
      </div>
    </section>
  );
}

function TestRow({ mock }: { mock: MockListItem }) {
  const g = mock.generation;
  const a = mock.attempts;
  const finished = a.latestStatus === 'SUBMITTED' || a.latestStatus === 'AUTO_SUBMITTED';

  return (
    <li className={`test-row test-${mock.status.toLowerCase()}`}>
      <div className="test-main">
        <div className="test-title">
          <Link to={`/mocks/${mock.id}`}>{mock.title}</Link>
          {mock.kind === 'PRACTICE' && <Badge tone="info">Practice</Badge>}
        </div>
        <div className="muted small">
          <span lang={mock.language}>{LANGUAGE_SHORT[mock.language]}</span>, {mock.exam.totalQuestions} questions, {formatDateTime(mock.createdAt)}
        </div>
        {mock.status === 'GENERATING' && (
          <div className="test-progress">
            <ProgressBar percent={g?.percent ?? 0} label="Preparing paper" />
            <span className="small">
              <strong>{Math.round(g?.percent ?? 0)}%</strong> <span className="muted">{generationStep(g)}</span>
            </span>
          </div>
        )}
        {mock.status === 'FAILED' && <div className="small error-text">This paper couldn’t be finished. Open it to try again.</div>}
      </div>

      <div className="test-side">
        {finished && a.bestScore !== null && (
          <div className="test-score">
            <strong>{formatMarks(a.bestScore)}</strong><span className="muted">/{mock.exam.totalMarks}</span>
            <span className="muted small">{a.count > 1 ? 'best' : 'score'}</span>
          </div>
        )}
        <div className="test-actions">
          {mock.status === 'GENERATING' && <Link className="btn btn-small btn-ghost" to={`/mocks/${mock.id}`}>View progress</Link>}
          {mock.status === 'FAILED' && <Link className="btn btn-small" to={`/mocks/${mock.id}`}>Try again</Link>}
          {mock.status === 'READY' && (a.inProgressAttemptId
            ? <Link className="btn btn-small btn-primary" to={`/attempts/${a.inProgressAttemptId}`}>Resume</Link>
            : finished && a.latestAttemptId
              ? <>
                  <Link className="btn btn-small btn-primary" to={`/attempts/${a.latestAttemptId}/result`}>View result</Link>
                  <Link className="btn btn-small btn-ghost" to={`/mocks/${mock.id}`}>Retake</Link>
                </>
              : <Link className="btn btn-small btn-primary" to={`/mocks/${mock.id}`}>Start</Link>
          )}
        </div>
      </div>
    </li>
  );
}

function PatternDetails({ profile }: { profile: ExamProfile }) {
  return (
    <details className="pattern">
      <summary>
        <span>Official exam pattern</span>
        <span className="muted small">
          {profile.totalQuestions} questions, {profile.totalMarks} marks, {profile.durationMinutes} minutes
          {profile.negativeMarking ? `, −${formatMarks(profile.negativeMarksPerQuestion)} per wrong answer` : ''}
        </span>
      </summary>
      <p className="small">{markingRule(profile)}.</p>
      <ul className="pattern-list">
        {profile.sectionsConfig.map((s) => (
          <li key={s.name}><span>{s.name}</span><strong>{s.questionCount}</strong></li>
        ))}
      </ul>
    </details>
  );
}
