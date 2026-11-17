import type { CSSProperties } from 'react';
import { AbsoluteFill, Img, Sequence } from 'remotion';
import type { Overlay, Style } from '../../../core/timeline';
import { fontStack, legibleText, mediaUrl } from './media';

const WIDTH = 1080;
const MARGIN = 0.05 * WIDTH;
const LOGO_WIDTH = 0.12 * WIDTH;

function placement(position: Overlay['position']): CSSProperties {
  switch (position) {
    case 'top-left': return { position: 'absolute', top: MARGIN, left: MARGIN, textAlign: 'left' };
    case 'top-right': return { position: 'absolute', top: MARGIN, right: MARGIN, textAlign: 'right' };
    case 'bottom-left': return { position: 'absolute', bottom: MARGIN, left: MARGIN, textAlign: 'left' };
    case 'bottom-right': return { position: 'absolute', bottom: MARGIN, right: MARGIN, textAlign: 'right' };
    default: return { position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center' };
  }
}

function OverlayView({ overlay, style, mediaBase }: { overlay: Overlay; style: Style; mediaBase: string }) {
  if (overlay.kind === 'logo') {
    if (!overlay.source) return null;
    return <Img src={mediaUrl(mediaBase, overlay.source)} style={{ ...placement(overlay.position), width: LOGO_WIDTH, height: 'auto' }} />;
  }
  if (!overlay.text) return null;
  const size = Math.round(style.captionSize * 1.2);
  return (
    <div style={{ ...placement(overlay.position), maxWidth: WIDTH - 2 * MARGIN, fontFamily: fontStack(style.fontFamily),
      fontWeight: 700, fontSize: size, lineHeight: 1.2, color: style.primaryColor, ...legibleText(size) }}>
      {overlay.text}
    </div>
  );
}

/** Logos (about 12% of frame width, in a corner) and title text, each shown from startFrame to endFrame. */
export function Overlays({ overlays, style, mediaBase }: { overlays: Overlay[]; style: Style; mediaBase: string }) {
  return (
    <AbsoluteFill>
      {overlays.filter((o) => o.endFrame > o.startFrame).map((o) => (
        <Sequence key={o.id} from={o.startFrame} durationInFrames={o.endFrame - o.startFrame} layout="none">
          <OverlayView overlay={o} style={style} mediaBase={mediaBase} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
