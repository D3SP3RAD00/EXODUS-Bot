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
  maxDownloadBytes: 1_000_000,
  downloadHostAllowlist: ["nitrado.net", "*.nitrado.net"],
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
  return new Response(body, {
    status: 200,
    headers: { "content-length": String(declaredLength), "content-type": "text/plain" },
  });
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

  it("confines configured discovery to the exact directory and never traverses child directories", async () => {
    const fetchMock = sequencedFetch([
      details(),
      listing([
        { type: "dir", path: "/logs/archive", name: "archive", modified_at: 999 },
        adm("/logs/current.ADM", 100),
      ]),
      ticket(),
      content(),
    ]);
    const client = new NitradoReadOnlyClient(options, fetchMock as typeof fetch);

    await expect(client.downloadLatestAdmLog()).resolves.toMatchObject({ content: CONTENT });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("dir=%2Flogs");
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("archive"))).toBe(false);
  });

  it("selects the newest valid ADM deterministically when several files exist", async () => {
    const fetchMock = sequencedFetch([
      details(),
      listing([
        adm("/logs/older.ADM", 10),
        adm("/logs/tie-b.ADM", 20),
        adm("/logs/tie-a.ADM", 20),
        { type: "file", path: "/logs/newer.txt", name: "newer.txt", size: 1, modified_at: 30 },
      ]),
      ticket(),
      content(),
    ]);
    const client = new NitradoReadOnlyClient(options, fetchMock as typeof fetch);

    await client.downloadLatestAdmLog();
    expect(fetchMock.mock.calls[2]?.[0]).toContain("file=%2Flogs%2Ftie-a.ADM");
  });

  it("rejects entries outside the configured directory", async () => {
    const fetchMock = sequencedFetch([details(), listing([adm("/other/current.ADM", 10)])]);
    const client = new NitradoReadOnlyClient(options, fetchMock as typeof fetch);
    await expect(client.downloadLatestAdmLog()).rejects.toMatchObject({ code: "NITRADO_UNSAFE_PATH" });
  });

  it("returns a stable code when the configured directory does not exist", async () => {
    const fetchMock = sequencedFetch([details(), jsonResponse({ status: "error" }, 404)]);
    const client = new NitradoReadOnlyClient(options, fetchMock as typeof fetch);
    await expect(client.downloadLatestAdmLog()).rejects.toMatchObject({ code: "NITRADO_INVALID_DIRECTORY" });
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
    expect(sleep).toHaveBeenCalledWith(1_000, undefined);
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
    const client = new NitradoReadOnlyClient(options, fetchMock as typeof fetch, sleep, () => new Date(), () => 0);

    await expect(client.downloadLatestAdmLog()).resolves.toMatchObject({ content: CONTENT });
    expect(sleep.mock.calls).toEqual([[100, undefined], [200, undefined]]);
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
    expect(sleep).toHaveBeenCalledWith(expect.any(Number), undefined);
  });

  it("retries when the download body stream is interrupted", async () => {
    const interrupted = new Response(new ReadableStream({
      pull(controller) {
        controller.error(new TypeError("synthetic interrupted body"));
      },
    }), { status: 200 });
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
    expect(sleep).toHaveBeenCalledWith(expect.any(Number), undefined);
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

  it("binds bearer authorization to the official API origin and never sends it to downloads", async () => {
    const fetchMock = sequencedFetch([details(), listing([adm("/logs/current.ADM", 10)]), ticket(), content()]);
    const client = new NitradoReadOnlyClient(options, fetchMock as typeof fetch);

    await client.downloadLatestAdmLog();

    for (const [input, init] of fetchMock.mock.calls) {
      const url = new URL(String(input));
      if (url.origin === "https://api.nitrado.net") {
        expect(init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
      } else {
        expect(init?.headers).toBeUndefined();
      }
      expect(init?.redirect).toBe("error");
    }
  });

  it("does not follow API or temporary-download redirects", async () => {
    const apiRedirectFetch = sequencedFetch([
      new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }),
    ]);
    const apiClient = new NitradoReadOnlyClient(options, apiRedirectFetch as typeof fetch);
    await expect(apiClient.downloadLatestAdmLog()).rejects.toMatchObject({ code: "NITRADO_REQUEST_FAILED" });
    expect(apiRedirectFetch).toHaveBeenCalledTimes(1);
    expect(apiRedirectFetch.mock.calls[0]?.[1]?.redirect).toBe("error");

    const downloadRedirectFetch = sequencedFetch([
      details(), listing([adm("/logs/current.ADM", 10)]), ticket(),
      new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }),
    ]);
    const downloadClient = new NitradoReadOnlyClient(
      { ...options, retryLimit: 0 },
      downloadRedirectFetch as typeof fetch
    );
    await expect(downloadClient.downloadLatestAdmLog()).rejects.toMatchObject({ code: "NITRADO_REQUEST_FAILED" });
    expect(downloadRedirectFetch).toHaveBeenCalledTimes(4);
    expect(downloadRedirectFetch.mock.calls[3]?.[1]?.headers).toBeUndefined();
  });

  it.each([
    "http://files.nitrado.net/download?token=secret",
    "https://nitrado.net.evil.example/download?token=secret",
    "https://files.nitrado.net:8443/download?token=secret",
    "https://user:password@files.nitrado.net/download?token=secret",
    "https://files.nitrado.net/download?token=secret#fragment",
  ])("rejects unsafe temporary download URL %s without disclosing it", async (url) => {
    const fetchMock = sequencedFetch([details(), listing([adm("/logs/current.ADM", 10)]), ticket(url)]);
    const client = new NitradoReadOnlyClient(options, fetchMock as typeof fetch);
    let thrown: unknown;
    try {
      await client.downloadLatestAdmLog();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "NITRADO_UNSAFE_DOWNLOAD" });
    expect(String(thrown)).not.toContain("secret");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("accepts only an explicitly configured exact download host", async () => {
    const fetchMock = sequencedFetch([
      details(), listing([adm("/logs/current.ADM", 10)]),
      ticket("https://download.example.net/file?sig=temporary"), content(),
    ]);
    const client = new NitradoReadOnlyClient(
      { ...options, downloadHostAllowlist: ["download.example.net"] },
      fetchMock as typeof fetch
    );
    await expect(client.downloadLatestAdmLog()).resolves.toMatchObject({ content: CONTENT });
  });

  it.each([
    "/logs/../secret.ADM",
    "/logs//nested/current.ADM",
    "/logs/%2e%2e/secret.ADM",
    "/logs-escape/current.ADM",
  ])("rejects a path outside or non-canonical to the configured root: %s", async (path) => {
    const fetchMock = sequencedFetch([details(), listing([adm(path, 10)])]);
    const client = new NitradoReadOnlyClient(options, fetchMock as typeof fetch);
    await expect(client.downloadLatestAdmLog()).rejects.toMatchObject({ code: "NITRADO_UNSAFE_PATH" });
  });

  it("rejects misleading entry names and non-canonical configured roots", async () => {
    const fetchMock = sequencedFetch([
      details(),
      listing([{ ...adm("/logs/current.ADM", 10), name: "different.ADM" }]),
    ]);
    await expect(new NitradoReadOnlyClient(options, fetchMock as typeof fetch).downloadLatestAdmLog())
      .rejects.toMatchObject({ code: "NITRADO_UNSAFE_PATH" });
    expect(() => new NitradoReadOnlyClient({ ...options, logDirectory: "/logs/../secret" })).toThrow(
      "canonical absolute path"
    );
  });

  it("fails closed on unsupported listing pagination and bounded discovery overflow", async () => {
    const paginated = sequencedFetch([
      details(),
      jsonResponse({ status: "success", data: { entries: [], next_page: 2 } }),
    ]);
    await expect(new NitradoReadOnlyClient(options, paginated as typeof fetch).downloadLatestAdmLog())
      .rejects.toMatchObject({ code: "NITRADO_UNSUPPORTED_PAGINATION" });

    const overflow = sequencedFetch([
      details(),
      listing([adm("/logs/a.ADM", 1), adm("/logs/b.ADM", 2)]),
    ]);
    await expect(new NitradoReadOnlyClient(
      { ...options, discoveryMaxEntries: 1 },
      overflow as typeof fetch
    ).downloadLatestAdmLog()).rejects.toMatchObject({ code: "NITRADO_DISCOVERY_LIMIT" });
  });

  it("strictly verifies service ID, DayZ machine identity, and Xbox human identity", async () => {
    for (const override of [
      { service_id: 99999 },
      { game: "dayzpc", game_human: "DayZ (Xbox One)" },
      { game: "dayzxb", game_human: "DayZ (PC)" },
    ]) {
      const client = new NitradoReadOnlyClient(options, sequencedFetch([details(override)]) as typeof fetch);
      await expect(client.downloadLatestAdmLog()).rejects.toMatchObject({ code: "NITRADO_WRONG_SERVICE" });
    }
  });

  it("enforces declared and streamed response-size limits", async () => {
    const declaredFetch = sequencedFetch([
      details(), listing([adm("/logs/current.ADM", 10, 1)]), ticket(),
      content(CONTENT, Buffer.byteLength(CONTENT)),
    ]);
    await expect(new NitradoReadOnlyClient(
      { ...options, maxDownloadBytes: 8, retryLimit: 0 },
      declaredFetch as typeof fetch
    ).downloadLatestAdmLog()).rejects.toMatchObject({ code: "NITRADO_RESPONSE_TOO_LARGE" });

    const streamedFetch = sequencedFetch([
      details(), listing([adm("/logs/current.ADM", 10, 1)]), ticket(),
      new Response(CONTENT, { status: 200, headers: { "content-type": "text/plain" } }),
    ]);
    await expect(new NitradoReadOnlyClient(
      { ...options, maxDownloadBytes: 8, retryLimit: 0 },
      streamedFetch as typeof fetch
    ).downloadLatestAdmLog()).rejects.toMatchObject({ code: "NITRADO_RESPONSE_TOO_LARGE" });
  });

  it("keeps the timeout active while the download body is streaming", async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const call = fetchMock.mock.calls.length;
      if (call === 1) return details();
      if (call === 2) return listing([adm("/logs/current.ADM", 10, 1)]);
      if (call === 3) return ticket();
      return new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
        },
      }), { status: 200, headers: { "content-type": "text/plain" } });
    });
    const client = new NitradoReadOnlyClient(
      { ...options, requestTimeoutMs: 1, retryLimit: 0 },
      fetchMock as typeof fetch
    );
    await expect(client.downloadLatestAdmLog()).rejects.toMatchObject({ code: "NITRADO_NETWORK_FAILED" });
  });

  it("fails safely on incorrect Content-Length, HTML, and malformed ADM data", async () => {
    const cases: Array<{ response: Response; code: string }> = [
      { response: content(CONTENT, Buffer.byteLength(CONTENT) + 1), code: "NITRADO_PARTIAL_DOWNLOAD" },
      { response: new Response("<html>error</html>", { status: 200, headers: { "content-type": "text/html" } }), code: "NITRADO_INVALID_ADM" },
      { response: new Response("not an admin log\n", { status: 200, headers: { "content-type": "text/plain" } }), code: "NITRADO_INVALID_ADM" },
    ];
    for (const testCase of cases) {
      const fetchMock = sequencedFetch([
        details(), listing([adm("/logs/current.ADM", 10, 1)]), ticket(), testCase.response,
      ]);
      const client = new NitradoReadOnlyClient(
        { ...options, retryLimit: 0 },
        fetchMock as typeof fetch
      );
      await expect(client.downloadLatestAdmLog()).rejects.toMatchObject({ code: testCase.code });
    }
  });

  it("honors HTTP-date Retry-After with bounded positive jitter", async () => {
    const now = new Date("2026-09-20T12:00:00.500Z");
    const fetchMock = sequencedFetch([
      jsonResponse({ status: "error" }, 429, { "retry-after": "Sun, 20 Sep 2026 12:00:01 GMT" }),
      details(), listing([adm("/logs/current.ADM", 10)]), ticket(), content(),
    ]);
    const sleep = vi.fn(async () => {});
    const client = new NitradoReadOnlyClient(options, fetchMock as typeof fetch, sleep, () => now, () => 1);
    await client.downloadLatestAdmLog();
    expect(sleep).toHaveBeenCalledWith(525, undefined);
  });

  it("never retains temporary URLs or fetch errors as public error causes", async () => {
    const secretUrl = "https://files.nitrado.net/download/private.ADM?token=never-log&signature=never-log";
    const fetchMock = sequencedFetch([
      details(), listing([adm("/logs/current.ADM", 10)]), ticket(secretUrl),
      new TypeError(`failed ${secretUrl} Authorization: Bearer ${TOKEN}`),
    ]);
    const client = new NitradoReadOnlyClient(
      { ...options, retryLimit: 0 },
      fetchMock as typeof fetch
    );
    let thrown: unknown;
    try {
      await client.downloadLatestAdmLog();
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).not.toContain("never-log");
    expect(String(thrown)).not.toContain(TOKEN);
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
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
