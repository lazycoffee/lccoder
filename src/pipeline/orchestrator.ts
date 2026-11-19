/**
 * 流水线编排器
 * 整个工具的核心——硬编码的流程控制
 */
import { classifyRequest } from './classifier.js';
import { Dispatcher, type DispatchResult } from './dispatcher.js';
import { ProductManager } from '../roles/product-manager.js';
import { ProjectManager } from '../roles/project-manager.js';
import { DirectAnswerRole } from '../roles/direct-answer.js';
import { BugTriage } from '../roles/bug-triage.js';
import { DocumentStore } from '../documents/store.js';
import type { ProviderResolver } from '../llm/factory.js';
import type { LccoderConfig } from '../config/index.js';
import { getModelForRole } from '../config/index.js';
import { extractProjectContext, formatContextForPrompt } from './context.js';
import type { Requirement } from '../schemas/requirement.js';
import type { Plan } from '../schemas/plan.js';
import type { BugReport } from '../schemas/bug-report.js';
import type { Summary } from '../schemas/result.js';
import type { ToolConfirmCallback } from '../roles/base-role.js';
import type { VerificationReport } from './verifier.js';
import type { RequestedMode } from '../schemas/route.js';
import {
  type PipelineState,
  createPipelineState,
  savePipelineState,
  clearPipelineState,
} from './state.js';
import { requiresConfirmation } from '../tools/safety.js';

/** 流水线事件回调 */
export interface PipelineCallbacks {
  onStageStart: (stage: string, description: string) => void;
  onStageComplete: (stage: string, durationMs?: number) => void;
  onQuestion: (questions: string[]) => Promise<Record<string, string>>;
  onRequirementReview: (requirement: Requirement) => Promise<boolean>;
  onPlanReview: (plan: Plan) => Promise<boolean>;
  onTaskStart: (taskId: string, title: string, index: number, total: number) => void;
  onTaskComplete: (taskId: string, success: boolean, summary: string) => void;
  onPause: (reason: string) => Promise<'continue' | 'abort'>;
  onSimpleResponse: (response: string) => void;
  onSummary: (summary: Summary) => void;
  onError: (error: string) => void;
  /** 工具执行安全确认 */
  onToolConfirm?: (toolName: string, args: Record<string, unknown>, reason: string) => Promise<boolean>;
  /** 验证结果回调 */
  onVerification?: (taskId: string, report: VerificationReport) => void;
}

export class Orchestrator {
  private factory: ProviderResolver;
  private config: LccoderConfig;
  private store: DocumentStore;
  private callbacks: PipelineCallbacks;
  private promptsDir?: string;

  constructor(params: {
    factory: ProviderResolver;
    config: LccoderConfig;
    store: DocumentStore;
    callbacks: PipelineCallbacks;
    promptsDir?: string;
  }) {
    this.factory = params.factory;
    this.config = params.config;
    this.store = params.store;
    this.callbacks = params.callbacks;
    this.promptsDir = params.promptsDir;
  }

  /**
   * 构建工具确认回调（桥接安全模块和 CLI 回调）
   */
  private buildToolConfirm(): ToolConfirmCallback | undefined {
    const cb = this.callbacks.onToolConfirm;
    if (!cb) return undefined;

    const config = this.config;
    return async (toolName: string, args: Record<string, unknown>) => {
      const check = requiresConfirmation(toolName, args, config);
      if (!check.needsConfirm) return true;
      return cb(toolName, args, check.reason || `工具 ${toolName} 需要确认`);
    };
  }

  /**
   * 运行完整的流水线
   */
  async run(userInput: string, requestedMode: RequestedMode = 'auto'): Promise<void> {
    await this.store.init();

    // 自动提取项目上下文
    const projectContext = await extractProjectContext(this.config.safety.workingDir);
    const contextPrompt = formatContextForPrompt(projectContext);

    const state = createPipelineState(userInput);
    const stageStart = Date.now();

    // ==========================================
    // Step 0: 分类
    // ==========================================
    this.callbacks.onStageStart('classifier', '正在分析请求复杂度...');
    const classification = await classifyRequest(
      userInput,
      this.factory.getProviderForRole('classifier'),
      getModelForRole(this.config, 'classifier'),
      this.promptsDir,
      requestedMode,
    );
    if (classification.sessionRecord) {
      await this.store.saveSession(classification.sessionRecord);
    }
    state.classification = classification.decision;
    state.requestMode = classification.decision.mode;
    state.pipelineType = classification.decision.pipelineType;
    state.currentStage = classification.decision.pipelineType === 'debug-pipeline' ? 'triage' : 'pm';
    await savePipelineState(state, this.store);
    this.callbacks.onStageComplete('classifier', Date.now() - stageStart);

    const onToolConfirm = this.buildToolConfirm();

    switch (classification.decision.pipelineType) {
      case 'direct-answer':
        await this.runDirectAnswer(userInput);
        break;
      case 'debug-pipeline':
        await this.runDebugPipeline(userInput, state, contextPrompt, onToolConfirm);
        break;
      case 'coding-pipeline':
      default:
        await this.runCodingPipeline(userInput, state, contextPrompt, onToolConfirm);
        break;
    }

    await clearPipelineState(this.store);
  }

  private async runDirectAnswer(userInput: string): Promise<void> {
    this.callbacks.onStageStart('direct-answer', '正在回答...');
    const answerStart = Date.now();
    const assistant = new DirectAnswerRole(
      this.factory.getProviderForRole('direct-answer'),
      getModelForRole(this.config, 'direct-answer'),
      this.promptsDir,
      { workingDir: this.config.safety.workingDir },
    );
    const answer = await assistant.execute({ userMessage: userInput });
    if (answer.sessionRecord) {
      await this.store.saveSession(answer.sessionRecord);
    }
    this.callbacks.onSimpleResponse(answer.text);
    this.callbacks.onStageComplete('direct-answer', Date.now() - answerStart);
  }

  private async runCodingPipeline(
    userInput: string,
    state: PipelineState,
    contextPrompt: string,
    onToolConfirm?: ToolConfirmCallback,
  ): Promise<void> {
    const requirement = await this.runRequirementStage(userInput, contextPrompt, onToolConfirm);
    if (!requirement) return;

    state.requirement = requirement;
    state.currentStage = 'pjm';
    await savePipelineState(state, this.store);

    const requirementApproved = await this.callbacks.onRequirementReview(requirement);
    if (!requirementApproved) {
      this.callbacks.onError('用户取消了需求。');
      return;
    }

    const plan = await this.runProjectPlanStage(requirement, contextPrompt, onToolConfirm);
    if (!plan) return;

    state.plan = plan;
    state.currentStage = 'dispatch';
    await savePipelineState(state, this.store);

    const planApproved = await this.callbacks.onPlanReview(plan);
    if (!planApproved) {
      this.callbacks.onError('用户取消了工作计划。');
      return;
    }

    await this.executeTasks(state, onToolConfirm);
  }

  private async runDebugPipeline(
    userInput: string,
    state: PipelineState,
    contextPrompt: string,
    onToolConfirm?: ToolConfirmCallback,
  ): Promise<void> {
    const bugReport = await this.runBugTriageStage(userInput, contextPrompt, onToolConfirm);
    if (!bugReport) return;

    state.bugReport = bugReport;
    state.currentStage = 'pjm';
    await savePipelineState(state, this.store);

    const bugReportApproved = await this.callbacks.onRequirementReview(this.bugReportAsRequirement(bugReport));
    if (!bugReportApproved) {
      this.callbacks.onError('用户取消了 bug 报告。');
      return;
    }

    const plan = await this.runDebugPlanStage(bugReport, contextPrompt, onToolConfirm);
    if (!plan) return;

    state.plan = plan;
    state.currentStage = 'dispatch';
    await savePipelineState(state, this.store);

    const planApproved = await this.callbacks.onPlanReview(plan);
    if (!planApproved) {
      this.callbacks.onError('用户取消了修复计划。');
      return;
    }

    await this.executeTasks(state, onToolConfirm);
  }

  private async runRequirementStage(
    userInput: string,
    contextPrompt: string,
    onToolConfirm?: ToolConfirmCallback,
  ): Promise<Requirement | null> {
    const pmStart = Date.now();
    this.callbacks.onStageStart('product-manager', '产品经理正在分析需求...');
    const pm = new ProductManager(
      this.factory.getProviderForRole('product-manager'),
      getModelForRole(this.config, 'product-manager'),
      this.promptsDir,
      {
        maxRetries: this.config.execution.maxRetries,
        onToolConfirm,
        workingDir: this.config.safety.workingDir,
      },
    );
    let pmResult = await pm.analyze(`${contextPrompt}\n\n用户的需求如下：\n\n${userInput}`);
    if (pmResult.sessionRecord) {
      await this.store.saveSession(pmResult.sessionRecord);
    }
    this.callbacks.onStageComplete('product-manager', Date.now() - pmStart);

    if (pmResult.questions && pmResult.questions.length > 0) {
      const answers = await this.callbacks.onQuestion(pmResult.questions);
      const refineStart = Date.now();
      this.callbacks.onStageStart('product-manager', '正在完善需求分析...');
      pmResult = await pm.refineWithAnswers(userInput, pmResult.document || {}, answers);
      if (pmResult.sessionRecord) {
        await this.store.saveSession(pmResult.sessionRecord);
      }
      this.callbacks.onStageComplete('product-manager', Date.now() - refineStart);
    }

    if (!pmResult.requirement) {
      this.callbacks.onError('产品经理未能生成有效的需求分析报告。');
      return null;
    }

    await this.store.saveDocument(`requirement-${pmResult.requirement.id}`, pmResult.requirement);
    return pmResult.requirement;
  }

  private async runBugTriageStage(
    userInput: string,
    contextPrompt: string,
    onToolConfirm?: ToolConfirmCallback,
  ): Promise<BugReport | null> {
    const triageStart = Date.now();
    this.callbacks.onStageStart('bug-triage', '正在分诊问题并生成 bug 报告...');
    const triage = new BugTriage(
      this.factory.getProviderForRole('bug-triage'),
      getModelForRole(this.config, 'bug-triage'),
      this.promptsDir,
      {
        maxRetries: this.config.execution.maxRetries,
        onToolConfirm,
        workingDir: this.config.safety.workingDir,
      },
    );
    const triageResult = await triage.analyze(`${contextPrompt}\n\n用户描述的问题如下：\n\n${userInput}`);
    if (triageResult.sessionRecord) {
      await this.store.saveSession(triageResult.sessionRecord);
    }
    this.callbacks.onStageComplete('bug-triage', Date.now() - triageStart);

    if (!triageResult.bugReport) {
      this.callbacks.onError('bug-triage 未能生成有效的 bug 报告。');
      return null;
    }

    await this.store.saveDocument(`bug-report-${triageResult.bugReport.id}`, triageResult.bugReport);
    return triageResult.bugReport;
  }

  private async runProjectPlanStage(
    requirement: Requirement,
    contextPrompt: string,
    onToolConfirm?: ToolConfirmCallback,
  ): Promise<Plan | null> {
    const pjmStart = Date.now();
    this.callbacks.onStageStart('project-manager', '项目经理正在拆分任务...');
    const pjm = this.createProjectManager(onToolConfirm);
    const pjmResult = await pjm.createPlan(requirement, contextPrompt);
    if (pjmResult.sessionRecord) {
      await this.store.saveSession(pjmResult.sessionRecord);
    }
    this.callbacks.onStageComplete('project-manager', Date.now() - pjmStart);

    if (!pjmResult.plan) {
      this.callbacks.onError('项目经理未能生成有效的工作计划。');
      return null;
    }

    await this.store.saveDocument(`plan-${pjmResult.plan.id}`, pjmResult.plan);
    return pjmResult.plan;
  }

  private async runDebugPlanStage(
    bugReport: BugReport,
    contextPrompt: string,
    onToolConfirm?: ToolConfirmCallback,
  ): Promise<Plan | null> {
    const pjmStart = Date.now();
    this.callbacks.onStageStart('project-manager', '项目经理正在制定修复计划...');
    const pjm = this.createProjectManager(onToolConfirm, 'debug-project-manager.md');
    const pjmResult = await pjm.createDebugPlan(bugReport, contextPrompt);
    if (pjmResult.sessionRecord) {
      await this.store.saveSession(pjmResult.sessionRecord);
    }
    this.callbacks.onStageComplete('project-manager', Date.now() - pjmStart);

    if (!pjmResult.plan) {
      this.callbacks.onError('项目经理未能生成有效的修复计划。');
      return null;
    }

    await this.store.saveDocument(`plan-${pjmResult.plan.id}`, pjmResult.plan);
    return pjmResult.plan;
  }

  private createProjectManager(
    onToolConfirm?: ToolConfirmCallback,
    promptFileName?: string,
  ): ProjectManager {
    return new ProjectManager(
      this.factory.getProviderForRole('project-manager'),
      getModelForRole(this.config, 'project-manager'),
      this.promptsDir,
      {
        maxRetries: this.config.execution.maxRetries,
        onToolConfirm,
        workingDir: this.config.safety.workingDir,
        promptFileName,
      },
    );
  }

  private bugReportAsRequirement(bugReport: BugReport): Requirement {
    return {
      id: bugReport.id,
      version: '1.0',
      created_by: 'product-manager',
      timestamp: bugReport.timestamp,
      project_context: {
        tech_stack: [],
        key_files: bugReport.suspected_scope,
        framework: undefined,
        project_type: 'debug-task',
      },
      requirement: {
        user_input: bugReport.user_input,
        summary: bugReport.observed_behavior,
        detailed_description: `${bugReport.observed_behavior}\n\n预期行为：${bugReport.expected_behavior}`,
        goals: bugReport.acceptance_criteria,
        non_goals: [],
        acceptance_criteria: bugReport.acceptance_criteria,
      },
      clarifications: [],
    };
  }

  /**
   * 从中断处恢复流水线
   */
  async resume(state: PipelineState): Promise<void> {
    await this.store.init();

    // 自动提取项目上下文
    const projectContext = await extractProjectContext(this.config.safety.workingDir);
    const contextPrompt = formatContextForPrompt(projectContext);

    const onToolConfirm = this.buildToolConfirm();

    switch (state.currentStage) {
      case 'classify':
      case 'pm':
      case 'triage':
        // 需要重新开始
        return this.run(state.userInput);

      case 'pjm': {
        let plan: Plan | null = null;

        if (state.pipelineType === 'debug-pipeline' && state.bugReport) {
          plan = await this.runDebugPlanStage(state.bugReport, contextPrompt, onToolConfirm);
        } else if (state.requirement) {
          plan = await this.runProjectPlanStage(state.requirement, contextPrompt, onToolConfirm);
        } else {
          return this.run(state.userInput);
        }

        if (!plan) return;
        state.plan = plan;

        const planApproved = await this.callbacks.onPlanReview(plan);
        if (!planApproved) {
          this.callbacks.onError(state.pipelineType === 'debug-pipeline' ? '用户取消了修复计划。' : '用户取消了工作计划。');
          await clearPipelineState(this.store);
          return;
        }

        state.currentStage = 'dispatch';
        await savePipelineState(state, this.store);
        await this.executeTasks(state, onToolConfirm);
        await clearPipelineState(this.store);
        break;
      }

      case 'dispatch': {
        // 有计划，从中断的任务继续
        if (!state.plan) return this.run(state.userInput);
        await this.executeTasks(state, onToolConfirm);
        await clearPipelineState(this.store);
        break;
      }

      case 'summary':
      case 'done':
        // 已完成
        break;
    }
  }

  /**
   * 执行任务分发循环（支持并行执行和依赖图）
   */
  private async executeTasks(
    state: PipelineState,
    onToolConfirm?: ToolConfirmCallback,
  ): Promise<void> {
    const plan = state.plan!;
    const dispatcher = new Dispatcher({
      clerkProvider: this.factory.getProviderForRole('clerk'),
      qaProvider: this.factory.getProviderForRole('qa-engineer'),
      evaluatorProvider: this.factory.getProviderForRole('evaluator'),
      clerkModel: getModelForRole(this.config, 'clerk'),
      qaModel: getModelForRole(this.config, 'qa-engineer'),
      evaluatorModel: getModelForRole(this.config, 'evaluator'),
      promptsDir: this.promptsDir,
      maxRetries: this.config.execution.maxRetries,
      onToolConfirm,
      enableVerification: true,
      workingDir: this.config.safety.workingDir,
      verificationProfile: state.pipelineType === 'debug-pipeline' ? 'debug' : 'coding',
    });

    const results: DispatchResult[] = [...state.completedResults];
    const tasks = [...plan.tasks];
    const totalTasks = tasks.length;
    
    // 已经运行或运行中的任务 ID
    const runningTaskIds = new Set<string>();
    const completedTaskIds = new Set<string>(results.map(r => r.task.id));
    const runningPromises = new Map<string, Promise<void>>();
    
    // 并行限制
    const maxParallel = this.config.execution.parallelTasks ? 3 : 1;

    while (completedTaskIds.size < totalTasks) {
      // 1. 查找可以执行的任务
      const executableTasks = tasks.filter(task => {
        // 还没开始，且没完成
        if (runningTaskIds.has(task.id) || completedTaskIds.has(task.id)) return false;
        
        // 检查依赖
        const depsOk = task.depends_on.every(depId => completedTaskIds.has(depId));
        if (!depsOk) return false;

        // 检查文件冲突 (与当前运行中的任务)
        const conflict = Array.from(runningTaskIds).some(runningId => {
          const runningTask = tasks.find(t => t.id === runningId);
          if (!runningTask) return false;
          return task.output_files.some(f => runningTask.output_files.includes(f));
        });
        if (conflict) return false;

        return true;
      });

      // 2. 如果没有可执行任务，且没有运行中的任务，说明剩下的是循环依赖或已被跳过
      if (executableTasks.length === 0 && runningTaskIds.size === 0) {
        // ... (skip remaining tasks logic) ...
        const remainingTasks = tasks.filter(t => !completedTaskIds.has(t.id));
        for (const task of remainingTasks) {
          this.callbacks.onTaskComplete(task.id, false, '依赖未满足或发生死锁，跳过');
          const skipResult: DispatchResult = {
            task,
            result: {
              task_id: task.id,
              executed_by: 'clerk',
              timestamp: new Date().toISOString(),
              status: 'skipped',
              changes_made: [],
              output_summary: '跳过',
            },
            qaReport: null,
            evaluation: null,
            verification: null,
          };
          results.push(skipResult);
          completedTaskIds.add(task.id);
        }
        break;
      }

      // 3. 启动新任务 (直到达到并行上限)
      const toStart = executableTasks.slice(0, maxParallel - runningTaskIds.size);
      
      for (const task of toStart) {
        runningTaskIds.add(task.id);
        const taskIndex = tasks.indexOf(task) + 1;
        
        const promise = (async () => {
          this.callbacks.onTaskStart(task.id, task.title, taskIndex, totalTasks);

          // 检查依赖是否全部成功
          const depsSuccessful = task.depends_on.every(depId => {
            const depResult = results.find(r => r.task.id === depId);
            return depResult && depResult.result?.status === 'success';
          });

          let dispatchResult: DispatchResult;

          if (!depsSuccessful && task.depends_on.length > 0) {
            dispatchResult = {
              task,
              result: {
                task_id: task.id,
                executed_by: 'clerk',
                timestamp: new Date().toISOString(),
                status: 'skipped',
                changes_made: [],
                output_summary: '依赖任务失败，跳过',
              },
              qaReport: null,
              evaluation: null,
              verification: null,
            };
          } else {
            dispatchResult = await dispatcher.dispatchTask(task, plan);
          }

          const success = dispatchResult.result?.status === 'success';
          this.callbacks.onTaskComplete(
            task.id,
            success,
            dispatchResult.result?.output_summary || '无结果',
          );

          // 报告验证结果
          if (dispatchResult.verification && this.callbacks.onVerification) {
            this.callbacks.onVerification(task.id, dispatchResult.verification);
          }

          // 保存会话记录
          if (dispatchResult.clerkSession) {
            await this.store.saveSession(dispatchResult.clerkSession);
          }
          if (dispatchResult.qaSession) {
            await this.store.saveSession(dispatchResult.qaSession);
          }
          if (dispatchResult.evaluatorSession) {
            await this.store.saveSession(dispatchResult.evaluatorSession);
          }

          // 保存结果到 store
          await this.store.saveDocument(`result-${task.id}`, dispatchResult.result);

          if (dispatchResult.evaluation) {
            await this.store.saveDocument(`evaluation-${task.id}`, dispatchResult.evaluation);
          }
          if (dispatchResult.qaReport) {
            await this.store.saveDocument(`qa-report-${task.id}`, dispatchResult.qaReport);
          }

          results.push(dispatchResult);
          completedTaskIds.add(task.id);
          runningTaskIds.delete(task.id);
          runningPromises.delete(task.id);
          task.status = success ? 'success' : 'failed';

          if (dispatchResult.evaluation?.decision === 'pause') {
            const decision = await this.callbacks.onPause(dispatchResult.evaluation.reason);
            if (decision === 'abort') {
              throw new Error('USER_ABORT');
            }
          }
          
          state.completedResults = results;
          await savePipelineState(state, this.store);
        })();

        runningPromises.set(task.id, promise);
      }

      // 4. 等待任务完成
      if (runningPromises.size > 0) {
        // 如果我们还没达到并行上限且还有可启动的任务，我们继续循环启动它们
        // 否则我们才真正等待
        if (runningPromises.size >= maxParallel || executableTasks.length === toStart.length) {
          try {
            await Promise.race(Array.from(runningPromises.values()));
          } catch (err: any) {
            if (err.message === 'USER_ABORT') {
              break;
            }
            throw err;
          }
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // ==========================================
    // Step 5: 总结报告
    // ==========================================
    state.currentStage = 'summary';
    await savePipelineState(state, this.store);

    this.callbacks.onStageStart('summary', '正在生成工作总结...');

    const summary: Summary = {
      plan_id: plan.id,
      timestamp: new Date().toISOString(),
      total_tasks: tasks.length,
      completed_tasks: results.filter((r) => r.result?.status === 'success').length,
      failed_tasks: results.filter((r) => r.result?.status === 'failed').length,
      skipped_tasks: results.filter((r) => r.result?.status === 'skipped').length,
      completed_items: results
        .filter((r) => r.result?.status === 'success')
        .map((r) => r.task.title),
      failed_items: results
        .filter((r) => r.result?.status === 'failed')
        .map((r) => `${r.task.title}: ${r.result?.error || '未知错误'}`),
      overall_summary: `共 ${tasks.length} 个任务，完成 ${results.filter((r) => r.result?.status === 'success').length} 个，失败 ${results.filter((r) => r.result?.status === 'failed').length} 个，跳过 ${results.filter((r) => r.result?.status === 'skipped').length} 个。`,
    };

    await this.store.saveDocument(`summary-${plan.id}`, summary);
    this.callbacks.onSummary(summary);
    this.callbacks.onStageComplete('summary');

    state.currentStage = 'done';
  }
}
