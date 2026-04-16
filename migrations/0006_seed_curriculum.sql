-- Curriculum seed: J277/01, J277/02, all topics, subtopics, command words, archetypes.
-- Source: OCR J277 specification, version 3.0 (2026), §2b, §2c, §3d.
-- Hand-keyed from OCR_Docs/specification/J277_specification_558027.pdf.
-- Idempotent: re-running has no effect on existing rows.
-- TODO: This seed needs the second human review described in PLAN.md Phase 0.

BEGIN;

-- 1. Components

INSERT INTO components (code, title) VALUES
  ('J277/01', 'Computer systems'),
  ('J277/02', 'Computational thinking, algorithms and programming')
ON CONFLICT (code) DO NOTHING;

-- 2. Topics — J277/01

INSERT INTO topics (code, component_code, title, display_order) VALUES
  ('1.1', 'J277/01', 'Systems architecture',                                                  1),
  ('1.2', 'J277/01', 'Memory and storage',                                                    2),
  ('1.3', 'J277/01', 'Computer networks, connections and protocols',                          3),
  ('1.4', 'J277/01', 'Network security',                                                      4),
  ('1.5', 'J277/01', 'Systems software',                                                      5),
  ('1.6', 'J277/01', 'Ethical, legal, cultural and environmental impacts of digital technology', 6)
ON CONFLICT (code) DO NOTHING;

-- 3. Topics — J277/02

INSERT INTO topics (code, component_code, title, display_order) VALUES
  ('2.1', 'J277/02', 'Algorithms',                                                  1),
  ('2.2', 'J277/02', 'Programming fundamentals',                                    2),
  ('2.3', 'J277/02', 'Producing robust programs',                                   3),
  ('2.4', 'J277/02', 'Boolean logic',                                               4),
  ('2.5', 'J277/02', 'Programming languages and Integrated Development Environments', 5)
ON CONFLICT (code) DO NOTHING;

-- 4. Subtopics — J277/01

INSERT INTO subtopics (code, topic_code, title, display_order) VALUES
  ('1.1.1', '1.1', 'Architecture of the CPU',                                  1),
  ('1.1.2', '1.1', 'CPU performance',                                          2),
  ('1.1.3', '1.1', 'Embedded systems',                                         3),

  ('1.2.1', '1.2', 'Primary storage (memory)',                                 1),
  ('1.2.2', '1.2', 'Secondary storage',                                        2),
  ('1.2.3', '1.2', 'Units',                                                    3),
  ('1.2.4', '1.2', 'Data storage',                                             4),
  ('1.2.5', '1.2', 'Compression',                                              5),

  ('1.3.1', '1.3', 'Networks and topologies',                                  1),
  ('1.3.2', '1.3', 'Wired and wireless networks, protocols and layers',        2),

  ('1.4.1', '1.4', 'Threats to computer systems and networks',                 1),
  ('1.4.2', '1.4', 'Identifying and preventing vulnerabilities',               2),

  ('1.5.1', '1.5', 'Operating systems',                                        1),
  ('1.5.2', '1.5', 'Utility software',                                         2),

  ('1.6.1', '1.6', 'Ethical, legal, cultural and environmental impact',        1)
ON CONFLICT (code) DO NOTHING;

-- 5. Subtopics — J277/02

INSERT INTO subtopics (code, topic_code, title, display_order) VALUES
  ('2.1.1', '2.1', 'Computational thinking',                                   1),
  ('2.1.2', '2.1', 'Designing, creating and refining algorithms',              2),
  ('2.1.3', '2.1', 'Searching and sorting algorithms',                         3),

  ('2.2.1', '2.2', 'Programming fundamentals',                                 1),
  ('2.2.2', '2.2', 'Data types',                                               2),
  ('2.2.3', '2.2', 'Additional programming techniques',                        3),

  ('2.3.1', '2.3', 'Defensive design',                                         1),
  ('2.3.2', '2.3', 'Testing',                                                  2),

  ('2.4.1', '2.4', 'Boolean logic',                                            1),

  ('2.5.1', '2.5', 'Languages',                                                1),
  ('2.5.2', '2.5', 'The Integrated Development Environment (IDE)',             2)
ON CONFLICT (code) DO NOTHING;

-- 6. Command words — OCR J277 spec §3d.
--    Definitions are verbatim from the spec.
--    expected_response_shape is a short tag for prompt-engineering use later.

INSERT INTO command_words (code, definition, expected_response_shape) VALUES
  ('add',
   'Join something to something else so as to increase the size, number, or amount.',
   'addition / instruction'),
  ('analyse',
   'Break down in order to bring out the essential elements or structure. Identify parts and relationships, and interpret information to reach conclusions.',
   'structured breakdown + conclusion'),
  ('annotate',
   'Add brief notes to a diagram or graph.',
   'labels on a given diagram'),
  ('calculate',
   'Obtain a numerical answer showing the relevant stages in the working.',
   'numerical answer with working'),
  ('compare',
   'Give an account of the similarities and differences between two (or more) items or situations, referring to both (all) of them throughout.',
   'similarities and differences, both sides referenced'),
  ('complete',
   'Provide all the necessary or appropriate parts.',
   'fill in missing parts'),
  ('convert',
   'Change the form, character, or function of something.',
   'converted value'),
  ('define',
   'Give the precise meaning of a word, phrase, concept or physical quantity.',
   'single precise definition'),
  ('describe',
   'Give a detailed account or picture of a situation, event, pattern or process.',
   'detailed account'),
  ('design',
   'Produce a plan, simulation or model.',
   'plan, simulation, or model'),
  ('discuss',
   'Offer a considered and balanced review that includes a range of arguments, factors or hypotheses. Opinions or conclusions should be presented clearly and supported by appropriate evidence.',
   'balanced arguments + supported judgement'),
  ('draw',
   'Produce (a picture or diagram) by making lines and marks on paper with a pencil, pen, etc.',
   'diagram'),
  ('evaluate',
   'Assess the implications and limitations. Make judgements about the ideas, works, solutions or methods in relation to selected criteria.',
   'implications and limitations + judgement'),
  ('explain',
   'Give a detailed account including reasons or causes.',
   'fact + reason'),
  ('give',
   'Present information which determines the importance of an event or issue, or to show causation.',
   'brief answer'),
  ('how',
   'In what way or manner; by what means.',
   'method or process'),
  ('identify',
   'Provide an answer from a number of possibilities. Recognise and state briefly a distinguishing factor or feature.',
   'single fact selected from options'),
  ('justify',
   'Give valid reasons or evidence to support an answer or conclusion.',
   'reasons or evidence supporting a position'),
  ('label',
   'Add title, labels or brief explanation(s) to a diagram or graph.',
   'labels on a given diagram'),
  ('list',
   'Give a sequence of brief answers with no explanation.',
   'sequence of brief answers, no explanation'),
  ('order',
   'Put the responses into a logical sequence.',
   'sequence'),
  ('outline',
   'Give a brief account or summary.',
   'brief summary'),
  ('refine',
   'Make more efficient, improve, modify or edit.',
   'improved version'),
  ('show',
   'Give steps in a derivation or calculation.',
   'steps of a derivation or calculation'),
  ('solve',
   'Obtain the answer(s) using algebraic and/or numerical and/or graphical methods.',
   'answer obtained via a method'),
  ('state',
   'Give a specific name, value or other brief answer without explanation or calculation.',
   'single fact or value'),
  ('tick',
   'Mark (an item) with a tick or select (a box) on a form, questionnaire, etc. to indicate that something has been chosen.',
   'selected option(s)'),
  ('what',
   'Asking for information specifying something.',
   'specific information'),
  ('write_rewrite',
   'Mark (letters, words, or other symbols) on a surface, typically paper, with a pen, pencil, or similar implement/write (something) again so as to alter or improve it.',
   'produced or improved text/code')
ON CONFLICT (code) DO NOTHING;

-- 7. Question archetypes — defined in DATA_MODEL.md, not in the OCR spec.

INSERT INTO question_archetypes (code, description) VALUES
  ('recall',                'Single-fact recall (typically state/identify/define).'),
  ('explain',               'Fact + reason or causation (typically explain/describe/give).'),
  ('compare',               'Similarities and differences across two or more items.'),
  ('evaluate',              'Balanced assessment with judgement (evaluate/discuss/justify).'),
  ('algorithm_completion',  'Complete a partially given algorithm (pseudocode or flow).'),
  ('code_writing',          'Write a program/function from scratch in OCR reference language or a high-level language.'),
  ('trace_table',           'Produce or complete a trace table for a given algorithm or program.'),
  ('extended_response',     'Multi-mark structured response, often combining describe + explain + evaluate.')
ON CONFLICT (code) DO NOTHING;

COMMIT;
