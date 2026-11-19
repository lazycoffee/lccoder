/**
 * LLM 提供商工厂
 * 负责根据配置为不同角色创建和管理 LLMProvider 实例
 */
import type { LLMProvider } from './provider.js';
import { OllamaProvider } from './ollama.js';
import { MiniMaxProvider } from './minimax.js';
import { type LccoderConfig, getProviderForRole } from '../config/index.js';

export interface ProviderResolver {
  getProviderForRole(role: string): LLMProvider;
}

export class ProviderFactory implements ProviderResolver {
  private providers: Map<string, LLMProvider> = new Map();
  private config: LccoderConfig;

  constructor(config: LccoderConfig) {
    this.config = config;
  }

  /**
   * 获取指定角色的 LLM 提供商
   */
  getProviderForRole(role: string): LLMProvider {
    const providerType = getProviderForRole(this.config, role);
    
    // 目前每个提供商类型共享同一个实例（因为配置是全局的）
    // 如果未来支持为每个角色配置不同的 API Key/BaseURL，这里可以根据配置内容生成 Key
    const key = providerType;
    
    if (this.providers.has(key)) {
      return this.providers.get(key)!;
    }

    let provider: LLMProvider;
    if (providerType === 'minimax') {
      if (!this.config.minimax?.apiKey) {
        throw new Error('未配置 MiniMax API Key，请在 .lccoder/config.json 或 MINIMAX_API_KEY 中设置');
      }
      provider = new MiniMaxProvider(this.config.minimax.apiKey, this.config.minimax.baseURL);
    } else {
      provider = new OllamaProvider(this.config.ollamaHost);
    }

    this.providers.set(key, provider);
    return provider;
  }

  /**
   * 获取默认提供商
   */
  getDefaultProvider(): LLMProvider {
    const defaultType = this.config.provider || 'ollama';
    return this.getProviderForRole('__default__');
  }
}
