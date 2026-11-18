import { promises as fs } from 'node:fs';
import path from 'node:path';

/** The one variable the app writes: the key for the AI provider (Claude). */
export const KEY_VAR = 'AI_PROVIDER_KEY';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
const BARE = /^[A-Za-z0-9_\-.:/+=@]*$/;

function parseValue(raw: string): string {
  if (raw.startsWith('"')) {
    // Up to the first unescaped quote; \" and \\ are unescaped.
    let out = '';
    for (let i = 1; i < raw.length; i++) {
      const c = raw[i];
      if (c === '\\' && i + 1 < raw.length) { out += raw[++i]; continue; }
      if (c === '"') return out;
      out += c;
    }
    return out;
  }
  if (raw.startsWith("'")) {
    const close = raw.indexOf("'", 1);
    return close === -1 ? raw.slice(1) : raw.slice(1, close);
  }
  const hash = raw.search(/\s#/);
  return (hash === -1 ? raw : raw.slice(0, hash)).trim();
}

/** `NAME=value` lines; `export `, spaces around `=`, quotes and trailing ` # comments` are handled. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = LINE.exec(line);
    if (m) out[m[1]] = parseValue(m[2]);
  }
  return out;
}

function formatValue(v: string): string {
  return BARE.test(v) ? v : `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Sets `name` in place (or appends it), keeping every other line, comment and line ending. Empty/null removes it. */
export function setEnvValue(text: string, name: string, value: string | null): string {
  if (value && /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${name} cannot contain line breaks or control characters`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  const trailing = lines.length > 0 && lines[lines.length - 1] === '';
  if (trailing) lines.pop();
  const isName = (l: string) => !/^\s*#/.test(l) && LINE.exec(l)?.[1] === name;
  const out: string[] = [];
  let placed = false;
  for (const l of lines) {
    if (!isName(l)) { out.push(l); continue; }
    if (!placed && value) out.push(`${name}=${formatValue(value)}`);
    placed = true;
  }
  if (!placed && value) out.push(`${name}=${formatValue(value)}`);
  if (out.length === 0) return '';
  return out.join(eol) + (trailing || !placed ? eol : '');
}

export async function readEnvFile(file: string): Promise<string> {
  try { return await fs.readFile(file, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw e; }
}

/** Atomic (temp file + rename) and readable only by the owner. */
export async function writeEnvFile(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, text, { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }); // the temp file holds the key: never leave it behind
    throw e;
  }
}
