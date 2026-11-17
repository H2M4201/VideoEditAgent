import { expect, test } from 'vitest';
import { formatTime, parseTimecodes } from '../../src/core/timecode';

test.each([['đổi cảnh giây thứ 10', [10]], ['fix text at 0:15', [15]], ['1:05 and 20s', [65, 20]]])('parse %s', (s, e) => expect(parseTimecodes(s)).toEqual(e));

test.each([
  ['swap the shot at second 10', [10]],
  ['giây 10 bị mờ', [10]],
  ['Giây thứ 7 và giây 12', [7, 12]],
  ['cut at 10:30', [630]],
  ['the shot at 0:10.5', [10.5]],
  ['at 3.5s please', [3.5]],
  ['at 4 seconds and 6 giây', [4, 6]],
  ['0:10, then 10s again, then second 10', [10]],
  ['20s then 0:05', [20, 5]],
])('parse %s', (s, e) => expect(parseTimecodes(s)).toEqual(e));

test.each(['make it 10 percent brighter', 'shot 3 is too dark', 'use 2 captions', 'scene 10', '', 'the 3 shots'])('no time in %j', s =>
  expect(parseTimecodes(s)).toEqual([]));

test('formatTime writes m:ss', () => expect([0, 7, 15.9, 65, 600].map(formatTime)).toEqual(['0:00', '0:07', '0:15', '1:05', '10:00']));
