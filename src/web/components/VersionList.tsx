import { getLanguage, t } from '../i18n';
import type { VideoDetail } from '../api';

/** Versions, newest first, each with its note and time; every version but the latest can be gone back to. */
export function VersionList({ versions, latest, onRevert, disabled }: { versions: VideoDetail['versions']; latest: number; onRevert: (n: number) => void; disabled: boolean }) {
  const fmt = new Intl.DateTimeFormat(getLanguage() === 'vi' ? 'vi-VN' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' });
  return (
    <ul className="items versions">
      {[...versions].reverse().map(v => (
        <li key={v.n}>
          <strong>v{v.n}</strong>
          <span className="grow">{v.note} <span className="muted">· {fmt.format(new Date(v.createdAt))}</span></span>
          {v.n === latest
            ? <span className="badge">{t('current')}</span>
            : <button type="button" disabled={disabled} onClick={() => onRevert(v.n)}>{t('goBack')}</button>}
        </li>
      ))}
    </ul>
  );
}
