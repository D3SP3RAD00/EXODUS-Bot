import { describe, expect, it } from "vitest";

import { redactLogValue } from "../src/observability/logger.js";

describe("structured log redaction", () => {
  it("redacts Discord, Nitrado, and generic credential-shaped fields and values", () => {
    const redacted = redactLogValue({
      discordToken: "discord-secret",
      nitradoApiKey: "nitrado-secret",
      nested: { authorization: "Bearer abc.def.ghi", cookie: "session-secret" },
      errorMessage: "request failed token=raw-secret&safe=yes",
      downloadUrl: "https://files.nitrado.net/download/private.ADM?token=temporary&signature=signed",
      signedError: "failed https://files.nitrado.net/download/private.ADM?X-Amz-Credential=name&X-Amz-Signature=value",
      opaqueTemporaryUrl: "failed https://files.nitrado.net/download/opaque-path",
      safeMessage: "connection timed out",
    });
    expect(redacted).toEqual({
      discordToken: "[REDACTED]",
      nitradoApiKey: "[REDACTED]",
      nested: { authorization: "[REDACTED]", cookie: "[REDACTED]" },
      errorMessage: "request failed token=[REDACTED]&safe=yes",
      downloadUrl: "[REDACTED]",
      signedError: "failed [REDACTED_URL]",
      opaqueTemporaryUrl: "[REDACTED]",
      safeMessage: "connection timed out",
    });
  });
});
