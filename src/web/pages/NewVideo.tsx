import { useEffect, useState } from 'react';
import { api, ApiError, type EngineInfo, type GenerateResult, type PrepareResult, type ProjectEntry, type Settings } from '../api';
import { CostEstimate } from '../components/CostEstimate';
import { JobError, JobProgress } from '../components/JobProgress';
import { RoleTable, toRequestRole, type RoleRow } from '../components/RoleTable';
import { errorText, t } from '../i18n';
import { useJobs } from '../useJobs';

type Props = { project: ProjectEntry; settings: Settings; onGenerated: (r: GenerateResult) => void };
type Failure = { code: string; message: string };

export function NewVideo({ project, settings, onGenerated }: Props) {
  const { waitFor } = useJobs();
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [engine, setEngine] = useState<string>(settings.defaultEngine ?? 'builtin');
  const [prompt, setPrompt] = useState('');
  const [prepared, setPrepared] = useState<PrepareResult | null>(null);
  const [rows, setRows] = useState<RoleRow[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const noKey = !settings.apiKey;

  useEffect(() => { void api.engines().then(setEngines).catch(() => setEngines([])); }, []);

  /** Starts a job with `start`, waits for it, and returns its result (or null after showing the error). */
  async function run<T>(start: () => Promise<{ job: { id: string } }>): Promise<T | null> {
    setBusy(true); setFailure(null);
    try {
      const { job } = await start();
      setJobId(job.id);
      const finished = await waitFor(job.id);
      if (finished.status === 'failed') { setFailure(finished.error ?? { code: 'INTERNAL', message: '' }); return null; }
      return finished.result as T;
    } catch (e) {
      setFailure(e instanceof ApiError ? e : { code: 'INTERNAL', message: (e as Error).message });
      return null;
    } finally { setBusy(false); }
  }

  async function check() {
    setPrepared(null);
    const r = await run<PrepareResult>(() => api.prepare(project.id, prompt));
    if (r) { setPrepared(r); setRows(r.roles); }
  }

  async function generate() {
    const r = await run<GenerateResult>(() => api.generate(project.id, { prompt, roles: rows.map(toRequestRole), engine }));
    if (r) onGenerated(r);
  }

  return (
    <div className="page">
      <h2>{t('newVideo.title')} · {project.name}</h2>
      {noKey && <p className="notice">{t('noKeyNotice')} <a href="#/settings">{t('noKeyLink')}</a></p>}
      <div className="field">
        <label htmlFor="engine">{t('engine')}</label>
        <select id="engine" value={engine} onChange={e => setEngine(e.target.value)}>
          {engines.map(e => (
            <option key={e.id} value={e.id} disabled={!e.available}>
              {t(`engine.${e.id as 'builtin' | 'capcut'}`)}{e.available ? '' : ` (${t('unavailable')})`}
            </option>
          ))}
        </select>
        {engines.filter(e => !e.available).map(e => <p key={e.id} className="muted">{e.reason}</p>)}
      </div>
      <div className="field">
        <label htmlFor="prompt">{t('prompt')}</label>
        <textarea id="prompt" rows={3} placeholder={t('promptHint')} value={prompt} onChange={e => setPrompt(e.target.value)} />
      </div>
      <button type="button" className="primary" disabled={noKey || busy} onClick={() => void check()}>{t('checkReferences')}</button>
      <JobProgress jobId={jobId} />
      {failure && <JobError job={{ error: failure }} />}

      {prepared && (
        <section>
          <h3>{t('references')}</h3>
          {rows.length === 0 ? <p className="muted">{t('noReferences')}</p>
            : <RoleTable rows={rows} onChange={(i, row) => setRows(rs => rs.map((r, j) => (j === i ? row : r)))} />}
          <CostEstimate cost={prepared.cost} settings={settings} />
          {prepared.linkFailures.length > 0 && (
            <div className="notice"><strong>{t('linkFailures')}</strong>
              <ul>{prepared.linkFailures.map(l => <li key={l.url}>{l.url}: {l.error}</li>)}</ul></div>
          )}
          {prepared.warnings.length > 0 && (
            <div className="notice"><strong>{t('warnings')}</strong>
              <ul>{prepared.warnings.map(w => <li key={w}>{w}</li>)}</ul></div>
          )}
          <button type="button" className="primary" disabled={busy} onClick={() => void generate()}>{t('generate')}</button>
        </section>
      )}
    </div>
  );
}
