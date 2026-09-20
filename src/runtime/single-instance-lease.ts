import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { mkdir, open, readFile, rm } from "node:fs/promises";

interface LeaseOwner {
  ownerId: string;
  hostname: string;
  pid: number;
  processStartTime: string | undefined;
}

export class InstanceAlreadyRunningError extends Error {
  constructor() {
    super("Another EXODUS bot process already owns the persistent data directory.");
    this.name = "InstanceAlreadyRunningError";
  }
}

export class SingleInstanceLease {
  private released = false;

  private constructor(
    private readonly path: string,
    private readonly ownerId: string
  ) {}

  static async acquire(path: string): Promise<SingleInstanceLease> {
    await mkdir(dirname(path), { recursive: true });
    const ownerId = randomUUID();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, "wx", 0o600);
        try {
          const owner: LeaseOwner = {
            ownerId,
            hostname: hostname(),
            pid: process.pid,
            processStartTime: await readProcessStartTime(process.pid),
          };
          await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return new SingleInstanceLease(path, ownerId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (attempt > 0 || await leaseOwnerIsActive(path)) {
          throw new InstanceAlreadyRunningError();
        }
        await rm(path, { force: true });
      }
    }

    throw new InstanceAlreadyRunningError();
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;

    try {
      const currentOwner = parseOwner(await readFile(this.path, "utf8"));
      if (currentOwner?.ownerId === this.ownerId) await rm(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function leaseOwnerIsActive(path: string): Promise<boolean> {
  try {
    const owner = parseOwner(await readFile(path, "utf8"));
    if (!owner || owner.hostname !== hostname()) return false;
    const actualStartTime = await readProcessStartTime(owner.pid);
    return actualStartTime !== undefined && actualStartTime === owner.processStartTime;
  } catch {
    return false;
  }
}

function parseOwner(value: string): LeaseOwner | undefined {
  try {
    const owner = JSON.parse(value) as Partial<LeaseOwner>;
    if (
      typeof owner.ownerId !== "string" ||
      typeof owner.hostname !== "string" ||
      !Number.isSafeInteger(owner.pid) ||
      (owner.processStartTime !== undefined && typeof owner.processStartTime !== "string")
    ) return undefined;
    return owner as LeaseOwner;
  } catch {
    return undefined;
  }
}

async function readProcessStartTime(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const closingParenthesis = stat.lastIndexOf(")");
    if (closingParenthesis < 0) return undefined;
    return stat.slice(closingParenthesis + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}
