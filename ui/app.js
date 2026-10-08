/* Tattletab UI — force graph of pages and the companies/hosts they pull in,
   with live follow, session replay, and insight panels. All served from 127.0.0.1. */
(() => {
"use strict";

const CAT = {
  ads:            { color: "#ff5c7a", label: "Ads" },
  analytics:      { color: "#ffb347", label: "Analytics" },
  fingerprinting: { color: "#c58cff", label: "Fingerprinting" },
  social:         { color: "#5ab0ff", label: "Social" },
  content:        { color: "#7ee0b5", label: "Content" },
  cdn:            { color: "#6e7d91", label: "CDN" },
  other:          { color: "#a9b1bd", label: "Unclassified" },
};
const PRIORITY = ["fingerprinting", "ads", "analytics", "social", "other", "content", "cdn"];
const TRACKING = new Set(["ads", "analytics", "fingerprinting"]);
const PAGE_COLOR = "#ffffff";
const SPEEDS = [1, 4, 16, 64];
const isBlocked = err => !!err && /BLOCKED_BY_CLIENT/.test(err);

// ---------- state ----------
const S = {
  sessions: [], recording: null, selected: null,
  events: [], cursor: 0, playT: 0, t0: 0, t1: 0,
  playing: false, speedIdx: 1, follow: false,
  groupBy: "company", trackersOnly: false, hidden: new Set(),
  hover: null, focus: null,
  tab: "who", reachScope: "session", reachCache: {},
  layout: "structured", // or "organic"
  view: "graph",         // or "entourage"
  sound: false,
  autoFit: true,        // camera follows the graph until the user pans/zooms
  pins: new Map(),      // node id -> {x, y}; dragged nodes stay put
  drag: null, justDragged: false,
};
let M; // graph + insight model, rebuilt from events
const ghost = new Map(); // remembered positions across rebuilds
let particles = [];
let structureDirty = false;

function freshModel() {
  return {
    nodes: new Map(), links: new Map(),
    req: 0, third: 0, hosts: new Set(), cos: new Set(), sites: new Set(),
    rank: new Map(),      // company -> {count, cats, hosts:Map, pages:Set}
    chains: new Map(),    // "kind|A|B" -> {kind, from, to, count}
    direct: new Set(),    // companies some page loaded itself
    via: new Map(),       // company -> Map(introducer -> count), when loaded from a 3rd-party frame
    bg: new Map(),        // initiator site -> {count, cos:Map, types:Map}
    bgCount: 0,
    block: new Map(),     // company -> {total, blocked}
    trk: 0, trkBlocked: 0,
    visits: [], visitSet: new Set(), lastVisit: null, // street of sites, in order visited
    siteCos: new Map(),   // site -> Set of third-party companies seen there
    joinAt: new Map(),    // company -> visit index where it reached 2 sites
    toasts: [],
  };
}
M = freshModel();

// ---------- dom ----------
const $ = id => document.getElementById(id);
const canvas = $("graph"), ctx = canvas.getContext("2d");
const spark = $("spark"), sctx = spark.getContext("2d");
const tip = $("tip");
let W = 0, H = 0, DPR = 1;
let transform = d3.zoomIdentity;

// ---------- simulation ----------
// Two layouts:
//  structured (default) — degree-aware. Leaves (contacted by only one node) are
//    placed on rings around that node, grouped into arcs by category. Bridges
//    (several neighbours) repel in proportion to degree and settle in the open
//    space between the clusters they connect. Hubs reserve room for their halo.
//  organic — plain force-directed layout.
// Pinned nodes (fx/fy) override both.
const CAT_ORDER = ["ads", "analytics", "fingerprinting", "social", "other", "content", "cdn"];
const isLeaf = n => !!n.leafOf;
const extent = n => n.halo || n.r; // how much room a node needs around its centre

const sim = d3.forceSimulation([])
  .force("charge", d3.forceManyBody().distanceMax(500).strength(n => {
    if (S.layout === "organic") return n.kind === "page" ? -520 : -70;
    if (isLeaf(n)) return -12;                                  // rings + collide space leaves
    if (n.kind === "page") return -Math.min(1600, 300 + 6 * (n.leafCount || 0));
    return -60 - 28 * Math.min(n.degree || 1, 12);              // bridges: more links, more room
  }))
  .force("link", d3.forceLink([]).id(n => n.id)
    .distance(l => {
      if (S.layout === "organic") return (l.kind === "load" ? 55 : 35) + l.target.r * 1.5;
      return extent(l.source) + extent(l.target) + (l.kind === "load" ? 40 : 25);
    })
    .strength(l => {
      if (S.layout === "organic") return l.kind === "load" ? 0.6 / Math.min(l.target.pageCount || 1, 4) : 0.25;
      if (isLeaf(l.target) || isLeaf(l.source)) return 0;   // the ring force owns leaves
      return 0.5 / Math.sqrt(Math.max(1, Math.min(l.source.degree, l.target.degree)));
    }))
  .force("collide", d3.forceCollide(n => n.r + (n.kind === "page" ? 14 : isLeaf(n) ? 3 : 9)).iterations(2))
  .force("x", d3.forceX(0))
  .force("y", d3.forceY(0))
  .force("rings", ringForce)
  .force("hubs", hubForce)
  .alphaDecay(0.02)
  .stop();
d3.timer(() => { if (sim.alpha() > sim.alphaMin()) sim.tick(); });

// Pull each leaf toward its assigned slot on its parent's ring.
function ringForce(alpha) {
  if (S.layout !== "structured") return;
  const k = 0.35 * alpha;
  for (const n of M.nodes.values()) {
    const p = n.leafOf;
    if (!p || n.fx != null) continue;
    n.vx += (p.x + Math.cos(n.angle) * n.ringR - n.x) * k;
    n.vy += (p.y + Math.sin(n.angle) * n.ringR - n.y) * k;
  }
}

// Keep hubs (anything with a halo of leaves) from overlapping each other's halos.
let hubs = [];
function hubForce(alpha) {
  if (S.layout !== "structured") return;
  for (let i = 0; i < hubs.length; i++) for (let j = i + 1; j < hubs.length; j++) {
    const a = hubs[i], b = hubs[j];
    const min = extent(a) + extent(b) + 70;
    let dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
    if (d >= min) continue;
    if (d < 1) { dx = Math.random() - .5; dy = Math.random() - .5; d = 1; }
    const push = (min - d) / d * 0.5 * alpha;
    const wa = a.fx != null ? 0 : b.fx != null ? 2 : 1, wb = b.fx != null ? 0 : a.fx != null ? 2 : 1;
    a.vx -= dx * push * wa; a.vy -= dy * push * wa;
    b.vx += dx * push * wb; b.vy += dy * push * wb;
  }
}

// Recompute degrees, leaves, ring slots and halos from the current links.
function computeLayout(nodes) {
  for (const n of nodes) { n.degree = 0; n.leafOf = null; n.halo = 0; n.leafCount = 0; n._nb = new Set(); }
  for (const l of M.links.values()) { l.source._nb.add(l.target); l.target._nb.add(l.source); }
  for (const n of nodes) n.degree = n._nb.size;
  hubs = [];
  if (S.layout !== "structured") { for (const n of nodes) delete n._nb; return; }

  const groups = new Map();
  for (const n of nodes) {
    if (n.kind !== "entity" || n.degree !== 1) continue;
    const parent = n._nb.values().next().value;
    if (parent.degree === 1 && parent.kind !== "page") continue; // isolated pair: leave to physics
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(n);
  }
  for (const [parent, leaves] of groups) {
    // Fill rings biggest-first: heavy hitters get the inner ring, the long tail
    // of small hosts the outer ones. Each ring is as tight as its own nodes allow.
    const bySize = [...leaves].sort((a, b) => b.r - a.r || b.count - a.count);
    const rings = [];
    let R = parent.r + 24 + bySize[0].r, maxR = bySize[0].r, cur = [], used = 0;
    for (const n of bySize) {
      const w = 2 * n.r + 8;
      if (cur.length && used + w > 2 * Math.PI * R) {
        rings.push({ R, maxR, nodes: cur });
        R += maxR + 12 + n.r; maxR = n.r; cur = []; used = 0;
      }
      cur.push(n); used += w;
    }
    rings.push({ R, maxR, nodes: cur });
    // Within a ring, category order runs clockwise from 12 o'clock, so the same
    // categories line up as arcs across rings. Angular room scales with size.
    for (const ring of rings) {
      ring.nodes.sort((a, b) => CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat) || b.count - a.count);
      const w = ring.nodes.map(n => 2 * n.r + 8);
      const total = w.reduce((a, b) => a + b, 0);
      let acc = 0;
      ring.nodes.forEach((n, i) => {
        n.leafOf = parent;
        n.ringR = ring.R;
        n.angle = -Math.PI / 2 + 2 * Math.PI * (acc + w[i] / 2) / total;
        acc += w[i];
      });
    }
    parent.leafCount = leaves.length;
    const last = rings[rings.length - 1];
    parent.halo = last.R + last.maxR;
  }
  for (const n of nodes) {
    delete n._nb;
    if (n.halo || n.kind === "page" || n.degree > 1) hubs.push(n);
  }
}

let lastSync = 0;
function syncSim(soft) {
  const nodes = [...M.nodes.values()];
  computeLayout(nodes);
  // Big graphs need a firmer pull to the middle or repulsion spreads them past
  // the viewport. Leaves are excluded: their position comes from their ring.
  const pull = 0.035 + Math.min(0.09, nodes.length / 1500);
  sim.force("x").strength(n => isLeaf(n) ? 0 : pull);
  sim.force("y").strength(n => isLeaf(n) ? 0 : pull);
  sim.nodes(nodes);
  sim.force("link").links([...M.links.values()]);
  sim.alpha(Math.max(sim.alpha(), soft ? 0.12 : 0.35));
  structureDirty = false;
  lastSync = performance.now();
}

// ---------- model ----------
function visible(cat) {
  if (S.hidden.has(cat)) return false;
  if (S.trackersOnly && (cat === "cdn" || cat === "content")) return false;
  return true;
}

function radius(n) {
  return n.kind === "page"
    ? Math.min(42, 11 + Math.sqrt(n.count) * 1.3)
    : Math.min(32, 4 + Math.sqrt(Math.max(n.count, 1)) * 1.7);
}

function ensureNode(id, kind, label, near) {
  let n = M.nodes.get(id);
  if (n) return n;
  const g = ghost.get(id);
  const base = near || { x: (Math.random() - .5) * 200, y: (Math.random() - .5) * 200 };
  n = {
    id, kind, label, count: 0, bytes: 0, blocked: 0, failed: 0, pulse: 0,
    cats: {}, cat: "other", hosts: new Map(), pages: new Set(), pageCount: 0,
    via: new Set(), direct: false, redirTo: new Map(),
    x: g ? g.x : base.x + (Math.random() - .5) * 60,
    y: g ? g.y : base.y + (Math.random() - .5) * 60,
    r: 6,
  };
  n.r = radius(n);
  const pin = S.pins.get(id);
  if (pin) { n.x = n.fx = pin.x; n.y = n.fy = pin.y; }
  M.nodes.set(id, n);
  structureDirty = true;
  return n;
}

function entity(company, host, near, fallbackCat) {
  const key = S.groupBy === "company" ? company : host;
  const n = ensureNode("e:" + key, "entity", key, near);
  if (!n.count && fallbackCat && n.cat === "other") n.cat = fallbackCat;
  if (!n.company) n.company = company;
  return n;
}

function link(a, b, kind) {
  const id = kind + ":" + a.id + "|" + b.id;
  let l = M.links.get(id);
  if (!l) { l = { id, kind, source: a, target: b, count: 0, flash: 0 }; M.links.set(id, l); structureDirty = true; }
  return l;
}

function dominant(cats) {
  for (const c of PRIORITY) if (cats[c]) return c;
  return "other";
}

function bump(map, key, by = 1) { map.set(key, (map.get(key) || 0) + by); }

function apply(e, animate) {
  const blocked = isBlocked(e.error);
  M.req++;
  M.hosts.add(e.host);
  if (e.party !== "background") {
    M.sites.add(e.page_site);
    const nav = e.type === "main_frame" && e.party === "first";
    if ((nav && e.page_site !== M.lastVisit) || !M.visitSet.has(e.page_site)) {
      M.visits.push({ site: e.page_site, ts: e.ts });
      M.visitSet.add(e.page_site);
      M.lastVisit = e.page_site;
    }
  }
  if (e.party === "third") { M.third++; M.cos.add(e.company); }

  // ----- insight bookkeeping (independent of graph filters) -----
  if (e.party !== "first") {
    let r = M.rank.get(e.company);
    if (!r) { r = { count: 0, cats: {}, hosts: new Map(), pages: new Set() }; M.rank.set(e.company, r); }
    r.count++; r.cats[e.category] = (r.cats[e.category] || 0) + 1;
    bump(r.hosts, e.host);
    if (e.party === "third") {
      const before = r.pages.size;
      r.pages.add(e.page_site);
      if (before === 1 && r.pages.size === 2) { // followed you to a second site
        let at = M.visits.length - 1;
        for (let i = M.visits.length - 1; i >= 0; i--) if (M.visits[i].site === e.page_site) { at = i; break; }
        M.joinAt.set(e.company, at);
        if (animate) M.toasts.push({ company: e.company, site: e.page_site, age: 0, color: colorOf(dominant(r.cats)) });
      }
      let sc = M.siteCos.get(e.page_site);
      if (!sc) { sc = new Set(); M.siteCos.set(e.page_site, sc); }
      sc.add(e.company);
    }
  }
  if (animate && S.sound && !S.follow && Sound.ctx) Sound.event(e, Sound.ctx.currentTime);
  if (e.party === "third" && TRACKING.has(e.category)) {
    let b = M.block.get(e.company);
    if (!b) { b = { total: 0, blocked: 0, cat: e.category }; M.block.set(e.company, b); }
    b.total++; M.trk++;
    if (blocked) { b.blocked++; M.trkBlocked++; }
  }
  if (e.party === "background") {
    M.bgCount++;
    const k = e.init_site || "(no initiator)";
    let g = M.bg.get(k);
    if (!g) { g = { count: 0, cos: new Map(), types: new Map() }; M.bg.set(k, g); }
    g.count++; bump(g.cos, e.company); bump(g.types, e.type);
  }
  // Loaded from inside another company's frame (an ad iframe pulling in more ad tech).
  const viaFrame = e.init_party === "third" && e.init_company && e.init_company !== e.company && e.party === "third";
  if (e.party === "third" || e.party === "same-owner") {
    if (viaFrame) {
      let v = M.via.get(e.company);
      if (!v) { v = new Map(); M.via.set(e.company, v); }
      bump(v, e.init_company);
      chain("frame", e.init_company, e.company);
    } else {
      M.direct.add(e.company);
    }
  }
  const redirOut = e.redir_company && e.redir_party && e.redir_party !== "first" && e.redir_company !== e.company;
  if (redirOut) chain("redirect", e.party === "first" ? e.page_site : e.company, e.redir_company);

  // ----- graph -----
  const page = ensureNode("p:" + e.page_site, "page", e.page_site);
  page.count++; page.r = radius(page);
  let src = page;

  if (e.party === "first") {
    bump(page.hosts, e.host);
    page.bytes += e.size || 0;
    if (animate) page.pulse = 1;
  } else {
    if (!visible(e.category)) return;
    let parent = page;
    if (viaFrame) {
      parent = entity(e.init_company, e.init_host, page);
      link(page, parent, "load");
    }
    const ent = entity(e.company, e.host, parent);
    ent.count++; ent.r = radius(ent);
    ent.bytes += e.size || 0;
    ent.cats[e.category] = (ent.cats[e.category] || 0) + 1;
    ent.cat = dominant(ent.cats);
    bump(ent.hosts, e.host);
    if (blocked) ent.blocked++; else if (e.error) ent.failed++;
    if (!ent.pages.has(e.page_site)) { ent.pages.add(e.page_site); ent.pageCount = ent.pages.size; }
    if (viaFrame) ent.via.add(e.init_company); else ent.direct = true;
    const l = link(parent, ent, viaFrame ? "frame" : "load");
    l.count++;
    if (animate) {
      ent.pulse = 1; l.flash = 1;
      spawn(l, e.category, !!e.error);
    }
    src = ent;
  }

  if (redirOut && visible(e.redir_category)) {
    const tgt = entity(e.redir_company, e.redir_host, src, e.redir_category);
    bump(src.redirTo, tgt.label);
    const l = link(src, tgt, "redirect");
    l.count++;
    if (animate) { tgt.pulse = 1; l.flash = 1; spawn(l, e.redir_category, false); }
  }
}

function chain(kind, from, to) {
  const k = kind + "|" + from + "|" + to;
  let c = M.chains.get(k);
  if (!c) { c = { kind, from, to, count: 0 }; M.chains.set(k, c); }
  c.count++;
}

function spawn(l, cat, err) {
  if (particles.length < 500) particles.push({ l, t: 0, c: CAT[cat]?.color || "#fff", err });
}

function rebuild(uptoT) {
  for (const n of M.nodes.values()) ghost.set(n.id, { x: n.x, y: n.y });
  M = freshModel();
  particles = [];
  S.cursor = 0;
  applyUntil(uptoT, false);
  syncSim();
  renderSide();
}

function applyUntil(t, animate) {
  let changed = false;
  while (S.cursor < S.events.length && S.events[S.cursor].ts <= t) {
    apply(S.events[S.cursor++], animate);
    changed = true;
  }
  if (structureDirty) syncSim();
  return changed;
}

// ---------- data ----------
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(r.status);
  return r.status === 204 ? null : r.json();
}

async function loadSessions() {
  const [st, list] = await Promise.all([api("/api/status"), api("/api/sessions")]);
  S.recording = st.recording;
  S.sessions = list;
  $("foot").textContent = `127.0.0.1 · ${st.full_urls ? "full URLs" : "hostnames only"} · ${st.tracker_list_entries ? st.tracker_list_entries + " list domains" : "built-in list"}`;
  renderSessions();
  renderRec();
}

async function selectSession(id) {
  S.selected = id;
  S.playing = false;
  const sess = S.sessions.find(s => s.id === id);
  S.events = id ? await api(`/api/sessions/${id}/events`) : [];
  S.t0 = sess ? sess.started : 0;
  S.t1 = sess ? (sess.stopped || Date.now()) : 0;
  if (S.events.length) {
    S.t0 = Math.min(S.t0, S.events[0].ts);
    S.t1 = Math.max(S.t1, S.events[S.events.length - 1].ts);
  }
  ghost.clear();
  M = freshModel(); // new session: don't inherit the previous layout
  S.focus = null;
  loadPins();
  S.autoFit = true; renderFitButtons();
  S.follow = !!(sess && sess.active);
  S.playT = S.follow ? Infinity : S.t1;
  rebuild(S.playT);
  if (!S.follow) S.playT = S.t1;
  renderSessions(); renderControls();
}

// Pins are a per-viewer layout preference, so they live in this browser's
// localStorage (keyed by session), not in the capture database.
function pinKey() { return `tattletab.pins.${S.selected}`; }
function loadPins() {
  S.pins = new Map();
  try {
    const raw = localStorage.getItem(pinKey()) || localStorage.getItem(`netscope.pins.${S.selected}`);
    if (raw) for (const [id, p] of Object.entries(JSON.parse(raw))) S.pins.set(id, p);
  } catch (_) { /* storage unavailable: pins last until reload */ }
  renderFitButtons();
}
function savePins() {
  try {
    if (S.pins.size) localStorage.setItem(pinKey(), JSON.stringify(Object.fromEntries(S.pins)));
    else localStorage.removeItem(pinKey());
  } catch (_) { /* ignore */ }
  renderFitButtons();
}
function unpin(n) {
  n.fx = n.fy = null;
  S.pins.delete(n.id);
  savePins();
  sim.alpha(Math.max(sim.alpha(), 0.3));
}

function connectStream() {
  const es = new EventSource("/api/stream");
  es.addEventListener("events", ev => {
    const rows = JSON.parse(ev.data);
    if (S.recording && S.selected === S.recording) {
      for (const r of rows) S.events.push(r);
      S.t1 = Math.max(Date.now(), S.t1);
    }
    if (S.recording) Sound.batch(rows); // audible even with this tab in the background
  });
  es.addEventListener("state", async ev => {
    const st = JSON.parse(ev.data);
    S.reachCache = {};
    await loadSessions();
    if (st.cleared !== undefined) {
      if (!S.sessions.some(s => s.id === S.selected)) await selectSession(st.recording || null);
      else renderSide();
    } else if (st.recording) await selectSession(st.recording);
    else if (st.stopped && S.selected === st.stopped) {
      const s = S.sessions.find(x => x.id === st.stopped);
      if (s) { S.t1 = s.stopped; S.follow = false; S.playT = S.t1; renderControls(); }
    }
  });
}

// ---------- formatting ----------
function fmtDur(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
}
function fmtBytes(b) {
  if (!b) return "—";
  const u = ["B", "KB", "MB", "GB"]; let i = 0;
  while (b >= 1024 && i < 3) { b /= 1024; i++; }
  return b.toFixed(b < 10 && i ? 1 : 0) + " " + u[i];
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function pct(a, b) { return b ? Math.round(100 * a / b) : 0; }
function plural(n, w) { return `${n.toLocaleString()} ${n === 1 ? w : w.endsWith("y") ? w.slice(0, -1) + "ies" : w + "s"}`; }
function colorOf(cat) { return (CAT[cat] || CAT.other).color; }

// ---------- left panel ----------
function renderRec() {
  $("rec").classList.toggle("live", !!S.recording);
  $("recLabel").textContent = S.recording ? "Stop recording" : "Start recording";
}

function renderSessions() {
  $("clearAll").classList.toggle("hide", !S.sessions.some(s => !s.active));
  const el = $("sessions");
  if (!S.sessions.length) { el.innerHTML = `<div class="sess"><div class="m">No sessions yet.</div></div>`; return; }
  el.innerHTML = S.sessions.map(s => `
    <div class="sess ${s.id === S.selected ? "sel" : ""}" data-id="${s.id}">
      <div class="n">${s.active ? '<span class="live">REC</span>' : ""}${esc(s.name)}</div>
      <div class="m">${new Date(s.started).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${fmtDur((s.stopped || Date.now()) - s.started)}</div>
      <div class="m">${s.requests} req · ${s.hosts} hosts · ${s.third_party_companies} 3p cos.</div>
      <div class="acts"><a data-act="receipt">Receipt</a><a data-act="rename">Rename</a>${s.active ? "" : '<a data-act="delete">Delete</a>'}</div>
    </div>`).join("");
}

$("sessions").addEventListener("click", async ev => {
  const row = ev.target.closest(".sess[data-id]");
  if (!row) return;
  const id = Number(row.dataset.id);
  const act = ev.target.dataset.act;
  if (act === "receipt") {
    openReceipt(id);
  } else if (act === "rename") {
    const s = S.sessions.find(x => x.id === id);
    const name = prompt("Session name", s.name);
    if (name) { await api(`/api/sessions/${id}/rename`, { method: "POST", body: JSON.stringify({ name }) }); await loadSessions(); }
  } else if (act === "delete") {
    if (confirm("Delete this session and all its captured requests?")) {
      await api(`/api/sessions/${id}/delete`, { method: "POST", body: "{}" });
      S.reachCache = {};
      await loadSessions();
      if (S.selected === id) await selectSession(S.sessions[0]?.id || null);
    }
  } else if (id !== S.selected) {
    await selectSession(id);
  }
});

$("clearAll").onclick = async () => {
  const saved = S.sessions.filter(s => !s.active);
  if (!saved.length) return;
  const reqs = saved.reduce((a, s) => a + s.requests, 0);
  const msg = `Permanently delete ${plural(saved.length, "saved session")} (${reqs.toLocaleString()} requests)?` +
    (S.recording ? "\n\nThe session currently recording will be kept." : "");
  if (confirm(msg)) await api("/api/clear", { method: "POST", body: "{}" });
};

$("rec").onclick = async () => {
  if (S.recording) await api("/api/stop", { method: "POST", body: "{}" });
  else await api("/api/start", { method: "POST", body: "{}" });
  // the "state" SSE event drives the rest
};

// ---------- right panel ----------
function renderSide() {
  $("sReq").textContent = M.req.toLocaleString();
  $("sHosts").textContent = M.hosts.size.toLocaleString();
  $("sCo").textContent = M.cos.size.toLocaleString();
  $("s3p").textContent = pct(M.third, M.req) + "%";
  $("empty").style.display = M.req ? "none" : "flex";
  renderTab();
  renderDetail();
}

$("tabs").addEventListener("click", ev => {
  const b = ev.target.closest("button[data-tab]");
  if (!b) return;
  S.tab = b.dataset.tab;
  for (const x of $("tabs").children) x.classList.toggle("on", x === b);
  renderTab();
});

function bar(value, max, color) {
  return `<div class="bar"><i style="width:${(100 * value / (max || 1)).toFixed(1)}%;background:${color}"></i></div>`;
}
function row(co, right, barHtml, sub) {
  return `<div class="row" data-co="${esc(co)}"><span class="nm">${esc(co)}</span><span class="ct">${right}</span>${sub ? `<div class="sub2">${sub}</div>` : ""}${barHtml}</div>`;
}

function renderTab() {
  const el = $("panel");
  if (!M.req && S.tab !== "reach") { el.innerHTML = `<div class="empty">No requests in view yet.</div>`; return; }
  const fn = { who: tabWho, reach: tabReach, chains: tabChains, bg: tabBackground, blocked: tabBlocked }[S.tab];
  el.innerHTML = fn();
}

function tabWho() {
  const rows = [...M.rank.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 80);
  const max = rows[0]?.[1].count || 1;
  return `<div class="headline">Every company your pages contacted, excluding the sites themselves.</div>` +
    rows.map(([co, r]) => row(co, r.count, bar(r.count, max, colorOf(dominant(r.cats))))).join("");
}

// 1. Cross-site reach
function tabReach() {
  const scopes = [["session", "Session"], ["7", "7 days"], ["30", "30 days"], ["0", "All"]];
  let html = `<div class="scope">${scopes.map(([k, l]) =>
    `<button data-scope="${k}" class="${S.reachScope === k ? "on" : ""}">${l}</button>`).join("")}</div>`;

  let total, list;
  if (S.reachScope === "session") {
    total = M.sites.size;
    list = [...M.rank.entries()].filter(([, r]) => r.pages.size)
      .map(([co, r]) => ({ company: co, sites: r.pages.size, requests: r.count, category: dominant(r.cats) }))
      .sort((a, b) => b.sites - a.sites || b.requests - a.requests);
  } else {
    const scope = S.reachScope, c = S.reachCache[scope];
    if ((!c || Date.now() - c.at > 5000) && !(c && c.loading)) {
      S.reachCache[scope] = { ...(c || {}), loading: true, at: c ? c.at : 0 };
      api(`/api/reach?days=${scope}`)
        .then(d => { S.reachCache[scope] = { data: d, at: Date.now() }; if (S.tab === "reach" && S.reachScope === scope) renderTab(); })
        .catch(() => { S.reachCache[scope] = c; });
    }
    const data = c && c.data;
    if (!data) return html + `<div class="empty">Loading…</div>`;
    total = data.total_sites; list = data.companies;
  }
  if (!list.length || !total) return html + `<div class="empty">No third-party requests in this range.</div>`;
  const top = list[0];
  const many = list.filter(c => c.sites >= Math.max(2, Math.ceil(total / 2))).length;
  html += `<div class="headline"><b>${esc(top.company)}</b> saw you on <b>${top.sites} of ${total}</b> sites (${pct(top.sites, total)}%).` +
    (many > 1 ? ` ${many} companies were on at least half of them.` : "") + `</div>`;
  html += list.slice(0, 80).map(c =>
    row(c.company, `${c.sites}/${total} · ${pct(c.sites, total)}%`, bar(c.sites, total, colorOf(c.category)))).join("");
  html += `<div class="note">Reach counts distinct sites (registrable domains) where the company was a third party. It is the closest thing here to "how much of your browsing can this company stitch together."</div>`;
  return html;
}
$("panel").addEventListener("click", ev => {
  const sc = ev.target.closest("button[data-scope]");
  if (sc) { S.reachScope = sc.dataset.scope; renderTab(); return; }
  const r = ev.target.closest("[data-co]");
  if (r) focusCompany(r.dataset.co);
});

function focusCompany(co) {
  const node = [...M.nodes.values()].find(n => n.kind === "entity" && (n.label === co || n.company === co))
    || M.nodes.get("p:" + co);
  S.focus = node || null;
  renderDetail();
}

// 2 + 3. Fourth parties, frame chains, redirect (ID-sync) chains
function tabChains() {
  const fourth = [...M.via.entries()].filter(([co]) => !M.direct.has(co))
    .map(([co, v]) => ({ co, via: [...v.entries()].sort((a, b) => b[1] - a[1]), n: [...v.values()].reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.n - a.n);
  const all = [...M.chains.values()];
  const redirects = all.filter(c => c.kind === "redirect").sort((a, b) => b.count - a.count);
  const frames = all.filter(c => c.kind === "frame").sort((a, b) => b.count - a.count);
  const syncCos = new Set(redirects.flatMap(c => [c.from, c.to]));

  let html = `<div class="headline">`;
  html += fourth.length
    ? `<b>${plural(fourth.length, "fourth party")}</b> — companies no page loaded directly. They arrived inside another company's frame.`
    : `No fourth parties seen: every third party was loaded by a page itself.`;
  if (redirects.length) html += ` <b>${plural(redirects.length, "redirect chain")}</b> handed you between ${syncCos.size} companies.`;
  html += `</div>`;

  if (fourth.length) {
    const max = fourth[0].n;
    html += `<div class="sect">Fourth parties</div>` + fourth.slice(0, 40).map(f =>
      row(f.co, f.n, bar(f.n, max, colorOf(M.rank.get(f.co) ? dominant(M.rank.get(f.co).cats) : "other")),
        "via " + f.via.slice(0, 3).map(([c]) => esc(c)).join(", "))).join("");
  }
  if (redirects.length) {
    const max = redirects[0].count;
    html += `<div class="sect">Redirect chains (ID sync)</div>` + redirects.slice(0, 40).map(c =>
      `<div class="row" data-co="${esc(c.to)}"><span class="nm">${esc(c.from)}<span class="arrow">→</span>${esc(c.to)}</span><span class="ct">${c.count}</span>${bar(c.count, max, "#c58cff")}</div>`).join("");
  }
  if (frames.length) {
    const max = frames[0].count;
    html += `<div class="sect">Loaded inside 3rd-party frames</div>` + frames.slice(0, 40).map(c =>
      `<div class="row" data-co="${esc(c.to)}"><span class="nm">${esc(c.from)}<span class="arrow">⇢</span>${esc(c.to)}</span><span class="ct">${c.count}</span>${bar(c.count, max, "#ffb347")}</div>`).join("");
  }
  html += `<div class="note">Chrome reports which <i>frame</i> started a request, not which script. A third-party script that injects another script into the page itself still looks "direct," so fourth parties here are a floor, not a full count. Redirects are captured hop by hop.</div>`;
  return html;
}

// 5. Requests with no tab
function tabBackground() {
  if (!M.bgCount) return `<div class="headline">No tab-less requests in view.</div>` + bgNote();
  const groups = [...M.bg.entries()].sort((a, b) => b[1].count - a[1].count);
  const max = groups[0][1].count;
  let html = `<div class="headline"><b>${plural(M.bgCount, "request")}</b> (${pct(M.bgCount, M.req)}% of traffic) came from no tab — work sites did in the background.</div>`;
  html += groups.slice(0, 40).map(([site, g]) => {
    const cos = [...g.cos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, n]) => `${esc(c)} ${n}`).join(" · ");
    const types = [...g.types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([t]) => t).join(", ");
    return row(site, g.count, bar(g.count, max, "#6e7d91"), `${cos}${types ? ` — ${esc(types)}` : ""}`);
  }).join("");
  return html + bgNote();
}
function bgNote() {
  return `<div class="note">Grouped by the site that started the request. Usually service workers (push, sync, offline caching) and prefetches, which can keep running after you leave a site. Chrome hides its own traffic and other extensions' traffic from extensions, so those never appear here.</div>`;
}

// 6. Blocker effectiveness
function tabBlocked() {
  let html = `<div class="headline">`;
  if (!M.trk) html += `No tracker requests (ads, analytics, fingerprinting) in view yet.`;
  else if (!M.trkBlocked) html += `<b>0 of ${M.trk.toLocaleString()}</b> tracker requests were blocked. Either no content blocker is active in this browser, or it blocks in a way Chrome doesn't report.`;
  else html += `Your blocker stopped <b>${M.trkBlocked.toLocaleString()} of ${M.trk.toLocaleString()}</b> tracker requests (${pct(M.trkBlocked, M.trk)}%).`;
  html += `</div>`;
  const rows = [...M.block.entries()].sort((a, b) => (b[1].total - b[1].blocked) - (a[1].total - a[1].blocked) || b[1].total - a[1].total);
  if (rows.length) {
    html += `<div class="sect">Red = blocked · gray = got through</div>`;
    const max = Math.max(...rows.map(([, b]) => b.total));
    html += rows.slice(0, 60).map(([co, b]) => {
      const w = 100 * b.total / max;
      return `<div class="row" data-co="${esc(co)}"><span class="nm">${esc(co)}</span><span class="ct">${b.blocked}/${b.total} · ${pct(b.blocked, b.total)}%</span>
        <div class="bar split" style="width:${w.toFixed(1)}%"><i style="width:${pct(b.blocked, b.total)}%;background:#ff4d5e"></i><i style="flex:1;background:#4a5466"></i></div></div>`;
    }).join("");
  }
  html += `<div class="note">Counts requests that failed with ERR_BLOCKED_BY_CLIENT. A blocked script never runs, so the requests it would have made never appear — the real effect of your blocker is larger than this number. Sorted by requests that got through.</div>`;
  return html;
}

function renderDetail() {
  const el = $("detail"), n = S.focus;
  if (!n || !M.nodes.has(n.id)) { el.style.display = "none"; S.focus = null; return; }
  el.style.display = "block";
  const color = n.kind === "page" ? PAGE_COLOR : colorOf(n.cat);
  const chip = n.kind === "page" ? "page" : CAT[n.cat].label;
  const hosts = [...n.hosts.entries()].sort((a, b) => b[1] - a[1]);
  const pages = [...n.pages];
  const fourth = n.kind === "entity" && n.via.size && !n.direct;
  const extra = [];
  if (n.blocked) extra.push(`${n.blocked} blocked`);
  if (n.failed) extra.push(`${n.failed} failed`);
  el.innerHTML = `
    <h3><span class="chip" style="background:${color}22;color:${color}">${esc(chip)}</span>${esc(n.label)}</h3>
    <div class="sub">${n.count} requests · ${fmtBytes(n.bytes)}${extra.length ? " · " + extra.join(" · ") : ""}${n.kind === "entity" ? ` · on ${plural(pages.length, "page")}` : ""}</div>
    ${fourth ? `<div class="sub" style="color:#ffb347">Fourth party — arrived via ${[...n.via].map(esc).join(", ")}</div>` : ""}
    ${n.redirTo.size ? `<div class="sub" style="color:#c58cff">Redirects you to ${[...n.redirTo.keys()].map(esc).join(", ")}</div>` : ""}
    <ul>${hosts.map(([h, c]) => `<li><span>${esc(h)}</span><span>${c}</span></li>`).join("")}</ul>
    ${n.kind === "entity" && pages.length > 1 ? `<div class="sub" style="margin:8px 0 2px">Seen on</div><ul>${pages.map(p => `<li><span>${esc(p)}</span></li>`).join("")}</ul>` : ""}`;
}

// ---------- toolbar / legend ----------
function setGroup(g) {
  S.groupBy = g;
  $("byCompany").classList.toggle("on", g === "company");
  $("byHost").classList.toggle("on", g === "host");
  S.focus = null;
  rebuild(S.follow ? Infinity : S.playT);
}
$("byCompany").onclick = () => setGroup("company");
$("byHost").onclick = () => setGroup("host");
$("trackersOnly").onclick = () => {
  S.trackersOnly = !S.trackersOnly;
  $("trackersOnly").classList.toggle("on", S.trackersOnly);
  rebuild(S.follow ? Infinity : S.playT);
};
$("fit").onclick = () => fit();
function setLayout(l) {
  S.layout = l;
  $("layStructured").classList.toggle("on", l === "structured");
  $("layOrganic").classList.toggle("on", l === "organic");
  syncSim();
  sim.alpha(0.9);
}
$("layStructured").onclick = () => setLayout("structured");
$("layOrganic").onclick = () => setLayout("organic");
$("unpinAll").onclick = () => {
  for (const n of M.nodes.values()) n.fx = n.fy = null;
  S.pins.clear(); savePins();
  sim.alpha(0.6);
};
function renderFitButtons() {
  $("fit").classList.toggle("on", S.autoFit);
  $("fit").textContent = S.autoFit ? "Auto-fit" : "Fit";
  $("fit").title = S.autoFit ? "Camera follows the graph (pan or zoom to stop)" : "Fit graph to view and follow it (F)";
  $("unpinAll").style.display = S.pins.size ? "" : "none";
  $("unpinAll").textContent = `Unpin ${S.pins.size}`;
}

function renderLegend() {
  $("legend").innerHTML = `<span><i style="background:${PAGE_COLOR}"></i>Page</span>` +
    Object.entries(CAT).map(([k, v]) =>
      `<span data-cat="${k}" class="${S.hidden.has(k) ? "off" : ""}"><i style="background:${v.color}"></i>${v.label}</span>`).join("") +
    `<span style="cursor:default">⇢ via frame</span><span style="cursor:default">┄▸ redirect</span>`;
}
$("legend").addEventListener("click", ev => {
  const s = ev.target.closest("[data-cat]");
  if (!s) return;
  const k = s.dataset.cat;
  S.hidden.has(k) ? S.hidden.delete(k) : S.hidden.add(k);
  renderLegend();
  rebuild(S.follow ? Infinity : S.playT);
});

// ---------- timeline ----------
function renderControls() {
  $("play").textContent = S.playing ? "❚❚" : "▶";
  $("speed").textContent = SPEEDS[S.speedIdx] + "×";
  const live = S.recording && S.selected === S.recording;
  $("follow").style.display = live ? "" : "none";
  $("follow").classList.toggle("on", S.follow);
}

$("play").onclick = togglePlay;
function togglePlay() {
  if (!S.events.length) return;
  S.follow = false;
  if (!S.playing && S.playT >= S.t1 - 50) seek(S.t0);
  S.playing = !S.playing;
  renderControls();
}
$("speed").onclick = () => { S.speedIdx = (S.speedIdx + 1) % SPEEDS.length; renderControls(); };
$("follow").onclick = () => {
  S.follow = !S.follow; S.playing = false;
  if (S.follow) { applyUntil(Infinity, false); renderSide(); }
  renderControls();
};

function seek(t) {
  t = Math.max(S.t0, Math.min(S.t1, t));
  if (t < S.playT) rebuild(t);
  else { applyUntil(t, false); renderSide(); }
  S.playT = t;
}

let dragging = false;
function seekFromEvent(ev) {
  const rect = spark.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
  S.follow = false; renderControls();
  seek(S.t0 + f * (S.t1 - S.t0));
}
spark.addEventListener("pointerdown", ev => { dragging = true; spark.setPointerCapture(ev.pointerId); seekFromEvent(ev); });
spark.addEventListener("pointermove", ev => { if (dragging) seekFromEvent(ev); });
spark.addEventListener("pointerup", () => { dragging = false; });

let histCache = { key: "", bins: [] };
function drawSpark() {
  const w = spark.clientWidth, h = spark.clientHeight;
  if (spark.width !== w * DPR) { spark.width = w * DPR; spark.height = h * DPR; }
  sctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  sctx.clearRect(0, 0, w, h);
  if (!S.events.length || S.t1 <= S.t0) return;
  const N = Math.max(20, Math.floor(w / 4));
  const key = `${S.events.length}|${S.t0}|${Math.round(S.t1 / 1000)}|${N}`;
  if (histCache.key !== key) {
    const bins = Array.from({ length: N }, () => ({ all: 0, trk: 0 }));
    const span = S.t1 - S.t0;
    for (const e of S.events) {
      const i = Math.min(N - 1, Math.floor((e.ts - S.t0) / span * N));
      if (i < 0) continue;
      bins[i].all++;
      if (e.party === "third" && TRACKING.has(e.category)) bins[i].trk++;
    }
    histCache = { key, bins };
  }
  const bins = histCache.bins, max = Math.max(1, ...bins.map(b => b.all));
  const bw = w / N;
  const tNow = S.follow ? S.t1 : S.playT;
  const px = (tNow - S.t0) / (S.t1 - S.t0) * w;
  bins.forEach((b, i) => {
    const x = i * bw, bh = Math.sqrt(b.all / max) * (h - 8), th = Math.sqrt(b.trk / max) * (h - 8);
    const past = x < px;
    sctx.fillStyle = past ? "#3a4659" : "#1d2533";
    sctx.fillRect(x + .5, h - bh, Math.max(1, bw - 1), bh);
    if (b.trk) { sctx.fillStyle = past ? "#ff5c7acc" : "#ff5c7a44"; sctx.fillRect(x + .5, h - th, Math.max(1, bw - 1), th); }
  });
  sctx.fillStyle = S.follow ? "#ff4d5e" : "#7ee0b5";
  sctx.fillRect(Math.min(w - 2, px), 0, 2, h);
  $("clock").textContent = `${fmtDur(tNow - S.t0)} / ${fmtDur(S.t1 - S.t0)}`;
}

// ---------- canvas: zoom, auto-fit, hit test ----------
function localPoint(ev) {
  const rect = canvas.getBoundingClientRect();
  const src = ev.touches ? ev.touches[0] : ev;
  return [src.clientX - rect.left, src.clientY - rect.top];
}
const zoom = d3.zoom().scaleExtent([0.05, 6])
  // Pressing on a node drags the node instead of panning the canvas.
  .filter(ev => {
    if (S.view !== "graph") return false;
    if (ev.type === "wheel") return true;
    if (ev.button) return false;
    if (ev.type === "mousedown" || ev.type === "touchstart") return !nodeAt(...localPoint(ev));
    return true;
  })
  .on("zoom", ev => {
    transform = ev.transform;
    if (ev.sourceEvent && S.autoFit) { S.autoFit = false; renderFitButtons(); } // user took the camera
  });
d3.select(canvas).call(zoom).on("dblclick.zoom", null);

function resize() {
  DPR = window.devicePixelRatio || 1;
  W = canvas.clientWidth; H = canvas.clientHeight;
  canvas.width = W * DPR; canvas.height = H * DPR;
}
window.addEventListener("resize", resize);

function fitTarget() {
  const ns = [...M.nodes.values()];
  if (!ns.length) return d3.zoomIdentity.translate(W / 2, H / 2);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of ns) {
    x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r);
    x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r + 16); // room for the label
  }
  const padX = 60, padTop = 60, padBottom = 50; // clear the toolbar and legend
  const k = Math.max(0.05, Math.min(2.2,
    (W - padX * 2) / (x1 - x0 || 1), (H - padTop - padBottom) / (y1 - y0 || 1)));
  return d3.zoomIdentity
    .translate(W / 2, padTop + (H - padTop - padBottom) / 2)
    .scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
}

// "Fit" re-engages auto-fit; the camera then eases toward the graph each frame.
function fit() { S.autoFit = true; renderFitButtons(); }

// Programmatic zoom (buttons, keys, double-click). Taking manual control turns
// auto-fit off, same as wheel zooming does.
function zoomBy(factor, point) {
  S.autoFit = false; renderFitButtons();
  d3.select(canvas).transition().duration(250).call(zoom.scaleBy, factor, point || [W / 2, H / 2]);
}

function followCamera(dt) {
  if (!S.autoFit || S.drag || !M.nodes.size) return;
  const t = fitTarget();
  const a = 1 - Math.exp(-dt / 220);
  const k = transform.k * Math.pow(t.k / transform.k, a);
  const x = transform.x + (t.x - transform.x) * a;
  const y = transform.y + (t.y - transform.y) * a;
  if (Math.abs(k - transform.k) < 1e-4 && Math.abs(x - transform.x) < 0.1 && Math.abs(y - transform.y) < 0.1) return;
  d3.select(canvas).call(zoom.transform, d3.zoomIdentity.translate(x, y).scale(k));
}

function nodeAt(cx, cy) {
  const [x, y] = transform.invert([cx, cy]);
  let best = null, bd = Infinity;
  for (const n of M.nodes.values()) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < n.r + 4 / transform.k && d < bd) { best = n; bd = d; }
  }
  return best;
}

canvas.addEventListener("mousemove", ev => {
  if (S.view === "entourage") { entHover(ev); return; }
  const rect = canvas.getBoundingClientRect();
  const n = nodeAt(ev.clientX - rect.left, ev.clientY - rect.top);
  S.hover = n;
  if (!n) { tip.style.display = "none"; return; }
  const hosts = [...n.hosts.entries()].sort((a, b) => b[1] - a[1]);
  const cat = n.kind === "page" ? "first-party page" : CAT[n.cat].label.toLowerCase();
  const fourth = n.kind === "entity" && n.via.size && !n.direct;
  tip.innerHTML = `<div class="t">${esc(n.label)}</div><div class="h">${cat} · ${n.count} req${n.kind === "entity" ? ` · ${plural(n.pages.size, "page")}` : ""}</div>` +
    (fourth ? `<div style="color:#ffb347">via ${[...n.via].map(esc).join(", ")}</div>` : "") +
    (n.redirTo.size ? `<div style="color:#c58cff">→ ${[...n.redirTo.keys()].slice(0, 4).map(esc).join(", ")}</div>` : "") +
    hosts.slice(0, 6).map(([h, c]) => `<div>${esc(h)} <span class="h">${c}</span></div>`).join("") +
    (hosts.length > 6 ? `<div class="h">+${hosts.length - 6} more</div>` : "");
  tip.style.display = "block";
  const tx = Math.min(ev.clientX - rect.left + 14, W - tip.offsetWidth - 8);
  const ty = Math.min(ev.clientY - rect.top + 14, H - tip.offsetHeight - 8);
  tip.style.left = tx + "px"; tip.style.top = ty + "px";
});
canvas.addEventListener("mouseleave", () => { S.hover = null; tip.style.display = "none"; });
canvas.addEventListener("click", ev => {
  if (S.view !== "graph") return;
  if (S.justDragged) { S.justDragged = false; return; }
  S.focus = nodeAt(...localPoint(ev));
  renderDetail();
});

// Drag a node to move it; it stays pinned where you drop it.
// Double-click a pinned node to release it.
canvas.addEventListener("pointerdown", ev => {
  if (ev.button || S.view !== "graph") return;
  const p = localPoint(ev);
  const n = nodeAt(...p);
  if (!n) return;
  S.drag = { n, start: p, moved: false, wasPinned: S.pins.has(n.id) };
  n.fx = n.x; n.fy = n.y;
  canvas.setPointerCapture(ev.pointerId);
  canvas.style.cursor = "grabbing";
});
canvas.addEventListener("pointermove", ev => {
  const d = S.drag;
  if (!d) {
    if (S.view === "graph") canvas.style.cursor = nodeAt(...localPoint(ev)) ? "pointer" : "grab";
    return;
  }
  const p = localPoint(ev);
  if (!d.moved && Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) < 4) return;
  d.moved = true;
  tip.style.display = "none";
  const [x, y] = transform.invert(p);
  d.n.fx = x; d.n.fy = y;
  sim.alphaTarget(0.15);
  sim.alpha(Math.max(sim.alpha(), 0.15));
});
function endDrag() {
  const d = S.drag;
  if (!d) return;
  S.drag = null;
  sim.alphaTarget(0);
  canvas.style.cursor = "pointer";
  if (d.moved) {
    S.pins.set(d.n.id, { x: d.n.fx, y: d.n.fy });
    savePins();
    S.justDragged = true;
  } else if (!d.wasPinned) {
    d.n.fx = d.n.fy = null; // a plain click shouldn't pin
  }
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("dblclick", ev => {
  if (S.view !== "graph") return;
  const p = localPoint(ev);
  const n = nodeAt(...p);
  if (n) { if (S.pins.has(n.id)) unpin(n); return; }
  zoomBy(ev.shiftKey ? 0.5 : 2, p);
});
$("zoomIn").onclick = () => zoomBy(1.5);
$("zoomOut").onclick = () => zoomBy(1 / 1.5);
$("zoomFit").onclick = () => fit();

// ---------- draw ----------
function labelSet() {
  const ents = [...M.nodes.values()].filter(n => n.kind === "entity").sort((a, b) => b.count - a.count);
  return new Set(ents.slice(0, transform.k > 1.4 ? 80 : 22).map(n => n.id));
}

function arrowHead(l, k, color) {
  const s = l.source, t = l.target;
  const dx = t.x - s.x, dy = t.y - s.y, d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d;
  const tipX = t.x - ux * (t.r + 3 / k), tipY = t.y - uy * (t.r + 3 / k);
  const sz = 7 / Math.sqrt(k);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - ux * sz - uy * sz * .55, tipY - uy * sz + ux * sz * .55);
  ctx.lineTo(tipX - ux * sz + uy * sz * .55, tipY - uy * sz - ux * sz * .55);
  ctx.closePath(); ctx.fill();
}

function draw(dt) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * .7);
  g.addColorStop(0, "#0e1420"); g.addColorStop(1, "#07090d");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.k, transform.k);
  const k = transform.k;
  const focus = S.focus || S.hover;
  const linked = new Set();
  if (focus) {
    linked.add(focus.id);
    for (const l of M.links.values()) if (l.source === focus || l.target === focus) { linked.add(l.source.id); linked.add(l.target.id); }
  }

  // links: load = plain line, frame = line + arrow, redirect = dashed + arrow
  ctx.lineCap = "round";
  for (const l of M.links.values()) {
    const on = !focus || l.source === focus || l.target === focus;
    const c = l.kind === "redirect" ? "#c58cff" : colorOf(l.target.cat);
    let base = l.kind === "load" ? 0.16 + Math.min(.3, l.count / 200) : 0.55;
    if (S.layout === "structured" && l.kind === "load") {
      if (isLeaf(l.target)) base = (l.source.leafCount || 0) > 30 ? 0.07 : 0.12; // spokes recede
      else base = 0.32 + Math.min(.35, l.count / 150);                         // bridges stand out
    }
    ctx.strokeStyle = c;
    ctx.globalAlpha = (on ? base : 0.03) + l.flash * 0.5;
    ctx.lineWidth = (0.6 + Math.min(4, Math.log2(1 + l.count) * 0.5)) / Math.sqrt(k);
    if (l.kind === "redirect") ctx.setLineDash([5 / k, 4 / k]);
    ctx.beginPath(); ctx.moveTo(l.source.x, l.source.y); ctx.lineTo(l.target.x, l.target.y); ctx.stroke();
    ctx.setLineDash([]);
    if (l.kind !== "load") arrowHead(l, k, c);
    l.flash = Math.max(0, l.flash - dt / 500);
  }
  ctx.globalAlpha = 1;

  // particles: one per request, travelling along its edge
  particles = particles.filter(p => p.t < 1);
  for (const p of particles) {
    p.t += dt / 700;
    const s = p.l.source, t = p.l.target, e = d3.easeCubicInOut(Math.min(1, p.t));
    const x = s.x + (t.x - s.x) * e, y = s.y + (t.y - s.y) * e;
    ctx.fillStyle = p.err ? "#ff4d5e" : p.c;
    ctx.globalAlpha = 0.9 * (1 - Math.max(0, p.t - .85) / .15);
    ctx.beginPath(); ctx.arc(x, y, 2.2 / Math.sqrt(k), 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // nodes
  const labels = labelSet();
  const glow = M.nodes.size < 150; // shadowBlur is the most expensive thing we draw
  for (const n of M.nodes.values()) {
    const dimmed = focus && !linked.has(n.id);
    const color = n.kind === "page" ? PAGE_COLOR : colorOf(n.cat);
    ctx.globalAlpha = dimmed ? 0.12 : 1;

    if (n.pulse > 0) {
      ctx.strokeStyle = color; ctx.lineWidth = 1.5 / k;
      ctx.globalAlpha = (dimmed ? .1 : .7) * n.pulse;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r + (1 - n.pulse) * 14, 0, Math.PI * 2); ctx.stroke();
      n.pulse = Math.max(0, n.pulse - dt / 600);
      ctx.globalAlpha = dimmed ? 0.12 : 1;
    }

    if (n.kind === "page") {
      ctx.fillStyle = "#0b0f16";
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = PAGE_COLOR; ctx.lineWidth = 2 / Math.sqrt(k); ctx.stroke();
      ctx.fillStyle = PAGE_COLOR;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r * .32, 0, Math.PI * 2); ctx.fill();
    } else {
      const fourth = n.via.size && !n.direct;
      ctx.fillStyle = color;
      ctx.shadowColor = color; ctx.shadowBlur = dimmed || !glow ? 0 : 10;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      if (fourth) { // hollow: never loaded by a page directly
        ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = "#0b0f16";
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r * .5, 0, Math.PI * 2); ctx.fill();
      } else ctx.fill();
      ctx.shadowBlur = 0;
      if (n.pageCount > 1) { // shared across pages: the cross-site trackers
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.2 / k;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 2.5 / k, 0, Math.PI * 2); ctx.stroke();
      }
      if (n.blocked) {
        ctx.setLineDash([3 / k, 3 / k]); ctx.strokeStyle = "#ff4d5e"; ctx.lineWidth = 1.2 / k;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 5 / k, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if (S.pins.has(n.id)) { // pinned: small pushpin at upper right
      const a = -Math.PI / 4, px = n.x + Math.cos(a) * (n.r + 3 / k), py = n.y + Math.sin(a) * (n.r + 3 / k);
      ctx.strokeStyle = "#7ee0b5"; ctx.lineWidth = 1.5 / k;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + 4 / k, py - 4 / k); ctx.stroke();
      ctx.fillStyle = "#7ee0b5";
      ctx.beginPath(); ctx.arc(px + 5 / k, py - 5 / k, 3 / k, 0, Math.PI * 2); ctx.fill();
    }

    if (n.kind === "page" || labels.has(n.id) || n === focus) {
      const fs = (n.kind === "page" ? 12 : 10.5) / Math.min(k, 1.6);
      ctx.font = `${n.kind === "page" ? 600 : 400} ${fs}px -apple-system, system-ui, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillStyle = n.kind === "page" ? "#fff" : "#c3ccd9";
      ctx.globalAlpha = dimmed ? 0.12 : (n.kind === "page" ? 1 : .85);
      ctx.fillText(n.label, n.x, n.y + n.r + 4 / k);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ---------- Geiger counter ----------
// One click per tracker request that actually went out (blocked ones are
// silent), plus a throttled cash register for ad requests. Live sound is
// driven from the event stream, not the render loop, so it keeps playing when
// this tab is in the background and you're browsing elsewhere.
const Sound = {
  ctx: null, master: null, noise: null, nextFree: 0, lastKa: 0,
  init() {
    if (this.ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    const len = Math.floor(this.ctx.sampleRate * 0.06);
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return true;
  },
  // Reserve a time slot; drop the sound if the queue is already far ahead
  // (fast replay of a 5,000-request page would otherwise ring for minutes).
  slot(at) {
    const now = this.ctx.currentTime;
    const t = Math.max(at, now + 0.005, this.nextFree);
    if (t - now > 0.6) return null;
    this.nextFree = t + 0.007; // ~140 clicks/s ceiling
    return t;
  },
  click(at) {
    const t = this.slot(at);
    if (t == null) return;
    const c = this.ctx, src = c.createBufferSource(), bp = c.createBiquadFilter(), g = c.createGain();
    src.buffer = this.noise;
    bp.type = "bandpass"; bp.frequency.value = 2200 + Math.random() * 2600; bp.Q.value = 0.9;
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.012);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.03, 0.015);
  },
  kaching(at) {
    const now = this.ctx.currentTime;
    if (now - this.lastKa < 0.45) return; // one register per ~half second
    this.lastKa = now;
    const c = this.ctx, t = Math.max(at, now + 0.01);
    for (const [f, off] of [[1318.5, 0], [1975.5, 0.07], [2637, 0.07]]) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = "triangle"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + off);
      g.gain.exponentialRampToValueAtTime(0.2, t + off + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.45);
      o.connect(g).connect(this.master);
      o.start(t + off); o.stop(t + off + 0.5);
    }
    const src = c.createBufferSource(), hp = c.createBiquadFilter(), g = c.createGain(); // drawer rattle
    src.buffer = this.noise; hp.type = "highpass"; hp.frequency.value = 5000;
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    src.connect(hp).connect(g).connect(this.master);
    src.start(t);
  },
  event(e, at) {
    if (e.party !== "third" || !TRACKING.has(e.category) || isBlocked(e.error)) return;
    this.click(at);
    if (e.category === "ads") this.kaching(at);
  },
  // Live batches arrive every ~500 ms; replay each batch with its own rhythm.
  batch(rows) {
    if (!S.sound || !this.ctx || !rows.length) return;
    const base = Math.min(...rows.map(r => r.ts)), start = this.ctx.currentTime + 0.05;
    for (const e of rows) this.event(e, start + Math.min(0.5, Math.max(0, (e.ts - base) / 1000)));
  },
};
function setSound(on) {
  if (on && !Sound.init()) return;
  S.sound = on;
  if (on && Sound.ctx.state === "suspended") Sound.ctx.resume();
  $("sound").classList.toggle("on", on);
  $("sound").textContent = on ? "◉ Geiger" : "○ Geiger";
}
$("sound").onclick = () => setSound(!S.sound);

// ---------- entourage view ----------
// You walk down a street of the sites you visited. Every company that has now
// seen you on 2+ sites steps out of the storefront where it caught up with you
// and joins the crowd behind you.
const ENT = { camX: 0, youX: 0, phase: 0, followers: new Map(), modelRef: null, snap: true, hits: [], hover: null };
const SPACING = 340, MAX_FOLLOWERS_DRAWN = 120, FIG = 1.85; // FIG: figure scale

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function setView(v) {
  S.view = v;
  $("viewGraph").classList.toggle("on", v === "graph");
  $("viewEnt").classList.toggle("on", v === "entourage");
  $("stage").classList.toggle("ent", v === "entourage");
  tip.style.display = "none";
  canvas.style.cursor = v === "graph" ? "grab" : "default";
  ENT.snap = true;
}
$("viewGraph").onclick = () => setView("graph");
$("viewEnt").onclick = () => setView("entourage");

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function drawStore(x, ground, site, current, inside) {
  const hs = hash(site);
  const w = 190, h = 150 + (hs % 90), top = ground - h;
  ctx.fillStyle = current ? "#1a2233" : "#141b28";
  ctx.fillRect(x - w / 2, top, w, h);
  ctx.strokeStyle = "#232d40"; ctx.lineWidth = 1;
  ctx.strokeRect(x - w / 2 + .5, top + .5, w - 1, h - 1);
  // windows
  for (let r = 0; r < Math.floor((h - 70) / 26); r++) for (let c = 0; c < 5; c++) {
    const lit = (hash(site + r + ":" + c) % 5) < 2;
    ctx.fillStyle = lit ? (current ? "#f5d67a55" : "#f5d67a26") : "#0c111b";
    ctx.fillRect(x - w / 2 + 14 + c * 34, top + 12 + r * 26, 22, 14);
  }
  // awning in the site's "brand" hue (stable per site)
  const hue = hs % 360;
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = i % 2 ? `hsl(${hue} 45% 30%)` : `hsl(${hue} 30% 82%)`;
    ctx.fillRect(x - w / 2 + 8 + i * 21.75, ground - 62, 21.75, 10);
  }
  // door
  ctx.fillStyle = "#07090d";
  ctx.fillRect(x - 13, ground - 40, 26, 40);
  ctx.fillStyle = current ? "#f5d67a33" : "#f5d67a14";
  ctx.fillRect(x - 11, ground - 38, 22, 36);
  // sign
  ctx.font = "600 12px -apple-system, system-ui, sans-serif";
  const tw = Math.min(w - 16, ctx.measureText(site).width + 18);
  roundRect(x - tw / 2, ground - 88, tw, 22, 4);
  ctx.fillStyle = current ? "#0b0f16" : "#0b0f16cc"; ctx.fill();
  ctx.strokeStyle = current ? "#7ee0b5" : "#33405a"; ctx.lineWidth = current ? 1.5 : 1; ctx.stroke();
  if (current) { ctx.shadowColor = "#7ee0b5"; ctx.shadowBlur = 12; ctx.stroke(); ctx.shadowBlur = 0; }
  ctx.fillStyle = current ? "#ffffff" : "#c3ccd9"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(site, x, ground - 77, w - 24);
  if (inside) {
    ctx.font = "10px ui-monospace, Menlo, monospace"; ctx.fillStyle = "#7d889a";
    ctx.fillText(`${inside} compan${inside === 1 ? "y" : "ies"} inside`, x, top - 10);
  }
}

function drawFigure(x, feet, sc, coat, phase, moving, spy) {
  const bob = moving ? Math.abs(Math.sin(phase)) * 1.6 * sc : 0;
  const y = feet - bob, swing = moving ? Math.sin(phase) * 4 * sc : 0;
  ctx.fillStyle = "#00000055"; // shadow
  ctx.beginPath(); ctx.ellipse(x, feet + 1, 8 * sc, 2.2 * sc, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#05070b"; ctx.lineWidth = 2.6 * sc; ctx.lineCap = "round"; // legs
  ctx.beginPath();
  ctx.moveTo(x - 1.5 * sc, y - 9 * sc); ctx.lineTo(x - 3 * sc + swing, y);
  ctx.moveTo(x + 1.5 * sc, y - 9 * sc); ctx.lineTo(x + 3 * sc - swing, y);
  ctx.stroke();
  ctx.fillStyle = coat; // coat
  ctx.beginPath();
  ctx.moveTo(x - 4.5 * sc, y - 24 * sc); ctx.lineTo(x + 4.5 * sc, y - 24 * sc);
  ctx.lineTo(x + 7.5 * sc, y - 7 * sc); ctx.lineTo(x - 7.5 * sc, y - 7 * sc); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#00000040"; ctx.fillRect(x - 6 * sc, y - 15 * sc, 12 * sc, 1.6 * sc); // belt
  if (spy) { ctx.fillStyle = "#ffffff22"; ctx.beginPath(); ctx.moveTo(x - 4.5 * sc, y - 24 * sc); ctx.lineTo(x, y - 18 * sc); ctx.lineTo(x + 4.5 * sc, y - 24 * sc); ctx.fill(); } // collar
  ctx.fillStyle = spy ? "#cfd6e0" : "#ffffff"; // head
  ctx.beginPath(); ctx.arc(x, y - 28.5 * sc, 4.4 * sc, 0, Math.PI * 2); ctx.fill();
  if (spy) {
    ctx.fillStyle = "#151a26"; // fedora
    ctx.fillRect(x - 7 * sc, y - 32 * sc, 14 * sc, 1.8 * sc);
    roundRect(x - 4.4 * sc, y - 36.5 * sc, 8.8 * sc, 5 * sc, 1.5 * sc); ctx.fill();
    ctx.strokeStyle = "#05070b"; ctx.lineWidth = 1.6 * sc; // sunglasses
    ctx.beginPath(); ctx.moveTo(x - 3.6 * sc, y - 28.6 * sc); ctx.lineTo(x + 3.6 * sc, y - 28.6 * sc); ctx.stroke();
  }
}

function tag(x, y, text, color) {
  ctx.font = "600 10px -apple-system, system-ui, sans-serif";
  const w = ctx.measureText(text).width + 10;
  roundRect(x - w / 2, y - 15, w, 15, 3);
  ctx.fillStyle = "#0b0f16e6"; ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = "#e6ebf2"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, x, y - 7.5);
}

function followerList() {
  return [...M.rank.entries()].filter(([, r]) => r.pages.size >= 2)
    .sort((a, b) => b[1].pages.size - a[1].pages.size || b[1].count - a[1].count);
}

function drawEntourage(dt) {
  if (ENT.modelRef !== M) { ENT.modelRef = M; ENT.followers = new Map(); ENT.snap = true; }
  const s = dt / 1000;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#06080e"); sky.addColorStop(1, "#111827");
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
  const ground = Math.round(H * 0.64);

  // you walk to the latest storefront; the camera trails you
  const target = Math.max(0, M.visits.length - 1) * SPACING;
  if (ENT.snap) ENT.youX = target;
  const dx = target - ENT.youX, moving = Math.abs(dx) > 1;
  ENT.youX += Math.sign(dx) * Math.min(Math.abs(dx), Math.max(170, Math.abs(dx) * 1.2) * s);
  if (moving) ENT.phase += s * 9;
  const camTarget = ENT.youX - W * 0.6;
  ENT.camX = ENT.snap ? camTarget : ENT.camX + (camTarget - ENT.camX) * (1 - Math.exp(-s * 3));
  const sx = x => x - ENT.camX;

  // distant skyline (parallax)
  ctx.fillStyle = "#0d1320";
  const p = ENT.camX * 0.3;
  for (let i = Math.floor((p - 100) / 64); i < (p + W + 100) / 64; i++) {
    const h = 50 + hash("sky" + i) % 140;
    ctx.fillRect(i * 64 - p, ground - 30 - h, 56, h + 30);
  }
  // street
  ctx.fillStyle = "#0a0d14"; ctx.fillRect(0, ground, W, H - ground);
  ctx.fillStyle = "#1d2533"; ctx.fillRect(0, ground, W, 2);
  ctx.fillStyle = "#1a2130";
  for (let i = Math.floor((ENT.camX - 60) / 80); i < (ENT.camX + W + 60) / 80; i++) ctx.fillRect(i * 80 - ENT.camX, ground + 58, 40, 3);

  // storefronts
  M.visits.forEach((v, i) => {
    const x = sx(i * SPACING);
    if (x < -260 || x > W + 260) return;
    drawStore(x, ground, v.site, i === M.visits.length - 1, M.siteCos.get(v.site)?.size || 0);
  });

  // followers
  const list = followerList();
  const live = new Set();
  list.slice(0, MAX_FOLLOWERS_DRAWN).forEach(([co, r], j) => {
    live.add(co);
    const lane = j % 4, col = Math.floor(j / 4);
    const tx = ENT.youX - 72 - col * 46 - (lane % 2) * 23;
    const ty = ground + 16 + lane * 19;
    let f = ENT.followers.get(co);
    if (!f) {
      const at = M.joinAt.get(co);
      const doorX = at != null ? at * SPACING : ENT.youX;
      f = { x: ENT.snap ? tx : doorX, y: ENT.snap ? ty : ground + 2, phase: Math.random() * 6, lag: 1.6 + (hash(co) % 10) / 10 };
      ENT.followers.set(co, f);
    }
    Object.assign(f, { tx, ty, co, r, rank: j });
  });
  for (const co of [...ENT.followers.keys()]) if (!live.has(co)) ENT.followers.delete(co);

  const people = [...ENT.followers.values()];
  for (const f of people) {
    const k = 1 - Math.exp(-s * f.lag);
    const mx = (f.tx - f.x) * k, my = (f.ty - f.y) * k;
    f.x += mx; f.y += my;
    f.moving = Math.abs(f.tx - f.x) > 2 || Math.abs(f.ty - f.y) > 2;
    if (f.moving) f.phase += s * 9;
  }
  people.push({ you: true, x: ENT.youX, y: ground + 44, moving, phase: ENT.phase });
  people.sort((a, b) => a.y - b.y);

  ENT.hits = [];
  for (const f of people) {
    const x = sx(f.x);
    if (x < -40 || x > W + 40) continue;
    if (f.you) { drawFigure(x, f.y, 1.2 * FIG, "#e8edf5", f.phase, f.moving, false); continue; }
    const sc = (0.82 + Math.min(0.45, (f.r.pages.size - 2) * 0.09)) * FIG;
    const cat = dominant(f.r.cats);
    drawFigure(x, f.y, sc, colorOf(cat), f.phase, f.moving, true);
    ENT.hits.push({ x, y: f.y, sc, co: f.co, r: f.r });
  }
  // tags: "you" always; a follower only while hovered (the roster names the rest)
  for (const f of people) {
    if (f.you) { tag(sx(f.x), f.y - 46 * FIG, "you", "#e8edf5"); continue; }
    if (f.co === ENT.hover) {
      const sc = (0.82 + Math.min(0.45, (f.r.pages.size - 2) * 0.09)) * FIG;
      tag(sx(f.x), f.y - 40 * sc - 2, `${f.co} · ${plural(f.r.pages.size, "site")}`, colorOf(dominant(f.r.cats)));
    }
  }

  // HUD
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff"; ctx.font = "600 22px -apple-system, system-ui, sans-serif";
  ctx.fillText(list.length ? `Your entourage: ${list.length}` : "No one's following you yet", 16, 82);
  ctx.fillStyle = "#7d889a"; ctx.font = "12px -apple-system, system-ui, sans-serif";
  ctx.fillText(list.length
    ? `companies that have seen you on 2+ of the ${M.visits.length} sites you visited${list.length > MAX_FOLLOWERS_DRAWN ? ` · ${list.length - MAX_FOLLOWERS_DRAWN} more not shown` : ""}`
    : "A company joins when it shows up on a second site you visit.", 16, 102);

  // roster: the most devoted followers
  const rosterN = Math.min(list.length, Math.max(3, Math.floor((ground - 220) / 20)), 10);
  list.slice(0, rosterN).forEach(([co, r], i) => {
    const y = 132 + i * 20;
    ctx.fillStyle = colorOf(dominant(r.cats));
    ctx.beginPath(); ctx.arc(21, y - 4, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = co === ENT.hover ? "#ffffff" : "#c3ccd9"; ctx.font = "12px -apple-system, system-ui, sans-serif";
    ctx.textAlign = "left"; ctx.fillText(co, 32, y);
    ctx.fillStyle = "#7d889a"; ctx.font = "11px ui-monospace, Menlo, monospace";
    ctx.fillText(`${r.pages.size}/${M.visits.length} sites`, 180, y);
  });
  if (list.length > rosterN) {
    ctx.fillStyle = "#4a5466"; ctx.font = "11px ui-monospace, Menlo, monospace";
    ctx.fillText(`+ ${list.length - rosterN} more in the crowd`, 16, 132 + rosterN * 20);
  }

  // join announcements
  M.toasts = M.toasts.filter(t => (t.age += s) < 4.5);
  M.toasts.slice(-5).forEach((t, i, arr) => {
    const a = Math.min(1, t.age * 4) * Math.min(1, (4.5 - t.age) / 0.8);
    ctx.globalAlpha = a;
    ctx.font = "12px -apple-system, system-ui, sans-serif";
    ctx.textAlign = "left";
    const text = `${t.company} joined your entourage at ${t.site}`;
    const w = ctx.measureText(text).width + 22;
    const y = 64 + (arr.length - 1 - i) * 26;
    roundRect(W - 16 - w, y, w, 20, 10);
    ctx.fillStyle = "#121823"; ctx.fill();
    ctx.strokeStyle = t.color; ctx.stroke();
    ctx.fillStyle = "#d6dde8"; ctx.textBaseline = "middle";
    ctx.fillText(text, W - 16 - w + 11, y + 10.5);
  });
  ctx.globalAlpha = 1;
  ENT.snap = false;
}

function entHover(ev) {
  const [px, py] = localPoint(ev);
  let hit = null;
  for (const h of ENT.hits) {
    if (Math.abs(px - h.x) < 8.5 * h.sc && py < h.y + 3 && py > h.y - 38 * h.sc) hit = h; // later = in front
  }
  ENT.hover = hit ? hit.co : null;
  if (!hit) { tip.style.display = "none"; return; }
  const sites = [...hit.r.pages];
  tip.innerHTML = `<div class="t">${esc(hit.co)}</div><div class="h">followed you to ${plural(sites.length, "site")}</div>` +
    sites.slice(0, 8).map(s => `<div>${esc(s)}</div>`).join("") + (sites.length > 8 ? `<div class="h">+${sites.length - 8} more</div>` : "");
  tip.style.display = "block";
  tip.style.left = Math.min(px + 14, W - tip.offsetWidth - 8) + "px";
  tip.style.top = Math.min(py + 14, H - tip.offsetHeight - 8) + "px";
}

// ---------- receipt ----------
function summarize(events) {
  const pages = new Map(), cos = new Set(), hosts = new Set(), reach = new Map(), ads = new Set();
  const direct = new Set(), viaFrame = new Set();
  let req = 0, bytes = 0, trk = 0, blocked = 0, redirects = 0;
  for (const e of events) {
    req++; hosts.add(e.host); bytes += e.size || 0;
    if (e.party !== "background") {
      let p = pages.get(e.page_site);
      if (!p) { p = { req: 0, cos: new Set() }; pages.set(e.page_site, p); }
      p.req++;
      if (e.party === "third") p.cos.add(e.company);
    }
    if (e.party === "third") {
      cos.add(e.company);
      (reach.get(e.company) || reach.set(e.company, new Set()).get(e.company)).add(e.page_site);
      if (e.category === "ads") ads.add(e.company);
      if (TRACKING.has(e.category)) { trk++; if (isBlocked(e.error)) blocked++; }
    }
    if (e.party === "third" || e.party === "same-owner") {
      if (e.init_party === "third" && e.init_company && e.init_company !== e.company && e.party === "third") viaFrame.add(e.company);
      else direct.add(e.company);
    }
    if (e.redir_company && e.redir_party && e.redir_party !== "first" && e.redir_company !== e.company) redirects++;
  }
  const followers = [...reach.entries()].filter(([, s]) => s.size >= 2).sort((a, b) => b[1].size - a[1].size);
  return {
    pages: [...pages.entries()], req, hosts: hosts.size, cos: cos.size, bytes, trk, blocked, redirects,
    ads: ads.size, fourth: [...viaFrame].filter(c => !direct.has(c)).length,
    followers, sites: pages.size,
  };
}

// One list of receipt lines drives every output: the on-screen HTML, the
// plain-text copy, and the PNG copy, so they can never disagree.
//   {k:"c"} centred · {k:"lr"} left/right · {k:"sub"} indented note
//   {k:"hr"} rule · {k:"dbl"} double rule · {k:"bar"} barcode · {k:"fine"} small print
function barcodeBars(seed) {
  let h = hash(seed), x = 0;
  const bars = [];
  while (x < 250) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    const w = 1 + (h % 3), gap = 1 + ((h >>> 3) % 3);
    bars.push([x, w]);
    x += w + gap;
  }
  return bars;
}

function receiptLines(sess, R, events) {
  const n = v => v.toLocaleString();
  const when = new Date(sess.started);
  const span = events.length ? events[events.length - 1].ts - events[0].ts : 0;
  const dur = Math.max((sess.stopped || Date.now()) - sess.started, span);
  const top = R.followers[0];
  const code = String(hash(`${sess.id}:${R.req}:${R.cos}`)).padStart(10, "0");
  const L = [
    { k: "c", t: "TATTLETAB MART", big: true },
    { k: "c", t: "Where the product is you" },
    { k: "c", t: `LOCALHOST BRANCH #${location.port || "8787"}` },
    { k: "hr" },
    { k: "lr", a: when.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }), b: when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) },
    { k: "lr", a: "SESSION", b: sess.name.slice(0, 26) },
    { k: "hr" },
    { k: "lr", a: "QTY ITEM", b: "REQS", bold: true },
  ];
  if (!R.pages.length) L.push({ k: "sub", t: "(nothing purchased)" });
  for (const [site, p] of R.pages.slice(0, 14)) {
    L.push({ k: "lr", a: `1  ${site}`, b: n(p.req) });
    L.push({ k: "sub", t: `${plural(p.cos.size, "company")} inside` });
  }
  if (R.pages.length > 14) L.push({ k: "sub", t: `… ${R.pages.length - 14} more items` });
  L.push(
    { k: "hr" },
    { k: "lr", a: "REQUESTS", b: n(R.req) },
    { k: "lr", a: "HOSTS CONTACTED", b: n(R.hosts) },
    { k: "lr", a: "THIRD-PARTY COMPANIES", b: n(R.cos) },
    { k: "lr", a: "AD COMPANIES", b: n(R.ads) },
    { k: "lr", a: "FOURTH PARTIES", b: n(R.fourth), note: R.fourth ? "(free w/ purchase)" : "" },
    { k: "lr", a: "ID-SYNC HANDOFFS", b: n(R.redirects) },
    { k: "lr", a: "DATA (REPORTED SIZES)", b: fmtBytes(R.bytes) },
    { k: "hr" },
    { k: "lr", a: "TRACKER SURCHARGE", b: `${pct(R.trk, R.req)}%` },
    R.blocked ? { k: "lr", a: "COUPON: AD BLOCKER", b: `-${n(R.blocked)} req` } : { k: "lr", a: "COUPONS APPLIED", b: "none" },
    { k: "dbl" },
    { k: "lr", a: "TOTAL ATTENTION SPENT", b: fmtDur(dur), bold: true },
    { k: "lr", a: "ENTOURAGE ACQUIRED", b: plural(R.followers.length, "follower"), bold: true },
  );
  if (top) L.push({ k: "lr", a: "MOST DEVOTED FOLLOWER", b: `${top[0]} (${top[1].size}/${R.sites})` });
  L.push(
    { k: "hr" },
    { k: "bar", code },
    { k: "c", t: code },
    { k: "c", t: "THANK YOU FOR BROWSING!", bold: true, gap: true },
    { k: "c", t: "NO REFUNDS. ALL DATA IS FINAL SALE." },
    { k: "fine", t: "Counts from requests your browser made, as seen by the Tattletab extension." },
  );
  return L;
}

function receiptHTML(lines) {
  return lines.map(l => {
    switch (l.k) {
      case "c": return `<div class="c${l.big ? " big" : ""}${l.bold ? " gap" : ""}">${esc(l.t)}</div>`;
      case "lr": return `<div class="ln${l.bold ? " tot" : ""}"><span>${esc(l.a)}</span><span>${esc(l.b)}${l.note ? ` <small>${esc(l.note)}</small>` : ""}</span></div>`;
      case "sub": return `<div class="sub">&nbsp;&nbsp;&nbsp;&nbsp;${esc(l.t)}</div>`;
      case "hr": return `<div class="hr"></div>`;
      case "dbl": return `<div class="hr dbl"></div>`;
      case "bar": return `<div class="c bar"><svg viewBox="0 0 250 44" width="250" height="44" fill="#1b1b1b">${barcodeBars(l.code).map(([x, w]) => `<rect x="${x}" y="0" width="${w}" height="44"/>`).join("")}</svg></div>`;
      case "fine": return `<div class="c fine">${esc(l.t)}</div>`;
    }
    return "";
  }).join("");
}

// Plain text, 40 columns: pastes cleanly anywhere with a monospace font.
function receiptText(lines) {
  const W = 40, up = s => String(s).toUpperCase();
  const center = s => { s = s.slice(0, W); const p = Math.floor((W - s.length) / 2); return " ".repeat(p) + s; };
  const wrap = s => { const out = []; let cur = ""; for (const w of s.split(" ")) { if ((cur + " " + w).trim().length > W) { out.push(cur); cur = w; } else cur = (cur + " " + w).trim(); } if (cur) out.push(cur); return out; };
  const out = [];
  for (const l of lines) {
    if (l.k === "c") { if (l.gap) out.push(""); out.push(center(up(l.t))); }
    else if (l.k === "lr") {
      const b = up(l.b) + (l.note ? " " + l.note : "");
      const a = up(l.a).slice(0, Math.max(4, W - b.length - 1));
      out.push(a + " ".repeat(Math.max(1, W - a.length - b.length)) + b);
    }
    else if (l.k === "sub") out.push("    " + l.t);
    else if (l.k === "hr") out.push("-".repeat(W));
    else if (l.k === "dbl") out.push("=".repeat(W));
    else if (l.k === "bar") {
      let s = ""; for (const [, w] of barcodeBars(l.code)) s += (w === 1 ? "|" : w === 2 ? "‖" : "█");
      out.push(center(s.slice(0, 34)));
    }
    else if (l.k === "fine") { out.push(""); for (const ln of wrap(l.t)) out.push(center(ln)); }
  }
  return out.join("\n");
}

// Draw the receipt onto a canvas directly (no DOM screenshotting, so it works
// the same in every browser and never taints the canvas).
function receiptCanvas(lines) {
  const S2 = 2, W = 340, pad = 22, mono = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  const lh = { c: 18, lr: 18, sub: 16, hr: 17, dbl: 19, bar: 56, fine: 14 };
  const fineLines = l => Math.ceil(l.t.length / 52);
  let h = 26;
  for (const l of lines) h += (l.k === "fine" ? fineLines(l) * lh.fine + 10 : lh[l.k]) + (l.big ? 8 : 0) + (l.gap ? 10 : 0);
  h += 14;
  const cv = document.createElement("canvas");
  cv.width = W * S2; cv.height = h * S2;
  const g = cv.getContext("2d");
  g.scale(S2, S2);
  // paper with a torn (zigzag) bottom edge
  g.fillStyle = "#f6f3ec";
  g.beginPath(); g.moveTo(0, 0); g.lineTo(W, 0); g.lineTo(W, h - 8);
  for (let x = W; x > 0; x -= 14) { g.lineTo(x - 7, h); g.lineTo(x - 14, h - 8); }
  g.closePath(); g.fill();
  g.fillStyle = "#1b1b1b"; g.textBaseline = "middle";
  let y = 26;
  const font = (px, bold) => { g.font = `${bold ? 700 : 400} ${px}px ${mono}`; };
  for (const l of lines) {
    if (l.gap) y += 10;
    if (l.k === "c") {
      font(l.big ? 19 : 12, l.big || l.bold); g.textAlign = "center"; g.fillStyle = "#1b1b1b";
      g.fillText(String(l.t).toUpperCase(), W / 2, y + (l.big ? 4 : 0), W - pad * 2);
      y += lh.c + (l.big ? 8 : 0);
    } else if (l.k === "lr") {
      font(l.bold ? 13 : 12, l.bold); g.fillStyle = "#1b1b1b";
      const b = String(l.b).toUpperCase();
      g.textAlign = "right";
      let right = W - pad;
      if (l.note) { font(9, false); g.fillStyle = "#666"; g.fillText(l.note.toUpperCase(), right, y); right -= g.measureText(l.note.toUpperCase()).width + 5; font(l.bold ? 13 : 12, l.bold); g.fillStyle = "#1b1b1b"; }
      g.fillText(b, right, y);
      const bw = g.measureText(b).width;
      g.textAlign = "left";
      g.fillText(String(l.a).toUpperCase(), pad, y, Math.max(40, right - bw - pad - 10));
      y += lh.lr;
    } else if (l.k === "sub") {
      font(11, false); g.fillStyle = "#666"; g.textAlign = "left";
      g.fillText(l.t, pad + 28, y); y += lh.sub;
    } else if (l.k === "hr" || l.k === "dbl") {
      g.strokeStyle = l.k === "dbl" ? "#555" : "#999"; g.lineWidth = 1;
      if (l.k === "hr") g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(pad, y + .5); g.lineTo(W - pad, y + .5); g.stroke();
      if (l.k === "dbl") { g.beginPath(); g.moveTo(pad, y + 3.5); g.lineTo(W - pad, y + 3.5); g.stroke(); }
      g.setLineDash([]);
      y += lh[l.k];
    } else if (l.k === "bar") {
      g.fillStyle = "#1b1b1b";
      const x0 = (W - 250) / 2;
      for (const [x, w] of barcodeBars(l.code)) g.fillRect(x0 + x, y - 4, w, 44);
      y += lh.bar;
    } else if (l.k === "fine") {
      font(9, false); g.fillStyle = "#777"; g.textAlign = "center";
      y += 6;
      const words = l.t.split(" "); let cur = "";
      for (const w of words) {
        if (g.measureText(cur + " " + w).width > W - pad * 2 && cur) { g.fillText(cur, W / 2, y); y += lh.fine; cur = w; }
        else cur = (cur + " " + w).trim();
      }
      if (cur) { g.fillText(cur, W / 2, y); y += lh.fine; }
    }
  }
  return cv;
}

let currentReceipt = null; // {lines, name}

async function openReceipt(id) {
  const sess = S.sessions.find(s => s.id === id);
  if (!sess) return;
  const events = id === S.selected ? S.events : await api(`/api/sessions/${id}/events`);
  const lines = receiptLines(sess, summarize(events), events);
  currentReceipt = { lines, name: sess.name };
  $("receiptPaper").innerHTML = receiptHTML(lines);
  $("receiptModal").hidden = false;
}

function flash(btn, text) {
  const orig = btn.dataset.label || (btn.dataset.label = btn.textContent);
  btn.textContent = text;
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.textContent = orig; }, 1600);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* fall back below */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
  ta.remove();
  return ok;
}

function receiptFilename() {
  const slug = (currentReceipt?.name || "session").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `tattletab-receipt-${slug || "session"}.png`;
}

$("receiptCopyText").onclick = async () => {
  if (!currentReceipt) return;
  flash($("receiptCopyText"), await copyText(receiptText(currentReceipt.lines)) ? "Copied ✓" : "Copy failed");
};
$("receiptCopyImg").onclick = async () => {
  if (!currentReceipt) return;
  const btn = $("receiptCopyImg");
  const cv = receiptCanvas(currentReceipt.lines);
  const blob = new Promise(res => cv.toBlob(res, "image/png"));
  try {
    if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error("no image clipboard");
    // Passing the promise (not the blob) keeps the user-gesture alive in Safari.
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    flash(btn, "Copied ✓");
  } catch (_) {
    // Browser won't put images on the clipboard: download the PNG instead.
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await blob);
    a.download = receiptFilename();
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    flash(btn, "Saved PNG ✓");
  }
};
$("receiptClose").onclick = () => { $("receiptModal").hidden = true; };
$("receiptModal").addEventListener("click", ev => { if (ev.target.id === "receiptModal") $("receiptModal").hidden = true; });
$("receiptPrint").onclick = () => window.print();

// ---------- main loop ----------
let last = performance.now(), sideTimer = 0;
function frame(now) {
  const dt = Math.min(100, now - last); last = now;
  let changed = false;
  if (S.follow) {
    changed = applyUntil(Infinity, true);
    S.t1 = Math.max(S.t1, Date.now());
  } else if (S.playing) {
    S.playT += dt * SPEEDS[S.speedIdx];
    changed = applyUntil(S.playT, true);
    if (S.playT >= S.t1) { S.playT = S.t1; S.playing = false; renderControls(); }
  }
  sideTimer += dt;
  if (changed && sideTimer > 300) { renderSide(); sideTimer = 0; }
  if (changed && now - lastSync > 1500) syncSim(true);
  if (S.view === "entourage") drawEntourage(dt);
  else { followCamera(dt); draw(dt); }
  drawSpark();
  requestAnimationFrame(frame);
}

document.addEventListener("keydown", ev => {
  if (ev.target.tagName === "INPUT") return;
  if (ev.code === "Space") { ev.preventDefault(); togglePlay(); }
  if (ev.key === "f" || ev.key === "0") fit();
  if (ev.key === "=" || ev.key === "+") zoomBy(1.5);
  if (ev.key === "-" || ev.key === "_") zoomBy(1 / 1.5);
  if (ev.key === "u" && S.focus && S.pins.has(S.focus.id)) unpin(S.focus);
  if (ev.key === "Escape") { S.focus = null; renderDetail(); $("receiptModal").hidden = true; }
  if (ev.key === "e") setView(S.view === "graph" ? "entourage" : "graph");
  if (ev.key === "r" && S.selected) openReceipt(S.selected);
});

setInterval(() => { if (S.recording) loadSessions().catch(() => {}); }, 5000);

if (new URLSearchParams(location.search).has("debug")) {
  window.__tattletab = { S, model: () => M, transform: () => transform, Sound, ENT };
}

// ---------- boot ----------
(async () => {
  resize();
  d3.select(canvas).call(zoom.transform, d3.zoomIdentity.translate(W / 2, H / 2));
  renderLegend(); renderControls();
  await loadSessions();
  await selectSession(S.recording || S.sessions[0]?.id || null);
  connectStream();
  requestAnimationFrame(frame);
})();
})();
