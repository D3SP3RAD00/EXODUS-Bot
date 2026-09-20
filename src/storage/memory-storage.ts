import { cloneState, createEmptyState, type BotState } from "../core/state.js";
import type { Storage } from "./storage.js";

export class MemoryStorage implements Storage {
  private state: BotState;
  private queue: Promise<void> = Promise.resolve();

  constructor(initialState: BotState = createEmptyState()) {
    this.state = cloneState(initialState);
  }

  async read(): Promise<BotState> {
    await this.queue;
    return cloneState(this.state);
  }

  async transaction<T>(mutate: (state: BotState) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const draft = cloneState(this.state);
      result = await mutate(draft);
      this.state = draft;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    await operation;
    return result;
  }
}
