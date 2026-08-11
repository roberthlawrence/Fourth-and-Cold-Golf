// =====================================================================
// Fourth and Cold Golf Open — registration app
// Stack: GitHub Pages + Firebase (Firestore, Anonymous + Google auth)
// Hard-coded full admin: roberthlawrence@gmail.com
// =====================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged,
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, collection, onSnapshot, getDoc, setDoc, addDoc, updateDoc,
  deleteDoc, runTransaction, serverTimestamp, query, orderBy, limit, getDocs, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const BOOTSTRAP_FULL_ADMIN = "roberthlawrence@gmail.com";
const DEFAULT_HANDICAP = 30; // "if handicap is not entered, assume at least +30"

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// ------------------------------------------------ state
const S = {
  user: null,          // firebase auth user (anon or google)
  adminEmail: null,    // google email if signed in via google
  isFull: false,
  isFin: false,
  me: null,            // my account doc {id, name, email, paidTotal}
  config: null,
  accounts: {},        // key -> account
  regs: {},            // id -> registration
  teams: {},           // id -> team
  payments: {},        // id -> payment (admins only)
  purchases: {},       // id -> extra purchase (chips for prize hat)
  draws: {},           // id -> prize draw
  shownDraws: {},      // draw ids already animated on this device
  audit: [],           // recent audit lines (full admin only)
  activeTab: "register",
  deepExtras: new URLSearchParams(location.search).has("extras"),
  pairSel: [],         // selected reg ids in pairing tool
  entrySeq: null,      // manually selected scoring hole (null = next unscored)
  unsub: { payments: null, audit: null }
};

// ------------------------------------------------ tiny helpers
const $  = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const money = (n) => "$" + (Math.round((n + Number.EPSILON) * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
const emailKey = (e) => String(e || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "_");
const cleanEmail = (e) => String(e || "").trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const nowIso = () => new Date().toISOString();

let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
}

function openModal(html) { $("modalBox").innerHTML = html; $("modal").classList.remove("hidden"); }
function closeModal() { $("modal").classList.add("hidden"); $("modalBox").innerHTML = ""; }
$("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

async function audit(action, detail) {
  try {
    await addDoc(collection(db, "audit"), {
      action, detail: detail || "",
      actor: S.adminEmail || (S.me ? S.me.email : "unknown"),
      ts: serverTimestamp(), tsLocal: nowIso()
    });
  } catch (e) { /* audit is best-effort */ }
}

// ------------------------------------------------ config helpers
function defaultConfig(bootEmail) {
  return {
    eventName: "Fourth and Cold Golf Open",
    formatLine: "2-Man Scramble",
    venueName: "Mustang Creek Country Club",
    venueAddress: "1102 Beech St, Taylor, TX 76574",
    venuePhone: "(512) 309-4045",
    eventDate: "",            // e.g. "Saturday, Oct 10"
    eventTime: "",            // e.g. "8:00 AM shotgun start"
    welcome: "Grab a partner or let us pair you up — either way, come play.",
    indivPrice: 150,
    teamPrice: 300,
    maxPlayers: 0,            // 0 = unlimited
    registrationClosed: false,
    venmoLines: "dan-huskerson | Blanco & Leander crew\nmarcus-dawes | Houston crew\nrandyn-tenery | DFW crew",
    fullAdmins: [BOOTSTRAP_FULL_ADMIN, ...(bootEmail && bootEmail !== BOOTSTRAP_FULL_ADMIN ? [bootEmail] : [])],
    finAdmins: [],
    // ---- live scoring (day of) ----
    scoringOpen: false,
    holesCount: 18,                          // holes each team plays
    parByHole: [4, 4, 3, 3, 5, 3, 5, 4, 4], // Mustang Creek card (9 physical holes, par 35)
    paceThreshold: 3,                        // holes behind field median before flagging
    // Day-of purchases — one per line: emoji | name | price | unit | max per team | note
    // unit "each" = countable use; anything else (ft, yd...) = amount deducted per use.
    // Empty = extras off. Sample lines live in Settings, ready to add with one tap.
    extrasLines: "",
    contestLD: 0,   // physical hole # for long drive (0 = none)
    contestCP: 0,   // physical hole # for closest to the pin (0 = none)
    rulesText: "",
    rulesVersion: "",
    extrasMode: "select",   // "select" = pick your extra, "draw" = random draw
    drawPrice: 10,          // flat price per random draw (draw mode)
    dealBuy: 0,             // buy N ...
    dealFree: 0,            // ... get M free draws (0/0 = no deal)
    spinSeconds: 10,        // wheel spin time (matches the chips game)
    scoringTest: false,     // admins-only live scoring test
    updatedAt: nowIso()
  };
}

function venmoList() {
  return String(S.config?.venmoLines || "").split("\n").map(l => {
    const [h, label] = l.split("|").map(s => (s || "").trim());
    return h ? { handle: h.replace(/^@/, ""), label: label || "" } : null;
  }).filter(Boolean);
}

function isFullEmail(e) {
  e = cleanEmail(e);
  return e === BOOTSTRAP_FULL_ADMIN || (S.config?.fullAdmins || []).map(cleanEmail).includes(e);
}
function isFinEmail(e) {
  e = cleanEmail(e);
  return isFullEmail(e) || (S.config?.finAdmins || []).map(cleanEmail).includes(e);
}

// ------------------------------------------------ spots
function spotsUsed() {
  return Object.values(S.regs).reduce((n, r) => n + (r.type === "team" ? 2 : 1), 0);
}
function spotsLeft() {
  const max = Number(S.config?.maxPlayers || 0);
  if (!max) return Infinity;
  return Math.max(0, max - spotsUsed());
}

// ------------------------------------------------ live scoring helpers
function pars()      { return (S.config?.parByHole || [4,4,3,3,5,3,5,4,4]).map(Number); }
function holesCount(){ return Number(S.config?.holesCount || 18); }
function startHole(t){ const n = parseInt(t?.hole); return (n >= 1 && n <= pars().length) ? n : 1; }
function physHole(t, seq) { return ((startHole(t) - 1 + (seq - 1)) % pars().length) + 1; }
function parFor(t, seq)   { return pars()[physHole(t, seq) - 1]; }
function relFmt(n) { return n === 0 ? "E" : (n > 0 ? "+" + n : String(n)); }
function isAdminViewer() { return !!(S.isFull || S.isFin); }
function scoringLive() {
  const c = S.config || {};
  return !!(c.scoringOpen || (c.scoringTest && isAdminViewer()));
}

function teamScore(t) {
  let played = 0, rel = 0, strokes = 0;
  const sc = t.scores || {};
  for (let seq = 1; seq <= holesCount(); seq++) {
    const s = Number(sc[seq]);
    if (!sc[seq] || isNaN(s)) continue;
    played++; strokes += s; rel += s - parFor(t, seq);
  }
  const pen = (t.penalties || []).reduce((a, p) => a + Number(p.strokes || 0), 0);
  return { played, strokes, pen, rel: rel + pen, relRaw: rel };
}
function nextSeq(t) {
  const sc = t.scores || {};
  for (let seq = 1; seq <= holesCount(); seq++) if (sc[seq] == null || sc[seq] === "") return seq;
  return 0; // done
}
const SAMPLE_EXTRAS = ["🎟 | Mulligan | 10 | each | 4 | re-hit any shot", "🧵 | Putt string | 10 | ft | 50 | one long string — cut off whole feet as you use it | 5", "🪂 | 150-yd drop | 20 | each | 1 | drop at the 150 marker on a par 5", "👗 | Red tee pass | 10 | each | 2 | hit one drive from the forward tees"];

function contestHoleOptions(current) {
  let o = `<option value="0">— none —</option>`;
  pars().forEach((p, i) => {
    const h = i + 1;
    o += `<option value="${h}" ${Number(current) === h ? "selected" : ""}>#${h} (par ${p})</option>`;
  });
  return o;
}

function extrasList() {
  return String(S.config?.extrasLines || "").split("\n").map(l => {
    const [emoji, name, price, unit, max, note, bundle] = l.split("|").map(s => (s || "").trim());
    if (!name) return null;
    const u = (unit || "each").toLowerCase();
    return {
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      emoji: emoji || "⭐", name,
      price: parseFloat(price) || 0,       // price per purchase (per bundle)
      unit: u,
      max: parseInt(max) || 0,             // max total units per team (ft for string)
      note: note || "",
      bundle: u === "each" ? 1 : (parseInt(bundle) || 5)   // units granted per purchase
    };
  }).filter(Boolean);
}
function teamPurchases(teamId) {
  return Object.values(S.purchases).filter(p => p.teamId === teamId);
}
function extraPurchased(t, id) {
  const manual = Number((t.extrasPurchased || {})[id] || 0);
  const bought = teamPurchases(t.id).filter(p => p.extraId === id).reduce((a, p) => a + Number(p.amt || 0), 0);
  return manual + bought;
}
function extraUsed(t, id) {
  return (t.extraUses || []).filter(u => u.id === id).reduce((a, u) => a + Number(u.amt || 0), 0);
}
function extraLeft(t, id) { return Math.max(0, extraPurchased(t, id) - extraUsed(t, id)); }
function extraUsesAt(t, seq) { return (t.extraUses || []).filter(u => Number(u.seq) === Number(seq)); }
function teamLabel(t) {
  return (t.customName ? esc(t.customName) + " " : "") + `<span class="tnum">(T${t.number})</span>`;
}
function fieldMedianThru() {
  const played = Object.values(S.teams).map(t => teamScore(t).played).sort((a, b) => a - b);
  if (!played.length) return 0;
  const m = Math.floor(played.length / 2);
  return played.length % 2 ? played[m] : Math.round((played[m - 1] + played[m]) / 2);
}
function isBulkEntry(t) {
  // 4+ hole scores stamped within any 3-minute window = likely end-dump
  const times = Object.values(t.scoreTimes || {}).map(x => Date.parse(x)).filter(x => !isNaN(x)).sort((a, b) => a - b);
  for (let i = 0; i + 3 < times.length; i++) if (times[i + 3] - times[i] <= 3 * 60 * 1000) return true;
  return false;
}
function agoFmt(iso) {
  const ms = Date.now() - Date.parse(iso || "");
  if (isNaN(ms)) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  return Math.floor(m / 60) + "h " + (m % 60) + "m ago";
}
// Mustang Creek hole reference (yardages/hcp for the hole guide; pars live in config)
const HOLE_INFO = {
  1: { hcp: 10, blue: 349, white: 345, red: 324 },
  2: { hcp: 18, blue: 298, white: 288, red: 255 },
  3: { hcp: 3,  blue: 173, white: 160, red: 180 },
  4: { hcp: 11, blue: 148, white: 143, red: 117 },
  5: { hcp: 5,  blue: 487, white: 450, red: 340 },
  6: { hcp: 16, blue: 132, white: 120, red: 115 },
  7: { hcp: 8,  blue: 491, white: 488, red: 380 },
  8: { hcp: 12, blue: 325, white: 272, red: 294 },
  9: { hcp: 4,  blue: 374, white: 320, red: 244 }
};
function holeImgSrc(ph) { return `holes/hole-${ph}.jpg`; }

function myTeam() {
  if (S.me?.myTeamId && S.teams[S.me.myTeamId]) return S.teams[S.me.myTeamId];
  // fall back: a team containing one of my registrations
  if (S.me) {
    const mine = Object.values(S.regs).find(r => r.ownerKey === S.me.id && r.teamId && S.teams[r.teamId]);
    if (mine) return S.teams[mine.teamId];
  }
  return null;
}
function regClosed() {
  return !!S.config?.registrationClosed || spotsLeft() <= 0;
}

// ------------------------------------------------ money owed
function owedFor(key) {
  return Object.values(S.regs).filter(r => r.ownerKey === key)
    .reduce((n, r) => n + Number(r.price || 0), 0);
}
function paidFor(key) {
  return Number(S.accounts[key]?.paidTotal || 0);
}

// =====================================================================
// BOOT
// =====================================================================
let booted = false;
onAuthStateChanged(auth, async (user) => {
  S.user = user;
  if (!user) { await signInAnonymously(auth).catch(e => toast("Sign-in failed: " + e.message, true)); return; }
  S.adminEmail = user.email ? cleanEmail(user.email) : null;
  refreshAdminFlags();
  if (!booted) { booted = true; subscribeAll(); }
  else renderAll();
});
getRedirectResult(auth).catch(() => {});

function refreshAdminFlags() {
  S.isFull = !!(S.adminEmail && isFullEmail(S.adminEmail));
  S.isFin  = !!(S.adminEmail && isFinEmail(S.adminEmail));
  if (S.isFin && !S.unsub.payments) subscribePayments();
  if (!S.isFin && S.unsub.payments) { S.unsub.payments(); S.unsub.payments = null; S.payments = {}; }
  if (S.isFull && !S.unsub.audit) subscribeAudit();
  if (!S.isFull && S.unsub.audit) { S.unsub.audit(); S.unsub.audit = null; S.audit = []; }
}

function subscribeAll() {
  onSnapshot(doc(db, "config", "current"), (snap) => {
    S.config = snap.exists() ? snap.data() : null;
    refreshAdminFlags();
    firstPaint();
    renderAll();
  }, (e) => { console.error(e); firstPaint(); });

  onSnapshot(collection(db, "accounts"), (qs) => {
    S.accounts = {};
    qs.forEach(d => S.accounts[d.id] = { id: d.id, ...d.data() });
    if (S.me && S.accounts[S.me.id]) S.me = S.accounts[S.me.id]; // live paid status
    maybeAutoLogin();
    renderAll();
  });

  onSnapshot(collection(db, "registrations"), (qs) => {
    S.regs = {};
    qs.forEach(d => S.regs[d.id] = { id: d.id, ...d.data() });
    renderAll();
  });

  onSnapshot(collection(db, "teams"), (qs) => {
    S.teams = {};
    qs.forEach(d => S.teams[d.id] = { id: d.id, ...d.data() });
    renderAll();
  });
}

function subscribePayments() {
  onSnapshot(collection(db, "extraPurchases"), (qs) => {
    S.purchases = {};
    qs.forEach(d => S.purchases[d.id] = { id: d.id, ...d.data() });
    renderAll();
  });
  onSnapshot(collection(db, "draws"), (qs) => {
    S.draws = {};
    qs.forEach(d => S.draws[d.id] = { id: d.id, ...d.data() });
    maybeAnimateDraw();
    renderAll();
  });
  S.unsub.payments = onSnapshot(collection(db, "payments"), (qs) => {
    S.payments = {};
    qs.forEach(d => S.payments[d.id] = { id: d.id, ...d.data() });
    renderAll();
  }, () => {});
}
function subscribeAudit() {
  S.unsub.audit = onSnapshot(query(collection(db, "audit"), orderBy("tsLocal", "desc"), limit(60)), (qs) => {
    S.audit = [];
    qs.forEach(d => S.audit.push(d.data()));
    renderAll();
  }, () => {});
}

let painted = false;
function firstPaint() {
  if (painted) return;
  painted = true;
  $("loader").classList.add("hidden");
  maybeAutoLogin();
}

// =====================================================================
// EMAIL GATE  (double-entry first time, single-entry after)
// =====================================================================
function maybeAutoLogin() {
  if (!painted) return;
  if (S.me) return;
  const saved = localStorage.getItem("fcgolf_email");
  if (saved) {
    const acct = S.accounts[emailKey(saved)];
    if (acct) { S.me = acct; showApp(); return; }
  }
  if ($("app").classList.contains("hidden")) showGate();
}

function showGate() {
  $("gate").classList.remove("hidden");
  $("app").classList.add("hidden");
  $("gateStep1").classList.remove("hidden");
  $("gateStep2").classList.add("hidden");
  $("gateErr").classList.add("hidden");
  if (S.config) $("gateBlurb").textContent = `${S.config.formatLine} · ${S.config.venueName}`;
}
function showApp() {
  $("gate").classList.add("hidden");
  $("app").classList.remove("hidden");
  renderAll();
}
function gateErr(msg) { const e = $("gateErr"); e.textContent = msg; e.classList.remove("hidden"); }

$("gateContinue").addEventListener("click", () => {
  const email = cleanEmail($("gateEmail").value);
  if (!validEmail(email)) return gateErr("That doesn't look like an email — check it and try again.");
  const acct = S.accounts[emailKey(email)];
  if (acct) {
    S.me = acct;
    localStorage.setItem("fcgolf_email", email);
    toast(`Welcome back, ${acct.name.split(" ")[0]}!`);
    showApp();
  } else {
    $("gateStep1").classList.add("hidden");
    $("gateStep2").classList.remove("hidden");
    $("gateErr").classList.add("hidden");
  }
});
$("gateBack").addEventListener("click", () => {
  $("gateStep2").classList.add("hidden");
  $("gateStep1").classList.remove("hidden");
});
$("gateCreate").addEventListener("click", async () => {
  const e1 = cleanEmail($("gateEmail").value);
  const e2 = cleanEmail($("gateEmail2").value);
  const name = $("gateName").value.trim();
  if (!validEmail(e1)) return gateErr("Go back and check your email address.");
  if (e1 !== e2) return gateErr("Those emails don't match — type the same one both times.");
  if (name.length < 3 || !name.includes(" ")) return gateErr("Enter your first and last name.");
  const key = emailKey(e1);
  try {
    const existing = await getDoc(doc(db, "accounts", key));
    if (existing.exists()) {
      // account was already there (snapshot just hadn't loaded) — log them in
      S.me = { id: key, ...existing.data() };
      localStorage.setItem("fcgolf_email", e1);
      toast(`Welcome back, ${S.me.name.split(" ")[0]}!`);
      showApp();
      return;
    }
    await setDoc(doc(db, "accounts", key), {
      email: e1, name, paidTotal: 0, createdAt: nowIso(), uid: S.user?.uid || null
    });
    S.me = { id: key, email: e1, name, paidTotal: 0 };
    localStorage.setItem("fcgolf_email", e1);
    audit("account_created", `${name} <${e1}>`);
    toast(`Let's play, ${name.split(" ")[0]}!`);
    showApp();
  } catch (err) { gateErr("Couldn't save that — " + err.message); }
});
$("switchBtn").addEventListener("click", () => {
  localStorage.removeItem("fcgolf_email");
  S.me = null;
  $("gateEmail").value = ""; $("gateEmail2").value = ""; $("gateName").value = "";
  showGate();
});

// =====================================================================
// TABS
// =====================================================================
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    S.activeTab = btn.dataset.tab;
    document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("hidden", p.id !== "tab-" + S.activeTab));
    renderAll();
  });
});

// =====================================================================
// RENDER
// =====================================================================
function renderAll() {
  if ($("app").classList.contains("hidden")) { renderAdminButton(); return; }
  if (!S.config) {
    renderAdminButton();
    $("tab-register").innerHTML = `<div class="card"><div class="card-title"><span class="flag">⛳</span> Almost ready</div>
      <p class="muted">Site setup isn't finished yet. An admin needs to tap <b>Admin</b> (top right) and sign in with Google once to initialize the event.</p></div>`;
    return;
  }
  $("eventName").textContent = S.config.eventName;
  $("whoami").textContent = S.me ? `${S.me.name} · ${S.me.email}` : "";
  renderBanner();
  renderAdminButton();
  if (S.activeTab === "register") renderRegister();
  if (S.activeTab === "roster")   renderRoster();
  if (S.activeTab === "live")     renderLive();
  if (S.deepExtras && S.me && S.config) {
    S.deepExtras = false;
    setTimeout(() => {
      document.querySelector('[data-tab="live"]')?.click();
      setTimeout(() => $("extrasShop")?.scrollIntoView({ behavior: "smooth" }), 400);
    }, 300);
  }
  if (S.activeTab === "admin")    renderAdmin();
}

function renderBanner() {
  const b = $("statusBanner");
  const max = Number(S.config.maxPlayers || 0);
  if (S.config.scoringOpen) {
    b.className = "status-banner live";
    b.innerHTML = `<span class="live-dot"></span> LIVE — scoring is open`;
    b.classList.remove("hidden");
    return;
  }
  if (S.config.registrationClosed) {
    b.className = "status-banner closed";
    b.textContent = "Registration is closed";
  } else if (max && spotsLeft() <= 0) {
    b.className = "status-banner closed";
    b.textContent = "Registration is full — all spots taken";
  } else if (max) {
    const left = spotsLeft();
    b.className = "status-banner " + (left <= 6 ? "low" : "open");
    b.textContent = `${left} player spot${left === 1 ? "" : "s"} left`;
  } else {
    b.className = "status-banner open";
    b.textContent = "Registration is open";
  }
  b.classList.remove("hidden");
}

function renderAdminButton() {
  $("adminBtn").textContent = S.adminEmail ? (S.isFin ? "Admin ✓" : "Not admin") : "Admin";
  $("adminTab").classList.toggle("hidden", !S.isFin);
}

// ---------------------------------------------------------------------
// REGISTER TAB
// ---------------------------------------------------------------------
function renderRegister() {
  const c = S.config;
  const myRegs = S.me ? Object.values(S.regs).filter(r => r.ownerKey === S.me.id)
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || "")) : [];
  const closed = regClosed();
  const left = spotsLeft();
  const mapsUrl = "https://maps.google.com/?q=" + encodeURIComponent(`${c.venueName}, ${c.venueAddress}`);

  const owed = S.me ? owedFor(S.me.id) : 0;
  const paid = S.me ? paidFor(S.me.id) : 0;
  const due  = Math.max(0, owed - paid);

  let html = `
  <div class="card event-hero">
    <div class="event-format">⛳ ${esc(c.formatLine)}</div>
    <div class="event-venue">${esc(c.venueName)}</div>
    <div class="event-addr small"><a href="${mapsUrl}" target="_blank" rel="noopener">${esc(c.venueAddress)}</a>${c.venuePhone ? " · " + esc(c.venuePhone) : ""}</div>
    ${c.eventDate || c.eventTime ? `<div class="small" style="margin-top:6px;font-weight:600">${esc([c.eventDate, c.eventTime].filter(Boolean).join(" · "))}</div>` : ""}
    <div class="event-meta">
      <span class="chip">Individual <b>${money(c.indivPrice)}</b></span>
      <span class="chip">Team of 2 <b>${money(c.teamPrice)}</b></span>
      ${Number(c.maxPlayers) ? `<span class="chip">Field <b>${spotsUsed()}/${c.maxPlayers}</b></span>` : ""}
    </div>
    ${c.welcome ? `<p class="small" style="margin-top:10px;color:var(--cream)">${esc(c.welcome)}</p>` : ""}
  </div>

  <div class="card">
    <div class="card-title"><span class="flag">⚑</span> My registrations</div>
    <div id="myRegs">`;

  if (!myRegs.length) {
    html += `<p class="muted">Nothing yet — add yourself, a friend, or a whole team below. You can register as many players and teams as you like in one go.</p>`;
  }
  myRegs.forEach(r => { html += regItemHtml(r, true); });
  html += `</div>
    <div class="add-row">
      <button class="btn btn-primary" id="addIndiv" ${closed || left < 1 ? "disabled" : ""}>+ Add a player · ${money(c.indivPrice)}</button>
      <button class="btn btn-green" id="addTeam" ${closed || left < 2 ? "disabled" : ""}>+ Add a team · ${money(c.teamPrice)}</button>
    </div>
    ${closed ? `<p class="muted" style="margin-top:8px">Registration is ${S.config.registrationClosed ? "closed" : "full"}. Talk to an admin if you need a change.</p>`
      : (left === 1 ? `<p class="muted" style="margin-top:8px">Only 1 spot left — team registration needs 2.</p>` : "")}
  </div>`;

  // balance card
  if (S.me && owed > 0) {
    html += `
    <div class="card">
      <div class="card-title"><span class="flag">$</span> Your balance</div>
      <div class="bal-grid">
        <div class="bal-cell"><div class="bal-num">${money(owed)}</div><div class="bal-lab">Total</div></div>
        <div class="bal-cell bal-paid"><div class="bal-num">${money(paid)}</div><div class="bal-lab">Received</div></div>
        <div class="bal-cell bal-due"><div class="bal-num">${money(due)}</div><div class="bal-lab">Due</div></div>
      </div>
      ${due <= 0
        ? `<span class="paid-flag">PAID ✓ You're all set</span>`
        : venmoList().map(v => `
          <button class="venmo-btn" data-venmo="${esc(v.handle)}">
            <span>Venmo @${esc(v.handle)} · ${money(due)}</span>
            <span class="h">${esc(v.label)}</span>
          </button>`).join("") +
          `<p class="muted" style="margin-top:8px">Pay whichever collector you know. An admin marks it received once it lands.</p>`
      }
    </div>`;
  }

  $("tab-register").innerHTML = html;

  $("addIndiv")?.addEventListener("click", () => openIndivModal(null));
  $("addTeam")?.addEventListener("click", () => openTeamModal(null));
  document.querySelectorAll("[data-edit-reg]").forEach(b => b.addEventListener("click", () => {
    const r = S.regs[b.dataset.editReg];
    if (!r) return;
    r.type === "team" ? openTeamModal(r) : openIndivModal(r);
  }));
  document.querySelectorAll("[data-del-reg]").forEach(b => b.addEventListener("click", () => confirmDeleteReg(b.dataset.delReg)));
  document.querySelectorAll("[data-venmo]").forEach(b => b.addEventListener("click", () => payVenmo(b.dataset.venmo, due)));
}

function regItemHtml(r, mine) {
  const team = r.teamId ? S.teams[r.teamId] : null;
  const teamLabel = team ? `Team ${team.number}` : null;
  const players = (r.players || []).map(p =>
    `<div>🏌️ <b>${esc(p.name)}</b> <span class="muted">${p.handicap !== "" && p.handicap != null ? "· hcp " + esc(p.handicap) : "· no handicap"}</span></div>`
  ).join("");
  let pref = "";
  if (r.type === "individual") {
    pref = r.teamId
      ? `<div class="reg-pref">Paired up ✓ ${teamLabel ? "(" + teamLabel + ")" : ""}</div>`
      : (r.preference === "partner"
        ? `<div class="reg-pref">Has a partner signing up separately: <b>${esc(r.partnerName || "?")}</b></div>`
        : `<div class="reg-pref">Randomly team me up 🎲</div>`);
  }
  return `
  <div class="reg-item">
    <div class="reg-head">
      <span class="badge ${r.type === "team" ? "badge-team" : "badge-ind"}">${r.type === "team" ? "Team" : "Individual"}</span>
      ${teamLabel ? `<span class="badge badge-gold">${teamLabel}${team.hole ? " · Hole " + esc(team.hole) : ""}</span>` : ""}
      <span class="reg-price">${money(r.price)}</span>
    </div>
    <div class="reg-players">${players}</div>
    ${pref}
    ${mine ? `<div class="reg-actions">
      <button class="btn btn-tiny btn-ghost" data-edit-reg="${r.id}">Edit</button>
      ${!regClosed() && (!r.teamId || r.type === "team") ? `<button class="btn btn-tiny btn-ghost" data-del-reg="${r.id}">Remove</button>` : ""}
    </div>` : ""}
  </div>`;
}

// ---------- individual add/edit ----------
function openIndivModal(existing) {
  const c = S.config;
  const p = existing?.players?.[0] || { name: S.me?.name || "", handicap: "" };
  const pref = existing?.preference || "random";
  const locked = !!existing?.teamId;
  openModal(`
    <div class="modal-title">${existing ? "Edit player" : "Add a player"}</div>
    <div class="modal-sub">${existing ? "" : `Individual entry · ${money(c.indivPrice)}. `}Registering for a friend? Just change the name.</div>
    <label class="field-label">Player name</label>
    <input class="field" id="mPName" value="${esc(p.name)}" placeholder="First & last name">
    <label class="field-label">Handicap (optional)</label>
    <input class="field" id="mPHcp" value="${esc(p.handicap ?? "")}" placeholder="e.g. 12 — leave blank if unsure" inputmode="decimal">
    ${locked ? `<p class="muted" style="margin-top:10px">This player is already paired onto a team, so pairing preference is locked. Ask an admin to change teams.</p>` : `
    <label class="field-label">Pairing preference</label>
    <label class="radio-row ${pref === "random" ? "selected" : ""}" id="rowRandom">
      <input type="radio" name="mPref" value="random" ${pref === "random" ? "checked" : ""}>
      <span><span class="r-title">Randomly team me 🎲</span><br><span class="r-sub">We'll pair you up with another player, balanced by handicap.</span></span>
    </label>
    <label class="radio-row ${pref === "partner" ? "selected" : ""}" id="rowPartner">
      <input type="radio" name="mPref" value="partner" ${pref === "partner" ? "checked" : ""}>
      <span><span class="r-title">I have a partner signing up separately</span><br><span class="r-sub">They're paying their own ${money(c.indivPrice)} entry.</span></span>
    </label>
    <div id="partnerWrap" class="${pref === "partner" ? "" : "hidden"}">
      <label class="field-label">Partner's first &amp; last name</label>
      <input class="field" id="mPartner" value="${esc(existing?.partnerName || "")}" placeholder="So we can match you up">
    </div>`}
    <div class="modal-actions">
      <button class="btn btn-ghost" id="mCancel">Cancel</button>
      <button class="btn btn-primary" id="mSave">${existing ? "Save changes" : "Add player · " + money(c.indivPrice)}</button>
    </div>
  `);
  const syncPref = () => {
    const v = document.querySelector('input[name="mPref"]:checked')?.value;
    $("rowRandom")?.classList.toggle("selected", v === "random");
    $("rowPartner")?.classList.toggle("selected", v === "partner");
    $("partnerWrap")?.classList.toggle("hidden", v !== "partner");
  };
  document.querySelectorAll('input[name="mPref"]').forEach(r => r.addEventListener("change", syncPref));
  $("mCancel").addEventListener("click", closeModal);
  $("mSave").addEventListener("click", async () => {
    const name = $("mPName").value.trim();
    if (name.length < 3 || !name.includes(" ")) return toast("Enter the player's first and last name.", true);
    const hcp = $("mPHcp").value.trim();
    if (hcp !== "" && isNaN(parseFloat(hcp))) return toast("Handicap should be a number (or blank).", true);
    const prefV = locked ? existing.preference : (document.querySelector('input[name="mPref"]:checked')?.value || "random");
    const partner = locked ? (existing.partnerName || "") : ($("mPartner")?.value.trim() || "");
    if (!locked && prefV === "partner" && partner.length < 3) return toast("Enter your partner's first and last name.", true);
    try {
      if (existing) {
        await updateDoc(doc(db, "registrations", existing.id), {
          players: [{ name, handicap: hcp }], preference: prefV, partnerName: prefV === "partner" ? partner : "", updatedAt: nowIso()
        });
        if (existing.teamId) await syncTeamPlayers(existing.teamId);
        audit("registration_edited", `${name} (individual) by ${S.me.name}`);
        toast("Saved.");
      } else {
        if (regClosed() || spotsLeft() < 1) return toast("Registration just filled up or closed.", true);
        await addDoc(collection(db, "registrations"), {
          type: "individual", ownerKey: S.me.id, ownerName: S.me.name, ownerEmail: S.me.email,
          players: [{ name, handicap: hcp }], preference: prefV, partnerName: prefV === "partner" ? partner : "",
          teamId: null, price: Number(S.config.indivPrice), uid: S.user?.uid || null,
          createdAt: nowIso(), updatedAt: nowIso()
        });
        audit("registration_added", `${name} (individual, ${money(S.config.indivPrice)}) by ${S.me.name}`);
        toast(`${name.split(" ")[0]} is in! Add more or settle up below.`);
      }
      closeModal();
    } catch (e) { toast("Couldn't save: " + e.message, true); }
  });
}

// ---------- team add/edit ----------
function openTeamModal(existing) {
  const c = S.config;
  const p1 = existing?.players?.[0] || { name: S.me?.name || "", handicap: "" };
  const p2 = existing?.players?.[1] || { name: "", handicap: "" };
  openModal(`
    <div class="modal-title">${existing ? "Edit team" : "Add a team"}</div>
    <div class="modal-sub">${existing ? "" : `Both players together · ${money(c.teamPrice)}. `}Player 1 defaults to you — change it if you're signing up others.</div>
    <div class="player-block">
      <h4>Player 1</h4>
      <label class="field-label">Name</label>
      <input class="field" id="mT1Name" value="${esc(p1.name)}" placeholder="First & last name">
      <label class="field-label">Handicap (optional)</label>
      <input class="field" id="mT1Hcp" value="${esc(p1.handicap ?? "")}" placeholder="e.g. 12" inputmode="decimal">
    </div>
    <div class="player-block">
      <h4>Player 2</h4>
      <label class="field-label">Name</label>
      <input class="field" id="mT2Name" value="${esc(p2.name)}" placeholder="First & last name">
      <label class="field-label">Handicap (optional)</label>
      <input class="field" id="mT2Hcp" value="${esc(p2.handicap ?? "")}" placeholder="e.g. 20" inputmode="decimal">
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="mCancel">Cancel</button>
      <button class="btn btn-green" id="mSave">${existing ? "Save changes" : "Add team · " + money(c.teamPrice)}</button>
    </div>
  `);
  $("mCancel").addEventListener("click", closeModal);
  $("mSave").addEventListener("click", async () => {
    const n1 = $("mT1Name").value.trim(), n2 = $("mT2Name").value.trim();
    const h1 = $("mT1Hcp").value.trim(), h2 = $("mT2Hcp").value.trim();
    if (n1.length < 3 || !n1.includes(" ")) return toast("Enter Player 1's first and last name.", true);
    if (n2.length < 3 || !n2.includes(" ")) return toast("Enter Player 2's first and last name.", true);
    for (const h of [h1, h2]) if (h !== "" && isNaN(parseFloat(h))) return toast("Handicaps should be numbers (or blank).", true);
    const players = [{ name: n1, handicap: h1 }, { name: n2, handicap: h2 }];
    try {
      if (existing) {
        await updateDoc(doc(db, "registrations", existing.id), { players, updatedAt: nowIso() });
        if (existing.teamId) await syncTeamPlayers(existing.teamId);
        audit("registration_edited", `Team ${n1} & ${n2} by ${S.me.name}`);
        toast("Saved.");
      } else {
        if (regClosed() || spotsLeft() < 2) return toast("Not enough spots left for a full team.", true);
        await createTeamRegistration(players);
        audit("registration_added", `Team ${n1} & ${n2} (${money(S.config.teamPrice)}) by ${S.me.name}`);
        toast("Team's in! Add more or settle up below.");
      }
      closeModal();
    } catch (e) { toast("Couldn't save: " + e.message, true); }
  });
}

async function nextTeamNumberTx(tx) {
  const ref = doc(db, "config", "counters");
  const snap = await tx.get(ref);
  const seq = (snap.exists() ? Number(snap.data().teamSeq || 0) : 0) + 1;
  tx.set(ref, { teamSeq: seq }, { merge: true });
  return seq;
}

async function createTeamRegistration(players) {
  await runTransaction(db, async (tx) => {
    const num = await nextTeamNumberTx(tx);
    const teamRef = doc(collection(db, "teams"));
    const regRef  = doc(collection(db, "registrations"));
    tx.set(regRef, {
      type: "team", ownerKey: S.me.id, ownerName: S.me.name, ownerEmail: S.me.email,
      players, preference: "", partnerName: "", teamId: teamRef.id,
      price: Number(S.config.teamPrice), uid: S.user?.uid || null,
      createdAt: nowIso(), updatedAt: nowIso()
    });
    tx.set(teamRef, {
      number: num, source: "registration", hole: "",
      regIds: [regRef.id], players: players.map(p => ({ ...p })), createdAt: nowIso()
    });
  });
}

// keep team doc's player copies in sync after a name/handicap edit
async function syncTeamPlayers(teamId) {
  const team = S.teams[teamId];
  if (!team) return;
  const players = [];
  (team.regIds || []).forEach(rid => {
    const r = S.regs[rid];
    if (r) (r.players || []).forEach(p => players.push({ ...p }));
  });
  if (players.length) await updateDoc(doc(db, "teams", teamId), { players }).catch(() => {});
}

function confirmDeleteReg(id) {
  const r = S.regs[id];
  if (!r) return;
  const who = (r.players || []).map(p => p.name).join(" & ");
  openModal(`
    <div class="modal-title">Remove registration?</div>
    <p style="margin-top:8px">${esc(who)} — ${money(r.price)} comes off your balance.</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="mCancel">Keep it</button>
      <button class="btn btn-danger" id="mYes">Remove</button>
    </div>`);
  $("mCancel").addEventListener("click", closeModal);
  $("mYes").addEventListener("click", async () => {
    try {
      if (r.type === "team" && r.teamId) await deleteDoc(doc(db, "teams", r.teamId)).catch(() => {});
      await deleteDoc(doc(db, "registrations", id));
      audit("registration_removed", `${who} by ${S.me?.name || S.adminEmail}`);
      toast("Removed.");
      closeModal();
    } catch (e) { toast("Couldn't remove: " + e.message, true); }
  });
}

// ---------- venmo ----------
function payVenmo(handle, amount) {
  const note = encodeURIComponent(`${S.config.eventName} — ${S.me?.name || ""}`);
  const amt = amount > 0 ? amount.toFixed(2) : "";
  const deep = `venmo://paycharge?txn=pay&recipients=${encodeURIComponent(handle)}&amount=${amt}&note=${note}`;
  const web  = `https://account.venmo.com/pay?recipients=${encodeURIComponent(handle)}&amount=${amt}&note=${note}`;
  const t0 = Date.now();
  window.location.href = deep;
  setTimeout(() => { if (Date.now() - t0 < 1600) window.open(web, "_blank"); }, 1200);
}

// ---------------------------------------------------------------------
// ROSTER TAB
// ---------------------------------------------------------------------
function renderRoster() {
  const teams = Object.values(S.teams).sort((a, b) => a.number - b.number);
  const soloRegs = Object.values(S.regs)
    .filter(r => r.type === "individual" && !r.teamId)
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  const totalPlayers = spotsUsed();
  const anyHoles = teams.some(t => t.hole);

  let html = `
  <div class="roster-count">
    <span class="chip">Players <b>${totalPlayers}</b></span>
    <span class="chip">Teams set <b>${teams.length}</b></span>
    <span class="chip">Awaiting pairing <b>${soloRegs.length}</b></span>
  </div>`;

  html += `<div class="card"><div class="card-title"><span class="flag">⛳</span> Set teams</div>`;
  if (!teams.length) {
    html += `<p class="muted">No teams locked in yet.</p>`;
  } else {
    html += `<div class="scorecard"><table>
      <tr><th style="width:44px">Team</th><th>Players</th>${anyHoles ? "<th style='width:70px'>Hole</th>" : ""}</tr>`;
    teams.forEach(t => {
      const ps = (t.players || []).map(p =>
        `${esc(p.name)} <span class="hcp">${p.handicap !== "" && p.handicap != null ? "(" + esc(p.handicap) + ")" : ""}</span>`
      ).join("<br>");
      html += `<tr><td><span class="tee">${t.number}</span></td><td>${t.customName ? `<b>${esc(t.customName)}</b><br>` : ""}${ps}</td>${anyHoles ? `<td>${t.hole ? `<span class="hole-chip">${esc(t.hole)}</span>` : ""}</td>` : ""}</tr>`;
    });
    html += `</table></div>`;
  }
  html += `</div>`;

  html += `<div class="card"><div class="card-title"><span class="flag">🎲</span> Individuals — not yet paired</div>`;
  if (!soloRegs.length) {
    html += `<p class="muted">Everyone's on a team.</p>`;
  } else {
    html += `<div class="scorecard"><table>
      <tr><th>Player</th><th>Pairing</th></tr>`;
    soloRegs.forEach(r => {
      const p = r.players[0] || {};
      html += `<tr>
        <td><b>${esc(p.name)}</b> <span class="hcp">${p.handicap !== "" && p.handicap != null ? "(" + esc(p.handicap) + ")" : ""}</span></td>
        <td>${r.preference === "partner" ? `<span class="pref-note">partner: ${esc(r.partnerName)}</span>` : `<span class="pref-note">random pairing</span>`}</td>
      </tr>`;
    });
    html += `</table></div>`;
  }
  html += `</div>`;

  $("tab-roster").innerHTML = html;
}


// ---------------------------------------------------------------------
// LIVE TAB — leaderboard + team scoring
// ---------------------------------------------------------------------
function renderLive() {
  const el = $("tab-live");
  const c = S.config;
  const teams = Object.values(S.teams).sort((a, b) => a.number - b.number);
  let html = "";

  if (!scoringLive()) {
    html += `<div class="card"><div class="card-title"><span class="flag">🔴</span> Live scoring</div>
      <p class="muted">Scoring opens on event day. Check back at the shotgun start — the leaderboard will be right here.</p>
      ${c.rulesText ? `<button class="btn btn-ghost btn-block" id="rulesBtn" style="margin-top:8px">📜 Tournament rules</button>` : ""}</div>`;
    $("tab-live").innerHTML = html + extrasShopHtml() + contestsHtml() + extrasSaleHtml() + prizeWinnersHtml() + holeGuideHtml() + leaderboardHtml(teams, false);
    wireHoleZoom(); wireShop(); wireRulesBtn();
    maybeShowRules();
    return;
  }

  if (c.scoringTest && !c.scoringOpen) {
    html += `<div class="card" style="border:2px dashed #B08BD0"><b>🧪 TEST MODE</b> — only admins can see live scoring right now. Flip it off in Admin → Live scoring and all test scores reset automatically.</div>`;
  }
  if (c.rulesText) html += `<button class="btn btn-ghost btn-block" id="rulesBtn" style="margin-bottom:10px">📜 Tournament rules</button>`;
  const myName = (S.me?.name || "").trim().toLowerCase();
  if (myName && (c.contestLDWinner || "").trim().toLowerCase() === myName)
    html += `<div class="winner-banner">🏆💪 YOU WON LONGEST DRIVE! 💪🏆</div>`;
  if (myName && (c.contestCPWinner || "").trim().toLowerCase() === myName)
    html += `<div class="winner-banner">🏆🎯 YOU WON CLOSEST TO THE PIN! 🎯🏆</div>`;
  html += myScoringHtml();
  html += leaderboardHtml(teams, true);
  html += extrasShopHtml();
  html += prizeWinnersHtml();
  html += contestsHtml();
  html += extrasSaleHtml();
  html += holeGuideHtml();
  el.innerHTML = html;
  wireLive(); wireShop(); wireRulesBtn();
  maybeShowRules();
}

// ---------------------------------------------------------------------
// RULES
// ---------------------------------------------------------------------
function wireRulesBtn() { $("rulesBtn")?.addEventListener("click", () => openRules(false)); }
function maybeShowRules() {
  const c = S.config || {};
  if (!scoringLive() || !c.rulesText) return;
  const ver = c.rulesVersion || "v1";
  if (localStorage.getItem("fcgolf_rulesAck") === ver) return;
  openRules(true);
}
function openRules(mustAck) {
  const c = S.config || {};
  openModal(`
    <div class="modal-title">📜 Tournament rules</div>
    <div class="rules-body">${esc(c.rulesText).replace(/\n/g, "<br>")}</div>
    <div class="modal-actions">
      <button class="btn btn-primary btn-block" id="rulesOk">${mustAck ? "Got it — I've read the rules" : "Close"}</button>
    </div>`);
  $("rulesOk").addEventListener("click", () => {
    localStorage.setItem("fcgolf_rulesAck", c.rulesVersion || "v1");
    closeModal();
  });
}

function leaderboardHtml(teams, open) {
  const scored = teams.map(t => ({ t, s: teamScore(t) }))
    .sort((a, b) => (a.s.rel - b.s.rel) || (b.s.played - a.s.played) || (a.t.number - b.t.number));
  const med = fieldMedianThru();
  const thr = Number(S.config.paceThreshold || 3);

  let html = `<div class="card"><div class="card-title"><span class="flag">🏆</span> Leaderboard</div>`;
  if (!teams.length) return html + `<p class="muted">No teams yet.</p></div>`;
  html += `<div class="lb">`;
  let lastRel = null, lastRank = 0;
  scored.forEach((x, i) => {
    const { t, s } = x;
    const rank = (open && s.played) ? ((s.rel === lastRel) ? lastRank : i + 1) : "";
    if (open && s.played) { lastRel = s.rel; lastRank = rank; }
    const behind = open && med - s.played >= thr && s.played < holesCount();
    const done = s.played >= holesCount();
    const exChips = extrasList().map(x => {
      const p = extraPurchased(t, x.id); if (!p) return "";
      return x.unit === "each"
        ? `<span class="chip chip-mull" title="${esc(x.name)} used / bought">${x.emoji} ${extraUsed(t, x.id)}/${p}</span>`
        : `<span class="chip chip-mull" title="${esc(x.name)} remaining">${x.emoji} ${extraLeft(t, x.id)}${esc(x.unit)} left</span>`;
    }).join("");
    html += `<div class="lb-row ${behind ? "lb-behind" : ""}">
      <span class="lb-rank">${rank ? (rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : rank) : "–"}</span>
      <span class="lb-team">${teamLabel(t)}
        ${t.lastScoreAt ? `<span class="lb-upd">upd ${agoFmt(t.lastScoreAt)}</span>` : ""}
      </span>
      <span class="lb-chips">
        ${s.pen ? `<span class="chip chip-pen" title="${esc((t.penalties||[]).map(p=>p.strokes+" — "+p.note).join("; "))}">+${s.pen} pen</span>` : ""}
        ${exChips}
        ${behind ? `<span class="chip chip-behind">⏳ ${med - s.played} behind</span>` : ""}
      </span>
      <span class="lb-score ${s.rel < 0 ? "under" : s.rel > 0 ? "over" : ""}">${s.played ? relFmt(s.rel) : "—"}</span>
      <span class="lb-thru">${done ? "F" : s.played ? `thru ${s.played}` : "not started"} <span class="lb-start">(S${startHole(t)}${esc(String(t.hole||"").replace(/^\d+/,""))})</span></span>
    </div>`;
  });
  html += `</div>`;
  if (open) html += `<p class="muted small" style="margin-top:8px">Every score is timestamped and logged with who entered it. Teams more than ${Number(S.config.paceThreshold||3)} holes behind the field get flagged — keep it honest, enter as you go. Committee reserves the right to assess penalties or remove teams for score dumping.</p>`;
  return html + `</div>`;
}

function contests() {
  const c = S.config || {};
  const out = [];
  if (c.contestLD >= 1) out.push({ hole: Number(c.contestLD), emoji: "💪", name: "Long drive", cls: "ld" });
  if (c.contestCP >= 1) out.push({ hole: Number(c.contestCP), emoji: "🎯", name: "Closest to the pin", cls: "cp" });
  return out;
}
function holeGuideHtml() {
  let cells = "";
  for (let ph = 1; ph <= pars().length; ph++) {
    if (!HOLE_INFO[ph]) continue;
    const inf = HOLE_INFO[ph];
    cells += `<button class="hg-cell" data-holezoom="${ph}">
      <img src="${holeImgSrc(ph)}" alt="hole ${ph}" loading="lazy">
      <span class="hg-num">#${ph}</span>
      <span class="hg-meta">Par ${pars()[ph-1]} · ${inf.white}y</span>
    </button>`;
  }
  if (!cells) return "";
  return `<div class="card"><div class="card-title"><span class="flag">🗺</span> Hole guide</div>
    <div class="hole-guide">${cells}</div>
    <p class="muted small" style="margin-top:8px">Tap any hole — pinch to zoom, drag to pan. Gold ring = green, white box = tee.</p></div>`;
}

function contestsHtml() {
  const list = contests();
  if (!list.length) return "";
  return `<div class="card contest-card"><div class="card-title"><span class="flag">🏅</span> Contest holes</div>
    <div class="roster-count">${list.map(x => {
      const win = x.cls === "ld" ? (S.config.contestLDWinner || "") : (S.config.contestCPWinner || "");
      return `<span class="chip chip-contest">${x.emoji} ${esc(x.name)} — hole <b>#${x.hole}</b>${win ? ` · <span class="contest-winner">🏆 ${esc(win)}</span>` : ""}</span>`;
    }).join("")}</div>
    <p class="muted small" style="margin-top:6px">${(S.config.contestLDWinner || S.config.contestCPWinner) ? "Congrats to the winners!" : "Winners called at the tent after the round — markers are on the hole."}</p></div>`;
}



// ---------------------------------------------------------------------
// PRIZE WHEEL — synchronized spin (same 10s feel as the chips game)
// ---------------------------------------------------------------------
function chipHue(teamNumber) { return (Number(teamNumber) * 47) % 360; }

function eligibleChips(beforePrize) {
  return Object.values(S.purchases)
    .filter(p => p.drawnPrize == null || (beforePrize != null && p.drawnPrize >= beforePrize))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function maybeAnimateDraw() {
  const now = Date.now();
  Object.values(S.draws).forEach(d => {
    if (S.shownDraws[d.id]) return;
    const start = Date.parse(d.startAt || "");
    const secs = Number(d.seconds || 10);
    if (isNaN(start) || now > start + (secs + 20) * 1000) { S.shownDraws[d.id] = true; return; }  // too old
    S.shownDraws[d.id] = true;
    openWheel(d, false);
  });
}

function openWheel(d, isTest) {
  const chips = isTest ? d.chips : eligibleChips(d.prizeNumber);
  if (!chips.length) return;
  const targetIdx = Math.max(0, chips.findIndex(c => c.id === d.chipId));
  const myKey = S.me?.id;
  const n = chips.length;
  const segAngle = 360 / n;

  // build SVG wheel
  let segs = "";
  chips.forEach((c, i) => {
    const a0 = i * segAngle - 90, a1 = (i + 1) * segAngle - 90;
    const large = segAngle > 180 ? 1 : 0;
    const x0 = 100 + 96 * Math.cos(a0 * Math.PI / 180), y0 = 100 + 96 * Math.sin(a0 * Math.PI / 180);
    const x1 = 100 + 96 * Math.cos(a1 * Math.PI / 180), y1 = 100 + 96 * Math.sin(a1 * Math.PI / 180);
    const mine = myKey && c.byKey === myKey || (S.me && myTeam() && c.teamId === myTeam().id);
    segs += `<path d="M100,100 L${x0.toFixed(1)},${y0.toFixed(1)} A96,96 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z"
      fill="hsl(${chipHue(c.teamNumber)},52%,${mine ? 52 : 40}%)" stroke="${mine ? "#FFC53D" : "#201A16"}" stroke-width="${mine ? 2.5 : 0.8}"/>`;
  });

  const old = $("prizeWheel"); if (old) old.remove();
  const ov = document.createElement("div");
  ov.id = "prizeWheel";
  ov.innerHTML = `
    <div class="pw-head"><span class="live-dot"></span> LIVE DRAW — PRIZE ${d.prizeNumber}${isTest ? " (TEST)" : ""}</div>
    <p class="pw-sub">${n} chips in the hat · your team's slices are ringed in gold</p>
    <div class="pw-stage">
      <div class="pw-pointer">▼</div>
      <svg viewBox="0 0 200 200" id="pwSvg">${segs}<circle cx="100" cy="100" r="20" fill="#201A16"/><text x="100" y="106" text-anchor="middle" fill="#FFC53D" font-size="13" font-weight="800">4&amp;C</text></svg>
    </div>
    <div class="pw-result hidden" id="pwResult"></div>`;
  document.body.appendChild(ov);

  const secs = Number(d.seconds || 10);
  const elapsed = isTest ? 0 : Math.max(0, (Date.now() - Date.parse(d.startAt)) / 1000);
  const remain = Math.max(0.5, secs - elapsed);
  const targetDeg = 360 * 6 + (360 - (targetIdx * segAngle + segAngle / 2));
  const svg = $("pwSvg");
  svg.style.transition = `transform ${remain}s cubic-bezier(.12,.65,.08,1)`;
  requestAnimationFrame(() => requestAnimationFrame(() => { svg.style.transform = `rotate(${targetDeg}deg)`; }));

  setTimeout(() => {
    const win = chips[targetIdx];
    const mineWin = myTeam() && win.teamId === myTeam().id;
    const r = $("pwResult");
    if (r) {
      r.classList.remove("hidden");
      r.innerHTML = `<div class="pw-win ${mineWin ? "pw-mine" : ""}">
        ${mineWin ? "🎉🎉 THAT'S YOU! 🎉🎉<br>" : "🏆 "}
        <b>${esc(win.teamName || "Team " + win.teamNumber)}</b> (T${win.teamNumber})<br>
        <span class="small">wins Prize ${d.prizeNumber} — ${win.emoji || "⭐"} ${esc(win.extraName)} chip${win.byName ? " bought by " + esc(win.byName) : ""}</span></div>
        <button class="btn btn-gold btn-block" id="pwClose" style="margin-top:12px">${mineWin ? "LET'S GO! Close" : "Close"}</button>`;
      $("pwClose").addEventListener("click", () => ov.remove());
    }
    setTimeout(() => { if (document.getElementById("prizeWheel") === ov && !$("pwResult")) ov.remove(); }, 60000);
  }, remain * 1000 + 200);
}

async function adminDrawPrize() {
  const chips = eligibleChips(null);
  if (!chips.length) return toast("No chips in the hat yet.", true);
  const n = Object.values(S.draws).reduce((m, d) => Math.max(m, Number(d.prizeNumber || 0)), 0) + 1;
  const u = new Uint32Array(1); crypto.getRandomValues(u);
  const win = chips[u[0] % chips.length];
  const secs = Number(S.config.spinSeconds || 10);
  try {
    await updateDoc(doc(db, "extraPurchases", win.id), { drawnPrize: n });
    await addDoc(collection(db, "draws"), {
      prizeNumber: n, chipId: win.id, teamId: win.teamId, teamNumber: win.teamNumber,
      teamName: win.teamName || "", extraName: win.extraName, emoji: win.emoji, byName: win.byName,
      startAt: nowIso(), seconds: secs, ts: nowIso()
    });
    audit("prize_drawn", `Prize ${n} → T${win.teamNumber} (${win.extraName} chip, ${win.byName})`);
  } catch (e) { toast(e.message, true); }
}

function testWheel() {
  const fake = Array.from({ length: 10 }, (_, i) => ({
    id: "t" + i, teamId: "t" + (i % 5), teamNumber: (i % 5) + 1,
    teamName: ["Salty Dawgs", "Shank Bros", "Mulligang", "Fore Play", "Bogey Men"][i % 5],
    extraName: ["Mulligan", "Putt string", "150-yd drop"][i % 3],
    emoji: ["🎟", "🧵", "🪂"][i % 3], byName: "Test", byKey: null
  }));
  const u = new Uint32Array(1); crypto.getRandomValues(u);
  openWheel({ prizeNumber: "TEST", chipId: fake[u[0] % fake.length].id, seconds: Number(S.config.spinSeconds || 10), chips: fake }, true);
}

// ---------------------------------------------------------------------
// EXTRAS SHOP — buy in-app; every purchase is a chip in the prize hat
// ---------------------------------------------------------------------
function bundleAmt(x) { return x.unit === "each" ? 1 : (x.bundle || 5); }  // one purchase grants this many units

function extrasShopHtml() {
  const list = extrasList();
  const t = myTeam();
  if (!list.length || !t) return "";
  const c = S.config || {};
  const mode = c.extrasMode === "draw" ? "draw" : "select";
  const mine = teamPurchases(t.id).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const due = mine.filter(p => !p.paid && !p.free).reduce((a, p) => a + Number(p.price || 0), 0);
  const dealOn = Number(c.dealBuy) > 0 && Number(c.dealFree) > 0;

  const salesClosed = !!c.scoringOpen;   // real live = no more sales (test mode keeps the shop open)
  let html = `<div class="card" id="extrasShop"><div class="card-title"><span class="flag">🛒</span> ${salesClosed ? "Your extras" : "Get your extras"} — ${teamLabel(t)}</div>`;
  if (salesClosed) html += `<p class="muted small" style="margin:4px 0 8px">🔒 Extras sales are closed — the round is live. Your chips below are locked in for the prize drawings.</p>`;
  if (!salesClosed && dealOn) html += `<div class="deal-band">🔥 DEAL: buy ${c.dealBuy}, get ${c.dealFree} free draw${c.dealFree > 1 ? "s" : ""}!</div>`;

  if (salesClosed) {
    // no buy buttons once live
  } else if (mode === "draw") {
    html += `<p class="muted small" style="margin:6px 0 10px">Every draw is random — you might pull ${list.map(x => x.name).join(", ")}. Every chip you buy also goes in the hat for the prize drawings.</p>
      <button class="btn btn-gold btn-block" id="shopDraw">🎲 Draw your extra (${list.map(x => esc(x.name)).join(" · ")}) — ${money(Number(c.drawPrice || 10))}</button>`;
  } else {
    html += `<p class="muted small" style="margin:6px 0 10px">Pick what you want — every purchase is also a chip in the hat for the prize drawings.</p>`;
    list.forEach(x => {
      const have = extraPurchased(t, x.id);
      const capped = x.max && have + bundleAmt(x) > x.max + 0.001;
      html += `<div class="shop-row">
        <span class="extra-emoji">${x.emoji}</span>
        <span class="extra-info"><b>${esc(x.name)}</b> — ${x.unit === "each" ? money(x.price) + " each" : money(x.price) + " per " + bundleAmt(x) + " " + esc(x.unit)}${x.max ? ` · max ${x.max}${x.unit === "each" ? "" : " " + esc(x.unit)} per team` : ""}${x.unit !== "each" && have ? `<br><span class="muted small">your team's ${esc(x.unit)} pool: ${extraLeft(t, x.id)} of ${have} left</span>` : ""}</span>
        <button class="btn btn-tiny ${capped ? "btn-ghost" : "btn-gold"}" data-shopbuy="${x.id}" ${capped ? "disabled" : ""}>${capped ? "Max" : "Add"}</button>
      </div>`;
    });
  }

  if (mine.length) {
    html += `<div class="shop-list"><b class="small">Your team's chips (${mine.length} in the hat):</b>`;
    mine.forEach(p => {
      html += `<div class="shop-item ${p.drawnPrize ? "shop-won" : ""}">
        <span>${p.emoji || "⭐"} ${esc(p.extraName)}${Number(p.amt) > 1 ? ` ×${p.amt}` : ""}${p.free ? ` <span class="chip chip-mull">FREE</span>` : ""}${p.drawnPrize ? ` 🏆 P${p.drawnPrize}` : ""}</span>
        <span class="shop-right">${p.free ? "—" : money(Number(p.price || 0))} ${p.paid ? `<span class="pay-ok">PAID ✓</span>` : (p.uid === S.user?.uid ? `<button class="btn btn-tiny btn-ghost" data-unbuy="${p.id}">Undo</button>` : `<span class="muted small">due</span>`)}</span>
      </div>`;
    });
    html += `</div>`;
    if (due > 0) {
      const vs = venmoList();
      html += `<div class="shop-due">Total due: <b>${money(due)}</b></div>
        ${vs.map(v => `<button class="btn btn-primary btn-block" data-payextras="${esc(v.handle)}" style="margin-top:6px">💸 PAY FOR MY EXTRAS — Venmo @${esc(v.handle)} ${money(due)}</button>`).join("")}
        <p class="muted small" style="margin-top:6px">Pay at registration — a money admin will mark you PAID.</p>`;
    }
  }
  return html + `</div>`;
}

function wireShop() {
  const t = myTeam();
  $("shopDraw")?.addEventListener("click", () => shopBuy(null, true));
  document.querySelectorAll("[data-shopbuy]").forEach(b => b.addEventListener("click", () => shopBuy(b.dataset.shopbuy, false)));
  document.querySelectorAll("[data-unbuy]").forEach(b => b.addEventListener("click", async () => {
    try {
      await deleteDoc(doc(db, "extraPurchases", b.dataset.unbuy));
      audit("extra_purchase_undone", `by ${S.me?.name || "?"}`);
      toast("Purchase removed.");
    } catch (e) { toast(e.message, true); }
  }));
  document.querySelectorAll("[data-payextras]").forEach(b => b.addEventListener("click", () => {
    if (!t) return;
    const due = teamPurchases(t.id).filter(p => !p.paid && !p.free).reduce((a, p) => a + Number(p.price || 0), 0);
    payVenmoNote(b.dataset.payextras, due, `${S.config.eventName} extras — T${t.number} ${S.me?.name || ""}`);
  }));
}

function randPick(arr) {
  const u = new Uint32Array(1); crypto.getRandomValues(u);
  return arr[u[0] % arr.length];
}

async function shopBuy(extraId, isDraw, asFree) {
  const t = myTeam(); if (!t) return toast("Claim your team first.", true);
  const list = extrasList(); if (!list.length) return;
  const c = S.config || {};
  let x, amt, price;
  if (isDraw || asFree) {
    x = randPick(list);
    amt = bundleAmt(x);
    price = asFree ? 0 : Number(c.drawPrice || 10);
  } else {
    x = list.find(e => e.id === extraId); if (!x) return;
    amt = bundleAmt(x);
    price = Number(x.price);   // line price = price per purchase (per bundle)
    if (x.max && extraPurchased(t, x.id) + (x.unit === "each" ? 1 : amt) > x.max * (x.unit === "each" ? 1 : amt))
      { /* soft cap: compare in units purchased */ }
    if (x.max && extraPurchased(t, x.id) >= x.max * (x.unit === "each" ? 1 : 1) && x.unit === "each") return toast(`Max ${x.max} ${x.name} per team.`, true);
  }
  try {
    const newRef = await addDoc(collection(db, "extraPurchases"), {
      teamId: t.id, teamNumber: t.number, teamName: t.customName || (t.players || []).map(p => p.name).join(" & "),
      uid: S.user?.uid || null, byKey: S.me?.id || null, byName: S.me?.name || "?",
      extraId: x.id, extraName: x.name, emoji: x.emoji, amt, price,
      free: !!asFree, paid: false, drawnPrize: null, ts: nowIso()
    });
    audit(asFree ? "extra_free_draw" : (isDraw ? "extra_drawn" : "extra_bought"),
      `T${t.number}: ${amt}${x.unit === "each" ? "×" : x.unit} ${x.name}${asFree ? " (FREE)" : " " + money(price)} — ${S.me?.name || "?"}`);
    if (isDraw || asFree) {
      openModal(`<div class="modal-title center">${asFree ? "🎁 FREE DRAW!" : "🎲 You drew…"}</div>
        <div class="draw-reveal">${x.emoji}<br><b>${esc(x.name)}</b>${amt > 1 ? ` — +${amt} ${esc(x.unit)}` : ""}</div>
        <div class="modal-actions"><button class="btn btn-primary btn-block" id="mCancel">Nice!</button></div>`);
      $("mCancel").addEventListener("click", closeModal);
    } else {
      toast(`${x.emoji} ${x.name} added — chip's in the hat!`);
    }
    // deal: every dealBuy paid chips earns dealFree free draws
    const db_ = Number(c.dealBuy), df = Number(c.dealFree);
    if (!asFree && db_ > 0 && df > 0) {
      const paidCount = teamPurchases(t.id).filter(p => !p.free && p.id !== newRef.id).length + 1; // this one exactly once
      if (paidCount % db_ === 0) {
        for (let i = 0; i < df; i++) await shopBuy(null, false, true);
        toast(`🔥 Deal hit — ${df} free draw${df > 1 ? "s" : ""} added!`);
      }
    }
  } catch (e) { toast(e.message, true); }
}

function payVenmoNote(handle, amount, noteText) {
  const note = encodeURIComponent(noteText);
  const amt = amount > 0 ? amount.toFixed(2) : "";
  const deep = `venmo://paycharge?txn=pay&recipients=${encodeURIComponent(handle)}&amount=${amt}&note=${note}`;
  const web  = `https://account.venmo.com/pay?recipients=${encodeURIComponent(handle)}&amount=${amt}&note=${note}`;
  const t0 = Date.now();
  window.location.href = deep;
  setTimeout(() => { if (Date.now() - t0 < 1600) window.open(web, "_blank"); }, 1200);
}

// ---------------------------------------------------------------------
// PRIZE WINNERS LOG
// ---------------------------------------------------------------------
function prizeWinnersHtml() {
  const draws = Object.values(S.draws).sort((a, b) => (a.prizeNumber || 0) - (b.prizeNumber || 0));
  if (!draws.length) return "";
  let html = `<div class="card"><div class="card-title"><span class="flag">🎉</span> Prize drawing winners</div><div class="win-log">`;
  draws.forEach(d => {
    html += `<div class="win-row"><span class="win-p">P${d.prizeNumber}</span>
      <span><b>${esc(d.teamName || "Team " + d.teamNumber)}</b> <span class="tnum">(T${d.teamNumber})</span><br>
      <span class="muted small">${d.emoji || "⭐"} ${esc(d.extraName || "")} chip · bought by ${esc(d.byName || "?")}</span></span></div>`;
  });
  return html + `</div></div>`;
}

function extrasSaleHtml() {
  const list = extrasList();
  if (!list.length || myTeam()) return "";
  let html = `<div class="card"><div class="card-title"><span class="flag">🛒</span> Day-of extras — cash or Venmo at the tent</div><div class="extras-list">`;
  list.forEach(x => {
    html += `<div class="extra-row"><span class="extra-emoji">${x.emoji}</span>
      <span class="extra-info"><b>${esc(x.name)}</b> — ${money(x.price)}${x.unit === "each" ? " each" : "/" + esc(x.unit)}${x.max ? ` · max ${x.max}${x.unit === "each" ? "" : " " + esc(x.unit)} per team` : ""}
      ${x.note ? `<br><span class="muted small">${esc(x.note)}</span>` : ""}</span></div>`;
  });
  return html + `</div></div>`;
}

function myScoringHtml() {
  const t = myTeam();
  if (!t) {
    const teams = Object.values(S.teams).sort((a, b) => a.number - b.number);
    return `<div class="card"><div class="card-title"><span class="flag">⛳</span> Enter scores</div>
      <p class="muted">Pick your team — either player can keep score.</p>
      <select class="field" id="claimTeam"><option value="">Select your team…</option>
        ${teams.map(x => `<option value="${x.id}">T${x.number} — ${esc(x.customName || (x.players||[]).map(p=>p.name).join(" & "))}</option>`).join("")}
      </select>
      <button class="btn btn-primary btn-block" id="claimBtn">This is my team</button></div>`;
  }

  const s = teamScore(t);
  const seq = nextSeq(t);
  const myExtras = extrasList().filter(x => extraPurchased(t, x.id) > 0);
  let html = `<div class="card"><div class="card-title"><span class="flag">⛳</span> ${teamLabel(t)} — your scorecard</div>
    <div class="roster-count">
      <span class="chip">${s.played ? relFmt(s.rel) + " thru " + s.played : "Not started"}</span>
      <span class="chip">Start hole <b>${esc(t.hole || "?")}</b></span>
      ${myExtras.map(x => `<span class="chip">${x.emoji} ${x.unit === "each" ? `${extraLeft(t, x.id)} left` : `${extraLeft(t, x.id)}${esc(x.unit)} left`}</span>`).join("")}
      ${s.pen ? `<span class="chip chip-pen">+${s.pen} penalty</span>` : ""}
    </div>`;

  const curSeq = (S.entrySeq && S.entrySeq >= 1 && S.entrySeq <= holesCount()) ? S.entrySeq : seq;
  if (curSeq) {
    const ph = physHole(t, curSeq), par = parFor(t, curSeq);
    const existing = (t.scores || {})[curSeq];
    const cs = contests().filter(x => x.hole === ph);
    html += `<div class="entry-box">
      ${cs.map(x => `<div class="contest-flag ${x.cls}">${x.emoji} ${x.name.toUpperCase()} HOLE — ${x.cls === "ld" ? "bombs away" : "stick it close"}</div>`).join("")}
      <div class="hole-nav">
        <button class="hn-btn" id="scPrev" ${curSeq <= 1 ? "disabled" : ""}>‹</button>
        <div class="hn-label">Course hole <b>#${ph}</b> · par ${par}<br><span class="muted small">your ${curSeq}${curSeq === 1 ? "st" : curSeq === 2 ? "nd" : curSeq === 3 ? "rd" : "th"} of ${holesCount()}${existing != null ? " · editing" : ""}</span></div>
        <button class="hn-btn" id="scNext" ${curSeq >= holesCount() ? "disabled" : ""}>›</button>
      </div>
      <div class="entry-cols">
        ${HOLE_INFO[ph] ? `<button class="entry-img" data-holezoom="${ph}"><img src="${holeImgSrc(ph)}" alt="hole ${ph}" loading="lazy"><span>tap to zoom</span></button>` : "<span></span>"}
        <div class="entry-right">
          <div class="score-label">⛳ YOUR SCORE — HOLE #${ph}</div>
          <div class="stepper">
            <button class="step-btn" id="scMinus">−</button>
            <span class="step-wrap"><span class="step-val" id="scVal" data-val="${existing ?? par}" data-par="${par}">${existing ?? par}</span><span class="step-rel" id="scRel">(${relFmt((existing ?? par) - par)})</span></span>
            <button class="step-btn" id="scPlus">+</button>
          </div>
          ${extraControlsHtml(t, curSeq, "sc")}
          <button class="btn btn-primary btn-block" id="scSave">${existing != null ? "Update" : "Save"} hole #${ph}</button>
        </div>
      </div>
    </div>`;
  } else {
    html += `<p class="pay-ok" style="font-weight:800;margin:10px 0">🏁 Round complete — great playing! Tap any hole below to fix a score.</p>`;
  }

  // full grid — holes 1..18 in play order; entry panel shows the course hole
  html += `<div class="score-grid">`;
  for (let q = 1; q <= holesCount(); q++) {
    const v = (t.scores || {})[q];
    const par = parFor(t, q), ph = physHole(t, q);
    const cls = v == null ? "" : v < par ? "sg-under" : v > par ? "sg-over" : "sg-even";
    const marks = extraUsesAt(t, q).map(u => (extrasList().find(x => x.id === u.id) || {}).emoji || "⭐").join("");
    const cMark = contests().filter(x => x.hole === ph).map(x => x.emoji).join("");
    html += `<button class="sg-cell ${cls} ${cMark ? "sg-contest" : ""} ${q === curSeq ? "sg-cur" : ""}" data-selscore="${q}" title="course hole #${ph}, par ${par}${cMark ? " — contest hole" : ""}">
      <span class="sg-hole">${q}</span>
      <span class="sg-val">${v ?? "·"}</span>${v != null ? `<span class="sg-relx">${relFmt(v - par)}</span>` : ""}${marks ? `<span class="sg-mull">${marks}</span>` : ""}${cMark ? `<span class="sg-cmark">${cMark}</span>` : ""}
    </button>`;
  }
  html += `</div>`;

  html += `<div class="add-row" style="margin-top:12px">
      <input class="field" id="teamNameIn" placeholder="Team name (fun optional)" value="${esc(t.customName || "")}" maxlength="26" style="flex:1">
      <button class="btn btn-ghost" id="teamNameSave">Save name</button>
    </div>
    <button class="btn btn-ghost btn-block btn-tiny" id="unclaimBtn" style="margin-top:8px">Not your team? Switch</button>
  </div>`;
  return html;
}

// controls for using extras on a hole; prefix keeps sc/em ids distinct
function extraControlsHtml(t, seq, prefix) {
  const existing = extraUsesAt(t, seq);
  let html = "";
  extrasList().forEach(x => {
    const cur = existing.filter(u => u.id === x.id).reduce((a, u) => a + Number(u.amt || 0), 0);
    const avail = extraLeft(t, x.id) + cur;
    if (avail <= 0) return;
    if (x.unit === "each") {
      html += `<label class="mull-row"><span class="mr-name">${x.emoji} ${esc(x.name)}</span>
        <select class="mull-n" data-exuse="${x.id}" data-exprefix="${prefix}">
          ${Array.from({ length: avail + 1 }, (_, i) => `<option value="${i}" ${i === cur ? "selected" : ""}>${i}</option>`).join("")}
        </select><span class="mr-avail">${avail} avail</span></label>`;
    } else {
      html += `<label class="mull-row"><span class="mr-name">${x.emoji} ${esc(x.name)}</span>
        <input class="mull-ft" inputmode="numeric" pattern="[0-9]*" data-exuse="${x.id}" data-exprefix="${prefix}" value="${cur || ""}" placeholder="0"><span class="mr-avail">${esc(x.unit)} · ${avail} left</span></label>`;
    }
  });
  return html;
}
function collectExtraUses(prefix, t, seq) {
  const uses = [];
  let err = null;
  document.querySelectorAll(`[data-exuse][data-exprefix="${prefix}"]`).forEach(el => {
    const id = el.dataset.exuse;
    const amt = Math.max(0, Math.round(Number(el.value) || 0));
    if (!amt) return;
    const x = extrasList().find(e => e.id === id);
    const cur = extraUsesAt(t, seq).filter(u => u.id === id).reduce((a, u) => a + Number(u.amt || 0), 0);
    if (amt > extraLeft(t, id) + cur) { err = `Not enough ${x?.name || id} left.`; return; }
    uses.push({ id, seq, amt, ts: nowIso(), by: (S.me?.name || "?") });
  });
  return { uses, err };
}

function wireHoleZoom() {
  document.querySelectorAll("[data-holezoom]").forEach(b => b.addEventListener("click", () => openHoleZoom(Number(b.dataset.holezoom))));
}

function openHoleZoom(ph) {
  const inf = HOLE_INFO[ph] || {};
  const par = pars()[ph - 1];
  const old = $("holeZoom"); if (old) old.remove();
  const ov = document.createElement("div");
  ov.id = "holeZoom";
  ov.innerHTML = `
    <div class="hz-top">
      <div class="hz-title">HOLE ${ph} <span class="hz-sub">PAR ${par} · HCP ${inf.hcp ?? "–"}</span></div>
      <div class="hz-tees"><i class="td td-b"></i>${inf.blue ?? "–"} <i class="td td-w"></i>${inf.white ?? "–"} <i class="td td-r"></i>${inf.red ?? "–"}</div>
      <button class="hz-close" id="hzClose">✕</button>
    </div>
    <div class="hz-stage" id="hzStage"><img src="${holeImgSrc(ph)}" id="hzImg" alt="hole ${ph}" draggable="false"></div>`;
  document.body.appendChild(ov);
  $("hzClose").addEventListener("click", () => ov.remove());

  const img = $("hzImg"), stage = $("hzStage");
  let scale = 1, tx = 0, ty = 0;
  const ptrs = new Map();
  let start = null, lastTap = 0;
  const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; };
  const clamp = () => {
    scale = Math.min(6, Math.max(1, scale));
    const r = stage.getBoundingClientRect();
    const mx = (img.offsetWidth * scale - r.width) / 2 + 60, my = (img.offsetHeight * scale - r.height) / 2 + 60;
    tx = Math.min(Math.max(tx, -Math.max(mx, 60)), Math.max(mx, 60));
    ty = Math.min(Math.max(ty, -Math.max(my, 60)), Math.max(my, 60));
  };
  stage.addEventListener("pointerdown", e => {
    stage.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) {
      const now = Date.now();
      if (now - lastTap < 300) { scale = scale > 1.2 ? 1 : 2.6; if (scale === 1) { tx = ty = 0; } clamp(); apply(); }
      lastTap = now;
      start = { x: e.clientX, y: e.clientY, tx, ty };
    } else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      start = { d: Math.hypot(a.x - b.x, a.y - b.y), scale, tx, ty };
    }
  });
  stage.addEventListener("pointermove", e => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1 && start && start.d == null) {
      tx = start.tx + (e.clientX - start.x); ty = start.ty + (e.clientY - start.y);
      clamp(); apply();
    } else if (ptrs.size === 2 && start && start.d != null) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      scale = start.scale * (d / start.d);
      clamp(); apply();
    }
  });
  const up = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) start = ptrs.size === 1 ? { x: [...ptrs.values()][0].x, y: [...ptrs.values()][0].y, tx, ty } : null; };
  stage.addEventListener("pointerup", up); stage.addEventListener("pointercancel", up);
  apply();
}

function wireLive() {
  $("claimBtn")?.addEventListener("click", async () => {
    const id = $("claimTeam").value;
    if (!id) return toast("Pick your team first.", true);
    try {
      await updateDoc(doc(db, "accounts", S.me.id), { myTeamId: id });
      audit("team_claimed", `${S.me.name} → T${S.teams[id]?.number}`);
    } catch (e) { toast(e.message, true); }
  });
  $("unclaimBtn")?.addEventListener("click", async () => {
    try { await updateDoc(doc(db, "accounts", S.me.id), { myTeamId: null }); } catch (e) { toast(e.message, true); }
  });
  $("teamNameSave")?.addEventListener("click", async () => {
    const t = myTeam(); if (!t) return;
    const name = $("teamNameIn").value.trim();
    try {
      await updateDoc(doc(db, "teams", t.id), { customName: name });
      audit("team_renamed", `T${t.number} → "${name}" by ${S.me?.name}`);
      toast(name ? `You are now ${name} (T${t.number}).` : "Back to plain T" + t.number + ".");
    } catch (e) { toast(e.message, true); }
  });

  const step = (d) => {
    const el = $("scVal"); if (!el) return;
    const v = Math.max(1, Math.min(15, Number(el.dataset.val) + d));
    el.dataset.val = v; el.textContent = v;
    const par = Number(el.dataset.par || 0);
    const rel = $("scRel");
    if (rel && par) {
      rel.textContent = `(${relFmt(v - par)})`;
      rel.className = "step-rel " + (v < par ? "rel-under" : v > par ? "rel-over" : "");
    }
  };
  $("scMinus")?.addEventListener("click", () => step(-1));
  $("scPlus")?.addEventListener("click", () => step(1));

  $("scPrev")?.addEventListener("click", () => {
    const t = myTeam(); if (!t) return;
    const cur = (S.entrySeq ?? nextSeq(t)) || holesCount();
    S.entrySeq = Math.max(1, cur - 1); renderLive();
  });
  $("scNext")?.addEventListener("click", () => {
    const t = myTeam(); if (!t) return;
    const cur = (S.entrySeq ?? nextSeq(t)) || holesCount();
    S.entrySeq = Math.min(holesCount(), cur + 1); renderLive();
  });
  $("scSave")?.addEventListener("click", async () => {
    const t = myTeam(); if (!t) return;
    const seq = (S.entrySeq && S.entrySeq >= 1) ? S.entrySeq : nextSeq(t);
    if (!seq) return;
    const isEdit = (t.scores || {})[seq] != null;
    const v = Number($("scVal").dataset.val);
    const { uses, err } = collectExtraUses("sc", t, seq);
    if (err) return toast(err, true);
    await saveHole(t, seq, v, uses, isEdit);
    S.entrySeq = null;
  });

  document.querySelectorAll("[data-selscore]").forEach(b => b.addEventListener("click", () => {
    S.entrySeq = Number(b.dataset.selscore);
    renderLive();
    $("scVal") && document.querySelector(".entry-box")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }));
  wireHoleZoom();
}

async function saveHole(t, seq, strokes, uses, isEdit) {
  try {
    // replace this hole's extra uses with the new set
    const otherUses = (t.extraUses || []).filter(u => Number(u.seq) !== Number(seq));
    const upd = {
      ["scores." + seq]: strokes,
      ["scoreTimes." + seq]: nowIso(),
      extraUses: [...otherUses, ...(uses || [])],
      lastScoreAt: nowIso(),
      lastScoreBy: S.me?.name || "?"
    };
    await updateDoc(doc(db, "teams", t.id), upd);
    const ph = physHole(t, seq), par = parFor(t, seq);
    const useTxt = (uses || []).map(u => {
      const x = extrasList().find(e => e.id === u.id);
      return `${u.amt}${x && x.unit !== "each" ? x.unit : "×"} ${x?.name || u.id}`;
    }).join(", ");
    audit(isEdit ? "score_edited" : "score_entered",
      `T${t.number} hole ${seq} (course #${ph}): ${strokes} (par ${par})${useTxt ? " — " + useTxt : ""} — by ${S.me?.name || "?"}`);
    toast(`Hole #${ph} saved: ${strokes} (${relFmt(strokes - par)}).`);
  } catch (e) { toast(e.message, true); }
}

function openEditScore(t, seq) {
  const cur = (t.scores || {})[seq];
  const par = parFor(t, seq), ph = physHole(t, seq);
  openModal(`
    <div class="modal-title">Hole ${seq} <span class="muted small">(course #${ph} · par ${par})</span></div>
    ${cur != null ? `<p class="muted small">Edits are logged on the audit trail.</p>` : ""}
    <div class="stepper" style="margin:14px 0">
      <button class="step-btn" id="emMinus">−</button>
      <span class="step-val" id="emVal" data-val="${cur ?? par}">${cur ?? par}</span>
      <button class="step-btn" id="emPlus">+</button>
    </div>
    ${extraControlsHtml(t, seq, "em")}
    <div class="modal-actions">
      <button class="btn btn-ghost" id="mCancel">Cancel</button>
      <button class="btn btn-primary" id="emSave">Save</button>
    </div>`);
  const step = (d) => {
    const el = $("emVal");
    const v = Math.max(1, Math.min(15, Number(el.dataset.val) + d));
    el.dataset.val = v; el.textContent = v;
  };
  $("emMinus").addEventListener("click", () => step(-1));
  $("emPlus").addEventListener("click", () => step(1));
  $("mCancel").addEventListener("click", closeModal);
  $("emSave").addEventListener("click", async () => {
    const v = Number($("emVal").dataset.val);
    const { uses, err } = collectExtraUses("em", t, seq);
    if (err) return toast(err, true);
    await saveHole(t, seq, v, uses, cur != null);
    closeModal();
  });
}

// ---------------------------------------------------------------------
// ADMIN SIGN-IN
// ---------------------------------------------------------------------
$("adminBtn").addEventListener("click", async () => {
  if (S.adminEmail) {
    openModal(`
      <div class="modal-title">Admin</div>
      <p style="margin-top:8px">Signed in as <b>${esc(S.adminEmail)}</b> — ${S.isFull ? "full admin" : S.isFin ? "financial admin" : "no admin access on this email"}.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="mCancel">Close</button>
        <button class="btn btn-danger" id="mOut">Sign out of admin</button>
      </div>`);
    $("mCancel").addEventListener("click", closeModal);
    $("mOut").addEventListener("click", async () => {
      await signOut(auth); closeModal();
      toast("Signed out of admin.");
    });
    return;
  }
  const prov = new GoogleAuthProvider();
  try { await signInWithPopup(auth, prov); }
  catch (e) {
    if (String(e.code).includes("popup")) { try { await signInWithRedirect(auth, prov); } catch (e2) { toast(e2.message, true); } }
    else toast(e.message, true);
  }
});

// bootstrap config on first admin sign-in
async function ensureConfig() {
  if (S.config) return;
  const snap = await getDoc(doc(db, "config", "current"));
  if (snap.exists()) return; // never overwrite live settings
  await setDoc(doc(db, "config", "current"), defaultConfig(S.adminEmail));
  audit("config_bootstrapped", "First-run setup");
}

// ---------------------------------------------------------------------
// ADMIN TAB
// ---------------------------------------------------------------------
function renderAdmin() {
  const el = $("tab-admin");
  if (!S.isFin) { el.innerHTML = `<div class="card"><p class="muted">Sign in with an admin Google account to use this tab.</p></div>`; return; }
  let html = "";
  html += adminPairingHtml();
  html += adminHolesHtml();
  html += adminScoringHtml();
  html += adminExtrasPaymentsHtml();
  html += adminPaymentsHtml();
  if (S.isFull) html += adminSettingsHtml() + adminDangerHtml() + adminAuditHtml();
  el.innerHTML = html;
  wireAdmin();
}

// ---------- pairing ----------
function unpairedIndividuals() {
  return Object.values(S.regs).filter(r => r.type === "individual" && !r.teamId)
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
}
function hcpOf(reg) {
  const h = parseFloat(reg.players?.[0]?.handicap);
  return isNaN(h) ? DEFAULT_HANDICAP : h;
}
function nameMatch(a, b) {
  a = a.toLowerCase().trim(); b = b.toLowerCase().trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const at = a.split(/\s+/), bt = b.split(/\s+/);
  return at[0] === bt[0] && at[at.length - 1] === bt[bt.length - 1];
}

function adminPairingHtml() {
  const solo = unpairedIndividuals();
  // suggestions: partner-name matches
  const used = new Set();
  const suggestions = [];
  solo.forEach(r => {
    if (r.preference !== "partner" || used.has(r.id)) return;
    const match = solo.find(o => o.id !== r.id && !used.has(o.id) && nameMatch(r.partnerName || "", o.players[0]?.name || ""));
    if (match) { suggestions.push([r, match]); used.add(r.id); used.add(match.id); }
  });

  let html = `<div class="card admin-section"><div class="card-title"><span class="flag">🤝</span> Pair players</div>`;
  if (!solo.length) {
    html += `<p class="muted">No unpaired individuals right now.</p></div>`;
    return html;
  }
  if (suggestions.length) {
    html += `<p class="small" style="color:var(--gold);font-weight:700">Requested partners found:</p>`;
    suggestions.forEach(([a, b]) => {
      html += `<div class="suggest">
        <b>${esc(a.players[0].name)}</b> asked for <b>${esc(a.partnerName)}</b> — matches <b>${esc(b.players[0].name)}</b>
        <button class="btn btn-sm btn-gold btn-block" data-pair="${a.id}|${b.id}">Pair them · Team ${nextTeamPreview()}</button>
      </div>`;
    });
  }
  html += `<p class="small muted" style="margin-top:12px">Tap two players, then pair them. Requested partners are noted.</p>`;
  solo.forEach(r => {
    const p = r.players[0] || {};
    const sel = S.pairSel.includes(r.id);
    html += `<div class="pair-item ${sel ? "selected" : ""}" data-sel="${r.id}">
      <span class="nm">${esc(p.name)}</span>
      <span class="muted small">hcp ${p.handicap !== "" && p.handicap != null ? esc(p.handicap) : DEFAULT_HANDICAP + " (assumed)"}</span>
      <span class="why">${r.preference === "partner" ? "wants: " + esc(r.partnerName) : "random 🎲"}</span>
    </div>`;
  });
  html += `<button class="btn btn-primary btn-block" id="pairSelected" ${S.pairSel.length === 2 ? "" : "disabled"}>Pair selected (${S.pairSel.length}/2)</button>`;
  html += `<button class="btn btn-green btn-block" id="assignTeams" ${solo.length >= 2 ? "" : "disabled"}>⚡ Assign teams — auto-pair remaining ${solo.length} by handicap</button>`;
  html += `<p class="muted small" style="margin-top:8px">Auto-assign balances handicaps: each team gets one lower-handicap and one higher-handicap player, without pairing the best with the worst. Blank handicap counts as ${DEFAULT_HANDICAP}.</p>`;
  html += `</div>`;
  return html;
}

function nextTeamPreview() {
  const nums = Object.values(S.teams).map(t => Number(t.number || 0));
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

async function pairRegs(idA, idB, source) {
  const a = S.regs[idA], b = S.regs[idB];
  if (!a || !b || a.teamId || b.teamId) throw new Error("One of those players is already teamed.");
  await runTransaction(db, async (tx) => {
    const num = await nextTeamNumberTx(tx);
    const teamRef = doc(collection(db, "teams"));
    tx.set(teamRef, {
      number: num, source: source || "paired", hole: "",
      regIds: [idA, idB],
      players: [{ ...(a.players[0] || {}) }, { ...(b.players[0] || {}) }],
      createdAt: nowIso()
    });
    tx.update(doc(db, "registrations", idA), { teamId: teamRef.id, updatedAt: nowIso() });
    tx.update(doc(db, "registrations", idB), { teamId: teamRef.id, updatedAt: nowIso() });
  });
}

// balanced auto-assign: sort by handicap, split low/high halves, pair A[i]+B[i]
function proposeAutoTeams() {
  const solo = unpairedIndividuals().map(r => ({ r, h: hcpOf(r) })).sort((x, y) => x.h - y.h);
  const n = solo.length;
  const half = Math.floor(n / 2);
  const A = solo.slice(0, half);
  const B = solo.slice(half + (n % 2));
  const leftover = n % 2 ? solo[half] : null;
  const pairs = A.map((a, i) => [a, B[i]]);
  return { pairs, leftover };
}

function confirmAutoAssign() {
  const { pairs, leftover } = proposeAutoTeams();
  if (!pairs.length) return toast("Need at least 2 unpaired players.", true);
  let num = nextTeamPreview();
  let list = pairs.map(([a, b]) =>
    `<tr><td><span class="tee">${num++}</span></td><td>${esc(a.r.players[0].name)} <span class="hcp">(${a.h})</span><br>${esc(b.r.players[0].name)} <span class="hcp">(${b.h})</span></td></tr>`
  ).join("");
  openModal(`
    <div class="modal-title">Assign teams</div>
    <div class="modal-sub">One low-handicap + one high-handicap per team, best not stuck with worst. Review, then lock it in.</div>
    <div class="scorecard" style="margin-top:10px"><table><tr><th style="width:44px">Team</th><th>Proposed pairing</th></tr>${list}</table></div>
    ${leftover ? `<p class="small" style="margin-top:10px;color:var(--gold)">⚠️ Odd number — <b>${esc(leftover.r.players[0].name)}</b> is left over. Pair them manually or find one more player.</p>` : ""}
    <div class="modal-actions">
      <button class="btn btn-ghost" id="mCancel">Cancel</button>
      <button class="btn btn-green" id="mGo">Lock in ${pairs.length} team${pairs.length === 1 ? "" : "s"}</button>
    </div>`);
  $("mCancel").addEventListener("click", closeModal);
  $("mGo").addEventListener("click", async () => {
    try {
      for (const [a, b] of pairs) await pairRegs(a.r.id, b.r.id, "auto");
      audit("teams_auto_assigned", `${pairs.length} teams created by handicap balance`);
      toast(`${pairs.length} teams locked in.`);
      S.pairSel = [];
      closeModal();
    } catch (e) { toast(e.message, true); }
  });
}

// ---------- holes ----------
function holeOptions(current) {
  let opts = `<option value="">—</option>`;
  for (let h = 1; h <= pars().length; h++) for (const s of ["A", "B"]) {
    const v = `${h}${s}`;
    opts += `<option value="${v}" ${current === v ? "selected" : ""}>${v}</option>`;
  }
  return opts;
}
function adminHolesHtml() {
  const teams = Object.values(S.teams).sort((a, b) => a.number - b.number);
  let html = `<div class="card admin-section"><div class="card-title"><span class="flag">🕳️</span> Hole assignments</div>`;
  if (!teams.length) { html += `<p class="muted">Assign holes once teams are set — usually the day before.</p></div>`; return html; }
  html += `<div class="table-scroll"><table class="admin-table"><tr><th>Team</th><th>Players</th><th>Hole</th><th></th></tr>`;
  teams.forEach(t => {
    const splittable = t.source !== "registration";
    html += `<tr>
      <td><b>${t.number}</b></td>
      <td class="small">${(t.players || []).map(p => esc(p.name)).join("<br>")}</td>
      <td><select class="hole-select" data-hole="${t.id}">${holeOptions(t.hole || "")}</select></td>
      <td>${splittable ? `<button class="btn btn-tiny btn-ghost" data-split="${t.id}" title="Undo this pairing">Split</button>` : ""}</td>
    </tr>`;
  });
  html += `</table></div><p class="muted small" style="margin-top:8px">Saves instantly and shows on the public roster.</p></div>`;
  return html;
}


// ---------- live scoring (fin + full) ----------
function adminScoringHtml() {
  const c = S.config;
  const teams = Object.values(S.teams).sort((a, b) => a.number - b.number);
  const med = fieldMedianThru();
  const thr = Number(c.paceThreshold || 3);
  let html = `<div class="card admin-section"><div class="card-title"><span class="flag">🔴</span> Live scoring</div>
    <div class="toggle-row">
      <div><b>Scoring open</b><br><span class="muted small">Flip on at the shotgun start. Shows the LIVE banner to everyone.</span></div>
      <label class="switch"><input type="checkbox" id="setScoring" ${c.scoringOpen ? "checked" : ""}><span class="slider"></span></label>
    </div>
    <div class="toggle-row">
      <div><b>🧪 Scoring test mode</b><br><span class="muted small">Live tab works for admins only. Turning OFF wipes all scores &amp; extra-usage automatically.</span></div>
      <label class="switch"><input type="checkbox" id="setScoringTest" ${c.scoringTest ? "checked" : ""}><span class="slider"></span></label>
    </div>
    <div class="drawings-box">
      <b>🎡 Prize drawings</b> — ${eligibleChips(null).length} chip${eligibleChips(null).length === 1 ? "" : "s"} in the hat
      <div class="add-row" style="margin-top:8px">
        <button class="btn btn-gold" id="drawPrizeBtn" style="flex:1">🎡 Draw for prize ${Object.values(S.draws).reduce((m, d) => Math.max(m, Number(d.prizeNumber || 0)), 0) + 1}</button>
        <button class="btn btn-ghost" id="testWheelBtn">🧪 Test wheel</button>
      </div>
      <p class="muted small" style="margin-top:6px">Everyone's phone gets the ${Number(c.spinSeconds || 10)}-second wheel. Drawn chips leave the hat. Test wheel is local — only you see it, nothing is saved.</p>
      ${(() => {
        const ds = Object.values(S.draws).sort((a, b) => (a.prizeNumber || 0) - (b.prizeNumber || 0));
        if (!ds.length) return "";
        return `<div class="shop-list" style="margin-top:8px"><b class="small">Winners so far:</b>
          ${ds.map(d => `<div class="shop-item"><span><b>P${d.prizeNumber}</b> — ${esc(d.teamName || "Team " + d.teamNumber)} (T${d.teamNumber})</span><span class="small">${d.emoji || ""} ${esc(d.extraName || "")} · ${esc(d.byName || "")}</span></div>`).join("")}
          <button class="btn btn-tiny btn-ghost btn-block" id="resetDrawsBtn" style="margin-top:8px">↺ Reset drawings (clears winners, chips go back in the hat)</button>
        </div>`;
      })()}
    </div>
    ${adminContestWinnersHtml()}`;
  if (!teams.length) return html + `<p class="muted" style="margin-top:8px">Teams will appear here once they're set.</p></div>`;
  const anyExtras = extrasList().length > 0;
  html += `<div class="table-scroll" style="margin-top:10px"><table class="admin-table">
    <tr><th>Team</th><th>Thru</th><th>Score</th>${anyExtras ? "<th>Extras</th>" : ""}<th>Flags</th><th></th></tr>`;
  teams.forEach(t => {
    const s = teamScore(t);
    const behind = c.scoringOpen && med - s.played >= thr && s.played < holesCount();
    const bulk = isBulkEntry(t);
    html += `<tr>
      <td><b>T${t.number}</b> ${t.customName ? `<span class="small">${esc(t.customName)}</span>` : ""}<br><span class="muted small">${(t.players||[]).map(p=>esc(p.name)).join(" & ")}</span></td>
      <td>${s.played}/${holesCount()}</td>
      <td>${s.played ? relFmt(s.rel) : "—"}${s.pen ? ` <span class="chip-pen small">(+${s.pen})</span>` : ""}</td>
      ${anyExtras ? `<td class="small">${extrasList().map(x => extraPurchased(t, x.id) ? `${x.emoji}${extraUsed(t, x.id)}/${extraPurchased(t, x.id)}` : "").filter(Boolean).join(" ") || "—"}<br><button class="btn btn-tiny btn-ghost" data-extras="${t.id}">Set</button></td>` : ""}
      <td class="small">${behind ? `<span class="chip chip-behind">⏳ ${med - s.played} behind</span>` : ""} ${bulk ? `<span class="chip chip-pen" title="4+ holes entered within 3 minutes">📦 bulk entry</span>` : ""}</td>
      <td><button class="btn btn-tiny btn-ghost" data-penalty="${t.id}">Penalty</button></td>
    </tr>`;
    (t.penalties || []).forEach((p, i) => {
      html += `<tr class="pen-row"><td colspan="${anyExtras ? 5 : 4}" class="small">⚠ +${Number(p.strokes)} — ${esc(p.note || "")} <span class="muted">(${esc(p.by || "")}, ${esc((p.ts || "").slice(5, 16).replace("T", " "))})</span></td>
        <td><button class="btn btn-tiny btn-ghost" data-unpen="${t.id}|${i}">Remove</button></td></tr>`;
    });
  });
  html += `</table></div>
    <p class="muted small" style="margin-top:8px">Sell extras for cash/Venmo, log the money under Payments as usual, then tap <b>Set</b> to record what each team bought. Penalty strokes add straight onto the team score and show on the public leaderboard. Field median: thru ${med}.</p></div>`;
  return html;
}

function openExtrasModal(teamId) {
  const t = S.teams[teamId]; if (!t) return;
  const list = extrasList();
  openModal(`
    <div class="modal-title">Extras — T${t.number}${t.customName ? " " + esc(t.customName) : ""}</div>
    <p class="muted small">Amount bought per team${list.some(x => x.max) ? " (maxes shown)" : ""}. Money gets logged under Payments.</p>
    ${list.map(x => `
      <label class="field-label">${x.emoji} ${esc(x.name)} — manual/cash amount (app purchases add on top)</label>
      <input class="field" inputmode="numeric" id="exbuy_${x.id}" value="${Number((t.extrasPurchased || {})[x.id] || 0) || ""}" placeholder="0">
      <p class="muted small" style="margin:2px 0 8px">total ${extraPurchased(t, x.id)} · used ${extraUsed(t, x.id)}</p>`).join("")}
    ${(() => {
      const mine = teamPurchases(t.id).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
      if (!mine.length) return "";
      const due = mine.filter(p => !p.paid && !p.free).reduce((a, p) => a + Number(p.price || 0), 0);
      return `<div class="shop-list"><b class="small">App purchases (${mine.length} chips${due ? ` · ${money(due)} unpaid` : " · all paid"}):</b>
        ${mine.map(p => `<div class="shop-item"><span>${p.emoji} ${esc(p.extraName)}${Number(p.amt) > 1 ? " ×" + p.amt : ""}${p.free ? " FREE" : ""} <span class="muted small">${esc(p.byName)}</span></span>
          <span class="shop-right">${p.free ? "—" : money(Number(p.price || 0))}
            ${p.free ? "" : `<button class="btn btn-tiny ${p.paid ? "btn-ghost" : "btn-gold"}" data-buypaid="${p.id}|${p.paid ? 0 : 1}">${p.paid ? "Unpay" : "Mark paid"}</button>`}
            <button class="btn btn-tiny btn-ghost" data-buydel="${p.id}">✕</button></span></div>`).join("")}
      </div>`;
    })()}
    <div class="modal-actions">
      <button class="btn btn-ghost" id="mCancel">Cancel</button>
      <button class="btn btn-gold" id="exGo">Save</button>
    </div>`);
  $("mCancel").addEventListener("click", closeModal);
  document.querySelectorAll("[data-buypaid]").forEach(b => b.addEventListener("click", async () => {
    const [pid, to] = b.dataset.buypaid.split("|");
    try {
      await updateDoc(doc(db, "extraPurchases", pid), { paid: to === "1" });
      audit(to === "1" ? "extras_paid" : "extras_unpaid", `purchase ${pid} T${t.number} by ${S.adminEmail}`);
      toast(to === "1" ? "Marked paid." : "Marked unpaid.");
      closeModal();
    } catch (e) { toast(e.message, true); }
  }));
  document.querySelectorAll("[data-buydel]").forEach(b => b.addEventListener("click", async () => {
    try { await deleteDoc(doc(db, "extraPurchases", b.dataset.buydel)); audit("extras_purchase_deleted", `T${t.number} by ${S.adminEmail}`); toast("Purchase deleted."); closeModal(); }
    catch (e) { toast(e.message, true); }
  }));
  $("exGo").addEventListener("click", async () => {
    const bought = {};
    let bad = null;
    list.forEach(x => {
      const v = Math.max(0, Number($("exbuy_" + x.id).value) || 0);
      if (x.max && v > x.max) bad = `${x.name}: max ${x.max} per team.`;
      if (v) bought[x.id] = v;
    });
    if (bad) return toast(bad, true);
    try {
      await updateDoc(doc(db, "teams", t.id), { extrasPurchased: bought });
      audit("extras_set", `T${t.number}: ` + (list.map(x => bought[x.id] ? `${bought[x.id]} ${x.name}` : "").filter(Boolean).join(", ") || "none"));
      toast(`T${t.number} extras saved.`);
      closeModal();
    } catch (e) { toast(e.message, true); }
  });
}


// ---------------------------------------------------------------------
// EVENT WORKBOOK (.xlsx) — full record of the event
// ---------------------------------------------------------------------
async function loadXLSX() {
  if (window.XLSX) return window.XLSX;
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
  return window.XLSX;
}

async function exportWorkbook() {
  toast("Building workbook…");
  let X;
  try { X = await loadXLSX(); } catch { return toast("Couldn't load the Excel library — check connection.", true); }
  const c = S.config || {};
  const wb = X.utils.book_new();
  const sheet = (name, rows) => X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(rows), name);

  // ---- Overview ----
  const teams = Object.values(S.teams).sort((a, b) => a.number - b.number);
  const regs = Object.values(S.regs);
  sheet("Overview", [
    [c.eventName || "Fourth and Cold Golf Open"],
    ["Exported", new Date().toLocaleString()],
    [],
    ["Teams", teams.length],
    ["Registrations", regs.length],
    ["Players registered", regs.reduce((a, r) => a + (r.players || []).length, 0)],
    ["Extras chips sold", Object.values(S.purchases).length],
    ["Prize drawings held", Object.values(S.draws).length],
    [],
    ["💪 Longest drive winner", c.contestLDWinner || "—", c.contestLD ? "hole #" + c.contestLD : ""],
    ["🎯 Closest to the pin winner", c.contestCPWinner || "—", c.contestCP ? "hole #" + c.contestCP : ""]
  ]);

  // ---- Final standings + hole-by-hole ----
  const holeCols = Array.from({ length: holesCount() }, (_, i) => "H" + (i + 1));
  const standings = teams.map(t => ({ t, s: teamScore(t) }))
    .sort((a, b) => (a.s.rel - b.s.rel) || (b.s.played - a.s.played) || (a.t.number - b.t.number));
  sheet("Final Standings", [
    ["Rank", "Team #", "Team name", "Players", "Start hole", "Thru", "Gross", "Penalty", "Score vs par", ...holeCols.map((h, i) => `${h} (#${((startHole(standings[0]?.t || {hole:1}) - 1 + i) % pars().length) + 1})`)],
    ...standings.map((x, i) => [
      x.s.played ? i + 1 : "", x.t.number, x.t.customName || "", (x.t.players || []).map(p => p.name).join(" & "),
      x.t.hole || "", x.s.played, x.s.strokes, x.s.pen, x.s.played ? relFmt(x.s.rel) : "",
      ...Array.from({ length: holesCount() }, (_, q) => (x.t.scores || {})[q + 1] ?? "")
    ])
  ]);

  // ---- Registrations ----
  sheet("Registrations", [
    ["Type", "Players", "Handicaps", "Owner email", "Price", "Team #", "Pairing preference", "Registered"],
    ...regs.map(r => [
      r.type, (r.players || []).map(p => p.name).join(" & "),
      (r.players || []).map(p => p.handicap ?? "").join(" & "),
      r.ownerEmail || "", Number(r.price || 0),
      r.teamId && S.teams[r.teamId] ? S.teams[r.teamId].number : "",
      r.type === "individual" ? (r.preference === "partner" ? "Partner: " + (r.partnerName || "") : "Random") : "",
      (r.createdAt || "").slice(0, 16).replace("T", " ")
    ])
  ]);

  // ---- Payments (registration money) ----
  sheet("Payments", [
    ["When", "Account", "Amount", "Collector", "Note"],
    ...Object.values(S.payments).sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || ""))).map(p => [
      (p.ts || "").slice(0, 16).replace("T", " "), p.accountName || p.accountKey || "", Number(p.amount || 0), p.by || "", p.note || ""
    ])
  ]);

  // ---- Extras purchases ----
  sheet("Extras", [
    ["When", "Team #", "Team", "Bought by", "Extra", "Amt", "Price", "Free", "Paid", "Won prize #"],
    ...Object.values(S.purchases).sort((a, b) => String(a.ts).localeCompare(String(b.ts))).map(p => [
      (p.ts || "").slice(0, 16).replace("T", " "), p.teamNumber, p.teamName || "", p.byName || "",
      p.extraName, Number(p.amt || 0), Number(p.price || 0), p.free ? "FREE" : "", p.paid ? "PAID" : (p.free ? "" : "unpaid"), p.drawnPrize ?? ""
    ]),
    [],
    ["Per-team totals:"],
    ["Team #", "Team", ...extrasList().map(x => x.name + " bought"), ...extrasList().map(x => x.name + " used"), "Unpaid $"],
    ...teams.map(t => [
      t.number, t.customName || (t.players || []).map(p => p.name).join(" & "),
      ...extrasList().map(x => extraPurchased(t, x.id)),
      ...extrasList().map(x => extraUsed(t, x.id)),
      teamPurchases(t.id).filter(p => !p.paid && !p.free).reduce((a, p) => a + Number(p.price || 0), 0)
    ])
  ]);

  // ---- Prize winners ----
  sheet("Prize Winners", [
    ["Prize #", "Team #", "Team", "Winning chip", "Chip bought by", "Drawn at"],
    ...Object.values(S.draws).sort((a, b) => (a.prizeNumber || 0) - (b.prizeNumber || 0)).map(d => [
      d.prizeNumber, d.teamNumber, d.teamName || "", d.extraName || "", d.byName || "", (d.ts || "").slice(0, 16).replace("T", " ")
    ])
  ]);

  const fname = (c.eventName || "fourth-and-cold-golf").toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-event-record.xlsx";
  X.writeFile(wb, fname);
  audit("workbook_exported", fname);
  toast("Workbook downloaded 🎉");
}

function adminExtrasPaymentsHtml() {
  const all = Object.values(S.purchases);
  if (!all.length) return "";
  const byTeam = {};
  all.forEach(p => { (byTeam[p.teamId] = byTeam[p.teamId] || []).push(p); });
  const unpaidTotal = all.filter(p => !p.paid && !p.free).reduce((a, p) => a + Number(p.price || 0), 0);
  let html = `<div class="card admin-section"><div class="card-title"><span class="flag">💸</span> Extras payments
    <span class="badge ${unpaidTotal ? "badge-gold" : ""}">${unpaidTotal ? money(unpaidTotal) + " unpaid" : "all paid ✓"}</span></div>
    <p class="muted small">Cash or Venmo — either way, mark it paid here so the team sees PAID ✓.</p>`;
  Object.values(byTeam).sort((a, b) => (a[0].teamNumber || 0) - (b[0].teamNumber || 0)).forEach(list => {
    const t0 = list[0];
    const due = list.filter(p => !p.paid && !p.free).reduce((a, p) => a + Number(p.price || 0), 0);
    html += `<div class="xpay-team"><div class="xpay-head">
      <b>T${t0.teamNumber}</b> ${esc(t0.teamName || "")} — ${list.length} chip${list.length === 1 ? "" : "s"}
      ${due ? `<span class="chip chip-pen">${money(due)} due</span> <button class="btn btn-tiny btn-gold" data-xpayall="${t0.teamId}">Mark all paid</button>` : `<span class="pay-ok">PAID ✓</span>`}
    </div>`;
    list.sort((a, b) => String(a.ts).localeCompare(String(b.ts))).forEach(p => {
      html += `<div class="shop-item"><span>${p.emoji || ""} ${esc(p.extraName)}${Number(p.amt) > 1 ? " +" + p.amt : ""}${p.free ? ` <span class="chip chip-mull">FREE</span>` : ""} <span class="muted small">${esc(p.byName || "")}</span></span>
        <span class="shop-right">${p.free ? "—" : money(Number(p.price || 0))}
        ${p.free ? "" : (p.paid ? `<button class="btn btn-tiny btn-ghost" data-xpay="${p.id}|0">Unpay</button>` : `<button class="btn btn-tiny btn-gold" data-xpay="${p.id}|1">Paid</button>`)}</span></div>`;
    });
    html += `</div>`;
  });
  return html + `</div>`;
}

function adminContestWinnersHtml() {
  const c = S.config || {};
  const names = [...new Set(Object.values(S.regs).flatMap(r => (r.players || []).map(p => p.name)).filter(Boolean))].sort();
  const opt = (sel) => `<option value="">— pick winner —</option>` + names.map(n => `<option ${n === sel ? "selected" : ""}>${esc(n)}</option>`).join("");
  return `<div class="drawings-box" style="margin-top:10px"><b>🏅 Contest winners</b>
    <div class="admin-grid" style="margin-top:8px">
      <div><label class="field-label">💪 Longest drive${c.contestLD ? ` (hole #${c.contestLD})` : ""}</label><select class="field" id="winLD">${opt(c.contestLDWinner || "")}</select></div>
      <div><label class="field-label">🎯 Closest to the pin${c.contestCP ? ` (hole #${c.contestCP})` : ""}</label><select class="field" id="winCP">${opt(c.contestCPWinner || "")}</select></div>
    </div>
    <button class="btn btn-gold btn-block" id="saveContestWinners" style="margin-top:8px">Save contest winners</button>
    <p class="muted small" style="margin-top:6px">Shows on everyone's Live tab — and the winner gets a gold WINNER banner on their own phone.</p>
  </div>`;
}

async function resetDrawings() {
  try {
    const batch = writeBatch(db);
    Object.values(S.draws).forEach(d => batch.delete(doc(db, "draws", d.id)));
    Object.values(S.purchases).filter(p => p.drawnPrize != null).forEach(p => batch.update(doc(db, "extraPurchases", p.id), { drawnPrize: null }));
    await batch.commit();
    S.shownDraws = {};
    audit("drawings_reset", "all prize draws cleared by " + S.adminEmail);
    toast("Drawings reset — every chip is back in the hat, next draw is Prize 1.");
  } catch (e) { toast(e.message, true); }
}

function openPenalty(teamId) {
  const t = S.teams[teamId]; if (!t) return;
  openModal(`
    <div class="modal-title">Penalty — T${t.number}${t.customName ? " " + esc(t.customName) : ""}</div>
    <label class="field-label">Penalty strokes</label>
    <input class="field" id="mPenN" inputmode="numeric" value="2">
    <label class="field-label">Reason (shows on leaderboard tap &amp; audit)</label>
    <input class="field" id="mPenNote" value="Pace of play — scores not entered as played">
    <div class="modal-actions">
      <button class="btn btn-ghost" id="mCancel">Cancel</button>
      <button class="btn btn-danger" id="mPenGo">Assess penalty</button>
    </div>`);
  $("mCancel").addEventListener("click", closeModal);
  $("mPenGo").addEventListener("click", async () => {
    const n = parseInt($("mPenN").value);
    if (isNaN(n) || n < 1) return toast("Enter penalty strokes.", true);
    const note = $("mPenNote").value.trim();
    try {
      const pens = [...(t.penalties || []), { strokes: n, note, by: S.adminEmail, ts: nowIso() }];
      await updateDoc(doc(db, "teams", t.id), { penalties: pens });
      audit("penalty_assessed", `T${t.number}: +${n} — ${note}`);
      toast(`+${n} penalty on T${t.number}.`);
      closeModal();
    } catch (e) { toast(e.message, true); }
  });
}

async function removePenalty(teamId, idx) {
  const t = S.teams[teamId]; if (!t) return;
  const pens = [...(t.penalties || [])];
  const [gone] = pens.splice(idx, 1);
  try {
    await updateDoc(doc(db, "teams", teamId), { penalties: pens });
    audit("penalty_removed", `T${t.number}: +${gone?.strokes} — ${gone?.note}`);
    toast("Penalty removed.");
  } catch (e) { toast(e.message, true); }
}

// ---------- payments ----------
function adminPaymentsHtml() {
  const rows = Object.values(S.accounts)
    .map(a => ({ a, owed: owedFor(a.id), paid: Number(a.paidTotal || 0) }))
    .filter(x => x.owed > 0 || x.paid > 0)
    .sort((x, y) => (y.owed - y.paid) - (x.owed - x.paid));
  const totOwed = rows.reduce((n, x) => n + x.owed, 0);
  const totPaid = rows.reduce((n, x) => n + x.paid, 0);
  let html = `<div class="card admin-section"><div class="card-title"><span class="flag">💵</span> Payments</div>
    <div class="roster-count">
      <span class="chip">Billed <b>${money(totOwed)}</b></span>
      <span class="chip">Received <b>${money(totPaid)}</b></span>
      <span class="chip">Outstanding <b>${money(Math.max(0, totOwed - totPaid))}</b></span>
    </div>`;
  if (!rows.length) { html += `<p class="muted">No registrations yet.</p></div>`; return html; }
  html += `<div class="table-scroll"><table class="admin-table">
    <tr><th>Player</th><th>Owed</th><th>Paid</th><th>Due</th><th></th></tr>`;
  rows.forEach(({ a, owed, paid }) => {
    const due = Math.max(0, owed - paid);
    html += `<tr>
      <td><b>${esc(a.name)}</b><br><span class="muted small">${esc(a.email)}</span></td>
      <td>${money(owed)}</td>
      <td class="pay-ok">${money(paid)}</td>
      <td class="${due > 0 ? "pay-due" : "pay-ok"}">${due > 0 ? money(due) : "PAID ✓"}</td>
      <td><button class="btn btn-tiny btn-gold" data-logpay="${a.id}">Log</button></td>
    </tr>`;
  });
  html += `</table></div>
    <button class="btn btn-ghost btn-block" id="payCsv">⬇ Download payments CSV</button>`;
  // recent payment log
  const log = Object.values(S.payments).sort((a, b) => (b.tsLocal || "").localeCompare(a.tsLocal || "")).slice(0, 12);
  if (log.length) {
    html += `<p class="small" style="margin-top:14px;font-weight:700;color:var(--gold)">Recent payments</p>`;
    log.forEach(p => {
      html += `<div class="audit-line">${money(p.amount)} from <span class="who">${esc(p.name)}</span> → ${esc(p.collector || "?")} <span class="ts">${esc((p.tsLocal || "").slice(0, 16).replace("T", " "))}</span>
        <button class="btn btn-tiny btn-ghost" data-unpay="${p.id}" style="float:right">Undo</button></div>`;
    });
  }
  html += `</div>`;
  return html;
}

function openLogPayment(key) {
  const a = S.accounts[key];
  if (!a) return;
  const due = Math.max(0, owedFor(key) - paidFor(key));
  const collectors = venmoList();
  openModal(`
    <div class="modal-title">Log payment</div>
    <div class="modal-sub">${esc(a.name)} · owes ${money(owedFor(key))} · ${money(paidFor(key))} received</div>
    <label class="field-label">Amount received</label>
    <input class="field" id="mAmt" inputmode="decimal" value="${due > 0 ? due.toFixed(2) : ""}" placeholder="0.00">
    <label class="field-label">Collected by</label>
    <select class="field" id="mCol">
      ${collectors.map(c => `<option value="${esc(c.handle)}">@${esc(c.handle)}${c.label ? " — " + esc(c.label) : ""}</option>`).join("")}
      <option value="cash">Cash / other</option>
    </select>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="mCancel">Cancel</button>
      <button class="btn btn-gold" id="mGo">Confirm payment</button>
    </div>`);
  $("mCancel").addEventListener("click", closeModal);
  $("mGo").addEventListener("click", async () => {
    const amt = parseFloat($("mAmt").value);
    if (isNaN(amt) || amt <= 0) return toast("Enter the amount received.", true);
    try {
      await addDoc(collection(db, "payments"), {
        accountKey: key, name: a.name, email: a.email, amount: amt,
        collector: $("mCol").value, by: S.adminEmail, ts: serverTimestamp(), tsLocal: nowIso()
      });
      await updateDoc(doc(db, "accounts", key), { paidTotal: paidFor(key) + amt });
      audit("payment_logged", `${money(amt)} from ${a.name} via ${$("mCol").value}`);
      toast(`Logged ${money(amt)} from ${a.name.split(" ")[0]}.`);
      closeModal();
    } catch (e) { toast("Couldn't log: " + e.message, true); }
  });
}

async function undoPayment(id) {
  const p = S.payments[id];
  if (!p) return;
  try {
    await deleteDoc(doc(db, "payments", id));
    const cur = paidFor(p.accountKey);
    await updateDoc(doc(db, "accounts", p.accountKey), { paidTotal: Math.max(0, cur - Number(p.amount || 0)) });
    audit("payment_undone", `${money(p.amount)} from ${p.name}`);
    toast("Payment undone.");
  } catch (e) { toast(e.message, true); }
}

function downloadPaymentsCsv() {
  const rows = [["Name", "Email", "Registrations", "Owed", "Received", "Due", "Status"]];
  Object.values(S.accounts).forEach(a => {
    const owed = owedFor(a.id), paid = Number(a.paidTotal || 0);
    if (owed <= 0 && paid <= 0) return;
    const nRegs = Object.values(S.regs).filter(r => r.ownerKey === a.id).length;
    rows.push([a.name, a.email, nRegs, owed.toFixed(2), paid.toFixed(2), Math.max(0, owed - paid).toFixed(2), owed - paid <= 0 ? "PAID" : "DUE"]);
  });
  rows.push([]);
  rows.push(["Payment log"]);
  rows.push(["When", "Name", "Email", "Amount", "Collector", "Logged by"]);
  Object.values(S.payments).sort((a, b) => (a.tsLocal || "").localeCompare(b.tsLocal || "")).forEach(p => {
    rows.push([p.tsLocal, p.name, p.email, Number(p.amount).toFixed(2), p.collector, p.by]);
  });
  downloadFile(csv(rows), `golf-payments-${nowIso().slice(0, 10)}.csv`, "text/csv");
}

// ---------- settings (full admin) ----------
function adminSettingsHtml() {
  const c = S.config;
  return `<div class="card admin-section"><div class="card-title"><span class="flag">⚙️</span> Event settings <span class="badge badge-gold">Full admin</span></div>
    <div class="toggle-row">
      <div><b>Registration closed</b><br><span class="muted small">Manually stop new sign-ups.</span></div>
      <label class="switch"><input type="checkbox" id="setClosed" ${c.registrationClosed ? "checked" : ""}><span class="slider"></span></label>
    </div>
    <div class="admin-grid" style="margin-top:12px">
      <div><label class="field-label">Event name</label><input class="field" id="setName" value="${esc(c.eventName)}"></div>
      <div><label class="field-label">Format line</label><input class="field" id="setFormat" value="${esc(c.formatLine)}"></div>
      <div><label class="field-label">Event date</label><input class="field" id="setDate" value="${esc(c.eventDate)}" placeholder="Saturday, Oct 10"></div>
      <div><label class="field-label">Start time</label><input class="field" id="setTime" value="${esc(c.eventTime)}" placeholder="8:00 AM shotgun"></div>
      <div><label class="field-label">Individual price</label><input class="field" id="setIndiv" inputmode="decimal" value="${c.indivPrice}"></div>
      <div><label class="field-label">Team price</label><input class="field" id="setTeam" inputmode="decimal" value="${c.teamPrice}"></div>
      <div><label class="field-label">Max players (0 = unlimited)</label><input class="field" id="setMax" inputmode="numeric" value="${c.maxPlayers || 0}"></div>
      <div><label class="field-label">Venue phone</label><input class="field" id="setPhone" value="${esc(c.venuePhone)}"></div>
      <div><label class="field-label">Holes each team plays</label><input class="field" id="setHoles" inputmode="numeric" value="${c.holesCount || 18}"></div>
      <div><label class="field-label">Pace flag — holes behind</label><input class="field" id="setPace" inputmode="numeric" value="${c.paceThreshold || 3}"></div>
    </div>
    <label class="field-label">📜 Tournament rules — pop up for everyone when scoring goes live; Rules button after that</label>
    <textarea class="field" id="setRules" rows="5" placeholder="1. Scramble format — both players tee off...\n2. ...">${esc(c.rulesText || "")}</textarea>
    <div class="admin-grid" style="margin-top:12px">
      <div><label class="field-label">Extras purchase mode</label>
        <select class="field" id="setExtrasMode">
          <option value="select" ${(c.extrasMode || "select") === "select" ? "selected" : ""}>Individual selection</option>
          <option value="draw" ${c.extrasMode === "draw" ? "selected" : ""}>Random drawing</option>
        </select></div>
      <div><label class="field-label">Price per random draw</label><input class="field" id="setDrawPrice" inputmode="decimal" value="${c.drawPrice ?? 10}"></div>
      <div><label class="field-label">Deal: buy N (0 = off)</label><input class="field" id="setDealBuy" inputmode="numeric" value="${c.dealBuy || 0}"></div>
      <div><label class="field-label">…get M free draws</label><input class="field" id="setDealFree" inputmode="numeric" value="${c.dealFree || 0}"></div>
      <div><label class="field-label">Wheel spin seconds</label><input class="field" id="setSpin" inputmode="numeric" value="${c.spinSeconds ?? 10}"></div>
    </div>
    <label class="field-label">Day-of extras — one per line: emoji | name | price | unit | max per team | note<br><span class="muted small" style="font-weight:400">unit "each" = countable (mulligans, drops); "ft" etc = amount used per go (putt string). Delete a line to turn it off; empty box turns extras off.</span></label>
    <textarea class="field" id="setExtras" rows="3" placeholder="empty = no extras">${esc(c.extrasLines || "")}</textarea>
    <div class="samples-box">
      <p class="small" style="font-weight:700;margin:0 0 6px">Sample ideas — tap ＋ to add:</p>
      ${SAMPLE_EXTRAS.map((s, i) => `<div class="sample-line"><button class="btn btn-tiny btn-ghost" data-addsample="${i}">＋</button><code>${esc(s)}</code></div>`).join("")}
    </div>
    <div class="admin-grid" style="margin-top:12px">
      <div><label class="field-label">💪 Long drive contest — course hole</label>
        <select class="field" id="setLD">${contestHoleOptions(c.contestLD)}</select></div>
      <div><label class="field-label">🎯 Closest to the pin — course hole</label>
        <select class="field" id="setCP">${contestHoleOptions(c.contestCP)}</select></div>
    </div>
    <label class="field-label">Course pars — comma-separated, one per physical hole (Mustang Creek: 9 holes)</label>
    <input class="field" id="setPars" value="${esc((c.parByHole || []).join(", "))}">
    <label class="field-label">Venue name</label><input class="field" id="setVenue" value="${esc(c.venueName)}">
    <label class="field-label">Venue address</label><input class="field" id="setAddr" value="${esc(c.venueAddress)}">
    <label class="field-label">Welcome blurb</label><input class="field" id="setWelcome" value="${esc(c.welcome)}">
    <label class="field-label">Venmo collectors — one per line: handle | label</label>
    <textarea class="field" id="setVenmo" rows="3">${esc(c.venmoLines)}</textarea>
    <label class="field-label">Full admins — emails, one per line</label>
    <textarea class="field" id="setFull" rows="2">${esc((c.fullAdmins || []).join("\n"))}</textarea>
    <label class="field-label">Financial admins — emails, one per line</label>
    <textarea class="field" id="setFin" rows="2">${esc((c.finAdmins || []).join("\n"))}</textarea>
    <p class="muted small" style="margin-top:6px">${esc(BOOTSTRAP_FULL_ADMIN)} is hard-coded as full admin and can never be locked out.</p>
    <button class="btn btn-primary btn-block" id="saveSettings">Save settings</button>
  </div>`;
}

async function saveSettings() {
  const c = S.config || {};
  const emails = (t) => t.split("\n").map(cleanEmail).filter(validEmail);
  const upd = {
    registrationClosed: $("setClosed").checked,
    eventName: $("setName").value.trim() || "Fourth and Cold Golf Open",
    formatLine: $("setFormat").value.trim(),
    eventDate: $("setDate").value.trim(),
    eventTime: $("setTime").value.trim(),
    indivPrice: parseFloat($("setIndiv").value) || 150,
    teamPrice: parseFloat($("setTeam").value) || 300,
    maxPlayers: Math.max(0, parseInt($("setMax").value) || 0),
    venuePhone: $("setPhone").value.trim(),
    venueName: $("setVenue").value.trim(),
    venueAddress: $("setAddr").value.trim(),
    welcome: $("setWelcome").value.trim(),
    venmoLines: $("setVenmo").value,
    holesCount: Math.max(1, parseInt($("setHoles").value) || 18),
    paceThreshold: Math.max(1, parseInt($("setPace").value) || 3),
    extrasLines: $("setExtras").value,
    rulesText: $("setRules").value,
    rulesVersion: ($("setRules").value.trim() !== (c.rulesText || "").trim()) ? nowIso() : (c.rulesVersion || ""),
    extrasMode: $("setExtrasMode").value,
    drawPrice: parseFloat($("setDrawPrice").value) || 10,
    dealBuy: parseInt($("setDealBuy").value) || 0,
    dealFree: parseInt($("setDealFree").value) || 0,
    spinSeconds: Math.max(3, parseInt($("setSpin").value) || 10),
    contestLD: parseInt($("setLD").value) || 0,
    contestCP: parseInt($("setCP").value) || 0,
    parByHole: (() => {
      const p = $("setPars").value.split(",").map(x => parseInt(x.trim())).filter(x => x >= 3 && x <= 6);
      return p.length ? p : [4, 4, 3, 3, 5, 3, 5, 4, 4];
    })(),
    fullAdmins: Array.from(new Set([BOOTSTRAP_FULL_ADMIN, ...emails($("setFull").value)])),
    finAdmins: emails($("setFin").value),
    updatedAt: nowIso()
  };
  try {
    await updateDoc(doc(db, "config", "current"), upd);
    audit("settings_saved", `by ${S.adminEmail}`);
    toast("Settings saved.");
  } catch (e) { toast(e.message, true); }
}

// ---------- danger zone (full admin) ----------
function adminDangerHtml() {
  return `<div class="card admin-section"><div class="card-title"><span class="flag">🗄️</span> Backup &amp; reset <span class="badge badge-gold">Full admin</span></div>
    <button class="btn btn-gold btn-block" id="exportXlsxBtn" style="margin-bottom:10px">📊 Download event workbook (.xlsx) — full record</button>
    <div class="add-row">
      <button class="btn btn-ghost" id="dlBackup">⬇ Download backup (JSON + CSV)</button>
      <button class="btn btn-ghost" id="cloudArchive">☁ Save cloud archive</button>
    </div>
    <div class="add-row">
      <button class="btn btn-ghost" id="restoreFile">⤴ Restore from file</button>
      <button class="btn btn-danger" id="resetAll">⚠ Reset event</button>
    </div>
    <input type="file" id="restoreInput" accept=".json" class="hidden">
    <p class="muted small" style="margin-top:8px">Reset clears registrations, teams, and payments — a backup downloads automatically first. Settings and admins are kept.</p>
  </div>`;
}

function buildBackup() {
  return {
    kind: "fcgolf-backup", version: 1, exportedAt: nowIso(),
    config: S.config, accounts: S.accounts, registrations: S.regs, teams: S.teams, payments: S.payments
  };
}
function backupCsv() {
  const rows = [["Type", "Team #", "Hole", "Player", "Handicap", "Pairing", "Registered by", "Email", "Price", "Created"]];
  Object.values(S.regs).forEach(r => {
    const t = r.teamId ? S.teams[r.teamId] : null;
    (r.players || []).forEach(p => {
      rows.push([r.type, t?.number ?? "", t?.hole ?? "", p.name, p.handicap ?? "",
        r.type === "individual" ? (r.teamId ? "paired" : (r.preference === "partner" ? "partner: " + r.partnerName : "random")) : "team entry",
        r.ownerName, r.ownerEmail, Number(r.price).toFixed(2), r.createdAt]);
    });
  });
  return csv(rows);
}
async function downloadBackup() {
  const stamp = nowIso().slice(0, 19).replace(/[:T]/g, "-");
  downloadFile(JSON.stringify(buildBackup(), null, 2), `golf-backup-${stamp}.json`, "application/json");
  downloadFile(backupCsv(), `golf-roster-${stamp}.csv`, "text/csv");
  toast("Backup downloaded (JSON + CSV).");
}
async function cloudArchive() {
  try {
    await addDoc(collection(db, "archives"), { ...buildBackup(), by: S.adminEmail });
    audit("cloud_archive_saved", `by ${S.adminEmail}`);
    toast("Cloud archive saved.");
  } catch (e) { toast(e.message, true); }
}
async function restoreFromFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.kind !== "fcgolf-backup") throw new Error("Not a golf backup file.");
    openModal(`
      <div class="modal-title">Restore backup?</div>
      <p style="margin-top:8px">From ${esc(data.exportedAt || "?")}. This overwrites current registrations, teams, accounts, and payments.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="mCancel">Cancel</button>
        <button class="btn btn-danger" id="mGo">Restore</button>
      </div>`);
    $("mCancel").addEventListener("click", closeModal);
    $("mGo").addEventListener("click", async () => {
      try {
        await wipeCollections(["registrations", "teams", "payments"]);
        const batchWrite = async (col, obj) => {
          for (const [id, val] of Object.entries(obj || {})) {
            const { id: _drop, ...rest } = val;
            await setDoc(doc(db, col, id), rest);
          }
        };
        await batchWrite("accounts", data.accounts);
        await batchWrite("registrations", data.registrations);
        await batchWrite("teams", data.teams);
        await batchWrite("payments", data.payments);
        if (data.config) await setDoc(doc(db, "config", "current"), data.config);
        audit("restore_completed", `from file dated ${data.exportedAt}`);
        toast("Restore complete.");
        closeModal();
      } catch (e) { toast(e.message, true); }
    });
  } catch (e) { toast("Couldn't read that file: " + e.message, true); }
}
async function wipeCollections(cols) {
  for (const col of cols) {
    const qs = await getDocs(collection(db, col));
    let batch = writeBatch(db), n = 0;
    for (const d of qs.docs) {
      batch.delete(d.ref);
      if (++n === 400) { await batch.commit(); batch = writeBatch(db); n = 0; }
    }
    if (n) await batch.commit();
  }
}
function confirmReset() {
  openModal(`
    <div class="modal-title">Reset event?</div>
    <p style="margin-top:8px">Clears <b>all registrations, teams, and payments</b>, and zeroes balances. A backup downloads automatically first. Settings and admins are kept.</p>
    <label class="field-label">Type RESET to confirm</label>
    <input class="field" id="mConfirm" autocomplete="off">
    <div class="modal-actions">
      <button class="btn btn-ghost" id="mCancel">Cancel</button>
      <button class="btn btn-danger" id="mGo">Reset everything</button>
    </div>`);
  $("mCancel").addEventListener("click", closeModal);
  $("mGo").addEventListener("click", async () => {
    if ($("mConfirm").value.trim().toUpperCase() !== "RESET") return toast("Type RESET to confirm.", true);
    try {
      await downloadBackup();
      await cloudArchive().catch(() => {});
      await wipeCollections(["registrations", "teams", "payments"]);
      const qs = await getDocs(collection(db, "accounts"));
      for (const d of qs.docs) await updateDoc(d.ref, { paidTotal: 0 }).catch(() => {});
      await setDoc(doc(db, "config", "counters"), { teamSeq: 0 });
      audit("event_reset", `by ${S.adminEmail}`);
      toast("Event reset. Fresh start.");
      closeModal();
    } catch (e) { toast(e.message, true); }
  });
}

// ---------- audit (full admin) ----------
function adminAuditHtml() {
  let html = `<div class="card admin-section"><div class="card-title"><span class="flag">📜</span> Audit trail <span class="badge badge-gold">Full admin</span></div>`;
  if (!S.audit.length) html += `<p class="muted">Nothing logged yet.</p>`;
  S.audit.forEach(a => {
    html += `<div class="audit-line"><span class="who">${esc(a.actor)}</span> — ${esc(a.action.replace(/_/g, " "))}${a.detail ? ": " + esc(a.detail) : ""} <span class="ts">${esc((a.tsLocal || "").slice(0, 16).replace("T", " "))}</span></div>`;
  });
  html += `</div>`;
  return html;
}

// ---------- wire up admin ----------
function wireAdmin() {
  document.querySelectorAll("[data-sel]").forEach(el => el.addEventListener("click", () => {
    const id = el.dataset.sel;
    if (S.pairSel.includes(id)) S.pairSel = S.pairSel.filter(x => x !== id);
    else { S.pairSel.push(id); if (S.pairSel.length > 2) S.pairSel.shift(); }
    renderAdmin();
  }));
  $("pairSelected")?.addEventListener("click", async () => {
    if (S.pairSel.length !== 2) return;
    try {
      const names = S.pairSel.map(id => S.regs[id]?.players?.[0]?.name).join(" & ");
      await pairRegs(S.pairSel[0], S.pairSel[1], "paired");
      audit("team_paired", names);
      toast(`Paired: ${names}`);
      S.pairSel = [];
    } catch (e) { toast(e.message, true); }
  });
  document.querySelectorAll("[data-pair]").forEach(b => b.addEventListener("click", async () => {
    const [a, bId] = b.dataset.pair.split("|");
    try {
      const names = [a, bId].map(id => S.regs[id]?.players?.[0]?.name).join(" & ");
      await pairRegs(a, bId, "requested");
      audit("team_paired", names + " (requested partners)");
      toast(`Paired: ${names}`);
    } catch (e) { toast(e.message, true); }
  }));
  $("assignTeams")?.addEventListener("click", confirmAutoAssign);
  document.querySelectorAll("[data-hole]").forEach(sel => sel.addEventListener("change", async () => {
    try {
      await updateDoc(doc(db, "teams", sel.dataset.hole), { hole: sel.value });
      const t = S.teams[sel.dataset.hole];
      audit("hole_assigned", `Team ${t?.number} → ${sel.value || "cleared"}`);
      toast(sel.value ? `Team ${t?.number} → Hole ${sel.value}` : "Hole cleared.");
    } catch (e) { toast(e.message, true); }
  }));
  document.querySelectorAll("[data-split]").forEach(b => b.addEventListener("click", async () => {
    const t = S.teams[b.dataset.split];
    if (!t) return;
    try {
      for (const rid of (t.regIds || [])) {
        if (S.regs[rid]) await updateDoc(doc(db, "registrations", rid), { teamId: null, updatedAt: nowIso() });
      }
      await deleteDoc(doc(db, "teams", t.id));
      audit("team_split", `Team ${t.number} (${(t.players || []).map(p => p.name).join(" & ")})`);
      toast(`Team ${t.number} split — both players are back in the pairing pool.`);
    } catch (e) { toast(e.message, true); }
  }));
  $("drawPrizeBtn")?.addEventListener("click", () => {
    const nxt = Object.values(S.draws).reduce((m, d) => Math.max(m, Number(d.prizeNumber || 0)), 0) + 1;
    openModal(`<div class="modal-title">🎡 Draw for prize ${nxt}?</div>
      <p class="muted small">${eligibleChips(null).length} chips eligible. Every open phone gets the live wheel.</p>
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button>
      <button class="btn btn-gold" id="mGo">Spin it</button></div>`);
    $("mCancel").addEventListener("click", closeModal);
    $("mGo").addEventListener("click", () => { closeModal(); adminDrawPrize(); });
  });
  $("testWheelBtn")?.addEventListener("click", testWheel);
  $("exportXlsxBtn")?.addEventListener("click", exportWorkbook);
  document.querySelectorAll("[data-xpay]").forEach(b => b.addEventListener("click", async () => {
    const [pid, to] = b.dataset.xpay.split("|");
    try {
      await updateDoc(doc(db, "extraPurchases", pid), { paid: to === "1" });
      audit(to === "1" ? "extras_paid" : "extras_unpaid", `purchase ${pid} by ${S.adminEmail}`);
      toast(to === "1" ? "Marked paid ✓" : "Marked unpaid.");
    } catch (e) { toast(e.message, true); }
  }));
  document.querySelectorAll("[data-xpayall]").forEach(b => b.addEventListener("click", async () => {
    try {
      const batch = writeBatch(db);
      Object.values(S.purchases).filter(p => p.teamId === b.dataset.xpayall && !p.paid && !p.free)
        .forEach(p => batch.update(doc(db, "extraPurchases", p.id), { paid: true }));
      await batch.commit();
      audit("extras_paid_all", `T? team ${b.dataset.xpayall} by ${S.adminEmail}`);
      toast("Team marked paid ✓");
    } catch (e) { toast(e.message, true); }
  }));
  $("resetDrawsBtn")?.addEventListener("click", () => {
    openModal(`<div class="modal-title">Reset all prize drawings?</div>
      <p class="muted small">Deletes every winner and puts all chips back in the hat. Next draw becomes Prize 1.</p>
      <div class="modal-actions"><button class="btn btn-ghost" id="mCancel">Cancel</button>
      <button class="btn btn-danger" id="mGo">Reset drawings</button></div>`);
    $("mCancel").addEventListener("click", closeModal);
    $("mGo").addEventListener("click", () => { closeModal(); resetDrawings(); });
  });
  $("saveContestWinners")?.addEventListener("click", async () => {
    try {
      await updateDoc(doc(db, "config", "current"), {
        contestLDWinner: $("winLD").value || "",
        contestCPWinner: $("winCP").value || "",
        updatedAt: nowIso()
      });
      audit("contest_winners_set", `LD: ${$("winLD").value || "—"} · CP: ${$("winCP").value || "—"}`);
      toast("Contest winners saved — they're live for everyone.");
    } catch (e) { toast(e.message, true); }
  });
  $("setScoringTest")?.addEventListener("change", async (e) => {
    try {
      if (!e.target.checked) {
        // turning OFF: reset all scoring data
        const batch = writeBatch(db);
        Object.values(S.teams).forEach(t => batch.update(doc(db, "teams", t.id), {
          scores: {}, scoreTimes: {}, extraUses: [], lastScoreAt: null, lastScoreBy: null
        }));
        Object.values(S.draws).forEach(d => batch.delete(doc(db, "draws", d.id)));
        Object.values(S.purchases).filter(p => p.drawnPrize != null).forEach(p => batch.update(doc(db, "extraPurchases", p.id), { drawnPrize: null }));
        await batch.commit();
        S.shownDraws = {};
        await updateDoc(doc(db, "config", "current"), { scoringTest: false, updatedAt: nowIso() });
        audit("scoring_test_off", "test data reset");
        toast("Test mode off — test scores and prize drawings wiped clean (next draw = Prize 1).");
        const testBuys = Object.values(S.purchases).length;
        if (testBuys) toast(`Heads up: ${testBuys} extras purchase(s) exist — undo any test ones in the shop or Extras modal.`, true);
      } else {
        await updateDoc(doc(db, "config", "current"), { scoringTest: true, updatedAt: nowIso() });
        audit("scoring_test_on", "by " + S.adminEmail);
        toast("🧪 Test mode ON — only admins see live scoring.");
      }
    } catch (err) { toast(err.message, true); }
  });
  $("setScoring")?.addEventListener("change", async (e) => {
    try {
      await updateDoc(doc(db, "config", "current"), { scoringOpen: e.target.checked, updatedAt: nowIso() });
      audit(e.target.checked ? "scoring_opened" : "scoring_closed", "by " + S.adminEmail);
      toast(e.target.checked ? "Scoring is LIVE." : "Scoring closed.");
    } catch (err) { toast(err.message, true); }
  });
  document.querySelectorAll("[data-extras]").forEach(b => b.addEventListener("click", () => openExtrasModal(b.dataset.extras)));
  document.querySelectorAll("[data-addsample]").forEach(b => b.addEventListener("click", () => {
    const ta = $("setExtras");
    const line = SAMPLE_EXTRAS[Number(b.dataset.addsample)];
    if (ta.value.includes(line.split("|")[1].trim())) return toast("Already in the box.", true);
    ta.value = (ta.value.trim() ? ta.value.trim() + "\n" : "") + line;
    toast("Added — hit Save settings to make it live.");
  }));
  document.querySelectorAll("[data-penalty]").forEach(b => b.addEventListener("click", () => openPenalty(b.dataset.penalty)));
  document.querySelectorAll("[data-unpen]").forEach(b => b.addEventListener("click", () => {
    const [id, i] = b.dataset.unpen.split("|");
    removePenalty(id, Number(i));
  }));
  document.querySelectorAll("[data-logpay]").forEach(b => b.addEventListener("click", () => openLogPayment(b.dataset.logpay)));
  document.querySelectorAll("[data-unpay]").forEach(b => b.addEventListener("click", () => undoPayment(b.dataset.unpay)));
  $("payCsv")?.addEventListener("click", downloadPaymentsCsv);
  $("saveSettings")?.addEventListener("click", saveSettings);
  $("dlBackup")?.addEventListener("click", downloadBackup);
  $("cloudArchive")?.addEventListener("click", cloudArchive);
  $("resetAll")?.addEventListener("click", confirmReset);
  $("restoreFile")?.addEventListener("click", () => $("restoreInput").click());
  $("restoreInput")?.addEventListener("change", (e) => { if (e.target.files[0]) restoreFromFile(e.target.files[0]); e.target.value = ""; });
}

// admin bootstrap: if a full-admin-capable email signs in and no config exists, create it
onAuthStateChanged(auth, async (user) => {
  if (user?.email && !S.config) {
    try { await ensureConfig(); } catch (e) { /* rules may block non-first users; fine */ }
  }
});

// ------------------------------------------------ file utils
function csv(rows) {
  return rows.map(r => r.map(v => {
    v = String(v ?? "");
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }).join(",")).join("\n");
}
function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}
