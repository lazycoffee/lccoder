import { spawn } from 'bun';
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { resolve, join } from 'path';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { DocumentStore } from '../documents/store.js';
import { loadConfig } from '../config/index.js';
import { loadPipelineState } from '../pipeline/state.js';
import { GuiPipelineController } from './controller.js';

const GUI_ROOT = resolve(import.meta.dir, '../../gui');
const GUI_DIST = join(GUI_ROOT, 'dist');
const GUI_VITE_CONFIG = join(GUI_ROOT, 'vite.config.ts');

function getStore(workingDir: string): DocumentStore {
  return new DocumentStore(workingDir);
}

async function ensureGuiBuilt(): Promise<void> {
  if (existsSync(join(GUI_DIST, 'index.html'))) {
    return;
  }

  await mkdir(GUI_DIST, { recursive: true });
  const proc = spawn(['bunx', 'vite', 'build', '--config', GUI_VITE_CONFIG], {
    cwd: resolve(import.meta.dir, '../..'),
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`GUI build failed with exit code ${exitCode}`);
  }
}

async function collectOverview(workingDir: string) {
  const store = getStore(workingDir);
  await store.init();
  const [config, pipelineState, sessions, documents] = await Promise.all([
    Promise.resolve(loadConfig(workingDir)),
    loadPipelineState(store),
    store.listSessions(),
    store.listDocuments(),
  ]);

  return {
    workingDir,
    provider: config.provider,
    model: config.model,
    pipelineState,
    sessionCount: sessions.length,
    documentCount: documents.length,
    latestSession: sessions[0] || null,
    latestDocument: documents[0] || null,
  };
}

async function collectGuiSnapshot(workingDir: string) {
  const store = getStore(workingDir);
  await store.init();
  const [overview, sessions, documents, runtimeEvents] = await Promise.all([
    collectOverview(workingDir),
    store.listSessions(),
    store.listDocuments(),
    store.listRuntimeEvents(),
  ]);

  return {
    overview,
    sessions,
    documents,
    runtimeEvents,
  };
}

async function collectFullSnapshot(
  workingDir: string,
  controller: GuiPipelineController,
) {
  return {
    ...(await collectGuiSnapshot(workingDir)),
    guiState: controller.getState(),
    canResume: await controller.canResume(),
  };
}

export async function startGuiServer(params?: {
  workingDir?: string;
  port?: number;
}): Promise<void> {
  const workingDir = resolve(params?.workingDir || process.cwd());
  const port = params?.port || 3456;
  const controller = new GuiPipelineController(workingDir);

  await ensureGuiBuilt();

  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/overview', async (c) => {
    return c.json({
      ...(await collectOverview(workingDir)),
      guiState: controller.getState(),
      canResume: await controller.canResume(),
    });
  });

  app.get('/api/events', async () => {
    const stream = new ReadableStream({
      async start(streamController) {
        const encoder = new TextEncoder();
        let closed = false;

        const send = async () => {
          if (closed) return;
          const snapshot = await collectFullSnapshot(workingDir, controller);
          try {
            streamController.enqueue(
              encoder.encode(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`),
            );
          } catch {
            closed = true;
          }
        };

        await send();
        const timer = setInterval(() => {
          if (closed) {
            clearInterval(timer);
            return;
          }
          send().catch((error) => {
            if (!closed) {
              try {
                streamController.enqueue(
                  encoder.encode(`event: error\ndata: ${JSON.stringify({ message: String(error) })}\n\n`),
                );
              } catch {
                closed = true;
              }
            }
          });
        }, 2000);

        if (!closed) {
          streamController.enqueue(encoder.encode(`event: ready\ndata: {"ok":true}\n\n`));
        }

        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          try {
            streamController.close();
          } catch {
            // ignore close race
          }
        };

        this.cancel = close;
      },
      cancel() {},
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  });

  app.get('/api/state', async (c) => {
    const store = getStore(workingDir);
    await store.init();
    const pipelineState = await loadPipelineState(store);
    return c.json({
      pipelineState,
      guiState: controller.getState(),
      canResume: await controller.canResume(),
    });
  });

  app.post('/api/run', async (c) => {
    try {
      const body = await c.req.json<{ userInput?: string; requestedMode?: 'auto' | 'answer' | 'code' | 'debug' }>();
      return c.json({
        ok: true,
        ...(await controller.startRun(body.userInput || '', body.requestedMode || 'auto')),
      });
    } catch (error) {
      return c.json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }, 400);
    }
  });

  app.post('/api/run/resume', async (c) => {
    try {
      return c.json({
        ok: true,
        ...(await controller.resumeRun()),
      });
    } catch (error) {
      return c.json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }, 400);
    }
  });

  app.post('/api/interactions/:id/respond', async (c) => {
    try {
      const body = await c.req.json<{ response?: unknown }>();
      controller.respond(c.req.param('id'), body.response);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }, 400);
    }
  });

  app.get('/api/sessions', async (c) => {
    const store = getStore(workingDir);
    await store.init();
    const sessions = await store.listSessions();
    return c.json({ sessions });
  });

  app.get('/api/sessions/:id', async (c) => {
    const store = getStore(workingDir);
    await store.init();
    const record = await store.loadSession(c.req.param('id'));
    if (!record) {
      return c.json({ error: 'Session not found' }, 404);
    }
    return c.json({ session: record });
  });

  app.get('/api/documents', async (c) => {
    const store = getStore(workingDir);
    await store.init();
    const documents = await store.listDocuments();
    return c.json({ documents });
  });

  app.get('/api/documents/:name', async (c) => {
    const store = getStore(workingDir);
    await store.init();
    const document = await store.loadDocument<Record<string, unknown>>(c.req.param('name'));
    if (!document) {
      return c.json({ error: 'Document not found' }, 404);
    }
    return c.json({ document });
  });

  app.use('/assets/*', serveStatic({ root: GUI_DIST }));
  app.get('/favicon.svg', async (c) => {
    const file = Bun.file(join(GUI_DIST, 'favicon.svg'));
    return new Response(file, {
      headers: { 'content-type': 'image/svg+xml' },
    });
  });
  app.get('*', async () => new Response(Bun.file(join(GUI_DIST, 'index.html'))));

  Bun.serve({
    port,
    fetch: app.fetch,
  });

  console.log(`GUI running at http://localhost:${port}`);
  console.log(`Monitoring workspace: ${workingDir}`);
}
