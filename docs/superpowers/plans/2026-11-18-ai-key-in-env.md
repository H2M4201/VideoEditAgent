# AI Key in `.env` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The AI key is entered on the Settings page and stored in the app folder's `.env` as `AI_PROVIDER_KEY`, never in `settings.json`.

**Architecture:** A small `.env` module reads and edits the file line by line. `SettingsStore` keeps its public shape (`Settings.apiKey` is still what the pipeline reads) but sources `apiKey` from `.env` / the environment and writes it back to `.env`; it never persists `apiKey` to JSON. The settings API adds `keySource`; the UI shows it.

**Tech Stack:** Node 22, TypeScript, Vitest, Fastify, React (existing).

**Spec:** `docs/superpowers/specs/2026-11-18-ai-key-in-env-design.md`

## Global Constraints

- Variable name: `AI_PROVIDER_KEY`. File: `.env` in the app folder (repository root, next to `package.json`), mode 0600, git-ignored.
- Precedence: key in `.env` > `AI_PROVIDER_KEY` in the process environment > none. `keySource: 'env-file' | 'environment' | 'none'`.
- Saving keeps every other `.env` line, comment and order; empty value removes the line; writes atomic (temp + rename) and serialised with settings writes.
- The full key never leaves the server; the UI sees `maskApiKey(key)` (existing: `••••` + last 4). Sending the masked value back means "unchanged".
- `.env` is read on every `get()` (hand edits apply without restart).
- Migration at startup: non-empty `apiKey` in `settings.json` and no key in `.env` → write it to `.env`; then always remove `apiKey` from `settings.json`.
- Tests never touch the repository's real `.env` or the real process environment.
- `graphify update .` only if `graphify` is on PATH.

## Review Focus

1. `.env` with Windows line endings (`\r\n`) → key read without a trailing `\r`; other lines keep `\r\n` on save. Test in Task 1.
2. `.env` has `export AI_PROVIDER_KEY=...` or spaces around `=` → key read. Test in Task 1.
3. A key containing `#`, spaces or `=` → round-trips exactly. Test in Task 1.
4. User saves settings while the key comes from the environment (source `environment`) and leaves the masked field as is → nothing written to `.env`. Test in Task 2.
5. `settings.json` still holds an old `apiKey` while `.env` already has a different key → `.env` wins, old key removed from JSON, never written over `.env`. Test in Task 2.

---

### Task 1: `.env` file module

**Files:** Create `src/server/envfile.ts`, `tests/server/envfile.test.ts`

**Interfaces — Produces:**

```ts
export const KEY_VAR = 'AI_PROVIDER_KEY';
export function parseEnv(text: string): Record<string, string>;
export function setEnvValue(text: string, name: string, value: string | null): string; // null or '' removes the line
export function readEnvFile(file: string): Promise<string>;        // '' when missing
export function writeEnvFile(file: string, text: string): Promise<void>; // atomic, mode 0600, creates the folder
```

Rules: lines are `NAME=value`, optional leading `export `, spaces around `=` ignored; values in `"…"` or `'…'` are unquoted (`\"` and `\\` unescaped inside double quotes); unquoted values end at ` #` (comment) and are trimmed; blank and `#` lines ignored by `parseEnv`. `setEnvValue` replaces the first matching line in place (dropping later duplicates), or appends a line at the end (adding a newline before it if the text doesn't end with one); it keeps the file's line ending (`\r\n` if the text contains one). It writes the value bare when it matches `/^[A-Za-z0-9_\-.:\/+=@]*$/`, else in double quotes with `\` and `"` escaped.

- [ ] **Step 1: Failing tests:**

```ts
test('parses plain, export, spaced, quoted and commented lines', () => {
  expect(parseEnv('A=1\nexport B = two \nC="x # y"\nD=v # note\n# E=no\n\nF=\'q\'')).toEqual({ A:'1', B:'two', C:'x # y', D:'v', F:'q' });
});
test('CRLF files read without a trailing \\r and keep CRLF on save', () => {
  const t = 'A=1\r\nAI_PROVIDER_KEY=old\r\n';
  expect(parseEnv(t).AI_PROVIDER_KEY).toBe('old');
  expect(setEnvValue(t, KEY_VAR, 'new')).toBe('A=1\r\nAI_PROVIDER_KEY=new\r\n');
});
test('set keeps other lines and order; replaces in place', () => {
  expect(setEnvValue('# c\nA=1\nAI_PROVIDER_KEY=x\nB=2\n', KEY_VAR, 'y')).toBe('# c\nA=1\nAI_PROVIDER_KEY=y\nB=2\n');
});
test('set appends when missing, with a newline first if needed', () => {
  expect(setEnvValue('A=1', KEY_VAR, 'k')).toBe('A=1\nAI_PROVIDER_KEY=k\n');
  expect(setEnvValue('', KEY_VAR, 'k')).toBe('AI_PROVIDER_KEY=k\n');
});
test('empty or null removes the line (and duplicates)', () => {
  expect(setEnvValue('A=1\nAI_PROVIDER_KEY=x\nAI_PROVIDER_KEY=z\n', KEY_VAR, '')).toBe('A=1\n');
});
test.each(['sk-ant-api03-AbC_d-9', 'has space', 'a#b', 'q"uote\\back'])('value %s round-trips', v => {
  expect(parseEnv(setEnvValue('', KEY_VAR, v))[KEY_VAR]).toBe(v);
});
test('write is private and atomic; read of a missing file is empty', async () => {
  const f = path.join(tmp, 'sub', '.env'); expect(await readEnvFile(f)).toBe('');
  await writeEnvFile(f, 'A=1\n'); expect(await readEnvFile(f)).toBe('A=1\n');
  expect((await fs.stat(f)).mode & 0o777).toBe(0o600);
});
```

- [ ] **Step 2:** `npx vitest run tests/server/envfile.test.ts` — FAIL (module missing).
- [ ] **Step 3:** Implement `src/server/envfile.ts`.
- [ ] **Step 4:** Run — PASS. Commit `feat: .env file reading and editing`.

### Task 2: Settings store, server and script use `.env`

**Files:** Modify `src/server/settings.ts`, `src/server/app.ts` (settings routes), `src/server/main.ts`, `scripts/acceptance.ts`, `tests/server/settings.test.ts`, `tests/server/app.test.ts`; create `.env.example`; modify `.gitignore`, `README.md`.

**Interfaces — Consumes:** Task 1. **Produces:**

```ts
export type KeySource = 'env-file' | 'environment' | 'none';
export type Settings = { /* existing fields */ apiKey: string; keySource: KeySource; /* … */ };
export const APP_ENV_FILE: string; // repository root .env, resolved from this module's location
export class SettingsStore {
  constructor(file?: string, opts?: { envFile?: string; env?: NodeJS.ProcessEnv });
  // envFile default: APP_ENV_FILE when `file` is omitted, else path.join(path.dirname(file), '.env')
  // env default: process.env when `file` is omitted, else {}
  readonly envFile: string;
  get(): Promise<Settings>;                    // apiKey + keySource from .env / env; JSON apiKey ignored
  update(p: Partial<Settings> | ((c: Settings) => Partial<Settings>)): Promise<Settings>; // apiKey → .env, never JSON; keySource ignored
  migrate(): Promise<'moved' | 'removed' | 'none'>; // design's migration rule
}
```

Decisions: `DEFAULT_SETTINGS` gains `keySource: 'none'`. The JSON file never contains `apiKey` or `keySource` after any write. `update` with `apiKey` present writes `.env` (via `setEnvValue`, empty removes) inside the same serialised chain. `app.ts`: `publicSettings` keeps masking; the PUT treats the masked value as unchanged (existing) and strips `keySource` from the patch (add `keySource` to the zod patch as optional and ignored). `main.ts` calls `await settings.migrate()` before `listen` and logs one line when it returns `moved` ("Moved the AI key from settings.json to <envFile>"). `pipeline.ts` `requireApiKey` message becomes "No AI key is set. Add it in Settings (saved as AI_PROVIDER_KEY in .env)." `scripts/acceptance.ts`: key from `new SettingsStore().get()` only (drop `ANTHROPIC_API_KEY`); the missing-key message names `AI_PROVIDER_KEY` and `.env`. `.gitignore` adds `.env` (not `.env.example`). `.env.example` holds `# Key for the AI provider (Claude). The app's Settings page writes this file.\nAI_PROVIDER_KEY=\n`. README: setup step "enter the AI key in Settings, or copy `.env.example` to `.env` and fill it in"; settings section says the key lives in `.env` and everything else in `~/.vea/settings.json`; precedence line.

- [ ] **Step 1: Failing tests** (`tests/server/settings.test.ts`; every store built with a temp settings file and, where relevant, explicit `{ envFile, env }`):
  - update the existing "defaults" test to include `keySource: 'none'`.
  - replace the existing round-trip test: `update({ apiKey: 'sk-ant-secret-1234', language: 'en' })` → `.env` contains `AI_PROVIDER_KEY=sk-ant-secret-1234`, `settings.json` text does not contain `sk-ant` nor `apiKey`, a new store's `get()` gives `apiKey` `'sk-ant-secret-1234'`, `keySource` `'env-file'`, `language` `'en'`; `.env` mode 0600.
  - `.env` with other lines (`# keep\nOTHER=1\n`) → after an update both survive in order.
  - `update({ apiKey: '' })` removes the line; `keySource` `'none'`.
  - hand edit: write `.env` directly, `get()` returns the new key without a new store.
  - precedence: `.env` key `A` + env `{ AI_PROVIDER_KEY: 'B' }` → `A`/`env-file`; no `.env` key + env `B` → `B`/`environment`.
  - Review Focus 4: env-sourced key, `update({ language: 'en' })` → no `.env` file created.
  - migrate: JSON `{"apiKey":"old"}` and no `.env` → `'moved'`, `.env` has `old`, JSON has no `apiKey`; JSON `{"apiKey":"old"}` and `.env` key `new` (Review Focus 5) → `'removed'`, key stays `new`; nothing to do → `'none'`.
  - `tests/server/app.test.ts`: `GET /api/settings` returns `keySource` and a masked key; `PUT` with the masked value leaves `.env` unchanged; `PUT` with `keySource: 'environment'` is ignored.
- [ ] **Step 2:** `npx vitest run tests/server/settings.test.ts tests/server/app.test.ts` — FAIL.
- [ ] **Step 3:** Implement; update `main.ts`, `pipeline.ts` message, `scripts/acceptance.ts`, `.gitignore`, `.env.example`, README.
- [ ] **Step 4:** `npx vitest run tests/server tests/e2e` and `npx tsc --noEmit` — PASS. Check `git status` shows no `.env` at the repo root. Commit `feat: store the AI key in .env as AI_PROVIDER_KEY`.

### Task 3: Settings page shows where the key lives

**Files:** Modify `src/web/pages/Settings.tsx`, `src/web/api.ts` (type gains `keySource`), `src/web/i18n/vi.ts`, `src/web/i18n/en.ts`; create `tests/web/Settings.test.tsx`.

Decisions: the key field's label becomes `settings.apiKey` = vi "Khóa AI (Claude)" / en "AI key (Claude)"; under it a hint `settings.keyHint` = vi "Lưu trong tệp .env của ứng dụng (AI_PROVIDER_KEY)." / en "Saved in the app's .env file (AI_PROVIDER_KEY)."; then the source line: `settings.keySource.env-file` vi "Đang dùng khóa trong .env." / en "Using the key from .env."; `settings.keySource.environment` vi "Đang dùng khóa từ biến môi trường của hệ thống. Khóa nhập ở đây sẽ được ưu tiên." / en "Using the key from the system environment. A key entered here takes priority."; `settings.keySource.none` vi "Chưa có khóa." / en "No key set." `noKeyNotice` becomes vi "Chưa có khóa AI, nên chưa thể kiểm tra tham chiếu." / en "No AI key yet, so references can't be checked." The form never sends `keySource`.

- [ ] **Step 1: Failing tests** (jsdom, `api` mocked): the source line renders the right text for each of the three `keySource` values; the hint names `AI_PROVIDER_KEY`; saving sends no `keySource` field; `vi`/`en` key sets still equal (existing i18n test).
- [ ] **Step 2:** `npx vitest run tests/web` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run` (full), `npx tsc --noEmit`, `npm run build:web` — PASS. Commit `feat(web): show where the AI key is stored`.
