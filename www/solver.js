// Solver pengurutan tujuan (varian TSP) berdasarkan matriks durasi.
// Titik 0 selalu menjadi titik awal. roundtrip=true berarti kembali ke titik awal.
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

  function nearestNeighbor(M) {
    const n = M.length;
    const used = new Array(n).fill(false);
    const order = [0];
    used[0] = true;
    for (let k = 1; k < n; k++) {
      const last = order[order.length - 1];
      let best = -1;
      let bestVal = Infinity;
      for (let j = 0; j < n; j++) {
        if (!used[j] && M[last][j] < bestVal) {
          bestVal = M[last][j];
          best = j;
        }
      }
      used[best] = true;
      order.push(best);
    }
    return order;
  }

  // Balik sebuah segmen (2-opt) selama masih memperbaiki biaya total.
  function twoOpt(order, M, roundtrip) {
    let best = order.slice();
    let bestCost = pathCost(best, M, roundtrip);
    let improved = false;
    for (let i = 1; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
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
  function relocate(order, M, roundtrip) {
    let best = order.slice();
    let bestCost = pathCost(best, M, roundtrip);
    let improved = false;
    for (let i = 1; i < best.length; i++) {
      for (let j = 1; j < best.length; j++) {
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

  function localSearch(order, M, roundtrip) {
    let cur = order;
    for (let guard = 0; guard < 200; guard++) {
      const a = twoOpt(cur, M, roundtrip);
      const b = relocate(a.order, M, roundtrip);
      cur = b.order;
      if (!a.improved && !b.improved) break;
    }
    return cur;
  }

  // Solusi pasti untuk jumlah titik kecil (titik 0 tetap di awal).
  function bruteForce(M, roundtrip) {
    const n = M.length;
    const rest = [];
    for (let i = 1; i < n; i++) rest.push(i);
    let bestCost = Infinity;
    let best = null;
    const cur = [0];
    const used = new Array(n).fill(false);
    (function rec(cost) {
      if (cost >= bestCost) return;
      if (cur.length === n) {
        const total = cost + (roundtrip ? M[cur[n - 1]][0] : 0);
        if (total < bestCost) {
          bestCost = total;
          best = cur.slice();
        }
        return;
      }
      for (const j of rest) {
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
  function shuffledStart(n) {
    const rest = [];
    for (let i = 1; i < n; i++) rest.push(i);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    return [0].concat(rest);
  }

  function solve(matrix, opts) {
    const roundtrip = !opts || opts.roundtrip !== false;
    const M = clean(matrix);
    const n = M.length;
    if (n <= 2) return M.map((_, i) => i);
    if (n <= 9) return bruteForce(M, roundtrip);

    let best = localSearch(nearestNeighbor(M), M, roundtrip);
    let bestCost = pathCost(best, M, roundtrip);
    const restarts = n <= 40 ? 8 : n <= 70 ? 3 : 1;
    for (let r = 0; r < restarts; r++) {
      const cand = localSearch(shuffledStart(n), M, roundtrip);
      const c = pathCost(cand, M, roundtrip);
      if (c < bestCost - 1e-9) {
        best = cand;
        bestCost = c;
      }
    }
    return best;
  }

  const api = { solve, pathCost };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RouteSolver = api;
})(typeof self !== 'undefined' ? self : this);
