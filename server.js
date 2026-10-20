/**
 * wa-inbox backend (multi-user)
 * Every user signs in with their own account and gets their own WhatsApp session (WPPConnect),
 * chats, events and API key. Nothing is shared between users.
 *
 * NOTE: each linked user runs one headless Chrome (roughly 300-500 MB RAM each). MAX_CLIENTS caps it.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000); // SERVER_PORT: game-panel hosts (Pterodactyl) assign the port this way
const HOST = process.env.HOST || '0.0.0.0'; // reachable from other devices on your network
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const ALLOW_SIGNUP = process.env.ALLOW_SIGNUP !== 'false';
const MAX_USERS = Number(process.env.MAX_USERS || 20);
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS || 5);
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const START_GAP_MS = Number(process.env.START_GAP_MS || 4000);
const NO_WA = process.env.NO_WHATSAPP === '1'; // testing the accounts without launching Chrome
fs.mkdirSync(DATA, { recursive: true });

/* ------------------------------------------------------------ accounts */
const USERS_FILE = path.join(DATA, 'users.json');
const SESSIONS_FILE = path.join(DATA, 'sessions.json');
let users = {};
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch {}
const saveUsers = () => { fs.writeFileSync(USERS_FILE + '.tmp', JSON.stringify(users)); fs.renameSync(USERS_FILE + '.tmp', USERS_FILE); };
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/* Sessions live on the server, one per signed-in device. Only a hash of the token is stored.
   This is what lets the same user be signed in on several devices at once, see them, and sign any of them out. */
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch {}
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
let saveTimer = null;
const saveSessions = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { fs.writeFileSync(SESSIONS_FILE + '.tmp', JSON.stringify(sessions), { mode: 0o600 }); fs.renameSync(SESSIONS_FILE + '.tmp', SESSIONS_FILE); }, 500);
};
const SESSION_MS = SESSION_DAYS * 864e5;
function deviceLabel(ua = '') {
  const os_ = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} on ${os_}`;
}
const cookieOf = (req, k) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([n]) => n === k)?.[1];
const tokenOf = (req) => cookieOf(req, 'wa_token') || (req.headers.authorization || '').replace(/^Bearer /, '');
function sessionOf(req) {
  const tok = tokenOf(req);
  if (!tok) return null;
  const id = sha(tok), ses = sessions[id], now = Date.now();
  if (!ses) return null;
  if (now - ses.last > SESSION_MS || !users[ses.user]) { delete sessions[id]; saveSessions(); return null; }
  if (now - ses.last > 60000) { ses.last = now; ses.ip = req.ip; saveSessions(); } // sliding expiry, written at most once a minute
  return { id, ...ses };
}
function userOf(req) {
  const ses = sessionOf(req);
  if (ses) { req.session = ses; return ses.user; }
  const key = req.headers['x-api-key'];
  if (key) for (const [n, u] of Object.entries(users)) if (safeEq(u.apiKey, key)) return n;
  return null;
}
function startSession(req, res, name) {
  const token = crypto.randomBytes(32).toString('hex'), now = Date.now();
  sessions[sha(token)] = { user: name, created: now, last: now, ua: String(req.headers['user-agent'] || '').slice(0, 300), ip: req.ip };
  saveSessions();
  const secure = process.env.COOKIE_SECURE === 'true' || (process.env.COOKIE_SECURE !== 'false' && req.secure);
  res.set('Set-Cookie', `wa_token=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure ? '; Secure' : ''}`);
}
function endSessions(pred) { // returns ids removed
  const gone = [];
  for (const [id, s_] of Object.entries(sessions)) if (pred(id, s_)) { delete sessions[id]; gone.push(id); }
  if (gone.length) saveSessions();
  return gone;
}
setInterval(() => { endSessions((_, s_) => Date.now() - s_.last > SESSION_MS); }, 3600e3).unref();

/* Login throttle: counts FAILED attempts only, per IP+username, so many people behind one office/home
   router are not locked out by each other. */
const fails = new Map();
const failKey = (req, name) => `${req.ip}|${name}`;
const isLocked = (req, name) => { const t = (fails.get(failKey(req, name)) || []).filter((x) => Date.now() - x < 60000); fails.set(failKey(req, name), t); return t.length >= 8; };
const noteFail = (req, name) => { const k = failKey(req, name); fails.set(k, [...(fails.get(k) || []), Date.now()]); };
setInterval(() => { const now = Date.now(); for (const [k, v] of fails) if (!v.some((x) => now - x < 60000)) fails.delete(k); }, 60000).unref();
const regTries = new Map(); // sign-ups per IP
function regThrottled(req) {
  const now = Date.now(), t = (regTries.get(req.ip) || []).filter((x) => now - x < 3600e3);
  t.push(now); regTries.set(req.ip, t);
  return t.length > 10;
}

const app = express();
// Behind a reverse proxy / tunnel set TRUST_PROXY=1 (hops) so client IPs and https are detected correctly.
const TP = process.env.TRUST_PROXY;
app.set('trust proxy', TP === undefined || TP === 'false' ? false : /^\d+$/.test(TP) ? Number(TP) : TP === 'true' ? 1 : TP);
const smallJson = express.json({ limit: '10kb' });   // sign-in routes: tiny bodies only
const bigJson = express.json({ limit: '60mb' });     // file uploads: signed-in users only

/* ---- CORS: lets your inventory app (a different origin) talk to this connector.
   Allowed by default: any http://localhost / http://127.0.0.1 page.
   Add your hosted inventory URL with  ALLOW_ORIGIN=https://your-app.web.app  (comma separated). */
const ALLOW = (process.env.ALLOW_ORIGIN || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o) {
    let sameOrigin = false;
    try { sameOrigin = new URL(o).host === req.headers.host; } catch {}
    const ok = sameOrigin || ALLOW.includes('*') || ALLOW.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
    if (ok) {
      res.set('Access-Control-Allow-Origin', o);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
      res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.set('Access-Control-Allow-Private-Network', 'true');
    } else if (req.method !== 'GET' || req.path.startsWith('/api/')) {
      if (req.method === 'OPTIONS') return res.status(403).end();
      if (req.path.startsWith('/api/') && req.path !== '/api/events') return res.status(403).json({ error: 'Origin not allowed. Set ALLOW_ORIGIN=' + o });
    }
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function serializeMessage(m) {
  const chatId = m.chatId?._serialized || m.chatId || (m.fromMe ? m.to : m.from);
  const isText = m.type === 'chat' || m.type === undefined;
  return {
    id: m.id?._serialized || m.id,
    chatId: typeof chatId === 'object' ? chatId?._serialized : chatId,
    fromMe: !!m.fromMe || !!m.id?.fromMe,
    type: m.type || 'chat',
    body: isText ? m.body || '' : m.caption || '',
    t: m.t || m.timestamp || Math.floor(Date.now() / 1000),
    ack: typeof m.ack === 'number' ? m.ack : 0,
    sender: m.notifyName || m.sender?.pushname || m.sender?.name || '',
    author: m.author?._serialized || m.author || null,
    mimetype: m.mimetype || null,
    filename: m.filename || null,
    hasMedia: !isText && ['image', 'video', 'audio', 'ptt', 'document', 'sticker'].includes(m.type),
    quoted: m.quotedMsg
      ? { body: m.quotedMsg.body && m.quotedMsg.type === 'chat' ? m.quotedMsg.body : `[${m.quotedMsg.type}]` }
      : null,
  };
}

function serializeChat(c) {
  const id = c.id?._serialized || c.id;
  const contact = c.contact || {};
  return {
    id,
    name: c.name || contact.name || contact.pushname || contact.formattedName || numberOf(id),
    isGroup: !!c.isGroup,
    unread: c.unreadCount || 0,
    t: c.t || 0,
    pinned: !!c.pin,
    muted: !!c.muteExpiration,
  };
}

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]).catch(() => null);
      }
    })
  );
  return out;
}


app.use(express.static(path.join(__dirname, 'public')));

/* ---------------------------------------------------- per-user sessions */
const ctxs = new Map(); // username -> context
let nextSlot = 0;
const numberOf = (id = '') => String(id).split('@')[0];
const sessionName = (name) => 'u' + crypto.createHash('sha256').update(name).digest('hex').slice(0, 16);

function ctxFor(name) {
  let c = ctxs.get(name);
  if (!c) {
    c = { name, state: { status: 'idle', detail: '', qr: null, code: null, me: null },
      lastMsg: new Map(), picCache: new Map(), subs: new Set(), client: null, started: false, gen: 0, browser: null };
    ctxs.set(name, c);
  }
  return c;
}
const pub = (c) => ({ status: c.state.status, detail: c.state.detail, qr: c.state.qr, code: c.state.code, me: c.state.me, saved: hasSaved(c) });
function emit(c, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of c.subs) res.write(payload);
}
function setStatus(c, status, detail = '') {
  c.state.status = status; c.state.detail = detail;
  if (status !== 'qr') { c.state.qr = null; c.state.code = null; }
  emit(c, 'status', pub(c));
}
function kickSessions(ids) { // close live streams of signed-out devices
  if (!ids.length) return;
  for (const c of ctxs.values()) for (const r of [...c.subs]) if (r.sid && ids.includes(r.sid)) { try { r.write('event: signedout\ndata: {}\n\n'); r.end(); } catch {} c.subs.delete(r); }
}
const sessDir = (c) => path.join(__dirname, 'tokens', sessionName(c.name));
// A WhatsApp login is remembered once it connected (.linked). Folders from older versions have neither marker and count as linked.
// A folder with only .pending is an unfinished link attempt and is never auto-started.
const hasSaved = (c) => fs.existsSync(path.join(sessDir(c), '.linked')) || (fs.existsSync(sessDir(c)) && !fs.existsSync(path.join(sessDir(c), '.pending')));
/* WhatsApp Web changes every few days and can break the phone-number link ("Minified invariant" errors).
   We load a fixed build that matches the installed WA-JS. Set WA_VERSION=latest to follow WhatsApp's newest build, or another build name. */
const WA_VERSION = process.env.WA_VERSION || '2.3000.1050469598-alpha';
const DEFAULT_CC = String(process.env.DEFAULT_COUNTRY_CODE || '').replace(/\D/g, ''); // e.g. 27 for South Africa
/* WhatsApp needs the number in international format with no leading 0 / 00 / +. Returns digits or null. */
function intlNumber(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) { if (!DEFAULT_CC) return null; d = DEFAULT_CC + d.slice(1); }
  return d.length >= 8 && d.length <= 15 ? d : null;
}
const activeCount = () => [...ctxs.values()].filter((c) => c.started).length;

function ensureStarted(c, opts = {}) {
  if (c.started || NO_WA) return;
  if (activeCount() >= MAX_CLIENTS) { setStatus(c, 'error', 'The server is at capacity. Try again later.'); return; }
  c.started = true;
  const gen = ++c.gen;
  const now = Date.now();
  const delay = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + START_GAP_MS; // stagger browser launches
  setStatus(c, 'starting', 'Launching browser…');
  setTimeout(() => { if (gen === c.gen) startWhatsApp(c, gen, opts); }, delay);
}

/* We launch the browser ourselves (same stealth setup WPPConnect uses) so we can close it at any moment:
   cancel linking, switch between QR and phone-number linking, or sign out, from any device. */
async function launchBrowser(session) {
  const puppeteer = require('puppeteer-extra');
  puppeteer.use(require('puppeteer-extra-plugin-stealth')());
  const dir = path.join(__dirname, 'tokens', session);
  const fresh = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  if (fresh) fs.writeFileSync(path.join(dir, '.pending'), ''); // unfinished until WhatsApp connects
  return puppeteer.launch({ headless: true, userDataDir: dir, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
}

function makeLogger(c, live) {
  const txt = (m) => String(m?.message || m || '');
  const handle = (level, m) => {
    const t = txt(m);
    if (level === 'error' || level === 'warn') console.error(`[${c.name}] wpp ${level}:`, t);
    if (level === 'error' && live() && c.state.status !== 'connected' && /login by code|link.?device|link code|phone/i.test(t))
      setStatus(c, 'error', /invariant/i.test(t)
        ? 'WhatsApp Web changed internally and could not make a link code (' + t + '). Press Show QR code instead, or try again later / set WA_VERSION on the server.'
        : 'WhatsApp refused the phone-number link: ' + t + ' Check the number (country code, no leading 0) or use the QR code.');
  };
  const lg = { log: (o) => handle(o.level, o.message) };
  for (const l of ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']) lg[l] = (m) => handle(l, m);
  return lg;
}

async function startWhatsApp(c, gen, opts = {}) {
  const wppconnect = require('@wppconnect-team/wppconnect');
  const session = sessionName(c.name);
  const live = () => gen === c.gen;
  let browser = null;
  try {
    browser = await launchBrowser(session);
    c.browser = browser;
    if (!live()) { await browser.close().catch(() => {}); return; }
    const phone = opts.phone ? String(opts.phone) : undefined;
    /* Ask WhatsApp for the 8-character link code. WPPConnect asks the moment the page loads, before WhatsApp's login
       screen is ready, which makes WhatsApp fail with "Minified invariant". We wait for the login screen and retry. */
    let codeStarted = false;
    const CODE_MSG = 'On your phone: WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead, then type this code';
    async function requestCode() {
      if (codeStarted) return; codeStarted = true;
      let lastErr = '';
      try {
        const page = (await browser.pages()).find((p) => /web\.whatsapp\.com/.test(p.url())) || (await browser.pages())[0];
        await page.exposeFunction('__waLinkCode', (code) => { if (live()) { c.state.code = code; setStatus(c, 'qr', CODE_MSG); } }).catch(() => {});
        await page.exposeFunction('__waLinkExpired', () => { if (live() && c.state.status !== 'connected') setStatus(c, 'error', 'The code expired. Press Get code again.'); }).catch(() => {});
        for (let attempt = 1; attempt <= 6 && live(); attempt++) {
          try {
            const code = await page.evaluate(async (num) => {
              if (!window.__waHooked) {
                window.__waHooked = true;
                WPP.on('conn.link_code_change', (cd) => window.__waLinkCode(cd));      // refreshed codes
                WPP.on('conn.link_code_expired', () => window.__waLinkExpired());
              }
              try { WPP.conn.cancelLinkDeviceCode(); } catch (e) {}
              return await WPP.conn.startLinkDeviceCodeForPhoneNumber(num);
            }, phone);
            if (code && live()) { c.state.code = code; setStatus(c, 'qr', CODE_MSG); }
            return;
          } catch (e) {
            lastErr = String(e?.message || e);
            console.error(`[${c.name}] link code attempt ${attempt} failed:`, lastErr);
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
      } catch (e) { lastErr = String(e?.message || e); }
      if (live() && c.state.status !== 'connected' && !c.state.code)
        setStatus(c, 'error', /invariant/i.test(lastErr)
          ? 'WhatsApp could not make a link code (' + lastErr + '). Check the number is registered on WhatsApp, or press Show QR code instead.'
          : 'WhatsApp refused the phone-number link: ' + lastErr + ' Check the number (country code, no leading 0) or use the QR code.');
    }
    let watchdog = null;
    if (phone) watchdog = setTimeout(() => { if (live() && !c.state.code && c.state.status !== 'connected' && c.state.status !== 'error') setStatus(c, 'error', 'WhatsApp did not return a link code. Check the number includes the country code (no leading 0), or use the QR code.'); }, 90000);
    const client = await wppconnect.create({
      session, browser, headless: true, autoClose: 0, logQR: false, disableWelcome: true, updatesLog: false,
      folderNameToken: './tokens', logger: makeLogger(c, live),
      whatsappVersion: WA_VERSION === 'latest' ? '' : WA_VERSION, // pinned WhatsApp Web build that WA-JS was tested with
      catchQR: (qr) => {
        if (!live()) return;
        if (phone) { requestCode(); return; } // phone-number mode: the QR appearing means the login screen is ready; show a code instead
        c.state.qr = qr; setStatus(c, 'qr', 'Scan this code with WhatsApp on another phone → Linked devices');
      },
      statusFind: (st) => {
        if (!live()) return;
        if (st === 'qrReadSuccess' || st === 'waitChat') setStatus(c, 'authenticating', 'Syncing chats…');
        if (st === 'isLogged' || st === 'chatsAvailable' || st === 'successChat') setStatus(c, 'authenticating', 'Loading…');
        if (st === 'desconnectedMobile' || st === 'browserClose') setStatus(c, 'disconnected', 'Connection lost.');
        if (st === 'qrReadFail') setStatus(c, 'error', 'The code was not used in time. Choose a link method to try again.');
      },
    });
    clearTimeout(watchdog);
    if (!live()) { await browser.close().catch(() => {}); return; }
    c.client = client;
    client.onAnyMessage((m) => {
      if (!live()) return;
      const msg = serializeMessage(m);
      if (!msg.chatId || msg.chatId === 'status@broadcast') return;
      c.lastMsg.set(msg.chatId, msg);
      emit(c, 'message', msg);
    });
    client.onAck((a) => live() && emit(c, 'ack', { id: a.id?._serialized || a.id, ack: a.ack, chatId: a.to?._serialized || a.to }));
    client.onStateChange((st) => {
      if (!live()) return;
      if (st === 'CONFLICT') client.useHere();
      if (st === 'UNPAIRED' || st === 'UNLAUNCHED') setStatus(c, 'disconnected', 'Phone was unlinked.');
    });
    try {
      const host = await client.getHostDevice();
      c.state.me = { number: numberOf(host?.wid?._serialized || host?.id?._serialized), name: host?.pushname || '' };
    } catch {}
    try { fs.writeFileSync(path.join(sessDir(c), '.linked'), ''); fs.rmSync(path.join(sessDir(c), '.pending'), { force: true }); } catch {}
    setStatus(c, 'connected');
  } catch (e) {
    if (!live()) return; // we closed it on purpose
    console.error(`[${c.name}]`, e);
    try { await browser?.close(); } catch {}
    c.browser = null; c.started = false;
    setStatus(c, 'error', e?.message || 'Could not start WhatsApp.');
  }
}

async function stopClient(c, wipe) {
  c.gen++; // anything still starting up for the old generation will clean itself up and stay silent
  try { if (wipe) await c.client?.logout(); } catch {}
  try { await c.client?.close(); } catch {}
  try { await c.browser?.close(); } catch {}
  c.client = null; c.browser = null; c.started = false; c.lastMsg.clear(); c.picCache.clear(); c.state.me = null;
  c.state.qr = null; c.state.code = null;
  if (wipe) {
    for (let i = 0; i < 6; i++) { // Windows can hold the profile folder for a moment after Chrome exits
      try { fs.rmSync(path.join(__dirname, 'tokens', sessionName(c.name)), { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 300)); }
    }
  }
}

/* ----------------------------------------------------------- auth routes */
const validName = (n) => /^[a-z0-9_.-]{3,32}$/.test(n);
const normPhone = (x) => String(x || '').replace(/\D/g, '');                 // "+250 788-123-456" -> "250788123456"
const validPhone = (d) => d.length >= 8 && d.length <= 15;
const looksLikePhone = (x) => /^[+\d\s().-]+$/.test(String(x).trim()) && validPhone(normPhone(x));
const nameByPhone = (d) => Object.keys(users).find((n) => users[n].phone === d);
// a phone number and a username must never collide, otherwise one identifier could mean two accounts
const identifierTaken = (id, except) => (users[id] && id !== except) || (nameByPhone(id) && nameByPhone(id) !== except);
function resolveLogin(raw) { // phone number or username -> username
  const id = String(raw || '').trim().toLowerCase();
  if (users[id]) return id;
  return looksLikePhone(id) ? nameByPhone(normPhone(id)) : undefined;
}
app.post('/api/register', smallJson, (req, res) => {
  if (!ALLOW_SIGNUP) return res.status(403).json({ error: 'Sign-up is closed.' });
  if (regThrottled(req)) return res.status(429).json({ error: 'Too many sign-ups from this network. Try later.' });
  const phone = normPhone(req.body?.phone), pw = String(req.body?.password || '');
  if (!validPhone(phone)) return res.status(400).json({ error: 'Enter your phone number with country code, e.g. 250788123456.' });
  const name = String(req.body?.username || '').trim().toLowerCase() || phone; // no username chosen: the phone number is the username
  if (!validName(name)) return res.status(400).json({ error: 'Username: 3-32 letters, numbers, . _ -' });
  if (pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (nameByPhone(phone) || (users[phone] && phone !== name)) return res.status(409).json({ error: 'That phone number already has an account. Sign in instead.' });
  if (identifierTaken(name)) return res.status(409).json({ error: 'That username is taken.' });
  if (Object.keys(users).length >= MAX_USERS) return res.status(503).json({ error: 'No free user slots.' });
  const salt = crypto.randomBytes(16).toString('hex');
  users[name] = { phone, salt, hash: hashPw(pw, salt), apiKey: crypto.randomBytes(24).toString('hex') };
  saveUsers(); startSession(req, res, name);
  res.json({ username: name });
});
app.post('/api/login', smallJson, (req, res) => {
  const raw = String(req.body?.username || '').trim().toLowerCase();
  const key = looksLikePhone(raw) ? normPhone(raw) : raw;           // throttle on a canonical form so "+250…" and "250…" count together
  const name = resolveLogin(raw), u = users[name];
  if (isLocked(req, key)) return res.status(429).json({ error: 'Too many wrong attempts. Wait a minute.' });
  // hash even for unknown users so response time does not reveal which usernames exist
  const ok = safeEq(hashPw(String(req.body?.password || ''), u ? u.salt : '0'.repeat(32)), u ? u.hash : 'x');
  if (!u || !ok) { noteFail(req, key); return res.status(401).json({ error: 'Wrong phone number / username or password.' }); }
  fails.delete(failKey(req, key));
  startSession(req, res, name);
  res.json({ username: name });
});
app.post('/api/signout', (req, res) => {
  const ses = sessionOf(req);
  if (ses) { endSessions((id) => id === ses.id); kickSessions([ses.id]); }
  res.set('Set-Cookie', 'wa_token=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  const name = userOf(req);
  if (!name) return res.status(401).json({ error: 'Please sign in.' });
  req.ctx = ctxFor(name);
  // Only reconnect a number that was linked before. A new user chooses how to link (QR or phone number) first.
  if (!req.path.startsWith('/link') && req.path !== '/logout' && req.path !== '/me' && !req.path.startsWith('/sessions') && req.path !== '/apikey' && req.path !== '/phone' && req.ctx.state.status === 'idle' && hasSaved(req.ctx)) ensureStarted(req.ctx);
  next();
});
app.use('/api', bigJson);

app.get('/api/me', (req, res) => res.json({ username: req.ctx.name, phone: users[req.ctx.name].phone || '', apiKey: users[req.ctx.name].apiKey }));
/* Add, change or remove the phone number you can sign in with. */
app.post('/api/phone', (req, res) => {
  const u = users[req.ctx.name], raw = String(req.body?.phone || '').trim();
  if (!raw) { u.phone = ''; saveUsers(); return res.json({ phone: '' }); }
  const phone = normPhone(raw);
  if (!validPhone(phone)) return res.status(400).json({ error: 'Enter the full number with country code, e.g. 250788123456.' });
  if (identifierTaken(phone, req.ctx.name)) return res.status(409).json({ error: 'That number is already used by another account.' });
  u.phone = phone; saveUsers();
  res.json({ phone });
});

/* Devices signed in to this account */
app.get('/api/sessions', (req, res) => {
  const list = Object.entries(sessions).filter(([, s_]) => s_.user === req.ctx.name)
    .map(([id, s_]) => ({ id: id.slice(0, 12), device: deviceLabel(s_.ua), ip: s_.ip || '', created: s_.created, last: s_.last, current: id === req.session?.id }))
    .sort((a, b) => b.last - a.last);
  res.json(list);
});
app.post('/api/sessions/revoke-others', (req, res) => {
  const gone = endSessions((id, s_) => s_.user === req.ctx.name && id !== req.session?.id);
  kickSessions(gone);
  res.json({ ok: true, revoked: gone.length });
});
app.post('/api/sessions/:id/revoke', (req, res) => {
  const gone = endSessions((id, s_) => s_.user === req.ctx.name && id.startsWith(req.params.id) && id !== req.session?.id);
  kickSessions(gone);
  res.json({ ok: true, revoked: gone.length });
});
app.post('/api/apikey', (req, res) => {
  users[req.ctx.name].apiKey = crypto.randomBytes(24).toString('hex');
  saveUsers();
  res.json({ apiKey: users[req.ctx.name].apiKey });
});

/* ------------------------------------------------------------------- API */
app.get('/api/events', (req, res) => {
  const c = req.ctx;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`event: status\ndata: ${JSON.stringify(pub(c))}\n\n`);
  res.sid = req.session?.id || null;
  c.subs.add(res);
  const beat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(beat); c.subs.delete(res); });
});
app.get('/api/status', (req, res) => res.json(pub(req.ctx)));

function needClient(req, res, next) {
  if (req.ctx.client && req.ctx.state.status === 'connected') return next();
  res.status(409).json({ error: 'WhatsApp is not connected yet.' });
}
const fail = (res, e) => { console.error(e); res.status(500).json({ error: e?.message || String(e) }); };
const unwrap = (s) => serializeMessage(Array.isArray(s) ? s[0] : s);

app.get('/api/chats', needClient, async (req, res) => {
  const c = req.ctx;
  try {
    const raw = await c.client.listChats({ count: 60 });
    const chats = raw.filter((x) => !x.isBroadcast && x.id?._serialized !== 'status@broadcast').map(serializeChat);
    chats.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.t - a.t);
    await pool(chats.slice(0, 25).filter((x) => !c.lastMsg.has(x.id)), 4, async (x) => {
      const [m] = await c.client.getMessages(x.id, { count: 1 });
      if (m) c.lastMsg.set(x.id, serializeMessage(m));
    });
    res.json(chats.map((x) => ({ ...x, last: c.lastMsg.get(x.id) || null })));
  } catch (e) { fail(res, e); }
});

app.get('/api/chats/:id/messages', needClient, async (req, res) => {
  try {
    const count = Math.min(Number(req.query.count) || 50, 200);
    const msgs = await req.ctx.client.getMessages(req.params.id, { count });
    res.json(msgs.map(serializeMessage).sort((a, b) => a.t - b.t));
  } catch (e) { fail(res, e); }
});

app.post('/api/chats/:id/messages', needClient, async (req, res) => {
  const c = req.ctx;
  try {
    const { text, replyTo } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'Message is empty.' });
    const sent = replyTo ? await c.client.reply(req.params.id, text, replyTo) : await c.client.sendText(req.params.id, text);
    const msg = unwrap(sent);
    msg.chatId = msg.chatId || req.params.id; msg.fromMe = true;
    c.lastMsg.set(req.params.id, msg);
    res.json(msg);
  } catch (e) { fail(res, e); }
});

/* Plain text to any number (or to yourself with to:"me"). Authenticate with X-Api-Key or the login cookie. */
app.post('/api/send', needClient, async (req, res) => {
  try {
    const { to, text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'Message is empty.' });
    const digits = to === 'me' || !to ? req.ctx.state.me?.number : String(to).replace(/\D/g, '');
    if (!digits) return res.status(400).json({ error: 'No destination number.' });
    const chatId = String(to || '').includes('@') ? to : `${digits}@c.us`;
    res.json(unwrap(await req.ctx.client.sendText(chatId, String(text))));
  } catch (e) { fail(res, e); }
});

app.post('/api/chats/:id/file', needClient, async (req, res) => {
  try {
    const { data, filename, caption } = req.body || {};
    if (!data) return res.status(400).json({ error: 'No file.' });
    res.json(unwrap(await req.ctx.client.sendFile(req.params.id, data, { filename, caption, type: 'auto-detect' })));
  } catch (e) { fail(res, e); }
});

app.post('/api/chats/:id/seen', needClient, async (req, res) => {
  try { await req.ctx.client.sendSeen(req.params.id); emit(req.ctx, 'seen', { chatId: req.params.id }); res.json({ ok: true }); } catch (e) { fail(res, e); }
});

app.get('/api/media/:msgId', needClient, async (req, res) => {
  try {
    const m = /^data:(.+?);base64,(.*)$/.exec((await req.ctx.client.downloadMedia(req.params.msgId)) || '');
    if (!m) return res.status(404).end();
    res.set('Content-Type', m[1]).set('Cache-Control', 'private, max-age=86400');
    res.send(Buffer.from(m[2], 'base64'));
  } catch (e) { fail(res, e); }
});

app.get('/api/pic/:id', needClient, async (req, res) => {
  const c = req.ctx;
  try {
    const id = req.params.id;
    if (!c.picCache.has(id)) {
      const p = await c.client.getProfilePicFromServer(id).catch(() => null);
      c.picCache.set(id, p?.eurl || p?.imgFull || null);
    }
    res.json({ url: c.picCache.get(id) });
  } catch { res.json({ url: null }); }
});

/* Link WhatsApp from any device. method: 'qr' | 'phone' (+ number, with country code) | 'resume' (reuse the saved login). */
app.post('/api/link', async (req, res) => {
  const c = req.ctx, method = String(req.body?.method || '');
  if (c.state.status === 'connected') return res.status(409).json({ error: 'Already linked. Disconnect first to link another number.' });
  let phone = '';
  if (method === 'phone') {
    phone = intlNumber(req.body?.number);
    if (!phone) return res.status(400).json({ error: 'Type the number with its country code and no leading 0, e.g. 27821234567 (South Africa) or 250788123456.' });
  } else if (method !== 'qr' && method !== 'resume') return res.status(400).json({ error: 'Unknown link method.' });
  if (method === 'resume' && !hasSaved(c)) return res.status(400).json({ error: 'Nothing to resume. Choose QR or phone number.' });
  try {
    await stopClient(c, method !== 'resume'); // a fresh link replaces any half-finished one; resume keeps the saved login
    if (NO_WA) { // test mode: pretend, no Chrome
      c.started = true;
      if (phone) c.state.code = 'TEST-1234'; else c.state.qr = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
      setStatus(c, 'qr', 'test mode');
      return res.json({ ok: true });
    }
    setStatus(c, 'starting', 'Launching browser…');
    ensureStarted(c, { phone });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});
/* Stop a link attempt that is not finished (wrong number, changed mind, switching method). */
app.post('/api/link/cancel', async (req, res) => {
  const c = req.ctx;
  if (c.state.status === 'connected') return res.status(409).json({ error: 'Already linked.' });
  try { await stopClient(c, !hasSaved(c)); setStatus(c, 'idle'); res.json({ ok: true }); } catch (e) { fail(res, e); }
});

/* Unlink this user's WhatsApp, then immediately offer a fresh QR. */
app.post('/api/logout', async (req, res) => {
  const c = req.ctx;
  try {
    await stopClient(c, true);
    setStatus(c, 'idle');
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

/* ------------------------------------------------------------------ go */
app.listen(PORT, HOST, () => {
  console.log(`\n  wa-inbox (multi-user)\n    this PC:        http://localhost:${PORT}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    for (const list of Object.values(os.networkInterfaces()))
      for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`    other devices:  http://${i.address}:${PORT}`);
    console.log('  (plain http: use it on a trusted network only; for the internet put HTTPS in front, see README)');
  }
  console.log('');
  // bring back users who already linked WhatsApp, a few seconds apart
  for (const name of Object.keys(users)) {
    if (hasSaved(ctxFor(name))) ensureStarted(ctxFor(name));
  }
});
process.on('SIGINT', async () => {
  for (const c of ctxs.values()) { try { await c.client?.close(); } catch {} }
  process.exit(0);
});
