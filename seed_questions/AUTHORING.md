# Seed question bank

`super_tet_seed.json` pre-fills the question bank so every mock is mostly bank-based and Gemini
only tops it up. Entries must meet the same bar as `../prompt.md` (the quality specification).

- Import: `npm run bank:seed` (also part of `npm run db:setup`). Re-running skips questions already imported.
- Check after editing: `npx tsx seed_questions/check.ts` — schema, exact subject/topic names, the
  same local validator generated questions pass, duplicate stems, topic coverage, letter/difficulty spread.
- The importer spreads correct answers over A–D per subject and sorts numeric options, identically
  for both mediums, so the letter written here does not need to be balanced by hand.

## File format

`super_tet_seed.json` is a JSON array of entries:

```json
{
  "subject": "Mathematics",
  "topic": "Percentage",
  "difficulty": "medium",
  "correctAnswer": "B",
  "hi": {
    "questionText": "किसी संख्या का 20% यदि 120 है, तो उसी संख्या का 120% कितना होगा?",
    "options": { "A": "600", "B": "720", "C": "640", "D": "840" },
    "explanation": "संख्या = 120 × 100/20 = 600; 600 का 120% = 720"
  },
  "en": {
    "questionText": "If 20% of a number is 120, what is 120% of the same number?",
    "options": { "A": "600", "B": "720", "C": "640", "D": "840" },
    "explanation": "Number = 120 × 100/20 = 600; 120% of 600 = 720"
  }
}
```

Rules:
- `subject` and `topic` must be copied **exactly** from the lists given (they match the exam profile).
- `difficulty`: `easy` | `medium` | `hard`, roughly 30% / 50% / 20% within each subject.
- `hi` and `en` are the same question in each medium, with options in the **same order**, so `correctAnswer` is valid for both.
- Language topics test one language, so they have **one** version that is used in both mediums:
  - `Hindi Grammar`, `Sanskrit Grammar`, `Unseen Prose Passage (Gadyansh)`, `Unseen Verse Passage (Padyansh)` → provide only `hi`.
  - `English Grammar`, `English Comprehension` → provide only `en`.
- Spread `correctAnswer` evenly over A–D. Numeric options go in ascending order.
- "उपर्युक्त सभी / इनमें से कोई नहीं / All of the above / None of these" only as option D, rarely. Never refer to options by letter.
- `explanation`: one or two sentences; for calculations, the working ending on exactly the keyed value.
- Plain text only (no markdown). Passages go inside `questionText`, then a blank line, then the question.
- Original questions in PYQ style — do not copy known papers verbatim.
- **Accuracy over everything**: only settled, textbook-verifiable facts. No current affairs you are not certain of; state the year in the stem for any dated fact. When unsure, pick a different fact.
