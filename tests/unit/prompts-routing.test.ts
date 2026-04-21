import { describe, expect, it } from 'vitest';
import { promptNameForResponseType } from '../../src/services/prompts.js';

// Chunk 3f routing map. Adding a new open-response type means wiring
// a prompt for it — this test keeps the map honest so a typo never
// silently falls through to `wrong_type` and leaves the pupil's
// answer stuck in teacher_pending.

describe('promptNameForResponseType', () => {
  it('maps English prose types to mark_open_response', () => {
    expect(promptNameForResponseType('medium_text')).toBe('mark_open_response');
    expect(promptNameForResponseType('extended_response')).toBe('mark_open_response');
  });

  it('maps code-like types to mark_code_response', () => {
    expect(promptNameForResponseType('code')).toBe('mark_code_response');
    expect(promptNameForResponseType('algorithm')).toBe('mark_code_response');
  });

  it('returns null for objective and canvas types', () => {
    for (const type of [
      'multiple_choice',
      'tick_box',
      'short_text',
      'matrix_tick_single',
      'matrix_tick_multi',
      'cloze_free',
      'cloze_with_bank',
      'cloze_code',
      'trace_table',
      'matching',
      'diagram_labels',
      'logic_diagram',
      'flowchart',
    ]) {
      expect(promptNameForResponseType(type)).toBeNull();
    }
  });

  it('returns null for an unknown type', () => {
    expect(promptNameForResponseType('not_a_real_type')).toBeNull();
  });
});
