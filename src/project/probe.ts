import { execa } from 'execa';
import { resolveOnDisk } from './paths';

export type MediaInfo = { path: string /*relative*/; kind: 'video' | 'audio'; durationSec: number;
  width?: number; height?: number /*after rotation*/; fps?: number; hasAudio: boolean };

type Stream = { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string;
  duration?: string; tags?: { rotate?: string }; side_data_list?: { rotation?: number | string }[]; disposition?: { attached_pic?: number } };

function parseRate(r?: string): number | undefined {
  if (!r) return undefined;
  const [n, d] = r.split('/').map(Number);
  if (!n || !d) return undefined;
  return Math.round((n / d) * 1000) / 1000;
}

function rotationOf(s: Stream): number {
  const side = s.side_data_list?.find(x => x.rotation !== undefined)?.rotation;
  return Number(side ?? s.tags?.rotate ?? 0) || 0;
}

/** Probes a media file (path relative to the project folder, POSIX separators). Throws if ffprobe cannot read it. */
export async function probeMedia(projectDir: string, relPath: string): Promise<MediaInfo> {
  const { stdout } = await execa('ffprobe', ['-v', 'error', '-of', 'json', '-show_streams', '-show_format',
    await resolveOnDisk(projectDir, relPath)]);
  const data = JSON.parse(stdout) as { streams?: Stream[]; format?: { duration?: string } };
  const streams = data.streams ?? [];
  const video = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const hasAudio = streams.some(s => s.codec_type === 'audio');
  if (!video && !hasAudio) throw new Error(`no audio or video stream in ${relPath}`);
  const durationSec = Number(data.format?.duration ?? (video ?? streams.find(s => s.codec_type === 'audio'))?.duration);
  if (!Number.isFinite(durationSec)) throw new Error(`unknown duration for ${relPath}`);
  if (!video) return { path: relPath, kind: 'audio', durationSec, hasAudio: true };
  let width = video.width!; let height = video.height!;
  if (Math.abs(rotationOf(video)) % 180 === 90) [width, height] = [height, width];
  return { path: relPath, kind: 'video', durationSec, width, height, fps: parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate), hasAudio };
}
