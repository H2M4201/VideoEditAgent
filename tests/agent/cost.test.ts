import { describe, it, expect } from 'vitest';
import { estimateCost } from '../../src/agent/cost';

describe('estimateCost', () => {
  it('counts frames, text and a fixed output', () => {
    expect(estimateCost({ frames: 10, textChars: 3000, inputPricePerMTok: 10, outputPricePerMTok: 50 }))
      .toEqual({ inputTokens: 8000, outputTokens: 6000, usd: 0.38 });
  });

  it('rounds partial text tokens up', () => {
    expect(estimateCost({ frames: 0, textChars: 4, inputPricePerMTok: 1, outputPricePerMTok: 0 }).inputTokens).toBe(2);
  });
});
