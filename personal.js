/* Persönlicher Bereich: Passwort-Tor, Nutzer, Likes, Gespeichert, Notizen, Ordner */

const CFG_API = `${SUPABASE_URL}/rest/v1/app_config`;
const NUTZER_API = `${SUPABASE_URL}/rest/v1/nutzer`;
const ITEMS_API = `${SUPABASE_URL}/rest/v1/user_items`;
const ORDNER_API = `${SUPABASE_URL}/rest/v1/ordner`;
const ORDNER_ITEMS_API = `${SUPABASE_URL}/rest/v1/ordner_items`;

let meinUser = null;                 // { id, username }
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
  gate.hidden = false;
  const pwInput = $("#gate-pw");
  $("#gate-eye").addEventListener("click", () => {
    pwInput.type = pwInput.type === "password" ? "text" : "password";
  });
  const tryPw = async () => {
    const h = await sha256(pwInput.value);
    if (h === hash) {
      localStorage.setItem("radar_pw", hash);
      gate.hidden = true;
      initUserGate();
    } else {
      $("#gate-error").hidden = false;
      pwInput.select();
    }
  };
  $("#gate-go").addEventListener("click", tryPw);
  pwInput.addEventListener("keydown", (e) => { if (e.key === "Enter") tryPw(); });
  pwInput.focus();
}

/* ---------- Nutzer ---------- */
async function initUserGate() {
  const saved = localStorage.getItem("radar_user");
  if (saved) {
    try {
      meinUser = JSON.parse(saved);
      // prüfen, ob der Nutzer noch existiert
      const res = await fetch(`${NUTZER_API}?id=eq.${meinUser.id}&select=id,username`, { headers: HEADERS });
      const rows = await res.json();
      if (rows.length) { meinUser = rows[0]; return userReady(); }
    } catch { /* neu anmelden */ }
    meinUser = null;
    localStorage.removeItem("radar_user");
  }
  const gate = $("#user-gate");
  gate.hidden = false;
  const input = $("#user-name");
  const go = async () => {
    const name = input.value.trim();
    if (name.length < 2) { showUserError("Bitte mindestens 2 Zeichen."); return; }
    try {
      const res = await fetch(`${NUTZER_API}?username=eq.${encodeURIComponent(name)}&select=id,username`, { headers: HEADERS });
      const rows = await res.json();
      if (rows.length) {
        meinUser = rows[0];
      } else {
        const ins = await fetch(NUTZER_API, {
          method: "POST",
          headers: { ...HEADERS, Prefer: "return=representation" },
          body: JSON.stringify({ username: name }),
        });
        if (!ins.ok) throw new Error("HTTP " + ins.status);
        meinUser = (await ins.json())[0];
      }
      localStorage.setItem("radar_user", JSON.stringify(meinUser));
      gate.hidden = true;
      userReady();
    } catch (e) {
      showUserError("Fehler: " + e.message);
    }
  };
  $("#user-go").addEventListener("click", go);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  input.focus();
}

function showUserError(msg) {
  const el = $("#user-error");
  el.textContent = msg;
  el.hidden = false;
}

async function userReady() {
  $("#user-chip").hidden = false;
  $("#user-chip-name").textContent = "👤 " + meinUser.username;
  await ladePersoenlicheDaten();
  fuelleMeineAuswahlFilter();
  loadPage(); // Tabelle neu rendern, damit Like/Speichern-Buttons erscheinen
}

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

$("#mb-open").addEventListener("click", openMb);
$("#mb-close").addEventListener("click", closeMb);
$("#mb-backdrop").addEventListener("click", closeMb);
$("#mb-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".mb-tab");
  if (!btn) return;
  mbTab = btn.dataset.tab;
  document.querySelectorAll(".mb-tab").forEach((b) => b.classList.toggle("active", b === btn));
  renderMbBody();
});
$("#user-switch").addEventListener("click", () => {
  localStorage.removeItem("radar_user");
  location.reload();
});

/* ---------- Start ---------- */
initGate();
