import { validateTimeline, type Timeline } from '../core/timeline';
import type { FileAnalysis } from '../analysis';
import type { ProjectScan } from '../project/scan';
import type { RoleAssignment, TimingDriver } from '../project/roles';
import { AgentError, type AgentModel, type ToolDef } from './model';
import { checkSources, runToolLoop, sourceInfo, type Attempt } from './loop';
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

/** Files the plan may play as audio: narration, music, and style references the user allowed (useAudio). */
function allowedAudio(ctx: PlanContext): string[] {
  return ctx.roles.filter(r => r.role === 'narration' || r.role === 'music' || (r.role === 'style' && r.useAudio)).map(r => r.path);
}

function parseNotFollowed(v: unknown): NotFollowed[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap(x => (x && typeof x.instruction === 'string' && typeof x.reason === 'string'
    ? [{ instruction: x.instruction, source: 'prompt' as const, reason: x.reason }] : []));
}

export async function planTimeline(ctx: PlanContext, model: AgentModel): Promise<{ timeline: Timeline; notFollowed: NotFollowed[] }> {
  const sources = sourceInfo(ctx.scan);
  const audio = allowedAudio(ctx);

  const result = await runToolLoop({
    model, tools: [SUBMIT_TIMELINE], maxAttempts: MAX_ATTEMPTS,
    system: buildSystemPrompt({ guideline: ctx.guideline, capabilities: ctx.capabilities }),
    messages: [{ role: 'user', content: await buildPlanMessage(ctx) }],
    noCallMessage: 'No timeline was submitted. Call the submit_timeline tool.',
    retryMessage: errors => `The timeline is invalid. Fix these errors and call submit_timeline again with the complete timeline:\n- ${errors.join('\n- ')}`,
    evaluate: (call): Attempt<{ timeline: Timeline; notFollowed: NotFollowed[] }> => {
      const input = (call.input ?? {}) as { timeline?: unknown; notFollowed?: unknown };
      const v = validateTimeline(input.timeline, sources);
      if (!v.ok) return { errors: v.errors };
      const errors = checkSources(v.timeline, { raw: ctx.scan.raw, audio, images: ctx.scan.references.images });
      if (errors.length) return { errors };
      const timeline: Timeline = {
        ...v.timeline,
        segments: v.timeline.segments.map(s => ({ ...s, approved: false })),
        captions: v.timeline.captions.map(c => ({ ...c, approved: false })),
      };
      return { done: { timeline, notFollowed: parseNotFollowed(input.notFollowed) } };
    },
  });
  if (!result.ok) throw new AgentError('INVALID_AFTER_RETRIES', `No valid timeline after ${MAX_ATTEMPTS} attempts: ${result.errors.join('; ')}`);
  return result.value;
}
