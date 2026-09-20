import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseAdminLog } from "../src/dayz/admin-log.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/short-session.ADM", import.meta.url)
);
const fixture = readFileSync(fixturePath, "utf8");

describe("parseAdminLog", () => {
  it("parses deterministic player events from an Xbox ADM log", () => {
    const parsed = parseAdminLog(fixture);

    expect(parsed.logDate).toBe("2026-09-19");
    expect(parsed.startedAt).toBe("2026-09-19T13:57:59");
    expect(parsed.events).toHaveLength(6);
    expect(parsed.ignoredLines).toEqual([]);
    expect(parsed.events.map((event) => event.type)).toEqual([
      "player_connecting",
      "player_connected",
      "player_snapshot",
      "player_snapshot",
      "player_emote",
      "player_disconnected",
    ]);
  });

  it("preserves identity, coordinates, and the emote name", () => {
    const parsed = parseAdminLog(fixture);
    const connected = parsed.events[1];
    const emote = parsed.events[4];

    expect(connected?.playerName).toBe("ExampleSurvivor");
    expect(connected?.playerId).toBe(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    );
    expect(connected?.position).toEqual({ x: 12799, y: 10946, z: 53.7 });
    expect(emote).toMatchObject({ type: "player_emote", emote: "EmoteSitA" });
  });

  it("creates stable, unique fingerprints for deduplication", () => {
    const first = parseAdminLog(fixture);
    const second = parseAdminLog(fixture);
    const firstFingerprints = first.events.map((event) => event.fingerprint);

    expect(second.events.map((event) => event.fingerprint)).toEqual(
      firstFingerprints
    );
    expect(new Set(firstFingerprints)).toHaveLength(firstFingerprints.length);
  });

  it("rejects input that is not an ADM log", () => {
    expect(() => parseAdminLog("not a DayZ log")).toThrow(
      "ADM log header was not found."
    );
  });
});
