import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAsync } from '../hooks';
import { FLAG_REASON_LABEL, formatDateTime, formatDuration, formatMarks, markingRule } from '../format';
import { Badge, ErrorBanner, Ring, Spinner, Stat } from '../components/ui';
import { FlagDialog } from '../components/FlagDialog';
import type { FlagInfo, Outcome, ReviewQuestion } from '../types';

type Filter = 'ALL' | Outcome | 'FLAGGED';

const FILTER_LABEL: Record<Filter, string> = {
  ALL: 'All',
  CORRECT: 'Correct',
  INCORRECT: 'Wrong',
  UNATTEMPTED: 'Skipped',
  FLAGGED: 'Reported',
};

const OUTCOME_LABEL: Record<Outcome, string> = { CORRECT: 'Correct', INCORRECT: 'Wrong', UNATTEMPTED: 'Not answered' };

/** An encouraging headline for the score band. */
function headline(percent: number): string {
  if (percent >= 70) return 'Excellent work!';
  if (percent >= 50) return 'Well done, you’re on track';
  if (percent >= 30) return 'Good effort, keep going';
  return 'Every test makes you stronger';
}

export function ResultPage() {
  const { attemptId = '' } = useParams();
  const result = useAsync(() => api.getResult(attemptId), [attemptId]);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [section, setSection] = useState<string>('ALL');
  const [flagFor, setFlagFor] = useState<ReviewQuestion | null>(null);
  const [flagOverrides, setFlagOverrides] = useState<Record<string, FlagInfo | null>>({});

  const questions = useMemo(() => (result.data?.questions ?? []).map((q) =>
    q.questionId in flagOverrides ? { ...q, flag: flagOverrides[q.questionId] } : q), [result.data, flagOverrides]);

  const visible = questions.filter((q) =>
    (section === 'ALL' || q.subject === section) &&
    (filter === 'ALL' || (filter === 'FLAGGED' ? q.flag !== null : q.outcome === filter)));

  if (result.loading && !result.data) return <Spinner label="Checking your answers…" />;
  if (!result.data) {
    return (
      <div className="stack">
        <ErrorBanner error={result.error} onRetry={result.reload} />
        <Link to={`/attempts/${attemptId}`} className="back-link">Back to the test</Link>
      </div>
    );
  }

  const { summary, attempt, exam, mock, sections, topics, weakTopics, practiceMockId } = result.data;
  const slowest = [...questions].filter((q) => q.timeSpentSeconds > 0)
    .sort((a, b) => b.timeSpentSeconds - a.timeSpentSeconds).slice(0, 5);
  const slowestMax = slowest[0]?.timeSpentSeconds ?? 1;
  const avgPerAttempted = summary.attempted > 0 ? Math.round(summary.trackedTimeSeconds / summary.attempted) : null;
  const counts: Record<Filter, number> = {
    ALL: questions.length,
    CORRECT: summary.correct,
    INCORRECT: summary.incorrect,
    UNATTEMPTED: summary.unattempted,
    FLAGGED: questions.filter((q) => q.flag).length,
  };

  return (
    <div className="stack-lg">
      <div className="page-head">
        <Link to={`/mocks/${mock.id}`} className="back-link">{mock.title}</Link>
      </div>

      <section className="board score-board">
        <Ring percent={summary.percentage} size={176} stroke={14} label={`Score ${formatMarks(summary.percentage)} percent`}>
          <span className="ring-value">{formatMarks(summary.score)}</span>
          <span className="ring-sub">out of {summary.totalMarks}</span>
        </Ring>
        <div className="score-copy">
          <h1>{headline(summary.percentage)}</h1>
          <p className="score-line">
            You scored <strong>{formatMarks(summary.percentage)}%</strong> on {mock.title}
            {mock.kind === 'PRACTICE' && <> <Badge tone="info">Practice</Badge></>}
          </p>
          <p className="score-meta">
            Started {formatDateTime(attempt.startedAt)}, submitted {formatDateTime(attempt.submittedAt)}
            {attempt.status === 'AUTO_SUBMITTED' && '. Time ran out, so your saved answers were submitted automatically.'}
          </p>
        </div>
      </section>

      <section className="stats">
        <Stat label="Correct" value={summary.correct} hint={`+${formatMarks(summary.correct * exam.marksPerCorrect)} marks`} tone="success" />
        <Stat
          label="Wrong"
          value={summary.incorrect}
          hint={exam.negativeMarking ? `−${formatMarks(summary.incorrect * (exam.negativeMarksPerQuestion ?? 0))} marks` : 'no penalty'}
          tone="danger"
        />
        <Stat label="Skipped" value={summary.unattempted} hint={`of ${summary.totalQuestions}`} />
        <Stat label="Accuracy" value={summary.accuracy === null ? '—' : `${formatMarks(summary.accuracy)}%`} hint={`${summary.attempted} answered`} tone="info" />
        <Stat label="Time taken" value={formatDuration(attempt.timeTakenSeconds)} hint={`of ${exam.durationMinutes} min`} />
      </section>

      <PracticePanel
        attemptId={attempt.id}
        practiceMockId={practiceMockId}
        incorrect={summary.incorrect}
        unattempted={summary.unattempted}
      />

      <section className="card">
        <div className="card-head">
          <h2>Section by section</h2>
          <div className="legend small">
            <span><i className="dot dot-correct" /> correct</span>
            <span><i className="dot dot-wrong" /> wrong</span>
            <span><i className="dot dot-skipped" /> skipped</span>
          </div>
        </div>
        <ul className="section-bars">
          {sections.map((s) => (
            <li key={s.subject}>
              <div className="section-bar-head">
                <span className="section-bar-name">{s.subject}</span>
                <span className="section-bar-score"><strong>{formatMarks(s.score)}</strong> marks</span>
              </div>
              <div className="stacked" aria-label={`${s.correct} correct, ${s.incorrect} wrong, ${s.unattempted} skipped of ${s.total}`}>
                <span className="seg-correct" style={{ width: `${(s.correct / s.total) * 100}%` }} />
                <span className="seg-wrong" style={{ width: `${(s.incorrect / s.total) * 100}%` }} />
                <span className="seg-skipped" style={{ width: `${(s.unattempted / s.total) * 100}%` }} />
              </div>
              <div className="section-bar-meta small muted">
                {s.correct} correct, {s.incorrect} wrong, {s.unattempted} skipped of {s.total}
                <span className="spacer" />
                {s.accuracy === null ? '' : `${formatMarks(s.accuracy)}% accuracy, `}{formatDuration(s.timeSpentSeconds)}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Topics to revise</h2>
          <span className="muted small">Where fewer than half the answers were right</span>
        </div>
        {weakTopics.length === 0
          ? <p className="good-news">No weak topics this time. Well done!</p>
          : (
            <ul className="focus-grid">
              {weakTopics.map((t) => (
                <li key={t.subject + t.topic} className="focus-card">
                  <strong>{t.topic}</strong>
                  <span className="muted small">{t.subject}</span>
                  <div className="focus-score">
                    <div className="mini-bar mini-bar-warn"><span style={{ width: `${(t.correct / t.total) * 100}%` }} /></div>
                    <span className="small">{t.correct} of {t.total} right</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        <details className="topic-details">
          <summary>All topics ({topics.length})</summary>
          <div className="table-scroll">
            <table className="table compact">
              <thead>
                <tr><th>Topic</th><th>Section</th><th className="num">Right</th><th className="num">Wrong</th><th className="num">Skipped</th><th className="num">Accuracy</th><th className="num">Time</th></tr>
              </thead>
              <tbody>
                {[...topics].sort((a, b) => a.correct / a.total - b.correct / b.total).map((t) => (
                  <tr key={t.subject + t.topic}>
                    <td>{t.topic}</td>
                    <td className="muted">{t.subject}</td>
                    <td className="num">{t.correct}</td>
                    <td className="num">{t.incorrect}</td>
                    <td className="num">{t.unattempted}</td>
                    <td className="num">{t.accuracy === null ? '—' : `${formatMarks(t.accuracy)}%`}</td>
                    <td className="num">{formatDuration(t.timeSpentSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      {slowest.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>How you used your time</h2>
          </div>
          <div className="time-facts">
            <div><strong>{formatDuration(summary.trackedTimeSeconds)}</strong><span>on questions</span></div>
            {avgPerAttempted !== null && <div><strong>{formatDuration(avgPerAttempted)}</strong><span>per answered question</span></div>}
          </div>
          <h3 className="small-heading">Questions that took longest</h3>
          <ol className="slowest">
            {slowest.map((q) => (
              <li key={q.questionId}>
                <a href={`#q-${q.number}`}>Q{q.number}</a>
                <span className="muted small slowest-subject">{q.subject}</span>
                <div className={`mini-bar mini-bar-${q.outcome.toLowerCase()}`}><span style={{ width: `${(q.timeSpentSeconds / slowestMax) * 100}%` }} /></div>
                <span className={`outcome outcome-${q.outcome.toLowerCase()}`}>{formatDuration(q.timeSpentSeconds)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Review your answers</h2>
          <select value={section} onChange={(e) => setSection(e.target.value)} aria-label="Filter by section">
            <option value="ALL">All sections</option>
            {sections.map((s) => <option key={s.subject} value={s.subject}>{s.subject}</option>)}
          </select>
        </div>
        <div className="chips" role="tablist">
          {(Object.keys(FILTER_LABEL) as Filter[]).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
              {FILTER_LABEL[f]} <span className="chip-count">{counts[f]}</span>
            </button>
          ))}
        </div>

        {visible.length === 0 && <p className="muted">No questions match this filter.</p>}
        <ol className="review-list">
          {visible.map((q) => (
            <li key={q.questionId} id={`q-${q.number}`} className={`review-item review-${q.outcome.toLowerCase()}`} lang={mock.language}>
              <div className="question-head">
                <span className="q-number">Q{q.number}</span>
                <span className={`outcome outcome-${q.outcome.toLowerCase()}`}>{OUTCOME_LABEL[q.outcome]}</span>
                <span className="spacer" />
                <span className="muted small review-meta">
                  {q.subject}, {q.topic}, {q.difficulty}{q.timeSpentSeconds > 0 ? `, ${formatDuration(q.timeSpentSeconds)}` : ''}
                </span>
              </div>
              <p className="question-text">{q.text}</p>
              <ul className="review-options">
                {q.options.map((o) => {
                  const isCorrect = o.id === q.correctOption;
                  const isSelected = o.id === q.selectedOption;
                  return (
                    <li key={o.id} className={`${isCorrect ? 'opt-correct' : ''} ${isSelected && !isCorrect ? 'opt-wrong' : ''}`}>
                      <span className="option-key">{o.id}</span>
                      <span className="option-text">{o.text}</span>
                      {isCorrect && <span className="opt-tag">Correct answer</span>}
                      {isSelected && <span className="opt-tag">Your answer</span>}
                    </li>
                  );
                })}
              </ul>
              {q.explanation && (
                <p className="review-explanation"><strong>Why:</strong> {q.explanation}</p>
              )}
              <div className="question-actions">
                <button className="btn btn-ghost btn-small" onClick={() => setFlagFor(q)}>
                  {q.flag ? `⚑ Reported: ${FLAG_REASON_LABEL[q.flag.reason].toLowerCase()}` : '⚐ Report a problem'}
                </button>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <p className="muted small">Marking: {markingRule(exam)}.</p>

      {flagFor && (
        <FlagDialog
          questionId={flagFor.questionId}
          questionNumber={flagFor.number}
          attemptId={attempt.id}
          existing={flagFor.flag}
          onClose={() => setFlagFor(null)}
          onChange={(f) => setFlagOverrides((prev) => ({ ...prev, [flagFor.questionId]: f }))}
        />
      )}
    </div>
  );
}

function PracticePanel({ attemptId, practiceMockId, incorrect, unattempted }: {
  attemptId: string;
  practiceMockId: string | null;
  incorrect: number;
  unattempted: number;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (incorrect + unattempted === 0) return null;

  async function practise(scope: 'INCORRECT' | 'INCORRECT_AND_UNATTEMPTED') {
    setBusy(true);
    setError(null);
    try {
      const { mockId } = await api.createPractice(attemptId, scope);
      const { attempt } = await api.startAttempt(mockId);
      navigate(`/attempts/${attempt.id}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <section className="practice-card">
      <div className="practice-copy">
        <h2>Practise your mistakes</h2>
        <p className="small">A short timed set of the questions you missed, with the same marking.</p>
      </div>
      {practiceMockId ? (
        <div className="practice-actions"><Link className="btn btn-primary" to={`/mocks/${practiceMockId}`}>Open your practice set</Link></div>
      ) : (
        <div className="practice-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => practise('INCORRECT_AND_UNATTEMPTED')}>
            {busy ? 'Preparing…' : `Wrong + skipped (${incorrect + unattempted})`}
          </button>
          {incorrect > 0 && unattempted > 0 && (
            <button className="btn" disabled={busy} onClick={() => practise('INCORRECT')}>Only wrong ({incorrect})</button>
          )}
        </div>
      )}
      <ErrorBanner error={error} />
    </section>
  );
}
