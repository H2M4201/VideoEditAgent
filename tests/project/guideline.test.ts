import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadGuideline, createFromStarter, STARTERS } from '../../src/project/guideline';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vea-guide-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('loadGuideline', () => {
  it('returns null when missing, empty or whitespace-only', async () => {
    expect(await loadGuideline(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, 'guideline.md'), '  \n\t\n');
    expect(await loadGuideline(dir)).toBeNull();
  });
  it('returns the UTF-8 text', async () => {
    fs.writeFileSync(path.join(dir, 'guideline.md'), '## Phong cách\nNhịp nhanh');
    expect(await loadGuideline(dir)).toBe('## Phong cách\nNhịp nhanh');
  });
});

describe('createFromStarter', () => {
  const headings = { vi: ['## Phong cách thương hiệu', '## Cách dùng tài liệu tham khảo'], en: ['## Brand style', '## Reference usage'] } as const;
  for (const starter of STARTERS) for (const lang of ['vi', 'en'] as const) {
    it(`writes ${starter}.${lang}`, async () => {
      await createFromStarter(dir, starter, lang);
      const text = fs.readFileSync(path.join(dir, 'guideline.md'), 'utf8');
      for (const h of headings[lang]) expect(text).toContain(h);
      expect(text).toContain('Be Vietnam Pro');
      expect(text).toMatch(/logo[^\n]*`reference\/`[^\n]*`reference\/logo\.png`/i);
      expect(text.split('\n').length).toBeGreaterThanOrEqual(25);
    });
  }
  it('refuses to overwrite an existing guideline', async () => {
    fs.writeFileSync(path.join(dir, 'guideline.md'), 'mine');
    await expect(createFromStarter(dir, 'vlog', 'en')).rejects.toThrow('guideline exists');
    expect(fs.readFileSync(path.join(dir, 'guideline.md'), 'utf8')).toBe('mine');
  });
});
