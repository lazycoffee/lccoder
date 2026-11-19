#!/usr/bin/env bun
/**
 * 完整流水线黑盒测试（真实模型）
 * 从用户输入开始，通过 Orchestrator 触发所有角色：
 * classifier -> product-manager -> project-manager -> clerk -> qa-engineer -> evaluator
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, type LccoderConfig } from '../src/config/index.js';
import { ProviderFactory } from '../src/llm/factory.js';
import { DocumentStore } from '../src/documents/store.js';
import { Orchestrator, type PipelineCallbacks } from '../src/pipeline/orchestrator.js';
import type { Summary } from '../src/schemas/result.js';

const PROMPTS_DIR = join(import.meta.dir, '../prompts');
const REPO_ROOT = join(import.meta.dir, '..');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function log(icon: string, msg: string) {
  console.log(`${icon} ${msg}`);
}

function pass(msg: string) { log(`${GREEN}✓${RESET}`, msg); }
function fail(msg: string) { log(`${RED}✗${RESET}`, msg); }
function info(msg: string) { log(`${CYAN}ℹ${RESET}`, msg); }
function warn(msg: string) { log(`${YELLOW}⚠${RESET}`, msg); }
function detail(msg: string) {
  console.log(`  ${DIM}${msg}${RESET}`);
}
function section(msg: string) {
  console.log(`\n${BOLD}━━━ ${msg} ━━━${RESET}`);
}

async function main() {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'lccoder-full-blackbox-'));

  try {
    await seedFixtureProject(fixtureDir);

    const config = buildRuntimeConfig(fixtureDir);
    const providerName = config.provider === 'minimax' ? 'MiniMax' : 'Ollama';
    const endpoint = config.provider === 'minimax'
      ? (config.minimax?.baseURL || 'https://api.minimaxi.com/v1')
      : config.ollamaHost;

    console.log(`\n${BOLD}${CYAN}lccoder 完整流水线黑盒测试${RESET}`);
    console.log(`${DIM}提供商: ${providerName} | 模型: ${config.model} | 地址: ${endpoint}${RESET}\n`);

    const factory = new ProviderFactory(config);
    const health = await factory.getDefaultProvider().checkHealth(config.model);
    if (!health.connected || !health.modelAvailable) {
      fail(`模型环境不可用: ${health.error || '未连接或模型不存在'}`);
      process.exit(1);
    }
    pass('真实模型健康检查通过');

    const store = new DocumentStore(fixtureDir);
    const { callbacks, state } = createCallbacks();
    const orchestrator = new Orchestrator({
      factory,
      config,
      store,
      callbacks,
      promptsDir: PROMPTS_DIR,
    });

    const request = [
      '请在当前项目中实现一个完整的问候功能。',
      '具体要求：',
      '1. 创建 `src/greeting.ts`，导出 `greet(name: string): string`，返回 `Hello, ${name}!`。',
      '2. 修改 `src/index.ts`，保留现有导出，并新增导出 `./greeting`。',
      '3. 新增 `tests/greeting.test.ts`，使用 `bun:test` 验证 `greet(\"QA\")` 返回 `Hello, QA!`。',
      '4. 确保 `bun test` 可以通过。',
      '5. 不要修改无关文件。',
    ].join('\n');

    section('执行完整流水线');
    const startedAt = Date.now();
    await orchestrator.run(request);
    detail(`耗时: ${Date.now() - startedAt}ms`);

    section('验证角色覆盖');
    const sessions = await store.listSessions();
    const roles = new Set(sessions.map((session) => session.role));
    const expectedRoles = [
      'classifier',
      'product-manager',
      'project-manager',
      'clerk',
      'qa-engineer',
      'evaluator',
    ];

    for (const role of expectedRoles) {
      if (!roles.has(role)) {
        fail(`未触发角色: ${role}`);
        process.exit(1);
      }
      pass(`已触发角色: ${role}`);
    }

    section('验证真实产物');
    const greetingContent = await readFile(join(fixtureDir, 'src/greeting.ts'), 'utf-8');
    const indexContent = await readFile(join(fixtureDir, 'src/index.ts'), 'utf-8');
    const testContent = await readFile(join(fixtureDir, 'tests/greeting.test.ts'), 'utf-8');

    if (!greetingContent.includes('export function greet')) {
      fail('未生成预期的 greet 函数');
      process.exit(1);
    }
    if (!greetingContent.includes('Hello, ${name}!')) {
      fail('greet 函数返回内容不符合预期');
      process.exit(1);
    }
    if (!indexContent.includes('./greeting')) {
      fail('src/index.ts 未导出 greeting 模块');
      process.exit(1);
    }
    if (!testContent.includes('bun:test') || !testContent.includes('Hello, QA!')) {
      fail('测试文件内容不符合预期');
      process.exit(1);
    }

    detail(`src/greeting.ts:\n${greetingContent}`);
    detail(`src/index.ts:\n${indexContent}`);
    detail(`tests/greeting.test.ts:\n${testContent}`);
    pass('代码与测试文件均已生成');

    section('运行真实测试命令');
    const testRun = await runCommand('bun test', fixtureDir);
    detail(`退出码: ${testRun.exitCode}`);
    if (testRun.stdout.trim()) detail(`stdout:\n${testRun.stdout.trim()}`);
    if (testRun.stderr.trim()) detail(`stderr:\n${testRun.stderr.trim()}`);
    if (testRun.exitCode !== 0) {
      fail('fixture 项目的 bun test 未通过');
      process.exit(1);
    }
    pass('fixture 项目的 bun test 通过');

    section('验证文档产物');
    const documentFiles = await readdir(join(fixtureDir, '.lccoder', 'documents'));
    const hasRequirement = documentFiles.some((name) => name.startsWith('requirement-'));
    const hasPlan = documentFiles.some((name) => name.startsWith('plan-'));
    const hasQaReport = documentFiles.some((name) => name.startsWith('qa-report-'));
    const hasEvaluation = documentFiles.some((name) => name.startsWith('evaluation-'));
    const hasSummary = documentFiles.some((name) => name.startsWith('summary-'));

    if (!hasRequirement || !hasPlan || !hasQaReport || !hasEvaluation || !hasSummary) {
      fail(`文档产物不完整: ${documentFiles.join(', ')}`);
      process.exit(1);
    }
    pass('需求、计划、QA 报告、评估与总结文档均已落盘');

    section('验证流程状态');
    if (state.simpleResponse !== null) {
      fail('请求被错误地走成 simple response');
      process.exit(1);
    }
    if (state.errors.length > 0) {
      fail(`流水线出现错误: ${state.errors.join(' | ')}`);
      process.exit(1);
    }
    if (state.summary === null) {
      fail('未收到最终 summary');
      process.exit(1);
    }
    if (state.summary.failed_tasks > 0) {
      fail(`summary 中存在失败任务: ${state.summary.failed_tasks}`);
      process.exit(1);
    }
    if (state.pauses.length > 0) {
      warn(`流程中出现 pause，但最终已继续: ${state.pauses.join(' | ')}`);
    }

    detail(`阶段顺序: ${state.stages.join(' -> ')}`);
    pass('完整流水线黑盒测试通过');
    pass(`fixture 目录: ${fixtureDir}`);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

function buildRuntimeConfig(workingDir: string): LccoderConfig {
  const base = loadConfig(REPO_ROOT);
  const preferMiniMax = !!process.env.MINIMAX_API_KEY && (base.provider === 'ollama');

  const provider = preferMiniMax ? 'minimax' : base.provider;
  const model = preferMiniMax && base.model === 'gemma4:latest' ? 'MiniMax-M2.5' : base.model;

  return {
    ...base,
    provider,
    model,
    minimax: provider === 'minimax'
      ? {
          apiKey: base.minimax?.apiKey || process.env.MINIMAX_API_KEY || '',
          baseURL: base.minimax?.baseURL || 'https://api.minimaxi.com/v1',
        }
      : base.minimax,
    safety: {
      ...base.safety,
      workingDir,
      allowShellExec: false,
      allowFileWrite: true,
    },
  };
}

function createCallbacks(): {
  callbacks: PipelineCallbacks;
  state: {
    stages: string[];
    pauses: string[];
    errors: string[];
    summary: Summary | null;
    simpleResponse: string | null;
  };
} {
  const state = {
    stages: [] as string[],
    pauses: [] as string[],
    errors: [] as string[],
    summary: null as Summary | null,
    simpleResponse: null as string | null,
  };

  const callbacks: PipelineCallbacks = {
    onStageStart(stage, description) {
      state.stages.push(stage);
      info(`[${stage}] ${description}`);
    },
    onStageComplete(stage, durationMs) {
      detail(`[${stage}] complete${durationMs ? ` (${durationMs}ms)` : ''}`);
    },
    async onQuestion(questions) {
      const answers: Record<string, string> = {};
      for (const question of questions) {
        answers[question] = '使用 TypeScript 和 bun:test，保持当前项目的简单风格，不引入额外依赖。';
      }
      return answers;
    },
    async onRequirementReview(requirement) {
      detail(`需求确认: ${requirement.requirement.summary}`);
      return true;
    },
    async onPlanReview(plan) {
      detail(`计划确认: ${plan.summary}`);
      return true;
    },
    onTaskStart(taskId, title, index, total) {
      info(`任务 ${index}/${total}: ${taskId} - ${title}`);
    },
    onTaskComplete(taskId, success, summary) {
      detail(`任务完成: ${taskId} | success=${success} | ${summary}`);
    },
    async onPause(reason) {
      state.pauses.push(reason);
      warn(`pause: ${reason}`);
      return 'continue';
    },
    onSimpleResponse(response) {
      state.simpleResponse = response;
    },
    onSummary(summary) {
      state.summary = summary;
      detail(`summary: completed=${summary.completed_tasks}, failed=${summary.failed_tasks}, skipped=${summary.skipped_tasks}`);
    },
    onError(error) {
      state.errors.push(error);
      warn(`error: ${error}`);
    },
    async onToolConfirm() {
      return true;
    },
    onVerification(taskId, report) {
      detail(`verification: ${taskId} -> ${report.allPassed}`);
    },
  };

  return { callbacks, state };
}

async function seedFixtureProject(workingDir: string): Promise<void> {
  await mkdir(join(workingDir, 'src'), { recursive: true });
  await mkdir(join(workingDir, 'tests'), { recursive: true });

  await writeFile(
    join(workingDir, 'README.md'),
    '# Full Blackbox Fixture\n\n用于测试完整流水线黑盒场景。\n',
    'utf-8',
  );

  await writeFile(
    join(workingDir, 'package.json'),
    JSON.stringify(
      {
        name: 'full-blackbox-fixture',
        version: '1.0.0',
        type: 'module',
        scripts: {
          test: 'bun test',
        },
      },
      null,
      2,
    ),
    'utf-8',
  );

  await writeFile(
    join(workingDir, 'src/index.ts'),
    [
      'export const fixtureName = "full-blackbox-fixture";',
      '',
    ].join('\n'),
    'utf-8',
  );
}

async function runCommand(command: string, cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['sh', '-c', command], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { exitCode, stdout, stderr };
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
