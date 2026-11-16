import { execa } from 'execa';
import MusicTempo from 'music-tempo';

export const SILENT_DB = -50;

/** Mean volume in dB from `volumedetect`; -Infinity when fully silent or unreadable. */
export async function meanVolumeDb(absPath: string): Promise<number> {
  const { stderr } = await execa('ffmpeg', ['-v', 'info', '-i', absPath, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const m = /mean_volume:\s*(-?[0-9.]+|-inf)\s*dB/.exec(stderr);
  if (!m || m[1] === '-inf') return -Infinity;
  return Number(m[1]);
}

/** Beat times (seconds) from mono 44.1 kHz PCM; [] if the signal cannot be analysed. */
export async function detectBeats(absPath: string): Promise<number[]> {
  try {
    const { stdout } = await execa('ffmpeg', ['-v', 'error', '-i', absPath, '-vn', '-ac', '1', '-ar', '44100', '-f', 'f32le', '-'],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 });
    const buf = Buffer.from(stdout);
    const samples = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length - (buf.length % 4)));
    return new MusicTempo(samples).beats.map(Number);
  } catch { return []; }
}
