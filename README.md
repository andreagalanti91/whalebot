# Whale Desk v13

- `worker.js` — Worker Cloudflare `whale-desk`: cron ogni minuto, alert Telegram, segnali combinati, copy virtuale. Stato in KV, chiave `s13`.
- `dashboard/index.html` — dashboard: 3 wallet, posizioni, ordini in attesa, tabella dei trade, backtest del copy, struttura di mercato. Legge direttamente da Hyperliquid, tema chiaro/scuro.
- `dashboard/analisi.js` — motore di analisi tecnica multi-timeframe (vedi sotto). Modulo puro, lo usano sia la dashboard sia il Worker: stessi calcoli, stessi risultati.
- `_v12/`, `_v13/` — versioni precedenti.

## Deploy

```bash
npx wrangler deploy
```

Segreti già presenti: `TG_TOKEN`, `TG_CHAT`, `ADMIN_KEY`. Dopo il deploy:

- `/test?key=…` manda un messaggio di prova su Telegram
- `/check?key=…` esegue un ciclo a mano
- `/state` è ciò che legge la dashboard
- `/analisi?coin=LINK` restituisce l'analisi in JSON (anche `coin=BTC,ETH` o `watchlist=1`); con `&tg=1&key=…` la manda su Telegram

Primo avvio: il Worker registra lo stato senza mandare alert, e per ~15 minuti (il tempo di scansionare tutti i DEX HIP-3) registra consenso/conflitto in silenzio.

Dashboard pubblica: https://whalebot.pages.dev (Cloudflare Pages, progetto `whalebot`). Worker: https://whale-desk.square-shape-0876.workers.dev

## Limiti del piano free di Workers

- 50 subrequest per invocazione: i DEX HIP-3 si interrogano quando un wallet ci ha posizioni o fill, più una rotazione di 5 coppie wallet×DEX al minuto (giro completo ogni ~13 minuti).
- 1.000 scritture KV al giorno: si scrive solo su eventi, segnali, campioni orari, più un rinfresco ogni 10 minuti.

## Analisi tecnica multi-timeframe

Tab **Struttura** in dashboard e route `/analisi` nel Worker. Per ogni coin (anche HIP-3, scritta `dex:COIN`) si scaricano le candele di 15m, 1h, 4h, 1d e 1w e per ciascun timeframe si calcolano:

- **Struttura su due gradi**: swing (massimi e minimi confermati da 10 candele per lato, 6 sul settimanale) e interna (3 per lato, 2 sul settimanale). Swing etichettati HH, HL, LH, LL.
- **Rotture in chiusura**: BOS se nella direzione del trend, CHoCH se lo invertono. A ogni rottura si registra il livello protetto (il minimo o massimo da cui è partita la spinta): è l'invalidazione.
- **Fase**: swing e interna insieme danno rialzista, ribassista, correzione in uptrend o rimbalzo in downtrend.
- **Fibonacci dell'ultimo impulso swing**: dal livello protetto all'estremo successivo, con la posizione del prezzo (es. 0,75) e la zona: leggero, sano (0,5), OTE 0,62–0,79, ultima difesa, invalidato.
- **RSI** con divergenze sugli ultimi due swing interni, **volume** della correzione rispetto all'impulso, **ATR**.

Poi si aggregano i timeframe (pesi: 1w e 1d 3, 4h 2, 1h 1, 15m 0,5):

- **Quadro e bias**: es. "Correzione dentro un trend rialzista" quando i timeframe alti sono rialzisti e quelli bassi ribassisti.
- **Livelli chiave**: swing e Fibonacci di tutti i timeframe fusi in zone; ★ quando la zona è confermata da più fonti o più timeframe.
- **Scenari**: trigger sul 4h, conferma e invalidazione sul daily, obiettivi dai livelli successivi.

Watchlist predefinita: BTC, ETH, SOL, HYPE, LINK (in `analisi.js`); la dashboard aggiunge le coin aperte dal wallet selezionato.

Costo nel Worker: 5 subrequest per coin, quindi la watchlist intera (25 + 5 messaggi) sta nelle 50 del piano free. Nessuna scrittura su KV.

La dashboard importa `analisi.js` come modulo: va servita via HTTP (Cloudflare Pages o un server locale), non aperta come file.
