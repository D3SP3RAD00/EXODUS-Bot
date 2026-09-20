import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("production deployment artifacts", () => {
  it("builds on Node 22 and runs the bot as a non-root user", async () => {
    const dockerfile = await readFile(resolve(root, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("FROM node:22-bookworm-slim AS build");
    expect(dockerfile).toContain("FROM node:22-bookworm-slim AS runtime");
    expect(dockerfile).toContain("npm ci --omit=dev --ignore-scripts");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain('VOLUME ["/data"]');
    expect(dockerfile).toContain("STOPSIGNAL SIGTERM");
    expect(dockerfile).toContain('ENTRYPOINT ["exodus-entrypoint"]');
    expect(dockerfile).toContain('CMD ["node", "dist/index.js"]');
  });

  it("excludes credentials, local state, tests, and build artifacts from Docker context", async () => {
    const dockerignore = await readFile(resolve(root, ".dockerignore"), "utf8");
    for (const entry of [".env", "data", "dist", "node_modules", "tests", "*.zip"]) {
      expect(dockerignore.split("\n")).toContain(entry);
    }
  });

  it("starts exactly one foreground Node process through an exec-style entrypoint", async () => {
    const entrypoint = await readFile(resolve(root, "docker-entrypoint.sh"), "utf8");
    const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(entrypoint).toContain('exec gosu node "$@"');
    expect(entrypoint).toContain('exec "$@"');
    expect(packageJson.scripts.start).toBe("node dist/index.js");
  });
});
