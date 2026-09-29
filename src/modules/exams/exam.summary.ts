import type { ExamProfile } from './types.js';

/** Client-facing exam rules, taken verbatim from the (versioned) ExamProfile. */
export interface ExamSummary {
  profileId: string;
  examId: string;
  version: string;
  name: string;
  totalQuestions: number;
  totalMarks: number;
  durationMinutes: number;
  optionsPerQuestion: number;
  marksPerCorrect: number;
  negativeMarking: boolean;
  negativeMarksPerQuestion: number | null;
  paperLanguages: string[];
}

/**
 * Rules that apply to one specific mock. FULL mocks use the profile verbatim;
 * PRACTICE sets keep the profile's marking scheme but have their own question
 * count, maximum marks and (proportional) duration.
 */
export function effectiveExamSummary(
  profile: ExamProfile,
  mock: { kind: 'FULL' | 'PRACTICE'; durationMinutes: number | null },
  questionCount: number,
): ExamSummary {
  const base = toExamSummary(profile);
  if (mock.kind !== 'PRACTICE') return base;
  return {
    ...base,
    totalQuestions: questionCount,
    totalMarks: Math.round(questionCount * profile.marksPerCorrect * 100) / 100,
    durationMinutes: mock.durationMinutes ?? base.durationMinutes,
  };
}

/** Practice duration: the profile's minutes-per-question pace, at least one minute. */
export function practiceDurationMinutes(profile: ExamProfile, questionCount: number): number {
  return Math.max(1, Math.ceil((questionCount * profile.durationMinutes) / profile.totalQuestions));
}

export function toExamSummary(profile: ExamProfile): ExamSummary {
  return {
    profileId: profile.id,
    examId: profile.examId,
    version: profile.version,
    name: profile.name,
    totalQuestions: profile.totalQuestions,
    totalMarks: profile.totalMarks,
    durationMinutes: profile.durationMinutes,
    optionsPerQuestion: profile.optionsPerQuestion,
    marksPerCorrect: profile.marksPerCorrect,
    negativeMarking: profile.negativeMarking,
    negativeMarksPerQuestion: profile.negativeMarking ? profile.negativeMarksPerQuestion : null,
    paperLanguages: profile.paperLanguages,
  };
}
