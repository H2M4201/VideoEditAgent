# Video Edit Agent — Core + Built-in Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local app that turns a project folder (`raw/`, `reference/`, `guideline.md`) plus a prompt into a vertical short video with the built-in engine, and applies typed feedback as locked, segment-level patches.

**Architecture:** An engine-neutral timeline (JSON, frame-based) is the single source of truth. A Claude tool-using agent writes timelines and patches; pure TypeScript validators enforce the system rules before anything is saved. A Fastify server runs analysis, agent and render jobs from a serial queue; a React UI drives it. Engines sit behind one interface; this plan ships the built-in (Remotion) engine.

**Tech Stack:** Node 20+, TypeScript, Vitest, zod, Fastify, React + Vite, Remotion 4 (`@remotion/bundler`, `@remotion/renderer`), `@anthropic-ai/sdk`, `execa`, `music-tempo`, external binaries `ffmpeg`/`ffprobe`, `yt-dlp`, `whisper-cli` (whisper.cpp).

**Spec:** `docs/superpowers/specs/2026-11-16-video-edit-agent-design.md`

**Out of this plan:** the CapCut engine (spec 5.10, 5.14) gets its own plan once a sample draft folder from a real machine is available. This plan leaves the engine interface and registry ready for it.

**Deviations from the spec, to confirm with the user:**
- Speed ramps (spec 5.10) are not built; each segment has one constant speed.
- After a fix the whole video is re-rendered (spec 5.14 allows this).
- Remotion needs a paid company licence for organisations above three people; the agency must check this before production use.

## Global Constraints

- Output: 1080×1920, 30 fps, H.264/AAC MP4, default length 15–90 s.
- All timeline times are integer frames at 30 fps; source in/out points are seconds.
- Order of authority: system rules > `guideline.md` > prompt > agent guess.
- Approved segments and captions never change. Without unlock, no segment boundary or total duration changes. Narration and music never move.
- Full media files never leave the machine; only sampled frames (JPEG, 512 px wide) and transcripts go to the AI.
- Audio from a downloaded reference is used only on explicit instruction.
- Fix speed range inside a slot: 0.75–1.5.
- UI strings exist in Vietnamese and English; Vietnamese is the default.
- Default caption font: Be Vietnam Pro, bundled in `assets/fonts/` (covers Vietnamese diacritics).
- Paths stored in timelines are relative to the project folder, POSIX separators.
- Tests: `npx vitest run <file>`. No test may call the network or a real AI; use the fakes defined in each task.
- After each task's code changes run `graphify update .` (repo rule), then commit.

## Review Focus

1. Folder or file names with Vietnamese characters and spaces (`D:\Dự án\căn hộ 1\raw\cảnh 1.mp4`) must scan, probe, serve and render. Test in Tasks 3 and 9.
2. Phone footage with rotation metadata or non-30 fps must be reported with display width/height and real duration. Test in Task 3.
3. Missing `raw/`, empty `raw/`, or a project with no references must give a clear error or proceed, never crash. Test in Task 3.
4. The agent asks for footage past the end of a source file. The validator rejects it and the agent retries. Test in Tasks 1 and 7.
5. A link in `links.txt` fails to download (offline, removed, blocked). The job continues without it and reports the failure. Test in Task 5.

---

## File Structure

```
package.json  tsconfig.json  vitest.config.ts
assets/fonts/BeVietnamPro-*.ttf
starters/{real-estate,vlog,trend}.{vi,en}.md
src/core/timeline.ts     Timeline types (zod) + validateTimeline
src/core/patch.ts        PatchOp, applyPatch, checkLocks
src/core/versions.ts     VersionStore (numbered timelines per video)
src/core/timecode.ts     parseTimecodes, resolveTargets
src/project/scan.ts      scanProject
src/project/probe.ts     probeMedia (ffprobe)
src/project/links.ts     downloadLinks (yt-dlp)
src/project/guideline.ts loadGuideline, createFromStarter
src/project/roles.ts     guessRoles
src/analysis/scenes.ts frames.ts transcribe.ts audio.ts cache.ts index.ts
src/agent/model.ts       AgentModel interface + Anthropic implementation
src/agent/prompt.ts      buildSystemPrompt, buildPlanMessage, buildFixMessage
src/agent/roles.ts       assignRoles
src/agent/plan.ts        planTimeline
src/agent/fix.ts         fixTimeline
src/agent/cost.ts        estimateCost
src/engines/types.ts registry.ts
src/engines/builtin/render.ts
src/engines/builtin/remotion/{index.ts,Root.tsx,Video.tsx,SegmentView.tsx,Captions.tsx,Overlays.tsx}
src/server/settings.ts jobs.ts app.ts main.ts
src/web/  (Vite app: main.tsx, i18n/{vi,en}.ts, api.ts, pages/*)
tests/    mirrors src/; tests/fixtures/make.ts builds media with ffmpeg lavfi
scripts/acceptance.ts
```

---

### Task 1: Scaffold and timeline schema

**Files:** Create `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/core/timeline.ts`, `tests/core/timeline.test.ts`, `tests/helpers/timeline.ts`

**Interfaces — Produces:**

```ts
export const FPS = 30, WIDTH = 1080, HEIGHT = 1920;
export type Transition = { type: 'cut'|'fade'|'slide'|'zoom'; frames: number };
export type Effect = { type: 'pushIn'|'pushOut' };
export type Crop = 'cover' | 'contain' | { x: number; y: number; scale: number };
export type Segment = { id: string; source: string; sourceIn: number; sourceOut: number;
  startFrame: number; durationFrames: number; speed: number; crop: Crop;
  transitionIn: Transition; effects: Effect[]; clipGain: number; approved: boolean };
export type Word = { text: string; startFrame: number; endFrame: number };
export type Caption = { id: string; text: string; startFrame: number; endFrame: number;
  words: Word[]; animation: 'line'|'word'; approved: boolean };
export type AudioTrack = { id: string; kind: 'narration'|'music'; source: string;
  startFrame: number; sourceIn: number; gain: number };
export type Overlay = { id: string; kind: 'logo'|'title'; source?: string; text?: string;
  startFrame: number; endFrame: number;
  position: 'top-left'|'top-right'|'bottom-left'|'bottom-right'|'center' };
export type Style = { fontFamily: string; primaryColor: string; secondaryColor: string;
  captionPosition: 'top'|'middle'|'bottom'; captionSize: number };
export type Timeline = { version: 1; fps: 30; width: 1080; height: 1920; durationFrames: number;
  segments: Segment[]; captions: Caption[]; audio: AudioTrack[]; overlays: Overlay[]; style: Style };
export const TimelineSchema: z.ZodType<Timeline>;
export type SourceInfo = Record<string, { durationSec: number }>; // key = relative path
export function validateTimeline(t: unknown, sources: SourceInfo): { ok: true; timeline: Timeline } | { ok: false; errors: string[] };
// tests/helpers/timeline.ts
export function makeTimeline(n: number, framesEach = 90): Timeline; // n contiguous segments "s1".."sn" from "raw/a.mp4", one caption "c<i>" per segment, one music track "m1"
```

`validateTimeline` rules (each produces one error string naming the id): schema valid; segments sorted, contiguous from frame 0, sum equals `durationFrames`; ids unique across all items; `sourceOut > sourceIn >= 0`; `sourceOut <= sources[source].durationSec`; unknown source; `|(sourceOut - sourceIn) / speed * 30 - durationFrames| <= 1`; `transitionIn.frames < durationFrames`; first segment transition is `cut`; captions within `[0, durationFrames]` and `endFrame > startFrame`; `durationFrames` between 1 and 30*600.

- [ ] **Step 1:** Scaffold: ESM package `vea`, scripts `test: vitest run`, `dev`, `build`; strict tsconfig with `jsx: react-jsx`. Install deps from Tech Stack.
- [ ] **Step 2: Failing tests** in `tests/core/timeline.test.ts`:

```ts
const src = { 'raw/a.mp4': { durationSec: 60 } };
test('valid timeline passes', () => expect(validateTimeline(makeTimeline(3), src).ok).toBe(true));
test('gap between segments is rejected', () => { const t = makeTimeline(3); t.segments[1].startFrame += 5;
  expect(validateTimeline(t, src)).toMatchObject({ ok: false, errors: [expect.stringContaining('s2')] }); });
test('source past end of file is rejected', () => { const t = makeTimeline(1); t.segments[0].sourceOut = 61;
  expect(validateTimeline(t, src).ok).toBe(false); });
test('duration/speed mismatch is rejected', () => { const t = makeTimeline(1); t.segments[0].speed = 2;
  expect(validateTimeline(t, src).ok).toBe(false); });
test('duplicate ids are rejected', () => { const t = makeTimeline(2); t.captions[1].id = 'c1';
  expect(validateTimeline(t, src).ok).toBe(false); });
test('unknown source is rejected', () => expect(validateTimeline(makeTimeline(1), {}).ok).toBe(false));
```

- [ ] **Step 3:** Run `npx vitest run tests/core/timeline.test.ts` — FAIL (module missing).
- [ ] **Step 4:** Implement schema, `validateTimeline`, `makeTimeline`.
- [ ] **Step 5:** Run — PASS. Commit `feat: timeline schema and validation`.

### Task 2: Patches, locks and versions

**Files:** Create `src/core/patch.ts`, `src/core/versions.ts`, `tests/core/patch.test.ts`, `tests/core/versions.test.ts`

**Interfaces — Consumes:** Task 1 types. **Produces:**

```ts
export type PatchOp =
  | { op: 'swapSource'; segmentId: string; source: string; sourceIn: number; sourceOut: number; speed: number }
  | { op: 'setEffects'; segmentId: string; effects: Effect[] }
  | { op: 'setTransition'; segmentId: string; transitionIn: Transition }
  | { op: 'setCrop'; segmentId: string; crop: Crop }
  | { op: 'setCaptionText'; captionId: string; text: string }
  | { op: 'setCaptionAnimation'; captionId: string; animation: 'line'|'word' }
  | { op: 'setGain'; trackId: string; gain: number }
  | { op: 'retime'; segmentId: string; durationFrames: number };
export function applyPatch(t: Timeline, ops: PatchOp[]): Timeline; // pure; throws Error('unknown id: <id>')
export function checkLocks(prev: Timeline, next: Timeline, opts: { targets: string[]; unlock: boolean }): string[]; // violations, [] = ok
export function setApproved(t: Timeline, id: string, approved: boolean): Timeline;
export class VersionStore { constructor(videoDir: string);
  save(t: Timeline, note: string): Promise<number>;  // returns new version n, writes v<n>.timeline.json
  load(n: number): Promise<Timeline>; latest(): Promise<{ n: number; timeline: Timeline } | null>;
  list(): Promise<{ n: number; note: string; createdAt: string }[]>; }
```

`applyPatch`: `setCaptionText` clears `words` and sets `animation: 'line'`; `retime` changes that segment's duration and shifts every later segment, and every caption starting at or after the old end, by the delta, and updates `durationFrames`; music/narration tracks are not touched.

`checkLocks` violations: any segment/caption/track not in `targets` that is not deep-equal (when `unlock`, `startFrame`/`endFrame` shifts of unapproved items are allowed); any approved item that differs in any field, including start (so a `retime` before an approved segment is a violation: message `"<id> is approved; un-approve it first"`); without unlock, any change to `durationFrames`, a segment's `startFrame` or `durationFrames`; any change to `startFrame` or `sourceIn` of an audio track; a targeted segment whose `speed` is outside 0.75–1.5.

- [ ] **Step 1: Failing tests:**

```ts
test('swap changes only the target', () => { const a = makeTimeline(4);
  const b = applyPatch(a, [{ op:'swapSource', segmentId:'s2', source:'raw/a.mp4', sourceIn:10, sourceOut:13, speed:1 }]);
  expect(checkLocks(a, b, { targets:['s2'], unlock:false })).toEqual([]);
  expect(b.segments.filter((s,i)=>i!==1)).toEqual(a.segments.filter((s,i)=>i!==1));
  expect(b.durationFrames).toBe(a.durationFrames); });
test('touching a non-target is a violation', () => { const a = makeTimeline(3);
  const b = applyPatch(a, [{ op:'setCaptionText', captionId:'c3', text:'x' }]);
  expect(checkLocks(a, b, { targets:['c1'], unlock:false })).toHaveLength(1); });
test('approved item cannot change even when targeted', () => { const a = setApproved(makeTimeline(2), 's1', true);
  const b = applyPatch(a, [{ op:'setEffects', segmentId:'s1', effects:[{type:'pushIn'}] }]);
  expect(checkLocks(a, b, { targets:['s1'], unlock:false })[0]).toContain('approved'); });
test('retime without unlock is a violation', () => { const a = makeTimeline(3);
  const b = applyPatch(a, [{ op:'retime', segmentId:'s1', durationFrames:60 }]);
  expect(checkLocks(a, b, { targets:['s1'], unlock:false }).length).toBeGreaterThan(0);
  expect(checkLocks(a, b, { targets:['s1'], unlock:true })).toEqual([]);
  expect(b.audio).toEqual(a.audio); });
test('retime before an approved segment is refused even with unlock', () => { const a = setApproved(makeTimeline(3), 's3', true);
  const b = applyPatch(a, [{ op:'retime', segmentId:'s1', durationFrames:60 }]);
  expect(checkLocks(a, b, { targets:['s1'], unlock:true })[0]).toContain('un-approve'); });
test('speed outside 0.75-1.5 is a violation', () => { const a = makeTimeline(1);
  const b = applyPatch(a, [{ op:'swapSource', segmentId:'s1', source:'raw/a.mp4', sourceIn:0, sourceOut:6, speed:2 }]);
  expect(checkLocks(a, b, { targets:['s1'], unlock:false }).length).toBeGreaterThan(0); });
test('versions are numbered and reloadable', async () => { const vs = new VersionStore(tmp);
  expect(await vs.save(makeTimeline(1), 'first')).toBe(1); expect(await vs.save(makeTimeline(2), 'fix')).toBe(2);
  expect((await vs.load(1)).segments).toHaveLength(1); expect((await vs.latest())!.n).toBe(2); });
```

- [ ] **Step 2:** Run both test files — FAIL.
- [ ] **Step 3:** Implement `patch.ts` and `versions.ts`.
- [ ] **Step 4:** Run — PASS. Commit `feat: patch ops, lock checks, version store`.

### Task 3: Project scan and media probe

**Files:** Create `src/project/scan.ts`, `src/project/probe.ts`, `tests/fixtures/make.ts`, `tests/project/scan.test.ts`

**Interfaces — Produces:**

```ts
export type MediaInfo = { path: string /*relative*/; kind: 'video'|'audio'; durationSec: number;
  width?: number; height?: number /*after rotation*/; fps?: number; hasAudio: boolean };
export function probeMedia(projectDir: string, relPath: string): Promise<MediaInfo>;
export type ProjectScan = { raw: MediaInfo[]; references: { media: MediaInfo[]; scripts: { path: string; text: string }[]; links: string[] };
  guidelinePath: string | null; warnings: string[] };
export class ProjectError extends Error { code: 'NO_RAW_FOLDER'|'NO_RAW_FOOTAGE'|'NOT_A_FOLDER' }
export function scanProject(projectDir: string): Promise<ProjectScan>;
// tests/fixtures/make.ts
export function makeProject(opts?: { rawNames?: string[]; narration?: boolean; music?: boolean; rotated?: boolean }): Promise<string>; // temp dir; 5 s testsrc clips, sine audio
```

Video: `.mp4 .mov .mkv .webm`; audio: `.mp3 .wav .m4a .aac`; script: `.txt .md .srt`. `links.txt` lines starting `http`, `#` lines ignored. A file that ffprobe cannot read goes to `warnings`, not an exception. `.vea/` is ignored.

- [ ] **Step 1: Failing tests:**

```ts
test('scans raw and references', async () => { const d = await makeProject({ narration:true });
  const s = await scanProject(d); expect(s.raw).toHaveLength(2); expect(s.references.media[0].kind).toBe('audio'); });
test('Vietnamese names with spaces work', async () => { const d = await makeProject({ rawNames:['cảnh 1.mp4','phòng khách.mp4'] });
  expect((await scanProject(d)).raw.map(r=>r.path)).toEqual(['raw/cảnh 1.mp4','raw/phòng khách.mp4']); });
test('rotation metadata swaps width and height', async () => { const d = await makeProject({ rotated:true });
  const m = (await scanProject(d)).raw[0]; expect(m.height!).toBeGreaterThan(m.width!); });
test('missing raw folder', async () => { await expect(scanProject(emptyDir)).rejects.toMatchObject({ code:'NO_RAW_FOLDER' }); });
test('empty raw folder', async () => { await expect(scanProject(dirWithEmptyRaw)).rejects.toMatchObject({ code:'NO_RAW_FOOTAGE' }); });
test('no reference folder is fine', async () => { expect((await scanProject(rawOnly)).references.media).toEqual([]); });
test('unreadable file becomes a warning', async () => { /* write garbage raw/bad.mp4 next to a good clip */
  expect((await scanProject(d)).warnings[0]).toContain('bad.mp4'); });
```

- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement with `ffprobe -of json -show_streams -show_format` via `execa` (args as array, never a shell string).
- [ ] **Step 4:** Run — PASS. Commit `feat: project scan and probe`.

### Task 4: Analysis and cache

**Files:** Create `src/analysis/{scenes,frames,transcribe,audio,cache,index}.ts`, `tests/analysis/*.test.ts`, `tests/fixtures/whisper-sample.json`

**Interfaces — Consumes:** `MediaInfo`. **Produces:**

```ts
export type Shot = { index: number; startSec: number; endSec: number; framePath: string /*abs JPEG*/ };
export type Transcript = { words: { text: string; startSec: number; endSec: number }[]; text: string; language: string };
export interface Transcriber { transcribe(absPath: string): Promise<Transcript>; }
export class WhisperCppTranscriber implements Transcriber { constructor(o: { binary: string; modelPath: string }); }
export function parseWhisperJson(json: unknown): Transcript;
export type FileAnalysis = { path: string; shots: Shot[]; transcript: Transcript | null;
  audioClass: 'speech'|'music'|'silent'|null; beatsSec: number[]; cutsPerMinute: number | null };
export function analyseFile(projectDir: string, m: MediaInfo, deps: { transcriber: Transcriber }): Promise<FileAnalysis>;
export function analyseProject(projectDir: string, scan: ProjectScan, deps: { transcriber: Transcriber; onProgress?: (done: number, total: number) => void }): Promise<Record<string, FileAnalysis>>;
```

Decisions: shots from `ffmpeg -vf "select='gt(scene,0.3)',showinfo"`; at most 12 shots per file (merge the shortest neighbours beyond that); one frame per shot at its midpoint, scaled to 512 px wide, saved under `.vea/analysis/frames/`. `audioClass`: `silent` if mean volume < −50 dB (`volumedetect`); `speech` if transcript word time covers ≥ 20% of duration; else `music`. `beatsSec` via `music-tempo` on mono 44.1 kHz PCM, only when `music`. `cutsPerMinute` for reference videos. Whisper is run as `whisper-cli -m <model> -l auto -ojf -of <tmp> <16k wav>`. Cache key: sha1 of relative path + size + mtime, stored in `.vea/analysis/<key>.json`; a cache hit must not call the transcriber.

- [ ] **Step 1: Failing tests:** `parseWhisperJson(fixture)` returns words with ascending times and Vietnamese text intact; a two-scene fixture (`testsrc` then `color=red`) yields 2 shots whose frame files exist; a `sine` clip classifies as `music`, `anullsrc` as `silent`, a fake transcriber covering 50% as `speech`; second `analyseFile` call with a spy transcriber records 1 call total; a 60-scene clip yields ≤ 12 shots.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS. Commit `feat: media analysis with cache`.

### Task 5: Link download

**Files:** Create `src/project/links.ts`, `tests/project/links.test.ts`

**Interfaces — Produces:**

```ts
export type LinkResult = { url: string; ok: true; path: string /*relative, .vea/downloads/<sha1>.mp4*/ } | { url: string; ok: false; error: string };
export function downloadLinks(projectDir: string, urls: string[], o: { ytDlp: string; run?: typeof execa }): Promise<LinkResult[]>;
```

Only `http(s)` URLs whose host ends with `youtube.com`, `youtu.be` or `tiktok.com` are attempted; others return `ok: false, error: 'unsupported site'`. Already-downloaded URLs are not fetched again. Args: `['-f','mp4/best','--no-playlist','-o',<out>,<url>]`.

- [ ] **Step 1: Failing tests** (inject `run`): success returns the path; a rejected run returns `ok:false` with stderr text and the other URLs still processed; `http://evil.example/x` is `unsupported site` and `run` is not called; a second call with the file present does not call `run`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit `feat: reference link download`.

### Task 6: Guideline, starters and default roles

**Files:** Create `src/project/guideline.ts`, `src/project/roles.ts`, `starters/*.md` (6 files), `tests/project/roles.test.ts`, `tests/project/guideline.test.ts`

**Interfaces — Produces:**

```ts
export type Role = 'narration'|'music'|'style'|'script'|'ignore';
export type RoleAssignment = { path: string; role: Role; useAudio: boolean; decidedBy: 'guideline'|'prompt'|'guess'; reason: string };
export function guessRoles(scan: ProjectScan, analysis: Record<string, FileAnalysis>, downloaded: LinkResult[]): RoleAssignment[];
export type TimingDriver = 'narration'|'footageSpeech'|'music'|'pace';
export function pickTimingDriver(roles: RoleAssignment[], rawAnalysis: FileAnalysis[]): TimingDriver;
export function loadGuideline(projectDir: string): Promise<string | null>;
export const STARTERS = ['real-estate','vlog','trend'] as const;
export function createFromStarter(projectDir: string, starter: typeof STARTERS[number], lang: 'vi'|'en'): Promise<void>; // refuses to overwrite: Error('guideline exists')
```

Defaults (spec 5.5): audio `speech` → `narration`; audio `music` → `music`; any video reference → `style`, `useAudio: false`; script file → `script`; `silent` audio → `ignore`. Two narration candidates: the longest is `narration`, others `ignore` with a reason. `pickTimingDriver` (spec 5.6): narration role present → `narration`; else any raw file with `audioClass === 'speech'` → `footageSpeech`; else music role → `music`; else `pace`.

Each starter has the headings `## Brand style` and `## Reference usage` (Vietnamese files: `## Phong cách thương hiệu`, `## Cách dùng tài liệu tham khảo`) with pacing, caption look, colours, font, transitions and things to avoid: real-estate = calm, 3–5 s shots, fades, serif-free elegant captions; vlog = casual, 1.5–3 s shots, word-by-word captions; trend = punchy, 0.7–1.5 s shots on the beat, large bold captions.

- [ ] **Step 1: Failing tests:** each default above; `useAudio` false for a sample video with audio; the four `pickTimingDriver` cases in order; `createFromStarter` writes a file containing both headings for all 6 combinations and throws when `guideline.md` exists.
- [ ] **Step 2:** FAIL. **Step 3:** Implement and write starters. **Step 4:** PASS. Commit `feat: guideline starters and default reference roles`.

### Task 7: Agent — model, prompts, roles and planning

**Files:** Create `src/agent/{model,prompt,roles,plan,cost}.ts`, `tests/agent/{prompt,roles,plan,cost}.test.ts`, `tests/helpers/fakeModel.ts`

**Interfaces — Consumes:** Tasks 1, 3, 4, 6. **Produces:**

```ts
export type ToolDef = { name: string; description: string; input_schema: object };
export type ModelTurn = { toolCalls: { id: string; name: string; input: unknown }[]; text: string; usage: { input: number; output: number } };
export interface AgentModel { run(req: { system: string; messages: unknown[]; tools: ToolDef[] }): Promise<ModelTurn>; }
export class AnthropicModel implements AgentModel { constructor(o: { apiKey: string; model: string }); }
export class FakeModel implements AgentModel { constructor(script: ModelTurn[]); calls: { system: string; messages: unknown[] }[]; }
export type EngineCapabilities = { transitions: Transition['type'][]; effects: Effect['type'][]; captionAnimations: ('line'|'word')[] };
export type NotFollowed = { instruction: string; source: 'prompt'; reason: string };
export function buildSystemPrompt(o: { guideline: string | null; capabilities: EngineCapabilities }): string;
export function assignRoles(ctx: { prompt: string; guideline: string | null; defaults: RoleAssignment[] }, model: AgentModel): Promise<RoleAssignment[]>;
export type PlanContext = { prompt: string; guideline: string | null; scan: ProjectScan; analysis: Record<string, FileAnalysis>;
  roles: RoleAssignment[]; driver: TimingDriver; capabilities: EngineCapabilities };
export function planTimeline(ctx: PlanContext, model: AgentModel): Promise<{ timeline: Timeline; notFollowed: NotFollowed[] }>;
export class AgentError extends Error { code: 'NO_API_KEY'|'INVALID_AFTER_RETRIES'|'API_ERROR' }
export function estimateCost(o: { frames: number; textChars: number; inputPricePerMTok: number; outputPricePerMTok: number }): { inputTokens: number; outputTokens: number; usd: number };
```

Decisions:
- `buildSystemPrompt` sections in this order, each under a heading: `SYSTEM RULES` (spec 5.8, verbatim list), `GUIDELINE` (file text or "none"), then a paragraph stating the order of authority and: "If the user's prompt conflicts with the guideline, follow the guideline and list the prompt instruction in `notFollowed`." Then engine capabilities and the output format from Global Constraints.
- Tools: `submit_roles { roles: RoleAssignment[] }`; `submit_timeline { timeline, notFollowed }`.
- `assignRoles` may change `role`/`useAudio` only with `decidedBy` `guideline` or `prompt`; an entry returned with `decidedBy: 'guess'` that differs from the default is reset to the default. Paths not in `defaults` are dropped.
- The plan user message carries: prompt; roles; driver; per raw file its duration and per-shot `[index, startSec, endSec]` followed by that shot's JPEG as an image block; transcripts with word times; `beatsSec`; reference `cutsPerMinute`. Frames from reference videos are included only for `style` roles.
- `planTimeline` validates with `validateTimeline`; on failure it replies with a `tool_result` listing the errors and asks again, at most 3 attempts in total, then throws `INVALID_AFTER_RETRIES`. Every segment and caption is forced to `approved: false`.
- `estimateCost`: 700 input tokens per frame, 1 token per 3 characters, output fixed at 6000 tokens. Default prices: take the current list price of the default model from Anthropic's pricing page when implementing and store them as the settings defaults (Task 10).
- `AnthropicModel` uses the Messages API with tool use and base64 image blocks; default model `claude-opus-5-5`; missing key throws `NO_API_KEY`.

- [ ] **Step 1: Failing tests:**

```ts
test('system prompt orders rules before guideline', () => { const p = buildSystemPrompt({ guideline:'Use gold captions', capabilities });
  expect(p.indexOf('SYSTEM RULES')).toBeLessThan(p.indexOf('GUIDELINE')); expect(p).toContain('Use gold captions'); expect(p).toContain('notFollowed'); });
test('roles: guideline decision is kept, unexplained change is reset', async () => { /* FakeModel returns vo.mp3 as music/guideline and sample.mp4 as narration/guess */
  const r = await assignRoles(ctx, fake); expect(r.find(x=>x.path.endsWith('vo.mp3'))!.role).toBe('music');
  expect(r.find(x=>x.path.endsWith('sample.mp4'))!.role).toBe('style'); });
test('plan retries on an invalid timeline then succeeds', async () => { const fake = new FakeModel([turn(badTimelinePastEndOfFile), turn(goodTimeline)]);
  const out = await planTimeline(ctx, fake); expect(out.timeline.segments.length).toBeGreaterThan(0);
  expect(JSON.stringify(fake.calls[1].messages)).toContain('sourceOut'); });
test('plan gives up after 3 invalid attempts', async () => { await expect(planTimeline(ctx, new FakeModel([bad,bad,bad]))).rejects.toMatchObject({ code:'INVALID_AFTER_RETRIES' }); });
test('plan output is never pre-approved', async () => { /* fake returns approved:true */ expect(out.timeline.segments.every(s=>!s.approved)).toBe(true); });
test('notFollowed is passed through', async () => { expect(out.notFollowed[0].instruction).toBe('use pink captions'); });
test('plan message sends frames, never video files', async () => { const m = JSON.stringify(fake.calls[0].messages);
  expect(m).toContain('image/jpeg'); expect(m).not.toContain('video/mp4'); });
test('cost', () => expect(estimateCost({ frames:10, textChars:3000, inputPricePerMTok:10, outputPricePerMTok:50 }))
  .toEqual({ inputTokens:8000, outputTokens:6000, usd:0.38 }));
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit `feat: planning agent with authority order and validation loop`.

### Task 8: Fix flow

**Files:** Create `src/core/timecode.ts`, `src/agent/fix.ts`, `tests/core/timecode.test.ts`, `tests/agent/fix.test.ts`

**Interfaces — Consumes:** Tasks 1, 2, 7. **Produces:**

```ts
export function parseTimecodes(text: string): number[]; // seconds
export function resolveTargets(t: Timeline, feedback: string): { candidates: string[]; matchedTimes: number[] };
export type FixResult = { status: 'applied'; timeline: Timeline; targets: string[]; summary: string }
  | { status: 'refused'; reason: string; needsUnlock: boolean };
export function fixTimeline(ctx: { feedback: string; current: Timeline; guideline: string | null; scan: ProjectScan;
  analysis: Record<string, FileAnalysis>; capabilities: EngineCapabilities; unlock: boolean }, model: AgentModel): Promise<FixResult>;
```

Decisions:
- `parseTimecodes` accepts `0:10`, `1:05`, `10s`, `second 10`, `giây 10`, `giây thứ 10`.
- `resolveTargets`: for each time, the segment covering that frame and every caption covering it; approved items are excluded. No timecode found → all unapproved ids.
- Tools: `submit_patch { targets: string[], ops: PatchOp[], summary }` and `refuse { reason, needsUnlock }`. `targets` outside `candidates` are rejected as a validation error.
- After `applyPatch`: run `checkLocks(current, next, { targets, unlock })` and `validateTimeline`; violations go back to the model, at most 3 attempts, then `refused` with the last violations as the reason and `needsUnlock: true` when any violation mentions duration or start.
- Feedback aimed only at approved items (candidates empty though a time matched) returns `refused`, reason `"That part is approved. Remove the approval to change it."`, without calling the model.
- The fix message includes the current timeline JSON, candidates, and for a segment swap the shots of all raw files (with frames) so the agent can pick a replacement.

- [ ] **Step 1: Failing tests:**

```ts
test.each([['đổi cảnh giây thứ 10',[10]],['fix text at 0:15',[15]],['1:05 and 20s',[65,20]]])('parse %s', (s,e)=>expect(parseTimecodes(s)).toEqual(e));
test('time resolves to covering segment and caption', () => expect(resolveTargets(makeTimeline(5), 'swap 0:07').candidates.sort()).toEqual(['c3','s3']));
test('fix changes only the named segment', async () => { const cur = makeTimeline(5);
  const r = await fixTimeline({ ...ctx, current:cur, feedback:'swap the shot at 0:07' }, new FakeModel([patchTurn(['s3'], swapS3)]));
  expect(r.status).toBe('applied'); if (r.status==='applied') { expect(r.timeline.durationFrames).toBe(cur.durationFrames);
    expect(r.timeline.segments.filter(s=>s.id!=='s3')).toEqual(cur.segments.filter(s=>s.id!=='s3')); expect(r.timeline.captions).toEqual(cur.captions); } });
test('patch touching another segment is retried then refused', async () => { const r = await fixTimeline(ctx7, new FakeModel([bad,bad,bad])); expect(r.status).toBe('refused'); });
test('approved target is refused without calling the model', async () => { const fake = new FakeModel([]);
  const r = await fixTimeline({ ...ctx, current:setApproved(setApproved(makeTimeline(5),'s3',true),'c3',true), feedback:'swap 0:07' }, fake);
  expect(r).toMatchObject({ status:'refused' }); expect(fake.calls).toHaveLength(0); });
test('shorten request without unlock reports needsUnlock', async () => { /* fake returns retime */ expect(r).toMatchObject({ status:'refused', needsUnlock:true }); });
test('same request with unlock applies and keeps music in place', async () => { expect(r.status).toBe('applied'); /* audio equal to before */ });
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit `feat: feedback fixes as locked patches`.

### Task 9: Engine interface and built-in renderer

**Files:** Create `src/engines/{types,registry}.ts`, `src/engines/builtin/render.ts`, `src/engines/builtin/remotion/*`, `assets/fonts/*`, `tests/engines/builtin.test.ts`, `tests/engines/registry.test.ts`

**Interfaces — Consumes:** Task 1, `EngineCapabilities`. **Produces:**

```ts
export type RenderResult = { kind: 'mp4'; path: string } | { kind: 'capcutDraft'; path: string };
export interface Engine { id: 'builtin'|'capcut'; capabilities(): EngineCapabilities;
  availability(): Promise<{ available: boolean; reason?: string }>;
  render(o: { projectDir: string; timeline: Timeline; outDir: string; name: string; onProgress?: (p: number) => void }): Promise<RenderResult>; }
export function listEngines(): Engine[]; export function getEngine(id: string): Engine; // throws on unknown id
export const builtinEngine: Engine;
```

Decisions: capabilities = transitions `cut, fade, slide, zoom`; effects `pushIn, pushOut`; caption animations `line, word`. `render` bundles `src/engines/builtin/remotion/index.ts` once per process, starts a loopback-only static server over `projectDir` for the duration of the render, and passes `{ timeline, mediaBase }` as input props to composition id `Video` (duration, fps and size from the timeline); codec h264, audio aac. `SegmentView` uses `OffthreadVideo` with `startFrom`/`playbackRate`; a transition is drawn inside the incoming segment's first `transitionIn.frames` frames over the previous segment's held last frame, so boundaries never move. Captions render inside a safe area (10% side margins, 18% bottom) and wrap; text that still overflows shrinks to no less than 60% of `captionSize`. Media URLs are built with `encodeURIComponent` per path part. Full re-render every time. Audio: narration and music tracks via `Audio` with `volume: gain`; clip audio at `clipGain`.

- [ ] **Step 1: Failing tests** (real render of a 2-segment, 2-second timeline from `makeProject`, 120 s timeout):

```ts
test('renders a 1080x1920 30fps mp4 of the timeline length', async () => { const r = await builtinEngine.render({ projectDir, timeline, outDir, name:'v1' });
  const m = await probeMedia(outDir, 'v1.mp4'); expect([m.width, m.height, m.fps]).toEqual([1080,1920,30]);
  expect(m.durationSec).toBeCloseTo(timeline.durationFrames/30, 1); expect(m.hasAudio).toBe(true); });
test('renders sources with Vietnamese names and spaces', async () => { /* project with 'cảnh 1.mp4' */ expect(r.kind).toBe('mp4'); });
test('registry lists builtin as available', async () => { expect((await getEngine('builtin').availability()).available).toBe(true); expect(()=>getEngine('x')).toThrow(); });
```

- [ ] **Step 2:** FAIL. **Step 3:** Implement. If Remotion cannot download its browser in this environment, pass `browserExecutable: '/opt/pw-browsers/chromium'` from env var `VEA_BROWSER`.
- [ ] **Step 4:** PASS. Commit `feat: engine interface and built-in renderer`.

### Task 10: Server, settings and job queue

**Files:** Create `src/server/{settings,jobs,app,main}.ts`, `tests/server/{settings,jobs,app}.test.ts`

**Interfaces — Consumes:** everything above. **Produces:**

```ts
export type Settings = { apiKey: string; model: string; language: 'vi'|'en'; defaultEngine: 'builtin'|'capcut';
  capcutDraftsDir: string; whisperBinary: string; whisperModel: string; ytDlpBinary: string;
  inputPricePerMTok: number; outputPricePerMTok: number; projects: { id: string; dir: string; name: string }[] };
export class SettingsStore { constructor(file?: string /*default ~/.vea/settings.json*/); get(): Promise<Settings>; update(p: Partial<Settings>): Promise<Settings>; }
export type Job = { id: string; kind: 'prepare'|'generate'|'fix'|'render'; projectId: string; videoId?: string;
  status: 'queued'|'running'|'done'|'failed'; progress: number; message: string; result?: unknown; error?: string };
export class JobQueue { add(kind: Job['kind'], meta: object, run: (report: (p: number, msg: string) => void) => Promise<unknown>): Job;
  get(id: string): Job | undefined; list(): Job[]; subscribe(fn: (j: Job) => void): () => void; }
export function buildApp(deps: { settings: SettingsStore; queue: JobQueue; model: (s: Settings) => AgentModel; transcriber: (s: Settings) => Transcriber }): FastifyInstance;
```

Routes (JSON; errors as `{ error: { code, message } }`):

| Route | Does |
|---|---|
| `GET/PUT /api/settings` | read/update; `apiKey` returned masked (last 4 chars) |
| `GET /api/engines` | id, capabilities, availability |
| `POST /api/projects {dir}` · `GET /api/projects` | register (runs `scanProject`), list |
| `POST /api/projects/:id/guideline {starter, lang}` | `createFromStarter` |
| `POST /api/projects/:id/prepare {prompt}` | job: scan → download links → analyse → `guessRoles` → `assignRoles`; result `{ roles, driver, cost, linkFailures, warnings }` |
| `POST /api/projects/:id/videos {prompt, roles, engine}` | job: `planTimeline` → save v1 → render; result `{ videoId, version, notFollowed, output }` |
| `GET /api/projects/:id/videos/:vid` | versions, latest timeline, outputs |
| `POST .../:vid/approve {id, approved}` | `setApproved`, saved as a new version, no re-render |
| `POST .../:vid/fix {feedback, unlock}` | job: `fixTimeline` → on `applied` save version → render; on `refused` result carries reason and `needsUnlock` |
| `POST .../:vid/revert {version}` | saves that version's timeline as the newest and renders |
| `GET /api/jobs` · `GET /api/jobs/stream` | list; server-sent events of job updates |
| `GET /media/:projectId/*` | serves files under that project folder only |

Decisions: listen on `127.0.0.1` only. Queue runs one job at a time, in order; a failing job does not stop the queue. `/media` resolves the path and rejects anything outside the project folder with 403. Videos live in `<project>/.vea/videos/<videoId>/` (`v<n>.timeline.json`, `v<n>.mp4`). "Start over" in the UI is simply `POST /videos` again (new `videoId`). Approval carries forward because every version derives from the previous timeline.

- [ ] **Step 1: Failing tests** (Fastify `inject`, FakeModel, fake transcriber, engine stubbed to write an empty file):
  - settings round-trip; `GET /api/settings` never returns the full key.
  - queue runs jobs in order; job 2 runs after job 1 fails; subscribers see `queued → running → done`.
  - `prepare` on a fixture project returns roles with `decidedBy` and a cost; a failing link appears in `linkFailures` and the job is `done`.
  - `videos` → result has `version: 1`; then `fix` with a FakeModel patch → `version: 2` and timeline v2 differs from v1 only in the target.
  - `fix` with `refused` leaves the latest version at 1.
  - `approve` then `fix` aimed at the approved segment → refused.
  - `GET /media/<id>/../../etc/passwd` (encoded) → 403; `GET /media/<id>/raw/c%E1%BA%A3nh%201.mp4` → 200.
  - `prepare` with an empty `apiKey` → job failed with code `NO_API_KEY`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit `feat: local server, settings and job queue`.

### Task 11: Web UI

**Files:** Create `src/web/{index.html,main.tsx,api.ts,App.tsx}`, `src/web/i18n/{vi,en,index}.ts`, `src/web/pages/{Projects,NewVideo,Result,Settings,Queue}.tsx`, `tests/web/{i18n,NewVideo,Result}.test.tsx`; modify `src/server/main.ts` to serve the built UI.

**Interfaces — Consumes:** Task 10 routes. **Produces:** `t(key: keyof typeof vi): string`, `setLanguage(l: 'vi'|'en')`.

Screens follow the sketch in spec 5.12:
- **Projects:** list; add by typing or pasting a folder path (a browser cannot open a native folder picker that returns a path, so the field is text with validation from `POST /api/projects`); "create guideline from starter" when none exists.
- **New video:** engine select (unavailable engines disabled with their reason), prompt box, "Check references" → runs `prepare`, then shows a table of path / role (editable select) / decided by, the estimated cost, link failures and warnings, and "Generate".
- **Result:** video player; list of segments and captions with time, text, approve toggle; feedback box; a refused fix shows its reason and, when `needsUnlock`, a button "Allow later segments to move" that resends with `unlock: true`; `notFollowed` shown as a notice; version list with "Go back to this version"; "Start over".
- **Queue:** jobs with progress from the event stream.
- **Settings:** API key, model, language, default engine, CapCut drafts folder, binaries, prices.

- [ ] **Step 1: Failing tests** (Vitest + Testing Library, `api.ts` mocked):
  - `Object.keys(vi)` equals `Object.keys(en)`; no empty values.
  - NewVideo: after `prepare` resolves, each role row shows its `decidedBy`; changing a select sends the edited roles in the `videos` request.
  - NewVideo: an engine with `available:false` is disabled and shows its reason.
  - Result: a refused fix with `needsUnlock` shows the unlock button; clicking sends `unlock: true`.
  - Result: `notFollowed` entries are displayed.
  - Switching language changes the "Generate" label between `Tạo video` and `Generate`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit `feat: web UI in Vietnamese and English`.

### Task 12: End-to-end acceptance

**Files:** Create `scripts/acceptance.ts`, `tests/e2e/acceptance.test.ts`, `README.md`

**Interfaces — Consumes:** everything.

`tests/e2e/acceptance.test.ts` (no network; FakeModel scripted with a 3-segment plan and one swap patch; real analysis with a fake transcriber; real built-in render), mapping to spec section 6:

```ts
test('generate, fix one segment, everything else identical', async () => {
  // prepare -> videos -> v1.mp4 exists and probes as 1080x1920
  // fix "swap the shot at 0:03" -> v2
  expect(v2.durationFrames).toBe(v1.durationFrames);
  expect(v2.segments.filter(s=>s.id!==target)).toEqual(v1.segments.filter(s=>s.id!==target));
  expect(v2.captions).toEqual(v1.captions); expect(v2.audio).toEqual(v1.audio);
  // v2.mp4 exists with the same duration as v1.mp4 (±0.1 s)
});
test('revert restores version 1 content as version 3', async () => { expect(v3.segments).toEqual(v1.segments); });
```

`scripts/acceptance.ts` is the manual run with a real API key and a real project folder per starter style: `npx tsx scripts/acceptance.ts <projectDir> "<prompt>"` prints the roles, cost, `notFollowed`, and the output path, then applies the feedback given as a third argument and prints a diff of changed ids. README: install (Node, ffmpeg, yt-dlp, whisper.cpp + model), run, folder layout, order of authority, known limits (deviations above; CapCut engine pending).

- [ ] **Step 1:** Write the e2e test — FAIL. **Step 2:** Fix whatever integration gaps it exposes. **Step 3:** `npx vitest run` — all PASS.
- [ ] **Step 4:** Write `scripts/acceptance.ts` and README. Commit `test: end-to-end acceptance and docs`.
- [ ] **Step 5 (needs the user):** run `scripts/acceptance.ts` with a real key on real footage for each starter, including one prompt that contradicts the guideline; record results in the README.
