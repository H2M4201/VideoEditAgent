import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

const root = path.join(__dirname, '..', '..');
const scripts = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;

test('"dev" and "start" run the server entry point, which exists', () => {
  for (const name of ['dev', 'start']) {
    expect(scripts[name], name).toBe('tsx src/server/main.ts');
    expect(existsSync(path.join(root, scripts[name].split(' ')[1])), name).toBe(true);
  }
});
