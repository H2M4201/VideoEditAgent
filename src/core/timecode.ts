const NUM = String.raw`(\d+(?:\.\d+)?)`;
const UNIT = String.raw`(?:s|secs?|seconds?|giây)`;
/**
 * One alternative per way a time is written; a bare number with no unit is never a time.
 * 1: m:ss / mm:ss (optional decimal seconds), 2: "second 10" / "giây 10" / "giây thứ 10", 3: "10s" / "10 seconds" / "10 giây".
 */
const TIMECODE = new RegExp(
  String.raw`(?<!\d)(\d{1,2}):([0-5]\d(?:\.\d+)?)(?!\d)` +
  String.raw`|(?<![\p{L}\d])(?:seconds?|giây)\s+(?:thứ\s+)?${NUM}(?![\p{L}\d:])` +
  String.raw`|(?<![\p{L}\d.])${NUM}\s*${UNIT}(?![\p{L}\d])`,
  'giu',
);

/** Times (seconds) mentioned in feedback text, in order of appearance, without duplicates. */
export function parseTimecodes(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(TIMECODE)) {
    const sec = m[1] !== undefined ? Number(m[1]) * 60 + Number(m[2]) : Number(m[3] ?? m[4]);
    if (!out.includes(sec)) out.push(sec);
  }
  return out;
}

/** Seconds as m:ss (whole seconds, rounded down). */
export function formatTime(sec: number): string {
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
