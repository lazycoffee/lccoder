import { BaseRole } from './base-role.js';
import type { LLMProvider } from '../llm/provider.js';

export class DirectAnswerRole extends BaseRole {
  constructor(
    provider: LLMProvider,
    model: string,
    promptsDir?: string,
    options?: { workingDir?: string },
  ) {
    super({
      roleName: 'direct-answer',
      promptFileName: 'direct-answer.md',
      provider,
      model,
      promptsDir,
      maxRetries: 0,
      workingDir: options?.workingDir,
    });
  }
}
