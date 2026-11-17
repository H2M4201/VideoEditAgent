import { JobError } from '../components/JobProgress';
import { t } from '../i18n';
import { useJobs } from '../useJobs';

export function Queue() {
  const { jobs } = useJobs();
  return (
    <div className="page">
      <h2>{t('queue.title')}</h2>
      {jobs.length === 0 ? <p className="muted">{t('queue.none')}</p> : (
        <ul className="items">
          {[...jobs].reverse().map(j => (
            <li key={j.id}>
              <strong>{t(`job.${j.kind}`)}</strong>
              <progress value={j.progress} max={1} aria-label={t(`job.${j.kind}`)} />
              <span className="grow muted">{t(`status.${j.status}`)} · {j.message}</span>
              <JobError job={j} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
