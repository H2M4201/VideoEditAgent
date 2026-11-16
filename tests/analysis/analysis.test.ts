import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyseFile, analyseProject, parseWhisperJson, type Transcriber, type Transcript } from '../../src/analysis';
import { probeMedia } from '../../src/project/probe';
import { scanProject } from '../../src/project/scan';
import { makeAudioFile, makeManySceneVideo, makeTwoSceneVideo } from '../fixtures/make';

const none: Transcript = { words: [], text: '', language: 'en' };
const spy = (t: Transcript = none) => { const s = { calls: 0, async transcribe() { s.calls++; return t; } }; return s as Transcriber & { calls: number }; };
const half: Transcript = { words: [{ text: 'hi', startSec: 0, endSec: 1 }], text: 'hi', language: 'en' };

let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vea-an-'));
  await fs.mkdir(path.join(dir, 'raw')); await fs.mkdir(path.join(dir, 'reference'));
  const r = (n: string) => path.join(dir, 'raw', n);
  await makeTwoSceneVideo(r('two.mp4'));
  await makeTwoSceneVideo(r('two-sine.mp4'), 'sine');
  await makeTwoSceneVideo(r('two-silent.mp4'), 'silence');
  await makeManySceneVideo(r('many.mp4'));
  await makeAudioFile(r('tone.wav'), 'sine');
  await makeAudioFile(r('quiet.wav'), 'silence');
  await makeTwoSceneVideo(path.join(dir, 'reference', 'ref.mp4'));
});
afterAll(() => fs.rm(dir, { recursive: true, force: true }));
const info = (rel: string) => probeMedia(dir, rel);
const clearCache = () => fs.rm(path.join(dir, '.vea'), { recursive: true, force: true });

describe('parseWhisperJson', () => {
  it('merges tokens into words with ascending times and keeps Vietnamese', async () => {
    const j = JSON.parse(await fs.readFile(path.join(__dirname, '../fixtures/whisper-sample.json'), 'utf8'));
    const t = parseWhisperJson(j);
    expect(t.language).toBe('vi');
    expect(t.words.map(w => w.text)).toEqual(['Xin', 'chào', 'các', 'bạn', 'Hôm', 'nay', 'chúng', 'ta', 'đi', 'Đà', 'Nẵng']);
    expect(t.text).toBe('Xin chào các bạn Hôm nay chúng ta đi Đà Nẵng');
    expect([t.words[3].startSec, t.words[3].endSec]).toEqual([1.1, 1.9]);
    for (let i = 1; i < t.words.length; i++) expect(t.words[i].startSec).toBeGreaterThanOrEqual(t.words[i - 1].startSec);
  });
});

describe('analyseFile', () => {
  it('splits a two-scene video into 2 shots with frame files; no audio -> null', async () => {
    const a = await analyseFile(dir, await info('raw/two.mp4'), { transcriber: spy() });
    expect(a.shots).toHaveLength(2);
    expect(a.shots[0].startSec).toBe(0);
    expect(a.shots[1].endSec).toBeCloseTo(2, 1);
    for (const s of a.shots) expect((await fs.stat(s.framePath)).size).toBeGreaterThan(0);
    expect(a.transcript).toBeNull(); expect(a.audioClass).toBeNull(); expect(a.cutsPerMinute).toBeNull();
  });
  it('classifies sine as music, silence as silent, covering transcript as speech', async () => {
    await clearCache();
    expect((await analyseFile(dir, await info('raw/tone.wav'), { transcriber: spy() })).audioClass).toBe('music');
    const sil = spy();
    const s = await analyseFile(dir, await info('raw/quiet.wav'), { transcriber: sil });
    expect(s.audioClass).toBe('silent'); expect(sil.calls).toBe(0); expect(s.transcript).toBeNull();
    expect((await analyseFile(dir, await info('raw/two-silent.mp4'), { transcriber: spy() })).audioClass).toBe('silent');
    const sp = await analyseFile(dir, await info('raw/two-sine.mp4'), { transcriber: spy(half) });
    expect(sp.audioClass).toBe('speech'); expect(sp.beatsSec).toEqual([]);
  });
  it('caches: second call does not transcribe again', async () => {
    await clearCache();
    const t = spy();
    const m = await info('raw/tone.wav');
    await analyseFile(dir, m, { transcriber: t }); await analyseFile(dir, m, { transcriber: t });
    expect(t.calls).toBe(1);
  });
  it('caps a 60-scene clip at 12 shots covering the whole duration', async () => {
    const m = await info('raw/many.mp4');
    const a = await analyseFile(dir, m, { transcriber: spy() });
    expect(a.shots.length).toBeLessThanOrEqual(12);
    expect(a.shots.length).toBeGreaterThan(1);
    expect(a.shots[0].startSec).toBe(0);
    expect(a.shots.at(-1)!.endSec).toBeCloseTo(m.durationSec, 2);
    a.shots.slice(1).forEach((s, i) => expect(s.startSec).toBe(a.shots[i].endSec));
  });
});

describe('analyseProject', () => {
  it('analyses raw and reference media; cutsPerMinute only for reference videos', async () => {
    const scan = await scanProject(dir);
    const progress: number[] = [];
    const out = await analyseProject(dir, scan, { transcriber: spy(), onProgress: d => progress.push(d) });
    expect(Object.keys(out).sort()).toEqual([...scan.raw, ...scan.references.media].map(m => m.path).sort());
    expect(out['reference/ref.mp4'].cutsPerMinute).toBeCloseTo(30, 0);
    expect(out['raw/two.mp4'].cutsPerMinute).toBeNull();
    expect(progress.at(-1)).toBe(Object.keys(out).length);
  });

  it('analyses a file stored under a decomposed (NFD) name through its NFC path', async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'vea-an-nfd-'));
    try {
      await fs.mkdir(path.join(d, 'raw'));
      await makeTwoSceneVideo(path.join(d, 'raw', 'cảnh 1.mp4'.normalize('NFD')), 'sine');
      const scan = await scanProject(d);
      const rel = 'raw/cảnh 1.mp4'.normalize('NFC');
      expect(scan.raw.map(m => m.path)).toEqual([rel]);
      const seen: string[] = [];
      const t: Transcriber = { async transcribe(abs) { seen.push(abs); await fs.access(abs); return half; } };
      const out = await analyseProject(d, scan, { transcriber: t });
      expect(out[rel].shots).toHaveLength(2);
      expect(out[rel].audioClass).toBe('speech');
      expect(seen).toHaveLength(1);
      // cached on the second run
      expect((await analyseProject(d, scan, { transcriber: t }))[rel].shots).toHaveLength(2);
      expect(seen).toHaveLength(1);
    } finally { await fs.rm(d, { recursive: true, force: true }); }
  });
});
