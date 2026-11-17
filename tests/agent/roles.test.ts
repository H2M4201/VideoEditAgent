import { describe, it, expect } from 'vitest';
import { assignRoles } from '../../src/agent/roles';
import type { RoleAssignment } from '../../src/project/roles';
import { FakeModel, turn } from '../helpers/fakeModel';

const defaults: RoleAssignment[] = [
  { path: 'reference/sample.mp4', role: 'style', useAudio: false, decidedBy: 'guess', reason: 'Sample video' },
  { path: 'reference/vo.mp3', role: 'narration', useAudio: false, decidedBy: 'guess', reason: 'Speech' },
];
const ctx = { prompt: 'Make a reel', guideline: '`vo.mp3` is music', defaults };

describe('assignRoles', () => {
  it('roles: guideline decision is kept, unexplained change is reset', async () => {
    const fake = new FakeModel([turn('submit_roles', { roles: [
      { path: 'reference/vo.mp3', role: 'music', useAudio: false, decidedBy: 'guideline', reason: 'guideline says music' },
      { path: 'reference/sample.mp4', role: 'narration', useAudio: false, decidedBy: 'guess', reason: 'hm' },
    ] })]);
    const r = await assignRoles(ctx, fake);
    expect(r.find(x => x.path.endsWith('vo.mp3'))!.role).toBe('music');
    expect(r.find(x => x.path.endsWith('vo.mp3'))!.decidedBy).toBe('guideline');
    expect(r.find(x => x.path.endsWith('sample.mp4'))!.role).toBe('style');
    expect(r.find(x => x.path.endsWith('sample.mp4'))!).toEqual(defaults[0]);
  });

  it('drops unknown paths and keeps defaults for files the model left out', async () => {
    const fake = new FakeModel([turn('submit_roles', { roles: [
      { path: 'reference/other.mp3', role: 'music', useAudio: false, decidedBy: 'prompt', reason: 'x' },
    ] })]);
    const r = await assignRoles(ctx, fake);
    expect(r).toEqual(defaults);
  });

  it('keeps a prompt decision to use a style reference audio', async () => {
    const fake = new FakeModel([turn('submit_roles', { roles: [
      { path: 'reference/sample.mp4', role: 'style', useAudio: true, decidedBy: 'prompt', reason: 'user asked to keep its sound' },
    ] })]);
    const r = await assignRoles(ctx, fake);
    expect(r[0]).toMatchObject({ role: 'style', useAudio: true, decidedBy: 'prompt' });
  });

  it('records the guideline as the source when it confirms a default', async () => {
    const fake = new FakeModel([turn('submit_roles', { roles: [
      { path: 'reference/sample.mp4', role: 'style', useAudio: false, decidedBy: 'guideline', reason: 'guideline: copy captions from sample.mp4' },
    ] })]);
    expect((await assignRoles(ctx, fake))[0]).toMatchObject({ role: 'style', decidedBy: 'guideline', reason: 'guideline: copy captions from sample.mp4' });
  });

  it('resets an invalid role value to the default', async () => {
    const fake = new FakeModel([turn('submit_roles', { roles: [
      { path: 'reference/vo.mp3', role: 'karaoke', useAudio: false, decidedBy: 'guideline', reason: 'x' },
    ] })]);
    expect((await assignRoles(ctx, fake))[1]).toEqual(defaults[1]);
  });

  it('sends prompt, guideline and defaults with the submit_roles tool', async () => {
    const fake = new FakeModel([turn('submit_roles', { roles: [] })]);
    await assignRoles(ctx, fake);
    expect(fake.calls[0].tools.map(t => t.name)).toEqual(['submit_roles']);
    expect(fake.calls[0].system).toContain('`vo.mp3` is music');
    const m = JSON.stringify(fake.calls[0].messages);
    expect(m).toContain('Make a reel');
    expect(m).toContain('reference/sample.mp4');
  });
});
