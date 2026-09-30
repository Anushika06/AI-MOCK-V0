import type {
  ExamPayload, ExamProfile, FlagReason, GenerationStatus, HistoryItem, Language, MockDetail,
  MockListItem, OptionId, ResultPayload, AttemptView,
} from './types';

// The backend runs in single-user local mode: requests carry no credentials.

/** One queued exam update: an answer change and/or the cumulative time on a question. */
export interface AnswerUpdate {
  questionId: string;
  selectedOption?: OptionId | null;
  timeSpentSeconds?: number;
}

/** Error carrying the backend's { statusCode, code, message } shape. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

const API_BASE_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection.', 'NETWORK');
  }

  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = (data ?? {}) as { message?: unknown; code?: unknown; details?: unknown };
    const msg = typeof err.message === 'string' && err.message ? err.message : `Request failed (${res.status})`;
    throw new ApiError(res.status, msg, typeof err.code === 'string' ? err.code : undefined, err.details);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return { message: text }; }
}

export const api = {
  examProfile: (examId: string) => request<ExamProfile>('GET', `/exams/${examId}`),

  listMocks: () => request<{ mocks: MockListItem[] }>('GET', '/mocks'),
  createMock: (input: { title?: string; language: Language; examId?: string }) =>
    request<MockDetail>('POST', '/mocks', input),
  getMock: (id: string) => request<MockDetail>('GET', `/mocks/${id}`),
  generationStatus: (id: string) => request<GenerationStatus>('GET', `/mocks/${id}/generation`),
  retryGeneration: (id: string) => request<GenerationStatus>('POST', `/mocks/${id}/generation/retry`),
  startAttempt: (mockId: string) =>
    request<{ attempt: AttemptView; resumed: boolean }>('POST', `/mocks/${mockId}/attempts`),

  getAttempt: (id: string) => request<ExamPayload>('GET', `/attempts/${id}`),
  saveAnswers: (id: string, answers: AnswerUpdate[]) =>
    request<{ saved: number; savedAt: string }>('PUT', `/attempts/${id}/answers`, { answers }),
  submitAttempt: (id: string) =>
    request<{ attempt: AttemptView; alreadySubmitted: boolean }>('POST', `/attempts/${id}/submit`),
  getResult: (id: string) => request<ResultPayload>('GET', `/attempts/${id}/result`),
  createPractice: (attemptId: string, scope: 'INCORRECT' | 'INCORRECT_AND_UNATTEMPTED') =>
    request<{ mockId: string; created: boolean; questionCount: number }>('POST', `/attempts/${attemptId}/practice`, { scope }),
  history: () => request<{ attempts: HistoryItem[] }>('GET', '/attempts'),

  flagQuestion: (questionId: string, input: { reason: FlagReason; comment?: string; attemptId?: string }) =>
    request<{ flag: { reason: FlagReason; comment: string | null; status: 'OPEN' | 'REVIEWED' | 'DISMISSED' } }>(
      'PUT', `/questions/${questionId}/flag`, input),
  unflagQuestion: (questionId: string) => request<{ removed: boolean }>('DELETE', `/questions/${questionId}/flag`),
};
