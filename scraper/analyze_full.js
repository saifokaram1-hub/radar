// Kombinierter Ein-Durchzug-Lauf pro Thread (replies>=5):
//  - Kommentare auswerten: Note (gesamt/KYC/Auszahlung) + 2 Zusammenfassungen + Zahlungsmethoden + Betragsgrenzen
//  - falls keine Website bekannt: Ersteintrag (OP) holen und Domain nachziehen
// Resumierbar (bewertung_am IS NULL). Meistgesehene zuerst.
const fs = require('fs');
const path = require('path');

const SUPA = 'https://abeheiewozqbkylmgrqr.supabase.co/rest/v1/casinos';
const KEY = 'sb_publishable_OysS4ElWHUiZNcC5aVdt8g__8LkRzh4';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const STATE_DIR = path.join(__dirname, 'state');
const DELAY_MS = 360;
const FLUSH_EVERY = 250;
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decode(s) {
  return s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(?:div|p|td|tr|li)>/gi, '\n').replace(/<img[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ' '; } })
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ');
}
const PAY_NEG = /not paying|won'?t pay|refus(e|ing) to pay|withdrawal[^.\n]{0,30}(problem|stuck|pending|delayed|issue|denied|frozen)|no payout|never (received|got|paid)|confiscat|locked (my )?(account|funds)|selective scam|scam(med)?|stole my|rip[- ]?off|still waiting[^.\n]{0,25}(withdraw|payout|payment)/i;
const PAY_POS = /instant (withdrawal|payout|cashout)|fast (withdrawal|payout|cashout)|got paid|paid (fast|quickly|instantly|within)|payment (received|arrived)|withdrew (fast|instantly|no problem)|withdrawals? (are|is|were) (fast|instant|smooth|quick)|always paid|pays? (out )?(fast|instantly|on time)/i;
const KYC_NEG = /(kyc|verification|verify|selfie|documents?)[^.\n]{0,45}(again|repeat|3rd|third|another time|stuck|hell|nightmare|takes? (weeks|forever)|rejected|denied)|endless (kyc|verification)|kyc (trap|scam)/i;
const KYC_POS = /(kyc|verification)[^.\n]{0,35}(easy|fast|quick|smooth|simple|only once|in minutes|no problem)|passed (kyc|verification) (fast|quickly|easily)|no kyc (asked|needed|required|so far)/i;
const GEN_NEG = /avoid (this|them)|stay away|be ?ware|warning|fraud|dishonest|worst (casino|site)|do ?n.t (deposit|trust|play)/i;
const GEN_POS = /great (casino|site|support)|awesome|best (casino|site)|love (this|it)|recommend(ed)?|trustworthy|reliable|good experience|excellent/i;

const COINS = [['bitcoin', 'BTC'], ['btc', 'BTC'], ['ethereum', 'ETH'], ['eth', 'ETH'], ['litecoin', 'LTC'], ['ltc', 'LTC'], ['tether', 'USDT'], ['usdt', 'USDT'], ['usdc', 'USDC'], ['dogecoin', 'DOGE'], ['doge', 'DOGE'], ['bch', 'BCH'], ['ripple', 'XRP'], ['xrp', 'XRP'], ['tron', 'TRX'], ['trx', 'TRX'], ['solana', 'SOL'], ['\\bsol\\b', 'SOL'], ['bnb', 'BNB'], ['monero', 'XMR'], ['xmr', 'XMR'], ['dash', 'DASH'], ['\\bton\\b', 'TON']];
const TLDS = 'com|io|net|org|game|games|casino|bet|co|gg|vip|fun|live|app|me|ag|eu|xyz|site|club|cash|win|money|one|top|life|world|pro|link|online|space|store|tech|tv|cc|is|to|ws|so|sh|im|fm|la|lol|pw|bz|am|ac|exchange|finance|zone|red|gold|city|poker|casa';
const DOM_BLACK = /bitcointalk|imgur|imgbb|ibb\.co|postimg|prnt\.sc|talkimg|gyazo|tinypic|photobucket|youtube|youtu\.be|twitter|x\.com|t\.me|telegram|discord|facebook|instagram|medium\.com|bit\.ly|goo\.gl|blogspot|wordpress|coinmarketcap|coingecko|google|apple\.com|trustpilot|askgamblers|casino\.guru|reddit|github|gmail|proton|w3\.org|moxtop|redirect|cutt\.ly|tinyurl|linktr|archive\.org|web\.archive/i;
const DOM_RE = new RegExp('([a-z0-9][a-z0-9-]{1,30}\\.(?:' + TLDS + '))\\b', 'gi');

function findeBetrag(sl) {
  const m = sl.match(/([\d][\d.,]*)\s*(btc|eth|ltc|usdt|usdc|usd|dollars?|eur|\$|€|k)\b/i);
  if (!m) return null;
  let z = parseFloat(m[1].replace(/,/g, '')); let e = m[2].toLowerCase();
  if (e === 'k') { z *= 1000; e = 'usd'; }
  if (/dollar/.test(e) || e === '$') e = 'usd';
  if (e === '€') e = 'eur';
  if (!(z > 0) || z > 1e8) return null;
  return { z, e };
}
function medianBetrag(bs) {
  const g = {}; for (const b of bs) (g[b.e] = g[b.e] || []).push(b.z);
  const [e, w] = Object.entries(g).sort((a, b) => b[1].length - a[1].length)[0];
  w.sort((a, b) => a - b); return { z: w[Math.floor(w.length / 2)], e };
}
function fmtBetrag(b) {
  const sym = b.e === 'usd' ? '$' : b.e === 'eur' ? '€' : b.e.toUpperCase();
  return (b.e === 'usd' || b.e === 'eur') ? sym + b.z.toLocaleString('de-AT') : b.z.toLocaleString('de-AT') + ' ' + sym;
}

function analysiere(posts, kycStatus, opText) {
  let payP = 0, payN = 0, kycP = 0, kycN = 0, genP = 0, genN = 0;
  const kycSaetze = [], paySaetze = [], problemBetraege = [], kycBetraege = [];
  const problemArten = {}; const coins = new Set();
  const istKyc = kycStatus === 'KYC';

  for (const p of posts) {
    if (PAY_NEG.test(p)) payN++; if (PAY_POS.test(p)) payP++;
    if (KYC_NEG.test(p)) kycN++; if (KYC_POS.test(p)) kycP++;
    if (GEN_NEG.test(p)) genN++; if (GEN_POS.test(p)) genP++;
    for (const [pat, sym] of COINS) if (new RegExp((pat.startsWith('\\') ? pat : '\\b' + pat + '\\b'), 'i').test(p)) coins.add(sym);
    for (const satz of p.split(/[.!?\n]+/)) {
      const sl = satz.toLowerCase().trim();
      if (sl.length < 8 || sl.length > 240) continue;
      if (/kyc|verif|selfie|document|identit/.test(sl)) {
        if (kycSaetze.length < 6) kycSaetze.push(sl);
        const b = findeBetrag(sl); if (b && /over|above|more than|exceed|when|requir|ask|after|from|threshold/.test(sl)) kycBetraege.push(b);
      }
      if (/withdraw|payout|cash ?out|cashout|payment/.test(sl)) {
        if (paySaetze.length < 8) paySaetze.push(sl);
        if (/stuck|freeze|frozen/.test(sl)) problemArten.haengend = (problemArten.haengend || 0) + 1;
        if (/pending|delay|slow|wait/.test(sl)) problemArten.verzoegert = (problemArten.verzoegert || 0) + 1;
        if (/denied|reject|refus/.test(sl)) problemArten.abgelehnt = (problemArten.abgelehnt || 0) + 1;
        if (/locked|confiscat|frozen account|banned/.test(sl)) problemArten.gesperrt = (problemArten.gesperrt || 0) + 1;
        const b = findeBetrag(sl); if (b && /over|above|more than|exceed|stuck|pending|problem|when|big|large|from|threshold|limit/.test(sl)) problemBetraege.push(b);
      }
    }
  }
  if (opText) for (const [pat, sym] of COINS) if (new RegExp((pat.startsWith('\\') ? pat : '\\b' + pat + '\\b'), 'i').test(opText)) coins.add(sym);

  const note = (pos, neg) => (pos + neg === 0 ? null : Math.round(((pos + 1) / (pos + neg + 2)) * 100) / 10);
  const payNote = note(payP, payN);
  const kycNote = istKyc ? note(kycP, kycN) : null;
  const genNote = note(genP, genN);
  const teile = []; if (payNote != null) teile.push([payNote, 0.5]); if (kycNote != null) teile.push([kycNote, 0.2]); if (genNote != null) teile.push([genNote, 0.3]);
  const gw = teile.reduce((s, [, w]) => s + w, 0);
  const gesamt = teile.length ? Math.round((teile.reduce((s, [n, w]) => s + n * w, 0) / gw) * 10) / 10 : null;

  const problemBetrag = problemBetraege.length ? medianBetrag(problemBetraege) : null;
  const kycBetrag = kycBetraege.length ? medianBetrag(kycBetraege) : null;
  const zahlungsmethoden = coins.size ? [...coins].slice(0, 10).join(', ') : null;

  // Auszahlungs-Betragsgrenze (Kurzform)
  let problemAb;
  if (problemBetrag) problemAb = `Probleme meist ab ca. ${fmtBetrag(problemBetrag)} (aus Kommentaren)`;
  else if (payN > 0) problemAb = 'Probleme erwähnt – Betrag nicht angegeben';
  else problemAb = 'Keine Auszahlungsprobleme in Kommentaren';

  // KYC-Zusammenfassung
  let kycZus;
  if (!istKyc) {
    kycZus = 'Non-KYC-Anbieter – laut Angebot keine Verifizierung nötig. ' + (kycN > 0 ? 'In Kommentaren wird vereinzelt doch von Nachfragen berichtet.' : 'Auch in den Kommentaren keine gegenteiligen Berichte.');
  } else if (kycSaetze.length === 0) {
    kycZus = 'Keine konkreten KYC-Erfahrungen in den ausgewerteten Kommentaren gefunden.';
  } else {
    kycZus = `KYC/Verifizierung wird in ${kycSaetze.length}+ Kommentaren thematisiert (${kycP} positiv, ${kycN} negativ). `;
    kycZus += kycBetrag ? `Verifizierung wird meist ab ca. ${fmtBetrag(kycBetrag)} verlangt. ` : 'Ein konkreter Schwellenbetrag für KYC wird nicht genannt. ';
    kycZus += kycN > kycP ? 'Nutzer berichten teils von wiederholten/mühsamen Verifizierungen.' : kycP > kycN ? 'Die Verifizierung wird überwiegend als machbar beschrieben.' : 'Eine klare Tendenz lässt sich aus den Kommentaren nicht ableiten.';
  }

  // Auszahlungs-Zusammenfassung
  let payZus;
  if (paySaetze.length === 0) {
    payZus = 'Keine konkreten Auszahlungs-Erfahrungen in den ausgewerteten Kommentaren gefunden.';
  } else {
    const artenTxt = Object.entries(problemArten).sort((a, b) => b[1] - a[1]).slice(0, 2)
      .map(([k]) => ({ haengend: 'hängende', verzoegert: 'verzögerte', abgelehnt: 'abgelehnte', gesperrt: 'gesperrte Konten bei' }[k] || k)).join(', ');
    payZus = `Auszahlungen werden in ${paySaetze.length}+ Kommentaren erwähnt (${payP} positiv, ${payN} problematisch). `;
    if (payN === 0) payZus += 'Es werden keine Auszahlungsprobleme berichtet. ';
    else payZus += problemBetrag ? `Probleme treten meist ab ca. ${fmtBetrag(problemBetrag)} auf. ` : 'Ein Schwellenbetrag wird nicht genannt. ';
    if (artenTxt) payZus += `Häufigste Probleme: ${artenTxt} Auszahlungen. `;
    payZus += zahlungsmethoden ? `Zahlungsmittel: ${zahlungsmethoden}.` : '';
  }

  return { gesamt, kycNote, payNote, problemAb, kycZus, payZus, zahlungsmethoden };
}

function findeDomainImOp(opText) {
  const counts = {};
  for (const m of opText.toLowerCase().matchAll(DOM_RE)) {
    const d = m[1]; if (DOM_BLACK.test(d)) continue; counts[d] = (counts[d] || 0) + 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

async function fetchSeite(topicId, offset, v = 1) {
  try {
    const res = await fetch(`https://bitcointalk.org/index.php?topic=${topicId}.${offset}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
    if (res.status === 403 || res.status === 429) { fs.appendFileSync(path.join(STATE_DIR, 'full_ratelimit.log'), `${new Date().toISOString()} ${res.status} ${topicId}\n`); await sleep(120000); if (v <= 3) return fetchSeite(topicId, offset, v + 1); return null; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return Buffer.from(await res.arrayBuffer()).toString('latin1');
  } catch { if (v <= 3) { await sleep(1800 * v); return fetchSeite(topicId, offset, v + 1); } return null; }
}
function postsAusHtml(html, opUeberspringen) {
  const teile = html.split('<div class="post">').slice(1);
  const posts = teile.map((t) => { let e = t.indexOf('<div class="signature"'); if (e === -1) e = Math.min(t.length, 12000); return decode(t.slice(0, e)).slice(0, 4000); });
  return opUeberspringen ? posts.slice(1) : posts;
}

async function holeOffene() {
  const rows = [];
  for (let off = 0; ; off += 1000) {
    const res = await fetch(`${SUPA}?select=topic_id,nummer,title,thread_url,replies,kyc,website&replies=gte.5&bewertung_am=is.null&order=views.desc.nullslast&limit=1000&offset=${off}`, { headers: { apikey: KEY } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const b = await res.json(); rows.push(...b); if (b.length < 1000) break;
  }
  return rows;
}
async function upsert(batch) {
  if (!batch.length) return true;
  const res = await fetch(`${SUPA}?on_conflict=topic_id`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(batch) });
  if (!res.ok) { console.error('Upsert HTTP', res.status, (await res.text()).slice(0, 300)); return false; }
  return true;
}

module.exports = { analysiere, findeDomainImOp, fetchSeite, postsAusHtml };
if (require.main !== module) return;

(async () => {
  const offene = await holeOffene();
  console.log('Zu analysieren:', offene.length);
  let buffer = [], done = 0, fehler = 0, neueDomains = 0;
  const flush = async () => {
    if (buffer.length) { if (await upsert(buffer)) buffer = []; else { fs.writeFileSync(path.join(STATE_DIR, 'full_failed.json'), JSON.stringify(buffer)); buffer = []; } }
    fs.writeFileSync(path.join(STATE_DIR, 'full_progress.txt'), `${done}/${offene.length}, Fehler ${fehler}, neue Domains ${neueDomains}, ${new Date().toISOString()}\n`);
  };

  for (const row of offene) {
    const posts = [];
    const lastOff = Math.floor(row.replies / 20) * 20;
    const h1 = await fetchSeite(row.topic_id, lastOff);
    if (h1) posts.push(...postsAusHtml(h1, lastOff === 0));
    await sleep(DELAY_MS);
    if (posts.length < 25 && lastOff >= 20) { const h2 = await fetchSeite(row.topic_id, lastOff - 20); if (h2) posts.unshift(...postsAusHtml(h2, lastOff - 20 === 0)); await sleep(DELAY_MS); }

    // OP nur holen, wenn Website fehlt (Domain nachziehen) – sonst spare Requests
    let neueWebsite = null, opText = '';
    if (!row.website) {
      const hop = lastOff === 0 && h1 ? h1 : await fetchSeite(row.topic_id, 0);
      if (hop) { const opPosts = postsAusHtml(hop, false); opText = opPosts[0] || ''; const d = findeDomainImOp(opText); if (d) { neueWebsite = d; neueDomains++; } }
      if (lastOff !== 0) await sleep(DELAY_MS);
    }

    if (posts.length || opText) {
      const a = analysiere(posts, row.kyc, opText);
      const rec = {
        topic_id: row.topic_id, nummer: row.nummer, title: row.title, thread_url: row.thread_url,
        bewertung_gesamt: a.gesamt, bewertung_kyc: a.kycNote, bewertung_auszahlung: a.payNote,
        auszahlung_problem_ab: a.problemAb, kyc_zusammenfassung: a.kycZus, auszahlung_zusammenfassung: a.payZus,
        zahlungsmethoden_komm: a.zahlungsmethoden, bewertung_kommentare: posts.length, bewertung_am: new Date().toISOString(),
      };
      if (neueWebsite) rec.website = neueWebsite; // neue Domain -> Website-Check später
      buffer.push(rec);
      done++;
    } else { fehler++; fs.appendFileSync(path.join(STATE_DIR, 'full_failed_topics.log'), row.topic_id + '\n'); }
    if (buffer.length >= FLUSH_EVERY) await flush();
    await sleep(DELAY_MS);
  }
  await flush();
  fs.writeFileSync(path.join(STATE_DIR, 'full_done.txt'), `FERTIG ${new Date().toISOString()}: ${done} analysiert, ${fehler} Fehler, ${neueDomains} neue Domains\n`);
  console.log('FERTIG:', done, 'Fehler', fehler, 'neue Domains', neueDomains);
})().catch((e) => { console.error(e); process.exit(1); });
