import { builtinEngine } from './builtin/render';
import type { Engine } from './types';

export { builtinEngine };

const ENGINES: Engine[] = [builtinEngine];

export function listEngines(): Engine[] {
  return [...ENGINES];
}

/** Throws on an unknown engine id. */
export function getEngine(id: string): Engine {
  const e = ENGINES.find((x) => x.id === id);
  if (!e) throw new Error(`unknown engine "${id}" (known: ${ENGINES.map((x) => x.id).join(', ')})`);
  return e;
}
