(() => {
  'use strict';

  // ---------- Konfigurasi ----------
  const OSRM = 'https://router.project-osrm.org';
  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const MAX_STOPS = 100;
  const MAX_NAME = 60;
  const MAX_PHOTOS = 10; // foto per titik
  const STORE_KEY = 'rutepintar.v2'; // { plans: [{ id, name, round, stops, createdAt, updatedAt }] }
  const OLD_KEY = 'rutepintar.v1'; // versi lama (tanpa rencana): { stops, round }
  const PHOTO_ID_RE = /^f[a-z0-9]{6,}$/;
  const MAX_GEOM = 800; // titik geometri rute yang disimpan per rencana
  // Koordinat "lat,lng" (pemisah koma, titik koma, atau spasi)
  const COORD_RE = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
  function parseCoord(text) {
    const m = String(text).match(COORD_RE);
    if (!m) return null;
    const lat = +m[1];
    const lng = +m[2];
    return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
  }

  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Plugin Capacitor (hanya ada di aplikasi Android; di web semuanya undefined)
  const CAP = window.Capacitor;
  const plug = (n) => (CAP && CAP.Plugins && CAP.Plugins[n]) || null;
  const isNative = !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform());

  const state = {
    plan: null, // rencana yang sedang dibuka (null = layar Beranda)
    stops: [], // { id, label, lat, lng }
    legs: [], // { distance, duration } per ruas, sesuai urutan stops
    totals: null, // { distance, duration }
    geometry: null, // [[lat, lng], ...] garis rute jalan
    round: true,
    busy: false,
  };
  let nextId = 1;

  // ---------- Peta ----------
  const map = L.map('map', { zoomControl: false }).setView([-2.5, 118], 5);
  L.control.zoom({ position: 'topright' }).addTo(map);
  // Server tile OSM menolak permintaan tanpa Referer (terjadi bila halaman dibuka dari
  // file lokal, file://). Dalam kasus itu pakai penyedia peta lain yang tidak mensyaratkannya.
  if (/^https?:$/.test(location.protocol)) {
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
  } else {
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri',
    }).addTo(map);
  }
  const markerLayer = L.layerGroup().addTo(map);
  let routeLayer = null;

  // ---------- Utilitas ----------
  let toastTimer = null;
  function toast(msg, ms = 3500) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), ms);
  }

  async function fetchJSON(url, timeout = 25000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error('Server membalas ' + res.status);
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Waktu habis, periksa koneksi internet.');
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  // Nominatim membatasi 1 permintaan/detik; antrikan semua panggilan.
  let nomChain = Promise.resolve();
  let nomLast = 0;
  function nominatim(path) {
    const p = nomChain.then(async () => {
      const wait = nomLast + 1100 - Date.now();
      if (wait > 0) await sleep(wait);
      nomLast = Date.now();
      return fetchJSON(NOMINATIM + path);
    });
    nomChain = p.catch(() => {});
    return p;
  }

  const shortLabel = (name) => name.split(',').slice(0, 3).join(',').trim();
  const coordLabel = (lat, lng) => lat.toFixed(5) + ', ' + lng.toFixed(5);
  const cleanName = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);

  async function geocode(q, limit = 5) {
    const data = await nominatim(
      '/search?format=jsonv2&limit=' + limit + '&q=' + encodeURIComponent(q)
    );
    return data.map((d) => ({
      label: shortLabel(d.display_name),
      full: d.display_name,
      lat: parseFloat(d.lat),
      lng: parseFloat(d.lon),
    }));
  }

  async function reverseGeocode(lat, lng) {
    const d = await nominatim('/reverse?format=jsonv2&zoom=18&lat=' + lat + '&lon=' + lng);
    return d && d.display_name ? shortLabel(d.display_name) : null;
  }

  function fmtDist(m) {
    return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km' : Math.round(m) + ' m';
  }
  function fmtDur(s) {
    const m = Math.round(s / 60);
    if (m < 60) return m + ' mnt';
    return Math.floor(m / 60) + ' j ' + (m % 60) + ' mnt';
  }
  function fmtDate(t) {
    try {
      return new Date(t).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return '';
    }
  }
  const fmtClock = (t) => new Date(t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', hour12: false });
  const fmtDT = (t) =>
    new Date(t).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) + ', ' + fmtClock(t);
  function fmtElapsed(ms) {
    const m = Math.max(0, Math.floor(ms / 60000));
    return m < 60 ? m + ' mnt' : Math.floor(m / 60) + ' j ' + (m % 60) + ' mnt';
  }
  const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- Penyimpanan (banyak rencana) ----------
  let store = { plans: [] };
  const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  function cleanStops(arr) {
    const out = [];
    (Array.isArray(arr) ? arr : []).forEach((s) => {
      if (!s) return;
      const lat = parseFloat(s.lat);
      const lng = parseFloat(s.lng);
      if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
      out.push({
        label: String(s.label || '').replace(/\s+/g, ' ').trim().slice(0, 200), // alamat
        name: String(s.name || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        note: String(s.note || '').trim().slice(0, 1000),
        photos: Array.isArray(s.photos)
          ? s.photos.filter((x) => typeof x === 'string' && PHOTO_ID_RE.test(x)).slice(0, MAX_PHOTOS)
          : [],
        pt: {}, // waktu unggah tiap foto (ms): id foto -> waktu
        lat,
        lng,
      });
      const o = out[out.length - 1];
      if (s.pt && typeof s.pt === 'object') {
        o.photos.forEach((pid) => { const t = +s.pt[pid]; if (isFinite(t) && t > 0) o.pt[pid] = t; });
      }
    });
    return out.slice(0, MAX_STOPS);
  }

  // Waktu kunjungan = waktu foto tertua yang diunggah pada titik itu (null bila belum ada foto).
  function visitAt(s) {
    const ts = (s.photos || []).map((id) => (s.pt || {})[id]).filter(Boolean);
    return ts.length ? Math.min.apply(null, ts) : null;
  }

  function cleanTrip(t) {
    if (!t || typeof t !== 'object') return null;
    const a = +t.startedAt;
    const f = +t.finishedAt;
    if (!isFinite(a) || a <= 0) return null;
    return { startedAt: a, finishedAt: isFinite(f) && f >= a ? f : null };
  }

  // Rute tersimpan: jarak, durasi, ruas, dan geometri jalan (dijarangkan agar kecil).
  function cleanRoute(r) {
    if (!r || typeof r !== 'object' || !Array.isArray(r.legs) || !isFinite(+r.distance) || !isFinite(+r.duration)) return null;
    const legs = r.legs.map((l) => ({ distance: +l.distance || 0, duration: +l.duration || 0 }));
    let g = Array.isArray(r.geometry) ? r.geometry.filter((p) => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])) : [];
    if (g.length > MAX_GEOM) {
      const step = g.length / MAX_GEOM;
      const thin = [];
      for (let i = 0; i < MAX_GEOM; i++) thin.push(g[Math.floor(i * step)]);
      thin[thin.length - 1] = g[g.length - 1];
      g = thin;
    }
    g = g.map((p) => [+(+p[0]).toFixed(5), +(+p[1]).toFixed(5)]);
    return { distance: +r.distance, duration: +r.duration, legs, geometry: g, round: r.round !== false };
  }

  // Salinan titik untuk disimpan / dimuat ke layar (foto hanya berupa id; isinya di IndexedDB).
  const plainStop = (s) => ({
    label: s.label, name: s.name || '', note: s.note || '', photos: (s.photos || []).slice(),
    pt: Object.assign({}, s.pt || {}), lat: s.lat, lng: s.lng,
  });
  const stopName = (s) => s.name || s.label || coordLabel(s.lat, s.lng);
  const firstPart = (t) => String(t || '').split(',')[0].trim().slice(0, 80);

  function normPlan(p) {
    const now = Date.now();
    return {
      id: String(p.id || uid()),
      name: cleanName(p.name) || 'Rencana',
      round: p.round !== false,
      stops: cleanStops(p.stops),
      trip: cleanTrip(p.trip), // { startedAt, finishedAt } | null
      route: cleanRoute(p.route),
      createdAt: +p.createdAt || now,
      updatedAt: +p.updatedAt || now,
    };
  }

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch (_) { /* abaikan */ }
  }

  function loadStore() {
    try {
      const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (d && Array.isArray(d.plans)) {
        store.plans = d.plans.filter((p) => p && typeof p === 'object').map(normPlan);
        return;
      }
    } catch (_) { /* lanjut ke migrasi */ }
    // Migrasi: data versi lama (satu daftar tujuan tanpa nama) menjadi satu rencana.
    try {
      const old = JSON.parse(localStorage.getItem(OLD_KEY) || 'null');
      if (old && Array.isArray(old.stops) && cleanStops(old.stops).length) {
        store.plans = [normPlan({ name: 'Rencana sebelumnya', round: old.round, stops: old.stops })];
        persist();
      }
    } catch (_) { /* abaikan */ }
  }

  // Simpan isi layar peta ke rencana yang sedang dibuka.
  function save() {
    const p = state.plan;
    if (!p) return;
    p.stops = state.stops.map(plainStop);
    p.round = state.round;
    p.route = state.totals && state.geometry
      ? cleanRoute({ distance: state.totals.distance, duration: state.totals.duration, legs: state.legs, geometry: state.geometry, round: state.round })
      : null;
    p.updatedAt = Date.now();
    persist();
  }

  function createPlan(name, stops, round, trip) {
    const now = Date.now();
    const p = {
      id: uid(),
      name: cleanName(name) || 'Rencana',
      round: round !== false,
      stops: cleanStops(stops),
      trip: cleanTrip(trip),
      route: null,
      createdAt: now,
      updatedAt: now,
    };
    store.plans.push(p);
    persist();
    return p;
  }

  // ---------- Beranda (daftar rencana) ----------
  // Gambar mini rute (SVG, tanpa peta/online): garis rute jalan bila ada, jika tidak garis antar titik.
  function routeThumb(p) {
    const W = 84, H = 62, PAD = 8;
    const stops = (p.stops || []).filter((s) => isFinite(s.lat) && isFinite(s.lng));
    if (!stops.length) return '<svg class="planThumb" viewBox="0 0 ' + W + ' ' + H + '"><text x="42" y="36" text-anchor="middle" font-size="18">🗺️</text></svg>';
    let line = p.route && Array.isArray(p.route.geometry) && p.route.geometry.length > 1 ? p.route.geometry : null;
    if (!line) {
      line = stops.map((s) => [s.lat, s.lng]);
      if (p.round !== false && line.length > 2) line.push(line[0]);
    }
    const step = Math.max(1, Math.ceil(line.length / 150));
    const pts = line.filter((_, i) => i % step === 0 || i === line.length - 1);
    const all = pts.concat(stops.map((s) => [s.lat, s.lng]));
    let minLa = 90, maxLa = -90, minLo = 180, maxLo = -180;
    all.forEach((q) => { minLa = Math.min(minLa, q[0]); maxLa = Math.max(maxLa, q[0]); minLo = Math.min(minLo, q[1]); maxLo = Math.max(maxLo, q[1]); });
    const k = Math.cos(((minLa + maxLa) / 2) * Math.PI / 180) || 1;
    const dx = Math.max((maxLo - minLo) * k, 1e-6), dy = Math.max(maxLa - minLa, 1e-6);
    const sc = Math.min((W - 2 * PAD) / dx, (H - 2 * PAD) / dy);
    const ox = (W - dx * sc) / 2, oy = (H - dy * sc) / 2;
    const X = (lo) => (ox + (lo - minLo) * k * sc).toFixed(1);
    const Y = (la) => (oy + (maxLa - la) * sc).toFixed(1);
    const d = pts.map((q, i) => (i ? 'L' : 'M') + X(q[1]) + ' ' + Y(q[0])).join('');
    const dots = stops.map((s, i) =>
      '<circle cx="' + X(s.lng) + '" cy="' + Y(s.lat) + '" r="' + (i === 0 ? 3.6 : 2.6) + '" fill="' + (i === 0 ? '#d97706' : '#fff') + '" stroke="#0f766e" stroke-width="1.4"/>'
    ).join('');
    return '<svg class="planThumb" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">' +
      '<path d="M0 20H84M0 41H84M28 0V62M56 0V62" stroke="#d1e7e2" stroke-width=".6"/>' +
      '<path d="' + d + '" fill="none" stroke="#0f766e" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>' + dots + '</svg>';
  }

  // Duplikat rencana (foto ikut disalin agar tiap rencana mandiri); status perjalanan direset.
  async function duplicatePlan(p) {
    if (state.plan === p) save();
    const stops = [];
    for (const s of p.stops) {
      const c = plainStop(s);
      c.photos = []; c.pt = {};
      for (const id of s.photos || []) {
        try {
          const b = await photoGet(id);
          if (!b) continue;
          const nid = newPhotoId();
          await photoPut(nid, b);
          c.photos.push(nid);
          if (s.pt && s.pt[id]) c.pt[nid] = s.pt[id];
        } catch (_) { /* lewati foto rusak */ }
      }
      stops.push(c);
    }
    const base = cleanName(p.name).slice(0, Math.max(1, MAX_NAME - 10));
    const np = createPlan(base + ' (salinan)', stops, p.round, null);
    if (p.route) np.route = JSON.parse(JSON.stringify(p.route));
    persist();
    renderHome();
    toast('Rencana diduplikat.');
  }

  function renderHome() {
    const list = $('#planList');
    list.innerHTML = '';
    const plans = store.plans.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    $('#homeEmpty').hidden = plans.length > 0;
    $('#homeList').hidden = plans.length === 0;
    plans.forEach((p) => {
      const li = document.createElement('li');
      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'planMain';
      const st = tripStatus(p);
      const chip = st === 'going' ? '<em class="chip going">Berjalan</em>' : st === 'done' ? '<em class="chip done">Selesai</em>' : '';
      main.innerHTML = routeThumb(p) +
        '<div class="pt"><b>' + escHtml(p.name) + chip + '</b><span>' + p.stops.length + ' tujuan · ' +
        (st === 'done' ? 'selesai ' + escHtml(fmtDate(p.trip.finishedAt)) : 'diubah ' + escHtml(fmtDate(p.updatedAt))) + '</span></div>';
      main.onclick = () => openPlan(p);
      const ren = mkBtn('✎', 'Ganti nama', () => askPlanName({ type: 'rename', plan: p }));
      const del = mkBtn('✕', 'Hapus rencana', () => deletePlan(p));
      const dup = mkBtn('⧉', 'Duplikat rencana', () => duplicatePlan(p));
      ren.className = del.className = dup.className = 'mini';
      if (st === 'done') {
        const rep = mkBtn('📄', 'Laporan PDF', () => makeReport(p));
        rep.className = 'mini rep';
        li.append(main, rep, dup, ren, del);
      } else {
        li.append(main, dup, ren, del);
      }
      list.appendChild(li);
    });
  }

  function deletePlan(p) {
    if (!confirm('Hapus rencana "' + p.name + '" beserta ' + p.stops.length + ' tujuannya?')) return;
    p.stops.forEach((s) => (s.photos || []).forEach(photoDel));
    store.plans = store.plans.filter((x) => x !== p);
    persist();
    renderHome();
  }

  function showHome() {
    if (state.plan) save();
    state.plan = null;
    state.stops = [];
    clearRoute();
    renderTrip();
    markerLayer.clearLayers();
    hideResults();
    $('#home').hidden = false;
    renderHome();
  }

  function openPlan(p, push = true) {
    if (state.plan && state.plan !== p) save();
    state.plan = p;
    state.stops = p.stops.map((s) => ({ id: nextId++, ...plainStop(s) }));
    state.round = p.round !== false;
    $('#optRound').checked = state.round;
    clearRoute();
    $('#home').hidden = true;
    $('#planTitle').textContent = p.name;
    $('#sheet').classList.remove('collapsed');
    hideResults();
    qEl.value = '';
    map.invalidateSize();
    restoreRoute(p);
    render();
    renderTrip();
    if (state.stops.length) fitAll();
    else map.setView([-2.5, 118], 5);
    if (push) {
      try { history.pushState({ v: 'plan' }, ''); } catch (_) { /* abaikan */ }
    }
  }

  // Dialog nama rencana (baru / ganti nama)
  const dlgPlan = $('#dlgPlan');
  let planMode = null;
  function askPlanName(mode) {
    planMode = mode;
    const isNew = mode.type === 'new';
    $('#planDlgTitle').textContent = isNew ? 'Rencana baru' : 'Ganti nama rencana';
    $('#planDlgDesc').textContent = isNew
      ? 'Beri nama rencana dulu, lalu pilih titik-titik lokasinya di peta.'
      : 'Nama baru untuk rencana ini.';
    $('#planDlgOk').textContent = isNew ? 'Buat & pilih titik' : 'Simpan';
    const inp = $('#planNameInput');
    inp.value = mode.plan ? mode.plan.name : '';
    dlgPlan.showModal();
    inp.focus();
    inp.select();
  }
  $('#planForm').onsubmit = (e) => {
    e.preventDefault();
    const inp = $('#planNameInput');
    const name = cleanName(inp.value);
    if (!name) {
      inp.focus();
      return toast('Isi nama rencana dulu.');
    }
    dlgPlan.close();
    if (planMode.type === 'new') {
      openPlan(createPlan(name));
    } else {
      planMode.plan.name = name;
      planMode.plan.updatedAt = Date.now();
      persist();
      if (state.plan === planMode.plan) $('#planTitle').textContent = name;
      renderHome();
    }
  };
  $('#planCancel').onclick = () => dlgPlan.close();
  $('#btnNewPlan').onclick = () => askPlanName({ type: 'new' });
  $('#btnNewPlan2').onclick = () => askPlanName({ type: 'new' });
  $('#planTitle').onclick = () => state.plan && askPlanName({ type: 'rename', plan: state.plan });
  $('#btnBack').onclick = () => {
    if (history.state && history.state.v === 'plan') history.back();
    else showHome();
  };
  // Tombol kembali (browser / Android) dari rencana menuju Beranda
  window.addEventListener('popstate', () => {
    if (state.plan) showHome();
  });

  // ---------- Daftar tujuan ----------
  function clearRoute() {
    if (routeLayer) {
      map.removeLayer(routeLayer);
      routeLayer = null;
    }
    state.legs = [];
    state.totals = null;
    state.geometry = null;
  }

  // Tampilkan kembali rute yang tersimpan bila urutan titik belum berubah.
  function restoreRoute(p) {
    const r = p.route;
    const n = state.stops.length;
    if (!r || n < 2 || r.round !== state.round || r.legs.length !== (state.round ? n : n - 1)) return;
    state.legs = r.legs.map((l) => ({ distance: l.distance, duration: l.duration }));
    state.totals = { distance: r.distance, duration: r.duration };
    state.geometry = r.geometry.slice();
    if (r.geometry.length > 1) {
      routeLayer = L.geoJSON(
        { type: 'LineString', coordinates: r.geometry.map((q) => [q[1], q[0]]) },
        { style: { color: '#0f766e', weight: 5, opacity: 0.85 } }
      ).addTo(map);
    }
  }

  function setBusy(b, msg) {
    state.busy = b;
    document.querySelectorAll('#actions button').forEach((x) => (x.disabled = b));
    if (b && msg) $('#summary').textContent = msg;
    if (!b) renderSummary();
  }

  function renderSummary() {
    const el = $('#summary');
    const n = state.stops.length;
    if (!n) {
      el.textContent = 'Belum ada tujuan. Cari alamat atau ketuk peta.';
    } else if (state.totals) {
      el.innerHTML =
        '<b>' + n + ' tujuan</b> · ' + fmtDist(state.totals.distance) + ' · ' + fmtDur(state.totals.duration);
    } else {
      el.innerHTML = '<b>' + n + ' tujuan</b> · ketuk "Cari rute tercepat" untuk mengurutkan';
    }
  }

  function makeIcon(i) {
    return L.divIcon({
      className: '',
      html: '<div class="pin' + (i === 0 ? ' start' : '') + '"><b>' + (i + 1) + '</b></div>',
      iconSize: [28, 28],
      iconAnchor: [14, 28],
    });
  }

  function render() {
    // Penanda
    markerLayer.clearLayers();
    state.stops.forEach((s, i) => {
      const m = L.marker([s.lat, s.lng], { icon: makeIcon(i), draggable: true });
      m.bindTooltip(stopName(s));
      m.on('click', () => openStopDialog({ mode: 'edit', stop: s }));
      m.on('dragend', async () => {
        const p = m.getLatLng();
        s.lat = p.lat;
        s.lng = p.lng;
        s.label = coordLabel(p.lat, p.lng);
        clearRoute();
        render();
        save();
        try {
          const name = await reverseGeocode(p.lat, p.lng);
          if (name) { s.label = name; render(); save(); }
        } catch (_) { /* biarkan koordinat */ }
      });
      markerLayer.addLayer(m);
    });

    // Daftar
    const ol = $('#stops');
    ol.innerHTML = '';
    state.stops.forEach((s, i) => {
      const li = document.createElement('li');

      const num = document.createElement('div');
      num.className = 'num' + (i === 0 ? ' start' : '');
      num.textContent = i + 1;

      const info = document.createElement('div');
      info.className = 'info';
      const lab = document.createElement('div');
      lab.className = 'label';
      lab.textContent = stopName(s);
      lab.onclick = () => map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 15));
      info.appendChild(lab);
      const nPh = (s.photos || []).length;
      if (s.note || nPh) {
        const v = visitAt(s);
        const sub = document.createElement('div');
        sub.className = 'sub';
        sub.textContent =
          (nPh ? '📷 ' + nPh + (v ? ' · ✓ ' + fmtClock(v) : '') + (s.note ? ' · ' : '') : '') +
          (s.note || '').replace(/\s+/g, ' ');
        info.appendChild(sub);
      }
      if (state.legs[i]) {
        const leg = document.createElement('div');
        leg.className = 'leg';
        leg.textContent =
          '↓ ' + fmtDist(state.legs[i].distance) + ' · ' + fmtDur(state.legs[i].duration) +
          (i === state.stops.length - 1 ? ' (kembali ke awal)' : '');
        info.appendChild(leg);
      }

      const btns = document.createElement('div');
      btns.className = 'row-btns';
      const up = mkBtn('↑', 'Naikkan', () => move(i, -1));
      up.disabled = i === 0;
      const down = mkBtn('↓', 'Turunkan', () => move(i, 1));
      down.disabled = i === state.stops.length - 1;
      const edit = mkBtn('✎', 'Ubah nama, keterangan & foto', () => openStopDialog({ mode: 'edit', stop: s }));
      const del = mkBtn('✕', 'Hapus', () => removeStop(i));
      btns.append(up, down, edit, del);

      li.append(num, info, btns);
      ol.appendChild(li);
    });
    renderSummary();
  }

  function mkBtn(text, label, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    b.onclick = fn;
    return b;
  }

  function move(i, d) {
    const j = i + d;
    if (j < 0 || j >= state.stops.length) return;
    [state.stops[i], state.stops[j]] = [state.stops[j], state.stops[i]];
    clearRoute();
    render();
    save();
  }

  function removeStop(i) {
    const [gone] = state.stops.splice(i, 1);
    if (gone) (gone.photos || []).forEach(photoDel);
    clearRoute();
    render();
    save();
  }

  function fitAll() {
    if (!state.stops.length) return;
    const b = L.latLngBounds(state.stops.map((s) => [s.lat, s.lng]));
    map.fitBounds(b, { padding: [50, 50], maxZoom: 16 });
  }

  function addStop(lat, lng, label, { fit = true, name = '', note = '' } = {}) {
    if (!state.plan) return null;
    if (state.stops.length >= MAX_STOPS) {
      toast('Maksimal ' + MAX_STOPS + ' tujuan.');
      return null;
    }
    const s = { id: nextId++, label: label || coordLabel(lat, lng), name, note, photos: [], pt: {}, lat, lng };
    state.stops.push(s);
    clearRoute();
    render();
    save();
    if (fit) {
      if (state.stops.length === 1) map.flyTo([lat, lng], 15);
      else fitAll();
    }
    return s;
  }

  // ---------- Penyimpanan foto (IndexedDB; localStorage terlalu kecil untuk foto) ----------
  let idbP = null;
  const memPhotos = new Map(); // cadangan bila IndexedDB tidak tersedia (hilang saat ditutup)
  const newPhotoId = () => 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  function idb() {
    if (!idbP) {
      idbP = new Promise((res, rej) => {
        try {
          const r = indexedDB.open('rutepintar', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('photos');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        } catch (e) { rej(e); }
      }).catch(() => null);
    }
    return idbP;
  }
  function idbReq(mode, fn) {
    return idb().then((db) => {
      if (!db) return undefined;
      return new Promise((res, rej) => {
        const tx = db.transaction('photos', mode);
        const rq = fn(tx.objectStore('photos'));
        tx.oncomplete = () => res(rq && rq.result);
        tx.onerror = tx.onabort = () => rej(tx.error);
      });
    });
  }
  async function photoPut(id, blob) {
    const db = await idb();
    if (!db) { memPhotos.set(id, blob); return; }
    try { await idbReq('readwrite', (st) => st.put(blob, id)); }
    catch (_) { memPhotos.set(id, blob); toast('Penyimpanan foto penuh/terblokir; foto hanya tersimpan sementara.', 5000); }
  }
  async function photoGet(id) {
    if (memPhotos.has(id)) return memPhotos.get(id);
    try { return (await idbReq('readonly', (st) => st.get(id))) || null; } catch (_) { return null; }
  }
  function photoDel(id) {
    memPhotos.delete(id);
    const u = photoUrls.get(id);
    if (u) { URL.revokeObjectURL(u); photoUrls.delete(id); }
    idbReq('readwrite', (st) => st.delete(id)).catch(() => {});
  }
  const photoUrls = new Map();
  async function photoURL(id) {
    if (photoUrls.has(id)) return photoUrls.get(id);
    const b = await photoGet(id);
    if (!b) return null;
    const u = URL.createObjectURL(b);
    photoUrls.set(id, u);
    return u;
  }

  // Kecilkan foto (sisi terpanjang 1280 px, JPEG) agar hemat ruang penyimpanan.
  async function compressImage(file, max = 1280, quality = 0.8) {
    let src, w, h, cleanup = () => {};
    try {
      src = await createImageBitmap(file);
      w = src.width; h = src.height;
      cleanup = () => src.close && src.close();
    } catch (_) {
      const url = URL.createObjectURL(file);
      src = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('Format foto tidak didukung'));
        im.src = url;
      });
      w = src.naturalWidth; h = src.naturalHeight;
      cleanup = () => URL.revokeObjectURL(url);
    }
    try {
      const k = Math.min(1, max / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * k));
      c.height = Math.max(1, Math.round(h * k));
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(src, 0, 0, c.width, c.height);
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
      if (!blob) throw new Error('Gagal memproses foto');
      return blob;
    } finally {
      cleanup();
    }
  }

  const blobToDataURL = (blob) =>
    new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });

  // ---------- Dialog titik: nama, keterangan, foto ----------
  // mode "new": titik belum ada; nama & keterangan diisi lalu titik disimpan.
  // mode "edit": titik sudah tersimpan; nama, keterangan & foto bisa diubah kapan saja.
  const dlgStop = $('#dlgStop');
  let stopCtx = null;

  function openStopDialog(ctx) {
    if (!state.plan) return;
    if (ctx.mode === 'new' && state.stops.length >= MAX_STOPS) return toast('Maksimal ' + MAX_STOPS + ' tujuan.');
    stopCtx = Object.assign({ touched: false, done: false }, ctx);
    const isNew = ctx.mode === 'new';
    const s = ctx.stop;
    $('#stopTitle').textContent = isNew ? 'Titik baru' : 'Detail titik';
    $('#stopOk').textContent = isNew ? 'Simpan titik' : 'Simpan';
    $('#stopAddr').textContent = isNew
      ? (ctx.label || 'Mencari alamat…')
      : (s.label || coordLabel(s.lat, s.lng));
    $('#stopName').value = isNew ? ctx.name || '' : s.name || firstPart(s.label);
    $('#stopNote').value = isNew ? '' : s.note || '';
    $('#photoBox').hidden = isNew;
    $('#photoLater').hidden = !isNew;
    if (!isNew) renderPhotoGrid();
    dlgStop.showModal();
    $('#stopName').focus();
    if (isNew) $('#stopName').select();
    return stopCtx;
  }

  function closeStopDialog() {
    if (stopCtx) stopCtx.done = true;
    dlgStop.close();
  }

  $('#stopName').addEventListener('input', () => { if (stopCtx) stopCtx.touched = true; });
  $('#stopCancel').onclick = closeStopDialog;
  $('#stopForm').onsubmit = (e) => {
    e.preventDefault();
    const c = stopCtx;
    if (!c) return;
    const name = $('#stopName').value.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) {
      $('#stopName').focus();
      return toast('Isi nama titik dulu.');
    }
    const note = $('#stopNote').value.trim().slice(0, 1000);
    closeStopDialog();
    if (c.mode === 'new') {
      const s = addStop(c.lat, c.lng, c.label, { fit: c.fit, name, note });
      if (s) toast('Titik disimpan. Ketuk ✎ pada titik untuk menambah foto.', 4500);
    } else {
      c.stop.name = name;
      c.stop.note = note;
      save();
      render();
      toast('Perubahan disimpan.');
    }
  };

  // Alur titik baru: tampilkan form nama + keterangan; alamat dicari di latar belakang.
  function newStopFlow({ lat, lng, label = '', name = '', fit = true }) {
    if (!state.plan) return;
    const ctx = openStopDialog({ mode: 'new', lat, lng, label, name, fit });
    if (ctx && !label) {
      reverseGeocode(lat, lng).then((addr) => {
        if (!addr || stopCtx !== ctx || ctx.done) return;
        ctx.label = addr;
        $('#stopAddr').textContent = addr;
        if (!ctx.touched && !$('#stopName').value) {
          $('#stopName').value = firstPart(addr);
          $('#stopName').select();
        }
      }).catch(() => {
        if (stopCtx === ctx && !ctx.done && !ctx.label) $('#stopAddr').textContent = coordLabel(lat, lng);
      });
    }
  }

  // ----- Foto di dalam dialog (mode ubah): tersimpan langsung -----
  function renderPhotoGrid() {
    const s = stopCtx && stopCtx.stop;
    if (!s) return;
    const grid = $('#photoGrid');
    grid.innerHTML = '';
    $('#photoCount').textContent = s.photos.length + '/' + MAX_PHOTOS;
    s.photos.forEach((id, i) => {
      const d = document.createElement('div');
      d.className = 'thumb';
      const im = document.createElement('img');
      im.alt = 'Foto ' + (i + 1);
      photoURL(id).then((u) => { if (u) im.src = u; else d.classList.add('missing'); });
      im.onclick = () => openViewer(s.photos, i);
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '✕';
      x.setAttribute('aria-label', 'Hapus foto');
      x.onclick = () => {
        if (!confirm('Hapus foto ini?')) return;
        s.photos = s.photos.filter((p) => p !== id);
        if (s.pt) delete s.pt[id];
        photoDel(id);
        save();
        renderPhotoGrid();
        render();
      };
      const tm = document.createElement('span');
      tm.className = 'tm';
      tm.textContent = s.pt && s.pt[id] ? fmtClock(s.pt[id]) : '';
      d.append(im, x, tm);
      grid.appendChild(d);
    });
    const v = visitAt(s);
    $('#visitInfo').textContent = v
      ? '✓ Dikunjungi ' + fmtDT(v) + ' (waktu foto pertama)'
      : 'Waktu kunjungan dicatat saat foto pertama diunggah.';
    $('#visitInfo').classList.toggle('ok', !!v);
  }

  async function addPhotos(fileList) {
    const s = stopCtx && stopCtx.stop;
    const files = Array.from(fileList || []).filter((f) => !f.type || /^image\//.test(f.type));
    if (!s || !files.length) return;
    const room = MAX_PHOTOS - s.photos.length;
    if (room <= 0) return toast('Maksimal ' + MAX_PHOTOS + ' foto per titik.');
    if (files.length > room) toast('Hanya ' + room + ' foto pertama yang ditambahkan (batas ' + MAX_PHOTOS + ').');
    $('#photoBtns').classList.add('busy');
    let ok = 0;
    let bad = 0;
    for (const f of files.slice(0, room)) {
      try {
        const id = newPhotoId();
        await photoPut(id, await compressImage(f));
        s.photos.push(id);
        (s.pt = s.pt || {})[id] = Date.now(); // waktu unggah = waktu kunjungan titik
        ok++;
      } catch (_) {
        bad++;
      }
      renderPhotoGrid();
    }
    $('#photoBtns').classList.remove('busy');
    if (ok) { save(); render(); }
    if (bad) toast(bad + ' foto gagal diproses (format tidak didukung?).', 4500);
  }

  $('#btnCam').onclick = () => $('#fileCam').click();
  $('#btnGallery').onclick = () => $('#fileGallery').click();
  [$('#fileCam'), $('#fileGallery')].forEach((inp) => {
    inp.onchange = async () => {
      const files = Array.from(inp.files || []);
      inp.value = ''; // izinkan memilih file yang sama lagi
      await addPhotos(files);
    };
  });

  // ----- Penampil foto -----
  const dlgPhoto = $('#dlgPhoto');
  let viewer = { ids: [], i: 0 };
  async function showViewer() {
    const id = viewer.ids[viewer.i];
    $('#pvCount').textContent = viewer.i + 1 + ' / ' + viewer.ids.length;
    $('#pvPrev').disabled = viewer.i === 0;
    $('#pvNext').disabled = viewer.i === viewer.ids.length - 1;
    const u = await photoURL(id);
    if (viewer.ids[viewer.i] === id) $('#pvImg').src = u || '';
  }
  function openViewer(ids, i) {
    viewer = { ids: ids.slice(), i };
    dlgPhoto.showModal();
    showViewer();
  }
  $('#pvPrev').onclick = () => { if (viewer.i > 0) { viewer.i--; showViewer(); } };
  $('#pvNext').onclick = () => { if (viewer.i < viewer.ids.length - 1) { viewer.i++; showViewer(); } };
  $('#pvClose').onclick = () => dlgPhoto.close();

  // ---------- Pencarian ----------
  const qEl = $('#q');
  const resEl = $('#results');
  let searchTimer = null;
  let searchToken = 0;

  function hideResults() {
    resEl.hidden = true;
    resEl.innerHTML = '';
  }

  function addByCoord(c) {
    qEl.value = '';
    hideResults();
    qEl.blur();
    newStopFlow({ lat: c.lat, lng: c.lng });
  }

  async function runSearch() {
    const q = qEl.value.trim();
    if (q.length < 3) return hideResults();
    const token = ++searchToken;

    // Input berupa koordinat: tawarkan langsung menambahkan titiknya
    const coord = parseCoord(q);
    if (coord) {
      resEl.hidden = false;
      resEl.innerHTML = '';
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '📍 Tambahkan titik ' + coordLabel(coord.lat, coord.lng);
      b.onclick = () => addByCoord(coord);
      resEl.appendChild(b);
      return;
    }
    if (/^[\s\d.,;+-]+$/.test(q)) {
      resEl.hidden = false;
      resEl.innerHTML = '<div class="none">Format koordinat: lat,lng (contoh: -5.1477, 119.4327)</div>';
      return;
    }

    resEl.hidden = false;
    resEl.innerHTML = '<div class="none">Mencari…</div>';
    try {
      const list = await geocode(q);
      if (token !== searchToken) return;
      resEl.innerHTML = '';
      if (!list.length) {
        resEl.innerHTML = '<div class="none">Tidak ditemukan. Coba kata kunci lain atau ketuk peta.</div>';
        return;
      }
      list.forEach((r) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = r.full;
        b.onclick = () => {
          qEl.value = '';
          hideResults();
          qEl.blur();
          newStopFlow({ lat: r.lat, lng: r.lng, label: r.label, name: firstPart(r.label) });
        };
        resEl.appendChild(b);
      });
    } catch (e) {
      if (token !== searchToken) return;
      resEl.innerHTML = '<div class="none">Gagal mencari: ' + escHtml(e.message) + '</div>';
    }
  }

  qEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 800);
  });
  qEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(searchTimer);
      runSearch();
    }
  });
  map.on('click', (e) => {
    hideResults();
    if (!state.plan) return;
    const { lat, lng } = e.latlng;
    newStopFlow({ lat, lng, fit: false });
  });

  // ---------- Lokasi saya ----------
  async function locate() {
    try {
      const G = plug('Geolocation');
      let pos;
      if (G) {
        try { await G.requestPermissions(); } catch (_) { /* lanjut */ }
        pos = await G.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
      } else {
        if (!navigator.geolocation) throw new Error('no geolocation');
        pos = await new Promise((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 15000 })
        );
      }
      const { latitude: lat, longitude: lng } = pos.coords;
      map.flyTo([lat, lng], 16);
      if (confirm('Tambahkan lokasi Anda saat ini sebagai tujuan?')) {
        newStopFlow({ lat, lng, name: 'Lokasi saya', fit: false });
      }
    } catch (e) {
      toast(
        isNative
          ? 'Tidak bisa mengambil lokasi. Pastikan izin lokasi dan GPS aktif.'
          : 'Tidak bisa mengambil lokasi. Izinkan akses lokasi di browser (butuh HTTPS atau localhost).',
        5000
      );
    }
  }
  $('#btnGps').onclick = locate;

  // ---------- Optimasi & rute ----------
  const lngLat = (s) => s.lng.toFixed(6) + ',' + s.lat.toFixed(6);

  async function drawRoute() {
    const pts = state.stops.slice();
    if (state.round && pts.length >= 2) pts.push(pts[0]);
    const url =
      OSRM + '/route/v1/driving/' + pts.map(lngLat).join(';') +
      '?overview=full&geometries=geojson&steps=false';
    const data = await fetchJSON(url);
    if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
      throw new Error(data.message || 'Rute tidak ditemukan. Mungkin ada titik yang tidak terjangkau jalan.');
    }
    return data.routes[0];
  }

  async function optimize() {
    if (state.busy) return;
    const n = state.stops.length;
    if (n < 2) return toast('Tambahkan minimal 2 tujuan.');
    const plan = state.plan;
    state.round = $('#optRound').checked;
    setBusy(true, 'Menghitung rute tercepat…');
    try {
      let order = null;
      if (n >= 3) {
        const coords = state.stops.map(lngLat).join(';');
        const t = await fetchJSON(OSRM + '/table/v1/driving/' + coords + '?annotations=duration');
        if (t.code !== 'Ok' || !t.durations) {
          throw new Error(t.message || 'Gagal menghitung matriks jarak.');
        }
        order = RouteSolver.solve(t.durations, { roundtrip: state.round });
      }
      if (state.plan !== plan) return; // pengguna pindah rencana saat menunggu
      if (order) state.stops = order.map((i) => state.stops[i]);
      const r = await drawRoute();
      if (state.plan !== plan) return;
      if (routeLayer) map.removeLayer(routeLayer);
      routeLayer = L.geoJSON(r.geometry, { style: { color: '#0f766e', weight: 5, opacity: 0.85 } }).addTo(map);
      map.fitBounds(routeLayer.getBounds(), { padding: [60, 60] });
      state.legs = r.legs.map((l) => ({ distance: l.distance, duration: l.duration }));
      state.totals = { distance: r.distance, duration: r.duration };
      state.geometry = r.geometry.coordinates.map((c) => [c[1], c[0]]);
      save();
      toast('Rute selesai dihitung.');
    } catch (e) {
      if (state.plan === plan) {
        clearRoute();
        toast('Gagal: ' + e.message, 5000);
      }
    } finally {
      setBusy(false);
      if (state.plan === plan) render();
    }
  }
  $('#btnOptimize').onclick = optimize;
  $('#optRound').onchange = () => {
    state.round = $('#optRound').checked;
    clearRoute();
    render();
    save();
  };

  // ---------- Navigasi & bagikan ----------
  function openExternal(url) {
    const B = plug('Browser');
    if (B) B.open({ url });
    else window.open(url, '_blank', 'noopener');
  }

  function mapsUrl() {
    const st = state.stops;
    const ll = (s) => s.lat.toFixed(6) + ',' + s.lng.toFixed(6);
    const origin = st[0];
    const destination = state.round ? st[0] : st[st.length - 1];
    const mids = state.round ? st.slice(1) : st.slice(1, -1);
    const shown = mids.slice(0, 9); // batas Google Maps: 9 titik antara
    let url =
      'https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=' + ll(origin) +
      '&destination=' + ll(destination);
    if (shown.length) url += '&waypoints=' + encodeURIComponent(shown.map(ll).join('|'));
    return { url, truncated: mids.length > shown.length };
  }

  $('#btnNav').onclick = () => {
    if (state.stops.length < 2) return toast('Tambahkan minimal 2 tujuan.');
    const { url, truncated } = mapsUrl();
    if (truncated) toast('Google Maps hanya menerima 9 titik antara; titik sisanya tidak ikut terkirim.', 5000);
    openExternal(url);
  };

  $('#btnShare').onclick = async () => {
    if (!state.stops.length) return toast('Belum ada tujuan untuk dibagikan.');
    const title = 'Rencana: ' + (state.plan ? state.plan.name : 'RutePintar');
    const lines = state.stops.map(
      (s, i) => (i + 1) + '. ' + stopName(s) + (s.note ? ' — ' + s.note.replace(/\s+/g, ' ').slice(0, 120) : '')
    );
    if (state.round) lines.push('↩ kembali ke ' + stopName(state.stops[0]));
    let text = title + '\n' + lines.join('\n');
    if (state.totals) text += '\nTotal: ' + fmtDist(state.totals.distance) + ', ' + fmtDur(state.totals.duration);
    if (state.stops.length >= 2) text += '\n' + mapsUrl().url;

    const S = plug('Share');
    try {
      if (S) await S.share({ title, text, dialogTitle: 'Bagikan rute' });
      else if (navigator.share) await navigator.share({ title, text });
      else {
        await navigator.clipboard.writeText(text);
        toast('Rute disalin ke papan klip.');
      }
    } catch (e) {
      if (e && e.name !== 'AbortError' && !/cancel/i.test(String(e.message))) toast('Gagal membagikan rute.');
    }
  };

  $('#btnReset').onclick = () => {
    if (!state.stops.length) return;
    if (!confirm('Hapus semua tujuan di rencana ini?')) return;
    state.stops.forEach((s) => (s.photos || []).forEach(photoDel));
    state.stops = [];
    clearRoute();
    render();
    save();
  };

  // ---------- Impor ----------
  const dlg = $('#dlgImport');
  let importing = false;
  let importBig = null;
  let importBigMark = '';

  // Bentuk JSON yang dikenali: {plans:[…]}, {plan:{…}}, {stops:[…]} (versi lama), atau array titik.
  function extractPlans(d) {
    if (Array.isArray(d)) return [{ name: '', stops: d }];
    if (d && Array.isArray(d.plans)) return d.plans.map((p) => ({ name: p && p.name, round: p && p.round, trip: p && p.trip, stops: p && p.stops }));
    if (d && d.plan && Array.isArray(d.plan.stops)) return [{ name: d.plan.name, round: d.plan.round, trip: d.plan.trip, stops: d.plan.stops }];
    if (d && Array.isArray(d.stops)) return [{ name: d.name, round: d.round, trip: d.trip, stops: d.stops }];
    return null;
  }
  function tryJSON(text) {
    text = String(text).replace(/^\uFEFF/, '');
    if (!/^\s*[\[{]/.test(text)) return null;
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  function nameFromFile(fn) {
    return cleanName(
      fn.replace(/\.[^.]+$/, '')
        .replace(/^rutepintar[_\s-]*/i, '')
        .replace(/[_\s-]*\d{4}-\d{2}-\d{2}([_\s-]\d{4})?$/, '')
        .replace(/[_-]+/g, ' ')
    );
  }

  function openImport() {
    const home = !state.plan;
    $('#importStatus').textContent = '';
    $('#importNameRow').hidden = !home;
    $('#importTitle').textContent = home ? 'Impor sebagai rencana baru' : 'Impor ke rencana ini';
    if (home) $('#importName').value = '';
    dlg.showModal();
  }
  $('#btnImport').onclick = openImport;
  $('#btnHomeImport').onclick = openImport;
  $('#btnHomeImport0').onclick = openImport;

  $('#importFile').onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    let text;
    try { text = (await f.text()).replace(/^\uFEFF/, ''); } catch (_) { toast('Gagal membaca file.'); return; }
    e.target.value = '';
    if (text.length > 200000) {
      importBig = text;
      importBigMark = '(' + f.name + ' — ' + Math.round(f.size / 1024) + ' KB, siap diimpor)';
      $('#importText').value = importBigMark;
    } else {
      importBig = null;
      $('#importText').value = text;
    }
    if (!state.plan && !$('#importName').value.trim()) {
      const j = tryJSON(text);
      const pl = j && extractPlans(j);
      const jn = pl && pl.length === 1 ? cleanName(pl[0].name) : '';
      $('#importName').value = jn || nameFromFile(f.name);
    }
  };
  $('#importCancel').onclick = (e) => {
    if (importing) { e.preventDefault(); toast('Tunggu, impor sedang berjalan.'); }
  };

  // Foto di JSON berupa data URL: simpan ke IndexedDB dan ganti dengan id.
  async function ingestStops(raw, limit = MAX_STOPS) {
    const out = [];
    for (const s of (Array.isArray(raw) ? raw : []).slice(0, limit)) {
      if (!s || typeof s !== 'object') continue;
      const c = Object.assign({}, s, { photos: [], pt: {} });
      // Foto boleh berupa data URL (format lama) atau { data, at } (format baru, dengan waktu unggah)
      const src = (Array.isArray(s.photos) ? s.photos : [])
        .map((x) => (typeof x === 'string' ? { data: x, at: null } : x && typeof x.data === 'string' ? { data: x.data, at: +x.at || null } : null))
        .filter((x) => x && x.data.startsWith('data:image/'))
        .slice(0, MAX_PHOTOS);
      for (const ph of src) {
        try {
          const id = newPhotoId();
          await photoPut(id, await (await fetch(ph.data)).blob());
          c.photos.push(id);
          if (ph.at) c.pt[id] = ph.at;
        } catch (_) { /* lewati foto rusak */ }
      }
      out.push(c);
    }
    return out;
  }

  // Impor JSON (cadangan). Mengembalikan true bila isinya dikenali.
  async function importJSON(d) {
    const plans = extractPlans(d);
    if (!plans) return false;
    const status = $('#importStatus');
    status.textContent = 'Memuat…';

    if (state.plan) {
      // Di dalam rencana: tambahkan titik ke rencana ini.
      if (plans.length > 1) {
        status.textContent = 'File ini berisi ' + plans.length + ' rencana. Impor dari layar Beranda.';
        return true;
      }
      const room = MAX_STOPS - state.stops.length;
      const add = cleanStops(await ingestStops(plans[0].stops, Math.max(room, 0)));
      add.slice(0, Math.max(room, 0)).forEach((s) => state.stops.push({ id: nextId++, ...s }));
      clearRoute();
      render();
      save();
      fitAll();
      dlg.close();
      $('#importText').value = '';
      toast(Math.min(add.length, Math.max(room, 0)) + ' titik dimuat' + (add.length > room ? ' (dibatasi ' + MAX_STOPS + ')' : '') + '.');
      return true;
    }

    // Di Beranda: buat rencana baru (satu atau banyak).
    if (plans.length === 1) {
      const name = cleanName($('#importName').value) || cleanName(plans[0].name);
      if (!name) {
        status.textContent = 'Isi nama rencana dulu.';
        $('#importName').focus();
        return true;
      }
      const p = createPlan(name, await ingestStops(plans[0].stops), plans[0].round, plans[0].trip);
      dlg.close();
      $('#importText').value = '';
      openPlan(p);
      toast(p.stops.length + ' titik dimuat ke rencana "' + p.name + '".');
    } else {
      for (let i = 0; i < plans.length; i++) {
        createPlan(cleanName(plans[i].name) || 'Rencana ' + (i + 1), await ingestStops(plans[i].stops), plans[i].round, plans[i].trip);
      }
      dlg.close();
      $('#importText').value = '';
      renderHome();
      toast(plans.length + ' rencana dimuat.');
    }
    return true;
  }

  $('#importGo').onclick = async () => {
    if (importing) return;
    // File JSON besar (mis. berisi foto) disimpan di variabel, bukan di kotak teks.
    const usingBig = importBig !== null && $('#importText').value === importBigMark;
    const raw = (usingBig ? importBig : $('#importText').value).trim();
    if (!raw) return;
    const j = tryJSON(raw);
    if (j) {
      importing = true;
      $('#importGo').disabled = true;
      let handled = false;
      try { handled = await importJSON(j); } finally { importing = false; $('#importGo').disabled = false; }
      if (handled) {
        if (usingBig && !dlg.open) { importBig = null; }
        return;
      }
    }
    if (usingBig) return; // bukan JSON yang dikenali; jangan proses teks raksasa sebagai alamat

    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const status = $('#importStatus');

    // Di Beranda: wajib punya nama rencana; buat rencananya lalu isi.
    if (!state.plan) {
      const name = cleanName($('#importName').value);
      if (!name) {
        status.textContent = 'Isi nama rencana dulu.';
        $('#importName').focus();
        return;
      }
      openPlan(createPlan(name));
    }

    const room = MAX_STOPS - state.stops.length;
    if (lines.length > room) toast('Hanya ' + room + ' baris pertama yang diproses (batas ' + MAX_STOPS + ').');
    const todo = lines.slice(0, Math.max(room, 0));

    const plan = state.plan;
    importing = true;
    $('#importGo').disabled = true;
    const failed = [];
    let ok = 0;
    for (let i = 0; i < todo.length; i++) {
      const line = todo[i];
      status.textContent = 'Memproses ' + (i + 1) + ' dari ' + todo.length + '…';
      try {
        const c = parseCoord(line);
        if (c) {
          addStop(c.lat, c.lng, coordLabel(c.lat, c.lng), { fit: false });
          ok++;
        } else {
          const r = await geocode(line, 1);
          if (state.plan !== plan) break;
          if (r.length) {
            addStop(r[0].lat, r[0].lng, r[0].label || line, { fit: false, name: firstPart(line) });
            ok++;
          } else failed.push(line);
        }
      } catch (_) {
        failed.push(line);
      }
    }
    importing = false;
    $('#importGo').disabled = false;
    fitAll();
    if (failed.length) {
      $('#importText').value = failed.join('\n');
      status.textContent = ok + ' berhasil, ' + failed.length + ' gagal ditemukan (tersisa di kotak di atas).';
    } else {
      $('#importText').value = '';
      status.textContent = '';
      dlg.close();
      toast(ok + ' alamat ditambahkan.');
    }
  };

  // ---------- Perjalanan: mulai / selesai ----------
  function tripStatus(p) {
    return !p || !p.trip ? 'plan' : p.trip.finishedAt ? 'done' : 'going';
  }
  let tripTimer = null;
  function renderTrip() {
    clearInterval(tripTimer);
    const bar = $('#tripBar');
    const p = state.plan;
    if (!p) { bar.hidden = true; return; }
    bar.hidden = false;
    const st = tripStatus(p);
    bar.dataset.state = st;
    $('#btnTripStart').hidden = st !== 'plan';
    $('#btnTripFinish').hidden = st !== 'going';
    $('#btnReport').hidden = st !== 'done';
    $('#btnTripReopen').hidden = st !== 'done';
    const info = $('#tripInfo');
    if (st === 'plan') {
      info.textContent = 'Belum dimulai. Tekan “Mulai perjalanan” untuk merekam tanggal & waktu perjalanan.';
    } else if (st === 'going') {
      const upd = () => {
        info.innerHTML =
          '<b>Perjalanan berjalan</b> sejak ' + escHtml(fmtDT(p.trip.startedAt)) + ' · ' +
          fmtElapsed(Date.now() - p.trip.startedAt) + '. Unggah foto di tiap titik untuk mencatat waktu kunjungan.';
      };
      upd();
      tripTimer = setInterval(upd, 30000);
    } else {
      info.innerHTML =
        '<b>Selesai</b> ' + escHtml(fmtDT(p.trip.finishedAt)) + ' · durasi ' +
        fmtElapsed(p.trip.finishedAt - p.trip.startedAt) + '. Laporan PDF siap dibuat.';
    }
  }

  $('#btnTripStart').onclick = () => {
    if (!state.plan) return;
    if (!state.stops.length) return toast('Tambahkan minimal 1 tujuan dulu.');
    state.plan.trip = { startedAt: Date.now(), finishedAt: null };
    save();
    renderTrip();
    toast('Perjalanan dimulai: ' + fmtDT(state.plan.trip.startedAt), 4500);
  };
  $('#btnTripFinish').onclick = async () => {
    const p = state.plan;
    if (!p || !p.trip || p.trip.finishedAt) return;
    if (!confirm('Selesaikan rencana "' + p.name + '"? Laporan PDF akan dibuat dari data perjalanan ini.')) return;
    p.trip.finishedAt = Date.now();
    save();
    renderTrip();
    await makeReport(p);
  };
  $('#btnTripReopen').onclick = () => {
    const p = state.plan;
    if (!p || !p.trip) return;
    if (!confirm('Buka kembali perjalanan ini? Waktu selesai akan dihapus.')) return;
    p.trip.finishedAt = null;
    save();
    renderTrip();
  };
  $('#btnReport').onclick = () => makeReport(state.plan);

  // ---------- Laporan PDF ----------
  const tileCfg = () =>
    /^https?:$/.test(location.protocol)
      ? { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors' }
      : { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', attribution: 'Tiles © Esri' };

  async function fetchRouteFor(stops, round) {
    const pts = stops.slice();
    if (round && pts.length >= 2) pts.push(pts[0]);
    const data = await fetchJSON(
      OSRM + '/route/v1/driving/' + pts.map(lngLat).join(';') + '?overview=full&geometries=geojson&steps=false', 20000
    );
    if (data.code !== 'Ok' || !data.routes || !data.routes.length) return null;
    const r = data.routes[0];
    return cleanRoute({
      distance: r.distance, duration: r.duration, round,
      legs: r.legs.map((l) => ({ distance: l.distance, duration: l.duration })),
      geometry: r.geometry.coordinates.map((c) => [c[1], c[0]]),
    });
  }

  async function collectReportData(plan) {
    const round = plan.round !== false;
    const stops = [];
    for (const s of plan.stops) {
      const photos = [];
      for (const id of s.photos || []) {
        const blob = await photoGet(id);
        if (blob) photos.push({ blob, at: (s.pt || {})[id] || null });
      }
      stops.push({ name: s.name, label: s.label, note: s.note, lat: s.lat, lng: s.lng, photos });
    }
    const n = stops.length;
    let route = plan.route && plan.route.round === round && plan.route.legs.length === (round && n >= 2 ? n : n - 1) ? plan.route : null;
    if (!route && n >= 2) { // belum pernah dihitung: coba hitung sesuai urutan sekarang (tanpa mengubah urutan)
      try {
        route = await fetchRouteFor(plan.stops, round);
        if (route) { plan.route = route; persist(); }
      } catch (_) { route = null; }
    }
    return {
      title: plan.name,
      startedAt: plan.trip && plan.trip.startedAt,
      finishedAt: plan.trip && plan.trip.finishedAt,
      generatedAt: Date.now(),
      round, route, stops, tile: tileCfg(),
    };
  }

  const dlgReport = $('#dlgReport');
  let reportBusy = false;
  let lastPdf = null;
  const nativePdf = () => (window.RutePdf && typeof window.RutePdf.save === 'function' ? window.RutePdf : null);
  dlgReport.addEventListener('cancel', (e) => { if (reportBusy) e.preventDefault(); });
  $('#repClose').onclick = () => { if (!reportBusy) dlgReport.close(); };
  function setRep(pct, text) {
    $('#repBar').style.width = Math.max(0, Math.min(100, pct)) + '%';
    $('#repStatus').textContent = text;
  }
  const blobToB64 = async (blob) => (await blobToDataURL(blob)).split(',')[1];

  async function makeReport(plan) {
    if (!plan || reportBusy) return;
    if (typeof RouteReport === 'undefined') return toast('Modul laporan tidak termuat.');
    reportBusy = true;
    lastPdf = null;
    $('#repActions').hidden = true;
    $('#repNote').textContent = '';
    $('#repClose').disabled = true;
    setRep(3, 'Menyiapkan data…');
    dlgReport.showModal();
    try {
      if (plan === state.plan) save();
      const data = await collectReportData(plan);
      data.onProgress = (f, t) => setRep(8 + f * 90, t);
      setRep(8, 'Membuat laporan…');
      const blob = await RouteReport.build(data);
      const name = 'laporan_' + slug(plan.name) + '_' + stamp() + '.pdf';
      lastPdf = { blob, name, url: null };
      setRep(100, 'Laporan siap · ' + name + ' (' + Math.max(1, Math.round(blob.size / 1024)) + ' KB)');
      await afterReport();
    } catch (e) {
      setRep(0, 'Gagal membuat laporan: ' + (e && e.message ? e.message : e));
    } finally {
      reportBusy = false;
      $('#repClose').disabled = false;
      $('#repActions').hidden = !lastPdf;
    }
  }

  // Atur tombol sesuai platform: web (unduh/buka) atau APK (simpan ke Download lewat jembatan native).
  async function afterReport() {
    const bridge = nativePdf();
    const canShareFile = !bridge && navigator.canShare && navigator.canShare({ files: [new File([lastPdf.blob], lastPdf.name, { type: 'application/pdf' })] });
    $('#repSave').hidden = !!bridge;
    $('#repSave').textContent = 'Unduh PDF';
    $('#repOpen').hidden = false;
    $('#repShare').hidden = !(bridge || canShareFile);
    if (bridge) {
      let res;
      try { res = String(bridge.save(lastPdf.name, await blobToB64(lastPdf.blob))); } catch (e) { res = 'ERR|' + e.message; }
      if (res.startsWith('OK')) {
        $('#repNote').textContent = 'Tersimpan di ' + (res.split('|')[1] || 'folder Download/RutePintar') + '. Ketuk "Buka PDF" atau "Bagikan".';
      } else {
        $('#repNote').textContent = 'Gagal menyimpan PDF: ' + (res.split('|')[1] || 'tidak diketahui');
        $('#repOpen').hidden = true;
        $('#repShare').hidden = true;
      }
    } else if (isNative) {
      $('#repNote').textContent = 'Versi aplikasi ini belum dapat menyimpan PDF langsung. Gunakan APK terbaru yang disertakan, atau buka versi web.';
      $('#repSave').hidden = false;
      $('#repOpen').hidden = true;
    }
  }
  $('#repSave').onclick = () => {
    if (!lastPdf) return;
    const url = URL.createObjectURL(lastPdf.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = lastPdf.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Mengunduh ' + lastPdf.name);
  };
  $('#repOpen').onclick = () => {
    if (!lastPdf) return;
    const bridge = nativePdf();
    if (bridge) {
      const r = String(bridge.open(lastPdf.name));
      if (!r.startsWith('OK')) toast('Tidak ada aplikasi PDF. Gunakan "Bagikan" untuk mengirim file.', 5000);
    } else {
      if (!lastPdf.url) lastPdf.url = URL.createObjectURL(lastPdf.blob);
      window.open(lastPdf.url, '_blank');
    }
  };
  $('#repShare').onclick = async () => {
    if (!lastPdf) return;
    const bridge = nativePdf();
    try {
      if (bridge) bridge.share(lastPdf.name);
      else await navigator.share({ title: lastPdf.name, files: [new File([lastPdf.blob], lastPdf.name, { type: 'application/pdf' })] });
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('Gagal membagikan.');
    }
  };

  // ---------- Ekspor ----------
  // Format "apk" = satu baris "lat, lng" per tujuan: persis yang dibaca fitur Impor
  // (tanpa geocoding, urutan & posisi akurat).
  const oneLine = (t) => String(t).replace(/\s+/g, ' ').trim();
  const csvCell = (t) => '"' + String(t).replace(/"/g, '""') + '"';
  const pad = (n) => String(n).padStart(2, '0');
  function stamp() {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      '_' + pad(d.getHours()) + pad(d.getMinutes());
  }
  function slug(name) {
    return (
      cleanName(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'rencana'
    );
  }
  // Foto: bila withPhotos, tiap foto disertakan sebagai data URL; jika tidak, hanya jumlahnya.
  async function stopToJSON(s, withPhotos) {
    const o = {
      name: oneLine(s.name || ''),
      note: String(s.note || '').trim(),
      label: oneLine(s.label || ''),
      lat: +s.lat.toFixed(6),
      lng: +s.lng.toFixed(6),
    };
    const ids = s.photos || [];
    o.visitedAt = visitAt(s);
    if (withPhotos && ids.length) {
      o.photos = [];
      for (const id of ids) {
        const b = await photoGet(id);
        if (b) o.photos.push({ data: await blobToDataURL(b), at: (s.pt || {})[id] || null });
      }
    } else if (ids.length) {
      o.photoCount = ids.length;
    }
    return o;
  }
  async function planToJSON(p, withPhotos) {
    const stops = [];
    for (const s of p.stops) stops.push(await stopToJSON(s, withPhotos));
    return { name: p.name, round: p.round !== false, trip: p.trip || null, stops };
  }

  const EXPORTS = {
    apk: {
      ext: 'txt', mime: 'text/plain',
      build: (st) => st.map((s) => s.lat.toFixed(6) + ', ' + s.lng.toFixed(6)).join('\n') + '\n',
    },
    // Alamat (bukan nama titik) agar bisa dicari ulang oleh fitur impor.
    names: {
      ext: 'txt', mime: 'text/plain',
      build: (st) => st.map((s) => oneLine(s.label) || oneLine(s.name) || coordLabel(s.lat, s.lng)).join('\n') + '\n',
    },
    csv: {
      ext: 'csv', mime: 'text/csv', bom: true,
      build: (st) =>
        'no,nama,keterangan,alamat,lat,lng,jumlah_foto,waktu_kunjungan\r\n' +
        st.map((s, i) => {
          const v = visitAt(s);
          const vt = v ? new Date(v) : null;
          const when = vt ? vt.getFullYear() + '-' + pad(vt.getMonth() + 1) + '-' + pad(vt.getDate()) + ' ' + pad(vt.getHours()) + ':' + pad(vt.getMinutes()) : '';
          return [i + 1, csvCell(oneLine(s.name || '')), csvCell(oneLine(s.note || '')), csvCell(oneLine(s.label || '')),
            s.lat.toFixed(6), s.lng.toFixed(6), (s.photos || []).length, when].join(',');
        }).join('\r\n') + '\r\n',
    },
    json: { ext: 'json', mime: 'application/json' },
  };

  async function exportText(fmt, withPhotos) {
    if (fmt === 'json') {
      const plan = await planToJSON(
        { name: state.plan ? state.plan.name : 'Rencana', round: state.round, trip: state.plan ? state.plan.trip : null, stops: state.stops },
        withPhotos
      );
      return JSON.stringify({ app: 'RutePintar', version: 2, exportedAt: new Date().toISOString(), plan }, null, 2) + '\n';
    }
    return EXPORTS[fmt].build(state.stops);
  }
  const totalPhotos = (stops) => stops.reduce((n, s) => n + (s.photos || []).length, 0);

  // Unduh file (web) atau bagikan sebagai teks (aplikasi Android: tanpa plugin Filesystem).
  async function deliver(filename, text, mime, bom) {
    const S = plug('Share');
    if (isNative && S) {
      try {
        await S.share({ title: filename, text, dialogTitle: 'Bagikan / simpan ' + filename });
      } catch (e) {
        if (e && !/cancel/i.test(String(e.message))) toast('Gagal membagikan.');
      }
      return;
    }
    const blob = new Blob([(bom ? '﻿' : '') + text], { type: mime === 'application/json' ? mime : mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('File ' + filename + ' diunduh.');
  }

  const dlgExport = $('#dlgExport');
  const expFormat = () => document.querySelector('input[name=expFmt]:checked').value;
  if (isNative) {
    $('#exportDownload').textContent = 'Bagikan';
    $('#exportNative').hidden = false;
  }

  const withPhotosChecked = () =>
    expFormat() === 'json' && !isNative && $('#expPhotos').checked && totalPhotos(state.stops) > 0;

  async function refreshExport() {
    const fmt = expFormat();
    const n = state.stops.length;
    const np = totalPhotos(state.stops);
    // Pratinjau tanpa isi foto (bisa sangat besar)
    $('#exportPreview').value = await exportText(fmt, false);
    $('#expPhotosRow').hidden = !(fmt === 'json' && !isNative && np > 0);
    $('#expPhotosLabel').textContent = 'Sertakan ' + np + ' foto (ukuran file lebih besar)';
    $('#exportInfo').textContent =
      n + ' tujuan, urutan sesuai daftar saat ini' + (n > MAX_STOPS ? ' (aplikasi membatasi ' + MAX_STOPS + ' tujuan)' : '') +
      (np && fmt === 'json' && isNative ? '. Foto tidak ikut diekspor dari aplikasi Android.' : '.');
  }

  $('#btnExport').onclick = async () => {
    if (!state.stops.length) return toast('Belum ada tujuan untuk diekspor.');
    await refreshExport();
    dlgExport.showModal();
  };
  document.querySelectorAll('input[name=expFmt]').forEach((r) => (r.onchange = refreshExport));

  $('#exportDownload').onclick = async () => {
    const fmt = expFormat();
    const f = EXPORTS[fmt];
    const name = 'rutepintar_' + slug(state.plan ? state.plan.name : '') + '_' + stamp() + '.' + f.ext;
    const withPhotos = withPhotosChecked();
    $('#exportDownload').disabled = true;
    try {
      const text = await exportText(fmt, withPhotos);
      dlgExport.close();
      await deliver(name, text, f.mime, f.bom);
    } finally {
      $('#exportDownload').disabled = false;
    }
  };

  $('#exportCopy').onclick = async () => {
    const text = await exportText(expFormat(), false);
    try {
      await navigator.clipboard.writeText(text);
      toast('Disalin ke papan klip.');
    } catch (_) {
      $('#exportPreview').select();
      toast('Salin manual: teks sudah terpilih (Ctrl+C).');
    }
  };

  // Ekspor semua rencana (cadangan) dari Beranda
  $('#btnHomeExport').onclick = async () => {
    if (!store.plans.length) return toast('Belum ada rencana.');
    if (state.plan) save();
    const np = store.plans.reduce((n, p) => n + totalPhotos(p.stops), 0);
    const withPhotos = !isNative && np > 0 && confirm('Sertakan ' + np + ' foto dalam cadangan? (ukuran file lebih besar)');
    const plans = [];
    for (const p of store.plans) plans.push(await planToJSON(p, withPhotos));
    const data = { app: 'RutePintar', version: 2, exportedAt: new Date().toISOString(), plans };
    await deliver('rutepintar_semua-rencana_' + stamp() + '.json', JSON.stringify(data, null, 2) + '\n', 'application/json');
  };

  // ---------- Panel bawah ----------
  $('#handle').onclick = () => $('#sheet').classList.toggle('collapsed');
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#topbar')) hideResults();
  });

  // ---------- Mulai ----------
  loadStore();
  try { history.replaceState(null, ''); } catch (_) { /* abaikan */ }
  renderHome();
  render();
  // Pertama kali (belum ada rencana): langsung minta nama rencana.
  if (!store.plans.length) askPlanName({ type: 'new' });
})();
