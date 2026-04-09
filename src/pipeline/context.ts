/**
 * 项目上下文自动提取
 * 帮助 AI 快速了解项目，减少探索步数
 */
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

export interface ProjectContext {
  tech_stack: string[];
  key_files: string[];
  framework: string;
  project_type: string;
  summary: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  structure: string[];
}

/**
 * 自动提取项目上下文
 */
export async function extractProjectContext(workingDir: string): Promise<ProjectContext> {
  const context: ProjectContext = {
    tech_stack: [],
    key_files: [],
    framework: '未知',
    project_type: '未知',
    summary: '',
    dependencies: {},
    devDependencies: {},
    structure: [],
  };

  try {
    // 1. 读取目录结构 (只读一层)
    const files = await readdir(workingDir);
    context.structure = files.filter(f => !f.startsWith('.'));

    // 2. 识别项目类型和技术栈 (基于 package.json)
    const packageJsonPath = join(workingDir, 'package.json');
    if (existsSync(packageJsonPath)) {
      context.project_type = 'Node.js / TypeScript';
      const pkg = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
      context.dependencies = pkg.dependencies || {};
      context.devDependencies = pkg.devDependencies || {};
      
      // 提取技术栈
      const allDeps = { 
        ...context.dependencies, 
        ...context.devDependencies,
        ...(pkg.peerDependencies || {})
      };
      if (allDeps['typescript']) context.tech_stack.push('TypeScript');
      if (allDeps['react']) {
        context.tech_stack.push('React');
        context.framework = 'React';
      }
      if (allDeps['vue']) {
        context.tech_stack.push('Vue');
        context.framework = 'Vue';
      }
      if (allDeps['express']) {
        context.tech_stack.push('Express');
        context.framework = 'Express';
      }
      if (allDeps['next']) {
        context.tech_stack.push('Next.js');
        context.framework = 'Next.js';
      }
      if (allDeps['bun-types'] || existsSync(join(workingDir, 'bun.lockb')) || existsSync(join(workingDir, 'bun.lock'))) {
        context.tech_stack.push('Bun');
      }

      context.key_files.push('package.json');
    }

    // 3. 读取 README.md 获取概要
    const readmePath = join(workingDir, 'README.md');
    if (existsSync(readmePath)) {
      const readme = await readFile(readmePath, 'utf-8');
      // 提取第一行作为概要
      const firstLine = readme.split('\n')[0]?.replace(/^#+\s*/, '').trim();
      context.summary = firstLine || '';
      context.key_files.push('README.md');
    }

    // 4. 识别其他语言
    if (existsSync(join(workingDir, 'requirements.txt')) || existsSync(join(workingDir, 'pyproject.toml'))) {
      context.project_type = 'Python';
      context.tech_stack.push('Python');
    }
    if (existsSync(join(workingDir, 'Cargo.toml'))) {
      context.project_type = 'Rust';
      context.tech_stack.push('Rust');
    }
    if (existsSync(join(workingDir, 'go.mod'))) {
      context.project_type = 'Go';
      context.tech_stack.push('Go');
    }

    // 5. 补充关键文件
    const possibleKeyFiles = ['src/index.ts', 'src/main.ts', 'index.js', 'src/index.js'];
    for (const f of possibleKeyFiles) {
      if (existsSync(join(workingDir, f))) {
        context.key_files.push(f);
      }
    }

  } catch (err) {
    console.error('项目上下文提取失败:', err);
  }

  return context;
}

/**
 * 将上下文格式化为 Prompt 友好的字符串
 */
export function formatContextForPrompt(context: ProjectContext): string {
  let output = `## 当前项目上下文 (自动提取)\n\n`;
  output += `- **项目类型**: ${context.project_type}\n`;
  output += `- **技术栈**: ${context.tech_stack.join(', ') || '未知'}\n`;
  output += `- **主要框架**: ${context.framework}\n`;
  if (context.summary) {
    output += `- **项目概要**: ${context.summary}\n`;
  }
  output += `- **关键文件**: ${context.key_files.join(', ')}\n`;
  output += `- **目录结构 (根目录)**: ${context.structure.join(', ')}\n`;
  
  const deps = Object.keys(context.dependencies);
  if (deps.length > 0) {
    output += `- **主要依赖**: ${deps.slice(0, 10).join(', ')}${deps.length > 10 ? '...' : ''}\n`;
  }
  
  return output;
}
