export type LogContext = Record<string, unknown>;

export interface Logger {
  info(event: string, context?: LogContext): void;
  warn(event: string, context?: LogContext): void;
  error(event: string, context?: LogContext): void;
}

const sensitiveKey = /token|password|secret|authorization/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      sensitiveKey.test(key) ? "[REDACTED]" : redact(nested),
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
      ...redact(context) as LogContext,
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
