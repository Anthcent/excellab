CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE app_meta (
  key text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE exercises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  instructions text NOT NULL DEFAULT '',
  points double precision NOT NULL DEFAULT 10 CHECK (points > 0),
  workbook jsonb NOT NULL,
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published')),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE exams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  instructions text NOT NULL DEFAULT '',
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  max_attempts integer NOT NULL DEFAULT 2 CHECK (max_attempts >= 1),
  pick_count integer CHECK (pick_count IS NULL OR pick_count > 0),
  scale double precision NOT NULL DEFAULT 20 CHECK (scale > 0),
  pass_percent double precision NOT NULL DEFAULT 60 CHECK (pass_percent >= 0 AND pass_percent <= 100),
  grade_policy text NOT NULL DEFAULT 'best' CHECK (grade_policy IN ('best', 'last')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  available_from timestamptz,
  available_until timestamptz,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE exam_exercises (
  exam_id uuid NOT NULL REFERENCES exams (id) ON DELETE CASCADE,
  exercise_id uuid NOT NULL REFERENCES exercises (id) ON DELETE CASCADE,
  position integer NOT NULL,
  PRIMARY KEY (exam_id, exercise_id)
);
CREATE INDEX exam_exercises_exercise_idx ON exam_exercises (exercise_id);

CREATE TABLE attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id uuid NOT NULL REFERENCES exams (id),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number >= 1),
  seed integer NOT NULL,
  exercise_ids jsonb NOT NULL,
  started_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  submitted_at timestamptz,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted', 'expired')),
  accepted_at timestamptz NOT NULL,
  score_percent double precision,
  grade double precision,
  UNIQUE (exam_id, user_id, number)
);
-- At most one running attempt per student and exam.
CREATE UNIQUE INDEX attempts_one_in_progress_idx ON attempts (exam_id, user_id) WHERE status = 'in_progress';
CREATE INDEX attempts_user_idx ON attempts (user_id);
CREATE INDEX attempts_status_deadline_idx ON attempts (status, deadline_at);

CREATE TABLE attempt_answers (
  attempt_id uuid NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
  exercise_id uuid NOT NULL REFERENCES exercises (id),
  workbook jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  score double precision,
  max_score double precision,
  details jsonb,
  graded_at timestamptz,
  PRIMARY KEY (attempt_id, exercise_id)
);
