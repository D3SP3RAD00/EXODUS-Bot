import { open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

import { cloneState, createEmptyState, type BotState } from "../core/state.js";
import type { Storage } from "./storage.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBotState(value: unknown): value is BotState {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  return [
    "players",
    "sessions",
    "openSessionByPlayer",
    "processedEventKeys",
    "checkpoints",
    "domains",
  ].every((key) => isRecord(value[key]));
}

async function readState(path: string): Promise<BotState | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return isBotState(value) ? value : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

async function writeDurably(path: string, contents: string): Promise<void> {
  const handle = await open(path, "w", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class JsonFileStorage implements Storage {
  private state: BotState | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async read(): Promise<BotState> {
    await this.queue;
    return cloneState(await this.load());
  }

  async transaction<T>(mutate: (state: BotState) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const draft = cloneState(await this.load());
      result = await mutate(draft);
      await this.persist(draft);
      this.state = draft;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    await operation;
    return result;
  }

  private async load(): Promise<BotState> {
    if (this.state) return this.state;

    const primary = await readState(this.filePath);
    if (primary) {
      this.state = primary;
      return primary;
    }

    const temporaryPath = `${this.filePath}.tmp`;
    const backupPath = `${this.filePath}.bak`;
    const recovered = await readState(temporaryPath) ?? await readState(backupPath);
    if (recovered) {
      await this.restore(recovered);
      this.state = recovered;
      return recovered;
    }

    try {
      await readFile(this.filePath, "utf8");
      throw new Error("EXODUS storage is corrupt and no valid recovery file exists.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    this.state = createEmptyState();
    return this.state;
  }

  private async restore(state: BotState): Promise<void> {
    const directory = dirname(this.filePath);
    const recoveryPath = `${this.filePath}.recovery`;
    await mkdir(directory, { recursive: true });
    await writeDurably(recoveryPath, `${JSON.stringify(state, null, 2)}\n`);
    await rename(recoveryPath, this.filePath);
    await this.syncDirectory(directory);
  }

  private async persist(state: BotState): Promise<void> {
    if (!isBotState(state)) throw new Error("Refusing to persist an invalid EXODUS state.");
    const directory = dirname(this.filePath);
    const temporaryPath = `${this.filePath}.tmp`;
    const backupTemporaryPath = `${this.filePath}.bak.tmp`;
    const backupPath = `${this.filePath}.bak`;
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    await mkdir(directory, { recursive: true });
    await writeDurably(temporaryPath, serialized);
    await writeDurably(backupTemporaryPath, serialized);
    await rename(backupTemporaryPath, backupPath);
    await rename(temporaryPath, this.filePath);
    await this.syncDirectory(directory);
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
