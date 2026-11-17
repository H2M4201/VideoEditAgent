import { describe, expect, test } from 'vitest';
import { en } from '../../src/web/i18n/en';
import { errorText, setLanguage, t } from '../../src/web/i18n';
import { vi as viDict } from '../../src/web/i18n/vi';

describe('i18n', () => {
  test('Vietnamese and English have the same keys and no empty values', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(viDict).sort());
    for (const [k, v] of [...Object.entries(viDict), ...Object.entries(en)]) expect(v.trim(), k).not.toBe('');
  });

  test('switching language changes the Generate label', () => {
    setLanguage('vi');
    expect(t('generate')).toBe('Tạo video');
    setLanguage('en');
    expect(t('generate')).toBe('Generate');
    setLanguage('vi');
  });

  test('error codes map to translated messages; unknown codes show the server message', () => {
    setLanguage('en');
    expect(errorText({ code: 'NO_API_KEY', message: 'server words' })).toBe(en['error.NO_API_KEY']);
    const unknown = errorText({ code: 'SOMETHING_NEW', message: 'server words' });
    expect(unknown).toContain(en['error.INTERNAL']);
    expect(unknown).toContain('server words');
    setLanguage('vi');
  });

  test('every error code the server or the client can produce has a translation in both languages', () => {
    const codes = ['UNKNOWN_ITEM', 'UNKNOWN_VERSION', 'BAD_ROLES', 'PROJECT_NOT_FOUND', 'VIDEO_NOT_FOUND', 'FORBIDDEN', 'BAD_REQUEST', 'NETWORK',
      'BUSY', 'ENGINE_UNAVAILABLE', 'APPROVED_CONFLICT', 'BROWSER_UNAVAILABLE', 'API_KEY_REJECTED', 'API_RATE_LIMIT', 'ALREADY_RENDERED'];
    for (const lang of ['vi', 'en'] as const) {
      setLanguage(lang);
      for (const code of codes) expect(errorText({ code, message: 'server words' }), `${lang} ${code}`).not.toContain('server words');
    }
    setLanguage('vi');
  });
});
