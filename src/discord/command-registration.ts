import { REST, Routes } from "discord.js";

import { AdminFacingError } from "../core/errors.js";
import type { Logger } from "../observability/logger.js";
import { commands } from "./commands.js";

export type CommandRegistrationRequest = (route: `/${string}`, body: unknown) => Promise<unknown>;

export type CommandRegistrationOptions = {
  token: string;
  applicationId: string;
  guildId: string;
  logger: Logger;
  timeoutMs?: number;
  retryLimit?: number;
  request?: CommandRegistrationRequest;
};

export async function registerGuildCommands(options: CommandRegistrationOptions): Promise<number> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const rest = options.request ? undefined : new REST({ version: "10", timeout: timeoutMs }).setToken(options.token);
  const request = options.request ?? ((route, body) => rest!.put(route, { body }));
  const route = Routes.applicationGuildCommands(options.applicationId, options.guildId);
  const retryLimit = options.retryLimit ?? 1;

  for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
    try {
      await withTimeout(request(route, commands), timeoutMs);
      options.logger.info("discord_commands_registered", { count: commands.length });
      return commands.length;
    } catch {
      if (attempt === retryLimit) break;
    }
  }

  options.logger.error("discord_command_registration_failed", {
    code: "DISCORD_COMMAND_REGISTRATION_FAILED",
    attempts: retryLimit + 1,
  });
  throw new AdminFacingError(
    "DISCORD_COMMAND_REGISTRATION_FAILED",
    "Discord guild commands could not be registered safely."
  );
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new AdminFacingError("DISCORD_COMMAND_REGISTRATION_TIMEOUT", "Command registration timed out.")),
      timeoutMs
    );
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
