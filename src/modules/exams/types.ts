import { z } from 'zod';

/** Target share of easy / medium / hard questions per section, in percent (sums to 100). */
export const difficultyDistributionSchema = z.object({
  easy: z.number().int().min(0).max(100),
  medium: z.number().int().min(0).max(100),
  hard: z.number().int().min(0).max(100),
}).refine((d) => d.easy + d.medium + d.hard === 100, 'difficulty distribution must sum to 100');

export type DifficultyDistribution = z.infer<typeof difficultyDistributionSchema>;

export const difficultyConfigSchema = z.object({
  academicSubjects: z.string(),
  professionalSubjects: z.string(),
  // Optional so older profiles stay valid; without it the LLM chooses difficulty freely.
  distribution: difficultyDistributionSchema.optional(),
});

export type DifficultyConfig = z.infer<typeof difficultyConfigSchema>;

/**
 * Which difficultyConfig level applies to a section:
 *  - academic     → difficultyConfig.academicSubjects (e.g. up to Class 12)
 *  - professional → difficultyConfig.professionalSubjects (e.g. up to D.El.Ed.)
 *  - general      → no level prescribed by the official syllabus (GK, Reasoning)
 * Optional so that profiles seeded before this field existed remain valid.
 */
export const sectionLevelCategorySchema = z.enum(['academic', 'professional', 'general']);

export type SectionLevelCategory = z.infer<typeof sectionLevelCategorySchema>;

export const sectionConfigSchema = z.object({
  name: z.string(),
  questionCount: z.number().int().positive(),
  levelCategory: sectionLevelCategorySchema.optional(),
});

export type SectionConfig = z.infer<typeof sectionConfigSchema>;

export const canonicalTopicsSchema = z.record(
  z.string(), // Subject name
  z.array(z.string()).min(1, 'Each subject must have at least one canonical topic'),
);

export type CanonicalTopics = z.infer<typeof canonicalTopicsSchema>;

// This schema models the raw row returned from the DB, ensuring JSON fields
// are validated structurally before business logic validation.
export const examProfileSchema = z.object({
  id: z.string().uuid(),
  examId: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  totalQuestions: z.number().int().positive(),
  totalMarks: z.number().int().nonnegative(),
  durationMinutes: z.number().int().positive(),
  optionsPerQuestion: z.number().int().min(2),
  marksPerCorrect: z.union([z.number(), z.string()]).transform((val) => Number(val)),
  negativeMarking: z.boolean(),
  negativeMarksPerQuestion: z.union([z.number(), z.string()]).nullable().transform((val) => val === null ? null : Number(val)),
  paperLanguages: z.array(z.string()).min(1, 'At least one paper language is required'),
  difficultyConfig: difficultyConfigSchema,
  sectionsConfig: z.array(sectionConfigSchema),
  canonicalTopics: canonicalTopicsSchema,
  isActive: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ExamProfile = z.infer<typeof examProfileSchema>;

/**
 * Validates the raw database row through Zod and then applies deterministic business rules.
 */
export function validateExamProfile(profile: unknown): ExamProfile {
  // 1. Structural validation via Zod
  const parsed = examProfileSchema.parse(profile);

  // 2. Business validation

  // Marks logic
  if (parsed.marksPerCorrect <= 0) {
    throw new Error('marksPerCorrect must be > 0');
  }

  // Use tolerance for floating point comparison just in case, though for 150 * 1 it's exact
  const expectedTotalMarks = parsed.totalQuestions * parsed.marksPerCorrect;
  if (Math.abs(expectedTotalMarks - parsed.totalMarks) > 0.01) {
    throw new Error(`totalQuestions (${parsed.totalQuestions}) * marksPerCorrect (${parsed.marksPerCorrect}) !== totalMarks (${parsed.totalMarks})`);
  }

  // Distribution logic
  const sumSectionQuestions = parsed.sectionsConfig.reduce((sum, sec) => sum + sec.questionCount, 0);
  if (sumSectionQuestions !== parsed.totalQuestions) {
    throw new Error(`Sum of section question counts (${sumSectionQuestions}) does not equal totalQuestions (${parsed.totalQuestions})`);
  }

  // Negative marking logic
  if (parsed.negativeMarking && parsed.negativeMarksPerQuestion === null) {
    throw new Error('negativeMarksPerQuestion cannot be null when negativeMarking is true');
  }
  if (parsed.negativeMarking && (parsed.negativeMarksPerQuestion as number) < 0) {
    throw new Error('negativeMarksPerQuestion must be >= 0 (it is the magnitude deducted per wrong answer)');
  }

  // Section names are used as subject keys — they must be unique.
  const sectionNames = new Set(parsed.sectionsConfig.map((s) => s.name));
  if (sectionNames.size !== parsed.sectionsConfig.length) {
    throw new Error('sectionsConfig contains duplicate section names');
  }

  // Topics logic - every section's subject must be in canonicalTopics
  for (const section of parsed.sectionsConfig) {
    if (!parsed.canonicalTopics[section.name] || parsed.canonicalTopics[section.name].length === 0) {
      throw new Error(`Configured section (subject) "${section.name}" is missing from canonicalTopics or has empty topics list.`);
    }
  }

  return parsed;
}
