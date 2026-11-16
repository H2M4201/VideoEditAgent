import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, frameSelection, MAX_IMAGES, MAX_STYLE_IMAGES, type EngineCapabilities } from '../../src/agent/prompt';
import { AgentError, AnthropicModel } from '../../src/agent/model';

const capabilities: EngineCapabilities = { transitions: ['cut', 'fade'], effects: ['pushIn'], captionAnimations: ['line'] };

describe('buildSystemPrompt', () => {
  it('orders rules before guideline', () => {
    const p = buildSystemPrompt({ guideline: 'Use gold captions', capabilities });
    expect(p.indexOf('SYSTEM RULES')).toBeLessThan(p.indexOf('GUIDELINE'));
    expect(p).toContain('Use gold captions');
    expect(p).toContain('notFollowed');
  });

  it('states the authority order, the conflict rule and the system rules verbatim', () => {
    const p = buildSystemPrompt({ guideline: null, capabilities });
    expect(p).toContain("If the user's prompt conflicts with the guideline, follow the guideline and list the prompt instruction in `notFollowed`.");
    expect(p).toContain('Approved segments are locked: no change to their start, duration, content or captions.');
    expect(p).toContain('Audio taken from a downloaded reference is used only on explicit instruction.');
    expect(p.indexOf('GUIDELINE')).toBeLessThan(p.indexOf('order of authority'));
    expect(p).toMatch(/GUIDELINE\s*\n+none/);
  });

  it('lists engine capabilities and output format', () => {
    const p = buildSystemPrompt({ guideline: null, capabilities });
    expect(p).toMatch(/transitions: cut, fade/);
    expect(p).toMatch(/effects: pushIn/);
    expect(p).toMatch(/caption animations: line/);
    expect(p).toContain('1080');
    expect(p).toContain('1920');
    expect(p).toContain('30 fps');
  });

  it('covers language handling', () => {
    const p = buildSystemPrompt({ guideline: null, capabilities });
    expect(p).toMatch(/Vietnamese or English/);
    expect(p).toMatch(/language of the narration/);
  });
});

describe('AnthropicModel', () => {
  const failing = (err: unknown) => {
    const m = new AnthropicModel({ apiKey: 'sk-test', model: 'claude-opus-5-5' });
    (m as unknown as { client: unknown }).client = { messages: { create: async () => { throw err; } } };
    return m.run({ system: 's', messages: [], tools: [] });
  };
  const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });

  it('keeps the HTTP status of API errors; 401/403 are API_KEY_REJECTED, 429 is API_RATE_LIMIT', async () => {
    await expect(failing(apiError(401, 'invalid x-api-key'))).rejects.toMatchObject({ code: 'API_KEY_REJECTED', message: '401: invalid x-api-key' });
    await expect(failing(apiError(403, 'forbidden'))).rejects.toMatchObject({ code: 'API_KEY_REJECTED', message: '403: forbidden' });
    await expect(failing(apiError(429, 'rate limited'))).rejects.toMatchObject({ code: 'API_RATE_LIMIT', message: '429: rate limited' });
    await expect(failing(apiError(529, 'overloaded'))).rejects.toMatchObject({ code: 'API_ERROR', message: '529: overloaded' });
    await expect(failing(new Error('Connection error.'))).rejects.toMatchObject({ code: 'API_ERROR', message: 'Connection error.' });
  });

  it('refuses to run without an API key', async () => {
    const m = new AnthropicModel({ apiKey: '', model: 'claude-opus-5-5' });
    await expect(m.run({ system: 's', messages: [], tools: [] })).rejects.toBeInstanceOf(AgentError);
    await expect(m.run({ system: 's', messages: [], tools: [] })).rejects.toMatchObject({ code: 'NO_API_KEY' });
  });
});

describe('frameSelection', () => {
  const total = (sel: Record<string, number[]>) => Object.values(sel).reduce((n, x) => n + x.length, 0);

  it('sends every frame when all fit', () => {
    expect(frameSelection({ raw: [{ path: 'raw/a', shots: 3 }], style: [{ path: 'reference/s', shots: 2 }] }))
      .toEqual({ 'raw/a': [0, 1, 2], 'reference/s': [0, 1] });
  });

  it('caps the request at 100 images: style at 12 in total, at least 1 per raw file, the rest by shot count, dropped evenly', () => {
    expect([MAX_IMAGES, MAX_STYLE_IMAGES]).toEqual([100, 12]);
    const raw = [...Array.from({ length: 20 }, (_, i) => ({ path: `raw/small${i}`, shots: 1 })), { path: 'raw/big1', shots: 120 }, { path: 'raw/big2', shots: 40 }];
    const style = [{ path: 'reference/s1', shots: 12 }, { path: 'reference/s2', shots: 12 }];
    const sel = frameSelection({ raw, style });
    expect(total(sel)).toBe(100);
    expect(sel['reference/s1'].length + sel['reference/s2'].length).toBe(12);
    expect(sel['reference/s1']).toHaveLength(6);
    for (let i = 0; i < 20; i++) expect(sel[`raw/small${i}`]).toEqual([0]);
    // 88 raw frames: 20 kept for the small files, 68 shared 120:40 between the big ones (after their 1 each)
    expect(sel['raw/big1'].length + sel['raw/big2'].length).toBe(68);
    expect(sel['raw/big1'].length).toBeGreaterThan(sel['raw/big2'].length * 2.5);
    const big2 = sel['raw/big2'];
    expect(big2).toEqual([...big2].sort((a, b) => a - b));
    expect(big2[0]).toBeLessThan(3); expect(big2.at(-1)!).toBeGreaterThan(36); // spread over the whole clip
  });

  it('keeps one frame per raw file even past the budget, then nothing for style', () => {
    const raw = Array.from({ length: 105 }, (_, i) => ({ path: `raw/${i}`, shots: 2 }));
    const sel = frameSelection({ raw, style: [{ path: 'reference/s', shots: 5 }] });
    expect(total(sel)).toBe(105);
    expect(sel['reference/s']).toEqual([]);
  });

  it('files without shots get none', () => {
    expect(frameSelection({ raw: [{ path: 'raw/a', shots: 0 }], style: [] })).toEqual({ 'raw/a': [] });
  });
});
