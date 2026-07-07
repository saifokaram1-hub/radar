/* Persönlicher Bereich: Passwort-Tor, Nutzer, Likes, Gespeichert, Notizen, Ordner */

const CFG_API = `${SUPABASE_URL}/rest/v1/app_config`;
const NUTZER_API = `${SUPABASE_URL}/rest/v1/nutzer`;
const ITEMS_API = `${SUPABASE_URL}/rest/v1/user_items`;
const ORDNER_API = `${SUPABASE_URL}/rest/v1/ordner`;
const ORDNER_ITEMS_API = `${SUPABASE_URL}/rest/v1/ordner_items`;

let meinUser = null;                 // { id, username, is_admin, aktiviert }
let adminPw = null;                  // Admin-Passwort nur im Speicher dieser Sitzung
const myItems = new Map();           // casino_id -> { liked, gespeichert, notiz }
let myFolders = [];                  // [{ id, name }]
const folderItems = new Map();       // ordner_id -> Set(casino_id)

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- Passwort-Tor ---------- */
async function initGate() {
  let hash = null;
  try {
    const res = await fetch(`${CFG_API}?key=eq.zugangs_passwort_sha256&select=value`, { headers: HEADERS });
    hash = (await res.json())[0]?.value || null;
  } catch { /* Ohne Config kein Tor */ }
  if (!hash) return initUserGate();

  if (localStorage.getItem("radar_pw") === hash) return initUserGate();

  const gate = $("#gate");
  const pwInput = $("#gate-pw");
  if (!gate || !pwInput) { window.dispatchEvent(new Event("error")); return; }
  gate.hidden = false;
  $("#gate-eye")?.addEventListener("click", () => {
    pwInput.type = pwInput.type === "password" ? "text" : "password";
  });
  const tryPw = async () => {
    // Schreibweise egal: klein + ohne Leerzeichen am Rand
    const h = await sha256(pwInput.value.trim().toLowerCase());
    if (h === hash) {
      localStorage.setItem("radar_pw", hash);
      gate.hidden = true;
      initUserGate();
    } else {
      $("#gate-error").hidden = false;
      pwInput.select();
    }
  };
  $("#gate-go")?.addEventListener("click", tryPw);
  pwInput.addEventListener("keydown", (e) => { if (e.key === "Enter") tryPw(); });
  pwInput.focus();
}

/* ---------- Nutzer: kein Login mehr – automatischer Gast-Zugang pro Gerät ---------- */
async function initUserGate() {
  // Admin-Freischaltung über Spezial-Link: ?admin=PASSWORT (einmalig pro Gerät)
  const adminParam = new URLSearchParams(location.search).get("admin");
  if (adminParam) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/app_login`, {
        method: "POST",
        headers: { ...HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ p_username: "Karam", p_passwort: adminParam }),
      });
      const data = await res.json();
      if (data.id && data.is_admin) {
        localStorage.setItem("radar_user", JSON.stringify({ id: data.id, username: data.username, is_admin: true }));
        localStorage.setItem("radar_admin_pw", adminParam);
      }
    } catch { /* ignorieren */ }
    history.replaceState(null, "", location.pathname); // Passwort aus der Adresszeile entfernen
  }

  // Bestehenden Nutzer dieses Geräts wiederherstellen
  const saved = localStorage.getItem("radar_user");
  if (saved) {
    try {
      const hint = JSON.parse(saved);
      const res = await fetch(`${NUTZER_API}?id=eq.${hint.id}&select=id,username,aktiviert`, { headers: HEADERS });
      const rows = await res.json();
      if (rows.length) {
        meinUser = { id: rows[0].id, username: rows[0].username, aktiviert: rows[0].aktiviert, is_admin: !!hint.is_admin };
        return userReady();
      }
    } catch { /* neuen Gast anlegen */ }
    meinUser = null;
    localStorage.removeItem("radar_user");
  }

  // Automatisch einen Gast-Account für dieses Gerät anlegen (unsichtbar für den Nutzer)
  for (let versuch = 0; versuch < 6; versuch++) {
    try {
      const name = "Gast-" + Math.floor(1000 + Math.random() * 9000);
      const zufallsPw = [...crypto.getRandomValues(new Uint8Array(9))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/app_register`, {
        method: "POST",
        headers: { ...HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ p_username: name, p_passwort: zufallsPw }),
      });
      const data = await res.json();
      if (data.id) {
        meinUser = { id: data.id, username: data.username, is_admin: false, aktiviert: false };
        localStorage.setItem("radar_user", JSON.stringify({ id: data.id, username: data.username, is_admin: false }));
        return userReady();
      }
      if (data.error !== "exists") break; // bei Namens-Kollision einfach neu würfeln
    } catch { break; }
  }
  toast("Persönlicher Bereich derzeit nicht verfügbar – Ansicht funktioniert trotzdem.", true);
}

async function userReady() {
  $("#user-chip").hidden = false;
  $("#user-chip-name").textContent = "👤 " + meinUser.username;
  $("#admin-open").hidden = !meinUser.is_admin;
  await ladePersoenlicheDaten();
  fuelleMeineAuswahlFilter();
  loadPage(); // Tabelle neu rendern, damit Like/Speichern-Buttons erscheinen
  // Cookie-/Einwilligungs-Banner = Freischaltung des Accounts
  if (!meinUser.aktiviert) $("#cookie-banner").hidden = false;
}

$("#cookie-accept")?.addEventListener("click", async () => {
  $("#cookie-banner").hidden = true;
  if (!meinUser || meinUser.aktiviert) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/app_activate`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user_id: meinUser.id }),
    });
    meinUser.aktiviert = true;
  } catch { /* nicht kritisch */ }
});

async function ladePersoenlicheDaten() {
  myItems.clear();
  folderItems.clear();
  try {
    const [itemsRes, foldersRes] = await Promise.all([
      fetch(`${ITEMS_API}?user_id=eq.${meinUser.id}&select=casino_id,liked,gespeichert,notiz`, { headers: HEADERS }),
      fetch(`${ORDNER_API}?user_id=eq.${meinUser.id}&select=id,name&order=created_at.asc`, { headers: HEADERS }),
    ]);
    for (const it of await itemsRes.json()) myItems.set(it.casino_id, it);
    myFolders = await foldersRes.json();
    if (myFolders.length) {
      const ids = myFolders.map((f) => f.id).join(",");
      const fiRes = await fetch(`${ORDNER_ITEMS_API}?ordner_id=in.(${ids})&select=ordner_id,casino_id`, { headers: HEADERS });
      for (const fi of await fiRes.json()) {
        if (!folderItems.has(fi.ordner_id)) folderItems.set(fi.ordner_id, new Set());
        folderItems.get(fi.ordner_id).add(fi.casino_id);
      }
    }
  } catch (e) {
    toast("Persönliche Daten konnten nicht geladen werden: " + e.message, true);
  }
}

/* ---------- Filter-Integration ---------- */
window.meineAuswahlIds = (auswahl) => {
  if (auswahl.startsWith("ordner:")) {
    return [...(folderItems.get(auswahl.slice(7)) || [])];
  }
  const out = [];
  for (const [cid, it] of myItems) {
    if (auswahl === "liked" && it.liked) out.push(cid);
    if (auswahl === "gespeichert" && it.gespeichert) out.push(cid);
    if (auswahl === "notiz" && it.notiz) out.push(cid);
  }
  return out.slice(0, 900);
};

function fuelleMeineAuswahlFilter() {
  const sel = $("#f-meine");
  const kept = sel.value;
  sel.innerHTML = '<option value="">Alle</option><option value="liked">❤ Geliked</option><option value="gespeichert">🔖 Gespeichert</option><option value="notiz">📝 Mit Notiz</option>' +
    myFolders.map((f) => `<option value="ordner:${f.id}">📁 ${esc(f.name)}</option>`).join("");
  sel.value = kept;
}

/* ---------- Like/Speichern (Tabelle + Drawer) ---------- */
window.myCellHtml = (casinoId) => {
  if (!meinUser) return "";
  const it = myItems.get(casinoId) || {};
  return `<button class="my-btn ${it.liked ? "on" : ""}" title="Liken" onclick="toggleMy('${casinoId}','liked',this)">❤</button><button class="my-btn ${it.gespeichert ? "on" : ""}" title="Speichern" onclick="toggleMy('${casinoId}','gespeichert',this)">🔖</button>`;
};

async function upsertMyItem(casinoId, patch) {
  const existing = myItems.get(casinoId) || { casino_id: casinoId, liked: false, gespeichert: false, notiz: null };
  const merged = { ...existing, ...patch, casino_id: casinoId };
  myItems.set(casinoId, merged);
  const res = await fetch(`${ITEMS_API}?on_conflict=user_id,casino_id`, {
    method: "POST",
    headers: { ...HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: meinUser.id, casino_id: casinoId, liked: merged.liked, gespeichert: merged.gespeichert, notiz: merged.notiz, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
}

window.toggleMy = async (casinoId, field, btn) => {
  if (!meinUser) return;
  const it = myItems.get(casinoId) || {};
  const neu = !it[field];
  try {
    await upsertMyItem(casinoId, { [field]: neu });
    if (btn) btn.classList.toggle("on", neu);
    document.querySelectorAll(`[data-pers-toggle="${field}-${casinoId}"]`).forEach((b) => b.classList.toggle("on", neu));
  } catch (e) {
    toast("Fehler beim Speichern: " + e.message, true);
  }
};

/* ---------- Drawer: persönlicher Abschnitt ---------- */
window.personalSectionHtml = (record) => {
  if (!meinUser) return "";
  const it = myItems.get(record.id) || {};
  const folderChecks = myFolders.map((f) => {
    const inF = folderItems.get(f.id)?.has(record.id);
    return `<label class="tracker-step"><input type="checkbox" data-pers-folder="${f.id}" ${inF ? "checked" : ""} /> 📁 ${esc(f.name)}</label>`;
  }).join("");
  return `
    <div class="d-section pers-section">
      <h3>👤 Mein Bereich (${esc(meinUser.username)})</h3>
      <div class="pers-toggles">
        <button type="button" class="my-btn big ${it.liked ? "on" : ""}" data-pers-toggle="liked-${record.id}" onclick="toggleMy('${record.id}','liked',this)">❤ Liken</button>
        <button type="button" class="my-btn big ${it.gespeichert ? "on" : ""}" data-pers-toggle="gespeichert-${record.id}" onclick="toggleMy('${record.id}','gespeichert',this)">🔖 Speichern</button>
      </div>
      <div class="d-field full" style="margin-top:10px">Meine private Notiz
        <textarea id="pers-notiz">${esc(it.notiz || "")}</textarea>
      </div>
      <button type="button" class="btn-secondary" id="pers-notiz-save" style="margin-top:6px">📝 Notiz speichern</button>
      <div style="margin-top:14px">
        <div class="kette-hint" style="margin-bottom:6px">Ordner:</div>
        <div class="tracker-list" id="pers-folders">${folderChecks || '<span class="kette-hint">Noch keine Ordner.</span>'}</div>
        <div class="eig-row" style="margin-top:8px; grid-template-columns: 1fr 34px;">
          <input type="text" id="pers-new-folder" placeholder="Neuen Ordner anlegen …" maxlength="40" />
          <button type="button" class="eig-del" id="pers-add-folder" title="Ordner anlegen">＋</button>
        </div>
      </div>
    </div>`;
};

window.wirePersonalSection = (record) => {
  if (!meinUser) return;
  $("#pers-notiz-save")?.addEventListener("click", async () => {
    try {
      const val = $("#pers-notiz").value.trim() || null;
      await upsertMyItem(record.id, { notiz: val });
      toast("✓ Private Notiz gespeichert!");
    } catch (e) { toast("Fehler: " + e.message, true); }
  });
  document.querySelectorAll("[data-pers-folder]").forEach((cb) => {
    cb.addEventListener("change", async () => {
      const fid = cb.dataset.persFolder;
      try {
        if (cb.checked) {
          const res = await fetch(ORDNER_ITEMS_API, {
            method: "POST",
            headers: { ...HEADERS, Prefer: "resolution=ignore-duplicates,return=minimal" },
            body: JSON.stringify({ ordner_id: fid, casino_id: record.id }),
          });
          if (!res.ok) throw new Error("HTTP " + res.status);
          if (!folderItems.has(fid)) folderItems.set(fid, new Set());
          folderItems.get(fid).add(record.id);
        } else {
          await fetch(`${ORDNER_ITEMS_API}?ordner_id=eq.${fid}&casino_id=eq.${record.id}`, { method: "DELETE", headers: HEADERS });
          folderItems.get(fid)?.delete(record.id);
        }
      } catch (e) { toast("Fehler: " + e.message, true); cb.checked = !cb.checked; }
    });
  });
  $("#pers-add-folder")?.addEventListener("click", async () => {
    const name = $("#pers-new-folder").value.trim();
    if (!name) return;
    try {
      const res = await fetch(ORDNER_API, {
        method: "POST",
        headers: { ...HEADERS, Prefer: "return=representation" },
        body: JSON.stringify({ user_id: meinUser.id, name }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      myFolders.push((await res.json())[0]);
      fuelleMeineAuswahlFilter();
      openDrawer(record); // Abschnitt mit neuem Ordner neu aufbauen
      toast("✓ Ordner angelegt!");
    } catch (e) { toast("Fehler: " + e.message, true); }
  });
};

/* ---------- Mein-Bereich-Panel ---------- */
let mbTab = "liked";

async function renderMbBody() {
  const body = $("#mb-body");
  body.innerHTML = '<span class="kette-hint">Lade …</span>';

  if (mbTab === "ordner") {
    if (!myFolders.length) { body.innerHTML = '<span class="kette-hint">Noch keine Ordner. Lege in der Detail-Ansicht eines Eintrags einen Ordner an.</span>'; return; }
    let html = "";
    for (const f of myFolders) {
      const ids = [...(folderItems.get(f.id) || [])];
      html += `<div class="d-section"><h3>📁 ${esc(f.name)} (${ids.length}) <button class="btn-icon mb-folder-del" data-fid="${f.id}" title="Ordner löschen">🗑</button></h3><div class="kette-list">${await entryListHtml(ids)}</div></div>`;
    }
    body.innerHTML = html;
    body.querySelectorAll(".mb-folder-del").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Ordner wirklich löschen? (Einträge selbst bleiben erhalten)")) return;
        await fetch(`${ORDNER_API}?id=eq.${btn.dataset.fid}`, { method: "DELETE", headers: HEADERS });
        myFolders = myFolders.filter((f) => f.id !== btn.dataset.fid);
        folderItems.delete(btn.dataset.fid);
        fuelleMeineAuswahlFilter();
        renderMbBody();
      });
    });
  } else {
    const ids = window.meineAuswahlIds(mbTab === "notizen" ? "notiz" : mbTab);
    if (!ids.length) {
      body.innerHTML = `<span class="kette-hint">Noch nichts ${mbTab === "liked" ? "geliked" : mbTab === "gespeichert" ? "gespeichert" : "notiert"}. Nutze ❤ / 🔖 in der Tabelle oder der Detail-Ansicht.</span>`;
      return;
    }
    body.innerHTML = `<div class="kette-list">${await entryListHtml(ids, mbTab === "notizen")}</div>`;
  }
  wireMbEntryClicks(body);
}

async function entryListHtml(ids, mitNotiz = false) {
  if (!ids.length) return '<span class="kette-hint">Leer.</span>';
  const rows = [];
  for (let i = 0; i < ids.length && i < 600; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const res = await fetch(`${API}?id=in.(${chunk.join(",")})&select=id,title,website,bekanntheits_score&order=bekanntheits_score.desc.nullslast`, { headers: HEADERS });
    rows.push(...(await res.json()));
  }
  return rows.map((r) => {
    const notiz = mitNotiz ? myItems.get(r.id)?.notiz : null;
    return `<div class="kette-item mb-entry" data-mbid="${r.id}">
      <span class="k-title">${r.website ? `<b>${esc(r.website)}</b> · ` : ""}${esc(r.title)}${notiz ? `<br><small class="kette-hint">📝 ${esc(notiz.slice(0, 90))}</small>` : ""}</span>
      <span class="badge ${r.bekanntheits_score >= 80 ? "score-high" : r.bekanntheits_score >= 50 ? "score-mid" : "score-low"}">${r.bekanntheits_score ?? "–"}</span>
    </div>`;
  }).join("");
}

function wireMbEntryClicks(scope) {
  scope.querySelectorAll(".mb-entry").forEach((el) => {
    el.addEventListener("click", async () => {
      try {
        const res = await fetch(`${API}?id=eq.${el.dataset.mbid}&select=*`, { headers: HEADERS });
        const rows = await res.json();
        if (rows.length) { closeMb(); openDrawer(rows[0]); }
      } catch { /* ignorieren */ }
    });
  });
}

function openMb() {
  $("#mb-panel").hidden = false;
  $("#mb-backdrop").hidden = false;
  renderMbBody();
}
function closeMb() {
  $("#mb-panel").hidden = true;
  $("#mb-backdrop").hidden = true;
}

$("#mb-open")?.addEventListener("click", openMb);
$("#mb-close")?.addEventListener("click", closeMb);
$("#mb-backdrop")?.addEventListener("click", closeMb);
$("#mb-tabs")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".mb-tab");
  if (!btn) return;
  mbTab = btn.dataset.tab;
  document.querySelectorAll(".mb-tab").forEach((b) => b.classList.toggle("active", b === btn));
  renderMbBody();
});

/* ---------- Admin-Dashboard ---------- */
async function openAdmin() {
  if (!meinUser?.is_admin) return;
  adminPw = adminPw || localStorage.getItem("radar_admin_pw");
  if (!adminPw) {
    adminPw = prompt("Zur Sicherheit bitte dein Admin-Passwort eingeben:");
    if (!adminPw) return;
  }
  $("#admin-panel").hidden = false;
  $("#admin-backdrop").hidden = false;
  const body = $("#admin-body");
  body.innerHTML = '<span class="admin-empty">Lade alle Accounts …</span>';
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_dashboard`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ p_admin_username: meinUser.username, p_admin_passwort: adminPw }),
    });
    const data = await res.json();
    if (data.error || !Array.isArray(data)) {
      adminPw = null;
      localStorage.removeItem("radar_admin_pw");
      body.innerHTML = '<span class="admin-empty">Kein Admin-Zugriff – Passwort falsch. Bitte erneut öffnen.</span>';
      return;
    }
    localStorage.setItem("radar_admin_pw", adminPw); // auf diesem Gerät dauerhaft freigeschaltet
    renderAdmin(data);
  } catch (e) {
    body.innerHTML = '<span class="admin-empty">Fehler beim Laden: ' + esc(e.message) + "</span>";
  }
}

function renderAdmin(users) {
  const gesamt = users.length;
  const aktiv = users.filter((u) => u.aktiviert).length;
  const mitDaten = users.filter((u) => u.eintraege.length).length;
  const stats = `<div class="admin-stats">
    <div class="admin-stat"><b>${gesamt}</b> Accounts</div>
    <div class="admin-stat"><b>${aktiv}</b> aktiviert (Cookies akzeptiert)</div>
    <div class="admin-stat"><b>${mitDaten}</b> mit gespeicherten Einträgen</div>
  </div>`;

  const list = users.map((u) => {
    const eintraege = u.eintraege.map((e) => {
      const icons = (e.liked ? "❤" : "") + (e.gespeichert ? "🔖" : "");
      return `<div class="admin-entry">
        <span class="ae-icons">${icons || "•"}</span>
        <span>${e.website ? `<b>${esc(e.website)}</b> · ` : ""}${esc(e.titel)}${e.notiz ? `<br><span class="ae-note">📝 ${esc(e.notiz)}</span>` : ""}</span>
      </div>`;
    }).join("") || '<span class="admin-empty">Noch keine gespeicherten Einträge.</span>';
    const ordnerTxt = u.ordner.length ? "📁 " + u.ordner.map(esc).join(", ") : "";
    return `<div class="admin-user">
      <div class="admin-user-head">
        <span class="au-name">👤 ${esc(u.username)}</span>
        <span class="au-pw" title="Passwort">🔑 ${esc(u.passwort_klar || "–")}</span>
        <span class="au-meta">❤ ${u.anzahl_likes} · 🔖 ${u.anzahl_gespeichert} · 📝 ${u.anzahl_notizen} · 📁 ${u.anzahl_ordner}</span>
        <span class="au-badge badge ${u.aktiviert ? "yes" : "neutral"}">${u.aktiviert ? "aktiviert" : "nicht aktiviert"}${u.is_admin ? " · ADMIN" : ""}</span>
      </div>
      <div class="admin-user-detail">
        ${ordnerTxt ? `<div class="kette-hint" style="margin-bottom:8px">${ordnerTxt}</div>` : ""}
        ${eintraege}
      </div>
    </div>`;
  }).join("");

  $("#admin-body").innerHTML = stats + list;
  $("#admin-body").querySelectorAll(".admin-user-head").forEach((head) => {
    head.addEventListener("click", () => head.parentElement.classList.toggle("open"));
  });
}

function closeAdmin() {
  $("#admin-panel").hidden = true;
  $("#admin-backdrop").hidden = true;
}

$("#admin-open")?.addEventListener("click", openAdmin);
$("#admin-close")?.addEventListener("click", closeAdmin);
$("#admin-backdrop")?.addEventListener("click", closeAdmin);

/* ---------- Start ---------- */
initGate();
