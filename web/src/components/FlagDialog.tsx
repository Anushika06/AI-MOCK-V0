import { useState } from 'react';
import { api } from '../api';
import { FLAG_REASON_LABEL } from '../format';
import type { FlagInfo, FlagReason } from '../types';

interface Props {
  questionId: string;
  questionNumber: number;
  attemptId?: string;
  existing: FlagInfo | null;
  onClose: () => void;
  onChange: (flag: FlagInfo | null) => void;
}

/** Report a problem with a question (creates, updates or removes the user's flag). */
export function FlagDialog({ questionId, questionNumber, attemptId, existing, onClose, onChange }: Props) {
  const [reason, setReason] = useState<FlagReason>(existing?.reason ?? 'WRONG_ANSWER');
  const [comment, setComment] = useState(existing?.comment ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const { flag } = await api.flagQuestion(questionId, { reason, comment: comment.trim() || undefined, attemptId });
      onChange(flag);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.unflagQuestion(questionId);
      onChange(null);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="flag-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="flag-title">Report question {questionNumber}</h3>
        <p className="muted">Flagged questions are reviewed. Reporting does not change your score.</p>
        <fieldset className="radio-list">
          {(Object.keys(FLAG_REASON_LABEL) as FlagReason[]).map((r) => (
            <label key={r}>
              <input type="radio" name="reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
              {FLAG_REASON_LABEL[r]}
            </label>
          ))}
        </fieldset>
        <label className="field">
          <span>Details (optional)</span>
          <textarea rows={3} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What is wrong with this question?" />
        </label>
        {error && <div className="banner banner-error">{error}</div>}
        <div className="modal-actions">
          {existing && <button className="btn btn-ghost" disabled={busy} onClick={remove}>Remove flag</button>}
          <span className="spacer" />
          <button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{existing ? 'Update report' : 'Submit report'}</button>
        </div>
      </div>
    </div>
  );
}
