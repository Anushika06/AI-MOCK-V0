/**
 * Live Gemini check (opt-in, costs ONE request, no database writes):
 * sends one small mixed-subject batch built from prompt.md and prints every
 * question with its local validation verdict.
 *
 *   npm run gemini:smoke            # Hindi
 *   npm run gemini:smoke -- en      # English
 */
import { GeminiQuestionWriter } from '../src/modules/generation/llm/gemini.writer.js';
import { validateItem } from '../src/modules/generation/question.quality.js';
import { CallBudget, type WriteSlot } from '../src/modules/generation/question.types.js';

const language = process.argv[2] === 'en' ? 'en' : 'hi';
const slots: WriteSlot[] = [
  { slot: 1, subject: 'Mathematics', topic: 'Profit and Loss', difficulty: 'medium', level: 'up to Class 12 (Intermediate) level' },
  { slot: 2, subject: 'Child Psychology', topic: 'Learning Theories and their Classroom Application', difficulty: 'easy', level: 'up to D.El.Ed. syllabus level' },
  { slot: 3, subject: 'Language (Hindi, Sanskrit, English)', topic: 'Hindi Grammar', difficulty: 'hard', level: 'up to Class 12 (Intermediate) level' },
  { slot: 4, subject: 'General Knowledge & Current Affairs', topic: 'Indian Culture and Art', difficulty: 'medium', level: 'general awareness expected of a graduate' },
  { slot: 5, subject: 'Teaching Skills', topic: 'Educational Evaluation and Measurement', difficulty: 'medium', level: 'up to D.El.Ed. syllabus level' },
];

const budget = new CallBudget(3);
const started = Date.now();
const { items } = await new GeminiQuestionWriter().write({ examName: 'Super TET Primary', language, slots, avoid: {} }, budget);
console.log(`Gemini requests: ${budget.spent} · ${((Date.now() - started) / 1000).toFixed(1)}s · items: ${items.length}\n`);

const slotMap = new Map(slots.map((s) => [s.slot, s]));
let valid = 0;
for (const item of items) {
  const result = validateItem(item, slotMap, language);
  const raw = item as { slot?: number; questionText?: string; options?: Record<string, string>; correctAnswer?: string; explanation?: string };
  console.log(`#${raw.slot} ${result.ok ? '✅ valid' : `❌ ${result.reason}`}`);
  console.log(raw.questionText);
  for (const [k, v] of Object.entries(raw.options ?? {})) console.log(`  ${k}. ${v}${k === raw.correctAnswer ? '  ✔' : ''}`);
  console.log(`  → ${raw.explanation}\n`);
  if (result.ok) valid++;
}
console.log(`${valid}/${slots.length} valid`);
process.exit(valid > 0 ? 0 : 1);
