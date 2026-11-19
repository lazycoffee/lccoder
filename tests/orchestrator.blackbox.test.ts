import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rm } from 'fs/promises';
import { Orchestrator, type PipelineCallbacks } from '../src/pipeline/orchestrator.js';
import { DocumentStore } from '../src/documents/store.js';
import type { LccoderConfig } from '../src/config/index.js';
import type { RoleName } from '../src/schemas/common.js';
import type { ProviderResolver } from '../src/llm/factory.js';
import { FakeProvider, jsonResponse } from './helpers/fake-provider.js';

const PROMPTS_DIR = join(import.meta.dir, '../prompts');

const requirementDoc = {
  id: 'req-test-001',
  version: '1.0',
  created_by: 'product-manager' as const,
  timestamp: '2026-04-13T00:00:00.000Z',
  project_context: {
    tech_stack: ['TypeScript', 'Bun'],
    key_files: ['README.md'],
    framework: '无',
    project_type: 'CLI 工具',
  },
  requirement: {
    user_input: '创建 greeting.txt 文件',
    summary: '创建 greeting.txt',
    detailed_description: '在项目中创建 greeting.txt 文件并写入问候语。',
    goals: ['创建 greeting.txt 文件'],
    non_goals: ['不修改其他文件'],
    acceptance_criteria: ['greeting.txt 文件存在且包含 Hello from lccoder'],
  },
  clarifications: [],
};

const bugReportDoc = {
  id: 'bug-test-001',
  created_by: 'bug-triage' as const,
  timestamp: '2026-04-15T00:00:00.000Z',
  user_input: '修复 greeting.txt 测试失败',
  observed_behavior: 'greeting 相关测试失败',
  expected_behavior: 'greeting 相关测试应通过',
  error_signals: ['tests/greeting.test.ts 失败'],
  suspected_scope: ['src/greeting.ts', 'tests/greeting.test.ts'],
  reproduction_steps: ['运行 bun test', '观察 greeting 测试失败'],
  severity: 'medium' as const,
  acceptance_criteria: ['greeting 测试恢复通过'],
};

const planDoc = {
  id: 'plan-test-001',
  source_requirement: 'req-test-001',
  created_by: 'project-manager' as const,
  timestamp: '2026-04-13T00:00:00.000Z',
  summary: '创建 greeting.txt 文件',
  tasks: [
    {
      id: 'task-write-greeting',
      order: 1,
      type: 'write' as const,
      title: '创建 greeting.txt',
      description: '创建 greeting.txt 并写入问候语',
      input_files: [],
      output_files: ['greeting.txt'],
      depends_on: [],
      estimated_complexity: 'simple' as const,
      instructions: '创建 greeting.txt 并写入 Hello from lccoder',
      verification: '确认 greeting.txt 存在',
      status: 'pending' as const,
    },
  ],
  critical_path: ['task-write-greeting'],
  notes: '测试计划',
};

const verifyPlanDoc = {
  ...planDoc,
  tasks: [
    {
      ...planDoc.tasks[0],
      type: 'verify' as const,
      title: '验证 greeting.txt 功能',
      description: '运行项目验证，确认 greeting 相关改动可通过检查',
      instructions: '运行验证流程并输出标准 JSON 结果报告',
      output_files: [],
      verification: '运行测试并确认结果',
    },
  ],
};

const successResultDoc = {
  task_id: 'task-write-greeting',
  executed_by: 'clerk' as const,
  timestamp: '2026-04-13T00:00:00.000Z',
  status: 'success' as const,
  changes_made: [
    {
      file: 'greeting.txt',
      action: 'created' as const,
      summary: '写入问候语',
    },
  ],
  output_summary: '已创建 greeting.txt',
  error: null,
  notes_for_pm: null,
};

const pauseEvaluationDoc = {
  task_id: 'task-write-greeting',
  evaluated_by: 'evaluator' as const,
  timestamp: '2026-04-13T00:00:00.000Z',
  task_succeeded: false,
  impacts_critical_path: true,
  decision: 'pause' as const,
  reason: '自动验证失败，需要人工介入',
  suggestion: '检查失败的测试后重试',
};

const qaPassReportDoc = {
  task_id: 'task-write-greeting',
  tested_by: 'qa-engineer' as const,
  timestamp: '2026-04-13T00:00:00.000Z',
  requirement_coverage: {
    passed: true,
    score: 9,
    notes: ['目标文件已创建', '内容符合任务要求'],
  },
  artifact_validation: {
    passed: true,
    notes: ['greeting.txt 存在', '文件内容包含问候语'],
  },
  quality_risks: [],
  verdict: 'pass' as const,
  reason: '任务已满足要求',
  suggestions: [],
};

const qaFailReportDoc = {
  task_id: 'task-write-greeting',
  tested_by: 'qa-engineer' as const,
  timestamp: '2026-04-13T00:00:00.000Z',
  requirement_coverage: {
    passed: false,
    score: 3,
    notes: ['自动验证失败', '当前结果不满足通过标准'],
  },
  artifact_validation: {
    passed: true,
    notes: ['目标文件存在，但整体质量未达标'],
  },
  quality_risks: ['自动验证失败，存在明显回归风险'],
  verdict: 'fail' as const,
  reason: '自动验证失败，不能判定任务通过',
  suggestions: ['修复失败测试后重新执行'],
};

const continueEvaluationDoc = {
  task_id: 'task-write-greeting',
  evaluated_by: 'evaluator' as const,
  timestamp: '2026-04-13T00:00:00.000Z',
  task_succeeded: true,
  impacts_critical_path: true,
  decision: 'continue' as const,
  reason: '任务已完成',
  suggestion: null,
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('Orchestrator black-box pipeline', () => {
  it('uses direct-answer role for simple requests and returns natural language', async () => {
    const workingDir = await createTempProject();
    const providers = createProviders({
      classifier: [jsonResponse({ mode: 'answer', complexity: 'simple', pipelineType: 'direct-answer', reason: '直接回答即可' })],
      'direct-answer': [{ content: 'GUI smoke test ok' }],
      'bug-triage': [],
      'product-manager': [],
      'project-manager': [],
      clerk: [],
      'qa-engineer': [],
      evaluator: [],
    });

    const { callbacks, events } = createCallbacks();
    const orchestrator = new Orchestrator({
      factory: providers,
      config: createConfig(workingDir),
      store: new DocumentStore(workingDir),
      callbacks,
      promptsDir: PROMPTS_DIR,
    });

    await orchestrator.run('请用一句话回复：GUI smoke test ok');

    expect(providers.providers['direct-answer'].calls).toHaveLength(1);
    expect(providers.providers['product-manager'].calls).toHaveLength(0);
    expect(events.simpleResponses).toEqual(['GUI smoke test ok']);
    expect(events.errors).toEqual([]);
  });

  it('routes debug requests into bug-triage instead of product-manager', async () => {
    const workingDir = await createTempProject();
    const providers = createProviders({
      classifier: [jsonResponse({ mode: 'debug', complexity: 'complex', pipelineType: 'debug-pipeline', reason: '需要先分诊问题' })],
      'direct-answer': [],
      'bug-triage': [jsonResponse(bugReportDoc)],
      'product-manager': [],
      'project-manager': [jsonResponse(planDoc)],
      clerk: [jsonResponse(successResultDoc)],
      'qa-engineer': [jsonResponse(qaPassReportDoc)],
      evaluator: [jsonResponse(continueEvaluationDoc)],
    });

    const { callbacks } = createCallbacks();
    const store = new DocumentStore(workingDir);
    const orchestrator = new Orchestrator({
      factory: providers,
      config: createConfig(workingDir),
      store,
      callbacks,
      promptsDir: PROMPTS_DIR,
    });

    await orchestrator.run('修复 greeting.txt 相关测试失败');

    expect(providers.providers['bug-triage'].calls).toHaveLength(1);
    expect(providers.providers['product-manager'].calls).toHaveLength(0);
    expect(providers.providers['project-manager'].calls[0]?.system).toContain('调试项目经理');
    expect((await store.loadDocument<typeof bugReportDoc>('bug-report-bug-test-001'))?.observed_behavior).toBe('greeting 相关测试失败');
  });

  it('uses debug verification profile to run tests for modify-like debug tasks', async () => {
    const workingDir = await createTempProject();
    await writeFailingTestProject(workingDir);

    const providers = createProviders({
      classifier: [jsonResponse({ mode: 'debug', complexity: 'complex', pipelineType: 'debug-pipeline', reason: '需要修复失败测试' })],
      'direct-answer': [],
      'bug-triage': [jsonResponse(bugReportDoc)],
      'product-manager': [],
      'project-manager': [jsonResponse(planDoc)],
      clerk: [jsonResponse(successResultDoc)],
      'qa-engineer': [jsonResponse(qaFailReportDoc)],
      evaluator: [jsonResponse(pauseEvaluationDoc)],
    });

    const { callbacks, events } = createCallbacks({
      onPause: vi.fn().mockResolvedValue('continue'),
    });
    const store = new DocumentStore(workingDir);
    const orchestrator = new Orchestrator({
      factory: providers,
      config: createConfig(workingDir),
      store,
      callbacks,
      promptsDir: PROMPTS_DIR,
    });

    await orchestrator.run('修复 greeting.txt 相关测试失败');

    const savedResult = await store.loadDocument<typeof successResultDoc>('result-task-write-greeting');

    expect(savedResult?.status).toBe('failed');
    expect(savedResult?.error).toContain('调试验证失败');
    expect(savedResult?.error).toContain('测试运行');
    expect(events.verifications).toHaveLength(1);
  });

  it('runs a full complex pipeline with tool execution and persists artifacts', async () => {
    const workingDir = await createTempProject();
    const providers = createProviders({
      classifier: [jsonResponse({ mode: 'code', complexity: 'complex', pipelineType: 'coding-pipeline', reason: '需要创建文件' })],
      'direct-answer': [],
      'bug-triage': [],
      'product-manager': [jsonResponse(requirementDoc)],
      'project-manager': [jsonResponse(planDoc)],
      clerk: [
        {
          content: '先创建文件',
          toolCalls: [
            {
              name: 'file_write',
              arguments: {
                path: 'greeting.txt',
                content: 'Hello from lccoder\n',
              },
            },
          ],
        },
        jsonResponse(successResultDoc),
      ],
      'qa-engineer': [jsonResponse(qaPassReportDoc)],
      evaluator: [jsonResponse(continueEvaluationDoc)],
    });

    const { callbacks, events } = createCallbacks();
    const config = createConfig(workingDir);
    const store = new DocumentStore(workingDir);
    const orchestrator = new Orchestrator({
      factory: providers,
      config,
      store,
      callbacks,
      promptsDir: PROMPTS_DIR,
    });

    await orchestrator.run('请创建 greeting.txt 文件并写入问候语');

    expect(await readFile(join(workingDir, 'greeting.txt'), 'utf-8')).toContain('Hello from lccoder');
    expect(events.summary?.completed_tasks).toBe(1);
    expect(events.errors).toEqual([]);
    expect(events.pauses).toEqual([]);
    expect(events.stages).toContain('classifier');
    expect(events.stages).toContain('summary');

    const savedRequirement = await store.loadDocument<typeof requirementDoc>('requirement-req-test-001');
    const savedPlan = await store.loadDocument<typeof planDoc>('plan-plan-test-001');
    const savedResult = await store.loadDocument<typeof successResultDoc>('result-task-write-greeting');
    const savedQaReport = await store.loadDocument<typeof qaPassReportDoc>('qa-report-task-write-greeting');
    const savedSummary = await store.loadDocument<{ completed_tasks: number }>('summary-plan-test-001');

    expect(savedRequirement?.requirement.summary).toBe('创建 greeting.txt');
    expect(savedPlan?.tasks).toHaveLength(1);
    expect(savedResult?.status).toBe('success');
    expect(savedQaReport?.verdict).toBe('pass');
    expect(savedSummary?.completed_tasks).toBe(1);
    expect(await store.loadPipelineState()).toBeNull();
    expect(existsSync(join(workingDir, '.lccoder', 'sessions'))).toBe(true);
  });

  it('retries invalid product-manager JSON within the same session and succeeds', async () => {
    const workingDir = await createTempProject();
    const providers = createProviders({
      classifier: [jsonResponse({ mode: 'code', complexity: 'complex', pipelineType: 'coding-pipeline', reason: '需要多阶段处理' })],
      'direct-answer': [],
      'bug-triage': [],
      'product-manager': [
        { content: '{"id":"req-bad"' },
        jsonResponse(requirementDoc),
      ],
      'project-manager': [jsonResponse(planDoc)],
      clerk: [jsonResponse(successResultDoc)],
      'qa-engineer': [jsonResponse(qaPassReportDoc)],
      evaluator: [jsonResponse(continueEvaluationDoc)],
    });

    const { callbacks } = createCallbacks();
    const orchestrator = new Orchestrator({
      factory: providers,
      config: createConfig(workingDir),
      store: new DocumentStore(workingDir),
      callbacks,
      promptsDir: PROMPTS_DIR,
    });

    await orchestrator.run('请创建 greeting.txt 文件并写入问候语');

    const pmProvider = providers.providers['product-manager'];
    expect(pmProvider.calls).toHaveLength(2);
    expect(pmProvider.calls[1]?.messages.at(-1)?.content).toContain('你上一次输出的不是有效的 JSON');
  });

  it('marks a task as failed when verification fails and pauses the pipeline', async () => {
    const workingDir = await createTempProject();
    await writeFailingTestProject(workingDir);

    const providers = createProviders({
      classifier: [jsonResponse({ mode: 'code', complexity: 'complex', pipelineType: 'coding-pipeline', reason: '需要创建文件' })],
      'direct-answer': [],
      'bug-triage': [],
      'product-manager': [jsonResponse(requirementDoc)],
      'project-manager': [jsonResponse(verifyPlanDoc)],
      clerk: [jsonResponse(successResultDoc)],
      'qa-engineer': [jsonResponse(qaFailReportDoc)],
      evaluator: [jsonResponse(pauseEvaluationDoc)],
    });

    const { callbacks, events } = createCallbacks({
      onPause: vi.fn().mockResolvedValue('continue'),
    });
    const store = new DocumentStore(workingDir);
    const orchestrator = new Orchestrator({
      factory: providers,
      config: createConfig(workingDir),
      store,
      callbacks,
      promptsDir: PROMPTS_DIR,
    });

    await orchestrator.run('请创建 greeting.txt 文件并写入问候语');

    const savedResult = await store.loadDocument<typeof successResultDoc>('result-task-write-greeting');
    const savedEvaluation = await store.loadDocument<typeof pauseEvaluationDoc>('evaluation-task-write-greeting');
    const savedQaReport = await store.loadDocument<typeof qaFailReportDoc>('qa-report-task-write-greeting');
    const savedSummary = await store.loadDocument<{ failed_tasks: number }>('summary-plan-test-001');

    expect(savedResult?.status).toBe('failed');
    expect(savedResult?.error).toContain('代码验证失败');
    expect(savedResult?.error).toContain('测试运行');
    expect(savedEvaluation?.decision).toBe('pause');
    expect(savedQaReport?.verdict).toBe('fail');
    expect(savedSummary?.failed_tasks).toBe(1);
    expect(events.verifications).toHaveLength(1);
    expect(events.pauses).toEqual(['自动验证失败，需要人工介入']);
  });
});

async function createTempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lccoder-blackbox-'));
  tempDirs.push(dir);
  await writeFile(join(dir, 'README.md'), '# Fixture Project\n', 'utf-8');
  return dir;
}

function createConfig(workingDir: string): LccoderConfig {
  return {
    provider: 'ollama',
    model: 'fake-model',
    ollamaHost: 'http://localhost:11434',
    roles: {},
    execution: {
      maxRetries: 2,
      parallelTasks: false,
      autoConfirm: false,
    },
    safety: {
      allowShellExec: false,
      allowFileWrite: true,
      workingDir,
    },
  };
}

function createProviders(
  responses: Record<RoleName, ConstructorParameters<typeof FakeProvider>[0]>,
): ProviderResolver & { providers: Record<RoleName, FakeProvider> } {
  const providers = {
    classifier: new FakeProvider(responses.classifier),
    'direct-answer': new FakeProvider(responses['direct-answer']),
    'bug-triage': new FakeProvider(responses['bug-triage']),
    'product-manager': new FakeProvider(responses['product-manager']),
    'project-manager': new FakeProvider(responses['project-manager']),
    clerk: new FakeProvider(responses.clerk),
    'qa-engineer': new FakeProvider(responses['qa-engineer']),
    evaluator: new FakeProvider(responses.evaluator),
  };

  return {
    providers,
    getProviderForRole(role: string) {
      const provider = providers[role as RoleName];
      if (!provider) {
        throw new Error(`No fake provider configured for role: ${role}`);
      }
      return provider;
    },
  };
}

function createCallbacks(options?: {
  onPause?: PipelineCallbacks['onPause'];
}): {
  callbacks: PipelineCallbacks;
  events: {
    stages: string[];
    errors: string[];
    pauses: string[];
    verifications: string[];
    simpleResponses: string[];
    summary: { completed_tasks: number; failed_tasks: number; skipped_tasks: number } | null;
  };
} {
  const events = {
    stages: [] as string[],
    errors: [] as string[],
    pauses: [] as string[],
    verifications: [] as string[],
    simpleResponses: [] as string[],
    summary: null as { completed_tasks: number; failed_tasks: number; skipped_tasks: number } | null,
  };

  const callbacks: PipelineCallbacks = {
    onStageStart(stage) {
      events.stages.push(stage);
    },
    onStageComplete() {},
    onQuestion: async () => ({}),
    onRequirementReview: async () => true,
    onPlanReview: async () => true,
    onTaskStart() {},
    onTaskComplete() {},
    onPause: async (reason) => {
      events.pauses.push(reason);
      if (options?.onPause) {
        return options.onPause(reason);
      }
      return 'continue';
    },
    onSimpleResponse(response) {
      events.simpleResponses.push(response);
    },
    onSummary(summary) {
      events.summary = {
        completed_tasks: summary.completed_tasks,
        failed_tasks: summary.failed_tasks,
        skipped_tasks: summary.skipped_tasks,
      };
    },
    onError(error) {
      events.errors.push(error);
    },
    onVerification(taskId, report) {
      events.verifications.push(`${taskId}:${report.allPassed}`);
    },
  };

  return { callbacks, events };
}

async function writeFailingTestProject(workingDir: string): Promise<void> {
  await mkdir(join(workingDir, 'tests'), { recursive: true });
  await writeFile(
    join(workingDir, 'package.json'),
    JSON.stringify(
      {
        name: 'verify-fixture',
        version: '1.0.0',
        scripts: {
          test: 'bun test tests/failing.test.ts',
        },
      },
      null,
      2,
    ),
    'utf-8',
  );
  await writeFile(
    join(workingDir, 'tests', 'failing.test.ts'),
    [
      "import { expect, test } from 'bun:test';",
      '',
      "test('forced failure', () => {",
      '  expect(1).toBe(2);',
      '});',
      '',
    ].join('\n'),
    'utf-8',
  );
}
