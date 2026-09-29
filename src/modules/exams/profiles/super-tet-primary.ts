/**
 * Super TET Primary exam profile definitions (seed data).
 *
 * The ACTIVE profile follows the latest official UPESSC scheme:
 *
 *   Source : उत्तर प्रदेश शिक्षा सेवा चयन आयोग (UPESSC), Prayagraj —
 *            "प्राथमिक विद्यालय सहायक अध्यापक (कक्षा 1–5 तक) की भर्ती परीक्षा 2026 की
 *            संरचना व विषय वस्तु", listed on upessc.up.gov.in as the syllabus
 *            "effective for Commission examinations from 2026".
 *   URL    : https://www.upessc.up.gov.in/syllabus/837218cf-1d9a-4252-a08c-404719d1b9d9.pdf
 *   Also   : UPESSC Advt. 05/2026 (15-09-2026) §9 — "360 अंकों की लिखित परीक्षा जो
 *            120 वस्तुनिष्ठ प्रश्नों पर आधारित होगी".
 *
 *   I.   Duration 02:00 hours = 120 minutes
 *   II.  120 questions
 *   III. 1 mark deducted for each wrong answer
 *   IV.  MCQ, 4 options, one correct answer, 3 marks per question (→ 360 marks)
 *   V.   Level: Hindi/Sanskrit/English, Science, Maths, EVS & Social Studies — up to
 *        Class 12; Teaching Skills, Child Psychology, IT, Life Skills — up to D.El.Ed.
 *   VI.  Question paper in both English and Hindi.
 *
 * Section order below is the order of the official syllabus table and is also the
 * order in which questions are numbered in a generated paper.
 */

import type { examProfiles } from '../../../db/schema.js';

type ExamProfileSeed = typeof examProfiles.$inferInsert;

export const SUPER_TET_EXAM_ID = 'super-tet-primary';
export const SUPER_TET_ACTIVE_VERSION = 'upessc-2026';

export const SUPER_TET_OFFICIAL_SOURCE_URL =
  'https://www.upessc.up.gov.in/syllabus/837218cf-1d9a-4252-a08c-404719d1b9d9.pdf';

export const superTetPrimary2026: ExamProfileSeed = {
  examId: SUPER_TET_EXAM_ID,
  version: SUPER_TET_ACTIVE_VERSION,
  name: 'Super TET Primary',
  description:
    'UPESSC Assistant Teacher (Primary, Classes 1–5) Recruitment Examination — official 2026 scheme: ' +
    '120 MCQs, 3 marks each (360), 120 minutes, −1 per wrong answer, bilingual (Hindi & English). ' +
    `Source: ${SUPER_TET_OFFICIAL_SOURCE_URL}`,
  totalQuestions: 120,
  totalMarks: 360,
  durationMinutes: 120,
  optionsPerQuestion: 4,
  marksPerCorrect: '3',
  negativeMarking: true,
  negativeMarksPerQuestion: '1',
  paperLanguages: ['hi', 'en'],
  difficultyConfig: {
    academicSubjects: 'up to Class 12 (Intermediate) level',
    professionalSubjects: 'up to D.El.Ed. syllabus level',
    // Not prescribed by UPESSC — an application choice for a realistic paper.
    distribution: { easy: 30, medium: 50, hard: 20 },
  },
  sectionsConfig: [
    { name: 'General Knowledge & Current Affairs', questionCount: 25, levelCategory: 'general' },
    { name: 'Logical Reasoning', questionCount: 5, levelCategory: 'general' },
    { name: 'Language (Hindi, Sanskrit, English)', questionCount: 30, levelCategory: 'academic' },
    { name: 'Science', questionCount: 8, levelCategory: 'academic' },
    { name: 'Mathematics', questionCount: 16, levelCategory: 'academic' },
    { name: 'Environment & Social Studies', questionCount: 8, levelCategory: 'academic' },
    { name: 'Teaching Skills', questionCount: 8, levelCategory: 'professional' },
    { name: 'Child Psychology', questionCount: 8, levelCategory: 'professional' },
    { name: 'Information Technology', questionCount: 4, levelCategory: 'professional' },
    { name: 'Life Skills / Management & Attitude', questionCount: 8, levelCategory: 'professional' },
  ],
  canonicalTopics: {
    'General Knowledge & Current Affairs': [
      'International Current Affairs',
      'National Current Affairs',
      'Uttar Pradesh Current Affairs',
      'Important Places',
      'Personalities',
      'Books and Works',
      'International and National Awards',
      'Sports',
      'Indian Culture and Art',
    ],
    'Logical Reasoning': [
      'Analogies',
      'Assertion and Reason',
      'Binary Logic',
      'Classification',
      'Clocks and Calendars',
      'Coded Inequalities',
      'Coding-Decoding',
      'Critical Reasoning',
      'Cubes and Dice',
      'Number Series',
      'Puzzles',
      'Symbols and Notations',
      'Venn Diagrams',
      'Data Interpretation',
      'Direction Sense Test',
      'Grouping and Selection',
      'Inferences',
      'Letter Series',
    ],
    'Language (Hindi, Sanskrit, English)': [
      'Hindi Grammar',
      'Sanskrit Grammar',
      'English Grammar',
      'Unseen Prose Passage (Gadyansh)',
      'Unseen Verse Passage (Padyansh)',
      'English Comprehension',
    ],
    'Science': [
      'Science in Daily Life',
      'Motion',
      'Force',
      'Energy',
      'Distance',
      'Light',
      'Sound',
      'World of Living Beings',
      'Human Body and Health',
      'Hygiene and Nutrition',
      'Environment and Natural Resources',
      'Matter and States of Matter',
    ],
    'Mathematics': [
      'Numerical Ability',
      'Mathematical Operations',
      'Decimals',
      'Place Value',
      'Fractions',
      'Interest',
      'Profit and Loss',
      'Percentage',
      'Divisibility',
      'Factorisation',
      'Unitary Method',
      'General Algebra',
      'Area',
      'Average',
      'Volume',
      'Ratio',
      'Identities',
      'General Geometry',
      'General Statistics',
    ],
    'Environment & Social Studies': [
      'Structure of the Earth',
      'Rivers',
      'Mountains',
      'Continents',
      'Oceans and Living Beings',
      'Natural Resources',
      'Latitude and Longitude',
      'Solar System',
      'Indian Geography',
      'Indian Freedom Struggle',
      'Indian Social Reformers',
      'Indian Constitution',
      'Our Governance System',
      'Traffic and Road Safety',
      'Indian Economy and Challenges',
      'Our Cultural Heritage',
      'Environmental Conservation',
      'Natural Disaster Management',
    ],
    'Teaching Skills': [
      'Teaching Methods and Skills',
      'Principles of Teaching and Learning',
      'Contemporary Indian Society and Elementary Education',
      'Inclusive Education',
      'New Initiatives in Elementary Education',
      'Educational Evaluation and Measurement',
      'Early Reading Skills',
      'Educational Management and Administration',
    ],
    'Child Psychology': [
      'Individual Differences',
      'Factors Influencing Child Development',
      'Identifying Learning Needs',
      'Creating an Environment for Reading',
      'Learning Theories and their Classroom Application',
      'Special Provisions for Divyang Students',
    ],
    'Information Technology': [
      'IT for Teaching Skill Development',
      'IT in Classroom Teaching and School Management',
      'Computers',
      'Internet',
      'Smartphones',
      'Open Educational Resources (OER)',
      'Useful Apps in Teaching',
      'Digital Teaching Material',
    ],
    'Life Skills / Management & Attitude': [
      'Professional Conduct and Ethics',
      'Motivation',
      'Role of the Teacher (Facilitator, Listener, Leader, Guide, Counsellor)',
      'Constitutional and Human Values',
      'Effective Use of Reward and Punishment',
    ],
  },
  isActive: true,
};
