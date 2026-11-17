import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type FixJobResult, type RevertJobResult, type Job, type ProjectEntry, type VideoDetail } from '../api';
import { JobError, JobProgress } from '../components/JobProgress';
import { itemTimes, mss, SegmentList } from '../components/SegmentList';
import { VersionList } from '../components/VersionList';
import { errorText, t } from '../i18n';
import { useJobs } from '../useJobs';

type Props = { project: ProjectEntry; videoId: string; onStartOver: () => void };
type Refusal = Extract<FixJobResult, { status: 'refused' }>;
type Applied = { summary: string; changed: string[] };

export function Result({ project, videoId, onStartOver }: Props) {
  const { waitFor } = useJobs();
  const [detail, setDetail] = useState<VideoDetail | null>(null);
  const [feedback, setFeedback] = useState('');
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => { setDetail(await api.video(project.id, videoId)); }, [project.id, videoId]);
  useEffect(() => { void load().catch(e => setFailure(e as ApiError)); }, [load]);

  /** Runs `act` (which may start a job), waits for the job, reloads the video. Returns the job's result. */
  async function work(act: () => Promise<{ job: { id: string } } | unknown>): Promise<Job | null> {
    setBusy(true); setFailure(null); setRefusal(null); setApplied(null); setNotice(null);
    try {
      const r = await act();
      const id = (r as { job?: { id: string } } | null)?.job?.id;
      let job: Job | null = null;
      if (id) { setJobId(id); job = await waitFor(id); }
      if (job?.status === 'failed') setFailure(job.error ?? { code: 'INTERNAL', message: '' });
      await load();
      return job;
    } catch (e) {
      setFailure(e instanceof ApiError ? e : { code: 'INTERNAL', message: (e as Error).message });
      return null;
    } finally { setBusy(false); }
  }

  async function sendFix(unlock: boolean) {
    const job = await work(() => api.fix(project.id, videoId, { feedback, unlock }));
    const result = job?.status === 'done' ? (job.result as FixJobResult) : null;
    if (result?.status === 'refused') setRefusal(result);
    if (result?.status === 'applied') { setApplied({ summary: result.summary, changed: result.changed }); setFeedback(''); }
  }

  async function revertTo(n: number) {
    const before = detail?.latest?.timeline;
    const job = await work(() => api.revert(project.id, videoId, n));
    const result = job?.status === 'done' ? (job.result as RevertJobResult) : null;
    if (result?.status === 'refused' && before) setNotice(t('revertConflict', { items: itemTimes(before, result.ids) }));
  }

  if (!detail) return failure ? <JobError job={{ error: failure }} /> : <p className="muted">{t('loading')}</p>;
  const latest = detail.latest!;
  const notFollowed = detail.notFollowed;
  const latestOutput = detail.versions.find(v => v.n === latest.n)?.output ?? null;
  const src = latestOutput?.url ?? undefined;

  return (
    <div className="page result">
      <div className="row between">
        <h2>{t('result.title')} · {videoId}</h2>
        <button type="button" onClick={onStartOver}>{t('startOver')}</button>
      </div>
      {notFollowed.length > 0 && (
        <div className="notice"><strong>{t('notFollowed')}</strong>
          <ul>{notFollowed.map((n, i) => <li key={i}>{n.instruction} — {t('notFollowedReason')}: {n.reason}</li>)}</ul></div>
      )}
      <div className="columns">
        <div>
          <video controls src={src} className="player" />
          {!latestOutput && (
            <p className="notice">{t('noVideoYet')}{' '}
              <button type="button" disabled={busy} onClick={() => void work(() => api.render(project.id, videoId))}>{t('renderAgain')}</button></p>
          )}
          <h3>{t('versions')}</h3>
          <VersionList versions={detail.versions} latest={latest.n} disabled={busy}
            onRevert={n => void revertTo(n)} />
        </div>
        <div>
          <SegmentList timeline={latest.timeline} onApprove={(id, approved) => void work(() => api.approve(project.id, videoId, id, approved))} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="feedback">{t('feedback')}</label>
        <textarea id="feedback" rows={2} placeholder={t('feedbackHint')} value={feedback} onChange={e => setFeedback(e.target.value)} />
      </div>
      <button type="button" className="primary" disabled={busy || !feedback.trim()} onClick={() => void sendFix(false)}>{t('sendFeedback')}</button>
      <JobProgress jobId={jobId} />
      {failure && <p role="alert" className="error">{errorText(failure)}</p>}
      {notice && <p role="status" className="notice">{notice}</p>}
      {applied && (
        <div role="status"><p>{t('fixApplied', { summary: applied.summary })}</p>
          {applied.changed.length > 0 && <p>{t('changedItems', { items: itemTimes(latest.timeline, applied.changed) })}</p>}</div>
      )}
      {refusal && (
        <div className="notice" role="status"><strong>{t('refused')}</strong>
          <RefusalText refusal={refusal} durationFrames={latest.timeline.durationFrames} />
          {refusal.needsUnlock && <button type="button" disabled={busy} onClick={() => void sendFix(true)}>{t('unlock')}</button>}
        </div>
      )}
    </div>
  );
}

/** A refusal in the UI language where its code is known; the model's own reason (already in the feedback's language) otherwise. */
function RefusalText({ refusal, durationFrames }: { refusal: Refusal; durationFrames: number }) {
  switch (refusal.code) {
    case 'APPROVED': return <p>{t('refusal.APPROVED')}</p>;
    case 'NOTHING_AT_TIME': return <p>{t('refusal.NOTHING_AT_TIME', { length: mss(durationFrames) })}</p>;
    case 'COULD_NOT_APPLY': return (
      <><p>{t('refusal.COULD_NOT_APPLY')}</p>
        <details><summary>{t('technicalDetails')}</summary><p className="muted">{refusal.reason}</p></details></>
    );
    default: return <p>{refusal.reason}</p>;
  }
}
