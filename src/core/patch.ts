import { isDeepStrictEqual } from 'node:util';
import { FPS, type Crop, type Effect, type Timeline, type Transition } from './timeline';

export type PatchOp =
  | { op: 'swapSource'; segmentId: string; source: string; sourceIn: number; sourceOut: number; speed: number }
  | { op: 'setEffects'; segmentId: string; effects: Effect[] }
  | { op: 'setTransition'; segmentId: string; transitionIn: Transition }
  | { op: 'setCrop'; segmentId: string; crop: Crop }
  | { op: 'setCaptionText'; captionId: string; text: string }
  | { op: 'setCaptionAnimation'; captionId: string; animation: 'line' | 'word' }
  | { op: 'setGain'; trackId: string; gain: number }
  | { op: 'retime'; segmentId: string; durationFrames: number };

const SPEED_MIN = 0.75;
const SPEED_MAX = 1.5;

function find<T extends { id: string }>(items: T[], id: string): T {
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`unknown id: ${id}`);
  return item;
}

/** Pure: returns a modified deep copy; throws Error('unknown id: <id>'). */
export function applyPatch(t: Timeline, ops: PatchOp[]): Timeline {
  const next = structuredClone(t);
  for (const op of ops) {
    switch (op.op) {
      case 'swapSource': {
        const s = find(next.segments, op.segmentId);
        s.source = op.source; s.sourceIn = op.sourceIn; s.sourceOut = op.sourceOut; s.speed = op.speed;
        break;
      }
      case 'setEffects': find(next.segments, op.segmentId).effects = op.effects; break;
      case 'setTransition': find(next.segments, op.segmentId).transitionIn = op.transitionIn; break;
      case 'setCrop': find(next.segments, op.segmentId).crop = op.crop; break;
      case 'setCaptionText': {
        const c = find(next.captions, op.captionId);
        c.text = op.text; c.words = []; c.animation = 'line';
        break;
      }
      case 'setCaptionAnimation': find(next.captions, op.captionId).animation = op.animation; break;
      case 'setGain': find(next.audio, op.trackId).gain = op.gain; break;
      case 'retime': {
        const s = find(next.segments, op.segmentId);
        const oldEnd = s.startFrame + s.durationFrames;
        const delta = op.durationFrames - s.durationFrames;
        s.durationFrames = op.durationFrames;
        s.sourceOut = s.sourceIn + (op.durationFrames / FPS) * s.speed;
        for (const other of next.segments) if (other.startFrame >= oldEnd) other.startFrame += delta;
        for (const c of next.captions) {
          if (c.startFrame < oldEnd) continue;
          c.startFrame += delta; c.endFrame += delta;
          for (const w of c.words) { w.startFrame += delta; w.endFrame += delta; }
        }
        next.durationFrames += delta;
        break;
      }
    }
  }
  return next;
}

export function setApproved(t: Timeline, id: string, approved: boolean): Timeline {
  const next = structuredClone(t);
  const item = [...next.segments, ...next.captions].find((i) => i.id === id);
  if (!item) throw new Error(`unknown id: ${id}`);
  item.approved = approved;
  return next;
}

type Item = { id: string; startFrame: number; endFrame?: number; words?: { startFrame: number; endFrame: number }[] };

/** Copy of an item with all position data removed, for "differs only by a shift" comparisons. */
function withoutPosition(item: Item): unknown {
  const { startFrame: _s, endFrame: _e, words, ...rest } = item;
  return words ? { ...rest, words: words.map((w) => ({ ...w, startFrame: 0, endFrame: 0 })) } : rest;
}

/** Returns violations; [] means the change respects all locks. */
export function checkLocks(prev: Timeline, next: Timeline, opts: { targets: string[]; unlock: boolean }): string[] {
  const out: string[] = [];
  const targets = new Set(opts.targets);

  if (!opts.unlock && prev.durationFrames !== next.durationFrames) {
    out.push(`durationFrames changed (${prev.durationFrames} -> ${next.durationFrames}) without unlock`);
  }

  for (const k of ['fps', 'width', 'height'] as const) {
    if (prev[k] !== next[k]) out.push(`${k} changed`);
  }
  if (!isDeepStrictEqual(prev.style, next.style)) out.push('style is locked');
  for (const p of prev.overlays) {
    const n = next.overlays.find((o) => o.id === p.id);
    if (!n) out.push(`${p.id} (overlay) was removed`);
    else if (!isDeepStrictEqual(p, n)) out.push(`${p.id} (overlay) is locked`);
  }
  for (const n of next.overlays) if (!prev.overlays.some((p) => p.id === n.id)) out.push(`${n.id} (overlay) was added`);

  const groups: { kind: 'segment' | 'caption' | 'audio'; before: Item[]; after: Item[] }[] = [
    { kind: 'segment', before: prev.segments, after: next.segments },
    { kind: 'caption', before: prev.captions, after: next.captions },
    { kind: 'audio', before: prev.audio, after: next.audio },
  ];
  for (const { kind, before, after } of groups) {
    for (const p of before) {
      const n = after.find((i) => i.id === p.id);
      if (!n) { out.push(`${p.id} was removed`); continue; }
      if (isDeepStrictEqual(p, n)) continue;

      if ((p as { approved?: boolean }).approved) { out.push(`${p.id} is approved; un-approve it first`); continue; }

      if (kind === 'audio') {
        const a = p as unknown as { startFrame: number; sourceIn: number };
        const b = n as unknown as typeof a;
        if (a.startFrame !== b.startFrame || a.sourceIn !== b.sourceIn) {
          out.push(`${p.id}: audio tracks never move`);
          continue;
        }
      }
      if (kind === 'segment' && !opts.unlock) {
        const a = p as unknown as { startFrame: number; durationFrames: number };
        const b = n as unknown as typeof a;
        if (a.startFrame !== b.startFrame || a.durationFrames !== b.durationFrames) {
          out.push(`${p.id}: segment boundaries changed without unlock`);
          continue;
        }
      }
      if (!targets.has(p.id)) {
        const onlyShifted = opts.unlock && kind !== 'audio' && isDeepStrictEqual(withoutPosition(p), withoutPosition(n));
        if (!onlyShifted) out.push(`${p.id} changed but is not a target`);
      }
    }
    for (const n of after) if (!before.some((p) => p.id === n.id)) out.push(`${n.id} was added`);
  }

  for (const s of next.segments) {
    if (targets.has(s.id) && (s.speed < SPEED_MIN || s.speed > SPEED_MAX)) {
      out.push(`${s.id}: speed ${s.speed} outside ${SPEED_MIN}-${SPEED_MAX}`);
    }
  }
  return out;
}
