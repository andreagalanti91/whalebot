/**
 * Whale Desk — server degli alert
 * Gira su Cloudflare Workers, cron ogni minuto.
 * Non serve un database: usa Workers KV per ricordare l'ultimo stato visto.
 */

const WALLETS = {
  "0x325edd95bb016c36027ce3b9f7595af7094a9564": "Metronomo",
  "0xac26cf5f3c46b5e102048c65b977d2551b72a9c7": "Orologiaio",
  "0x8fc7c0442e582bca195978c5a4fdec2e7c5bb0f7": "Ribassista",
};

const API = "https://api.hyperliquid.xyz/info";
const SOGLIA_VARIAZIONE = 0.03;   // ignora movimenti sotto il 3%
const SOGLIA_DECADIMENTO = 0.45;  // sotto il 45% del ritmo precedente = allarme
const DEXS = ["xyz","flx","vntl","hyna","km","abcd","cash","para","mkts","io"]; // perp dex builder-deployed (HIP-3)
const bareCoin = c => { const i = c.indexOf(":"); return i < 0 ? c : c.slice(i + 1); };

/* ─────────── utilità ─────────── */

const hl = (body) =>
  fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => {
    if (!r.ok) throw new Error("Hyperliquid HTTP " + r.status);
    return r.json();
  });

const kk = (n) => {
  const x = Math.abs(n);
  return (n < 0 ? "−" : "") + "$" +
    (x >= 1e6 ? (x / 1e6).toFixed(2) + "M" : x >= 1e3 ? (x / 1e3).toFixed(1) + "k" : x.toFixed(0));
};

async function telegram(env, text) {
  if (!env.TG_TOKEN || !env.TG_CHAT) return;
  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TG_CHAT,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  }).catch(() => {});
}

/* ─────────── 1. movimenti dei singoli wallet ─────────── */

async function snapshot(addr) {
  // mercato standard + tutti i perp dex secondari, in un unico libro
  const jobs = [hl({ type: "clearinghouseState", user: addr })];
  for (const dx of DEXS) jobs.push(hl({ type: "clearinghouseState", user: addr, dex: dx }).catch(() => null));
  const res = await Promise.all(jobs);
  let eq = 0;
  const pos = {};
  res.forEach((st, i) => {
    if (!st || !st.marginSummary) return;
    eq += +st.marginSummary.accountValue || 0;
    const dex = i === 0 ? "" : DEXS[i - 1];
    for (const a of st.assetPositions) {
      const p = a.position;
      pos[p.coin] = { sz: +p.szi, val: +p.positionValue, lev: p.leverage.value, dex };
    }
  });
  const total = Object.values(pos).reduce((s, p) => s + p.val, 0);
  return { eq: eq || 1, total, lev: total / (eq || 1), pos, t: Date.now() };
}

function confronta(nick, vecchio, nuovo) {
  const righe = [];
  for (const [coin, p] of Object.entries(nuovo.pos)) {
    const o = vecchio.pos[coin];
    if (!o) {
      righe.push(`🟢 apre <b>${p.sz > 0 ? "long" : "short"} ${bareCoin(coin)}</b>${p.dex ? " (" + p.dex + ")" : ""} — ${kk(p.val)} a ${p.lev}x`);
      continue;
    }
    const d = (p.sz - o.sz) / Math.abs(o.sz || 1);
    if (Math.abs(d) > SOGLIA_VARIAZIONE) {
      const su = Math.abs(p.sz) > Math.abs(o.sz);
      righe.push(`${su ? "🔼" : "🔽"} ${su ? "incrementa" : "riduce"} <b>${bareCoin(coin)}</b> del ${Math.abs(d * 100).toFixed(0)}% — ora ${kk(p.val)}`);
    }
  }
  for (const [coin, o] of Object.entries(vecchio.pos)) {
    if (!nuovo.pos[coin]) righe.push(`🔴 chiude tutta <b>${bareCoin(coin)}</b> — era ${kk(o.val)}`);
  }
  return righe;
}

/* ─────────── 2. consenso tra i wallet ─────────── */

function consenso(snaps) {
  const per = {};
  for (const [addr, s] of Object.entries(snaps)) {
    if (!s) continue;
    for (const [coin, p] of Object.entries(s.pos)) {
      if (p.val < 1000) continue; // ignora le briciole
      const key = bareCoin(coin);
      (per[key] ||= []).push({ nick: WALLETS[addr], dir: p.sz > 0 ? "L" : "S", val: p.val });
    }
  }
  const out = {};
  for (const [coin, lista] of Object.entries(per)) {
    if (lista.length < 2) continue;
    const dirs = new Set(lista.map((x) => x.dir));
    out[coin] = {
      n: lista.length,
      stato: dirs.size === 1 ? (lista[0].dir === "L" ? "long" : "short") : "conflitto",
      chi: lista.map((x) => `${x.nick} ${x.dir === "L" ? "long" : "short"}`).join(", "),
    };
  }
  return out;
}

function confrontaConsenso(vecchio, nuovo) {
  const righe = [];
  for (const [coin, c] of Object.entries(nuovo)) {
    const o = vecchio[coin];
    if (!o) {
      righe.push(`✳️ nuovo allineamento su <b>${coin}</b>: ${c.stato === "conflitto" ? "sono in disaccordo" : `${c.n} wallet ${c.stato}`}\n   <i>${c.chi}</i>`);
    } else if (o.stato !== c.stato) {
      righe.push(`🔀 <b>${coin}</b>: da «${o.stato}» a «${c.stato}»\n   <i>${c.chi}</i>`);
    } else if (o.n !== c.n) {
      righe.push(`${c.n > o.n ? "➕" : "➖"} <b>${coin}</b>: ora ${c.n} wallet ${c.stato} (erano ${o.n})\n   <i>${c.chi}</i>`);
    }
  }
  for (const coin of Object.keys(vecchio)) {
    if (!nuovo[coin]) righe.push(`⬜️ si scioglie l'allineamento su <b>${coin}</b>`);
  }
  return righe;
}

/* ─────────── 3. decadimento dell'edge ─────────── */

async function ritmo(addr) {
  const ora = Date.now();
  let start = ora - 370 * 864e5, fills = [], visti = new Set(), pagina = 0;
  while (pagina < 7) {
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
    const d = new Date(f.time);
    const k = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
    mesi[k] = (mesi[k] || 0) + net;
  }
  const giorni = (fills[fills.length - 1].time - fills[0].time) / 864e5;
  const prec = Math.min(180, Math.max(1, giorni - 60));
  const v = Object.values(mesi);
  return {
    decadimento: r240 > 0 ? (r60 / 60) / (r240 / prec) : (r60 > 0 ? 2 : 0),
    pnl60: r60,
    mesi: v.length,
    mesiPositivi: v.filter((x) => x > 0).length,
    ultimoTrade: fills[fills.length - 1].time,
  };
}

/* ─────────── ciclo principale ─────────── */

async function controlla(env, forzaReport = false) {
  const snaps = {}, messaggi = [];

  for (const [addr, nick] of Object.entries(WALLETS)) {
    let nuovo;
    try { nuovo = await snapshot(addr); } catch { continue; }
    snaps[addr] = nuovo;
    const grezzo = await env.KV.get("pos:" + addr);
    const vecchio = grezzo ? JSON.parse(grezzo) : null;
    if (vecchio) {
      const righe = confronta(nick, vecchio, nuovo);
      if (righe.length) {
        messaggi.push(`🔶 <b>${nick}</b>\n${righe.join("\n")}\n<i>esposizione ${kk(nuovo.total)} · leva ${nuovo.lev.toFixed(2)}x</i>`);
      }
    }
    await env.KV.put("pos:" + addr, JSON.stringify(nuovo));
  }

  const cNuovo = consenso(snaps);
  const cGrezzo = await env.KV.get("cons");
  const cVecchio = cGrezzo ? JSON.parse(cGrezzo) : null;
  if (cVecchio) {
    const righe = confrontaConsenso(cVecchio, cNuovo);
    if (righe.length) messaggi.push(`🧭 <b>Consenso</b>\n${righe.join("\n")}`);
  }
  await env.KV.put("cons", JSON.stringify(cNuovo));

  for (const m of messaggi) {
    await telegram(env, m);
    await new Promise((r) => setTimeout(r, 400));
  }

  // report settimanale sul decadimento: lunedì alle 8 UTC, o forzato da /decay
  const ora = new Date();
  const seTocca = ora.getUTCDay() === 1 && ora.getUTCHours() === 8 && ora.getUTCMinutes() < 2;
  if (seTocca || forzaReport) {
    const fatto = await env.KV.get("decay:ultimo");
    const oggi = ora.toISOString().slice(0, 10);
    if (forzaReport || fatto !== oggi) {
      const righe = [];
      for (const [addr, nick] of Object.entries(WALLETS)) {
        const r = await ritmo(addr).catch(() => null);
        if (!r) { righe.push(`• <b>${nick}</b> — nessun dato`); continue; }
        const gg = Math.round((Date.now() - r.ultimoTrade) / 864e5);
        const stato = r.decadimento >= 0.8 ? "in forma"
          : r.decadimento >= SOGLIA_DECADIMENTO ? "rallenta" : "⚠️ sotto soglia";
        righe.push(`• <b>${nick}</b> — ${stato}\n   ritmo ${Math.round(r.decadimento * 100)}% · ${r.mesiPositivi}/${r.mesi} mesi in utile · ultimo trade ${gg} gg fa`);
      }
      await telegram(env, `📉 <b>Salute dei wallet</b>\n${righe.join("\n")}\n\n<i>Il ritmo confronta il guadagno giornaliero degli ultimi 60 giorni con quello dei 180 precedenti.</i>`);
      await env.KV.put("decay:ultimo", oggi);
    }
  }

  return { wallet: Object.keys(snaps).length, messaggi: messaggi.length, consenso: cNuovo };
}

/* ─────────── entry point ─────────── */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(controlla(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    };

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, wallet: WALLETS, ora: new Date().toISOString() }, null, 2), { headers: cors });
    }

    if (url.pathname === "/state") {
      const out = {};
      for (const addr of Object.keys(WALLETS)) {
        const s = await env.KV.get("pos:" + addr);
        out[WALLETS[addr]] = s ? JSON.parse(s) : null;
      }
      const c = await env.KV.get("cons");
      return new Response(JSON.stringify({ wallet: out, consenso: c ? JSON.parse(c) : {} }, null, 2), { headers: cors });
    }

    // protette da chiave: /check?key=…  e  /decay?key=…
    if (url.pathname === "/check" || url.pathname === "/decay") {
      if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) {
        return new Response(JSON.stringify({ errore: "chiave mancante o errata" }), { status: 401, headers: cors });
      }
      const r = await controlla(env, url.pathname === "/decay");
      return new Response(JSON.stringify(r, null, 2), { headers: cors });
    }

    return new Response(JSON.stringify({
      servizio: "Whale Desk",
      rotte: ["/health", "/state", "/check?key=…", "/decay?key=…"],
    }, null, 2), { headers: cors });
  },
};
