(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const S = {
    chats: [],
    active: null, // chat object
    msgs: new Map(), // chatId -> message[]
    replyTo: null,
    filter: '',
    me: null,
    atBottom: true,
  };

  /* ------------------------------------------------------------ utils */
  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) { location.reload(); throw new Error('Please sign in.'); }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || res.statusText);
    }
    return res.json();
  }
  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 4000);
  }
  const initials = (name) =>
    name.split(/\s+/).map((w) => (w.match(/[\p{L}\p{N}]/u) || [''])[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '#';
  const fmtTime = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function fmtListTime(t) {
    if (!t) return '';
    const d = new Date(t * 1000), now = new Date();
    const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
    if (days <= 0) return fmtTime(t);
    if (days === 1) return 'Yesterday';
    if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  function dayLabel(t) {
    const d = new Date(t * 1000), now = new Date();
    const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  }
  const preview = (m) => {
    if (!m) return '';
    const label = { image: 'Photo', video: 'Video', audio: 'Audio', ptt: 'Voice message', document: 'Document', sticker: 'Sticker' }[m.type];
    const body = m.body || (label ? label : m.type !== 'chat' ? `[${m.type}]` : '');
    return (m.fromMe ? 'You: ' : '') + (label && m.body ? `${label} · ${m.body}` : body);
  };
  function linkify(text, parent) {
    const re = /(https?:\/\/[^\s<]+[^\s<.,;:!?)"'\]])/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      parent.append(text.slice(last, m.index));
      const a = el('a', null, m[0]);
      a.href = m[0]; a.target = '_blank'; a.rel = 'noopener noreferrer';
      parent.append(a);
      last = m.index + m[0].length;
    }
    parent.append(text.slice(last));
  }
  const tickFor = (ack) => (ack === -1 ? ['!', 'fail'] : ack >= 3 ? ['✓✓', 'read'] : ack === 2 ? ['✓✓', ''] : ack === 1 ? ['✓', ''] : ['🕓', '']);

  /* ------------------------------------------------------- connection */
  const gate = $('gate'), app = $('app');
  let refreshActive = false;
  function resetData() {
    S.chats = []; S.msgs.clear(); S.active = null; S.replyTo = null; picMemo.clear();
    $('thread').hidden = true; $('empty').hidden = false; app.classList.remove('in-thread'); $('replying').hidden = true;
  }
  async function reloadThread() { // after the connection was lost (phone slept, wifi changed): catch up
    const c = S.active && S.chats.find((x) => x.id === S.active.id);
    if (!c) return;
    try { S.msgs.set(c.id, await api(`/chats/${encodeURIComponent(c.id)}/messages?count=60`)); S.active = c; renderMessages(false); } catch {}
  }
  function applyStatus(s) {
    S.me = s.me;
    const connected = s.status === 'connected';
    if (!connected && S.wasConnected) resetData(); // unlinked or lost: never show the previous number's chats
    if (connected && S.stale) { S.stale = false; S.chats = []; refreshActive = true; }
    S.wasConnected = connected;
    gate.hidden = connected;
    app.hidden = !connected;
    if (connected) {
      $('me-name').textContent = s.me?.name || 'Inbox';
      $('me-sub').textContent = s.mock ? 'Demo mode' : s.me?.number ? '+' + s.me.number : 'Connected';
      $('me-av').textContent = initials(s.me?.name || 'Me');
      if (!S.chats.length) loadChats().then(() => { if (refreshActive && S.active) reloadThread(); });
      return;
    }
    const st = $('gate-status');
    st.classList.toggle('err', s.status === 'error' || s.status === 'disconnected');
    st.textContent =
      s.status === 'qr' ? s.detail || 'Waiting for scan…' :
      s.status === 'authenticating' ? s.detail || 'Linking…' :
      s.detail || (s.status === 'starting' ? 'Starting browser…' : s.status);
    // link screen: choose a method when nothing is in progress; otherwise show the matching steps and a way out
    const choosing = ['idle', 'disconnected', 'error'].includes(s.status), busy = !choosing;
    $('link-choose').hidden = !choosing;
    $('link-resume').hidden = !(choosing && s.saved && s.status !== 'idle');
    $('link-steps').hidden = !busy;
    $('steps-qr').hidden = !(busy && !s.code);
    $('steps-code').hidden = !(busy && s.code);
    $('qr-frame').style.display = busy ? '' : 'none';
    if (choosing) st.textContent = s.status === 'idle' ? 'Choose how to link your WhatsApp.' : (s.detail || 'Not connected.') + ' Reconnect or link again.';
    $('qr-img').hidden = !s.qr;
    $('qr-wait').hidden = !!(s.qr || s.code);
    $('pair-code').style.display = s.code ? 'block' : 'none';
    $('pair-code').textContent = s.code || '';
    if (s.qr) $('qr-img').src = s.qr;
    $('gate-note').textContent =
      s.status === 'starting' ? 'The first launch can take a minute while the browser starts.' :
      s.status === 'qr' ? 'The code refreshes by itself. Your session is remembered, so you only scan once.' : '';
  }

  function connectEvents() {
    const es = new EventSource('/api/events');
    es.addEventListener('status', (e) => applyStatus(JSON.parse(e.data)));
    es.addEventListener('message', (e) => onIncoming(JSON.parse(e.data)));
    es.addEventListener('ack', (e) => onAck(JSON.parse(e.data)));
    es.addEventListener('seen', (e) => { // you read this chat on another device
      const { chatId } = JSON.parse(e.data), c = S.chats.find((x) => x.id === chatId);
      if (c && c.unread) { c.unread = 0; renderChats(); }
    });
    es.addEventListener('signedout', () => { es.close(); location.reload(); }); // this device was signed out elsewhere
    es.onerror = () => {
      S.stale = true; // we may have missed messages: reload when the stream is back
      gate.hidden = false; app.hidden = true;
      $('gate-status').textContent = 'Lost contact with the server. Retrying…';
      $('gate-status').classList.add('err');
      fetch('/api/me').then((r) => { if (r.status === 401) location.reload(); }).catch(() => {});
    };
  }

  /* ------------------------------------------------------- chat list */
  async function loadChats() {
    try {
      S.chats = await api('/chats');
      if (S.active) S.active = S.chats.find((c) => c.id === S.active.id) || S.active;
      renderChats();
    } catch (e) { toast(e.message); }
  }

  function renderChats() {
    const ul = $('chats');
    ul.replaceChildren();
    const q = S.filter.trim().toLowerCase();
    const rows = S.chats.filter((c) => !q || c.name.toLowerCase().includes(q) || c.id.includes(q));
    if (!rows.length) {
      ul.append(el('li', 'none', q ? 'No chats match.' : 'No chats yet. Use + to start one.'));
    }
    for (const c of rows) {
      const li = el('li');
      const b = el('button', 'chat');
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(S.active?.id === c.id));
      b.append(avatar(c));
      const main = el('div', 'c-main');
      main.append(el('div', 'c-name', c.name), el('div', 'c-last', preview(c.last)));
      const side = el('div', 'c-side');
      side.append(el('div', 'c-time', fmtListTime(c.last?.t || c.t)));
      if (c.unread > 0) side.append(el('div', 'badge', c.unread > 99 ? '99+' : String(c.unread)));
      b.append(main, side);
      b.onclick = () => openChat(c);
      li.append(b);
      ul.append(li);
    }
    const total = S.chats.reduce((n, c) => n + (c.unread || 0), 0);
    document.title = total ? `(${total}) Inbox` : 'Inbox';
  }

  const picMemo = new Map();
  function avatar(c) {
    const a = el('div', 'avatar' + (c.isGroup ? ' group' : ''), initials(c.name));
    const apply = (url) => { if (url) { a.style.backgroundImage = `url("${url}")`; a.textContent = ''; } };
    if (picMemo.has(c.id)) apply(picMemo.get(c.id));
    else {
      picMemo.set(c.id, null);
      api('/pic/' + encodeURIComponent(c.id)).then((r) => { picMemo.set(c.id, r.url); apply(r.url); renderHeadAvatar(); }).catch(() => {});
    }
    return a;
  }
  function renderHeadAvatar() {
    if (!S.active) return;
    const a = $('th-av'), url = picMemo.get(S.active.id);
    a.className = 'avatar' + (S.active.isGroup ? ' group' : '');
    a.style.backgroundImage = url ? `url("${url}")` : '';
    a.textContent = url ? '' : initials(S.active.name);
  }

  /* ----------------------------------------------------- conversation */
  async function openChat(c) {
    S.active = c;
    S.replyTo = null;
    $('replying').hidden = true;
    $('empty').hidden = true;
    $('thread').hidden = false;
    $('th-name').textContent = c.name;
    $('th-sub').textContent = c.isGroup ? 'Group' : '+' + c.id.split('@')[0];
    renderHeadAvatar();
    app.classList.add('in-thread');
    renderChats();
    $('msgs').replaceChildren();
    try {
      const list = await api(`/chats/${encodeURIComponent(c.id)}/messages?count=60`);
      S.msgs.set(c.id, list);
      if (S.active?.id !== c.id) return;
      renderMessages(true);
      markSeen(c);
    } catch (e) { toast(e.message); }
    $('input').focus({ preventScroll: true });
  }

  function markSeen(c) {
    if (!c.unread) return;
    c.unread = 0;
    renderChats();
    api(`/chats/${encodeURIComponent(c.id)}/seen`, { method: 'POST' }).catch(() => {});
  }

  function renderMessages(forceBottom) {
    const box = $('msgs');
    const list = S.msgs.get(S.active.id) || [];
    const stick = forceBottom || S.atBottom;
    box.replaceChildren();
    let lastDay = '', lastSender = null;
    for (const m of list) {
      const day = dayLabel(m.t);
      if (day !== lastDay) { box.append(el('div', 'day', day)); lastDay = day; lastSender = null; }
      const who = m.fromMe ? 'me' : m.author || 'them';
      box.append(messageNode(m, who !== lastSender));
      lastSender = who;
    }
    if (stick) box.scrollTop = box.scrollHeight;
    $('jump').hidden = true;
  }

  function messageNode(m, firstInRun) {
    const wrap = el('div', `msg${m.fromMe ? ' me' : ''}${firstInRun ? ' first-in-run' : ''}${m._pending ? ' pending' : ''}`);
    wrap.dataset.id = m.id;
    const bub = el('div', 'bubble');
    if (!m.fromMe && S.active?.isGroup && firstInRun && m.sender) bub.append(el('div', 'who', m.sender));
    if (m.quoted) bub.append(el('div', 'quote', m.quoted.body));

    if (m.hasMedia) {
      if (m.type === 'image' || m.type === 'sticker') {
        const img = el('img', 'media'); img.loading = 'lazy'; img.alt = m.body || 'Photo';
        img.src = '/api/media/' + encodeURIComponent(m.id);
        img.onerror = () => { img.replaceWith(el('span', 'fileline', '🖼 Photo (could not load)')); };
        bub.append(img);
      } else if (m.type === 'video' || m.type === 'audio' || m.type === 'ptt') {
        const v = el(m.type === 'video' ? 'video' : 'audio', 'media'); v.controls = true; v.preload = 'none';
        v.src = '/api/media/' + encodeURIComponent(m.id);
        bub.append(v);
      } else {
        const a = el('a', 'fileline', '📎 ' + (m.filename || 'Document'));
        a.href = '/api/media/' + encodeURIComponent(m.id); a.download = m.filename || '';
        bub.append(a);
      }
      if (m.body) bub.append(document.createElement('br'));
    } else if (m.type !== 'chat' && !m.body) {
      bub.append(el('em', null, `[${m.type}]`));
    }
    if (m.body) linkify(m.body, bub);

    const meta = el('span', 'meta');
    meta.append(el('span', null, fmtTime(m.t)));
    if (m.fromMe) {
      const [sym, cls] = tickFor(m.ack);
      const t = el('span', 'tick ' + cls, sym); t.dataset.tick = '1';
      meta.append(t);
    }
    bub.append(meta);

    const hint = el('button', 'reply-hint');
    hint.type = 'button'; hint.title = 'Reply'; hint.setAttribute('aria-label', 'Reply to this message');
    hint.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5M4 9h9a7 7 0 017 7v3"/></svg>';
    hint.onclick = () => setReply(m);
    bub.ondblclick = () => setReply(m);
    wrap.append(bub, hint);
    return wrap;
  }

  function setReply(m) {
    if (m._pending) return;
    S.replyTo = m;
    $('replying-text').textContent = (m.fromMe ? 'yourself' : S.active.name) + ': ' + (preview(m).replace(/^You: /, '') || `[${m.type}]`);
    $('replying').hidden = false;
    $('input').focus();
  }
  $('replying-x').onclick = () => { S.replyTo = null; $('replying').hidden = true; };

  /* --------------------------------------------------------- realtime */
  function onIncoming(m) {
    if (!m.chatId) return;
    // update chat list
    let chat = S.chats.find((c) => c.id === m.chatId);
    if (!chat) {
      chat = { id: m.chatId, name: m.sender || m.chatId.split('@')[0], isGroup: m.chatId.endsWith('@g.us'), unread: 0, t: m.t, last: m };
      S.chats.unshift(chat);
      loadChats(); // pick up the real name
    }
    chat.last = m; chat.t = m.t;
    const viewing = S.active?.id === m.chatId && document.visibilityState === 'visible';
    if (!m.fromMe && !viewing) chat.unread = (chat.unread || 0) + 1;
    S.chats.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.last?.t || b.t) - (a.last?.t || a.t));

    // update open thread (replace optimistic copy if it matches)
    const list = S.msgs.get(m.chatId);
    if (list) {
      if (list.some((x) => x.id === m.id)) { /* dup */ }
      else {
        const pend = m.fromMe ? list.findIndex((x) => x._pending && x.body === m.body) : -1;
        if (pend >= 0) list[pend] = m; else list.push(m);
      }
      if (S.active?.id === m.chatId) {
        renderMessages(false);
        if (!S.atBottom && !m.fromMe) $('jump').hidden = false;
      }
    }
    if (viewing && !m.fromMe) markSeen(chat);
    renderChats();
    if (!m.fromMe && !viewing) notify(chat, m);
  }

  function onAck({ id, ack }) {
    for (const list of S.msgs.values()) {
      const m = list.find((x) => x.id === id);
      if (!m) continue;
      m.ack = ack;
      const node = document.querySelector(`.msg[data-id="${CSS.escape(id)}"] [data-tick]`);
      if (node) { const [sym, cls] = tickFor(ack); node.textContent = sym; node.className = 'tick ' + cls; }
    }
  }

  function notify(chat, m) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(chat.name, { body: preview(m), tag: chat.id });
      n.onclick = () => { window.focus(); openChat(chat); n.close(); };
    } catch {}
  }

  /* ---------------------------------------------------------- sending */
  const input = $('input');
  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
  });

  $('composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !S.active) return;
    const chat = S.active, replyTo = S.replyTo;
    const temp = {
      id: 'tmp-' + Date.now(), chatId: chat.id, fromMe: true, type: 'chat', body: text,
      t: Math.floor(Date.now() / 1000), ack: 0, quoted: replyTo ? { body: replyTo.body || `[${replyTo.type}]` } : null, _pending: true,
    };
    const list = S.msgs.get(chat.id) || [];
    list.push(temp); S.msgs.set(chat.id, list);
    input.value = ''; autosize();
    S.replyTo = null; $('replying').hidden = true;
    renderMessages(true);
    try {
      const sent = await api(`/chats/${encodeURIComponent(chat.id)}/messages`, {
        method: 'POST', body: { text, replyTo: replyTo?.id },
      });
      const i = list.indexOf(temp);
      // the realtime event may already have swapped our temp message
      if (i >= 0) { list[i] = { ...sent, ack: sent.ack || 1 }; }
      dedupe(list);
      if (S.active?.id === chat.id) renderMessages(true);
      chat.last = list.find((m) => m.id === sent.id) || chat.last;
      renderChats();
    } catch (err) {
      temp._pending = false; temp.ack = -1;
      if (S.active?.id === chat.id) renderMessages(true);
      toast('Not sent: ' + err.message);
    }
  });
  function dedupe(list) {
    const seen = new Set();
    for (let i = list.length - 1; i >= 0; i--) {
      if (seen.has(list[i].id)) list.splice(i, 1); else seen.add(list[i].id);
    }
  }

  $('btn-attach').onclick = () => $('file').click();
  $('file').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f || !S.active) return;
    if (f.size > 40 * 1024 * 1024) return toast('That file is over 40 MB.');
    const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
    const caption = input.value.trim(); input.value = ''; autosize();
    toast(`Sending ${f.name}…`);
    try {
      await api(`/chats/${encodeURIComponent(S.active.id)}/file`, { method: 'POST', body: { data, filename: f.name, caption } });
      $('toast').hidden = true;
    } catch (err) { toast('File not sent: ' + err.message); }
  };

  /* ----------------------------------------------------------- chrome */
  $('msgs').addEventListener('scroll', () => {
    const b = $('msgs');
    S.atBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 80;
    if (S.atBottom) $('jump').hidden = true;
  });
  $('jump').onclick = () => { const b = $('msgs'); b.scrollTop = b.scrollHeight; };
  $('search').addEventListener('input', (e) => { S.filter = e.target.value; renderChats(); });
  $('btn-back').onclick = () => { app.classList.remove('in-thread'); S.active = null; renderChats(); };
  $('btn-new').onclick = () => { const n = $('newchat'); n.hidden = !n.hidden; if (!n.hidden) $('newchat-num').focus(); };
  $('newchat-go').onclick = startNew;
  $('newchat-num').addEventListener('keydown', (e) => { if (e.key === 'Enter') startNew(); });
  function startNew() {
    const digits = $('newchat-num').value.replace(/\D/g, '');
    if (digits.length < 8) return toast('Enter the full number including country code.');
    const id = digits + '@c.us';
    let chat = S.chats.find((c) => c.id === id);
    if (!chat) { chat = { id, name: '+' + digits, isGroup: false, unread: 0, t: 0, last: null }; S.chats.unshift(chat); }
    $('newchat').hidden = true; $('newchat-num').value = '';
    renderChats(); openChat(chat);
  }
  $('btn-menu').onclick = async () => {
    if (!confirm('Disconnect this WhatsApp number from the inbox?')) return;
    try { await api('/logout', { method: 'POST' }); } catch (e) { toast(e.message); }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.active) markSeen(S.active);
  });
  document.addEventListener('click', function ask() {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    document.removeEventListener('click', ask);
  });

  /* ---- account & devices ---- */
  const dlg = $('account');
  let apiKey = '', keyShown = false;
  const paintKey = () => { $('acct-key').textContent = keyShown ? apiKey : '•'.repeat(24); $('acct-show').textContent = keyShown ? 'Hide' : 'Show'; };
  const ago = (ms) => {
    const m = Math.round((Date.now() - ms) / 60000);
    return m < 2 ? 'active now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
  };
  async function loadDevices() {
    const ul = $('devs'); ul.replaceChildren();
    try {
      for (const d of await api('/sessions')) {
        const li = el('li'), left = el('div');
        left.append(el('div', 'd-name', d.device + (d.current ? ' (this device)' : '')), el('div', 'd-sub', `${d.ip || ''} · ${ago(d.last)}`));
        li.append(left);
        if (!d.current) {
          const b = el('button', 'chip danger', 'Sign out'); b.type = 'button';
          b.onclick = async () => { try { await api(`/sessions/${d.id}/revoke`, { method: 'POST' }); loadDevices(); } catch (e) { toast(e.message); } };
          li.append(b);
        }
        ul.append(li);
      }
    } catch (e) { toast(e.message); }
  }
  $('btn-account').onclick = async () => {
    const u = await api('/me').catch(() => null); if (!u) return;
    apiKey = u.apiKey; keyShown = false; paintKey();
    $('acct-phone').value = u.phone || '';
    $('acct-title').textContent = u.username;
    dlg.showModal(); loadDevices();
  };
  $('acct-x').onclick = () => dlg.close();
  $('acct-phone-save').onclick = async () => {
    try { const r = await api('/phone', { method: 'POST', body: { phone: $('acct-phone').value } }); $('acct-phone').value = r.phone; toast(r.phone ? 'Saved. You can now sign in with this number.' : 'Phone number removed.'); } catch (e) { toast(e.message); }
  };
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $('acct-show').onclick = () => { keyShown = !keyShown; paintKey(); };
  $('acct-copy').onclick = async () => { try { await navigator.clipboard.writeText(apiKey); toast('API key copied.'); } catch { keyShown = true; paintKey(); toast('Copy it manually.'); } };
  $('acct-regen').onclick = async () => {
    if (!confirm('Make a new API key? Apps using the old key stop working until you update them.')) return;
    try { apiKey = (await api('/apikey', { method: 'POST' })).apiKey; keyShown = true; paintKey(); } catch (e) { toast(e.message); }
  };
  $('acct-others').onclick = async () => {
    try { const r = await api('/sessions/revoke-others', { method: 'POST' }); toast(r.revoked ? `Signed out ${r.revoked} other device(s).` : 'No other devices.'); loadDevices(); } catch (e) { toast(e.message); }
  };
  $('acct-out').onclick = async () => { await fetch('/api/signout', { method: 'POST' }); location.reload(); };

  /* ---- accounts ---- */
  let registering = false;
  function authMode(reg) { // "Create account" first reveals the phone field, a second tap submits
    registering = reg;
    $('au-phone').hidden = !reg; $('au-phone').required = reg;
    $('au-name').placeholder = reg ? 'Username (optional, your number is used if empty)' : 'Phone number or username';
    $('au-name').required = !reg;
    $('au-login').hidden = reg; $('au-back').hidden = !reg;
    $('au-reg').textContent = reg ? 'Create my account' : 'Create account';
    $('au-pass').autocomplete = reg ? 'new-password' : 'current-password';
    document.querySelector('#auth h1').textContent = reg ? 'Create account' : 'Sign in';
    $('au-err').textContent = '';
    if (reg) $('au-phone').focus();
  }
  async function authPost(path) {
    $('au-err').textContent = '';
    const r = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('au-name').value, phone: $('au-phone').value, password: $('au-pass').value }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return ($('au-err').textContent = j.error || 'Failed.');
    location.reload();
  }
  $('auth-form').onsubmit = (e) => { e.preventDefault(); authPost(registering ? 'register' : 'login'); };
  $('au-reg').onclick = () => { if (!registering) return authMode(true); if ($('auth-form').reportValidity()) authPost('register'); };
  $('au-back').onclick = () => authMode(false);
  async function link(method, number) {
    try { await api('/link', { method: 'POST', body: { method, number } }); } catch (e) { toast(e.message); }
  }
  $('link-qr').onclick = () => link('qr');
  $('link-resume').onclick = () => link('resume');
  /* Country picker: the dropdown supplies the dial code, the box takes the national number. */
  const ccSel = $('link-cc'), numIn = $('link-num');
  const byIso = Object.fromEntries(window.COUNTRIES.map((c) => [c[0], c]));
  const addOpts = (parent, list) => { for (const [iso, name, dial] of list) { const o = document.createElement('option'); o.value = iso; o.textContent = `${name} (+${dial})`; parent.append(o); } };
  const PINNED = ['RW', 'ZA', 'KE', 'UG', 'TZ', 'BI', 'CD', 'NG', 'GB', 'US'];
  const pinGrp = document.createElement('optgroup'); pinGrp.label = 'Common';
  addOpts(pinGrp, PINNED.map((i) => byIso[i]));
  const allGrp = document.createElement('optgroup'); allGrp.label = 'All countries (A-Z)';
  addOpts(allGrp, [...window.COUNTRIES].sort((x, y) => x[1].localeCompare(y[1])));
  ccSel.append(pinGrp, allGrp);
  let startIso = 'ZA';
  try { startIso = localStorage.getItem('wa-cc') || ((navigator.language || '').split('-')[1] || '').toUpperCase(); } catch {}
  ccSel.value = byIso[startIso] ? startIso : 'ZA';
  const fullNumber = () => {
    let n = numIn.value.replace(/\D/g, '');
    const dial = byIso[ccSel.value][2];
    if (numIn.value.trim().startsWith('+') || n.startsWith('00')) return n.replace(/^00/, ''); // typed in full international form
    n = n.replace(/^0+/, '');                                    // drop the local leading 0
    return n ? dial + n : '';
  };
  const showFull = () => { const f = fullNumber(); $('link-full').textContent = f ? 'Will link: +' + f : ''; };
  ccSel.onchange = () => { try { localStorage.setItem('wa-cc', ccSel.value); } catch {} showFull(); };
  numIn.addEventListener('input', showFull);
  /* split a saved full number like 27821234567 into country + national part */
  function prefill(full) {
    const best = window.COUNTRIES.filter((c) => full.startsWith(c[2])).sort((a, b) => b[2].length - a[2].length)[0];
    if (best) { ccSel.value = best[0]; numIn.value = full.slice(best[2].length); } else numIn.value = full;
    showFull();
  }
  $('link-phone').onclick = () => {
    const n = fullNumber();
    if (n.length < 8 || n.length > 15) return toast('Enter your phone number (without the country code).');
    link('phone', n);
  };
  numIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('link-phone').click(); });
  $('link-cancel').onclick = async () => { try { await api('/link/cancel', { method: 'POST' }); } catch (e) { toast(e.message); } };
  $('btn-signout').onclick = async () => { await fetch('/api/signout', { method: 'POST' }); location.reload(); };

  fetch('/api/me').then(async (r) => {
    if (!r.ok) { $('auth').hidden = false; return; }
    const u = await r.json();
    $('gate-user').textContent = 'Signed in as ' + u.username + '. API key for your other apps: ' + u.apiKey;
    $('me-name').title = 'Signed in as ' + u.username;
    if (u.phone && !numIn.value) prefill(u.phone);
    api('/status').then(applyStatus).catch(() => {});
    connectEvents();
  });
})();
