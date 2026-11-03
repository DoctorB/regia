# Regia manual

*[Leggi in italiano](manuale.md)*

Regia lets AI agents work on your project along a path you design: analysis, implementation, testing, review, browser preview, approval, publishing. While they work, the diagram shows what they are doing, what they decide and how much they use, and you step in when needed.

The screenshots were taken in **trial mode**: simulated agents, no cost. The interface is in Italian; button labels are shown as they appear on screen, with their meaning in parentheses.

---

## 1. Start

Once:

```bash
git clone https://github.com/DoctorB/regia.git
cd regia
npm install
```

Every time:

```bash
npm start
```

Open **http://127.0.0.1:4317** and keep the terminal open while you use Regia. Closing it also stops any run in progress.

**Requirements**: Node.js 20 or later. Real runs need [Claude Code](https://docs.claude.com/en/docs/claude-code) with an active login (check with `claude auth status`), or the `ANTHROPIC_API_KEY` environment variable. You don't need to open Claude Code: Regia uses its credentials.

---

## 2. Create a workflow

![New workflow](img/01-nuovo-workflow.png)

1. On first start you see the welcome screen; later, open the menu with the workflow name at the top left → **Nuovo workflow…** (new workflow). Pick a preset: *Correggi un bug* (fix a bug), *Nuova funzionalità* (new feature), *Revisione del codice* (read-only code review), *Aggiungi test* (add tests), *Refactoring sicuro* (safe refactoring) or *Vuoto* (empty).
2. Enter the **project folder**. Regia checks whether it is a git repository and whether it has uncommitted changes.
   > Before a real run, **commit or stash** your changes: you can then review the agents' work with `git diff` and undo it with `git checkout .`.
3. Write the **goal**: what needs to be done and when it counts as finished. The more precise it is, the fewer rounds it takes.

---

## 3. Customize the phases

![Editor](img/02-editor.png)

- **Add** phases from the palette on the left: drag them onto the diagram, or click. If a phase is selected, the new one is connected right after it. **Riordina** (arrange) lays the diagram out top to bottom.
- **Connect** two phases by dragging from the bottom handle of one to the top handle of the other; select a connection or a phase and press **Delete** to remove it.
- **Configure** the selected phase in the right panel:
  - *Istruzioni* (instructions): what it must do, ideally naming the files to look at.
  - *Modello* (model): Haiku ($) for simple tasks (tests, checks), Sonnet ($$) as the balanced choice, Opus ($$$) for the hardest tasks.
  - *Strumenti* (tools): turn on only those needed. Tools with a pencil icon edit files or run commands.
  - *Turni massimi* (max turns) and *Spesa massima* (spending limit): safety caps.
- With no phase selected, the panel shows the **workflow settings**: folder, goal, spending limit per run, phases in parallel, rules.
- The indicator at the top tells you whether the workflow is **Valido** (valid): click it to see errors and warnings and jump to the phase concerned. Errors block the start. **Salva** (save) appears when there are changes (also `Ctrl+S`).

### Phase types

| Phase | Purpose |
|---|---|
| Analisi, Implementazione, Test, Revisione, Personalizzata (analysis, implementation, test, review, custom) | Work done by an agent |
| **Approvazione umana** (human approval) | The workflow waits until you approve or reject |
| **Server locale** (local server) | Regia starts the project's dev server (e.g. `npm run dev`) so you can see the result in the browser |
| **Pubblicazione** (publishing, ready-made phase) | Commit, push and any releases or GitHub Actions. Place it after an approval |

---

## 4. Try first, then run for real

- **Prova** (trial run): runs everything with simulated agents. Use it to check the flow and the interactions, for free.
- **Esegui** (run for real): shows a summary (authentication, models, phases that can edit files, local commands, spending limit) and starts only after you confirm.

![Run](img/03-esecuzione.png)

On the diagram each phase shows its state (waiting, active, completed, failed, blocked, waiting for you), what it is doing and the last declared decision; **Segui fase attiva** (follow active phase) keeps the running phase in view. At the top of the panel you find cost and spending limit, completed phases and a progress bar (click a segment to select that phase). **Annulla** (cancel) stops everything.

---

## 5. Step in when needed

![Approval](img/04-approvazione.png)

When the workflow stops, the **Stato** (status) tab shows what is needed:

- **Approval**: read the summaries of the previous phases and check the project (`git diff`), then **Approva** (approve) or **Respingi con commento** (reject with a comment): the phase that produced the work resumes where it left off with your comment, and tests and review run again.
- **Failed or blocked phase**: **Riprova da capo** (retry from scratch), **Riprendi la sessione** (resume the session, with a message for the agent), **Salta la fase** (skip the phase) or **Annulla esecuzione** (cancel the run).

### Browser preview

![Local preview](img/05-anteprima-locale.png)

The **Server locale** phase starts the project's server and puts the link in the approval request: open it, check, then approve. Stop and restart are one click away. Regia picks the Node version the project requires (`.nvmrc`, `engines`), installs dependencies if missing and, if the right Node version is not installed, offers to install it. The server is shut down when the run ends.

---

## 6. Understand what happened

A run's panel has five tabs:

| Tab | What you find |
|---|---|
| **Stato** (status) | Pending interventions, running servers, applied rules, phase summary |
| **Eventi** (events) | Everything that happens, filterable by type; click a phase on the diagram to see only its events |
| **Decisioni** (decisions) | Short explanations written by the agents (*dichiarate*, declared) or inferred from their actions (*osservate*, observed). The models' internal reasoning is not shown |
| **Consumi** (usage) | Tokens, cache and estimated cost per phase, agent and model |
| **Ottimizza** (optimize) | Where the spending concentrates and what to try, each with its possible quality trade-off |

![Decisions](img/06-decisioni.png)

![Usage](img/07-consumi.png)

![Optimizations](img/08-ottimizzazioni.png)

> **Costs are estimates** computed by the SDK at list prices. With an API key, the actual cost is in the Console; with a claude.ai subscription, usage counts against your plan limits.

---

## 7. Improve: compare two runs

![Comparison](img/09-confronto.png)

Change something (for example a cheaper model for the review), run again and open **Confronta** (compare): you see the measured differences in cost, tokens, time and outcome, and what changed in the configuration. A single pair of runs is not enough to draw conclusions: agents are not deterministic.

---

## 8. Add phases to finished work: Continue

![Continue](img/10-continua.png)

You finished a run and realize something was missing, for example preview, approval and publishing?

1. Add the phases in the editor and **save**.
2. Go to **Esecuzione** (run) and pick the finished run from the menu at the top of the panel.
3. **Continua…** (continue): phases already done and unchanged are carried over with their results, without running them again; only new or changed phases run. The summary before starting tells you which ones and why.

---

## 9. General rules

![Rules](img/11-regole.png)

The **Regole** (rules) button shows the rules added to every agent's instructions:

- your **personal rules** (`~/.claude/CLAUDE.md`), read and never modified;
- **Regia's rules**, editable here (by default: no commit or push unless the phase asks for it, no changes outside the project, no reading credential files);
- the **project's CLAUDE.md**, if you enable the option in the workflow.

Each run stores the rules it used.

---

## 10. Common problems

| Problem | What to do |
|---|---|
| "Esegui" (run) is disabled | The workflow has errors (badge at the top) |
| No login detected | Run `claude` once and sign in, or set `ANTHROPIC_API_KEY` before `npm start` |
| The local server does not start | Read the reason in the intervention request: Node version, dependencies, port in use. Use the suggested buttons or fix the command in the phase |
| The run shows as "interrotta" (interrupted) | Regia was closed while it was active: open it and use **Continua…** |
| Spending is close to the limit | Raise the limit in the workflow settings or check the Ottimizza tab |

For details on usage accounting, permissions, stored data and known limits: [technical details](technical-details.md).
