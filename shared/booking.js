/* Booking calendar: cycle through clients, tap a time slot, appointment is created with the client pre-filled.
   Each appointment must be confirmed by the owner AND by you before it counts as confirmed. */
(function () {
  const C = window.Common, esc = C.esc, store = C.store;
  let leads = C.getLeads();
  const DEFAULT_TPL = "Hi {name}, it's {me}. Confirming our meeting on {date} at {time}. Google Meet link: {meet}. Reply YES to confirm. Thanks!";
  const DEF = { clientId: null, filter: 'all', view: 'calendar', month: null, day: null, listFilter: 'upcoming', myName: '', myEmail: '', myPhone: '',
    startHour: 8, endHour: 18, slotMin: 30, duration: 30, template: DEFAULT_TPL, defaultMeet: '', gClientId: '' };
  let prefs = Object.assign({}, DEF, store.get('booking.prefs', {}));
  const savePrefs = () => store.set('booking.prefs', prefs);
  let appts = store.get('appointments', []);
  const save = () => store.set('appointments', appts);
  const $ = s => document.querySelector(s);
  const MIN = 60000, DAY = 864e5;
  const isConfirmed = a => !!(a.ownerConfirmed && a.meConfirmed);
  const endMs = a => a.startMs + (a.durationMin || 30) * MIN;
  const whenStr = (a, tz) => C.fmtDate(new Date(a.startMs), tz) + ' ' + C.fmtTime(new Date(a.startMs), tz);
  const title = a => (a.name || 'Meeting') + (a.business ? ' · ' + a.business : '');
  const details = a => ['Phone: ' + (a.phone || ''), a.business ? 'Business: ' + a.business : '', a.email ? 'Email: ' + a.email : '', a.meet ? 'Google Meet: ' + a.meet : '', a.notes ? 'Notes: ' + a.notes : '', 'Booked with the ' + C.APP.title + ' booking app'].filter(Boolean).join('\n');

  /* ---- clients ---- */
  function clients() {
    const st = C.leadState();
    return leads.filter(l => { const s = st[l.id] || {}; const has = appts.some(a => a.leadId === l.id);
      switch (prefs.filter) { case 'booked': return s.disp === 'booked'; case 'callback': return s.disp === 'callback'; case 'interested': return ['interested', 'booked'].includes(s.disp);
        case 'hasappt': return has; case 'noappt': return !has; } return true; });
  }
  function client() {
    const q = clients(); if (!q.length) return null;
    let l = q.find(x => x.id === prefs.clientId);
    if (!l) { const cur = C.leadById(prefs.clientId); l = (cur && q.find(x => x.rank >= cur.rank)) || q[0]; prefs.clientId = l.id; savePrefs(); }
    return l;
  }
  function moveClient(dir) {
    const q = clients(); if (!q.length) { C.toast('No clients match this filter'); return; }
    const i = q.findIndex(x => x.id === prefs.clientId); let n;
    if (i >= 0) n = q[(i + dir + q.length) % q.length]; else { const cur = C.leadById(prefs.clientId), r = cur ? cur.rank : 0; n = dir > 0 ? (q.find(x => x.rank > r) || q[0]) : (q.slice().reverse().find(x => x.rank < r) || q[q.length - 1]); }
    prefs.clientId = n.id; savePrefs(); render();
  }
  function fillMessage(a) {
    const l = a.leadId ? C.leadById(a.leadId) : null; const d = new Date(a.startMs);
    const map = { name: l ? C.firstName(l) : (a.name || '').split(' ')[0] || 'there', business: a.business || '', me: prefs.myName || 'me', myphone: prefs.myPhone || '',
      date: C.fmtDate(d, a.tz, { weekday: 'long', month: 'long', day: 'numeric' }), time: C.fmtTime(d, a.tz) + ' ' + C.tzShort(a.tz, d), mytime: C.fmtTime(d) + ' ' + C.tzShort(C.myTz, d),
      meet: a.meet || '(link to follow)' };
    return (prefs.template || DEFAULT_TPL).replace(/\{(\w+)\}/g, (m, k) => k in map ? map[k] : m);
  }
  function gcalUrl(a) {
    const p = new URLSearchParams({ action: 'TEMPLATE', text: title(a), dates: C.utcStamp(a.startMs) + '/' + C.utcStamp(endMs(a)), details: details(a), ctz: C.myTz });
    if (a.email) p.set('add', a.email); if (a.meet) p.set('location', a.meet);
    return 'https://calendar.google.com/calendar/render?' + p.toString();
  }
  function icsFor(a) {
    const t = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//outreach//booking//EN', 'BEGIN:VEVENT', 'UID:' + a.id + '@outreach', 'DTSTAMP:' + C.utcStamp(Date.now()), 'DTSTART:' + C.utcStamp(a.startMs), 'DTEND:' + C.utcStamp(endMs(a)),
      'SUMMARY:' + t(title(a)), 'DESCRIPTION:' + t(details(a)), a.meet ? 'LOCATION:' + t(a.meet) : '', 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
  }

  /* ---- Google Calendar API (optional, needs a Client ID in settings) ---- */
  let gToken = null, gExp = 0;
  function loadGIS() { return new Promise((res, rej) => { if (window.google && google.accounts && google.accounts.oauth2) return res(); const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.onload = res; s.onerror = () => rej(new Error('Could not load Google sign-in')); document.head.appendChild(s); }); }
  async function getToken() {
    if (gToken && Date.now() < gExp) return gToken; await loadGIS();
    return new Promise((resolve, reject) => {
      const tc = google.accounts.oauth2.initTokenClient({ client_id: prefs.gClientId.trim(), scope: 'https://www.googleapis.com/auth/calendar.events',
        callback: r => { if (r && r.access_token) { gToken = r.access_token; gExp = Date.now() + ((r.expires_in || 3600) - 60) * 1000; resolve(gToken); } else reject(new Error((r && r.error_description) || (r && r.error) || 'No access token')); },
        error_callback: e => reject(new Error(e && e.type === 'popup_closed' ? 'Google sign-in was closed' : 'Google sign-in failed')) });
      tc.requestAccessToken();
    });
  }
  async function createGoogleEvent(a) {
    const token = await getToken();
    const body = { summary: title(a), description: details(a), start: { dateTime: new Date(a.startMs).toISOString(), timeZone: C.myTz }, end: { dateTime: new Date(endMs(a)).toISOString(), timeZone: C.myTz },
      conferenceData: { createRequest: { requestId: a.id + '-' + Date.now().toString(36), conferenceSolutionKey: { type: 'hangoutsMeet' } } } };
    if (a.email) body.attendees = [{ email: a.email }];
    const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events' + (a.gcalId ? '/' + encodeURIComponent(a.gcalId) : '') + '?conferenceDataVersion=1' + (a.email ? '&sendUpdates=all' : '');
    const res = await fetch(url, { method: a.gcalId ? 'PATCH' : 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error('Google Calendar error ' + res.status + ': ' + (await res.text()).slice(0, 300));
    const ev = await res.json(); const video = ((ev.conferenceData || {}).entryPoints || []).find(e => e.entryPointType === 'video');
    a.meet = ev.hangoutLink || (video && video.uri) || a.meet; a.gcalId = ev.id; a.gcalLink = ev.htmlLink; save();
  }

  /* ---- rendering ---- */
  function render() {
    const unconfirmed = appts.filter(a => !isConfirmed(a) && endMs(a) > Date.now()).length;
    $('#tabCount').textContent = unconfirmed || ''; $('#tabCount').style.display = unconfirmed ? '' : 'none';
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === prefs.view));
    const back = $('#backToDialer'); if (back) back.href = '../dialer/' + (prefs.clientId ? '?lead=' + encodeURIComponent(prefs.clientId) : '');
    if (prefs.view === 'list') return renderList(); if (prefs.view === 'settings') return renderSettings();
    renderCalendar();
  }
  function clientStrip() {
    const l = client(), q = clients(), st = C.leadState(); const idx = l ? q.findIndex(x => x.id === l.id) : -1;
    const opts = [['all', 'All leads'], ['booked', 'Marked booked'], ['callback', 'Callbacks'], ['interested', 'Interested + booked'], ['hasappt', 'Has a meeting'], ['noappt', 'No meeting yet']];
    const mine = l ? appts.filter(a => a.leadId === l.id).sort((a, b) => a.startMs - b.startMs) : [];
    const s = l ? (st[l.id] || {}) : {};
    return '<div class="card"><div class="client-strip"><button class="btn" data-action="prevClient" aria-label="Previous client">◀</button><div class="who">' +
      (l ? '<div class="n">' + esc(C.displayName(l)) + '</div><div class="b">' + esc([l.owner ? l.business : '', [l.city, l.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')) + '</div>' : '<div class="n muted">No client</div>') +
      '</div><button class="btn primary" data-action="nextClient" aria-label="Next client">▶</button></div>' +
      '<div class="row" style="margin-top:10px"><select class="grow" id="clientFilter" style="min-height:40px;padding:6px 10px;font-size:14px">' + opts.map(([k, v]) => '<option value="' + k + '"' + (prefs.filter === k ? ' selected' : '') + '>' + v + ' (' + (k === 'all' ? leads.length : leads.filter(x => { const ss = st[x.id] || {}; const has = appts.some(a => a.leadId === x.id); return k === 'booked' ? ss.disp === 'booked' : k === 'callback' ? ss.disp === 'callback' : k === 'interested' ? ['interested', 'booked'].includes(ss.disp) : k === 'hasappt' ? has : !has; }).length) + ')</option>').join('') + '</select>' +
      '<button class="iconbtn" data-action="searchClient" aria-label="Search">🔍</button><span class="small muted" style="white-space:nowrap">' + (idx + 1) + ' / ' + q.length + '</span></div>' +
      (l ? '<div class="row" style="margin-top:10px"><a class="btn sm" href="' + C.telHref(l.phone) + '">📞 ' + esc(l.phone) + '</a><a class="btn sm" href="' + C.smsHref(l.phone, '') + '">💬 Text</a>' + (l.email ? '<a class="btn sm" href="mailto:' + esc(l.email) + '">✉️</a>' : '') +
        (s.disp ? '<span class="badge">' + esc(C.dispLabel(s.disp)) + '</span>' : '') + '</div>' +
        '<div class="small" style="margin-top:8px">' + (mine.length ? mine.map(a => '<a href="#" data-appt="' + a.id + '" style="display:block;font-weight:600;text-decoration:none">' + (isConfirmed(a) ? '✅' : '⚠️') + ' ' + esc(whenStr(a)) + (isConfirmed(a) ? ' · confirmed' : ' · not confirmed yet') + '</a>').join('') : '<span class="muted">No meeting yet. Tap a time below to book ' + esc(C.firstName(l)) + '.</span>') + '</div>' : '') + '</div>';
  }
  function renderCalendar() {
    const l = client(); const today = new Date(); const [Y, M] = (prefs.month || C.ymd(today).slice(0, 7)).split('-').map(Number);
    const first = new Date(Y, M - 1, 1); const start = new Date(first); start.setDate(1 - first.getDay());
    const sel = prefs.day || C.ymd(today); const byDay = {}; appts.forEach(a => { const k = C.ymd(new Date(a.startMs)); (byDay[k] = byDay[k] || []).push(a); });
    let cells = ''; for (let i = 0; i < 42; i++) { const d = new Date(start.getTime() + i * DAY); if (i >= 35 && d.getMonth() !== M - 1) break; const k = C.ymd(d); const list = byDay[k] || [];
      cells += '<button class="day' + (d.getMonth() !== M - 1 ? ' other' : '') + (k === C.ymd(today) ? ' today' : '') + (k === sel ? ' sel' : '') + (d < today && k !== C.ymd(today) ? ' past' : '') + '" data-day="' + k + '">' + d.getDate() +
        '<span class="dots">' + list.slice(0, 3).map(a => '<i class="' + (isConfirmed(a) ? '' : 'warn') + '"></i>').join('') + '</span></button>'; }
    const [sy, sm, sd] = sel.split('-').map(Number); const selDate = new Date(sy, sm - 1, sd); const dayList = (byDay[sel] || []).sort((a, b) => a.startMs - b.startMs);
    let slots = ''; const tzDiff = l && l.tz !== C.myTz;
    for (let m = prefs.startHour * 60; m < prefs.endHour * 60; m += prefs.slotMin) {
      const t = new Date(sy, sm - 1, sd, Math.floor(m / 60), m % 60).getTime(); const hit = appts.filter(a => a.startMs < t + prefs.slotMin * MIN && endMs(a) > t);
      const tl = C.fmtTime(new Date(t)) + (tzDiff ? '<small>' + esc(C.fmtTime(new Date(t), l.tz) + ' ' + C.tzShort(l.tz, new Date(t))) + '</small>' : '');
      if (hit.length) slots += hit.map(a => '<button class="slot taken" data-appt="' + a.id + '"><span class="time">' + tl + '</span><span class="grow"><span class="nm">' + esc(a.name || 'Meeting') + '</span>' + (a.business ? ' <span class="muted small">' + esc(a.business) + '</span>' : '') +
        '<div class="st">' + (isConfirmed(a) ? '<span class="badge ok">Confirmed</span>' : '<span class="badge warn">' + (!a.ownerConfirmed && !a.meConfirmed ? 'Nobody confirmed' : !a.ownerConfirmed ? 'Owner not confirmed' : 'You have not confirmed') + '</span>') + (a.meet ? ' <span class="badge">Meet ✓</span>' : '') + '</div></span></button>').join('');
      else slots += '<button class="slot" data-book="' + t + '"><span class="time">' + tl + '</span><span class="book">+ Book ' + esc(l ? C.firstName(l) : '') + '</span></button>';
    }
    const upcomingUnconf = appts.filter(a => !isConfirmed(a) && endMs(a) > Date.now()).length;
    $('#main').innerHTML = clientStrip() +
      (upcomingUnconf ? '<button class="status-line warn" data-action="view:list" style="width:100%;border:none;text-align:left;margin-bottom:12px;cursor:pointer">⚠️ ' + upcomingUnconf + ' upcoming meeting' + (upcomingUnconf > 1 ? 's' : '') + ' not fully confirmed · tap to review</button>' : '') +
      '<div class="card"><div class="cal-head"><button class="iconbtn" data-action="month:-1">◀</button><div class="m">' + first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) + '</div><button class="iconbtn" data-action="today">Today</button><button class="iconbtn" data-action="month:1">▶</button></div>' +
      '<div class="cal-grid">' + ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(d => '<div class="dow">' + d + '</div>').join('') + cells + '</div></div>' +
      '<div class="card"><div class="row" style="margin-bottom:10px"><b class="grow">' + esc(selDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })) + '</b><span class="small muted">' + dayList.length + ' booked</span></div>' +
      (tzDiff ? '<div class="small muted" style="margin-bottom:8px">Times shown in your zone (' + esc(C.tzShort(C.myTz)) + '), then ' + esc(C.firstName(l)) + '’s (' + esc(C.tzShort(l.tz)) + ').</div>' : '') +
      '<div class="slots">' + slots + '</div><button class="btn block ghost" style="margin-top:10px" data-action="otherTime">Other time…</button></div>';
  }
  function renderList() {
    const now = Date.now(); const f = prefs.listFilter; const rows = appts.slice().sort((a, b) => a.startMs - b.startMs).filter(a => f === 'past' ? endMs(a) <= now : f === 'unconfirmed' ? !isConfirmed(a) && endMs(a) > now : f === 'confirmed' ? isConfirmed(a) && endMs(a) > now : endMs(a) > now);
    const chips = [['upcoming', 'Upcoming'], ['unconfirmed', 'Needs confirmation'], ['confirmed', 'Confirmed'], ['past', 'Past']].map(([k, v]) => '<button class="chip' + (f === k ? ' on' : '') + '" data-lf="' + k + '">' + v + '</button>').join('');
    let html = '<div class="card" style="padding:12px 16px"><div class="row"><div class="grow"><b>' + appts.filter(a => endMs(a) > now).length + '</b> upcoming · <b>' + appts.filter(a => !isConfirmed(a) && endMs(a) > now).length + '</b> need confirmation</div><button class="btn sm" data-action="exportAppts">⬇️ CSV</button></div></div>' +
      '<div class="chips" style="margin-bottom:12px">' + chips + '</div>';
    if (!rows.length) html += '<div class="card muted" style="text-align:center;padding:30px">Nothing here yet.</div>';
    let lastDay = ''; rows.forEach(a => { const k = C.ymd(new Date(a.startMs)); if (k !== lastDay) { html += (lastDay ? '</ul></div>' : '') + '<div class="card" style="padding:8px 16px"><div class="section-title" style="margin-top:6px">' + esc(C.fmtDate(new Date(a.startMs), C.myTz, { weekday: 'long', month: 'long', day: 'numeric' })) + '</div><ul class="list">'; lastDay = k; }
      html += '<li data-appt="' + a.id + '"><div style="width:74px;font-weight:700;flex:none">' + esc(C.fmtTime(new Date(a.startMs))) + '</div><div class="grow"><div class="t">' + esc(a.name || 'Meeting') + '</div><div class="s">' + esc([a.business, a.phone].filter(Boolean).join(' · ')) + '</div></div>' +
        '<div style="text-align:right;flex:none"><span class="badge ' + (a.ownerConfirmed ? 'ok' : 'warn') + '">Owner ' + (a.ownerConfirmed ? '✓' : '?') + '</span><br><span class="badge ' + (a.meConfirmed ? 'ok' : 'warn') + '" style="margin-top:3px">Me ' + (a.meConfirmed ? '✓' : '?') + '</span></div></li>'; });
    if (lastDay) html += '</ul></div>';
    $('#main').innerHTML = html;
  }
  function renderSettings() {
    const hours = Array.from({ length: 24 }, (_, h) => h); const hopt = (sel) => hours.map(h => '<option value="' + h + '"' + (sel === h ? ' selected' : '') + '>' + C.fmtTime(new Date(2000, 0, 1, h)) + '</option>').join('');
    $('#main').innerHTML =
      '<div class="card"><div class="section-title" style="margin-top:0">You (used in confirmation messages)</div><div class="stack">' +
      '<div><label class="field">Your name</label><input type="text" data-pref="myName" value="' + esc(prefs.myName) + '" placeholder="e.g. Hashim"></div>' +
      '<div class="field-row"><div><label class="field">Your phone</label><input type="tel" data-pref="myPhone" value="' + esc(prefs.myPhone) + '"></div><div><label class="field">Your email</label><input type="email" data-pref="myEmail" value="' + esc(prefs.myEmail) + '"></div></div></div></div>' +
      '<div class="card"><div class="section-title" style="margin-top:0">Calendar</div><div class="field-row"><div><label class="field">Day starts</label><select data-pref="startHour">' + hopt(+prefs.startHour) + '</select></div><div><label class="field">Day ends</label><select data-pref="endHour">' + hopt(+prefs.endHour) + '</select></div></div>' +
      '<div class="field-row" style="margin-top:10px"><div><label class="field">Slot length</label><select data-pref="slotMin">' + [15, 30, 60].map(v => '<option value="' + v + '"' + (+prefs.slotMin === v ? ' selected' : '') + '>' + v + ' min</option>').join('') + '</select></div><div><label class="field">Meeting length</label><select data-pref="duration">' + [15, 20, 30, 45, 60].map(v => '<option value="' + v + '"' + (+prefs.duration === v ? ' selected' : '') + '>' + v + ' min</option>').join('') + '</select></div></div>' +
      '<p class="small muted" style="margin:10px 0 0">Your time zone: ' + esc(C.myTz) + '. Each client’s local time is shown next to yours when it differs.</p></div>' +
      '<div class="card"><div class="section-title" style="margin-top:0">Confirmation message</div><textarea data-pref="template" style="min-height:110px">' + esc(prefs.template) + '</textarea>' +
      '<p class="small muted" style="margin:6px 0 0">Placeholders: {name} {business} {date} {time} {mytime} {meet} {me} {myphone}. Used by the Text, Email and Copy buttons on each appointment.</p></div>' +
      '<div class="card"><div class="section-title" style="margin-top:0">Google Meet</div>' +
      '<label class="field">Default Meet link (optional, pre-filled on every new booking)</label><input type="url" data-pref="defaultMeet" value="' + esc(prefs.defaultMeet) + '" placeholder="https://meet.google.com/xxx-xxxx-xxx">' +
      '<div class="small muted" style="margin-top:10px"><b>Ways to get a Meet link</b><ol style="padding-left:18px;margin:6px 0"><li><b>Add to Google Calendar</b> on an appointment opens Google Calendar with everything filled in. Turn on <i>Settings → Event settings → “Automatically add Google Meet video conferences to events I create”</i> in Google Calendar once, and every saved event gets a Meet link. Copy it into the appointment.</li>' +
      '<li><b>New Meet link</b> on an appointment opens meet.google.com/new, which creates a meeting instantly. Copy the address and paste it into the appointment.</li>' +
      '<li><b>One-tap (advanced)</b>: paste a Google OAuth Client ID below and the “Create event + Meet link” button creates the calendar event, generates the Meet link, and emails the owner an invite, all from this page.</li></ol></div>' +
      '<label class="field" style="margin-top:10px">Google OAuth Client ID (optional)</label><input type="text" data-pref="gClientId" value="' + esc(prefs.gClientId) + '" placeholder="1234567890-abc.apps.googleusercontent.com">' +
      '<details style="margin-top:8px"><summary>How to create the Client ID (about 10 minutes)</summary><ol class="small muted" style="padding-left:18px"><li>Go to console.cloud.google.com, create a project, and enable the <b>Google Calendar API</b>.</li><li>APIs & Services → OAuth consent screen: External, add your Gmail as a test user.</li><li>Credentials → Create credentials → OAuth client ID → Web application.</li><li>Authorized JavaScript origins: add <code>' + esc(location.origin) + '</code>.</li><li>Copy the Client ID here. First use will ask you to sign in and allow calendar access.</li></ol></details></div>' +
      '<div class="card"><div class="section-title" style="margin-top:0">Data (this browser only, ' + esc(C.APP.title) + ' only)</div><div class="stack">' +
      '<button class="btn block" data-action="exportAppts">⬇️ Export appointments (CSV)</button><button class="btn block" data-action="backup">💾 Backup appointments (JSON)</button>' +
      '<label class="btn block" for="restoreFile">📂 Restore from backup</label><input type="file" id="restoreFile" accept=".json,application/json" style="display:none">' +
      '<a class="btn block" href="../dialer/">📞 Open ' + esc(C.APP.title) + ' dialer</a><a class="btn block ghost" href="../../">🏠 All apps</a>' +
      '<button class="btn block danger" data-action="wipe">Delete all appointments</button></div></div>';
  }

  /* ---- appointment sheet ---- */
  function book(startMs) {
    const l = client(); const a = { id: C.uid(), leadId: l ? l.id : null, name: l ? C.displayName(l) : '', business: l ? l.business : '', phone: l ? l.phone : '', email: l ? l.email : '', tz: l ? l.tz : C.myTz,
      startMs, durationMin: +prefs.duration, meet: prefs.defaultMeet || '', notes: '', ownerConfirmed: false, meConfirmed: false, createdAt: Date.now() };
    appts.push(a); save(); if (l) C.updateState(l.id, { disp: 'booked' });
    C.toast('Booked ' + (a.name || 'meeting') + ' · ' + whenStr(a)); render(); openAppt(a.id);
  }
  function openAppt(id) {
    const a = appts.find(x => x.id === id); if (!a) return; const d = new Date(a.startMs); const tzDiff = a.tz && a.tz !== C.myTz;
    const statusHtml = () => isConfirmed(a) ? '<div class="status-line ok">✅ Confirmed by the owner and by you</div>' : '<div class="status-line warn">⚠️ Not confirmed yet: ' + [!a.ownerConfirmed ? 'owner' : '', !a.meConfirmed ? 'you' : ''].filter(Boolean).join(' and ') + '</div>';
    C.openSheet('Meeting · ' + whenStr(a),
      '<div id="apStatus">' + statusHtml() + '</div><div class="stack" style="margin-top:12px">' +
      '<div class="field-row"><div><label class="field">Client name</label><input type="text" data-ap="name" value="' + esc(a.name) + '"></div><div><label class="field">Business</label><input type="text" data-ap="business" value="' + esc(a.business) + '"></div></div>' +
      '<div class="field-row"><div><label class="field">Phone</label><input type="tel" data-ap="phone" value="' + esc(a.phone) + '"></div><div><label class="field">Email</label><input type="email" data-ap="email" value="' + esc(a.email) + '" placeholder="for the calendar invite"></div></div>' +
      '<div class="field-row"><div><label class="field">Date</label><input type="date" data-ap="date" value="' + C.ymd(d) + '"></div><div><label class="field">Time (yours)</label><input type="time" data-ap="time" value="' + C.pad(d.getHours()) + ':' + C.pad(d.getMinutes()) + '"></div></div>' +
      '<div class="field-row"><div><label class="field">Length</label><select data-ap="durationMin">' + [15, 20, 30, 45, 60, 90].map(v => '<option value="' + v + '"' + (+a.durationMin === v ? ' selected' : '') + '>' + v + ' min</option>').join('') + '</select></div>' +
      '<div><label class="field">Their local time</label><div id="apLocal" style="padding:11px 0;font-weight:700">' + esc(tzDiff ? C.fmtTime(d, a.tz) + ' ' + C.tzShort(a.tz, d) : 'same as yours') + '</div></div></div>' +
      '<div class="section-title">Confirmation</div>' +
      '<label class="toggle' + (a.ownerConfirmed ? ' on' : '') + '"><input type="checkbox" data-ap="ownerConfirmed"' + (a.ownerConfirmed ? ' checked' : '') + '><div><div class="l">Owner confirmed</div><div class="d">' + esc(a.name || 'They') + ' said yes to this time</div></div></label>' +
      '<label class="toggle' + (a.meConfirmed ? ' on' : '') + '"><input type="checkbox" data-ap="meConfirmed"' + (a.meConfirmed ? ' checked' : '') + '><div><div class="l">I confirmed</div><div class="d">It is on my calendar and I sent the details</div></div></label>' +
      '<div class="section-title">Google Meet</div>' +
      '<div class="row nowrap"><input type="url" data-ap="meet" class="grow" value="' + esc(a.meet) + '" placeholder="https://meet.google.com/…"><button class="iconbtn" data-act="pasteMeet" title="Paste">📋</button></div>' +
      '<div class="row"><a class="btn sm" href="https://meet.google.com/new" target="_blank" rel="noopener">🔗 New Meet link ↗</a><a class="btn sm" id="apGcal" href="' + esc(gcalUrl(a)) + '" target="_blank" rel="noopener">📆 Add to Google Calendar ↗</a>' +
      (prefs.gClientId ? '<button class="btn sm primary" data-act="gapi">✨ ' + (a.gcalId ? 'Update event' : 'Create event + Meet link') + '</button>' : '') + (a.gcalLink ? '<a class="btn sm" href="' + esc(a.gcalLink) + '" target="_blank" rel="noopener">Open event ↗</a>' : '') + '</div>' +
      '<div class="section-title">Send the details</div>' +
      '<div class="row"><a class="btn sm" id="apSms" href="' + esc(C.smsHref(a.phone, fillMessage(a))) + '">💬 Text owner</a><a class="btn sm" id="apMail" href="' + esc(C.mailHref(a.email, 'Our meeting ' + whenStr(a, a.tz), fillMessage(a))) + '">✉️ Email</a><button class="btn sm" data-act="copy">📋 Copy message</button><button class="btn sm" data-act="ics">⬇️ .ics</button></div>' +
      '<div><label class="field">Notes</label><textarea data-ap="notes" style="min-height:70px">' + esc(a.notes) + '</textarea></div>' +
      '<div class="row" style="margin-top:6px"><button class="btn danger grow" data-act="delete">Delete</button><button class="btn primary grow" data-act="done">Done</button></div></div>',
      sh => {
        const refresh = () => { sh.querySelector('#apStatus').innerHTML = statusHtml(); const dd = new Date(a.startMs); sh.querySelector('#apLocal').textContent = a.tz && a.tz !== C.myTz ? C.fmtTime(dd, a.tz) + ' ' + C.tzShort(a.tz, dd) : 'same as yours';
          sh.querySelector('#apGcal').href = gcalUrl(a); sh.querySelector('#apSms').href = C.smsHref(a.phone, fillMessage(a)); sh.querySelector('#apMail').href = C.mailHref(a.email, 'Our meeting ' + whenStr(a, a.tz), fillMessage(a)); sh.querySelector('h3').firstChild.textContent = 'Meeting · ' + whenStr(a); };
        sh.querySelectorAll('[data-ap]').forEach(el => el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' || el.type === 'date' || el.type === 'time' ? 'change' : 'input', () => {
          const k = el.dataset.ap;
          if (k === 'date' || k === 'time') { const date = sh.querySelector('[data-ap=date]').value, time = sh.querySelector('[data-ap=time]').value; if (date && time) { const [y, m, dd] = date.split('-').map(Number), [h, mi] = time.split(':').map(Number); a.startMs = new Date(y, m - 1, dd, h, mi).getTime(); prefs.day = date; prefs.month = date.slice(0, 7); savePrefs(); } }
          else if (el.type === 'checkbox') { a[k] = el.checked; el.closest('.toggle').classList.toggle('on', el.checked); }
          else if (k === 'durationMin') a[k] = +el.value; else a[k] = el.value;
          save(); refresh();
        }));
        sh.onclick = async e => {
          const b = e.target.closest('[data-act]'); if (!b) return; const act = b.dataset.act;
          if (act === 'done') C.closeSheet();
          else if (act === 'delete') { if (confirm('Delete this meeting?')) { appts = appts.filter(x => x.id !== a.id); save(); if (a.leadId && !appts.some(x => x.leadId === a.leadId)) { const s = C.getState(a.leadId); if (s.disp === 'booked') C.updateState(a.leadId, { disp: 'interested' }); } C.closeSheet(); } }
          else if (act === 'copy') C.copyText(fillMessage(a));
          else if (act === 'ics') C.download((a.name || 'meeting').replace(/[^\w]+/g, '-') + '.ics', icsFor(a), 'text/calendar');
          else if (act === 'pasteMeet') { try { const t = await navigator.clipboard.readText(); if (/meet\.google\.com/.test(t)) { a.meet = t.trim(); sh.querySelector('[data-ap=meet]').value = a.meet; save(); refresh(); C.toast('Meet link pasted'); } else C.toast('Clipboard does not contain a Meet link'); } catch (err) { C.toast('Paste blocked, long-press the field instead'); } }
          else if (act === 'gapi') { b.disabled = true; b.textContent = 'Working…'; try { await createGoogleEvent(a); sh.querySelector('[data-ap=meet]').value = a.meet; a.meConfirmed = true; save(); refresh(); C.toast('Event created' + (a.email ? ' and invite emailed' : '')); C.closeSheet(); openAppt(a.id); } catch (err) { alert(err.message); b.disabled = false; b.textContent = '✨ Create event + Meet link'; } }
        };
      }, render);
  }
  function openOtherTime() {
    const l = client(); const sel = prefs.day || C.ymd(new Date());
    C.openSheet('Book ' + (l ? C.firstName(l) : 'a meeting') + ' at any time', '<div class="field-row"><div><label class="field">Date</label><input type="date" id="otDate" value="' + sel + '"></div><div><label class="field">Time (yours)</label><input type="time" id="otTime" value="12:00"></div></div><button class="btn primary block" id="otGo" style="margin-top:12px">Book it</button>',
      sh => { sh.querySelector('#otGo').onclick = () => { const [y, m, d] = sh.querySelector('#otDate').value.split('-').map(Number), [h, mi] = sh.querySelector('#otTime').value.split(':').map(Number); if (!y || isNaN(h)) return; prefs.day = sh.querySelector('#otDate').value; prefs.month = prefs.day.slice(0, 7); savePrefs(); C.closeSheet(); book(new Date(y, m - 1, d, h, mi).getTime()); }; });
  }
  function openClientSearch() {
    C.openSheet('Find a client', '<input type="search" id="q" placeholder="Name, business, phone, city…" autocomplete="off"><ul class="list" id="qres"></ul>', sh => {
      const inp = sh.querySelector('#q'), res = sh.querySelector('#qres'), st = C.leadState();
      const run = () => { const t = inp.value.trim().toLowerCase(), td = C.digits(t); if (!t) { res.innerHTML = '<li class="muted small">Type to search ' + leads.length + ' leads</li>'; return; }
        res.innerHTML = leads.filter(l => [l.owner, l.business, l.city, l.state, l.market].join(' ').toLowerCase().includes(t) || (td && C.digits(l.phone).includes(td))).slice(0, 60)
          .map(l => '<li data-go="' + l.id + '"><div class="grow"><div class="t">' + esc(C.displayName(l)) + '</div><div class="s">' + esc([l.business, l.phone, l.city].filter(Boolean).join(' · ')) + '</div></div>' + ((st[l.id] || {}).disp ? '<span class="badge">' + esc(C.dispLabel(st[l.id].disp)) + '</span>' : '') + '</li>').join('') || '<li class="muted small">No matches</li>'; };
      inp.oninput = run; run(); setTimeout(() => inp.focus(), 50);
      res.onclick = e => { const li = e.target.closest('[data-go]'); if (li) { prefs.clientId = li.dataset.go; if (!clients().some(x => x.id === prefs.clientId)) prefs.filter = 'all'; savePrefs(); C.closeSheet(); render(); } };
    });
  }
  function exportAppts() {
    const cols = ['Date', 'Time (mine)', 'Time (client)', 'Length (min)', 'Client', 'Business', 'Phone', 'Email', 'Owner confirmed', 'I confirmed', 'Google Meet', 'Notes'];
    const rows = appts.slice().sort((a, b) => a.startMs - b.startMs).map(a => { const d = new Date(a.startMs); return { Date: C.ymd(d), 'Time (mine)': C.fmtTime(d), 'Time (client)': C.fmtTime(d, a.tz) + ' ' + C.tzShort(a.tz, d), 'Length (min)': a.durationMin, Client: a.name, Business: a.business, Phone: a.phone, Email: a.email,
      'Owner confirmed': a.ownerConfirmed ? 'Y' : 'N', 'I confirmed': a.meConfirmed ? 'Y' : 'N', 'Google Meet': a.meet, Notes: a.notes }; });
    C.download(C.APP.campaign + '-appointments-' + C.ymd(new Date()) + '.csv', C.toCSV(cols, rows), 'text/csv'); C.toast('CSV downloaded');
  }

  /* ---- events ---- */
  document.addEventListener('click', e => {
    const ap = e.target.closest('[data-appt]'); if (ap) { e.preventDefault(); openAppt(ap.dataset.appt); return; }
    const bk = e.target.closest('[data-book]'); if (bk) { book(+bk.dataset.book); return; }
    const dy = e.target.closest('[data-day]'); if (dy) { prefs.day = dy.dataset.day; prefs.month = dy.dataset.day.slice(0, 7); savePrefs(); render(); return; }
    const lf = e.target.closest('[data-lf]'); if (lf) { prefs.listFilter = lf.dataset.lf; savePrefs(); render(); return; }
    const tab = e.target.closest('.tabs [data-view]'); if (tab) { prefs.view = tab.dataset.view; savePrefs(); render(); window.scrollTo(0, 0); return; }
    const a = e.target.closest('[data-action]'); if (!a) return; const act = a.dataset.action;
    if (act === 'nextClient') moveClient(1); else if (act === 'prevClient') moveClient(-1); else if (act === 'searchClient') openClientSearch();
    else if (act === 'today') { prefs.month = C.ymd(new Date()).slice(0, 7); prefs.day = C.ymd(new Date()); savePrefs(); render(); }
    else if (act.startsWith('month:')) { const [Y, M] = (prefs.month || C.ymd(new Date()).slice(0, 7)).split('-').map(Number); const d = new Date(Y, M - 1 + (+act.split(':')[1]), 1); prefs.month = C.ymd(d).slice(0, 7); savePrefs(); render(); }
    else if (act.startsWith('view:')) { prefs.view = act.split(':')[1]; if (prefs.view === 'list') prefs.listFilter = 'unconfirmed'; savePrefs(); render(); window.scrollTo(0, 0); }
    else if (act === 'otherTime') openOtherTime(); else if (act === 'exportAppts') exportAppts();
    else if (act === 'backup') C.download(C.APP.campaign + '-appointments-backup.json', JSON.stringify({ campaign: C.APP.campaign, appointments: appts, leadState: C.leadState() }, null, 2), 'application/json');
    else if (act === 'wipe') { if (confirm('Delete every appointment in the ' + C.APP.title + ' calendar?')) { appts = []; save(); render(); } }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'clientFilter') { prefs.filter = e.target.value; savePrefs(); render(); }
    if (e.target.id === 'restoreFile') { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { try { const j = JSON.parse(r.result); if (!Array.isArray(j.appointments)) throw new Error('not a backup file'); if (j.campaign && j.campaign !== C.APP.campaign && !confirm('This backup is from the ' + j.campaign + ' calendar. Restore it here anyway?')) return; appts = j.appointments; save(); if (j.leadState) store.set('leadState', j.leadState); render(); C.toast('Restored ' + appts.length + ' appointments'); } catch (err) { alert('Restore failed: ' + err.message); } }; r.readAsText(f); }
    const p = e.target.dataset && e.target.dataset.pref; if (p && e.target.tagName === 'SELECT') { prefs[p] = +e.target.value; savePrefs(); }
  });
  const savePref = C.debounce(() => savePrefs(), 300);
  document.addEventListener('input', e => { const p = e.target.dataset && e.target.dataset.pref; if (p && e.target.tagName !== 'SELECT') { prefs[p] = e.target.value; savePref(); } });
  const q = new URLSearchParams(location.search);
  if (q.get('lead') && C.leadById(q.get('lead'))) { prefs.clientId = q.get('lead'); prefs.view = 'calendar'; if (!clients().some(x => x.id === prefs.clientId)) prefs.filter = 'all'; savePrefs(); history.replaceState(null, '', location.pathname); }
  if (!prefs.month) prefs.month = C.ymd(new Date()).slice(0, 7);
  render();
})();
