import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Where Remotion cannot download its own browser, point it at a local headless shell (only if present).
const LOCAL_HEADLESS_SHELL = '/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const env: Record<string, string> =
  !process.env.VEA_BROWSER && existsSync(LOCAL_HEADLESS_SHELL) ? { VEA_BROWSER: LOCAL_HEADLESS_SHELL } : {};

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    env,
  },
});
