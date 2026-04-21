// Token-to-pence conversion for the Phase 3 marker. The rate card
// is a deliberate flat map rather than a pricing API call — list
// prices change rarely and silent rate drift would poison the cost
// dashboard. When OpenAI changes prices, update this file in the
// same commit as the model pin so git blame tells the story.
//
// Rates are stored as pence-per-million-tokens at integer precision
// to avoid floating-point accumulation in SUM() queries. Pounds are
// the human unit in the dashboard; pence are the storage unit.

export interface ModelRate {
  readonly inputPencePerMillion: number;
  readonly outputPencePerMillion: number;
}

// Rates as of 2026-04-21. USD list prices converted at £0.79 ≈ $1.
// Keep the comment tied to the date so a future reviewer can decide
// whether the numbers are still fresh enough.
export const RATE_CARD: Readonly<Record<string, ModelRate>> = {
  'gpt-5-mini': { inputPencePerMillion: 20, outputPencePerMillion: 158 },
  'gpt-5': { inputPencePerMillion: 99, outputPencePerMillion: 790 },
};

// Unknown models fall back to the most expensive rate so accidental
// drift inflates the cost estimate rather than hiding it.
const FALLBACK_RATE: ModelRate = { inputPencePerMillion: 99, outputPencePerMillion: 790 };

export function costPence(modelId: string, inputTokens: number, outputTokens: number): number {
  const rate = RATE_CARD[modelId] ?? FALLBACK_RATE;
  const inPence = (inputTokens * rate.inputPencePerMillion) / 1_000_000;
  const outPence = (outputTokens * rate.outputPencePerMillion) / 1_000_000;
  return Math.ceil(inPence + outPence);
}
