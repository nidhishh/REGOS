# REGOS

Local hub where each of the user's projects has its own Claude Code agent, so they can make steady progress instead of stalling.

## How it works
- `server.js` (Node, zero deps) serves `public/` on http://localhost:4242 and runs each agent as headless Claude Code (`claude -p --output-format stream-json`) with the project folder as cwd. Runs on the user's Claude subscription — no API key.
- `projects.json` — registry of projects (id, name, type `code`|`pm`|`hq`, path).
- `projects/<id>/PROGRESS.md` — each agent's memory (Goal, Status, Next steps, Blockers, Log). The dashboard parses "Next steps" checkboxes. Optional `projects/<id>/AGENT.md` adds custom instructions.
- `agents/*.md` — system prompt templates (`base.md` + type file + mode from `modes.md`).
- `data/<id>/` (gitignored) — chat log, current session id, generated system prompts, PROGRESS.md backups.
- Modes: **Talk** = read-only tools; **Build** = `acceptEdits` + an allowlist of dev commands. `git push`, `rm -rf`, `git reset --hard`, `git clean` are always denied. "Terminal" opens an interactive `claude --resume` in Windows Terminal.

## Run
`start.cmd` (double-click) or `npm start`.

## Theme
Matches the user's retro pixel portfolio (`C:\Users\colos\Downloads\portfolio-website`): Press Start 2P / VT323 fonts, hard pixel shadows, "LEVEL 0X" framing, marquee bands. Each project's `theme` in `projects.json` (`bg`/`fg`/`acc`, optional `style` `so`|`ar`, `band` text) mirrors its portfolio section; `app.js` swaps `--bg/--fg/--acc` per view. Home uses the hero palette (#1a0033 / #fff / #ffe600).

## Conventions
- Keep it dependency-free and Windows-first.
- Agent structure is still being designed with the user — keep prompts in `agents/` editable, not hard-coded.
