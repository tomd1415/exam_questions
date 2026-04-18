// Pupil-facing "how to answer this widget" microcopy.
//
// Each entry is shown at most once per pupil per widget type, the
// first time they see that widget on an attempt page. Dismissal is
// persisted in users.widget_tips_dismissed (migration 0024); the
// route POST /me/widget-tips/dismiss writes the dismissal.
//
// Keys mirror the widget registry's `type` field. Widgets the
// pupil already understands from the question form (multiple_choice,
// short_text, medium_text, code, etc.) deliberately have no entry
// — pupils don't need an interstitial for "type your answer".

import { registeredWidgetTypes } from './widgets.js';

export interface WidgetTip {
  /** Short title for the panel (≤ 6 words). */
  title: string;
  /** One-paragraph plain-language explanation (≤ 280 chars). */
  body: string;
}

export const WIDGET_TIPS: Readonly<Record<string, WidgetTip>> = {
  tick_box: {
    title: 'Tick boxes',
    body: 'Tick every box you think is correct. If a number is shown, tick exactly that many. Wrong ticks cancel out right ticks, so don\u2019t guess.',
  },
  matrix_tick_single: {
    title: 'One tick per row',
    body: 'Each row needs exactly one tick \u2014 pick the column that best matches the row label.',
  },
  matrix_tick_multi: {
    title: 'Several ticks per row',
    body: 'Each row may need none, one, or several ticks. The counter on the right shows how many the row expects so far.',
  },
  cloze_free: {
    title: 'Fill in the gaps',
    body: 'Type a short answer into each gap. Spelling matters, but capitalisation usually doesn\u2019t.',
  },
  cloze_with_bank: {
    title: 'Pick from the word bank',
    body: 'Drag or click words from the bank into the gaps. Some bank words are decoys \u2014 you don\u2019t have to use every one.',
  },
  cloze_code: {
    title: 'Complete the code',
    body: 'Type the missing token into each gap exactly as it would appear in code (case-sensitive). Spaces and punctuation matter.',
  },
  trace_table: {
    title: 'Trace table',
    body: 'Fill in one cell at a time. Pre-filled cells are read-only. Press Ctrl+Z (or \u2318+Z) to undo your last cell edit.',
  },
  matching: {
    title: 'Match prompts to options',
    body: 'For each row on the left, pick the matching option on the right. Some options may not be used; some may be used more than once.',
  },
  diagram_labels: {
    title: 'Label the diagram',
    body: 'Type a short label into each box on the image. Labels are not case-sensitive but spelling matters.',
  },
  logic_diagram: {
    title: 'Draw the logic diagram',
    body: 'Use the pen to draw your gates and wires. Eraser rubs out mistakes; Clear wipes the canvas. The teacher will mark the picture you submit.',
  },
  flowchart: {
    title: 'Draw the flowchart',
    body: 'Use the pen to draw terminators, processes, decisions, and arrows. Eraser rubs out mistakes; Clear wipes the canvas. The teacher will mark the picture you submit.',
  },
};

export function getWidgetTip(widgetKey: string): WidgetTip | null {
  return WIDGET_TIPS[widgetKey] ?? null;
}

/** Pupil widget keys that ship with a tip; helpers for tests / route guards. */
export function widgetKeysWithTips(): readonly string[] {
  return Object.keys(WIDGET_TIPS);
}

/**
 * Validates that `key` is a real widget type with a tip. The route
 * uses this to refuse junk keys before persisting.
 */
export function isWidgetTipKey(key: unknown): key is string {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(WIDGET_TIPS, key);
}

// Module-load guard: every key in WIDGET_TIPS must be a real widget
// type. Catches drift if a widget is removed but the tip is left
// behind. The reverse direction (every widget has a tip) is *not*
// required \u2014 simple widgets like multiple_choice deliberately omit.
{
  const known = new Set(registeredWidgetTypes());
  for (const key of Object.keys(WIDGET_TIPS)) {
    if (!known.has(key)) {
      throw new Error(`WIDGET_TIPS has entry for unknown widget type '${key}'.`);
    }
  }
}
