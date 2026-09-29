import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../../config/env.js';
import type { WriteRequest } from './question.types.js';

/**
 * Builds the generation prompt from two parts:
 *
 *  1. The authoring specification in prompt.md (project root) — exam style, quality
 *     bar, per-subject guidance. It is re-read whenever the file changes, so the
 *     spec can be improved without touching or restarting code.
 *  2. The task block generated here — language, the exact slots to fill
 *     (subject / topic / difficulty / level), stems to avoid, and the output contract.
 *
 * prompt.md markup (plain Markdown; the markers are HTML comments):
 *   <!-- subject: Mathematics --> … <!-- /subject -->   included only when the batch has that subject
 *   <!-- language: hi --> … <!-- /language -->          included only for that paper language
 * Everything outside those blocks is always included; other HTML comments are dropped.
 */

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export interface AuthoringSpec {
  general: string;
  subjects: Map<string, string>;
  languages: Map<string, string>;
}

const BLOCK = /<!--\s*(subject|language):\s*(.+?)\s*-->([\s\S]*?)<!--\s*\/\1\s*-->/g;

export function parseAuthoringSpec(markdown: string): AuthoringSpec {
  const subjects = new Map<string, string>();
  const languages = new Map<string, string>();
  const general = markdown.replace(BLOCK, (_match, kind: string, name: string, body: string) => {
    (kind === 'subject' ? subjects : languages).set(name.trim(), body.trim());
    return '';
  });
  // Remaining HTML comments are notes for maintainers, not for the model.
  const text = general.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return { general: text, subjects, languages };
}

let cached: { path: string; mtimeMs: number; spec: AuthoringSpec } | null = null;

export function specPath(): string {
  return isAbsolute(env.PROMPT_SPEC_PATH) ? env.PROMPT_SPEC_PATH : resolve(PROJECT_ROOT, env.PROMPT_SPEC_PATH);
}

/** Loads prompt.md, re-parsing only when the file changed. */
export function loadAuthoringSpec(path = specPath()): AuthoringSpec {
  const { mtimeMs } = statSync(path);
  if (cached?.path === path && cached.mtimeMs === mtimeMs) return cached.spec;
  const spec = parseAuthoringSpec(readFileSync(path, 'utf8'));
  cached = { path, mtimeMs, spec };
  return spec;
}

const LANGUAGE_NAME = { hi: 'Hindi (हिन्दी)', en: 'English' } as const;

function taskBlock(request: WriteRequest): string {
  const { language, slots } = request;
  const rows = slots
    .map((s) => `| ${s.slot} | ${s.subject} | ${s.topic} | ${s.difficulty} | ${s.level} |`)
    .join('\n');

  const avoidLines = Object.entries(request.avoid)
    .filter(([, stems]) => stems.length > 0)
    .map(([topic, stems]) => `- ${topic}:\n${stems.map((s) => `  - ${s}`).join('\n')}`)
    .join('\n');

  return `# YOUR TASK

Write exactly ${slots.length} original Super TET questions for the ${request.examName} paper, one per slot below.

- Paper language: ${LANGUAGE_NAME[language]} — language code "${language}". Write every stem, option and explanation in this language, except where a language topic itself requires the tested language (see the rules above).
- Each question must test its slot's subject and topic at its slot's difficulty and level.
- When several slots share a topic, each must test a DIFFERENT sub-concept.

| slot | subject | topic | difficulty | level |
|---|---|---|---|---|
${rows}
${avoidLines ? `
## Already in the question bank — do not repeat these questions or test the same fact in the same way

${avoidLines}
` : ''}
# OUTPUT

Return only JSON: {"questions": [ ... ]} with exactly ${slots.length} objects, one per slot, each with:
- "slot": the slot number from the table (integer)
- "questionText": the complete question (include any passage, statements or list needed to answer it)
- "options": {"A": "...", "B": "...", "C": "...", "D": "..."}
- "explanation": one or two sentences showing why the key is correct (for calculations, the working and the final value)
- "correctAnswer": "A" | "B" | "C" | "D" — decide it only after writing the explanation, and make sure they agree

Run the final quality checklist on every question before returning.`;
}

/** Full prompt for one Gemini request. */
export function buildAuthoringPrompt(request: WriteRequest, spec: AuthoringSpec = loadAuthoringSpec()): string {
  const subjectNames = [...new Set(request.slots.map((s) => s.subject))];
  const subjectGuides = subjectNames
    .map((name) => spec.subjects.get(name))
    .filter((guide): guide is string => Boolean(guide));
  const languageGuide = spec.languages.get(request.language);

  return [
    spec.general,
    languageGuide,
    subjectGuides.length > 0 ? `# SUBJECT GUIDANCE FOR THIS BATCH\n\n${subjectGuides.join('\n\n')}` : undefined,
    taskBlock(request),
  ].filter(Boolean).join('\n\n');
}
