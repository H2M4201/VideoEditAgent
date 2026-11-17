import { promises as fs } from 'node:fs';
import path from 'node:path';

const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

/**
 * The absolute on-disk path of a project-relative POSIX path. Paths in scans and timelines are NFC-normalised, but a file
 * may be stored with a decomposed (NFD) name, which a normalisation-sensitive file system will not find under its NFC
 * spelling. So: the path as given if it exists; otherwise each segment is matched against the directory's entries by NFC
 * equality. A path that still cannot be found is returned as given (the caller's own I/O then reports it missing).
 */
export async function resolveOnDisk(projectDir: string, relPosix: string): Promise<string> {
  const parts = relPosix.split('/').filter(Boolean);
  const direct = path.join(projectDir, ...parts);
  if (await exists(direct)) return direct;
  let current = projectDir;
  for (const part of parts) {
    const exact = path.join(current, part);
    if (await exists(exact)) { current = exact; continue; }
    const want = part.normalize('NFC');
    const match = (await fs.readdir(current).catch(() => [] as string[])).find(name => name.normalize('NFC') === want);
    if (match === undefined) return direct;
    current = path.join(current, match);
  }
  return current;
}
