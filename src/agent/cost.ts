/** List prices (USD per million tokens) of the default model, claude-opus-5-5; settings defaults (Task 10). */
export const DEFAULT_INPUT_PRICE_PER_MTOK = 4;
export const DEFAULT_OUTPUT_PRICE_PER_MTOK = 20;

const TOKENS_PER_FRAME = 700;
const CHARS_PER_TOKEN = 3;
const OUTPUT_TOKENS = 6000;

export function estimateCost(o: { frames: number; textChars: number; inputPricePerMTok: number; outputPricePerMTok: number }):
  { inputTokens: number; outputTokens: number; usd: number } {
  const inputTokens = o.frames * TOKENS_PER_FRAME + Math.ceil(o.textChars / CHARS_PER_TOKEN);
  const usd = (inputTokens * o.inputPricePerMTok + OUTPUT_TOKENS * o.outputPricePerMTok) / 1_000_000;
  return { inputTokens, outputTokens: OUTPUT_TOKENS, usd: Math.round(usd * 1e6) / 1e6 };
}
