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
- Nitrado access isolated behind an adapter interface
- Automated parser, restart, reconnect, duplicate, malformed-line, and incomplete-session tests

## Architecture

The deterministic core does not call Nitrado directly. `AdmLogSource` defines the input boundary and
`NitradoAdmLogAdapter` wraps the future authenticated client. The ingestion and storage layers can be
tested without network access and reused unchanged when the real Nitrado connection is added.

## Local setup

1. Install Node.js 22 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Put the Discord bot token in `.env`.
5. Run `npm run commands:register` once.
6. Run `npm run dev`.

Set `DATA_DIRECTORY` to a persistent mounted directory in hosted environments. The bot stores its
state as `exodus-bot.json` inside that directory and maintains recovery files alongside it.

Never commit `.env` or the bot token.
