#!/usr/bin/env bun
/**
 * QA Engineer 黑盒测试（真实模型）
 * 使用真实模型执行真实任务，并由 qa-engineer 复核产物与结果。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Dispatcher } from '../src/pipeline/dispatcher.js';
import { DEFAULT_CONFIG, loadConfig } from '../src/config/index.js';
import { DocumentStore } from '../src/documents/store.js';
import type { Plan } from '../src/schemas/plan.js';
import { ProviderFactory } from '../src/llm/factory.js';

const PROMPTS_DIR = join(import.meta.dir, '../prompts');

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
function section(msg: string) {
  console.log(`\n${BOLD}━━━ ${msg} ━━━${RESET}`);
}
function detail(msg: string) {
  console.log(`  ${DIM}${msg}${RESET}`);
}

async function main() {
  const config = loadConfig(join(import.meta.dir, '..'));
  const factory = new ProviderFactory(config);
  const provider = factory.getDefaultProvider();
  const providerName = config.provider === 'minimax' ? 'MiniMax' : 'Ollama';
  const endpoint = config.provider === 'minimax'
    ? (config.minimax?.baseURL || 'https://api.minimaxi.com/v1')
    : config.ollamaHost;

  console.log(`\n${BOLD}${CYAN}lccoder QA Engineer 黑盒测试${RESET}`);
  console.log(`${DIM}提供商: ${providerName} | 模型: ${config.model} | 地址: ${endpoint}${RESET}\n`);

  const health = await provider.checkHealth(config.model);
  if (!health.connected || !health.modelAvailable) {
    fail(`模型环境不可用: ${health.error || '未连接或模型不存在'}`);
    process.exit(1);
  }
  pass('真实模型健康检查通过');

  const fixtureDir = await mkdtemp(join(tmpdir(), 'lccoder-qa-blackbox-'));
  const store = new DocumentStore(fixtureDir);

  try {
    await store.init();
    await seedFixtureProject(fixtureDir);

    const plan: Plan = {
      id: 'plan-qa-blackbox-001',
      source_requirement: 'req-qa-blackbox-001',
      created_by: 'project-manager',
      timestamp: new Date().toISOString(),
      summary: '创建 greeting 模块并导出 greet 函数',
      tasks: [
        {
          id: 'task-qa-blackbox-001',
          order: 1,
          type: 'write',
          title: '创建 src/greeting.ts',
          description: '创建 greeting 模块，导出 greet(name: string): string 函数。',
          input_files: ['package.json', 'README.md'],
          output_files: ['src/greeting.ts'],
          depends_on: [],
          estimated_complexity: 'simple',
          instructions: [
            '请在当前项目中创建 `src/greeting.ts`。',
            '导出 `greet(name: string): string` 函数。',
            '函数返回 `Hello, ${name}!`。',
            '优先使用 file_read / file_write / file_patch 工具。',
            '完成后输出标准 JSON 结果报告。',
          ].join('\n'),
          verification: 'src/greeting.ts 存在，并且 greet("QA") 返回 "Hello, QA!"。',
          status: 'pending',
        },
      ],
      critical_path: ['task-qa-blackbox-001'],
    };

    const dispatcher = new Dispatcher({
      clerkProvider: provider,
      qaProvider: provider,
      evaluatorProvider: provider,
      clerkModel: config.roles.clerk?.model || config.model,
      qaModel: config.roles['qa-engineer']?.model || config.model,
      evaluatorModel: config.roles.evaluator?.model || config.model,
      promptsDir: PROMPTS_DIR,
      maxRetries: config.execution.maxRetries,
      enableVerification: true,
      workingDir: fixtureDir,
    });

    section('执行真实任务');
    const startedAt = Date.now();
    const result = await dispatcher.dispatchTask(plan.tasks[0]!, plan);
    detail(`耗时: ${Date.now() - startedAt}ms`);

    await store.saveDocument('qa-blackbox-result', result.result);
    await store.saveDocument('qa-blackbox-qa-report', result.qaReport);
    await store.saveDocument('qa-blackbox-evaluation', result.evaluation);

    section('验证真实产物');
    const fileContent = await readFile(join(fixtureDir, 'src/greeting.ts'), 'utf-8');
    detail(`src/greeting.ts:\n${fileContent}`);

    if (!fileContent.includes('export function greet')) {
      fail('目标文件不存在预期函数声明');
      process.exit(1);
    }
    if (!fileContent.includes('Hello, ${name}!') && !fileContent.includes('Hello, ')) {
      fail('目标文件未生成预期问候语实现');
      process.exit(1);
    }
    pass('真实文件产物符合最低验收标准');

    section('验证 QA Engineer 报告');
    if (!result.qaReport) {
      fail('qa-engineer 未返回有效的结构化测试报告');
      process.exit(1);
    }

    detail(`verdict: ${result.qaReport.verdict}`);
    detail(`reason: ${result.qaReport.reason}`);
    detail(`coverage score: ${result.qaReport.requirement_coverage.score}`);

    if (result.qaReport.tested_by !== 'qa-engineer') {
      fail('qa-engineer 报告的 tested_by 字段不正确');
      process.exit(1);
    }
    if (result.qaReport.task_id !== plan.tasks[0]!.id) {
      fail('qa-engineer 报告的 task_id 不匹配');
      process.exit(1);
    }
    if (!result.qaReport.artifact_validation.passed) {
      fail('qa-engineer 认为真实产物校验未通过');
      process.exit(1);
    }
    if (result.qaReport.verdict === 'fail') {
      fail('qa-engineer 最终判定为 fail');
      process.exit(1);
    }
    pass('qa-engineer 成功复核真实产物');

    section('验证流程决策');
    if (!result.evaluation) {
      fail('evaluator 未返回有效评估结果');
      process.exit(1);
    }

    detail(`decision: ${result.evaluation.decision}`);
    detail(`reason: ${result.evaluation.reason}`);

    if (result.evaluation.decision !== 'continue') {
      warn(`evaluator decision = ${result.evaluation.decision}，未达到预期 continue`);
      process.exit(1);
    }
    pass('评估器基于 QA 报告选择继续流程');

    section('结果');
    pass(`黑盒测试通过。fixture 目录: ${fixtureDir}`);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

async function seedFixtureProject(workingDir: string): Promise<void> {
  await mkdir(join(workingDir, 'src'), { recursive: true });

  await writeFile(
    join(workingDir, 'README.md'),
    '# QA Fixture\n\n用于测试 qa-engineer 的真实黑盒场景。\n',
    'utf-8',
  );

  await writeFile(
    join(workingDir, 'package.json'),
    JSON.stringify(
      {
        name: 'qa-blackbox-fixture',
        version: '1.0.0',
        type: 'module',
        scripts: {
          test: 'echo "qa blackbox fixture ok"',
        },
      },
      null,
      2,
    ),
    'utf-8',
  );

  await writeFile(
    join(workingDir, 'src/index.ts'),
    'export const fixture = true;\n',
    'utf-8',
  );
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
