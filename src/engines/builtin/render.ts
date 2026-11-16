import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { openBrowser, renderMedia, selectComposition, type ChromiumOptions } from '@remotion/renderer';
import type { EngineCapabilities } from '../../agent/prompt';
import type { Engine, RenderOptions, RenderResult } from '../types';
import type { VideoProps } from './remotion/media';
import { serveFolder } from './server';

const ENTRY = fileURLToPath(new URL('./remotion/index.ts', import.meta.url));
const PUBLIC_DIR = fileURLToPath(new URL('../../../assets', import.meta.url));
const COMPOSITION_ID = 'Video';

const CAPABILITIES: EngineCapabilities = {
  transitions: ['cut', 'fade', 'slide', 'zoom'],
  effects: ['pushIn', 'pushOut'],
  captionAnimations: ['line', 'word'],
};

let bundled: Promise<string> | null = null;

/** Bundles the Remotion project once per process; a failed bundle is retried on the next call. */
function serveUrl(): Promise<string> {
  bundled ??= bundle({ entryPoint: ENTRY, publicDir: PUBLIC_DIR }).catch((err: unknown) => {
    bundled = null;
    throw err;
  });
  return bundled;
}

/**
 * Browser settings. VEA_BROWSER points at a local Chrome/Chromium where Remotion cannot download its own;
 * unset, Remotion's default browser applies. Remotion always launches Chromium with --no-sandbox.
 */
function browserOptions(): { browserExecutable: string | null; chromeMode: 'headless-shell' | 'chrome-for-testing'; chromiumOptions: ChromiumOptions } {
  const exe = process.env.VEA_BROWSER || null;
  const chromeMode = exe && !/headless/i.test(path.basename(exe)) ? 'chrome-for-testing' : 'headless-shell';
  return { browserExecutable: exe, chromeMode, chromiumOptions: {} };
}

async function renderTimeline({ projectDir, timeline, outDir, name, onProgress }: RenderOptions): Promise<RenderResult> {
  const out = path.join(outDir, `${name}.mp4`);
  await fs.mkdir(outDir, { recursive: true });
  const url = await serveUrl();
  const server = await serveFolder(projectDir);
  const browser = browserOptions();
  const puppeteerInstance = await openBrowser('chrome', { ...browser, logLevel: 'error' });
  try {
    const inputProps: VideoProps = { timeline, mediaBase: server.url };
    const composition = await selectComposition({ serveUrl: url, id: COMPOSITION_ID, inputProps, puppeteerInstance, logLevel: 'error', ...browser });
    await renderMedia({
      serveUrl: url,
      composition,
      inputProps,
      codec: 'h264',
      audioCodec: 'aac',
      enforceAudioTrack: true,
      outputLocation: out,
      overwrite: true,
      puppeteerInstance,
      logLevel: 'error',
      ...browser,
      onProgress: ({ progress }) => onProgress?.(Math.min(1, Math.max(0, progress))),
    });
    return { kind: 'mp4', path: out };
  } finally {
    await puppeteerInstance.close({ silent: true }).catch(() => {});
    await server.close();
  }
}

export const builtinEngine: Engine = {
  id: 'builtin',
  capabilities: () => structuredClone(CAPABILITIES),
  availability: async () => ({ available: true }),
  render: renderTimeline,
};
