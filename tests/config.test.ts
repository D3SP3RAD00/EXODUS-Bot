import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("configuration", () => {
  it("supports a configurable persistent storage directory", () => {
    const config = loadConfig({
      DISCORD_BOT_TOKEN: "placeholder",
      DISCORD_APPLICATION_ID: "123",
      DISCORD_GUILD_ID: "456",
      DATA_DIRECTORY: "/persistent/exodus",
    });
    expect(config.DATA_DIRECTORY).toBe("/persistent/exodus");
  });
});
