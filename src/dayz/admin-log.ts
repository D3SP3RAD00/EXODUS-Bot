import { createHash } from "node:crypto";

export type Position = { x: number; y: number; z: number };

type PlayerEventBase = {
  fingerprint: string;
  lineNumber: number;
  logDate: string;
  occurredAt: string;
  playerName: string;
  playerId: string;
  position?: Position;
  raw: string;
};

export type AdminLogEvent =
  | (PlayerEventBase & { type: "player_connecting" })
  | (PlayerEventBase & { type: "player_connected" })
  | (PlayerEventBase & { type: "player_snapshot" })
  | (PlayerEventBase & { type: "player_emote"; emote: string })
  | (PlayerEventBase & { type: "player_disconnected" });

export type IgnoredAdminLogLine = { lineNumber: number; raw: string };

export type ParsedAdminLog = {
  logDate: string;
  startedAt: string;
  events: AdminLogEvent[];
  ignoredLines: IgnoredAdminLogLine[];
  completeLineCount: number;
};

const headerPattern = /AdminLog started on (\d{4})-(\d{2})-(\d{2}) at (\d{2}:\d{2}:\d{2})/;
const timedLinePattern = /^(\d{2}:\d{2}:\d{2}) \| (.+)$/;
const playerPattern = /^Player "([^"]+)" \(id=([A-Fa-f0-9]+)(?: pos=<([^>]+)>)?\)(?: (.*))?$/;

export function completeAdmLines(input: string): string[] {
  const normalized = input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n");
  if (!normalized.endsWith("\n")) lines.pop();
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function hashAdmLines(lines: string[]): string {
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function parsePosition(value: string | undefined): Position | undefined {
  if (!value) return undefined;
  const coordinates = value.split(",").map((part) => Number(part.trim()));
  const [x, y, z] = coordinates;
  if (
    coordinates.length !== 3 || x === undefined || y === undefined || z === undefined ||
    coordinates.some((coordinate) => !Number.isFinite(coordinate))
  ) return undefined;
  return { x, y, z };
}

function eventFingerprint(logDate: string, raw: string): string {
  return createHash("sha256").update(`${logDate}|${raw}`).digest("hex");
}

function classifyPlayerEvent(action: string | undefined):
  | { type: "player_connecting" }
  | { type: "player_connected" }
  | { type: "player_snapshot" }
  | { type: "player_emote"; emote: string }
  | { type: "player_disconnected" }
  | undefined {
  if (!action) return { type: "player_snapshot" };
  if (action === "is connecting") return { type: "player_connecting" };
  if (action === "is connected") return { type: "player_connected" };
  if (action === "has been disconnected") return { type: "player_disconnected" };
  const emote = /^performed (\S+)$/.exec(action);
  if (emote?.[1]) return { type: "player_emote", emote: emote[1] };
  return undefined;
}

export function parseAdminLog(input: string): ParsedAdminLog {
  const lines = completeAdmLines(input);
  const headerLine = lines.find((line) => headerPattern.test(line));
  const header = headerLine ? headerPattern.exec(headerLine) : null;
  if (!header) throw new Error("ADM log header was not found.");

  const [, year, month, day, startTime] = header;
  const logDate = `${year}-${month}-${day}`;
  const events: AdminLogEvent[] = [];
  const ignoredLines: IgnoredAdminLogLine[] = [];

  lines.forEach((originalLine, index) => {
    const lineNumber = index + 1;
    const line = originalLine.trim();
    if (!line || line.includes("AdminLog started") || /^\*+$/.test(line)) return;
    const timed = timedLinePattern.exec(line);
    if (!timed?.[1] || !timed[2]) {
      ignoredLines.push({ lineNumber, raw: line });
      return;
    }
    const [, time, payload] = timed;
    if (payload.startsWith("#####")) return;
    const player = playerPattern.exec(payload);
    if (!player?.[1] || !player[2]) {
      ignoredLines.push({ lineNumber, raw: line });
      return;
    }
    const [, playerName, playerId, positionValue, action] = player;
    const classification = classifyPlayerEvent(action);
    if (!classification) {
      ignoredLines.push({ lineNumber, raw: line });
      return;
    }
    const base: PlayerEventBase = {
      fingerprint: eventFingerprint(logDate, line), lineNumber, logDate,
      occurredAt: `${logDate}T${time}`, playerName, playerId, raw: line,
    };
    const position = parsePosition(positionValue);
    if (position) base.position = position;
    events.push({ ...base, ...classification });
  });

  return {
    logDate,
    startedAt: `${logDate}T${startTime}`,
    events,
    ignoredLines,
    completeLineCount: lines.length,
  };
}
