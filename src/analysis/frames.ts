import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';

/** Writes one 512 px wide JPEG of the frame at `timeSec` to `outPath` (parent dir is created). */
export async function extractFrame(absPath: string, timeSec: number, outPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await execa('ffmpeg', ['-y', '-v', 'error', '-ss', timeSec.toFixed(3), '-i', absPath,
    '-frames:v', '1', '-vf', 'scale=512:-2', '-q:v', '3', outPath]);
}
