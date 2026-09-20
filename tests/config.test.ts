import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("configuration", () => {
  it("supports a configurable persistent storage directory", () => {
    const config = loadConfig({
      DISCORD_BOT_TOKEN: "placeholder",
      DISCORD_APPLICATION_ID: "123",
      DISCORD_GUILD_ID: "456",
      DATA_DIRECTORY: "/persistent/exodus",
      NITRADO_TOKEN: "placeholder-token",
      NITRADO_SERVICE_ID: "1234567",
      NITRADO_LOG_DIRECTORY: "",
    });
    expect(config.DATA_DIRECTORY).toBe("/persistent/exodus");
    expect(config.NITRADO_SERVICE_ID).toBe(1_234_567);
    expect(config.NITRADO_LOG_DIRECTORY).toBeUndefined();
    expect(config.NITRADO_POLL_INTERVAL_MS).toBe(60_000);
    expect(config.NITRADO_MAX_DOWNLOAD_BYTES).toBe(16_777_216);
  });

  it.each(["", " ", "0", "-1", "+1", "1.0", "1e3", "01", "9007199254740992"])(
    "rejects malformed service ID %j",
    (serviceId) => {
      expect(() => loadConfig({
        DISCORD_BOT_TOKEN: "placeholder",
        DISCORD_APPLICATION_ID: "123",
        DISCORD_GUILD_ID: "456",
        NITRADO_TOKEN: "placeholder-token",
        NITRADO_SERVICE_ID: serviceId,
      })).toThrow();
    }
  );
});
