# Regia — dettagli tecnici

*[Read in English](technical-details.md)*

Approfondimenti per chi vuole sapere come Regia conta i consumi, quali regole applica agli agenti, come gestisce i server locali e quali limiti ha. Per l'uso quotidiano basta il [manuale](manuale.md).

## Avvio app

Fase gestita da Regia, senza agenti e senza costi. Esegue un comando nella cartella del progetto (o in una sottocartella) con la shell di sistema, quindi va bene qualsiasi strumento. Poi attende che l'app sia pronta secondo il criterio scelto:

- **url**: l'indirizzo indicato, oppure il primo indirizzo locale stampato, riceve una risposta HTTP qualsiasi (anche 401 o 500). Il certificato non viene verificato, così funzionano i certificati di sviluppo (IIS Express, `dotnet dev-certs`): è solo un controllo di raggiungibilità. **Senza comando** la fase verifica soltanto un servizio già attivo (IIS, container, ambiente di test) e non lo avvia né lo ferma.
- **output**: una riga dell'output contiene il testo atteso (senza distinzione di maiuscole), oppure corrisponde a `/espressione regolare/`.
- **process**: il programma è ancora aperto dopo qualche secondo. Per queste fasi e per **output** la finestra non viene nascosta. Un lanciatore che termina subito con codice 0 (es. `start app.exe`) è considerato riuscito.
- **exit**: il comando termina con codice 0 entro l'attesa massima (predefinita 600 secondi, 1200 per il telefono, massimo 3600).

Per **exit** e **output**, se allo scadere dell'attesa il comando sta ancora scrivendo output (ad esempio una build Gradle lunga, soprattutto la prima volta) Regia continua ad aspettare: la fase fallisce solo quando il comando resta in silenzio per metà dell'attesa (al massimo 5 minuti), oppure dopo 3600 secondi in tutto. La proroga compare tra gli eventi.

**Sistemi**: su Windows il comando parte con `cmd.exe` e l'app viene chiusa con `taskkill /T`; su macOS e Linux con `/bin/sh` in un gruppo di processi a parte, chiuso con un segnale al gruppo. La fase pronta "App iOS (simulatore)" usa `xcodebuild` e `xcrun simctl`, quindi funziona solo su macOS con Xcode.

Nel diagramma e nella richiesta di approvazione successiva compaiono il link (se c'è), lo stato, le ultime righe di output e i pulsanti Ferma / Riavvia. Solo per i progetti Node (presenza di `package.json`, o versione di Node indicata nella fase) prima dell'avvio la fase prepara anche l'ambiente:

- **Versione di Node**: legge `.nvmrc` / `.node-version` e `engines.node` del package.json (o il campo "Versione di Node" della fase) e sceglie la versione compatibile più recente tra quelle installate (nvm, nvm-windows, fnm, volta, sistema). La usa solo per quel comando, mettendola in testa al PATH: la versione di sistema non cambia. Se nessuna è compatibile non avvia nulla e propone **Installa Node e riprova**, mostrando il comando esatto (es. `nvm install 24.22.2`, versione scelta dall'elenco ufficiale di nodejs.org preferendo le LTS). L'installazione parte solo con il tuo clic.
- **Dipendenze**: se manca `node_modules` le installa con il gestore indicato dal lockfile, senza modificarlo (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `bun install --frozen-lockfile`).

Se l'avvio non riesce, la fase legge l'output e riconosce le cause comuni. Nei progetti Node, per un messaggio "versione di Node non supportata" ricava la versione richiesta e, se è installata, riprova da sola una volta; altrimenti propone di installarla. Per moduli o comandi mancanti propone **Installa le dipendenze e riprova**. Segnala anche porta occupata e permessi insufficienti. Negli altri casi mostra l'output utile a capire perché.

I log scritti in JSON (Astro, Vite e altri quando non sono collegati a un terminale) vengono trasformati in righe leggibili, e dall'output si estrae l'indirizzo tenendo solo caratteri validi in un URL.

L'app viene fermata (insieme ai processi figli) quando l'esecuzione termina o viene annullata, e quando Regia si chiude. Dopo una correzione chiesta in un'approvazione successiva viene riavviato, così si verifica la versione aggiornata; con "Continua" viene sempre riavviato. In modalità di prova è simulata e nessun comando viene eseguito. Prima di un'esecuzione reale il dialogo di conferma elenca i comandi che verranno avviati e gli indirizzi che verranno verificati.

## Collaudo sul telefono

Fase di tipo `collaudo`, in due passi nella stessa fase:

- **Build e installazione**: lo stesso rilevamento di "Mostra sul telefono" (progetto, dispositivo, comando, criterio `exit`). È registrato come tentativo con `step: 'build'`, a costo zero, e non conta tra i tentativi della fase.
- **Collaudo**: un agente (predefiniti Sonnet, Read/Glob/Grep/Bash, 80 turni) riceve nel prompt dispositivo, applicationId, percorso di `adb`, la cartella delle prove e il file del log, con i comandi utili (`uiautomator dump`, `input tap/text/swipe/keyevent`, `screencap`) e le regole: niente modifiche al codice, niente azioni irreversibili, niente pulizia di logcat. Su Windows i percorsi sono passati con `/` e l'agente antepone `MSYS_NO_PATHCONV=1` ai comandi con percorsi del dispositivo.
- **Prove**: `data/uat/<esecuzione>/<fase>/<giro>/`, con gli screenshot e `app-log.txt`. La cartella è passata come `additionalDirectories`; l'interfaccia mostra le miniature dell'ultimo giro e il link al log.
- **Log dell'app** (solo Android, esecuzioni reali): Regia pulisce il buffer (`logcat -c`), segue `logcat -v threadtime *:W` e tiene le righe dei processi dell'app (PID aggiornati ogni 3 secondi con `pidof`), più crash (`FATAL EXCEPTION` con `Process: <app>`) e ANR (`ANR in <app>`). Ogni crash o ANR distinto genera subito un evento e, a fine collaudo, si aggiunge ai punti. Senza applicationId rilevato tiene tutti gli errori del dispositivo.
- **Esito**: il protocollo chiede le anomalie nella chiave `punti` (al massimo 25, per gravità) e gli scenari non automatizzabili in `manuali`. Le anomalie non fanno fallire la fase: arrivano all'approvazione come i punti della revisione. `ko` solo se non si riesce a collaudare.
- **applicationId**: dal Gradle del modulo app (con `applicationIdSuffix` del flavor scelto), da `android/app/build.gradle(.kts)` per Flutter, React Native e Capacitor, da `app.json` per Expo.
- **Schermo dal vivo**: con un dispositivo Android vero e l'opzione attiva (`show.noMirror` assente) Regia copia sul telefono `scrcpy-server` (versione fissata in `scrcpy.ts`, SHA-256 verificato; dalla copia di Regia o scaricato da GitHub in `data/tools/`), apre `adb forward tcp:0 localabstract:scrcpy_<id>` e lo avvia con `app_process` in sola visione, senza audio, flusso H.264 grezzo (`raw_stream=true`, `max_size=1280`, `max_fps=30`, un fotogramma chiave ogni 2 secondi). `GET /api/runs/<id>/mirror/<fase>` inoltra il flusso alle pagine: chi si collega a metà riceve subito SPS, PPS e i fotogrammi dall'ultimo fotogramma chiave. La pagina lo decodifica con WebCodecs (`VideoDecoder`, codec dall'SPS, riconfigurato quando cambia, ad esempio ruotando il telefono) e si ricollega da sola. A fine collaudo, anche annullato o sospeso, Regia chiude il socket, il processo e il forward. Banda tipica: circa 40 KB/s.
- **Finestra separata** (facoltativa, `show.mirrorWindow`): `scrcpy -s <seriale> --no-control --no-audio --window-title 'Regia · <fase>' --max-size 1600` con `ADB` puntato all'adb dell'SDK, chiusa a fine collaudo. Ricerca: copia di Regia (`data/tools/scrcpy-win64-v<versione>/`), PATH, cartelle di Homebrew su macOS. Installazione solo su richiesta (`POST /api/tools/scrcpy/install`): su Windows x64 lo zip ufficiale, verificato con il suo SHA-256 ed estratto con il `tar.exe` di Windows; su macOS `brew install scrcpy`; altrove indicazioni.
- **Limiti**: solo Android; iOS e app desktop non sono ancora supportati. La lettura dello schermo dipende dall'accessibilità dell'app (con viste disegnate a mano l'agente si affida agli screenshot).

## Interventi

- **Approvazione umana**: approva, oppure respingi con un commento. La fase a monte più vicina che può modificare file riprende la propria sessione con il commento; le fasi intermedie (test, revisione) vengono rieseguite e l'approvazione viene richiesta di nuovo. Non c'è un limite ai cicli: decidi tu quando approvare o annullare.
- **Punti della revisione**: alle fasi di tipo *revisione* il protocollo chiede di elencare le modifiche proposte nella chiave `punti` del blocco di esito, in ordine di importanza e al massimo 25, lasciando l'esito `ok`. Se ne arrivano di più, la checklist tiene i primi 25: gli altri sono elencati in un evento della fase e l'approvazione indica quanti sono. Restano nel testo passato alle fasi successive e l'approvazione li mostra come caselle: vengono raccolti dalle fasi che un respingi farebbe rieseguire, anche se non collegate direttamente, più quelle collegate direttamente, dall'ultimo tentativo di ciascuna. Respingendo, i punti scelti (raggruppati per fase) e il commento formano il feedback; serve almeno uno dei due.
- **Fase fallita o bloccata**: l'agente può dichiarare un esito `ko` o `bloccato`. Le scelte sono riprova da capo, riprendi la sessione con un messaggio, salta oppure annulla l'esecuzione.
- **Permesso mancante**: il protocollo chiede all'agente che si ferma per mancanza di strumenti di indicare nel blocco di esito `permesso`: `modifica` o `internet`. Se alla fase mancano davvero gli strumenti di quel livello (`modifica`: Read, Glob, Grep, Edit, Write, Bash; `internet`: in più WebFetch e WebSearch), compare l'azione **Consenti**: gli strumenti mancanti vengono aggiunti, senza toglierne nessuno, alla copia del workflow dell'esecuzione e al workflow salvato, se la fase esiste ancora; la fase riprende la stessa sessione. Gli eventi registrano cosa è stato concesso.
- **Cartella mancante**: allo stesso modo l'agente che si ferma perché deve lavorare fuori dalle cartelle consentite indica `cartella` con un percorso assoluto. Se non è dentro la cartella del progetto né tra le cartelle aggiuntive, compare **Consenti la cartella**: viene aggiunta alle cartelle aggiuntive della copia del workflow dell'esecuzione e del workflow salvato, e la fase riprende la stessa sessione.
- **Domande nell'approvazione**: mentre un'approvazione aspetta si può fare una domanda alle fasi con agente che esamina (quelle che un respingi rifarebbe e quelle collegate direttamente), se sono completate e hanno una sessione. La fase risponde in una copia della sua sessione (`forkSession`), con i soli strumenti Read, Glob e Grep e al massimo 10 turni: la sessione originale e il registro dei tentativi restano invariati. Le domande successive alla stessa fase, nello stesso giro di approvazione, continuano quella copia. Una domanda alla volta; decidendo sull'approvazione, una domanda in corso si interrompe. I consumi delle risposte entrano nei totali dell'esecuzione, non in quelli della fase.
- **Suono**: generato dal browser (Web Audio, nessun file audio) per l'esecuzione aperta nella pagina, quando una fase comincia ad aspettare un intervento e quando l'esecuzione termina (non quando la annulli tu). Con la pagina chiusa non suona. La scelta attivo/disattivo è ricordata nel browser.

## Sospensione e ripresa

- **Sospendi**: le fasi agente in corso vengono fermate e il tentativo risulta "interrotto", con la sessione dell'agente e l'ora dell'ultima attività. Le app della fase Avvio app vengono chiuse e riavviate alla ripresa. Approvazioni e interventi restano in attesa. Tutto è salvato in `data/runs`, quindi la ripresa funziona anche dopo aver chiuso Regia o spento il PC.
- **Chiusura improvvisa**: all'avvio, le esecuzioni rimaste attive diventano "interrotte" e vengono trattate come sospese.
- **Riprendi** prosegue la stessa esecuzione (stesso identificativo, consumi e resoconto). Per ogni fase interrotta:
  - se l'ultima attività è entro la durata della cache del prompt (300 secondi, `REGIA_CACHE_TTL_SEC`), riprende la stessa sessione con l'indicazione di controllare lo stato dei file e completare il compito;
  - altrimenti apre una sessione nuova con il prompt normale della fase più un riassunto: gli ultimi passi e decisioni registrati (fino a 60, anche dei tentativi interrotti precedenti) e l'eventuale correzione che la fase stava applicando;
  - se la sessione non si può più riprendere (ad esempio i dati di Claude Code sono stati rimossi), passa da sola al riassunto.
- **Perché il riassunto**: riprendere una sessione dopo la scadenza della cache rimanda tutta la conversazione e la riscrive in cache. Il riassunto costa meno; in cambio l'agente rilegge i file che gli servono.
- **Git**: ramo e commit del progetto sono registrati alla fine di ogni fase e alla sospensione. Prima di riprendere vengono confrontati con quelli attuali e, se sono diversi, l'interfaccia chiede conferma.
- Un'esecuzione sospesa si può anche annullare senza riprenderla. La durata mostrata comprende il tempo di sospensione.

## User story collegata

- **Indirizzi**: work item di Azure DevOps (`https://dev.azure.com/<org>/<progetto>/_workitems/edit/<id>`, `https://<org>.visualstudio.com/<progetto>/_workitems/edit/<id>`, anche le bacheche con `?workitem=<id>`) e issue di GitHub (`https://github.com/<owner>/<repo>/issues/<n>`). Campo `settings.story` del workflow.
- **Accesso ad Azure DevOps**, nell'ordine: variabile `AZURE_DEVOPS_EXT_PAT`; Git Credential Manager (`git credential fill` per l'host, o per `dev.azure.com` con l'organizzazione nel percorso: se non ha credenziali apre il login Microsoft una volta); la CLI `az` (`az account get-access-token`). Da Git Credential Manager Regia chiede il token OAuth del login Microsoft (`GCM_AZREPOS_CREDENTIALTYPE=oauth`), che vale per le API dei work item; il Personal Access Token che GCM crea per i repository ha solo il permesso sul codice e resta come ultima prova. Dopo la prima lettura riuscita, se l'organizzazione non ha un account associato, Regia la associa a quello del login (`git credential-manager azure-repos bind`), così GCM riusa la sessione senza chiedere di nuovo il login. Il token che ha funzionato resta in memoria fino a 5 minuti prima della scadenza (al massimo un'ora) e non viene mai salvato da Regia. GitHub: `gh api` e `gh auth token` per le immagini.
- **Lettura**: `GET <base>/_apis/wit/workitems/<id>?$expand=relations&api-version=7.1` (titolo, tipo, stato, `System.Description` o i passi di un bug, `Microsoft.VSTS.Common.AcceptanceCriteria`, allegati) e gli ultimi 10 commenti. L'HTML diventa testo semplice; ogni immagine diventa un segnaposto `[immagine n: nome]` al suo posto. Testo al massimo 20.000 caratteri per sezione, passato dal filtro dei segreti.
- **Immagini**: quelle nel testo e gli allegati immagine, al massimo 10 e 5 MB l'una, scaricate con lo stesso accesso (solo dalla stessa organizzazione) in `data/stories/<lettura>/`. La cartella è passata agli agenti come `additionalDirectories`, con l'elenco dei file e l'indicazione di aprirli solo se servono.
- **Quando**: con **Leggi** nell'editor (anteprima in `data/stories/preview/`) e a ogni avvio di un'esecuzione, la cui copia resta nell'esecuzione (`run.story`). Se la lettura non riesce l'esecuzione parte lo stesso, con un avviso negli eventi. Il resoconto riporta link e titolo.
- **Prompt**: dopo l'obiettivo, la sezione "User story collegata" con descrizione, criteri di accettazione, commenti e immagini.

## Esecuzione di riferimento

Con l'impostazione **Esecuzione di riferimento** (attiva nel preset Allineamento e verifica) all'avvio si sceglie un'esecuzione di un altro workflow. Il suo resoconto, in versione compatta (obiettivo, risultati, decisioni dichiarate, file modificati, interventi, senza costi né tempi, al massimo 12.000 caratteri), viene fotografato nell'esecuzione e aggiunto al prompt di ogni fase agente, dopo l'obiettivo. Resta lo stesso anche se l'esecuzione di riferimento viene poi eliminata, e una continuazione lo mantiene. Entra nella chiave del riuso dei risultati: con un riferimento diverso le fasi non vengono riusate.

## Regole generali

Il pulsante **Regole** mostra le regole aggiunte alle istruzioni di ogni fase (opzione "Applica le regole generali" del workflow, attiva di base). Prevalgono sulle istruzioni della fase.

- **Regole personali**: `~/.claude/CLAUDE.md`, lette a ogni esecuzione, mai modificate da Regia. Servono perché hook, plugin e impostazioni personali di `~/.claude` non vengono caricati negli agenti.
- **Regole di Regia**: testo modificabile, salvato in `data/regole.md`. Di base: niente commit o push salvo richiesta esplicita della fase, niente modifiche fuori dalla cartella del progetto e dalle cartelle aggiuntive, niente lettura di file con credenziali se non indispensabile.
- **CLAUDE.md del progetto**: caricato dalla CLI se è attiva l'opzione del workflow; il pannello lo mostra in sola lettura.

Ogni esecuzione salva le regole che ha usato: le trovi nella scheda Stato ("Regole applicate") e nel registro eventi. Il percorso del file di regole personali si può cambiare con `REGIA_GLOBAL_RULES`.

## Skill

- **Ricerca**: `<progetto>/.claude/skills/<nome>/SKILL.md`, `<progetto>/.agents/skills` (la cartella condivisa da altri strumenti come Codex, Junie e Copilot) e `~/.claude/skills` (fino a 4 livelli di sottocartelle). Nome e descrizione dal frontmatter, anche su più righe (`|`, `>`); senza frontmatter il nome è quello della cartella. Le skill personali sono escluse finché non si attivano nel workflow.
- **Esecuzione**: per ogni tentativo Regia copia le sole skill scelte in un plugin locale temporaneo (`data/skill-bundles/`, chiamato `regia-skills`) e lo passa al SDK con le opzioni `plugins` e `skills`, aggiungendo lo strumento `Skill` solo a quella fase. I file originali non vengono modificati e, con le impostazioni del progetto spente, non si caricano impostazioni, hook o plugin personali. Il plugin viene rimosso a fine fase (e all'avvio di Regia, se ne restano).
- **Nomi**: nel plugin ogni skill prende il nome della propria cartella in minuscolo (`Revisione Testi` → `revisione-testi`); due skill con lo stesso nome, una del progetto e una personale, restano distinte con un suffisso.
- **Riuso dei risultati**: le skill scelte fanno parte della chiave di riuso.
- **Modalità di prova**: la prima skill disponibile viene "usata" in modo simulato, così eventi e decisioni si vedono senza costi.

## Decisioni mostrate

- **Dichiarate**: righe `DECISIONE: …` che l'agente scrive su richiesta del protocollo di risposta, più l'elenco `decisioni` del blocco di esito finale. I `punti` delle revisioni non sono decisioni: compaiono nell'approvazione.
- **Osservate**: dedotte da eventi visibili, cioè file modificati, comandi eseguiti, skill usate, subagenti avviati e strumenti negati.

I blocchi di ragionamento interno (thinking) non vengono mai mostrati né salvati.

## Resoconto

Generato nel browser dai dati dell'esecuzione, nella lingua dell'interfaccia; non viene salvato in `data/`. Riporta solo le decisioni dichiarate. I **file modificati** sono quelli toccati dagli strumenti `Edit`, `Write` e `NotebookEdit`, con il percorso relativo alla cartella del progetto: i file cambiati da comandi `Bash` (generatori, formattatori, `git`) non compaiono, quindi per l'elenco completo resta `git diff`. Le fasi riprese da un'esecuzione precedente indicano da quale, senza durata né costo.

## Consumi

Fonte: messaggio `result` di ogni chiamata `query()`.

- **Totali per fase**: da `modelUsage` e `total_cost_usd`. Includono i subagenti e il dettaglio per modello: input, output, scrittura e lettura della cache, costo e listino usato.
- **Contatori live durante la fase**: input e cache dai messaggi `assistant`, deduplicati per `message.id`. Sono solo indicativi, perché `output_tokens` sui singoli messaggi è un segnaposto.
- **Sessioni riprese** ("Riprendi" e correzioni da approvazione): il result riporta anche la spesa precedente della sessione, quindi Regia registra solo la differenza rispetto ai totali già contati. Se la CLI non ha ripristinato i totali, non sottrae nulla.
- **Crash**: il result di errore può avere valori azzerati. In quel caso restano i contatori live (input e cache del ciclo principale) e il costo è segnato come non noto.
- **Per agente**: aggregato per ruolo.

**Stime, non fatturazione.** `total_cost_usd` e `costUSD` sono calcolati localmente dal SDK con il listino incluso nella sua versione. Con una chiave API il costo effettivo si legge nella Console. Con il login claude.ai il consumo rientra nei limiti del piano (o nei crediti extra, se attivi) e i dollari sono un equivalente a prezzi di listino. In modalità di prova le tariffe sono fittizie.

**Ottimizzazioni**: regole applicate ai dati misurati, cioè fase dominante, modello costoso su compiti semplici, contesto molto superiore alle altre fasi, chiamate identiche ripetute, vicinanza al limite di turni, tentativi dopo errori, cicli di correzione, candidati al riuso, fasi in sola lettura consecutive, cache scritta più che letta. Ogni suggerimento indica il compromesso sulla qualità. Nessun "risparmio" viene stimato: l'effetto si verifica con Confronta.

## Autenticazione e costi delle esecuzioni reali

Il SDK usa l'eseguibile Claude Code e le sue credenziali, in quest'ordine:

1. `ANTHROPIC_API_KEY` nell'ambiente con cui avvii Regia: consumo fatturato a token sull'account della chiave.
2. Login di Claude Code (`claude auth status`): con un abbonamento claude.ai il consumo è conteggiato sui limiti del piano.

La documentazione del SDK precisa che i prodotti di terze parti non devono offrire il login claude.ai e devono usare chiavi API. Per uso personale e locale il login funziona, ma verifica le regole della tua organizzazione.

Il dialogo "Esecuzione reale" mostra metodo di autenticazione, modelli, fasi che possono modificare file o eseguire comandi, e chiede una conferma esplicita. Con `REGIA_DISABLE_REAL=1` le esecuzioni reali sono disattivate.

### Permessi degli agenti

Ogni fase riceve solo gli strumenti selezionati (`tools` e `allowedTools`), con `permissionMode: 'dontAsk'`: tutto ciò che non è consentito viene negato senza chiedere, e i dinieghi compaiono tra le decisioni osservate. `Bash`, `Edit` e `Write` agiscono senza ulteriori conferme nella cartella del progetto: usali solo su progetti di cui hai una copia o un controllo di versione. Le **cartelle aggiuntive** del workflow (percorsi assoluti) vengono passate come `additionalDirectories`: senza, Claude Code nega le scritture fuori dalla cartella del progetto. Concedendo una cartella che non esiste ancora, Regia la crea; a Claude Code vanno solo quelle esistenti. Sono elencate anche nel prompt di sistema e negli eventi di avvio, ed entrano nella chiave di riuso dei risultati. Le regole predefinite salvate prima della 0.7.0 vengono aggiornate all'avvio, solo se la riga sulle modifiche fuori dal progetto è ancora quella originale.

Hook, plugin e impostazioni personali di `~/.claude` non vengono caricati; le regole personali di `~/.claude/CLAUDE.md` sì, tramite le regole generali. Il CLAUDE.md e le impostazioni del progetto si caricano solo se attivi l'opzione nel workflow.

## Dati e riservatezza

- **Segnalazioni di errore** (solo con il consenso, chiesto al primo avvio; `REGIA_REPORTS=0` le disattiva): `server/reports.ts` registra gli errori di Regia (nelle esecuzioni reali `events.phaseFailed`, `events.service.startFailed`, `events.uat.mirrorFailed`, `events.skillsBundleFailed`, `events.questionFailed`; errori 500 delle API; eccezioni non gestite; errori dell'interfaccia, al massimo 5 per sessione). Il testo passa dal filtro dei segreti e poi viene anonimizzato (cartelle dei progetti e aggiuntive dei workflow → `<progetto>`, dati → `<dati>`, cartella utente → `~`, nome utente → `<utente>`, email → `<email>`). Copia locale in `data/reports/` (ultime 100), invio in JSON a `POST https://trace.lucabottani.dev/api/regia/report` (Worker Cloudflare con KV: 180 giorni, nessun IP salvato, 5 invii al minuto); senza rete si riprova all'avvio e ogni 10 minuti; lo stesso errore (chiave e testo senza numeri) non si rimanda prima di 24 ore. `npm run reports` scarica le segnalazioni in `local/reports/` per chi ha il token dell'area admin.
- Tutto resta in locale in `data/`, che è escluso dal controllo di versione: workflow, esecuzioni, regole di Regia, cache di riuso e prove dei collaudi (screenshot e log dell'app, che possono contenere i dati mostrati dall'app, ad esempio quelli dell'account collegato). La cartella si può spostare con `REGIA_DATA_DIR`.
- Regia non salva credenziali. L'unica che legge, solo se il workflow ha una user story di Azure DevOps, è l'accesso temporaneo che Git Credential Manager (o `AZURE_DEVOPS_EXT_PAT`, o `az`) fornisce per leggerla: resta in memoria il tempo della lettura. Dello stato di autenticazione espone solo metodo, provider e tipo di piano, senza email né organizzazione.
- I testi prodotti dagli agenti passano da un filtro che oscura pattern comuni di segreti (chiavi API, token, chiavi private, assegnazioni `*_TOKEN=`/`*_SECRET=`/`PASSWORD=`) prima di essere salvati o mostrati. Il filtro è euristico e non sostituisce l'attenzione a cosa si fa leggere agli agenti.
- Le API rifiutano richieste da origini diverse da localhost.
- Le sessioni del SDK vengono salvate da Claude Code nella sua cartella dei progetti (`~/.claude/projects`), come per qualunque uso della CLI.

## Modalità di prova

"Prova" esegue il workflow con agenti simulati: nessuna chiamata di rete e nessun costo, tariffe fittizie. I messaggi simulati hanno la stessa forma di quelli del SDK (ID duplicati per strumenti in parallelo, subagenti, sessioni riprese con totali ripristinati, crash con valori azzerati), quindi la contabilità segue lo stesso percorso del codice reale. Nelle istruzioni di una fase si può scrivere `[simula-errore]` o `[simula-blocco]` per provare gli interventi, `[simula-permesso]` (una fase che può solo leggere chiede di modificare il progetto) o `[simula-cartella]` (la fase chiede una cartella accanto al progetto) per provare le concessioni con un clic, `[simula-molti-punti]` per una revisione con più punti del limite. La fase Avvio app è simulata e nessun comando viene eseguito; il Collaudo simula build e installazione, poi un collaudo con due anomalie e uno scenario da provare a mano.

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
| `AZURE_DEVOPS_EXT_PAT` | Token per leggere le user story di Azure DevOps senza Git Credential Manager (facoltativo) |
| `REGIA_REPORTS=0` | Disattiva le segnalazioni di errore, anche con il consenso |
| `REGIA_REPORTS_URL` | Indirizzo a cui inviare le segnalazioni (predefinito `https://trace.lucabottani.dev/api/regia/report`) |
| `REGIA_UPDATE_CHECK=0` | Disattiva il controllo di nuove versioni su GitHub (la versione in uso resta visibile accanto al nome) |
| `REGIA_LANG` | Lingua predefinita del server (es. per le regole di Regia iniziali); altrimenti quella del sistema |
| `REGIA_CACHE_TTL_SEC` | Durata della cache del prompt usata per decidere come riprendere una fase interrotta (predefinita 300 secondi) |
| `REGIA_MOCK_SPEED` | Millisecondi per passo nella modalità di prova (predefinito 600) |
| `ANTHROPIC_API_KEY` | Se presente, le esecuzioni reali usano la chiave API invece del login |

## Struttura

```
server/            API Express + SSE, motore di esecuzione, contabilità, simulatore, suggerimenti
  engine.ts        grafo delle fasi, parallelismo, interventi, riprese, riuso
  usage.ts         regole di conteggio (dedup, subagenti, riprese, crash)
  mockQuery.ts     modalità di prova
  insights.ts      suggerimenti di ottimizzazione
  validate.ts      validazione del diagramma
  rules.ts         regole generali (personali, di Regia, del progetto)
  folder.ts        controllo della cartella di progetto (git, modifiche in sospeso)
  resume.ts        sospensione e ripresa: stato riprendibile, riassunto del lavoro interrotto
  service.ts       processi della fase Avvio app (avvio, indirizzo, raggiungibilità, arresto)
  launch.ts        fasi "mostra" (telefono, browser, desktop): riconoscimento del progetto, comando, apertura del browser
  mobile.ts        telefono: progetto mobile, dispositivi collegati, comando di build e installazione (Gradle con `.\gradlew.bat` su Windows e variante dei product flavor)
  uat.ts           collaudo: log dell'app da logcat, crash e ANR
  scrcpy.ts        finestra separata del collaudo: ricerca, installazione verificata, avvio di scrcpy
  story.ts         user story collegata: Azure DevOps e GitHub, testo, immagini
  reports.ts       segnalazioni di errore: consenso, anonimizzazione, coda locale, invio
  mirror.ts        schermo dal vivo nella pagina: server di scrcpy sul telefono, flusso H.264 inoltrato alle pagine
  nodeenv.ts       versione di Node richiesta dal progetto, installazioni, diagnosi degli errori
  skills.ts        ricerca delle skill e plugin temporaneo per fase
  version.ts       versione in uso e controllo di quella pubblicata su GitHub
shared/types.ts    modello dati comune
shared/principles.ts principi di progettazione (testi in locales/<lingua>/principles.json)
shared/report.ts   resoconto dell'esecuzione in Markdown
web/src/           interfaccia React + React Flow
templates/         preset di partenza (JSON)
```

## Limiti noti

- La qualità del risultato è valutata solo con segnali osservabili: esiti dichiarati, approvazioni, tentativi e stato finale. Regia non valuta il contenuto.
- Le decisioni dichiarate dipendono dal rispetto del protocollo di risposta da parte dell'agente. Se manca il blocco di esito, la fase usa il testo finale e lo segnala.
- Dopo un rifiuto vengono rieseguite solo le fasi tra quella corretta e l'approvazione (comprese eventuali approvazioni intermedie, che vengono richieste di nuovo). Le altre fasi a valle già completate non vengono rieseguite.
- "Continua" riprende una fase solo se identica e completata; una fase saltata o fallita viene eseguita. La ripresa della sessione originale richiede che Claude Code abbia ancora la sessione salvata (`~/.claude/projects`).
- Il riuso confronta configurazione, input e un'impronta dei file del progetto (percorso, dimensione, data di modifica). Non rileva cambiamenti esterni alla cartella.
- Un'esecuzione non prosegue mentre Regia è chiuso: risulta interrotta e si riprende con Riprendi. Della fase interrotta resta ciò che era già registrato (passi, decisioni, file modificati); il consumo del tentativo interrotto è parziale e il suo costo non è noto.
- La durata reale della cache del prompt dipende dall'account (di norma 5 minuti, in alcuni casi 1 ora) e Regia non la può leggere: usa 5 minuti, modificabili con `REGIA_CACHE_TTL_SEC`.
- I contatori live dei subagenti non sono mostrati durante la fase: i loro consumi arrivano con il result. Contano come subagenti solo i task di tipo `local_agent`: i comandi Bash lunghi, che Claude Code segnala anch'essi come task, restano comandi.
