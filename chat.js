/* Recherche-Chat: beantwortet Fragen direkt aus der Casino-Datenbank (regelbasiert, ohne externe KI) */

const chatCache = new Map(); // id -> vollständiger Datensatz (für Klick → Detail)

function chatAdd(kind, html) {
  const box = $("#chat-messages");
  const d = document.createElement("div");
  d.className = "chat-msg " + kind;
  d.innerHTML = html;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
  // klickbare Ergebnis-Einträge verdrahten
  d.querySelectorAll(".chat-entry[data-id]").forEach((el) => {
    el.addEventListener("click", () => {
      const rec = chatCache.get(el.dataset.id);
      if (rec && typeof openDrawer === "function") openDrawer(rec);
    });
  });
  d.querySelectorAll(".chat-sugg").forEach((el) => {
    el.addEventListener("click", () => { $("#chat-input").value = el.textContent; chatSend(); });
  });
}

function chatEntryHtml(r) {
  chatCache.set(r.id, r);
  const site = r.website ? `<b>${esc(r.website)}</b> · ` : "";
  const infos = [`Bekanntheit ${r.bekanntheits_score ?? "–"}`];
  if (r.kyc) infos.push(esc(r.kyc));
  infos.push((r.verfuegbar_de === "Ja" ? "DE ✓" : "DE ✗") + " / " + (r.verfuegbar_at === "Ja" ? "AT ✓" : "AT ✗"));
  if (r.sportwetten === "Ja") infos.push("Sportwetten");
  if (r.revshare_wert != null) infos.push(`Revshare ${r.revshare_wert}%`);
  else if (r.affiliate === "Ja") infos.push("Affiliate (Satz verhandeln)");
  if (r.cpa_wert != null) infos.push(`CPA $${r.cpa_wert}`);
  else if (r.cpa === "Ja") infos.push("CPA möglich");
  return `<span class="chat-entry" data-id="${r.id}">#${r.nummer} · ${site}${esc((r.title || "").slice(0, 60))}<br><span style="color:var(--text-dim);font-size:0.78rem">${infos.join(" · ")}</span></span>`;
}

// parseWunsch-Ausgabe (aus app.js) in PostgREST-Parameter umsetzen
function chatBuildParams(parsed) {
  const p = new URLSearchParams();
  for (const [col, val] of Object.entries(parsed.filters || {})) if (val) p.append(col, `eq.${val}`);
  for (const [col, cond] of parsed.extra || []) p.append(col, cond);
  if ((parsed.groups || []).length) p.append("and", `(${parsed.groups.join(",")})`);
  return p;
}

async function chatCount(params) {
  const res = await fetch(`${API}?${params}&select=id&limit=1`, { method: "HEAD", headers: { ...HEADERS, Prefer: "count=exact" } });
  const range = res.headers.get("content-range");
  return range ? parseInt(range.split("/")[1], 10) || 0 : 0;
}

async function chatExamples(params, sort, n = 5) {
  const q = new URLSearchParams(params);
  q.append("select", "*");
  q.append("order", sort || "bekanntheits_score.desc.nullslast");
  q.append("limit", n);
  const res = await fetch(`${API}?${q}`, { headers: HEADERS });
  return res.ok ? res.json() : [];
}

async function chatAnswer(frage) {
  const text = frage.trim();
  const lower = text.toLowerCase();

  // 1) Nummer-Lookup: "nr 5", "nummer 100", "zeig 38", oder reine Zahl
  const nrM = text.match(/(?:nr\.?|nummer|eintrag|#)\s*(\d{1,6})/i) || text.match(/^\s*(\d{1,6})\s*$/);
  if (nrM) {
    const nr = nrM[1];
    const res = await fetch(`${API}?nummer=eq.${nr}&select=*`, { headers: HEADERS });
    const rows = await res.json();
    if (rows.length) {
      const r = rows[0];
      const partner = r.kette_partner ? `<br>🔗 <b>Verbunden mit:</b> ${esc(r.kette_partner)}` : "";
      return chatAdd("bot", `Das ist <b>Nr. ${r.nummer}</b>:<br>${chatEntryHtml(r)}<br><br>` +
        `<b>Website:</b> ${esc(r.website || "–")}<br><b>KYC:</b> ${esc(r.kyc)} · <b>Sportwetten:</b> ${esc(r.sportwetten)} · <b>Verfügbar AT:</b> ${esc(r.verfuegbar_at)}<br>` +
        `<b>Angebot:</b> ${esc(r.allgemeines_angebot)}<br><b>Affiliate:</b> ${esc(r.affiliate)} · <b>Revshare:</b> ${esc(r.revshare_prozent)} · <b>CPA:</b> ${esc(r.cpa)}${r.cpa_wert != null ? ` ($${r.cpa_wert})` : ""}${partner}<br><br>` +
        `<span style="color:var(--text-dim)">Klick oben für alle Details.</span>`);
    }
    return chatAdd("bot", `Ich habe keinen Eintrag mit der Nummer ${nr} gefunden. Die Nummern gehen von 1 bis 11.886.`);
  }

  // 2) Hilfe
  if (/^(hilfe|help|was kannst du|hallo|hi|hey)\b/.test(lower)) {
    return chatAdd("bot", "Ich durchsuche alle 11.886 Casinos für dich. Frag mich z.B.:" +
      `<div class="chat-suggestions">
        <span class="chat-sugg">Wie viele Non-KYC mit Sportwetten?</span>
        <span class="chat-sugg">Zeig Nr. 1</span>
        <span class="chat-sugg">Casinos mit Revshare ab 30%</span>
        <span class="chat-sugg">Welche gehören zu einer Kette?</span>
        <span class="chat-sugg">Non-KYC in Österreich verfügbar</span>
      </div>`);
  }

  // 3) Ketten-Frage
  if (/kette|schwester|tochter|verbund|gehören zu|zusammen|gleiche firma/.test(lower)) {
    const anzahl = await chatCount(new URLSearchParams({ kette: "eq.Ja" }));
    const bsp = await chatExamples(new URLSearchParams({ kette: "eq.Ja" }));
    return chatAdd("bot", `<b>${anzahl}</b> Einträge gehören zu einer Kette (mehrere Seiten derselben Firma). Beispiele – klick für die verbundenen Seiten:<br>` +
      bsp.map(chatEntryHtml).join("<br>"));
  }

  // 4) Gesamtzahl
  if (/wie viele (einträge|casinos|gibt|insgesamt|total)|gesamt|insgesamt/.test(lower) && !/(kyc|sport|affiliate|cpa|kette|österreich|deutschland|online)/.test(lower)) {
    return chatAdd("bot", "Insgesamt sind <b>11.886</b> Casinos/Threads erfasst – jeder mit einer festen Nummer von 1 bis 11.886.");
  }

  // 5) Wunsch/Filter-Frage → parseWunsch (aus app.js) nutzen
  let parsed = null;
  try { parsed = parseWunsch(text); } catch { parsed = null; }
  if (parsed && parsed.chips && parsed.chips.length) {
    const params = chatBuildParams(parsed);
    const anzahl = await chatCount(params);
    if (anzahl === 0) {
      return chatAdd("bot", `Zu <b>${parsed.chips.join(" · ")}</b> habe ich <b>keine</b> Treffer gefunden.`);
    }
    const bsp = await chatExamples(params, parsed.sort);
    return chatAdd("bot", `Ich habe <b>${anzahl.toLocaleString("de-AT")}</b> Treffer für <b>${parsed.chips.join(" · ")}</b>.<br>` +
      `Die bekanntesten:<br>` + bsp.map(chatEntryHtml).join("<br>"));
  }

  // 6) Fallback: Freitext-Suche in Titel/Website
  const q = lower.replace(/[,()*]/g, " ").trim().split(/\s+/).filter((w) => w.length >= 3).slice(0, 3);
  if (q.length) {
    const groups = q.map((w) => `or(title.ilike.*${w}*,website.ilike.*${w}*)`);
    const params = new URLSearchParams();
    params.append("and", `(${groups.join(",")})`);
    const anzahl = await chatCount(params);
    if (anzahl) {
      const bsp = await chatExamples(params);
      return chatAdd("bot", `Ich habe <b>${anzahl.toLocaleString("de-AT")}</b> passende Einträge gefunden:<br>` + bsp.map(chatEntryHtml).join("<br>"));
    }
  }
  return chatAdd("bot", "Das habe ich nicht ganz verstanden. Versuch es z.B. mit „Wie viele Non-KYC mit Sportwetten?“, „Zeig Nr. 10“ oder tippe <b>Hilfe</b>.");
}

async function chatSend() {
  const input = $("#chat-input");
  const frage = input.value.trim();
  if (!frage) return;
  chatAdd("user", esc(frage));
  input.value = "";
  const denk = document.createElement("div");
  denk.className = "chat-msg bot";
  denk.textContent = "…";
  $("#chat-messages").appendChild(denk);
  $("#chat-messages").scrollTop = $("#chat-messages").scrollHeight;
  try {
    await chatAnswer(frage);
  } catch (e) {
    chatAdd("bot", "Fehler bei der Suche: " + esc(e.message));
  } finally {
    denk.remove();
  }
}

let chatBegruesst = false;
function openChat() {
  $("#chat-panel").hidden = false;
  $("#chat-backdrop").hidden = false;
  if (!chatBegruesst) {
    chatBegruesst = true;
    chatAdd("bot", "👋 Hi! Ich bin dein Recherche-Chat und kenne alle <b>11.886</b> Casinos. Frag mich etwas:" +
      `<div class="chat-suggestions">
        <span class="chat-sugg">Wie viele Non-KYC mit Sportwetten?</span>
        <span class="chat-sugg">Zeig Nr. 1</span>
        <span class="chat-sugg">Revshare ab 30%</span>
        <span class="chat-sugg">Welche gehören zu einer Kette?</span>
      </div>`);
  }
  $("#chat-input").focus();
}
function closeChat() {
  $("#chat-panel").hidden = true;
  $("#chat-backdrop").hidden = true;
}

$("#chat-open")?.addEventListener("click", openChat);
$("#chat-close")?.addEventListener("click", closeChat);
$("#chat-backdrop")?.addEventListener("click", closeChat);
$("#chat-send")?.addEventListener("click", chatSend);
$("#chat-input")?.addEventListener("keydown", (e) => { if (e.key === "Enter") chatSend(); });
