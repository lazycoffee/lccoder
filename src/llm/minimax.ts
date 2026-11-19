/**
 * MiniMax 提供商实现
 * 通过 OpenAI SDK 的兼容接口接入 MiniMax。
 */
import OpenAI from 'openai';
import type { Message } from 'ollama';
import type { LLMProvider, LLMResponse, ToolDefinition, ToolCall } from './provider.js';

const DEFAULT_MINIMAX_BASE_URL = 'https://api.minimaxi.com/v1';

export class MiniMaxProvider implements LLMProvider {
  private client: OpenAI;

  constructor(apiKey: string, baseURL: string = DEFAULT_MINIMAX_BASE_URL) {
    this.client = new OpenAI({
      apiKey,
      baseURL,
    });
  }

  private convertMessages(system: string, messages: Message[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: system },
    ];

    for (const msg of messages) {
      if (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system' || msg.role === 'tool') {
        msgs.push({
          role: msg.role as any,
          content: msg.content,
        });
      }
    }

    return msgs;
  }

  private normalizeContent(content: string | null | undefined): string {
    if (!content) return '';
    return content.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '').trim();
  }

  async chat(params: {
    model: string;
    system: string;
    messages: Message[];
  }): Promise<LLMResponse> {
    const messages = this.convertMessages(params.system, params.messages);

    const response = await this.client.chat.completions.create({
      model: params.model,
      messages,
      temperature: 0.1,
    });

    return {
      content: this.normalizeContent(response.choices[0]?.message?.content),
    };
  }

  async chatWithTools(params: {
    model: string;
    system: string;
    messages: Message[];
    tools: ToolDefinition[];
  }): Promise<LLMResponse> {
    const messages = this.convertMessages(params.system, params.messages);
    const tools = params.tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters as any,
      },
    }));

    const response = await this.client.chat.completions.create({
      model: params.model,
      messages,
      tools,
      temperature: 0.1,
    });

    const choice = response.choices[0];
    const message = choice?.message;

    const toolCalls: ToolCall[] = [];
    if (message?.tool_calls) {
      for (const tc of message.tool_calls) {
        if (tc.type === 'function') {
          toolCalls.push({
            name: tc.function.name,
            arguments: JSON.parse(tc.function.arguments || '{}'),
          });
        }
      }
    }

    return {
      content: this.normalizeContent(message?.content),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  async checkHealth(model: string): Promise<{
    connected: boolean;
    modelAvailable: boolean;
    error?: string;
  }> {
    try {
      await this.client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 1,
      });
      return { connected: true, modelAvailable: true };
    } catch (err: any) {
      if (err.status === 401) {
        return {
          connected: true,
          modelAvailable: false,
          error: 'MiniMax API Key 无效或未授权',
        };
      }

      return {
        connected: false,
        modelAvailable: false,
        error: err.message || 'Failed to connect to MiniMax API',
      };
    }
  }
}
