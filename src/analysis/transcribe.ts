import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';

export type Transcript = { words: { text: string; startSec: number; endSec: number }[]; text: string; language: string };
export interface Transcriber { transcribe(absPath: string): Promise<Transcript>; }

type WToken = { text: string; offsets: { from: number; to: number } };
type WSegment = { text?: string; tokens?: WToken[] };

/** Parses whisper.cpp `-ojf` full JSON into words (tokens merged by leading space) with times in seconds. */
export function parseWhisperJson(json: unknown): Transcript {
  const j = json as { result?: { language?: string }; transcription?: WSegment[] };
  const words: Transcript['words'] = [];
  const texts: string[] = [];
  for (const seg of j.transcription ?? []) {
    if (seg.text?.trim()) texts.push(seg.text.trim());
    let current: Transcript['words'][number] | null = null;
    for (const tok of seg.tokens ?? []) {
      if (tok.text.startsWith('[_')) continue;
      const from = tok.offsets.from / 1000; const to = tok.offsets.to / 1000;
      if (tok.text.startsWith(' ') || !current) {
        if (!tok.text.trim()) continue;
        current = { text: tok.text.trim(), startSec: from, endSec: to };
        words.push(current);
      } else { current.text += tok.text; current.endSec = to; }
    }
  }
  return { words, text: texts.join(' '), language: j.result?.language ?? 'unknown' };
}

export class WhisperCppTranscriber implements Transcriber {
  constructor(private o: { binary: string; modelPath: string }) {}

  async transcribe(absPath: string): Promise<Transcript> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'vea-whisper-'));
    try {
      const wav = path.join(tmp, 'in.wav');
      await execa('ffmpeg', ['-y', '-v', 'error', '-i', absPath, '-vn', '-ar', '16000', '-ac', '1', wav]);
      const prefix = path.join(tmp, 'out');
      await execa(this.o.binary, ['-m', this.o.modelPath, '-l', 'auto', '-ojf', '-of', prefix, wav]);
      return parseWhisperJson(JSON.parse(await fs.readFile(`${prefix}.json`, 'utf8')));
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  }
}
