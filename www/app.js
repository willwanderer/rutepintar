(() => {
  'use strict';

  // ---------- Konfigurasi ----------
  const OSRM = 'https://router.project-osrm.org';
  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const MAX_STOPS = 100;
  const STORE_KEY = 'rutepintar.v1';
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

  const state = {
    stops: [], // { id, label, lat, lng }
    legs: [], // { distance, duration } per ruas, sesuai urutan stops
    totals: null, // { distance, duration }
    round: true,
    busy: false,
  };
  let nextId = 1;

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

  // ---------- Penyimpanan ----------
  function save() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ stops: state.stops, round: state.round })
      );
    } catch (_) { /* abaikan */ }
  }
  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (d && Array.isArray(d.stops)) {
        state.stops = d.stops
          .filter((s) => isFinite(s.lat) && isFinite(s.lng))
          .map((s) => ({ id: nextId++, label: String(s.label || ''), lat: +s.lat, lng: +s.lng }));
        state.round = d.round !== false;
      }
    } catch (_) { /* abaikan */ }
  }

  // ---------- Daftar tujuan ----------
  function clearRoute() {
    if (routeLayer) {
      map.removeLayer(routeLayer);
      routeLayer = null;
    }
    state.legs = [];
    state.totals = null;
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
      m.bindTooltip(s.label || coordLabel(s.lat, s.lng));
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
      lab.textContent = s.label || coordLabel(s.lat, s.lng);
      lab.onclick = () => map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 15));
      info.appendChild(lab);
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
      const del = mkBtn('✕', 'Hapus', () => removeStop(i));
      btns.append(up, down, del);

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
    state.stops.splice(i, 1);
    clearRoute();
    render();
    save();
  }

  function fitAll() {
    if (!state.stops.length) return;
    const b = L.latLngBounds(state.stops.map((s) => [s.lat, s.lng]));
    map.fitBounds(b, { padding: [50, 50], maxZoom: 16 });
  }

  function addStop(lat, lng, label, { fit = true } = {}) {
    if (state.stops.length >= MAX_STOPS) {
      toast('Maksimal ' + MAX_STOPS + ' tujuan.');
      return null;
    }
    const s = { id: nextId++, label: label || coordLabel(lat, lng), lat, lng };
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

  // ---------- Pencarian ----------
  const qEl = $('#q');
  const resEl = $('#results');
  let searchTimer = null;
  let searchToken = 0;

  function hideResults() {
    resEl.hidden = true;
    resEl.innerHTML = '';
  }

  async function addByCoord(c) {
    qEl.value = '';
    hideResults();
    qEl.blur();
    const s = addStop(c.lat, c.lng, null);
    if (!s) return;
    try {
      const name = await reverseGeocode(c.lat, c.lng);
      if (name) { s.label = name; render(); save(); }
    } catch (_) { /* biarkan koordinat */ }
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
          addStop(r.lat, r.lng, r.label);
          qEl.value = '';
          hideResults();
          qEl.blur();
        };
        resEl.appendChild(b);
      });
    } catch (e) {
      if (token !== searchToken) return;
      resEl.innerHTML = '<div class="none">Gagal mencari: ' + e.message + '</div>';
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
  map.on('click', async (e) => {
    hideResults();
    const { lat, lng } = e.latlng;
    const s = addStop(lat, lng, null, { fit: false });
    if (!s) return;
    try {
      const name = await reverseGeocode(lat, lng);
      if (name) { s.label = name; render(); save(); }
    } catch (_) { /* biarkan koordinat */ }
  });

  // ---------- Lokasi saya ----------
  async function locate() {
    try {
      const G = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Geolocation;
      let pos;
      if (G) {
        try { await G.requestPermissions(); } catch (_) { /* lanjut */ }
        pos = await G.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
      } else {
        pos = await new Promise((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 15000 })
        );
      }
      const { latitude: lat, longitude: lng } = pos.coords;
      map.flyTo([lat, lng], 16);
      if (confirm('Tambahkan lokasi Anda saat ini sebagai tujuan?')) {
        const s = addStop(lat, lng, 'Lokasi saya', { fit: false });
        if (s) {
          try {
            const name = await reverseGeocode(lat, lng);
            if (name) { s.label = name; render(); save(); }
          } catch (_) { /* tetap "Lokasi saya" */ }
        }
      }
    } catch (e) {
      toast('Tidak bisa mengambil lokasi. Pastikan izin lokasi dan GPS aktif.');
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
    const r = data.routes[0];
    if (routeLayer) map.removeLayer(routeLayer);
    routeLayer = L.geoJSON(r.geometry, { style: { color: '#0f766e', weight: 5, opacity: 0.85 } }).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [60, 60] });
    state.legs = r.legs.map((l) => ({ distance: l.distance, duration: l.duration }));
    state.totals = { distance: r.distance, duration: r.duration };
  }

  async function optimize() {
    if (state.busy) return;
    const n = state.stops.length;
    if (n < 2) return toast('Tambahkan minimal 2 tujuan.');
    state.round = $('#optRound').checked;
    setBusy(true, 'Menghitung rute tercepat…');
    try {
      if (n >= 3) {
        const coords = state.stops.map(lngLat).join(';');
        const t = await fetchJSON(OSRM + '/table/v1/driving/' + coords + '?annotations=duration');
        if (t.code !== 'Ok' || !t.durations) {
          throw new Error(t.message || 'Gagal menghitung matriks jarak.');
        }
        const order = RouteSolver.solve(t.durations, { roundtrip: state.round });
        state.stops = order.map((i) => state.stops[i]);
      }
      await drawRoute();
      save();
      toast('Rute selesai dihitung.');
    } catch (e) {
      clearRoute();
      toast('Gagal: ' + e.message, 5000);
    } finally {
      setBusy(false);
      render();
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
    const B = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser;
    if (B) B.open({ url });
    else window.open(url, '_blank');
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
    const lines = state.stops.map((s, i) => (i + 1) + '. ' + (s.label || coordLabel(s.lat, s.lng)));
    if (state.round) lines.push('↩ kembali ke ' + (state.stops[0].label || 'titik awal'));
    let text = 'Rute RutePintar\n' + lines.join('\n');
    if (state.totals) text += '\nTotal: ' + fmtDist(state.totals.distance) + ', ' + fmtDur(state.totals.duration);
    if (state.stops.length >= 2) text += '\n' + mapsUrl().url;

    const S = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share;
    try {
      if (S) await S.share({ title: 'Rute RutePintar', text, dialogTitle: 'Bagikan rute' });
      else if (navigator.share) await navigator.share({ title: 'Rute RutePintar', text });
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
    if (!confirm('Hapus semua tujuan?')) return;
    state.stops = [];
    clearRoute();
    render();
    save();
  };

  // ---------- Impor ----------
  const dlg = $('#dlgImport');
  let importing = false;

  $('#btnImport').onclick = () => {
    $('#importStatus').textContent = '';
    dlg.showModal();
  };
  $('#importFile').onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    $('#importText').value = await f.text();
  };
  $('#importCancel').onclick = (e) => {
    if (importing) { e.preventDefault(); toast('Tunggu, impor sedang berjalan.'); }
  };

  $('#importGo').onclick = async () => {
    if (importing) return;
    const lines = $('#importText').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const room = MAX_STOPS - state.stops.length;
    if (lines.length > room) toast('Hanya ' + room + ' baris pertama yang diproses (batas ' + MAX_STOPS + ').');
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
        const c = parseCoord(line);
        if (c) {
          addStop(c.lat, c.lng, coordLabel(c.lat, c.lng), { fit: false });
          ok++;
        } else {
          const r = await geocode(line, 1);
          if (r.length) {
            addStop(r[0].lat, r[0].lng, r[0].label || line, { fit: false });
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

  // ---------- Panel bawah ----------
  $('#handle').onclick = () => $('#sheet').classList.toggle('collapsed');
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#topbar')) hideResults();
  });

  // ---------- Mulai ----------
  load();
  $('#optRound').checked = state.round;
  render();
  fitAll();
})();
