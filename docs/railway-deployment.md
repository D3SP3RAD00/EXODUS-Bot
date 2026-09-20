# Railway deployment guide

This guide prepares one continuously running EXODUS bot worker. It does not expose a website and it
must run as exactly one process against one persistent volume.

## Before you begin

You need a Railway account, access to the `D3SP3RAD00/EXODUS-Bot` GitHub repository, a Discord bot,
and a read-only Nitrado token limited to the intended Xbox DayZ service.

**Never put real tokens or credentials in GitHub, committed files, Discord, application logs,
screenshots, support tickets, or chat.** Add them only in Railway's private Variables screen. Do not
put them in `.env.example`.

## Create the service

1. After the deployment pull request has been reviewed and merged, open the Railway dashboard.
2. Choose **New Project**, then **Deploy from GitHub repo**.
3. Select `D3SP3RAD00/EXODUS-Bot` and the `main` branch.
4. Open the new service's **Settings**. Confirm Railway detected the root `Dockerfile`.
5. Leave **Custom Start Command** empty. The image already starts the single foreground process with
   `node dist/index.js`.
6. Keep the service at one replica. Railway volumes do not support replicas, and the bot also holds
   an exclusive lease in its data directory so a second local process fails closed.
7. In the service's deploy settings, set **Restart Policy** to **Always** so an unexpected clean exit
   or failure is restarted. Leave the replica count at one.

Do not add a public domain or health-check URL. This is a background worker, not an HTTP service.

## Add the private variables

Open the bot service, choose **Variables**, and add each variable there. Use the private values from
the corresponding provider; do not paste those values anywhere else.

| Variable | Value to enter |
| --- | --- |
| `DISCORD_BOT_TOKEN` | The Discord bot token |
| `DISCORD_APPLICATION_ID` | The Discord application ID |
| `DISCORD_GUILD_ID` | The Discord server/guild ID |
| `NITRADO_TOKEN` | The read-only, service-scoped Nitrado token |
| `NITRADO_SERVICE_ID` | The numeric ID of the intended Xbox DayZ service |
| `DATA_DIRECTORY` | `/data` |

Also add `RAILWAY_RUN_UID=0`. Railway mounts volumes as root, so this platform setting lets the
container entrypoint correct `/data` ownership. The entrypoint immediately drops privileges; the
Node.js bot itself runs as the unprivileged `node` user.

Startup fails before Discord or Nitrado connections begin if a required value is missing, blank,
malformed, or if `DATA_DIRECTORY` is not an absolute path.

## Attach persistent storage

1. On the Railway project canvas, right-click and choose **New Volume** (the Command Palette also has
   **New Volume**).
2. Attach the volume to the EXODUS bot service.
3. Set its mount path to exactly `/data`.
4. Recheck that `DATA_DIRECTORY` is exactly `/data` in the service's **Variables** screen.

The volume preserves `exodus-bot.json` and its atomic-write recovery files. Those contain ADM
checkpoints, player sessions, accumulated playtime, and the reserved storage areas for future economy
and faction data. Railway prevents multiple active deployments from mounting the same service volume,
which also prevents overlapping pollers during redeploys.

## Optional read-only Nitrado settings

The defaults in `.env.example` are safe starting values. Add any override in Railway's **Variables**
screen only when needed:

| Variable | Purpose | Default |
| --- | --- | --- |
| `NITRADO_LOG_DIRECTORY` | Known ADM log directory; blank enables bounded discovery | blank |
| `NITRADO_DOWNLOAD_HOSTS` | Comma-separated HTTPS download-host allowlist | `nitrado.net,*.nitrado.net` |
| `NITRADO_MAX_DOWNLOAD_BYTES` | Maximum ADM response size | `16777216` |
| `NITRADO_POLL_INTERVAL_MS` | Delay between completed polls | `60000` |
| `NITRADO_REQUEST_TIMEOUT_MS` | Per-request/download timeout | `15000` |
| `NITRADO_RETRY_LIMIT` | Maximum retry count | `3` |
| `NITRADO_BACKOFF_BASE_MS` | Initial retry backoff | `1000` |
| `NITRADO_BACKOFF_MAX_MS` | Maximum retry backoff | `30000` |
| `NITRADO_DISCOVERY_MAX_DEPTH` | Maximum directory traversal depth | `8` |
| `NITRADO_DISCOVERY_MAX_ENTRIES` | Maximum entries examined per discovery | `10000` |

Keep the download-host allowlist limited to official Nitrado-owned hosts. The client refuses HTTP,
redirects, unlisted hosts, oversized or partial files, HTML error pages, and malformed ADM content.

## First deployment and verification

1. Review the Variables list and confirm no value was added to GitHub or a committed file.
2. In Railway, choose **Deploy** for `main` only after the deployment pull request is merged.
3. Open **Deployments**, select the deployment, and inspect its logs. A healthy start emits structured
   JSON events named `application_starting` and `application_started`; secrets are redacted.
4. In Discord, run `/status`, `/players`, and `/playtime` to confirm the bot responds. Empty-server
   responses are expected until ADM events have been ingested.
5. Restart the Railway service once. Confirm it starts normally and retains state from `/data`.
6. Keep the replica count at one. Do not create a second Railway service pointing at the same bot,
   Discord application, Nitrado service, or data set.

On Railway shutdown, `SIGTERM` aborts active read-only requests, waits for the poll loop to stop,
closes Discord, releases the process lease, and logs `application_shutdown_completed`. Atomic storage
writes and checkpoint updates remain protected if Railway later sends a forced termination.
