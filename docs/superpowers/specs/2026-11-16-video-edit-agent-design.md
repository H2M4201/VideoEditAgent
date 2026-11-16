# Video Edit Agent — Phase 1 Design

Date: 2026-11-16
Status: draft, awaiting approval
Source brief: "Brief_BaoGia_AI_Agent_SanXuatVideo" (Phase 1 only)

## 1. Intent

A video agency produces short-form videos (TikTok, Reels, YouTube Shorts) in
volume for clients in real estate, beauty, daily vlog and retail. Editing is
the bottleneck. Phase 1 is an AI agent that turns a folder of raw footage plus
references and a written request into a finished edit, in the client's brand
style, and that can apply a client's feedback to one part of a video without
disturbing the rest.

## 2. Goals, non-goals, anti-goals

Goals
- Prompt + project folder in, edited short video out.
- Per-project brand style and reference handling, written by the editor in a
  guideline file.
- Two interchangeable render engines, chosen per project: a built-in renderer
  (unattended MP4) and a CapCut draft writer (editable project).
- Local fixes from typed feedback that change only the named segment.
- Batch: several jobs queued and run without attention (built-in engine).

Non-goals (Phase 2 or later)
- Trend research, script writing, voice generation, thumbnails, posting,
  channel analytics.
- Multi-user accounts, a shared server, cloud rendering.
- Matching CapCut's full effect library in the built-in engine.
- Producing the price quote requested in the brief.

Anti-goals (a failure even if it runs)
- A fix that shifts timing, music sync or layout of segments the client
  already approved.
- A re-prompt that silently regenerates the whole edit.
- Output that ignores the project guideline.
- Uploading full video files to any third party.

## 3. Constraints

- Runs on the agency's own machines (Windows and macOS); footage is local.
- The agency holds its own AI API keys and pays usage directly.
- CapCut has no public automation API and no unattended export. Recent
  desktop versions encrypt the draft file. The CapCut engine therefore
  targets the unencrypted draft format, must detect an unsupported version
  and say so, and always needs a person to press Export.
- The CapCut engine cannot be verified in the development environment (no
  CapCut there). It is verified on an agency machine. The built-in engine is
  verified end to end in development.
- Captions are primarily Vietnamese; fonts must cover Vietnamese diacritics.

## 4. Approaches considered

1. Built-in renderer only (Remotion + ffmpeg). Unattended, stable, works
   anywhere. No editable project; effects are whatever we build.
2. CapCut draft writer only. Editable result with CapCut Pro's effects and
   fonts, the brief's stated preference. Undocumented format, breaks on
   CapCut updates, encrypted in recent versions, manual export per video.
3. Driving CapCut's interface with clicks. Dropped: slow and brittle.
4. **Chosen: both engines behind one timeline, selectable per project.**
   The user asked for the engine to be configurable. It costs little because
   the timeline is engine-neutral, and it lets the agency use CapCut where
   hand-finishing matters and the built-in engine where volume matters.

## 5. Decided design

### 5.1 Project folder (decided with the user)

```
<project>/
  guideline.md        optional; brand style + reference usage
  raw/                footage to be edited
  reference/          sample videos, audio files, script text files
    links.txt         optional; one YouTube/TikTok URL per line
  .vea/               created by the app: analysis cache, timelines, renders
```

### 5.2 Inputs (decided with the user)

- The user's prompt.
- Raw footage in `raw/`.
- References in `reference/`: sample video (may carry audio), audio file,
  script as text, or a YouTube/TikTok URL in `links.txt`. URLs are downloaded
  on the user's machine into `.vea/` and then treated as sample videos.

### 5.3 Order of authority (decided by the user)

Highest first:

1. **System rules** built into the app (section 5.8).
2. **`guideline.md`**.
3. **The user's prompt.**
4. **The agent's own guess.**

When the prompt conflicts with the guideline, the guideline wins and the app
tells the user which instruction was not followed and why.

### 5.4 guideline.md

Free-form Markdown written by an editor. Two topics:
- Brand style: tone, pacing, caption look, colours, fonts, logo placement,
  things to avoid.
- Reference usage: what each file in `reference/` is for, e.g.
  "`sample1.mp4`: copy caption style only", "`track.mp3` is music".

The app offers starter guidelines for three styles named in the brief: real
estate (polished, calm), vlog (casual, fast), trend (punchy). Creating a
project from a starter copies it into the folder for editing. There is no
separate style setting; the guideline is the style. (Assistant's call: the
earlier idea of a style dropdown was folded into starter guidelines once the
user fixed the order of authority without it.)

### 5.5 Reference roles — agent defaults

Used only where the guideline and prompt are silent:
- Audio with speech → narration; footage is cut to fit it.
- Audio without speech → music; cuts land on its beat.
- Sample video (file or URL) → style to imitate: cut pace, structure,
  caption look, transitions. Its audio is not used.
- Script text → caption wording and story order.

Before generating, the app shows each reference, the role assigned, and the
source of that decision (guideline, prompt, or guess), and the user confirms.

### 5.6 What drives timing

First that applies: narration audio; speech inside the raw footage (keep
good takes, cut pauses); the music's beat; the pace of the sample video or
guideline. A script with no audio becomes on-screen text; no voice is
generated.

### 5.7 Pipeline

1. **Ingest**: scan the folder, download links, probe media.
2. **Analyse** (cached per file): speech transcription with word timings;
   scene-change detection; sampled frames per shot; speech/music
   classification of audio; beat detection for music; for sample videos, cut
   rhythm and caption appearance.
3. **Plan**: the agent (Claude, tool-using) reads the prompt, guideline and
   analysis, and writes a timeline.
4. **Render**: the chosen engine turns the timeline into an MP4 or a CapCut
   draft.
5. **Review and fix**: the user approves segments or types feedback; the
   agent patches the timeline; only affected segments are re-rendered.

### 5.8 System rules (top of the order of authority)

- Approved segments are locked: no change to their start, duration, content
  or captions.
- A fix may not change total duration or move any segment boundary outside
  the segments named in the feedback, unless the user explicitly unlocks.
- Music and narration tracks keep their position through any fix.
- Full media files never leave the machine; only sampled frames and
  transcripts are sent to the AI.
- Audio taken from a downloaded reference is used only on explicit
  instruction.
- Output format limits (5.11).

### 5.9 Timeline: the single source of truth

One JSON document per video version, engine-neutral:
- Video segments with stable ids: source file, in/out points, position,
  speed, crop/reframe, transition in/out, effects, `approved` flag.
- Caption items with stable ids: text, start/end, word timings, style.
- Audio tracks: narration, music, original clip audio, each with gain.
- Overlays: logo, titles.
- Style values resolved from the guideline (fonts, colours, caption preset).

Fixes are patches addressed by segment or caption id. A swap replaces the
source and in/out inside the same slot so duration is unchanged. The patch
is validated against the system rules before it is accepted; a patch that
would move a locked segment is rejected and the agent must try again or
report that the request needs an unlock. Every accepted timeline is kept as
a numbered version, so any fix can be undone.

Feedback refers to time ("the shot at 0:10", "the text at 0:15"); the app
resolves the time to segment/caption ids before the agent acts.

### 5.10 Engines

Both implement one interface: timeline in, result out, plus a capability
list (which effects and transitions they support) that the agent reads
before planning so it does not ask for something the engine cannot do.

- **Built-in**: Remotion for composition, captions, transitions and effects;
  ffmpeg for probing, cutting and encoding. Effect set for Phase 1: cuts,
  cross-fade, slide and zoom transitions, slow push-in/out, speed ramps,
  word-by-word and line caption animations, logo and title overlays. After a
  fix, only changed segments are re-rendered and the result is re-assembled.
- **CapCut**: writes a draft folder into the configured CapCut drafts
  directory. Checks the installed version first; if drafts are encrypted or
  the format is unknown, it stops with a clear message and offers the
  built-in engine. After a fix it rewrites the draft; the user re-exports.

### 5.11 Output

Vertical 9:16, 1080×1920, 30 fps, H.264/AAC MP4, 15–90 seconds by default.
Other aspect ratios are a setting, not a Phase 1 test target.

### 5.12 Application

Local app, opened in the browser, one install per machine, no login.

```
┌ Projects ──┬─ New video ─────────────────────────────┐
│ Villa tour │ Project folder [ D:\shoots\villa    ] 📁 │
│ Spa promo  │ Engine [ Built-in ▾ ]                    │
│ + New      │ Prompt [ 45s tour, calm, end on pool  ]  │
│            │ References        role       decided by  │
│            │  vo.mp3           narration  guess       │
│            │  sample1.mp4      style      guideline   │
│            │ Est. AI cost: ~$0.40        [ Generate ] │
│            ├─ Result ────────────────────────────────┤
│            │ ▶ preview  │ 0:00 intro    ✓ approved    │
│            │            │ 0:10 kitchen  [approve]     │
│            │ Feedback [ swap the shot at 0:10      ]  │
│            │ Versions: v1 v2 v3                       │
└────────────┴─────────────────────────────────────────┘
```

Also: a job queue for batches, and settings (API key, CapCut drafts folder,
default engine, model).

### 5.13 Technology (assistant's calls)

- TypeScript throughout: Node backend, React front end, Remotion renderer.
  One language because Remotion already requires Node.
- Agent: Claude through the Anthropic API with tool use; model is a setting.
- Transcription: Whisper running locally, behind an interface so a hosted
  service can be swapped in.
- Link download: yt-dlp on the user's machine.
- ffmpeg and yt-dlp are bundled or checked at start-up.

### 5.14 Clarifications after review (assistant's calls unless marked)

- **Build order.** Built-in engine first, end to end. The CapCut engine is
  built second and needs a sample draft folder and the version number from
  an agency machine before work starts. If the agency's version encrypts
  drafts and cannot be pinned to an older one, the CapCut engine is dropped
  from Phase 1 and the app ships with the built-in engine only.
- **What "only that segment changes" guarantees.** The guarantee is at the
  timeline level (section 6): untouched segments and captions are identical
  between versions. Re-rendering only changed segments is a speed
  optimisation; a full re-render from the patched timeline is acceptable.
  Frame- or byte-identical output is not required.
- **Fixes with the CapCut engine.** One-way: the app never reads a draft
  back. Each timeline version is written as a new draft (named with the
  version number), so a draft the editor hand-finished is never overwritten.
  Hand edits made in CapCut are not carried into later versions; the app
  says so when a fix is requested on a CapCut project.
- **When a fix does not fit its slot.** Inside the slot the agent may trim,
  pick a different in/out, or change speed between 0.75x and 1.5x. Caption
  text that is too long is wrapped or shrunk within the style's limits; its
  timing does not change. If the request still cannot fit, or it asks for a
  duration change ("make the intro shorter"), the app refuses, explains, and
  offers an explicit unlock that lets later segments move.
- **Approval.** Approval is per segment and per caption, carries forward to
  every later version and across an engine switch, and can be removed by the
  user. Typing into the feedback box always produces a patch. A fresh
  generation is a separate, explicit "Start over" action that creates a new
  video with its own version history and no approvals.
- **Slow machines.** Local transcription is the default. A hosted
  transcription service is an opt-in setting; turning it on warns that audio
  tracks will be uploaded, which is an exception to the "media never leaves
  the machine" rule that the user accepts by enabling it. Agency hardware is
  unknown; the builder should measure on a mid-range laptop without a GPU.
- **Language.** UI in Vietnamese and English, switchable, Vietnamese by
  default. Prompts and guidelines may be written in either. (To be confirmed
  by the user.)

## 6. Acceptance

- For each starter style, one sample video generated from a real project
  folder with the built-in engine, with captions, transitions and music in
  sync.
- A feedback fix ("swap the shot at 0:10", "change the text at 0:15")
  changes only that segment or caption. Checked automatically: every other
  segment and caption in the new timeline is identical to the previous
  version, and total duration is unchanged.
- A prompt that contradicts the guideline is not followed, and the user is
  told.
- The CapCut engine writes a draft that opens in a supported CapCut version
  on an agency machine. Verified there, not in development.

## 7. Left to the builder

- The exact timeline schema and patch format.
- How frames are sampled and how many are sent per shot (cost vs. quality).
- Which local Whisper build and model size.
- How the agent's tools are divided.
- Caption animation details and the look of the three starter guidelines.
- Packaging and installer.
