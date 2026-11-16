import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planTimeline, type PlanContext } from '../../src/agent/plan';
import type { FileAnalysis } from '../../src/analysis';
import type { ProjectScan } from '../../src/project/scan';
import type { RoleAssignment } from '../../src/project/roles';
import type { Timeline } from '../../src/core/timeline';
import { FakeModel, turn } from '../helpers/fakeModel';

// Smallest valid JPEG (1x1 px).
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

let ctx: PlanContext;
let framePath: string;

const roles: RoleAssignment[] = [
  { path: 'reference/sample.mp4', role: 'style', useAudio: false, decidedBy: 'guess', reason: 'Sample video' },
  { path: 'reference/song.mp3', role: 'music', useAudio: false, decidedBy: 'guess', reason: 'Music' },
  { path: 'reference/vo.mp3', role: 'narration', useAudio: false, decidedBy: 'guess', reason: 'Speech' },
];

beforeAll(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vea-plan-'));
  framePath = path.join(dir, 'f.jpg');
  await fs.writeFile(framePath, JPEG);
  const shot = (index: number, startSec: number, endSec: number) => ({ index, startSec, endSec, framePath });
  const scan: ProjectScan = {
    raw: [{ path: 'raw/a.mp4', kind: 'video', durationSec: 10, hasAudio: true }, { path: 'raw/b.mp4', kind: 'video', durationSec: 8, hasAudio: false }],
    references: {
      media: [{ path: 'reference/vo.mp3', kind: 'audio', durationSec: 12, hasAudio: true },
        { path: 'reference/song.mp3', kind: 'audio', durationSec: 60, hasAudio: true },
        { path: 'reference/sample.mp4', kind: 'video', durationSec: 30, hasAudio: true }],
      scripts: [], links: [], images: ['reference/logo.png'],
    },
    guidelinePath: null, warnings: [],
  };
  const analysis: Record<string, FileAnalysis> = {
    'raw/a.mp4': { path: 'raw/a.mp4', shots: [shot(0, 0, 4), shot(1, 4, 10)], transcript: null, audioClass: 'silent', beatsSec: [], cutsPerMinute: null },
    'raw/b.mp4': { path: 'raw/b.mp4', shots: [shot(0, 0, 8)], transcript: null, audioClass: null, beatsSec: [], cutsPerMinute: null },
    'reference/vo.mp3': { path: 'reference/vo.mp3', shots: [], audioClass: 'speech', beatsSec: [], cutsPerMinute: null,
      transcript: { text: 'Xin chào', language: 'vi', words: [{ text: 'Xin', startSec: 0.5, endSec: 0.9 }, { text: 'chào', startSec: 0.9, endSec: 1.4 }] } },
    'reference/song.mp3': { path: 'reference/song.mp3', shots: [], transcript: null, audioClass: 'music', beatsSec: [0.5, 1.0, 1.5], cutsPerMinute: null },
    'reference/sample.mp4': { path: 'reference/sample.mp4', shots: [shot(0, 0, 2)], transcript: null, audioClass: 'speech', beatsSec: [], cutsPerMinute: 24 },
  };
  ctx = { prompt: 'Làm video 6 giây', guideline: null, scan, analysis, roles, driver: 'narration',
    capabilities: { transitions: ['cut', 'fade'], effects: ['pushIn'], captionAnimations: ['line', 'word'] } };
});

function timeline(over: (t: Timeline) => void = () => {}): Timeline {
  const t: Timeline = {
    version: 1, fps: 30, width: 1080, height: 1920, durationFrames: 180,
    segments: [
      { id: 's1', source: 'raw/a.mp4', sourceIn: 0, sourceOut: 3, startFrame: 0, durationFrames: 90, speed: 1, crop: 'cover',
        transitionIn: { type: 'cut', frames: 0 }, effects: [], clipGain: 0, approved: false },
      { id: 's2', source: 'raw/b.mp4', sourceIn: 1, sourceOut: 4, startFrame: 90, durationFrames: 90, speed: 1, crop: 'cover',
        transitionIn: { type: 'fade', frames: 10 }, effects: [], clipGain: 0, approved: false },
    ],
    captions: [{ id: 'c1', text: 'Xin chào', startFrame: 15, endFrame: 42, words: [], animation: 'line', approved: false }],
    audio: [{ id: 'a1', kind: 'narration', source: 'reference/vo.mp3', startFrame: 0, sourceIn: 0, gain: 1 }],
    overlays: [],
    style: { fontFamily: 'Be Vietnam Pro', primaryColor: '#FFFFFF', secondaryColor: '#000000', captionPosition: 'bottom', captionSize: 64 },
  };
  over(t);
  return t;
}
const submit = (t: Timeline, notFollowed: unknown[] = []) => turn('submit_timeline', { timeline: t, notFollowed });
const bad = () => submit(timeline(t => { t.segments[0].sourceOut = 20; t.segments[0].durationFrames = 600; t.durationFrames = 690; }));

describe('planTimeline', () => {
  it('returns a valid timeline on the first try', async () => {
    const fake = new FakeModel([submit(timeline())]);
    const out = await planTimeline(ctx, fake);
    expect(out.timeline.segments.map(s => s.id)).toEqual(['s1', 's2']);
    expect(out.notFollowed).toEqual([]);
    expect(fake.calls[0].tools.map(t => t.name)).toEqual(['submit_timeline']);
  });

  it('plan retries on an invalid timeline then succeeds', async () => {
    const fake = new FakeModel([bad(), submit(timeline())]);
    const out = await planTimeline(ctx, fake);
    expect(out.timeline.segments.length).toBeGreaterThan(0);
    expect(JSON.stringify(fake.calls[1].messages)).toContain('sourceOut');
    expect(JSON.stringify(fake.calls[1].messages)).toContain('tool_result');
  });

  it('plan gives up after 3 invalid attempts', async () => {
    const fake = new FakeModel([bad(), bad(), bad(), submit(timeline())]);
    await expect(planTimeline(ctx, fake)).rejects.toMatchObject({ code: 'INVALID_AFTER_RETRIES' });
    expect(fake.calls).toHaveLength(3);
  });

  it('treats a turn without submit_timeline as a failed attempt', async () => {
    const fake = new FakeModel([{ toolCalls: [], text: 'Here is my plan…', usage: { input: 1, output: 1 } }, submit(timeline())]);
    const out = await planTimeline(ctx, fake);
    expect(out.timeline.durationFrames).toBe(180);
    expect(JSON.stringify(fake.calls[1].messages)).toContain('submit_timeline');
  });

  it('plan output is never pre-approved', async () => {
    const fake = new FakeModel([submit(timeline(t => { t.segments.forEach(s => (s.approved = true)); t.captions[0].approved = true; }))]);
    const out = await planTimeline(ctx, fake);
    expect(out.timeline.segments.every(s => !s.approved)).toBe(true);
    expect(out.timeline.captions.every(c => !c.approved)).toBe(true);
  });

  it('notFollowed is passed through', async () => {
    const fake = new FakeModel([submit(timeline(), [{ instruction: 'use pink captions', source: 'prompt', reason: 'guideline says gold' }])]);
    const out = await planTimeline(ctx, fake);
    expect(out.notFollowed[0].instruction).toBe('use pink captions');
    expect(out.notFollowed[0]).toEqual({ instruction: 'use pink captions', source: 'prompt', reason: 'guideline says gold' });
  });

  it('plan message sends frames, never video files', async () => {
    const fake = new FakeModel([submit(timeline())]);
    await planTimeline(ctx, fake);
    const m = JSON.stringify(fake.calls[0].messages);
    expect(m).toContain('image/jpeg');
    expect(m).toContain(JPEG.toString('base64'));
    expect(m).not.toContain('video/mp4');
  });

  it('plan message carries prompt, roles, driver, shots, transcripts, beats, cut pace and format rules', async () => {
    const fake = new FakeModel([submit(timeline())]);
    await planTimeline(ctx, fake);
    const content = (fake.calls[0].messages[0] as { content: { type: string; text?: string }[] }).content;
    const m = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    for (const s of ['Làm video 6 giây', 'reference/vo.mp3', 'narration', 'raw/a.mp4', '[1, 4, 10]', 'chào', '0.9', '1.5',
      'cutsPerMinute', '24', 'Be Vietnam Pro', '#FFFFFF', '#000000', '"s1"', '"c1"', '"a1"', '"o1"', 'contiguous', 'speed']) {
      expect(m, s).toContain(s);
    }
    expect(fake.calls[0].system).toContain('SYSTEM RULES');
  });

  it('includes reference frames only for style roles', async () => {
    const withStyle = new FakeModel([submit(timeline())]);
    await planTimeline(ctx, withStyle);
    const ignoreRoles = ctx.roles.map(r => r.path === 'reference/sample.mp4' ? { ...r, role: 'ignore' as const } : r);
    const noStyle = new FakeModel([submit(timeline())]);
    await planTimeline({ ...ctx, roles: ignoreRoles }, noStyle);
    const images = (f: FakeModel) => (JSON.stringify(f.calls[0].messages).match(/image\/jpeg/g) ?? []).length;
    expect(images(withStyle)).toBe(4); // 3 raw shots + 1 style shot
    expect(images(noStyle)).toBe(3);
    expect(JSON.stringify(noStyle.calls[0].messages)).not.toContain('reference/sample.mp4');
  });

  it('rejects segments cut from a non-raw file and feeds the error back', async () => {
    const fromRef = timeline(t => { t.segments[1].source = 'reference/sample.mp4'; });
    const fake = new FakeModel([submit(fromRef), submit(timeline())]);
    const out = await planTimeline(ctx, fake);
    expect(out.timeline.segments[1].source).toBe('raw/b.mp4');
    expect(JSON.stringify(fake.calls[1].messages)).toMatch(/s2.*not a raw file/);
  });

  it('rejects audio from a style reference without useAudio, accepts it with useAudio', async () => {
    const styleAudio = timeline(t => { t.audio.push({ id: 'a2', kind: 'music', source: 'reference/sample.mp4', startFrame: 0, sourceIn: 0, gain: 0.5 }); });
    const fake = new FakeModel([submit(styleAudio), submit(timeline())]);
    await planTimeline(ctx, fake);
    expect(JSON.stringify(fake.calls[1].messages)).toMatch(/a2.*reference\/sample\.mp4/);

    const allowed = ctx.roles.map(r => r.role === 'style' ? { ...r, useAudio: true, decidedBy: 'prompt' as const } : r);
    const ok = new FakeModel([submit(styleAudio)]);
    const out = await planTimeline({ ...ctx, roles: allowed }, ok);
    expect(out.timeline.audio.map(a => a.id)).toEqual(['a1', 'a2']);
  });

  it('rejects audio from a raw clip or ignored file', async () => {
    const rawAudio = timeline(t => { t.audio[0].source = 'raw/a.mp4'; });
    const fake = new FakeModel([submit(rawAudio), submit(rawAudio), submit(rawAudio)]);
    await expect(planTimeline(ctx, fake)).rejects.toMatchObject({ code: 'INVALID_AFTER_RETRIES' });
  });

  it('lists image files for logo overlays; a logo naming an unknown file is rejected and fed back, a known one passes', async () => {
    const logo = (source: string) => timeline(t => { t.overlays = [{ id: 'o1', kind: 'logo', source, startFrame: 0, endFrame: 180, position: 'bottom-right' }]; });
    const fake = new FakeModel([submit(logo('reference/brand.png')), submit(logo('reference/logo.png'))]);
    const out = await planTimeline(ctx, fake);
    expect(JSON.stringify(fake.calls[0].messages)).toMatch(/image files available for logo overlays: reference\/logo\.png/i);
    expect(JSON.stringify(fake.calls[1].messages)).toMatch(/o1.*reference\/brand\.png.*reference\/logo\.png/);
    expect(out.timeline.overlays[0].source).toBe('reference/logo.png');
  });

  it('a title overlay needs no source', async () => {
    const titled = timeline(t => { t.overlays = [{ id: 'o1', kind: 'title', text: 'Nhà mới', startFrame: 0, endFrame: 60, position: 'center' }]; });
    const out = await planTimeline(ctx, new FakeModel([submit(titled)]));
    expect(out.timeline.overlays).toHaveLength(1);
  });
});
