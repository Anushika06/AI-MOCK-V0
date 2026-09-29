import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAsync } from '../hooks';
import { formatDateTime, formatDuration, formatMarks } from '../format';
import { AttemptStatusBadge, Badge, EmptyState, ErrorBanner, Spinner } from '../components/ui';

export function HistoryPage() {
  const history = useAsync(() => api.history(), []);
  const attempts = history.data?.attempts ?? [];
  const finished = attempts.filter((a) => a.score !== null && a.status !== 'IN_PROGRESS');
  const best = finished.length ? Math.max(...finished.map((a) => (a.score! / a.exam.totalMarks) * 100)) : null;
  const withAccuracy = finished.filter((a) => a.accuracy !== null);
  const avg = withAccuracy.length ? withAccuracy.reduce((n, a) => n + a.accuracy!, 0) / withAccuracy.length : null;

  return (
    <div className="stack-lg">
      <div className="page-head">
        <h1>History</h1>
        {finished.length > 0 && (
          <div className="muted small">
            {finished.length} {finished.length === 1 ? 'test' : 'tests'} completed, best {formatMarks(Math.round(best! * 100) / 100)}%
            {avg !== null && `, average accuracy ${formatMarks(Math.round(avg * 100) / 100)}%`}
          </div>
        )}
      </div>

      {history.loading && !history.data && <Spinner />}
      <ErrorBanner error={history.error} onRetry={history.reload} />
      {history.data && attempts.length === 0 && (
        <EmptyState title="No tests taken yet"><Link to="/">Generate a new test</Link> and your results will appear here.</EmptyState>
      )}
      {attempts.length > 0 && (
        <ul className="history-list">
          {attempts.map((a) => {
            const done = a.status !== 'IN_PROGRESS';
            const percent = a.score === null ? 0 : Math.max(0, (a.score / a.exam.totalMarks) * 100);
            return (
              <li key={a.id} className="history-row">
                <div className="history-main">
                  <div className="test-title">
                    <Link to={`/mocks/${a.mock.id}`}>{a.mock.title}</Link>
                    {a.mock.kind === 'PRACTICE' && <Badge tone="info">Practice</Badge>}
                    <AttemptStatusBadge status={a.status} />
                  </div>
                  <div className="muted small">{formatDateTime(a.startedAt)}{done && a.timeTakenSeconds !== null ? `, took ${formatDuration(a.timeTakenSeconds)}` : ''}</div>
                  {done && (
                    <div className="history-tally small">
                      <span className="t-correct">{a.totalCorrect} correct</span>
                      <span className="t-wrong">{a.totalIncorrect} wrong</span>
                      <span className="muted">{a.totalUnattempted} skipped</span>
                      {a.accuracy !== null && <span className="muted">{formatMarks(a.accuracy)}% accuracy</span>}
                    </div>
                  )}
                </div>
                <div className="history-side">
                  {a.score !== null && (
                    <div className="test-score">
                      <strong>{formatMarks(a.score)}</strong><span className="muted">/{a.exam.totalMarks}</span>
                      <div className="mini-bar"><span style={{ width: `${percent}%` }} /></div>
                    </div>
                  )}
                  {done
                    ? <Link className="btn btn-small" to={`/attempts/${a.id}/result`}>View result</Link>
                    : <Link className="btn btn-small btn-primary" to={`/attempts/${a.id}`}>Resume</Link>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
