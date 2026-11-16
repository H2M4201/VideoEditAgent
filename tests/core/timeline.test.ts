import { expect, test } from 'vitest';
import { validateTimeline } from '../../src/core/timeline';
import { makeTimeline } from '../helpers/timeline';

const src = { 'raw/a.mp4': { durationSec: 60 } };

test('valid timeline passes', () => expect(validateTimeline(makeTimeline(3), src).ok).toBe(true));
test('gap between segments is rejected', () => { const t = makeTimeline(3); t.segments[1].startFrame += 5;
  expect(validateTimeline(t, src)).toMatchObject({ ok: false, errors: [expect.stringContaining('s2')] }); });
test('source past end of file is rejected', () => { const t = makeTimeline(1); t.segments[0].sourceOut = 61;
  expect(validateTimeline(t, src).ok).toBe(false); });
test('duration/speed mismatch is rejected', () => { const t = makeTimeline(1); t.segments[0].speed = 2;
  expect(validateTimeline(t, src).ok).toBe(false); });
test('duplicate ids are rejected', () => { const t = makeTimeline(2); t.captions[1].id = 'c1';
  expect(validateTimeline(t, src).ok).toBe(false); });
test('unknown source is rejected', () => expect(validateTimeline(makeTimeline(1), {}).ok).toBe(false));
