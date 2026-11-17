import type { CSSProperties } from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame } from 'remotion';
import type { Caption, Style } from '../../../core/timeline';
import { fontStack, legibleText } from './media';

const WIDTH = 1080;
const HEIGHT = 1920;
const SIDE_MARGIN = 0.1 * WIDTH;
const BOTTOM_MARGIN = 0.18 * HEIGHT;
const TOP_MARGIN = 0.1 * HEIGHT;
const BOX_WIDTH = WIDTH - 2 * SIDE_MARGIN;
const MAX_LINES = 3;
const MIN_SCALE = 0.6;
/** Average advance width of a bold glyph, in em. Conservative so wrapped text stays inside the safe area. */
const AVG_GLYPH_EM = 0.6;
const LINE_HEIGHT = 1.2;

/**
 * Font size so that the wrapped text fits in MAX_LINES inside the safe area, shrinking to no less than
 * 60% of captionSize. Estimated from glyph count (no DOM measurement, so it is deterministic per frame).
 */
export function fitCaptionSize(text: string, captionSize: number): number {
  const fits = (size: number) => {
    const perLine = Math.max(1, Math.floor(BOX_WIDTH / (size * AVG_GLYPH_EM)));
    let lines = 1; let used = 0;
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const len = [...word].length;
      const need = used === 0 ? len : used + 1 + len;
      if (need <= perLine) { used = need; continue; }
      // start a new line unless this is the first word; a word longer than a line breaks across lines
      lines += (used === 0 ? 0 : 1) + Math.floor((len - 1) / perLine);
      used = ((len - 1) % perLine) + 1;
    }
    return lines <= MAX_LINES;
  };
  for (let size = captionSize; size > captionSize * MIN_SCALE; size -= 1) if (fits(size)) return size;
  return Math.ceil(captionSize * MIN_SCALE);
}

function boxPosition(position: Style['captionPosition']): CSSProperties {
  const base: CSSProperties = { position: 'absolute', left: SIDE_MARGIN, width: BOX_WIDTH, textAlign: 'center' };
  if (position === 'top') return { ...base, top: TOP_MARGIN };
  if (position === 'middle') return { ...base, top: '50%', transform: 'translateY(-50%)' };
  return { ...base, bottom: BOTTOM_MARGIN };
}

function CaptionView({ caption, style }: { caption: Caption; style: Style }) {
  const absFrame = caption.startFrame + useCurrentFrame();
  const size = fitCaptionSize(caption.text, style.captionSize);
  const text: CSSProperties = {
    fontFamily: fontStack(style.fontFamily), fontWeight: 700, fontSize: size, lineHeight: LINE_HEIGHT,
    color: style.primaryColor, overflowWrap: 'anywhere', ...legibleText(size),
  };
  const byWord = caption.animation === 'word' && caption.words.length > 0;
  return (
    <div style={{ ...boxPosition(style.captionPosition), ...text }}>
      {byWord
        ? caption.words.map((w, i) => {
          const active = absFrame >= w.startFrame && absFrame < w.endFrame;
          return (
            <span key={i}>
              {i > 0 ? ' ' : ''}
              <span style={{ display: 'inline-block', color: active ? style.secondaryColor : style.primaryColor,
                transform: active ? 'scale(1.1)' : undefined }}>{w.text}</span>
            </span>
          );
        })
        : caption.text}
    </div>
  );
}

/** Captions inside the safe area (10% side margins, 18% bottom). 'word' highlights the word being spoken. */
export function Captions({ captions, style }: { captions: Caption[]; style: Style }) {
  return (
    <AbsoluteFill>
      {captions.filter((c) => c.endFrame > c.startFrame).map((c) => (
        <Sequence key={c.id} from={c.startFrame} durationInFrames={c.endFrame - c.startFrame} layout="none">
          <CaptionView caption={c} style={style} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
