import { AbsoluteFill, Audio, Sequence, useVideoConfig } from 'remotion';
import { Captions } from './Captions';
import { loadFonts } from './fonts';
import { mediaUrl, type VideoProps } from './media';
import { Overlays } from './Overlays';
import { IncomingSegment } from './SegmentView';

loadFonts();

/** The whole timeline: segments, then captions and overlays on top; narration and music tracks. */
export function Video({ timeline, mediaBase }: VideoProps) {
  const { fps } = useVideoConfig(); // = timeline.fps (set by calculateMetadata)
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {timeline.segments.map((s, i) => (
        <Sequence key={s.id} from={s.startFrame} durationInFrames={s.durationFrames}>
          <IncomingSegment segment={s} previous={i > 0 ? timeline.segments[i - 1] : undefined} mediaBase={mediaBase} />
        </Sequence>
      ))}
      {timeline.audio.map((a) => (
        <Sequence key={a.id} from={a.startFrame} layout="none">
          <Audio src={mediaUrl(mediaBase, a.source)} trimBefore={Math.round(a.sourceIn * fps)} volume={a.gain} />
        </Sequence>
      ))}
      <Captions captions={timeline.captions} style={timeline.style} />
      <Overlays overlays={timeline.overlays} style={timeline.style} mediaBase={mediaBase} />
    </AbsoluteFill>
  );
}
