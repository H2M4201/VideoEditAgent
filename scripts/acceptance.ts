/**
 * Manual acceptance run against the real AI and the real transcriber.
 *
 *   npx tsx scripts/acceptance.ts <projectDir> "<prompt>" ["<feedback>"]
 *
 * prepare -> generate (built-in engine) -> optional fix, calling the pipeline functions directly (no HTTP).
 * The API key comes from ~/.vea/settings.json or the ANTHROPIC_API_KEY environment variable.
 */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { AnthropicModel } from '../src/agent/model';
import { WhisperCppTranscriber } from '../src/analysis';
import type { Timeline } from '../src/core/timeline';
import { VersionStore } from '../src/core/versions';
import { builtinEngine } from '../src/engines/builtin/render';
import { runFix, runGenerate, runPrepare, videoDir, type JobDeps } from '../src/server/pipeline';
import { SettingsStore } from '../src/server/settings';

const USAGE = 'Usage: npx tsx scripts/acceptance.ts <projectDir> "<prompt>" ["<feedback>"]';

/** Ids (segments, captions, audio tracks, overlays) whose content differs between two timelines, including added and removed ones. */
function changedIds(a: Timeline, b: Timeline): string[] {
  const items = (t: Timeline) => new Map<string, string>([...t.segments, ...t.captions, ...t.audio, ...t.overlays].map(i => [i.id, JSON.stringify(i)]));
  const [x, y] = [items(a), items(b)];
  return [...new Set([...x.keys(), ...y.keys()])].filter(id => x.get(id) !== y.get(id));
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function requireBinary(bin: string, what: string, args: string[]): Promise<void> {
  try { await execa(bin, args); }
  catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') fail(`${what} was not found (tried "${bin}"). Install it and make sure it is on PATH.`);
    // A program that starts but exits non-zero is present, which is all that is checked here.
  }
}

async function main(): Promise<void> {
  const [dirArg, prompt, feedback] = process.argv.slice(2);
  if (!dirArg || !prompt) { console.error(USAGE); process.exit(1); }
  const dir = await fs.realpath(path.resolve(dirArg)).catch(() => fail(`project folder ${dirArg} does not exist`));

  const settings = await new SettingsStore().get();
  const apiKey = process.env.ANTHROPIC_API_KEY || settings.apiKey;
  if (!apiKey) fail('no Anthropic API key. Set ANTHROPIC_API_KEY or add it in ~/.vea/settings.json (apiKey).');
  await requireBinary('ffmpeg', 'ffmpeg', ['-version']);
  await requireBinary('ffprobe', 'ffprobe', ['-version']);
  await requireBinary(settings.whisperBinary, 'The whisper binary', ['--help']);
  if (!settings.whisperModel || !existsSync(settings.whisperModel)) {
    fail(`whisper model file not found (whisperModel = "${settings.whisperModel}" in ~/.vea/settings.json).`);
  }

  const deps: JobDeps = {
    settings: { ...settings, apiKey },
    model: s => new AnthropicModel({ apiKey: s.apiKey, model: s.model }),
    transcriber: s => new WhisperCppTranscriber({ binary: s.whisperBinary, modelPath: s.whisperModel }),
    engines: () => builtinEngine,
  };
  const p = { id: 'acceptance', dir };
  const report = (x: number, msg: string) => console.error(`[${Math.round(x * 100)}%] ${msg}`);

  const prep = await runPrepare(p, prompt, deps, report);
  console.log('\nRoles:');
  for (const r of prep.roles) console.log(`  ${r.path}: ${r.role}${r.useAudio ? ' (own audio)' : ''}, decided by ${r.decidedBy} - ${r.reason}`);
  console.log(`Timing driver: ${prep.driver}`);
  console.log(`Cost estimate: ${prep.cost.inputTokens} input tokens, ${prep.cost.outputTokens} output tokens, $${prep.cost.usd}`);
  for (const f of prep.linkFailures) console.log(`Link failed: ${f.url} (${f.error})`);
  for (const w of prep.warnings) console.log(`Warning: ${w}`);

  const videoId = `acc${Date.now().toString(36)}`;
  const gen = await runGenerate(p, { videoId, prompt, roles: prep.roles, engine: 'builtin' }, deps, report);
  console.log(`\nGenerated version ${gen.version}.`);
  console.log(`Not followed: ${gen.notFollowed.length === 0 ? 'nothing' : ''}`);
  for (const n of gen.notFollowed) console.log(`  "${n.instruction}" - ${n.reason}`);
  console.log(`Output: ${gen.output.path}`);

  if (!feedback) return;
  const fix = await runFix(p, videoId, { feedback, unlock: false }, deps, report);
  if (fix.status === 'refused') {
    console.log(`\nFix refused${fix.needsUnlock ? ' (needs unlock)' : ''}: ${fix.reason}`);
    return;
  }
  const store = new VersionStore(videoDir(dir, videoId));
  const [before, after] = [await store.load(gen.version), await store.load(fix.version)];
  console.log(`\nFix applied as version ${fix.version}: ${fix.summary}`);
  console.log(`Targets: ${fix.targets.join(', ')}`);
  console.log(`Ids whose content differs from version ${gen.version}: ${changedIds(before, after).join(', ') || 'none'}`);
  console.log(`Total duration changed: ${before.durationFrames === after.durationFrames ? 'no' : `yes (${before.durationFrames} -> ${after.durationFrames} frames)`}`);
  console.log(`Output: ${fix.output.path}`);
}

main().catch(e => fail((e as Error).message ?? String(e)));
