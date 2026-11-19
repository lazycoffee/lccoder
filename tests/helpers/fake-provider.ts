import type { Message } from 'ollama';
import type { LLMProvider, LLMResponse, ToolDefinition } from '../../src/llm/provider.js';

interface FakeProviderCall {
  kind: 'chat' | 'chatWithTools';
  model: string;
  system: string;
  messages: Message[];
  tools?: ToolDefinition[];
}

export class FakeProvider implements LLMProvider {
  readonly calls: FakeProviderCall[] = [];
  private responses: LLMResponse[];

  constructor(responses: LLMResponse[]) {
    this.responses = [...responses];
  }

  async chat(params: {
    model: string;
    system: string;
    messages: Message[];
  }): Promise<LLMResponse> {
    this.calls.push({
      kind: 'chat',
      model: params.model,
      system: params.system,
      messages: [...params.messages],
    });
    return this.nextResponse();
  }

  async chatWithTools(params: {
    model: string;
    system: string;
    messages: Message[];
    tools: ToolDefinition[];
  }): Promise<LLMResponse> {
    this.calls.push({
      kind: 'chatWithTools',
      model: params.model,
      system: params.system,
      messages: [...params.messages],
      tools: params.tools,
    });
    return this.nextResponse();
  }

  async checkHealth(): Promise<{ connected: boolean; modelAvailable: boolean; error?: string }> {
    return {
      connected: true,
      modelAvailable: true,
    };
  }

  private nextResponse(): LLMResponse {
    const response = this.responses.shift();
    if (!response) {
      throw new Error('FakeProvider response queue exhausted');
    }
    return response;
  }
}

export function jsonResponse(document: unknown): LLMResponse {
  return {
    content: `\`\`\`json\n${JSON.stringify(document, null, 2)}\n\`\`\``,
  };
}
