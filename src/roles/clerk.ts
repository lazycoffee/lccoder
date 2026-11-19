/**
 * 办事员角色
 * 负责执行具体的子任务
 */
import { BaseRole, type ToolConfirmCallback } from './base-role.js';
import { ResultSchema, type Result } from '../schemas/result.js';
import type { Instruction } from '../schemas/instruction.js';
import type { LLMProvider } from '../llm/provider.js';
import type { RoleOutput } from './base-role.js';
import type { SessionRecord } from '../llm/session.js';
import type { FileChange } from '../schemas/common.js';

export class Clerk extends BaseRole {
  constructor(
    provider: LLMProvider,
    model: string,
    promptsDir?: string,
    options?: { maxRetries?: number; onToolConfirm?: ToolConfirmCallback; workingDir?: string },
  ) {
    super({
      roleName: 'clerk',
      promptFileName: 'clerk.md',
      provider,
      model,
      promptsDir,
      maxRetries: options?.maxRetries,
      onToolConfirm: options?.onToolConfirm,
      workingDir: options?.workingDir,
    });
  }

  /**
   * 执行一个子任务
   */
  async executeTask(instruction: Instruction): Promise<RoleOutput & { result?: Result }> {
    const message = this.buildTaskMessage(instruction);

    const output = await this.execute({
      userMessage: message,
      document: instruction as unknown as Record<string, unknown>,
    });

    if (output.document) {
      const normalized = this.normalizeResultDocument(output.document, instruction, output.text);
      if (normalized) {
        return { ...output, result: normalized };
      }
    }

    const inferred = this.inferResultFromSession(output.sessionRecord, instruction, output.text);
    if (inferred) {
      return { ...output, result: inferred };
    }

    return output;
  }

  private buildTaskMessage(instruction: Instruction): string {
    let message = `请执行以下任务：\n\n`;
    message += `## 任务：${instruction.title}\n\n`;
    message += `${instruction.instructions}\n\n`;

    if (instruction.input_files.length > 0) {
      message += `## 需要读取的文件\n`;
      for (const f of instruction.input_files) {
        message += `- ${f}\n`;
      }
      message += '\n';
    }

    if (instruction.output_files.length > 0) {
      message += `## 需要操作的文件\n`;
      for (const f of instruction.output_files) {
        message += `- ${f}\n`;
      }
      message += '\n';
    }

    if (instruction.code_template) {
      message += `## 代码模板\n\`\`\`\n${instruction.code_template}\n\`\`\`\n\n`;
    }

    if (instruction.verification) {
      message += `## 验证方法\n${instruction.verification}\n\n`;
    }

    message += `完成后请输出 JSON 格式的执行结果报告。`;
    return message;
  }

  private normalizeResultDocument(
    document: Record<string, unknown>,
    instruction: Instruction,
    fallbackText: string,
  ): Result | null {
    const normalizedStatus = this.normalizeStatus(document.status, document.error);
    const normalizedChanges = this.normalizeChanges(document.changes_made, instruction);

    const candidate: Result = {
      task_id: String(document.task_id || instruction.task_id),
      executed_by: 'clerk',
      timestamp: typeof document.timestamp === 'string' ? document.timestamp : new Date().toISOString(),
      status: normalizedStatus,
      changes_made: normalizedChanges,
      output_summary: this.pickString(
        document.output_summary,
        document.summary,
        document.result,
        fallbackText.slice(0, 500),
      ),
      error: this.pickNullableString(document.error),
      notes_for_pm: this.pickNullableString(document.notes_for_pm, document.notes),
    };

    try {
      return ResultSchema.parse(candidate);
    } catch {
      return null;
    }
  }

  private inferResultFromSession(
    sessionRecord: SessionRecord | undefined,
    instruction: Instruction,
    fallbackText: string,
  ): Result | null {
    if (!sessionRecord) return null;

    const toolLog = sessionRecord.toolCallLog;
    if (toolLog.length === 0) return null;

    const changes: FileChange[] = [];
    let sawMutation = false;
    let sawFailure = false;
    const notes: string[] = [];

    for (const entry of toolLog) {
      const resultText = this.resultToText(entry.result);
      if (this.isFailureResult(resultText)) {
        sawFailure = true;
        notes.push(`${entry.call.name}: ${resultText.slice(0, 160)}`);
        continue;
      }

      if (entry.call.name === 'file_write') {
        sawMutation = true;
        changes.push({
          file: String(entry.call.arguments.path || instruction.output_files[0] || ''),
          action: instruction.type === 'modify' ? 'modified' : 'created',
          summary: '通过 file_write 写入文件',
        });
      } else if (entry.call.name === 'file_patch') {
        sawMutation = true;
        changes.push({
          file: String(entry.call.arguments.path || instruction.output_files[0] || ''),
          action: 'modified',
          summary: '通过 file_patch 修改文件',
        });
      } else if (entry.call.name === 'file_read') {
        changes.push({
          file: String(entry.call.arguments.path || instruction.input_files[0] || ''),
          action: 'read',
          summary: '读取文件确认内容',
        });
      } else if (entry.call.name === 'shell_exec') {
        sawMutation = true;
        notes.push(`shell_exec: ${resultText.slice(0, 160)}`);
      }
    }

    if (!sawMutation && !sawFailure) return null;

    const dedupedChanges = this.dedupeChanges(changes);
    const outputSummary = sawFailure
      ? this.pickString(fallbackText.slice(0, 500), '办事员执行过程中出现工具错误')
      : this.pickString(
          fallbackText.slice(0, 500),
          dedupedChanges.length > 0 ? `已执行 ${dedupedChanges.length} 项文件相关操作` : '任务已执行',
        );

    try {
      return ResultSchema.parse({
        task_id: instruction.task_id,
        executed_by: 'clerk',
        timestamp: new Date().toISOString(),
        status: sawFailure ? 'failed' : 'success',
        changes_made: dedupedChanges,
        output_summary: outputSummary,
        error: sawFailure ? notes.join('\n') || '工具执行失败' : null,
        notes_for_pm: !sawFailure && notes.length > 0 ? notes.join('\n') : null,
      });
    } catch {
      return null;
    }
  }

  private normalizeStatus(rawStatus: unknown, rawError: unknown): Result['status'] {
    const value = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : '';
    if (value === 'success' || value === 'failed') return value;
    if (['completed', 'done', 'ok', 'passed'].includes(value)) return 'success';
    if (['error', 'failure', 'failed_with_errors'].includes(value)) return 'failed';
    return this.pickNullableString(rawError) ? 'failed' : 'success';
  }

  private normalizeChanges(rawChanges: unknown, instruction: Instruction): FileChange[] {
    if (!Array.isArray(rawChanges)) return [];

    const changes: FileChange[] = [];
    for (const item of rawChanges) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const file = this.pickString(record.file, record.path);
      if (!file) continue;

      const action = this.normalizeAction(record.action, instruction.type);
      if (!action) continue;

      changes.push({
        file,
        action,
        summary: this.pickNullableString(record.summary, record.description) || undefined,
      });
    }

    return this.dedupeChanges(changes);
  }

  private normalizeAction(rawAction: unknown, fallbackType: Instruction['type']): FileChange['action'] | null {
    const value = typeof rawAction === 'string' ? rawAction.toLowerCase() : '';
    if (value === 'created' || value === 'modified' || value === 'deleted' || value === 'read') {
      return value;
    }

    if (['create', 'write', 'new'].includes(value)) return 'created';
    if (['modify', 'modified', 'patch', 'update', 'updated', 'edit'].includes(value)) return 'modified';
    if (['delete', 'remove', 'deleted'].includes(value)) return 'deleted';

    if (fallbackType === 'write') return 'created';
    if (fallbackType === 'modify') return 'modified';
    if (fallbackType === 'delete') return 'deleted';
    if (fallbackType === 'read') return 'read';
    return null;
  }

  private dedupeChanges(changes: FileChange[]): FileChange[] {
    const map = new Map<string, FileChange>();
    for (const change of changes) {
      map.set(`${change.file}:${change.action}`, change);
    }
    return [...map.values()];
  }

  private pickString(...values: unknown[]): string {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return '';
  }

  private pickNullableString(...values: unknown[]): string | null {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return null;
  }

  private resultToText(result: unknown): string {
    if (typeof result === 'string') return result;
    if (result && typeof result === 'object' && 'error' in result) {
      return String((result as Record<string, unknown>).error || '');
    }
    return JSON.stringify(result);
  }

  private isFailureResult(text: string): boolean {
    const value = text.toLowerCase();
    return value.includes('错误') || value.includes('失败') || value.includes('error') || value.includes('退出码');
  }
}
