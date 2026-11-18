# AI key in `.env` — design (small change)

Date: 2026-11-18 · Status: approved by the user · Builds on: `2026-11-16-video-edit-agent-design.md`

## Intent

The agency configures the AI key themselves in the app's Settings page, and the value is written to a `.env` file instead of the general settings file. The variable has a provider-neutral name.

## Goals / non-goals / anti-goals

- Goals: the key is entered and changed in the UI; it is stored in `.env` as `AI_PROVIDER_KEY`; hand edits to `.env` work too.
- Non-goals: choosing an AI provider (Claude only, decided by the user); keys for editing tools (none of them use one today); moving non-secret settings out of `settings.json`.
- Anti-goals: the full key ever reaching the browser; saving from the UI wiping other lines in `.env`; a key left behind in `settings.json` after the move.

## Approaches considered

1. Keep the key in `~/.vea/settings.json` — rejected: not what was asked.
2. Provider dropdown + generic key, or an OpenAI-compatible endpoint — rejected by the user: Claude only.
3. **Chosen:** `.env` holds only the key; everything else stays in `settings.json`.

## Decided design

- **File:** `.env` in the app's folder (the repository root, next to `package.json`). Git-ignored. Written with mode 0600.
- **Variable:** `AI_PROVIDER_KEY` (decided by the user).
- **Writing (Settings page):** saving updates or adds the `AI_PROVIDER_KEY=` line and keeps every other line, comment and order as it was. An empty value removes the line. Writes are atomic (temp file + rename) and serialised with other settings writes. The page shows only the last 4 characters and the source of the current key; sending the masked value back means "unchanged" (existing behaviour).
- **Reading:** the server reads `.env` each time it needs the key (each job and each settings read), so hand edits apply without a restart. *(Assistant's call.)*
- **Precedence:** a key in `.env` wins; if `.env` has none, `AI_PROVIDER_KEY` from the process environment is used; otherwise there is no key. The settings API reports `keySource: 'env-file' | 'environment' | 'none'`, shown on the Settings page. *(Assistant's call.)*
- **Migration:** at startup, if `settings.json` contains a non-empty `apiKey` and `.env` has no `AI_PROVIDER_KEY`, the key is written to `.env`; in all cases `apiKey` is then removed from `settings.json`. *(Assistant's call.)*
- **Format:** `KEY=value` lines; values may be quoted with `"` or `'`; `#` comments and blank lines preserved. Values written by the app are quoted only if they contain whitespace, `#` or quotes.
- **Also updated:** `scripts/acceptance.ts` reads the key the same way; README setup steps and the "settings" section describe `.env`; a `.env.example` with an empty `AI_PROVIDER_KEY=` line is committed.

## Left to the builder

- Module layout (e.g. `src/server/envfile.ts`) and how the settings route merges key and settings.
- Whether `.env` location can be overridden for tests (it must be, for test isolation).
