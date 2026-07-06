// Recherche-Pipeline: holt für jeden Eintrag den Bitcointalk-Thread (OP-Post)
// und extrahiert alle Kategorien. Resumierbar, batch-weise Upserts.
const fs = require('fs');
const path = require('path');

const SUPA = 'https://abeheiewozqbkylmgrqr.supabase.co/rest/v1/casinos';
const KEY = 'sb_publishable_OysS4ElWHUiZNcC5aVdt8g__8LkRzh4';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const STATE_DIR = path.join(__dirname, 'state');
const DELAY_MS = 350;
const FLUSH_EVERY = 400;

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => DELAY_MS + Math.floor(Math.random() * 120);

/* ---------- Hilfen ---------- */
function decode(s) {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:div|p|td|tr|li|ul)>/gi, '\n')
    .replace(/<img[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ' '; } })
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

function sentences(text) {
  return text.split(/[\n.!?]+/).map((s) => s.trim()).filter((s) => s.length >= 15 && s.length <= 400);
}

const CRYPTOS = [
  ['bitcoin', 'BTC'], ['btc', 'BTC'], ['ethereum', 'ETH'], ['eth', 'ETH'], ['tether', 'USDT'], ['usdt', 'USDT'],
  ['litecoin', 'LTC'], ['ltc', 'LTC'], ['dogecoin', 'DOGE'], ['doge', 'DOGE'], ['solana', 'SOL'], ['sol', 'SOL'],
  ['tron', 'TRX'], ['trx', 'TRX'], ['ripple', 'XRP'], ['xrp', 'XRP'], ['monero', 'XMR'], ['xmr', 'XMR'],
  ['usdc', 'USDC'], ['bnb', 'BNB'], ['cardano', 'ADA'], ['bch', 'BCH'], ['dash', 'DASH'], ['ton', 'TON'],
  ['matic', 'MATIC'], ['polygon', 'MATIC'], ['avax', 'AVAX'], ['shiba', 'SHIB'], ['shib', 'SHIB'], ['pepe', 'PEPE'],
];
const LIZENZEN = [
  [/cura[cç]ao/i, 'Curaçao'], [/anjouan/i, 'Anjouan'], [/\bmga\b|malta gaming|licensed in malta/i, 'Malta (MGA)'],
  [/kahnawake/i, 'Kahnawake'], [/costa rica/i, 'Costa Rica'], [/gibraltar/i, 'Gibraltar'],
  [/isle of man/i, 'Isle of Man'], [/panama/i, 'Panama'], [/kanawake/i, 'Kahnawake'],
];
const DOMAIN_BLACKLIST = /bitcointalk|imgur|imgbb|ibb\.co|postimg|prnt\.sc|talkimg|gyazo|tinypic|photobucket|youtube|youtu\.be|twitter|x\.com|t\.me|telegram|discord|facebook|instagram|medium\.com|bit\.ly|goo\.gl|blogspot|wordpress|coinmarketcap|coingecko|google|apple\.com|trustpilot|askgamblers|casino\.guru|casinoguru|reddit|github|mail\.to|gmail|proton|w3\.org|moxtop|redirect|cutt\.ly|tinyurl|linktr/i;
const TLD_RE = /\b([a-z0-9][a-z0-9-]{1,30}\.(?:com|io|net|org|game|games|casino|bet|co|gg|vip|fun|live|app|me|ag|eu|us|uk|xyz|site|club|cash|win|money|plus|one|top|life|world|pro|link|online|space|store|tech|tv|cc|is|to|ws|so|sh|im|fm|la|lol|pw|bz|am|ac|exchange|finance|zone|run|red|blue|gold|black|city|day|now|today|best|cool|ninja|dog|poker|casa))\b/gi;

function extract(opText, row) {
  const t = opText;
  const lower = t.toLowerCase();
  const sents = sentences(t);
  const out = {};
  const restr = {}; // Verfügbarkeits-Restriktionen (separat angewendet, hat Vorrang)

  // Website (nur wenn noch keine bekannt)
  if (!row.website) {
    const counts = {};
    for (const m of lower.matchAll(TLD_RE)) {
      const d = m[1];
      if (DOMAIN_BLACKLIST.test(d)) continue;
      counts[d] = (counts[d] || 0) + 1;
    }
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 2) out.website = best[0];
  }

  // KYC
  const nonKyc = /no[\s-]?kyc|without kyc|kyc[\s-]?free|no verification|anonym/i.test(lower);
  const kycReq = /kyc (?:is )?(?:required|mandatory)|must (?:complete|pass) (?:kyc|verification)|verification (?:is )?required/i.test(lower);
  if (nonKyc) out.kyc = 'Non-KYC';
  else if (kycReq) out.kyc = 'KYC';
  const kycSents = sents.filter((s) => /kyc|verif/i.test(s)).slice(0, 2);
  if (kycSents.length) out.kyc_details = kycSents.join(' | ').slice(0, 300) + ' (laut Thread)';

  // Kryptowährungen
  const found = [];
  for (const [pat, sym] of CRYPTOS) {
    if (new RegExp(`\\b${pat}\\b`, 'i').test(lower) && !found.includes(sym)) found.push(sym);
  }
  const coinsN = lower.match(/(\d{2,4})\+?\s*(?:coins|cryptocurrencies|cryptos)\s*(?:supported|accepted)?/);
  let zahlung = found.slice(0, 15).join(', ');
  if (coinsN) zahlung = (zahlung ? zahlung + ' ' : '') + `(${coinsN[1]}+ Coins laut Thread)`;
  if (zahlung) out.zahlungsmoeglichkeiten = zahlung;

  // Angebot
  const angebot = [];
  const gamesN = lower.match(/([\d.,]+)\s*\+?\s*(?:casino\s+)?(?:games|slots|spiele)/);
  if (/casino/i.test(lower)) angebot.push('Casino');
  if (/slot/i.test(lower)) angebot.push(gamesN ? `Slots (${gamesN[1]}+ laut Thread)` : 'Slots');
  if (/live[\s-]?(?:casino|dealer)/i.test(lower)) angebot.push('Live-Casino');
  if (/poker/i.test(lower)) angebot.push('Poker');
  if (/\bdice\b/i.test(lower)) angebot.push('Dice');
  if (/\bcrash\b/i.test(lower)) angebot.push('Crash');
  if (/roulette/i.test(lower)) angebot.push('Roulette');
  if (/blackjack/i.test(lower)) angebot.push('Blackjack');
  if (/baccarat/i.test(lower)) angebot.push('Baccarat');
  if (/lotter|lotto|raffle/i.test(lower)) angebot.push('Lotterie');
  if (/plinko|mines|keno|bingo|limbo|wheel/i.test(lower)) angebot.push('Minigames');
  if (/provably fair/i.test(lower)) angebot.push('Provably Fair');
  if (angebot.length) out.allgemeines_angebot = angebot.join(', ');

  // Sportwetten
  const sport = /sportsbook|sports betting|sport bets|bet on sports|esports? (?:betting|markets)|thousands of sports/i.test(lower);
  if (sport) {
    out.sportwetten = 'Ja';
    const sportSents = sents.filter((s) => /sport|odds|esport|leagues|markets|football|soccer|tennis|ufc|nba|live bet/i.test(s)).slice(0, 4);
    if (sportSents.length) out.sportwetten_bericht = 'Aus dem Bitcointalk-Thread: ' + sportSents.join(' | ').slice(0, 500);
  } else if (/\bno sportsbook\b/i.test(lower)) {
    out.sportwetten = 'Nein';
  }

  // Registrierung
  const regHints = [];
  if (/no (?:email|e-mail)/i.test(lower)) regHints.push('Keine E-Mail nötig');
  if (/no registration|without (?:an? )?account|no account (?:needed|required)/i.test(lower)) regHints.push('Ohne Registrierung spielbar');
  if (/(?:sign[\s-]?up|register|registration).{0,30}(?:seconds|instant|1[\s-]?click|quick|easy)/i.test(lower)) regHints.push('Sehr schnelle Registrierung (laut Thread)');
  if (/metamask|wallet[\s-]?(?:login|connect)|web3 login/i.test(lower)) regHints.push('Wallet-Login möglich');
  if (nonKyc) regHints.push('Ohne KYC');
  if (regHints.length) out.registrierung_aufwand = regHints.join(', ');

  // Auszahlung
  if (/(?:instant|immediate)[\w\s]{0,25}(?:withdraw|payout|cashout)|withdraw[\w\s]{0,25}instant/i.test(lower)) out.auszahlung_dauer = 'Instant (laut Thread)';
  else {
    const within = lower.match(/withdraw[\w\s]{0,30}within\s+([\w\s]{1,20}?(?:minute|hour|min\b)s?)/i) || lower.match(/within\s+([\w\s]{1,20}?(?:minute|hour|min\b)s?)[\w\s]{0,20}withdraw/i);
    if (within) out.auszahlung_dauer = `Innerhalb ${within[1].trim()} (laut Thread)`;
    else if (/fast (?:crypto )?(?:withdraw|payout)/i.test(lower)) out.auszahlung_dauer = 'Schnell (laut Thread, ohne Zeitangabe)';
  }
  if (/withdraw/i.test(lower) && found.length) out.auszahlung_methoden = found.slice(0, 15).join(', ') + ' (laut Thread)';

  // Kunden-Bewertungen
  const tp = lower.match(/trustpilot[^\d]{0,40}(\d[.,]\d)/);
  if (tp) out.kunden_bewertungen = `Trustpilot ${tp[1]}/5 (laut Thread)`;

  // Spieler-Zahlen
  const pl = t.match(/([\d][\d.,]*\s*(?:k|m|million|thousand)?\+?)\s*(?:active\s+|registered\s+)?(?:players|users|members)/i);
  if (pl) out.spieler_zahlen = pl[0].trim() + ' (laut Thread)';

  // Affiliate / CPA / Revshare
  const aff = /affiliate|referral program|rev[\s-]?share|revenue share|partner program/i.test(lower);
  if (aff) out.affiliate = 'Ja';
  const cpaM = lower.match(/\bcpa\b[^.\n]{0,60}?\$\s?([\d,]{2,6})/) || lower.match(/\$\s?([\d,]{2,6})[^.\n]{0,30}\bcpa\b/);
  if (/\bcpa\b/i.test(lower)) { out.cpa = 'Ja'; out.affiliate = 'Ja'; }
  if (cpaM) out.cpa_hoehe = `$${cpaM[1]} (laut Thread)`;
  const rsM = lower.match(/(?:up to\s*)?(\d{1,2}(?:[.,]\d)?)\s*%[^.\n]{0,40}(?:rev(?:enue)?[\s-]?share|commission|revenue)/) || lower.match(/(?:rev(?:enue)?[\s-]?share|commission)[^%\n]{0,40}?(\d{1,2}(?:[.,]\d)?)\s*%/);
  if (rsM) {
    const val = parseFloat(rsM[1].replace(',', '.'));
    if (val >= 1 && val <= 90) {
      out.revshare_prozent = `${rsM[1]}% (laut Thread)`;
      out.revshare_wert = val;
      out.affiliate = 'Ja';
    }
  }

  // Affiliate-Kontakt
  const kontakt = [];
  const tg = t.match(/t\.me\/([A-Za-z0-9_]{4,32})/) || t.match(/telegram[^\w@]{0,20}@([A-Za-z0-9_]{4,32})/i);
  if (tg) kontakt.push(`Telegram: @${tg[1]}`);
  const dc = t.match(/discord\.gg\/([A-Za-z0-9]{4,20})/);
  if (dc) kontakt.push(`Discord: discord.gg/${dc[1]}`);
  const mails = [...t.matchAll(/([\w.+-]+@[\w-]+\.[a-z.]{2,10})/gi)].map((m) => m[1]).filter((m) => !/example|bitcointalk/i.test(m));
  const affMail = mails.find((m) => /aff|partner/i.test(m)) || mails[0];
  if (affMail) kontakt.push(`E-Mail: ${affMail}`);
  if (kontakt.length) out.affiliate_kontakt = kontakt.slice(0, 3).join(' | ');

  // Lizenz + Betreiberfirma
  for (const [re, name] of LIZENZEN) { if (re.test(lower)) { out.lizenz = name; break; } }
  const op = t.match(/operat(?:ed|or)\s*(?:by|:)?\s*([A-Z][\w\s.,&'-]{2,60}?(?:B\.?\s?V\.?|N\.?\s?V\.?|Ltd\.?|LLC|Limited|Inc\.?|S\.?A\.?|Group(?:\s[A-Z]\.?[A-Z]\.?[A-Z]?\.?)?))(?:[\s,.]|$)/);
  if (op) out.kette_firma = op[1].replace(/\s+/g, ' ').trim().slice(0, 80);

  // Verfügbarkeits-Restriktionen (separat, hat Vorrang)
  for (const s of sents) {
    if (/restrict|not accept|prohibit|exclud|banned|unavailable|blacklist/i.test(s)) {
      if (/germany|deutschland/i.test(s)) restr.verfuegbar_de = 'Nein';
      if (/austria|österreich|osterreich/i.test(s)) restr.verfuegbar_at = 'Nein';
    }
  }

  return { out, restr };
}

/* ---------- Supabase ---------- */
async function fetchAllRows() {
  const rows = [];
  for (let off = 0; ; off += 1000) {
    const res = await fetch(`${SUPA}?select=topic_id,title,thread_url,website,kyc,kyc_details,zahlungsmoeglichkeiten,allgemeines_angebot,sportwetten,sportwetten_bericht,registrierung_aufwand,auszahlung_methoden,auszahlung_dauer,kunden_bewertungen,spieler_zahlen,affiliate,cpa,cpa_hoehe,revshare_prozent,revshare_wert,lizenz,kette_firma,affiliate_kontakt,auto_recherche_am&order=topic_id.asc&limit=1000&offset=${off}`, { headers: { apikey: KEY } });
    if (!res.ok) throw new Error('Rows laden: HTTP ' + res.status);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows;
}

const UPSERT_COLS = ['topic_id','title','thread_url','website','kyc','kyc_details','zahlungsmoeglichkeiten','allgemeines_angebot','sportwetten','sportwetten_bericht','registrierung_aufwand','auszahlung_methoden','auszahlung_dauer','kunden_bewertungen','spieler_zahlen','affiliate','cpa','cpa_hoehe','revshare_prozent','revshare_wert','lizenz','kette_firma','affiliate_kontakt','auto_recherche_am'];

async function upsert(batch) {
  if (!batch.length) return true;
  const res = await fetch(`${SUPA}?on_conflict=topic_id`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(batch),
  });
  if (!res.ok) { console.error('Upsert-Fehler HTTP', res.status, (await res.text()).slice(0, 300)); return false; }
  return true;
}

/* ---------- Merge: neue Werte nur, wenn bisher unbekannt/leer ---------- */
function mergeRow(row, found) {
  const final = {};
  for (const col of UPSERT_COLS) final[col] = row[col] ?? null;
  const isEmpty = (v) => v == null || v === '' || v === 'Unbekannt';
  for (const [col, val] of Object.entries(found)) {
    if (col === 'zahlungsmoeglichkeiten' && row[col] && val) {
      const merged = [...new Set([...String(row[col]).split(/,\s*/), ...String(val).split(/,\s*/)])];
      final[col] = merged.join(', ').slice(0, 300);
    } else if (isEmpty(row[col]) && val != null) {
      final[col] = val;
    }
  }
  final.auto_recherche_am = new Date().toISOString();
  return final;
}

/* ---------- Thread holen ---------- */
async function fetchThread(topicId, attempt = 1) {
  try {
    const res = await fetch(`https://bitcointalk.org/index.php?topic=${topicId}.0`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
    });
    if (res.status === 403 || res.status === 429) {
      fs.appendFileSync(path.join(STATE_DIR, 'ratelimit.log'), `${new Date().toISOString()} HTTP ${res.status} bei ${topicId}\n`);
      await sleep(120000);
      if (attempt <= 3) return fetchThread(topicId, attempt + 1);
      return null;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString('latin1');
  } catch (e) {
    if (attempt <= 3) { await sleep(2000 * attempt); return fetchThread(topicId, attempt + 1); }
    return null;
  }
}

function opFromHtml(html) {
  const start = html.indexOf('<div class="post">');
  if (start === -1) return null;
  let end = html.indexOf('<div class="post">', start + 10);
  const sig = html.indexOf('<div class="signature"', start);
  if (sig !== -1 && (end === -1 || sig < end)) end = sig;
  if (end === -1) end = Math.min(start + 45000, html.length);
  return decode(html.slice(start, end));
}

/* ---------- Hauptschleife ---------- */
(async () => {
  const processedFile = path.join(STATE_DIR, 'processed.json');
  const restrFile = path.join(STATE_DIR, 'restrictions.jsonl');
  const processed = new Set(fs.existsSync(processedFile) ? JSON.parse(fs.readFileSync(processedFile, 'utf8')) : []);

  console.log('Lade aktuelle Daten aus Supabase …');
  const rows = await fetchAllRows();
  const todo = rows.filter((r) => !processed.has(r.topic_id) && !r.auto_recherche_am);
  console.log(`Gesamt: ${rows.length}, bereits erledigt: ${rows.length - todo.length}, offen: ${todo.length}`);

  let buffer = [];
  let done = rows.length - todo.length;
  let failed = 0;

  const flush = async () => {
    if (buffer.length) {
      const ok = await upsert(buffer);
      if (ok) buffer = [];
      else { fs.writeFileSync(path.join(STATE_DIR, 'failed_batch.json'), JSON.stringify(buffer)); buffer = []; }
    }
    fs.writeFileSync(processedFile, JSON.stringify([...processed]));
    fs.writeFileSync(path.join(STATE_DIR, 'research_progress.txt'),
      `${done}/${rows.length} erledigt, ${failed} Fehler, ${new Date().toISOString()}\n`);
  };

  for (const row of todo) {
    const html = await fetchThread(row.topic_id);
    if (html) {
      const op = opFromHtml(html);
      if (op) {
        const { out, restr } = extract(op, row);
        buffer.push(mergeRow(row, out));
        if (Object.keys(restr).length) fs.appendFileSync(restrFile, JSON.stringify({ topic_id: row.topic_id, ...restr }) + '\n');
      } else {
        buffer.push(mergeRow(row, {})); // Thread existiert, aber kein OP parsebar → als recherchiert markieren
      }
      processed.add(row.topic_id);
      done++;
    } else {
      failed++;
      fs.appendFileSync(path.join(STATE_DIR, 'failed_topics.log'), row.topic_id + '\n');
    }
    if (buffer.length >= FLUSH_EVERY) await flush();
    await sleep(jitter());
  }
  await flush();
  fs.writeFileSync(path.join(STATE_DIR, 'research_done.txt'), `FERTIG ${new Date().toISOString()}: ${done}/${rows.length}, Fehler: ${failed}\n`);
  console.log('FERTIG:', done, '/', rows.length, 'Fehler:', failed);
})().catch((e) => {
  fs.appendFileSync(path.join(STATE_DIR, 'research_progress.txt'), 'ABBRUCH: ' + e.message + '\n');
  console.error(e);
  process.exit(1);
});
