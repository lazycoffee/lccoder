/**
 * 文档存储管理
 * 所有流水线文档都存储在 .lccoder/ 目录下
 */
import { writeFile, readFile, mkdir, readdir, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import type { SessionRecord } from '../llm/session.js';
import type { GuiRuntimeEvent } from '../gui/runtime-events.js';

export class DocumentStore {
  private baseDir: string;
  private documentsDir: string;
  private sessionsDir: string;
  private currentDir: string;

  constructor(workingDir?: string) {
    const root = workingDir || process.cwd();
    this.baseDir = join(root, '.lccoder');
    this.documentsDir = join(this.baseDir, 'documents');
    this.sessionsDir = join(this.baseDir, 'sessions');
    this.currentDir = join(this.baseDir, 'current');
  }

  /** 初始化工作目录 */
  async init(): Promise<void> {
    await mkdir(this.documentsDir, { recursive: true });
    await mkdir(this.sessionsDir, { recursive: true });
    await mkdir(this.currentDir, { recursive: true });
  }

  /** 保存文档 */
  async saveDocument(name: string, data: unknown): Promise<string> {
    const filePath = join(this.documentsDir, `${name}.json`);
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return filePath;
  }

  /** 读取文档 */
  async loadDocument<T>(name: string): Promise<T | null> {
    const filePath = join(this.documentsDir, `${name}.json`);
    if (!existsSync(filePath)) return null;
    try {
      const raw = await readFile(filePath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /** 列出所有文档 */
  async listDocuments(): Promise<{ name: string; updatedAt: string }[]> {
    if (!existsSync(this.documentsDir)) return [];

    const files = await readdir(this.documentsDir);
    const documents = await Promise.all(
      files
        .filter((file) => file.endsWith('.json'))
        .map(async (file) => {
          const filePath = join(this.documentsDir, file);
          const fileStat = await stat(filePath);
          return {
            name: file.replace(/\.json$/, ''),
            updatedAt: fileStat.mtime.toISOString(),
          };
        }),
    );

    return documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** 保存会话记录 */
  async saveSession(record: SessionRecord): Promise<void> {
    const fileName = `session-${record.id}.json`;
    const filePath = join(this.sessionsDir, fileName);
    await writeFile(filePath, JSON.stringify(record, null, 2), 'utf-8');
  }

  /** 保存流水线状态（用于断点续传） */
  async savePipelineState(state: unknown): Promise<void> {
    const filePath = join(this.currentDir, 'pipeline-state.json');
    await writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  /** 加载流水线状态（用于断点续传） */
  async loadPipelineState<T>(): Promise<T | null> {
    const filePath = join(this.currentDir, 'pipeline-state.json');
    if (!existsSync(filePath)) return null;
    try {
      const raw = await readFile(filePath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /** 清除流水线状态（完成或放弃后） */
  async clearPipelineState(): Promise<void> {
    const filePath = join(this.currentDir, 'pipeline-state.json');
    if (existsSync(filePath)) {
      const { unlink } = await import('fs/promises');
      await unlink(filePath);
    }
  }

  /** 获取工作目录路径 */
  getBaseDir(): string {
    return this.baseDir;
  }

  /** 列出所有会话记录 */
  async listSessions(): Promise<{ id: string; role: string; model: string; startedAt: string }[]> {
    if (!existsSync(this.sessionsDir)) return [];
    const { readdir } = await import('fs/promises');
    const files = await readdir(this.sessionsDir);
    const sessions = [];
    for (const file of files) {
      if (file.startsWith('session-') && file.endsWith('.json')) {
        try {
          const raw = await readFile(join(this.sessionsDir, file), 'utf-8');
          const data = JSON.parse(raw);
          sessions.push({
            id: data.id,
            role: data.role,
            model: data.model,
            startedAt: data.startedAt,
          });
        } catch {
          // 忽略损坏的文件
        }
      }
    }
    return sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** 加载特定会话 */
  async loadSession(id: string): Promise<SessionRecord | null> {
    const filePath = join(this.sessionsDir, `session-${id}.json`);
    if (!existsSync(filePath)) return null;
    try {
      const raw = await readFile(filePath, 'utf-8');
      return JSON.parse(raw) as SessionRecord;
    } catch {
      return null;
    }
  }

  /** 读取运行时事件 */
  async listRuntimeEvents(): Promise<GuiRuntimeEvent[]> {
    const filePath = join(this.currentDir, 'runtime-events.json');
    if (!existsSync(filePath)) return [];
    try {
      const raw = await readFile(filePath, 'utf-8');
      const events = JSON.parse(raw);
      return Array.isArray(events) ? (events as GuiRuntimeEvent[]) : [];
    } catch {
      return [];
    }
  }

  /** 追加运行时事件 */
  async appendRuntimeEvent(event: GuiRuntimeEvent): Promise<void> {
    const filePath = join(this.currentDir, 'runtime-events.json');
    const events = await this.listRuntimeEvents();
    events.push(event);
    const trimmedEvents = events.slice(-200);
    await writeFile(filePath, JSON.stringify(trimmedEvents, null, 2), 'utf-8');
  }

  /** 清理运行时事件 */
  async clearRuntimeEvents(): Promise<void> {
    const filePath = join(this.currentDir, 'runtime-events.json');
    if (existsSync(filePath)) {
      const { unlink } = await import('fs/promises');
      await unlink(filePath);
    }
  }
}
