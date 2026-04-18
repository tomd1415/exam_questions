// Logic-diagram widget — Phase 2.5f MVP (image variant).
//
// The MVP lets a pupil draw a logic diagram on a <canvas> and ships the
// result as a base64-encoded PNG inside `attempt_parts.raw_answer`. The
// marker is teacher_pending: a teacher views the image on the review
// page and judges it.
//
// `part_config.variant` is required so that future variants
// (`structured_free`, `gate_in_box`, …) can be added without changing
// the response-type code or migrating existing rows. The MVP accepts
// `'image'` only; the registry's validator rejects anything else with
// a clear authoring-time message.
//
// The pupil's answer travels as a single line:
//
//     image=data:image/png;base64,<base64chars>
//
// SVG / JPEG are deliberately excluded: SVG can carry script and JPEG
// is wasteful for line art. Restricting to PNG means the teacher review
// page can render the image with a plain <img> tag and no sanitiser.

import { EXPECTED_RESPONSE_TYPES } from './question-invariants.js';

export type LogicDiagramVariant = 'image';

export const SUPPORTED_LOGIC_DIAGRAM_VARIANTS: readonly LogicDiagramVariant[] = ['image'];

export interface LogicDiagramConfig {
  /** Variant tag — only `'image'` is accepted in the MVP. */
  variant: LogicDiagramVariant;
  /** Drawing surface in CSS pixels. Both dimensions are positive integers. */
  canvas: { width: number; height: number };
}

/** Hard cap on the length of a stored data URL (≈ 600 KB after base64). */
export const MAX_LOGIC_DIAGRAM_DATA_URL_LENGTH = 600_000;

/** Required prefix on every accepted data URL. */
export const LOGIC_DIAGRAM_DATA_URL_PREFIX = 'data:image/png;base64,';

export function isLogicDiagramConfig(c: unknown): c is LogicDiagramConfig {
  return validateLogicDiagramConfigShape(c).length === 0;
}

export function validateLogicDiagramConfigShape(c: unknown): string[] {
  const issues: string[] = [];
  if (c === null || c === undefined || typeof c !== 'object' || Array.isArray(c)) {
    issues.push('logic_diagram part_config must be an object.');
    return issues;
  }
  const cfg = c as Record<string, unknown>;

  const variant = cfg['variant'];
  if (typeof variant !== 'string') {
    issues.push("logic_diagram.variant is required and must be the string 'image'.");
  } else if (!SUPPORTED_LOGIC_DIAGRAM_VARIANTS.includes(variant as LogicDiagramVariant)) {
    issues.push(
      `logic_diagram.variant '${variant}' is not supported (expected one of: ${SUPPORTED_LOGIC_DIAGRAM_VARIANTS.join(', ')}).`,
    );
  }

  const canvas = cfg['canvas'];
  if (
    canvas === null ||
    canvas === undefined ||
    typeof canvas !== 'object' ||
    Array.isArray(canvas)
  ) {
    issues.push('logic_diagram.canvas must be an object with width and height.');
  } else {
    const cv = canvas as Record<string, unknown>;
    const w = cv['width'];
    const h = cv['height'];
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 100 || w > 2000) {
      issues.push('logic_diagram.canvas.width must be an integer between 100 and 2000.');
    }
    if (typeof h !== 'number' || !Number.isInteger(h) || h < 100 || h > 2000) {
      issues.push('logic_diagram.canvas.height must be an integer between 100 and 2000.');
    }
    for (const key of Object.keys(cv)) {
      if (key !== 'width' && key !== 'height') {
        issues.push(`logic_diagram.canvas has unsupported key '${key}'.`);
      }
    }
  }

  for (const key of Object.keys(cfg)) {
    if (key !== 'variant' && key !== 'canvas') {
      issues.push(`logic_diagram part_config has unsupported key '${key}'.`);
    }
  }

  return issues;
}

export interface ParsedLogicDiagramAnswer {
  /** PNG data URL the pupil submitted, or null if no image was saved. */
  image: string | null;
  /** Authoring-time-only debug info — empty in the happy path. */
  errors: string[];
}

/**
 * Parses the line-encoded raw_answer. A well-formed answer is a single
 * `image=<dataURL>` line with a `data:image/png;base64,…` payload. Any
 * other shape yields `image: null` plus one or more error strings; the
 * caller decides how to surface them (the marker treats it as "nothing
 * to mark", the template falls back to a blank canvas).
 */
export function parseLogicDiagramRawAnswer(rawAnswer: string): ParsedLogicDiagramAnswer {
  const errors: string[] = [];
  if (typeof rawAnswer !== 'string' || rawAnswer.length === 0) {
    return { image: null, errors };
  }
  let imageLine: string | null = null;
  for (const line of rawAnswer.split('\n')) {
    if (line.length === 0) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      errors.push('logic_diagram raw_answer line missing "key=value" separator.');
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (key === 'image') {
      imageLine = value;
    } else {
      errors.push(`logic_diagram raw_answer has unknown key '${key}'.`);
    }
  }
  if (imageLine === null) {
    return { image: null, errors };
  }
  if (imageLine.length > MAX_LOGIC_DIAGRAM_DATA_URL_LENGTH) {
    errors.push(
      `logic_diagram image exceeds ${MAX_LOGIC_DIAGRAM_DATA_URL_LENGTH} characters; rejected.`,
    );
    return { image: null, errors };
  }
  if (!imageLine.startsWith(LOGIC_DIAGRAM_DATA_URL_PREFIX)) {
    errors.push(`logic_diagram image must start with '${LOGIC_DIAGRAM_DATA_URL_PREFIX}'.`);
    return { image: null, errors };
  }
  const payload = imageLine.slice(LOGIC_DIAGRAM_DATA_URL_PREFIX.length);
  if (payload.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    errors.push('logic_diagram image base64 payload is malformed.');
    return { image: null, errors };
  }
  return { image: imageLine, errors };
}

/**
 * Emits the canonical raw_answer string for a logic-diagram answer.
 * `null` → empty string ("not attempted").
 */
export function serialiseLogicDiagramAnswer(image: string | null): string {
  if (image === null || image.length === 0) return '';
  return `image=${image}`;
}

// Module-load guard: keeps the type in sync with the central list.
{
  if (!EXPECTED_RESPONSE_TYPES.includes('logic_diagram')) {
    throw new Error("EXPECTED_RESPONSE_TYPES is missing 'logic_diagram'.");
  }
}
