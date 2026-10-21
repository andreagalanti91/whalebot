# Whale Desk v13

- `worker.js` — Worker Cloudflare `whale-desk`: cron ogni minuto, alert Telegram, segnali combinati, copy virtuale. Stato in KV, chiave `s13`.
- `dashboard/index.html` — dashboard: Cluster-1, Petroliere e Rotatore con posizioni, ordini in attesa, tabella dei trade e backtest del copy. Legge direttamente da Hyperliquid, file unico, tema chiaro/scuro.

## Wallet negli alert

- **Gruppo A — Cluster** (3 conti, stesso operatore): copy solo con conferma 2 su 3, metà leva, stop 10%.
- **Gruppo C — Copy diretto**: Petroliere `0xbd33…4200` e Rotatore `0x2d99…a351`, scelti dalla leaderboard di Hyperdash (equity > 1M, win rate ~80%+, swing di più giorni, trade medi da 2–3M $). Ogni entrata da almeno 1M $ di nozionale è un segnale di copy; un quarto della loro leva, stop 20%.
- **Gruppo B — Lettura**: Ribassista e Inversore, per consenso, conflitto e inversioni di regime.
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
