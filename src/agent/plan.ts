import { validateTimeline, type SourceInfo, type Timeline } from '../core/timeline';
import type { FileAnalysis } from '../analysis';
import type { ProjectScan } from '../project/scan';
import type { RoleAssignment, TimingDriver } from '../project/roles';
import { AgentError, type AgentModel, type ModelTurn, type ToolDef } from './model';
import { buildPlanMessage, buildSystemPrompt, type EngineCapabilities } from './prompt';

export type NotFollowed = { instruction: string; source: 'prompt'; reason: string };
export type PlanContext = { prompt: string; guideline: string | null; scan: ProjectScan; analysis: Record<string, FileAnalysis>;
  roles: RoleAssignment[]; driver: TimingDriver; capabilities: EngineCapabilities };

const MAX_ATTEMPTS = 3;

export const SUBMIT_TIMELINE: ToolDef = {
  name: 'submit_timeline',
  description: 'Submit the complete edit as a timeline, plus the prompt instructions that were not followed because a higher authority overrides them.',
  input_schema: {
    type: 'object',
    properties: {
      timeline: { type: 'object', description: 'The timeline, in the exact format described in the user message.' },
      notFollowed: {
        type: 'array',
        items: { type: 'object', properties: { instruction: { type: 'string' }, source: { type: 'string', enum: ['prompt'] }, reason: { type: 'string' } },
          required: ['instruction', 'source', 'reason'] },
      },
    },
    required: ['timeline', 'notFollowed'],
  },
};

/** App-level checks validateTimeline cannot know: segments come from raw/, audio only from allowed references. */
function checkSources(t: Timeline, ctx: PlanContext): string[] {
  const raw = new Set(ctx.scan.raw.map(m => m.path));
  const audioOk = new Set(ctx.roles.filter(r => r.role === 'narration' || r.role === 'music' || (r.role === 'style' && r.useAudio)).map(r => r.path));
  const errors: string[] = [];
  for (const s of t.segments) {
    if (!raw.has(s.source)) errors.push(`segment ${s.id}: source ${s.source} is not a raw file; cut only from: ${[...raw].join(', ')}`);
  }
  for (const a of t.audio) {
    if (!audioOk.has(a.source)) {
      errors.push(`audio ${a.id}: source ${a.source} may not be used as audio; allowed: ${[...audioOk].join(', ') || 'none'} (clip sound goes through segment clipGain)`);
    }
  }
  return errors;
}

function parseNotFollowed(v: unknown): NotFollowed[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap(x => (x && typeof x.instruction === 'string' && typeof x.reason === 'string'
    ? [{ instruction: x.instruction, source: 'prompt' as const, reason: x.reason }] : []));
}

function assistantMessage(turn: ModelTurn) {
  const content = turn.assistantContent ?? [
    ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
    ...turn.toolCalls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
  ];
  return { role: 'assistant', content };
}

export async function planTimeline(ctx: PlanContext, model: AgentModel): Promise<{ timeline: Timeline; notFollowed: NotFollowed[] }> {
  const sources: SourceInfo = {};
  for (const m of [...ctx.scan.raw, ...ctx.scan.references.media]) sources[m.path] = { durationSec: m.durationSec };

  const system = buildSystemPrompt({ guideline: ctx.guideline, capabilities: ctx.capabilities });
  const messages: unknown[] = [{ role: 'user', content: await buildPlanMessage(ctx) }];
  let lastErrors: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const turn = await model.run({ system, messages, tools: [SUBMIT_TIMELINE] });
    const call = turn.toolCalls.find(c => c.name === 'submit_timeline');
    const input = (call?.input ?? {}) as { timeline?: unknown; notFollowed?: unknown };

    if (call) {
      const v = validateTimeline(input.timeline, sources);
      lastErrors = v.ok ? checkSources(v.timeline, ctx) : v.errors;
      if (v.ok && lastErrors.length === 0) {
        const timeline: Timeline = {
          ...v.timeline,
          segments: v.timeline.segments.map(s => ({ ...s, approved: false })),
          captions: v.timeline.captions.map(c => ({ ...c, approved: false })),
        };
        return { timeline, notFollowed: parseNotFollowed(input.notFollowed) };
      }
    } else {
      lastErrors = ['No timeline was submitted. Call the submit_timeline tool.'];
    }

    // Every tool_use needs a tool_result; the submit_timeline result carries the errors.
    const feedback = `The timeline is invalid. Fix these errors and call submit_timeline again with the complete timeline:\n- ${lastErrors.join('\n- ')}`;
    const results = turn.toolCalls.map(c => ({
      type: 'tool_result', tool_use_id: c.id, is_error: true,
      content: c.name === 'submit_timeline' ? feedback : `Unknown tool ${c.name}. Use submit_timeline.`,
    }));
    messages.push(assistantMessage(turn));
    messages.push({ role: 'user', content: call ? results : [...results, { type: 'text', text: lastErrors[0] }] });
  }
  throw new AgentError('INVALID_AFTER_RETRIES', `No valid timeline after ${MAX_ATTEMPTS} attempts: ${lastErrors.join('; ')}`);
}
