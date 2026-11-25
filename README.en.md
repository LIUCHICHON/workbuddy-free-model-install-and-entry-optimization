# WorkBuddy Free LLM Install & Entry Optimization

A cross-platform toolkit that turns a pool of free LLM endpoints into one stable,
auto-failover "total entry" model for WorkBuddy (and any Ollama / OpenAI-compatible client).

Originally two separate deliverables — a macOS engineering directory and a Windows
one-click installer — now merged into a single platform-neutral GitHub repository.

## What's inside

| Path | Purpose |
|---|---|
| `src/` | Platform-neutral Node.js core (zero dependencies): bridge, combos, auto-entry, health checks |
| `platforms/macos/` | bash + launchd (auto start, self-healing) |
| `platforms/windows/` | PowerShell + Scheduled Tasks (one-click `.bat` entry) |
| `examples/` | Config templates with placeholder keys |
| `docs/` | User guide (Chinese), architecture, macOS/Windows deployment, security |
| `skills/` | Two WorkBuddy user-level skills distilled from real incidents |
| `tests/` | Regression suite: 10 scenarios (R1–R10) |

## Quick start

Requires Node.js >= 18 and a separately deployed `dsh-our-free-model` standalone gateway.

- **Windows**: double-click `platforms/windows/start.bat`
- **macOS**: `bash platforms/macos/start-bridge.sh`

See `docs/MACOS.md` / `docs/WINDOWS.md` for details. Full Chinese documentation: `README.md`.

## Security

All real keys and local absolute paths were removed. Never commit `settings.json`,
`rescue-providers.json` or `models.json`. See `docs/SECURITY.md`.

MIT License.
