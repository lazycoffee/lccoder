/**
 * 任务分发器
 * 将计划中的子任务转化为指令，分发给办事员执行
 */
import type { Plan, SubTask } from '../schemas/plan.js';
import type { Instruction } from '../schemas/instruction.js';
import type { Result } from '../schemas/result.js';
import type { Evaluation, QaReport } from '../schemas/result.js';
import { Clerk } from '../roles/clerk.js';
import { QaEngineer } from '../roles/qa-engineer.js';
import { Evaluator } from '../roles/evaluator.js';
import { Verifier, type VerificationReport } from './verifier.js';
import type { LLMProvider } from '../llm/provider.js';
import type { ToolConfirmCallback } from '../roles/base-role.js';

import { type SessionRecord } from '../llm/session.js';
export type VerificationProfile = 'coding' | 'debug';

export interface DispatchResult {
  task: SubTask;
  result: Result | null;
  qaReport: QaReport | null;
  evaluation: Evaluation | null;
  verification: VerificationReport | null;
  clerkSession?: SessionRecord;
  qaSession?: SessionRecord;
  evaluatorSession?: SessionRecord;
}

export class Dispatcher {
  private clerkProvider: LLMProvider;
  private evaluatorProvider: LLMProvider;
  private qaProvider: LLMProvider;
  private clerkModel: string;
  private qaModel: string;
  private evaluatorModel: string;
  private promptsDir?: string;
  private maxRetries: number;
  private onToolConfirm?: ToolConfirmCallback;
  private enableVerification: boolean;
  private workingDir: string;
  private verificationProfile: VerificationProfile;

  constructor(params: {
    clerkProvider: LLMProvider;
    qaProvider: LLMProvider;
    evaluatorProvider: LLMProvider;
    clerkModel: string;
    qaModel: string;
    evaluatorModel: string;
    promptsDir?: string;
    maxRetries?: number;
    onToolConfirm?: ToolConfirmCallback;
    enableVerification?: boolean;
    workingDir?: string;
    verificationProfile?: VerificationProfile;
  }) {
    this.clerkProvider = params.clerkProvider;
    this.qaProvider = params.qaProvider;
    this.evaluatorProvider = params.evaluatorProvider;
    this.clerkModel = params.clerkModel;
    this.qaModel = params.qaModel;
    this.evaluatorModel = params.evaluatorModel;
    this.promptsDir = params.promptsDir;
    this.maxRetries = params.maxRetries ?? 2;
    this.onToolConfirm = params.onToolConfirm;
    this.enableVerification = params.enableVerification ?? true;
    this.workingDir = params.workingDir || process.cwd();
    this.verificationProfile = params.verificationProfile ?? 'coding';
  }

  /**
   * 将子任务转化为办事员指令
   */
  createInstruction(task: SubTask): Instruction {
    return {
      task_id: task.id,
      type: task.type,
      title: task.title,
      instructions: task.instructions,
      input_files: task.input_files,
      output_files: task.output_files,
      code_template: task.code_template,
      verification: task.verification,
      context: task.description,
    };
  }

  /**
   * 分发并执行一个子任务
   * 每次调用都创建全新的 Clerk 和 Evaluator 会话
   */
  async dispatchTask(task: SubTask, plan: Plan): Promise<DispatchResult> {
    const instruction = this.createInstruction(task);

    // 创建全新的办事员执行
    const clerk = new Clerk(this.clerkProvider, this.clerkModel, this.promptsDir, {
      maxRetries: this.maxRetries,
      onToolConfirm: this.onToolConfirm,
      workingDir: this.workingDir,
    });
    const clerkOutput = await clerk.executeTask(instruction);

    let result: Result | null = clerkOutput.result || null;

    // 如果办事员没有返回有效的结果报告，构建一个基本报告
    if (!result) {
      result = {
        task_id: task.id,
        executed_by: 'clerk',
        timestamp: new Date().toISOString(),
        status: 'failed',
        changes_made: [],
        output_summary: clerkOutput.text.slice(0, 500),
        error: '办事员未返回有效的执行结果报告',
      };
    }

    // ===== 自动验证层 =====
    let verification: VerificationReport | null = null;
    if (this.enableVerification && result.status === 'success') {
      // 中间编码任务只跑基础验证，verify 任务再跑完整测试链
      const shouldVerify = ['write', 'modify', 'shell', 'verify'].includes(task.type);
      if (shouldVerify) {
        const verifier = new Verifier(this.workingDir);
        const includeTests = this.verificationProfile === 'debug'
          ? ['write', 'modify', 'shell', 'verify'].includes(task.type)
          : task.type === 'verify';
        verification = await verifier.verify({
          includeTypeCheck: true,
          includeLint: true,
          includeTests,
          profile: this.verificationProfile,
        });

        // 如果验证失败，更新结果状态并补充信息
        if (!verification.allPassed) {
          const failedChecks = verification.checks
            .filter(c => !c.passed)
            .map(c => `${c.name}: ${c.output.slice(0, 200)}`)
            .join('\n');

          result = {
            ...result,
            status: 'failed',
            error: `${this.verificationProfile === 'debug' ? '调试验证失败' : '代码验证失败'}:\n${failedChecks}`,
            notes_for_pm: `${this.verificationProfile === 'debug' ? '调试验证发现问题' : '自动验证发现问题'}:\n${failedChecks}`,
          };
        } else {
          // 验证通过，补充信息
          const passedChecks = verification.checks.map(c => c.name).join(', ');
          result = {
            ...result,
            notes_for_pm: (result.notes_for_pm || '') +
              `\n✓ ${this.verificationProfile === 'debug' ? '调试验证通过' : '自动验证通过'}: ${passedChecks}`,
          };
        }
      }
    }

    // ===== QA 复核层 =====
    const qaEngineer = new QaEngineer(this.qaProvider, this.qaModel, this.promptsDir, {
      maxRetries: this.maxRetries,
      workingDir: this.workingDir,
    });
    const qaOutput = await qaEngineer.review(task, plan, result, verification);

    // 创建全新的评估器评估
    const evaluator = new Evaluator(this.evaluatorProvider, this.evaluatorModel, this.promptsDir, {
      maxRetries: this.maxRetries,
    });
    const evalOutput = await evaluator.evaluate(result, plan, qaOutput.report || null);

    return {
      task,
      result,
      qaReport: qaOutput.report || null,
      evaluation: evalOutput.evaluation || null,
      verification,
      clerkSession: clerkOutput.sessionRecord,
      qaSession: qaOutput.sessionRecord,
      evaluatorSession: evalOutput.sessionRecord,
    };
  }
}
