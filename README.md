# Whale Desk v13

- `worker.js` — Worker Cloudflare `whale-desk`: cron ogni minuto, alert Telegram, segnali combinati, copy virtuale. Stato in KV, chiave `s13`.
- `dashboard/index.html` — dashboard (Netlify `signalgala`), file unico, tema chiaro/scuro.
- `_v12/` — copia della versione precedente (worker e dashboard).

## Deploy

```bash
npx wrangler deploy
```

Segreti già presenti: `TG_TOKEN`, `TG_CHAT`, `ADMIN_KEY`. Dopo il deploy:

- `/test?key=…` manda un messaggio di prova su Telegram
- `/check?key=…` esegue un ciclo a mano
- `/state` è ciò che legge la dashboard

Primo avvio: il Worker registra lo stato senza mandare alert, e per ~15 minuti (il tempo di scansionare tutti i DEX HIP-3) registra consenso/conflitto in silenzio.

Dashboard: imposta `DEFAULT_WORKER` in `dashboard/index.html` con l'URL `https://whale-desk.<sottodominio>.workers.dev`, oppure inseriscilo dall'icona impostazioni. Poi carica la cartella `dashboard/` su Netlify.

## Limiti del piano free di Workers

- 50 subrequest per invocazione: i DEX HIP-3 si interrogano quando un wallet ci ha posizioni o fill, più una rotazione di 5 coppie wallet×DEX al minuto (giro completo ogni ~13 minuti).
- 1.000 scritture KV al giorno: si scrive solo su eventi, segnali, campioni orari, più un rinfresco ogni 10 minuti.
