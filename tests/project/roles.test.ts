import { describe, it, expect } from 'vitest';
import { guessRoles, pickTimingDriver, type RoleAssignment } from '../../src/project/roles';
import type { ProjectScan, MediaInfo } from '../../src/project/scan';
import type { FileAnalysis } from '../../src/analysis';
import type { LinkResult } from '../../src/project/links';

const media = (p: string, kind: 'video' | 'audio', durationSec = 10, hasAudio = true): MediaInfo => ({ path: p, kind, durationSec, hasAudio });
const an = (p: string, audioClass: FileAnalysis['audioClass']): FileAnalysis =>
  ({ path: p, shots: [], transcript: null, audioClass, beatsSec: [], cutsPerMinute: null });
const scan = (refs: MediaInfo[], scripts: { path: string; text: string }[] = [], raw: MediaInfo[] = []): ProjectScan =>
  ({ raw, references: { media: refs, scripts, links: [], images: ['reference/logo.png'] }, guidelinePath: null, warnings: [] });
const byPath = (rs: RoleAssignment[], p: string) => rs.find(r => r.path === p)!;

describe('guessRoles', () => {
  it('maps audio classes, scripts and sample videos to default roles', () => {
    const s = scan([media('reference/a.mp3', 'audio'), media('reference/v.wav', 'audio'), media('reference/q.wav', 'audio'), media('reference/s.mp4', 'video')],
      [{ path: 'reference/script.txt', text: 'hi' }]);
    const rs = guessRoles(s, { 'reference/a.mp3': an('reference/a.mp3', 'music'), 'reference/v.wav': an('reference/v.wav', 'speech'),
      'reference/q.wav': an('reference/q.wav', 'silent') }, []);
    expect(byPath(rs, 'reference/a.mp3')).toMatchObject({ role: 'music', decidedBy: 'guess' });
    expect(byPath(rs, 'reference/v.wav')).toMatchObject({ role: 'narration', decidedBy: 'guess' });
    expect(byPath(rs, 'reference/q.wav').role).toBe('ignore');
    expect(byPath(rs, 'reference/s.mp4')).toMatchObject({ role: 'style', useAudio: false });
    expect(byPath(rs, 'reference/script.txt')).toMatchObject({ role: 'script', useAudio: false });
    expect(rs.every(r => r.decidedBy === 'guess' && r.reason.length > 0)).toBe(true);
    expect(rs.map(r => r.path)).not.toContain('reference/logo.png'); // images are for logo overlays, not roles
  });

  it('sets useAudio false for a sample video that has audio', () => {
    const rs = guessRoles(scan([media('reference/s.mp4', 'video', 30, true)]), { 'reference/s.mp4': an('reference/s.mp4', 'speech') }, []);
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ role: 'style', useAudio: false });
  });

  it('keeps the longest of several narration candidates and ignores the rest', () => {
    const s = scan([media('reference/b.wav', 'audio', 20), media('reference/a.wav', 'audio', 5), media('reference/c.wav', 'audio', 60)]);
    const rs = guessRoles(s, Object.fromEntries(['a', 'b', 'c'].map(n => [`reference/${n}.wav`, an(`reference/${n}.wav`, 'speech')])), []);
    expect(byPath(rs, 'reference/c.wav').role).toBe('narration');
    expect(byPath(rs, 'reference/a.wav')).toMatchObject({ role: 'ignore' });
    expect(byPath(rs, 'reference/b.wav').role).toBe('ignore');
    expect(byPath(rs, 'reference/a.wav').reason).toMatch(/narration/i);
  });

  it('ignores audio missing from analysis or with null class', () => {
    const s = scan([media('reference/x.mp3', 'audio'), media('reference/y.mp3', 'audio')]);
    const rs = guessRoles(s, { 'reference/y.mp3': an('reference/y.mp3', null) }, []);
    expect(rs.map(r => r.role)).toEqual(['ignore', 'ignore']);
    expect(rs.every(r => r.reason.length > 0)).toBe(true);
  });

  it('adds successful downloads as style, skips failed ones, and sorts by path', () => {
    const dl: LinkResult[] = [{ url: 'u1', ok: true, path: '.vea/downloads/abc.mp4' }, { url: 'u2', ok: false, error: 'nope' }];
    const rs = guessRoles(scan([media('reference/z.mp4', 'video')]), {}, dl);
    expect(rs.map(r => r.path)).toEqual(['.vea/downloads/abc.mp4', 'reference/z.mp4']);
    expect(rs[0]).toMatchObject({ role: 'style', useAudio: false, decidedBy: 'guess' });
  });
});

describe('pickTimingDriver', () => {
  const role = (r: RoleAssignment['role']): RoleAssignment => ({ path: 'p', role: r, useAudio: false, decidedBy: 'guess', reason: 'x' });
  it('follows the spec order', () => {
    expect(pickTimingDriver([role('narration'), role('music')], [an('raw/a.mp4', 'speech')])).toBe('narration');
    expect(pickTimingDriver([role('music')], [an('raw/a.mp4', 'speech')])).toBe('footageSpeech');
    expect(pickTimingDriver([role('music')], [an('raw/a.mp4', 'music')])).toBe('music');
    expect(pickTimingDriver([role('style')], [an('raw/a.mp4', null)])).toBe('pace');
  });
});
