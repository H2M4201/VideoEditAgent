import { expect, test } from 'vitest';
import { estimateCost } from '../../src/agent/cost';
import type { FileAnalysis } from '../../src/analysis';
import type { RoleAssignment } from '../../src/project/roles';
import type { ProjectScan } from '../../src/project/scan';
import { generateCost } from '../../src/server/pipeline';
import { DEFAULT_SETTINGS } from '../../src/server/settings';

test('the generate cost estimate counts only the frames that will be sent (at most 100, style at most 12)', () => {
  const shots = (n: number) => Array.from({ length: n }, (_, i) => ({ index: i, startSec: i, endSec: i + 1, framePath: '/f.jpg' }));
  const an = (path: string, n: number): FileAnalysis => ({ path, shots: shots(n), transcript: null, audioClass: null, beatsSec: [], cutsPerMinute: null });
  const scan: ProjectScan = {
    raw: [{ path: 'raw/a.mp4', kind: 'video', durationSec: 200, hasAudio: false }],
    references: { media: [{ path: 'reference/s.mp4', kind: 'video', durationSec: 60, hasAudio: false }], scripts: [], links: [], images: [] },
    guidelinePath: null, warnings: [],
  };
  const analysis = { 'raw/a.mp4': an('raw/a.mp4', 150), 'reference/s.mp4': an('reference/s.mp4', 30) };
  const roles: RoleAssignment[] = [{ path: 'reference/s.mp4', role: 'style', useAudio: false, decidedBy: 'guess', reason: 'x' }];
  const noFrames = generateCost(DEFAULT_SETTINGS, 'p', null, roles, { scan, analysis: {} });
  const cost = generateCost(DEFAULT_SETTINGS, 'p', null, roles, { scan, analysis });
  const frameTokens = estimateCost({ frames: 100, textChars: 0, inputPricePerMTok: 0, outputPricePerMTok: 0 }).inputTokens;
  expect(cost.inputTokens - noFrames.inputTokens).toBe(frameTokens);
});
