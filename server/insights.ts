// Suggerimenti di ottimizzazione basati solo su dati misurati dell'esecuzione.
// Non stimano risparmi: indicano dove si concentra la spesa e cosa provare, con il compromesso atteso.
// L'effetto reale si verifica confrontando due esecuzioni.
import type { Attempt, Insight, Run, WorkflowNode } from '../shared/types.ts';
import { WRITE_TOOLS, isAgentKind } from '../shared/types.ts';

const usd = (n: number) => `${n.toFixed(4)} USD`;
const tok = (n: number) => n.toLocaleString('it-IT');

function tier(models: string[], configured: string): 'premium' | 'medio' | 'economico' | 'sconosciuto' {
  const all = [...models, configured].join(' ').toLowerCase();
  if (/opus|fable/.test(all)) return 'premium';
  if (/sonnet/.test(all)) return 'medio';
  if (/haiku/.test(all)) return 'economico';
  return 'sconosciuto';
}

interface NodeStats {
  node: WorkflowNode;
  attempts: Attempt[];
  cost: number;
  costKnown: boolean;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  turns: number;
  models: string[];
  repeated: { name: string; count: number }[];
}

function stats(run: Run): NodeStats[] {
  return run.snapshot.nodes.filter((n) => isAgentKind(n.data.kind)).map((node) => {
    const attempts = (run.nodes[node.id]?.attempts ?? []).filter((a) => a.usageSource !== 'riusato');
    const s: NodeStats = { node, attempts, cost: 0, costKnown: true, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, turns: 0, models: [], repeated: [] };
    for (const a of attempts) {
      if (a.usage.costUsd === null) s.costKnown = false; else s.cost += a.usage.costUsd;
      s.input += a.usage.inputTokens; s.output += a.usage.outputTokens;
      s.cacheCreate += a.usage.cacheCreationInputTokens; s.cacheRead += a.usage.cacheReadInputTokens;
      s.turns += a.numTurns ?? 0;
      for (const m of Object.keys(a.usage.byModel).concat(a.models)) if (!s.models.includes(m)) s.models.push(m);
      const counts = new Map<string, { name: string; count: number }>();
      for (const c of a.toolCalls) {
        const e = counts.get(c.key) ?? { name: c.name, count: 0 };
        e.count++;
        counts.set(c.key, e);
      }
      for (const e of counts.values()) if (e.count >= 3) s.repeated.push(e);
    }
    return s;
  });
}

export function computeInsights(run: Run): Insight[] {
  const out: Insight[] = [];
  const all = stats(run);
  const total = all.reduce((x, s) => x + s.cost, 0);
  const share = (s: NodeStats) => (total > 0 ? s.cost / total : 0);
  const pct = (s: NodeStats) => `${Math.round(share(s) * 100)}%`;
  const sev = (s: NodeStats): Insight['severity'] => (share(s) >= 0.35 ? 'alta' : share(s) >= 0.15 ? 'media' : 'info');
  const wf = run.snapshot;
  const sim = run.mode === 'prova' ? ' (dati simulati)' : '';
  const ctxs = all.map((s) => s.input + s.cacheCreate + s.cacheRead).filter((x) => x > 0).sort((a, b) => a - b);
  const medianCtx = ctxs.length ? ctxs[Math.floor(ctxs.length / 2)] : 0;
  const preds = (id: string) => wf.edges.filter((e) => e.target === id).map((e) => e.source);
  const hasWriterAncestor = (id: string): boolean => preds(id).some((p) => {
    const n = wf.nodes.find((x) => x.id === p);
    return Boolean(n && (n.data.allowedTools.some((t) => WRITE_TOOLS.includes(t)) || hasWriterAncestor(p)));
  });
  // Cicli di correzione chiesti in approvazione: costo della fase ripresa + fasi intermedie rieseguite.
  const correctionAttempts = all.flatMap((s) => s.attempts.filter((a) => a.reason === 'dopo_correzione' || a.reason === 'ripresa_con_feedback').map((a) => ({ s, a })));
  const correctionTargets = new Set(correctionAttempts.filter((x) => x.a.reason === 'ripresa_con_feedback').map((x) => x.s.node.id));
  const rounds = Object.values(run.nodes).reduce((x, n) => x + n.feedbackRounds, 0);
  if (rounds > 0 && correctionAttempts.length) {
    const c = correctionAttempts.reduce((x, { a }) => x + (a.usage.costUsd ?? 0), 0);
    const names = [...new Set(correctionAttempts.map(({ s }) => s.node.data.label))];
    out.push({
      id: 'corrections', severity: total > 0 && c / total > 0.25 ? 'alta' : 'media',
      title: rounds === 1 ? '1 ciclo di correzione richiesto in approvazione' : `${rounds} cicli di correzione richiesti in approvazione`,
      evidence: `Costo stimato dei passaggi rifatti: ${usd(c)}${total > 0 ? ` (${Math.round((c / total) * 100)}% del totale)` : ''}${sim}. Fasi coinvolte: ${names.join(', ')}.`,
      suggestion: 'Riporta nelle istruzioni della fase di implementazione i criteri che hai usato per respingere, oppure aggiungi una revisione automatica mirata a quei criteri prima dell\'approvazione.',
      tradeoff: 'Criteri più rigidi allungano le istruzioni (più input a ogni chiamata) e una revisione in più costa anche quando il lavoro è già corretto.',
    });
  }

  // Fase più costosa
  const top = [...all].sort((a, b) => b.cost - a.cost)[0];
  if (top && total > 0 && share(top) >= 0.4 && all.length > 1) {
    out.push({
      id: `top-${top.node.id}`, severity: 'alta', nodeId: top.node.id,
      title: `"${top.node.data.label}" concentra ${pct(top)} della spesa stimata`,
      evidence: `${usd(top.cost)} su ${usd(total)}${sim}; input+cache ${tok(top.input + top.cacheCreate + top.cacheRead)} token, output ${tok(top.output)}.`,
      suggestion: 'È la fase su cui un intervento ha più effetto: vedi i suggerimenti specifici sotto per questa fase.',
      tradeoff: 'Nessuno di per sé: è un\'indicazione di priorità.',
    });
  }

  for (const s of all) {
    const d = s.node.data;
    const t = tier(s.models, d.model);
    const readOnly = !d.allowedTools.some((x) => WRITE_TOOLS.includes(x));
    const simpleKind = d.kind === 'test' || d.kind === 'revisione' || (d.kind === 'analisi' && readOnly);

    if (simpleKind && (t === 'premium' || t === 'medio') && share(s) >= 0.1) {
      const target = t === 'premium' ? 'sonnet' : 'haiku';
      out.push({
        id: `model-${s.node.id}`, severity: sev(s), nodeId: s.node.id,
        title: `"${d.label}": prova un modello meno costoso (${target})`,
        evidence: `Fase di tipo ${d.kind}${readOnly ? ', senza strumenti di scrittura' : ''}, modello ${s.models.join(', ') || d.model}; ${usd(s.cost)} (${pct(s)} del totale)${sim}.`,
        suggestion: `Imposta il modello "${target}" per questa fase e confronta le due esecuzioni (esito, decisioni, tempi).`,
        tradeoff: d.kind === 'test'
          ? 'Eseguire i test e riportarne l\'esito richiede poco ragionamento, ma la diagnosi delle cause di un fallimento può essere meno precisa.'
          : d.kind === 'revisione'
            ? 'Una revisione con un modello più piccolo può non accorgersi di problemi sottili (logica, casi limite). Tienilo se la revisione è il tuo controllo di qualità principale.'
            : 'L\'analisi può essere meno approfondita e indicare meno file o cause: verifica che la fase successiva non debba poi rifare il lavoro.',
      });
    }

    // Ogni sessione parte con un prompt di sistema corposo (in cache), quindi un rapporto input/output alto è normale:
    // si segnala solo una fase che usa molto più contesto delle altre, o che riceve il testo completo delle precedenti.
    const ctxTokens = s.input + s.cacheCreate + s.cacheRead;
    const relHigh = all.length > 1 && medianCtx > 0 && ctxTokens >= 2 * medianCtx;
    const fullCtx = d.contextMode === 'completo' && wf.edges.some((e) => e.target === s.node.id);
    if (ctxTokens > 40000 && s.output > 0 && (relHigh || fullCtx)) {
      out.push({
        id: `ctx-${s.node.id}`, severity: sev(s), nodeId: s.node.id,
        title: `"${d.label}": ${relHigh ? 'molto più contesto delle altre fasi' : 'riceve il testo completo delle fasi precedenti'}`,
        evidence: `${tok(ctxTokens)} token di input/cache${relHigh ? ` (${(ctxTokens / medianCtx).toFixed(1)}× la mediana delle fasi)` : ''} contro ${tok(s.output)} di output${sim}.`,
        suggestion: [
          d.contextMode === 'completo' ? 'Passa i risultati delle fasi precedenti in modalità "sintesi" invece che "completo".' : null,
          'Indica nelle istruzioni i file o le cartelle da guardare, così l\'agente legge meno.',
          wf.settings.loadProjectSettings ? 'Se il CLAUDE.md del progetto è lungo e non serve a questa fase, valuta di non caricarlo.' : null,
        ].filter(Boolean).join(' '),
        tradeoff: 'Con meno contesto l\'agente può non vedere informazioni utili e sbagliare o chiedere un altro passaggio: restringi gradualmente.',
      });
    }

    if (s.repeated.length) {
      out.push({
        id: `rep-${s.node.id}`, severity: 'media', nodeId: s.node.id,
        title: `"${d.label}": chiamate identiche ripetute`,
        evidence: s.repeated.map((r) => `${r.name} ×${r.count} con gli stessi parametri`).join('; ') + '.',
        suggestion: 'Chiedi nelle istruzioni di non rileggere file già letti se non sono cambiati e di riassumere ciò che serve; imposta un limite di turni adeguato.',
        tradeoff: 'Rileggere un file dopo una modifica può essere legittimo (verifica): non vietarlo del tutto.',
      });
    }

    if (d.maxTurns && s.attempts.some((a) => (a.numTurns ?? 0) >= d.maxTurns! * 0.8)) {
      out.push({
        id: `turns-${s.node.id}`, severity: 'media', nodeId: s.node.id,
        title: `"${d.label}": vicino al limite di turni`,
        evidence: `Turni usati: ${s.attempts.map((a) => a.numTurns ?? '?').join(', ')} su un massimo di ${d.maxTurns}.`,
        suggestion: 'Spezza il compito in due fasi più piccole o rendi le istruzioni più specifiche, invece di alzare soltanto il limite.',
        tradeoff: 'Più fasi significano più avvii di sessione e contesto ricaricato: conviene solo se i passaggi sono davvero separabili.',
      });
    }

    // Tentativi dovuti a errori o blocchi della fase stessa (le correzioni da approvazione sono conteggiate a parte).
    const retries = s.attempts.filter((a) => a.reason === 'riprova' || (a.reason === 'ripresa_con_feedback' && !correctionTargets.has(s.node.id)));
    if (retries.length) {
      const retryCost = retries.reduce((x, a) => x + (a.usage.costUsd ?? 0), 0);
      const failures = s.attempts.filter((a) => a.status === 'errore').map((a) => a.error ?? a.resultSubtype ?? 'errore');
      out.push({
        id: `retry-${s.node.id}`, severity: retryCost > 0 && total > 0 && retryCost / total > 0.15 ? 'alta' : 'media', nodeId: s.node.id,
        title: `"${d.label}": ${retries.length} tentativi aggiuntivi dopo errori o blocchi`,
        evidence: `Costo stimato dei tentativi aggiuntivi: ${usd(retryCost)}${sim}.${failures.length ? ` Cause: ${failures.slice(0, 3).join('; ')}.` : ''}`,
        suggestion: 'Se la causa è ricorrente (limite di turni o di spesa, strumento mancante, informazione assente), correggi la configurazione invece di ritentare; "Riprendi la sessione" riusa il contesto già costruito invece di ricominciare.',
        tradeoff: 'Riprendere una sessione porta con sé anche eventuali errori di impostazione dell\'agente; ripartire da capo costa di più ma è più pulito.',
      });
    }

    if (readOnly && !d.reuseResult && share(s) >= 0.1 && !hasWriterAncestor(s.node.id)) {
      out.push({
        id: `reuse-${s.node.id}`, severity: 'info', nodeId: s.node.id,
        title: `"${d.label}": candidato al riuso del risultato`,
        evidence: `Fase in sola lettura, ${usd(s.cost)}${sim}.`,
        suggestion: 'Attiva "Riusa il risultato se nulla è cambiato": nelle esecuzioni successive, se istruzioni, input e file del progetto sono identici, il risultato precedente viene riusato senza chiamate.',
        tradeoff: 'L\'impronta dei file si basa su percorso, dimensione e data di modifica: cambiamenti fuori dalla cartella del progetto (dipendenze, servizi esterni) non vengono rilevati.',
      });
    }
  }

  // Passaggi potenzialmente ridondanti: due fasi in sola lettura in sequenza diretta.
  for (const e of wf.edges) {
    const a = wf.nodes.find((n) => n.id === e.source);
    const b = wf.nodes.find((n) => n.id === e.target);
    if (!a || !b || !isAgentKind(a.data.kind) || !isAgentKind(b.data.kind)) continue;
    const ro = (n: WorkflowNode) => !n.data.allowedTools.some((x) => WRITE_TOOLS.includes(x));
    const onlyPred = wf.edges.filter((x) => x.target === b.id).length === 1;
    if (ro(a) && ro(b) && onlyPred && a.data.model === b.data.model) {
      out.push({
        id: `merge-${a.id}-${b.id}`, severity: 'info', nodeId: b.id,
        title: `"${a.data.label}" e "${b.data.label}" sono due fasi in sola lettura consecutive`,
        evidence: 'Stesso modello, nessuna modifica ai file tra le due: la seconda ricarica il contesto del progetto.',
        suggestion: 'Valuta di unirle in un\'unica fase con istruzioni in due punti.',
        tradeoff: 'Una fase unica è meno leggibile nel diagramma e un errore costringe a rifare entrambe le parti.',
      });
    }
  }

  const cc = all.reduce((x, s) => x + s.cacheCreate, 0);
  const cr = all.reduce((x, s) => x + s.cacheRead, 0);
  if (cc > 20000 && cr < cc) {
    out.push({
      id: 'cache', severity: 'info',
      title: 'La cache viene scritta più di quanto venga riletta',
      evidence: `Cache scritta ${tok(cc)} token, letta ${tok(cr)} token${sim}. La scrittura in cache costa più dell'input normale.`,
      suggestion: 'Succede con molte fasi brevi, ognuna con un contesto nuovo. Meno fasi più corpose, o fasi che condividono lo stesso modello e lo stesso prompt di sistema, riutilizzano meglio la cache.',
      tradeoff: 'Accorpare le fasi riduce la granularità di controllo e la possibilità di usare modelli diversi per compiti diversi.',
    });
  }

  if (run.budgetUsd === undefined && run.mode === 'reale' && total > 0) {
    out.push({
      id: 'budget', severity: 'media',
      title: 'Nessun limite di spesa per esecuzione',
      evidence: `Questa esecuzione è costata circa ${usd(total)} (stima del SDK).`,
      suggestion: `Imposta un limite nelle impostazioni del workflow, ad esempio ${usd(Math.max(0.05, total * 1.5))} (1,5× il valore osservato), e limiti per fase sulle fasi più costose.`,
      tradeoff: 'Un limite troppo basso interrompe una fase a metà: il lavoro parziale resta nei file ma va completato con un nuovo tentativo.',
    });
  }

  const order = { alta: 0, media: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}
