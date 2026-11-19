import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig } from './index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('config - minimax support', () => {
  it('loads MiniMax API key from environment and fills default base URL', async () => {
    const previousApiKey = process.env.MINIMAX_API_KEY;
    const workingDir = await mkdtemp(join(tmpdir(), 'lccoder-config-'));
    tempDirs.push(workingDir);

    try {
      process.env.MINIMAX_API_KEY = 'test-minimax-key';
      await mkdir(join(workingDir, '.lccoder'), { recursive: true });
      await writeFile(
        join(workingDir, '.lccoder', 'config.json'),
        JSON.stringify({
          provider: 'minimax',
          model: 'MiniMax-M2.5',
          minimax: {
            apiKey: '',
          },
        }),
        'utf-8',
      );

      const config = loadConfig(workingDir);

      expect(config.provider).toBe('minimax');
      expect(config.minimax?.apiKey).toBe('test-minimax-key');
      expect(config.minimax?.baseURL).toBe('https://api.minimaxi.com/v1');
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.MINIMAX_API_KEY;
      } else {
        process.env.MINIMAX_API_KEY = previousApiKey;
      }
    }
  });
});
