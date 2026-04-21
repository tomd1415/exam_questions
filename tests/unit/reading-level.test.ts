import { describe, expect, it } from 'vitest';
import {
  ACCEPTABLE_FLESCH_THRESHOLD,
  fleschReadingEase,
  isReadable,
} from '../../src/lib/reading-level.js';

describe('fleschReadingEase', () => {
  it('returns 100 for empty text (degenerate input — not flagged)', () => {
    expect(fleschReadingEase('')).toBe(100);
    expect(fleschReadingEase('   ')).toBe(100);
  });

  it('scores short plain sentences as readable for a GCSE pupil', () => {
    const plain = 'You named the CPU and the GPU. Try to say what each one does.';
    expect(fleschReadingEase(plain)).toBeGreaterThanOrEqual(ACCEPTABLE_FLESCH_THRESHOLD);
    expect(isReadable(plain)).toBe(true);
  });

  it('flags long latinate sentences as hard', () => {
    const hard =
      'The cognitive operationalisation of juxtaposed microprocessor functionalities ' +
      'necessitates contextualised articulation beyond superficial nomenclature, ' +
      'particularly regarding parallelisation and instruction-level parallelism.';
    expect(fleschReadingEase(hard)).toBeLessThan(ACCEPTABLE_FLESCH_THRESHOLD);
    expect(isReadable(hard)).toBe(false);
  });

  it('is monotonic: shorter words → higher score on the same sentence shape', () => {
    const easy = 'The cat sat on the mat. The dog ran to the box.';
    const hard =
      'The feline reclined upon the rectangular textile. The canine ' +
      'sprinted toward the cardboard container.';
    expect(fleschReadingEase(easy)).toBeGreaterThan(fleschReadingEase(hard));
  });

  it('treats a single-token exclamation as readable (no sentence terminator)', () => {
    expect(isReadable('Great work!')).toBe(true);
  });
});
