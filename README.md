# pi-copilot-usage

A **pi** extension that surfaces your GitHub Copilot Pro plan usage — quota, sessions, and model billing — directly inside pi, with a live footer indicator.

## Features

| What | How |
|------|-----|
| `/copilot` | Full dashboard: quota summary + session counts + top repos + recent sessions |
| `/copilot-quota` | Focused quota panel: premium-interaction budget, chat, completions + model billing table |
| `/copilot-sessions` | Browse all sessions newest-first; pick one to inspect full metadata |
| `/copilot-models` | Model list with billing multipliers (free vs. premium-interaction cost) |
| `copilot_usage` tool | LLM-callable tool returning structured JSON; supports `period` filter |
| Footer status | Live `🟢/🟡/🔴 Copilot: N/300 premium left` indicator, refreshed every 60 s |

## Prerequisites

- [pi coding agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) installed globally
- GitHub Copilot Pro subscription
- GitHub CLI authenticated (`gh auth login`)
- Node.js ≥ 18

## Installation

```bash
pi install https://github.com/azs06/pi-copilot-usage
```

Then inside a running pi session, reload with `/reload`. The extension is auto-discovered on all future sessions.

## How it works

Two data sources are used in parallel:

| Source | What it provides |
|--------|-----------------|
| `gh api /copilot_internal/user` | Quota snapshots (premium interactions, chat, completions), plan name, reset date |
| `@github/copilot-sdk` `CopilotClient` | Sessions list, auth status (login), CLI status (version), model list with billing multipliers |

The `CopilotClient` lazily starts the bundled Copilot CLI binary via stdio JSON-RPC on first use, and is stopped cleanly on `session_shutdown`.

### Caching & polling

- **Commands** share a 30-second TTL cache (`fetchAllCached`). Invoking `/copilot` then `/copilot-quota` within 30 s costs one API round-trip total.
- **Footer polling** runs a lightweight `gh api` call every 60 seconds — independently of the command cache — to keep the premium-interactions counter current without fetching the full session list.
- The first poll is intentionally **delayed by 3 seconds** after session start so it doesn't add latency to pi's startup path.

## Commands

### `/copilot` — full dashboard

Shows everything in one panel:

- GitHub login, plan name, quota reset date
- Premium-interactions progress bar (`used / total`)
- Chat and completions quota status
- Session counts: total / today / this week / this month / active now / avg duration
- Top repositories and directories by session count
- 10 most recent sessions with timestamps, duration, repo, and AI summary

### `/copilot-quota` — quota panel

Focused view of your Pro plan budget:

- Premium-interactions entitlement, used, remaining, overage status — with a visual progress bar
- Chat and completions status (unlimited or counted)
- Any other quota buckets from the API
- Full model billing table (see `/copilot-models` below)

### `/copilot-sessions` — session browser

Lists all sessions newest-first. Select one to see its full metadata:

- Session ID, start / last-active timestamps, duration
- Remote flag, git root, repository, branch, working directory
- AI-generated session summary (word-wrapped)

### `/copilot-models` — model billing

Two-section table:

- **Free** — models that cost 0 premium interactions per request
- **Premium** — models sorted by multiplier (e.g. `1×`, `1.5×`, `2×`) counted against your monthly quota

### `copilot_usage` tool — LLM-accessible

The AI assistant can call this directly. Useful prompts:

- *"How many Copilot sessions did I have this week?"*
- *"Which repository do I use Copilot in the most?"*
- *"How many premium interactions do I have left this month?"*
- *"Show me my recent Copilot sessions."*

Accepts an optional `period` parameter: `today | week | month | all` (default `all`). Returns a structured JSON object containing quota snapshots, session counts, top repos/directories, model list, and recent session summaries.

## Footer status

The footer indicator auto-updates every 60 seconds:

| Icon | Meaning |
|------|---------|
| 🔄 | Loading / fetching |
| 🟢 | > 25% premium interactions remaining |
| 🟡 | 10–25% remaining |
| 🔴 | < 10% remaining |
| ⚫ | No sessions found |

## File layout

```
pi-copilot-usage/
├── package.json        ← @github/copilot-sdk dependency + pi extension entry point
├── package-lock.json
├── node_modules/       ← includes bundled Copilot CLI binary
├── src/
│   └── index.ts        ← extension source (~700 LOC)
└── README.md
```
