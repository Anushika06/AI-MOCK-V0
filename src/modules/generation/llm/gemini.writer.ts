import { type GoogleGenAI, type Schema, ThinkingLevel, Type } from '@google/genai';
import { env } from '../../../config/env.js';
import { buildAuthoringPrompt } from '../authoring.prompt.js';
import type { CallBudget, QuestionWriter, WriteRequest, WriteResult } from '../question.types.js';
import { createGeminiClient, withGeminiRetry } from './gemini.client.js';

// explanation is ordered before correctAnswer so the model works the answer out first.
const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          slot: { type: Type.INTEGER },
          questionText: { type: Type.STRING },
          options: {
            type: Type.OBJECT,
            properties: {
              A: { type: Type.STRING },
              B: { type: Type.STRING },
              C: { type: Type.STRING },
              D: { type: Type.STRING },
            },
            required: ['A', 'B', 'C', 'D'],
            propertyOrdering: ['A', 'B', 'C', 'D'],
          },
          explanation: { type: Type.STRING },
          correctAnswer: { type: Type.STRING, enum: ['A', 'B', 'C', 'D'] },
        },
        required: ['slot', 'questionText', 'options', 'explanation', 'correctAnswer'],
        propertyOrdering: ['slot', 'questionText', 'options', 'explanation', 'correctAnswer'],
      },
    },
  },
  required: ['questions'],
};

const THINKING_LEVEL = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
} as const;

/** Writes a whole batch in one structured-output Gemini request. */
export class GeminiQuestionWriter implements QuestionWriter {
  readonly name = 'gemini';
  private readonly ai: GoogleGenAI;

  constructor(apiKey = env.GEMINI_API_KEY, private readonly model = env.LLM_MODEL) {
    if (!apiKey) throw new Error('GEMINI_API_KEY is required when LLM_PROVIDER=gemini');
    this.ai = createGeminiClient(apiKey);
  }

  async write(request: WriteRequest, budget: CallBudget): Promise<WriteResult> {
    const prompt = buildAuthoringPrompt(request);
    const response = await withGeminiRetry(() => this.ai.models.generateContent({
      model: this.model,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
        ...(env.LLM_THINKING_LEVEL ? { thinkingConfig: { thinkingLevel: THINKING_LEVEL[env.LLM_THINKING_LEVEL] } } : {}),
      },
    }), budget);

    return { items: parseItems(response.text) };
  }
}

/**
 * Extracts the questions array from the model's JSON. A truncated or malformed
 * response yields the items that did parse rather than failing the whole batch.
 */
export function parseItems(text: string | undefined): unknown[] {
  if (!text) return [];
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    const parsed = JSON.parse(cleaned) as { questions?: unknown };
    return Array.isArray(parsed?.questions) ? parsed.questions : Array.isArray(parsed) ? parsed : [];
  } catch {
    return salvageObjects(cleaned);
  }
}

/** Parses every complete top-level object inside the "questions" array of a cut-off response. */
function salvageObjects(text: string): unknown[] {
  const start = text.indexOf('[');
  if (start < 0) return [];
  const items: unknown[] = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objectStart >= 0) {
        try { items.push(JSON.parse(text.slice(objectStart, i + 1))); } catch { /* skip broken object */ }
        objectStart = -1;
      }
    } else if (ch === ']' && depth === 0) break;
  }
  return items;
}
