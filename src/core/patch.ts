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
        if (!Number.isInteger(op.durationFrames) || op.durationFrames < 1) throw new Error('invalid duration');
        const s = find(next.segments, op.segmentId);
        const oldStart = s.startFrame;
        const oldDuration = s.durationFrames;
        const oldEnd = oldStart + oldDuration;
        const newEnd = oldStart + op.durationFrames;
        const delta = op.durationFrames - oldDuration;
        // Shortening squeezes the segment's old range into the new one (so its captions do not overlap the next ones);
        // frames after it move by delta. Continuous, so a caption reaching past the segment keeps its tail in place.
        // Rounds half up in integers: (f - oldStart) * new / old, without floating-point error.
        const squeeze = (f: number) => (f <= oldEnd
          ? oldStart + Math.floor((2 * (f - oldStart) * op.durationFrames + oldDuration) / (2 * oldDuration)) : f + delta);
        s.durationFrames = op.durationFrames;
        s.sourceOut = s.sourceIn + (op.durationFrames / FPS) * s.speed;
        for (const other of next.segments) if (other.startFrame >= oldEnd) other.startFrame += delta;
        for (const c of next.captions) {
          if (c.startFrame >= oldEnd) {
            c.startFrame += delta; c.endFrame += delta;
            for (const w of c.words) { w.startFrame += delta; w.endFrame += delta; }
            continue;
          }
          // Captions starting before the segment stay; lengthening leaves the ones inside it untouched.
          if (c.startFrame < oldStart || delta >= 0) continue;
          c.startFrame = Math.min(squeeze(c.startFrame), newEnd - 1);
          c.endFrame = Math.max(squeeze(c.endFrame), c.startFrame + 1);
          for (const w of c.words) {
            w.startFrame = squeeze(w.startFrame);
            w.endFrame = Math.max(squeeze(w.endFrame), w.startFrame + 1);
          }
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

/**
 * `target`'s content with `latest`'s approvals (for going back to an older version). Every item approved in `latest` must
 * exist in `target` with the same content; otherwise the ids of those that do not are returned as conflicts (timeline order).
 */
export function carryApprovals(target: Timeline, latest: Timeline):
  { ok: true; timeline: Timeline } | { ok: false; conflicts: string[] } {
  const approved = new Set([...latest.segments, ...latest.captions].filter((i) => i.approved).map((i) => i.id));
  const unapproved = <T extends { approved: boolean }>(i: T): T => ({ ...i, approved: false });
  const conflicts: string[] = [];
  for (const [before, after] of [[latest.segments, target.segments], [latest.captions, target.captions]] as const) {
    for (const p of before as { id: string; approved: boolean }[]) {
      if (!p.approved) continue;
      const n = (after as { id: string; approved: boolean }[]).find((i) => i.id === p.id);
      if (!n || !isDeepStrictEqual(unapproved(p), unapproved(n))) conflicts.push(p.id);
    }
  }
  if (conflicts.length) return { ok: false, conflicts };
  const next = structuredClone(target);
  for (const i of [...next.segments, ...next.captions]) i.approved = approved.has(i.id);
  return { ok: true, timeline: next };
}

type Item = { id: string; startFrame: number; endFrame?: number; words?: { startFrame: number; endFrame: number }[] };

/** Copy of an item with every frame position moved back by `delta`. */
function shiftedBack(item: Item, delta: number): Item {
  const out: Item = { ...item, startFrame: item.startFrame - delta };
  if (item.endFrame !== undefined) out.endFrame = item.endFrame - delta;
  if (item.words) out.words = item.words.map((w) => ({ ...w, startFrame: w.startFrame - delta, endFrame: w.endFrame - delta }));
  return out;
}

/** True when `n` is `p` moved in time as a whole: every frame position (start, end, words) by the same delta, nothing else changed. */
function isPureShift(p: Item, n: Item): boolean {
  return isDeepStrictEqual(p, shiftedBack(n, n.startFrame - p.startFrame));
}

/** Captions starting inside a target segment whose duration changed: a retime rescales them, so they count as targets. */
function rescaledCaptions(prev: Timeline, next: Timeline, targets: string[]): string[] {
  const ranges = prev.segments
    .filter((p) => targets.includes(p.id) && next.segments.find((n) => n.id === p.id)?.durationFrames !== p.durationFrames)
    .map((p) => [p.startFrame, p.startFrame + p.durationFrames]);
  return prev.captions.filter((c) => ranges.some(([a, b]) => a <= c.startFrame && c.startFrame < b)).map((c) => c.id);
}

/** Ids of segments, captions and audio tracks present in both whose content changed (not only moved in time as a whole), in timeline order. */
export function changedItems(prev: Timeline, next: Timeline): string[] {
  const groups: [Item[], Item[]][] = [[prev.segments, next.segments], [prev.captions, next.captions], [prev.audio, next.audio]];
  return groups.flatMap(([before, after]) => after.filter((n) => {
    const p = before.find((i) => i.id === n.id);
    return p !== undefined && !isDeepStrictEqual(p, n) && !isPureShift(p, n);
  }).map((n) => n.id));
}

/** Returns violations; [] means the change respects all locks. */
export function checkLocks(prev: Timeline, next: Timeline, opts: { targets: string[]; unlock: boolean }): string[] {
  const out: string[] = [];
  const targets = new Set([...opts.targets, ...(opts.unlock ? rescaledCaptions(prev, next, opts.targets) : [])]);

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
          out.push(`${p.id}: segment start or duration changed without unlock`);
          continue;
        }
      }
      if (!targets.has(p.id)) {
        const onlyShifted = opts.unlock && kind !== 'audio' && isPureShift(p, n);
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
