import type { MediaInfo } from '../project/scan';
import type { SourceInfo, Timeline } from '../core/timeline';
import type { AgentModel, ModelTurn, ToolDef } from './model';

export type ToolCall = ModelTurn['toolCalls'][number];
/** What `evaluate` decides about one tool call: accept it, or send these errors back to the model. */
export type Attempt<T> = { done: T } | { errors: string[] };

/** The assistant turn as it goes back into the conversation: the raw content when the model gave it (R6), else rebuilt. */
export function assistantMessage(turn: ModelTurn) {
  const content = turn.assistantContent ?? [
    ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
    ...turn.toolCalls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
  ];
  return { role: 'assistant', content };
}

/**
 * Asks the model until `evaluate` accepts the first call to one of `tools`, at most `maxAttempts` turns.
 * A turn without such a call is a failed attempt (R5). Every tool_use of a rejected turn gets a tool_result;
 * the evaluated call's result carries `retryMessage(errors)`.
 */
export async function runToolLoop<T>(o: {
  model: AgentModel; system: string; tools: ToolDef[]; messages: unknown[]; maxAttempts: number;
  evaluate: (call: ToolCall) => Attempt<T> | Promise<Attempt<T>>;
  retryMessage: (errors: string[]) => string;
  noCallMessage: string;
}): Promise<{ ok: true; value: T } | { ok: false; errors: string[] }> {
  const names = o.tools.map(t => t.name);
  const messages = [...o.messages];
  let lastErrors: string[] = [];

  for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
    const turn = await o.model.run({ system: o.system, messages, tools: o.tools });
    const call = turn.toolCalls.find(c => names.includes(c.name));

    if (call) {
      const r = await o.evaluate(call);
      if ('done' in r) return { ok: true, value: r.done };
      lastErrors = r.errors;
    } else {
      lastErrors = [o.noCallMessage];
    }

    const results = turn.toolCalls.map(c => ({
      type: 'tool_result', tool_use_id: c.id, is_error: true,
      content: c === call ? o.retryMessage(lastErrors)
        : names.includes(c.name) ? 'Ignored: only the first tool call of a turn is read.'
        : `Unknown tool ${c.name}. Use ${names.join(' or ')}.`,
    }));
    messages.push(assistantMessage(turn));
    messages.push({ role: 'user', content: call ? results : [...results, { type: 'text', text: lastErrors[0] }] });
  }
  return { ok: false, errors: lastErrors };
}

/** App-level checks validateTimeline cannot know: segments come from raw/, audio only from the allowed files, logos from reference/ images. */
export function checkSources(t: Timeline, allowed: { raw: MediaInfo[]; audio: string[]; images: string[] }): string[] {
  const raw = new Set(allowed.raw.map(m => m.path));
  const audioOk = new Set(allowed.audio);
  const errors: string[] = [];
  for (const s of t.segments) {
    if (!raw.has(s.source)) errors.push(`segment ${s.id}: source ${s.source} is not a raw file; cut only from: ${[...raw].join(', ')}`);
  }
  for (const a of t.audio) {
    if (!audioOk.has(a.source)) {
      errors.push(`audio ${a.id}: source ${a.source} may not be used as audio; allowed: ${[...audioOk].join(', ') || 'none'} (clip sound goes through segment clipGain)`);
    }
  }
  for (const o of t.overlays) {
    if (o.kind === 'logo' && (o.source === undefined || !allowed.images.includes(o.source))) {
      errors.push(`overlay ${o.id}: logo source ${o.source ?? '(none)'} is not an image file in reference/; available: ${allowed.images.join(', ') || 'none (use no logo overlay)'}`);
    }
  }
  return errors;
}

/** Durations of every file a timeline may reference, keyed by project-relative path, for validateTimeline. */
export function sourceInfo(scan: { raw: MediaInfo[]; references: { media: MediaInfo[] } }): SourceInfo {
  const sources: SourceInfo = {};
  for (const m of [...scan.raw, ...scan.references.media]) sources[m.path] = { durationSec: m.durationSec };
  return sources;
}
