-- Migration: database-level functions and constraints
--
-- 1. Automatic updated_at trigger function
-- 2. updated_at triggers on all tables with updated_at
-- 3. Partial unique index: only one IN_PROGRESS attempt per (user, mock)

-- ─── 1. Trigger function ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── 2. updated_at triggers ───────────────────────────────────────────────

CREATE TRIGGER set_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_exam_profiles_updated_at
  BEFORE UPDATE ON exam_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_questions_updated_at
  BEFORE UPDATE ON questions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_mocks_updated_at
  BEFORE UPDATE ON mocks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_generation_jobs_updated_at
  BEFORE UPDATE ON generation_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_generation_job_subjects_updated_at
  BEFORE UPDATE ON generation_job_subjects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_attempts_updated_at
  BEFORE UPDATE ON attempts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_attempt_answers_updated_at
  BEFORE UPDATE ON attempt_answers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER set_question_flags_updated_at
  BEFORE UPDATE ON question_flags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── 3. Partial unique index: one IN_PROGRESS attempt per (user, mock) ────
CREATE UNIQUE INDEX attempts_one_in_progress_per_user_mock
  ON attempts (user_id, mock_id)
  WHERE status = 'IN_PROGRESS';
