// Generator laporan perjalanan RutePintar (PDF A4) menggunakan jsPDF.
// Modul mandiri: menerima data biasa (bukan objek aplikasi) dan mengembalikan Blob PDF.
//
// RouteReport.build({
//   title, startedAt, finishedAt, generatedAt, round,
//   route: { distance, duration, legs:[{distance,duration}], geometry:[[lat,lng],...] } | null,
//   stops: [{ name, label, note, lat, lng, photos:[{ blob, at }] }],
//   tile: { url, attribution, subdomains } | null,
//   onProgress(fraction, text)
// }) -> Promise<Blob>
(function (root) {
  'use strict';

  // ---------- Palet & ukuran (mm) ----------
  const C = {
    brand: [15, 118, 110], dark: [17, 94, 89], accent: [217, 119, 6],
    text: [31, 41, 55], muted: [107, 114, 128], line: [226, 232, 240],
    soft: [240, 253, 250], card: [248, 250, 252], ok: [21, 128, 61], okBg: [220, 252, 231],
    white: [255, 255, 255],
  };
  const PW = 210, PH = 297, M = 15, CW = PW - 2 * M, FOOT = 285, TOP = 20;

  // Font bawaan PDF (Helvetica) hanya mengenal Latin-1: ganti karakter lain agar tidak rusak.
  function T(s) {
    return String(s == null ? '' : s)
      .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"')
      .replace(/[–—−]/g, '-').replace(/…/g, '...').replace(/[•·●]/g, '·')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[←-⯿︀-️​-‍]|[\uD800-\uDFFF]/g, '') // emoji & simbol: dibuang
      .replace(/[^\x20-\x7E -ÿ]/g, '?')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  function TB(s) { // teks beberapa baris (pertahankan baris baru)
    return String(s == null ? '' : s).split(/\r?\n/).map(T).join('\n');
  }

  // ---------- Format ----------
  const id = 'id-ID';
  const fmtDate = (ms) => new Date(ms).toLocaleDateString(id, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fmtDateS = (ms) => new Date(ms).toLocaleDateString(id, { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString(id, { hour: '2-digit', minute: '2-digit', hour12: false });
  const fmtDT = (ms) => fmtDateS(ms) + ', ' + fmtTime(ms);
  function fmtDur(sec) {
    const m = Math.round(sec / 60);
    if (m < 1) return '< 1 mnt';
    if (m < 60) return m + ' mnt';
    const h = Math.floor(m / 60);
    return h + ' j ' + (m % 60 ? (m % 60) + ' mnt' : '');
  }
  const fmtDist = (m) => m >= 1000
    ? (m / 1000).toLocaleString(id, { maximumFractionDigits: 1 }) + ' km'
    : Math.round(m) + ' m';
  const coord = (lat, lng) => lat.toFixed(5) + ', ' + lng.toFixed(5);
  // Alamat yang cuma berupa koordinat tidak perlu ditampilkan dua kali.
  const realAddr = (s) => (s.label && !/^-?\d{1,3}(\.\d+)?\s*[,;]\s*-?\d{1,3}(\.\d+)?$/.test(String(s.label).trim()) ? s.label : '');
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

  // ---------- Gambar ----------
  async function loadBitmap(blob) {
    try {
      return { src: await createImageBitmap(blob), close() { this.src.close && this.src.close(); } };
    } catch (_) {
      const url = URL.createObjectURL(blob);
      const im = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('gambar rusak'));
        i.src = url;
      });
      return { src: im, close() { URL.revokeObjectURL(url); } };
    }
  }
  // Potong tengah (cover) ke rasio w:h lalu simpan sebagai JPEG ringan.
  async function coverJpeg(blob, W, H, q) {
    const bm = await loadBitmap(blob);
    try {
      const sw = bm.src.width || bm.src.naturalWidth;
      const sh = bm.src.height || bm.src.naturalHeight;
      const k = Math.max(W / sw, H / sh);
      const cw = W / k;
      const ch = H / k;
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, W, H);
      g.drawImage(bm.src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, W, H);
      return c.toDataURL('image/jpeg', q);
    } finally {
      bm.close();
    }
  }

  // ---------- Peta statis (tile + rute + penanda bernomor) ----------
  const worldPx = (lat, lng, z) => {
    const s = 256 * Math.pow(2, z);
    const sin = Math.min(0.9999, Math.max(-0.9999, Math.sin((lat * Math.PI) / 180)));
    return [((lng + 180) / 360) * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
  };

  function loadTile(url, ms) {
    return new Promise((res) => {
      const im = new Image();
      const t = setTimeout(() => res(null), ms);
      im.crossOrigin = 'anonymous';
      im.onload = () => { clearTimeout(t); res(im); };
      im.onerror = () => { clearTimeout(t); res(null); };
      im.src = url;
    });
  }

  async function renderMap(stops, geometry, round, tile) {
    const W = 1200;
    const H = 616;
    const PAD = 70;
    const pts = stops.map((s) => [s.lat, s.lng]);
    const all = pts.concat(geometry || []);
    let z = 15;
    if (all.length > 1) {
      for (z = 17; z > 2; z--) {
        const px = all.map((p) => worldPx(p[0], p[1], z));
        const xs = px.map((p) => p[0]);
        const ys = px.map((p) => p[1]);
        if (Math.max(...xs) - Math.min(...xs) <= W - 2 * PAD && Math.max(...ys) - Math.min(...ys) <= H - 2 * PAD) break;
      }
    }
    const px = all.map((p) => worldPx(p[0], p[1], z));
    const xs = px.map((p) => p[0]);
    const ys = px.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const ox = cx - W / 2;
    const oy = cy - H / 2;
    const toXY = (lat, lng) => { const p = worldPx(lat, lng, z); return [p[0] - ox, p[1] - oy]; };

    // Ambil tile (bila tersedia)
    let tiles = [];
    if (tile && tile.url) {
      const n = Math.pow(2, z);
      const jobs = [];
      for (let tx = Math.floor(ox / 256); tx <= Math.floor((ox + W) / 256); tx++) {
        for (let ty = Math.floor(oy / 256); ty <= Math.floor((oy + H) / 256); ty++) {
          if (ty < 0 || ty >= n) continue;
          const wx = ((tx % n) + n) % n;
          const sub = tile.subdomains ? tile.subdomains[(wx + ty) % tile.subdomains.length] : '';
          const url = tile.url.replace('{z}', z).replace('{x}', wx).replace('{y}', ty).replace('{s}', sub);
          jobs.push(loadTile(url, 9000).then((im) => ({ im, x: tx * 256 - ox, y: ty * 256 - oy })));
        }
      }
      tiles = (await Promise.all(jobs)).filter((t) => t.im);
    }

    function draw(withTiles) {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#e8eeee';
      g.fillRect(0, 0, W, H);
      if (withTiles && tiles.length) {
        tiles.forEach((t) => g.drawImage(t.im, Math.round(t.x), Math.round(t.y)));
      } else {
        // Latar sederhana bila peta dasar tidak tersedia (offline)
        g.strokeStyle = 'rgba(15,118,110,.12)';
        g.lineWidth = 1;
        for (let x = 0; x < W; x += 60) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
        for (let y = 0; y < H; y += 60) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
      }
      g.lineJoin = 'round';
      g.lineCap = 'round';
      const path = (list) => { g.beginPath(); list.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); };
      if (geometry && geometry.length > 1) {
        const line = geometry.map((p) => toXY(p[0], p[1]));
        g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 12; path(line); g.stroke();
        g.strokeStyle = '#0f766e'; g.lineWidth = 6.5; path(line); g.stroke();
      } else if (stops.length > 1) {
        const line = stops.map((s) => toXY(s.lat, s.lng));
        if (round) line.push(line[0]);
        g.setLineDash([22, 14]);
        g.strokeStyle = 'rgba(255,255,255,.95)'; g.lineWidth = 11; path(line); g.stroke();
        g.strokeStyle = '#0f766e'; g.lineWidth = 6; path(line); g.stroke();
        g.setLineDash([]);
      }
      // Penanda bernomor (titik awal berwarna oranye)
      stops.forEach((s, i) => {
        const [x, y] = toXY(s.lat, s.lng);
        g.fillStyle = 'rgba(0,0,0,.28)';
        g.beginPath(); g.arc(x + 1.5, y + 3, 19, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#fff';
        g.beginPath(); g.arc(x, y, 19, 0, Math.PI * 2); g.fill();
        g.fillStyle = i === 0 ? '#d97706' : '#0f766e';
        g.beginPath(); g.arc(x, y, 15.5, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#fff';
        g.font = 'bold ' + (i >= 99 ? 14 : 19) + 'px Helvetica, Arial, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(String(i + 1), x, y + 1);
      });
      // Atribusi
      const attr = withTiles && tiles.length ? (tile.attribution || '') : 'Peta dasar tidak tersedia (tanpa koneksi)';
      g.font = '15px Helvetica, Arial, sans-serif';
      g.textAlign = 'right';
      g.textBaseline = 'alphabetic';
      const tw = g.measureText(attr).width;
      g.fillStyle = 'rgba(255,255,255,.85)';
      g.fillRect(W - tw - 18, H - 26, tw + 18, 26);
      g.fillStyle = '#374151';
      g.fillText(attr, W - 9, H - 8);
      return c;
    }

    let canvas = draw(true);
    let url;
    try {
      url = canvas.toDataURL('image/jpeg', 0.88);
    } catch (_) { // kanvas "tainted" (tile tanpa CORS): gambar ulang tanpa tile
      tiles = [];
      canvas = draw(false);
      url = canvas.toDataURL('image/jpeg', 0.88);
    }
    return { url, ratio: H / W, hasTiles: tiles.length > 0 };
  }

  // ---------- Penyusun PDF ----------
  async function build(d) {
    const jsPDF = (root.jspdf && root.jspdf.jsPDF) || root.jsPDF;
    if (!jsPDF) throw new Error('Pustaka PDF belum dimuat');
    const progress = d.onProgress || (() => {});
    const stops = d.stops || [];
    const route = d.route && d.route.legs ? d.route : null;
    const title = T(d.title || 'Rencana');
    const generatedAt = d.generatedAt || Date.now();

    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
    doc.setProperties({
      title: 'Laporan Perjalanan - ' + title,
      subject: 'Laporan perjalanan RutePintar',
      author: 'RutePintar',
      creator: 'RutePintar',
    });
    let y = 0;

    const font = (style, size, color) => {
      doc.setFont('helvetica', style);
      doc.setFontSize(size);
      doc.setTextColor.apply(doc, color || C.text);
    };
    const fill = (c) => doc.setFillColor.apply(doc, c);
    const stroke = (c, w) => { doc.setDrawColor.apply(doc, c); doc.setLineWidth(w || 0.25); };
    const fitText = (s, w, size, style) => { // potong dengan "..." agar muat satu baris
      font(style || 'normal', size);
      let t = T(s);
      if (doc.getTextWidth(t) <= w) return t;
      while (t.length > 1 && doc.getTextWidth(t + '...') > w) t = t.slice(0, -1);
      return t + '...';
    };
    const wrap = (s, w, size, style, maxLines) => {
      font(style || 'normal', size);
      let lines = doc.splitTextToSize(TB(s), w);
      if (maxLines && lines.length > maxLines) {
        lines = lines.slice(0, maxLines);
        lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S{0,3}$/, '') + '...';
      }
      return lines;
    };

    function pinIcon(cx, cy, s, col, hole) { // ikon penanda peta sederhana
      fill(col);
      doc.circle(cx, cy - s * 0.25, s * 0.55, 'F');
      doc.triangle(cx - s * 0.46, cy - s * 0.05, cx + s * 0.46, cy - s * 0.05, cx, cy + s * 0.85, 'F');
      fill(hole);
      doc.circle(cx, cy - s * 0.25, s * 0.22, 'F');
    }

    function runningHeader() {
      fill(C.brand);
      doc.rect(0, 0, PW, 3, 'F');
      pinIcon(M + 2, 10, 3.4, C.brand, C.white);
      font('bold', 8.5, C.dark);
      doc.text('RutePintar', M + 6.5, 10.6);
      font('normal', 8, C.muted);
      doc.text(fitText(title, 110, 8), PW - M, 10.6, { align: 'right' });
      stroke(C.line, 0.3);
      doc.line(M, 14, PW - M, 14);
    }
    function newPage() {
      doc.addPage();
      runningHeader();
      y = TOP;
    }
    function ensure(h) {
      if (y + h > FOOT - 2) newPage();
    }
    function section(label) {
      ensure(16);
      fill(C.brand);
      doc.roundedRect(M, y, 1.8, 6.2, 0.9, 0.9, 'F');
      font('bold', 13, C.dark);
      doc.text(T(label), M + 4.5, y + 5);
      y += 10.5;
    }

    // ===== Halaman 1: sampul =====
    progress(0.05, 'Menyusun sampul…');
    // Pita judul
    fill(C.dark);
    doc.rect(0, 0, PW, 62, 'F');
    fill(C.brand);
    doc.rect(0, 0, PW, 56, 'F');
    fill(C.accent);
    doc.rect(0, 56, PW, 1.6, 'F');
    // Dekorasi garis rute
    stroke([255, 255, 255], 0.5);
    doc.setLineDashPattern([2, 2], 0);
    doc.lines([[10, -7], [13, 10], [11, -9], [15, 7], [10, -6]], 138, 20, [1, 1], 'S');
    doc.setLineDashPattern([], 0);
    fill(C.white);
    doc.circle(M + 6, 18, 6.2, 'F');
    pinIcon(M + 6, 18.4, 6.2, C.brand, C.white);
    font('bold', 10, C.white);
    doc.text('RutePintar', M + 15, 16.6);
    font('normal', 8.5, [204, 251, 241]);
    doc.text('Perencana rute pintar', M + 15, 21.2);
    font('bold', 8.5, [204, 251, 241]);
    doc.text('LAPORAN PERJALANAN', M, 33, { charSpace: 1.2 });
    const tl = wrap(title, CW - 10, 25, 'bold', 2);
    font('bold', 25, C.white);
    doc.text(tl, M, 43.5);
    y = 70;

    // Tanggal perjalanan
    const hasTrip = !!d.startedAt;
    const durMs = hasTrip && d.finishedAt ? d.finishedAt - d.startedAt : 0;
    let dateLine = 'Perjalanan belum dimulai';
    if (hasTrip) {
      dateLine = fmtDate(d.startedAt) + (d.finishedAt && !sameDay(d.startedAt, d.finishedAt) ? '  -  ' + fmtDate(d.finishedAt) : '');
    }
    font('bold', 12.5, C.text);
    doc.text(T(dateLine), M, y);
    font('normal', 9, C.muted);
    doc.text(
      hasTrip
        ? 'Mulai ' + fmtTime(d.startedAt) + (d.finishedAt ? '  -  Selesai ' + fmtTime(d.finishedAt) : '  -  belum selesai')
        : '-',
      M, y + 5.5
    );
    y += 12;

    // Kartu statistik
    const visited = stops.filter((s) => s.photos && s.photos.length).length;
    const nPhotos = stops.reduce((n, s) => n + (s.photos ? s.photos.length : 0), 0);
    const cards = [
      ['DURASI PERJALANAN', hasTrip && d.finishedAt ? fmtDur(durMs / 1000) : '-'],
      ['JARAK RUTE', route ? fmtDist(route.distance) : '-'],
      ['EST. WAKTU TEMPUH', route ? fmtDur(route.duration) : '-'],
      ['JENIS RUTE', d.round ? 'Pulang-pergi' : 'Satu arah'],
      ['TITIK TUJUAN', String(stops.length)],
      ['TITIK TERKUNJUNGI', visited + ' dari ' + stops.length],
      ['TOTAL FOTO', String(nPhotos)],
      ['DIBUAT', fmtDateS(generatedAt)],
    ];
    const gap = 4;
    const cw = (CW - 3 * gap) / 4;
    const ch = 19;
    cards.forEach((c, i) => {
      const x = M + (i % 4) * (cw + gap);
      const yy = y + Math.floor(i / 4) * (ch + gap);
      fill(C.card);
      stroke(C.line, 0.3);
      doc.roundedRect(x, yy, cw, ch, 2, 2, 'FD');
      fill(i < 4 ? C.brand : C.accent);
      doc.roundedRect(x, yy + 3, 1.2, ch - 6, 0.6, 0.6, 'F');
      font('bold', 6.3, C.muted);
      doc.text(c[0], x + 4, yy + 6.6, { charSpace: 0.3 });
      font('bold', 12, C.text);
      doc.text(fitText(c[1], cw - 7, 12, 'bold'), x + 4, yy + 14);
    });
    y += 2 * ch + gap + 8;

    // Peta rute
    ensure(CW * 0.52 + 20);
    section('Peta rute');
    progress(0.12, 'Menggambar peta rute…');
    let mapInfo = null;
    try {
      mapInfo = stops.length ? await renderMap(stops, route && route.geometry, d.round, d.tile) : null;
    } catch (_) { mapInfo = null; }
    if (mapInfo) {
      const mh = CW * mapInfo.ratio;
      ensure(mh + 4);
      doc.addImage(mapInfo.url, 'JPEG', M, y, CW, mh, undefined, 'FAST');
      stroke(C.line, 0.4);
      doc.roundedRect(M, y, CW, mh, 1.5, 1.5, 'S');
      y += mh + 3;
      font('italic', 7.5, C.muted);
      doc.text(
        route && route.geometry && route.geometry.length > 1
          ? 'Garis hijau = rute jalan terencana. Lingkaran oranye = titik awal.'
          : 'Garis putus-putus = urutan kunjungan (rute jalan tidak tersedia). Lingkaran oranye = titik awal.',
        M, y + 1
      );
      y += 8;
    }

    // Tabel ringkasan rute
    ensure(58); // judul + kepala tabel + beberapa baris harus muat bersama
    section('Ringkasan rute');
    const cols = { no: M + 2, name: M + 13, leg: M + 92, visit: M + 133 };
    const tableHead = () => {
      fill(C.dark);
      doc.roundedRect(M, y, CW, 7.5, 1.2, 1.2, 'F');
      font('bold', 7.6, C.white);
      doc.text('NO', cols.no, y + 5);
      doc.text('TITIK TUJUAN', cols.name, y + 5);
      doc.text('DARI TITIK SEBELUMNYA', cols.leg, y + 5);
      doc.text('WAKTU KUNJUNGAN', cols.visit, y + 5);
      y += 7.5;
    };
    ensure(42);
    tableHead();
    const visitOf = (s) => {
      const ts = (s.photos || []).map((p) => p.at).filter(Boolean);
      return ts.length ? Math.min.apply(null, ts) : null;
    };
    stops.forEach((s, i) => {
      const nm = wrap(s.name || s.label || coord(s.lat, s.lng), 74, 9, 'bold', 2);
      const addr = s.name && realAddr(s) ? fitText(realAddr(s), 74, 7.3) : '';
      const rh = Math.max(9.5, 4.4 * nm.length + (addr ? 3.6 : 0) + 3.2);
      if (y + rh > FOOT - 2) { newPage(); tableHead(); }
      if (i % 2 === 0) { fill(C.card); doc.rect(M, y, CW, rh, 'F'); }
      // nomor
      fill(i === 0 ? C.accent : C.brand);
      doc.circle(cols.no + 2.2, y + rh / 2, 3, 'F');
      font('bold', 7.5, C.white);
      doc.text(String(i + 1), cols.no + 2.2, y + rh / 2 + 1, { align: 'center' });
      // nama + alamat
      font('bold', 9, C.text);
      doc.text(nm, cols.name, y + 4.6);
      if (addr) { font('normal', 7.3, C.muted); doc.text(addr, cols.name, y + 4.6 + 4.4 * (nm.length - 1) + 3.6); }
      // ruas dari titik sebelumnya
      font('normal', 8.3, C.text);
      if (i === 0) { font('italic', 8.3, C.muted); doc.text('Titik awal', cols.leg, y + 4.8); }
      else if (route && route.legs[i - 1]) {
        doc.text(fmtDist(route.legs[i - 1].distance) + '  ·  ' + fmtDur(route.legs[i - 1].duration), cols.leg, y + 4.8);
      } else { font('normal', 8.3, C.muted); doc.text('-', cols.leg, y + 4.8); }
      // waktu kunjungan
      const v = visitOf(s);
      if (v) { font('bold', 8.3, C.ok); doc.text(T(fmtDT(v)), cols.visit, y + 4.8); }
      else { font('italic', 8.1, C.muted); doc.text('Tidak tercatat (tanpa foto)', cols.visit, y + 4.8); }
      stroke(C.line, 0.2);
      doc.line(M, y + rh, M + CW, y + rh);
      y += rh;
    });
    if (route && d.round && route.legs.length >= stops.length && stops.length > 1) {
      const last = route.legs[stops.length - 1];
      ensure(10);
      font('italic', 8.5, C.muted);
      doc.text('Kembali ke titik awal', cols.name, y + 5.6);
      font('normal', 8.3, C.text);
      doc.text(fmtDist(last.distance) + '  ·  ' + fmtDur(last.duration), cols.leg, y + 5.6);
      stroke(C.line, 0.2);
      doc.line(M, y + 9, M + CW, y + 9);
      y += 9;
    }
    if (route) {
      ensure(11);
      fill(C.soft);
      doc.roundedRect(M, y + 2, CW, 8, 1.2, 1.2, 'F');
      font('bold', 9, C.dark);
      doc.text('TOTAL', cols.name, y + 7.4);
      doc.text(fmtDist(route.distance) + '  ·  ' + fmtDur(route.duration), cols.leg, y + 7.4);
      y += 12;
    }
    // Catatan metode
    ensure(16);
    y += 2;
    font('italic', 7.6, C.muted);
    const note = doc.splitTextToSize(
      T('Catatan: rute dan estimasi waktu tempuh dihitung untuk kendaraan roda empat tanpa data lalu lintas langsung. ' +
        'Waktu kunjungan pada setiap titik dicatat dari waktu foto pertama yang diunggah pada titik tersebut.'),
      CW
    );
    doc.text(note, M, y);
    y += note.length * 3.5 + 2;

    // ===== Detail titik =====
    y += 4;
    ensure(70); // judul bagian + kartu pertama harus muat; jika tidak, pindah halaman
    section('Detail titik tujuan');
    const COLW = (CW - 5) / 2;
    const PH_H = COLW * 0.75;
    const PXW = 960;
    const PXH = 720;

    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      progress(0.2 + 0.72 * (i / Math.max(1, stops.length)), 'Memproses titik ' + (i + 1) + ' dari ' + stops.length + '…');
      const nameLines = wrap(s.name || s.label || coord(s.lat, s.lng), CW - 14 - 50, 12.5, 'bold', 2);
      const addrLines = realAddr(s) ? wrap(realAddr(s), CW - 6, 8.5, 'normal', 2) : [];
      const noteLines = s.note ? wrap(s.note, CW - 6, 9.5, 'normal', 14) : [];
      const v = visitOf(s);
      const headH = 3 + Math.max(11, nameLines.length * 5.4 + 5);
      const bodyH = 2 + addrLines.length * 3.8 + 5 + (noteLines.length ? 5 + noteLines.length * 4.3 : 5 + 4.3) + 3;
      const firstPhotoH = s.photos && s.photos.length ? PH_H + 8 : 0;
      ensure(headH + bodyH + Math.min(firstPhotoH, 40));

      // Kartu header
      fill(C.soft);
      stroke(C.line, 0.3);
      doc.roundedRect(M, y, CW, headH, 2, 2, 'FD');
      fill(i === 0 ? C.accent : C.brand);
      doc.circle(M + 7, y + headH / 2, 4.4, 'F');
      font('bold', 10, C.white);
      doc.text(String(i + 1), M + 7, y + headH / 2 + 1.4, { align: 'center' });
      font('bold', 12.5, C.text);
      doc.text(nameLines, M + 14, y + headH / 2 - (nameLines.length - 1) * 2.7 + 1.6);
      // lencana kunjungan
      const badge = v ? 'Dikunjungi ' + fmtDT(v) : 'Belum ada catatan kunjungan';
      font('bold', 7.6);
      const bw = doc.getTextWidth(T(badge)) + 7;
      fill(v ? C.okBg : [241, 245, 249]);
      doc.roundedRect(M + CW - bw - 3, y + headH / 2 - 3.6, bw, 7.2, 3.6, 3.6, 'F');
      font('bold', 7.6, v ? C.ok : C.muted);
      doc.text(T(badge), M + CW - bw / 2 - 3, y + headH / 2 + 1.1, { align: 'center' });
      y += headH + 3;

      // Alamat & koordinat
      if (addrLines.length) { font('normal', 8.5, C.muted); doc.text(addrLines, M + 3, y + 3); y += addrLines.length * 3.8 + 1; }
      font('normal', 8, C.muted);
      const ctext = 'Koordinat: ' + coord(s.lat, s.lng) + '   ';
      doc.text(ctext, M + 3, y + 3.6);
      const lx = M + 3 + doc.getTextWidth(ctext);
      font('bold', 8, C.brand);
      doc.text('Buka di Google Maps', lx, y + 3.6);
      doc.link(lx, y, doc.getTextWidth('Buka di Google Maps'), 4.6, { url: 'https://www.google.com/maps?q=' + s.lat.toFixed(6) + ',' + s.lng.toFixed(6) });
      y += 7;

      // Keterangan
      font('bold', 7, C.muted);
      doc.text('KETERANGAN', M + 3, y + 1.8, { charSpace: 0.3 });
      y += 4.6;
      if (noteLines.length) { font('normal', 9.5, C.text); doc.text(noteLines, M + 3, y + 2.6); y += noteLines.length * 4.3; }
      else { font('italic', 9, C.muted); doc.text('Tidak ada keterangan.', M + 3, y + 2.6); y += 4.3; }
      y += 3;

      // Foto (2 kolom) dengan keterangan waktu
      const photos = s.photos || [];
      if (photos.length) {
        font('bold', 7, C.muted);
        ensure(PH_H + 14);
        doc.text('FOTO (' + photos.length + ')', M + 3, y + 1.8, { charSpace: 0.3 });
        y += 4;
        for (let k = 0; k < photos.length; k += 2) {
          ensure(PH_H + 8);
          for (let j = 0; j < 2 && k + j < photos.length; j++) {
            const p = photos[k + j];
            const x = M + j * (COLW + 5);
            try {
              const url = await coverJpeg(p.blob, PXW, PXH, 0.74);
              doc.addImage(url, 'JPEG', x, y, COLW, PH_H, undefined, 'FAST');
              stroke(C.line, 0.3);
              doc.rect(x, y, COLW, PH_H, 'S');
            } catch (_) {
              fill(C.card);
              doc.rect(x, y, COLW, PH_H, 'F');
              font('italic', 8, C.muted);
              doc.text('Foto tidak dapat dimuat', x + COLW / 2, y + PH_H / 2, { align: 'center' });
            }
            font('normal', 7.6, C.muted);
            doc.text(T('Foto ' + (k + j + 1) + (p.at ? '  ·  ' + fmtDT(p.at) : '')), x, y + PH_H + 4.2);
          }
          y += PH_H + 8;
        }
      }
      y += 5;
    }

    // ===== Footer semua halaman =====
    progress(0.96, 'Merapikan halaman…');
    const total = doc.getNumberOfPages();
    for (let p = 1; p <= total; p++) {
      doc.setPage(p);
      stroke(C.line, 0.3);
      doc.line(M, 288.2, PW - M, 288.2);
      font('normal', 7.5, C.muted);
      doc.text(T('RutePintar  ·  Laporan perjalanan  ·  ' + title), M, 292.6);
      doc.text('Halaman ' + p + ' dari ' + total, PW - M, 292.6, { align: 'right' });
    }
    progress(1, 'Selesai');
    return doc.output('blob');
  }

  root.RouteReport = { build };
})(typeof window !== 'undefined' ? window : this);
