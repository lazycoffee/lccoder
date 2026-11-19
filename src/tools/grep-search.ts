/**
 * 工具：代码搜索 (grep)
 */
import { resolve } from 'path';
import type { ToolDefinition } from '../llm/provider.js';

export const grepSearchTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'grep_search',
    description: '在项目文件中搜索指定内容。返回匹配的文件名和行号。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '搜索的文本模式',
        },
        path: {
          type: 'string',
          description: '搜索的目录路径，默认为 "."（项目根目录）',
        },
        file_pattern: {
          type: 'string',
          description: '文件过滤模式，如 "*.ts"，"*.py"',
        },
      },
      required: ['pattern'],
    },
  },
};

export async function grepSearchExecutor(
  args: Record<string, unknown>,
  workingDir: string = process.cwd(),
): Promise<unknown> {
  const pattern = String(args.pattern);
  const searchPath = resolve(workingDir, String(args.path || '.'));
  const filePattern = args.file_pattern ? String(args.file_pattern) : undefined;

  try {
    const grepArgs = ['grep', '-rn', '--max-count=5'];
    if (filePattern) {
      grepArgs.push('--include', filePattern);
    }
    grepArgs.push(pattern, searchPath);

    const proc = Bun.spawn(grepArgs, {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    if (!output.trim()) {
      return `未找到匹配 "${pattern}" 的内容`;
    }

    // 限制输出
    const lines = output.trim().split('\n').slice(0, 20);
    const relative = lines.map((line) => line.replace(`${workingDir}/`, ''));
    return relative.join('\n');
  } catch (err: any) {
    return `搜索错误: ${err.message}`;
  }
}
