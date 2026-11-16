import type { FileAnalysis } from '../analysis';
import type { LinkResult } from './links';
import type { ProjectScan } from './scan';

export type Role = 'narration' | 'music' | 'style' | 'script' | 'ignore';
export type RoleAssignment = { path: string; role: Role; useAudio: boolean; decidedBy: 'guideline' | 'prompt' | 'guess'; reason: string };
export type TimingDriver = 'narration' | 'footageSpeech' | 'music' | 'pace';

const guess = (path: string, role: Role, reason: string): RoleAssignment => ({ path, role, useAudio: false, decidedBy: 'guess', reason });

/** Default role for every reference file; guideline and prompt may override these later. */
export function guessRoles(scan: ProjectScan, analysis: Record<string, FileAnalysis>, downloaded: LinkResult[]): RoleAssignment[] {
  const out: RoleAssignment[] = [];
  const speech: { path: string; durationSec: number }[] = [];

  for (const m of scan.references.media) {
    if (m.kind === 'video') { out.push(guess(m.path, 'style', 'Sample video: copy its look and pacing, not its audio')); continue; }
    const cls = analysis[m.path]?.audioClass ?? null;
    if (cls === 'speech') speech.push({ path: m.path, durationSec: m.durationSec });
    else if (cls === 'music') out.push(guess(m.path, 'music', 'Audio contains music'));
    else if (cls === 'silent') out.push(guess(m.path, 'ignore', 'Audio is silent'));
    else out.push(guess(m.path, 'ignore', 'Audio could not be classified'));
  }

  // Longest speech file is the narration; ties go to the first path alphabetically.
  const sorted = [...speech].sort((a, b) => b.durationSec - a.durationSec || (a.path < b.path ? -1 : 1));
  sorted.forEach((s, i) => out.push(i === 0
    ? guess(s.path, 'narration', 'Audio contains speech')
    : guess(s.path, 'ignore', `Another narration file is longer (${sorted[0].path})`)));

  for (const s of scan.references.scripts) out.push(guess(s.path, 'script', 'Text file: used as the script'));
  for (const d of downloaded) if (d.ok) out.push(guess(d.path, 'style', 'Downloaded sample video: copy its look and pacing, not its audio'));

  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** What drives the edit's timing, in priority order. */
export function pickTimingDriver(roles: RoleAssignment[], rawAnalysis: FileAnalysis[]): TimingDriver {
  if (roles.some(r => r.role === 'narration')) return 'narration';
  if (rawAnalysis.some(a => a.audioClass === 'speech')) return 'footageSpeech';
  if (roles.some(r => r.role === 'music')) return 'music';
  return 'pace';
}
