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
- Guild-scoped `/status` command
- Runtime environment validation
- Xbox/Nitrado ADM parser for connections, snapshots, emotes, and disconnects
- Stable event fingerprints for duplicate protection
- Automated parser tests based on a real EXODUS log

## Local setup

1. Install Node.js 22 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Put the Discord bot token in `.env`.
5. Run `npm run commands:register` once.
6. Run `npm run dev`.

Never commit `.env` or the bot token.
