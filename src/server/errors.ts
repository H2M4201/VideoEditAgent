import type { z } from 'zod';
import { AgentError } from '../agent/model';
import { ProjectError } from '../project/scan';
import type { JobError } from './jobs';

/** An error with a code the UI understands; `status` is the HTTP status when it is thrown by a route. */
export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); this.name = 'AppError'; }
}

export const FFMPEG_MISSING_MESSAGE = 'ffmpeg/ffprobe was not found. Install ffmpeg (it includes ffprobe) and make sure it is on PATH.';

/** True for an execa failure to start ffmpeg or ffprobe because the program does not exist. */
function isFfmpegMissing(e: unknown): boolean {
  const x = e as { code?: unknown; command?: unknown } | null;
  return x?.code === 'ENOENT' && typeof x.command === 'string' && /^ff(mpeg|probe)\b/.test(x.command);
}

/** Maps anything a job throws to `{ code, message }`; unknown errors are 'INTERNAL'. */
export function toJobError(e: unknown): JobError {
  if (e instanceof AppError || e instanceof AgentError || e instanceof ProjectError) return { code: e.code, message: e.message };
  if (isFfmpegMissing(e)) return { code: 'FFMPEG_MISSING', message: FFMPEG_MISSING_MESSAGE };
  return { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) };
}

/** Parses a request body with a zod schema; a mismatch is a 400 BAD_REQUEST. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new AppError('BAD_REQUEST', r.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}
