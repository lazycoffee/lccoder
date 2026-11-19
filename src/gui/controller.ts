import { Orchestrator, type PipelineCallbacks } from '../pipeline/orchestrator.js';
import { ProviderFactory } from '../llm/factory.js';
import { DocumentStore } from '../documents/store.js';
import { loadConfig } from '../config/index.js';
import { loadPipelineState, type PipelineState } from '../pipeline/state.js';
import { createGuiEventEmitter } from './events.js';
import type { Requirement } from '../schemas/requirement.js';
import type { Plan } from '../schemas/plan.js';
import type { Summary } from '../schemas/result.js';
import type { VerificationReport } from '../pipeline/verifier.js';
import type { RequestedMode } from '../schemas/route.js';

export type GuiInteraction =
  | {
      id: string;
      type: 'questions';
      title: string;
      payload: { questions: string[] };
    }
  | {
      id: string;
      type: 'requirement-review';
      title: string;
      payload: { requirement: Requirement };
    }
  | {
      id: string;
      type: 'plan-review';
      title: string;
      payload: { plan: Plan };
    }
  | {
      id: string;
      type: 'pause';
      title: string;
      payload: { reason: string };
    }
  | {
      id: string;
      type: 'tool-confirm';
      title: string;
      payload: { toolName: string; args: Record<string, unknown>; reason: string };
    };

type DeferredInteraction = {
  interaction: GuiInteraction;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

export class GuiPipelineController {
  private readonly workingDir: string;
  private running = false;
  private activeRunId: string | null = null;
  private pendingInteraction: DeferredInteraction | null = null;
  private latestSummary: Summary | null = null;
  private latestSimpleResponse: string | null = null;
  private latestError: string | null = null;

  constructor(workingDir: string) {
    this.workingDir = workingDir;
  }

  getState() {
    return {
      running: this.running,
      activeRunId: this.activeRunId,
      pendingInteraction: this.pendingInteraction?.interaction || null,
      latestSummary: this.latestSummary,
      latestSimpleResponse: this.latestSimpleResponse,
      latestError: this.latestError,
    };
  }

  async canResume(): Promise<boolean> {
    const store = new DocumentStore(this.workingDir);
    await store.init();
    return (await loadPipelineState(store)) !== null;
  }

  async startRun(userInput: string, requestedMode: RequestedMode = 'auto'): Promise<{ runId: string }> {
    if (this.running) {
      throw new Error('已有流水线正在运行，请先完成当前任务。');
    }

    const trimmedInput = userInput.trim();
    if (!trimmedInput) {
      throw new Error('请输入任务描述。');
    }

    this.beginRun();
    const runId = this.activeRunId!;
    void this.executeRun(trimmedInput, requestedMode);
    return { runId };
  }

  async resumeRun(): Promise<{ runId: string }> {
    if (this.running) {
      throw new Error('已有流水线正在运行，请先完成当前任务。');
    }

    const store = new DocumentStore(this.workingDir);
    await store.init();
    const savedState = await loadPipelineState(store);
    if (!savedState) {
      throw new Error('没有可恢复的流水线。');
    }

    this.beginRun();
    const runId = this.activeRunId!;
    void this.executeResume(savedState);
    return { runId };
  }

  respond(interactionId: string, response: unknown): void {
    const pending = this.pendingInteraction;
    if (!pending || pending.interaction.id !== interactionId) {
      throw new Error('交互已失效或不存在。');
    }

    this.pendingInteraction = null;
    pending.resolve(response);
  }

  private beginRun(): void {
    this.running = true;
    this.activeRunId = `gui-run-${Date.now()}`;
    this.pendingInteraction = null;
    this.latestSummary = null;
    this.latestSimpleResponse = null;
    this.latestError = null;
  }

  private finishRun(): void {
    this.running = false;
    this.activeRunId = null;
    if (this.pendingInteraction) {
      this.pendingInteraction.reject(new Error('流水线已结束'));
      this.pendingInteraction = null;
    }
  }

  private async executeRun(userInput: string, requestedMode: RequestedMode): Promise<void> {
    try {
      const orchestrator = await this.createRuntime();
      await orchestrator.run(userInput, requestedMode);
    } catch (error) {
      this.latestError = error instanceof Error ? error.message : String(error);
    } finally {
      this.finishRun();
    }
  }

  private async executeResume(state: PipelineState): Promise<void> {
    try {
      const orchestrator = await this.createRuntime();
      await orchestrator.resume(state);
    } catch (error) {
      this.latestError = error instanceof Error ? error.message : String(error);
    } finally {
      this.finishRun();
    }
  }

  private async createRuntime(): Promise<Orchestrator> {
    const config = loadConfig(this.workingDir);
    const store = new DocumentStore(this.workingDir);
    await store.init();
    await store.clearRuntimeEvents();
    const factory = new ProviderFactory(config);
    const callbacks = this.buildCallbacks(store);
    const promptsDir = new URL('../../prompts', import.meta.url).pathname;

    return new Orchestrator({
      factory,
      config,
      store,
      callbacks,
      promptsDir,
    });
  }

  private buildCallbacks(store: DocumentStore): PipelineCallbacks {
    const emitGuiEvent = createGuiEventEmitter(store);
    let stageStartTime = 0;

    return {
      onStageStart: (stage: string, description: string) => {
        stageStartTime = Date.now();
        emitGuiEvent('stage-start', { stage, description });
      },

      onStageComplete: (stage: string, durationMs?: number) => {
        emitGuiEvent('stage-complete', {
          stage,
          durationMs: durationMs || (Date.now() - stageStartTime),
        });
      },

      onQuestion: async (questions: string[]) => {
        return this.waitForInteraction<Record<string, string>>({
          type: 'questions',
          title: '产品经理需要你补充信息',
          payload: { questions },
        });
      },

      onRequirementReview: async (requirement: Requirement) => {
        return this.waitForInteraction<boolean>({
          type: 'requirement-review',
          title: '请确认需求分析结果',
          payload: { requirement },
        });
      },

      onPlanReview: async (plan: Plan) => {
        return this.waitForInteraction<boolean>({
          type: 'plan-review',
          title: '请确认项目计划',
          payload: { plan },
        });
      },

      onTaskStart: (taskId: string, title: string, index: number, total: number) => {
        emitGuiEvent('task-start', { taskId, title, index, total });
      },

      onTaskComplete: (taskId: string, success: boolean, summary: string) => {
        emitGuiEvent('task-complete', { taskId, success, summary });
      },

      onPause: async (reason: string) => {
        return this.waitForInteraction<'continue' | 'abort'>({
          type: 'pause',
          title: '流水线已暂停，等待你的决策',
          payload: { reason },
        });
      },

      onSimpleResponse: (response: string) => {
        this.latestSimpleResponse = response;
      },

      onSummary: (summary: Summary) => {
        this.latestSummary = summary;
        emitGuiEvent('summary', { summary });
      },

      onError: (error: string) => {
        this.latestError = error;
        emitGuiEvent('error', { error });
      },

      onToolConfirm: async (toolName: string, args: Record<string, unknown>, reason: string) => {
        return this.waitForInteraction<boolean>({
          type: 'tool-confirm',
          title: '工具调用需要确认',
          payload: { toolName, args, reason },
        });
      },

      onVerification: (taskId: string, report: VerificationReport) => {
        emitGuiEvent('verification', { taskId, report });
      },
    };
  }

  private waitForInteraction<T>(interaction: Omit<GuiInteraction, 'id'>): Promise<T> {
    if (this.pendingInteraction) {
      throw new Error('当前已有待处理交互。');
    }

    return new Promise<T>((resolve, reject) => {
      this.pendingInteraction = {
        interaction: {
          ...interaction,
          id: `interaction-${Date.now()}`,
        } as GuiInteraction,
        resolve,
        reject,
      };
    });
  }
}
