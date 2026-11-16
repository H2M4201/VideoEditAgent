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
});
