import { describe, it, expect } from 'vitest';
import { canManageClass, canManageClasses } from '../../src/services/classes.js';

describe('canManageClasses', () => {
  it('allows teachers and admins', () => {
    expect(canManageClasses({ role: 'teacher' })).toBe(true);
    expect(canManageClasses({ role: 'admin' })).toBe(true);
  });

  it('rejects pupils', () => {
    expect(canManageClasses({ role: 'pupil' })).toBe(false);
  });
});

describe('canManageClass', () => {
  const cls = { teacher_id: '42' };

  it('allows the owning teacher', () => {
    expect(canManageClass({ id: '42', role: 'teacher' }, cls)).toBe(true);
  });

  it('rejects a different teacher', () => {
    expect(canManageClass({ id: '99', role: 'teacher' }, cls)).toBe(false);
  });

  it('allows any admin regardless of ownership', () => {
    expect(canManageClass({ id: '99', role: 'admin' }, cls)).toBe(true);
  });

  it('rejects pupils even if id matches teacher_id', () => {
    expect(canManageClass({ id: '42', role: 'pupil' }, cls)).toBe(false);
  });
});
