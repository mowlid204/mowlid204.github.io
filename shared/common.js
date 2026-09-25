/* Shared helpers. Every key in storage is prefixed with the campaign name, so the pest and roofing
   apps never see each other's leads, call outcomes, or appointments. */
window.Common = (function () {
  const APP = window.APP || { campaign: 'default', title: 'Outreach' };
  const KEY = k => APP.campaign + '.' + k;

  const store = {
    get(k, def) { try { const v = localStorage.getItem(KEY(k)); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem(KEY(k), JSON.stringify(v)); return true; } catch (e) { toast('Could not save (storage full or blocked)'); return false; } },
    remove(k) { try { localStorage.removeItem(KEY(k)); } catch (e) {} },
  };

  const STATE_TZ = {
    AB: 'America/Edmonton', BC: 'America/Vancouver', SK: 'America/Regina', MB: 'America/Winnipeg', ON: 'America/Toronto', QC: 'America/Toronto',
    AL: 'America/Chicago', AR: 'America/Chicago', AZ: 'America/Phoenix', CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York',
    DE: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', IA: 'America/Chicago', ID: 'America/Boise', IL: 'America/Chicago',
    IN: 'America/Indiana/Indianapolis', KS: 'America/Chicago', KY: 'America/Chicago', LA: 'America/Chicago', MA: 'America/New_York', MD: 'America/New_York',
    ME: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago', MO: 'America/Chicago', MS: 'America/Chicago', MT: 'America/Denver',
    NC: 'America/New_York', ND: 'America/Chicago', NE: 'America/Chicago', NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver',
    NV: 'America/Los_Angeles', NY: 'America/New_York', OH: 'America/New_York', OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York',
    RI: 'America/New_York', SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/New_York', TX: 'America/Chicago', UT: 'America/Denver',
    VA: 'America/New_York', VT: 'America/New_York', WA: 'America/Los_Angeles', WI: 'America/Chicago', WV: 'America/New_York', WY: 'America/Denver',
  };
  const myTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function tzShort(tz, date) {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(date || new Date()).find(p => p.type === 'timeZoneName').value; }
    catch (e) { return ''; }
  }
  function fmtTime(date, tz) {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: tz || myTz, hour: 'numeric', minute: '2-digit' }).format(date); } catch (e) { return ''; }
  }
  function fmtDate(date, tz, opts) {
    try { return new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: tz || myTz, weekday: 'short', month: 'short', day: 'numeric' }, opts || {})).format(date); } catch (e) { return ''; }
  }
  function hourIn(tz, date) {
    try { return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(date || new Date()), 10) % 24; } catch (e) { return 12; }
  }

  const digits = p => String(p || '').replace(/\D/g, '');
  function telHref(p) { let d = digits(p); if (d.length === 10) d = '1' + d; return 'tel:+' + d; }
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function smsHref(p, body) { return 'sms:' + telHref(p).slice(4) + (isIOS ? '&' : '?') + 'body=' + encodeURIComponent(body || ''); }
  function mailHref(to, subject, body) { return 'mailto:' + encodeURIComponent(to || '') + '?subject=' + encodeURIComponent(subject || '') + '&body=' + encodeURIComponent(body || ''); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function firstName(lead) { const n = (lead.owner || '').trim(); return n ? n.split(/\s+/)[0] : (lead.business || 'there'); }
  function displayName(lead) { return (lead.owner || '').trim() || lead.business || 'Unknown'; }

  /* ---- leads: built-in list, or a list the user imported in the app ---- */
  function getLeads() {
    const custom = store.get('customLeads', null);
    if (custom && custom.length) return custom;
    return window.LEADS || [];
  }
  function leadById(id) { return getLeads().find(l => l.id === id); }
  function leadState() { return store.get('leadState', {}); }
  function getState(id) { return leadState()[id] || {}; }
  function updateState(id, patch) {
    const s = leadState(); s[id] = Object.assign({}, s[id] || {}, patch, { updatedAt: Date.now() }); store.set('leadState', s); return s[id];
  }
  const DISPOSITIONS = [
    { k: 'noanswer', label: 'No answer' }, { k: 'voicemail', label: 'Voicemail' }, { k: 'callback', label: 'Callback' },
    { k: 'gatekeeper', label: 'Gatekeeper' }, { k: 'interested', label: 'Interested' }, { k: 'booked', label: 'Booked' },
    { k: 'notinterested', label: 'Not interested' }, { k: 'badnumber', label: 'Bad number' },
  ];
  const dispLabel = k => (DISPOSITIONS.find(d => d.k === k) || {}).label || '';
  function wasCalled(st) { return !!(st && ((st.calls && st.calls.length) || st.disp)); }

  /* ---- CSV ---- */
  function parseCSV(text) {
    const rows = []; let row = [], cell = '', q = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim() !== ''));
  }
  const csvCell = v => { v = String(v == null ? '' : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  function toCSV(cols, rows) { return [cols.map(csvCell).join(',')].concat(rows.map(r => cols.map(c => csvCell(r[c])).join(','))).join('\r\n'); }
  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain' }); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 2000);
  }
  /* Turn any lead sheet into our lead format by guessing columns from the header names. */
  function importLeadsCSV(text, prefix) {
    const rows = parseCSV(text); if (rows.length < 2) throw new Error('No rows found');
    const head = rows[0].map(h => h.trim().toLowerCase());
    const find = (...pats) => { for (const p of pats) { const i = head.findIndex(h => p.test(h)); if (i >= 0) return i; } return -1; };
    const ix = {
      business: find(/^(company|business|company name|business name)$/, /company|business/),
      owner: find(/^owner/, /decision/, /contact name/, /^(name|full name|first name)$/, /owner|name/),
      title: find(/^title$/, /title|role/),
      phone: find(/^(main phone|phone|phone number|mobile|tel)$/, /phone|mobile|tel|number/),
      city: find(/^city$/, /city|town/), state: find(/^(state|province|prov|st)$/, /state|province/),
      market: find(/^(area|market|region|metro)$/), website: find(/^(website|url|web|site)$/, /website|url/),
      email: find(/^e-?mail/, /e-?mail/), tier: find(/^tier$/), rank: find(/^(rank|#|no\.?)$/),
      rating: find(/bbb rating|^rating$/), years: find(/years/), notes: find(/why qualified|^notes?$|notes/),
    };
    if (ix.phone < 0) throw new Error('Could not find a phone column');
    const out = []; const seen = {};
    rows.slice(1).forEach((r, i) => {
      const g = k => ix[k] >= 0 ? (r[ix[k]] || '').trim() : '';
      const phone = g('phone'); if (!digits(phone)) return;
      let state = g('state').toUpperCase(); if (state.length > 2) state = state.slice(0, 2);
      let id = (prefix || 'x') + digits(phone); if (seen[id]) id += '-' + i; seen[id] = 1;
      out.push({ id, rank: parseInt(g('rank'), 10) || out.length + 1, tier: g('tier').toUpperCase().slice(0, 1), owner: g('owner'), title: g('title'),
        business: g('business'), phone, phoneAlt: '', city: g('city'), state, market: g('market') || g('city'), website: g('website'), email: g('email'),
        rating: g('rating'), accredited: false, years: g('years'), services: '', notes: g('notes'), profile: '', tz: STATE_TZ[state] || myTz });
    });
    if (!out.length) throw new Error('No leads with phone numbers found');
    return out;
  }

  /* ---- UI bits ---- */
  let toastTimer;
  function toast(msg) {
    let el = document.querySelector('.toast'); if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }
  function sheetEl() {
    let b = document.querySelector('.sheet-backdrop');
    if (!b) { b = document.createElement('div'); b.className = 'sheet-backdrop'; b.innerHTML = '<div class="sheet"></div>'; document.body.appendChild(b);
      b.addEventListener('click', e => { if (e.target === b) closeSheet(); }); }
    return b;
  }
  let onSheetClose = null;
  function openSheet(title, html, onMount, onClose) {
    const b = sheetEl(); const s = b.querySelector('.sheet');
    s.innerHTML = '<h3>' + esc(title) + '<button class="iconbtn x" data-close aria-label="Close">✕</button></h3>' + html;
    s.querySelector('[data-close]').onclick = closeSheet; b.classList.add('open'); onSheetClose = onClose || null;
    document.body.style.overflow = 'hidden';
    if (onMount) onMount(s);
    return s;
  }
  function closeSheet() {
    const b = document.querySelector('.sheet-backdrop'); if (b) b.classList.remove('open'); document.body.style.overflow = '';
    if (onSheetClose) { const f = onSheetClose; onSheetClose = null; f(); }
  }
  function sheetOpen() { const b = document.querySelector('.sheet-backdrop'); return !!(b && b.classList.contains('open')); }
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t).then(() => toast('Copied'), () => fallbackCopy(t));
    fallbackCopy(t); return Promise.resolve();
  }
  function fallbackCopy(t) { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('Copied'); } catch (e) { prompt('Copy this:', t); } document.body.removeChild(ta); }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const utcStamp = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  return { APP, store, STATE_TZ, myTz, tzShort, fmtTime, fmtDate, hourIn, digits, telHref, smsHref, mailHref, isIOS, esc, firstName, displayName,
    getLeads, leadById, leadState, getState, updateState, DISPOSITIONS, dispLabel, wasCalled, parseCSV, toCSV, download, importLeadsCSV,
    toast, openSheet, closeSheet, sheetOpen, copyText, debounce, uid, pad, ymd, utcStamp };
})();
