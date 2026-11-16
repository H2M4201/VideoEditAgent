import { execa } from 'execa';

export const MAX_SHOTS = 12;
export type Span = { startSec: number; endSec: number };

/** Merges the shortest span into its shorter neighbour until at most `max` remain. */
export function mergeShortest(spans: Span[], max: number): Span[] {
  const out = spans.map(s => ({ ...s }));
  while (out.length > max) {
    let i = 0;
    for (let k = 1; k < out.length; k++) if (len(out[k]) < len(out[i])) i = k;
    const left = i > 0 ? len(out[i - 1]) : Infinity;
    const right = i < out.length - 1 ? len(out[i + 1]) : Infinity;
    if (left <= right) { out[i - 1].endSec = out[i].endSec; out.splice(i, 1); }
    else { out[i + 1].startSec = out[i].startSec; out.splice(i, 1); }
  }
  return out;
}
const len = (s: Span) => s.endSec - s.startSec;

/** Scene-cut spans of a video (single span if no cuts), at most MAX_SHOTS. */
export async function detectScenes(absPath: string, durationSec: number): Promise<Span[]> {
  const { stderr } = await execa('ffmpeg', ['-v', 'info', '-i', absPath, '-an',
    '-vf', "select='gt(scene,0.3)',showinfo", '-f', 'null', '-'], { all: false });
  const cuts = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map(m => Number(m[1]))
    .filter(t => t > 0.05 && t < durationSec - 0.05).sort((a, b) => a - b);
  const bounds = [0, ...cuts, durationSec];
  const spans: Span[] = [];
  for (let i = 0; i < bounds.length - 1; i++) if (bounds[i + 1] > bounds[i]) spans.push({ startSec: bounds[i], endSec: bounds[i + 1] });
  return mergeShortest(spans.length ? spans : [{ startSec: 0, endSec: durationSec }], MAX_SHOTS);
}
