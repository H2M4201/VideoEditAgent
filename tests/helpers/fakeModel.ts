import type { AgentModel, ModelTurn, ToolDef } from '../../src/agent/model';

/** Builds a ModelTurn holding one tool call. */
export function turn(name: string, input: unknown, text = ''): ModelTurn {
  return { toolCalls: [{ id: `call_${name}_${Math.random().toString(36).slice(2, 8)}`, name, input }], text, usage: { input: 100, output: 50 } };
}

/** Returns its scripted turns in order and records every request. */
export class FakeModel implements AgentModel {
  calls: { system: string; messages: unknown[]; tools: ToolDef[] }[] = [];
  private next = 0;
  constructor(private script: ModelTurn[]) {}

  async run(req: { system: string; messages: unknown[]; tools: ToolDef[] }): Promise<ModelTurn> {
    this.calls.push({ system: req.system, messages: structuredClone(req.messages), tools: req.tools });
    if (this.next >= this.script.length) throw new Error(`FakeModel: asked for turn ${this.next + 1} but only ${this.script.length} scripted`);
    return this.script[this.next++];
  }
}
