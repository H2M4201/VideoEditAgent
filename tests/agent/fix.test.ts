import { beforeAll, describe, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixTimeline, resolveTargets } from '../../src/agent/fix';
import type { ModelTurn } from '../../src/agent/model';
import type { PatchOp } from '../../src/core/patch';
import { setApproved } from '../../src/core/patch';
import type { FileAnalysis } from '../../src/analysis';
import type { ProjectScan } from '../../src/project/scan';
import { FakeModel, turn } from '../helpers/fakeModel';
import { makeTimeline } from '../helpers/timeline';

// Smallest valid JPEG (1x1 px).
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

type Ctx = Parameters<typeof fixTimeline>[0];
let ctx: Ctx;

beforeAll(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vea-fix-'));
  const framePath = path.join(dir, 'f.jpg');
  await fs.writeFile(framePath, JPEG);
  const scan: ProjectScan = {
    raw: [{ path: 'raw/a.mp4', kind: 'video', durationSec: 60, hasAudio: true }, { path: 'raw/b.mp4', kind: 'video', durationSec: 20, hasAudio: false }],
    references: { media: [{ path: 'reference/sample.mp4', kind: 'video', durationSec: 30, hasAudio: true }], scripts: [], links: [], images: ['reference/logo.png'] },
    guidelinePath: null, warnings: [],
  };
  const analysis: Record<string, FileAnalysis> = {
    'raw/a.mp4': { path: 'raw/a.mp4', shots: [{ index: 0, startSec: 0, endSec: 60, framePath }], transcript: null, audioClass: 'silent', beatsSec: [], cutsPerMinute: null },
    'raw/b.mp4': { path: 'raw/b.mp4', shots: [{ index: 0, startSec: 0, endSec: 9, framePath }, { index: 1, startSec: 9, endSec: 20, framePath }],
      transcript: null, audioClass: null, beatsSec: [], cutsPerMinute: null },
  };
  ctx = { feedback: '', current: makeTimeline(5), guideline: 'Calm pace. Gold captions.', scan, analysis,
    capabilities: { transitions: ['cut', 'fade'], effects: ['pushIn'], captionAnimations: ['line', 'word'] }, unlock: false };
});

const patchTurn = (targets: string[], ops: PatchOp[], summary = 'Swapped the shot.') => turn('submit_patch', { targets, ops, summary });
const swapS3: PatchOp[] = [{ op: 'swapSource', segmentId: 's3', source: 'raw/b.mp4', sourceIn: 5, sourceOut: 8, speed: 1 }];
const sent = (f: FakeModel, i: number) => JSON.stringify(f.calls[i].messages);

describe('resolveTargets', () => {
  test('time resolves to covering segment and caption', () => expect(resolveTargets(makeTimeline(5), 'swap 0:07').candidates.sort()).toEqual(['c3', 's3']));

  test('every caption covering the time is a candidate; approved items are excluded', () => {
    const t = setApproved(makeTimeline(5), 's3', true);
    t.captions.push({ id: 'c9', text: 'long', startFrame: 150, endFrame: 300, words: [], animation: 'line', approved: false });
    expect(resolveTargets(t, 'at 0:07')).toEqual({ candidates: ['c3', 'c9'], matchedTimes: [7] });
  });

  test('a time on a boundary belongs to the item starting there', () =>
    expect(resolveTargets(makeTimeline(5), 'at 0:06').candidates.sort()).toEqual(['c3', 's3']));

  test('no timecode means every unapproved item', () => {
    const t = setApproved(makeTimeline(2), 'c1', true);
    expect(resolveTargets(t, 'make the captions bigger')).toEqual({ candidates: ['s1', 's2', 'c2', 'm1'], matchedTimes: [] });
  });

  test('a time at or beyond the end matches nothing', () => {
    expect(resolveTargets(makeTimeline(5), 'at 0:15')).toEqual({ candidates: [], matchedTimes: [] });
    expect(resolveTargets(makeTimeline(5), 'at 0:14 and 0:20')).toEqual({ candidates: ['s5', 'c5'], matchedTimes: [14] });
  });

  test('a time covered only by approved items has a match but no candidates', () => {
    const t = setApproved(setApproved(makeTimeline(5), 's3', true), 'c3', true);
    expect(resolveTargets(t, 'swap 0:07')).toEqual({ candidates: [], matchedTimes: [7] });
  });
});

describe('fixTimeline', () => {
  test('fix changes only the named segment', async () => {
    const cur = makeTimeline(5);
    const r = await fixTimeline({ ...ctx, current: cur, feedback: 'swap the shot at 0:07' }, new FakeModel([patchTurn(['s3'], swapS3)]));
    expect(r.status).toBe('applied');
    if (r.status === 'applied') {
      expect(r.timeline.durationFrames).toBe(cur.durationFrames);
      expect(r.timeline.segments.filter(s => s.id !== 's3')).toEqual(cur.segments.filter(s => s.id !== 's3'));
      expect(r.timeline.captions).toEqual(cur.captions);
      expect(r.timeline.audio).toEqual(cur.audio);
      expect(r.timeline.segments[2]).toMatchObject({ source: 'raw/b.mp4', sourceIn: 5, sourceOut: 8 });
      expect(r.targets).toEqual(['s3']);
      expect(r.summary).toBe('Swapped the shot.');
    }
  });

  test('patch touching another segment is retried then refused', async () => {
    const bad = () => patchTurn(['s3'], [...swapS3, { op: 'setEffects', segmentId: 's4', effects: [{ type: 'pushIn' }] }]);
    const fake = new FakeModel([bad(), bad(), bad()]);
    const r = await fixTimeline({ ...ctx, feedback: 'swap the shot at 0:07' }, fake);
    expect(r).toMatchObject({ status: 'refused', needsUnlock: false });
    if (r.status === 'refused') expect(r.reason).toContain('s4 changed but is not a target');
    expect(fake.calls).toHaveLength(3);
    expect(sent(fake, 1)).toContain('tool_result');
    expect(sent(fake, 1)).toContain('s4 changed but is not a target');
  });

  test('a retried patch can succeed', async () => {
    const fake = new FakeModel([patchTurn(['s3'], [...swapS3, { op: 'setCaptionText', captionId: 'c4', text: 'x' }]), patchTurn(['s3'], swapS3)]);
    const r = await fixTimeline({ ...ctx, feedback: 'swap the shot at 0:07' }, fake);
    expect(r.status).toBe('applied');
  });

  test('targets outside the candidates are a validation error', async () => {
    const fake = new FakeModel([patchTurn(['s3', 's4'], swapS3), patchTurn(['s3'], swapS3)]);
    const r = await fixTimeline({ ...ctx, feedback: 'swap the shot at 0:07' }, fake);
    expect(r.status).toBe('applied');
    expect(sent(fake, 1)).toMatch(/s4 is not one of the items you may change/);
  });

  test('all violations go back together: locks, timeline validation and sources', async () => {
    const ops: PatchOp[] = [
      { op: 'swapSource', segmentId: 's3', source: 'reference/sample.mp4', sourceIn: 0, sourceOut: 2, speed: 1 },
      { op: 'setCaptionText', captionId: 'c4', text: 'x' },
    ];
    const fake = new FakeModel([patchTurn(['s3'], ops), patchTurn(['s3'], swapS3)]);
    await fixTimeline({ ...ctx, feedback: 'swap the shot at 0:07' }, fake);
    const m = sent(fake, 1);
    expect(m).toContain('c4 changed but is not a target');
    expect(m).toContain('does not match source range');
    expect(m).toMatch(/s3: source reference\/sample\.mp4 is not a raw file/);
  });

  test('an op naming an unknown id goes back to the model instead of throwing', async () => {
    const fake = new FakeModel([patchTurn(['s3'], [{ op: 'setCrop', segmentId: 's99', crop: 'contain' }]), patchTurn(['s3'], swapS3)]);
    const r = await fixTimeline({ ...ctx, feedback: 'swap the shot at 0:07' }, fake);
    expect(r.status).toBe('applied');
    expect(sent(fake, 1)).toContain('unknown id: s99');
  });

  test('an empty patch is rejected', async () => {
    const fake = new FakeModel([patchTurn(['s3'], []), patchTurn(['s3'], swapS3)]);
    await fixTimeline({ ...ctx, feedback: 'swap the shot at 0:07' }, fake);
    expect(sent(fake, 1)).toContain('changes nothing');
  });

  test('approved target is refused without calling the model', async () => {
    const fake = new FakeModel([]);
    const r = await fixTimeline({ ...ctx, current: setApproved(setApproved(makeTimeline(5), 's3', true), 'c3', true), feedback: 'swap 0:07' }, fake);
    expect(r).toEqual({ status: 'refused', reason: 'That part is approved. Remove the approval to change it.', needsUnlock: false });
    expect(fake.calls).toHaveLength(0);
  });

  test('a time beyond the end is refused without calling the model', async () => {
    const fake = new FakeModel([]);
    const r = await fixTimeline({ ...ctx, feedback: 'swap the shot at 0:20' }, fake);
    expect(r).toEqual({ status: 'refused', reason: 'There is nothing at that time; the video is 0:15 long.', needsUnlock: false });
    expect(fake.calls).toHaveLength(0);
  });

  const retime = () => patchTurn(['s3'], [{ op: 'retime', segmentId: 's3', durationFrames: 60 }], 'Shortened the shot.');

  test('shorten request without unlock reports needsUnlock', async () => {
    const fake = new FakeModel([retime(), retime(), retime()]);
    const r = await fixTimeline({ ...ctx, feedback: 'make the shot at 0:07 shorter' }, fake);
    expect(r).toMatchObject({ status: 'refused', needsUnlock: true });
    if (r.status === 'refused') expect(r.reason).toMatch(/^The fix could not be made.*duration.*\.$/);
    expect(fake.calls).toHaveLength(3);
  });

  test('same request with unlock applies and keeps music in place', async () => {
    const cur = makeTimeline(5);
    const r = await fixTimeline({ ...ctx, current: cur, unlock: true, feedback: 'make the shot at 0:07 shorter' }, new FakeModel([retime()]));
    expect(r.status).toBe('applied');
    if (r.status === 'applied') {
      expect(r.timeline.audio).toEqual(cur.audio);
      expect(r.timeline.durationFrames).toBe(cur.durationFrames - 30);
      expect(r.timeline.segments.slice(0, 2)).toEqual(cur.segments.slice(0, 2));
      expect(r.timeline.segments.map(s => s.startFrame)).toEqual([0, 90, 180, 240, 330]);
    }
  });

  test('the refuse tool passes the reason through', async () => {
    const fake = new FakeModel([turn('refuse', { reason: 'The guideline asks for calm pacing; a speed ramp would break it.', needsUnlock: false })]);
    const r = await fixTimeline({ ...ctx, feedback: 'add a fast speed ramp at 0:07' }, fake);
    expect(r).toEqual({ status: 'refused', reason: 'The guideline asks for calm pacing; a speed ramp would break it.', needsUnlock: false });
  });

  test('a refuse asking for unlock is passed through', async () => {
    const fake = new FakeModel([turn('refuse', { reason: 'This needs more time than the slot has.', needsUnlock: true })]);
    const r = await fixTimeline({ ...ctx, feedback: 'show the whole pool walk at 0:07' }, fake);
    expect(r).toMatchObject({ status: 'refused', needsUnlock: true });
  });

  test('a turn with no tool call is a failed attempt; assistantContent is replayed unchanged', async () => {
    const raw = [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }, { type: 'text', text: 'I will swap it.' }];
    const noCall: ModelTurn = { toolCalls: [], text: 'I will swap it.', usage: { input: 1, output: 1 }, assistantContent: raw };
    const fake = new FakeModel([noCall, patchTurn(['s3'], swapS3)]);
    const r = await fixTimeline({ ...ctx, feedback: 'swap the shot at 0:07' }, fake);
    expect(r.status).toBe('applied');
    expect(fake.calls[1].messages[1]).toEqual({ role: 'assistant', content: raw });
    expect(sent(fake, 1)).toContain('submit_patch');
  });

  test('uses the planning system prompt with the guideline, and offers submit_patch and refuse', async () => {
    const fake = new FakeModel([patchTurn(['s3'], swapS3)]);
    await fixTimeline({ ...ctx, feedback: 'swap the shot at 0:07' }, fake);
    expect(fake.calls[0].system).toContain('SYSTEM RULES');
    expect(fake.calls[0].system).toContain('Calm pace. Gold captions.');
    expect(fake.calls[0].tools.map(t => t.name)).toEqual(['submit_patch', 'refuse']);
  });

  test('fix message carries feedback, timeline JSON, candidates and raw shots with frames', async () => {
    const fake = new FakeModel([patchTurn(['s3'], swapS3)]);
    await fixTimeline({ ...ctx, feedback: 'swap the shot at 0:07' }, fake);
    const m = sent(fake, 0);
    expect(m).toContain('swap the shot at 0:07');
    expect(m).toContain(JSON.stringify(JSON.stringify(ctx.current)).slice(1, -1));
    expect(m).toMatch(/s3, c3/);
    expect(m).toContain('raw/b.mp4');
    expect(m).toContain('[1, 9, 20]');
    expect(m).toMatch(/image files available for logo overlays: reference\/logo\.png/i);
    expect(m).toContain('image/jpeg');
    expect(m).not.toContain('video/mp4');
  });

  test('caption-only candidates send no frames', async () => {
    const t = setApproved(makeTimeline(5), 's3', true);
    const fake = new FakeModel([patchTurn(['c3'], [{ op: 'setCaptionText', captionId: 'c3', text: 'Hồ bơi' }])]);
    const r = await fixTimeline({ ...ctx, current: t, feedback: 'fix text at 0:07' }, fake);
    expect(r.status).toBe('applied');
    expect(sent(fake, 0)).not.toContain('image/jpeg');
  });
});
