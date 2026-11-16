import { z } from 'zod';

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;
const MAX_DURATION_FRAMES = FPS * 600;

const frame = z.number().int();

const TransitionSchema = z.object({
  type: z.enum(['cut', 'fade', 'slide', 'zoom']),
  frames: frame.min(0),
});
const EffectSchema = z.object({ type: z.enum(['pushIn', 'pushOut']) });
const CropSchema = z.union([
  z.literal('cover'),
  z.literal('contain'),
  z.object({ x: z.number(), y: z.number(), scale: z.number().positive() }),
]);
const SegmentSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceIn: z.number(),
  sourceOut: z.number(),
  startFrame: frame.min(0),
  durationFrames: frame.min(1),
  speed: z.number().positive(),
  crop: CropSchema,
  transitionIn: TransitionSchema,
  effects: z.array(EffectSchema),
  clipGain: z.number().min(0),
  approved: z.boolean(),
});
const WordSchema = z.object({ text: z.string(), startFrame: frame, endFrame: frame });
const CaptionSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  startFrame: frame,
  endFrame: frame,
  words: z.array(WordSchema),
  animation: z.enum(['line', 'word']),
  approved: z.boolean(),
});
const AudioTrackSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['narration', 'music']),
  source: z.string().min(1),
  startFrame: frame.min(0),
  sourceIn: z.number().min(0),
  gain: z.number().min(0),
});
const OverlaySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['logo', 'title']),
  source: z.string().optional(),
  text: z.string().optional(),
  startFrame: frame.min(0),
  endFrame: frame,
  position: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']),
});
const StyleSchema = z.object({
  fontFamily: z.string(),
  primaryColor: z.string(),
  secondaryColor: z.string(),
  captionPosition: z.enum(['top', 'middle', 'bottom']),
  captionSize: z.number().positive(),
});

export const TimelineSchema = z.object({
  version: z.literal(1),
  fps: z.literal(30),
  width: z.literal(1080),
  height: z.literal(1920),
  durationFrames: frame,
  segments: z.array(SegmentSchema),
  captions: z.array(CaptionSchema),
  audio: z.array(AudioTrackSchema),
  overlays: z.array(OverlaySchema),
  style: StyleSchema,
});

export type Transition = z.infer<typeof TransitionSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type Crop = z.infer<typeof CropSchema>;
export type Segment = z.infer<typeof SegmentSchema>;
export type Word = z.infer<typeof WordSchema>;
export type Caption = z.infer<typeof CaptionSchema>;
export type AudioTrack = z.infer<typeof AudioTrackSchema>;
export type Overlay = z.infer<typeof OverlaySchema>;
export type Style = z.infer<typeof StyleSchema>;
export type Timeline = z.infer<typeof TimelineSchema>;

/** key = path relative to the project folder */
export type SourceInfo = Record<string, { durationSec: number }>;

export function validateTimeline(
  t: unknown,
  sources: SourceInfo,
): { ok: true; timeline: Timeline } | { ok: false; errors: string[] } {
  const parsed = TimelineSchema.safeParse(t);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `schema: ${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  const tl = parsed.data;
  const errors: string[] = [];

  if (tl.durationFrames < 1 || tl.durationFrames > MAX_DURATION_FRAMES) {
    errors.push(`durationFrames ${tl.durationFrames} must be between 1 and ${MAX_DURATION_FRAMES}`);
  }

  // ids unique across all items
  const seen = new Set<string>();
  const dup = new Set<string>();
  const ids = [
    ...tl.segments.map((s) => s.id),
    ...tl.captions.map((c) => c.id),
    ...tl.audio.map((a) => a.id),
    ...tl.overlays.map((o) => o.id),
  ];
  for (const id of ids) {
    if (seen.has(id) && !dup.has(id)) {
      dup.add(id);
      errors.push(`duplicate id ${id}`);
    }
    seen.add(id);
  }

  // segments: sorted, contiguous from 0, sum equals durationFrames
  let expectedStart = 0;
  for (const s of tl.segments) {
    if (s.startFrame !== expectedStart) {
      errors.push(`segment ${s.id}: startFrame ${s.startFrame} but expected ${expectedStart} (must be contiguous from frame 0)`);
    }
    expectedStart += s.durationFrames;

    if (!(s.sourceIn >= 0 && s.sourceOut > s.sourceIn)) {
      errors.push(`segment ${s.id}: need sourceOut > sourceIn >= 0 (got ${s.sourceIn}..${s.sourceOut})`);
    }
    const info = sources[s.source];
    if (!info) {
      errors.push(`segment ${s.id}: unknown source ${s.source}`);
    } else if (s.sourceOut > info.durationSec) {
      errors.push(`segment ${s.id}: sourceOut ${s.sourceOut} exceeds source duration ${info.durationSec}s`);
    }
    const expectedFrames = ((s.sourceOut - s.sourceIn) / s.speed) * FPS;
    if (Math.abs(expectedFrames - s.durationFrames) > 1) {
      errors.push(`segment ${s.id}: durationFrames ${s.durationFrames} does not match source range at speed ${s.speed} (~${Math.round(expectedFrames)})`);
    }
    if (s.transitionIn.frames >= s.durationFrames) {
      errors.push(`segment ${s.id}: transitionIn.frames ${s.transitionIn.frames} must be < durationFrames ${s.durationFrames}`);
    }
  }
  if (tl.segments.length > 0 && tl.segments[0].transitionIn.type !== 'cut') {
    errors.push(`segment ${tl.segments[0].id}: first segment transitionIn must be cut`);
  }
  if (expectedStart !== tl.durationFrames) {
    errors.push(`segments total ${expectedStart} frames but durationFrames is ${tl.durationFrames}`);
  }

  for (const c of tl.captions) {
    if (c.startFrame < 0 || c.endFrame > tl.durationFrames) {
      errors.push(`caption ${c.id}: must lie within [0, ${tl.durationFrames}]`);
    }
    if (c.endFrame <= c.startFrame) {
      errors.push(`caption ${c.id}: endFrame must be > startFrame`);
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, timeline: tl };
}
