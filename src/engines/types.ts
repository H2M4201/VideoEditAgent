import type { EngineCapabilities } from '../agent/prompt';
import type { Timeline } from '../core/timeline';

export type { EngineCapabilities };

export type RenderResult = { kind: 'mp4'; path: string } | { kind: 'capcutDraft'; path: string };

export type RenderOptions = {
  projectDir: string;
  timeline: Timeline;
  outDir: string;
  /** output file name without extension */
  name: string;
  /** called with progress 0..1 */
  onProgress?: (p: number) => void;
};

export interface Engine {
  id: 'builtin' | 'capcut';
  capabilities(): EngineCapabilities;
  availability(): Promise<{ available: boolean; reason?: string }>;
  render(o: RenderOptions): Promise<RenderResult>;
}
