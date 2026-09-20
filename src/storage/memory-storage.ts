import { cloneState, createEmptyState, type BotState } from "../core/state.js";
import type { Storage } from "./storage.js";

export class MemoryStorage implements Storage {
  private state: BotState;

  constructor(initialState: BotState = createEmptyState()) {
    this.state = cloneState(initialState);
  }

  async read(): Promise<BotState> {
    return cloneState(this.state);
  }

  async transaction<T>(mutate: (state: BotState) => T | Promise<T>): Promise<T> {
    const draft = cloneState(this.state);
    const result = await mutate(draft);
    this.state = draft;
    return result;
  }
}
