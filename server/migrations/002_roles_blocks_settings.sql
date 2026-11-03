-- 002: teacher role + user management, exercise bank metadata, ownership, exam blocks and exam settings.
-- Additive: 001 is never edited, existing data is migrated in place.

/* ---------- Users: teacher role, deactivation, forced password change ---------- */

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('student', 'teacher', 'admin'));
ALTER TABLE users ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
CREATE INDEX users_role_idx ON users (role);

/* ---------- Exercises: bank metadata + owner ---------- */

ALTER TABLE exercises ADD COLUMN owner_id uuid REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE exercises ADD COLUMN difficulty text NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard'));
ALTER TABLE exercises ADD COLUMN tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE exercises ADD COLUMN estimated_minutes integer CHECK (estimated_minutes IS NULL OR estimated_minutes > 0);
ALTER TABLE exercises ADD COLUMN category text;
CREATE INDEX exercises_owner_idx ON exercises (owner_id);

UPDATE exercises
   SET owner_id = COALESCE(created_by, (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at, id LIMIT 1))
 WHERE owner_id IS NULL;

/* ---------- Exams: owner + settings ---------- */

ALTER TABLE exams ADD COLUMN owner_id uuid REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE exams ADD COLUMN description text NOT NULL DEFAULT '';
ALTER TABLE exams ADD COLUMN shuffle_blocks boolean NOT NULL DEFAULT false;
ALTER TABLE exams ADD COLUMN feedback_mode text NOT NULL DEFAULT 'details' CHECK (feedback_mode IN ('none', 'score', 'details'));
ALTER TABLE exams ADD COLUMN result_mode text NOT NULL DEFAULT 'immediate' CHECK (result_mode IN ('immediate', 'after_close', 'hidden'));
ALTER TABLE exams ADD COLUMN allow_review boolean NOT NULL DEFAULT false;
ALTER TABLE exams ADD COLUMN access_code text;
ALTER TABLE exams ADD COLUMN restricted boolean NOT NULL DEFAULT false;
CREATE INDEX exams_owner_idx ON exams (owner_id);

UPDATE exams
   SET owner_id = COALESCE(created_by, (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at, id LIMIT 1))
 WHERE owner_id IS NULL;

/* ---------- Exam blocks (replace the flat exam_exercises pool) ---------- */

CREATE TABLE exam_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id uuid NOT NULL REFERENCES exams (id) ON DELETE CASCADE,
  position integer NOT NULL,
  title text NOT NULL,
  pick_count integer CHECK (pick_count IS NULL OR pick_count > 0),
  shuffle boolean NOT NULL DEFAULT true
);
CREATE INDEX exam_blocks_exam_idx ON exam_blocks (exam_id, position);

CREATE TABLE exam_block_exercises (
  block_id uuid NOT NULL REFERENCES exam_blocks (id) ON DELETE CASCADE,
  exercise_id uuid NOT NULL REFERENCES exercises (id) ON DELETE CASCADE,
  position integer NOT NULL,
  points_override double precision CHECK (points_override IS NULL OR points_override > 0),
  PRIMARY KEY (block_id, exercise_id)
);
CREATE INDEX exam_block_exercises_exercise_idx ON exam_block_exercises (exercise_id);

-- Every exam that had exercises gets ONE default block that keeps the old pool, order and pick_count.
INSERT INTO exam_blocks (exam_id, position, title, pick_count, shuffle)
SELECT e.id, 0, 'Ejercicios', e.pick_count, true
  FROM exams e
 WHERE EXISTS (SELECT 1 FROM exam_exercises x WHERE x.exam_id = e.id);

INSERT INTO exam_block_exercises (block_id, exercise_id, position)
SELECT b.id, x.exercise_id, x.position
  FROM exam_exercises x JOIN exam_blocks b ON b.exam_id = x.exam_id;

-- "pick at least as many as the pool" meant "everything" before; store that explicitly as NULL.
UPDATE exam_blocks b
   SET pick_count = NULL
 WHERE pick_count IS NOT NULL
   AND pick_count >= (SELECT count(*) FROM exam_block_exercises bx WHERE bx.block_id = b.id);

/* ---------- Access list, extra attempts, attempt snapshots ---------- */

CREATE TABLE exam_access (
  exam_id uuid NOT NULL REFERENCES exams (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (exam_id, user_id)
);
CREATE INDEX exam_access_user_idx ON exam_access (user_id);

CREATE TABLE attempt_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id uuid NOT NULL REFERENCES exams (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  extra integer NOT NULL CHECK (extra BETWEEN 1 AND 5),
  reason text NOT NULL DEFAULT '',
  granted_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attempt_overrides_exam_user_idx ON attempt_overrides (exam_id, user_id);

-- Per-exercise snapshot taken when the attempt is drawn: {"<exerciseId>": {"block": "Title", "override": 5 | null}}.
-- Attempts created before this migration keep '{}' (no block title, no points override).
ALTER TABLE attempts ADD COLUMN exercise_meta jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Deprecated: exam_exercises and exams.pick_count are no longer read by the application (the draw is per block).
-- They are kept so the migration is reversible by hand; pick_count mirrors the block when an exam has exactly one.
COMMENT ON TABLE exam_exercises IS 'DEPRECATED since 002: replaced by exam_blocks + exam_block_exercises';
