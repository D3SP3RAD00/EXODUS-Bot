import { describe, expect, it, vi } from "vitest";

import {
  NitradoClientError,
  NitradoReadOnlyClient,
  type NitradoReadOnlyClientOptions,
} from "../src/nitrado/nitrado-readonly-client.js";

const TOKEN = "synthetic-nitrado-token-for-tests";
const CONTENT = "AdminLog started on 2026-09-20 at 10:00:00\n";

const options: NitradoReadOnlyClientOptions = {
  token: TOKEN,
  serviceId: 12345,
  requestTimeoutMs: 50,
  retryLimit: 2,
  backoffBaseMs: 100,
  backoffMaxMs: 1_000,
  discoveryMaxDepth: 4,
  discoveryMaxEntries: 100,
  logDirectory: "/logs",
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function details(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    status: "success",
    data: {
      gameserver: {
        service_id: 12345,
        game: "dayzxb",
        game_human: "DayZ (Xbox One)",
        game_specific: { features: { has_file_browser: true } },
        ...overrides,
      },
    },
  });
}

function listing(entries: unknown[]): Response {
  return jsonResponse({ status: "success", data: { entries } });
}

function adm(path: string, modifiedAt: number, size = Buffer.byteLength(CONTENT)): Record<string, unknown> {
  return { type: "file", path, name: path.split("/").at(-1), size, modified_at: modifiedAt };
}

function ticket(url = "https://files.nitrado.net/download/?token=temporary-download-token"): Response {
  return jsonResponse({ status: "success", data: { token: { url, token: "temporary-download-token" } } });
}

function content(body = CONTENT, declaredLength = Buffer.byteLength(body)): Response {
  return new Response(body, { status: 200, headers: { "content-length": String(declaredLength) } });
}

function sequencedFetch(responses: Array<Response | Error>): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("Unexpected fetch call");
    if (next instanceof Error) throw next;
    return next;
  });
}

describe("NitradoReadOnlyClient official API contract", () => {
  it("verifies Xbox DayZ, discovers the newest ADM file, and uses the documented download ticket", async () => {
    const fetchMock = sequencedFetch([
      details(),
      listing([
        adm("/logs/older.ADM", 100),
        adm("/logs/newest.ADM", 200),
        { type: "file", path: "/logs/server.log", name: "server.log", size: 10, modified_at: 300 },
      ]),
      ticket(),
      content(),
    ]);
    const client = new NitradoReadOnlyClient(options, fetchMock as typeof fetch, async () => {}, () =>
      new Date("2026-09-20T12:00:00Z")
    );

    const file = await client.downloadLatestAdmLog();

    expect(file.content).toBe(CONTENT);
    expect(file.fetchedAt).toBe("2026-09-20T12:00:00.000Z");
    expect(file.id).toMatch(/^[a-f0-9]{64}$/);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.nitrado.net/services/12345/gameservers");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("file_server/list?");
    expect(fetchMock.mock.calls[2]?.[0]).toContain("file=%2Flogs%2Fnewest.ADM");
    expect(fetchMock.mock.calls[3]?.[0]).toContain("files.nitrado.net/download/");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(fetchMock.mock.calls[3]?.[1]?.headers).toBeUndefined();
    expect(fetchMock.mock.calls.every((call) => call[1]?.method === "GET")).toBe(true);
  });

  it("recursively discovers logs without leaving paths returned by the current directory", async () => {
    const recursiveOptions = { ...options };
    delete recursiveOptions.logDirectory;
    const fetchMock = sequencedFetch([
      details(),
      listing([{ type: "dir", path: "/games/dayz", name: "dayz", modified_at: 1 }]),
      listing([adm("/games/dayz/runtime.ADM", 10)]),
      ticket(),
      content(),
    ]);
    const client = new NitradoReadOnlyClient(recursiveOptions, fetchMock as typeof fetch, async () => {});

    await expect(client.downloadLatestAdmLog()).resolves.toMatchObject({ content: CONTENT });
    expect(fetchMock.mock.calls[2]?.[0]).toContain("dir=%2Fgames%2Fdayz");
  });

  it("rejects a service that is not the configured Xbox DayZ server", async () => {
    const fetchMock = sequencedFetch([details({ game: "mc", game_human: "Minecraft" })]);
    const client = new NitradoReadOnlyClient(options, fetchMock as typeof fetch);

    await expect(client.downloadLatestAdmLog()).rejects.toMatchObject({ code: "NITRADO_WRONG_SERVICE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects service metadata without read-only file browsing", async () => {
    const fetchMock = sequencedFetch([
      details({ game_specific: { features: { has_file_browser: false } } }),
    ]);
    const client = new NitradoReadOnlyClient(options, fetchMock as typeof fetch);

    await expect(client.downloadLatestAdmLog()).rejects.toMatchObject({
      code: "NITRADO_FILE_BROWSER_UNAVAILABLE",
    });
  });

  it("fails immediately and safely on authorization errors", async () => {
    const fetchMock = sequencedFetch([jsonResponse({ status: "error" }, 401)]);
    const sleep = vi.fn(async () => {});
    const client = new NitradoReadOnlyClient(options, fetchMock as typeof fetch, sleep);

    let thrown: unknown;
    try {
      await client.downloadLatestAdmLog();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "NITRADO_AUTHORIZATION_FAILED" });
    expect(String(thrown)).not.toContain(TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("treats forbidden file access as an authorization failure", async () => {
    const fetchMock = sequencedFetch([
      details(),
      jsonResponse({ status: "error" }, 403),
    ]);
    const client = new NitradoReadOnlyClient(options, fetchMock as typeof fetch);

    await expect(client.downloadLatestAdmLog()).rejects.toMatchObject({
      code: "NITRADO_AUTHORIZATION_FAILED",
    });
  });

  it("honors rate limiting and retries with bounded backoff", async () => {
    const fetchMock = sequencedFetch([
      jsonResponse({ status: "error" }, 429, { "retry-after": "2" }),
      details(),
      listing([adm("/logs/current.ADM", 10)]),
      ticket(),
      content(),
    ]);
    const sleep = vi.fn(async () => {});
    const client = new NitradoReadOnlyClient(options, fetchMock as typeof fetch, sleep);

    await expect(client.downloadLatestAdmLog()).resolves.toMatchObject({ content: CONTENT });
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("retries network interruptions with exponential backoff", async () => {
    const fetchMock = sequencedFetch([
      new TypeError("synthetic network interruption"),
      new TypeError("synthetic network interruption"),
      details(),
      listing([adm("/logs/current.ADM", 10)]),
      ticket(),
      content(),
    ]);
    const sleep = vi.fn(async () => {});
    const client = new NitradoReadOnlyClient(options, fetchMock as typeof fetch, sleep);

    await expect(client.downloadLatestAdmLog()).resolves.toMatchObject({ content: CONTENT });
    expect(sleep.mock.calls).toEqual([[100], [200]]);
  });

  it("times out interrupted requests without revealing the token", async () => {
    const timeoutFetch = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const client = new NitradoReadOnlyClient(
      { ...options, requestTimeoutMs: 1, retryLimit: 0 },
      timeoutFetch as typeof fetch
    );

    let thrown: unknown;
    try {
      await client.downloadLatestAdmLog();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "NITRADO_NETWORK_FAILED" });
    expect(String(thrown)).not.toContain(TOKEN);
  });

  it("reports a useful error when no ADM logs exist", async () => {
    const fetchMock = sequencedFetch([details(), listing([])]);
    const client = new NitradoReadOnlyClient(options, fetchMock as typeof fetch);

    await expect(client.downloadLatestAdmLog()).rejects.toMatchObject({ code: "NITRADO_ADM_NOT_FOUND" });
  });

  it("retries a partial download with a fresh documented download ticket", async () => {
    const expectedSize = Buffer.byteLength(CONTENT);
    const fetchMock = sequencedFetch([
      details(),
      listing([adm("/logs/current.ADM", 10, expectedSize)]),
      ticket(),
      content("partial", expectedSize),
      ticket(),
      content(),
    ]);
    const sleep = vi.fn(async () => {});
    const client = new NitradoReadOnlyClient(options, fetchMock as typeof fetch, sleep);

    await expect(client.downloadLatestAdmLog()).resolves.toMatchObject({ content: CONTENT });
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("retries when the download body stream is interrupted", async () => {
    const interrupted = new Response(CONTENT, { status: 200 });
    vi.spyOn(interrupted, "text").mockRejectedValueOnce(new TypeError("synthetic interrupted body"));
    const fetchMock = sequencedFetch([
      details(),
      listing([adm("/logs/current.ADM", 10)]),
      ticket(),
      interrupted,
      ticket(),
      content(),
    ]);
    const sleep = vi.fn(async () => {});
    const client = new NitradoReadOnlyClient(options, fetchMock as typeof fetch, sleep);

    await expect(client.downloadLatestAdmLog()).resolves.toMatchObject({ content: CONTENT });
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("rejects unsafe file paths and untrusted download hosts", async () => {
    const unsafePathFetch = sequencedFetch([
      details(),
      listing([adm("/logs/../secret.ADM", 10)]),
    ]);
    const unsafePathClient = new NitradoReadOnlyClient(options, unsafePathFetch as typeof fetch);
    await expect(unsafePathClient.downloadLatestAdmLog()).rejects.toMatchObject({ code: "NITRADO_UNSAFE_PATH" });

    const unsafeHostFetch = sequencedFetch([
      details(),
      listing([adm("/logs/current.ADM", 10)]),
      ticket("https://example.com/download/?token=do-not-send"),
    ]);
    const unsafeHostClient = new NitradoReadOnlyClient(options, unsafeHostFetch as typeof fetch);
    await expect(unsafeHostClient.downloadLatestAdmLog()).rejects.toMatchObject({
      code: "NITRADO_UNSAFE_DOWNLOAD",
    });
  });

  it.each([
    ["metadata", [jsonResponse({ status: "success", data: { gameserver: {} } })]],
    ["listing", [details(), jsonResponse({ status: "success", data: { entries: "invalid" } })]],
    ["download ticket", [details(), listing([adm("/logs/current.ADM", 10)]), jsonResponse({ status: "success", data: {} })]],
    ["non-success body", [jsonResponse({ status: "error" })]],
    ["unreadable JSON", [new Response("not-json", { status: 200 })]],
  ])("rejects malformed %s contract responses", async (_label, responses) => {
    const client = new NitradoReadOnlyClient(options, sequencedFetch(responses as Response[]) as typeof fetch);
    await expect(client.downloadLatestAdmLog()).rejects.toMatchObject({ code: "NITRADO_INVALID_RESPONSE" });
  });

  it("uses safe error codes for unexpected HTTP and exhausted service failures", async () => {
    const rejected = new NitradoReadOnlyClient(
      options,
      sequencedFetch([jsonResponse({ status: "error" }, 404)]) as typeof fetch
    );
    await expect(rejected.downloadLatestAdmLog()).rejects.toMatchObject({ code: "NITRADO_REQUEST_FAILED" });

    const unavailable = new NitradoReadOnlyClient(
      { ...options, retryLimit: 1 },
      sequencedFetch([
        jsonResponse({ status: "error" }, 503),
        jsonResponse({ status: "error" }, 503),
      ]) as typeof fetch,
      async () => {}
    );
    await expect(unavailable.downloadLatestAdmLog()).rejects.toMatchObject({ code: "NITRADO_UNAVAILABLE" });
  });

  it("exports a typed safe error without credential fields", () => {
    const error = new NitradoClientError("SAFE", "safe message");
    expect(error).toMatchObject({ code: "SAFE", message: "safe message" });
    expect(Object.keys(error)).not.toContain("token");
  });
});
