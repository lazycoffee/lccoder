/**
 * CLI 用户交互函数
 */
import * as p from '@clack/prompts';
import type { Requirement } from '../schemas/requirement.js';
import type { Plan } from '../schemas/plan.js';

/**
 * 获取用户输入
 */
export async function getUserInput(): Promise<string | null> {
  const input = await p.text({
    message: '请输入你的需求：',
    placeholder: '例如：给 Header 组件添加响应式导航菜单',
  });

  if (p.isCancel(input)) return null;
  return input as string;
}

/**
 * 追问用户
 */
export async function askQuestions(questions: string[]): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};

  p.note(
    questions.map((q, i) => `${i + 1}. ${q}`).join('\n'),
    '📋 产品经理有以下问题需要确认',
  );

  for (const question of questions) {
    const answer = await p.text({
      message: question,
      placeholder: '请输入你的回答',
    });

    if (p.isCancel(answer)) {
      return answers;
    }
    answers[question] = answer as string;
  }

  return answers;
}

/**
 * 用户确认需求文档
 */
export async function reviewRequirement(req: Requirement): Promise<boolean> {
  console.log('');
  p.note(
    [
      `📝 ${req.requirement.summary}`,
      '',
      '目标：',
      ...req.requirement.goals.map((g) => `  • ${g}`),
      '',
      '不做的事：',
      ...req.requirement.non_goals.map((g) => `  • ${g}`),
      '',
      '验收标准：',
      ...req.requirement.acceptance_criteria.map((c) => `  • ${c}`),
    ].join('\n'),
    '📋 需求分析报告',
  );

  const confirmed = await p.confirm({
    message: '是否确认这份需求？',
  });

  if (p.isCancel(confirmed)) return false;
  return confirmed as boolean;
}

/**
 * 用户确认工作计划
 */
export async function reviewPlan(plan: Plan): Promise<boolean> {
  console.log('');
  const taskList = plan.tasks
    .sort((a, b) => a.order - b.order)
    .map((t) => `  ${t.order}. [${t.type}] ${t.title} (${t.estimated_complexity})`)
    .join('\n');

  p.note(
    [
      `📋 ${plan.summary}`,
      '',
      `共 ${plan.tasks.length} 个子任务：`,
      '',
      taskList,
    ].join('\n'),
    '🗂️ 工作计划',
  );

  const confirmed = await p.confirm({
    message: '是否确认并开始执行这份计划？',
  });

  if (p.isCancel(confirmed)) return false;
  return confirmed as boolean;
}

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

/**
 * 初始化项目配置
 */
export async function initConfiguration(workingDir: string = process.cwd()): Promise<void> {
  p.intro('初始化 lccoder 项目配置');

  const provider = await p.select({
    message: '选择 LLM 提供商：',
    options: [
      { value: 'ollama', label: 'Ollama (本地)' },
      { value: 'minimax', label: 'MiniMax (云端)' },
    ],
  });

  if (p.isCancel(provider)) return;

  const model = await p.text({
    message: '输入默认模型名称：',
    initialValue: provider === 'ollama' ? 'gemma4:latest' : 'MiniMax-M2.5',
  });

  if (p.isCancel(model)) return;

  let config: any = {
    provider,
    model,
    roles: {},
    execution: {
      maxRetries: 2,
      parallelTasks: false,
      autoConfirm: false,
    },
    safety: {
      allowShellExec: false,
      allowFileWrite: true,
      workingDir: workingDir,
    },
  };

  if (provider === 'ollama') {
    const host = await p.text({
      message: 'Ollama 地址：',
      initialValue: 'http://localhost:11434',
    });
    if (p.isCancel(host)) return;
    config.ollamaHost = host;
  } else {
    const apiKey = await p.text({
      message: 'MiniMax API Key：',
      placeholder: 'sk-xxxxxxxxxxxx',
    });
    if (p.isCancel(apiKey)) return;
    
    const baseURL = await p.text({
      message: 'MiniMax Base URL：',
      initialValue: 'https://api.minimaxi.com/v1',
    });
    if (p.isCancel(baseURL)) return;
    
    config.minimax = {
      apiKey: apiKey as string,
      baseURL: baseURL as string,
    };
  }

  // 保存配置
  const dotDir = join(workingDir, '.lccoder');
  if (!existsSync(dotDir)) {
    await mkdir(dotDir, { recursive: true });
  }

  const configPath = join(dotDir, 'config.json');
  await writeFile(configPath, JSON.stringify(config, null, 2));

  p.note(`配置已保存到 ${configPath}`, '✅ 初始化成功');
}

/**
 * 暂停等待人工决策
 */
export async function pauseForDecision(reason: string): Promise<'continue' | 'abort'> {
  console.log('');
  p.note(reason, '⚠️ 流水线已暂停');

  const decision = await p.select({
    message: '请选择操作：',
    options: [
      { value: 'continue', label: '继续执行后续任务' },
      { value: 'abort', label: '终止流水线' },
    ],
  });

  if (p.isCancel(decision)) return 'abort';
  return decision as 'continue' | 'abort';
}
