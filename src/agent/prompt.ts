import { promises as fs } from 'node:fs';
import { FPS, HEIGHT, WIDTH, type Effect, type Style, type Transition } from '../core/timeline';
import type { FileAnalysis, Shot } from '../analysis';
import type { RoleAssignment } from '../project/roles';
import type { PlanContext } from './plan';
import type { ProjectScan } from '../project/scan';

export type EngineCapabilities = { transitions: Transition['type'][]; effects: Effect['type'][]; captionAnimations: ('line' | 'word')[] };

/** Style used where the guideline says nothing about the look. */
export const DEFAULT_STYLE: Style = {
  fontFamily: 'Be Vietnam Pro', primaryColor: '#FFFFFF', secondaryColor: '#000000', captionPosition: 'bottom', captionSize: 64,
};

/** Spec 5.8, verbatim. */
const SYSTEM_RULES = [
  'Approved segments are locked: no change to their start, duration, content or captions.',
  'A fix may not change total duration or move any segment boundary outside the segments named in the feedback, unless the user explicitly unlocks.',
  'Music and narration tracks keep their position through any fix.',
  'Full media files never leave the machine; only sampled frames and transcripts are sent to the AI.',
  'Audio taken from a downloaded reference is used only on explicit instruction.',
  'Output format limits (5.11).',
];

/** SYSTEM RULES, GUIDELINE and the order of authority: the shared head of every agent system prompt. */
export function authorityPrompt(guideline: string | null): string {
  const g = guideline && guideline.trim() ? guideline.trim() : 'none';
  return `You are the editing agent of a local video-editing app used by a Vietnamese video agency. You turn raw footage into short vertical videos.

# SYSTEM RULES

${SYSTEM_RULES.map(r => `- ${r}`).join('\n')}
- Output format limits: ${WIDTH}x${HEIGHT} vertical, ${FPS} fps, default length 15–90 seconds.

# GUIDELINE

${g}

# Order of authority

The order of authority, highest first, is: 1. SYSTEM RULES, 2. GUIDELINE, 3. the user's prompt, 4. your own guess. Where a higher source decides something, a lower one cannot change it; use your own judgement only where all three are silent. If the user's prompt conflicts with the guideline, follow the guideline and list the prompt instruction in \`notFollowed\`.

# Language

Prompts and guidelines may be written in Vietnamese or English; understand both. Caption text stays in the language of the narration/script (usually Vietnamese, with correct diacritics); never translate it. Write \`notFollowed\` reasons in the language of the user's prompt.`;
}

export function buildSystemPrompt(o: { guideline: string | null; capabilities: EngineCapabilities }): string {
  const c = o.capabilities;
  return `${authorityPrompt(o.guideline)}

# Engine capabilities

The selected render engine supports only these; use nothing else.
- transitions: ${c.transitions.join(', ') || 'cut'}
- effects: ${c.effects.join(', ') || 'none'}
- caption animations: ${c.captionAnimations.join(', ') || 'line'}

# Output format

- Video: ${WIDTH}x${HEIGHT} (9:16), ${FPS} fps, H.264/AAC MP4, default length 15–90 seconds unless the guideline or prompt asks otherwise.
- All timeline positions and durations are integer frames at ${FPS} fps; source in/out points are seconds in the source file.
- File paths are relative to the project folder with forward slashes, exactly as given to you.
- Answer only by calling the tool you are given, with the complete result as its input. Do not answer in plain text.`;
}

/** The exact timeline shape and the validator's rules, for the plan message. */
export function timelineFormat(): string {
  return `## Timeline format

Submit \`timeline\` as JSON of exactly this shape:
{
  "version": 1, "fps": ${FPS}, "width": ${WIDTH}, "height": ${HEIGHT},
  "durationFrames": int,
  "segments": [{ "id": "s1", "source": "raw/<file>", "sourceIn": sec, "sourceOut": sec, "startFrame": int, "durationFrames": int,
    "speed": number, "crop": "cover" | "contain" | { "x": number, "y": number, "scale": number }, "transitionIn": { "type": "cut" | "fade" | "slide" | "zoom", "frames": int },
    "effects": [{ "type": "pushIn" | "pushOut" }], "clipGain": number >= 0, "approved": false }],
  "captions": [{ "id": "c1", "text": string, "startFrame": int, "endFrame": int, "words": [{ "text": string, "startFrame": int, "endFrame": int }],
    "animation": "line" | "word", "approved": false }],
  "audio": [{ "id": "a1", "kind": "narration" | "music", "source": "<path>", "startFrame": int, "sourceIn": sec, "gain": number >= 0 }],
  "overlays": [{ "id": "o1", "kind": "logo" | "title", "source"?: "<path>", "text"?: string, "startFrame": int, "endFrame": int,
    "position": "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center" }],
  "style": { "fontFamily": string, "primaryColor": "#RRGGBB", "secondaryColor": "#RRGGBB", "captionPosition": "top" | "middle" | "bottom", "captionSize": number }
}
Only transitions, effects and caption animations listed under engine capabilities may be used.

## Rules the app checks (a timeline that breaks one is sent back to you)

- Ids: segments "s1", "s2", …; captions "c1", "c2", …; audio "a1", "a2", …; overlays "o1", "o2", …; every id unique.
- fps ${FPS}, width ${WIDTH}, height ${HEIGHT}; durationFrames between 1 and ${FPS * 600}.
- Segments are in order and contiguous from frame 0: the first startFrame is 0, each next startFrame is the previous startFrame + durationFrames, and the durationFrames of all segments add up to the timeline durationFrames.
- Segment source must be a file in raw/; 0 <= sourceIn < sourceOut <= that file's duration.
- Speed and duration: durationFrames = round((sourceOut - sourceIn) / speed * ${FPS}) (±1 frame); keep speed between 0.75 and 1.5.
- The first segment's transitionIn is { "type": "cut", "frames": 0 }; every transitionIn.frames is less than its segment's durationFrames.
- Captions lie within [0, durationFrames] with endFrame > startFrame; word frames are timeline frames.
- Audio tracks may use only the narration file, the music file, or a style reference whose role says useAudio: true. Original clip sound is controlled by segment clipGain (0 = muted).
- A logo overlay's source must be one of the image files listed for logo overlays; a title overlay has text and no source.
- Every segment and caption has "approved": false.
- Style: where the guideline says nothing, use ${JSON.stringify(DEFAULT_STYLE)}.

Also submit \`notFollowed\`: one entry { "instruction", "source": "prompt", "reason" } for each prompt instruction you did not follow because the guideline or the system rules override it; [] if none.`;
}

// ---- plan message ----

export type TextBlock = { type: 'text'; text: string };
export type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg'; data: string } };
export type ContentBlock = TextBlock | ImageBlock;

const text = (t: string): TextBlock => ({ type: 'text', text: t });
const sec = (n: number) => Math.round(n * 100) / 100;

// ---- frame budget ----

/** Most images one request may carry (raw and style frames together). */
export const MAX_IMAGES = 100;
/** Most style-reference frames in one request, all style files together. */
export const MAX_STYLE_IMAGES = 12;

/** `k` of `n` positions spread evenly over 0..n-1 (all of them when k >= n). */
function spread(n: number, k: number): number[] {
  if (k >= n) return Array.from({ length: n }, (_, i) => i);
  return Array.from({ length: k }, (_, j) => Math.floor(((j + 0.5) * n) / k));
}

/** Splits `budget` over files by their counts (largest remainder), never giving a file more than it has; `min1`: each non-empty file gets 1 first. */
function allocate(counts: number[], budget: number, min1: boolean): number[] {
  if (counts.reduce((a, b) => a + b, 0) <= budget) return [...counts];
  const out: number[] = counts.map(c => (min1 && c > 0 ? 1 : 0));
  const rest = counts.map((c, i) => c - out[i]);
  const remaining = Math.max(0, budget - out.reduce((a, b) => a + b, 0));
  const restTotal = rest.reduce((a, b) => a + b, 0);
  if (remaining === 0 || restTotal === 0) return out;
  const ideal = rest.map(r => (r * remaining) / restTotal);
  ideal.forEach((x, i) => { out[i] += Math.floor(x); });
  let left = remaining - ideal.reduce((a, x) => a + Math.floor(x), 0);
  const byFraction = ideal.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of byFraction) { if (left <= 0) break; if (out[i] < counts[i]) { out[i] += 1; left -= 1; } }
  return out;
}

/**
 * Which shots (by position in each file's shot list) get their frame sent. At most MAX_IMAGES in total: every raw file keeps at
 * least one, style references share at most MAX_STYLE_IMAGES, and the rest of the budget goes to raw files by shot count.
 * Within a file the kept shots are spread evenly. Used for both plan and fix messages, and for the cost estimate.
 */
export function frameSelection(files: { raw: { path: string; shots: number }[]; style: { path: string; shots: number }[] }): Record<string, number[]> {
  const rawMin = files.raw.filter(f => f.shots > 0).length;
  const styleShots = files.style.reduce((n, f) => n + f.shots, 0);
  const styleBudget = Math.min(styleShots, MAX_STYLE_IMAGES, Math.max(0, MAX_IMAGES - rawMin));
  const styleAlloc = allocate(files.style.map(f => f.shots), styleBudget, false);
  const rawAlloc = allocate(files.raw.map(f => f.shots), MAX_IMAGES - styleAlloc.reduce((a, b) => a + b, 0), true);
  const out: Record<string, number[]> = {};
  files.raw.forEach((f, i) => { out[f.path] = spread(f.shots, rawAlloc[i]); });
  files.style.forEach((f, i) => { out[f.path] = spread(f.shots, styleAlloc[i]); });
  return out;
}

/** The frame selection for a plan or fix request: every raw file, plus the given style references. */
export function requestFrames(scan: ProjectScan, analysis: Record<string, FileAnalysis>, stylePaths: string[]): Record<string, number[]> {
  const shots = (p: string) => ({ path: p, shots: analysis[p]?.shots.length ?? 0 });
  return frameSelection({ raw: scan.raw.map(m => shots(m.path)), style: stylePaths.map(shots) });
}

/** One text line per shot followed by its JPEG frame when the shot is in `keep`; only sampled frames are sent, never the media file. */
async function shotBlocks(shots: Shot[], keep: number[]): Promise<ContentBlock[]> {
  const out: ContentBlock[] = [];
  for (const [i, s] of shots.entries()) {
    const line = `shot [${s.index}, ${sec(s.startSec)}, ${sec(s.endSec)}]`;
    if (!keep.includes(i)) { out.push(text(`${line} (no frame)`)); continue; }
    out.push(text(line));
    const data = await fs.readFile(s.framePath).then(b => b.toString('base64'), () => null);
    out.push(data ? { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } } : text('(frame unavailable)'));
  }
  return out;
}

function transcriptText(a: FileAnalysis | undefined): string | null {
  const t = a?.transcript;
  if (!t || t.words.length === 0) return null;
  return `transcript (${t.language}): ${t.text.trim()}\nword times [text, startSec, endSec]: ${JSON.stringify(t.words.map(w => [w.text, sec(w.startSec), sec(w.endSec)]))}`;
}

function roleLine(r: RoleAssignment): string {
  return `- ${r.path}: ${r.role}${r.role === 'style' ? `, useAudio: ${r.useAudio}` : ''} (decided by ${r.decidedBy}: ${r.reason})`;
}

/** The reference images a logo overlay may use. */
export function imagesLine(scan: ProjectScan): string {
  const images = scan.references.images;
  return `Image files available for logo overlays: ${images.length ? images.join(', ') : 'none (do not add a logo overlay)'}.`;
}

/** Every raw file with its duration, transcript and shots; the shots `frames` selects carry a sampled frame. */
export async function rawFootageBlocks(scan: ProjectScan, analysis: Record<string, FileAnalysis>, frames: Record<string, number[]>): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [text(`# Raw footage (cut only from these files)\n\nEach shot is [index, startSec, endSec], followed by a frame from its middle; `
    + `to keep the request small, shots marked (no frame) are listed without one.`)];
  for (const m of scan.raw) {
    const a = analysis[m.path];
    const t = transcriptText(a);
    blocks.push(text(`## ${m.path}\n${m.kind}, duration ${sec(m.durationSec)}s, ${m.hasAudio ? 'has audio' : 'no audio'}${t ? `\n${t}` : ''}`));
    blocks.push(...(await shotBlocks(a?.shots ?? [], frames[m.path] ?? [])));
  }
  return blocks;
}

/** The user message asking for a timeline: prompt, roles, timing driver, raw footage frames, transcripts, beats, reference pace, format rules. */
export async function buildPlanMessage(ctx: PlanContext): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  const active = ctx.roles.filter(r => r.role !== 'ignore');
  blocks.push(text(`# User prompt\n\n${ctx.prompt}\n\n# Reference roles\n\n${active.length ? active.map(roleLine).join('\n') : 'none'}\n\n` +
    `# Timing driver\n\n${ctx.driver} (${DRIVER_HELP[ctx.driver]})\n\n# Logo\n\n${imagesLine(ctx.scan)}`));

  const frames = requestFrames(ctx.scan, ctx.analysis, active.filter(r => r.role === 'style').map(r => r.path));
  blocks.push(...(await rawFootageBlocks(ctx.scan, ctx.analysis, frames)));

  if (active.length) blocks.push(text('# References'));
  for (const r of active) {
    const a = ctx.analysis[r.path];
    const lines = [`## ${r.path} (${r.role})`];
    const media = ctx.scan.references.media.find(x => x.path === r.path);
    if (media) lines.push(`duration ${sec(media.durationSec)}s`);
    if (r.role === 'narration') { const t = transcriptText(a); if (t) lines.push(t); }
    if (r.role === 'music' && a?.beatsSec.length) lines.push(`beatsSec: ${JSON.stringify(a.beatsSec.map(sec))}`);
    if (r.role === 'script') {
      const s = ctx.scan.references.scripts.find(x => x.path === r.path);
      if (s) lines.push(`script text:\n${s.text.trim()}`);
    }
    if (r.role === 'style' && a?.cutsPerMinute != null) lines.push(`cutsPerMinute: ${sec(a.cutsPerMinute)}`);
    blocks.push(text(lines.join('\n')));
    if (r.role === 'style') blocks.push(...(await shotBlocks(a?.shots ?? [], frames[r.path] ?? [])));
  }

  blocks.push(text(`${timelineFormat()}\n\nNow call submit_timeline with the complete timeline and notFollowed.`));
  return blocks;
}

const DRIVER_HELP: Record<PlanContext['driver'], string> = {
  narration: 'cut the footage to fit the narration; place it as audio track a1 at frame 0 and make the video as long as the narration',
  footageSpeech: 'keep good spoken takes from the raw footage, cut pauses; keep clip audio on (clipGain 1)',
  music: 'land cuts on the music beats',
  pace: 'follow the cut pace of the style reference or guideline',
};
