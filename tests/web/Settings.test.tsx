// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '../../src/web/i18n';
import { Settings } from '../../src/web/pages/Settings';

const api = vi.hoisted(() => ({ saveSettings: vi.fn() }));
vi.mock('../../src/web/api', async orig => ({ ...(await orig<typeof import('../../src/web/api')>()), api }));

const base = {
  apiKey: '••••1234', keySource: 'env-file', model: 'claude-opus-5-5', language: 'en', defaultEngine: 'builtin',
  capcutDraftsDir: '', whisperBinary: 'whisper-cli', whisperModel: '', ytDlpBinary: 'yt-dlp',
  inputPricePerMTok: 0, outputPricePerMTok: 0, projects: [],
};

beforeEach(() => { setLanguage('en'); api.saveSettings.mockReset(); });
afterEach(cleanup);

test.each([
  ['env-file', 'Using the key from .env.'],
  ['environment', 'Using the key from the system environment. A key entered here takes priority.'],
  ['none', 'No key set.'],
])('key source %s is shown', (keySource, text) => {
  render(<Settings settings={{ ...base, keySource } as never} onSaved={() => {}} />);
  expect(screen.getByText(text)).toBeInTheDocument();
});

test('the key field is labelled for Claude and says it is saved as AI_PROVIDER_KEY in .env', () => {
  render(<Settings settings={base as never} onSaved={() => {}} />);
  expect(screen.getByLabelText('AI key (Claude)')).toHaveAttribute('type', 'password');
  expect(screen.getByText(/AI_PROVIDER_KEY/)).toHaveTextContent("Saved in the app's .env file (AI_PROVIDER_KEY).");
});

test('saving never sends keySource', async () => {
  api.saveSettings.mockResolvedValue(base);
  render(<Settings settings={base as never} onSaved={() => {}} />);
  await userEvent.type(screen.getByLabelText('AI key (Claude)'), 'x');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
  const patch = api.saveSettings.mock.calls[0][0];
  expect(patch).not.toHaveProperty('keySource');
  expect(patch.apiKey).toBe('••••1234x');
});

test('Vietnamese labels', () => {
  setLanguage('vi');
  render(<Settings settings={{ ...base, keySource: 'none' } as never} onSaved={() => {}} />);
  expect(screen.getByLabelText('Khóa AI (Claude)')).toBeInTheDocument();
  expect(screen.getByText('Chưa có khóa.')).toBeInTheDocument();
});
