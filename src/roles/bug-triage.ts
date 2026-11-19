import { BaseRole, type ToolConfirmCallback } from './base-role.js';
import { BugReportSchema, type BugReport } from '../schemas/bug-report.js';
import type { LLMProvider } from '../llm/provider.js';
import type { RoleOutput } from './base-role.js';

export class BugTriage extends BaseRole {
  constructor(
    provider: LLMProvider,
    model: string,
    promptsDir?: string,
    options?: { maxRetries?: number; onToolConfirm?: ToolConfirmCallback; workingDir?: string },
  ) {
    super({
      roleName: 'bug-triage',
      promptFileName: 'bug-triage.md',
      provider,
      model,
      promptsDir,
      maxRetries: options?.maxRetries,
      onToolConfirm: options?.onToolConfirm,
      workingDir: options?.workingDir,
    });
  }

  async analyze(userInput: string): Promise<RoleOutput & { bugReport?: BugReport }> {
    const result = await this.execute({
      userMessage: `用户反馈了一个问题。请先理解项目上下文，再输出结构化 bug 报告。\n\n${userInput}`,
    });

    if (result.document) {
      try {
        const bugReport = BugReportSchema.parse(result.document);
        return { ...result, bugReport };
      } catch {
        return result;
      }
    }

    return result;
  }
}
