import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { DocumentStore } from './store.js';
import type { GuiRuntimeEvent } from '../gui/runtime-events.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('DocumentStore runtime events', () => {
  it('persists runtime events across store instances', async () => {
    const workingDir = await mkdtemp(join(tmpdir(), 'lccoder-store-'));
    tempDirs.push(workingDir);

    const writer = new DocumentStore(workingDir);
    await writer.init();

    const event: GuiRuntimeEvent = {
      type: 'stage-start',
      timestamp: '2026-04-14T00:00:00.000Z',
      payload: {
        stage: 'product-manager',
        description: '产品经理正在分析需求...',
      },
    };

    await writer.appendRuntimeEvent(event);

    const reader = new DocumentStore(workingDir);
    await reader.init();
    const events = await reader.listRuntimeEvents();

    expect(events).toEqual([event]);
  });

  it('keeps only the latest 200 runtime events', async () => {
    const workingDir = await mkdtemp(join(tmpdir(), 'lccoder-store-'));
    tempDirs.push(workingDir);

    const store = new DocumentStore(workingDir);
    await store.init();

    for (let index = 0; index < 205; index += 1) {
      await store.appendRuntimeEvent({
        type: 'task-complete',
        timestamp: `2026-04-14T00:00:${String(index).padStart(2, '0')}.000Z`,
        payload: { index },
      });
    }

    const events = await store.listRuntimeEvents();

    expect(events).toHaveLength(200);
    expect(events[0]?.payload).toEqual({ index: 5 });
    expect(events[199]?.payload).toEqual({ index: 204 });
  });
});
