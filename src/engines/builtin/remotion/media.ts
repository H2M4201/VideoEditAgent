import type { Timeline } from '../../../core/timeline';

export type VideoProps = { timeline: Timeline; /** media server base URL, no trailing slash */ mediaBase: string };

export const DEFAULT_FONT = 'Be Vietnam Pro';

/** URL of a project-relative POSIX path on the media server; each path part is encoded. */
export function mediaUrl(base: string, relPath: string): string {
  return `${base}/${relPath.split('/').map(encodeURIComponent).join('/')}`;
}

/** CSS font-family for the timeline's family, always falling back to Be Vietnam Pro then sans-serif. */
export function fontStack(family: string): string {
  const quoted = `"${family.replace(/["\\]/g, '')}"`;
  return family === DEFAULT_FONT ? `${quoted}, sans-serif` : `${quoted}, "${DEFAULT_FONT}", sans-serif`;
}

/** Text outline + shadow that keeps light text legible on any footage. */
export function legibleText(sizePx: number): Record<string, string> {
  const s = Math.max(2, Math.round(sizePx * 0.1));
  return {
    WebkitTextStroke: `${s}px rgba(0,0,0,0.85)`,
    paintOrder: 'stroke fill',
    textShadow: `0 ${Math.round(s / 2)}px ${s * 2}px rgba(0,0,0,0.6)`,
  };
}
