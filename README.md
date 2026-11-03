# Regia

Draw the path, let the agents work, step in when it matters.

Regia is a local app for designing development workflows as a diagram, running them with [Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk/overview) agents, and following the execution live on the same diagram.

![Regia during a run](docs/img/05-anteprima-locale.png)

> The user interface is in Italian. The documentation is available in [English](docs/manual.md) and [Italian](docs/manuale.md).

## What it does

- **Visual editor**: analysis, implementation, test, review, human approval, local server and publishing phases, connected into a flow. Start from ready-made presets.
- **Live execution**: the state of every phase on the diagram, plus events, results, errors and the decisions declared by the agents.
- **Interventions**: approve, reject with a comment (the agent resumes its own session), retry, skip, cancel.
- **Local preview**: Regia starts the project's dev server with the right Node version and gives you the link to check before approving.
- **Usage tracking**: tokens, cache, model and estimated cost per run, phase and agent, with no double counting across subagents and resumed sessions. Spending limits per run and per phase.
- **Optimization**: suggestions based on measured data, each with its quality trade-off, and a side-by-side comparison of two runs.
- **Continue**: add phases to finished work without re-running everything.
- **General rules**: your personal rules and Regia's own rules are applied to every agent.
- **Trial mode**: explore everything with simulated agents, at no cost.

## Quick start

Requirements: Node.js 20+. For real runs, Claude Code with an active login, or `ANTHROPIC_API_KEY`.

```bash
git clone https://github.com/DoctorB/regia.git
cd regia
npm install
npm start
```

Open <http://127.0.0.1:4317>, create a workflow from a preset and press **Prova** (trial run).

## Documentation

| | English | Italiano |
|---|---|---|
| User manual, step by step with screenshots | [Manual](docs/manual.md) | [Manuale](docs/manuale.md) |
| Usage accounting, rules, agent permissions, stored data, environment variables, known limits | [Technical details](docs/technical-details.md) | [Dettagli tecnici](docs/dettagli-tecnici.md) |

## Costs and data

- Costs shown are **estimates** computed by the SDK, not billing data. With an API key, the actual cost is in the Console; with a claude.ai login, usage counts against your plan limits.
- Everything stays on your machine, in the `data/` folder (excluded from git). Regia never reads or stores credentials and listens on 127.0.0.1 only.
- Agents can edit files and run commands in the project folder, limited to the tools you grant each phase. Use a clean git repository so you can review and undo their work.

## Development

```bash
npm run dev        # server and UI with hot reload (http://127.0.0.1:5173)
npm test           # usage accounting, execution engine, local server
npm run typecheck
```

## License

[MIT](LICENSE)
