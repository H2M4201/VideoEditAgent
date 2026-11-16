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

const enc = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];

/** Two 1 s scenes (testsrc then solid red), 10 fps 320x240, no audio unless `audio` given ('sine' | 'silence'). */
export async function makeTwoSceneVideo(file: string, audio?: 'sine' | 'silence'): Promise<void> {
  const a = audio === 'sine' ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2']
    : audio === 'silence' ? ['-f', 'lavfi', '-t', '2', '-i', 'anullsrc=r=44100:cl=mono'] : [];
  await execa('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=1',
    '-f', 'lavfi', '-i', 'color=c=red:size=320x240:rate=10:duration=1', ...a,
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', ...(audio ? ['-map', '2:a', '-shortest'] : []),
    ...enc, ...(audio ? ['-c:a', 'aac'] : []), file]);
}

/** 12 s video flipping black/white every 0.2 s: 60 scenes. */
export async function makeManySceneVideo(file: string): Promise<void> {
  await execa('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:size=64x64:rate=10:duration=12',
    '-vf', "geq=lum='if(mod(floor(T*5),2),255,0)':cb=128:cr=128", ...enc, file]);
}

/** Audio-only file: a sine tone ('sine') or digital silence ('silence'), `sec` seconds. */
export async function makeAudioFile(file: string, kind: 'sine' | 'silence', sec = 2): Promise<void> {
  const src = kind === 'sine' ? `sine=frequency=440:duration=${sec}` : `anullsrc=r=44100:cl=mono`;
  await execa('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', src, '-t', String(sec), file]);
}
