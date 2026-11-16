import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';

export type MakeProjectOpts = { rawNames?: string[]; narration?: boolean; music?: boolean; rotated?: boolean };

async function makeClip(file: string, freq: number, rotate90: boolean): Promise<void> {
  const base = ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30:duration=5',
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=5`, '-shortest',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '200k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '48k'];
  if (!rotate90) { await execa('ffmpeg', [...base, file]); return; }
  const plain = `${file}.plain.mp4`;
  await execa('ffmpeg', [...base, plain]);
  await execa('ffmpeg', ['-y', '-v', 'error', '-display_rotation:v:0', '90', '-i', plain, '-c', 'copy', file]);
  await fs.rm(plain);
}

async function makeAudio(file: string, freq: number): Promise<void> {
  await execa('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=5`, '-b:a', '48k', file]);
}

/** Builds a temp project folder (raw/ clips, optional reference/ audio). Caller owns cleanup. */
export async function makeProject(opts: MakeProjectOpts = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vea-proj-'));
  const raw = path.join(dir, 'raw');
  await fs.mkdir(raw);
  const names = opts.rawNames ?? ['a.mp4', 'b.mp4'];
  await Promise.all(names.map((n, i) => makeClip(path.join(raw, n), 440 + i * 110, !!opts.rotated && i === 0)));
  if (opts.narration || opts.music) {
    const ref = path.join(dir, 'reference');
    await fs.mkdir(ref);
    if (opts.narration) await makeAudio(path.join(ref, 'vo.mp3'), 300);
    if (opts.music) await makeAudio(path.join(ref, 'track.mp3'), 660);
  }
  return dir;
}
