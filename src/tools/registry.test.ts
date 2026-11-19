import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { getToolExecutors } from './registry.js';

describe('tool registry', () => {
  it('binds tool executors to the provided working directory', async () => {
    const workingDir = await mkdtemp(join(tmpdir(), 'lccoder-tools-'));
    const filePath = join(workingDir, 'sample.txt');
    await writeFile(filePath, 'alpha\nbeta\n', 'utf-8');

    const executors = getToolExecutors('clerk', workingDir);

    const fileRead = executors.get('file_read');
    const grepSearch = executors.get('grep_search');
    const filePatch = executors.get('file_patch');

    expect(fileRead).toBeDefined();
    expect(grepSearch).toBeDefined();
    expect(filePatch).toBeDefined();

    const readResult = await fileRead!({ path: 'sample.txt' });
    expect(readResult).toContain('alpha');

    const grepResult = await grepSearch!({ pattern: 'beta', path: '.', file_pattern: '*.txt' });
    expect(grepResult).toContain('sample.txt:2:beta');

    await filePatch!({ path: 'sample.txt', search: 'beta', replace: 'gamma' });
    const patched = await readFile(filePath, 'utf-8');
    expect(patched).toContain('gamma');
  });
});
