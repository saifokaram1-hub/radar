/* Crypto Gambling Radar — Frontend (Vanilla JS + Supabase REST) */

const SUPABASE_URL = "https://abeheiewozqbkylmgrqr.supabase.co";
const SUPABASE_KEY = "sb_publishable_OysS4ElWHUiZNcC5aVdt8g__8LkRzh4";
const TABLE = "casinos";
const PAGE_SIZE = 50;

const API = `${SUPABASE_URL}/rest/v1/${TABLE}`;
const HEADERS = { apikey: SUPABASE_KEY, "Content-Type": "application/json" };

const state = {
  page: 0, total: 0, search: "",
  sort: "bekanntheits_score.desc.nullslast",
  filters: {},
  scoreExtra: [],    // vom Bekanntheit-Dropdown: [spalte, "op.wert"]
  wunschExtra: [],   // von der Wunsch-Suche: [spalte, "op.wert"]
  wunschGroups: [],  // von der Wunsch-Suche: PostgREST or(...)-Gruppen
  advanced: {},      // erweiterte Filter: { spalte: { text, status } }
  trackerStep: "",   // Account-Tracker-Filter: Schritt-Schlüssel
  revMin: "",        // Revshare-%-Filter ab
  revMax: "",        // Revshare-%-Filter bis
};
let currentRecord = null;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- Query-Aufbau ---------- */
function buildFilterParams() {
  const p = new URLSearchParams();
  for (const [col, val] of Object.entries(state.filters)) {
    if (val) p.append(col, `eq.${val}`);
  }
  for (const [col, cond] of [...state.scoreExtra, ...state.wunschExtra]) p.append(col, cond);

  // Erweiterte Filter: Textsuche + Ausgefüllt/Leer je Kategorie
  for (const [col, f] of Object.entries(state.advanced)) {
    const t = (f.text || "").replace(/[,()*]/g, " ").trim();
    if (t) p.append(col, `ilike.*${t}*`);
    if (f.status === "ausgefuellt") p.append(col, "not.is.null");
    if (f.status === "leer") p.append(col, "is.null");
    if (f.status === "nichtvorhanden") p.append(col, "eq.Nicht vorhanden");
  }
  if (state.trackerStep) p.append(`tracker->>${state.trackerStep}`, "eq.true");
  if (state.revMin !== null && state.revMin !== "") p.append("revshare_wert", `gte.${state.revMin}`);
  if (state.revMax !== null && state.revMax !== "") p.append("revshare_wert", `lte.${state.revMax}`);

  const groups = [...state.wunschGroups];
  const q = state.search.trim().replace(/[,()*]/g, " ").trim();
  if (q) groups.push(`or(title.ilike.*${q}*,website.ilike.*${q}*,notizen.ilike.*${q}*,eigenschaften_text.ilike.*${q}*)`);
  if (groups.length) p.append("and", `(${groups.join(",")})`);
  return p;
}

/* ---------- Daten laden ---------- */
async function loadPage() {
  const p = buildFilterParams();
  p.append("select", "*");
  p.append("order", state.sort);
  p.append("limit", PAGE_SIZE);
  p.append("offset", state.page * PAGE_SIZE);

  $("#results-meta").textContent = "Lade Daten …";
  try {
    const res = await fetch(`${API}?${p}`, { headers: { ...HEADERS, Prefer: "count=exact" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rows = await res.json();
    const range = res.headers.get("content-range"); // z.B. "0-49/11886"
    state.total = range ? parseInt(range.split("/")[1], 10) || 0 : rows.length;
    renderRows(rows);
    renderMeta();
  } catch (e) {
    $("#results-meta").textContent = "Fehler beim Laden: " + e.message;
  }
}

async function countWhere(params) {
  const res = await fetch(`${API}?${params}&select=id&limit=1`, {
    method: "HEAD",
    headers: { ...HEADERS, Prefer: "count=exact" },
  });
  const range = res.headers.get("content-range");
  return range ? parseInt(range.split("/")[1], 10) || 0 : 0;
}

async function loadStats() {
  try {
    const [total, nonkyc, sport, fertig] = await Promise.all([
      countWhere(new URLSearchParams()),
      countWhere(new URLSearchParams({ kyc: "eq.Non-KYC" })),
      countWhere(new URLSearchParams({ sportwetten: "eq.Ja" })),
      countWhere(new URLSearchParams({ recherche_status: "eq.Fertig" })),
    ]);
    $("#stat-total").textContent = total.toLocaleString("de-AT");
    $("#stat-nonkyc").textContent = nonkyc.toLocaleString("de-AT");
    $("#stat-sport").textContent = sport.toLocaleString("de-AT");
    $("#stat-fertig").textContent = fertig.toLocaleString("de-AT");
  } catch { /* Statistiken sind nicht kritisch */ }
}

/* ---------- Rendering ---------- */
function scoreBadge(v) {
  if (v == null) return '<span class="badge neutral">–</span>';
  const cls = v >= 80 ? "score-high" : v >= 50 ? "score-mid" : "score-low";
  return `<span class="badge ${cls}">${v}</span>`;
}
function kycBadge(v) {
  if (v === "Non-KYC") return '<span class="badge kyc-non">Non-KYC</span>';
  if (v === "KYC") return '<span class="badge kyc-yes">KYC</span>';
  return '<span class="badge neutral">Unbekannt</span>';
}
function yesNoBadge(v) {
  if (v === "Ja") return '<span class="badge yes">Ja</span>';
  if (v === "Nein") return '<span class="badge neutral">Nein</span>';
  return '<span class="badge neutral">?</span>';
}
function statusBadge(v) {
  if (v === "Fertig") return '<span class="badge status-fertig">Fertig</span>';
  if (v === "In Arbeit") return '<span class="badge status-arbeit">In Arbeit</span>';
  return '<span class="badge neutral">Offen</span>';
}

function renderRows(rows) {
  const tbody = $("#tbody");
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-dim);padding:30px">Keine Treffer.</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map(
      (r) => `<tr data-id="${r.id}">
        <td class="title-cell" title="${esc(r.title)}">${esc(r.title)}</td>
        <td>${r.website ? `<span class="website">${esc(r.website)}</span>` : '<span style="color:var(--text-dim)">–</span>'}</td>
        <td>${scoreBadge(r.bekanntheits_score)}</td>
        <td>${kycBadge(r.kyc)}</td>
        <td>${yesNoBadge(r.sportwetten)}</td>
        <td>${yesNoBadge(r.affiliate)}</td>
        <td>${statusBadge(r.recherche_status)}</td>
        <td>${r.views != null ? r.views.toLocaleString("de-AT") : "–"}</td>
        <td><a class="thread-link" href="${esc(r.thread_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Öffnen ↗</a></td>
      </tr>`
    )
    .join("");
  tbody.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => openDrawer(rows.find((r) => r.id === tr.dataset.id)));
  });
}

function renderMeta() {
  const from = state.page * PAGE_SIZE + 1;
  const to = Math.min((state.page + 1) * PAGE_SIZE, state.total);
  $("#results-meta").textContent = state.total
    ? `${state.total.toLocaleString("de-AT")} Einträge · zeige ${from.toLocaleString("de-AT")}–${to.toLocaleString("de-AT")}`
    : "Keine Einträge gefunden.";
  const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  $("#page-info").textContent = `Seite ${state.page + 1} von ${pages.toLocaleString("de-AT")}`;
  $("#prev").disabled = state.page === 0;
  $("#next").disabled = state.page + 1 >= pages;
}

/* ---------- Detail-Drawer ---------- */
const SELECT_JNU = ["Ja", "Nein", "Unbekannt", "Nicht vorhanden"];
const SECTIONS = [
  { title: "Allgemein", fields: [
    { col: "website", label: "Website", type: "text" },
    { col: "website_status", label: "Website-Status", type: "select", options: ["", "Online", "Offline"] },
    { col: "spieler_zahlen", label: "Spieler-Zahlen", type: "text" },
    { col: "lizenz", label: "Lizenz / Standort", type: "text" },
  ]},
  { title: "Verfügbarkeit", fields: [
    { col: "verfuegbar_at", label: "Verfügbar in Österreich", type: "select", options: SELECT_JNU },
    { col: "verfuegbar_de", label: "Verfügbar in Deutschland", type: "select", options: SELECT_JNU },
  ]},
  { title: "Kette", fields: [
    { col: "kette", label: "Teil einer Kette?", type: "select", options: SELECT_JNU },
    { col: "kette_firma", label: "Firma / Muttergesellschaft", type: "text" },
  ]},
  { title: "KYC & Zahlungen", fields: [
    { col: "kyc", label: "KYC-Status", type: "select", options: ["KYC", "Non-KYC", "Unbekannt", "Nicht vorhanden"] },
    { col: "kyc_details", label: "Was für KYC?", type: "textarea", full: true },
    { col: "zahlungsmoeglichkeiten", label: "Einzahlungen (Crypto)", type: "text", full: true },
    { col: "allgemeines_angebot", label: "Allgemeines Angebot", type: "textarea", full: true },
  ]},
  { title: "Sportwetten", fields: [
    { col: "sportwetten", label: "Sportwetten?", type: "select", options: SELECT_JNU },
    { col: "sportwetten_bericht", label: "Bericht zum Sportwetten-Angebot", type: "textarea", full: true },
  ]},
  { title: "Registrierung & Auszahlung", fields: [
    { col: "registrierung_aufwand", label: "Aufwand Registrierung", type: "text", full: true },
    { col: "auszahlung_methoden", label: "Auszahlungsmöglichkeiten (Crypto)", type: "text", full: true },
    { col: "auszahlung_dauer", label: "Dauer der Auszahlung", type: "text" },
    { col: "kunden_bewertungen", label: "Kunden-Bewertungen", type: "textarea", full: true },
  ]},
  { title: "Affiliate-Programm", fields: [
    { col: "affiliate", label: "Affiliate-Angebot?", type: "select", options: SELECT_JNU },
    { col: "cpa", label: "CPA-Angebot?", type: "select", options: SELECT_JNU },
    { col: "cpa_hoehe", label: "Höhe CPA", type: "text" },
    { col: "revshare_prozent", label: "Revshare %", type: "text" },
    { col: "affiliate_auszahlung_dauer", label: "Auszahlungsdauer Provision", type: "text" },
    { col: "affiliate_bewertungen", label: "Bewertungen Affiliate-Programm", type: "textarea", full: true },
    { col: "affiliate_kontakt", label: "Kontaktdaten (Affiliate-Partnerschaft)", type: "textarea", full: true },
  ]},
  { title: "Recherche & Notizen", fields: [
    { col: "recherche_status", label: "Recherche-Status", type: "select", options: ["Offen", "In Arbeit", "Fertig"] },
    { col: "notizen", label: "Notizen", type: "textarea", full: true },
  ]},
];

/* ---------- Account-Tracker ---------- */
const TRACKER_STEPS = [
  ["account", "Account erstellt"],
  ["einzahlung", "Einzahlung getestet"],
  ["auszahlung", "Auszahlung getestet"],
  ["affiliate_beantragt", "Affiliate-Programm beantragt"],
  ["affiliate_aktiv", "Affiliate aktiv / Provision läuft"],
];

/* ---------- Erweiterte Filter: alle Kategorien ---------- */
const ADV_FIELDS = [
  ["website", "Website"],
  ["kette_firma", "Kette / Firma"],
  ["spieler_zahlen", "Spieler-Zahlen"],
  ["kyc_details", "KYC-Details"],
  ["zahlungsmoeglichkeiten", "Einzahlungen (Crypto)"],
  ["allgemeines_angebot", "Allgemeines Angebot"],
  ["sportwetten_bericht", "Sportwetten-Bericht"],
  ["registrierung_aufwand", "Registrierungs-Aufwand"],
  ["auszahlung_methoden", "Auszahlungsmethoden"],
  ["auszahlung_dauer", "Auszahlungsdauer"],
  ["kunden_bewertungen", "Kunden-Bewertungen"],
  ["cpa_hoehe", "CPA-Höhe"],
  ["revshare_prozent", "Revshare %"],
  ["affiliate_auszahlung_dauer", "Affiliate-Auszahlungsdauer"],
  ["affiliate_bewertungen", "Affiliate-Bewertungen"],
  ["affiliate_kontakt", "Affiliate-Kontakt"],
  ["notizen", "Notizen"],
  ["eigenschaften_text", "Eigene Eigenschaften"],
  ["lizenz", "Lizenz / Standort"],
];

function renderAdvFilters() {
  const box = $("#adv-fields");
  box.innerHTML = ADV_FIELDS.map(([col, label]) => `
    <div class="adv-field">
      <label>${esc(label)} enthält …<input type="text" data-adv-text="${col}" autocomplete="off" /></label>
      <label>Status<select data-adv-status="${col}">
        <option value="">Egal</option><option value="ausgefuellt">Ausgefüllt</option><option value="leer">Leer</option><option value="nichtvorhanden">Nicht vorhanden</option>
      </select></label>
    </div>`).join("");

  let advTimer;
  box.querySelectorAll("[data-adv-text]").forEach((inp) => {
    inp.addEventListener("input", () => {
      clearTimeout(advTimer);
      advTimer = setTimeout(() => {
        const col = inp.dataset.advText;
        state.advanced[col] = { ...(state.advanced[col] || {}), text: inp.value };
        state.page = 0;
        loadPage();
      }, 400);
    });
  });
  box.querySelectorAll("[data-adv-status]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const col = sel.dataset.advStatus;
      state.advanced[col] = { ...(state.advanced[col] || {}), status: sel.value };
      state.page = 0;
      loadPage();
    });
  });
}

function resetAdvFilters() {
  state.advanced = {};
  state.trackerStep = "";
  $("#f-tracker").value = "";
  document.querySelectorAll("[data-adv-text]").forEach((i) => (i.value = ""));
  document.querySelectorAll("[data-adv-status]").forEach((s) => (s.value = ""));
}

/* ---------- Recherche-Fortschritt (automatisch) ---------- */
const PROGRESS_FIELDS = [
  ["verfuegbar_at", "unbekannt"], ["verfuegbar_de", "unbekannt"], ["kette", "unbekannt"],
  ["kette_firma", "text"], ["spieler_zahlen", "text"], ["kyc", "unbekannt"], ["kyc_details", "text"],
  ["zahlungsmoeglichkeiten", "text"], ["allgemeines_angebot", "text"], ["sportwetten", "unbekannt"],
  ["sportwetten_bericht", "text"], ["registrierung_aufwand", "text"], ["auszahlung_methoden", "text"],
  ["auszahlung_dauer", "text"], ["kunden_bewertungen", "text"], ["affiliate", "unbekannt"],
  ["cpa", "unbekannt"], ["cpa_hoehe", "text"], ["revshare_prozent", "text"],
  ["affiliate_auszahlung_dauer", "text"], ["affiliate_bewertungen", "text"], ["affiliate_kontakt", "text"],
];

function progressOf(record) {
  let filled = 0;
  for (const [col, kind] of PROGRESS_FIELDS) {
    const v = record[col];
    if (kind === "unbekannt") { if (v && v !== "Unbekannt") filled++; }
    else if (v != null && String(v).trim() !== "") filled++;
  }
  return { filled, total: PROGRESS_FIELDS.length, pct: Math.round((filled / PROGRESS_FIELDS.length) * 100) };
}

function fieldHtml(f, value) {
  const v = value ?? "";
  const cls = f.full ? "d-field full" : "d-field";
  if (f.type === "select") {
    const opts = f.options
      .map((o) => `<option value="${esc(o)}" ${o === v ? "selected" : ""}>${esc(o)}</option>`)
      .join("");
    return `<div class="${cls}">${esc(f.label)}<select data-col="${f.col}">${opts}</select></div>`;
  }
  if (f.type === "textarea") {
    return `<div class="${cls}">${esc(f.label)}<textarea data-col="${f.col}">${esc(v)}</textarea></div>`;
  }
  return `<div class="${cls}">${esc(f.label)}<input type="text" data-col="${f.col}" value="${esc(v)}" /></div>`;
}

function eigRowHtml(name, wert) {
  return `<div class="eig-row">
    <input type="text" class="eig-name" placeholder="Eigenschaft" value="${esc(name)}" />
    <input type="text" class="eig-wert" placeholder="Wert" value="${esc(wert)}" />
    <button type="button" class="eig-del" title="Entfernen">✕</button>
  </div>`;
}

function openDrawer(record) {
  if (!record) return;
  currentRecord = record;
  $("#d-title").textContent = record.title;
  const prog = progressOf(record);
  const tracker = record.tracker || {};
  const eigenschaften = Array.isArray(record.eigenschaften) ? record.eigenschaften : [];

  const info = `
    <div class="d-section">
      <h3>Recherche-Fortschritt</h3>
      <div class="progress-wrap">
        <div class="progress-bar"><div class="progress-fill" id="prog-fill" style="width:${prog.pct}%"></div></div>
        <div class="progress-text" id="prog-text">${prog.filled} von ${prog.total} Kategorien ausgefüllt (${prog.pct} %)</div>
      </div>
    </div>
    <div class="d-section">
      <h3>Account-Tracker</h3>
      <div class="tracker-list">
        ${TRACKER_STEPS.map(([key, label], i) => `
          <label class="tracker-step"><span class="step-nr">${i + 1}.</span>
            <input type="checkbox" data-track="${key}" ${tracker[key] ? "checked" : ""} /> ${esc(label)}
          </label>`).join("")}
      </div>
    </div>
    <div class="d-section">
      <h3>Thread-Info (aus Bitcointalk)</h3>
      <div class="d-grid">
        <div class="d-field">Bekanntheits-Score<div class="d-static">${record.bekanntheits_score ?? "–"} / 100</div></div>
        <div class="d-field">Aufrufe / Antworten<div class="d-static">${(record.views ?? 0).toLocaleString("de-AT")} / ${(record.replies ?? 0).toLocaleString("de-AT")}</div></div>
        <div class="d-field">Ersteller<div class="d-static">${esc(record.starter) || "–"}</div></div>
        <div class="d-field">Letzter Beitrag<div class="d-static">${esc(record.last_post) || "–"}</div></div>
        <div class="d-field full">Thread<div class="d-static"><a href="${esc(record.thread_url)}" target="_blank" rel="noopener">${esc(record.thread_url)}</a></div></div>
      </div>
    </div>`;

  const sections = SECTIONS.map(
    (s) => `<div class="d-section"><h3>${esc(s.title)}</h3><div class="d-grid">${s.fields.map((f) => fieldHtml(f, record[f.col])).join("")}</div></div>`
  ).join("");

  const eigHtml = `
    <div class="d-section">
      <h3>Eigene Eigenschaften</h3>
      <div id="eig-list">${eigenschaften.map((e) => eigRowHtml(e.name || "", e.wert || "")).join("")}</div>
      <button type="button" class="btn-secondary eig-add" id="eig-add">+ Eigenschaft hinzufügen</button>
    </div>`;

  const ketteHtml = `
    <div class="d-section">
      <h3>Kette – Schwester-Seiten</h3>
      <div id="kette-box" class="kette-list">
        ${record.kette_firma
          ? '<span class="kette-hint">Lade Kette …</span>'
          : '<span class="kette-hint">Trage oben bei „Firma / Muttergesellschaft“ einen Namen ein und speichere – dann erscheinen hier alle Seiten derselben Firma.</span>'}
      </div>
    </div>`;

  $("#drawer-body").innerHTML = info + sections + eigHtml + ketteHtml;

  $("#eig-add").addEventListener("click", () => {
    $("#eig-list").insertAdjacentHTML("beforeend", eigRowHtml("", ""));
    wireEigDelete();
  });
  wireEigDelete();
  if (record.kette_firma) loadKette(record);

  $("#drawer").hidden = false;
  $("#backdrop").hidden = false;
  $("#drawer-body").scrollTop = 0;
}

function wireEigDelete() {
  document.querySelectorAll(".eig-del").forEach((btn) => {
    btn.onclick = () => btn.closest(".eig-row").remove();
  });
}

async function loadKette(record) {
  const box = $("#kette-box");
  try {
    const name = record.kette_firma.replace(/[,()*]/g, " ").trim();
    const p = new URLSearchParams();
    p.append("kette_firma", `ilike.${name}`);
    p.append("select", "*");
    p.append("order", "bekanntheits_score.desc.nullslast");
    p.append("limit", 50);
    const res = await fetch(`${API}?${p}`, { headers: HEADERS });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rows = (await res.json()).filter((r) => r.id !== record.id);
    if (!rows.length) {
      box.innerHTML = '<span class="kette-hint">Keine weiteren Seiten mit dieser Firma eingetragen.</span>';
      return;
    }
    box.innerHTML =
      `<span class="kette-hint">Firma „${esc(record.kette_firma)}“ – ${rows.length} weitere Seite(n):</span>` +
      rows.map((r) => `
        <div class="kette-item" data-kid="${r.id}">
          <span class="k-title">${r.website ? `<b>${esc(r.website)}</b> · ` : ""}${esc(r.title)}</span>
          <span class="badge ${r.bekanntheits_score >= 80 ? "score-high" : r.bekanntheits_score >= 50 ? "score-mid" : "score-low"}">${r.bekanntheits_score ?? "–"}</span>
        </div>`).join("");
    box.querySelectorAll(".kette-item").forEach((el) => {
      el.addEventListener("click", () => openDrawer(rows.find((r) => r.id === el.dataset.kid)));
    });
  } catch (e) {
    box.innerHTML = '<span class="kette-hint">Fehler beim Laden der Kette: ' + esc(e.message) + "</span>";
  }
}

function closeDrawer() {
  $("#drawer").hidden = true;
  $("#backdrop").hidden = true;
  currentRecord = null;
}

async function saveRecord() {
  if (!currentRecord) return;
  const patch = {};
  $("#drawer-body").querySelectorAll("[data-col]").forEach((el) => {
    patch[el.dataset.col] = el.value.trim() === "" ? null : el.value.trim();
  });

  // Account-Tracker einsammeln
  const tracker = {};
  $("#drawer-body").querySelectorAll("[data-track]").forEach((cb) => {
    tracker[cb.dataset.track] = cb.checked;
  });
  patch.tracker = tracker;

  // Eigene Eigenschaften einsammeln
  const eigenschaften = [];
  $("#drawer-body").querySelectorAll(".eig-row").forEach((row) => {
    const name = row.querySelector(".eig-name").value.trim();
    const wert = row.querySelector(".eig-wert").value.trim();
    if (name) eigenschaften.push({ name, wert });
  });
  patch.eigenschaften = eigenschaften;

  patch.updated_at = new Date().toISOString();
  try {
    const res = await fetch(`${API}?id=eq.${currentRecord.id}`, {
      method: "PATCH",
      headers: { ...HEADERS, Prefer: "return=minimal" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    toast("✓ Gespeichert – Änderung ist live!");
    closeDrawer();
    loadPage();
    loadStats();
  } catch (e) {
    toast("Fehler beim Speichern: " + e.message, true);
  }
}

/* ---------- Wunsch-Suche (intelligente Freitext-Suche) ---------- */
const NEG_WORDS = ["ohne", "kein", "keine", "keinen", "keinem", "nicht", "nix", "no", "not", "non"];
const FILLER = ["so", "sehr", "zu", "ganz", "wirklich", "die", "das", "der"];
const STOP_WORDS = new Set([
  "der","die","das","den","dem","des","und","oder","aber","mit","für","fuer","von","aus","bei","auf","in","im","am","an","zu","zum","zur","nach","als","auch","noch","nur","mal","dann","denn","doch","schon","sind","ist","sein","hat","haben","wo","was","wie","wer","es","er","sie","ich","du","wir","ihr","mir","mich","uns","man","bitte","zeig","zeige","zeigen","such","suche","suchen","finde","find","finden","gib","geben","will","wollen","möchte","moechte","hätte","haette","gerne","gern","brauche","brauch","alle","alles","allen","paar","einige","einen","eine","ein","einem","einer","eines","gute","guten","guter","gutes","beste","besten","seiten","seite","webseiten","webseite","websites","website","casinos","casino","gambling","glücksspiel","gluecksspiel","anbieter","plattform","plattformen","liste","mir","haben","gibt","sollen","soll","können","koennen","kann","welche","funktionieren","gehen","geht","laufen","sowie","dazu","etwas","irgendwas","am","liebsten","echt","richtig",
  "gutem","programm","programme","programmen","angebot","angebote","angeboten","sortiert","sortiere","sortieren",
  "schnell","schnelle","schnellen","schneller","sofort","auszahlen","auszahlung","auszahlungen","auszahlt",
  "habe","hab","hast","hatte","schon","bereits","dort","denen","deren","damit","wurde","worden","sein","meine","mein","meinem","meinen",
]);

// Angebots- und Krypto-Begriffe: suchen in Angebot/Zahlungen UND im Titel
const OFFER_TERMS = ["poker", "dice", "würfel", "slots", "slot", "crash", "roulette", "blackjack", "baccarat", "lotterie", "lottery", "lotto", "plinko", "mines", "keno", "bingo", "esport", "esports"];
const CRYPTO_TERMS = { btc: "btc", bitcoin: "bitcoin", eth: "eth", ethereum: "ethereum", usdt: "usdt", tether: "usdt", ltc: "ltc", litecoin: "ltc", doge: "doge", dogecoin: "doge", sol: "sol", solana: "sol", trx: "trx", tron: "trx", xrp: "xrp", monero: "monero", xmr: "xmr" };
const TITLE_TERMS = ["bonus", "freispiele", "freespins", "cashback", "rakeback", "vip", "jackpot", "faucet", "provably", "wager"];

function parseWunsch(raw) {
  const out = { filters: {}, extra: [], groups: [], sort: null, chips: [] };
  const text = raw.toLowerCase().replace(/[’'"!?]/g, "").replace(/[^a-z0-9äöüß.\- ]/g, " ");
  const tokens = text.split(/\s+/).filter(Boolean);
  const used = new Set();
  const jn = (neg) => (neg ? "Nein" : "Ja");

  const negatedAt = (i) => {
    if (i > 0 && NEG_WORDS.includes(tokens[i - 1])) return true;
    if (i > 1 && FILLER.includes(tokens[i - 1]) && NEG_WORDS.includes(tokens[i - 2])) return true;
    if (i > 2 && FILLER.includes(tokens[i - 1]) && FILLER.includes(tokens[i - 2]) && NEG_WORDS.includes(tokens[i - 3])) return true;
    return false;
  };
  const orGroup = (term, cols) => `or(${cols.map((c) => `${c}.ilike.*${term}*`).join(",")})`;

  // Phrasen auf dem Gesamttext (schnelle Auszahlung)
  if (/schnell\w*\s+(?:\w+\s+)?auszahl|auszahl\w*\s+schnell|sofort\w*\s*auszahl|instant/.test(text)) {
    out.groups.push("or(auszahlung_dauer.ilike.*sofort*,auszahlung_dauer.ilike.*schnell*,auszahlung_dauer.ilike.*instant*,auszahlung_dauer.ilike.*minut*,title.ilike.*instant*)");
    out.chips.push("Schnelle Auszahlung");
  }

  // Revshare-Prozent-Bereiche ("revshare ab 25%", "unter 40%")
  let revPhrase = false;
  if (/rev[\s-]?share|revenue|provision|kommission/.test(text)) {
    const ab = text.match(/(?:ab|über|ueber|mindestens|mind|minimum|mehr als)\s*(\d{1,2}(?:[.,]\d)?)\s*%?/);
    const bis = text.match(/(?:unter|maximal|max|höchstens|hoechstens|weniger als)\s*(\d{1,2}(?:[.,]\d)?)\s*%?/);
    if (ab) { out.extra.push(["revshare_wert", `gte.${ab[1].replace(",", ".")}`]); out.chips.push(`Revshare ≥ ${ab[1]}%`); revPhrase = true; }
    if (bis) { out.extra.push(["revshare_wert", `lte.${bis[1].replace(",", ".")}`]); out.chips.push(`Revshare ≤ ${bis[1]}%`); revPhrase = true; }
  }

  tokens.forEach((tok, i) => {
    if (used.has(i)) return;
    const neg = negatedAt(i);
    const mark = () => used.add(i);

    // KYC
    if (tok === "kyc") { out.filters.kyc = neg ? "Non-KYC" : "KYC"; out.chips.push(neg ? "Non-KYC" : "Mit KYC"); return mark(); }
    if (["non-kyc", "nonkyc", "nokyc", "kyc-frei", "kycfrei"].includes(tok) || tok.startsWith("anonym")) { out.filters.kyc = "Non-KYC"; out.chips.push("Non-KYC"); return mark(); }
    if (tok.startsWith("verifizierung") || tok.startsWith("verifikation")) { out.filters.kyc = neg ? "Non-KYC" : "KYC"; out.chips.push(neg ? "Non-KYC" : "Mit KYC"); return mark(); }

    // Sportwetten
    if (tok.startsWith("sportwette") || tok === "wetten" || tok === "sport" || tok.startsWith("sportsbook") || tok.startsWith("betting") || tok.startsWith("buchmacher")) {
      out.filters.sportwetten = jn(neg); out.chips.push(`Sportwetten: ${jn(neg)}`); return mark();
    }

    // Verfügbarkeit
    if (tok.startsWith("österreich") || tok.startsWith("oesterreich") || tok === "austria" || tok.startsWith("österreicher")) {
      out.filters.verfuegbar_at = jn(neg); out.chips.push(`Verfügbar AT: ${jn(neg)}`); return mark();
    }
    if (tok.startsWith("deutschland") || tok === "germany" || tok.startsWith("deutsche")) {
      out.filters.verfuegbar_de = jn(neg); out.chips.push(`Verfügbar DE: ${jn(neg)}`); return mark();
    }

    // Kette
    if (tok.startsWith("kette") || tok === "chain" || tok.startsWith("schwesterseite") || tok.startsWith("mutterfirma")) {
      out.filters.kette = jn(neg); out.chips.push(`Kette: ${jn(neg)}`); return mark();
    }

    // Affiliate / CPA / Revshare
    if (tok.startsWith("affiliate") || tok.startsWith("partnerprogramm") || tok.startsWith("provision") || tok.startsWith("referral")) {
      out.filters.affiliate = jn(neg); out.chips.push(`Affiliate: ${jn(neg)}`); return mark();
    }
    if (tok === "cpa") { out.filters.cpa = jn(neg); out.chips.push(`CPA: ${jn(neg)}`); return mark(); }
    if (tok.startsWith("revshare")) {
      if (!revPhrase) { out.extra.push(["revshare_wert", "not.is.null"]); out.chips.push("Revshare-Angabe vorhanden"); }
      return mark();
    }

    // Lizenz / Standort
    if (tok.startsWith("curacao") || tok.startsWith("curaçao")) { out.extra.push(["lizenz", "ilike.*cura*"]); out.chips.push("Lizenz: Curaçao"); return mark(); }
    if (tok.startsWith("malta")) { out.extra.push(["lizenz", "ilike.*malta*"]); out.chips.push("Lizenz: Malta"); return mark(); }
    if (tok.startsWith("anjouan")) { out.extra.push(["lizenz", "ilike.*anjouan*"]); out.chips.push("Lizenz: Anjouan"); return mark(); }
    if (tok.startsWith("lizenz") || tok.startsWith("lizensiert") || tok.startsWith("licensed")) {
      if (!out.extra.some(([c]) => c === "lizenz")) {
        out.extra.push(["lizenz", neg ? "is.null" : "not.is.null"]);
        out.chips.push(neg ? "Ohne Lizenz-Angabe" : "Lizenz-Angabe vorhanden");
      }
      return mark();
    }

    // Website-Status
    if (tok === "online" || tok.startsWith("erreichbar")) { out.filters.website_status = "Online"; out.chips.push("Website: Online"); return mark(); }
    if (tok === "offline" || tok === "tot" || tok === "tote" || tok === "dead") { out.filters.website_status = "Offline"; out.chips.push("Website: Offline"); return mark(); }

    // Recherche-Status
    if (tok.startsWith("recherchiert") || (tok === "fertig" && tokens[i + 1]?.startsWith("recherchiert"))) {
      out.filters.recherche_status = neg ? "Offen" : "Fertig"; out.chips.push(neg ? "Noch offen" : "Fertig recherchiert"); return mark();
    }
    if (tok.startsWith("unrecherchiert")) { out.filters.recherche_status = "Offen"; out.chips.push("Noch offen"); return mark(); }

    // Bekanntheit (unbekannt VOR bekannt prüfen)
    if (tok.startsWith("unbekannt") || tok.startsWith("geheimtipp") || tok.startsWith("nische")) {
      out.extra.push(["bekanntheits_score", "lte.40"]); out.chips.push("Geringe Bekanntheit (≤40)"); return mark();
    }
    if (tok.startsWith("bekannt") || tok.startsWith("beliebt") || tok.startsWith("populär") || tok.startsWith("popular") || tok === "top" || tok.startsWith("groß") || tok.startsWith("gross") || tok.startsWith("berühmt") || tok.startsWith("famous")) {
      if (neg) { out.extra.push(["bekanntheits_score", "lte.40"]); out.chips.push("Geringe Bekanntheit (≤40)"); }
      else { out.extra.push(["bekanntheits_score", "gte.80"]); out.chips.push("Hohe Bekanntheit (≥80)"); out.sort = "bekanntheits_score.desc.nullslast"; }
      return mark();
    }

    // Sortierung
    if (tok.startsWith("aufrufe") || tok === "views" || tok.startsWith("meistgesehen")) { out.sort = "views.desc.nullslast"; out.chips.push("Sortiert nach Aufrufen"); return mark(); }
    if (tok.startsWith("antworten") || tok.startsWith("aktivste")) { out.sort = "replies.desc.nullslast"; out.chips.push("Sortiert nach Antworten"); return mark(); }

    // Account-Tracker
    if (tok === "account" || tok === "konto" || tok === "accounts") {
      if (neg) { out.groups.push("or(tracker->>account.is.null,tracker->>account.eq.false)"); out.chips.push("Noch kein Account"); }
      else { out.extra.push(["tracker->>account", "eq.true"]); out.chips.push("Account erstellt ✓"); }
      return mark();
    }

    // Spiel-Angebot
    const offer = OFFER_TERMS.find((o) => tok === o || tok === o + "s");
    if (offer) { out.groups.push(orGroup(offer === "würfel" ? "dice" : offer, ["allgemeines_angebot", "title"])); out.chips.push(`Angebot: ${offer}`); return mark(); }

    // Kryptowährungen
    if (CRYPTO_TERMS[tok]) { out.groups.push(orGroup(CRYPTO_TERMS[tok], ["zahlungsmoeglichkeiten", "title"])); out.chips.push(`Zahlung: ${tok.toUpperCase()}`); return mark(); }

    // Titel-Begriffe (Bonus etc.)
    const tt = TITLE_TERMS.find((t) => tok.startsWith(t));
    if (tt) { out.groups.push(orGroup(tt, ["title"])); out.chips.push(`Titel enthält: ${tt}`); return mark(); }

    // Domain direkt eingegeben
    if (tok.includes(".") && tok.length > 3) { out.groups.push(orGroup(tok, ["website", "title"])); out.chips.push(`Domain: ${tok}`); return mark(); }
  });

  // Übrige unbekannte Wörter als Freitext-Suche (max. 2)
  let free = 0;
  tokens.forEach((tok, i) => {
    if (used.has(i) || free >= 2) return;
    if (STOP_WORDS.has(tok) || NEG_WORDS.includes(tok) || FILLER.includes(tok) || tok.length < 4) return;
    out.groups.push(orGroup(tok, ["title", "website", "notizen", "eigenschaften_text"]));
    out.chips.push(`Text: „${tok}“`);
    free++;
  });

  out.chips = [...new Set(out.chips)];
  out.groups = [...new Set(out.groups)];
  return out;
}

function renderChips(chips) {
  const box = $("#wunsch-chips");
  if (!chips.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.innerHTML =
    '<span class="chips-label">Verstanden:</span>' +
    chips.map((c) => `<span class="chip">${esc(c)}</span>`).join("") +
    '<button class="chip-clear" id="wunsch-clear" type="button">✕ Wunsch löschen</button>';
  box.hidden = false;
  $("#wunsch-clear").addEventListener("click", clearWunsch);
}

function clearWunsch() {
  state.wunschExtra = [];
  state.wunschGroups = [];
  state.filters = {};
  state.page = 0;
  $("#wunsch").value = "";
  document.querySelectorAll("#filters select[data-col]").forEach((s) => (s.value = ""));
  renderChips([]);
  loadPage();
}

function runWunsch() {
  const raw = $("#wunsch").value.trim();
  if (!raw) return;
  const parsed = parseWunsch(raw);
  if (!parsed.chips.length) { toast("Wunsch nicht verstanden – bitte anders formulieren.", true); return; }

  // Filter-UI zurücksetzen und mit dem verstandenen Wunsch befüllen
  state.filters = {};
  document.querySelectorAll("#filters select[data-col]").forEach((s) => (s.value = ""));
  for (const [col, val] of Object.entries(parsed.filters)) {
    state.filters[col] = val;
    const sel = document.querySelector(`#filters select[data-col="${col}"]`);
    if (sel) sel.value = val;
  }
  state.wunschExtra = parsed.extra;
  state.wunschGroups = parsed.groups;
  if (parsed.sort) {
    state.sort = parsed.sort;
    const sortSel = $("#sort");
    if ([...sortSel.options].some((o) => o.value === parsed.sort)) sortSel.value = parsed.sort;
  }
  state.page = 0;
  renderChips(parsed.chips);
  loadPage();
}

/* ---------- Spracheingabe (Web Speech API) ---------- */
function setupVoice() {
  const micBtn = $("#mic");
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    micBtn.addEventListener("click", () => toast("Spracheingabe wird von diesem Browser nicht unterstützt – bitte Chrome oder Edge nutzen.", true));
    return;
  }
  const rec = new SR();
  rec.lang = "de-DE";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  let listening = false;
  rec.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    $("#wunsch").value = transcript;
    runWunsch();
  };
  rec.onend = () => { listening = false; micBtn.classList.remove("listening"); };
  rec.onerror = (e) => {
    listening = false;
    micBtn.classList.remove("listening");
    if (e.error !== "aborted") toast("Spracheingabe-Fehler: " + e.error, true);
  };
  micBtn.addEventListener("click", () => {
    if (listening) { rec.stop(); return; }
    listening = true;
    micBtn.classList.add("listening");
    rec.start();
  });
}

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " error" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

/* ---------- Events ---------- */
let searchTimer;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value;
    state.page = 0;
    loadPage();
  }, 350);
});

document.querySelectorAll("#filters select[data-col]").forEach((sel) => {
  sel.addEventListener("change", () => {
    state.filters[sel.dataset.col] = sel.value;
    state.page = 0;
    loadPage();
  });
});

$("#sort").addEventListener("change", (e) => {
  state.sort = e.target.value;
  state.page = 0;
  loadPage();
});

$("#f-score").addEventListener("change", (e) => {
  const map = {
    hoch: [["bekanntheits_score", "gte.80"]],
    mittel: [["bekanntheits_score", "gte.50"], ["bekanntheits_score", "lte.79"]],
    niedrig: [["bekanntheits_score", "lte.49"]],
  };
  state.scoreExtra = map[e.target.value] || [];
  state.page = 0;
  loadPage();
});

$("#wunsch-go").addEventListener("click", runWunsch);
$("#wunsch").addEventListener("keydown", (e) => { if (e.key === "Enter") runWunsch(); });

$("#f-tracker").addEventListener("change", (e) => {
  state.trackerStep = e.target.value;
  state.page = 0;
  loadPage();
});

let revTimer;
["f-rev-min", "f-rev-max"].forEach((id) => {
  document.getElementById(id).addEventListener("input", (e) => {
    clearTimeout(revTimer);
    revTimer = setTimeout(() => {
      state[id === "f-rev-min" ? "revMin" : "revMax"] = e.target.value;
      state.page = 0;
      loadPage();
    }, 400);
  });
});

$("#reset").addEventListener("click", () => {
  state.filters = {};
  state.search = "";
  state.page = 0;
  state.scoreExtra = [];
  state.wunschExtra = [];
  state.wunschGroups = [];
  state.revMin = "";
  state.revMax = "";
  resetAdvFilters();
  $("#search").value = "";
  $("#wunsch").value = "";
  $("#f-score").value = "";
  $("#f-rev-min").value = "";
  $("#f-rev-max").value = "";
  renderChips([]);
  document.querySelectorAll("#filters select[data-col]").forEach((s) => (s.value = ""));
  $("#sort").value = "bekanntheits_score.desc.nullslast";
  state.sort = "bekanntheits_score.desc.nullslast";
  loadPage();
});

$("#prev").addEventListener("click", () => { if (state.page > 0) { state.page--; loadPage(); window.scrollTo(0, 0); } });
$("#next").addEventListener("click", () => { state.page++; loadPage(); window.scrollTo(0, 0); });
$("#drawer-close").addEventListener("click", closeDrawer);
$("#backdrop").addEventListener("click", closeDrawer);
$("#save").addEventListener("click", saveRecord);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

/* ---------- Start ---------- */
renderAdvFilters();
setupVoice();
loadStats();
loadPage();
