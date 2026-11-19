import type { DocumentStore } from '../documents/store.js';
import type { GuiRuntimeEvent } from './runtime-events.js';

type Listener = (event: GuiRuntimeEvent) => void;

class GuiEventBus {
  private listeners = new Set<Listener>();
  private history: GuiRuntimeEvent[] = [];

  publish(event: GuiRuntimeEvent): void {
    this.history.push(event);
    if (this.history.length > 200) {
      this.history.shift();
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getHistory(): GuiRuntimeEvent[] {
    return [...this.history];
  }
}

export const guiEventBus = new GuiEventBus();

function createEvent(
  type: GuiRuntimeEvent['type'],
  payload: Record<string, unknown>,
): GuiRuntimeEvent {
  return {
    type,
    payload,
    timestamp: new Date().toISOString(),
  };
}

export function emitGuiEvent(
  type: GuiRuntimeEvent['type'],
  payload: Record<string, unknown>,
): void {
  guiEventBus.publish(createEvent(type, payload));
}

export function createGuiEventEmitter(store: DocumentStore) {
  return (type: GuiRuntimeEvent['type'], payload: Record<string, unknown>): void => {
    const event = createEvent(type, payload);
    guiEventBus.publish(event);
    void store.appendRuntimeEvent(event).catch(() => {
      // GUI 事件持久化失败不应中断主流程
    });
  };
}
