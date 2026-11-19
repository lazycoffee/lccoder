/**
 * 项目经理角色
 * 负责将需求拆分为可执行的子任务
 */
import { BaseRole, type ToolConfirmCallback } from './base-role.js';
import { PlanSchema, type Plan } from '../schemas/plan.js';
import type { Requirement } from '../schemas/requirement.js';
import type { BugReport } from '../schemas/bug-report.js';
import type { LLMProvider } from '../llm/provider.js';
import type { RoleOutput } from './base-role.js';
import type { TaskComplexity, TaskType, TaskStatus } from '../schemas/common.js';

export class ProjectManager extends BaseRole {
  constructor(
    provider: LLMProvider,
    model: string,
    promptsDir?: string,
    options?: {
      maxRetries?: number;
      onToolConfirm?: ToolConfirmCallback;
      workingDir?: string;
      promptFileName?: string;
    },
  ) {
    super({
      roleName: 'project-manager',
      promptFileName: options?.promptFileName || 'project-manager.md',
      provider,
      model,
      promptsDir,
      maxRetries: options?.maxRetries,
      onToolConfirm: options?.onToolConfirm,
      workingDir: options?.workingDir,
    });
  }

  /**
   * 基于需求报告生成工作计划
   */
  async createPlan(requirement: Requirement, contextPrompt?: string): Promise<RoleOutput & { plan?: Plan }> {
    const userMessage = contextPrompt 
      ? `${contextPrompt}\n\n请基于上游的需求分析报告，分析项目代码，然后制定详细的工作计划。`
      : '请基于上游的需求分析报告，分析项目代码，然后制定详细的工作计划。';

    const result = await this.execute({
      userMessage,
      document: requirement as unknown as Record<string, unknown>,
    });

    if (result.document) {
      const normalized = this.normalizePlanDocument(result.document, requirement);
      if (normalized) {
        return { ...result, plan: normalized };
      }

      try {
        const plan = PlanSchema.parse(result.document);
        return { ...result, plan };
      } catch {
        // Schema 校验失败
        return { ...result };
      }
    }

    return result;
  }

  async createDebugPlan(bugReport: BugReport, contextPrompt?: string): Promise<RoleOutput & { plan?: Plan }> {
    const userMessage = contextPrompt
      ? `${contextPrompt}\n\n请基于上游的 bug 报告，分析项目代码，然后制定详细的修复计划。计划应围绕复现、定位、修复和回归验证展开。`
      : '请基于上游的 bug 报告，分析项目代码，然后制定详细的修复计划。计划应围绕复现、定位、修复和回归验证展开。';

    const result = await this.execute({
      userMessage,
      document: bugReport as unknown as Record<string, unknown>,
    });

    if (result.document) {
      const normalized = this.normalizePlanDocument(result.document, {
        id: bugReport.id,
        requirement: {
          summary: bugReport.observed_behavior,
        },
      } as Requirement);
      if (normalized) {
        return { ...result, plan: normalized };
      }

      try {
        const plan = PlanSchema.parse(result.document);
        return { ...result, plan };
      } catch {
        return { ...result };
      }
    }

    return result;
  }

  private normalizePlanDocument(document: Record<string, unknown>, requirement: Requirement): Plan | null {
    if (!Array.isArray(document.tasks)) return null;

    const normalizedTasks = document.tasks
      .filter((task): task is Record<string, unknown> => !!task && typeof task === 'object')
      .map((task, index) => {
        const type = this.normalizeTaskType(task.type, task.instructions);
        return {
          id: typeof task.id === 'string' ? task.id : `task-${String(index + 1).padStart(3, '0')}`,
          order: typeof task.order === 'number' ? task.order : index + 1,
          type,
          title: this.pickString(task.title, task.description, `任务 ${index + 1}`),
          description: this.pickString(task.description, task.title, `任务 ${index + 1}`),
          input_files: Array.isArray(task.input_files) ? task.input_files.map(String) : [],
          output_files: Array.isArray(task.output_files) ? task.output_files.map(String) : [],
          depends_on: Array.isArray(task.depends_on) ? task.depends_on.map(String) : [],
          estimated_complexity: this.normalizeComplexity(task.estimated_complexity, type),
          instructions: this.pickString(task.instructions, task.description, task.title),
          code_template: this.pickOptionalString(task.code_template),
          verification: this.pickOptionalString(task.verification),
          status: this.normalizeStatus(task.status),
        };
      });

    if (normalizedTasks.length === 0) return null;

    try {
      return PlanSchema.parse({
        id: this.pickString(document.id, `plan-${Date.now()}`),
        source_requirement: this.pickString(document.source_requirement, requirement.id),
        created_by: 'project-manager',
        timestamp: typeof document.timestamp === 'string' ? document.timestamp : new Date().toISOString(),
        summary: this.pickString(document.summary, requirement.requirement.summary, '工作计划'),
        tasks: normalizedTasks,
        critical_path: Array.isArray(document.critical_path)
          ? document.critical_path.map(String)
          : normalizedTasks.map((task) => task.id),
        notes: this.pickOptionalString(document.notes) || undefined,
      });
    } catch {
      return null;
    }
  }

  private normalizeTaskType(rawType: unknown, instructions: unknown): TaskType {
    const value = typeof rawType === 'string' ? rawType.toLowerCase() : '';
    if (value === 'read' || value === 'write' || value === 'modify' || value === 'delete' || value === 'shell' || value === 'verify') {
      return value;
    }

    const text = typeof instructions === 'string' ? instructions.toLowerCase() : '';
    if (text.includes('bun test') || text.includes('运行测试') || text.includes('验证测试')) return 'verify';
    return 'modify';
  }

  private normalizeComplexity(rawComplexity: unknown, type: TaskType): TaskComplexity {
    const value = typeof rawComplexity === 'string' ? rawComplexity.toLowerCase() : '';
    if (value === 'trivial' || value === 'simple' || value === 'moderate') {
      return value;
    }

    if (type === 'read') return 'trivial';
    if (type === 'verify') return 'simple';
    return 'simple';
  }

  private normalizeStatus(rawStatus: unknown): TaskStatus {
    const value = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : '';
    if (value === 'pending' || value === 'running' || value === 'success' || value === 'failed' || value === 'skipped') {
      return value;
    }
    return 'pending';
  }

  private pickString(...values: unknown[]): string {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return '';
  }

  private pickOptionalString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return undefined;
  }
}
