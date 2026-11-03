# Regia — dettagli tecnici

*[Read in English](technical-details.md)*

Approfondimenti per chi vuole sapere come Regia conta i consumi, quali regole applica agli agenti, come gestisce i server locali e quali limiti ha. Per l'uso quotidiano basta il [manuale](manuale.md).

## Avvio app

Fase gestita da Regia, senza agenti e senza costi. Esegue un comando nella cartella del progetto (o in una sottocartella) con la shell di sistema, quindi va bene qualsiasi strumento. Poi attende che l'app sia pronta secondo il criterio scelto:

- **url**: l'indirizzo indicato, oppure il primo indirizzo locale stampato, riceve una risposta HTTP qualsiasi (anche 401 o 500). Il certificato non viene verificato, così funzionano i certificati di sviluppo (IIS Express, `dotnet dev-certs`): è solo un controllo di raggiungibilità. **Senza comando** la fase verifica soltanto un servizio già attivo (IIS, container, ambiente di test) e non lo avvia né lo ferma.
- **output**: una riga dell'output contiene il testo atteso (senza distinzione di maiuscole), oppure corrisponde a `/espressione regolare/`.
- **process**: il programma è ancora aperto dopo qualche secondo. Per queste fasi e per **output** la finestra non viene nascosta. Un lanciatore che termina subito con codice 0 (es. `start app.exe`) è considerato riuscito.
- **exit**: il comando termina con codice 0 entro l'attesa massima (predefinita 600 secondi, massimo 3600).

**Sistemi**: su Windows il comando parte con `cmd.exe` e l'app viene chiusa con `taskkill /T`; su macOS e Linux con `/bin/sh` in un gruppo di processi a parte, chiuso con un segnale al gruppo. La fase pronta "App iOS (simulatore)" usa `xcodebuild` e `xcrun simctl`, quindi funziona solo su macOS con Xcode.

Nel diagramma e nella richiesta di approvazione successiva compaiono il link (se c'è), lo stato, le ultime righe di output e i pulsanti Ferma / Riavvia. Solo per i progetti Node (presenza di `package.json`, o versione di Node indicata nella fase) prima dell'avvio la fase prepara anche l'ambiente:

- **Versione di Node**: legge `.nvmrc` / `.node-version` e `engines.node` del package.json (o il campo "Versione di Node" della fase) e sceglie la versione compatibile più recente tra quelle installate (nvm, nvm-windows, fnm, volta, sistema). La usa solo per quel comando, mettendola in testa al PATH: la versione di sistema non cambia. Se nessuna è compatibile non avvia nulla e propone **Installa Node e riprova**, mostrando il comando esatto (es. `nvm install 24.22.2`, versione scelta dall'elenco ufficiale di nodejs.org preferendo le LTS). L'installazione parte solo con il tuo clic.
- **Dipendenze**: se manca `node_modules` le installa con il gestore indicato dal lockfile, senza modificarlo (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `bun install --frozen-lockfile`).

Se l'avvio non riesce, la fase legge l'output e riconosce le cause comuni. Nei progetti Node, per un messaggio "versione di Node non supportata" ricava la versione richiesta e, se è installata, riprova da sola una volta; altrimenti propone di installarla. Per moduli o comandi mancanti propone **Installa le dipendenze e riprova**. Segnala anche porta occupata e permessi insufficienti. Negli altri casi mostra l'output utile a capire perché.

I log scritti in JSON (Astro, Vite e altri quando non sono collegati a un terminale) vengono trasformati in righe leggibili, e dall'output si estrae l'indirizzo tenendo solo caratteri validi in un URL.

L'app viene fermata (insieme ai processi figli) quando l'esecuzione termina o viene annullata, e quando Regia si chiude. Dopo una correzione chiesta in un'approvazione successiva viene riavviato, così si verifica la versione aggiornata; con "Continua" viene sempre riavviato. In modalità di prova è simulata e nessun comando viene eseguito. Prima di un'esecuzione reale il dialogo di conferma elenca i comandi che verranno avviati e gli indirizzi che verranno verificati.

## Interventi

- **Approvazione umana**: approva, oppure respingi con un commento. La fase a monte più vicina che può modificare file riprende la propria sessione con il commento; le fasi intermedie (test, revisione) vengono rieseguite e l'approvazione viene richiesta di nuovo. Al massimo 3 cicli.
- **Fase fallita o bloccata**: l'agente può dichiarare un esito `ko` o `bloccato`. Le scelte sono riprova da capo, riprendi la sessione con un messaggio, salta oppure annulla l'esecuzione.

## Regole generali

Il pulsante **Regole** mostra le regole aggiunte alle istruzioni di ogni fase (opzione "Applica le regole generali" del workflow, attiva di base). Prevalgono sulle istruzioni della fase.

- **Regole personali**: `~/.claude/CLAUDE.md`, lette a ogni esecuzione, mai modificate da Regia. Servono perché hook, plugin e impostazioni personali di `~/.claude` non vengono caricati negli agenti.
- **Regole di Regia**: testo modificabile, salvato in `data/regole.md`. Di base: niente commit o push salvo richiesta esplicita della fase, niente modifiche fuori dalla cartella del progetto, niente lettura di file con credenziali se non indispensabile.
- **CLAUDE.md del progetto**: caricato dalla CLI se è attiva l'opzione del workflow; il pannello lo mostra in sola lettura.

Ogni esecuzione salva le regole che ha usato: le trovi nella scheda Stato ("Regole applicate") e nel registro eventi. Il percorso del file di regole personali si può cambiare con `REGIA_GLOBAL_RULES`.

## Skill

- **Ricerca**: `<progetto>/.claude/skills/<nome>/SKILL.md` e `~/.claude/skills` (fino a 4 livelli di sottocartelle). Nome e descrizione dal frontmatter; senza frontmatter il nome è quello della cartella. Le skill personali sono escluse finché non si attivano nel workflow.
- **Esecuzione**: per ogni tentativo Regia copia le sole skill scelte in un plugin locale temporaneo (`data/skill-bundles/`, chiamato `regia-skills`) e lo passa al SDK con le opzioni `plugins` e `skills`, aggiungendo lo strumento `Skill` solo a quella fase. I file originali non vengono modificati e, con le impostazioni del progetto spente, non si caricano impostazioni, hook o plugin personali. Il plugin viene rimosso a fine fase (e all'avvio di Regia, se ne restano).
- **Nomi**: nel plugin ogni skill prende il nome della propria cartella in minuscolo (`Revisione Testi` → `revisione-testi`); due skill con lo stesso nome, una del progetto e una personale, restano distinte con un suffisso.
- **Riuso dei risultati**: le skill scelte fanno parte della chiave di riuso.
- **Modalità di prova**: la prima skill disponibile viene "usata" in modo simulato, così eventi e decisioni si vedono senza costi.

## Decisioni mostrate

- **Dichiarate**: righe `DECISIONE: …` che l'agente scrive su richiesta del protocollo di risposta, più l'elenco `decisioni` del blocco di esito finale.
- **Osservate**: dedotte da eventi visibili, cioè file modificati, comandi eseguiti, skill usate, subagenti avviati e strumenti negati.

I blocchi di ragionamento interno (thinking) non vengono mai mostrati né salvati.

## Consumi

Fonte: messaggio `result` di ogni chiamata `query()`.

- **Totali per fase**: da `modelUsage` e `total_cost_usd`. Includono i subagenti e il dettaglio per modello: input, output, scrittura e lettura della cache, costo e listino usato.
- **Contatori live durante la fase**: input e cache dai messaggi `assistant`, deduplicati per `message.id`. Sono solo indicativi, perché `output_tokens` sui singoli messaggi è un segnaposto.
- **Sessioni riprese** ("Riprendi" e correzioni da approvazione): il result riporta anche la spesa precedente della sessione, quindi Regia registra solo la differenza rispetto ai totali già contati. Se la CLI non ha ripristinato i totali, non sottrae nulla.
- **Crash**: il result di errore può avere valori azzerati. In quel caso restano i contatori live (input e cache del ciclo principale) e il costo è segnato come non noto.
- **Per agente**: aggregato per ruolo.

**Stime, non fatturazione.** `total_cost_usd` e `costUSD` sono calcolati localmente dal SDK con il listino incluso nella sua versione. Con una chiave API il costo effettivo si legge nella Console. Con il login claude.ai il consumo rientra nei limiti del piano (o nei crediti extra, se attivi) e i dollari sono un equivalente a prezzi di listino. In modalità di prova le tariffe sono fittizie.

**Limite di spesa**: il limite per esecuzione è applicato sulla stima. Prima di ogni fase la parte rimanente viene divisa tra le fasi attive e passata come `maxBudgetUsd`, insieme all'eventuale limite della fase. Se il limite viene superato, la fase termina con `error_max_budget_usd` e l'esecuzione si mette in pausa.

**Ottimizzazioni**: regole applicate ai dati misurati, cioè fase dominante, modello costoso su compiti semplici, contesto molto superiore alle altre fasi, chiamate identiche ripetute, vicinanza al limite di turni, tentativi dopo errori, cicli di correzione, candidati al riuso, fasi in sola lettura consecutive, cache scritta più che letta e assenza di limite di spesa. Ogni suggerimento indica il compromesso sulla qualità. Nessun "risparmio" viene stimato: l'effetto si verifica con Confronta.

## Autenticazione e costi delle esecuzioni reali

Il SDK usa l'eseguibile Claude Code e le sue credenziali, in quest'ordine:

1. `ANTHROPIC_API_KEY` nell'ambiente con cui avvii Regia: consumo fatturato a token sull'account della chiave.
2. Login di Claude Code (`claude auth status`): con un abbonamento claude.ai il consumo è conteggiato sui limiti del piano.

La documentazione del SDK precisa che i prodotti di terze parti non devono offrire il login claude.ai e devono usare chiavi API. Per uso personale e locale il login funziona, ma verifica le regole della tua organizzazione.

Il dialogo "Esecuzione reale" mostra metodo di autenticazione, modelli, fasi che possono modificare file o eseguire comandi e limite di spesa, e chiede una conferma esplicita. Con `REGIA_DISABLE_REAL=1` le esecuzioni reali sono disattivate.

### Permessi degli agenti

Ogni fase riceve solo gli strumenti selezionati (`tools` e `allowedTools`), con `permissionMode: 'dontAsk'`: tutto ciò che non è consentito viene negato senza chiedere, e i dinieghi compaiono tra le decisioni osservate. `Bash`, `Edit` e `Write` agiscono senza ulteriori conferme nella cartella del progetto: usali solo su progetti di cui hai una copia o un controllo di versione.

Hook, plugin e impostazioni personali di `~/.claude` non vengono caricati; le regole personali di `~/.claude/CLAUDE.md` sì, tramite le regole generali. Il CLAUDE.md e le impostazioni del progetto si caricano solo se attivi l'opzione nel workflow.

## Dati e riservatezza

- Tutto resta in locale in `data/`, che è escluso dal controllo di versione: workflow, esecuzioni, regole di Regia e cache di riuso. La cartella si può spostare con `REGIA_DATA_DIR`.
- Regia non legge né salva credenziali. Dello stato di autenticazione espone solo metodo, provider e tipo di piano, senza email né organizzazione.
- I testi prodotti dagli agenti passano da un filtro che oscura pattern comuni di segreti (chiavi API, token, chiavi private, assegnazioni `*_TOKEN=`/`*_SECRET=`/`PASSWORD=`) prima di essere salvati o mostrati. Il filtro è euristico e non sostituisce l'attenzione a cosa si fa leggere agli agenti.
- Le API rifiutano richieste da origini diverse da localhost.
- Le sessioni del SDK vengono salvate da Claude Code nella sua cartella dei progetti (`~/.claude/projects`), come per qualunque uso della CLI.

## Modalità di prova

"Prova" esegue il workflow con agenti simulati: nessuna chiamata di rete e nessun costo, tariffe fittizie. I messaggi simulati hanno la stessa forma di quelli del SDK (ID duplicati per strumenti in parallelo, subagenti, sessioni riprese con totali ripristinati, crash con valori azzerati), quindi la contabilità segue lo stesso percorso del codice reale. Nelle istruzioni di una fase si può scrivere `[simula-errore]`, `[simula-blocco]` o `[simula-budget]` per provare gli interventi. La fase Avvio app è simulata e nessun comando viene eseguito.

## Lingue

Interfaccia, messaggi di Regia e istruzioni inviate agli agenti sono tradotti tramite file JSON, senza toccare il codice.

- **Traduzioni**: `locales/<lingua>/*.json` (es. `locales/it/`, `locales/en/`). Ogni cartella contiene `_meta.json` con nome e locale (`{"name": "Italiano", "locale": "it-IT"}`) e uno o più file con chiavi annidate; i file di una lingua vengono uniti. Parametri tra graffe (`{count} fasi`), plurali come oggetti (`{"one": "{count} fase", "other": "{count} fasi"}`). Le chiavi mancanti usano l'inglese, poi l'italiano.
- **Preset**: `templates/<lingua>/*.json`, stessi nomi di file per tutte le lingue; un preset non tradotto usa la versione inglese, poi quella italiana.
- **Lingua dell'interfaccia**: scelta dal menu con l'icona delle lingue in alto a destra (ricordata nel browser); all'inizio segue la lingua del browser.
- **Lingua degli agenti**: impostazione di ogni workflow ("Lingua degli agenti"). Determina la lingua del protocollo di risposta, delle regole e dei titoli del prompt inviati agli agenti; i nuovi workflow usano la lingua dell'interfaccia.
- I messaggi generati da Regia (validazione, eventi, interventi, suggerimenti) viaggiano come chiave e parametri e vengono tradotti nella lingua di chi li guarda; il testo prodotto dagli agenti resta come lo scrivono.

**Aggiungere una lingua**: copia `locales/en/` in `locales/<codice>/`, aggiorna `_meta.json` e traduci i valori (non le chiavi). Facoltativamente traduci i preset in `templates/<codice>/`. I file vengono riletti a ogni richiesta: basta ricaricare la pagina. `npm run i18n:check` elenca le chiavi mancanti o in più per ogni lingua.

## Variabili d'ambiente

| Variabile | Effetto |
|---|---|
| `PORT` | Porta del server (predefinita 4317; ascolta solo su 127.0.0.1) |
| `REGIA_DATA_DIR` | Cartella dei dati locali (predefinita `data/`) |
| `REGIA_GLOBAL_RULES` | File delle regole personali (predefinito `~/.claude/CLAUDE.md`) |
| `REGIA_SKILLS_DIR` | Cartella delle skill personali (predefinita `~/.claude/skills`) |
| `REGIA_DISABLE_REAL=1` | Disattiva le esecuzioni reali |
| `REGIA_LANG` | Lingua predefinita del server (es. per le regole di Regia iniziali); altrimenti quella del sistema |
| `REGIA_MOCK_SPEED` | Millisecondi per passo nella modalità di prova (predefinito 600) |
| `ANTHROPIC_API_KEY` | Se presente, le esecuzioni reali usano la chiave API invece del login |

## Struttura

```
server/            API Express + SSE, motore di esecuzione, contabilità, simulatore, suggerimenti
  engine.ts        grafo delle fasi, parallelismo, budget, interventi, riprese, riuso
  usage.ts         regole di conteggio (dedup, subagenti, riprese, crash)
  mockQuery.ts     modalità di prova
  insights.ts      suggerimenti di ottimizzazione
  validate.ts      validazione del diagramma
  rules.ts         regole generali (personali, di Regia, del progetto)
  folder.ts        controllo della cartella di progetto (git, modifiche in sospeso)
  service.ts       processi della fase Avvio app (avvio, indirizzo, raggiungibilità, arresto)
  nodeenv.ts       versione di Node richiesta dal progetto, installazioni, diagnosi degli errori
  skills.ts        ricerca delle skill e plugin temporaneo per fase
shared/types.ts    modello dati comune
web/src/           interfaccia React + React Flow
templates/         preset di partenza (JSON)
```

## Limiti noti

- La qualità del risultato è valutata solo con segnali osservabili: esiti dichiarati, approvazioni, tentativi e stato finale. Regia non valuta il contenuto.
- Le decisioni dichiarate dipendono dal rispetto del protocollo di risposta da parte dell'agente. Se manca il blocco di esito, la fase usa il testo finale e lo segnala.
- Con più fasi in parallelo il limite di spesa per esecuzione è ripartito in anticipo, quindi la somma può superarlo di poco se una fase usa meno della sua quota e un'altra di più.
- Dopo un rifiuto vengono rieseguite solo le fasi tra quella corretta e l'approvazione (comprese eventuali approvazioni intermedie, che vengono richieste di nuovo). Le altre fasi a valle già completate non vengono rieseguite.
- "Continua" riprende una fase solo se identica e completata; una fase saltata o fallita viene eseguita. La ripresa della sessione originale richiede che Claude Code abbia ancora la sessione salvata (`~/.claude/projects`).
- Il riuso confronta configurazione, input e un'impronta dei file del progetto (percorso, dimensione, data di modifica). Non rileva cambiamenti esterni alla cartella.
- Un'esecuzione attiva non sopravvive al riavvio del server: viene marcata come interrotta.
- I contatori live dei subagenti non sono mostrati durante la fase: i loro consumi arrivano con il result.
