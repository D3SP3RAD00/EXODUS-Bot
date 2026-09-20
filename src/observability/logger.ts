export type LogContext = Record<string, unknown>;

export interface Logger {
  info(event: string, context?: LogContext): void;
  warn(event: string, context?: LogContext): void;
  error(event: string, context?: LogContext): void;
}

const sensitiveKey = /token|password|secret|authorization|api[-_]?key|credential|cookie|private[-_]?key|download[-_]?url|temporary[-_]?url/i;
function redactString(value: string): string {
  return value
    .replace(/https:\/\/[^\s,]+/gi, (candidate) => {
      try {
        const url = new URL(candidate);
        return url.search || /download|temporary/i.test(url.pathname) ? "[REDACTED_URL]" : candidate;
      } catch {
        return "[REDACTED_URL]";
      }
    })
    .replace(/\b(Bot|Bearer)\s+[A-Za-z0-9._~-]+/gi, "$1 [REDACTED]")
    .replace(
      /((?:token|password|secret|authorization|api[-_]?key|credential|cookie|signature|sig)\s*[:=]\s*)[^\s,;&]+/gi,
      "$1[REDACTED]"
    )
    .replace(
      /([?&](?:token|password|secret|authorization|api[-_]?key|credential|cookie|signature|sig|key|code)=)[^&\s]+/gi,
      "$1[REDACTED]"
    )
    .replace(/\b(?:mfa\.)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
}

export function redactLogValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (typeof value === "string") return redactString(value);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      sensitiveKey.test(key) ? "[REDACTED]" : redactLogValue(nested),
    ])
  );
}

export class StructuredConsoleLogger implements Logger {
  info(event: string, context: LogContext = {}): void {
    this.write("info", event, context);
  }

  warn(event: string, context: LogContext = {}): void {
    this.write("warn", event, context);
  }

  error(event: string, context: LogContext = {}): void {
    this.write("error", event, context);
  }

  private write(level: "info" | "warn" | "error", event: string, context: LogContext): void {
    const output = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...redactLogValue(context) as LogContext,
    });
    const writer = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    writer(output);
  }
}

export class NullLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
}
