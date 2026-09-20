import { describe, expect, it } from "vitest";

import { redactLogValue } from "../src/observability/logger.js";

describe("structured log redaction", () => {
  it("redacts Discord, Nitrado, and generic credential-shaped fields and values", () => {
    const redacted = redactLogValue({
      discordToken: "discord-secret",
      nitradoApiKey: "nitrado-secret",
      nested: { authorization: "Bearer abc.def.ghi", cookie: "session-secret" },
      errorMessage: "request failed token=raw-secret&safe=yes",
      safeMessage: "connection timed out",
    });
    expect(redacted).toEqual({
      discordToken: "[REDACTED]",
      nitradoApiKey: "[REDACTED]",
      nested: { authorization: "[REDACTED]", cookie: "[REDACTED]" },
      errorMessage: "request failed token=[REDACTED]&safe=yes",
      safeMessage: "connection timed out",
    });
  });
});
