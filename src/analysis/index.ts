import path from 'node:path';
import type { MediaInfo, ProjectScan } from '../project/scan';
import { detectBeats, meanVolumeDb, SILENT_DB } from './audio';
import { cacheKey, framesDir, readCache, writeCache } from './cache';
import { extractFrame } from './frames';
import { detectScenes } from './scenes';
import type { Transcriber, Transcript } from './transcribe';

export { parseWhisperJson, WhisperCppTranscriber } from './transcribe';
export type { Transcriber, Transcript } from './transcribe';

export type Shot = { index: number; startSec: number; endSec: number; framePath: string /*abs JPEG*/ };
export type FileAnalysis = { path: string; shots: Shot[]; transcript: Transcript | null;
  audioClass: 'speech' | 'music' | 'silent' | null; beatsSec: number[]; cutsPerMinute: number | null };

const SPEECH_COVERAGE = 0.2;

function speechCoverage(t: Transcript, durationSec: number): number {
  const spoken = t.words.reduce((s, w) => s + Math.max(0, w.endSec - w.startSec), 0);
  return durationSec > 0 ? spoken / durationSec : 0;
}

export async function analyseFile(projectDir: string, m: MediaInfo, deps: { transcriber: Transcriber }): Promise<FileAnalysis> {
  const key = await cacheKey(projectDir, m.path);
  const cached = await readCache(projectDir, key);
  if (cached) return cached;

  const abs = path.join(projectDir, ...m.path.split('/'));
  let shots: Shot[] = [];
  let cutsPerMinute: number | null = null;
  if (m.kind === 'video') {
    const spans = await detectScenes(abs, m.durationSec);
    shots = await Promise.all(spans.map(async (s, index) => {
      const framePath = path.join(framesDir(projectDir), `${key}-${index}.jpg`);
      await extractFrame(abs, (s.startSec + s.endSec) / 2, framePath);
      return { index, startSec: s.startSec, endSec: s.endSec, framePath };
    }));
    if (m.path.startsWith('reference/')) cutsPerMinute = m.durationSec > 0 ? ((shots.length - 1) / m.durationSec) * 60 : 0;
  }

  let transcript: Transcript | null = null;
  let audioClass: FileAnalysis['audioClass'] = null;
  let beatsSec: number[] = [];
  if (m.hasAudio) {
    if ((await meanVolumeDb(abs)) < SILENT_DB) audioClass = 'silent';
    else {
      transcript = await deps.transcriber.transcribe(abs);
      audioClass = speechCoverage(transcript, m.durationSec) >= SPEECH_COVERAGE ? 'speech' : 'music';
      if (audioClass === 'music') beatsSec = await detectBeats(abs);
    }
  }
  const result: FileAnalysis = { path: m.path, shots, transcript, audioClass, beatsSec, cutsPerMinute };
  await writeCache(projectDir, key, result);
  return result;
}

export async function analyseProject(projectDir: string, scan: ProjectScan,
  deps: { transcriber: Transcriber; onProgress?: (done: number, total: number) => void }): Promise<Record<string, FileAnalysis>> {
  const files = [...scan.raw, ...scan.references.media];
  const out: Record<string, FileAnalysis> = {};
  let done = 0;
  for (const m of files) {
    const a = await analyseFile(projectDir, m, deps);
    out[m.path] = a;
    deps.onProgress?.(++done, files.length);
  }
  return out;
}
