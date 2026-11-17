import type { CSSProperties } from 'react';
import { AbsoluteFill, Freeze, interpolate, OffthreadVideo, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Crop, Segment } from '../../../core/timeline';
import { mediaUrl } from './media';

const PUSH_SCALE = 1.08;

function effectScale(seg: Segment, frame: number): number {
  const last = Math.max(1, seg.durationFrames - 1);
  let s = 1;
  for (const e of seg.effects) {
    if (e.type === 'pushIn') s *= interpolate(frame, [0, last], [1, PUSH_SCALE], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    if (e.type === 'pushOut') s *= interpolate(frame, [0, last], [PUSH_SCALE, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  }
  return s;
}

function cropStyle(crop: Crop): CSSProperties {
  const base: CSSProperties = { width: '100%', height: '100%' };
  if (crop === 'cover') return { ...base, objectFit: 'cover' };
  if (crop === 'contain') return { ...base, objectFit: 'contain' };
  return { ...base, objectFit: 'cover', transform: `translate(${crop.x * 100}%, ${crop.y * 100}%) scale(${crop.scale})` };
}

/** One segment's footage, cropped and with its effects, at the current frame of its Sequence. */
export function SegmentView({ segment, mediaBase, muted }: { segment: Segment; mediaBase: string; muted?: boolean }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ backgroundColor: 'black', overflow: 'hidden' }}>
      <AbsoluteFill style={{ transform: `scale(${effectScale(segment, frame)})` }}>
        <OffthreadVideo
          src={mediaUrl(mediaBase, segment.source)}
          trimBefore={Math.round(segment.sourceIn * fps)}
          playbackRate={segment.speed}
          volume={segment.clipGain}
          muted={muted}
          style={cropStyle(segment.crop)}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

function transitionStyle(type: Segment['transitionIn']['type'], progress: number): CSSProperties {
  switch (type) {
    case 'fade': return { opacity: progress };
    case 'slide': return { transform: `translateX(${(1 - progress) * 100}%)` };
    case 'zoom': return { opacity: progress, transform: `scale(${interpolate(progress, [0, 1], [1.25, 1])})` };
    default: return {};
  }
}

/**
 * The incoming segment. During its first `transitionIn.frames` frames it is drawn over the previous segment's
 * held last frame, so segment boundaries never move.
 */
export function IncomingSegment({ segment, previous, mediaBase }: { segment: Segment; previous?: Segment; mediaBase: string }) {
  const frame = useCurrentFrame();
  const { type, frames } = segment.transitionIn;
  const inTransition = previous !== undefined && type !== 'cut' && frames > 0 && frame < frames;
  if (!inTransition) return <SegmentView segment={segment} mediaBase={mediaBase} />;
  const progress = interpolate(frame, [0, frames], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill>
      <Freeze frame={previous.durationFrames - 1}>
        <SegmentView segment={previous} mediaBase={mediaBase} muted />
      </Freeze>
      <AbsoluteFill style={transitionStyle(type, progress)}>
        <SegmentView segment={segment} mediaBase={mediaBase} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
