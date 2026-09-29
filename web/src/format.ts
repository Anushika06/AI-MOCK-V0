import type { AttemptStatus, GenerationProgress, Language } from './types';

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function formatDuration(totalSeconds: number | null): string {
  if (totalSeconds === null) return '—';
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m === 0) return `${s}s`;
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m ${s}s`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function formatMarks(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export const LANGUAGE_LABEL: Record<Language, string> = { hi: 'हिन्दी (Hindi)', en: 'English' };

export const LANGUAGE_SHORT: Record<Language, string> = { hi: 'हिन्दी', en: 'English' };

/** Friendly label for what the paper builder is doing right now. */
export function generationStep(g: GenerationProgress | null | undefined): string {
  if (!g || g.status === 'PENDING') return 'Getting started';
  if (g.status === 'FAILED') return 'Stopped';
  if (g.status === 'COMPLETED') return 'Paper ready';
  return g.currentSubject?.trim() || 'Preparing your paper';
}

/** "90 from your question collection · 30 freshly written", when the counts are known. */
export function questionSourceLine(g: GenerationProgress | null | undefined): string | null {
  if (!g || (g.reusedCount === undefined && g.newCount === undefined)) return null;
  const parts: string[] = [];
  if (g.reusedCount) parts.push(`${g.reusedCount} from your question collection`);
  if (g.newCount) parts.push(`${g.newCount} freshly written`);
  return parts.length ? parts.join(' · ') : null;
}

export const ATTEMPT_STATUS_LABEL: Record<AttemptStatus, string> = {
  IN_PROGRESS: 'In progress',
  SUBMITTED: 'Submitted',
  AUTO_SUBMITTED: 'Auto-submitted',
};

export const FLAG_REASON_LABEL = {
  WRONG_ANSWER: 'Marked answer is wrong',
  AMBIGUOUS_QUESTION: 'Question is ambiguous',
  TYPO_OR_TRANSLATION: 'Typo / translation issue',
  OUT_OF_SYLLABUS: 'Out of syllabus',
  OTHER: 'Other',
} as const;

export function markingRule(exam: { marksPerCorrect: number; negativeMarking: boolean; negativeMarksPerQuestion: number | null }): string {
  const plus = `+${formatMarks(exam.marksPerCorrect)} per correct answer`;
  return exam.negativeMarking
    ? `${plus}, −${formatMarks(exam.negativeMarksPerQuestion)} per wrong answer, 0 for unattempted`
    : `${plus}, no negative marking`;
}
