/**
 * Whale Desk v13 — server degli alert e del copy virtuale
 * Cloudflare Worker, cron ogni minuto. Stato in un'unica chiave KV ("s13"),
 * scritta solo quando qualcosa cambia (eventi, segnali, campioni orari).
 *
 * Il Worker invia solo alert: l'esecuzione degli ordini resta manuale.
 */

/* ─────────── configurazione ─────────── */

const WALLETS = [
  // Gruppo A — Cluster (READ + COPY). Cluster-1 è il riferimento per il sizing.
  { a: "0x237152b038d88f4156a0cd71090462de7e3f0883", n: "Cluster-1", g: "A", ref: true, note: "Swing + trade tattici" },
  { a: "0xbd1c84113c6deb5044be0c2221f9e9403811ff0e", n: "Cluster-2", g: "A", note: "Replica Cluster-1" },
  { a: "0xec7f9f5b31b8f5da6ac6c0973bbd496e16f9df39", n: "Cluster-3", g: "A", note: "Solo swing, a volte entra prima" },
  // Gruppo B — Lettura (READ ONLY)
  { a: "0xc7290b4b308431a985fa9e3e8a335c2f7650517c", n: "Ribassista", g: "B", bear: true, regime: true, note: "Short di lungo periodo su BTC/ETH/HYPE e HIP-3" },
  { a: "0x9c16bc8f1104e4d2f72267eb981fa12de7cc4a6f", n: "Inversore", g: "B", regime: true, note: "Rare inversioni su BTC · SOL ad alta leva: non copiare" },
  // Gruppo C — Copy diretto: trader indipendenti scelti da Hyperdash con profilo simile a Cluster-1
  // (win rate alto, swing di più giorni, trade da milioni). Tengono le posizioni durante cali forti:
  // nel backtest funzionano a un quarto della loro leva con stop al 20%, non a metà con stop al 10%.
  { a: "0xbd334a55db91617545e8d1b09941e036ad8e4200", n: "Petroliere", g: "C", factor: 0.25, stop: 0.2, note: "HYPE e petrolio HIP-3 · 88% vincenti · 17 giorni" },
  { a: "0x2d99fe0f36c1aebd28a1a2c0e82e8ca13c2ea351", n: "Rotatore", g: "C", factor: 0.25, stop: 0.2, note: "BTC e alt · 79% vincenti · 9 giorni" },
];

// Wallet della v12, fuori dagli alert: restano visibili in dashboard come archivio.
const ARCHIVE = [
  { a: "0x325edd95bb016c36027ce3b9f7595af7094a9564", n: "Metronomo", note: "Diventato market maker: non più leggibile" },
  { a: "0xac26cf5f3c46b5e102048c65b977d2551b72a9c7", n: "Orologiaio", note: "Edge spento, fermo da mesi" },
  { a: "0x8fc7c0442e582bca195978c5a4fdec2e7c5bb0f7", n: "Ribassista storico", note: "Sostituito dal nuovo Ribassista" },
  { a: "0x10e14ba2d77263543be1bdb2851b0933ddf4f4bd", n: "Macro", note: "Tolto per lasciare spazio al Gruppo C" },
];

const CAPITAL = 50_000;        // capitale dedicato al copy
const COPY_FACTOR = 0.5;       // metà leva rispetto al Cluster
const STOP = 0.10;             // stop a −10% del capitale
const PRE_STOP = 0.05;         // pre-alert a −5%
const LEV_RANGE = 2;           // oltre questa leva sul capitale l'alert di copy avvisa
const FUNDING_ALERT = 0.005;   // funding cumulato oltre lo 0,5% del nozionale
const EQ_DROP = 0.10;          // equity Cluster in calo oltre il 10% in 24h

const AGG_MS = 2 * 60e3;       // fill della stessa coin entro 2 min = un evento
const CONFIRM_MS = 30 * 60e3;  // finestra per la conferma 2/3 del Cluster
const REGIME_AGE = 30 * 864e5; // posizioni "di regime": aperte da oltre 30 giorni
const KEEP_MS = 30 * 864e5;    // storico eventi e segnali: 30 giorni
const MIN_NTL = 1_000;         // eventi sotto questo nozionale: registrati, non notificati
const SOLO_MIN = 1_000_000;    // Gruppo C: si copia un'entrata solo da 1M $ di nozionale in su
const SIG_NTL = 10_000;        // posizioni sotto questo nozionale non contano per consenso/conflitto
const SWEEP = 5;               // coppie wallet×DEX HIP-3 riscansionate a ogni ciclo
const SUB_BUDGET = 44;         // il piano free di Workers concede 50 subrequest per invocazione

const API = "https://api.hyperliquid.xyz/info";
const DEXS_FALLBACK = ["xyz", "flx", "vntl", "hyna", "km", "abcd", "cash", "para", "mkts", "io"];
const KEY = "s13";

/* ─────────── utilità ─────────── */

let SUB = 0; // subrequest usate in questa invocazione

const hl = (body) => {
  SUB++;
  return fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => {
    if (!r.ok) throw new Error("Hyperliquid HTTP " + r.status);
    return r.json();
  });
};

const dexOf = (c) => { const i = c.indexOf(":"); return i < 0 ? "" : c.slice(0, i); };
const bareCoin = (c) => { const i = c.indexOf(":"); return i < 0 ? c : c.slice(i + 1); };
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const D = (d) => (d > 0 ? "LONG" : "SHORT");
const byAddr = Object.fromEntries(WALLETS.map((w) => [w.a, w]));
const byName = Object.fromEntries(WALLETS.map((w) => [w.n, w]));
// regole di copy per fonte: il Cluster usa i valori generali, i wallet del Gruppo C i propri
const rules = (src) => ({ factor: byName[src]?.factor ?? COPY_FACTOR, stop: byName[src]?.stop ?? STOP });
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

// numeri all'italiana senza dipendere dall'ICU del runtime
function nf(n, d = 0) {
  const [i, f] = Math.abs(n).toFixed(d).split(".");
  return (n < 0 ? "−" : "") + i.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (f ? "," + f : "");
}
const usd = (n) => {
  const x = Math.abs(n);
  const s = x >= 1e9 ? nf(x / 1e9, 2) + "B" : x >= 1e6 ? nf(x / 1e6, 1) + "M" : x >= 1e5 ? nf(x / 1e3, 0) + "k" : nf(x, 0);
  return (n < 0 ? "−" : "") + s + " $";
};
const sUsd = (n) => (n >= 0 ? "+" : "") + usd(n);
const px = (p) => nf(p, p >= 1000 ? 1 : p >= 10 ? 2 : p >= 1 ? 3 : 5);
const qty = (q) => { const x = Math.abs(q); return nf(x, x >= 100 ? 0 : x >= 1 ? 2 : 4); };
const lev = (x) => nf(x, x >= 10 ? 0 : 1) + "x";
const pct = (x, d = 0) => nf(x * 100, d) + "%";
const hhmm = (t) => new Date(t).toISOString().slice(11, 16);
function dur(ms) {
  const m = Math.round(ms / 60e3), h = Math.floor(m / 60), g = Math.floor(h / 24);
  return g >= 1 ? `${g}g ${h % 24}h` : h >= 1 ? `${h}h ${m % 60}m` : `${m}m`;
}

/* ─────────── Telegram ─────────── */

async function tgSend(env, text) {
  if (!env.TG_TOKEN || !env.TG_CHAT) return null;
  SUB++;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TG_CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const j = await r.json();
    return j.ok ? j.result.message_id : null;
  } catch { return null; }
}

async function tgEdit(env, id, text) {
  if (!env.TG_TOKEN || !env.TG_CHAT || !id) return;
  SUB++;
  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TG_CHAT, message_id: id, text, parse_mode: "HTML", disable_web_page_preview: true }),
  }).catch(() => {});
}

/* ─────────── stato ─────────── */

const empty = () => ({
  v: 13,
  cur: {},       // addr → time dell'ultimo fill visto
  dex: {},       // addr → dex → { eq, t, pos: { coin: {sz, ntl, entry, upnl, fund} } }
  open: {},      // "addr|coin" → { t, dir, approx } apertura della posizione corrente
  ev: [],        // eventi (aggregati 2 min), anche quelli ancora aperti
  sig: [],       // segnali combinati, copy e rischio
  cons: {},      // consenso/conflitto attivi
  copy: { pos: {}, closed: [], realized: 0 },
  eqh: {},       // addr → [[t, equity]] campioni orari, ultime ~48h
  eqAlert: {},   // addr → time ultimo alert di calo equity
  spot: {},      // addr → stablecoin in spot
  dexList: null, // { t, list } da perpDexs
  readyAt: 0,    // prima di questo istante consenso/conflitto si registrano in silenzio
});

// Il salvataggio ignora i campi che cambiano a ogni minuto (equity, nozionali, timestamp):
// si scrive su KV solo per eventi, segnali e campioni orari, più un rinfresco ogni 10 minuti.
// Così si resta sotto le 1.000 scritture al giorno del piano free.
const VOLATILE = new Set(["eq", "ntl", "upnl", "fund", "t", "savedAt", "spot"]);
const sigOf = (o) => JSON.stringify(o, (k, v) => (VOLATILE.has(k) ? undefined : v));
const SAVE_EVERY = 10 * 60e3;

// equity = margine perp su tutti i DEX + stablecoin in spot (il conto unificato tiene lì il collaterale)
const eqTot = (st, a) => Object.values(st.dex[a] || {}).reduce((s, d) => s + (d.eq || 0), 0) + (st.spot?.[a] || 0);
const STABLES = new Set(["USDC", "USDT0", "USDH", "USDE", "USDT"]);

// posizione di un wallet su una coin "nuda" (preferisce il DEX principale)
function findPos(st, a, bare) {
  const dx = st.dex[a] || {};
  for (const d of ["", ...Object.keys(dx).filter((k) => k)]) {
    for (const [coin, p] of Object.entries(dx[d]?.pos || {})) if (bareCoin(coin) === bare) return { coin, ...p };
  }
  return null;
}

function markOf(st, coin) {
  for (const a of Object.keys(st.dex)) {
    const p = st.dex[a]?.[dexOf(coin)]?.pos?.[coin];
    if (p && p.sz) return p.ntl / Math.abs(p.sz);
  }
  return null;
}

async function perpDexList(st, now) {
  if (st.dexList && now - st.dexList.t < 6 * 3600e3) return st.dexList.list;
  try {
    const r = await hl({ type: "perpDexs" });
    const list = r.filter(Boolean).map((x) => x.name).filter(Boolean);
    st.dexList = { t: now, list };
    return list;
  } catch { return st.dexList?.list || DEXS_FALLBACK; }
}

async function fetchState(a, dex) {
  const s = await hl(dex ? { type: "clearinghouseState", user: a, dex } : { type: "clearinghouseState", user: a });
  const pos = {};
  for (const ap of s.assetPositions || []) {
    const p = ap.position;
    pos[p.coin] = {
      sz: +p.szi, ntl: +p.positionValue, entry: +p.entryPx,
      upnl: +p.unrealizedPnl, fund: +(p.cumFunding?.sinceOpen || 0),
    };
  }
  return { eq: +s.marginSummary?.accountValue || 0, pos };
}

/* ─────────── eventi dai fill ─────────── */

function classify(start, end) {
  if (start === end) return null;
  if (start === 0) return "APERTURA";
  if (end === 0) return "CHIUSURA";
  if (sgn(start) !== sgn(end)) return "INVERSIONE";
  return Math.abs(end) > Math.abs(start) ? "AUMENTO" : "RIDUZIONE";
}

// direzione della posizione di cui parla l'evento
const evDir = (e) => (e.type === "CHIUSURA" ? sgn(e.start) : sgn(e.end));
// per la conferma 2/3 apertura e inversione contano come "entrata" nella nuova direzione
const evNorm = (e) => (e.type === "APERTURA" || e.type === "INVERSIONE" ? "ENTRATA" : e.type);

function addFill(st, w, f) {
  const signed = f.side === "B" ? +f.sz : -f.sz;
  const start = +f.startPosition;
  let e = st.ev.find((x) => !x.final && x.w === w.a && x.coin === f.coin && f.time - x.t1 <= AGG_MS);
  if (!e) {
    e = {
      id: w.a.slice(2, 8) + "-" + f.coin + "-" + f.time,
      w: w.a, n: w.n, g: w.g, coin: f.coin,
      start, end: start, t0: f.time, t1: f.time,
      nf: 0, q: 0, qpx: 0, pnl: 0,
      openT: st.open[w.a + "|" + f.coin]?.t || null,
      final: false, msg: null,
    };
    st.ev.push(e);
  }
  e.end = Math.round((start + signed) * 1e8) / 1e8;
  e.t1 = Math.max(e.t1, f.time);
  e.nf++;
  e.q += +f.sz;
  e.qpx += +f.sz * +f.px;
  e.pnl += +f.closedPnl - +f.fee;
  return e;
}

function enrich(st, e) {
  e.type = classify(e.start, e.end);
  e.vwap = e.q ? e.qpx / e.q : 0;
  const p = st.dex[e.w]?.[dexOf(e.coin)]?.pos?.[e.coin];
  const eq = eqTot(st, e.w) || 1;
  e.ntl = e.end === 0 ? Math.abs(e.start) * e.vwap : p ? p.ntl : Math.abs(e.end) * e.vwap;
  e.eqPct = e.ntl / eq;
  e.lev = e.ntl / eq;
  if (e.type === "CHIUSURA" && e.openT) e.dur = e.t1 - e.openT;
  e.quiet = Math.max(Math.abs(e.start), Math.abs(e.end)) * e.vwap < MIN_NTL;
}

const GROUP = { A: "Cluster", B: "Lettura", C: "Copy" };
const ICON = { APERTURA: "🟢", AUMENTO: "🔼", RIDUZIONE: "🔽", CHIUSURA: "⚪️", INVERSIONE: "🔄" };

function evMsg(st, e) {
  const d = evDir(e);
  const title = e.type === "INVERSIONE" ? `INVERSIONE → ${D(d)}` : `${e.type} ${D(d)}`;
  const dex = dexOf(e.coin);
  const coin = `<b>${esc(bareCoin(e.coin))}</b>${dex ? ` <i>(${esc(dex)})</i>` : ""}`;
  const L = [`${ICON[e.type]} <b>${title}</b> — ${esc(e.n)} <i>· ${GROUP[e.g]}</i>`];
  if (e.type === "APERTURA") {
    L.push(`${coin} · ${qty(e.end)} (${usd(e.ntl)}) @ ${px(e.vwap)}`);
  } else if (e.type === "CHIUSURA") {
    L.push(`${coin} · ${qty(e.start)} chiusi @ ${px(e.vwap)}`);
  } else {
    const delta = e.end - e.start;
    L.push(`${coin} · ${delta > 0 ? "+" : "−"}${qty(delta)} → ${qty(e.end)} (${usd(e.ntl)}) @ ${px(e.vwap)}`);
  }
  if (e.type !== "CHIUSURA") L.push(`Leva effettiva ${lev(e.lev)} · ${pct(e.eqPct)} dell'equity`);
  if (e.type === "CHIUSURA" || ((e.type === "RIDUZIONE" || e.type === "INVERSIONE") && Math.abs(e.pnl) >= 1)) {
    L.push(`PnL realizzato <b>${sUsd(e.pnl)}</b>${e.type === "CHIUSURA" ? ` · durata ${e.dur ? dur(e.dur) + (st.open[e.w + "|" + e.coin]?.approx ? "+" : "") : "n/d"}` : ""}`);
  }
  const foot = [];
  if (e.nf > 1) foot.push(`${e.nf} blocchi · ${hhmm(e.t0)}–${hhmm(e.t1)} UTC`);
  if (e.g === "A" && !e.confirmed) foot.push("singolo wallet: non è un segnale di copy finché non arriva la conferma 2/3");
  if (e.g === "C" && !e.confirmed && evNorm(e) === "ENTRATA") foot.push(`sotto ${usd(SOLO_MIN)}: non copiato`);
  if (foot.length) L.push(`<i>${foot.join(" · ")}</i>`);
  return L.join("\n");
}

/* ─────────── segnali combinati ─────────── */

function pushSig(st, s) {
  st.sig.push({ id: s.type + "-" + s.t + "-" + (s.coin || ""), ...s });
  return s;
}

async function checkCluster(env, st, e, now, touched) {
  const norm = evNorm(e), dir = evDir(e), bare = bareCoin(e.coin);
  const peers = st.ev.filter((x) =>
    x.g === "A" && x.type && !x.quiet && bareCoin(x.coin) === bare &&
    evNorm(x) === norm && evDir(x) === dir && x.t1 >= e.t0 - CONFIRM_MS && x.t0 <= e.t1 + CONFIRM_MS);
  const who = [...new Set(peers.map((x) => x.w))];
  if (who.length < 2) return;
  // i messaggi già inviati perdono la nota "in attesa di conferma"
  for (const x of peers) {
    if (x.confirmed) continue;
    x.confirmed = true;
    if (x.msg && !touched.has(x)) await tgEdit(env, x.msg, evMsg(st, x));
  }

  const key = `CC|${bare}|${norm}|${dir}`;
  const prev = st.sig.slice().reverse().find((s) => s.key === key && now - s.t < 2 * CONFIRM_MS);
  const names = who.map((a) => byAddr[a].n);
  if (prev) {
    if (who.length > prev.n) {
      prev.n = who.length; prev.who = names;
      await tgSend(env, `🎯 <b>CLUSTER ${who.length}/3</b> — ${esc(bare)} ${norm.toLowerCase()} ${D(dir).toLowerCase()}: si aggiunge ${esc(names[names.length - 1])}`);
    }
    return;
  }
  const verb = { ENTRATA: "apre", AUMENTO: "aumenta", RIDUZIONE: "riduce", CHIUSURA: "chiude" }[norm];
  pushSig(st, { type: "CC", key, pr: "ALTA", t: now, coin: bare, dir, ev: norm, n: who.length, who: names,
    txt: `${who.length}/3 del Cluster ${verb} ${D(dir).toLowerCase()} ${bare}` });
  await tgSend(env,
    `🎯 <b>CLUSTER CONFERMATO ${who.length}/3</b>\n<b>${esc(bare)}</b> · ${verb} ${D(dir)}\n<i>${names.map(esc).join(", ")} entro 30 min</i>`);
  await copyOnSignal(env, st, norm, bare, dir, who, now);
}

// Gruppo C: trader indipendenti, ognuno è un segnale di copy da solo (niente conferma 2/3)
async function checkSolo(env, st, e, now) {
  const w = byAddr[e.w], bare = bareCoin(e.coin), norm = evNorm(e), dir = evDir(e);
  const key = `SOLO|${e.w}|${bare}|${norm}|${dir}`;
  if (st.sig.some((s) => s.key === key && now - s.t < 2 * CONFIRM_MS)) return;
  // si entra solo su posizioni grandi; le uscite si seguono sempre se c'è una copia aperta
  if (norm === "ENTRATA" && e.ntl < SOLO_MIN) return;
  if (norm !== "ENTRATA" && !st.copy.pos[copyKey(w.n, bare)]) return;
  e.confirmed = true;
  const verb = { ENTRATA: "apre", AUMENTO: "aumenta", RIDUZIONE: "riduce", CHIUSURA: "chiude" }[norm];
  pushSig(st, { type: "SOLO", key, pr: "ALTA", t: now, coin: bare, dir, ev: norm, who: [w.n],
    txt: `${w.n} ${verb} ${D(dir).toLowerCase()} ${bare} · ${usd(e.ntl)}` });
  await copyOnSignal(env, st, norm, bare, dir, [e.w], now, w.n);
}

async function checkRegime(env, st, e, now) {
  const w = byAddr[e.w];
  const bare = bareCoin(e.coin);
  if (!w.regime || !["BTC", "ETH"].includes(bare)) return;
  if (e.type !== "CHIUSURA" && e.type !== "INVERSIONE") return;
  if (!e.openT || e.t0 - e.openT < REGIME_AGE) return;
  const key = `REG|${e.w}|${e.coin}|${e.openT}`;
  if (st.sig.some((s) => s.key === key)) return;
  const was = sgn(e.start);
  const age = dur(e.t0 - e.openT);
  pushSig(st, { type: "REG", key, pr: "ALTA", t: now, coin: bare, dir: was, who: [w.n],
    txt: `${w.n} ${e.type === "CHIUSURA" ? "chiude" : "inverte"} lo ${D(was).toLowerCase()} ${bare} aperto da ${age}` });
  await tgSend(env,
    `🧭 <b>INVERSIONE DI REGIME</b>\n${esc(w.n)} ${e.type === "CHIUSURA" ? "chiude" : "inverte"} il ${D(was)} su <b>${bare}</b> aperto da ${age}` +
    (e.type === "INVERSIONE" ? `\nOra ${D(sgn(e.end))} ${qty(e.end)} (${usd(e.ntl)})` : `\nPnL realizzato ${sUsd(e.pnl)}`));
}

// consenso e conflitto: confronto fra le posizioni aperte, alert quando nascono
async function checkConsensus(env, st, now) {
  const per = {};
  for (const w of WALLETS) {
    for (const d of Object.values(st.dex[w.a] || {})) {
      for (const [coin, p] of Object.entries(d.pos || {})) {
        if (p.ntl < SIG_NTL) continue;
        (per[bareCoin(coin)] ||= []).push({ w, dir: sgn(p.sz), ntl: p.ntl });
      }
    }
  }
  const now_ = {};
  for (const [bare, list] of Object.entries(per)) {
    const A = list.filter((x) => x.w.g === "A");
    const L = A.filter((x) => x.dir > 0).length, S = A.filter((x) => x.dir < 0).length;
    const cdir = L >= 2 ? 1 : S >= 2 ? -1 : 0;
    if (!cdir) continue;
    const same = list.filter((x) => x.w.g !== "A" && x.dir === cdir);
    if (same.length) now_[`CONS|${bare}|${cdir}`] = { type: "CONS", pr: "ALTA", coin: bare, dir: cdir, who: same.map((x) => x.w.n),
      txt: `Cluster e ${same.map((x) => x.w.n).join(", ")} ${D(cdir).toLowerCase()} su ${bare}` };
    const opp = list.filter((x) => x.w.bear && x.dir === -cdir);
    if (opp.length) now_[`CONF|${bare}`] = { type: "CONF", pr: "MEDIA", coin: bare, dir: cdir, who: opp.map((x) => x.w.n),
      txt: `Cluster ${D(cdir).toLowerCase()} contro Ribassista ${D(-cdir).toLowerCase()} su ${bare}` };
  }
  for (const [k, s] of Object.entries(now_)) {
    if (st.cons[k]) continue;
    st.cons[k] = now;
    if (now < st.readyAt) continue;
    pushSig(st, { key: k, t: now, ...s });
    await tgSend(env, s.type === "CONS"
      ? `🤝 <b>CONSENSO</b> · <b>${esc(s.coin)}</b> ${D(s.dir)}\n<i>${esc(s.txt)}</i>`
      : `⚔️ <b>CONFLITTO</b> · <b>${esc(s.coin)}</b>\n<i>${esc(s.txt)} — informativo</i>`);
  }
  for (const k of Object.keys(st.cons)) if (!now_[k]) delete st.cons[k];
}

/* ─────────── copy virtuale (Cluster confermato 2/3, oppure un wallet del Gruppo C da solo) ─────────── */

// una posizione copiata per fonte e coin: "Cluster|ETH", "Whale-2|BTC"
const copyKey = (src, bare) => src + "|" + bare;

function refFor(st, bare, dir, who, src) {
  const order = [...(src === "Cluster" ? WALLETS.filter((w) => w.ref) : []), ...who.map((a) => byAddr[a])];
  for (const w of order) {
    const p = findPos(st, w.a, bare);
    if (p && sgn(p.sz) === dir && p.ntl > 0) return { w, p, eq: eqTot(st, w.a), mark: p.ntl / Math.abs(p.sz) };
  }
  return null;
}

let MIDS = null;
async function midOf(st, coin) {
  const m = markOf(st, coin);
  if (m) return m;
  try {
    MIDS ||= {};
    const dex = dexOf(coin);
    if (!MIDS[dex]) MIDS[dex] = await hl(dex ? { type: "allMids", dex } : { type: "allMids" });
    return +MIDS[dex][coin] || null;
  } catch { return null; }
}

const copyPnl = (cp, mark) => cp.realized + cp.dir * (mark - cp.entry) * cp.sz - cp.fund;

async function closeCopy(env, st, cp, mark, why, now) {
  const pnl = copyPnl(cp, mark);
  st.copy.closed.unshift({ ...cp, exit: mark, t1: now, pnl, why });
  st.copy.closed = st.copy.closed.slice(0, 50);
  st.copy.realized += pnl;
  delete st.copy.pos[copyKey(cp.src || "Cluster", cp.bare)];
  pushSig(st, { type: "COPY", pr: "ALTA", t: now, coin: cp.bare, dir: cp.dir, who: [cp.src || "Cluster"], txt: `Chiudi copy ${D(cp.dir).toLowerCase()} ${cp.bare} · ${sUsd(pnl)} (${why})` });
  await tgSend(env,
    `📋 <b>COPY ${esc(cp.src || "Cluster")} · CHIUDI ${D(cp.dir)} ${esc(cp.bare)}</b>\n${qty(cp.sz)} @ ~${px(mark)} · PnL <b>${sUsd(pnl)}</b> (${pct(pnl / CAPITAL, 1)} del capitale)\n` +
    `<i>${esc(why)} · durata ${dur(now - cp.t)} · esecuzione manuale</i>`);
}

async function copyOnSignal(env, st, norm, bare, dir, who, now, src = "Cluster") {
  const key = copyKey(src, bare);
  let cp = st.copy.pos[key];
  const chi = src === "Cluster" ? "il Cluster" : src;
  if (norm === "CHIUSURA") {
    if (cp && cp.dir === dir) {
      const mark = await midOf(st, cp.coin);
      if (mark) await closeCopy(env, st, cp, mark, src === "Cluster" ? "il Cluster chiude 2/3" : `${src} chiude`, now);
    }
    return;
  }
  if (cp && cp.dir !== dir) {
    const mark = await midOf(st, cp.coin);
    if (mark) await closeCopy(env, st, cp, mark, `${chi} inverte`, now);
    cp = null;
  }
  const ref = refFor(st, bare, dir, who, src);
  if (!ref) return;
  const R = rules(src);
  const target = (CAPITAL / ref.eq) * ref.p.ntl * R.factor;
  const mark = ref.mark;
  const tgtSz = target / mark;
  const myLev = target / CAPITAL;
  const refTxt = `<i>Rif. ${esc(ref.w.n)}: ${usd(ref.p.ntl)} su equity ${usd(ref.eq)} (${lev(ref.p.ntl / ref.eq)}) → ${R.factor === 0.5 ? "metà" : R.factor === 0.25 ? "un quarto della" : nf(R.factor, 2) + "×"} leva</i>`;
  const tag = `COPY ${esc(src)}`;
  const levWarn = myLev > LEV_RANGE ? `\n⚠️ Leva ${lev(myLev)} sul capitale: fuori dal range storico 1–2x` : "";

  if (!cp) {
    if (norm !== "ENTRATA") return; // non si entra a metà trade su un aumento o una riduzione
    cp = st.copy.pos[key] = {
      coin: ref.p.coin, bare, dir, sz: tgtSz, entry: mark, ntl0: target, t: now,
      realized: 0, fund: 0, fundT: now, a5: false, aF: false, ref: ref.w.n, src, stop: R.stop,
    };
    const stopPx = mark - dir * (R.stop * CAPITAL) / tgtSz;
    pushSig(st, { type: "COPY", pr: "ALTA", t: now, coin: bare, dir, who: [src], txt: `Apri copy ${D(dir).toLowerCase()} ${bare} · ${usd(target)} (${lev(myLev)})` });
    await tgSend(env,
      `📋 <b>${tag} · APRI ${D(dir)} ${esc(bare)}</b>\nNozionale <b>${usd(target)}</b> · ≈ ${qty(tgtSz)} ${esc(bare)} @ ~${px(mark)}\n` +
      `Leva ${lev(myLev)} sul capitale ${usd(CAPITAL)} · stop −${usd(R.stop * CAPITAL)} ${stopPx > 0 ? "≈ " + px(stopPx) : "(oltre lo zero: posizione troppo piccola per raggiungerlo)"}\n${refTxt}${levWarn}\n<i>Esecuzione manuale</i>`);
    return;
  }

  // ridimensionamento proporzionale a un aumento o una riduzione confermati
  const cur = cp.sz * mark;
  if (Math.abs(target - cur) / cur < 0.1) return;
  if (tgtSz > cp.sz) {
    cp.entry = (cp.entry * cp.sz + mark * (tgtSz - cp.sz)) / tgtSz;
  } else {
    cp.realized += cp.dir * (mark - cp.entry) * (cp.sz - tgtSz);
  }
  const dq = tgtSz - cp.sz;
  cp.sz = tgtSz;
  pushSig(st, { type: "COPY", pr: "ALTA", t: now, coin: bare, dir, who: [src], txt: `${dq > 0 ? "Aumenta" : "Riduci"} copy ${bare} → ${usd(target)}` });
  await tgSend(env,
    `📋 <b>${tag} · ${dq > 0 ? "AUMENTA" : "RIDUCI"} ${D(dir)} ${esc(bare)}</b>\n${dq > 0 ? "+" : "−"}${qty(dq)} ${esc(bare)} @ ~${px(mark)} → nozionale <b>${usd(target)}</b> (${lev(myLev)})\n${refTxt}${levWarn}\n<i>Esecuzione manuale</i>`);
}

async function copyRisk(env, st, now) {
  for (const cp of Object.values(st.copy.pos)) {
    const mark = await midOf(st, cp.coin);
    if (!mark) continue;

    if (now - cp.fundT >= 3600e3 && SUB < SUB_BUDGET) {
      try {
        const rows = await hl({ type: "fundingHistory", coin: cp.coin, startTime: cp.fundT });
        for (const r of rows) cp.fund += cp.dir * +r.fundingRate * cp.sz * mark; // >0 = costo
        cp.fundT = rows.length ? rows[rows.length - 1].time + 1 : now;
      } catch {}
      const ntl = cp.sz * mark;
      if (!cp.aF && cp.fund > FUNDING_ALERT * ntl) {
        cp.aF = true;
        pushSig(st, { type: "RISK", pr: "MEDIA", t: now, coin: cp.bare, dir: cp.dir, txt: `Funding cumulato ${usd(cp.fund)} (${pct(cp.fund / ntl, 2)})` });
        await tgSend(env, `💸 <b>FUNDING</b> · copy ${esc(cp.src || "Cluster")} ${D(cp.dir)} ${esc(cp.bare)}\nCumulato ${usd(cp.fund)} = ${pct(cp.fund / ntl, 2)} del nozionale (soglia 0,5%)`);
      }
    }

    const pnl = copyPnl(cp, mark);
    const stop = cp.stop ?? STOP;
    if (pnl <= -stop * CAPITAL) {
      await tgSend(env, `🛑 <b>STOP −${pct(stop)}</b> · copy ${esc(cp.src || "Cluster")} ${D(cp.dir)} ${esc(cp.bare)}\nPnL ${sUsd(pnl)} @ ${px(mark)} — <b>chiudi manualmente</b>`);
      await closeCopy(env, st, cp, mark, `stop −${pct(stop)} del capitale`, now);
    } else if (pnl <= -(stop / 2) * CAPITAL && !cp.a5) {
      cp.a5 = true;
      pushSig(st, { type: "RISK", pr: "ALTA", t: now, coin: cp.bare, dir: cp.dir, txt: `Copy ${cp.bare} a ${sUsd(pnl)}: metà strada dallo stop` });
      await tgSend(env, `⚠️ <b>PRE-ALERT −${pct(stop / 2)}</b> · copy ${esc(cp.src || "Cluster")} ${D(cp.dir)} ${esc(cp.bare)}\nPnL ${sUsd(pnl)} @ ${px(mark)} · stop a ${sUsd(-stop * CAPITAL)}`);
    }
  }
}

// campioni orari di equity; alert se il Cluster perde oltre il 10% in 24h
async function equityWatch(env, st, now) {
  for (const w of WALLETS) {
    const eq = eqTot(st, w.a);
    if (!eq) continue;
    const h = (st.eqh[w.a] ||= []);
    if (!h.length || now - h[h.length - 1][0] >= 3600e3) {
      h.push([now, Math.round(eq)]);
      while (h.length > 49) h.shift();
    }
    if (w.g === "B") continue;
    const old = h.find((x) => now - x[0] <= 25 * 3600e3 && now - x[0] >= 23 * 3600e3);
    if (!old) continue;
    const drop = (old[1] - eq) / old[1];
    if (drop > EQ_DROP && now - (st.eqAlert[w.a] || 0) > 12 * 3600e3) {
      st.eqAlert[w.a] = now;
      pushSig(st, { type: "RISK", pr: "ALTA", t: now, who: [w.n], txt: `${w.n}: equity −${pct(drop)} in 24h` });
      await tgSend(env, `⚠️ <b>EQUITY ${w.g === "A" ? "CLUSTER" : "COPY"}</b> · ${esc(w.n)}\n−${pct(drop)} in 24h: ${usd(old[1])} → ${usd(eq)}\n<i>Drawdown o prelievo: controlla prima di seguire il prossimo segnale</i>`);
    }
  }
}

/* ─────────── apertura delle posizioni già in corso ─────────── */

// risale ai fill per sapere da quando è aperta una posizione (serve a durata e regime)
async function findOpenTime(a, coin, dir, now) {
  const W = [7, 30, 120, 365];
  let end = now;
  for (const days of W) {
    const start = now - days * 864e5;
    if (SUB >= SUB_BUDGET) return null;
    let fills;
    try { fills = await hl({ type: "userFillsByTime", user: a, startTime: start, endTime: end, aggregateByTime: true }); }
    catch { return null; }
    let t = null;
    for (const f of fills) {
      if (f.coin !== coin) continue;
      const s0 = +f.startPosition, s1 = s0 + (f.side === "B" ? +f.sz : -f.sz);
      if (sgn(s0) !== dir && sgn(s1) === dir) t = f.time;
    }
    if (t) return { t, dir, approx: false };
    end = start;
  }
  return { t: now - 365 * 864e5, dir, approx: true };
}

/* ─────────── ciclo principale ─────────── */

async function controlla(env) {
  SUB = 0; MIDS = null;
  const now = Date.now();
  const raw = await env.KV.get(KEY);
  const st = raw ? { ...empty(), ...JSON.parse(raw) } : empty();
  const boot = !raw;
  const before = sigOf(st);
  const dexs = await perpDexList(st, now);
  if (boot) st.readyAt = now + Math.ceil((WALLETS.length * dexs.length) / SWEEP + 2) * 60e3;

  // 1. fill nuovi
  const fills = {};
  await Promise.all(WALLETS.map(async (w) => {
    try {
      const r = await hl({ type: "userFillsByTime", user: w.a, startTime: (st.cur[w.a] || now - 60e3) + 1, aggregateByTime: true });
      fills[w.a] = r.sort((x, y) => x.time - y.time);
    } catch (err) { fills[w.a] = null; console.log("fills", w.n, String(err)); }
  }));

  // 2. quali DEX interrogare: principale, quelli con posizioni, quelli toccati dai fill, più una rotazione HIP-3
  const want = {};
  for (const w of WALLETS) {
    const s = (want[w.a] = new Set([""]));
    for (const [d, v] of Object.entries(st.dex[w.a] || {})) if (Object.keys(v.pos || {}).length) s.add(d);
    for (const f of fills[w.a] || []) s.add(dexOf(f.coin));
  }
  const pairs = WALLETS.flatMap((w) => dexs.map((d) => [w.a, d]));
  const tick = Math.floor(now / 60e3);
  for (let j = 0; j < SWEEP && pairs.length; j++) {
    const [a, d] = pairs[(tick * SWEEP + j) % pairs.length];
    want[a].add(d);
  }
  const jobs = [];
  for (const [a, set] of Object.entries(want)) for (const d of set) jobs.push([a, d]);
  st.spot ||= {};
  // il saldo spot cambia di rado: ogni wallet lo rilegge ogni 5 minuti (o se ha appena fatto fill), a turno
  await Promise.all(WALLETS.map(async (w, i) => {
    if (st.spot[w.a] != null && (tick + i) % 5 && !(fills[w.a] || []).length) return;
    try {
      const s = await hl({ type: "spotClearinghouseState", user: w.a });
      st.spot[w.a] = (s.balances || []).filter((b) => STABLES.has(b.coin)).reduce((x, b) => x + +b.total, 0);
    } catch (err) { console.log("spot", w.n, String(err)); }
  }));
  await Promise.all(jobs.map(async ([a, d]) => {
    try {
      const s = await fetchState(a, d);
      st.dex[a] ||= {};
      if (!d || s.eq || Object.keys(s.pos).length) st.dex[a][d] = { ...s, t: now };
      else delete st.dex[a][d];
    } catch (err) { console.log("state", byAddr[a].n, d || "main", String(err)); }
  }));

  // 3. eventi aggregati
  const touched = new Set();
  for (const w of WALLETS) {
    const list = fills[w.a];
    if (!list) continue;
    for (const f of list) {
      st.cur[w.a] = Math.max(st.cur[w.a] || 0, f.time);
      if (!boot) touched.add(addFill(st, w, f));
    }
    if (!st.cur[w.a]) st.cur[w.a] = now - 60e3;
  }
  // prima si classificano tutti, così due wallet del Cluster nello stesso ciclo si confermano a vicenda
  for (const e of touched) enrich(st, e);
  const live = [...touched].filter((e) => e.type && !e.quiet);
  for (const e of live) {
    if (e.g === "A") await checkCluster(env, st, e, now, touched);
    if (e.g === "C") await checkSolo(env, st, e, now);
    await checkRegime(env, st, e, now);
  }
  for (const e of live) {
    const text = evMsg(st, e);
    if (!e.msg) e.msg = await tgSend(env, text);
    else await tgEdit(env, e.msg, text);
  }

  // 4. chiusura dei blocchi da 2 minuti e registro delle aperture
  for (const e of st.ev) {
    if (e.final || now - e.t1 <= AGG_MS) continue;
    e.final = true;
    const k = e.w + "|" + e.coin;
    if (e.type === "APERTURA" || e.type === "INVERSIONE") st.open[k] = { t: e.t0, dir: sgn(e.end), approx: false };
    else if (e.type === "CHIUSURA") delete st.open[k];
  }

  // 5. stato: consenso/conflitto, rischio copy, equity
  await checkConsensus(env, st, now);
  await copyRisk(env, st, now);
  await equityWatch(env, st, now);

  // 6. una posizione già aperta senza data di apertura: la ricostruisco (una per ciclo)
  outer: for (const w of WALLETS) {
    for (const d of Object.values(st.dex[w.a] || {})) {
      for (const [coin, p] of Object.entries(d.pos || {})) {
        const k = w.a + "|" + coin;
        if (st.open[k] && st.open[k].dir === sgn(p.sz)) continue;
        if (SUB >= SUB_BUDGET - 4) break outer;
        const o = await findOpenTime(w.a, coin, sgn(p.sz), now);
        if (o) st.open[k] = o;
        break outer;
      }
    }
  }

  // 7. pulizia e salvataggio
  st.ev = st.ev.filter((e) => !e.final || now - e.t1 < KEEP_MS).slice(-600);
  st.sig = st.sig.filter((s) => now - s.t < KEEP_MS).slice(-400);
  if (sigOf(st) !== before || now - (st.savedAt || 0) > SAVE_EVERY) {
    st.savedAt = now;
    await env.KV.put(KEY, JSON.stringify(st));
  }

  return { ok: true, boot, subrequest: SUB, eventi: touched.size, segnali: st.sig.length, copy: Object.keys(st.copy.pos) };
}

/* ─────────── report settimanale: salute dei wallet ─────────── */

async function ritmo(addr) {
  const ora = Date.now();
  let start = ora - 370 * 864e5, fills = [], visti = new Set(), pagina = 0;
  while (pagina < 6) {
    const b = await hl({ type: "userFillsByTime", user: addr, startTime: start, aggregateByTime: true });
    for (const f of b) if (!visti.has(f.tid)) { visti.add(f.tid); fills.push(f); }
    pagina++;
    if (b.length < 2000) break;
    start = b[b.length - 1].time + 1;
  }
  if (!fills.length) return null;
  fills.sort((a, b) => a.time - b.time);
  const T60 = ora - 60 * 864e5, T240 = ora - 240 * 864e5;
  let r60 = 0, r240 = 0;
  const mesi = {};
  for (const f of fills) {
    const net = +f.closedPnl - +f.fee;
    if (f.time > T60) r60 += net;
    else if (f.time > T240) r240 += net;
    const k = new Date(f.time).toISOString().slice(0, 7);
    mesi[k] = (mesi[k] || 0) + net;
  }
  const giorni = (fills[fills.length - 1].time - fills[0].time) / 864e5;
  const prec = Math.min(180, Math.max(1, giorni - 60));
  const v = Object.values(mesi);
  return {
    decadimento: r240 > 0 ? (r60 / 60) / (r240 / prec) : (r60 > 0 ? 2 : 0),
    mesi: v.length, mesiPositivi: v.filter((x) => x > 0).length,
    ultimoTrade: fills[fills.length - 1].time,
  };
}

async function reportSalute(env) {
  SUB = 0;
  const righe = [];
  for (const w of WALLETS) {
    const r = await ritmo(w.a).catch(() => null);
    if (!r) { righe.push(`• <b>${w.n}</b> — nessun dato`); continue; }
    const gg = Math.round((Date.now() - r.ultimoTrade) / 864e5);
    const stato = r.decadimento >= 0.8 ? "in forma" : r.decadimento >= 0.45 ? "rallenta" : "⚠️ sotto soglia";
    righe.push(`• <b>${w.n}</b> — ${stato}\n   ritmo ${Math.round(r.decadimento * 100)}% · ${r.mesiPositivi}/${r.mesi} mesi in utile · ultimo trade ${gg} gg fa`);
  }
  await tgSend(env, `📉 <b>Salute dei wallet</b>\n${righe.join("\n")}\n\n<i>Il ritmo confronta il guadagno giornaliero degli ultimi 60 giorni con quello dei 180 precedenti.</i>`);
  return { ok: true, wallet: righe.length };
}

/* ─────────── API per la dashboard ─────────── */

async function stato(env) {
  const raw = await env.KV.get(KEY);
  const st = raw ? JSON.parse(raw) : empty();
  const now = Date.now();
  const wallet = WALLETS.map((w) => {
    const pos = [];
    for (const d of Object.values(st.dex?.[w.a] || {})) {
      for (const [coin, p] of Object.entries(d.pos || {})) {
        pos.push({ coin, ...p, mark: p.sz ? p.ntl / Math.abs(p.sz) : 0, open: st.open?.[w.a + "|" + coin] || null });
      }
    }
    pos.sort((x, y) => y.ntl - x.ntl);
    return { a: w.a, n: w.n, g: w.g, note: w.note, ref: !!w.ref, ...(w.g === "B" ? {} : rules(w.g === "A" ? "Cluster" : w.n)), eq: eqTot(st, w.a), pos, eqh: st.eqh?.[w.a] || [] };
  });
  const copy = Object.values(st.copy?.pos || {}).map((cp) => {
    const mark = markOf(st, cp.coin) || cp.entry;
    const pnl = copyPnl(cp, mark);
    return { ...cp, mark, pnl, ntl: cp.sz * mark, stopPx: cp.entry - cp.dir * ((cp.stop ?? STOP) * CAPITAL + cp.realized - cp.fund) / cp.sz };
  });
  return {
    v: 13, t: now,
    config: { capital: CAPITAL, copyFactor: COPY_FACTOR, stop: STOP, preStop: PRE_STOP, aggMs: AGG_MS, confirmMs: CONFIRM_MS },
    wallet, archivio: ARCHIVE,
    eventi: (st.ev || []).filter((e) => e.type && !e.quiet).slice(-300).reverse(),
    segnali: (st.sig || []).slice().reverse(),
    copy: { aperte: copy, chiuse: st.copy?.closed || [], realizzato: st.copy?.realized || 0 },
    consenso: Object.keys(st.cons || {}),
    pronto: now >= (st.readyAt || 0),
  };
}

/* ─────────── entry point ─────────── */

export default {
  async scheduled(event, env, ctx) {
    const ora = new Date(event.scheduledTime || Date.now());
    // lunedì alle 08:00 UTC il ciclo lascia il posto al report (troppe subrequest per farli insieme)
    if (ora.getUTCDay() === 1 && ora.getUTCHours() === 8 && ora.getUTCMinutes() === 0) ctx.waitUntil(reportSalute(env));
    else ctx.waitUntil(controlla(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    };
    const json = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: cors });

    if (url.pathname === "/health") return json({ ok: true, v: 13, wallet: WALLETS.map((w) => `${w.g} ${w.n}`), ora: new Date().toISOString() });
    if (url.pathname === "/state") return json(await stato(env));

    // protette da chiave: /check?key=…  /decay?key=…  /test?key=…
    if (["/check", "/decay", "/test"].includes(url.pathname)) {
      if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) return json({ errore: "chiave mancante o errata" }, 401);
      if (url.pathname === "/decay") return json(await reportSalute(env));
      if (url.pathname === "/test") {
        const id = await tgSend(env, `🟢 <b>APERTURA LONG</b> — Cluster-1 <i>· Cluster</i>\n<b>ETH</b> · 12.000 (29,1M $) @ 2.421,8\nLeva effettiva 2,1x · 210% dell'equity\n<i>messaggio di prova v13</i>`);
        return json({ ok: !!id });
      }
      return json(await controlla(env));
    }

    return json({ servizio: "Whale Desk v13", rotte: ["/health", "/state", "/check?key=…", "/decay?key=…", "/test?key=…"] });
  },
};
