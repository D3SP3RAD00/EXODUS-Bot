import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const requiredEnvironment = {
  DISCORD_BOT_TOKEN: "placeholder",
  DISCORD_APPLICATION_ID: "123",
  DISCORD_GUILD_ID: "456",
  DATA_DIRECTORY: "/data",
  NITRADO_TOKEN: "placeholder-token",
  NITRADO_SERVICE_ID: "1234567",
};

describe("configuration", () => {
  it("supports a configurable persistent storage directory", () => {
    const config = loadConfig({
      ...requiredEnvironment,
      DATA_DIRECTORY: "/persistent/exodus",
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
        ...requiredEnvironment,
        NITRADO_SERVICE_ID: serviceId,
      })).toThrow();
    }
  );

  it.each(Object.keys(requiredEnvironment))("rejects missing required variable %s", (name) => {
    const environment = { ...requiredEnvironment } as Record<string, string | undefined>;
    delete environment[name];
    expect(() => loadConfig(environment)).toThrow();
  });

  it.each(Object.keys(requiredEnvironment))("rejects blank required variable %s", (name) => {
    expect(() => loadConfig({ ...requiredEnvironment, [name]: "" })).toThrow();
  });

  it("rejects relative persistent storage paths", () => {
    expect(() => loadConfig({ ...requiredEnvironment, DATA_DIRECTORY: "./data" })).toThrow();
  });

  it("rejects whitespace-only credentials", () => {
    expect(() => loadConfig({ ...requiredEnvironment, NITRADO_TOKEN: "   " })).toThrow();
  });

  it("rejects a backoff range whose minimum exceeds its maximum", () => {
    expect(() => loadConfig({
      ...requiredEnvironment,
      NITRADO_BACKOFF_BASE_MS: "5000",
      NITRADO_BACKOFF_MAX_MS: "1000",
    })).toThrow();
  });
});
