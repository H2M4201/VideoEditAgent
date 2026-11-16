import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type ProjectEntry, type ProjectScan, type Starter, type VideoSummary } from '../api';
import { errorText, getLanguage, t } from '../i18n';

const STARTERS: Starter[] = ['real-estate', 'vlog', 'trend'];
type Props = { selected: ProjectEntry | null; onSelect: (p: ProjectEntry) => void; onNewVideo: () => void; onOpenVideo: (id: string) => void };

export function Projects({ selected, onSelect, onNewVideo, onOpenVideo }: Props) {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [dir, setDir] = useState('');
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [scan, setScan] = useState<ProjectScan | null>(null);
  const [videos, setVideos] = useState<VideoSummary[]>([]);
  const [starter, setStarter] = useState<Starter>('real-estate');

  const fail = (e: unknown) => setError(e instanceof ApiError ? e : { code: 'INTERNAL', message: (e as Error).message });

  /** Registering an existing folder again is harmless and returns a fresh scan (files, guideline, warnings). */
  const open = useCallback(async (p: ProjectEntry) => {
    setError(null);
    try {
      const r = await api.addProject(p.dir);
      setScan(r.scan);
      setVideos(await api.videos(r.project.id));
      return r.project;
    } catch (e) { fail(e); return null; }
  }, []);

  useEffect(() => { void api.projects().then(setProjects).catch(fail); }, []);
  useEffect(() => { if (selected) void open(selected); }, [selected, open]);

  async function add() {
    setError(null);
    try {
      const r = await api.addProject(dir.trim());
      setProjects(await api.projects());
      setDir('');
      onSelect(r.project);
    } catch (e) { fail(e); }
  }

  async function createGuideline() {
    if (!selected) return;
    try { await api.createGuideline(selected.id, starter, getLanguage()); await open(selected); } catch (e) { fail(e); }
  }

  return (
    <div className="page">
      <h2>{t('projects.title')}</h2>
      <form className="row" onSubmit={e => { e.preventDefault(); if (dir.trim()) void add(); }}>
        <div className="field grow">
          <label htmlFor="dir">{t('projects.folderPath')}</label>
          <input id="dir" value={dir} onChange={e => setDir(e.target.value)} aria-describedby="dir-hint" />
          <small id="dir-hint" className="muted">{t('projects.folderHint')}</small>
        </div>
        <button type="submit" className="primary">{t('projects.add')}</button>
      </form>
      {error && <p role="alert" className="error">{errorText(error)}</p>}
      {projects.length === 0 ? <p className="muted">{t('projects.none')}</p> : (
        <ul className="items">
          {projects.map(p => (
            <li key={p.id} className={selected?.id === p.id ? 'selected' : ''}>
              <span className="grow"><strong>{p.name}</strong> <span className="muted path">{p.dir}</span></span>
              <button type="button" aria-pressed={selected?.id === p.id} onClick={() => onSelect(p)}>{t('projects.open')}</button>
            </li>
          ))}
        </ul>
      )}
      {selected && scan && (
        <section>
          <h3>{selected.name}</h3>
          <p>{t('projects.summary', { raw: scan.raw.length, refs: scan.references.media.length + scan.references.scripts.length + scan.references.links.length })}</p>
          {scan.warnings.length > 0 && <ul className="notice">{scan.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
          {!scan.guidelinePath && (
            <div className="row">
              <span>{t('projects.noGuideline')}</span>
              <select aria-label={t('projects.starter')} value={starter} onChange={e => setStarter(e.target.value as Starter)}>
                {STARTERS.map(s => <option key={s} value={s}>{t(`starter.${s}`)}</option>)}
              </select>
              <button type="button" onClick={() => void createGuideline()}>{t('projects.createGuideline')}</button>
            </div>
          )}
          <p><button type="button" className="primary" onClick={onNewVideo}>{t('projects.newVideo')}</button></p>
          <h3>{t('projects.videos')}</h3>
          {videos.length === 0 ? <p className="muted">{t('projects.noVideos')}</p> : (
            <ul className="items">
              {videos.map(v => (
                <li key={v.videoId}>
                  <span className="grow">{v.prompt || v.videoId} <span className="muted">· v{v.latestVersion}</span></span>
                  <button type="button" onClick={() => onOpenVideo(v.videoId)}>{t('projects.openVideo')}</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
