// Flowchart widget — Phase 2.5h MVP (image variant).
//
// Mirrors the logic_diagram MVP: a pupil draws a flowchart freehand on
// a <canvas> and ships the result as a base64-encoded PNG inside
// `attempt_parts.raw_answer`. The marker is teacher_pending.
//
// `part_config.variant` is required so the structured shape-palette
// variant from the original chunk plan (terminator / process / decision
// / io / arrow) can land later under the same `expected_response_type`
// without a migration — the registry's validator rejects anything other
// than 'image' today with a clear authoring-time message.
//
// The pupil's answer travels as a single line:
//
//     image=data:image/png;base64,<base64chars>
//
// PNG-only for the same reason as logic_diagram: teacher review renders
// with a plain <img> tag and no sanitiser.

import { EXPECTED_RESPONSE_TYPES } from './question-invariants.js';

export type FlowchartVariant = 'image';

export const SUPPORTED_FLOWCHART_VARIANTS: readonly FlowchartVariant[] = ['image'];

export interface FlowchartConfig {
  /** Variant tag — only `'image'` is accepted in the MVP. */
  variant: FlowchartVariant;
  /** Drawing surface in CSS pixels. Both dimensions are positive integers. */
  canvas: { width: number; height: number };
}

/** Hard cap on the length of a stored data URL (≈ 600 KB after base64). */
export const MAX_FLOWCHART_DATA_URL_LENGTH = 600_000;

/** Required prefix on every accepted data URL. */
export const FLOWCHART_DATA_URL_PREFIX = 'data:image/png;base64,';

export function isFlowchartConfig(c: unknown): c is FlowchartConfig {
  return validateFlowchartConfigShape(c).length === 0;
}

export function validateFlowchartConfigShape(c: unknown): string[] {
  const issues: string[] = [];
  if (c === null || c === undefined || typeof c !== 'object' || Array.isArray(c)) {
    issues.push('flowchart part_config must be an object.');
    return issues;
  }
  const cfg = c as Record<string, unknown>;

  const variant = cfg['variant'];
  if (typeof variant !== 'string') {
    issues.push("flowchart.variant is required and must be the string 'image'.");
  } else if (!SUPPORTED_FLOWCHART_VARIANTS.includes(variant as FlowchartVariant)) {
    issues.push(
      `flowchart.variant '${variant}' is not supported (expected one of: ${SUPPORTED_FLOWCHART_VARIANTS.join(', ')}).`,
    );
  }

  const canvas = cfg['canvas'];
  if (
    canvas === null ||
    canvas === undefined ||
    typeof canvas !== 'object' ||
    Array.isArray(canvas)
  ) {
    issues.push('flowchart.canvas must be an object with width and height.');
  } else {
    const cv = canvas as Record<string, unknown>;
    const w = cv['width'];
    const h = cv['height'];
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 100 || w > 2000) {
      issues.push('flowchart.canvas.width must be an integer between 100 and 2000.');
    }
    if (typeof h !== 'number' || !Number.isInteger(h) || h < 100 || h > 2000) {
      issues.push('flowchart.canvas.height must be an integer between 100 and 2000.');
    }
    for (const key of Object.keys(cv)) {
      if (key !== 'width' && key !== 'height') {
        issues.push(`flowchart.canvas has unsupported key '${key}'.`);
      }
    }
  }

  for (const key of Object.keys(cfg)) {
    if (key !== 'variant' && key !== 'canvas') {
      issues.push(`flowchart part_config has unsupported key '${key}'.`);
    }
  }

  return issues;
}

export interface ParsedFlowchartAnswer {
  /** PNG data URL the pupil submitted, or null if no image was saved. */
  image: string | null;
  /** Authoring-time-only debug info — empty in the happy path. */
  errors: string[];
}

/**
 * Parses the line-encoded raw_answer. A well-formed answer is a single
 * `image=<dataURL>` line with a `data:image/png;base64,…` payload. Any
 * other shape yields `image: null` plus one or more error strings.
 */
export function parseFlowchartRawAnswer(rawAnswer: string): ParsedFlowchartAnswer {
  const errors: string[] = [];
  if (typeof rawAnswer !== 'string' || rawAnswer.length === 0) {
    return { image: null, errors };
  }
  let imageLine: string | null = null;
  for (const line of rawAnswer.split('\n')) {
    if (line.length === 0) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      errors.push('flowchart raw_answer line missing "key=value" separator.');
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (key === 'image') {
      imageLine = value;
    } else {
      errors.push(`flowchart raw_answer has unknown key '${key}'.`);
    }
  }
  if (imageLine === null) {
    return { image: null, errors };
  }
  if (imageLine.length > MAX_FLOWCHART_DATA_URL_LENGTH) {
    errors.push(`flowchart image exceeds ${MAX_FLOWCHART_DATA_URL_LENGTH} characters; rejected.`);
    return { image: null, errors };
  }
  if (!imageLine.startsWith(FLOWCHART_DATA_URL_PREFIX)) {
    errors.push(`flowchart image must start with '${FLOWCHART_DATA_URL_PREFIX}'.`);
    return { image: null, errors };
  }
  const payload = imageLine.slice(FLOWCHART_DATA_URL_PREFIX.length);
  if (payload.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    errors.push('flowchart image base64 payload is malformed.');
    return { image: null, errors };
  }
  return { image: imageLine, errors };
}

/**
 * Emits the canonical raw_answer string for a flowchart answer.
 * `null` → empty string ("not attempted").
 */
export function serialiseFlowchartAnswer(image: string | null): string {
  if (image === null || image.length === 0) return '';
  return `image=${image}`;
}

// Module-load guard: keeps the type in sync with the central list.
{
  if (!EXPECTED_RESPONSE_TYPES.includes('flowchart')) {
    throw new Error("EXPECTED_RESPONSE_TYPES is missing 'flowchart'.");
  }
}
