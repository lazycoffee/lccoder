import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { classifyRequest } from './classifier.js';
import { FakeProvider, jsonResponse } from '../../tests/helpers/fake-provider.js';

const PROMPTS_DIR = join(import.meta.dir, '../../prompts');

describe('classifyRequest', () => {
  it('honors requested debug mode over model routing output', async () => {
    const provider = new FakeProvider([
      jsonResponse({
        mode: 'answer',
        complexity: 'simple',
        pipelineType: 'direct-answer',
        reason: '模型误判成简单问答',
      }),
    ]);

    const result = await classifyRequest(
      '页面报错了，帮我修一下',
      provider,
      'fake-model',
      PROMPTS_DIR,
      'debug',
    );

    expect(result.decision.mode).toBe('debug');
    expect(result.decision.pipelineType).toBe('debug-pipeline');
    expect(result.decision.complexity).toBe('complex');
    expect(result.decision.reason).toContain('用户手动指定 debug 模式');
  });
});
