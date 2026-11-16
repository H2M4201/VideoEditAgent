import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, type ProjectEntry, type Settings as S } from './api';
import { setLanguage, t, useLanguage } from './i18n';
import { NewVideo } from './pages/NewVideo';
import { Projects } from './pages/Projects';
import { Queue } from './pages/Queue';
import { Result } from './pages/Result';
import { Settings } from './pages/Settings';

const subscribeHash = (fn: () => void) => { window.addEventListener('hashchange', fn); return () => window.removeEventListener('hashchange', fn); };
const currentHash = () => window.location.hash.replace(/^#\/?/, '');
const go = (to: string) => { window.location.hash = `#/${to}`; };

const NAV = [['projects', 'nav.projects'], ['new', 'nav.newVideo'], ['queue', 'nav.queue'], ['settings', 'nav.settings']] as const;

export function App() {
  useLanguage(); // re-render everything when the language changes
  const hash = useSyncExternalStore(subscribeHash, currentHash);
  const [page, videoId] = hash.split('/');
  const [settings, setSettings] = useState<S | null>(null);
  const [project, setProject] = useState<ProjectEntry | null>(null);

  useEffect(() => { void api.settings().then(s => { setLanguage(s.language); setSettings(s); }); }, []);
  useEffect(() => { document.title = t('app.title'); });

  if (!settings) return <p className="muted pad">{t('loading')}</p>;
  const active = page || 'projects';

  return (
    <>
      <header>
        <h1>{t('app.title')}</h1>
        <nav aria-label={t('app.title')}>
          {NAV.map(([id, label]) => <a key={id} href={`#/${id}`} aria-current={active === id ? 'page' : undefined}>{t(label)}</a>)}
        </nav>
      </header>
      <main>
        {active === 'settings' && <Settings settings={settings} onSaved={s => { setSettings(s); setLanguage(s.language); }} />}
        {active === 'queue' && <Queue />}
        {active === 'new' && (project
          ? <NewVideo project={project} settings={settings} onGenerated={r => go(`result/${r.videoId}`)} />
          : <p className="pad">{t('newVideo.pickProject')}</p>)}
        {active === 'result' && project && videoId && (
          <Result key={videoId} project={project} videoId={videoId} onStartOver={() => go('new')} />
        )}
        {(active === 'projects' || (active === 'result' && !project)) && (
          <Projects selected={project} onSelect={setProject} onNewVideo={() => go('new')}
            onOpenVideo={id => go(`result/${id}`)} />
        )}
      </main>
    </>
  );
}
