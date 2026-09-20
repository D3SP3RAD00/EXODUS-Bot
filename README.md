# !!EXODUS Discord Bot

Deterministic Discord and Xbox DayZ server automation for the !!EXODUS Badlands community.

## Principles

- Exact code paths, not generated answers
- Every economy change is auditable
- Every imported ADM event is deduplicated
- Unknown log lines are recorded instead of guessed
- Destructive staff actions require explicit authorization
- Secrets never enter source control

## Current foundation

- Discord bot connection
- Guild-scoped `/status`, `/players`, and `/playtime` commands
- Runtime environment validation
- Xbox/Nitrado ADM parser for connections, snapshots, emotes, and disconnects
- Checkpointed, idempotent ADM ingestion with log-rotation detection
- Persistent player sessions and accumulated playtime
- Serialized, recoverable atomic JSON storage with reserved economy and faction domains
- Structured, credential-redacting operational logs
- Read-only Nitrado ADM discovery and polling isolated behind an adapter interface
- Railway-ready container lifecycle with persistent storage and single-instance protection
- Automated parser, restart, reconnect, duplicate, malformed-line, and incomplete-session tests

## Architecture

The deterministic core does not call Nitrado directly. `AdmLogSource` defines the input boundary,
`NitradoAdmLogAdapter` maps downloaded files into the core, and `NitradoReadOnlyClient` contains the
official API contract. The client issues only documented `GET` requests. It has no file-write or
server-control methods.

## Nitrado read-only setup

The implementation was checked against Nitrado's official API documentation on September 20, 2026:

- bearer access tokens and the service-scoped `service` OAuth scope
- `GET /services/:id/gameservers` for service identity and file-browser capability
- `GET /services/:id/gameservers/file_server/list` for file discovery
- `GET /services/:id/gameservers/file_server/download` for a temporary file-download URL

Official source: [Nitrado.net API Documentation](https://doc.nitrado.net/).

Create a service-limited Nitrado long-life token with only the `service` scope in your Nitrado account.
Store it directly in the bot host's secret/environment settings as `NITRADO_TOKEN`. Never paste the
token into Discord, chat, GitHub, source files, build logs, or deployment commands. Set
`NITRADO_SERVICE_ID` to the numeric service ID for the Xbox DayZ server. The client refuses to browse
files unless Nitrado identifies that exact service as DayZ on Xbox with file browsing available.

`NITRADO_LOG_DIRECTORY` is optional. When blank, discovery begins at the service's documented home
directory and follows returned child directories within bounded depth and entry limits. Setting it to
the known DayZ log directory reduces API requests. Poll intervals, request timeouts, retry limits,
exponential backoff with jitter, discovery bounds, maximum download size, and permitted download
hosts are configurable in `.env.example`. Keep `NITRADO_DOWNLOAD_HOSTS` restricted to the exact
Nitrado-owned hosts (or the documented `*.nitrado.net` pattern) used by your service.

The token is sent only in the `Authorization: Bearer` header to `https://api.nitrado.net`. Temporary
download URLs must use HTTPS on the explicit host allowlist. Redirects are disabled for both API and
download requests, and download requests never receive the account token. Bodies are streamed under
strict byte and duration limits and must be valid ADM content. Authorization failures are not retried;
rate limits, temporary service failures, timeouts, network interruptions, and partial downloads use
bounded retries. Shutdown aborts active requests before another checkpoint can begin.

## Local setup

1. Install Node.js 22 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Put the Discord bot token, Nitrado token, and Nitrado service ID in the host's private environment.
5. Run `npm run commands:register` once.
6. Run `npm run dev`.

Set `DATA_DIRECTORY` to a persistent mounted directory in hosted environments. The bot stores its
state as `exodus-bot.json` inside that directory and maintains recovery files alongside it.

Never commit `.env`, the Discord token, or the Nitrado token.

For hosted production setup, follow the step-by-step [Railway deployment guide](docs/railway-deployment.md).
