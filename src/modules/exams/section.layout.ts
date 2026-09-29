import type { ExamProfile } from './types.js';

export interface SectionSlot {
  /** Section (subject) name exactly as in profile.sectionsConfig. */
  name: string;
  /** Position of the section in profile.sectionsConfig. */
  index: number;
  questionCount: number;
  /** First question number (1-based, inclusive) reserved for this section. */
  startNumber: number;
  /** Last question number (inclusive) reserved for this section. */
  endNumber: number;
}

/**
 * Derives the paper layout from the ExamProfile: each section owns a fixed,
 * contiguous block of question numbers in sectionsConfig order.
 *
 * Fixed blocks make generation idempotent — re-running a subject can only ever
 * write into its own block, and the (mock_id, question_number) primary key then
 * rejects any duplicate association instead of silently appending.
 */
export function computeSectionLayout(profile: Pick<ExamProfile, 'sectionsConfig'>): SectionSlot[] {
  let next = 1;
  return profile.sectionsConfig.map((section, index) => {
    const slot: SectionSlot = {
      name: section.name,
      index,
      questionCount: section.questionCount,
      startNumber: next,
      endNumber: next + section.questionCount - 1,
    };
    next += section.questionCount;
    return slot;
  });
}

export interface PaperSection {
  name: string;
  startNumber: number;
  endNumber: number;
  questionCount: number;
}

/**
 * Groups an assembled paper's questions (sorted by number) into sections by
 * subject, in order of first appearance. Derived from the stored paper rather
 * than the profile so it is always accurate for the mock actually being taken.
 */
export function paperSectionsFromQuestions(rows: Array<{ number: number; subject: string }>): PaperSection[] {
  const sections: PaperSection[] = [];
  const byName = new Map<string, PaperSection>();
  for (const row of rows) {
    const existing = byName.get(row.subject);
    if (existing) {
      existing.startNumber = Math.min(existing.startNumber, row.number);
      existing.endNumber = Math.max(existing.endNumber, row.number);
      existing.questionCount++;
    } else {
      const section = { name: row.subject, startNumber: row.number, endNumber: row.number, questionCount: 1 };
      byName.set(row.subject, section);
      sections.push(section);
    }
  }
  return sections;
}

export function sectionLayoutByName(profile: Pick<ExamProfile, 'sectionsConfig'>): Map<string, SectionSlot> {
  return new Map(computeSectionLayout(profile).map((slot) => [slot.name, slot]));
}
