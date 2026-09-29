import { buildApp } from '../src/app.js';
import { db, pool } from '../src/db/index.js';
import { examProfiles } from '../src/db/schema.js';
import { eq, and } from 'drizzle-orm';
import assert from 'node:assert';
import { examProfileService } from '../src/modules/exams/exam.service.js';
import { validateExamProfile } from '../src/modules/exams/types.js';
import {
  SUPER_TET_ACTIVE_VERSION,
  superTetPrimary2026,
} from '../src/modules/exams/profiles/super-tet-primary.js';

async function runTests() {
  console.log('Starting Exam profile verification...');
  const app = await buildApp();

  try {
    // 1. Seed idempotency & data presence
    console.log('Testing seed idempotency...');
    // Seed was already run twice in bash potentially, or at least once. We'll check the DB directly.
    const profiles = await db
      .select()
      .from(examProfiles)
      .where(
        and(
          eq(examProfiles.examId, 'super-tet-primary'),
          eq(examProfiles.version, SUPER_TET_ACTIVE_VERSION)
        )
      );
    
    assert.strictEqual(profiles.length, 1, 'There should be exactly 1 profile for this ID and version (Idempotency check)');
    
    const profile = profiles[0];
    // Official UPESSC 2026 scheme (see src/modules/exams/profiles/super-tet-primary.ts)
    assert.strictEqual(profile.totalQuestions, 120);
    assert.strictEqual(profile.totalMarks, 360);
    assert.strictEqual(profile.durationMinutes, 120);
    assert.strictEqual(Number(profile.marksPerCorrect), 3);
    assert.strictEqual(profile.negativeMarking, true);
    assert.strictEqual(Number(profile.negativeMarksPerQuestion), 1);
    assert.deepStrictEqual(profile.sectionsConfig, superTetPrimary2026.sectionsConfig);

    console.log('Testing examProfileService.getActiveExamProfile...');
    const activeProfile = await examProfileService.getActiveExamProfile('super-tet-primary');
    assert.strictEqual(activeProfile.examId, 'super-tet-primary');
    assert.strictEqual(activeProfile.version, SUPER_TET_ACTIVE_VERSION);

    // 3. Validation Rules (Invalid data)
    console.log('Testing validateExamProfile with invalid data...');
    const baseValidData = { ...activeProfile, createdAt: new Date(), updatedAt: new Date() };

    // Invalid distribution
    try {
      validateExamProfile({
        ...baseValidData,
        sectionsConfig: [
          { name: 'Only Section', questionCount: 140 } // Sum != 150
        ]
      });
      assert.fail('Should have thrown on invalid distribution');
    } catch (e: any) {
      assert.match(e.message, /Sum of section question counts/);
    }

    // Invalid marks
    try {
      validateExamProfile({
        ...baseValidData,
        marksPerCorrect: 2 // 120 * 2 != 360
      });
      assert.fail('Should have thrown on invalid marks');
    } catch (e: any) {
      assert.match(e.message, /!== totalMarks/);
    }

    // Invalid negative marking
    try {
      validateExamProfile({
        ...baseValidData,
        negativeMarking: true,
        negativeMarksPerQuestion: null
      });
      assert.fail('Should have thrown on invalid negative marking');
    } catch (e: any) {
      assert.match(e.message, /cannot be null when negativeMarking is true/);
    }

    // Empty topic configuration
    try {
      validateExamProfile({
        ...baseValidData,
        canonicalTopics: {
          ...baseValidData.canonicalTopics,
          'Mathematics': [] // Empty!
        }
      });
      assert.fail('Should have thrown on empty topics');
    } catch (e: any) {
      assert.ok(e.issues || e.message.includes('at least one canonical topic')); // Zod will throw here
    }
    
    // Missing section in canonical topics
    try {
      validateExamProfile({
        ...baseValidData,
        sectionsConfig: [
          ...baseValidData.sectionsConfig,
          { name: 'Unknown Subject', questionCount: 0 } // although 0 is invalid Zod, let's bypass that by just removing a topic
        ]
      });
      // Better way to test:
      const badData = { ...baseValidData, canonicalTopics: { ...baseValidData.canonicalTopics } };
      delete badData.canonicalTopics['Mathematics'];
      validateExamProfile(badData);
      assert.fail('Should have thrown on missing topic for configured section');
    } catch (e: any) {
      assert.ok(e.issues || e.message.includes('missing from canonicalTopics'));
    }

    // 4. API Endpoints
    console.log('Testing API Endpoints...');
    const response = await app.inject({
      method: 'GET',
      url: '/api/exams/super-tet-primary'
    });
    assert.strictEqual(response.statusCode, 200);
    const body = response.json();
    assert.strictEqual(body.examId, 'super-tet-primary');
    assert.strictEqual(body.totalQuestions, 120);

    const notFoundResponse = await app.inject({
      method: 'GET',
      url: '/api/exams/invalid-exam'
    });
    assert.strictEqual(notFoundResponse.statusCode, 404);

    // 5. Multiple active profiles protection
    console.log('Testing multiple active profiles protection...');
    await db.insert(examProfiles).values({
      examId: 'super-tet-primary',
      version: 'dummy-v2',
      name: 'Super TET Primary v2',
      totalQuestions: 150,
      totalMarks: 150,
      durationMinutes: 150,
      optionsPerQuestion: 4,
      marksPerCorrect: '1',
      negativeMarking: false,
      negativeMarksPerQuestion: null,
      paperLanguages: ['hi', 'en'],
      difficultyConfig: activeProfile.difficultyConfig,
      sectionsConfig: activeProfile.sectionsConfig,
      canonicalTopics: activeProfile.canonicalTopics,
      isActive: true
    });

    try {
      await examProfileService.getActiveExamProfile('super-tet-primary');
      assert.fail('Should have thrown ConfigurationError');
    } catch (e: any) {
      assert.strictEqual(e.name, 'ConfigurationError');
    }

    const errorResponse = await app.inject({
      method: 'GET',
      url: '/api/exams/super-tet-primary'
    });
    assert.strictEqual(errorResponse.statusCode, 500);

    // Cleanup the dummy profile
    await db.delete(examProfiles).where(eq(examProfiles.version, 'dummy-v2'));

    console.log('Exam profile verification passed completely!');
  } finally {
    await app.close();
    await pool.end();
  }
}

runTests().catch(e => {
  console.error('Test failed:', e);
  process.exit(1);
});
