import { t } from '../i18n';
import type { Timeline } from '../api';

const FPS = 30;
export const mss = (frame: number) => `${Math.floor(frame / FPS / 60)}:${String(Math.floor(frame / FPS) % 60).padStart(2, '0')}`;

type Item = { id: string; startFrame: number; approved: boolean };

/** "0:06 shot, 0:06 caption, audio a1": the given ids of `timeline` by start time (audio tracks by id), in timeline order. */
export function itemTimes(timeline: Timeline, ids: string[]): string {
  const timed = [...timeline.segments.map(s => [s, t('item.segment')] as const), ...timeline.captions.map(c => [c, t('item.caption')] as const)]
    .filter(([i]) => ids.includes(i.id)).map(([i, kind]) => `${mss(i.startFrame)} ${kind}`);
  const audio = timeline.audio.filter(a => ids.includes(a.id)).map(a => `${t('item.audio')} ${a.id}`);
  return [...timed, ...audio].join(', ');
}

function Section({ title, items, label, onApprove }: { title: string; items: Item[]; label: (i: never) => string; onApprove: (id: string, approved: boolean) => void }) {
  return (
    <section>
      <h3>{title}</h3>
      <ul className="items">
        {items.map(i => (
          <li key={i.id} aria-label={i.id} className={i.approved ? 'approved' : ''}>
            <span className="time">{mss(i.startFrame)}</span>
            <span className="grow">{label(i as never)}</span>
            {i.approved && <span className="badge"><span aria-hidden="true">✓</span> <span>{t('approved')}</span></span>}
            <button type="button" aria-pressed={i.approved} onClick={() => onApprove(i.id, !i.approved)}>
              {i.approved ? t('unapprove') : t('approve')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Segments and captions of a timeline with their start time (m:ss) and an approve toggle. */
export function SegmentList({ timeline, onApprove }: { timeline: Timeline; onApprove: (id: string, approved: boolean) => void }) {
  return (
    <>
      <Section title={t('segments')} items={timeline.segments} label={(s: Timeline['segments'][number]) => s.source} onApprove={onApprove} />
      <Section title={t('captions')} items={timeline.captions} label={(c: Timeline['captions'][number]) => c.text} onApprove={onApprove} />
    </>
  );
}
