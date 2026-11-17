import { expect, test } from 'vitest';
import { builtinEngine, getEngine, listEngines } from '../../src/engines/registry';

test('registry lists builtin as available', async () => {
  expect((await getEngine('builtin').availability()).available).toBe(true);
  expect(() => getEngine('x')).toThrow();
});

test('listEngines includes the builtin engine', () => {
  expect(listEngines().map((e) => e.id)).toContain('builtin');
  expect(getEngine('builtin')).toBe(builtinEngine);
});

test('builtin capabilities', () => {
  expect(builtinEngine.capabilities()).toEqual({
    transitions: ['cut', 'fade', 'slide', 'zoom'],
    effects: ['pushIn', 'pushOut'],
    captionAnimations: ['line', 'word'],
  });
});
