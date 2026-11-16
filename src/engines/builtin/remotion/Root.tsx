import { Composition } from 'remotion';
import type { VideoProps } from './media';
import { Video } from './Video';

const PLACEHOLDER: VideoProps = {
  mediaBase: '',
  timeline: {
    version: 1, fps: 30, width: 1080, height: 1920, durationFrames: 1, segments: [], captions: [], audio: [], overlays: [],
    style: { fontFamily: 'Be Vietnam Pro', primaryColor: '#ffffff', secondaryColor: '#ffd400', captionPosition: 'bottom', captionSize: 64 },
  },
};

/** Composition `Video`; duration, fps and size come from the timeline in the input props. */
export function Root() {
  return (
    <Composition
      id="Video"
      component={Video}
      defaultProps={PLACEHOLDER}
      durationInFrames={1}
      fps={30}
      width={1080}
      height={1920}
      calculateMetadata={({ props }) => ({
        durationInFrames: props.timeline.durationFrames,
        fps: props.timeline.fps,
        width: props.timeline.width,
        height: props.timeline.height,
      })}
    />
  );
}
