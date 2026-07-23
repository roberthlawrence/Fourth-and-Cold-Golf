// =====================================================================
// 4th & Cold Golf Classic — registration app
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
  audit: [],           // recent audit lines (full admin only)
  activeTab: "register",
  pairSel: [],         // selected reg ids in pairing tool
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
    eventName: "4th & Cold Golf Classic",
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
  if (S.activeTab === "admin")    renderAdmin();
}

function renderBanner() {
  const b = $("statusBanner");
  const max = Number(S.config.maxPlayers || 0);
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
      html += `<tr><td><span class="tee">${t.number}</span></td><td>${ps}</td>${anyHoles ? `<td>${t.hole ? `<span class="hole-chip">${esc(t.hole)}</span>` : ""}</td>` : ""}</tr>`;
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
  for (let h = 1; h <= 18; h++) for (const s of ["A", "B"]) {
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
    </div>
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
  const emails = (t) => t.split("\n").map(cleanEmail).filter(validEmail);
  const upd = {
    registrationClosed: $("setClosed").checked,
    eventName: $("setName").value.trim() || "4th & Cold Golf Classic",
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
