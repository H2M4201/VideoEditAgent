import type { Role, RoleAssignment } from '../project/roles';
import type { AgentModel, ToolDef } from './model';
import { authorityPrompt } from './prompt';

const ROLES: Role[] = ['narration', 'music', 'style', 'script', 'ignore'];

export const SUBMIT_ROLES: ToolDef = {
  name: 'submit_roles',
  description: 'Submit the role of every reference file and who decided it.',
  input_schema: {
    type: 'object',
    properties: {
      roles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            role: { type: 'string', enum: ROLES },
            useAudio: { type: 'boolean' },
            decidedBy: { type: 'string', enum: ['guideline', 'prompt', 'guess'] },
            reason: { type: 'string' },
          },
          required: ['path', 'role', 'useAudio', 'decidedBy', 'reason'],
        },
      },
    },
    required: ['roles'],
  },
};

const ROLES_TASK = `# Task: reference roles

Decide the role of each reference file: narration (speech the footage is cut to), music (cuts land on its beat), style (a sample to imitate: pace, structure, caption look, transitions), script (caption wording and story order) or ignore.
useAudio is true only for a style reference whose own audio should be used, and only when the guideline or the prompt explicitly says so.
Change a default only when the guideline or the user's prompt says so, and set decidedBy to "guideline" or "prompt" accordingly with a short reason quoting it. Otherwise return the default unchanged.
Answer only by calling submit_roles with every file.`;

/** Applies guideline/prompt decisions on top of the defaults; an unexplained ("guess") change is reset to the default. */
export async function assignRoles(ctx: { prompt: string; guideline: string | null; defaults: RoleAssignment[] }, model: AgentModel): Promise<RoleAssignment[]> {
  const system = `${authorityPrompt(ctx.guideline)}\n\n${ROLES_TASK}`;
  const user = `# User prompt\n\n${ctx.prompt}\n\n# Default roles\n\n${JSON.stringify(ctx.defaults, null, 2)}`;
  const turn = await model.run({ system, messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], tools: [SUBMIT_ROLES] });
  const input = turn.toolCalls.find(c => c.name === 'submit_roles')?.input as { roles?: unknown } | undefined;
  const returned = Array.isArray(input?.roles) ? (input.roles as Partial<RoleAssignment>[]) : [];

  return ctx.defaults.map(d => {
    const r = returned.find(x => x && x.path === d.path);
    if (!r || !ROLES.includes(r.role as Role)) return d;
    if (r.decidedBy !== 'guideline' && r.decidedBy !== 'prompt') return d;
    return { path: d.path, role: r.role as Role, useAudio: r.role === 'style' && r.useAudio === true, decidedBy: r.decidedBy,
      reason: typeof r.reason === 'string' && r.reason ? r.reason : `Set by the ${r.decidedBy}` };
  });
}
