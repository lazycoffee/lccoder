/**
 * QA Engineer 角色
 * 负责基于任务目标、执行结果和验证输出生成结构化测试报告
 */
import { BaseRole, type ToolConfirmCallback } from './base-role.js';
import { QaReportSchema, type QaReport, type Result } from '../schemas/result.js';
import type { Plan, SubTask } from '../schemas/plan.js';
import type { LLMProvider } from '../llm/provider.js';
import type { RoleOutput } from './base-role.js';
import type { VerificationReport } from '../pipeline/verifier.js';

export class QaEngineer extends BaseRole {
  constructor(
    provider: LLMProvider,
    model: string,
    promptsDir?: string,
    options?: { maxRetries?: number; onToolConfirm?: ToolConfirmCallback; workingDir?: string },
  ) {
    super({
      roleName: 'qa-engineer',
      promptFileName: 'qa-engineer.md',
      provider,
      model,
      promptsDir,
      maxRetries: options?.maxRetries,
      onToolConfirm: options?.onToolConfirm,
      workingDir: options?.workingDir,
    });
  }

  /**
   * 对任务执行结果做 QA 复核
   */
  async review(
    task: SubTask,
    plan: Plan,
    result: Result,
    verification: VerificationReport | null,
  ): Promise<RoleOutput & { report?: QaReport }> {
    const output = await this.execute({
      userMessage:
        '请以 QA 工程师视角复核当前任务的实现结果。结合任务目标、执行结果、自动验证报告和真实代码产物，输出结构化测试报告。',
      document: {
        task,
        result,
        verification,
        plan_summary: {
          plan_id: plan.id,
          plan_summary: plan.summary,
          critical_path: plan.critical_path,
        },
      },
    });

    if (output.document) {
      try {
        const report = QaReportSchema.parse(output.document);
        return { ...output, report };
      } catch {
        // Schema 校验失败
      }
    }

    return output;
  }
}
