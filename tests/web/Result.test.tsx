// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { setLanguage, t } from '../../src/web/i18n';
import { Result } from '../../src/web/pages/Result';

const h = vi.hoisted(() => ({ waitFor: vi.fn() }));
const api = vi.hoisted(() => ({ video: vi.fn(), approve: vi.fn(), fix: vi.fn(), revert: vi.fn(), render: vi.fn() }));
vi.mock('../../src/web/api', async orig => ({ ...(await orig<typeof import('../../src/web/api')>()), api }));
vi.mock('../../src/web/useJobs', () => ({ useJobs: () => ({ jobs: [], waitFor: h.waitFor }) }));

const project = { id: 'p1', dir: '/shoots/villa', name: 'villa' };
const detail = {
  videoId: 'v1', engine: 'builtin', prompt: 'p', roles: [], notFollowed: [],
  versions: [
    { n: 1, note: 'generated', createdAt: '2026-11-16T10:00:00.000Z', output: { url: '/media/p1/.vea/videos/v1/v1.mp4', path: '/x' } },
    { n: 2, note: 'approved s1', createdAt: '2026-11-16T10:05:00.000Z', output: { url: '/media/p1/.vea/videos/v1/v2.mp4', path: '/x' } },
  ],
  latest: { n: 2, timeline: { durationFrames: 450, audio: [],
    segments: [{ id: 's1', source: 'raw/intro.mp4', startFrame: 0, durationFrames: 300, approved: true },
      { id: 's2', source: 'raw/kitchen.mp4', startFrame: 300, durationFrames: 150, approved: false }],
    captions: [{ id: 'c1', text: 'Xin chào các bạn', startFrame: 45, endFrame: 90, approved: false }],
  } },
};
const done = (result: unknown) => ({ id: 'j', status: 'done', result });

beforeEach(() => {
  setLanguage('en');
  Object.values(api).forEach(f => f.mockReset());
  h.waitFor.mockReset();
  api.video.mockResolvedValue(detail);
});
afterEach(() => { cleanup(); setLanguage('vi'); });

const open = async (props: object = {}) => {
  const user = userEvent.setup();
  render(<Result project={project} videoId="v1" onStartOver={vi.fn()} {...props} />);
  await screen.findByText('Xin chào các bạn');
  return user;
};

describe('Result', () => {
  test('lists segments and captions with m:ss time, text and approval state; the player uses the latest output', async () => {
    await open();
    expect(screen.getByText('0:10')).toBeInTheDocument();
    expect(screen.getByText('0:01')).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: /s1/ })).getByText(t('approved'))).toBeInTheDocument();
    expect(within(screen.getByRole('listitem', { name: /s2/ })).queryByText(t('approved'))).toBeNull();
    expect(document.querySelector('video')).toHaveAttribute('src', '/media/p1/.vea/videos/v1/v2.mp4');
  });

  test('the approve toggle calls the approve route with the item id', async () => {
    const user = await open();
    api.approve.mockResolvedValue({ version: 3 });
    await user.click(within(screen.getByRole('listitem', { name: /s2/ })).getByRole('button', { name: t('approve') }));
    expect(api.approve).toHaveBeenCalledWith('p1', 'v1', 's2', true);
    await user.click(within(screen.getByRole('listitem', { name: /s1/ })).getByRole('button', { name: t('unapprove') }));
    expect(api.approve).toHaveBeenCalledWith('p1', 'v1', 's1', false);
  });

  test('a refused fix with needsUnlock shows its reason and an unlock button that resends with unlock: true', async () => {
    const user = await open();
    api.fix.mockResolvedValue({ job: { id: 'j' } });
    h.waitFor.mockResolvedValueOnce(done({ status: 'refused', code: 'MODEL_REFUSED', reason: 'That makes the intro shorter.', needsUnlock: true }));
    await user.type(screen.getByLabelText(t('feedback')), 'shorten the intro');
    await user.click(screen.getByRole('button', { name: t('sendFeedback') }));
    expect(await screen.findByText('That makes the intro shorter.')).toBeInTheDocument();
    expect(api.fix).toHaveBeenLastCalledWith('p1', 'v1', { feedback: 'shorten the intro', unlock: false });
    h.waitFor.mockResolvedValueOnce(done({ status: 'applied', version: 3, targets: [], changed: [], summary: 's', output: { url: null, path: '' } }));
    await user.click(screen.getByRole('button', { name: t('unlock') }));
    await waitFor(() => expect(api.fix).toHaveBeenLastCalledWith('p1', 'v1', { feedback: 'shorten the intro', unlock: true }));
  });

  test('a refusal without needsUnlock has no unlock button', async () => {
    const user = await open();
    api.fix.mockResolvedValue({ job: { id: 'j' } });
    h.waitFor.mockResolvedValueOnce(done({ status: 'refused', code: 'MODEL_REFUSED', reason: 'Cannot do that.', needsUnlock: false }));
    await user.type(screen.getByLabelText(t('feedback')), 'x');
    await user.click(screen.getByRole('button', { name: t('sendFeedback') }));
    await screen.findByText('Cannot do that.');
    expect(screen.queryByRole('button', { name: t('unlock') })).toBeNull();
  });

  /** Sends feedback "x" and resolves the fix job with `result`. */
  async function fixWith(result: unknown) {
    const user = await open();
    api.fix.mockResolvedValue({ job: { id: 'j' } });
    h.waitFor.mockResolvedValueOnce(done(result));
    await user.type(screen.getByLabelText(t('feedback')), 'x');
    await user.click(screen.getByRole('button', { name: t('sendFeedback') }));
    return user;
  }

  test('an applied fix lists the changed items with their times', async () => {
    await fixWith({ status: 'applied', version: 3, targets: ['s2'], changed: ['s2', 'c1'], summary: 'Đã đổi cảnh.', output: { url: null, path: '' } });
    expect(await screen.findByText(t('fixApplied', { summary: 'Đã đổi cảnh.' }))).toBeInTheDocument();
    expect(screen.getByText(t('changedItems', { items: `0:10 ${t('item.segment')}, 0:01 ${t('item.caption')}` }))).toBeInTheDocument();
  });

  test('refusals with a known code are translated; COULD_NOT_APPLY keeps the technical detail in a collapsed block', async () => {
    await fixWith({ status: 'refused', code: 'APPROVED', reason: 'That part is approved. Remove the approval to change it.', needsUnlock: false });
    expect(await screen.findByText(t('refusal.APPROVED'))).toBeInTheDocument();
    cleanup();
    await fixWith({ status: 'refused', code: 'NOTHING_AT_TIME', reason: 'There is nothing at that time; the video is 0:15 long.', needsUnlock: false });
    expect(await screen.findByText(t('refusal.NOTHING_AT_TIME', { length: '0:15' }))).toBeInTheDocument();
    cleanup();
    await fixWith({ status: 'refused', code: 'COULD_NOT_APPLY', reason: 'segment s2: durationFrames 90 does not match', needsUnlock: false });
    expect(await screen.findByText(t('refusal.COULD_NOT_APPLY'))).toBeInTheDocument();
    const detailBlock = screen.getByText('segment s2: durationFrames 90 does not match').closest('details');
    expect(detailBlock).not.toBeNull();
    expect(detailBlock).not.toHaveAttribute('open');
  });

  test('notFollowed entries stored with the video are displayed', async () => {
    api.video.mockResolvedValue({ ...detail, notFollowed: [{ instruction: 'use a red logo', source: 'prompt', reason: 'guideline.md forbids red logos' }] });
    await open();
    expect(screen.getByText(/use a red logo/)).toBeInTheDocument();
    expect(screen.getByText(/guideline\.md forbids red logos/)).toBeInTheDocument();
  });

  test('"Go back to this version" calls revert for an earlier version only', async () => {
    const user = await open();
    api.revert.mockResolvedValue({ job: { id: 'j' } });
    h.waitFor.mockResolvedValueOnce(done({ version: 3, output: { url: null, path: '' } }));
    const buttons = screen.getAllByRole('button', { name: t('goBack') });
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0]);
    expect(api.revert).toHaveBeenCalledWith('p1', 'v1', 1);
  });

  test('a refused revert names the approved items by time and asks to remove those approvals first', async () => {
    const user = await open();
    api.revert.mockResolvedValue({ job: { id: 'j' } });
    h.waitFor.mockResolvedValueOnce(done({ status: 'refused', code: 'APPROVED_CONFLICT', ids: ['s1', 'c1'] }));
    await user.click(screen.getByRole('button', { name: t('goBack') }));
    expect(await screen.findByText(t('revertConflict', { items: `0:00 ${t('item.segment')}, 0:01 ${t('item.caption')}` }))).toBeInTheDocument();
  });

  test('a failed fix job shows the translated error', async () => {
    const user = await open();
    api.fix.mockResolvedValue({ job: { id: 'j' } });
    h.waitFor.mockResolvedValueOnce({ id: 'j', status: 'failed', error: { code: 'INVALID_AFTER_RETRIES', message: 'raw' } });
    await user.type(screen.getByLabelText(t('feedback')), 'x');
    await user.click(screen.getByRole('button', { name: t('sendFeedback') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t('error.INVALID_AFTER_RETRIES'));
  });

  test('"Render again" shows only when the latest version has no video, and renders it', async () => {
    await open();
    expect(screen.queryByRole('button', { name: t('renderAgain') })).toBeNull();
    cleanup();
    api.video.mockResolvedValue({ ...detail, versions: [detail.versions[0], { ...detail.versions[1], output: null }] });
    const user = await open();
    api.render.mockResolvedValue({ job: { id: 'j' } });
    h.waitFor.mockResolvedValueOnce(done({ version: 2, output: { url: '/media/p1/.vea/videos/v1/v2.mp4', path: '/x' } }));
    await user.click(screen.getByRole('button', { name: t('renderAgain') }));
    expect(api.render).toHaveBeenCalledWith('p1', 'v1');
  });

  test('a browser failure is shown with its translated message', async () => {
    const user = await open();
    api.fix.mockResolvedValue({ job: { id: 'j' } });
    h.waitFor.mockResolvedValueOnce({ id: 'j', status: 'failed', error: { code: 'BROWSER_UNAVAILABLE', message: 'raw' } });
    await user.type(screen.getByLabelText(t('feedback')), 'x');
    await user.click(screen.getByRole('button', { name: t('sendFeedback') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(t('error.BROWSER_UNAVAILABLE'));
  });

  test('Start over calls onStartOver', async () => {
    const onStartOver = vi.fn();
    const user = await open({ onStartOver });
    await user.click(screen.getByRole('button', { name: t('startOver') }));
    expect(onStartOver).toHaveBeenCalled();
  });
});
