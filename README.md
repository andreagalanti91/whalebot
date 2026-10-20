# Whale Desk v13

- `worker.js` — Worker Cloudflare `whale-desk`: cron ogni minuto, alert Telegram, segnali combinati, copy virtuale. Stato in KV, chiave `s13`.
- `dashboard/index.html` — dashboard: 3 wallet, posizioni, ordini in attesa, tabella dei trade, backtest del copy. Legge direttamente da Hyperliquid, file unico, tema chiaro/scuro.
- `_v12/`, `_v13/` — versioni precedenti.

## Deploy

```bash
npx wrangler deploy
```

Segreti già presenti: `TG_TOKEN`, `TG_CHAT`, `ADMIN_KEY`. Dopo il deploy:

- `/test?key=…` manda un messaggio di prova su Telegram
- `/check?key=…` esegue un ciclo a mano
- `/state` è ciò che legge la dashboard

Primo avvio: il Worker registra lo stato senza mandare alert, e per ~15 minuti (il tempo di scansionare tutti i DEX HIP-3) registra consenso/conflitto in silenzio.

Dashboard pubblica: https://whalebot.pages.dev (Cloudflare Pages, progetto `whalebot`). Worker: https://whale-desk.square-shape-0876.workers.dev

## Limiti del piano free di Workers

- 50 subrequest per invocazione: i DEX HIP-3 si interrogano quando un wallet ci ha posizioni o fill, più una rotazione di 5 coppie wallet×DEX al minuto (giro completo ogni ~13 minuti).
- 1.000 scritture KV al giorno: si scrive solo su eventi, segnali, campioni orari, più un rinfresco ogni 10 minuti.
