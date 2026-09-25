/* Power dialer: one lead on screen, one CALL button, outcome -> next. */
(function () {
  const C = window.Common, esc = C.esc, store = C.store;
  let leads = C.getLeads();
  const DEF = { currentId: null, tier: '', market: '', state: '', status: 'all', autoAdvance: true, autoDial: false };
  let prefs = Object.assign({}, DEF, store.get('dialer.prefs', {}));
  const savePrefs = () => store.set('dialer.prefs', prefs);
  const $ = sel => document.querySelector(sel);
  const REDIAL = ['noanswer', 'voicemail', 'gatekeeper'];

  function queue() {
    const st = C.leadState();
    const q = leads.filter(l => {
      const s = st[l.id] || {};
      if (prefs.tier && l.tier !== prefs.tier) return false;
      if (prefs.market && l.market !== prefs.market) return false;
      if (prefs.state && l.state !== prefs.state) return false;
      switch (prefs.status) {
        case 'notcalled': return !C.wasCalled(s);
        case 'called': return C.wasCalled(s);
        case 'redial': return REDIAL.includes(s.disp);
        case 'callback': return s.disp === 'callback';
        case 'interested': return s.disp === 'interested';
        case 'booked': return s.disp === 'booked';
      }
      return true;
    });
    if (prefs.status === 'callback') q.sort((a, b) => ((st[a.id] || {}).callbackAt || '9') < ((st[b.id] || {}).callbackAt || '9') ? -1 : 1);
    return q;
  }
  function current() {
    const q = queue(); if (!q.length) return null;
    let l = q.find(x => x.id === prefs.currentId);
    if (!l) { const cur = C.leadById(prefs.currentId); l = (cur && q.find(x => x.rank >= cur.rank)) || q[0]; prefs.currentId = l.id; savePrefs(); }
    return l;
  }
  function move(dir) {
    const q = queue(); if (!q.length) { C.toast('No leads match the current filter'); return; }
    const i = q.findIndex(x => x.id === prefs.currentId); let n;
    if (i >= 0) n = q[(i + dir + q.length) % q.length];
    else { const cur = C.leadById(prefs.currentId), r = cur ? cur.rank : 0;
      n = dir > 0 ? (q.find(x => x.rank > r) || q[0]) : (q.slice().reverse().find(x => x.rank < r) || q[q.length - 1]); }
    prefs.currentId = n.id; savePrefs(); render(); window.scrollTo(0, 0);
    if (dir > 0 && prefs.autoDial) dial(n);
  }
  function recordCall(l) { const s = C.getState(l.id); C.updateState(l.id, { calls: (s.calls || []).concat(Date.now()) }); }
  function dial(l) { recordCall(l); window.location.href = C.telHref(l.phone); setTimeout(render, 300); }
  function goTo(id) { prefs.currentId = id; savePrefs(); C.closeSheet(); render(); window.scrollTo(0, 0); }
  function apptFor(id) { return (store.get('appointments', []) || []).filter(a => a.leadId === id).sort((a, b) => a.startMs - b.startMs)[0]; }
  function activeFilterCount() { return ['tier', 'market', 'state'].filter(k => prefs[k]).length + (prefs.status !== 'all' ? 1 : 0); }
  const fmtStamp = ms => C.fmtDate(new Date(ms)) + ' ' + C.fmtTime(new Date(ms));
  const fmtLocalInput = s => s ? s.replace('T', ' ').slice(0, 16) : '';

  function render() {
    const l = current(), q = queue(), st = C.leadState(), main = $('#main');
    $('#filterCount').textContent = activeFilterCount() || ''; $('#filterCount').style.display = activeFilterCount() ? '' : 'none';
    const cbDue = leads.filter(x => (st[x.id] || {}).disp === 'callback').length; $('#cbCount').textContent = cbDue || ''; $('#cbCount').style.display = cbDue ? '' : 'none';
    if (!l) {
      main.innerHTML = '<div class="card" style="text-align:center;padding:40px 16px"><div style="font-size:40px">🎉</div><p><b>No leads match this filter.</b></p>' +
        '<p class="muted small">' + leads.length + ' leads in this list.</p><button class="btn primary" data-action="clearFilters">Show all leads</button></div>';
      return;
    }
    const s = st[l.id] || {}, idx = q.findIndex(x => x.id === l.id), called = q.filter(x => C.wasCalled(st[x.id])).length;
    const now = new Date(), hr = C.hourIn(l.tz, now), local = C.fmtTime(now, l.tz) + ' ' + C.tzShort(l.tz, now), off = hr < 8 || hr >= 19;
    const appt = apptFor(l.id);
    const filt = [prefs.status !== 'all' ? ({ notcalled: 'Not called', called: 'Called', redial: 'Redial', callback: 'Callbacks', interested: 'Interested', booked: 'Booked' })[prefs.status] : '',
      prefs.tier ? 'Tier ' + prefs.tier : '', prefs.market, prefs.state].filter(Boolean).join(' · ');
    let status = '';
    if (C.wasCalled(s)) {
      const parts = [];
      if (s.calls && s.calls.length) parts.push('Called ' + s.calls.length + '× · last ' + fmtStamp(s.calls[s.calls.length - 1]));
      if (s.disp) parts.push('<b>' + esc(C.dispLabel(s.disp)) + '</b>');
      if (s.disp === 'callback' && s.callbackAt) parts.push('call back ' + esc(fmtLocalInput(s.callbackAt)));
      if (appt) parts.push('meeting ' + esc(C.fmtDate(new Date(appt.startMs)) + ' ' + C.fmtTime(new Date(appt.startMs))) + (appt.ownerConfirmed && appt.meConfirmed ? ' ✅' : ' ⚠️ unconfirmed'));
      status = '<div class="status-line ' + (['booked', 'interested'].includes(s.disp) ? 'ok' : 'warn') + '" style="margin-top:10px">' + parts.join(' · ') + '</div>';
    }
    main.innerHTML =
      '<div class="progress-wrap"><span><b>Lead ' + (idx + 1) + ' of ' + q.length + '</b>' + (filt ? ' · ' + esc(filt) : '') + '</span><div class="progress"><div style="width:' + Math.round(100 * called / Math.max(1, q.length)) + '%"></div></div><span>' + called + ' called</span></div>' +
      '<div class="card" style="padding:14px 16px">' +
      '<div class="row" style="margin-bottom:4px">' + (l.tier ? '<span class="badge tier">Tier ' + esc(l.tier) + '</span>' : '') +
      (l.rating ? '<span class="badge">BBB ' + esc(l.rating) + (l.accredited ? ' ✓' : '') + '</span>' : '') + (l.years ? '<span class="badge">' + esc(l.years) + ' yrs</span>' : '') +
      (l.market && l.market !== l.city ? '<span class="badge">' + esc(l.market) + '</span>' : '') + '</div>' +
      '<h1 class="lead-name">' + esc(C.displayName(l)) + '</h1>' +
      (l.owner ? '<div class="lead-biz">' + esc(l.business) + '</div>' : '<div class="lead-biz muted">Owner name unknown, ask who owns it</div>') +
      '<div class="muted">' + esc([l.title, [l.city, l.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')) + '</div>' +
      '<div class="small muted" style="margin-top:4px">Their local time <b>' + esc(local) + '</b> ' + (off ? '<span class="badge warn">outside 8am–7pm</span>' : '') + '</div>' +
      '<a class="lead-phone" href="' + C.telHref(l.phone) + '" data-action="call">' + esc(l.phone) + '</a>' +
      (l.phoneAlt ? '<a class="lead-phone alt" href="' + C.telHref(l.phoneAlt) + '" data-action="call">alt ' + esc(l.phoneAlt) + '</a>' : '') +
      '<div class="links small" style="margin-top:8px">' + (l.website ? '<a href="' + esc(l.website) + '" target="_blank" rel="noopener">Website ↗</a>' : '') +
      (l.email ? '<a href="mailto:' + esc(l.email) + '">' + esc(l.email) + '</a>' : '') + (l.profile ? '<a href="' + esc(l.profile) + '" target="_blank" rel="noopener">BBB/YP ↗</a>' : '') + '</div>' +
      status +
      (l.notes || l.services ? '<details style="margin-top:10px"><summary>Why qualified / research notes</summary><p class="small muted" style="margin:6px 0">' + esc(l.notes) + '</p>' +
        (l.services ? '<p class="small muted" style="margin:6px 0">Services: ' + esc(l.services) + '</p>' : '') + '</details>' : '') +
      '</div>' +
      '<a class="btn-call" href="' + C.telHref(l.phone) + '" data-action="call">📞 CALL <small>' + esc(l.phone) + '</small></a>' +
      '<div class="navrow" style="margin-top:10px"><button class="btn" data-action="prev">◀ Back<span class="kbd">P</span></button><button class="btn primary" data-action="next">Next ▶<span class="kbd">N</span></button></div>' +
      '<div class="card" style="margin-top:12px"><div class="section-title" style="margin-top:0">Outcome ' + (prefs.autoAdvance ? '<span class="muted" style="text-transform:none;font-weight:500">(tap = save + next)</span>' : '') + '</div>' +
      '<div class="chips">' + C.DISPOSITIONS.map((d, i) => '<button class="chip disp-' + d.k + (s.disp === d.k ? ' on' : '') + '" data-disp="' + d.k + '">' + esc(d.label) + '<span class="kbd">' + (i + 1) + '</span></button>').join('') + '</div>' +
      (s.disp === 'callback' ? '<label class="field" style="margin-top:10px">Call back on</label><input type="datetime-local" data-field="callbackAt" value="' + esc(s.callbackAt || '') + '">' : '') +
      '<label class="field" style="margin-top:10px">Call notes</label><textarea data-field="notes" placeholder="What did they say?">' + esc(s.notes || '') + '</textarea>' +
      '<a class="btn block" style="margin-top:10px" href="../booking/?lead=' + encodeURIComponent(l.id) + '">📅 Book a meeting with ' + esc(C.firstName(l)) + '</a></div>';
  }

  function setDisp(k) {
    const l = current(); if (!l) return; const s = C.getState(l.id); const next = s.disp === k ? '' : k;
    if (next === 'callback') { C.updateState(l.id, { disp: next }); render(); askCallback(l); return; }
    C.updateState(l.id, { disp: next });
    if (next === 'booked') { C.toast('Marked booked, opening booking'); window.location.href = '../booking/?lead=' + encodeURIComponent(l.id); return; }
    if (next && prefs.autoAdvance) move(1); else render();
  }
  function askCallback(l) {
    const s = C.getState(l.id); const d = new Date(Date.now() + 864e5); d.setHours(10, 0, 0, 0);
    const def = s.callbackAt || (C.ymd(d) + 'T10:00');
    C.openSheet('Call back ' + C.firstName(l),
      '<label class="field">When</label><input type="datetime-local" id="cbAt" value="' + esc(def) + '">' +
      '<div class="chips" style="margin:10px 0"><button class="chip" data-quick="1">Tomorrow 10am</button><button class="chip" data-quick="2">In 2 days</button><button class="chip" data-quick="7">Next week</button></div>' +
      '<button class="btn primary block" id="cbSave">Save' + (prefs.autoAdvance ? ' & next' : '') + '</button>',
      sh => {
        sh.querySelectorAll('[data-quick]').forEach(b => b.onclick = () => { const x = new Date(Date.now() + 864e5 * +b.dataset.quick); x.setHours(10, 0, 0, 0); sh.querySelector('#cbAt').value = C.ymd(x) + 'T10:00'; });
        sh.querySelector('#cbSave').onclick = () => { C.updateState(l.id, { callbackAt: sh.querySelector('#cbAt').value }); C.closeSheet(); if (prefs.autoAdvance) move(1); else render(); };
      });
  }
  function openSearch() {
    C.openSheet('Search leads', '<input type="search" id="q" placeholder="Name, business, phone, city…" autocomplete="off"><ul class="list" id="qres"></ul>', sh => {
      const inp = sh.querySelector('#q'), res = sh.querySelector('#qres'); const st = C.leadState();
      const run = () => {
        const t = inp.value.trim().toLowerCase(), td = C.digits(t); if (!t) { res.innerHTML = '<li class="muted small">Type to search ' + leads.length + ' leads</li>'; return; }
        const hits = leads.filter(l => [l.owner, l.business, l.city, l.state, l.market, l.email].join(' ').toLowerCase().includes(t) || (td && C.digits(l.phone).includes(td))).slice(0, 60);
        res.innerHTML = hits.map(l => { const s = st[l.id] || {}; return '<li data-go="' + l.id + '"><div class="grow"><div class="t">' + esc(C.displayName(l)) + '</div><div class="s">' + esc([l.business, l.phone, [l.city, l.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')) + '</div></div>' +
          (s.disp ? '<span class="badge">' + esc(C.dispLabel(s.disp)) + '</span>' : (C.wasCalled(s) ? '<span class="badge">called</span>' : '')) + '</li>'; }).join('') || '<li class="muted small">No matches</li>';
      };
      inp.oninput = run; run(); setTimeout(() => inp.focus(), 50);
      res.onclick = e => { const li = e.target.closest('[data-go]'); if (li) goTo(li.dataset.go); };
    });
  }
  function openFilters() {
    const st = C.leadState(); const count = f => leads.filter(f).length;
    const tiers = [...new Set(leads.map(l => l.tier).filter(Boolean))].sort();
    const markets = [...new Set(leads.map(l => l.market).filter(Boolean))].sort();
    const states = [...new Set(leads.map(l => l.state).filter(Boolean))].sort();
    const statuses = [['all', 'All'], ['notcalled', 'Not called'], ['called', 'Called'], ['redial', 'Redial (no answer / VM)'], ['callback', 'Callbacks'], ['interested', 'Interested'], ['booked', 'Booked']];
    const chip = (attr, v, label, on) => '<button class="chip' + (on ? ' on' : '') + '" data-' + attr + '="' + esc(v) + '">' + esc(label) + '</button>';
    C.openSheet('Filters & settings',
      '<div class="section-title">Status</div><div class="chips">' + statuses.map(([k, lab]) => chip('status', k, lab, prefs.status === k)).join('') + '</div>' +
      (tiers.length > 1 ? '<div class="section-title">Tier</div><div class="chips">' + chip('tier', '', 'All', !prefs.tier) + tiers.map(t => chip('tier', t, 'Tier ' + t + ' (' + count(l => l.tier === t) + ')', prefs.tier === t)).join('') + '</div>' : '') +
      (markets.length > 1 ? '<div class="section-title">Market</div><select id="fMarket"><option value="">All markets</option>' + markets.map(m => '<option value="' + esc(m) + '"' + (prefs.market === m ? ' selected' : '') + '>' + esc(m) + ' (' + count(l => l.market === m) + ')</option>').join('') + '</select>' : '') +
      (states.length > 1 ? '<div class="section-title">State</div><select id="fState"><option value="">All states</option>' + states.map(m => '<option value="' + esc(m) + '"' + (prefs.state === m ? ' selected' : '') + '>' + esc(m) + ' (' + count(l => l.state === m) + ')</option>').join('') + '</select>' : '') +
      '<div class="section-title">Behaviour</div><div class="stack">' +
      '<label class="toggle' + (prefs.autoAdvance ? ' on' : '') + '"><input type="checkbox" id="fAuto"' + (prefs.autoAdvance ? ' checked' : '') + '><div><div class="l">Auto-advance after outcome</div><div class="d">Tapping an outcome saves it and shows the next lead</div></div></label>' +
      '<label class="toggle' + (prefs.autoDial ? ' on' : '') + '"><input type="checkbox" id="fDial"' + (prefs.autoDial ? ' checked' : '') + '><div><div class="l">Auto-dial on Next</div><div class="d">Starts the call as soon as the next lead appears (your phone still asks to confirm)</div></div></label></div>' +
      '<div class="row" style="margin-top:14px"><button class="btn grow" data-action="clearFilters">Clear filters</button><button class="btn primary grow" data-action="firstUncalled">Jump to first uncalled</button></div>',
      sh => {
        sh.onclick = e => {
          const b = e.target.closest('[data-status],[data-tier]'); if (!b) return;
          if (b.dataset.status != null) prefs.status = b.dataset.status; if (b.dataset.tier != null) prefs.tier = b.dataset.tier;
          savePrefs(); C.closeSheet(); render(); openFilters();
        };
        const m = sh.querySelector('#fMarket'); if (m) m.onchange = () => { prefs.market = m.value; savePrefs(); render(); };
        const s = sh.querySelector('#fState'); if (s) s.onchange = () => { prefs.state = s.value; savePrefs(); render(); };
        sh.querySelector('#fAuto').onchange = e => { prefs.autoAdvance = e.target.checked; savePrefs(); e.target.closest('.toggle').classList.toggle('on', e.target.checked); render(); };
        sh.querySelector('#fDial').onchange = e => { prefs.autoDial = e.target.checked; savePrefs(); e.target.closest('.toggle').classList.toggle('on', e.target.checked); };
      });
  }
  function openCallbacks() {
    const st = C.leadState();
    const items = leads.filter(l => (st[l.id] || {}).disp === 'callback').sort((a, b) => ((st[a.id].callbackAt || '9') < (st[b.id].callbackAt || '9') ? -1 : 1));
    const nowKey = new Date().toISOString().slice(0, 16);
    C.openSheet('Callbacks (' + items.length + ')', '<ul class="list">' + (items.map(l => { const at = st[l.id].callbackAt || ''; const due = at && at.replace('T', 'T') <= C.ymd(new Date()) + 'T' + C.pad(new Date().getHours()) + ':' + C.pad(new Date().getMinutes());
      return '<li data-go="' + l.id + '"><div class="grow"><div class="t">' + esc(C.displayName(l)) + ' <span class="muted small">' + esc(l.business) + '</span></div><div class="s">' + esc(l.phone) + (st[l.id].notes ? ' · ' + esc(st[l.id].notes.slice(0, 60)) : '') + '</div></div>' +
        '<span class="badge ' + (due ? 'bad' : 'warn') + '">' + (at ? esc(fmtLocalInput(at)) : 'no time') + '</span></li>'; }).join('') || '<li class="muted small">No callbacks scheduled. Tap “Callback” on a lead to add one.</li>') + '</ul>',
      sh => { sh.onclick = e => { const li = e.target.closest('[data-go]'); if (li) goTo(li.dataset.go); }; });
    void nowKey;
  }
  function openMore() {
    const st = C.leadState(); const today = C.ymd(new Date());
    const calledToday = leads.filter(l => (st[l.id] || {}).calls && st[l.id].calls.some(t => C.ymd(new Date(t)) === today)).length;
    const counts = C.DISPOSITIONS.map(d => d.label + ': ' + leads.filter(l => (st[l.id] || {}).disp === d.k).length).join(' · ');
    const custom = store.get('customLeads', null);
    C.openSheet(C.APP.title + ' dialer',
      '<div class="card" style="margin:0 0 12px"><div class="small muted">Today</div><div style="font-size:28px;font-weight:800">' + calledToday + ' calls</div>' +
      '<div class="small muted">' + leads.filter(l => C.wasCalled(st[l.id])).length + ' of ' + leads.length + ' leads called · ' + esc(counts) + '</div></div>' +
      '<div class="stack">' +
      '<button class="btn block" data-action="export">⬇️ Export results as CSV</button>' +
      '<label class="btn block" for="importFile">⬆️ Import a different lead list (CSV)</label><input type="file" id="importFile" accept=".csv,text/csv" style="display:none">' +
      (custom ? '<button class="btn block" data-action="restore">↩️ Restore the built-in list (' + (window.LEADS || []).length + ' leads)</button>' : '') +
      '<a class="btn block" href="../booking/">📅 Open ' + esc(C.APP.title) + ' booking</a>' +
      '<a class="btn block ghost" href="../../">🏠 All apps</a>' +
      '<button class="btn block danger" data-action="reset">Reset all call outcomes for this list</button></div>' +
      '<p class="small muted" style="margin-top:12px">Data is saved in this browser only. Export regularly. Shortcuts on a keyboard: C call, N next, P back, 1–8 outcome, / search.</p>',
      sh => { sh.querySelector('#importFile').onchange = e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader();
        r.onload = () => { try { const out = C.importLeadsCSV(r.result, C.APP.campaign[0]); store.set('customLeads', out); leads = C.getLeads(); prefs.currentId = null; Object.assign(prefs, { tier: '', market: '', state: '', status: 'all' }); savePrefs(); C.closeSheet(); render(); C.toast('Imported ' + out.length + ' leads'); }
          catch (err) { alert('Import failed: ' + err.message); } }; r.readAsText(f); }; });
  }
  function exportCSV() {
    const st = C.leadState(); const cols = ['Rank', 'Tier', 'Owner', 'Title', 'Business', 'Phone', 'Alt phone', 'City', 'State', 'Market', 'Website', 'Email', 'BBB rating', 'Years', 'Called?', 'Times called', 'Last called', 'Outcome', 'Callback date', 'Call notes', 'Research notes'];
    const rows = leads.map(l => { const s = st[l.id] || {}; const last = s.calls && s.calls.length ? new Date(s.calls[s.calls.length - 1]) : null;
      return { Rank: l.rank, Tier: l.tier, Owner: l.owner, Title: l.title, Business: l.business, Phone: l.phone, 'Alt phone': l.phoneAlt, City: l.city, State: l.state, Market: l.market, Website: l.website, Email: l.email,
        'BBB rating': l.rating, Years: l.years, 'Called?': C.wasCalled(s) ? 'Y' : 'N', 'Times called': (s.calls || []).length, 'Last called': last ? C.ymd(last) + ' ' + C.pad(last.getHours()) + ':' + C.pad(last.getMinutes()) : '',
        Outcome: C.dispLabel(s.disp), 'Callback date': fmtLocalInput(s.callbackAt), 'Call notes': s.notes || '', 'Research notes': l.notes }; });
    C.download(C.APP.campaign + '-calls-' + C.ymd(new Date()) + '.csv', C.toCSV(cols, rows), 'text/csv'); C.toast('CSV downloaded');
  }

  document.addEventListener('click', e => {
    const a = e.target.closest('[data-action]'); const chip = e.target.closest('[data-disp]');
    if (chip) { setDisp(chip.dataset.disp); return; }
    if (!a) return; const act = a.dataset.action;
    if (act === 'call') { const l = current(); if (l) { recordCall(l); setTimeout(render, 400); } return; } // let the tel: link do its job
    e.preventDefault();
    if (act === 'next') move(1); else if (act === 'prev') move(-1);
    else if (act === 'search') openSearch(); else if (act === 'filters') openFilters(); else if (act === 'callbacks') openCallbacks(); else if (act === 'more') openMore();
    else if (act === 'clearFilters') { Object.assign(prefs, { tier: '', market: '', state: '', status: 'all' }); savePrefs(); C.closeSheet(); render(); }
    else if (act === 'firstUncalled') { const st = C.leadState(); const f = queue().find(l => !C.wasCalled(st[l.id])); if (f) goTo(f.id); else C.toast('Everything in this filter has been called'); }
    else if (act === 'export') exportCSV();
    else if (act === 'restore') { store.remove('customLeads'); leads = C.getLeads(); prefs.currentId = null; savePrefs(); C.closeSheet(); render(); C.toast('Built-in list restored'); }
    else if (act === 'reset') { if (confirm('Clear every call outcome and note for this list? Appointments are kept.')) { store.remove('leadState'); C.closeSheet(); render(); } }
  });
  const saveNotes = C.debounce((id, v) => C.updateState(id, { notes: v }), 400);
  document.addEventListener('input', e => { const f = e.target.dataset && e.target.dataset.field; const l = current(); if (!f || !l) return;
    if (f === 'notes') saveNotes(l.id, e.target.value); else C.updateState(l.id, { [f]: e.target.value }); });
  document.addEventListener('keydown', e => {
    if (C.sheetOpen() || /input|textarea|select/i.test(e.target.tagName)) return;
    if (e.key === 'n' || e.key === 'ArrowRight') move(1); else if (e.key === 'p' || e.key === 'ArrowLeft') move(-1);
    else if (e.key === 'c' || e.key === 'Enter') { const a = $('.btn-call'); if (a) a.click(); }
    else if (e.key === '/') { e.preventDefault(); openSearch(); }
    else if (/^[1-8]$/.test(e.key)) { const d = C.DISPOSITIONS[+e.key - 1]; if (d) setDisp(d.k); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
  setInterval(() => { if (!C.sheetOpen() && document.activeElement && !/textarea|input/i.test(document.activeElement.tagName)) render(); }, 60000);
  const p = new URLSearchParams(location.search); if (p.get('lead') && C.leadById(p.get('lead'))) { prefs.currentId = p.get('lead'); savePrefs(); history.replaceState(null, '', location.pathname); }
  render();
})();
