import { t } from '../i18n';
import type { RoleAssignment } from '../api';

/** A reference row; `edited` rows were changed in the UI and show "you" as the decider. */
export type RoleRow = RoleAssignment & { edited?: boolean };
const ROLES = ['narration', 'music', 'style', 'script', 'ignore'] as const;

/** Applies an edit. The server only knows guideline/prompt/guess, so a user's choice is sent as a prompt-level decision. */
export function editRow(row: RoleRow, change: Partial<Pick<RoleRow, 'role' | 'useAudio'>>): RoleRow {
  const role = change.role ?? row.role;
  return { ...row, ...change, role, useAudio: role === 'style' && (change.useAudio ?? row.useAudio), edited: true };
}

export function toRequestRole({ edited, ...row }: RoleRow): RoleAssignment {
  return edited ? { ...row, decidedBy: 'prompt', reason: t('editedReason') } : row;
}

export function RoleTable({ rows, onChange }: { rows: RoleRow[]; onChange: (i: number, row: RoleRow) => void }) {
  return (
    <table>
      <thead><tr><th>{t('file')}</th><th>{t('role')}</th><th>{t('decidedBy')}</th></tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.path}>
            <td className="path" title={r.reason}>{r.path}</td>
            <td>
              <select aria-label={`${t('role')}: ${r.path}`} value={r.role} onChange={e => onChange(i, editRow(r, { role: e.target.value as RoleRow['role'] }))}>
                {ROLES.map(x => <option key={x} value={x}>{t(`role.${x}`)}</option>)}
              </select>
              {r.role === 'style' && (
                <label className="inline">
                  <input type="checkbox" aria-label={`${t('useAudio')}: ${r.path}`} checked={r.useAudio}
                    onChange={e => onChange(i, editRow(r, { useAudio: e.target.checked }))} />
                  {t('useAudio')}
                </label>
              )}
            </td>
            <td>{r.edited ? t('decidedBy.you') : t(`decidedBy.${r.decidedBy}`)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
