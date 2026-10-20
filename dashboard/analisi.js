/**
 * Whale Desk — analisi tecnica multi-timeframe
 *
 * Modulo puro (niente fetch, niente DOM): lo usano sia il Worker (route /analisi, Telegram)
 * sia la dashboard (tab Struttura). Riceve candele Hyperliquid e restituisce:
 *  - per ogni timeframe due gradi di struttura: swing (principale) e interna (breve),
 *    con swing etichettati HH/HL/LH/LL e rotture BOS/CHoCH confermate in chiusura;
 *  - il Fibonacci dell'ultimo impulso swing e dove si trova il prezzo (es. 0,75);
 *  - livelli chiave da tutti i timeframe, con le confluenze (swing + Fib, più timeframe);
 *  - RSI con divergenze, volume impulso vs correzione, ATR;
 *  - una sintesi aggregata pesata per timeframe e gli scenari con trigger e invalidazione.
 */

/* ─────────── configurazione ─────────── */

// k = candele per lato che servono a confermare un massimo/minimo
export const TIMEFRAMES = [
  { tf: "15m", ms: 15 * 60e3, n: 500, kInt: 3, kSw: 10, w: 0.5, nome: "15 min" },
  { tf: "1h", ms: 3600e3, n: 500, kInt: 3, kSw: 10, w: 1, nome: "1 ora" },
  { tf: "4h", ms: 4 * 3600e3, n: 500, kInt: 3, kSw: 10, w: 2, nome: "4 ore" },
  { tf: "1d", ms: 864e5, n: 500, kInt: 3, kSw: 10, w: 3, nome: "Giornaliero" },
  { tf: "1w", ms: 7 * 864e5, n: 300, kInt: 2, kSw: 6, w: 3, nome: "Settimanale" },
];

export const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.705, 0.75, 0.786, 1, 1.272, 1.618];
export const FIB_EXT = [-0.272, -0.618]; // oltre l'estremo dell'impulso: obiettivi di continuazione

export const WATCHLIST = ["BTC", "ETH", "SOL", "HYPE", "LINK"];

// "link" → "LINK", "XYZ:xyz100" → "xyz:XYZ100"; i nomi con minuscole volute (kPEPE) restano come sono
export function normCoin(c) {
  c = String(c || "").trim();
  const i = c.indexOf(":");
  if (i >= 0) return c.slice(0, i).toLowerCase() + ":" + c.slice(i + 1).toUpperCase();
  return c === c.toLowerCase() ? c.toUpperCase() : c;
}

/* ─────────── dati ─────────── */

// richieste candleSnapshot da passare all'API info di Hyperliquid, una per timeframe
export function richieste(coin, now = Date.now(), tfs = TIMEFRAMES) {
  return tfs.map((c) => ({
    tf: c.tf,
    body: { type: "candleSnapshot", req: { coin, interval: c.tf, startTime: now - c.n * c.ms, endTime: now } },
  }));
}

export const parseCandele = (raw) =>
  (raw || []).map((c) => ({ t: c.t, T: c.T, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v })).filter((c) => c.h > 0);

/* ─────────── indicatori ─────────── */

function atr(cs, n = 14) {
  if (cs.length < 2) return 0;
  let a = 0;
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
    a = i <= n ? a + tr / n : (a * (n - 1) + tr) / n;
  }
  return a;
}

// RSI di Wilder, un valore per candela (null finché non ci sono abbastanza dati)
function rsi(cs, n = 14) {
  const out = new Array(cs.length).fill(null);
  let up = 0, dn = 0;
  for (let i = 1; i < cs.length; i++) {
    const d = cs[i].c - cs[i - 1].c, u = Math.max(d, 0), g = Math.max(-d, 0);
    if (i <= n) { up += u / n; dn += g / n; if (i < n) continue; }
    else { up = (up * (n - 1) + u) / n; dn = (dn * (n - 1) + g) / n; }
    out[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
  }
  return out;
}

/* ─────────── swing e struttura ─────────── */

// massimi e minimi confermati da k candele per lato (pareggi a destra ammessi, così un doppio top conta una volta)
function pivot(cs, k) {
  const out = [];
  for (let i = k; i < cs.length - k; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= k && (hi || lo); j++) {
      if (cs[i - j].h >= cs[i].h || cs[i + j].h > cs[i].h) hi = false;
      if (cs[i - j].l <= cs[i].l || cs[i + j].l < cs[i].l) lo = false;
    }
    const bear = cs[i].c < cs[i].o; // su una candela che fa entrambi, l'ordine segue il colore
    const add = (tipo) => out.push({ tipo, i, t: cs[i].t, p: tipo === "H" ? cs[i].h : cs[i].l, conf: i + k });
    if (hi && lo) { if (bear) { add("H"); add("L"); } else { add("L"); add("H"); } }
    else if (hi) add("H");
    else if (lo) add("L");
  }
  return out;
}

// sequenza alternata massimo/minimo (tiene l'estremo quando due dello stesso tipo sono consecutivi) ed etichette
function zigzag(pv) {
  const z = [];
  for (const p of pv) {
    const last = z[z.length - 1];
    if (last && last.tipo === p.tipo) {
      if ((p.tipo === "H" && p.p > last.p) || (p.tipo === "L" && p.p < last.p)) z[z.length - 1] = { ...p };
    } else z.push({ ...p });
  }
  const prev = { H: null, L: null };
  for (const p of z) {
    const q = prev[p.tipo];
    p.lab = !q ? p.tipo : p.tipo === "H" ? (p.p > q.p ? "HH" : "LH") : (p.p > q.p ? "HL" : "LL");
    prev[p.tipo] = p;
  }
  return z;
}

// direzione dalle etichette: ultimi due swing
function trendDaEtichette(z) {
  const h = z.filter((p) => p.tipo === "H").slice(-1)[0], l = z.filter((p) => p.tipo === "L").slice(-1)[0];
  if (!h || !l || h.lab.length < 2 || l.lab.length < 2) return 0;
  if (h.lab === "HH" && l.lab === "HL") return 1;
  if (h.lab === "LH" && l.lab === "LL") return -1;
  return 0;
}

/**
 * Rotture di struttura su candele chiuse.
 * Chiusura sopra l'ultimo massimo confermato: BOS se si era già rialzisti, CHoCH se si era ribassisti.
 * A ogni rottura si registra il livello "protetto" (il minimo da cui è partita la spinta, o il massimo per i ribassi):
 * è l'invalidazione del trend e l'origine del Fibonacci.
 */
function struttura(cs, k) {
  const pv = pivot(cs, k);
  let stato = 0, lastH = null, lastL = null, prot = null, pi = 0;
  const eventi = [];
  for (let j = 0; j < cs.length; j++) {
    while (pi < pv.length && pv[pi].conf <= j) {
      const p = pv[pi++];
      if (p.tipo === "H") lastH = { ...p, rotto: false }; else lastL = { ...p, rotto: false };
    }
    const c = cs[j].c;
    if (lastH && !lastH.rotto && c > lastH.p) {
      lastH.rotto = true;
      let m = lastH.i;
      for (let x = lastH.i; x <= j; x++) if (cs[x].l < cs[m].l) m = x;
      eventi.push({ tipo: stato < 0 ? "CHoCH" : "BOS", dir: 1, livello: lastH.p, t: cs[j].t, i: j });
      stato = 1;
      prot = { p: cs[m].l, i: m, t: cs[m].t };
    } else if (lastL && !lastL.rotto && c < lastL.p) {
      lastL.rotto = true;
      let m = lastL.i;
      for (let x = lastL.i; x <= j; x++) if (cs[x].h > cs[m].h) m = x;
      eventi.push({ tipo: stato > 0 ? "CHoCH" : "BOS", dir: -1, livello: lastL.p, t: cs[j].t, i: j });
      stato = -1;
      prot = { p: cs[m].h, i: m, t: cs[m].t };
    }
  }
  const z = zigzag(pv);
  if (!stato) stato = trendDaEtichette(z);
  return { stato, eventi, prot, lastH, lastL, swing: z };
}

/* ─────────── Fibonacci dell'ultimo impulso ─────────── */

function fibonacci(cs, s, prezzo) {
  if (!s.prot || !s.stato) return null;
  const dir = s.stato;
  let ext = s.prot.i;
  for (let x = s.prot.i; x < cs.length; x++) {
    if (dir > 0 ? cs[x].h > cs[ext].h : cs[x].l < cs[ext].l) ext = x;
  }
  const da = s.prot.p, a = dir > 0 ? cs[ext].h : cs[ext].l, range = Math.abs(a - da);
  if (!range) return null;
  const livello = (f) => a - dir * f * range; // 0 = estremo dell'impulso, 1 = origine
  const r = dir > 0 ? (a - prezzo) / range : (prezzo - a) / range;
  return {
    dir, da, a, tDa: s.prot.t, tA: cs[ext].t,
    r, zona: zonaFib(r),
    livelli: FIB.map((f) => ({ f, p: livello(f) })),
    estensioni: FIB_EXT.map((f) => ({ f, p: livello(f) })),
    // volume medio: impulso contro correzione
    volImpulso: media(cs.slice(s.prot.i, ext + 1).map((c) => c.v)),
    volCorrezione: ext < cs.length - 1 ? media(cs.slice(ext + 1).map((c) => c.v)) : null,
  };
}

export function zonaFib(r) {
  if (r < 0) return { k: "oltre", nome: "oltre l'estremo: impulso in estensione" };
  if (r < 0.382) return { k: "leggero", nome: "ritracciamento leggero: trend forte" };
  if (r < 0.618) return { k: "sano", nome: "ritracciamento sano (area 0,5)" };
  if (r < 0.786) return { k: "ote", nome: "ritracciamento profondo, zona OTE 0,62–0,79" };
  if (r <= 1) return { k: "difesa", nome: "ultima difesa prima dell'origine dell'impulso" };
  return { k: "rotto", nome: "oltre l'origine: impulso invalidato" };
}

const media = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

/* ─────────── divergenze RSI sugli ultimi due swing interni ─────────── */

function divergenza(cs, z, rs, k) {
  const recente = (p) => cs.length - 1 - p.i <= 6 * k + 4;
  const L = z.filter((p) => p.tipo === "L").slice(-2), H = z.filter((p) => p.tipo === "H").slice(-2);
  if (L.length === 2 && recente(L[1]) && L[1].p < L[0].p && rs[L[1].i] != null && rs[L[0].i] != null && rs[L[1].i] > rs[L[0].i])
    return { dir: 1, nome: "divergenza rialzista: prezzo fa un minimo più basso, RSI no" };
  if (H.length === 2 && recente(H[1]) && H[1].p > H[0].p && rs[H[1].i] != null && rs[H[0].i] != null && rs[H[1].i] < rs[H[0].i])
    return { dir: -1, nome: "divergenza ribassista: prezzo fa un massimo più alto, RSI no" };
  return null;
}

/* ─────────── un timeframe ─────────── */

export function fase(sw, int) {
  if (sw > 0 && int > 0) return { k: "rialzista", nome: "Rialzista" };
  if (sw > 0 && int < 0) return { k: "correzione", nome: "Correzione in uptrend" };
  if (sw < 0 && int < 0) return { k: "ribassista", nome: "Ribassista" };
  if (sw < 0 && int > 0) return { k: "rimbalzo", nome: "Rimbalzo in downtrend" };
  if (int > 0) return { k: "laterale+", nome: "Laterale, spinta rialzista" };
  if (int < 0) return { k: "laterale-", nome: "Laterale, spinta ribassista" };
  return { k: "laterale", nome: "Laterale" };
}

export function analizzaTF(raw, cfg, now = Date.now()) {
  const tutte = Array.isArray(raw) && raw.length && raw[0].o != null && typeof raw[0].o === "number" ? raw : parseCandele(raw);
  if (tutte.length < 3 * cfg.kSw) return { tf: cfg.tf, nome: cfg.nome, w: cfg.w, ok: false, n: tutte.length };
  const ultima = tutte[tutte.length - 1];
  const chiuse = ultima.T >= now ? tutte.slice(0, -1) : tutte; // le rotture contano solo in chiusura
  const prezzo = ultima.c;
  const sw = struttura(chiuse, cfg.kSw), int = struttura(chiuse, cfg.kInt);
  const rs = rsi(tutte);
  const f = fase(sw.stato, int.stato);
  // nel Fibonacci entra anche la candela in corso, per estremo e posizione del prezzo
  const fib = fibonacci(tutte, sw, prezzo);
  const fibInt = fibonacci(tutte, int, prezzo);
  const ultimo = (e) => (e.length ? e[e.length - 1] : null);
  return {
    tf: cfg.tf, nome: cfg.nome, w: cfg.w, ok: true, n: tutte.length,
    prezzo, atr: atr(chiuse), rsi: rs[rs.length - 1],
    fase: f,
    punteggio: 0.65 * sw.stato + 0.35 * int.stato,
    swing: {
      stato: sw.stato, ultimaRottura: ultimo(sw.eventi), protetto: sw.prot,
      massimo: sw.lastH && { p: sw.lastH.p, t: sw.lastH.t, rotto: sw.lastH.rotto },
      minimo: sw.lastL && { p: sw.lastL.p, t: sw.lastL.t, rotto: sw.lastL.rotto },
      sequenza: sw.swing.slice(-8).map(({ tipo, lab, p, t }) => ({ tipo, lab, p, t })),
    },
    interna: {
      stato: int.stato, ultimaRottura: ultimo(int.eventi), protetto: int.prot,
      massimo: int.lastH && { p: int.lastH.p, t: int.lastH.t, rotto: int.lastH.rotto },
      minimo: int.lastL && { p: int.lastL.p, t: int.lastL.t, rotto: int.lastL.rotto },
      sequenza: int.swing.slice(-8).map(({ tipo, lab, p, t }) => ({ tipo, lab, p, t })),
    },
    fib, fibInt,
    divergenza: divergenza(tutte, int.swing, rs, cfg.kInt),
    candele: tutte.slice(-160), // per il grafico in dashboard
  };
}

/* ─────────── livelli chiave e confluenze ─────────── */

function livelliChiave(tfs, prezzo) {
  const d1 = tfs.find((x) => x.tf === "1d" && x.ok) || tfs.filter((x) => x.ok).slice(-1)[0];
  const tol = Math.max((d1?.atr || 0) * 0.25, prezzo * 0.003); // zone larghe al massimo 2 × tol
  const fonti = [];
  for (const x of tfs) {
    if (!x.ok || x.w < 1) continue; // il 15 min è rumore per i livelli
    for (const [grado, peso] of [["swing", 1.5], ["interna", 1]]) {
      for (const p of x[grado].sequenza) {
        if (Math.abs(p.p - prezzo) / prezzo > 0.35) continue;
        fonti.push({ p: p.p, peso: x.w * peso, cat: "swing", tf: x.tf, txt: `${p.lab} ${x.tf}${grado === "interna" ? " int." : ""}` });
      }
    }
    if (x.fib && x.w >= 2) {
      for (const l of x.fib.livelli) {
        if (![0.382, 0.5, 0.618, 0.75, 0.786, 1].includes(l.f)) continue;
        fonti.push({ p: l.p, peso: x.w * (l.f === 0.618 || l.f === 0.75 || l.f === 0.786 ? 0.9 : 0.6), cat: "fib", tf: x.tf, txt: `Fib ${nf(l.f, l.f === 1 ? 0 : 3)} ${x.tf}` });
      }
    }
  }
  fonti.sort((a, b) => a.p - b.p);
  const gruppi = [];
  for (const f of fonti) {
    const g = gruppi[gruppi.length - 1];
    if (g && f.p - g.max <= tol && f.p - g.min <= 2 * tol) { g.fonti.push(f); g.max = f.p; }
    else gruppi.push({ min: f.p, max: f.p, fonti: [f] });
  }
  return gruppi.map((g) => {
    const peso = g.fonti.reduce((s, f) => s + f.peso, 0);
    const p = g.fonti.reduce((s, f) => s + f.p * f.peso, 0) / peso;
    const cat = new Set(g.fonti.map((f) => f.cat));
    const tf = new Set(g.fonti.map((f) => f.tf));
    return {
      p, da: g.min, a: g.max, forza: Math.round(peso * 10) / 10,
      confluenza: cat.size > 1 || tf.size > 1,
      fonti: [...new Set(g.fonti.map((f) => f.txt))],
      lato: p < prezzo - tol / 2 ? "supporto" : p > prezzo + tol / 2 ? "resistenza" : "prezzo",
    };
  }).filter((l) => l.forza >= 2.5);
}

/* ─────────── sintesi e scenari ─────────── */

export function analizza(coin, perTf, now = Date.now()) {
  const tfs = TIMEFRAMES.map((cfg) => analizzaTF(perTf[cfg.tf] || [], cfg, now));
  const ok = tfs.filter((x) => x.ok);
  if (!ok.length) return { coin, t: now, ok: false, errore: "nessuna candela: coin inesistente o senza storico" };
  const prezzo = (tfs.find((x) => x.tf === "15m" && x.ok) || ok[0]).prezzo;
  const peso = ok.reduce((s, x) => s + x.w, 0);
  const punteggio = ok.reduce((s, x) => s + x.w * x.punteggio, 0) / peso;
  const T = Object.fromEntries(ok.map((x) => [x.tf, x]));
  const alto = ok.filter((x) => x.w >= 3), basso = ok.filter((x) => x.w <= 2 && x.w >= 1);
  // timeframe alti: struttura swing; bassi (4h, 1h): punteggio completo. Entrambi pesati.
  const soglia = (v) => (v > 0.2 ? 1 : v < -0.2 ? -1 : 0);
  const pesato = (xs, f) => (xs.length ? xs.reduce((s, x) => s + x.w * f(x), 0) / xs.reduce((s, x) => s + x.w, 0) : 0);
  const dirAlto = soglia(pesato(alto, (x) => x.swing.stato));
  const dirBasso = soglia(pesato(basso, (x) => x.punteggio));

  let quadro;
  if (dirAlto > 0 && dirBasso < 0) quadro = { k: "pullback-rialzista", nome: "Correzione dentro un trend rialzista" };
  else if (dirAlto < 0 && dirBasso > 0) quadro = { k: "rimbalzo-ribassista", nome: "Rimbalzo dentro un trend ribassista" };
  else if (dirAlto > 0 && dirBasso > 0) quadro = { k: "rialzista", nome: "Trend rialzista allineato" };
  else if (dirAlto < 0 && dirBasso < 0) quadro = { k: "ribassista", nome: "Trend ribassista allineato" };
  else if (dirAlto > 0) quadro = { k: "rialzista-pausa", nome: "Trend rialzista, breve senza direzione" };
  else if (dirAlto < 0) quadro = { k: "ribassista-pausa", nome: "Trend ribassista, breve senza direzione" };
  else quadro = { k: "misto", nome: "Quadro misto, senza direzione dominante" };

  const livelli = livelliChiave(tfs, prezzo);
  const supporti = livelli.filter((l) => l.lato === "supporto").sort((a, b) => b.p - a.p).slice(0, 4);
  const resistenze = livelli.filter((l) => l.lato === "resistenza").sort((a, b) => a.p - b.p).slice(0, 4);
  const alPrezzo = livelli.filter((l) => l.lato === "prezzo");

  // timeframe di riferimento: daily per il quadro, 4h per i trigger
  const ref = T["1d"] || T["1w"] || ok[ok.length - 1];
  const trig = T["4h"] || T["1h"] || ref;
  const scenari = costruisciScenari(ref, trig, prezzo,
    livelli.filter((l) => l.lato === "supporto").sort((a, b) => b.p - a.p),
    livelli.filter((l) => l.lato === "resistenza").sort((a, b) => a.p - b.p));

  const note = [];
  if (ref.fib) note.push(`Prezzo a ${nf(ref.fib.r, 2)} del ritracciamento swing ${ref.tf} (${px(ref.fib.da)} → ${px(ref.fib.a)}): ${ref.fib.zona.nome}.`);
  const zona = [...alPrezzo, ...supporti.slice(0, 1)].find((l) => l.confluenza && Math.abs(l.p - prezzo) / prezzo < 0.03);
  if (zona) note.push(`Confluenza vicino al prezzo a ${px(zona.p)} (${px(zona.da)}–${px(zona.a)}): ${zona.fonti.slice(0, 4).join(", ").replace(/\.$/, "")}.`);
  for (const x of ok) if (x.divergenza && x.w >= 1) note.push(`${x.tf}: ${x.divergenza.nome}.`);
  if (ref.fib?.volCorrezione != null && ref.fib.volImpulso) {
    const q = ref.fib.volCorrezione / ref.fib.volImpulso;
    if (q < 0.8) note.push(`Volume ${ref.tf} in calo nella correzione (${nf(q * 100)}% di quello dell'impulso): pullback ordinato.`);
    else if (q > 1.2) note.push(`Volume ${ref.tf} più alto nella correzione che nell'impulso (${nf(q * 100)}%): pressione contraria in aumento.`);
  }

  return {
    coin, t: now, ok: true, prezzo,
    punteggio: Math.round(punteggio * 100) / 100,
    bias: punteggio > 0.45 ? "rialzista" : punteggio > 0.15 ? "moderatamente rialzista" : punteggio < -0.45 ? "ribassista" : punteggio < -0.15 ? "moderatamente ribassista" : "neutrale",
    quadro, timeframe: tfs, supporti, resistenze, alPrezzo, scenari, note,
  };
}

function costruisciScenari(ref, trig, prezzo, sup, res) {
  const dir = ref.swing.stato || ref.interna.stato || 1;
  const inv = ref.swing.protetto?.p ?? (dir > 0 ? ref.swing.minimo?.p : ref.swing.massimo?.p);
  // obiettivi: livelli forti oltre la soglia, chiusi dall'estremo dell'impulso swing quando è più lontano
  const estremo = ref.fib?.a;
  const conEstremo = (arr, d) => (estremo && arr.length < 3 && (d > 0 ? estremo > (arr[arr.length - 1] ?? -Infinity) * 1.01 : estremo < (arr[arr.length - 1] ?? Infinity) * 0.99) ? [...arr, estremo] : arr);
  const sopra = (p, conE) => { const a = res.filter((l) => l.p > p && l.forza >= 5).slice(0, 3).map((l) => l.p); return conE ? conEstremo(a, 1) : a; };
  const sotto = (p, conE) => { const a = sup.filter((l) => l.p < p && l.forza >= 5).slice(0, 3).map((l) => l.p); return conE ? conEstremo(a, -1) : a; };
  const trigSu = !trig.interna.massimo?.rotto ? trig.interna.massimo?.p : null;
  const trigGiu = !trig.interna.minimo?.rotto ? trig.interna.minimo?.p : null;
  const confSu = ref.interna.massimo && !ref.interna.massimo.rotto ? ref.interna.massimo.p : null;
  const confGiu = ref.interna.minimo && !ref.interna.minimo.rotto ? ref.interna.minimo.p : null;
  const s = [];
  if (dir > 0) {
    s.push({
      k: "rialzista", nome: "Ripartenza del trend",
      trigger: trigSu && trigSu > prezzo ? trigSu : null, tfTrigger: trig.tf,
      conferma: confSu && confSu > prezzo ? confSu : null, tfConferma: ref.tf,
      obiettivi: sopra(Math.max(prezzo, confSu || 0), ref.fib?.dir > 0),
    });
    s.push({
      k: "ribassista", nome: "Rottura della struttura " + ref.tf,
      trigger: sup[0]?.p ?? trigGiu, tfTrigger: ref.tf,
      invalidazione: inv, tfConferma: ref.tf,
      obiettivi: inv ? sotto(inv * 0.997) : [],
    });
  } else {
    s.push({
      k: "ribassista", nome: "Continuazione del ribasso",
      trigger: trigGiu && trigGiu < prezzo ? trigGiu : null, tfTrigger: trig.tf,
      conferma: confGiu && confGiu < prezzo ? confGiu : null, tfConferma: ref.tf,
      obiettivi: sotto(Math.min(prezzo, confGiu || Infinity), ref.fib?.dir < 0),
    });
    s.push({
      k: "rialzista", nome: "Inversione della struttura " + ref.tf,
      trigger: res[0]?.p ?? trigSu, tfTrigger: ref.tf,
      invalidazione: inv, tfConferma: ref.tf,
      obiettivi: inv ? sopra(inv * 1.003) : [],
    });
  }
  return { dir, invalidazione: inv, lista: s };
}

/* ─────────── testo (Telegram e copia veloce) ─────────── */

export function nf(n, d = 0) {
  if (n == null || !isFinite(n)) return "–";
  const [i, f] = Math.abs(n).toFixed(d).split(".");
  return (n < 0 ? "−" : "") + i.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (f ? "," + f : "");
}
export const px = (p) => (p == null ? "–" : nf(p, p >= 1000 ? 1 : p >= 10 ? 2 : p >= 1 ? 3 : 5));
const freccia = (s) => (s > 0 ? "↑" : s < 0 ? "↓" : "→");
const escH = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function testoTelegram(r) {
  if (!r.ok) return `📐 <b>${escH(r.coin)}</b>: ${escH(r.errore)}`;
  const L = [`📐 <b>STRUTTURA ${escH(r.coin)}</b> · ${px(r.prezzo)}`, `<b>${escH(r.quadro.nome)}</b> · bias ${r.bias} (${nf(r.punteggio, 2)})`, ""];
  for (const x of r.timeframe) {
    if (!x.ok) continue;
    const rot = x.swing.ultimaRottura;
    L.push(`<code>${x.tf.padEnd(3)}</code> ${freccia(x.swing.stato)}${freccia(x.interna.stato)} ${escH(x.fase.nome)}` +
      (x.fib ? ` · Fib ${nf(x.fib.r, 2)}` : "") + (rot ? ` · ${rot.tipo} ${px(rot.livello)}` : ""));
  }
  const lv = (l) => `${px(l.p)}${l.confluenza ? " ★" : ""}`;
  if (r.resistenze.length) L.push("", `Resistenze: ${r.resistenze.slice(0, 3).map(lv).join(" · ")}`);
  if (r.supporti.length) L.push(`Supporti: ${r.supporti.slice(0, 3).map(lv).join(" · ")}`);
  if (r.note.length) L.push("", ...r.note.map((n) => "• " + escH(n)));
  L.push("");
  for (const s of r.scenari.lista) L.push(`${s.k === "rialzista" ? "🟢" : "🔴"} ${escH(testoScenario(s))}`);
  L.push("", "<i>↑↓ = swing / interna · ★ = confluenza · lettura tecnica, non consulenza</i>");
  return L.join("\n");
}

export function testoScenario(s) {
  const parti = [s.nome + ":"];
  if (s.trigger) parti.push(`chiusura ${s.tfTrigger} ${s.k === "rialzista" ? "sopra" : "sotto"} ${px(s.trigger)}`);
  if (s.conferma) parti.push(`conferma ${s.tfConferma} oltre ${px(s.conferma)}`);
  if (s.invalidazione) parti.push(`la struttura cede con chiusura ${s.tfConferma} ${s.k === "rialzista" ? "sopra" : "sotto"} ${px(s.invalidazione)}`);
  if (s.obiettivi?.length) parti.push(`obiettivi ${s.obiettivi.map(px).join(" → ")}`);
  if (parti.length === 1) parti.push("nessun livello utile nei dati disponibili");
  return parti.join(" · ").replace(": ·", ":");
}
