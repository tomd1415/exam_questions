// Decides whether an attempt_parts.raw_answer should render as an
// image (widgets whose pupil-facing output is a drawing — flowchart
// variant=image, logic_diagram variant=image) or as plain text
// (every other widget). Used by every template that displays a
// pupil answer to a teacher or admin: pupil review, teacher marking,
// AI moderation, and pilot shadow review.
//
// The flowchart + logic_diagram widgets serialise the drawing as:
//   image=data:image/png;base64,<payload>
// matching FLOWCHART_DATA_URL_PREFIX / LOGIC_DIAGRAM_DATA_URL_PREFIX
// in src/lib/flowchart.ts and src/lib/logic-diagram.ts. Any other
// raw_answer shape falls through to the text branch unchanged.
//
// Chunk 3i follow-up: before this helper, admin marking templates
// displayed the raw `image=data:...` string as a <pre>, which looks
// like a URL and is useless for marking — flagged during the first
// pilot day.

const IMAGE_LINE_PREFIX = 'image=data:image/';

export type PupilAnswerView =
  | { kind: 'empty' }
  | { kind: 'image'; dataUrl: string; alt: string }
  | { kind: 'text'; text: string };

export function buildPupilAnswerView(
  rawAnswer: string | null | undefined,
  expectedResponseType: string | null | undefined,
): PupilAnswerView {
  if (!rawAnswer || rawAnswer.length === 0) return { kind: 'empty' };

  // The image variants use a single-line `image=data:image/...` payload
  // at (or near) the start. Trim leading blank lines to be forgiving of
  // incoming data.
  const firstNonBlank = rawAnswer.split('\n').find((line) => line.length > 0) ?? '';
  if (firstNonBlank.startsWith(IMAGE_LINE_PREFIX)) {
    const dataUrl = firstNonBlank.slice('image='.length);
    const widgetName = expectedResponseType ?? 'widget';
    return {
      kind: 'image',
      dataUrl,
      alt: `Pupil's drawn answer (${widgetName})`,
    };
  }

  return { kind: 'text', text: rawAnswer };
}
