import type { AppEventType, AppEvent } from "../types/index";

type Handler<T = unknown> = (event: AppEvent<T>) => void;

export class EventEmitter {
  private listeners = new Map<AppEventType, Set<Handler<unknown>>>();

  on<T>(type: AppEventType, handler: Handler<T>): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(handler as Handler<unknown>);
    return () => this.off(type, handler);
  }

  off<T>(type: AppEventType, handler: Handler<T>): void {
    this.listeners.get(type)?.delete(handler as Handler<unknown>);
  }

  emit<T>(type: AppEventType, payload?: T): void {
    const handlers = this.listeners.get(type);
    if (!handlers) return;
    const event: AppEvent<T> = { type, payload };
    handlers.forEach((h) => h(event as AppEvent<unknown>));
  }

  once<T>(type: AppEventType, handler: Handler<T>): void {
    const wrapped: Handler<T> = (e) => {
      handler(e);
      this.off(type, wrapped);
    };
    this.on(type, wrapped);
  }
}

export const bus = new EventEmitter();
