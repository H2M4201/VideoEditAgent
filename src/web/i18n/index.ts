import { useSyncExternalStore } from 'react';
import { en } from './en';
import { vi } from './vi';

export type Language = 'vi' | 'en';
export type Key = keyof typeof vi;

const dictionaries: Record<Language, Record<Key, string>> = { vi, en };
let current: Language = 'vi';
const listeners = new Set<() => void>();

export function setLanguage(l: Language): void {
  if (l === current) return;
  current = l;
  listeners.forEach(fn => fn());
}

export const getLanguage = (): Language => current;

/** Re-renders the calling component when the language changes. */
export function useLanguage(): Language {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, getLanguage);
}

/** Translates `key`; `{name}` placeholders are filled from `vars`. */
export function t(key: Key, vars?: Record<string, string | number>): string {
  const text = dictionaries[current][key];
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

/** A job or request error as text: translated for known codes, otherwise a generic line plus the server's message. */
export function errorText(e: { code: string; message: string }): string {
  const key = `error.${e.code}`;
  return key in vi && key !== 'error.INTERNAL' ? t(key as Key) : `${t('error.INTERNAL')} ${e.message}`;
}
