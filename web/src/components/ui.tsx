import type { ReactNode } from 'react';
import type { AttemptStatus } from '../types';
import { ATTEMPT_STATUS_LABEL } from '../format';

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="banner banner-error" role="alert">
      <span>{message}</span>
      {onRetry && <button className="btn btn-small" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function AttemptStatusBadge({ status }: { status: AttemptStatus }) {
  const tone: Tone = status === 'IN_PROGRESS' ? 'info' : status === 'AUTO_SUBMITTED' ? 'warning' : 'success';
  return <Badge tone={tone}>{ATTEMPT_STATUS_LABEL[status]}</Badge>;
}

export function ProgressBar({ percent, label, tone }: { percent: number; label?: string; tone?: Tone }) {
  const p = Math.max(0, Math.min(100, percent));
  return (
    <div className={`progress ${tone ? `progress-${tone}` : ''}`} role="progressbar" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="progress-fill" style={{ width: `${p}%` }} />
    </div>
  );
}

/** Circular progress / score dial. `percent` is clamped to 0–100. */
export function Ring({ percent, size = 148, stroke = 12, label, children, className = '' }: {
  percent: number;
  size?: number;
  stroke?: number;
  label: string;
  children?: ReactNode;
  className?: string;
}) {
  const p = Math.max(0, Math.min(100, percent));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div
      className={`ring ${className}`}
      style={{ width: size, height: size }}
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(p)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        <circle
          className="ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - p / 100)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <div>{children}</div>}
    </div>
  );
}
