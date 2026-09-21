import type { Logger } from "../observability/logger.js";

export interface RuntimeLifecycleOptions {
  abortController: AbortController;
  closeDiscord: () => void | Promise<void>;
  releaseLease: () => Promise<void>;
  logger: Logger;
}

export class RuntimeLifecycle {
  private pollerTask: Promise<void> | undefined;
  private shutdownTask: Promise<void> | undefined;

  constructor(private readonly options: RuntimeLifecycleOptions) {}

  attachPoller(task: Promise<void>): void {
    if (this.pollerTask) throw new Error("The polling task is already attached.");
    this.pollerTask = task;
  }

  shutdown(reason: "SIGINT" | "SIGTERM" | "startup_failure"): Promise<void> {
    this.shutdownTask ??= this.performShutdown(reason);
    return this.shutdownTask;
  }

  private async performShutdown(reason: string): Promise<void> {
    this.options.logger.info("application_shutdown_started", { reason });
    this.options.abortController.abort();

    try {
      await this.pollerTask;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        this.options.logger.error("poller_shutdown_failed", {
          code: "BACKGROUND_TASK_SHUTDOWN_FAILED",
        });
      }
    } finally {
      try {
        await this.options.closeDiscord();
      } finally {
        await this.options.releaseLease();
      }
    }

    this.options.logger.info("application_shutdown_completed", { reason });
  }
}
