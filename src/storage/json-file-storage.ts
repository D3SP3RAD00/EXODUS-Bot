import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { cloneState, createEmptyState, type BotState } from "../core/state.js";
import type { Storage } from "./storage.js";

export class JsonFileStorage implements Storage {
  private state: BotState | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async read(): Promise<BotState> {
    await this.queue;
    const state = await this.load();
    return cloneState(state);
  }

  async transaction<T>(mutate: (state: BotState) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const draft = cloneState(await this.load());
      result = await mutate(draft);
      await this.persist(draft);
      this.state = draft;
    });

    this.queue = operation.then(
      () => undefined,
      () => undefined
    );
    await operation;
    return result;
  }

  private async load(): Promise<BotState> {
    if (this.state) return this.state;

    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!value || typeof value !== "object" || !("schemaVersion" in value)) {
        throw new Error("Storage file does not contain a supported EXODUS state.");
      }
      this.state = value as BotState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = createEmptyState();
    }

    return this.state;
  }

  private async persist(state: BotState): Promise<void> {
    const directory = dirname(this.filePath);
    const temporaryPath = `${this.filePath}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
