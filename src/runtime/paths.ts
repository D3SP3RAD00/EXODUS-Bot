import { join } from "node:path";

export function storageFilePath(dataDirectory: string): string {
  return join(dataDirectory, "exodus-bot.json");
}

export function instanceLeasePath(dataDirectory: string): string {
  return join(dataDirectory, ".exodus-bot-instance");
}
