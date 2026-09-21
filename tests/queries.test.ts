import { describe, expect, it } from "vitest";

import { AdminFacingError } from "../src/core/errors.js";
import { playersMessage, playtimeMessage, statusMessage } from "../src/core/queries.js";
import { createEmptyState } from "../src/core/state.js";

describe("Discord query messages", () => {
  it("returns deterministic empty-state status and player messages", () => {
    const state = createEmptyState();
    expect(statusMessage(state)).toContain("Tracked players: 0");
    expect(statusMessage(state)).toContain("ADM state: never");
    expect(statusMessage(state)).toContain("Last successful ingestion: None yet");
    expect(playersMessage(state)).toBe("No players currently have an active session.");
  });

  it("returns an admin-facing error for an unknown playtime lookup", () => {
    expect(() => playtimeMessage(createEmptyState(), "Nobody")).toThrow("No tracked player matches");
  });

  it("handles duplicate aliases deterministically without exposing player IDs", () => {
    const state = createEmptyState();
    state.players.PRIVATE_ID_ONE = {
      playerId: "PRIVATE_ID_ONE",
      currentName: "SharedName",
      aliases: ["SharedName"],
      firstSeenAt: "2026-09-20T10:00:00Z",
      lastSeenAt: "2026-09-20T10:00:00Z",
      accumulatedPlaytimeMs: 60_000,
    };
    state.players.PRIVATE_ID_TWO = {
      playerId: "PRIVATE_ID_TWO",
      currentName: "OtherName",
      aliases: ["OtherName", "sharedname"],
      firstSeenAt: "2026-09-20T10:00:00Z",
      lastSeenAt: "2026-09-20T10:00:00Z",
      accumulatedPlaytimeMs: 120_000,
    };
    let thrown: unknown;
    try {
      playtimeMessage(state, "SHAREDNAME");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AdminFacingError);
    expect(thrown).toMatchObject({ code: "PLAYER_NAME_AMBIGUOUS" });
    expect((thrown as Error).message).toBe("More than one tracked player has used “SHAREDNAME”.");
    expect((thrown as Error).message).not.toContain("PRIVATE_ID");
    expect(playersMessage(state)).not.toContain("PRIVATE_ID");
    expect(statusMessage(state)).not.toContain("PRIVATE_ID");
  });
});
