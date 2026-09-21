import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseAdminLog } from "../src/dayz/admin-log.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/short-session.ADM", import.meta.url)
);
const fixture = readFileSync(fixturePath, "utf8");
const currentXboxFixture = readFileSync(
  fileURLToPath(new URL("./fixtures/current-xbox.ADM", import.meta.url)),
  "utf8"
);

describe("parseAdminLog", () => {
  it("parses deterministic player events from an Xbox ADM log", () => {
    const parsed = parseAdminLog(fixture);

    expect(parsed.logDate).toBe("2026-09-19");
    expect(parsed.startedAt).toBe("2026-09-19T13:57:59Z");
    expect(parsed.events).toHaveLength(8);
    expect(parsed.ignoredLines).toEqual([]);
    expect(parsed.events.map((event) => event.type)).toEqual([
      "player_connecting",
      "player_connected",
      "player_count",
      "player_snapshot",
      "player_count",
      "player_snapshot",
      "player_emote",
      "player_disconnected",
    ]);
  });

  it("preserves identity, coordinates, and the emote name", () => {
    const parsed = parseAdminLog(fixture);
    const connected = parsed.events[1];
    const emote = parsed.events.find((event) => event.type === "player_emote");

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

  it("rejects invalid header times and ignores invalid event times", () => {
    expect(() => parseAdminLog(
      "AdminLog started on 2026-09-19 at 29:00:00\n"
    )).toThrow("invalid timestamp");

    const parsed = parseAdminLog([
      "AdminLog started on 2026-09-19 at 13:00:00",
      "25:99:00 | Player \"ExampleSurvivor\" (id=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA) is connected",
      "",
    ].join("\n"));
    expect(parsed.events).toEqual([]);
    expect(parsed.ignoredLines).toHaveLength(1);
  });

  it("rolls timestamps forward consistently when a log crosses midnight", () => {
    const parsed = parseAdminLog([
      "AdminLog started on 2026-09-19 at 23:55:00",
      "23:59:00 | Player \"ExampleSurvivor\" (id=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA) is connected",
      "00:01:00 | Player \"ExampleSurvivor\" (id=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA) has been disconnected",
      "",
    ].join("\n"));
    expect(parsed.events.map((event) => event.occurredAt)).toEqual([
      "2026-09-19T23:59:00Z",
      "2026-09-20T00:01:00Z",
    ]);
  });

  it("parses the current Xbox player-list and emote formats with optional held items", () => {
    const parsed = parseAdminLog(currentXboxFixture);
    expect(parsed.events.map((event) => event.type)).toEqual([
      "player_connecting",
      "player_connected",
      "player_count",
      "player_snapshot",
      "player_emote",
      "player_emote",
    ]);
    expect(parsed.events.find((event) => event.type === "player_count")).toMatchObject({ count: 1 });
    const emotes = parsed.events.filter((event) => event.type === "player_emote");
    expect(emotes[0]).toMatchObject({
      emote: "EmoteTauntKiss",
      item: "SyntheticMapItem",
    });
    expect(emotes[1]).toMatchObject({ emote: "EmoteSurrender" });
    expect(emotes[1]).not.toHaveProperty("item");
  });
});
