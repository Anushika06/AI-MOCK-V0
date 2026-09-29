import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type AnswerUpdate } from '../api';
import { formatClock } from '../format';
import { ErrorBanner, Spinner } from '../components/ui';
import { FlagDialog } from '../components/FlagDialog';
import type { ExamPayload, ExamQuestion, FlagInfo, OptionId } from '../types';

type SaveState = 'saved' | 'saving' | 'offline' | 'error';
/** Unsent changes per question: an answer change and/or cumulative seconds. */
type PendingEntry = Omit<AnswerUpdate, 'questionId'>;
type Pending = Map<string, PendingEntry>;

/** How often accumulated time is queued for saving. */
const TIME_SYNC_MS = 15_000;

// Unsaved selections survive a refresh / crash; the server copy stays authoritative.
const pendingKey = (id: string) => `supertet.pending.${id}`;
const reviewKey = (id: string) => `supertet.review.${id}`;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

function removeKey(key: string) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export function ExamPage() {
  const { attemptId = '' } = useParams();
  const navigate = useNavigate();

  const [payload, setPayload] = useState<ExamPayload | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [answers, setAnswers] = useState<Record<string, OptionId>>({});
  const [review, setReview] = useState<Set<string>>(new Set());
  const [flags, setFlags] = useState<Record<string, FlagInfo | null>>({});
  const [current, setCurrent] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [flagFor, setFlagFor] = useState<ExamQuestion | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const offsetRef = useRef(0); // server clock − client clock (ms)
  const pendingRef = useRef<Pending>(new Map());
  const savingRef = useRef<Promise<void> | null>(null);
  const closedRef = useRef(false);
  const finishingRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(1000);
  const timeRef = useRef<Map<string, number>>(new Map()); // seconds viewed per question
  const sentTimeRef = useRef<Map<string, number>>(new Map()); // last value queued/saved
  const currentIdRef = useRef<string | null>(null);

  const goToResult = useCallback(() => {
    closedRef.current = true;
    removeKey(pendingKey(attemptId));
    navigate(`/attempts/${attemptId}/result`, { replace: true });
  }, [attemptId, navigate]);

  const persistPending = useCallback(() => {
    writeJson(pendingKey(attemptId), Object.fromEntries(pendingRef.current));
  }, [attemptId]);

  /** Sends every pending selection, one request at a time; rejects on failure. */
  const saveAll = useCallback(async () => {
    while (savingRef.current) await savingRef.current.catch(() => {});
    const run = (async () => {
      while (pendingRef.current.size > 0 && !closedRef.current) {
        const batch = [...pendingRef.current.entries()];
        await api.saveAnswers(attemptId, batch.map(([questionId, entry]) => ({ questionId, ...entry })));
        for (const [q, v] of batch) if (pendingRef.current.get(q) === v) pendingRef.current.delete(q);
        persistPending();
      }
    })();
    savingRef.current = run;
    try {
      await run;
    } finally {
      if (savingRef.current === run) savingRef.current = null;
    }
  }, [attemptId, persistPending]);

  const scheduleSave = useCallback(() => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    if (closedRef.current) return;
    setSaveState('saving');
    saveAll()
      .then(() => {
        retryDelayRef.current = 1000;
        setSaveError(null);
        setSaveState(pendingRef.current.size ? 'saving' : 'saved');
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.code === 'ATTEMPT_CLOSED') {
          if (!finishingRef.current) goToResult();
          return;
        }
        const retryable = !(e instanceof ApiError) || e.status === 0 || e.status >= 500 || e.status === 429;
        if (!retryable) {
          // A rejected selection will never succeed — drop it rather than loop forever.
          pendingRef.current.clear();
          persistPending();
          setSaveError(e instanceof Error ? e.message : String(e));
          setSaveState('error');
          return;
        }
        setSaveState('offline');
        const delay = retryDelayRef.current;
        retryDelayRef.current = Math.min(delay * 2, 15000);
        retryTimerRef.current = setTimeout(scheduleSave, delay);
      });
  }, [saveAll, goToResult, persistPending]);

  // ── Load / resume ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    api.getAttempt(attemptId)
      .then((p) => {
        if (cancelled) return;
        if (p.attempt.status !== 'IN_PROGRESS') {
          goToResult();
          return;
        }
        offsetRef.current = Date.parse(p.attempt.serverNow) - Date.now();

        const inPaper = new Set(p.questions.map((q) => q.questionId));
        const merged: Record<string, OptionId> = { ...p.answers };
        for (const [q, secs] of Object.entries(p.timeSpent ?? {})) {
          timeRef.current.set(q, secs);
          sentTimeRef.current.set(q, secs);
        }
        const stored = readJson<Record<string, PendingEntry | OptionId | null>>(pendingKey(attemptId), {});
        for (const [q, raw] of Object.entries(stored)) {
          if (!inPaper.has(q)) continue;
          // Older builds stored a bare selection instead of an entry object.
          const entry: PendingEntry = raw === null || typeof raw === 'string' ? { selectedOption: raw } : raw;
          pendingRef.current.set(q, entry);
          if (entry.selectedOption === null) delete merged[q];
          else if (entry.selectedOption) merged[q] = entry.selectedOption;
          if (entry.timeSpentSeconds !== undefined) {
            timeRef.current.set(q, Math.max(timeRef.current.get(q) ?? 0, entry.timeSpentSeconds));
          }
        }
        setAnswers(merged);
        setReview(new Set(readJson<string[]>(reviewKey(attemptId), []).filter((q) => inPaper.has(q))));
        const firstUnanswered = p.questions.findIndex((q) => !merged[q.questionId]);
        setCurrent(firstUnanswered === -1 ? 0 : firstUnanswered);
        setPayload(p);
        if (pendingRef.current.size) scheduleSave();
      })
      .catch((e) => { if (!cancelled) setLoadError(e); });
    return () => { cancelled = true; };
  }, [attemptId, goToResult, scheduleSave]);

  // ── Clock ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  // ── Time per question ────────────────────────────────────────────────────
  /** Merges a change into the question's pending entry (new object = new version). */
  const mergePending = useCallback((questionId: string, patch: PendingEntry) => {
    pendingRef.current.set(questionId, { ...pendingRef.current.get(questionId), ...patch });
  }, []);

  /** Queues whole seconds accumulated since the last sync; true if anything was queued. */
  const queueTimes = useCallback(() => {
    let queued = false;
    for (const [questionId, secs] of timeRef.current) {
      const whole = Math.floor(secs);
      if (whole > (sentTimeRef.current.get(questionId) ?? 0)) {
        mergePending(questionId, { timeSpentSeconds: whole });
        sentTimeRef.current.set(questionId, whole);
        queued = true;
      }
    }
    if (queued) persistPending();
    return queued;
  }, [mergePending, persistPending]);

  // Count time only while the tab is visible; long gaps (sleep) are ignored.
  useEffect(() => {
    let last = Date.now();
    const id = setInterval(() => {
      const t = Date.now();
      const delta = Math.min(t - last, 5000);
      last = t;
      const questionId = currentIdRef.current;
      if (!questionId || closedRef.current || document.visibilityState !== 'visible') return;
      timeRef.current.set(questionId, (timeRef.current.get(questionId) ?? 0) + delta / 1000);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => { if (queueTimes()) scheduleSave(); }, TIME_SYNC_MS);
    return () => clearInterval(id);
  }, [queueTimes, scheduleSave]);

  useEffect(() => {
    const online = () => { if (pendingRef.current.size) scheduleSave(); };
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (pendingRef.current.size && !closedRef.current) e.preventDefault();
    };
    window.addEventListener('online', online);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('beforeunload', beforeUnload);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [scheduleSave]);

  const deadlineMs = payload ? Date.parse(payload.attempt.deadlineAt) : 0;
  const remaining = payload ? Math.max(0, Math.ceil((deadlineMs - (now + offsetRef.current)) / 1000)) : 0;

  // ── Submit (manual or at time-up) ────────────────────────────────────────
  const finish = useCallback(async (auto: boolean) => {
    if (finishingRef.current || closedRef.current) return;
    finishingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    setConfirmOpen(false);
    try {
      try {
        queueTimes();
        await saveAll();
      } catch (e) {
        // After the deadline the server refuses saves; anything already saved counts.
        if (!(e instanceof ApiError && e.code === 'ATTEMPT_CLOSED') && !auto) throw e;
      }
      await api.submitAttempt(attemptId);
      goToResult();
    } catch (e) {
      finishingRef.current = false;
      setSubmitting(false);
      setSubmitError(auto
        ? new Error('Time is up. Your saved answers are submitted automatically by the server — reconnect and press "View result".')
        : e);
    }
  }, [attemptId, saveAll, goToResult, queueTimes]);

  useEffect(() => {
    if (payload && remaining === 0 && !closedRef.current) void finish(true);
  }, [payload, remaining, finish]);

  // ── Answering ────────────────────────────────────────────────────────────
  const choose = useCallback((questionId: string, option: OptionId | null) => {
    if (closedRef.current || finishingRef.current) return;
    setAnswers((prev) => {
      const next = { ...prev };
      if (option === null) delete next[questionId];
      else next[questionId] = option;
      return next;
    });
    mergePending(questionId, { selectedOption: option });
    queueTimes();
    persistPending();
    scheduleSave();
  }, [mergePending, queueTimes, persistPending, scheduleSave]);

  const toggleReview = useCallback((questionId: string) => {
    setReview((prev) => {
      const next = new Set(prev);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      writeJson(reviewKey(attemptId), [...next]);
      return next;
    });
  }, [attemptId]);

  const questions = payload?.questions ?? [];
  const question = questions[current];
  const answeredCount = useMemo(() => questions.filter((q) => answers[q.questionId]).length, [questions, answers]);

  // Track which question is on screen; queue its time when moving on.
  useEffect(() => {
    currentIdRef.current = question?.questionId ?? null;
    return () => { queueTimes(); };
  }, [question?.questionId, queueTimes]);

  // Bring each new question to the top (matters most on phones).
  useEffect(() => {
    if (window.scrollY > 0) window.scrollTo({ top: 0 });
  }, [current]);

  // Per-section answered counts for the tabs and palette.
  const sectionProgress = useMemo(() => (payload?.sections ?? []).map((s) => {
    const inSection = questions.filter((q) => q.number >= s.startNumber && q.number <= s.endNumber);
    return { ...s, questions: inSection, answered: inSection.filter((q) => answers[q.questionId]).length };
  }), [payload, questions, answers]);

  // Keyboard: A–D / 1–4 select, ←/→ navigate, Esc closes the palette.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (paletteOpen) setPaletteOpen(false);
        else if (confirmOpen) setConfirmOpen(false);
        return;
      }
      if (!question || flagFor || confirmOpen || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select')) return;
      const idx = ['a', 'b', 'c', 'd'].indexOf(e.key.toLowerCase());
      const num = ['1', '2', '3', '4'].indexOf(e.key);
      const pick = idx !== -1 ? idx : num;
      if (pick !== -1 && question.options[pick]) {
        choose(question.questionId, question.options[pick].id);
      } else if (e.key === 'ArrowRight') {
        setCurrent((c) => Math.min(c + 1, questions.length - 1));
      } else if (e.key === 'ArrowLeft') {
        setCurrent((c) => Math.max(c - 1, 0));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [question, questions.length, choose, flagFor, confirmOpen, paletteOpen]);

  if (loadError) {
    return (
      <div className="container stack">
        <ErrorBanner error={loadError} />
        <Link to="/" className="back-link">Home</Link>
      </div>
    );
  }
  if (!payload || !question) return <div className="container"><Spinner label="Opening your test…" /></div>;

  const section = sectionProgress.find((s) => question.number >= s.startNumber && question.number <= s.endNumber);
  const lowTime = remaining <= 300;
  const selected = answers[question.questionId] ?? null;
  const marked = review.has(question.questionId);
  const overallPercent = questions.length ? (answeredCount / questions.length) * 100 : 0;

  function goTo(index: number) {
    setCurrent(index);
    setPaletteOpen(false);
  }

  return (
    <div className="exam">
      <header className="exam-bar">
        <div className="exam-bar-inner">
          <div className="exam-title">
            <strong>{payload.mock.title}</strong>
            <span className={`save-state save-${saveState}`} aria-live="polite">
              {saveState === 'saved' && 'All answers saved'}
              {saveState === 'saving' && 'Saving…'}
              {saveState === 'offline' && 'Offline, will retry'}
              {saveState === 'error' && (saveError ?? 'Could not save')}
            </span>
          </div>
          <div className={`timer ${lowTime ? 'timer-low' : ''}`} aria-label="Time remaining" role="timer">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2M9 2h6" /></svg>
            {formatClock(remaining)}
          </div>
          <button className="btn btn-accent" disabled={submitting} onClick={() => setConfirmOpen(true)}>
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        </div>
        <div className="exam-progress" aria-hidden="true"><span style={{ width: `${overallPercent}%` }} /></div>
      </header>

      {lowTime && remaining > 0 && (
        <div className="low-time" role="status">Less than 5 minutes left. Your saved answers are submitted when time runs out.</div>
      )}

      {submitError !== null && (
        <div className="container">
          <ErrorBanner error={submitError} onRetry={remaining === 0 ? goToResult : () => void finish(false)} />
        </div>
      )}

      <div className="exam-body">
        <main className="question-panel">
          <div className="section-tabs" role="tablist" aria-label="Sections">
            {sectionProgress.map((s) => (
              <button
                key={s.name}
                role="tab"
                aria-selected={section?.name === s.name}
                className={section?.name === s.name ? 'active' : ''}
                onClick={() => setCurrent(questions.findIndex((q) => q.number === s.startNumber))}
              >
                <span className="tab-name">{s.name}</span>
                <span className="tab-count">{s.answered}/{s.questionCount}</span>
              </button>
            ))}
          </div>

          <article className="question" lang={payload.mock.language}>
            <div className="question-head">
              <span className="q-number">Question {question.number}<span className="muted"> of {questions.length}</span></span>
              {marked && <span className="badge badge-review">Marked for review</span>}
            </div>
            <p className="question-text">{question.text}</p>
            <div className="options" role="radiogroup" aria-label={`Options for question ${question.number}`}>
              {question.options.map((o) => (
                <button
                  key={o.id}
                  role="radio"
                  aria-checked={selected === o.id}
                  className={`option ${selected === o.id ? 'selected' : ''}`}
                  onClick={() => choose(question.questionId, o.id)}
                >
                  <span className="option-key">{o.id}</span>
                  <span className="option-text">{o.text}</span>
                </button>
              ))}
            </div>
            <div className="question-actions">
              <button className="btn btn-ghost btn-small" disabled={!selected} onClick={() => choose(question.questionId, null)}>Clear answer</button>
              <button className={`btn btn-small ${marked ? 'btn-review' : 'btn-ghost'}`} aria-pressed={marked} onClick={() => toggleReview(question.questionId)}>
                {marked ? '★ Marked for review' : '☆ Mark for review'}
              </button>
              <span className="spacer" />
              <button className="btn btn-ghost btn-small" onClick={() => setFlagFor(question)}>
                {flags[question.questionId] ? '⚑ Reported' : '⚐ Report a problem'}
              </button>
            </div>
          </article>

          <div className="nav-buttons">
            <button className="btn" disabled={current === 0} onClick={() => setCurrent(current - 1)}>Previous</button>
            <button className="btn palette-toggle" onClick={() => setPaletteOpen(true)} aria-haspopup="dialog">
              {answeredCount}/{questions.length} answered
            </button>
            <button className="btn btn-primary" disabled={current === questions.length - 1} onClick={() => setCurrent(current + 1)}>Next</button>
          </div>
        </main>

        {paletteOpen && <div className="sheet-backdrop" onClick={() => setPaletteOpen(false)} />}
        <aside className={`palette ${paletteOpen ? 'open' : ''}`} aria-label="Question palette">
          <div className="palette-top">
            <strong>All questions</strong>
            <button className="btn btn-ghost btn-small palette-close" onClick={() => setPaletteOpen(false)}>Close</button>
          </div>
          <div className="palette-summary">
            <span><i className="dot dot-answered" /> {answeredCount} answered</span>
            <span><i className="dot dot-unanswered" /> {questions.length - answeredCount} left</span>
            <span><i className="dot dot-review" /> {review.size} for review</span>
          </div>
          <div className="palette-scroll">
            {sectionProgress.map((s) => (
              <div key={s.name} className="palette-section">
                <div className="palette-section-name">
                  <span>{s.name}</span>
                  <span className="muted">{s.answered}/{s.questionCount}</span>
                </div>
                <div className="palette-grid">
                  {s.questions.map((q) => {
                    const cls = [
                      'pal',
                      answers[q.questionId] ? 'pal-answered' : '',
                      review.has(q.questionId) ? 'pal-review' : '',
                      question.questionId === q.questionId ? 'pal-current' : '',
                    ].join(' ');
                    return (
                      <button
                        key={q.questionId}
                        className={cls}
                        onClick={() => goTo(questions.indexOf(q))}
                        aria-label={`Question ${q.number}${answers[q.questionId] ? ', answered' : ''}${review.has(q.questionId) ? ', marked for review' : ''}`}
                        aria-current={question.questionId === q.questionId ? 'true' : undefined}
                      >
                        {q.number}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <p className="muted small palette-keys">Keys: A–D or 1–4 to answer, ← → to move.</p>
        </aside>
      </div>

      {confirmOpen && (
        <div className="modal-backdrop" onClick={() => setConfirmOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="submit-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="submit-title">Submit your test?</h3>
            <div className="confirm-tiles">
              <div><strong>{answeredCount}</strong><span>answered</span></div>
              <div><strong>{questions.length - answeredCount}</strong><span>unanswered</span></div>
              <div><strong>{review.size}</strong><span>for review</span></div>
            </div>
            <p className="small"><strong>{formatClock(remaining)}</strong> still left. You can’t change answers after submitting.</p>
            <div className="modal-actions">
              <span className="spacer" />
              <button className="btn btn-ghost" onClick={() => setConfirmOpen(false)}>Keep working</button>
              <button className="btn btn-primary" onClick={() => void finish(false)}>Submit now</button>
            </div>
          </div>
        </div>
      )}

      {flagFor && (
        <FlagDialog
          questionId={flagFor.questionId}
          questionNumber={flagFor.number}
          attemptId={attemptId}
          existing={flags[flagFor.questionId] ?? null}
          onClose={() => setFlagFor(null)}
          onChange={(f) => setFlags((prev) => ({ ...prev, [flagFor.questionId]: f }))}
        />
      )}
    </div>
  );
}
