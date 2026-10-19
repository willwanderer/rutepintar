const assert = require('assert');
const { solve, pathCost } = require('../www/solver.js');

// Titik acak di bidang datar; matriks = jarak Euclid (simetris)
function makeMatrix(n, seed) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const pts = Array.from({ length: n }, () => [rnd() * 100, rnd() * 100]);
  return pts.map((a) => pts.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1])));
}

function isPerm(order, n) {
  return order.length === n && new Set(order).size === n;
}

// Biaya terbaik dengan menjajal semua permutasi (referensi)
function bruteBest(M, start, end, roundtrip) {
  const n = M.length;
  const free = [];
  for (let i = 0; i < n; i++) if (i !== start && i !== end) free.push(i);
  let best = Infinity;
  (function perm(cur, rest) {
    if (!rest.length) {
      const full = end == null ? cur : cur.concat(end);
      return void (best = Math.min(best, pathCost(full, M, end == null && roundtrip)));
    }
    rest.forEach((x, i) => perm(cur.concat(x), rest.slice(0, i).concat(rest.slice(i + 1))));
  })([start], free);
  return best;
}

// 1. Kasus kecil: harus optimal untuk semua kombinasi awal/akhir
const M8 = makeMatrix(8, 7);
const cases = [
  { start: 0, end: null, roundtrip: true },
  { start: 0, end: null, roundtrip: false },
  { start: 3, end: null, roundtrip: false },
  { start: 3, end: null, roundtrip: true },
  { start: 0, end: 5, roundtrip: false },
  { start: 4, end: 1, roundtrip: false },
  { start: 6, end: 2, roundtrip: true }, // end menang atas roundtrip
];
for (const c of cases) {
  const order = solve(M8, c);
  assert(isPerm(order, 8), 'permutasi sah ' + JSON.stringify(c));
  assert.strictEqual(order[0], c.start, 'awal sesuai ' + JSON.stringify(c));
  if (c.end != null) assert.strictEqual(order[7], c.end, 'akhir sesuai ' + JSON.stringify(c));
  const rt = c.end == null && c.roundtrip;
  const got = pathCost(order, M8, rt);
  const ref = bruteBest(M8, c.start, c.end, c.roundtrip);
  assert(Math.abs(got - ref) < 1e-6, `optimal ${JSON.stringify(c)}: ${got} vs ${ref}`);
}

// 2. Kasus sedang/besar: awal/akhir terkunci dan lebih baik dari urutan input
for (const n of [15, 40, 100]) {
  const M = makeMatrix(n, n);
  for (const c of [
    { start: 0, end: null, roundtrip: true },
    { start: 2, end: null, roundtrip: false },
    { start: 1, end: n - 2, roundtrip: false },
  ]) {
    const t0 = Date.now();
    const order = solve(M, c);
    const ms = Date.now() - t0;
    assert(isPerm(order, n), `n=${n}: permutasi tidak sah`);
    assert.strictEqual(order[0], c.start);
    if (c.end != null) assert.strictEqual(order[n - 1], c.end);
    const rt = c.end == null && c.roundtrip;
    // pembanding: urutan indeks dengan awal/akhir dipindah ke posisi yang benar
    const naive = [c.start];
    for (let i = 0; i < n; i++) if (i !== c.start && i !== c.end) naive.push(i);
    if (c.end != null) naive.push(c.end);
    const base = pathCost(naive, M, rt);
    const got = pathCost(order, M, rt);
    assert(got < base, `n=${n}: tidak lebih baik dari urutan awal`);
    console.log(`n=${n} ${JSON.stringify(c)}: ${base.toFixed(0)} -> ${got.toFixed(0)} (${ms} ms)`);
  }
}

// 3. Nilai null di matriks tidak boleh membuat solver error
const M = makeMatrix(12, 3);
M[2][5] = null;
M[5][2] = null;
assert(isPerm(solve(M, { roundtrip: false }), 12));
assert(isPerm(solve(M, { start: 1, end: 7 }), 12));

// 4. Dua titik
assert.deepStrictEqual(solve(makeMatrix(2, 1), { start: 1 }), [1, 0]);

console.log('Semua tes solver lulus.');
