// Website-Prüfer: testet jede eingetragene Casino-Domain auf Erreichbarkeit.
// Online  -> verfuegbar_at='Ja' (Verbindung aus Österreich), website_status='Online'
// Offline -> verfuegbar_at='Nein', verfuegbar_de='Nein', website_status='Offline'
// Füllt Verfügbarkeits-Felder nur, wenn sie noch 'Unbekannt' sind.
const fs = require('fs');
const path = require('path');

const SUPA = 'https://abeheiewozqbkylmgrqr.supabase.co/rest/v1/casinos';
const KEY = 'sb_publishable_OysS4ElWHUiZNcC5aVdt8g__8LkRzh4';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const STATE_DIR = path.join(__dirname, 'state');
const CONCURRENCY = 12;
const TIMEOUT_MS = 9000;

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR);

async function fetchRows() {
  const rows = [];
  for (let off = 0; ; off += 1000) {
    const res = await fetch(`${SUPA}?select=topic_id,nummer,title,thread_url,website,verfuegbar_at,verfuegbar_de,website_status&website=not.is.null&order=topic_id.asc&limit=1000&offset=${off}`, { headers: { apikey: KEY } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const b = await res.json();
    rows.push(...b);
    if (b.length < 1000) break;
  }
  return rows;
}

async function probe(domain) {
  for (const proto of ['https://', 'http://']) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(proto + domain + '/', {
        method: 'GET', redirect: 'follow', signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
      });
      clearTimeout(timer);
      // 2xx/3xx = online; 401/403/429/503 mit Antwort = Server existiert (oft Bot-Schutz) -> Online
      if (res.status < 500 || res.status === 503) return 'Online';
      return 'Offline';
    } catch {
      clearTimeout(timer);
    }
  }
  return 'Offline';
}

(async () => {
  const doneFile = path.join(STATE_DIR, 'websites_done.json');
  const done = new Map(fs.existsSync(doneFile) ? JSON.parse(fs.readFileSync(doneFile, 'utf8')) : []);

  const rows = await fetchRows();
  // Pro Domain nur einmal prüfen
  const domains = [...new Set(rows.map((r) => r.website))].filter((d) => !done.has(d));
  console.log(`Zeilen mit Website: ${rows.length}, einzigartige Domains offen: ${domains.length}`);

  let checked = 0;
  const worker = async () => {
    while (domains.length) {
      const d = domains.shift();
      const status = await probe(d);
      done.set(d, status);
      checked++;
      if (checked % 50 === 0) {
        fs.writeFileSync(doneFile, JSON.stringify([...done]));
        fs.writeFileSync(path.join(STATE_DIR, 'websites_progress.txt'), `${done.size} Domains geprüft, ${new Date().toISOString()}\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  fs.writeFileSync(doneFile, JSON.stringify([...done]));

  // Ergebnisse anwenden (Batch-Upsert; Verfügbarkeit nur füllen, wenn Unbekannt)
  // Klare Regel: erreichbar = in DE/AT verfügbar (Ja), tot = Nein.
  // Eine im Thread belegte Länder-Sperre (verfuegbar_de='Nein') bleibt erhalten.
  const updates = rows.map((r) => {
    const status = done.get(r.website);
    if (!status) return null;
    return {
      topic_id: r.topic_id, nummer: r.nummer, title: r.title, thread_url: r.thread_url,
      website_status: status,
      verfuegbar_at: status === 'Online' ? 'Ja' : 'Nein',
      verfuegbar_de: status === 'Online' ? (r.verfuegbar_de === 'Nein' ? 'Nein' : 'Ja') : 'Nein',
    };
  }).filter(Boolean);

  let ok = 0;
  for (let i = 0; i < updates.length; i += 500) {
    const res = await fetch(`${SUPA}?on_conflict=topic_id`, {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(updates.slice(i, i + 500)),
    });
    if (res.ok) ok += Math.min(500, updates.length - i);
    else console.error('Upsert HTTP', res.status, (await res.text()).slice(0, 200));
  }
  const online = [...done.values()].filter((v) => v === 'Online').length;
  fs.writeFileSync(path.join(STATE_DIR, 'websites_report.txt'),
    `FERTIG ${new Date().toISOString()}: ${done.size} Domains geprüft, ${online} online, ${done.size - online} offline, ${ok} Zeilen aktualisiert\n`);
  console.log('FERTIG:', done.size, 'Domains,', online, 'online,', ok, 'Zeilen aktualisiert');
})().catch((e) => { console.error(e); process.exit(1); });
