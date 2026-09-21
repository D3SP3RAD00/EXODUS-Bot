import { describe, expect, it, vi } from "vitest";

import { registerGuildCommands } from "../src/discord/command-registration.js";
import type { LogContext, Logger } from "../src/observability/logger.js";

class RecordingLogger implements Logger {
  readonly records: Array<{ level: string; event: string; context?: LogContext }> = [];
  info(event: string, context?: LogContext): void { this.records.push({ level: "info", event, context }); }
  warn(event: string, context?: LogContext): void { this.records.push({ level: "warn", event, context }); }
  error(event: string, context?: LogContext): void { this.records.push({ level: "error", event, context }); }
}

const input = {
  token: "synthetic-discord-token",
  applicationId: "12345678901234567",
  guildId: "23456789012345678",
};

describe("automatic guild command registration", () => {
  it("uses an idempotent guild PUT body and can safely run on every startup", async () => {
    const request = vi.fn(async () => ({}));
    const logger = new RecordingLogger();
    await expect(registerGuildCommands({ ...input, logger, request })).resolves.toBe(3);
    await expect(registerGuildCommands({ ...input, logger, request })).resolves.toBe(3);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toBe(request.mock.calls[1]?.[0]);
    expect(request.mock.calls[0]?.[1]).toEqual(request.mock.calls[1]?.[1]);
    expect(logger.records.filter((record) => record.event === "discord_commands_registered")).toHaveLength(2);
  });

  it("bounds retries and logs only a stable redacted error code", async () => {
    const secret = "sensitive-response-body";
    const request = vi.fn(async () => { throw new Error(`${secret} ${input.token}`); });
    const logger = new RecordingLogger();

    await expect(registerGuildCommands({ ...input, logger, request, retryLimit: 1 }))
      .rejects.toMatchObject({ code: "DISCORD_COMMAND_REGISTRATION_FAILED" });
    expect(request).toHaveBeenCalledTimes(2);
    const serialized = JSON.stringify(logger.records);
    expect(serialized).toContain("DISCORD_COMMAND_REGISTRATION_FAILED");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(input.token);
    expect(serialized).not.toContain(input.guildId);
    expect(serialized).not.toContain(input.applicationId);
  });
});
