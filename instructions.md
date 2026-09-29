# Super TET Mock Exam Engine

**Open the app → Generate New Test → take the timed test → results → review and analytics → practise mistakes.**

The app is single-user, so there is no sign-in. Every request acts as one built-in local user. That user owns the history, the record of seen questions, the flags and the practice sets.

⚠️ Anyone who can reach the server uses the same data. Run the app on your own machine, or put it behind your own access control.

---

## 1. How a mock is built

The exam profile is `src/modules/exams/profiles/super-tet-primary.ts`. It follows the official UPESSC 2026 scheme:
- 120 questions, 3 marks each (360 in total), −1 for each wrong answer, 120 minutes.
- 10 sections: GK 25, Reasoning 5, Language 30, Science 8, Maths 16, EVS 8, Teaching Skills 8, Child Psychology 8, IT 4, Life Skills 8.
- The 30/50/20 easy/medium/hard mix is an app choice.

### Question bank first

1. **Seed bank.** `seed_questions/super_tet_seed.json` holds **467 original, PYQ-style, bilingual questions**. They cover every section and every official topic, at 3–4 papers' worth per section. Importing them adds **934 bank rows**, one Hindi and one English row per question.
   - Language topics carry a single version used in both mediums. A Hindi-grammar question stays in Hindi in an English-medium paper, as in the printed exam.
2. **About 85% from the bank.** In each section, slots get planned topics and difficulties. They are then filled with questions that are unseen by you and not flagged:
   - first from the planned topic;
   - then from other topics of the same subject.

   The difficulty mix stays exact.
3. **About 15% fresh from Gemini.** By default 18 questions are written fresh (`GENERATION_NEW_PER_MOCK`). That takes **2 requests** of up to 15 questions each.
   - The fresh slots go to the topics the bank covers least, so the bank grows evenly.
   - Every fresh question is saved to the bank.
4. **Hard limits.** At most 30 fresh questions per mock (`GENERATION_MAX_NEW_PER_MOCK`) and **at most 4 Gemini requests** (`GENERATION_MAX_CALLS_PER_MOCK`), with retries and the repair pass included.
   - If the bank has no unseen question left for a slot, the questions you saw longest ago are reused rather than calling Gemini again.
   - The first mock is already built from the bank.
5. **Local checks only.** There are no embeddings, similarity model, arbitration or answer-verifier calls. Each generated question is checked by `question.quality.ts`:
   - structure and duplicate options;
   - option texts that name other options by letter;
   - placeholder text or markup;
   - an answer leaked into the stem;
   - the paper medium;
   - for calculation subjects, whether the worked explanation reaches the keyed value.

   Near-duplicates of bank questions are dropped using local text overlap. Missing slots get one repair pass.
6. **Gemini failures are safe** (`llm/gemini.client.ts`).
   - One limiter is shared by the whole process: at least 6 s between request starts, and at most 2 requests in flight.
   - A per-minute 429 or a 5xx is retried at most 2 times.
   - A daily-quota 429 trips a breaker, so later requests fail instantly until the quota resets.
   - An error a retry cannot fix (bad key, unknown model, other 4xx) stops writing at once.
   - In all of these cases, the paper is completed from the bank.
7. **Interrupted jobs.** A job cut off by a crash or restart resumes and reuses the questions it already paid for.

### `prompt.md`

`prompt.md` is the question-authoring specification sent to Gemini. It covers:
- the exam pattern and PYQ style, based on analysis of the ATRE-2019 paper;
- difficulty definitions and distractor patterns;
- factual rules, including the lessons from the 2019 court-disputed questions;
- prohibited patterns and a final checklist;
- guidance for each section and each medium.

The app adds the slot table (subject, topic, difficulty, level), recent bank questions not to repeat, and the JSON contract. Edit `prompt.md` freely: it is re-read when it changes. The seed authors worked from the same file.

### Adding or fixing seed questions

See `seed_questions/AUTHORING.md`. Check the file with `npx tsx seed_questions/check.ts`, then import it with `npm run bank:seed`. Importing is idempotent. A question can be flagged from the results page; flagged questions are never reused.

---

## 2. Running it

**Prerequisites:** Node.js ≥ 22.12 and Docker. Postgres runs on port **5434**.

```bash
npm run docker:up                   # postgres:17 on localhost:5434
cp .env.example .env                # PowerShell: Copy-Item .env.example .env
npm install && npm --prefix web install
npm run db:setup                    # migrations + exam profile + seed question bank

npm run build:all && npm start      # http://localhost:3000
# development: npm run dev  +  npm run dev:web  → http://localhost:5173
```

**Real questions.** In `.env`, set:

```env
LLM_PROVIDER=gemini
GEMINI_API_KEY=<your key from https://aistudio.google.com/apikey>
LLM_MODEL=<a current Gemini flash model id>
```

Then check it with `npm run gemini:smoke`. This sends **one** request of 5 questions and prints each one with its validation verdict. It writes nothing to the database.

With `LLM_PROVIDER=demo`, no key is needed: the fresh share of each paper is placeholder questions, and everything else comes from the real seed bank.

All settings are listed in `.env.example`.

---

## 3. Tests

```bash
npm run typecheck && npm run typecheck:tests
npm --prefix web run build
npm test            # uses a separate <db>_test database; needs Postgres running
```

| Suite | Covers |
|---|---|
| `verify-unit` | Profile, layout, scoring, the local validator, `prompt.md` coverage and assembly, duplicate detection, parsing truncated responses, option balancing, the Gemini limiter, retries, the quota breaker and budget, and the offline writers |
| `verify-database`, `verify-profile`, `verify-mock-init` | Schema and triggers, the profile API, and job setup |
| `verify-bank` | See the list below |
| `verify-api` | The full HTTP API as the local user: generation, attempts, answers, scoring, results, history, flags, practice and timing |

`verify-bank` covers:
- An empty bank fails safely within the limits.
- The seed imports with 0 rejections, every topic covered in both mediums, and re-importing is a no-op.
- A mock is 102 bank / 18 fresh in 2 requests.
- Seen and flagged questions are excluded.
- A daily-quota error, and separately a bad-request error, stop Gemini at once.
- Bad items are repaired once.
- An interrupted job resumes without paying twice.

---

## 4. Known limitations

- **Answer keys are not checked by a second model.** They rely on authoring review, the explanation-before-answer order, the local checks, and your flags.
- **Current-affairs questions** in the seed are limited to facts dated 2024 or earlier, because they were written from model knowledge. Fresh current affairs depend on what Gemini knows.
- **Two mocks generating at the same time** can pick the same bank question.
