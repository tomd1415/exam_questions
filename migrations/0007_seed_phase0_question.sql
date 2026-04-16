-- Phase 0 seed: one handcrafted question + supporting fixtures so /q/1 is reachable.
-- Idempotent: re-running has no effect on existing rows.
--
-- Fixtures created:
--   * users          'phase0_seed'   (inactive teacher; cannot log in; used as created_by)
--   * classes        'Phase 0 Demo'  (owned by phase0_seed; attempts are attributed here)
--   * questions      handcrafted ALU question (1 part, 2 marks)
--   * question_parts (a) "Describe the purpose of the ALU."
--   * mark_points    arithmetic / logical operation points
--
-- This intentionally does NOT seed enrolments. Phase 0 attempts are attributed
-- to the demo class regardless of enrolment; enrolment enforcement is Phase 1+.

BEGIN;

-- 1. Seeder user. password_hash is a deliberately invalid bcrypt-shape string
--    so login is impossible even before we set active=false.
INSERT INTO users (role, display_name, username, password_hash, must_change_password, active, pseudonym)
VALUES (
  'teacher',
  'Phase 0 Seed (system)',
  'phase0_seed',
  '$argon2id$v=19$m=19456,t=2,p=1$disabled$disabled',
  false,
  false,
  'SYS-PHASE0'
)
ON CONFLICT (username) DO NOTHING;

-- 2. Demo class owned by the seeder.
INSERT INTO classes (name, teacher_id, academic_year, active)
SELECT 'Phase 0 Demo', u.id, '2025/26', true
FROM users u
WHERE u.username = 'phase0_seed'
ON CONFLICT (teacher_id, academic_year, name) DO NOTHING;

-- 3. Question + part + mark points. Only seed if no question with this stem exists.
DO $$
DECLARE
  v_seeder_id BIGINT;
  v_question_id BIGINT;
  v_part_id BIGINT;
BEGIN
  SELECT id INTO v_seeder_id FROM users WHERE username = 'phase0_seed';
  IF v_seeder_id IS NULL THEN
    RAISE EXCEPTION 'phase0_seed user missing — preceding insert failed';
  END IF;

  IF EXISTS (SELECT 1 FROM questions WHERE stem = 'Inside the CPU is the Arithmetic Logic Unit (ALU).') THEN
    RETURN;
  END IF;

  INSERT INTO questions (
    component_code, topic_code, subtopic_code, command_word_code, archetype_code,
    stem, marks_total, expected_response_type, model_answer, feedback_template,
    difficulty_band, difficulty_step, source_type, approval_status, active, created_by, approved_by
  )
  VALUES (
    'J277/01', '1.1', '1.1.1', 'describe', 'explain',
    'Inside the CPU is the Arithmetic Logic Unit (ALU).',
    2,
    'short_text',
    'The ALU carries out arithmetic operations (e.g. addition, subtraction) and logical operations (e.g. AND, OR, comparisons) on data.',
    NULL,
    3, 1,
    'teacher', 'approved', true,
    v_seeder_id, v_seeder_id
  )
  RETURNING id INTO v_question_id;

  INSERT INTO question_parts (question_id, part_label, prompt, marks, expected_response_type, display_order)
  VALUES (
    v_question_id, '(a)',
    'Describe the purpose of the ALU.',
    2, 'short_text', 1
  )
  RETURNING id INTO v_part_id;

  INSERT INTO mark_points (question_part_id, text, accepted_alternatives, marks, is_required, display_order)
  VALUES
    (v_part_id, 'Performs arithmetic operations',
     ARRAY['arithmetic', 'addition', 'subtraction', 'maths', 'calculations'], 1, false, 1),
    (v_part_id, 'Performs logical operations',
     ARRAY['logic', 'logical', 'AND', 'OR', 'NOT', 'comparison', 'comparisons', 'boolean'], 1, false, 2);
END
$$;

COMMIT;
