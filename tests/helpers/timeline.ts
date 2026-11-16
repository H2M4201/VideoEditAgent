import type { Timeline } from '../../src/core/timeline';

/** n contiguous segments s1..sn from raw/a.mp4, one caption c<i> per segment, one music track m1. */
export function makeTimeline(n: number, framesEach = 90): Timeline {
  const sec = framesEach / 30;
  return {
    version: 1,
    fps: 30,
    width: 1080,
    height: 1920,
    durationFrames: n * framesEach,
    segments: Array.from({ length: n }, (_, k) => ({
      id: `s${k + 1}`,
      source: 'raw/a.mp4',
      sourceIn: 0,
      sourceOut: sec,
      startFrame: k * framesEach,
      durationFrames: framesEach,
      speed: 1,
      crop: 'cover' as const,
      transitionIn: { type: 'cut' as const, frames: 0 },
      effects: [],
      clipGain: 1,
      approved: false,
    })),
    captions: Array.from({ length: n }, (_, k) => ({
      id: `c${k + 1}`,
      text: `caption ${k + 1}`,
      startFrame: k * framesEach,
      endFrame: (k + 1) * framesEach,
      words: [],
      animation: 'line' as const,
      approved: false,
    })),
    audio: [{ id: 'm1', kind: 'music', source: 'raw/music.mp3', startFrame: 0, sourceIn: 0, gain: 0.3 }],
    overlays: [],
    style: {
      fontFamily: 'Be Vietnam Pro',
      primaryColor: '#ffffff',
      secondaryColor: '#ffd400',
      captionPosition: 'bottom',
      captionSize: 64,
    },
  };
}
