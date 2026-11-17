// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { setLanguage, t } from '../../src/web/i18n';
import { NewVideo } from '../../src/web/pages/NewVideo';

const h = vi.hoisted(() => ({ waitFor: vi.fn() }));
const api = vi.hoisted(() => ({ engines: vi.fn(), prepare: vi.fn(), generate: vi.fn() }));
vi.mock('../../src/web/api', async orig => ({ ...(await orig<typeof import('../../src/web/api')>()), api }));
vi.mock('../../src/web/useJobs', () => ({ useJobs: () => ({ jobs: [], waitFor: h.waitFor }) }));

const project = { id: 'p1', dir: '/shoots/villa', name: 'villa' };
const settings = { apiKey: '••••1234', inputPricePerMTok: 0, outputPricePerMTok: 0 } as never;
const ROLES = [
  { path: 'reference/vo.mp3', role: 'narration', useAudio: false, decidedBy: 'guess', reason: 'speech' },
  { path: 'reference/sample1.mp4', role: 'style', useAudio: false, decidedBy: 'guideline', reason: 'guideline says so' },
];
const prepared = { id: 'j1', status: 'done', progress: 1, message: '', result: {
  roles: ROLES, driver: 'narration', cost: { inputTokens: 12000, outputTokens: 6000, usd: 0.4 },
  linkFailures: [{ url: 'https://bad.example/x', error: 'private video' }], warnings: ['careful with raw/a.mp4'] } };

beforeEach(() => {
  setLanguage('en');
  Object.values(api).forEach(f => f.mockReset());
  h.waitFor.mockReset();
  api.engines.mockResolvedValue([
    { id: 'builtin', capabilities: {}, available: true },
    { id: 'capcut', capabilities: null, available: false, reason: 'CapCut engine is not installed in this version.' },
  ]);
  api.prepare.mockResolvedValue({ job: { id: 'j1' } });
  h.waitFor.mockResolvedValue(prepared);
});
afterEach(() => { cleanup(); setLanguage('vi'); });

async function prepare(s: unknown = settings) {
  const user = userEvent.setup();
  render(<NewVideo project={project} settings={s as never} onGenerated={vi.fn()} />);
  await user.type(screen.getByLabelText(t('prompt')), '45s tour');
  await user.click(screen.getByRole('button', { name: t('checkReferences') }));
  await screen.findByRole('table');
  return user;
}

describe('NewVideo', () => {
  test('after prepare, each role row shows who decided it; costs, link failures and warnings appear', async () => {
    await prepare();
    expect(api.prepare).toHaveBeenCalledWith('p1', '45s tour');
    expect(within(screen.getByRole('row', { name: /vo\.mp3/ })).getByText('guess')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /sample1\.mp4/ })).getByText('guideline')).toBeInTheDocument();
    expect(screen.getByText(/12,000/)).toBeInTheDocument(); // no prices set: token counts
    expect(screen.getByText(/private video/)).toBeInTheDocument();
    expect(screen.getByText(/careful with raw/)).toBeInTheDocument();
  });

  test('shows USD when prices are set', async () => {
    await prepare({ ...(settings as object), inputPricePerMTok: 3, outputPricePerMTok: 15 });
    expect(screen.getByText(/\$0\.40/)).toBeInTheDocument();
  });

  test('changing a role marks it "you" and sends the edited roles in the videos request', async () => {
    const user = await prepare();
    api.generate.mockResolvedValue({ job: { id: 'j2' } });
    h.waitFor.mockResolvedValue({ id: 'j2', status: 'done', result: { videoId: 'abc', version: 1, notFollowed: [], output: { url: null, path: '' } } });
    await user.selectOptions(screen.getByLabelText(`${t('role')}: reference/vo.mp3`), 'music');
    expect(within(screen.getByRole('row', { name: /vo\.mp3/ })).getByText('you')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t('generate') }));
    await waitFor(() => expect(api.generate).toHaveBeenCalled());
    const [pid, body] = api.generate.mock.calls[0];
    expect(pid).toBe('p1');
    expect(body.prompt).toBe('45s tour');
    expect(body.roles).toEqual([
      expect.objectContaining({ path: 'reference/vo.mp3', role: 'music', decidedBy: 'prompt', useAudio: false }),
      ROLES[1],
    ]);
  });

  test('a style row offers "use its audio" and sends it', async () => {
    const user = await prepare();
    api.generate.mockResolvedValue({ job: { id: 'j2' } });
    h.waitFor.mockResolvedValue({ id: 'j2', status: 'done', result: { videoId: 'abc', version: 1, notFollowed: [], output: { url: null, path: '' } } });
    await user.click(screen.getByLabelText(`${t('useAudio')}: reference/sample1.mp4`));
    await user.click(screen.getByRole('button', { name: t('generate') }));
    await waitFor(() => expect(api.generate).toHaveBeenCalled());
    expect(api.generate.mock.calls[0][1].roles[1]).toMatchObject({ role: 'style', useAudio: true, decidedBy: 'prompt' });
    expect(screen.queryByLabelText(`${t('useAudio')}: reference/vo.mp3`)).toBeNull();
  });

  test('an unavailable engine is disabled and shows its reason', async () => {
    render(<NewVideo project={project} settings={settings} onGenerated={vi.fn()} />);
    const option = await screen.findByRole('option', { name: /capcut/i });
    expect(option).toBeDisabled();
    expect(screen.getByText('CapCut engine is not installed in this version.')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /built-in/i })).toBeEnabled();
  });

  test('an empty API key disables "Check references" and shows a notice linking to Settings', async () => {
    render(<NewVideo project={project} settings={{ apiKey: '' } as never} onGenerated={vi.fn()} />);
    expect(screen.getByRole('button', { name: t('checkReferences') })).toBeDisabled();
    expect(screen.getByRole('link', { name: t('noKeyLink') })).toHaveAttribute('href', '#/settings');
  });

  test('a failed job shows the translated error for its code', async () => {
    h.waitFor.mockResolvedValue({ id: 'j1', status: 'failed', error: { code: 'TRANSCRIBE_FAILED', message: 'raw server text' } });
    const user = userEvent.setup();
    render(<NewVideo project={project} settings={settings} onGenerated={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: t('checkReferences') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t('error.TRANSCRIBE_FAILED'));
    expect(screen.queryByText(/raw server text/)).toBeNull();
  });

  test('editing the prompt after "Check references" clears the prepared roles; they must be checked again', async () => {
    const user = await prepare();
    await user.type(screen.getByLabelText(t('prompt')), ', end on the pool');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: t('generate') })).toBeNull();
    await user.click(screen.getByRole('button', { name: t('checkReferences') }));
    await screen.findByRole('table');
    expect(api.prepare).toHaveBeenLastCalledWith('p1', '45s tour, end on the pool');
  });

  test('when the default engine is unavailable the first available engine is selected and sent', async () => {
    const s = { ...(settings as object), defaultEngine: 'capcut' };
    const user = await prepare(s);
    await waitFor(() => expect(screen.getByLabelText(t('engine'))).toHaveValue('builtin'));
    api.generate.mockResolvedValue({ job: { id: 'j2' } });
    h.waitFor.mockResolvedValue({ id: 'j2', status: 'done', result: { videoId: 'abc', version: 1, notFollowed: [], output: { url: null, path: '' } } });
    await user.click(screen.getByRole('button', { name: t('generate') }));
    await waitFor(() => expect(api.generate).toHaveBeenCalled());
    expect(api.generate.mock.calls[0][1].engine).toBe('builtin');
  });

  test('Generate button label follows the language', async () => {
    await prepare();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeInTheDocument();
    cleanup();
    setLanguage('vi');
    await prepare();
    expect(screen.getByRole('button', { name: 'Tạo video' })).toBeInTheDocument();
  });
});
