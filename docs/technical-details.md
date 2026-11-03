# Regia — technical details

*[Leggi in italiano](dettagli-tecnici.md)*

For readers who want to know how Regia counts usage, which rules it applies to agents, how it manages local servers and what its limits are. For everyday use, the [manual](manual.md) is enough.

## Local server

A phase run by Regia itself, with no agent and no cost: it runs a command in the project folder (e.g. `npm run dev`, optionally in a subfolder), waits until the address responds (the one you set, or the first local address the server prints) and keeps the server running until the run ends. The link, status, latest output lines and Ferma / Riavvia (stop / restart) buttons appear on the diagram and in the following approval request. Before starting, the phase prepares the environment:

- **Node version**: it reads `.nvmrc` / `.node-version` and `engines.node` in package.json (or the phase's "Versione di Node" field) and picks the most recent compatible version among those installed (nvm, nvm-windows, fnm, volta, system). It uses it for that command only, by putting it first in the PATH: the system version does not change. If none is compatible, it starts nothing and offers **Installa Node e riprova** (install Node and retry), showing the exact command (e.g. `nvm install 24.22.2`, a version chosen from the official nodejs.org list, preferring LTS). Installation only starts when you click.
- **Dependencies**: if `node_modules` is missing, it installs them with the package manager implied by the lockfile, without modifying it (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `bun install --frozen-lockfile`).

If startup fails, the phase reads the output and recognizes common causes. For an "unsupported Node version" message it extracts the required version and, if that version is installed, retries once on its own; otherwise it offers to install it. For missing modules or commands it offers **Installa le dipendenze e riprova** (install dependencies and retry). It also reports ports already in use and insufficient permissions. In other cases it shows the output needed to understand why.

Logs written as JSON (Astro, Vite and others when not attached to a terminal) are turned into readable lines, and only valid URL characters are kept when extracting the address.

The server (together with its child processes) is stopped when the run ends or is cancelled, and when Regia closes. After a correction requested in a later approval it is restarted, so you check the updated version; with "Continue" it is always restarted. In trial mode it is simulated and no command runs. Before a real run, the confirmation dialog lists the commands that will be started.

## Interventions

- **Human approval**: approve, or reject with a comment. The closest upstream phase that can edit files resumes its own session with the comment; intermediate phases (test, review) run again and approval is requested again. At most 3 rounds.
- **Failed or blocked phase**: the agent can declare a `ko` or `bloccato` (blocked) outcome. The choices are retry from scratch, resume the session with a message, skip, or cancel the run.

## General rules

The **Regole** (rules) button shows the rules added to every phase's instructions (workflow option "Applica le regole generali", on by default). They take precedence over the phase instructions.

- **Personal rules**: `~/.claude/CLAUDE.md`, read at every run, never modified by Regia. They are needed because hooks, plugins and personal settings from `~/.claude` are not loaded into the agents.
- **Regia rules**: editable text, stored in `data/regole.md`. By default: no commit or push unless the phase explicitly asks, no changes outside the project folder, no reading credential files unless essential.
- **Project CLAUDE.md**: loaded by the CLI if the workflow option is on; the panel shows it read-only.

Each run stores the rules it used: you find them in the Stato tab ("Regole applicate") and in the event log. The personal rules file path can be changed with `REGIA_GLOBAL_RULES`.

## Decisions shown

- **Declared**: `DECISIONE: …` lines that the agent writes as required by the response protocol, plus the `decisioni` list in the final outcome block.
- **Observed**: inferred from visible events, i.e. files edited, commands run, subagents started and tools denied.

Internal reasoning blocks (thinking) are never shown or stored.

## Usage

Source: the `result` message of each `query()` call.

- **Totals per phase**: from `modelUsage` and `total_cost_usd`. They include subagents and the per-model breakdown: input, output, cache writes and reads, cost and price table used.
- **Live counters during a phase**: input and cache from `assistant` messages, deduplicated by `message.id`. Indicative only, because `output_tokens` on individual messages is a placeholder.
- **Resumed sessions** ("Resume" and corrections from approvals): the result also reports the session's earlier spend, so Regia records only the difference from the totals already counted. If the CLI did not restore the totals, nothing is subtracted.
- **Crashes**: an error result may carry zeroed values. In that case the live counters are kept (input and cache of the main loop) and the cost is marked as unknown.
- **Per agent**: aggregated by role.

**Estimates, not billing.** `total_cost_usd` and `costUSD` are computed locally by the SDK from the price table bundled with its version. With an API key, the actual cost is in the Console. With a claude.ai login, usage counts against the plan limits (or extra credits, if enabled) and the dollar figure is a list-price equivalent. In trial mode the rates are fictitious.

**Spending limit**: the per-run limit applies to the estimate. Before each phase, the remaining amount is split among the active phases and passed as `maxBudgetUsd`, together with the phase's own limit if set. If the limit is exceeded, the phase ends with `error_max_budget_usd` and the run pauses.

**Optimizations**: rules applied to measured data: dominant phase, expensive model on simple tasks, much more context than other phases, repeated identical calls, close to the turn limit, retries after errors, correction rounds, reuse candidates, consecutive read-only phases, cache written more than read, and no spending limit. Each suggestion states the quality trade-off. No "savings" are estimated: the effect is checked with Compare.

## Authentication and cost of real runs

The SDK uses the Claude Code executable and its credentials, in this order:

1. `ANTHROPIC_API_KEY` in the environment Regia is started from: usage billed per token to the key's account.
2. Claude Code login (`claude auth status`): with a claude.ai subscription, usage counts against the plan limits.

The SDK documentation states that third-party products must not offer claude.ai login and must use API keys. For personal, local use the login works, but check your organization's policies.

The "Esecuzione reale" (real run) dialog shows the authentication method, models, phases that can edit files or run commands, local commands and spending limit, and asks for explicit confirmation. With `REGIA_DISABLE_REAL=1` real runs are disabled.

### Agent permissions

Each phase gets only the selected tools (`tools` and `allowedTools`), with `permissionMode: 'dontAsk'`: anything not allowed is denied without asking, and denials appear among the observed decisions. `Bash`, `Edit` and `Write` act without further confirmation in the project folder: use them only on projects you have a copy of or under version control.

Hooks, plugins and personal settings from `~/.claude` are not loaded; personal rules from `~/.claude/CLAUDE.md` are, through the general rules. The project's CLAUDE.md and settings are loaded only if you enable the option in the workflow.

## Data and privacy

- Everything stays local in `data/`, which is excluded from version control: workflows, runs, Regia rules and reuse cache. The folder can be moved with `REGIA_DATA_DIR`.
- Regia never reads or stores credentials. Of the authentication status it exposes only method, provider and plan type, with no email or organization.
- Text produced by agents goes through a filter that masks common secret patterns (API keys, tokens, private keys, `*_TOKEN=`/`*_SECRET=`/`PASSWORD=` assignments) before being stored or shown. The filter is heuristic and does not replace care about what agents are allowed to read.
- The API rejects requests from origins other than localhost.
- SDK sessions are saved by Claude Code in its projects folder (`~/.claude/projects`), as with any CLI use.

## Trial mode

"Prova" (trial run) runs the workflow with simulated agents: no network calls and no cost, fictitious rates. Simulated messages have the same shape as the SDK's (duplicate IDs for parallel tool calls, subagents, resumed sessions with restored totals, crashes with zeroed values), so usage accounting follows the same code path as real runs. In a phase's instructions you can write `[simula-errore]`, `[simula-blocco]` or `[simula-budget]` to try the interventions (error, block, budget). The local server is simulated and no command runs.

## Languages

The interface, Regia's messages and the instructions sent to agents are translated through JSON files, without touching the code.

- **Translations**: `locales/<language>/*.json` (e.g. `locales/it/`, `locales/en/`). Each folder contains `_meta.json` with name and locale (`{"name": "English", "locale": "en-GB"}`) and one or more files with nested keys; the files of a language are merged. Parameters in braces (`{count} phases`), plurals as objects (`{"one": "{count} phase", "other": "{count} phases"}`). Missing keys fall back to English, then Italian.
- **Presets**: `templates/<language>/*.json`, same file names for every language; an untranslated preset falls back to the English version, then the Italian one.
- **Interface language**: chosen from the languages menu at the top right (remembered in the browser); initially it follows the browser language.
- **Agent language**: a per-workflow setting ("Lingua degli agenti" / agent language). It sets the language of the response protocol, the rules and the prompt headings sent to the agents; new workflows use the interface language.
- Messages generated by Regia (validation, events, interventions, suggestions) travel as key and parameters and are translated into the viewer's language; text written by agents is shown as they wrote it.

**Adding a language**: copy `locales/en/` to `locales/<code>/`, update `_meta.json` and translate the values (not the keys). Optionally translate the presets in `templates/<code>/`. Files are re-read on every request: just reload the page. `npm run i18n:check` lists missing or extra keys for each language.

## Environment variables

| Variable | Effect |
|---|---|
| `PORT` | Server port (default 4317; listens on 127.0.0.1 only) |
| `REGIA_DATA_DIR` | Local data folder (default `data/`) |
| `REGIA_GLOBAL_RULES` | Personal rules file (default `~/.claude/CLAUDE.md`) |
| `REGIA_DISABLE_REAL=1` | Disables real runs |
| `REGIA_LANG` | Default server language (e.g. for the initial Regia rules); otherwise the system language |
| `REGIA_MOCK_SPEED` | Milliseconds per step in trial mode (default 600) |
| `ANTHROPIC_API_KEY` | If set, real runs use the API key instead of the login |

## Structure

```
server/            Express API + SSE, execution engine, usage accounting, simulator, suggestions
  engine.ts        phase graph, parallelism, budget, interventions, resumes, reuse
  usage.ts         counting rules (dedup, subagents, resumes, crashes)
  mockQuery.ts     trial mode
  insights.ts      optimization suggestions
  validate.ts      diagram validation
  rules.ts         general rules (personal, Regia, project)
  folder.ts        project folder check (git, pending changes)
  service.ts       local server phase processes (start, address, shutdown)
  nodeenv.ts       Node version required by the project, installations, error diagnosis
shared/types.ts    shared data model
web/src/           React + React Flow interface
templates/         starting presets (JSON)
```

## Known limits

- Result quality is judged only through observable signals: declared outcomes, approvals, attempts and final state. Regia does not assess the content.
- Declared decisions depend on the agent following the response protocol. If the outcome block is missing, the phase uses the final text and reports it.
- With several phases in parallel, the per-run spending limit is split up front, so the total may slightly exceed it if one phase uses less than its share and another more.
- After a rejection, only the phases between the corrected one and the approval run again (including intermediate approvals, which are requested again). Other downstream phases already completed do not run again.
- "Continue" carries over a phase only if it is identical and completed; a skipped or failed phase runs again. Resuming the original session requires Claude Code to still have the saved session (`~/.claude/projects`).
- Reuse compares configuration, inputs and a fingerprint of the project files (path, size, modification time). It does not detect changes outside the folder.
- An active run does not survive a server restart: it is marked as interrupted.
- Live counters for subagents are not shown during a phase: their usage arrives with the result.
