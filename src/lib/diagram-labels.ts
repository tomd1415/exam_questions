// Diagram-labels widget — Phase 2.5g.
//
// The author bundles an image (PNG, JPEG or SVG) under
// `src/static/curated/` (or any URL the pupil's browser can fetch) and
// defines one or more rectangular hotspots. Each hotspot becomes a
// short text input positioned over its rectangle; the pupil types a
// short label per hotspot.
//
// Used by:
//
//   * the diagram-labels widget template (renders the image with one
//     absolutely-positioned <input> per hotspot);
//   * the deterministic marker (set-match each pupil label against the
//     hotspot's `accept` list, with optional case / whitespace
//     handling).
//
// Pupil answers travel as line-encoded `<hotspotId>=<value>` blocks in
// `attempt_parts.raw_answer`. The widget posts one field per hotspot
// named `part_<partId>__<hotspotId>`; the route aggregator
// (src/routes/attempts.ts:495) turns those into the `id=value` lines.
// Hotspots the pupil left blank are absent.
//
// `imageUrl` is restricted to either a same-origin `/static/...` path
// or an `https://` URL so we never load mixed content. SVG payloads
// are safe under `<img src=…>` because browsers do not execute scripts
// in image-loaded SVGs.

import { EXPECTED_RESPONSE_TYPES } from './question-invariants.js';

export interface DiagramLabelHotspot {
  /** Stable id; used in the form-field name and the raw_answer key. */
  id: string;
  /** Top-left x in image-pixel coordinates (0-based). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Accepted pupil labels, compared after case/whitespace normalisation. */
  accept: readonly string[];
  /** When true, comparisons preserve case. Default false (case-insensitive). */
  caseSensitive?: boolean;
  /** When true (default), trims surrounding whitespace before comparing. */
  trimWhitespace?: boolean;
}

export interface DiagramLabelsConfig {
  /** URL the pupil's browser will fetch the image from. */
  imageUrl: string;
  /** Alt text — required at authoring time so the image has a description. */
  imageAlt: string;
  /** Intrinsic image dimensions (used to size the layered overlay). */
  width: number;
  height: number;
  /** One or more rectangular labelling targets. */
  hotspots: readonly DiagramLabelHotspot[];
}

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function isAcceptableUrl(u: unknown): u is string {
  if (typeof u !== 'string' || u.length === 0) return false;
  if (u.startsWith('/static/')) return true;
  if (u.startsWith('https://')) return true;
  return false;
}

export function isDiagramLabelsConfig(c: unknown): c is DiagramLabelsConfig {
  return validateDiagramLabelsConfigShape(c).length === 0;
}

export function validateDiagramLabelsConfigShape(c: unknown): string[] {
  const issues: string[] = [];
  if (c === null || c === undefined || typeof c !== 'object' || Array.isArray(c)) {
    issues.push('diagram_labels part_config must be an object.');
    return issues;
  }
  const cfg = c as Record<string, unknown>;

  const imageUrl = cfg['imageUrl'];
  const imageAlt = cfg['imageAlt'];
  const width = cfg['width'];
  const height = cfg['height'];
  const hotspots = cfg['hotspots'];

  if (!isAcceptableUrl(imageUrl)) {
    issues.push("diagram_labels.imageUrl must be a non-empty '/static/...' or 'https://' URL.");
  }

  if (typeof imageAlt !== 'string' || imageAlt.trim().length === 0) {
    issues.push('diagram_labels.imageAlt is required (accessibility — describe the image).');
  }

  let imgW = 0;
  let imgH = 0;
  if (typeof width !== 'number' || !Number.isInteger(width) || width < 50 || width > 4000) {
    issues.push('diagram_labels.width must be an integer between 50 and 4000.');
  } else {
    imgW = width;
  }
  if (typeof height !== 'number' || !Number.isInteger(height) || height < 50 || height > 4000) {
    issues.push('diagram_labels.height must be an integer between 50 and 4000.');
  } else {
    imgH = height;
  }

  if (!Array.isArray(hotspots) || hotspots.length === 0) {
    issues.push('diagram_labels.hotspots must be a non-empty array.');
  } else {
    const seenIds = new Set<string>();
    for (let i = 0; i < hotspots.length; i += 1) {
      const h: unknown = hotspots[i];
      if (h === null || typeof h !== 'object' || Array.isArray(h)) {
        issues.push(`diagram_labels.hotspots[${i}] must be an object.`);
        continue;
      }
      const ho = h as Record<string, unknown>;
      const id = ho['id'];
      const hx = ho['x'];
      const hy = ho['y'];
      const hw = ho['width'];
      const hh = ho['height'];
      const accept = ho['accept'];
      const caseSensitive = ho['caseSensitive'];
      const trimWhitespace = ho['trimWhitespace'];

      if (typeof id !== 'string' || !ID_RE.test(id)) {
        issues.push(
          `diagram_labels.hotspots[${i}].id must match ${ID_RE.source} (e.g. 'top-router', 'h1').`,
        );
      } else if (seenIds.has(id)) {
        issues.push(`diagram_labels.hotspots reuses id '${id}'; ids must be unique.`);
      } else {
        seenIds.add(id);
      }

      const isInt = (v: unknown): v is number =>
        typeof v === 'number' && Number.isInteger(v) && v >= 0;

      if (!isInt(hx)) {
        issues.push(`diagram_labels.hotspots[${i}].x must be a non-negative integer.`);
      }
      if (!isInt(hy)) {
        issues.push(`diagram_labels.hotspots[${i}].y must be a non-negative integer.`);
      }
      if (typeof hw !== 'number' || !Number.isInteger(hw) || hw < 20) {
        issues.push(`diagram_labels.hotspots[${i}].width must be an integer ≥ 20.`);
      }
      if (typeof hh !== 'number' || !Number.isInteger(hh) || hh < 20) {
        issues.push(`diagram_labels.hotspots[${i}].height must be an integer ≥ 20.`);
      }
      if (
        imgW > 0 &&
        isInt(hx) &&
        typeof hw === 'number' &&
        Number.isInteger(hw) &&
        hx + hw > imgW
      ) {
        issues.push(`diagram_labels.hotspots[${i}] extends past image width.`);
      }
      if (
        imgH > 0 &&
        isInt(hy) &&
        typeof hh === 'number' &&
        Number.isInteger(hh) &&
        hy + hh > imgH
      ) {
        issues.push(`diagram_labels.hotspots[${i}] extends past image height.`);
      }

      if (!Array.isArray(accept) || accept.length === 0) {
        issues.push(`diagram_labels.hotspots[${i}].accept must be a non-empty string array.`);
      } else if (!accept.every((v) => typeof v === 'string' && v.length > 0)) {
        issues.push(`diagram_labels.hotspots[${i}].accept entries must be non-empty strings.`);
      }

      if (caseSensitive !== undefined && typeof caseSensitive !== 'boolean') {
        issues.push(`diagram_labels.hotspots[${i}].caseSensitive must be a boolean if present.`);
      }
      if (trimWhitespace !== undefined && typeof trimWhitespace !== 'boolean') {
        issues.push(`diagram_labels.hotspots[${i}].trimWhitespace must be a boolean if present.`);
      }

      for (const key of Object.keys(ho)) {
        if (
          key !== 'id' &&
          key !== 'x' &&
          key !== 'y' &&
          key !== 'width' &&
          key !== 'height' &&
          key !== 'accept' &&
          key !== 'caseSensitive' &&
          key !== 'trimWhitespace'
        ) {
          issues.push(`diagram_labels.hotspots[${i}] has unsupported key '${key}'.`);
        }
      }
    }
  }

  for (const key of Object.keys(cfg)) {
    if (
      key !== 'imageUrl' &&
      key !== 'imageAlt' &&
      key !== 'width' &&
      key !== 'height' &&
      key !== 'hotspots'
    ) {
      issues.push(`diagram_labels part_config has unsupported key '${key}'.`);
    }
  }

  return issues;
}

/**
 * Parses the line-encoded raw_answer into a Map keyed by hotspot id.
 * Last value wins if a hotspot id is repeated; lines without a `=` or
 * whose key fails the id regex are ignored (defensive — the form
 * builder always emits well-formed lines).
 */
export function parseDiagramLabelsRawAnswer(rawAnswer: string): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof rawAnswer !== 'string' || rawAnswer.length === 0) return out;
  for (const line of rawAnswer.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (!ID_RE.test(key)) continue;
    out.set(key, value);
  }
  return out;
}

/**
 * Emits a stable `id=value` serialisation in the same order as
 * `config.hotspots`. Hotspots the pupil left blank are skipped.
 */
export function serialiseDiagramLabelsAnswer(
  config: DiagramLabelsConfig,
  pupilLabels: ReadonlyMap<string, string>,
): string {
  const lines: string[] = [];
  for (const hs of config.hotspots) {
    const v = pupilLabels.get(hs.id);
    if (v === undefined || v.length === 0) continue;
    lines.push(`${hs.id}=${v}`);
  }
  return lines.join('\n');
}

function normaliseLabel(value: string, hs: DiagramLabelHotspot): string {
  let v = value;
  if (hs.trimWhitespace !== false) v = v.trim();
  if (hs.caseSensitive !== true) v = v.toLowerCase();
  return v;
}

export interface DiagramLabelOutcome {
  hotspotId: string;
  pupilValue: string | null;
  hit: boolean;
}

export interface DiagramLabelsMarkResult {
  outcomes: DiagramLabelOutcome[];
  hits: number;
  total: number;
}

/**
 * Marks a pupil answer against a diagram-labels config. A blank
 * hotspot never hits; otherwise the pupil's label must match (under
 * the hotspot's normalisation rules) one of the strings in `accept`.
 */
export function markDiagramLabels(
  config: DiagramLabelsConfig,
  pupilLabels: ReadonlyMap<string, string>,
): DiagramLabelsMarkResult {
  const outcomes: DiagramLabelOutcome[] = [];
  let hits = 0;
  for (const hs of config.hotspots) {
    const raw = pupilLabels.get(hs.id);
    if (raw === undefined || raw.length === 0) {
      outcomes.push({ hotspotId: hs.id, pupilValue: null, hit: false });
      continue;
    }
    const normPupil = normaliseLabel(raw, hs);
    const hit = hs.accept.some((a) => normaliseLabel(a, hs) === normPupil);
    if (hit) hits += 1;
    outcomes.push({ hotspotId: hs.id, pupilValue: raw, hit });
  }
  return { outcomes, hits, total: config.hotspots.length };
}

// Module-load guard: keeps the type in sync with the central list.
{
  if (!EXPECTED_RESPONSE_TYPES.includes('diagram_labels')) {
    throw new Error("EXPECTED_RESPONSE_TYPES is missing 'diagram_labels'.");
  }
}
