import { describe, expect, it } from "vitest";

import { playersMessage, playtimeMessage, statusMessage } from "../src/core/queries.js";
import { createEmptyState } from "../src/core/state.js";

describe("Discord query messages", () => {
  it("returns deterministic empty-state status and player messages", () => {
    const state = createEmptyState();
    expect(statusMessage(state)).toContain("Tracked players: 0");
    expect(statusMessage(state)).toContain("Waiting for Nitrado adapter connection");
    expect(playersMessage(state)).toBe("No players currently have an active session.");
  });

  it("returns an admin-facing error for an unknown playtime lookup", () => {
    expect(() => playtimeMessage(createEmptyState(), "Nobody")).toThrow("No tracked player matches");
  });
});
