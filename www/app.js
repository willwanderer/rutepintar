(() => {
  'use strict';

  // ---------- Konfigurasi ----------
  const OSRM = 'https://router.project-osrm.org';
  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const MAX_POINTS = 100;
  const STORE_KEY = 'rutepintar.v2';

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
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // Pembuat elemen kecil: h('div', {className:'x'}, anak1, anak2)
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) for (const k of Object.keys(props)) el[k] = props[k];
    for (const k of kids) if (k != null) el.append(k);
    return el;
  }

  // ---------- Data ----------
  // route: { id, name, points:[{id,name,address,lat,lng,notes,active}], startId, endId, round, updated }
  const db = { routes: [] };
  let cur = null; // rute yang sedang dibuka
  const ui = { legs: [], totals: null, busy: false };

  function sanitizeRoute(r) {
    if (!r || typeof r !== 'object') return null;
    const pts = (Array.isArray(r.points) ? r.points : [])
      .filter((p) => p && isFinite(p.lat) && isFinite(p.lng))
      .map((p) => ({
        id: String(p.id || uid()),
        name: String(p.name || ''),
        address: String(p.address || ''),
        lat: +p.lat,
        lng: +p.lng,
        notes: String(p.notes || ''),
        active: p.active !== false,
      }));
    return {
      id: String(r.id || uid()),
      name: String(r.name || 'Rute'),
      points: pts,
      startId: r.startId || null,
      endId: r.endId || null,
      round: !!r.round,
      updated: +r.updated || Date.now(),
    };
  }
  function loadDb() {
    try {
      const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (d && Array.isArray(d.routes)) db.routes = d.routes.map(sanitizeRoute).filter(Boolean);
    } catch (_) { /* abaikan */ }
  }
  function saveDb() {
    if (cur) cur.updated = Date.now();
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ routes: db.routes }));
    } catch (_) { /* abaikan */ }
  }

  // ---------- Peta ----------
  const map = L.map('map', { zoomControl: false }).setView([-2.5, 118], 5);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
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

  async function geocode(q, limit = 5) {
    const data = await nominatim('/search?format=jsonv2&limit=' + limit + '&q=' + encodeURIComponent(q));
    return data.map((d) => ({
      label: shortLabel(d.display_name),
      full: d.display_name,
      lat: parseFloat(d.lat),
      lng: parseFloat(d.lon),
    }));
  }

  async function reverseGeocode(lat, lng) {
    const d = await nominatim('/reverse?format=jsonv2&zoom=18&lat=' + lat + '&lon=' + lng);
    return d && d.display_name ? { label: shortLabel(d.display_name), full: d.display_name } : null;
  }

  function fmtDist(m) {
    return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km' : Math.round(m) + ' m';
  }
  function fmtDur(s) {
    const m = Math.round(s / 60);
    if (m < 60) return m + ' mnt';
    return Math.floor(m / 60) + ' j ' + (m % 60) + ' mnt';
  }

  async function openExternal(url) {
    const P = window.Capacitor && window.Capacitor.Plugins;
    try {
      if (P && P.AppLauncher) { await P.AppLauncher.openUrl({ url }); return; } // membuka aplikasi Google Maps
    } catch (_) { /* coba cara lain */ }
    try {
      if (P && P.Browser) { await P.Browser.open({ url }); return; }
    } catch (_) { /* coba cara lain */ }
    window.open(url, '_blank');
  }

  // ---------- Layar 1: daftar rute ----------
  function renderRoutes() {
    const box = $('#routeList');
    box.innerHTML = '';
    $('#routesEmpty').hidden = db.routes.length > 0;
    db.routes
      .slice()
      .sort((a, b) => b.updated - a.updated)
      .forEach((r) => {
        const used = r.points.filter((p) => p.active).length;
        const sub = r.points.length + ' titik' + (used !== r.points.length ? ' (' + used + ' ikut rute)' : '');
        box.appendChild(
          h('div', { className: 'card' },
            h('button', { className: 'cardmain', type: 'button', onclick: () => openRoute(r.id) },
              h('div', { className: 'cname', textContent: r.name }),
              h('div', { className: 'csub', textContent: sub })),
            h('div', { className: 'cardbtns' },
              h('button', { type: 'button', textContent: 'Ganti nama', onclick: () => askName(r.id) }),
              h('button', { type: 'button', textContent: 'Hapus', onclick: () => deleteRoute(r.id) })))
        );
      });
  }

  function deleteRoute(id) {
    const r = db.routes.find((x) => x.id === id);
    if (!r) return;
    if (!confirm('Hapus rute "' + r.name + '" beserta semua titiknya?')) return;
    db.routes = db.routes.filter((x) => x.id !== id);
    saveDb();
    renderRoutes();
  }

  // Dialog nama rute (baru / ganti nama)
  const dlgName = $('#dlgName');
  let nameMode = { id: null };
  function askName(id) {
    nameMode = { id: id || null };
    const r = id ? db.routes.find((x) => x.id === id) : null;
    $('#nameTitle').textContent = r ? 'Ganti nama rute' : 'Rute baru';
    $('#nameInput').value = r ? r.name : '';
    dlgName.showModal();
    setTimeout(() => $('#nameInput').focus(), 60);
  }
  function saveName() {
    const v = $('#nameInput').value.trim();
    if (!v) return toast('Nama rute tidak boleh kosong.');
    if (nameMode.id) {
      const r = db.routes.find((x) => x.id === nameMode.id);
      if (r) {
        r.name = v;
        r.updated = Date.now();
        if (cur && cur.id === r.id) $('#routeTitle').textContent = v;
      }
      saveDb();
      renderRoutes();
      dlgName.close();
    } else {
      const r = { id: uid(), name: v, points: [], startId: null, endId: null, round: false, updated: Date.now() };
      db.routes.push(r);
      saveDb();
      dlgName.close();
      openRoute(r.id);
    }
  }
  $('#btnNewRoute').onclick = () => askName(null);
  $('#nameSave').onclick = saveName;
  $('#nameCancel').onclick = () => dlgName.close();
  $('#nameInput').onkeydown = (e) => { if (e.key === 'Enter') saveName(); };
  $('#routeTitle').onclick = () => cur && askName(cur.id);

  // ---------- Layar 2: isi rute ----------
  const byId = (id) => cur && cur.points.find((p) => p.id === id);
  const activePts = () => cur.points.filter((p) => p.active);
  function effStart() {
    const a = activePts();
    return a.find((p) => p.id === cur.startId) || a[0] || null;
  }
  function effEnd() {
    const e = activePts().find((p) => p.id === cur.endId);
    return e && e !== effStart() ? e : null;
  }

  // Urutan daftar: titik mulai di atas, titik akhir di bawah, yang tidak ikut di paling bawah.
  function normalizeOrder() {
    const s = effStart();
    const e = effEnd();
    const mid = activePts().filter((p) => p !== s && p !== e);
    const off = cur.points.filter((p) => !p.active);
    cur.points = (s ? [s] : []).concat(mid, e ? [e] : [], off);
  }

  function removeRouteLayer() {
    if (routeLayer) {
      map.removeLayer(routeLayer);
      routeLayer = null;
    }
  }
  function invalidate() {
    removeRouteLayer();
    ui.legs = [];
    ui.totals = null;
  }

  function openRoute(id) {
    const r = db.routes.find((x) => x.id === id);
    if (!r) return;
    cur = r;
    invalidate();
    $('#screenRoutes').hidden = true;
    $('#screenRoute').hidden = false;
    $('#routeTitle').textContent = cur.name;
    $('#sheet').classList.remove('collapsed');
    $('#optRound').checked = cur.round;
    $('#q').value = '';
    hideResults();
    map.invalidateSize();
    render();
    fitAll();
  }

  function closeRoute() {
    invalidate();
    markerLayer.clearLayers();
    cur = null;
    $('#screenRoute').hidden = true;
    $('#screenRoutes').hidden = false;
    renderRoutes();
  }
  $('#btnBack').onclick = closeRoute;

  function makeIcon(label, cls) {
    return L.divIcon({
      className: '',
      html: '<div class="pin ' + cls + '"><b>' + label + '</b></div>',
      iconSize: [28, 28],
      iconAnchor: [14, 28],
    });
  }

  function renderSummary() {
    const el = $('#summary');
    const total = cur.points.length;
    if (!total) {
      el.textContent = 'Belum ada titik. Cari alamat, ketuk peta, atau ketuk "+ Titik".';
      return;
    }
    const a = activePts().length;
    let html = '<b>' + a + ' dari ' + total + ' titik</b> ikut rute';
    if (ui.totals) html += ' · ' + fmtDist(ui.totals.distance) + ' · ' + fmtDur(ui.totals.duration);
    else if (a >= 2) html += ' · ketuk "Cari rute tercepat"';
    el.innerHTML = html;
  }

  function render() {
    if (!cur) return;
    markerLayer.clearLayers();
    const list = $('#points');
    list.innerHTML = '';
    const s = effStart();
    const e = effEnd();
    const activeCount = activePts().length;
    let n = 0;

    cur.points.forEach((p, idx) => {
      const on = p.active;
      const role = on ? (p === s ? 'start' : p === e ? 'end' : '') : '';
      const num = on ? ++n : null;

      // Penanda di peta
      const mk = L.marker([p.lat, p.lng], {
        icon: makeIcon(on ? num : '–', on ? role : 'off'),
        draggable: true,
      });
      mk.bindTooltip(p.name || coordLabel(p.lat, p.lng));
      mk.on('dragend', async () => {
        const pos = mk.getLatLng();
        p.lat = pos.lat;
        p.lng = pos.lng;
        p.address = coordLabel(pos.lat, pos.lng);
        invalidate();
        render();
        saveDb();
        try {
          const r = await reverseGeocode(pos.lat, pos.lng);
          if (r) { p.address = r.full; render(); saveDb(); }
        } catch (_) { /* biarkan koordinat */ }
      });
      markerLayer.addLayer(mk);

      // Baris di daftar
      const tag = role ? h('span', { className: 'tag ' + role, textContent: role === 'start' ? 'MULAI' : 'AKHIR' }) : null;
      const info = h('div', { className: 'info' },
        h('div', { className: 'pname' }, p.name || 'Titik ' + (idx + 1), tag),
        h('div', { className: 'paddr', textContent: p.address || coordLabel(p.lat, p.lng) }));
      if (p.notes) info.append(h('div', { className: 'pnote', textContent: p.notes }));
      if (on && ui.legs[num - 1]) {
        const lg = ui.legs[num - 1];
        info.append(h('div', { className: 'leg',
          textContent: (num === activeCount ? '↩ kembali ke titik mulai · ' : '↓ ') +
            fmtDist(lg.distance) + ' · ' + fmtDur(lg.duration) }));
      }

      const prev = cur.points[idx - 1];
      const next = cur.points[idx + 1];
      const fixed = (q) => !q || !q.active || q === s || q === e;
      const canMove = on && !fixed(p);

      const btns = h('div', { className: 'ptbtns' },
        h('button', { type: 'button', textContent: 'Mulai', disabled: !on,
          className: p === s ? 'on start' : '', onclick: () => setStart(p.id) }),
        h('button', { type: 'button', textContent: 'Akhir', disabled: !on,
          className: p === e ? 'on end' : '', onclick: () => setEnd(p.id) }),
        h('button', { type: 'button', textContent: 'Google Maps', className: 'gm', onclick: () => gmapsPoint(p) }),
        h('button', { type: 'button', textContent: 'Ubah', onclick: () => openEditor(p) }),
        h('button', { type: 'button', textContent: '↑', disabled: !canMove || fixed(prev),
          onclick: () => movePoint(p.id, -1) }),
        h('button', { type: 'button', textContent: '↓', disabled: !canMove || fixed(next),
          onclick: () => movePoint(p.id, 1) }),
        h('button', { type: 'button', textContent: 'Hapus', className: 'del', onclick: () => deletePoint(p.id) }));
      info.append(btns);

      const lead = h('div', { className: 'lead' },
        h('input', { type: 'checkbox', className: 'inc', checked: on, onchange: () => toggleActive(p.id) }),
        h('div', { className: 'num' + (on ? (role ? ' ' + role : '') : ' offnum'), textContent: on ? String(num) : '–' }));

      list.appendChild(h('li', { className: 'pt' + (on ? '' : ' off') }, lead, info));
    });

    $('#roundRow').classList.toggle('disabled', !!e);
    $('#optRound').disabled = !!e;
    $('#optRound').checked = cur.round;
    renderSummary();
  }

  function fitAll() {
    if (!cur || !cur.points.length) return;
    const b = L.latLngBounds(cur.points.map((p) => [p.lat, p.lng]));
    map.fitBounds(b, { padding: [60, 60], maxZoom: 16 });
  }

  // ---------- Aksi pada titik ----------
  function afterChange({ refit = false } = {}) {
    normalizeOrder();
    invalidate();
    render();
    saveDb();
    if (refit) fitAll();
  }

  function setStart(id) {
    const p = byId(id);
    if (!p || !p.active) return;
    if (effStart() === p && cur.startId === p.id) {
      cur.startId = null; // kembali ke default (titik pertama)
    } else {
      cur.startId = p.id;
      if (cur.endId === p.id) cur.endId = null;
    }
    afterChange();
  }

  function setEnd(id) {
    const p = byId(id);
    if (!p || !p.active) return;
    if (effStart() === p) return toast('Titik mulai tidak bisa sekaligus titik akhir. Pilih titik mulai lain dulu.', 4500);
    cur.endId = effEnd() === p ? null : p.id;
    afterChange();
  }

  function toggleActive(id) {
    const p = byId(id);
    if (!p) return;
    p.active = !p.active;
    if (!p.active) {
      if (cur.startId === id) cur.startId = null;
      if (cur.endId === id) cur.endId = null;
    }
    afterChange();
  }

  function movePoint(id, d) {
    const i = cur.points.findIndex((p) => p.id === id);
    const j = i + d;
    const a = cur.points[i];
    const b = cur.points[j];
    if (!a || !b) return;
    const s = effStart();
    const e = effEnd();
    const fixed = (q) => !q.active || q === s || q === e;
    if (fixed(a) || fixed(b)) return;
    cur.points[i] = b;
    cur.points[j] = a;
    invalidate();
    render();
    saveDb();
  }

  function deletePoint(id) {
    const p = byId(id);
    if (!p) return;
    if (!confirm('Hapus titik "' + (p.name || coordLabel(p.lat, p.lng)) + '"?')) return;
    cur.points = cur.points.filter((q) => q.id !== id);
    if (cur.startId === id) cur.startId = null;
    if (cur.endId === id) cur.endId = null;
    afterChange();
  }

  function gmapsPoint(p) {
    openExternal('https://www.google.com/maps/search/?api=1&query=' + p.lat.toFixed(6) + ',' + p.lng.toFixed(6));
  }

  // ---------- Editor titik (nama, lokasi, keterangan) ----------
  const dlgPoint = $('#dlgPoint');
  const ed = { id: null, lat: null, lng: null, nameTouched: false, locTouched: false, locDirty: false, token: 0, saving: false };
  let pickMode = false;
  let sheetWasCollapsed = false;

  function showCoord() {
    $('#edCoord').textContent =
      ed.lat != null
        ? 'Koordinat: ' + coordLabel(ed.lat, ed.lng) + (ed.locDirty ? ' (tekan Cari untuk memperbarui)' : '')
        : 'Lokasi belum ditentukan. Ketik alamat lalu tekan Cari, atau pilih di peta.';
  }

  function openEditor(p, pre) {
    ed.token++;
    ed.id = p ? p.id : null;
    ed.lat = p ? p.lat : pre && pre.lat != null ? pre.lat : null;
    ed.lng = p ? p.lng : pre && pre.lng != null ? pre.lng : null;
    ed.nameTouched = p ? true : !!(pre && pre.name);
    ed.locTouched = !!p;
    ed.locDirty = false;
    ed.saving = false;
    $('#edTitle').textContent = p ? 'Ubah titik' : 'Titik baru';
    $('#edName').value = p ? p.name : (pre && pre.name) || '';
    $('#edLoc').value = p ? p.address : (pre && pre.address) || '';
    $('#edNotes').value = p ? p.notes : '';
    $('#edResults').hidden = true;
    $('#edResults').innerHTML = '';
    $('#edSave').disabled = false;
    showCoord();
    dlgPoint.showModal();
  }

  function setEdLocation(lat, lng, address) {
    ed.lat = lat;
    ed.lng = lng;
    ed.locDirty = false;
    $('#edLoc').value = address;
    showCoord();
  }

  // Isi nama/alamat dari koordinat bila pengguna belum mengetiknya sendiri
  async function reverseFill(lat, lng) {
    const token = ed.token;
    try {
      const r = await reverseGeocode(lat, lng);
      if (!r || token !== ed.token) return;
      if (!ed.locTouched) $('#edLoc').value = r.full;
      if (!ed.nameTouched) $('#edName').value = r.label;
    } catch (_) { /* biarkan koordinat */ }
  }

  $('#edName').oninput = () => { ed.nameTouched = true; };
  $('#edLoc').oninput = () => { ed.locTouched = true; ed.locDirty = true; showCoord(); };
  $('#edLoc').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); edSearch(); } };
  $('#edFind').onclick = () => edSearch();
  $('#edCancel').onclick = () => { ed.token++; dlgPoint.close(); };

  async function edSearch() {
    const q = $('#edLoc').value.trim();
    const box = $('#edResults');
    if (q.length < 2) return;
    const c = parseCoord(q);
    if (c) {
      ed.locTouched = false;
      setEdLocation(c.lat, c.lng, coordLabel(c.lat, c.lng));
      box.hidden = true;
      reverseFill(c.lat, c.lng);
      return;
    }
    box.hidden = false;
    box.innerHTML = '';
    box.appendChild(h('div', { className: 'none', textContent: 'Mencari…' }));
    const token = ed.token;
    try {
      const list = await geocode(q);
      if (token !== ed.token) return;
      box.innerHTML = '';
      if (!list.length) {
        box.appendChild(h('div', { className: 'none', textContent: 'Tidak ditemukan. Coba kata kunci lain atau pilih di peta.' }));
        return;
      }
      list.forEach((r) =>
        box.appendChild(h('button', { type: 'button', textContent: r.full, onclick: () => {
          setEdLocation(r.lat, r.lng, r.full);
          if (!ed.nameTouched) $('#edName').value = r.label;
          box.hidden = true;
        } })));
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(h('div', { className: 'none', textContent: 'Gagal mencari: ' + e.message }));
    }
  }

  // Pilih lokasi lewat peta
  $('#edPick').onclick = () => {
    dlgPoint.close();
    pickMode = true;
    sheetWasCollapsed = $('#sheet').classList.contains('collapsed');
    $('#sheet').classList.add('collapsed');
    $('#pickBanner').hidden = false;
  };
  function endPick() {
    pickMode = false;
    $('#pickBanner').hidden = true;
    if (!sheetWasCollapsed) $('#sheet').classList.remove('collapsed');
  }
  function cancelPick() {
    endPick();
    dlgPoint.showModal();
  }
  $('#pickCancel').onclick = cancelPick;
  function finishPick(lat, lng) {
    endPick();
    ed.locTouched = false;
    setEdLocation(lat, lng, coordLabel(lat, lng));
    $('#edResults').hidden = true;
    dlgPoint.showModal();
    reverseFill(lat, lng);
  }

  $('#edSave').onclick = async () => {
    if (ed.saving || !cur) return;
    const name = $('#edName').value.trim();
    const loc = $('#edLoc').value.trim();
    const notes = $('#edNotes').value.trim();
    ed.saving = true;
    $('#edSave').disabled = true;
    try {
      let address = loc;
      // Lokasi diketik tapi belum dicari: selesaikan sekarang
      if (ed.locDirty || ed.lat == null) {
        if (!loc) throw new Error('Isi lokasi (alamat atau koordinat) atau pilih di peta.');
        const c = parseCoord(loc);
        if (c) {
          ed.lat = c.lat;
          ed.lng = c.lng;
          address = coordLabel(c.lat, c.lng);
        } else {
          const r = await geocode(loc, 1);
          if (!r.length) throw new Error('Lokasi tidak ditemukan. Coba alamat lain atau pilih di peta.');
          ed.lat = r[0].lat;
          ed.lng = r[0].lng;
          address = r[0].full;
        }
      }
      if (!address) address = coordLabel(ed.lat, ed.lng);
      const finalName = name || address.split(',')[0].trim() || 'Titik ' + (cur.points.length + 1);

      if (ed.id) {
        const p = byId(ed.id);
        if (p) {
          const moved = p.lat !== ed.lat || p.lng !== ed.lng;
          Object.assign(p, { name: finalName, address, lat: ed.lat, lng: ed.lng, notes });
          if (!moved) {
            render();
            saveDb();
            ed.token++;
            dlgPoint.close();
            return;
          }
        }
      } else {
        if (cur.points.length >= MAX_POINTS) throw new Error('Maksimal ' + MAX_POINTS + ' titik per rute.');
        cur.points.push({ id: uid(), name: finalName, address, lat: ed.lat, lng: ed.lng, notes, active: true });
      }
      ed.token++;
      dlgPoint.close();
      afterChange({ refit: true });
    } catch (e) {
      toast(e.message, 4500);
    } finally {
      ed.saving = false;
      $('#edSave').disabled = false;
    }
  };

  $('#btnAdd').onclick = () => cur && openEditor(null);

  // ---------- Pencarian (bilah atas) ----------
  const qEl = $('#q');
  const resEl = $('#results');
  let searchTimer = null;
  let searchToken = 0;

  function hideResults() {
    resEl.hidden = true;
    resEl.innerHTML = '';
  }

  async function runSearch() {
    if (!cur) return;
    const q = qEl.value.trim();
    if (q.length < 3) return hideResults();
    const token = ++searchToken;
    resEl.hidden = false;
    resEl.innerHTML = '';

    // Koordinat: tawarkan langsung menambahkan titiknya
    const coord = parseCoord(q);
    if (coord) {
      resEl.appendChild(h('button', { type: 'button',
        textContent: '📍 Tambahkan titik ' + coordLabel(coord.lat, coord.lng),
        onclick: () => {
          qEl.value = '';
          hideResults();
          qEl.blur();
          openEditor(null, { lat: coord.lat, lng: coord.lng, address: coordLabel(coord.lat, coord.lng) });
          reverseFill(coord.lat, coord.lng);
        } }));
      return;
    }
    if (/^[\s\d.,;+-]+$/.test(q)) {
      resEl.appendChild(h('div', { className: 'none', textContent: 'Format koordinat: lat,lng (contoh: -5.1477, 119.4327)' }));
      return;
    }

    resEl.appendChild(h('div', { className: 'none', textContent: 'Mencari…' }));
    try {
      const list = await geocode(q);
      if (token !== searchToken) return;
      resEl.innerHTML = '';
      if (!list.length) {
        resEl.appendChild(h('div', { className: 'none', textContent: 'Tidak ditemukan. Coba kata kunci lain atau ketuk peta.' }));
        return;
      }
      list.forEach((r) =>
        resEl.appendChild(h('button', { type: 'button', textContent: r.full, onclick: () => {
          qEl.value = '';
          hideResults();
          qEl.blur();
          map.flyTo([r.lat, r.lng], 16);
          openEditor(null, { lat: r.lat, lng: r.lng, name: r.label, address: r.full });
        } })));
    } catch (e) {
      if (token !== searchToken) return;
      resEl.innerHTML = '';
      resEl.appendChild(h('div', { className: 'none', textContent: 'Gagal mencari: ' + e.message }));
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
    if (!cur) return;
    const { lat, lng } = e.latlng;
    if (pickMode) return finishPick(lat, lng);
    openEditor(null, { lat, lng, address: coordLabel(lat, lng) });
    reverseFill(lat, lng);
  });

  // ---------- Lokasi saya ----------
  async function locate() {
    if (!cur) return;
    try {
      const G = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Geolocation;
      let pos;
      if (G) {
        try { await G.requestPermissions(); } catch (_) { /* lanjut */ }
        pos = await G.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
      } else {
        pos = await new Promise((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 15000 }));
      }
      const { latitude: lat, longitude: lng } = pos.coords;
      map.flyTo([lat, lng], 16);
      if (confirm('Tambahkan lokasi Anda saat ini sebagai titik?')) {
        openEditor(null, { lat, lng, name: 'Lokasi saya', address: coordLabel(lat, lng) });
        reverseFill(lat, lng);
      }
    } catch (e) {
      toast('Tidak bisa mengambil lokasi. Pastikan izin lokasi dan GPS aktif.');
    }
  }
  $('#btnGps').onclick = locate;

  // ---------- Rute tercepat ----------
  const lngLat = (p) => p.lng.toFixed(6) + ',' + p.lat.toFixed(6);

  function setBusy(b, msg) {
    ui.busy = b;
    document.querySelectorAll('#actions button').forEach((x) => (x.disabled = b));
    if (b && msg) $('#summary').textContent = msg;
  }

  async function drawRoute() {
    const pts = activePts();
    const rt = !effEnd() && cur.round;
    const seq = rt && pts.length >= 2 ? pts.concat(pts[0]) : pts;
    const url =
      OSRM + '/route/v1/driving/' + seq.map(lngLat).join(';') + '?overview=full&geometries=geojson&steps=false';
    const data = await fetchJSON(url);
    if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
      throw new Error(data.message || 'Rute tidak ditemukan. Mungkin ada titik yang tidak terjangkau jalan.');
    }
    const r = data.routes[0];
    removeRouteLayer();
    routeLayer = L.geoJSON(r.geometry, { style: { color: '#0f766e', weight: 5, opacity: 0.85 } }).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [70, 70] });
    ui.legs = r.legs.map((l) => ({ distance: l.distance, duration: l.duration }));
    ui.totals = { distance: r.distance, duration: r.duration };
  }

  async function optimize() {
    if (ui.busy || !cur) return;
    if (activePts().length < 2) return toast('Centang minimal 2 titik yang ikut rute.');
    normalizeOrder();
    const a = activePts();
    const e = effEnd();
    setBusy(true, 'Menghitung rute tercepat…');
    try {
      if (a.length >= 3) {
        const t = await fetchJSON(OSRM + '/table/v1/driving/' + a.map(lngLat).join(';') + '?annotations=duration');
        if (t.code !== 'Ok' || !t.durations) throw new Error(t.message || 'Gagal menghitung matriks jarak.');
        const order = RouteSolver.solve(t.durations, {
          start: 0,
          end: e ? a.length - 1 : null,
          roundtrip: !e && cur.round,
        });
        const off = cur.points.filter((p) => !p.active);
        cur.points = order.map((i) => a[i]).concat(off);
      }
      await drawRoute();
      saveDb();
      toast('Rute selesai dihitung.');
    } catch (err) {
      invalidate();
      toast('Gagal: ' + err.message, 5000);
    } finally {
      setBusy(false);
      render();
    }
  }
  $('#btnOptimize').onclick = optimize;
  $('#optRound').onchange = () => {
    if (!cur) return;
    cur.round = $('#optRound').checked;
    invalidate();
    render();
    saveDb();
  };

  // ---------- Navigasi & bagikan (seluruh rute) ----------
  function routeMapsUrl() {
    const a = activePts();
    const rt = !effEnd() && cur.round;
    const ll = (p) => p.lat.toFixed(6) + ',' + p.lng.toFixed(6);
    const origin = a[0];
    const destination = rt ? a[0] : a[a.length - 1];
    const mids = rt ? a.slice(1) : a.slice(1, -1);
    const shown = mids.slice(0, 9); // batas Google Maps: 9 titik antara
    let url =
      'https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=' + ll(origin) +
      '&destination=' + ll(destination);
    if (shown.length) url += '&waypoints=' + encodeURIComponent(shown.map(ll).join('|'));
    return { url, truncated: mids.length > shown.length };
  }

  $('#btnNav').onclick = () => {
    if (!cur) return;
    if (activePts().length < 2) return toast('Centang minimal 2 titik yang ikut rute.');
    const { url, truncated } = routeMapsUrl();
    if (truncated) toast('Google Maps hanya menerima 9 titik antara; titik sisanya tidak ikut terkirim.', 5000);
    openExternal(url);
  };

  $('#btnShare').onclick = async () => {
    if (!cur) return;
    const a = activePts();
    if (!a.length) return toast('Belum ada titik untuk dibagikan.');
    const rt = !effEnd() && cur.round;
    const lines = [];
    a.forEach((p, i) => {
      lines.push((i + 1) + '. ' + (p.name || coordLabel(p.lat, p.lng)) + (p.address ? ' — ' + p.address : ''));
      if (p.notes) lines.push('   Ket: ' + p.notes);
    });
    if (rt) lines.push('↩ kembali ke titik mulai');
    let text = 'Rute: ' + cur.name + '\n' + lines.join('\n');
    if (ui.totals) text += '\nTotal: ' + fmtDist(ui.totals.distance) + ', ' + fmtDur(ui.totals.duration);
    if (a.length >= 2) text += '\n' + routeMapsUrl().url;

    const S = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share;
    try {
      if (S) await S.share({ title: 'Rute ' + cur.name, text, dialogTitle: 'Bagikan rute' });
      else if (navigator.share) await navigator.share({ title: 'Rute ' + cur.name, text });
      else {
        await navigator.clipboard.writeText(text);
        toast('Rute disalin ke papan klip.');
      }
    } catch (e) {
      if (e && e.name !== 'AbortError' && !/cancel/i.test(String(e.message))) toast('Gagal membagikan rute.');
    }
  };

  // ---------- Impor ----------
  const dlgImport = $('#dlgImport');
  let importing = false;

  $('#btnImport').onclick = () => {
    if (!cur) return;
    $('#importStatus').textContent = '';
    dlgImport.showModal();
  };
  $('#importFile').onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    $('#importText').value = await f.text();
  };
  $('#importCancel').onclick = () => {
    if (importing) return toast('Tunggu, impor sedang berjalan.');
    dlgImport.close();
  };

  $('#importGo').onclick = async () => {
    if (importing || !cur) return;
    const lines = $('#importText').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const room = MAX_POINTS - cur.points.length;
    if (lines.length > room) toast('Hanya ' + Math.max(room, 0) + ' baris pertama yang diproses (batas ' + MAX_POINTS + ').');
    const todo = lines.slice(0, Math.max(room, 0));

    importing = true;
    $('#importGo').disabled = true;
    const status = $('#importStatus');
    const failed = [];
    let ok = 0;
    for (let i = 0; i < todo.length; i++) {
      const line = todo[i];
      status.textContent = 'Memproses ' + (i + 1) + ' dari ' + todo.length + '…';
      try {
        const parts = line.split('|').map((s) => s.trim());
        let name = '';
        let loc = parts[0];
        let notes = '';
        if (parts.length >= 2) {
          name = parts[0];
          loc = parts[1];
          notes = parts.slice(2).join(' | ');
        }
        if (!loc) { failed.push(line); continue; }
        const c = parseCoord(loc);
        if (c) {
          cur.points.push({ id: uid(), name: name || coordLabel(c.lat, c.lng), address: coordLabel(c.lat, c.lng),
            lat: c.lat, lng: c.lng, notes, active: true });
          ok++;
        } else {
          const r = await geocode(loc, 1);
          if (r.length) {
            cur.points.push({ id: uid(), name: name || r[0].label || loc, address: r[0].full,
              lat: r[0].lat, lng: r[0].lng, notes, active: true });
            ok++;
          } else failed.push(line);
        }
      } catch (_) {
        failed.push(line);
      }
    }
    importing = false;
    $('#importGo').disabled = false;
    if (ok) afterChange({ refit: true });
    if (failed.length) {
      $('#importText').value = failed.join('\n');
      status.textContent = ok + ' berhasil, ' + failed.length + ' gagal ditemukan (tersisa di kotak di atas).';
    } else {
      $('#importText').value = '';
      status.textContent = '';
      dlgImport.close();
      toast(ok + ' titik ditambahkan.');
    }
  };

  // ---------- Panel bawah & tombol kembali Android ----------
  $('#handle').onclick = () => $('#sheet').classList.toggle('collapsed');
  document.addEventListener('click', (e) => {
    if (e.target && e.target.closest && !e.target.closest('#topbar')) hideResults();
  });

  (function initBack() {
    const A = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (!A) return;
    try {
      A.addListener('backButton', () => {
        const dlg = [dlgPoint, dlgImport, dlgName].find((d) => d.open);
        if (dlg) {
          if (dlg === dlgImport && importing) return;
          dlg.close();
          return;
        }
        if (pickMode) return cancelPick();
        if (cur) return closeRoute();
        A.exitApp();
      });
    } catch (_) { /* abaikan */ }
  })();

  // ---------- Mulai ----------
  loadDb();
  renderRoutes();
})();
