"use strict";
/* Ink Locker — personal Lorcana collection + deck tracker with "cards in use".
   Card data and images: Lorcast public API (loaded on this device). */

const API = "https://api.lorcast.com/v0";
const INKS = ["Amber", "Amethyst", "Emerald", "Ruby", "Sapphire", "Steel"];
const TYPE_ORDER = ["Character", "Action", "Song", "Item", "Location"];
const CARD_DATA_MAX_AGE = 3 * 24 * 3600 * 1000; // re-check for new cards every 3 days
const PAGE = 60;

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const key = n => String(n).toLowerCase().normalize("NFC").replace(/[–—]/g, "-").replace(/\s*-\s*/g, " - ").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
const cardKey = c => key(c.version ? `${c.name} - ${c.version}` : c.name);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const newId = () => "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ---------------- storage (IndexedDB key-value) ---------------- */
const store = (() => {
  let dbp;
  const open = () => dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open("ink-locker", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction("kv", mode); const s = t.objectStore("kv");
      const out = fn(s);
      t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: k => tx("readonly", s => s.get(k)).catch(() => undefined),
    set: (k, v) => tx("readwrite", s => s.put(v, k)),
  };
})();

/* ---------------- state ---------------- */
const S = {
  cards: [],            // slim card records, set order
  sets: [],             // [{code,name,released}]
  byKey: new Map(),     // key -> first printing (for names/images)
  dataAt: null,
  collection: null,     // {counts:{key:n}, names:{key:display}, at}
  decks: [],            // {id,name,built,cards:{key:qty},updated}
  filters: { q: "", inks: new Set(), set: "", type: "", own: "", costs: new Set() },
  addingTo: null,       // deck id while picking cards
  lastDeck: null,
  shown: PAGE,
  newKeys: new Set(),   // cards added by the latest update
  sheetKey: null,
};

function slim(c) {
  const img = c.image_uris?.digital || {};
  const inks = c.inks && c.inks.length ? c.inks : (c.ink ? [c.ink] : []);
  return {
    k: cardKey(c), id: c.id, name: c.name, version: c.version || "", inks,
    cost: c.cost ?? 0, inkwell: !!c.inkwell, type: c.type || [], cls: c.classifications || [],
    text: c.text || "", str: c.strength, will: c.willpower, lore: c.lore, move: c.move_cost,
    rarity: (c.rarity || "").replace(/_/g, " "), set: c.set?.code || "", setName: c.set?.name || "",
    num: c.collector_number || "", sm: img.small || "", md: img.normal || img.large || "",
  };
}

function indexCards() {
  S.byKey = new Map();
  for (const c of S.cards) if (!S.byKey.has(c.k)) S.byKey.set(c.k, c);
}

/* ---------------- card data download ---------------- */
async function fetchJSON(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} from card service`);
  return r.json();
}

let updating = false;
async function downloadCards({ silent, manual } = {}) {
  if (updating) return false;
  updating = true;
  const box = $("#loading"); const bar = $("#loadBar"); const msg = $("#loadMsg");
  const btn = $("#updateBtn"), label = $("#updateLabel");
  if (!silent && !manual) box.hidden = false;
  btn.disabled = true; btn.classList.add("busy"); label.textContent = "Checking…";
  try {
    const sj = await fetchJSON(`${API}/sets`);
    const sets = (sj.results || sj).map(s => ({ code: s.code, name: s.name, released: s.released_at || s.prereleased_at || "" }))
      .sort((a, b) => (a.released || "9").localeCompare(b.released || "9"));
    const all = [];
    for (let i = 0; i < sets.length; i++) {
      msg.textContent = `Downloading ${sets[i].name}… (${i + 1} of ${sets.length})`;
      label.textContent = `${i + 1}/${sets.length}`;
      bar.style.width = `${Math.round((i / sets.length) * 100)}%`;
      const cj = await fetchJSON(`${API}/sets/${encodeURIComponent(sets[i].code)}/cards`);
      for (const c of (cj.results || cj)) all.push(slim(c));
      await sleep(110); // be polite to the free card service
    }
    bar.style.width = "100%";
    const oldKeys = new Set(S.byKey.keys()), oldSets = new Set(S.sets.map(s => s.code));
    S.cards = all; S.sets = sets; S.dataAt = Date.now();
    indexCards();
    await store.set("cards", { cards: all, sets, at: S.dataAt });
    if (oldKeys.size) {
      const added = [...S.byKey.keys()].filter(k => !oldKeys.has(k));
      const newSets = sets.filter(s => !oldSets.has(s.code)).map(s => s.name);
      if (added.length) {
        S.newKeys = new Set(added);
        await store.set("newKeys", added).catch(() => {});
        toast(`${added.length} new card${added.length === 1 ? "" : "s"} added${newSets.length ? ` from ${newSets.join(", ")}` : ""}. Filter by \"Newly added\" to see them.`);
      } else if (manual) toast("You're up to date. No new cards yet.");
    }
    return true;
  } catch (e) {
    if (!silent) toast(navigator.onLine ? "Couldn't reach the card list. Try again in a minute." : "You're offline. Connect once to download the card list.");
    return false;
  } finally {
    box.hidden = true; updating = false;
    btn.disabled = false; btn.classList.remove("busy"); label.textContent = "Update";
    renderAll();
  }
}

/* ---------------- collection import (Dreamborn export or "4 Name") ---------------- */
function splitCSV(line) {
  const r = []; let c = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { r.push(c); c = ""; } else c += ch;
  }
  r.push(c); return r.map(s => s.trim());
}
function parseList(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim(); if (!l || /^(\/\/|#)/.test(l)) continue;
    let m = l.match(/^(\d+)\s*x?\s+(.+)$/i), q = 1, n = l;
    if (m) { q = +m[1]; n = m[2]; } else if ((m = l.match(/^(.+?)\s+x?(\d+)$/i))) { n = m[1]; q = +m[2]; }
    n = n.replace(/\s+/g, " ").trim(); const k = key(n);
    const cur = out.get(k); out.set(k, { n: cur ? cur.n : n, k, q: (cur ? cur.q : 0) + q });
  }
  return [...out.values()];
}
function parseCollection(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim()); if (!lines.length) return null;
  const counts = {}, names = {};
  const add = (n, q) => { if (!n || !q) return; const k = key(n); counts[k] = (counts[k] || 0) + q; names[k] ||= n; };
  const head = splitCSV(lines[0]).map(h => h.toLowerCase());
  const ni = head.findIndex(h => /^(name|card ?name|card)$/.test(h));
  if (lines[0].includes(",") && ni >= 0) {
    const vi = head.findIndex(h => /version|subtitle|title/.test(h) && h !== "name");
    const qcols = head.map((h, i) => /^(count|quantity|qty|amount|normal|non-?foil|foil|regular)/.test(h) ? i : -1).filter(i => i >= 0);
    for (const l of lines.slice(1)) {
      const c = splitCSV(l); let n = c[ni] || "";
      if (vi >= 0 && c[vi] && !n.includes(" - ")) n += " - " + c[vi];
      const q = qcols.length ? qcols.reduce((s, i) => s + (parseInt(c[i]) || 0), 0) : 1; add(n, q);
    }
  } else for (const p of parseList(text)) add(p.n, p.q);
  return Object.keys(counts).length ? { counts, names, at: Date.now() } : null;
}

/* ---------------- "cards in use" math ---------------- */
function usage() { // key -> {tied, decks:[{d,q}]}
  const m = new Map();
  for (const d of S.decks) for (const [k, q] of Object.entries(d.cards)) {
    if (!q) continue;
    if (!m.has(k)) m.set(k, { tied: 0, decks: [] });
    const e = m.get(k); e.decks.push({ d, q }); if (d.built) e.tied += q;
  }
  return m;
}
function own(k) { return S.collection ? (S.collection.counts[k] || 0) : null; }
function info(k, U = usage()) {
  const e = U.get(k) || { tied: 0, decks: [] };
  const o = own(k);
  return { own: o, tied: e.tied, decks: e.decks, free: o == null ? null : Math.max(0, o - e.tied), over: o != null && e.tied > o };
}
/* status of one card inside one deck */
function rowStatus(k, q, deck, U) {
  const i = info(k, U);
  if (i.own == null) return { cls: "muted", label: "No collection loaded" };
  const others = i.decks.filter(x => x.d.built && x.d.id !== deck.id);
  const usedElsewhere = others.reduce((s, x) => s + x.q, 0);
  const available = i.own - usedElsewhere;
  if (deck.built) {
    if (available >= q) return { cls: "ok", label: "Sleeved" };
    return { cls: "bad", label: i.own >= q ? `Also in ${others.map(x => x.d.name).join(", ")}` : `Own ${i.own} of ${q}` };
  }
  if (available >= q) return { cls: "ok", label: "Ready" };
  if (i.own >= q) return { cls: "warn", label: `Pull ${q - Math.max(0, available)} from ${others.map(x => x.d.name).join(", ")}` };
  return { cls: "bad", label: `Buy ${q - i.own}` };
}

/* ---------------- helpers for display ---------------- */
const cardOf = k => S.byKey.get(k);
const displayName = k => { const c = cardOf(k); return c ? (c.version ? `${c.name} - ${c.version}` : c.name) : (S.collection?.names[k] || k); };
function dotHTML(inks) {
  if (!inks || !inks.length) return `<span class="dot"></span>`;
  if (inks.length === 1) return `<span class="dot" style="--c:var(--${inks[0]})"></span>`;
  return `<span class="dot duo" style="--c1:var(--${inks[0]});--c2:var(--${inks[1]})"></span>`;
}
function deckInks(d) {
  const t = {};
  for (const [k, q] of Object.entries(d.cards)) { const c = cardOf(k); if (c) for (const ink of c.inks) t[ink] = (t[ink] || 0) + q; }
  return Object.entries(t).sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]);
}
const deckCount = d => Object.values(d.cards).reduce((s, q) => s + q, 0);
const stripe = inks => inks.length ? `linear-gradient(90deg,var(--${inks[0]}) 50%,var(--${inks[1] || inks[0]}) 50%)` : "var(--line)";
function toast(t) { const el = $("#toast"); el.textContent = t; el.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("on"), 2600); }
const save = () => store.set("decks", S.decks).catch(() => toast("Couldn't save. Your phone may be out of space."));

/* ---------------- CARDS view ---------------- */
function buildFilters() {
  $("#inkFilter").innerHTML = INKS.map(i => `<button type="button" class="inkbtn" style="--c:var(--${i})" data-ink="${i}" aria-pressed="${S.filters.inks.has(i)}" aria-label="${i}" title="${i}"><i></i></button>`).join("");
  const costs = ["1", "2", "3", "4", "5", "6", "7", "8", "9+"];
  $("#costFilter").innerHTML = costs.map(c => `<button type="button" class="costbtn" data-cost="${c}" aria-pressed="${S.filters.costs.has(c)}">${c}</button>`).join("");
  $("#setFilter").innerHTML = `<option value="">All sets</option>` + [...S.sets].reverse().map(s => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join("");
  $("#setFilter").value = S.filters.set;
}
function filtered() {
  const f = S.filters, q = key(f.q), U = usage();
  let list = S.cards;
  // one tile per name+version when not filtering by set (reprints collapse)
  if (!f.set) { const seen = new Set(); list = list.filter(c => !seen.has(c.k) && seen.add(c.k)); }
  return list.filter(c => {
    if (f.set && c.set !== f.set) return false;
    if (f.inks.size && !c.inks.some(i => f.inks.has(i))) return false;
    if (f.type && !c.type.includes(f.type)) return false;
    if (f.costs.size && !f.costs.has(c.cost >= 9 ? "9+" : String(c.cost))) return false;
    if (q && !(key(`${c.name} - ${c.version}`).includes(q) || key(c.text).includes(q) || c.cls.some(x => key(x) === q))) return false;
    if (f.own) {
      const i = info(c.k, U);
      if (f.own === "owned" && !(i.own > 0)) return false;
      if (f.own === "missing" && i.own !== 0) return false;
      if (f.own === "free" && !(i.free > 0)) return false;
      if (f.own === "inuse" && !(i.tied > 0)) return false;
      if (f.own === "new" && !S.newKeys.has(c.k)) return false;
    }
    return true;
  }).sort((a, b) => f.set ? (parseInt(a.num) || 0) - (parseInt(b.num) || 0) : 0);
}
function tileHTML(c, U, deck) {
  const i = info(c.k, U);
  let left = "", right = "";
  if (deck) { const q = deck.cards[c.k] || 0; if (q) left = `<span class="b use">${q} in deck</span>`; }
  else if (i.tied) left = `<span class="b use">${i.tied} in use</span>`;
  else if (S.newKeys.has(c.k)) left = `<span class="b new">New</span>`;
  if (i.own != null) right = i.own === 0 ? `<span class="b none">0</span>` : `<span class="b ${i.free ? "free" : ""}">${i.free}/${i.own}</span>`;
  return `<button type="button" class="tile${i.own === 0 ? " unowned" : ""}" data-k="${esc(c.k)}" aria-label="${esc(c.name)} ${esc(c.version)}">
    <div class="img"><div class="fallback">${esc(c.name)}</div>${c.sm ? `<img loading="lazy" decoding="async" src="${esc(c.sm)}" alt="" onerror="this.remove()">` : ""}${left || right ? `<div class="badges">${left || "<span></span>"}${right}</div>` : ""}</div>
    <div class="nm">${esc(c.name)}${c.version ? `<br><small>${esc(c.version)}</small>` : ""}</div></button>`;
}
function renderCards() {
  if (!S.cards.length) { $("#grid").innerHTML = `<div class="empty">The card list hasn't downloaded yet.<button type="button" class="btn primary" id="dlNow">Download cards</button></div>`; $("#resultCount").textContent = ""; $("#dlNow").onclick = () => downloadCards(); return; }
  const list = filtered(), U = usage(), deck = S.addingTo && S.decks.find(d => d.id === S.addingTo);
  $("#resultCount").textContent = `${list.length.toLocaleString()} card${list.length === 1 ? "" : "s"}` + (S.collection ? " · badge shows free / owned" : "");
  $("#grid").innerHTML = list.slice(0, S.shown).map(c => tileHTML(c, U, deck)).join("") || `<div class="empty">No cards match these filters.</div>`;
  renderCards.more = list.length > S.shown;
}

/* ---------------- card sheet ---------------- */
function openCard(k) {
  const c = cardOf(k); if (!c) return;
  S.sheetKey = k; renderSheet();
  const dlg = $("#sheet"); if (!dlg.open) { dlg.showModal(); history.pushState({ sheet: 1 }, ""); }
}
function renderSheet() {
  const k = S.sheetKey, c = cardOf(k); if (!c) return;
  const U = usage(), i = info(k, U);
  const printings = S.cards.filter(x => x.k === k).map(x => `${x.setName} #${x.num}`);
  const stats = [c.cost != null && `Cost ${c.cost}`, c.inkwell ? "Inkable" : "Not inkable", c.str != null && `⚔ ${c.str}`, c.will != null && `🛡 ${c.will}`, c.lore != null && `◆ ${c.lore}`, c.move != null && `Move ${c.move}`, c.rarity].filter(Boolean);
  const deckOpts = S.decks.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join("");
  const target = S.addingTo || S.lastDeck || S.decks[0]?.id;
  const tq = target ? (S.decks.find(d => d.id === target)?.cards[k] || 0) : 0;
  $("#sheetBody").innerHTML = `<div class="inner">
    <div class="grab"></div>
    <div class="cardview">
      <div class="img">${c.md ? `<img src="${esc(c.md)}" alt="${esc(c.name)} card">` : ""}</div>
      <div style="display:flex;flex-direction:column;gap:8px;min-width:0">
        <h2>${esc(c.name)}${c.version ? `<small>${esc(c.version)}</small>` : ""}</h2>
        <div class="row">${dotHTML(c.inks)}<span class="hint">${c.inks.join(" / ")} · ${esc(c.type.join(" · "))}</span></div>
        <div class="facts">${stats.map(s => `<span>${esc(s)}</span>`).join("")}</div>
        ${c.cls.length ? `<div class="hint">${esc(c.cls.join(" · "))}</div>` : ""}
      </div>
    </div>
    ${c.text ? `<p class="rules">${esc(c.text)}</p>` : ""}
    <div class="ownbox">
      <div><b>${i.own ?? "—"}</b><span>owned</span></div>
      <div class="${i.over ? "bad" : ""}"><b>${i.tied}</b><span>in built decks</span></div>
      <div class="${i.free ? "good" : i.own != null ? "bad" : ""}"><b>${i.free ?? "—"}</b><span>free</span></div>
    </div>
    ${i.over ? `<p class="hint warn">Your built decks use ${i.tied} copies but you own ${i.own}.</p>` : ""}
    ${i.decks.length ? `<div class="row wrap">${i.decks.map(x => `<button type="button" class="chip${x.d.built ? "" : " apart"}" data-open-deck="${x.d.id}">${dotHTML(deckInks(x.d))}${esc(x.d.name)} <b>×${x.q}</b></button>`).join("")}</div>` : `<p class="hint">Not in any deck.</p>`}
    ${S.decks.length ? `<div class="addto"><select id="sheetDeck" aria-label="Deck">${deckOpts}</select>
      <div class="stepper"><button type="button" data-step="-1" aria-label="Remove one">−</button><b id="sheetQty">${tq}</b><button type="button" data-step="1" aria-label="Add one">+</button></div></div>`
      : `<button type="button" class="btn" id="sheetNewDeck">Start a deck with this card</button>`}
    <p class="hint">Printed in: ${esc(printings.join(", "))}</p>
  </div>`;
  const sel = $("#sheetDeck"); if (sel && target) sel.value = target;
}
function changeQty(deckId, k, delta) {
  const d = S.decks.find(x => x.id === deckId); if (!d) return;
  const q = Math.max(0, Math.min(99, (d.cards[k] || 0) + delta));
  if (q) d.cards[k] = q; else delete d.cards[k];
  if (delta > 0 && q > 4) toast("Decks can only run 4 copies of a card");
  d.updated = Date.now(); S.lastDeck = d.id; save();
}
$("#sheetBody").addEventListener("click", e => {
  const st = e.target.closest("[data-step]");
  if (st) { const id = $("#sheetDeck").value; changeQty(id, S.sheetKey, +st.dataset.step); renderSheet(); renderAll(true); return; }
  const od = e.target.closest("[data-open-deck]");
  if (od) { closeSheet(); location.hash = "deck-" + od.dataset.openDeck; return; }
  if (e.target.id === "sheetNewDeck") { const d = createDeck(); d.cards[S.sheetKey] = 1; save(); closeSheet(); location.hash = "deck-" + d.id; }
});
$("#sheetBody").addEventListener("change", e => { if (e.target.id === "sheetDeck") { S.lastDeck = e.target.value; renderSheet(); } });
function closeSheet() { const d = $("#sheet"); if (d.open) { d.close(); if (history.state?.sheet) history.back(); } }
$("#sheet").addEventListener("click", e => { if (e.target === $("#sheet")) closeSheet(); });
$("#sheet").addEventListener("cancel", e => { e.preventDefault(); closeSheet(); });
addEventListener("popstate", () => { const d = $("#sheet"); if (d.open) d.close(); });

/* ---------------- DECKS ---------------- */
function createDeck() {
  const d = { id: newId(), name: `New deck ${S.decks.length + 1}`, built: false, cards: {}, updated: Date.now() };
  S.decks.push(d); S.lastDeck = d.id; save(); return d;
}
function renderDecks() {
  if (!S.decks.length) {
    $("#deckList").innerHTML = `<div class="empty">No decks yet. Make one, add cards from the card list or paste a Dreamborn list, then mark it Built when it's sleeved up.<button type="button" class="btn primary" data-new>New deck</button></div>`;
    return;
  }
  const U = usage();
  const sorted = [...S.decks].sort((a, b) => (b.built - a.built) || (b.updated - a.updated));
  $("#deckList").innerHTML = sorted.map(d => {
    const inks = deckInks(d), n = deckCount(d);
    let issues = 0; if (S.collection) for (const [k, q] of Object.entries(d.cards)) if (rowStatus(k, q, d, U).cls !== "ok") issues++;
    return `<button type="button" class="deck${d.built ? "" : " apart"}" style="--stripe:${stripe(inks)}" data-deck="${d.id}">
      <h3>${esc(d.name)}</h3>
      <div class="meta">${inks.join(" / ") || "No cards yet"} · ${n} cards${n && n !== 60 ? ` (${n < 60 ? "under" : "over"} 60)` : ""}</div>
      <div class="row wrap">${d.built ? `<span class="pill ok">Built</span>` : `<span class="pill muted">Taken apart</span>`}
      ${S.collection && n ? (issues ? `<span class="pill ${d.built ? "bad" : "warn"}">${issues} card${issues > 1 ? "s" : ""} ${d.built ? "short" : "to pull or buy"}</span>` : `<span class="pill ok">${d.built ? "All sleeved" : "Ready to build"}</span>`) : ""}</div>
    </button>`;
  }).join("");
}
$("#deckList").addEventListener("click", e => {
  if (e.target.closest("[data-new]")) { const d = createDeck(); location.hash = "deck-" + d.id; return; }
  const b = e.target.closest("[data-deck]"); if (b) location.hash = "deck-" + b.dataset.deck;
});
$("#newDeck").onclick = () => { const d = createDeck(); location.hash = "deck-" + d.id; };

let confirmDelete = false;
function currentDeck() { const m = location.hash.match(/^#deck-(.+)$/); return m && S.decks.find(d => d.id === m[1]); }
function renderDeck() {
  const d = currentDeck(); if (!d) return;
  const U = usage(), inks = deckInks(d), n = deckCount(d);
  if (document.activeElement !== $("#dName")) $("#dName").value = d.name;
  $("#dBuilt").setAttribute("aria-pressed", d.built); $("#dApart").setAttribute("aria-pressed", !d.built);

  // stats
  const inkT = {}; const curve = Array(10).fill(0); let inkable = 0;
  const rows = Object.entries(d.cards).map(([k, q]) => ({ k, q, c: cardOf(k) }));
  for (const r of rows) {
    if (!r.c) continue;
    for (const i of r.c.inks) inkT[i] = (inkT[i] || 0) + r.q / r.c.inks.length;
    curve[Math.min(9, r.c.cost)] += r.q; if (r.c.inkwell) inkable += r.q;
  }
  const max = Math.max(1, ...curve);
  let ready = 0, pull = 0, buy = 0;
  if (S.collection) for (const r of rows) { const s = rowStatus(r.k, r.q, d, U); if (s.cls === "ok") ready += r.q; else if (s.cls === "warn") pull += r.q; else buy += r.q; }
  $("#deckStats").innerHTML = `<div class="stats">
    <div class="statrow">
      <div class="stat"><b>${n}</b><span>/ 60 cards</span></div>
      <div class="stat"><b>${inkable}</b><span>inkable</span></div>
      <div class="stat"><span>${inks.length ? inks.map(i => `${dotHTML([i])} ${i}`).join(" &nbsp; ") : "No cards yet"}</span></div>
    </div>
    ${n ? `<div class="inkbar" aria-hidden="true">${INKS.filter(i => inkT[i]).map(i => `<i style="width:${(inkT[i] / n) * 100}%;background:var(--${i})"></i>`).join("")}</div>
    <div class="curve" aria-label="Cost curve">${curve.map((v, i) => `<div><span style="height:${(v / max) * 100}%"></span><em>${i === 9 ? "9+" : i}</em></div>`).join("")}</div>` : ""}
    ${S.collection && n && !d.built ? `<div class="tally">
      <div style="background:var(--ok-soft);color:var(--ok)"><b>${ready}</b><span>ready</span></div>
      <div style="background:var(--warn-soft);color:var(--warn)"><b>${pull}</b><span>pull from decks</span></div>
      <div style="background:var(--bad-soft);color:var(--bad)"><b>${buy}</b><span>to buy</span></div></div>` : ""}
    ${!S.collection && n ? `<p class="hint">Load your collection on the Collection tab to see what's free, what to pull, and what to buy.</p>` : ""}
  </div>`;

  // card rows grouped by type
  const groups = {};
  for (const r of rows) { const t = r.c ? (TYPE_ORDER.find(x => r.c.type.includes(x)) || r.c.type[0] || "Other") : "Not recognized"; (groups[t] ||= []).push(r); }
  const order = [...TYPE_ORDER, "Other", "Not recognized"].filter(t => groups[t]);
  $("#deckCards").innerHTML = rows.length ? order.map(t => {
    const list = groups[t].sort((a, b) => (a.c?.cost ?? 99) - (b.c?.cost ?? 99) || displayName(a.k).localeCompare(displayName(b.k)));
    const total = list.reduce((s, r) => s + r.q, 0);
    return `<div class="group"><h3>${t === "Song" ? "Songs" : t === "Not recognized" ? t : t + "s"} · ${total}</h3>${list.map(r => {
      const s = rowStatus(r.k, r.q, d, U);
      return `<div class="drow">
        <button type="button" class="thumb" data-k="${esc(r.k)}" aria-label="Open card">${r.c?.sm ? `<img loading="lazy" src="${esc(r.c.sm)}" alt="">` : ""}</button>
        <div class="dname"><div class="t">${r.c ? `<span class="cost">${r.c.cost}</span> ` : ""}${esc(r.c ? r.c.name : displayName(r.k))}${r.c?.version ? ` <small>· ${esc(r.c.version)}</small>` : ""}</div>
          <div class="s">${r.c ? dotHTML(r.c.inks) : ""}<span class="pill ${s.cls}">${esc(s.label)}</span></div></div>
        <div class="stepper"><button type="button" data-dstep="-1" data-k="${esc(r.k)}" aria-label="Remove one">−</button><b>${r.q}</b><button type="button" data-dstep="1" data-k="${esc(r.k)}" aria-label="Add one">+</button></div>
      </div>`; }).join("")}</div>`;
  }).join("") : `<div class="empty">This deck is empty. Tap Add cards to pick from the card list, or paste a list from Dreamborn.</div>`;

  $("#dDeleteZone").innerHTML = confirmDelete
    ? `<span class="hint warn">Delete "${esc(d.name)}"? This can't be undone.</span><button type="button" class="btn danger" id="dDelYes">Delete deck</button><button type="button" class="btn ghost" id="dDelNo">Keep it</button>`
    : `<button type="button" class="btn ghost" id="dDel">Delete deck</button>`;
}
$("#deckCards").addEventListener("click", e => {
  const st = e.target.closest("[data-dstep]"); const d = currentDeck();
  if (st && d) { changeQty(d.id, st.dataset.k, +st.dataset.dstep); renderDeck(); return; }
  const th = e.target.closest(".thumb"); if (th) openCard(th.dataset.k);
});
$("#dName").addEventListener("input", e => { const d = currentDeck(); if (d) { d.name = e.target.value.slice(0, 60) || "Untitled deck"; d.updated = Date.now(); clearTimeout(renderDeck.t); renderDeck.t = setTimeout(save, 400); } });
$("#dBuilt").onclick = () => setBuilt(true);
$("#dApart").onclick = () => setBuilt(false);
function setBuilt(v) {
  const d = currentDeck(); if (!d || d.built === v) return;
  d.built = v; d.updated = Date.now(); save(); renderDeck();
  toast(v ? "Marked as built. Its cards now count as in use." : "Taken apart. Its cards are free again.");
}
$("#deckBack").onclick = () => { location.hash = "decks"; };
$("#dAdd").onclick = () => { const d = currentDeck(); if (!d) return; S.addingTo = d.id; S.lastDeck = d.id; location.hash = "cards"; };
$("#addBarDone").onclick = () => { const id = S.addingTo; S.addingTo = null; location.hash = "deck-" + id; };
$("#dDeleteZone").addEventListener("click", e => {
  const d = currentDeck(); if (!d) return;
  if (e.target.id === "dDel") { confirmDelete = true; renderDeck(); }
  else if (e.target.id === "dDelNo") { confirmDelete = false; renderDeck(); }
  else if (e.target.id === "dDelYes") { S.decks = S.decks.filter(x => x.id !== d.id); confirmDelete = false; save(); toast("Deck deleted"); location.hash = "decks"; }
});
$("#dCopy").onclick = async () => {
  const d = currentDeck(); if (!d) return;
  const text = Object.entries(d.cards).map(([k, q]) => `${q} ${displayName(k)}`).join("\n");
  try { await navigator.clipboard.writeText(text); toast("Deck list copied"); } catch { $("#pasteText").value = text; openPaste(true); }
};
function openPaste(showOnly) {
  $("#pasteErr").textContent = ""; if (!showOnly) { const d = currentDeck(); $("#pasteText").value = ""; }
  $("#pasteDlg").showModal(); history.pushState({ sheet: 1 }, "");
}
$("#dPaste").onclick = () => openPaste(false);
$("#pasteCancel").onclick = () => { $("#pasteDlg").close(); if (history.state?.sheet) history.back(); };
$("#pasteDlg").addEventListener("cancel", e => { e.preventDefault(); $("#pasteCancel").onclick(); });
addEventListener("popstate", () => { if ($("#pasteDlg").open) $("#pasteDlg").close(); });
$("#pasteApply").onclick = () => {
  const d = currentDeck(); if (!d) return;
  const list = parseList($("#pasteText").value);
  if (!list.length) { $("#pasteErr").textContent = "Paste at least one line like: 4 Card Name - Version"; return; }
  const unknown = S.cards.length ? list.filter(x => !S.byKey.has(x.k)).map(x => x.n) : [];
  d.cards = {}; for (const x of list) d.cards[x.k] = (d.cards[x.k] || 0) + x.q;
  d.updated = Date.now(); save(); $("#pasteDlg").close(); if (history.state?.sheet) history.back();
  renderDeck();
  toast(unknown.length ? `Added. ${unknown.length} name${unknown.length > 1 ? "s" : ""} didn't match a card: ${unknown.slice(0, 2).join(", ")}${unknown.length > 2 ? "…" : ""}` : `Added ${list.length} different cards`);
};

/* ---------------- COLLECTION ---------------- */
function renderCollection() {
  const c = S.collection;
  $("#colStatus").textContent = c ? `Last import ${new Date(c.at).toLocaleDateString()}` : "No collection loaded yet";
  $("#dataStatus").textContent = S.cards.length ? `${S.byKey.size.toLocaleString()} different cards across ${S.sets.length} sets · updated ${new Date(S.dataAt).toLocaleDateString()}` : "Not downloaded yet.";
  if (!c) { $("#colSummary").innerHTML = `<h2>What you own</h2><p class="hint">Import your Dreamborn export above to see owned, free, and in-use counts everywhere.</p>`; return; }
  const total = Object.values(c.counts).reduce((s, q) => s + q, 0);
  const U = usage(); let tied = 0; for (const [, e] of U) tied += e.tied;
  const matched = Object.keys(c.counts).filter(k => S.byKey.has(k)).length;
  const per = S.sets.filter(s => /^\d+$/.test(s.code)).map(s => {
    const keys = new Set(S.cards.filter(x => x.set === s.code).map(x => x.k));
    let have = 0; for (const k of keys) if (c.counts[k] > 0) have++;
    return { s, have, size: keys.size };
  }).reverse();
  $("#colSummary").innerHTML = `<h2>What you own</h2>
    <div class="big3"><div class="stat"><b>${total.toLocaleString()}</b><span>cards</span></div>
      <div class="stat"><b>${Object.keys(c.counts).length.toLocaleString()}</b><span>different</span></div>
      <div class="stat"><b>${tied}</b><span>in built decks</span></div></div>
    ${S.cards.length && matched < Object.keys(c.counts).length ? `<p class="hint">${Object.keys(c.counts).length - matched} names in your file didn't match the card list (often promos or spelling differences).</p>` : ""}
    ${per.map(p => `<div class="setrow"><span>${esc(p.s.name)}</span><span class="n">${p.have}/${p.size}</span><div class="pbar"><i style="width:${p.size ? (p.have / p.size) * 100 : 0}%"></i></div></div>`).join("")}`;
}
$("#colFile").addEventListener("change", async e => { const f = e.target.files[0]; if (f) $("#colPaste").value = await f.text(); });
$("#colImport").onclick = async () => {
  const o = parseCollection($("#colPaste").value);
  if (!o) { $("#colStatus").textContent = "Couldn't find any cards in that. It needs a Name column, or lines like \"4 Card Name\"."; return; }
  S.collection = o; await store.set("collection", o).catch(() => {});
  $("#colPaste").value = ""; $("#colFile").value = "";
  toast(`Collection replaced: ${Object.values(o.counts).reduce((s, q) => s + q, 0).toLocaleString()} cards`); renderAll();
};
$("#refreshData").onclick = () => downloadCards({ manual: true }).then(buildFilters);
$("#updateBtn").onclick = () => downloadCards({ manual: true }).then(buildFilters);
$("#backupSave").onclick = () => {
  const blob = new Blob([JSON.stringify({ app: "ink-locker", v: 1, at: Date.now(), decks: S.decks, collection: S.collection }, null, 1)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `ink-locker-backup-${new Date().toISOString().slice(0, 10)}.json`; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  $("#backupStatus").textContent = "Backup saved to your downloads.";
};
$("#backupLoad").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const j = JSON.parse(await f.text()); if (j.app !== "ink-locker") throw 0;
    S.decks = j.decks || []; S.collection = j.collection || null;
    await save(); await store.set("collection", S.collection);
    $("#backupStatus").textContent = `Restored ${S.decks.length} decks from ${new Date(j.at).toLocaleDateString()}.`; renderAll();
  } catch { $("#backupStatus").textContent = "That file isn't an Ink Locker backup."; }
  e.target.value = "";
});

/* ---------------- routing & events ---------------- */
function route() {
  let v = (location.hash || "#cards").slice(1);
  if (v.startsWith("deck-")) { if (!currentDeck()) v = "decks"; else { confirmDelete = false; } }
  const view = v.startsWith("deck-") ? "deck" : (["cards", "decks", "collection"].includes(v) ? v : "cards");
  for (const s of ["cards", "decks", "deck", "collection"]) $("#v-" + s).hidden = s !== view;
  document.querySelectorAll(".tabs a").forEach(a => a.toggleAttribute("aria-current", a.dataset.v === view || (view === "deck" && a.dataset.v === "decks")));
  document.querySelectorAll(".tabs a[aria-current]").forEach(a => a.setAttribute("aria-current", "page"));
  if (view !== "cards" && S.addingTo && view !== "deck") S.addingTo = null;
  renderAll(); scrollTo(0, 0);
}
addEventListener("hashchange", route);
function renderAddBar() {
  const d = S.addingTo && S.decks.find(x => x.id === S.addingTo);
  const onCards = !$("#v-cards").hidden;
  $("#addBar").hidden = !(d && onCards);
  if (d) { $("#addBarName").textContent = d.name; $("#addBarCount").textContent = `${deckCount(d)}/60`; }
}
function renderAll(light) {
  if (!$("#v-cards").hidden) { if (light) { const y = scrollY; renderCards(); scrollTo(0, y); } else renderCards(); }
  if (!$("#v-decks").hidden) renderDecks();
  if (!$("#v-deck").hidden) renderDeck();
  if (!$("#v-collection").hidden) renderCollection();
  renderAddBar();
  $("#syncNote").textContent = S.collection ? `${S.decks.filter(d => d.built).length} built · ${Object.values(S.collection.counts).reduce((s, q) => s + q, 0).toLocaleString()} cards` : "";
}
let qt;
$("#q").addEventListener("input", e => { clearTimeout(qt); qt = setTimeout(() => { S.filters.q = e.target.value; S.shown = PAGE; renderCards(); }, 160); });
$("#inkFilter").addEventListener("click", e => { const b = e.target.closest("[data-ink]"); if (!b) return; const s = S.filters.inks; s.has(b.dataset.ink) ? s.delete(b.dataset.ink) : s.add(b.dataset.ink); b.setAttribute("aria-pressed", s.has(b.dataset.ink)); S.shown = PAGE; renderCards(); });
$("#costFilter").addEventListener("click", e => { const b = e.target.closest("[data-cost]"); if (!b) return; const s = S.filters.costs; s.has(b.dataset.cost) ? s.delete(b.dataset.cost) : s.add(b.dataset.cost); b.setAttribute("aria-pressed", s.has(b.dataset.cost)); S.shown = PAGE; renderCards(); });
for (const [id, f] of [["#setFilter", "set"], ["#typeFilter", "type"], ["#ownFilter", "own"]]) $(id).addEventListener("change", e => { S.filters[f] = e.target.value; S.shown = PAGE; renderCards(); });
$("#grid").addEventListener("click", e => {
  const t = e.target.closest(".tile"); if (!t) return;
  if (S.addingTo) { changeQty(S.addingTo, t.dataset.k, 1); const d = S.decks.find(x => x.id === S.addingTo); toast(`${d.cards[t.dataset.k]}× ${displayName(t.dataset.k)}`); renderAll(true); return; }
  openCard(t.dataset.k);
});
$("#grid").addEventListener("contextmenu", e => { const t = e.target.closest(".tile"); if (t && S.addingTo) { e.preventDefault(); openCard(t.dataset.k); } });
new IntersectionObserver(es => { if (es[0].isIntersecting && renderCards.more && !$("#v-cards").hidden) { S.shown += PAGE; renderAll(true); } }, { rootMargin: "600px" }).observe($("#gridMore"));

/* ---------------- start ---------------- */
(async function start() {
  const [cd, decks, col, nk] = await Promise.all([store.get("cards"), store.get("decks"), store.get("collection"), store.get("newKeys")]);
  if (Array.isArray(nk)) S.newKeys = new Set(nk);
  if (cd) { S.cards = cd.cards; S.sets = cd.sets; S.dataAt = cd.at; indexCards(); }
  S.decks = Array.isArray(decks) ? decks : []; S.collection = col || null;
  buildFilters(); route();
  if (!S.cards.length) { await downloadCards(); buildFilters(); }
  else if (Date.now() - S.dataAt > CARD_DATA_MAX_AGE && navigator.onLine) { downloadCards({ silent: true }).then(buildFilters); }
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
