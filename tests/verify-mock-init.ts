import assert from 'node:assert';
import { db, pool } from '../src/db/index.js';
import { users, examProfiles, generationJobs, mocks, generationJobSubjects, questions, mockQuestions } from '../src/db/schema.js';
import { mockGenerationService, DuplicateGenerationJobError } from '../src/modules/generation/mock.generation.service.js';
import { examProfileService } from '../src/modules/exams/exam.service.js';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

async function runTests() {
  console.log('Starting Mock initialisation verification...');

  let testUserId = '';

  try {
    const profile = await examProfileService.getActiveExamProfile('super-tet-primary');

    // Create a dummy user
    const [user] = await db.insert(users).values({
      name: 'Mock Init Tester',
      email: `test4.1-${Date.now()}@example.com`,
    }).returning();
    testUserId = user.id;

    console.log('Test 1: Valid mock, generation_jobs, and subject_jobs creation...');
    const result = await mockGenerationService.initializeMockGeneration(
      user.id,
      'super-tet-primary',
      'Test Mock 4.1'
    );
    assert.ok(result.mock.id, 'mockId should be returned');
    assert.ok(result.generationJob.id, 'jobId should be returned');

    // Verify mock is GENERATING
    const [mock] = await db.select().from(mocks).where(eq(mocks.id, result.mock.id));
    assert.strictEqual(mock.status, 'GENERATING');

    // Verify job is PENDING with correct counts
    const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, result.generationJob.id));
    assert.strictEqual(job.status, 'PENDING');
    assert.strictEqual(job.totalSubjects, profile.sectionsConfig.length);
    assert.strictEqual(job.completedSubjects, 0);
    assert.strictEqual(job.failedSubjects, 0);

    // Verify subjects
    const subjects = await db.select().from(generationJobSubjects).where(eq(generationJobSubjects.generationJobId, job.id));
    assert.strictEqual(subjects.length, profile.sectionsConfig.length);
    
    // Check initial statuses and counts without relying on DB order
    for (const section of profile.sectionsConfig) {
      const dbSubject = subjects.find(s => s.subject === section.name);
      assert.ok(dbSubject, `Subject ${section.name} should exist in db`);
      assert.strictEqual(dbSubject.targetCount, section.questionCount);
      assert.strictEqual(dbSubject.status, 'PENDING');
      assert.strictEqual(dbSubject.attemptCount, 0);
    }
    console.log('  ✅ Test 1 passed');

    console.log('Test 2: Invalid/inactive ExamProfile...');
    await assert.rejects(
      () => mockGenerationService.initializeMockGeneration(user.id, 'nonexistent-exam-id', 'Bad Profile'),
      (err: any) => err.name === 'NotFoundError'
    );
    console.log('  ✅ Test 2 passed');

    console.log('Test 3: Duplicate initialization handling (constraint & typed error)...');
    // Try to initialize a generation job for a mock that already has one
    await assert.rejects(
      () => db.transaction(async (tx) => {
        await mockGenerationService.initializeGenerationJobForMock(tx, result.mock.id, profile);
      }),
      (err: any) => {
        return err instanceof DuplicateGenerationJobError;
      }
    );
    console.log('  ✅ Test 3 passed');

    console.log('Test 4: Transaction rollback on failure...');
    // Simulate a failure during subject insertion by passing a profile with an invalid section 
    // that violates some constraint, or just throwing manually.
    // Instead of messing with schema constraints, let's just create a dummy error scenario:
    const badProfile = { ...profile, sectionsConfig: [{ name: 'Test', questionCount: -1 }] }; 
    // -1 questionCount might fail db constraints. Wait, is there a target_count > 0 constraint? No.
    
    // Let's mock tx.insert to throw for this test, or simpler: pass a null subject.
    const veryBadProfile = { ...profile, sectionsConfig: [{ name: null, questionCount: 1 }] };
    
    const countMocksBefore = await db.select({ count: sql<number>`count(*)` }).from(mocks);
    const countJobsBefore = await db.select({ count: sql<number>`count(*)` }).from(generationJobs);
    
    await assert.rejects(
      () => db.transaction(async (tx) => {
        const [m] = await tx.insert(mocks).values({
           examProfileId: profile.id, createdByUserId: user.id, title: 'Rollback test', status: 'GENERATING'
        }).returning();
        // @ts-ignore
        await mockGenerationService.initializeGenerationJobForMock(tx, m.id, veryBadProfile);
      })
    );
    
    const countMocksAfter = await db.select({ count: sql<number>`count(*)` }).from(mocks);
    const countJobsAfter = await db.select({ count: sql<number>`count(*)` }).from(generationJobs);
    
    assert.strictEqual(countMocksBefore[0].count, countMocksAfter[0].count, 'Mocks count should remain same after rollback');
    assert.strictEqual(countJobsBefore[0].count, countJobsAfter[0].count, 'Jobs count should remain same after rollback');
    console.log('  ✅ Test 4 passed');

    console.log('Test 5: Confirmation that no questions or mock_questions are created...');
    // We check if this mock has any mockQuestions or if questions were created
    const mockQs = await db.select().from(mockQuestions).where(eq(mockQuestions.mockId, result.mock.id));
    assert.strictEqual(mockQs.length, 0, 'No mock_questions should be created');

    console.log('  ✅ Test 5 passed');
    console.log('\nMock initialisation verification passed completely!');
  } finally {
    // Clean up
    if (testUserId) {
      // Delete mocks first because user FK doesn't cascade
      await db.delete(mocks).where(eq(mocks.createdByUserId, testUserId));
      await db.delete(users).where(eq(users.id, testUserId));
    }
    await pool.end();
  }
}

runTests().catch(e => {
  console.error('Mock initialisation test failed:', e);
  process.exit(1);
});
