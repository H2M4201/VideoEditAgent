import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TimelineSchema, type Timeline } from './timeline';

type Meta = { note: string; createdAt: string };

/** Stores v<n>.timeline.json plus v<n>.meta.json (note, createdAt) in videoDir. */
export class VersionStore {
  constructor(private readonly videoDir: string) {}

  private file(n: number, kind: 'timeline' | 'meta'): string {
    return path.join(this.videoDir, `v${n}.${kind}.json`);
  }

  private async numbers(): Promise<number[]> {
    let names: string[];
    try { names = await fs.readdir(this.videoDir); } catch { return []; }
    return names
      .map((f) => /^v(\d+)\.timeline\.json$/.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  }

  async save(t: Timeline, note: string): Promise<number> {
    await fs.mkdir(this.videoDir, { recursive: true });
    const n = ((await this.numbers()).at(-1) ?? 0) + 1;
    const meta: Meta = { note, createdAt: new Date().toISOString() };
    await fs.writeFile(this.file(n, 'meta'), JSON.stringify(meta, null, 2));
    await fs.writeFile(this.file(n, 'timeline'), JSON.stringify(t, null, 2));
    return n;
  }

  async load(n: number): Promise<Timeline> {
    return TimelineSchema.parse(JSON.parse(await fs.readFile(this.file(n, 'timeline'), 'utf8')));
  }

  async latest(): Promise<{ n: number; timeline: Timeline } | null> {
    const n = (await this.numbers()).at(-1);
    return n === undefined ? null : { n, timeline: await this.load(n) };
  }

  async list(): Promise<{ n: number; note: string; createdAt: string }[]> {
    return Promise.all((await this.numbers()).map(async (n) => {
      const meta = JSON.parse(await fs.readFile(this.file(n, 'meta'), 'utf8')) as Meta;
      return { n, note: meta.note, createdAt: meta.createdAt };
    }));
  }
}
