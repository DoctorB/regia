# Manuale di Regia

*[Read in English](manual.md)*

Regia fa lavorare agenti AI su un tuo progetto seguendo un percorso che disegni tu: analisi, implementazione, test, revisione, anteprima nel browser, approvazione, pubblicazione. Mentre lavorano, vedi sul diagramma cosa stanno facendo, cosa decidono, quanto consumano, e intervieni quando serve.

Le immagini di questo manuale sono prese in **modalità di prova**: agenti simulati, nessun costo.

L'interfaccia è disponibile in italiano e in inglese: si cambia dal menu delle lingue in alto a destra. Ogni workflow ha anche una **lingua degli agenti** (Impostazioni → Esecuzione), che decide la lingua delle istruzioni inviate agli agenti.

---

## 1. Avvio

Una volta sola:

```bash
git clone https://github.com/DoctorB/regia.git
cd regia
npm install
```

Ogni volta:

```bash
npm start
```

Apri **http://127.0.0.1:4317** e lascia aperto il terminale finché usi Regia. Chiudendolo si fermano anche le esecuzioni in corso.

**Requisiti**: Node.js 20 o superiore. Per le esecuzioni reali serve [Claude Code](https://docs.claude.com/en/docs/claude-code) con un login attivo (verifica con `claude auth status`), oppure la variabile `ANTHROPIC_API_KEY`. Non serve aprire Claude Code: Regia usa le sue credenziali.

---

## 2. Crea un workflow

![Nuovo workflow](img/01-nuovo-workflow.png)

1. Al primo avvio compare la schermata di benvenuto; in seguito apri il menu con il nome del workflow in alto a sinistra → **Nuovo workflow…**. Scegli un preset: *Correggi un bug*, *Nuova funzionalità*, *Revisione del codice* (sola lettura), *Aggiungi test*, *Refactoring sicuro* o *Vuoto*.
2. Indica la **cartella del progetto**. Regia controlla se è un repository git e se ci sono modifiche non salvate.
   > Prima di un'esecuzione reale fai **commit o stash** delle tue modifiche: così potrai rivedere il lavoro degli agenti con `git diff` e annullarlo con `git checkout .`.
3. Scrivi l'**obiettivo**: cosa va fatto e quando è finito. Più è preciso, meno passaggi servono.

---

## 3. Personalizza le fasi

![Editor](img/02-editor.png)

- **Aggiungi** fasi dalla palette a sinistra: trascinale sul diagramma, oppure fai clic. Se una fase è selezionata, la nuova viene collegata subito dopo. **Riordina** dispone il diagramma dall'alto verso il basso.
- **Collega** due fasi trascinando dal punto in basso di una al punto in alto dell'altra; seleziona un collegamento o una fase e premi **Canc** per eliminarli.
- **Configura** la fase selezionata nel pannello a destra:
  - *Istruzioni*: cosa deve fare, idealmente con i file da guardare.
  - *Modello*: Haiku ($) per compiti semplici (test, controlli), Sonnet ($$) come scelta equilibrata, Opus ($$$) per i compiti più difficili.
  - *Strumenti*: attiva solo quelli necessari. Quelli con la matita modificano file o eseguono comandi.
  - *Turni massimi* e *Spesa massima*: tetti di sicurezza.
- Senza fasi selezionate il pannello mostra le **impostazioni del workflow**: cartella, obiettivo, limite di spesa per esecuzione, fasi in parallelo, regole.
- L'indicatore in alto dice se il workflow è **Valido**: cliccalo per vedere errori e avvisi e andare alla fase interessata. Gli errori bloccano l'avvio. **Salva** compare quando ci sono modifiche (anche `Ctrl+S`).

### Tipi di fase

| Fase | A cosa serve |
|---|---|
| Analisi, Implementazione, Test, Revisione, Personalizzata | Lavoro svolto da un agente |
| **Approvazione umana** | Il workflow si ferma finché non approvi o respingi |
| **Server locale** | Regia avvia il server di sviluppo (es. `npm run dev`) per farti vedere il risultato nel browser |
| **Pubblicazione** (fase pronta) | Commit, push ed eventuali pubblicazioni o GitHub Actions. Mettila dopo un'approvazione |

---

## 4. Prova, poi esegui

- **Prova**: esegue tutto con agenti simulati. Serve a controllare il percorso e le interazioni, gratis.
- **Esegui**: esecuzione reale. Mostra un riepilogo (autenticazione, modelli, fasi che possono modificare file, comandi locali, limite di spesa) e parte solo dopo la tua conferma.

![Esecuzione](img/03-esecuzione.png)

Sul diagramma ogni fase mostra lo stato (in attesa, attiva, completata, fallita, bloccata, in attesa di te), cosa sta facendo e l'ultima decisione dichiarata; **Segui fase attiva** tiene inquadrata la fase in corso. In alto nel pannello trovi costo e limite di spesa, fasi completate e una barra di avanzamento (clicca un segmento per selezionare la fase). **Annulla** ferma tutto.

---

## 5. Intervieni quando serve

![Approvazione](img/04-approvazione.png)

Quando il workflow si ferma, la scheda **Stato** mostra cosa serve:

- **Approvazione**: leggi le sintesi delle fasi precedenti e controlla il progetto (`git diff`), poi **Approva** oppure **Respingi con commento**: la fase che ha prodotto il lavoro riprende da dove era con il tuo commento, e test e revisione vengono rifatti.
- **Fase fallita o bloccata**: **Riprova da capo**, **Riprendi la sessione** (con un messaggio per l'agente), **Salta la fase** o **Annulla esecuzione**.

### Anteprima nel browser

![Anteprima locale](img/05-anteprima-locale.png)

La fase **Server locale** avvia il server del progetto e mette il link nella richiesta di approvazione: aprilo, verifica, poi approva. Ferma e riavvia sono a portata di clic. Regia sceglie da sola la versione di Node richiesta dal progetto (`.nvmrc`, `engines`), installa le dipendenze se mancano e, se manca la versione di Node giusta, ti propone di installarla. Il server viene chiuso a fine esecuzione.

---

## 6. Capire cosa è successo

Il pannello di un'esecuzione ha cinque schede:

| Scheda | Cosa trovi |
|---|---|
| **Stato** | Interventi richiesti, server attivi, regole applicate, riepilogo delle fasi |
| **Eventi** | Tutto quello che succede, filtrabile per tipo; clicca una fase sul diagramma per vedere solo i suoi |
| **Decisioni** | Spiegazioni brevi scritte dagli agenti (*dichiarate*) o dedotte dalle loro azioni (*osservate*). Il ragionamento interno dei modelli non viene mostrato |
| **Consumi** | Token, cache e costo stimato per fase, agente e modello |
| **Ottimizza** | Dove si concentra la spesa e cosa provare, ognuno con il possibile compromesso sulla qualità |

![Decisioni](img/06-decisioni.png)

![Consumi](img/07-consumi.png)

![Ottimizzazioni](img/08-ottimizzazioni.png)

> **I costi sono stime** calcolate dal SDK a prezzi di listino. Con una chiave API il costo reale è nella Console; con un abbonamento claude.ai il consumo rientra nei limiti del piano.

---

## 7. Migliorare: confronta due esecuzioni

![Confronto](img/09-confronto.png)

Cambia qualcosa (ad esempio un modello più economico per la revisione), riesegui e apri **Confronta**: vedi le differenze misurate di costo, token, tempi ed esiti, e cosa è cambiato nella configurazione. Una sola coppia di esecuzioni non basta a concludere: gli agenti non sono deterministici.

---

## 8. Aggiungere fasi a un lavoro già fatto: Continua

![Continua](img/10-continua.png)

Hai completato un'esecuzione e ti accorgi che mancava qualcosa, ad esempio anteprima, approvazione e pubblicazione?

1. Aggiungi le fasi nell'editor e **salva**.
2. Vai su **Esecuzione** e scegli l'esecuzione completata dal menu in cima al pannello.
3. **Continua…**: le fasi già fatte e non modificate vengono riprese con i loro risultati, senza rifarle; vengono eseguite solo quelle nuove o cambiate. Il riepilogo prima dell'avvio ti dice quali e perché.

---

## 9. Regole generali

![Regole](img/11-regole.png)

Il pulsante **Regole** mostra le regole aggiunte alle istruzioni di ogni agente:

- le tue **regole personali** (`~/.claude/CLAUDE.md`), lette e mai modificate;
- le **regole di Regia**, modificabili qui (di base: niente commit o push se la fase non lo chiede, niente modifiche fuori dal progetto, niente file con credenziali);
- il **CLAUDE.md del progetto**, se attivi l'opzione nel workflow.

Ogni esecuzione salva le regole che ha usato.

### Skill

Le fasi con un agente possono usare le **skill** di Claude Code: procedure scritte in un file `SKILL.md` (ad esempio "pubblica un articolo del blog" o "controllo SEO prima del rilascio").

- **Dove le cerca Regia**: nella cartella `.claude/skills/` del progetto (attiva di serie) e tra le tue skill personali in `~/.claude/skills/`, comprese le sottocartelle (da attivare nelle impostazioni del workflow, sezione **Skill**).
- **Per ogni fase**, sezione **Skill**: *Nessuna* (predefinito), *Tutte* quelle delle fonti attive, oppure *Scelte* da un elenco con nome, descrizione e provenienza. Il riquadro della fase sul diagramma indica quante skill ha.
- **In esecuzione** l'agente carica una skill solo quando gli serve; negli eventi vedi le skill disponibili, quale ha usato e la decisione "Ha usato la skill …". Le istruzioni della skill consumano token come il resto del contesto.
- Se una skill scelta non si trova più, la validazione lo segnala e la fase prosegue senza.

---

## 10. Organizzare i workflow, tema e lingua

- **Gruppi**: ogni workflow può stare in un gruppo, ad esempio il progetto. Alla creazione il gruppo proposto è il nome della cartella del progetto; si cambia anche dalle impostazioni del workflow. Il menu con il nome del workflow, in alto a sinistra, mostra i workflow per gruppo e ha una ricerca (Invio apre il primo risultato).
- **Gestisci workflow…** (dallo stesso menu): ricerca, gruppi comprimibili, e per ogni workflow apri, rinomina, sposta in un gruppo, duplica, elimina. Con le caselle puoi spostare o eliminare più workflow insieme. Un gruppo si rinomina o si toglie (i suoi workflow restano, senza gruppo). Eliminando un workflow le sue esecuzioni restano, a meno di scegliere di eliminarle; quelle ancora in corso non vengono mai toccate.
- **Tema**: pulsante in alto a destra, Come il sistema / Chiaro / Scuro. **Lingua**: il pulsante accanto. Entrambe le scelte vengono ricordate.

## 11. Problemi comuni

| Problema | Cosa fare |
|---|---|
| "Esegui" disattivato | Il workflow ha errori (badge in alto) |
| Nessun login rilevato | Esegui `claude` una volta e accedi, oppure imposta `ANTHROPIC_API_KEY` prima di `npm start` |
| Il server locale non parte | Leggi il motivo nella richiesta di intervento: versione di Node, dipendenze, porta occupata. Usa i pulsanti proposti oppure correggi il comando nella fase |
| L'esecuzione risulta "interrotta" | Regia è stato chiuso mentre era attiva: aprila e usa **Continua…** |
| La spesa è vicina al limite | Alza il limite nelle impostazioni del workflow o guarda la scheda Ottimizza |

Per dettagli su conteggio dei consumi, permessi, dati salvati e limiti noti: [dettagli tecnici](dettagli-tecnici.md).
