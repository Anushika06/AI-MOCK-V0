CREATE TYPE "public"."attempt_status" AS ENUM('IN_PROGRESS', 'SUBMITTED', 'AUTO_SUBMITTED');--> statement-breakpoint
CREATE TYPE "public"."flag_reason" AS ENUM('WRONG_ANSWER', 'AMBIGUOUS_QUESTION', 'TYPO_OR_TRANSLATION', 'OUT_OF_SYLLABUS', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."flag_status" AS ENUM('OPEN', 'REVIEWED', 'DISMISSED');--> statement-breakpoint
CREATE TYPE "public"."generation_job_status" AS ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."mock_kind" AS ENUM('FULL', 'PRACTICE');--> statement-breakpoint
CREATE TYPE "public"."mock_status" AS ENUM('GENERATING', 'READY', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."question_difficulty" AS ENUM('easy', 'medium', 'hard');--> statement-breakpoint
CREATE TYPE "public"."question_language" AS ENUM('hi', 'en');--> statement-breakpoint
CREATE TYPE "public"."subject_job_status" AS ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TABLE "attempt_answers" (
	"attempt_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"selected_answer" varchar(1),
	"is_correct" boolean,
	"answered_at" timestamp with time zone,
	"time_spent_seconds" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attempt_answers_attempt_id_question_id_pk" PRIMARY KEY("attempt_id","question_id"),
	CONSTRAINT "attempt_answers_selected_answer_valid" CHECK ("attempt_answers"."selected_answer" IS NULL OR "attempt_answers"."selected_answer" IN ('A', 'B', 'C', 'D')),
	CONSTRAINT "attempt_answers_time_spent_non_negative" CHECK ("attempt_answers"."time_spent_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"mock_id" uuid NOT NULL,
	"status" "attempt_status" DEFAULT 'IN_PROGRESS' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"score" numeric(7, 2),
	"total_correct" integer,
	"total_incorrect" integer,
	"total_unattempted" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attempts_deadline_after_start" CHECK ("attempts"."deadline_at" > "attempts"."started_at"),
	CONSTRAINT "attempts_total_correct_non_negative" CHECK ("attempts"."total_correct" IS NULL OR "attempts"."total_correct" >= 0),
	CONSTRAINT "attempts_total_incorrect_non_negative" CHECK ("attempts"."total_incorrect" IS NULL OR "attempts"."total_incorrect" >= 0),
	CONSTRAINT "attempts_total_unattempted_non_negative" CHECK ("attempts"."total_unattempted" IS NULL OR "attempts"."total_unattempted" >= 0),
	CONSTRAINT "attempts_submitted_requirements" CHECK ("attempts"."status" = 'IN_PROGRESS' OR ("attempts"."submitted_at" IS NOT NULL AND "attempts"."score" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "exam_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_id" varchar(100) NOT NULL,
	"version" varchar(50) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"total_questions" integer NOT NULL,
	"total_marks" integer NOT NULL,
	"duration_minutes" integer NOT NULL,
	"options_per_question" integer DEFAULT 4 NOT NULL,
	"marks_per_correct" numeric(5, 2) NOT NULL,
	"negative_marking" boolean DEFAULT false NOT NULL,
	"negative_marks_per_question" numeric(5, 2),
	"paper_languages" jsonb NOT NULL,
	"difficulty_config" jsonb NOT NULL,
	"sections_config" jsonb NOT NULL,
	"canonical_topics" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_profiles_exam_id_version_unique" UNIQUE("exam_id","version"),
	CONSTRAINT "exam_profiles_total_questions_positive" CHECK ("exam_profiles"."total_questions" > 0),
	CONSTRAINT "exam_profiles_duration_positive" CHECK ("exam_profiles"."duration_minutes" > 0),
	CONSTRAINT "exam_profiles_negative_marking_check" CHECK (NOT "exam_profiles"."negative_marking" OR "exam_profiles"."negative_marks_per_question" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "generation_job_subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation_job_id" uuid NOT NULL,
	"subject" varchar(100) NOT NULL,
	"target_count" integer NOT NULL,
	"status" "subject_job_status" DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"generated_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gen_job_subjects_job_subject_unique" UNIQUE("generation_job_id","subject"),
	CONSTRAINT "gen_job_subjects_attempts_bounded" CHECK ("generation_job_subjects"."attempt_count" <= "generation_job_subjects"."max_attempts"),
	CONSTRAINT "gen_job_subjects_generated_bounded" CHECK ("generation_job_subjects"."generated_count" >= 0 AND "generation_job_subjects"."generated_count" <= "generation_job_subjects"."target_count")
);
--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mock_id" uuid NOT NULL,
	"status" "generation_job_status" DEFAULT 'PENDING' NOT NULL,
	"total_subjects" integer DEFAULT 0 NOT NULL,
	"completed_subjects" integer DEFAULT 0 NOT NULL,
	"failed_subjects" integer DEFAULT 0 NOT NULL,
	"current_subject" varchar(100),
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"reused_count" integer DEFAULT 0 NOT NULL,
	"new_count" integer DEFAULT 0 NOT NULL,
	"llm_calls" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_jobs_mock_id_unique" UNIQUE("mock_id"),
	CONSTRAINT "gen_jobs_completed_subjects_non_negative" CHECK ("generation_jobs"."completed_subjects" >= 0),
	CONSTRAINT "gen_jobs_failed_subjects_non_negative" CHECK ("generation_jobs"."failed_subjects" >= 0),
	CONSTRAINT "gen_jobs_completed_plus_failed_bounded" CHECK ("generation_jobs"."completed_subjects" + "generation_jobs"."failed_subjects" <= "generation_jobs"."total_subjects")
);
--> statement-breakpoint
CREATE TABLE "mock_questions" (
	"mock_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"question_number" integer NOT NULL,
	CONSTRAINT "mock_questions_mock_id_question_number_pk" PRIMARY KEY("mock_id","question_number"),
	CONSTRAINT "mock_questions_mock_question_unique" UNIQUE("mock_id","question_id")
);
--> statement-breakpoint
CREATE TABLE "mocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_profile_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"language" "question_language" DEFAULT 'hi' NOT NULL,
	"status" "mock_status" DEFAULT 'GENERATING' NOT NULL,
	"kind" "mock_kind" DEFAULT 'FULL' NOT NULL,
	"source_attempt_id" uuid,
	"duration_minutes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mocks_duration_positive" CHECK ("mocks"."duration_minutes" IS NULL OR "mocks"."duration_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "question_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"attempt_id" uuid,
	"reason" "flag_reason" NOT NULL,
	"comment" text,
	"flag_status" "flag_status" DEFAULT 'OPEN' NOT NULL,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_flags_user_question_unique" UNIQUE("user_id","question_id")
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exam_profile_id" uuid NOT NULL,
	"subject" varchar(100) NOT NULL,
	"topic" varchar(100) NOT NULL,
	"language" "question_language" NOT NULL,
	"difficulty" "question_difficulty" NOT NULL,
	"source_type" text DEFAULT 'ai_generated' NOT NULL,
	"question_text" text NOT NULL,
	"options" jsonb NOT NULL,
	"correct_option" varchar(1) NOT NULL,
	"explanation" text,
	"is_flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questions_correct_option_valid" CHECK ("questions"."correct_option" IN ('A', 'B', 'C', 'D'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"email" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_answers" ADD CONSTRAINT "attempt_answers_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_mock_id_mocks_id_fk" FOREIGN KEY ("mock_id") REFERENCES "public"."mocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_job_subjects" ADD CONSTRAINT "generation_job_subjects_generation_job_id_generation_jobs_id_fk" FOREIGN KEY ("generation_job_id") REFERENCES "public"."generation_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_mock_id_mocks_id_fk" FOREIGN KEY ("mock_id") REFERENCES "public"."mocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_questions" ADD CONSTRAINT "mock_questions_mock_id_mocks_id_fk" FOREIGN KEY ("mock_id") REFERENCES "public"."mocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_questions" ADD CONSTRAINT "mock_questions_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocks" ADD CONSTRAINT "mocks_exam_profile_id_exam_profiles_id_fk" FOREIGN KEY ("exam_profile_id") REFERENCES "public"."exam_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocks" ADD CONSTRAINT "mocks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mocks" ADD CONSTRAINT "mocks_source_attempt_id_attempts_id_fk" FOREIGN KEY ("source_attempt_id") REFERENCES "public"."attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_flags" ADD CONSTRAINT "question_flags_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_flags" ADD CONSTRAINT "question_flags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_flags" ADD CONSTRAINT "question_flags_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_exam_profile_id_exam_profiles_id_fk" FOREIGN KEY ("exam_profile_id") REFERENCES "public"."exam_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attempt_answers_attempt_idx" ON "attempt_answers" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "attempts_user_mock_idx" ON "attempts" USING btree ("user_id","mock_id");--> statement-breakpoint
CREATE INDEX "attempts_status_idx" ON "attempts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "mock_questions_mock_idx" ON "mock_questions" USING btree ("mock_id");--> statement-breakpoint
CREATE INDEX "mocks_created_by_user_idx" ON "mocks" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "mocks_status_idx" ON "mocks" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "mocks_source_attempt_unique" ON "mocks" USING btree ("source_attempt_id");--> statement-breakpoint
CREATE INDEX "question_flags_question_idx" ON "question_flags" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "question_flags_user_idx" ON "question_flags" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "question_flags_status_idx" ON "question_flags" USING btree ("flag_status");--> statement-breakpoint
CREATE INDEX "questions_exam_profile_subject_idx" ON "questions" USING btree ("exam_profile_id","subject");--> statement-breakpoint
CREATE INDEX "questions_exam_profile_subject_topic_idx" ON "questions" USING btree ("exam_profile_id","subject","topic");--> statement-breakpoint
CREATE INDEX "questions_difficulty_idx" ON "questions" USING btree ("difficulty");--> statement-breakpoint
CREATE INDEX "questions_language_idx" ON "questions" USING btree ("language");