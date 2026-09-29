import { env } from '../../config/env.js';
import { JobExecutionService, type JobExecutionOptions } from './job.execution.service.js';
import { GeminiQuestionWriter } from './llm/gemini.writer.js';
import { DemoQuestionWriter, FakeQuestionWriter } from './llm/offline.writers.js';
import type { QuestionWriter } from './question.types.js';

/** The question writer selected by LLM_PROVIDER. */
export function createQuestionWriter(provider: string = env.LLM_PROVIDER): QuestionWriter {
  switch (provider) {
    case 'gemini': return new GeminiQuestionWriter();
    case 'demo': return new DemoQuestionWriter();
    case 'fake': return new FakeQuestionWriter();
    default: throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
  }
}

/** Composition root for mock generation. */
export function createJobExecutionService(
  overrides: { writer?: QuestionWriter } = {},
  options?: JobExecutionOptions,
): JobExecutionService {
  return new JobExecutionService(overrides.writer ?? createQuestionWriter(), options);
}
