import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger, LogContext } from "../src/observability/logger.js";
import { instanceLeasePath, storageFilePath } from "../src/runtime/paths.js";
import { RuntimeLifecycle } from "../src/runtime/runtime-lifecycle.js";
import { InstanceAlreadyRunningError, SingleInstanceLease } from "../src/runtime/single-instance-lease.js";

class RecordingLogger implements Logger {
  readonly events: string[] = [];
  info(event: string, _context?: LogContext): void { this.events.push(event); }
  warn(event: string, _context?: LogContext): void { this.events.push(event); }
  error(event: string, _context?: LogContext): void { this.events.push(event); }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("runtime deployment behavior", () => {
  it("keeps all durable files beneath the configured volume path", () => {
    expect(storageFilePath("/data")).toBe("/data/exodus-bot.json");
    expect(instanceLeasePath("/data")).toBe("/data/.exodus-bot-instance");
  });

  it("serializes processes using the same persistent directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exodus-lease-"));
    temporaryDirectories.push(directory);
    const path = instanceLeasePath(directory);
    const first = await SingleInstanceLease.acquire(path);

    await expect(SingleInstanceLease.acquire(path)).rejects.toBeInstanceOf(InstanceAlreadyRunningError);
    await first.release();
    const second = await SingleInstanceLease.acquire(path);
    await second.release();
  });

  it("recovers a stale or interrupted lease file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exodus-stale-"));
    temporaryDirectories.push(directory);
    const path = instanceLeasePath(directory);
    await writeFile(path, "incomplete", { mode: 0o600 });

    const lease = await SingleInstanceLease.acquire(path);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: process.pid });
    await lease.release();
  });

  it("aborts polling, waits for it, closes Discord, and releases the lease once", async () => {
    const abortController = new AbortController();
    const logger = new RecordingLogger();
    const order: string[] = [];
    let finishPoller: (() => void) | undefined;
    const poller = new Promise<void>((resolve) => { finishPoller = resolve; });
    abortController.signal.addEventListener("abort", () => order.push("abort"));
    const closeDiscord = vi.fn(() => { order.push("discord"); });
    const releaseLease = vi.fn(async () => { order.push("lease"); });
    const lifecycle = new RuntimeLifecycle({ abortController, closeDiscord, releaseLease, logger });
    lifecycle.attachPoller(poller);

    const first = lifecycle.shutdown("SIGTERM");
    const second = lifecycle.shutdown("SIGINT");
    await Promise.resolve();
    expect(order).toEqual(["abort"]);
    finishPoller?.();
    await Promise.all([first, second]);

    expect(order).toEqual(["abort", "discord", "lease"]);
    expect(closeDiscord).toHaveBeenCalledTimes(1);
    expect(releaseLease).toHaveBeenCalledTimes(1);
    expect(logger.events).toEqual(["application_shutdown_started", "application_shutdown_completed"]);
  });

  it("still releases the lease if Discord cleanup fails", async () => {
    const releaseLease = vi.fn(async () => {});
    const lifecycle = new RuntimeLifecycle({
      abortController: new AbortController(),
      closeDiscord: () => { throw new Error("close failed"); },
      releaseLease,
      logger: new RecordingLogger(),
    });

    await expect(lifecycle.shutdown("startup_failure")).rejects.toThrow("close failed");
    expect(releaseLease).toHaveBeenCalledOnce();
  });
});
