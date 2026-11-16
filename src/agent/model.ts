import Anthropic from '@anthropic-ai/sdk';

export type ToolDef = { name: string; description: string; input_schema: object };
export type ModelTurn = {
  toolCalls: { id: string; name: string; input: unknown }[];
  text: string;
  usage: { input: number; output: number };
  /** The assistant message content exactly as the API returned it (incl. thinking blocks), replayed unchanged on the next request. */
  assistantContent?: unknown[];
};
export interface AgentModel { run(req: { system: string; messages: unknown[]; tools: ToolDef[] }): Promise<ModelTurn>; }

export class AgentError extends Error {
  constructor(public code: 'NO_API_KEY' | 'INVALID_AFTER_RETRIES' | 'API_ERROR' | 'API_KEY_REJECTED' | 'API_RATE_LIMIT', message: string) {
    super(message); this.name = 'AgentError';
  }
}

export const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_TOKENS = 16000;

/** Claude via the Messages API. `messages` must already be Anthropic message params (text, base64 image, tool_use, tool_result blocks). */
export class AnthropicModel implements AgentModel {
  private client: Anthropic | null;
  private model: string;

  constructor(o: { apiKey: string; model: string }) {
    this.client = o.apiKey ? new Anthropic({ apiKey: o.apiKey }) : null;
    this.model = o.model || DEFAULT_MODEL;
  }

  async run(req: { system: string; messages: unknown[]; tools: ToolDef[] }): Promise<ModelTurn> {
    if (!this.client) throw new AgentError('NO_API_KEY', 'No Anthropic API key is set');
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: req.system,
        messages: req.messages as Anthropic.MessageParam[],
        tools: req.tools as Anthropic.Tool[],
        // claude-opus-5-5 rejects forced tool_choice ('any'/'tool') with a 400; the prompt names the tool to call instead.
        tool_choice: { type: 'auto' },
      });
    } catch (e) {
      // The SDK's APIError carries the HTTP status; connection failures have none.
      const status = (e as { status?: unknown }).status;
      const message = (e as Error).message;
      if (typeof status !== 'number') throw new AgentError('API_ERROR', message);
      const code = status === 401 || status === 403 ? 'API_KEY_REJECTED' : status === 429 ? 'API_RATE_LIMIT' : 'API_ERROR';
      throw new AgentError(code, message.startsWith(`${status}`) ? message : `${status}: ${message}`);
    }
    if (res.stop_reason === 'refusal') throw new AgentError('API_ERROR', 'The model declined the request');
    const toolCalls: ModelTurn['toolCalls'] = [];
    let text = '';
    for (const b of res.content) {
      if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, input: b.input });
      else if (b.type === 'text') text += b.text;
    }
    return { toolCalls, text, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens }, assistantContent: res.content };
  }
}
