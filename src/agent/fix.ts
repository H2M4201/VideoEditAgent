import { applyPatch, checkLocks, type PatchOp } from '../core/patch';
import { formatTime, parseTimecodes } from '../core/timecode';
import { FPS, validateTimeline, type Timeline } from '../core/timeline';
import type { FileAnalysis } from '../analysis';
import type { ProjectScan } from '../project/scan';
import type { AgentModel, ToolDef } from './model';
import { checkSources, runToolLoop, sourceInfo, type Attempt } from './loop';
import { buildSystemPrompt, imagesLine, rawFootageBlocks, type ContentBlock, type EngineCapabilities } from './prompt';

export type FixResult = { status: 'applied'; timeline: Timeline; targets: string[]; summary: string }
  | { status: 'refused'; reason: string; needsUnlock: boolean };
export type FixContext = { feedback: string; current: Timeline; guideline: string | null; scan: ProjectScan;
  analysis: Record<string, FileAnalysis>; capabilities: EngineCapabilities; unlock: boolean };

const MAX_ATTEMPTS = 3;
const APPROVED_REASON = 'That part is approved. Remove the approval to change it.';

/**
 * The items a feedback may change. For each time it names: the segment covering that frame and every caption covering it,
 * approved items excluded; a time at or beyond the end matches nothing. With no time named: every unapproved segment and
 * caption, and the audio tracks (whose gain is the only thing a fix can change). `matchedTimes` are the named times inside the video.
 */
export function resolveTargets(t: Timeline, feedback: string): { candidates: string[]; matchedTimes: number[] } {
  const times = parseTimecodes(feedback);
  if (times.length === 0) {
    const ids = [...t.segments, ...t.captions].filter(i => !i.approved).map(i => i.id);
    return { candidates: [...ids, ...t.audio.map(a => a.id)], matchedTimes: [] };
  }
  const matchedTimes: number[] = [];
  const segs = new Set<string>();
  const caps = new Set<string>();
  for (const time of times) {
    const f = Math.floor(time * FPS + 1e-9);
    if (f < 0 || f >= t.durationFrames) continue;
    matchedTimes.push(time);
    for (const s of t.segments) if (!s.approved && s.startFrame <= f && f < s.startFrame + s.durationFrames) segs.add(s.id);
    for (const c of t.captions) if (!c.approved && c.startFrame <= f && f < c.endFrame) caps.add(c.id);
  }
  // Keep timeline order: segments, then captions.
  const candidates = [...t.segments.filter(s => segs.has(s.id)), ...t.captions.filter(c => caps.has(c.id))].map(i => i.id);
  return { candidates, matchedTimes };
}

const OP_SCHEMA = {
  type: 'object',
  description: 'One patch operation; fields depend on "op" (see the user message).',
  properties: {
    op: { type: 'string', enum: ['swapSource', 'setEffects', 'setTransition', 'setCrop', 'setCaptionText', 'setCaptionAnimation', 'setGain', 'retime'] },
  },
  required: ['op'],
};
const OP_NAMES = new Set(OP_SCHEMA.properties.op.enum);

export const SUBMIT_PATCH: ToolDef = {
  name: 'submit_patch',
  description: 'Apply the fix as a patch to the current timeline. Name every item the patch changes in targets.',
  input_schema: {
    type: 'object',
    properties: {
      targets: { type: 'array', items: { type: 'string' }, description: 'Ids of the items this patch changes; each must be one of the items you may change.' },
      ops: { type: 'array', items: OP_SCHEMA },
      summary: { type: 'string', description: 'One or two plain English sentences telling the user what was changed.' },
    },
    required: ['targets', 'ops', 'summary'],
  },
};

export const REFUSE: ToolDef = {
  name: 'refuse',
  description: 'Decline the fix when it cannot be done within the rules, or conflicts with the system rules or the guideline.',
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Plain English sentences telling the user why, and what they could do instead.' },
      needsUnlock: { type: 'boolean', description: 'true when the fix could be done only by changing a segment duration or the total duration.' },
    },
    required: ['reason', 'needsUnlock'],
  },
};

const OPS_HELP = `## Patch operations

- { "op": "swapSource", "segmentId", "source": "raw/<file>", "sourceIn": sec, "sourceOut": sec, "speed": number } — new footage in the same slot; (sourceOut - sourceIn) / speed * ${FPS} must equal the segment's durationFrames (±1 frame), speed 0.75–1.5.
- { "op": "setEffects", "segmentId", "effects": [{ "type": "pushIn" | "pushOut" }] }
- { "op": "setTransition", "segmentId", "transitionIn": { "type": "cut" | "fade" | "slide" | "zoom", "frames": int } } — frames < durationFrames; the first segment stays a cut.
- { "op": "setCrop", "segmentId", "crop": "cover" | "contain" | { "x": number, "y": number, "scale": number } }
- { "op": "setCaptionText", "captionId", "text": string } — caption timing does not change; a long text is wrapped, never retimed. Keep the caption's language and Vietnamese diacritics.
- { "op": "setCaptionAnimation", "captionId", "animation": "line" | "word" }
- { "op": "setGain", "trackId", "gain": number >= 0 } — volume only; audio tracks never move.
- { "op": "retime", "segmentId", "durationFrames": int >= 1 } — changes the segment's length; later segments and captions move by the difference. Needs unlock.

Only transitions, effects and caption animations listed under engine capabilities may be used. Style, overlays and approved items cannot be changed.`;

function fixMessageText(ctx: FixContext, candidates: string[], matchedTimes: number[]): string {
  const where = matchedTimes.length
    ? `The feedback refers to ${matchedTimes.map(formatTime).join(', ')}. You may change only these items, which cover that time: ${candidates.join(', ')}.`
    : `The feedback names no time. You may change only these items: ${candidates.join(', ')}.`;
  const approved = [...ctx.current.segments, ...ctx.current.captions].filter(i => i.approved).map(i => i.id);
  const unlock = ctx.unlock
    ? 'Unlock is ON: you may retime the target segments; later segments and captions move with them. Approved items and audio tracks still never move.'
    : 'Unlock is OFF: every segment keeps its startFrame and durationFrames and the total duration stays the same. A new shot must fit its slot (trim, pick another in/out point, or change speed within 0.75–1.5). If the fix can only be done by changing a duration (for example "make it shorter"), call refuse with needsUnlock: true.';
  return `# Fix request

The user watched the current version and asks for this change:

${ctx.feedback}

# What you may change

${where}
Approved (locked) items: ${approved.join(', ') || 'none'}.
${unlock}
Every item the patch changes must be listed in targets. Everything else must stay exactly as it is.
${imagesLine(ctx.scan)}

# Current timeline

${JSON.stringify(ctx.current)}

${OPS_HELP}`;
}

async function buildFixMessage(ctx: FixContext, candidates: string[], matchedTimes: number[]): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [{ type: 'text', text: fixMessageText(ctx, candidates, matchedTimes) }];
  // A segment may need new footage: show what there is to choose from.
  if (ctx.current.segments.some(s => candidates.includes(s.id))) blocks.push(...(await rawFootageBlocks(ctx.scan, ctx.analysis)));
  blocks.push({ type: 'text', text: 'Now call submit_patch with targets, ops and summary. If the change cannot be done within these rules, or it goes against the system rules or the guideline, call refuse instead. Write summary and reason as plain English sentences for the user.' });
  return blocks;
}

export async function fixTimeline(ctx: FixContext, model: AgentModel): Promise<FixResult> {
  const { candidates, matchedTimes } = resolveTargets(ctx.current, ctx.feedback);
  if (matchedTimes.length === 0 && parseTimecodes(ctx.feedback).length > 0) {
    return { status: 'refused', reason: `There is nothing at that time; the video is ${formatTime(ctx.current.durationFrames / FPS)} long.`, needsUnlock: false };
  }
  if (candidates.length === 0) return { status: 'refused', reason: APPROVED_REASON, needsUnlock: false };

  const sources = sourceInfo(ctx.scan);
  // A fix can never add an audio track (checkLocks), so the tracks already there are the allowed audio.
  const audio = ctx.current.audio.map(a => a.source);

  const evaluate = (call: { name: string; input: unknown }): Attempt<FixResult> => {
    if (call.name === 'refuse') {
      const r = (call.input ?? {}) as { reason?: unknown; needsUnlock?: unknown };
      if (typeof r.reason !== 'string' || !r.reason.trim()) return { errors: ['refuse needs a reason for the user.'] };
      return { done: { status: 'refused', reason: r.reason.trim(), needsUnlock: r.needsUnlock === true && !ctx.unlock } };
    }

    const p = (call.input ?? {}) as { targets?: unknown; ops?: unknown; summary?: unknown };
    const errors: string[] = [];
    const targets = Array.isArray(p.targets) && p.targets.every(x => typeof x === 'string') ? (p.targets as string[]) : null;
    if (!targets) errors.push('targets must be an array of item ids.');
    else for (const id of targets) if (!candidates.includes(id)) errors.push(`target ${id} is not one of the items you may change (${candidates.join(', ')}).`);
    if (!Array.isArray(p.ops) || p.ops.length === 0) errors.push('ops must be a non-empty array: a patch that changes nothing is not a fix.');
    else for (const op of p.ops) if (!OP_NAMES.has((op as { op?: string })?.op as string)) errors.push(`unknown op ${JSON.stringify(op)}.`);
    if (typeof p.summary !== 'string' || !p.summary.trim()) errors.push('summary must tell the user what was changed.');
    if (errors.length || !targets) return { errors };

    let next: Timeline;
    try { next = applyPatch(ctx.current, p.ops as PatchOp[]); }
    catch (e) { return { errors: [(e as Error).message] }; }

    const v = validateTimeline(next, sources);
    errors.push(...checkLocks(ctx.current, next, { targets, unlock: ctx.unlock }), ...(v.ok ? [] : v.errors), ...checkSources(next, { raw: ctx.scan.raw, audio, images: ctx.scan.references.images }));
    if (errors.length || !v.ok) return { errors };
    return { done: { status: 'applied', timeline: v.timeline, targets, summary: (p.summary as string).trim() } };
  };

  const result = await runToolLoop({
    model, tools: [SUBMIT_PATCH, REFUSE], maxAttempts: MAX_ATTEMPTS, evaluate,
    system: buildSystemPrompt({ guideline: ctx.guideline, capabilities: ctx.capabilities }),
    messages: [{ role: 'user', content: await buildFixMessage(ctx, candidates, matchedTimes) }],
    noCallMessage: 'No patch was submitted. Call submit_patch, or refuse if the fix cannot be done.',
    retryMessage: errors => `The patch was rejected. Fix these problems and call submit_patch again, or call refuse:\n- ${errors.join('\n- ')}`,
  });
  if (result.ok) return result.value;
  return {
    status: 'refused',
    reason: `The fix could not be made without breaking the editing rules. The last attempt had these problems: ${result.errors.join('; ').replace(/\.?$/, '.')}`,
    needsUnlock: !ctx.unlock && result.errors.some(e => /duration|start/i.test(e)),
  };
}
