import { useState, type ReactNode } from 'react';
import { api, ApiError, type Settings as S } from '../api';
import { errorText, t } from '../i18n';

type Props = { settings: S; onSaved: (s: S) => void };
type Field = 'apiKey' | 'model' | 'capcutDraftsDir' | 'whisperBinary' | 'whisperModel' | 'ytDlpBinary';
const TEXT: [Field, 'settings.apiKey' | 'settings.model' | 'settings.capcutDraftsDir' | 'settings.whisperBinary' | 'settings.whisperModel' | 'settings.ytDlpBinary'][] = [
  ['apiKey', 'settings.apiKey'], ['model', 'settings.model'], ['capcutDraftsDir', 'settings.capcutDraftsDir'],
  ['whisperBinary', 'settings.whisperBinary'], ['whisperModel', 'settings.whisperModel'], ['ytDlpBinary', 'settings.ytDlpBinary'],
];

function Labelled({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return <div className="field"><label htmlFor={id}>{label}</label>{children}</div>;
}

export function Settings({ settings, onSaved }: Props) {
  const [form, setForm] = useState(settings);
  const [status, setStatus] = useState<'idle' | 'saved' | { code: string; message: string }>('idle');
  const set = <K extends keyof S>(k: K, v: S[K]) => { setForm(f => ({ ...f, [k]: v })); setStatus('idle'); };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const { projects: _projects, ...patch } = form;
    try { const saved = await api.saveSettings(patch); setForm(saved); onSaved(saved); setStatus('saved'); }
    catch (err) { setStatus(err instanceof ApiError ? err : { code: 'INTERNAL', message: (err as Error).message }); }
  }

  return (
    <form className="page" onSubmit={e => void save(e)}>
      <h2>{t('settings.title')}</h2>
      {TEXT.map(([k, label]) => (
        <Labelled key={k} id={k} label={t(label)}>
          <input id={k} type={k === 'apiKey' ? 'password' : 'text'} autoComplete="off" value={form[k]} onChange={e => set(k, e.target.value)} />
        </Labelled>
      ))}
      <Labelled id="language" label={t('settings.language')}>
        <select id="language" value={form.language} onChange={e => set('language', e.target.value as S['language'])}>
          <option value="vi">{t('language.vi')}</option><option value="en">{t('language.en')}</option>
        </select>
      </Labelled>
      <Labelled id="defaultEngine" label={t('settings.defaultEngine')}>
        <select id="defaultEngine" value={form.defaultEngine} onChange={e => set('defaultEngine', e.target.value as S['defaultEngine'])}>
          <option value="builtin">{t('engine.builtin')}</option><option value="capcut">{t('engine.capcut')}</option>
        </select>
      </Labelled>
      {(['inputPricePerMTok', 'outputPricePerMTok'] as const).map(k => (
        <Labelled key={k} id={k} label={t(k === 'inputPricePerMTok' ? 'settings.inputPrice' : 'settings.outputPrice')}>
          <input id={k} type="number" min={0} step="any" value={form[k]} onChange={e => set(k, Number(e.target.value) || 0)} />
        </Labelled>
      ))}
      <p className="muted">{t('settings.pricesHint')}</p>
      <button type="submit" className="primary">{t('save')}</button>
      {status === 'saved' && <p role="status">{t('saved')}</p>}
      {typeof status === 'object' && <p role="alert" className="error">{errorText(status)}</p>}
    </form>
  );
}
