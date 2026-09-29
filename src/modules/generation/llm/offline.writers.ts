import { randomInt } from 'node:crypto';
import type { CallBudget, QuestionWriter, WriteRequest, WriteResult, WriteSlot } from '../question.types.js';

const LETTERS = ['A', 'B', 'C', 'D'] as const;

function placeCorrect(correct: string, wrong: string[], index: number) {
  const texts = [...wrong];
  texts.splice(index, 0, correct);
  return {
    options: Object.fromEntries(LETTERS.map((l, i) => [l, texts[i]])),
    correctAnswer: LETTERS[index],
  };
}

/**
 * Keyless writer for trying the app (LLM_PROVIDER=demo). Maths items are real
 * arithmetic; other subjects get clearly-labelled placeholders. NOT exam content.
 */
export class DemoQuestionWriter implements QuestionWriter {
  readonly name = 'demo';

  async write(request: WriteRequest, budget: CallBudget): Promise<WriteResult> {
    budget.take();
    const batch = String(randomInt(100_000, 1_000_000));
    return { items: request.slots.map((slot) => this.item(slot, request.language, `${batch}-${slot.slot}`)) };
  }

  private item(slot: WriteSlot, language: 'hi' | 'en', ref: string) {
    if (slot.subject === 'Mathematics') {
      const a = randomInt(12, 99);
      const b = randomInt(12, 99);
      const answer = a * b;
      const wrong = new Set<number>();
      while (wrong.size < 3) {
        const d = answer + randomInt(-40, 41);
        if (d !== answer && d > 0) wrong.add(d);
      }
      return {
        slot: slot.slot,
        questionText: language === 'hi' ? `[डेमो ${ref}] ${a} × ${b} का मान क्या है?` : `[Demo ${ref}] What is the value of ${a} × ${b}?`,
        ...placeCorrect(String(answer), [...wrong].map(String), randomInt(4)),
        explanation: `${a} × ${b} = ${answer}`,
      };
    }
    const hi = language === 'hi';
    return {
      slot: slot.slot,
      questionText: hi
        ? `[डेमो ${ref}] यह इस विषय का एक नमूना प्रश्न है। इसका सही विकल्प "सही उत्तर" वाला है।`
        : `[Demo ${ref}] Sample ${slot.subject} question on "${slot.topic}". The right option is the one saying "Correct answer".`,
      // The ref keeps placeholders distinct, so the duplicate check does not reject them.
      ...placeCorrect(
        hi ? `सही उत्तर ${ref}` : `Correct answer ${ref}`,
        (hi ? ['गलत उत्तर', 'अनुचित उत्तर', 'त्रुटिपूर्ण उत्तर'] : ['Wrong answer', 'Incorrect answer', 'Mistaken answer']).map((w) => `${w} ${ref}`),
        randomInt(4),
      ),
      explanation: hi ? 'डेमो प्रश्न।' : 'Demo question.',
    };
  }
}

let fakeCounter = 0;

/**
 * Deterministic writer for automated tests (LLM_PROVIDER=fake): every item is valid,
 * unique across calls, and its key is always the option starting with "Right".
 */
export class FakeQuestionWriter implements QuestionWriter {
  readonly name: string = 'fake';
  readonly requests: WriteRequest[] = [];

  async write(request: WriteRequest, budget: CallBudget): Promise<WriteResult> {
    budget.take();
    this.requests.push(request);
    return { items: request.slots.map((slot) => fakeItem(slot, request.language)) };
  }
}

export function fakeItem(slot: WriteSlot, language: 'hi' | 'en') {
  const n = ++fakeCounter;
  const stem = language === 'hi'
    ? `परीक्षण प्रश्न ${n}: इस विषय से सम्बन्धित निम्नलिखित में से कौन-सा कथन सही है?`
    : `Test question ${n}: which statement about "${slot.topic}" in ${slot.subject} (${slot.difficulty}) is correct?`;
  return {
    slot: slot.slot,
    questionText: stem,
    options: { A: `Right answer ${n}`, B: `Wrong option ${n}-1`, C: `Wrong option ${n}-2`, D: `Wrong option ${n}-3` },
    explanation: `Statement ${n} is the correct one.`,
    correctAnswer: 'A',
  };
}
