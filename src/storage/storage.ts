import type { BotState } from "../core/state.js";

export interface Storage {
  read(): Promise<BotState>;
  transaction<T>(mutate: (state: BotState) => T | Promise<T>): Promise<T>;
}
