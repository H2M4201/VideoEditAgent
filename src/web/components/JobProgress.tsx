import { errorText, t } from '../i18n';
import type { Job } from '../api';
import { useJobs } from '../useJobs';

/** Progress bar and message of one job (by id), taken from the event stream. */
export function JobProgress({ jobId }: { jobId: string | null }) {
  const { jobs } = useJobs();
  const job = jobs.find(j => j.id === jobId);
  if (!job) return jobId ? <p role="status" className="muted">{t('loading')}</p> : null;
  return (
    <div className="job" role="status">
      <progress value={job.progress} max={1} aria-label={t(`job.${job.kind}`)} />
      <span className="muted">{t(`status.${job.status}`)} · {job.message}</span>
    </div>
  );
}

export function JobError({ job }: { job: Pick<Job, 'error'> }) {
  return job.error ? <p role="alert" className="error">{errorText(job.error)}</p> : null;
}
