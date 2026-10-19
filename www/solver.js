// Solver pengurutan tujuan (varian TSP) berdasarkan matriks durasi.
//
// solve(matrix, { start, end, roundtrip })
//   start     : indeks titik awal (default 0)
//   end       : indeks titik akhir yang dikunci (default: bebas)
//   roundtrip : bila tidak ada `end`, true = kembali ke titik awal, false = berhenti di titik terakhir
// Mengembalikan urutan indeks; elemen pertama selalu `start`, dan terakhir `end` bila diberikan.
(function (root) {
  'use strict';

  const BIG = 1e7; // pengganti untuk pasangan titik yang tidak terhubung (null)

  function clean(M) {
    return M.map((row) => row.map((v) => (v == null || !isFinite(v) ? BIG : v)));
  }

  function pathCost(order, M, roundtrip) {
    let c = 0;
    for (let i = 0; i < order.length - 1; i++) c += M[order[i]][order[i + 1]];
    if (roundtrip && order.length > 1) c += M[order[order.length - 1]][order[0]];
    return c;
  }

  // fixedLast: indeks n-1 dikunci sebagai titik terakhir
  function nearestNeighbor(M, fixedLast) {
    const n = M.length;
    const limit = fixedLast ? n - 1 : n;
    const used = new Array(n).fill(false);
    const order = [0];
    used[0] = true;
    for (let k = 1; k < limit; k++) {
      const last = order[order.length - 1];
      let best = -1;
      let bestVal = Infinity;
      for (let j = 0; j < limit; j++) {
        if (!used[j] && M[last][j] < bestVal) {
          bestVal = M[last][j];
          best = j;
        }
      }
      used[best] = true;
      order.push(best);
    }
    if (fixedLast) order.push(n - 1);
    return order;
  }

  // Balik sebuah segmen (2-opt) selama masih memperbaiki biaya total.
  // Posisi pertama (dan terakhir bila fixedLast) tidak pernah disentuh.
  function twoOpt(order, M, roundtrip, fixedLast) {
    let best = order.slice();
    let bestCost = pathCost(best, M, roundtrip);
    let improved = false;
    const lastMovable = best.length - (fixedLast ? 2 : 1);
    for (let i = 1; i < lastMovable; i++) {
      for (let j = i + 1; j <= lastMovable; j++) {
        const cand = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
        const c = pathCost(cand, M, roundtrip);
        if (c < bestCost - 1e-9) {
          best = cand;
          bestCost = c;
          improved = true;
        }
      }
    }
    return { order: best, improved };
  }

  // Pindahkan satu titik ke posisi lain (Or-opt, segmen panjang 1) bila memperbaiki.
  function relocate(order, M, roundtrip, fixedLast) {
    let best = order.slice();
    let bestCost = pathCost(best, M, roundtrip);
    let improved = false;
    const lastMovable = best.length - (fixedLast ? 2 : 1);
    for (let i = 1; i <= lastMovable; i++) {
      for (let j = 1; j <= lastMovable; j++) {
        if (i === j) continue;
        const cand = best.slice();
        const [node] = cand.splice(i, 1);
        cand.splice(j, 0, node);
        const c = pathCost(cand, M, roundtrip);
        if (c < bestCost - 1e-9) {
          best = cand;
          bestCost = c;
          improved = true;
        }
      }
    }
    return { order: best, improved };
  }

  function localSearch(order, M, roundtrip, fixedLast) {
    let cur = order;
    for (let guard = 0; guard < 200; guard++) {
      const a = twoOpt(cur, M, roundtrip, fixedLast);
      const b = relocate(a.order, M, roundtrip, fixedLast);
      cur = b.order;
      if (!a.improved && !b.improved) break;
    }
    return cur;
  }

  // Solusi pasti untuk jumlah titik kecil (titik 0 tetap di awal, n-1 di akhir bila fixedLast).
  function bruteForce(M, roundtrip, fixedLast) {
    const n = M.length;
    const free = [];
    for (let i = 1; i < (fixedLast ? n - 1 : n); i++) free.push(i);
    let bestCost = Infinity;
    let best = null;
    const cur = [0];
    const used = new Array(n).fill(false);
    const target = fixedLast ? n - 1 : n; // panjang `cur` sebelum titik terakhir ditambahkan
    (function rec(cost) {
      if (cost >= bestCost) return;
      if (cur.length === target) {
        let total = cost;
        const full = cur.slice();
        if (fixedLast) {
          total += M[cur[cur.length - 1]][n - 1];
          full.push(n - 1);
        }
        if (roundtrip) total += M[full[full.length - 1]][0];
        if (total < bestCost) {
          bestCost = total;
          best = full;
        }
        return;
      }
      for (const j of free) {
        if (used[j]) continue;
        used[j] = true;
        cur.push(j);
        rec(cost + M[cur[cur.length - 2]][j]);
        cur.pop();
        used[j] = false;
      }
    })(0);
    return best;
  }

  // Titik awal acak untuk pencarian lokal (agar tidak terjebak minimum lokal).
  function shuffledStart(n, fixedLast) {
    const rest = [];
    for (let i = 1; i < (fixedLast ? n - 1 : n); i++) rest.push(i);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    return [0].concat(rest, fixedLast ? [n - 1] : []);
  }

  // Inti: titik 0 = awal. fixedLast: titik n-1 = akhir.
  function core(M, roundtrip, fixedLast) {
    const n = M.length;
    if (n <= 2) return M.map((_, i) => i);
    if (n <= 9) return bruteForce(M, roundtrip, fixedLast);

    let best = localSearch(nearestNeighbor(M, fixedLast), M, roundtrip, fixedLast);
    let bestCost = pathCost(best, M, roundtrip);
    const restarts = n <= 40 ? 8 : n <= 70 ? 3 : 1;
    for (let r = 0; r < restarts; r++) {
      const cand = localSearch(shuffledStart(n, fixedLast), M, roundtrip, fixedLast);
      const c = pathCost(cand, M, roundtrip);
      if (c < bestCost - 1e-9) {
        best = cand;
        bestCost = c;
      }
    }
    return best;
  }

  function solve(matrix, opts) {
    opts = opts || {};
    const M0 = clean(matrix);
    const n = M0.length;
    const start = opts.start == null ? 0 : opts.start;
    const end = opts.end == null || opts.end === start ? null : opts.end;
    const roundtrip = opts.roundtrip !== false;

    // Susun ulang indeks: awal di depan, akhir (bila ada) di belakang.
    const ids = [start];
    for (let i = 0; i < n; i++) if (i !== start && i !== end) ids.push(i);
    if (end != null) ids.push(end);
    const M = ids.map((a) => ids.map((b) => M0[a][b]));

    // Jalur terbuka dengan akhir terkunci: tambahkan sisi "akhir -> awal" berbiaya 0 dan
    // larang sisi lain keluar dari akhir / masuk ke awal, lalu selesaikan sebagai tur tertutup.
    const fixedLast = end != null && n > 1;
    if (fixedLast) {
      const m = n - 1;
      for (let x = 1; x < m; x++) M[x][0] = BIG * 10;
      for (let x = 1; x < m; x++) M[m][x] = BIG * 10;
      M[m][0] = 0;
    }

    let order = core(M, fixedLast ? true : roundtrip, fixedLast);
    if (fixedLast && order[order.length - 1] !== n - 1) {
      order = order.filter((x) => x !== n - 1).concat(n - 1);
    }
    return order.map((i) => ids[i]);
  }

  const api = { solve, pathCost };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RouteSolver = api;
})(typeof self !== 'undefined' ? self : this);
