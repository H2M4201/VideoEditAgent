import { cancelRender, continueRender, delayRender, staticFile } from 'remotion';
import { DEFAULT_FONT } from './media';

// Vietnamese and Latin subsets of Be Vietnam Pro (assets/fonts, served as the bundle's public dir).
const VIETNAMESE = 'U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB';
const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';

let loaded = false;

/** Registers Be Vietnam Pro 400/700 and holds the render until the font files are loaded. Idempotent. */
export function loadFonts(): void {
  if (loaded) return;
  loaded = true;
  const handle = delayRender(`Loading ${DEFAULT_FONT}`);
  const faces = (['latin', 'vietnamese'] as const).flatMap((subset) => (['400', '700'] as const).map((weight) =>
    new FontFace(DEFAULT_FONT, `url(${staticFile(`fonts/be-vietnam-pro-${subset}-${weight}-normal.woff2`)}) format('woff2')`,
      { weight, style: 'normal', unicodeRange: subset === 'latin' ? LATIN : VIETNAMESE })));
  Promise.all(faces.map((f) => f.load()))
    .then(() => { faces.forEach((f) => document.fonts.add(f)); continueRender(handle); })
    .catch((err: unknown) => cancelRender(new Error(`could not load bundled ${DEFAULT_FONT}: ${String(err)}`)));
}
