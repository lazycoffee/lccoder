import { describe, it, expect } from 'vitest';
import { extractProjectContext, formatContextForPrompt } from './context.js';

describe('ProjectContextExtractor', () => {
  it('should extract context from the current project', async () => {
    const projectRoot = new URL('../..', import.meta.url).pathname;
    const context = await extractProjectContext(projectRoot);
    
    expect(context.project_type).toBe('Node.js / TypeScript');
    expect(context.tech_stack).toContain('TypeScript');
    expect(context.tech_stack).toContain('Bun');
    expect(context.key_files).toContain('package.json');
    expect(context.key_files).toContain('README.md');
    expect(context.structure).toContain('src');
    expect(context.structure).toContain('prompts');
  });

  it('should format context for prompt', async () => {
    const context = {
      tech_stack: ['TypeScript', 'Bun'],
      key_files: ['package.json', 'README.md'],
      framework: '无',
      project_type: 'Node.js / TypeScript',
      summary: 'lccoder',
      dependencies: { 'ollama': '^0.6.3' },
      devDependencies: { 'vitest': '^4.1.2' },
      structure: ['src', 'prompts'],
    };
    
    const formatted = formatContextForPrompt(context);
    expect(formatted).toContain('## 当前项目上下文');
    expect(formatted).toContain('Node.js / TypeScript');
    expect(formatted).toContain('TypeScript, Bun');
    expect(formatted).toContain('lccoder');
  });
});
