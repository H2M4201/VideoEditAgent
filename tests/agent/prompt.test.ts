import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, type EngineCapabilities } from '../../src/agent/prompt';
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
  it('refuses to run without an API key', async () => {
    const m = new AnthropicModel({ apiKey: '', model: 'claude-opus-5-5' });
    await expect(m.run({ system: 's', messages: [], tools: [] })).rejects.toBeInstanceOf(AgentError);
    await expect(m.run({ system: 's', messages: [], tools: [] })).rejects.toMatchObject({ code: 'NO_API_KEY' });
  });
});
