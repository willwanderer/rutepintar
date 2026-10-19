const assert = require('assert');
const { solve, pathCost } = require('../www/solver.js');

// Titik acak di bidang datar; matriks = jarak Euclid (simetris)
function makeMatrix(n, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const pts = Array.from({ length: n }, () => [rnd() * 100, rnd() * 100]);
  return pts.map((a) => pts.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1])));
}

function isPermutation(order, n) {
  return order.length === n && new Set(order).size === n && order[0] === 0;
}

// 1. Kasus kecil: hasil harus sama dengan solusi pasti (brute force)
for (const roundtrip of [true, false]) {
  const M = makeMatrix(8, 7);
  const order = solve(M, { roundtrip });
  assert(isPermutation(order, 8), 'urutan harus permutasi sah');
  // bandingkan dengan semua permutasi
  let best = Infinity;
  (function perm(cur, rest) {
    if (!rest.length) return void (best = Math.min(best, pathCost(cur, M, roundtrip)));
    rest.forEach((x, i) => perm(cur.concat(x), rest.slice(0, i).concat(rest.slice(i + 1))));
  })([0], [1, 2, 3, 4, 5, 6, 7]);
  assert(Math.abs(pathCost(order, M, roundtrip) - best) < 1e-6, 'harus optimal untuk n kecil');
}

// 2. Kasus sedang/besar: harus permutasi sah dan lebih baik dari urutan input
for (const n of [15, 40, 100]) {
  const M = makeMatrix(n, n);
  const t0 = Date.now();
  const order = solve(M, { roundtrip: true });
  const ms = Date.now() - t0;
  assert(isPermutation(order, n), `n=${n}: permutasi tidak sah`);
  const base = pathCost([...Array(n).keys()], M, true);
  const got = pathCost(order, M, true);
  assert(got < base, `n=${n}: tidak lebih baik dari urutan awal`);
  console.log(`n=${n}: biaya ${base.toFixed(0)} -> ${got.toFixed(0)} (${ms} ms)`);
}

// 3. Nilai null di matriks tidak boleh membuat solver error
const M = makeMatrix(12, 3);
M[2][5] = null;
M[5][2] = null;
assert(isPermutation(solve(M, { roundtrip: false }), 12));

console.log('Semua tes solver lulus.');
