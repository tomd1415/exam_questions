/**
 * Seed 2 questions per expected_response_type (34 total) and pre-load them
 * into a fresh topic-set attempt owned by a dedicated test pupil. Intended
 * for hand-testing every widget variant end-to-end without polluting the
 * random-draw pool that real pupils pull from.
 *
 *   npm run test-questions:seed                   -- defaults to pupil 'test_pupil'
 *   npm run test-questions:seed -- --dry-run      -- validate only, no writes
 *   npm run test-questions:seed -- --reset        -- purge previous test questions first
 *
 * Idempotent: each test question is keyed by similarity_hash
 * 'test:<type>-<n>' and is written with active=false + approval_status=
 * 'approved'. Inactive questions are excluded from random topic-set draws
 * but remain attemptable once linked into an attempt_questions row, so the
 * pre-built test attempt picks them up while regular classes don't.
 */
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool as defaultPool } from '../db/pool.js';
import { CurriculumRepo } from '../repos/curriculum.js';
import { QuestionRepo } from '../repos/questions.js';
import {
  validateQuestionDraft,
  type QuestionDraft,
  type QuestionDraftReferenceData,
} from '../lib/question-invariants.js';
import { validatePartConfig } from '../lib/widgets.js';
import { hashPassword } from '../lib/passwords.js';

const TEST_HASH_PREFIX = 'test:';
const DEFAULT_PUPIL_USERNAME = 'test_pupil';
const DEFAULT_TEACHER_USERNAME = 'test_teacher';
const DEFAULT_CLASS_NAME = 'Widget Test Harness';
const DEFAULT_ACADEMIC_YEAR = '2025-26';
const DEFAULT_TOPIC_CODE = '1.1';
const DEFAULT_SUBTOPIC_CODE = '1.1.1';
const DEFAULT_COMPONENT_CODE = 'J277/01';

interface TestPartDef {
  label?: string;
  prompt: string;
  marks: number;
  expected_response_type: string;
  part_config: unknown;
  mark_points: {
    text: string;
    accepted_alternatives?: string[];
    marks?: number;
    is_required?: boolean;
  }[];
}

interface TestQuestionDef {
  suffix: string;
  stem: string;
  expected_response_type: string;
  model_answer: string;
  command_word_code: string;
  archetype_code: string;
  difficulty_band?: number;
  parts: TestPartDef[];
}

function buildQuestions(): TestQuestionDef[] {
  const defs: TestQuestionDef[] = [];

  // multiple_choice
  defs.push({
    suffix: 'multiple_choice-1',
    stem: 'Which component performs arithmetic and logic operations inside the CPU?',
    expected_response_type: 'multiple_choice',
    model_answer: 'ALU',
    command_word_code: 'identify',
    archetype_code: 'recall',
    parts: [
      {
        prompt: 'Select one.',
        marks: 1,
        expected_response_type: 'multiple_choice',
        part_config: { options: ['ALU', 'CU', 'Cache', 'Register'] },
        mark_points: [{ text: 'ALU' }],
      },
    ],
  });
  defs.push({
    suffix: 'multiple_choice-2',
    stem: 'Which storage type is volatile?',
    expected_response_type: 'multiple_choice',
    model_answer: 'RAM',
    command_word_code: 'identify',
    archetype_code: 'recall',
    parts: [
      {
        prompt: 'Select one.',
        marks: 1,
        expected_response_type: 'multiple_choice',
        part_config: { options: ['RAM', 'ROM', 'HDD', 'SSD'] },
        mark_points: [{ text: 'RAM' }],
      },
    ],
  });

  // tick_box
  defs.push({
    suffix: 'tick_box-1',
    stem: 'Tick every item that is an example of secondary storage.',
    expected_response_type: 'tick_box',
    model_answer: JSON.stringify(['HDD', 'SSD', 'Optical disc']),
    command_word_code: 'tick',
    archetype_code: 'recall',
    parts: [
      {
        prompt: 'Tick all that apply.',
        marks: 3,
        expected_response_type: 'tick_box',
        part_config: { options: ['RAM', 'HDD', 'SSD', 'Optical disc', 'Cache'] },
        mark_points: [{ text: 'HDD' }, { text: 'SSD' }, { text: 'Optical disc' }],
      },
    ],
  });
  defs.push({
    suffix: 'tick_box-2',
    stem: 'Tick exactly two characteristics of RAM.',
    expected_response_type: 'tick_box',
    model_answer: JSON.stringify(['Volatile', 'Read/write']),
    command_word_code: 'tick',
    archetype_code: 'recall',
    parts: [
      {
        prompt: 'Tick exactly two.',
        marks: 2,
        expected_response_type: 'tick_box',
        part_config: {
          options: ['Volatile', 'Non-volatile', 'Read/write', 'Read-only'],
          tickExactly: 2,
        },
        mark_points: [{ text: 'Volatile' }, { text: 'Read/write' }],
      },
    ],
  });

  // short_text
  defs.push({
    suffix: 'short_text-1',
    stem: 'State what ALU stands for.',
    expected_response_type: 'short_text',
    model_answer: 'Arithmetic Logic Unit',
    command_word_code: 'state',
    archetype_code: 'recall',
    parts: [
      {
        prompt: 'One-line answer.',
        marks: 1,
        expected_response_type: 'short_text',
        part_config: null,
        mark_points: [
          {
            text: 'Arithmetic Logic Unit',
            accepted_alternatives: ['arithmetic logic unit', 'ALU'],
          },
        ],
      },
    ],
  });
  defs.push({
    suffix: 'short_text-2',
    stem: 'State the unit that stores 1024 kilobytes.',
    expected_response_type: 'short_text',
    model_answer: 'megabyte',
    command_word_code: 'state',
    archetype_code: 'recall',
    parts: [
      {
        prompt: 'One-line answer.',
        marks: 1,
        expected_response_type: 'short_text',
        part_config: null,
        mark_points: [
          { text: 'megabyte', accepted_alternatives: ['MB', 'Megabyte', 'mega byte'] },
        ],
      },
    ],
  });

  // medium_text
  defs.push({
    suffix: 'medium_text-1',
    stem: 'Describe the role of the control unit in the CPU.',
    expected_response_type: 'medium_text',
    model_answer:
      'The control unit fetches instructions from memory, decodes them into signals, and coordinates the rest of the CPU so each instruction is carried out in the correct order.',
    command_word_code: 'describe',
    archetype_code: 'explain',
    parts: [
      {
        prompt: 'Answer in 2–3 sentences.',
        marks: 3,
        expected_response_type: 'medium_text',
        part_config: null,
        mark_points: [
          { text: 'Fetches instructions from memory.' },
          { text: 'Decodes instructions into control signals.' },
          { text: 'Coordinates/directs other CPU components.' },
        ],
      },
    ],
  });
  defs.push({
    suffix: 'medium_text-2',
    stem: 'Describe two differences between RAM and ROM.',
    expected_response_type: 'medium_text',
    model_answer:
      'RAM is volatile and loses its contents when power is removed, whereas ROM is non-volatile. RAM is read/write during normal operation while ROM is typically read-only.',
    command_word_code: 'describe',
    archetype_code: 'compare',
    parts: [
      {
        prompt: 'Give two contrasting points.',
        marks: 2,
        expected_response_type: 'medium_text',
        part_config: null,
        mark_points: [
          { text: 'RAM is volatile; ROM is non-volatile.' },
          { text: 'RAM is read/write in normal use; ROM is read-only.' },
        ],
      },
    ],
  });

  // extended_response
  defs.push({
    suffix: 'extended_response-1',
    stem: 'Discuss the trade-offs a school should consider when choosing between HDD and SSD storage for its desktop computers.',
    expected_response_type: 'extended_response',
    model_answer:
      'SSDs are faster and more robust but cost more per gigabyte; HDDs are cheaper and higher-capacity but slower and more fragile. A school running many identical desktops has to balance the upfront budget against day-to-day responsiveness, lifespan under heavy reboot cycles, and the cost of replacing failed drives.',
    command_word_code: 'discuss',
    archetype_code: 'evaluate',
    difficulty_band: 5,
    parts: [
      {
        prompt: 'Write 6–8 sentences.',
        marks: 6,
        expected_response_type: 'extended_response',
        part_config: null,
        mark_points: [
          { text: 'SSD is faster (lower access times).' },
          { text: 'SSD is more robust / no moving parts.' },
          { text: 'HDD is cheaper per gigabyte.' },
          { text: 'HDD offers higher maximum capacity.' },
          { text: 'Evaluation weighing cost vs. responsiveness.' },
          { text: 'Consideration of lifespan / reliability.' },
        ],
      },
    ],
  });
  defs.push({
    suffix: 'extended_response-2',
    stem: 'Discuss the ethical and legal issues raised by large-scale data collection by online services.',
    expected_response_type: 'extended_response',
    model_answer:
      'Large-scale data collection raises privacy concerns, because users may not know what is stored or how it is used. Legislation such as the Data Protection Act / UK GDPR requires a lawful basis and retention limits. Ethically, there are questions of consent, profiling, and the power imbalance between big platforms and individuals; these must be weighed against legitimate uses such as fraud detection.',
    command_word_code: 'discuss',
    archetype_code: 'evaluate',
    difficulty_band: 6,
    parts: [
      {
        prompt: 'Write 6–8 sentences.',
        marks: 6,
        expected_response_type: 'extended_response',
        part_config: null,
        mark_points: [
          { text: 'Privacy: users often unaware of what is stored.' },
          { text: 'Legal basis and retention rules under UK GDPR.' },
          { text: 'Consent and transparency as ethical requirements.' },
          { text: 'Profiling / targeted advertising concerns.' },
          { text: 'Power imbalance between platforms and individuals.' },
          { text: 'Balanced evaluation against legitimate uses.' },
        ],
      },
    ],
  });

  // code
  defs.push({
    suffix: 'code-1',
    stem: 'Write a Python function add(a, b) that returns the sum of two integers.',
    expected_response_type: 'code',
    model_answer: 'def add(a, b):\n    return a + b',
    command_word_code: 'write_rewrite',
    archetype_code: 'code_writing',
    parts: [
      {
        prompt: 'Write the function.',
        marks: 2,
        expected_response_type: 'code',
        part_config: null,
        mark_points: [
          { text: 'Function signature def add(a, b).' },
          { text: 'Returns a + b.' },
        ],
      },
    ],
  });
  defs.push({
    suffix: 'code-2',
    stem: 'Write a Python loop that prints every integer from 1 to 10 inclusive.',
    expected_response_type: 'code',
    model_answer: 'for i in range(1, 11):\n    print(i)',
    command_word_code: 'write_rewrite',
    archetype_code: 'code_writing',
    parts: [
      {
        prompt: 'Write the loop.',
        marks: 2,
        expected_response_type: 'code',
        part_config: null,
        mark_points: [
          { text: 'Iterates from 1 to 10 inclusive.' },
          { text: 'Prints each value.' },
        ],
      },
    ],
  });

  // algorithm
  defs.push({
    suffix: 'algorithm-1',
    stem: 'Describe, in pseudocode or numbered steps, a linear search over an unsorted list for a target value.',
    expected_response_type: 'algorithm',
    model_answer:
      '1. For each item in the list (from first to last):\n2.   If the item equals the target, return its index.\n3. If the loop finishes without a match, return -1.',
    command_word_code: 'describe',
    archetype_code: 'algorithm_completion',
    parts: [
      {
        prompt: 'Write the steps of the algorithm.',
        marks: 3,
        expected_response_type: 'algorithm',
        part_config: null,
        mark_points: [
          { text: 'Iterates over each item in order.' },
          { text: 'Compares item to target; returns index on match.' },
          { text: 'Returns not-found sentinel when no match.' },
        ],
      },
    ],
  });
  defs.push({
    suffix: 'algorithm-2',
    stem: 'Describe the steps of a bubble sort on a list of integers.',
    expected_response_type: 'algorithm',
    model_answer:
      '1. Repeat until no swaps are made in a full pass:\n2.   For each adjacent pair (i, i+1):\n3.     If list[i] > list[i+1], swap them.\n4. The list is now sorted.',
    command_word_code: 'describe',
    archetype_code: 'algorithm_completion',
    parts: [
      {
        prompt: 'Write the steps of bubble sort.',
        marks: 4,
        expected_response_type: 'algorithm',
        part_config: null,
        mark_points: [
          { text: 'Outer loop repeats while swaps are still being made.' },
          { text: 'Inner loop compares adjacent pairs.' },
          { text: 'Swap when left > right.' },
          { text: 'Stops when a pass has no swaps.' },
        ],
      },
    ],
  });

  // trace_table
  defs.push({
    suffix: 'trace_table-1',
    stem: 'Trace the following loop:\n  total ← 0\n  for i = 1 to 3\n    total ← total + i\n  next i\nRecord the value of total after each iteration.',
    expected_response_type: 'trace_table',
    model_answer: JSON.stringify({ '0,0': '1', '0,1': '1', '1,0': '2', '1,1': '3', '2,0': '3', '2,1': '6' }),
    command_word_code: 'complete',
    archetype_code: 'trace_table',
    parts: [
      {
        prompt: 'Fill in the trace table.',
        marks: 6,
        expected_response_type: 'trace_table',
        part_config: {
          columns: [{ name: 'i' }, { name: 'total' }],
          rows: 3,
          expected: {
            '0,0': '1',
            '0,1': '1',
            '1,0': '2',
            '1,1': '3',
            '2,0': '3',
            '2,1': '6',
          },
          marking: { mode: 'perCell' },
        },
        mark_points: [
          { text: 'Row 0: i=1' },
          { text: 'Row 0: total=1' },
          { text: 'Row 1: i=2' },
          { text: 'Row 1: total=3' },
          { text: 'Row 2: i=3' },
          { text: 'Row 2: total=6' },
        ],
      },
    ],
  });
  defs.push({
    suffix: 'trace_table-2',
    stem: 'Complete the truth table for Q = A AND (NOT B).',
    expected_response_type: 'trace_table',
    model_answer: JSON.stringify({
      '0,2': '0',
      '1,2': '1',
      '2,2': '0',
      '3,2': '0',
    }),
    command_word_code: 'complete',
    archetype_code: 'trace_table',
    parts: [
      {
        prompt: 'Fill in the Q column.',
        marks: 4,
        expected_response_type: 'trace_table',
        part_config: {
          columns: [{ name: 'A' }, { name: 'B' }, { name: 'Q' }],
          rows: 4,
          prefill: {
            '0,0': '0',
            '0,1': '0',
            '1,0': '1',
            '1,1': '0',
            '2,0': '0',
            '2,1': '1',
            '3,0': '1',
            '3,1': '1',
          },
          expected: { '0,2': '0', '1,2': '1', '2,2': '0', '3,2': '0' },
          marking: { mode: 'perCell' },
        },
        mark_points: [
          { text: 'Q=0 when A=0, B=0' },
          { text: 'Q=1 when A=1, B=0' },
          { text: 'Q=0 when A=0, B=1' },
          { text: 'Q=0 when A=1, B=1' },
        ],
      },
    ],
  });

  // matrix_tick_single
  defs.push({
    suffix: 'matrix_tick_single-1',
    stem: 'Classify each component as input, output, or storage.',
    expected_response_type: 'matrix_tick_single',
    model_answer: JSON.stringify({
      Keyboard: 'Input',
      Monitor: 'Output',
      HDD: 'Storage',
    }),
    command_word_code: 'tick',
    archetype_code: 'recall',
    parts: [
      {
        prompt: 'Tick one column for each row.',
        marks: 3,
        expected_response_type: 'matrix_tick_single',
        part_config: {
          rows: ['Keyboard', 'Monitor', 'HDD'],
          columns: ['Input', 'Output', 'Storage'],
          correctByRow: ['Input', 'Output', 'Storage'],
          allOrNothing: false,
        },
        mark_points: [
          { text: 'Keyboard — Input' },
          { text: 'Monitor — Output' },
          { text: 'HDD — Storage' },
        ],
      },
    ],
  });
  defs.push({
    suffix: 'matrix_tick_single-2',
    stem: 'Classify each algorithm as sorting or searching.',
    expected_response_type: 'matrix_tick_single',
    model_answer: JSON.stringify({
      'Bubble sort': 'Sorting',
      'Linear search': 'Searching',
      'Merge sort': 'Sorting',
      'Binary search': 'Searching',
    }),
    command_word_code: 'tick',
    archetype_code: 'recall',
    parts: [
      {
        prompt: 'Tick one column for each row.',
        marks: 4,
        expected_response_type: 'matrix_tick_single',
        part_config: {
          rows: ['Bubble sort', 'Linear search', 'Merge sort', 'Binary search'],
          columns: ['Sorting', 'Searching'],
          correctByRow: ['Sorting', 'Searching', 'Sorting', 'Searching'],
          allOrNothing: false,
        },
        mark_points: [
          { text: 'Bubble sort — Sorting' },
          { text: 'Linear search — Searching' },
          { text: 'Merge sort — Sorting' },
          { text: 'Binary search — Searching' },
        ],
      },
    ],
  });

  // matrix_tick_multi
  defs.push({
    suffix: 'matrix_tick_multi-1',
    stem: 'For each storage type, tick every property that applies.',
    expected_response_type: 'matrix_tick_multi',
    model_answer: JSON.stringify({
      RAM: ['Volatile', 'Read/write'],
      ROM: ['Non-volatile', 'Read-only'],
    }),
    command_word_code: 'tick',
    archetype_code: 'recall',
    parts: [
      {
        prompt: 'Tick every box that applies.',
        marks: 4,
        expected_response_type: 'matrix_tick_multi',
        part_config: {
          rows: ['RAM', 'ROM'],
          columns: ['Volatile', 'Non-volatile', 'Read/write', 'Read-only'],
          correctByRow: [
            ['Volatile', 'Read/write'],
            ['Non-volatile', 'Read-only'],
          ],
          partialCredit: true,
        },
        mark_points: [
          { text: 'RAM — Volatile' },
          { text: 'RAM — Read/write' },
          { text: 'ROM — Non-volatile' },
          { text: 'ROM — Read-only' },
        ],
      },
    ],
  });
  defs.push({
    suffix: 'matrix_tick_multi-2',
    stem: 'For each network layer, tick every protocol commonly associated with it.',
    expected_response_type: 'matrix_tick_multi',
    model_answer: JSON.stringify({
      Application: ['HTTP', 'SMTP'],
      Transport: ['TCP'],
    }),
    command_word_code: 'tick',
    archetype_code: 'recall',
    parts: [
      {
        prompt: 'Tick every box that applies.',
        marks: 3,
        expected_response_type: 'matrix_tick_multi',
        part_config: {
          rows: ['Application', 'Transport'],
          columns: ['HTTP', 'SMTP', 'TCP', 'IP'],
          correctByRow: [['HTTP', 'SMTP'], ['TCP']],
          partialCredit: true,
        },
        mark_points: [
          { text: 'Application — HTTP' },
          { text: 'Application — SMTP' },
          { text: 'Transport — TCP' },
        ],
      },
    ],
  });

  // cloze_free
  defs.push({
    suffix: 'cloze_free-1',
    stem: 'Complete the sentences about primary memory.',
    expected_response_type: 'cloze_free',
    model_answer: JSON.stringify({ g1: 'volatile', g2: 'non-volatile' }),
    command_word_code: 'complete',
    archetype_code: 'recall',
    parts: [
      {
        prompt: 'Type each missing term.',
        marks: 2,
        expected_response_type: 'cloze_free',
        part_config: {
          text: 'RAM is {{g1}} memory. ROM is {{g2}} memory.',
          gaps: [
            { id: 'g1', accept: ['volatile'] },
            { id: 'g2', accept: ['non-volatile', 'nonvolatile'] },
          ],
        },
        mark_points: [
          { text: 'volatile', accepted_alternatives: ['volatile'] },
          { text: 'non-volatile', accepted_alternatives: ['non-volatile', 'nonvolatile'] },
        ],
      },
    ],
  });
  defs.push({
    suffix: 'cloze_free-2',
    stem: 'Complete the sentence about binary.',
    expected_response_type: 'cloze_free',
    model_answer: JSON.stringify({ u1: 'byte', u2: 'kilobyte' }),
    command_word_code: 'complete',
    archetype_code: 'recall',
    parts: [
      {
        prompt: 'Type each missing unit.',
        marks: 2,
        expected_response_type: 'cloze_free',
        part_config: {
          text: '8 bits make a {{u1}}; 1000 bytes make a {{u2}}.',
          gaps: [
            { id: 'u1', accept: ['byte'] },
            { id: 'u2', accept: ['kilobyte', 'KB'] },
          ],
        },
        mark_points: [
          { text: 'byte' },
          { text: 'kilobyte', accepted_alternatives: ['kilobyte', 'KB'] },
        ],
      },
    ],
  });

  // cloze_with_bank
  defs.push({
    suffix: 'cloze_with_bank-1',
    stem: 'Drag the correct device into each gap.',
    expected_response_type: 'cloze_with_bank',
    model_answer: JSON.stringify({ d1: 'switch', d2: 'router' }),
    command_word_code: 'complete',
    archetype_code: 'recall',
    parts: [
      {
        prompt: 'Fill both gaps from the bank.',
        marks: 2,
        expected_response_type: 'cloze_with_bank',
        part_config: {
          text: 'A {{d1}} forwards frames within a LAN; a {{d2}} forwards packets between networks.',
          gaps: [
            { id: 'd1', accept: ['switch'] },
            { id: 'd2', accept: ['router'] },
          ],
          bank: ['switch', 'router', 'hub', 'bridge'],
        },
        mark_points: [{ text: 'switch' }, { text: 'router' }],
      },
    ],
  });
  defs.push({
    suffix: 'cloze_with_bank-2',
    stem: 'Drag the correct layer into each gap.',
    expected_response_type: 'cloze_with_bank',
    model_answer: JSON.stringify({ l1: 'Application', l2: 'Transport' }),
    command_word_code: 'complete',
    archetype_code: 'recall',
    parts: [
      {
        prompt: 'Fill both gaps from the bank.',
        marks: 2,
        expected_response_type: 'cloze_with_bank',
        part_config: {
          text: 'HTTP works at the {{l1}} layer; TCP works at the {{l2}} layer.',
          gaps: [
            { id: 'l1', accept: ['Application'] },
            { id: 'l2', accept: ['Transport'] },
          ],
          bank: ['Application', 'Transport', 'Network', 'Link'],
        },
        mark_points: [{ text: 'Application' }, { text: 'Transport' }],
      },
    ],
  });

  // cloze_code
  defs.push({
    suffix: 'cloze_code-1',
    stem: 'Complete the pseudocode loop that sums 1..10.',
    expected_response_type: 'cloze_code',
    model_answer: JSON.stringify({ stop: '10', op: '+' }),
    command_word_code: 'complete',
    archetype_code: 'code_writing',
    parts: [
      {
        prompt: 'Fill the gaps.',
        marks: 2,
        expected_response_type: 'cloze_code',
        part_config: {
          text: 'total = 0\nfor i = 1 to {{stop}}\n  total = total {{op}} i\nnext i',
          gaps: [
            { id: 'stop', accept: ['10'] },
            { id: 'op', accept: ['+'] },
          ],
        },
        mark_points: [{ text: '10' }, { text: '+' }],
      },
    ],
  });
  defs.push({
    suffix: 'cloze_code-2',
    stem: 'Complete the Python range() call that iterates 0..4 inclusive.',
    expected_response_type: 'cloze_code',
    model_answer: JSON.stringify({ start: '0', stop: '5' }),
    command_word_code: 'complete',
    archetype_code: 'code_writing',
    parts: [
      {
        prompt: 'Fill the gaps.',
        marks: 2,
        expected_response_type: 'cloze_code',
        part_config: {
          text: 'for i in range({{start}}, {{stop}}):\n    print(i)',
          gaps: [
            { id: 'start', accept: ['0'] },
            { id: 'stop', accept: ['5'] },
          ],
        },
        mark_points: [{ text: '0' }, { text: '5' }],
      },
    ],
  });

  // matching
  defs.push({
    suffix: 'matching-1',
    stem: 'Match each protocol to what it is commonly used for.',
    expected_response_type: 'matching',
    model_answer: JSON.stringify([
      [0, 0],
      [1, 1],
      [2, 2],
    ]),
    command_word_code: 'identify',
    archetype_code: 'recall',
    parts: [
      {
        prompt: 'Pair each left item with a right item.',
        marks: 3,
        expected_response_type: 'matching',
        part_config: {
          left: ['HTTP', 'SMTP', 'FTP'],
          right: ['Web pages', 'Email', 'File transfer', 'Remote shell'],
          correctPairs: [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
          partialCredit: true,
        },
        mark_points: [
          { text: 'HTTP — Web pages' },
          { text: 'SMTP — Email' },
          { text: 'FTP — File transfer' },
        ],
      },
    ],
  });
  defs.push({
    suffix: 'matching-2',
    stem: 'Match each logic operator to its symbol.',
    expected_response_type: 'matching',
    model_answer: JSON.stringify([
      [0, 0],
      [1, 1],
      [2, 2],
    ]),
    command_word_code: 'identify',
    archetype_code: 'recall',
    parts: [
      {
        prompt: 'Pair each operator with its symbol.',
        marks: 3,
        expected_response_type: 'matching',
        part_config: {
          left: ['AND', 'OR', 'NOT'],
          right: ['∧', '∨', '¬', '⊕'],
          correctPairs: [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
          partialCredit: true,
        },
        mark_points: [{ text: 'AND — ∧' }, { text: 'OR — ∨' }, { text: 'NOT — ¬' }],
      },
    ],
  });

  // logic_diagram
  defs.push({
    suffix: 'logic_diagram-1',
    stem: 'Draw a logic circuit that implements Q = A AND (NOT B).',
    expected_response_type: 'logic_diagram',
    model_answer:
      'NOT gate with B as input; AND gate takes A and NOT B as inputs; output Q.',
    command_word_code: 'draw',
    archetype_code: 'explain',
    parts: [
      {
        prompt: 'Draw the circuit.',
        marks: 3,
        expected_response_type: 'logic_diagram',
        part_config: { variant: 'image', canvas: { width: 600, height: 400 } },
        mark_points: [
          { text: 'NOT gate fed by input B.' },
          { text: 'AND gate fed by A and NOT B.' },
          { text: 'Output Q labelled on AND output.' },
        ],
      },
    ],
  });
  defs.push({
    suffix: 'logic_diagram-2',
    stem: 'Name the gate in the circuit below that completes Q = A OR B.',
    expected_response_type: 'logic_diagram',
    model_answer: JSON.stringify({ g1: 'OR' }),
    command_word_code: 'identify',
    archetype_code: 'recall',
    parts: [
      {
        prompt: 'Name the missing gate.',
        marks: 1,
        expected_response_type: 'logic_diagram',
        part_config: {
          variant: 'gate_in_box',
          canvas: { width: 600, height: 400 },
          terminals: [
            { id: 'A', label: 'A', kind: 'input', x: 40, y: 120 },
            { id: 'B', label: 'B', kind: 'input', x: 40, y: 220 },
            { id: 'Q', label: 'Q', kind: 'output', x: 540, y: 170 },
          ],
          gates: [
            { id: 'g1', accept: ['OR', 'or'], x: 260, y: 140, width: 140, height: 80 },
          ],
          wires: [
            { from: 'A', to: 'g1' },
            { from: 'B', to: 'g1' },
            { from: 'g1', to: 'Q' },
          ],
        },
        mark_points: [{ text: 'OR' }],
      },
    ],
  });

  // diagram_labels
  defs.push({
    suffix: 'diagram_labels-1',
    stem: 'Label the parts of the CPU block diagram.',
    expected_response_type: 'diagram_labels',
    model_answer: JSON.stringify({ alu: 'ALU', cu: 'CU', reg: 'Registers' }),
    command_word_code: 'label',
    archetype_code: 'recall',
    parts: [
      {
        prompt: 'Type a label into each hotspot.',
        marks: 3,
        expected_response_type: 'diagram_labels',
        part_config: {
          imageUrl: '/static/diagrams/cpu.png',
          imageAlt: 'Block diagram of a CPU with three unlabelled regions.',
          width: 600,
          height: 200,
          hotspots: [
            { id: 'alu', x: 40, y: 60, width: 140, height: 80, accept: ['ALU', 'arithmetic logic unit'] },
            { id: 'cu', x: 220, y: 60, width: 140, height: 80, accept: ['CU', 'control unit'] },
            { id: 'reg', x: 400, y: 60, width: 160, height: 80, accept: ['Registers', 'register file'] },
          ],
        },
        mark_points: [
          { text: 'ALU', accepted_alternatives: ['ALU', 'arithmetic logic unit'] },
          { text: 'CU', accepted_alternatives: ['CU', 'control unit'] },
          { text: 'Registers', accepted_alternatives: ['Registers', 'register file'] },
        ],
      },
    ],
  });
  defs.push({
    suffix: 'diagram_labels-2',
    stem: 'Label the hardware in the star network topology diagram.',
    expected_response_type: 'diagram_labels',
    model_answer: JSON.stringify({ centre: 'switch', host: 'client' }),
    command_word_code: 'label',
    archetype_code: 'recall',
    parts: [
      {
        prompt: 'Type a label into each hotspot.',
        marks: 2,
        expected_response_type: 'diagram_labels',
        part_config: {
          imageUrl: '/static/diagrams/star.png',
          imageAlt: 'Star topology with one central device and several leaf devices.',
          width: 600,
          height: 400,
          hotspots: [
            { id: 'centre', x: 260, y: 170, width: 120, height: 60, accept: ['switch', 'hub'] },
            { id: 'host', x: 40, y: 40, width: 120, height: 40, accept: ['client', 'host', 'computer'] },
          ],
        },
        mark_points: [
          { text: 'switch', accepted_alternatives: ['switch', 'hub'] },
          { text: 'client', accepted_alternatives: ['client', 'host', 'computer'] },
        ],
      },
    ],
  });

  // flowchart
  defs.push({
    suffix: 'flowchart-1',
    stem: 'Draw a flowchart that outputs the larger of two inputs A and B.',
    expected_response_type: 'flowchart',
    model_answer:
      'Start terminator → input A and B → decision "A > B?" → Yes branch outputs A; No branch outputs B → Stop terminator.',
    command_word_code: 'draw',
    archetype_code: 'explain',
    parts: [
      {
        prompt: 'Draw the flowchart.',
        marks: 4,
        expected_response_type: 'flowchart',
        part_config: { variant: 'image', canvas: { width: 600, height: 500 } },
        mark_points: [
          { text: 'Start and Stop terminators.' },
          { text: 'Input of A and B.' },
          { text: 'Decision "A > B?" with Yes/No branches.' },
          { text: 'Output A on Yes; output B on No.' },
        ],
      },
    ],
  });
  defs.push({
    suffix: 'flowchart-2',
    stem: 'Complete the flowchart by filling the blank shapes.',
    expected_response_type: 'flowchart',
    model_answer: JSON.stringify({ q1: 'A > B', out_a: 'Output A', out_b: 'Output B' }),
    command_word_code: 'complete',
    archetype_code: 'algorithm_completion',
    parts: [
      {
        prompt: 'Fill each blank shape.',
        marks: 3,
        expected_response_type: 'flowchart',
        part_config: {
          variant: 'shapes',
          canvas: { width: 600, height: 500 },
          shapes: [
            { id: 'start', type: 'terminator', x: 220, y: 20, width: 160, height: 50, text: 'Start' },
            {
              id: 'q1',
              type: 'decision',
              x: 200,
              y: 100,
              width: 200,
              height: 80,
              accept: ['A > B', 'Is A greater than B?', 'A>B'],
            },
            {
              id: 'out_a',
              type: 'io',
              x: 60,
              y: 220,
              width: 180,
              height: 50,
              accept: ['Output A', 'Print A'],
            },
            {
              id: 'out_b',
              type: 'io',
              x: 360,
              y: 220,
              width: 180,
              height: 50,
              accept: ['Output B', 'Print B'],
            },
            { id: 'stop', type: 'terminator', x: 220, y: 310, width: 160, height: 50, text: 'Stop' },
          ],
          arrows: [
            { from: 'start', to: 'q1' },
            { from: 'q1', to: 'out_a', label: 'Yes' },
            { from: 'q1', to: 'out_b', label: 'No' },
            { from: 'out_a', to: 'stop' },
            { from: 'out_b', to: 'stop' },
          ],
        },
        mark_points: [
          { text: 'Decision text: A > B' },
          { text: 'Yes branch: Output A' },
          { text: 'No branch: Output B' },
        ],
      },
    ],
  });

  return defs;
}

export interface SeedOptions {
  pupilUsername: string;
  teacherUsername: string;
  className: string;
  academicYear: string;
  topicCode: string;
  subtopicCode: string;
  componentCode: string;
  dryRun: boolean;
  reset: boolean;
}

export interface RunSummary {
  scanned: number;
  created: number;
  updated: number;
  failed: number;
  curatedAttached: number;
  attemptId: string | null;
  pupilLogin: { username: string; password: string } | null;
  errors: { key: string; message: string }[];
}

async function ensureUser(
  pool: Pool,
  opts: { role: 'pupil' | 'teacher'; username: string; displayName: string; pseudonym: string },
): Promise<{ id: string; password: string | null }> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id::text FROM users WHERE username = $1 LIMIT 1`,
    [opts.username],
  );
  if (existing.rows.length > 0) return { id: existing.rows[0]!.id, password: null };

  const password =
    opts.role === 'pupil' ? 'test-pupil-0000' : randomBytes(16).toString('hex');
  const passwordHash = await hashPassword(password);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users
       (role, display_name, username, password_hash, must_change_password, pseudonym, active)
     VALUES ($1, $2, $3, $4, false, $5, true)
     RETURNING id::text`,
    [opts.role, opts.displayName, opts.username, passwordHash, opts.pseudonym],
  );
  return { id: rows[0]!.id, password };
}

async function ensureClass(
  pool: Pool,
  opts: { name: string; teacherId: string; academicYear: string },
): Promise<string> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id::text FROM classes
      WHERE name = $1 AND academic_year = $2 AND teacher_id = $3::bigint
      LIMIT 1`,
    [opts.name, opts.academicYear, opts.teacherId],
  );
  if (existing.rows.length > 0) return existing.rows[0]!.id;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO classes (name, teacher_id, academic_year)
     VALUES ($1, $2::bigint, $3)
     RETURNING id::text`,
    [opts.name, opts.teacherId, opts.academicYear],
  );
  return rows[0]!.id;
}

async function ensureEnrolment(pool: Pool, classId: string, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO enrolments (class_id, user_id)
     VALUES ($1::bigint, $2::bigint)
     ON CONFLICT DO NOTHING`,
    [classId, userId],
  );
}

async function purgePreviousTestQuestions(client: PoolClient): Promise<void> {
  // attempt_questions → attempt_parts/awarded_marks cascade via attempt_questions FK;
  // attempts row itself remains if the attempt referenced non-test questions too,
  // but our test attempts only reference test questions so it is safe to cascade.
  await client.query(
    `DELETE FROM attempts
       WHERE id IN (
         SELECT DISTINCT aq.attempt_id
           FROM attempt_questions aq
           JOIN questions q ON q.id = aq.question_id
          WHERE q.similarity_hash LIKE $1
       )`,
    [`${TEST_HASH_PREFIX}%`],
  );
  await client.query(
    `DELETE FROM questions WHERE similarity_hash LIKE $1`,
    [`${TEST_HASH_PREFIX}%`],
  );
}

export async function seedTestQuestions(
  opts: SeedOptions,
  pool: Pool = defaultPool,
): Promise<RunSummary> {
  const summary: RunSummary = {
    scanned: 0,
    created: 0,
    updated: 0,
    failed: 0,
    curatedAttached: 0,
    attemptId: null,
    pupilLogin: null,
    errors: [],
  };

  const defs = buildQuestions();
  summary.scanned = defs.length;

  const curriculumRepo = new CurriculumRepo(pool);
  const questionRepo = new QuestionRepo(pool);
  const refs: QuestionDraftReferenceData = await curriculumRepo.getReferenceData();

  if (opts.reset && !opts.dryRun) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await purgePreviousTestQuestions(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  const pupilPseudonym = 'TST-PUP-00';
  const teacherPseudonym = 'TST-TCH-00';
  const pupil = opts.dryRun
    ? { id: '0', password: null }
    : await ensureUser(pool, {
        role: 'pupil',
        username: opts.pupilUsername,
        displayName: 'Widget Test Pupil',
        pseudonym: pupilPseudonym,
      });
  const teacher = opts.dryRun
    ? { id: '0', password: null }
    : await ensureUser(pool, {
        role: 'teacher',
        username: opts.teacherUsername,
        displayName: 'Widget Test Teacher',
        pseudonym: teacherPseudonym,
      });
  const classId = opts.dryRun
    ? '0'
    : await ensureClass(pool, {
        name: opts.className,
        teacherId: teacher.id,
        academicYear: opts.academicYear,
      });
  if (!opts.dryRun) await ensureEnrolment(pool, classId, pupil.id);
  if (pupil.password) summary.pupilLogin = { username: opts.pupilUsername, password: pupil.password };

  const createdQuestionIds: string[] = [];

  for (const def of defs) {
    const hash = `${TEST_HASH_PREFIX}${def.suffix}`;
    const totalMarks = def.parts.reduce((n, p) => n + p.marks, 0);

    const draft: QuestionDraft = {
      component_code: opts.componentCode,
      topic_code: opts.topicCode,
      subtopic_code: opts.subtopicCode,
      command_word_code: def.command_word_code,
      archetype_code: def.archetype_code,
      stem: def.stem,
      expected_response_type: def.expected_response_type,
      model_answer: def.model_answer,
      feedback_template: null,
      difficulty_band: def.difficulty_band ?? 3,
      difficulty_step: 1,
      source_type: 'imported_pattern',
      review_notes: null,
      parts: def.parts.map((p, idx) => ({
        part_label: p.label ?? `(${String.fromCharCode(97 + idx)})`,
        prompt: p.prompt,
        marks: p.marks,
        expected_response_type: p.expected_response_type,
        part_config: p.part_config,
        mark_points: p.mark_points.map((mp) => ({
          text: mp.text,
          accepted_alternatives: mp.accepted_alternatives ?? [],
          marks: mp.marks ?? 1,
          is_required: mp.is_required ?? false,
        })),
        misconceptions: [],
      })),
    };

    const validation = validateQuestionDraft(draft, refs);
    if (!validation.ok) {
      summary.failed++;
      summary.errors.push({
        key: def.suffix,
        message: `invariants: ${validation.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
      });
      continue;
    }

    const configIssues: string[] = [];
    validation.value.parts.forEach((p, idx) => {
      for (const issue of validatePartConfig(p.expected_response_type, p.part_config)) {
        configIssues.push(`parts.${String(idx)}.part_config: ${issue.message}`);
      }
    });
    if (configIssues.length > 0) {
      summary.failed++;
      summary.errors.push({
        key: def.suffix,
        message: `widget config: ${configIssues.join('; ')}`,
      });
      continue;
    }

    if (opts.dryRun) {
      const existingId = await questionRepo.findIdBySimilarityHash(hash);
      if (existingId) summary.updated++;
      else summary.created++;
      continue;
    }

    const existingId = await questionRepo.findIdBySimilarityHash(hash);
    let questionId: string;
    if (existingId) {
      await questionRepo.updateWithChildren(existingId, {
        ...validation.value,
        created_by: teacher.id,
      });
      questionId = existingId;
      summary.updated++;
    } else {
      questionId = await questionRepo.createWithChildren({
        ...validation.value,
        created_by: teacher.id,
      });
      await questionRepo.setSimilarityHash(questionId, hash);
      summary.created++;
    }
    await questionRepo.setApprovalStatus(questionId, {
      approval_status: 'approved',
      approved_by: teacher.id,
      active: false,
      review_notes: null,
    });
    void totalMarks;
    createdQuestionIds.push(questionId);
  }

  // Also pull in every approved, active, non-retired curated question so the
  // test pupil's pre-built attempt exercises the live content bank alongside
  // the internal widget fixtures. Curated rows carry similarity_hash
  // 'curated:<external_key>' (see seed-curated-content.ts) — filter on that
  // prefix so ad-hoc teacher-authored content doesn't get pulled in.
  const curatedQuestionIds: string[] = [];
  if (!opts.dryRun) {
    const { rows: curatedRows } = await pool.query<{ id: string }>(
      `SELECT id::text
         FROM questions
        WHERE similarity_hash LIKE 'curated:%'
          AND approval_status = 'approved'
          AND active = true
          AND retired_at IS NULL
        ORDER BY topic_code, subtopic_code, id`,
    );
    for (const row of curatedRows) curatedQuestionIds.push(row.id);
    summary.curatedAttached = curatedQuestionIds.length;
  }

  const attachableIds = [...createdQuestionIds, ...curatedQuestionIds];

  if (!opts.dryRun && attachableIds.length > 0 && summary.failed === 0) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Remove any prior open test attempt for this pupil so a re-run starts
      // fresh. Earlier attempts (if any) were already torn down by --reset.
      await client.query(
        `DELETE FROM attempts
           WHERE user_id = $1::bigint
             AND class_id = $2::bigint
             AND submitted_at IS NULL`,
        [pupil.id, classId],
      );

      const { rows: attemptRow } = await client.query<{ id: string }>(
        `INSERT INTO attempts (user_id, class_id, mode, target_topic_code, reveal_mode)
         VALUES ($1::bigint, $2::bigint, 'topic_set', $3, 'whole_attempt')
         RETURNING id::text`,
        [pupil.id, classId, opts.topicCode],
      );
      const attemptId = attemptRow[0]!.id;

      for (let i = 0; i < attachableIds.length; i++) {
        const qid = attachableIds[i]!;
        const { rows: aqRow } = await client.query<{ id: string }>(
          `INSERT INTO attempt_questions (attempt_id, question_id, display_order)
           VALUES ($1::bigint, $2::bigint, $3)
           RETURNING id::text`,
          [attemptId, qid, i + 1],
        );
        const aqId = aqRow[0]!.id;
        await client.query(
          `INSERT INTO attempt_parts (attempt_question_id, question_part_id, raw_answer)
             SELECT $1::bigint, qp.id, ''
               FROM question_parts qp
              WHERE qp.question_id = $2::bigint
              ORDER BY qp.display_order`,
          [aqId, qid],
        );
      }

      await client.query('COMMIT');
      summary.attemptId = attemptId;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  return summary;
}

function printSummary(summary: RunSummary, opts: SeedOptions): void {
  console.log(
    `Test-question seed: scanned=${summary.scanned} created=${summary.created} updated=${summary.updated} failed=${summary.failed}`,
  );
  if (summary.pupilLogin) {
    console.log(
      `  ✓ pupil '${summary.pupilLogin.username}' created (password: ${summary.pupilLogin.password})`,
    );
  } else if (!opts.dryRun) {
    console.log(`  ✓ pupil '${opts.pupilUsername}' already existed (password unchanged)`);
  }
  if (summary.attemptId) {
    const total = summary.created + summary.updated + summary.curatedAttached;
    console.log(
      `  ✓ pre-loaded attempt ${summary.attemptId} with ${total} questions (${summary.created + summary.updated} widget fixtures + ${summary.curatedAttached} curated)`,
    );
    console.log(`    Sign in as '${opts.pupilUsername}' and continue the in-progress attempt.`);
  }
  if (summary.errors.length > 0) {
    console.error('Errors:');
    for (const e of summary.errors) console.error(`  ${e.key}: ${e.message}`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'pupil-username': { type: 'string' },
      'teacher-username': { type: 'string' },
      'class-name': { type: 'string' },
      'academic-year': { type: 'string' },
      'topic-code': { type: 'string' },
      'subtopic-code': { type: 'string' },
      'component-code': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      reset: { type: 'boolean', default: false },
    },
  });

  const opts: SeedOptions = {
    pupilUsername: values['pupil-username'] ?? DEFAULT_PUPIL_USERNAME,
    teacherUsername: values['teacher-username'] ?? DEFAULT_TEACHER_USERNAME,
    className: values['class-name'] ?? DEFAULT_CLASS_NAME,
    academicYear: values['academic-year'] ?? DEFAULT_ACADEMIC_YEAR,
    topicCode: values['topic-code'] ?? DEFAULT_TOPIC_CODE,
    subtopicCode: values['subtopic-code'] ?? DEFAULT_SUBTOPIC_CODE,
    componentCode: values['component-code'] ?? DEFAULT_COMPONENT_CODE,
    dryRun: values['dry-run'] ?? false,
    reset: values.reset ?? false,
  };

  const summary = await seedTestQuestions(opts);
  printSummary(summary, opts);
  await defaultPool.end();
  process.exit(summary.failed > 0 ? 1 : 0);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(async (err) => {
    console.error(err);
    await defaultPool.end();
    process.exit(1);
  });
}
