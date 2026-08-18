// tests/suite.mjs — assertions over the modules that do not touch the DOM:
// world.js (storage, meshing, raycast, carve), mapgen.js, entities.js (Body).
//
// game.js / player.js / main.js are NOT covered: game.js reads
// `location.search` at module scope, so importing it outside a browser throws.
// See the audit notes on making the snapshot row codecs testable.
import * as THREE from 'three';
import crypto from 'node:crypto';
import { VoxelWorld, SX, SY, SZ, SEA, PALETTE, BLOCK } from '../src/world.js';
import { generateMap, MAPS, BASE, mapsForMode } from '../src/mapgen.js';
import { Body } from '../src/entities.js';
import { mergeSnapshot, qx, qy, qa } from '../src/game.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  <- ' + extra : ''}`); }
};
const note = s => console.log(`        ${s}`);
const group = s => console.log(`\n== ${s} ==`);
const scene = () => new THREE.Scene();
const dataHash = w => crypto.createHash('sha1')
  .update(Buffer.from(w.data.buffer, w.data.byteOffset, w.data.byteLength))
  .digest('hex').slice(0, 12);
const colorHash = m => m
  ? crypto.createHash('sha1')
      .update(Buffer.from(Float32Array.from(m.geometry.attributes.color.array).buffer))
      .digest('hex').slice(0, 8)
  : 'MISSING';
const meshHash = w => [...w.chunks.keys()].sort()
  .map(k => k + ':' + colorHash(w.chunks.get(k))).join('|');
const lcg = seed => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// ---------------------------------------------------------------------------
function mapgenTests() {
  group('mapgen: determinism, bounds, spawn sanity');
  const hashes = [];
  for (let m = 0; m < MAPS.length; m++) {
    const name = MAPS[m].name;
    const a = new VoxelWorld(scene());
    generateMap(a, 12345, m);
    const baseA = JSON.stringify(BASE);
    const b = new VoxelWorld(scene());
    generateMap(b, 12345, m);
    ok(`${name}: seed 12345 is reproducible`, dataHash(a) === dataHash(b));
    ok(`${name}: BASE anchoring is reproducible`, baseA === JSON.stringify(BASE));
    const c = new VoxelWorld(scene());
    generateMap(c, 999, m);
    ok(`${name}: a different seed gives different terrain`, dataHash(c) !== dataHash(a));
    generateMap(a, 12345, m); // restore BASE for this map before reading it
    hashes.push(dataHash(a));

    for (const team of ['green', 'blue']) {
      const f = BASE[team].flag;
      ok(`${name}: ${team} stand inside the world`,
        !!f && f.x > 1 && f.x < SX - 2 && f.z > 1 && f.z < SZ - 2 && f.y > 0 && f.y < SY - 1,
        JSON.stringify(f));
      ok(`${name}: ${team} stand above the waterline`, f.y >= SEA, `y=${f.y}`);
      ok(`${name}: ${team} stand has headroom`, a.get(f.x, f.y + 1, f.z) === 0);
    }
    if (MAPS[m].hill) {
      const h = MAPS[m].hill;
      ok(`${name}: hill centre is on dry land`, a.surface(h.x, h.z) >= SEA,
        `surface=${a.surface(h.x, h.z)}`);
    }
    let bad = 0;
    for (let i = 0; i < a.data.length; i++) if (a.data[i] >= PALETTE.length) bad++;
    ok(`${name}: every voxel indexes PALETTE`, bad === 0, `${bad} out of range`);
  }
  ok('all six maps are distinct', new Set(hashes).size === MAPS.length);
  ok('mapsForMode(ctf) = [0,1,2]', JSON.stringify(mapsForMode('ctf')) === '[0,1,2]');
  ok('mapsForMode(koth) = [3,4,5]', JSON.stringify(mapsForMode('koth')) === '[3,4,5]');
  ok('mapsForMode(tdm) covers every map',
    mapsForMode('tdm').length === MAPS.length, JSON.stringify(mapsForMode('tdm')));
}

// ---------------------------------------------------------------------------
function raycastTests() {
  group('world.raycast: DDA against a fine-step reference');
  const w = new VoxelWorld(scene());
  generateMap(w, 4242, 2); // PINEFALL: canopy, creek, overhangs
  // Reference march. The step has to be fine enough not to skip a grazing
  // corner: 0.002 produced four false mismatches against a correct DDA.
  const reference = (o, d, maxD, step = 0.0002) => {
    let last = null;
    for (let t = 0; t <= maxD; t += step) {
      const x = Math.floor(o.x + d.x * t), y = Math.floor(o.y + d.y * t), z = Math.floor(o.z + d.z * t);
      const key = x + ',' + y + ',' + z;
      if (key === last) continue;
      last = key;
      if (w.solid(x, y, z)) return { x, y, z, t };
    }
    return null;
  };
  const rnd = lcg(7);
  let checked = 0, mismatch = 0, maxDistErr = 0;
  for (let i = 0; i < 1200; i++) {
    const o = new THREE.Vector3(20 + rnd() * 216, 18 + rnd() * 30, 20 + rnd() * 216);
    if (w.solid(o.x, o.y, o.z)) continue;
    const d = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
    if (d.lengthSq() < 1e-6) continue;
    d.normalize();
    checked++;
    const got = w.raycast(o, d, 60), want = reference(o, d, 60);
    if (!got !== !want || (got && want && (got.x !== want.x || got.y !== want.y || got.z !== want.z))) {
      mismatch++;
      if (mismatch <= 3) note(`mismatch o=${o.toArray()} d=${d.toArray()}`);
      continue;
    }
    if (got) maxDistErr = Math.max(maxDistErr, Math.abs(got.dist - want.t));
  }
  ok(`DDA agrees with the reference on ${checked} random rays`, mismatch === 0, `${mismatch} bad`);
  note(`max |dist - reference t| = ${maxDistErr.toFixed(5)}`);

  const flat = new VoxelWorld(scene());
  for (let x = 0; x < SX; x++) for (let z = 0; z < SZ; z++) flat.data[(10 * SZ + z) * SX + x] = BLOCK.STONE;
  flat.data[(20 * SZ + 100) * SX + 100] = BLOCK.STONE;
  const down = flat.raycast(new THREE.Vector3(50.5, 30, 50.5), new THREE.Vector3(0, -1, 0), 50);
  ok('straight down finds the floor with a +y normal', !!down && down.y === 10 && down.ny === 1, JSON.stringify(down));
  const level = flat.raycast(new THREE.Vector3(90.5, 20.5, 100.5), new THREE.Vector3(1, 0, 0), 50);
  ok('a level ray finds the pillar with a -x normal', !!level && level.x === 100 && level.nx === -1, JSON.stringify(level));
  ok('maxDist is honoured', flat.raycast(new THREE.Vector3(50.5, 30, 50.5), new THREE.Vector3(0, -1, 0), 5) === null);

  const inside = flat.raycast(new THREE.Vector3(100.5, 20.5, 100.5), new THREE.Vector3(1, 0, 0), 10);
  ok('an origin inside a solid returns dist 0 and a zero normal', !!inside && inside.dist === 0
    && inside.nx === 0 && inside.ny === 0 && inside.nz === 0, JSON.stringify(inside));
  note('playerPlace adds that zero normal to the hit cell, so it targets the occupied cell and silently fails');

  ok('maxDist is measured in |dir| units, not blocks (callers must normalise)',
    flat.raycast(new THREE.Vector3(50.5, 30, 50.5), new THREE.Vector3(0, -0.5, 0), 20) === null);
}

// ---------------------------------------------------------------------------
function meshingTests() {
  group('meshing: incremental edits vs a from-scratch buildAll');
  const slab = () => {
    const w = new VoxelWorld(scene());
    for (let x = 60; x < 120; x++) for (let z = 60; z < 120; z++)
      for (let y = 20; y <= 24; y++) w.data[(y * SZ + z) * SX + x] = BLOCK.STONE;
    w.buildAll();
    return w;
  };
  const parity = (label, edits) => {
    const inc = slab();
    for (const [x, y, z, v] of edits) inc.set(x, y, z, v);
    inc.flushDirty();
    const full = slab();
    for (const [x, y, z, v] of edits) full.data[(y * SZ + z) * SX + x] = v;
    full.buildAll();
    ok(label, meshHash(inc) === meshHash(full));
  };
  // 16-voxel chunks: (96,96) is the corner of chunk 6,6; chunk 5,5 is its
  // diagonal neighbour, and baked AO reads diagonally across that corner.
  parity('edit in the middle of a chunk', [[103, 25, 103, BLOCK.BLUE]]);
  parity('edit on an x seam only', [[96, 25, 103, BLOCK.BLUE]]);
  parity('edit on a z seam only', [[103, 25, 96, BLOCK.BLUE]]);
  parity('edit on a chunk CORNER (x and z seam)  [known failure]', [[96, 25, 96, BLOCK.BLUE]]);
  parity('edit on the opposite corner cell        [known failure]', [[95, 25, 95, BLOCK.BLUE]]);
  note('rebuildAt/carve dirty only the 4 orthogonal neighbours; AO probes read the diagonal');

  group('meshing: chunk lifecycle');
  const w = slab();
  const before = w.chunks.size;
  for (let x = 96; x < 112; x++) for (let z = 96; z < 112; z++)
    for (let y = 20; y <= 24; y++) w.set(x, y, z, 0);
  w.flushDirty();
  ok('a fully emptied chunk drops its mesh', w.chunks.size === before - 1,
    `${before} -> ${w.chunks.size}`);
  w.set(100, 22, 100, BLOCK.BLUE);
  w.flushDirty();
  ok('and comes back when refilled', w.chunks.size === before);
}

// ---------------------------------------------------------------------------
function hostileInputTests() {
  group('malformed input reaching world.set / world.carve');
  const w = new VoxelWorld(scene());
  generateMap(w, 1, 0);
  let threw = null;
  try { w.set(100, 25, 100, PALETTE.length); } catch (e) { threw = e; }
  ok('set() rejects an out-of-palette value without throwing',
    threw === null, String(threw).slice(0, 70));
  note("_clientEvent case 'edit' passes d.v straight from the wire, so one bad byte kills the render loop");

  const w2 = new VoxelWorld(scene());
  generateMap(w2, 1, 0);
  const h = dataHash(w2);
  w2.set(NaN, NaN, NaN, BLOCK.BLUE);
  ok('set() with NaN coordinates is rejected by the bounds check', dataHash(w2) === h);

  const w3 = new VoxelWorld(scene());
  generateMap(w3, 1, 0);
  let carveThrew = null, removed = null;
  try { removed = w3.carve(100, 25, 100, NaN); } catch (e) { carveThrew = e; }
  ok('carve() with a NaN radius is a no-op rather than a throw', !carveThrew && removed?.length === 0);

  const w4 = new VoxelWorld(scene());
  generateMap(w4, 1, 0);
  const t0 = Date.now();
  const big = w4.carve(128, 30, 128, 40);
  const ms = Date.now() - t0;
  ok('carve() clamps an oversized radius', big.length < 5000, `${big.length} voxels`);
  note(`carve(r=40) removed ${big.length} voxels in ${ms}ms; the wire format lets a host send any r`);
}

// ---------------------------------------------------------------------------
function bodyTests() {
  group('Body: gravity, collision, ledge guard');
  const floorAt = y0 => {
    const w = new VoxelWorld(scene());
    for (let x = 0; x < SX; x++) for (let z = 0; z < SZ; z++) w.data[(y0 * SZ + z) * SX + x] = BLOCK.STONE;
    return w;
  };
  const drop = (w, fromY, dt, steps) => {
    const b = new Body(w, 50.5, fromY, 50.5);
    for (let i = 0; i < steps; i++) b.move(dt);
    return b;
  };
  const w = floorAt(30);
  ok('lands on top of the floor at 60fps', Math.abs(drop(w, 45, 1 / 60, 200).pos.y - 31) < 1e-6);
  ok('no tunnelling at the main loop dt cap (0.05s)', Math.abs(drop(w, 60, 0.05, 200).pos.y - 31) < 1e-6);
  ok('onGround is set once resting', drop(w, 45, 1 / 60, 200).onGround);

  const ceiling = new VoxelWorld(scene());
  for (let x = 40; x < 60; x++) for (let z = 40; z < 60; z++) {
    ceiling.data[(30 * SZ + z) * SX + x] = BLOCK.STONE;
    ceiling.data[(34 * SZ + z) * SX + x] = BLOCK.STONE;
  }
  const b2 = new Body(ceiling, 50.5, 31, 50.5);
  b2.half.h = 1.15;
  for (let i = 0; i < 30; i++) b2.move(1 / 60);
  b2.half.h = 1.75;
  for (let i = 0; i < 30; i++) b2.move(1 / 60);
  ok('standing up under a 3-block ceiling does not wedge', b2.pos.y >= 31 - 1e-6 && b2.pos.y < 32, `y=${b2.pos.y}`);

  const cliff = new VoxelWorld(scene());
  for (let x = 0; x < 50; x++) for (let z = 0; z < SZ; z++) cliff.data[(30 * SZ + z) * SX + x] = BLOCK.STONE;
  const walkEast = guard => {
    const b = new Body(cliff, 48.5, 31, 50.5);
    b.guard = guard;
    for (let i = 0; i < 120; i++) { b.vel.x = 5; b.move(1 / 60); }
    return b.pos.x;
  };
  const guarded = walkEast(true);
  ok('the crouch guard stops at the rim', guarded < 50.6, `x=${guarded}`);
  ok('without the guard you walk off the cliff', walkEast(false) > 50);
  note(`guarded body parks at x=${guarded.toFixed(2)}; the last solid column ends at 50, so the centre `
    + 'overhangs by ~0.25 (the guard only requires SOME of the footprint to have footing)');

  const step = new VoxelWorld(scene());
  for (let x = 0; x < SX; x++) for (let z = 0; z < SZ; z++) {
    step.data[(30 * SZ + z) * SX + x] = BLOCK.STONE;
    if (x >= 50) step.data[(29 * SZ + z) * SX + x] = BLOCK.STONE;
  }
  const b4 = new Body(step, 48.5, 31, 50.5);
  b4.guard = true;
  for (let i = 0; i < 180; i++) { b4.vel.x = 5; b4.move(1 / 60); }
  ok('a guarded body still takes a one-block step down', b4.pos.x > 50, `x=${b4.pos.x}`);

  const voidWorld = new VoxelWorld(scene());
  const b5 = new Body(voidWorld, 50.5, 5, 50.5);
  for (let i = 0; i < 300; i++) b5.move(1 / 60);
  ok('a void fall is caught by the safety net', b5.pos.y > -8, `y=${b5.pos.y}`);
  note(`the faller ends up oscillating near y=${b5.pos.y.toFixed(2)} forever (SEA=${SEA}); `
    + 'nothing kills or respawns a body that falls out of the world');

  ok('surface() of an empty column reads as ground at y=0', voidWorld.surface(10, 10) === 0);
}

// ---------------------------------------------------------------------------
function timings() {
  group('timings (node, no GPU upload — treat as relative, not absolute)');
  const w = new VoxelWorld(scene());
  let t = Date.now();
  generateMap(w, 5, 0);
  note(`generateMap + buildAll (256 chunks): ${Date.now() - t}ms`);
  t = Date.now();
  for (let i = 0; i < 100; i++) w.set(100 + (i % 7), 25, 100, i % 2 ? 0 : BLOCK.BLUE);
  note(`set() mid-chunk: ${((Date.now() - t) / 100).toFixed(2)}ms per single-voxel edit`);
  t = Date.now();
  for (let i = 0; i < 50; i++) w.set(96, 25, 100 + (i % 3), i % 2 ? 0 : BLOCK.BLUE);
  note(`set() on a chunk seam: ${((Date.now() - t) / 50).toFixed(2)}ms per edit (rebuilds 2 chunks)`);
  t = Date.now();
  w.set(130, 25, 130, 0); w.set(130, 26, 130, 0); w.set(130, 27, 130, 0); w.set(131, 26, 131, 0); w.flushDirty();
  note(`one bot uphill dig swing (4 x set()): ${Date.now() - t}ms`);
  t = Date.now();
  w.carve(120, 26, 120, 2.4);
  note(`one grenade carve(r=2.4), batched dirty set: ${Date.now() - t}ms`);
}

// ---------------------------------------------------------------------------
// Grounding check for structural collapse, isolated from Game (which needs a
// DOM). Mirrors _collapseFrom's BFS so the shipped algorithm can be fuzzed
// against a straightforward per-component reference.
const DIRS6 = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
const ckey = (x, y, z) => x + ',' + y + ',' + z;
function seedsFor(solid, holes) {
  const seeded = new Set(), seeds = [];
  for (const h of holes) for (const d of DIRS6) {
    const x = h.x + d[0], y = h.y + d[1], z = h.z + d[2], k = ckey(x, y, z);
    if (!seeded.has(k) && solid(x, y, z)) { seeded.add(k); seeds.push({ x, y, z }); }
  }
  return seeds;
}
// The shipped algorithm: verdict map, early exit on reaching bedrock.
function collapseShipped(solid, holes, CAP = 4000) {
  const verdict = new Map(), doomed = new Set();
  for (const s of seedsFor(solid, holes)) {
    const sk = ckey(s.x, s.y, s.z);
    if (verdict.has(sk)) continue;
    const comp = new Set([sk]), q = [s];
    let grounded = false, settled = false;
    for (let i = 0; i < q.length && !settled; i++) {
      const c = q[i];
      if (c.y === 0 || comp.size > CAP) { grounded = true; break; }
      for (const d of DIRS6) {
        const x = c.x + d[0], y = c.y + d[1], z = c.z + d[2], k = ckey(x, y, z);
        if (comp.has(k) || !solid(x, y, z)) continue;
        const known = verdict.get(k);
        if (known !== undefined) { grounded = known; settled = true; break; }
        comp.add(k); q.push({ x, y, z });
      }
    }
    for (const k of comp) verdict.set(k, grounded);
    if (!grounded) for (const k of comp) doomed.add(k);
  }
  return doomed;
}
// Reference: flood each component to completion with its own visited set.
function collapseReference(solid, holes, CAP = 4000) {
  const doomed = new Set(), resolved = new Map();
  for (const s of seedsFor(solid, holes)) {
    const sk = ckey(s.x, s.y, s.z);
    if (resolved.has(sk)) continue;
    const comp = new Set([sk]), q = [s];
    let grounded = false;
    for (let i = 0; i < q.length; i++) {
      const c = q[i];
      if (c.y === 0) grounded = true;
      if (comp.size > CAP) { grounded = true; break; }
      for (const d of DIRS6) {
        const x = c.x + d[0], y = c.y + d[1], z = c.z + d[2], k = ckey(x, y, z);
        if (comp.has(k) || !solid(x, y, z)) continue;
        comp.add(k); q.push({ x, y, z });
      }
    }
    for (const k of comp) resolved.set(k, grounded);
    if (!grounded) for (const k of comp) doomed.add(k);
  }
  return doomed;
}

function collapseTests() {
  group('structural collapse: grounding');
  const rnd = lcg(12345);
  const N = 14, H = 10;
  let checked = 0, disagreements = 0, extraN = 0, missN = 0;
  for (let trial = 0; trial < 3000; trial++) {
    const cells = new Set();
    for (let x = 0; x < N; x++) for (let z = 0; z < N; z++) if (rnd() < 0.5) cells.add(ckey(x, 0, z));
    const n = 8 + Math.floor(rnd() * 60);
    for (let i = 0; i < n; i++) {
      const x = Math.floor(rnd() * N), z = Math.floor(rnd() * N), y = 1 + Math.floor(rnd() * (H - 1));
      cells.add(ckey(x, y, z));
      if (rnd() < 0.6) for (let yy = 1; yy < y; yy++) cells.add(ckey(x, yy, z));
    }
    const solid = (x, y, z) => cells.has(ckey(x, y, z));
    const list = [...cells].map(k => k.split(',').map(Number)).filter(c => c[1] > 0);
    if (!list.length) continue;
    const h = list[Math.floor(rnd() * list.length)];
    cells.delete(ckey(h[0], h[1], h[2]));
    checked++;
    const got = collapseShipped(solid, [{ x: h[0], y: h[1], z: h[2] }]);
    const want = collapseReference(solid, [{ x: h[0], y: h[1], z: h[2] }]);
    const extra = [...got].filter(k => !want.has(k)).length;
    const miss = [...want].filter(k => !got.has(k)).length;
    if (extra || miss) { disagreements++; extraN += extra; missN += miss; }
  }
  ok(`grounding matches the reference on ${checked} random structures`,
    disagreements === 0, `${disagreements} bad (extra ${extraN}, missing ${missN})`);
  note('the shared-visited-set version failed 94/3000 here, always by collapsing supported blocks');

  // A severed L-beam must still come down: the fix must not make collapse timid.
  const cells = new Set();
  cells.add(ckey(0, 0, 0));
  for (let y = 1; y <= 3; y++) cells.add(ckey(0, y, 0));
  for (let x = 1; x <= 3; x++) cells.add(ckey(x, 3, 0));
  for (let z = 1; z <= 3; z++) cells.add(ckey(0, 3, z));
  const solid = (x, y, z) => cells.has(ckey(x, y, z));
  cells.delete(ckey(0, 3, 0));
  const doomed = collapseShipped(solid, [{ x: 0, y: 3, z: 0 }]);
  ok('a severed L-beam still collapses (6 cells)', doomed.size === 6, `${doomed.size}`);
}

// ---------------------------------------------------------------------------
function wireTests() {
  group('snapshot omission: host sent-map vs client reconstruction');
  // Model the host side of _broadcastSnapshot and the client side of
  // mergeSnapshot, and assert they stay in agreement across random churn.
  const rowsEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const rnd = lcg(4242);
  const sentP = new Map(), sentB = new Map();
  const fullP = new Map(), fullB = new Map();
  let truthP = new Map(), truthB = new Map();
  const mkP = idx => [idx, qx(rnd() * 250), qy(rnd() * 60), qx(rnd() * 250),
    qa(rnd() * 6), Math.round(rnd() * 100), 1, 0, (rnd() * 5) | 0, (rnd() * 50) | 0, 0, 3];
  const mkB = idx => [idx, qx(rnd() * 250), qy(rnd() * 60), qx(rnd() * 250),
    qa(rnd() * 6), Math.round(rnd() * 100), 1, 0, 0];
  for (let idx = 0; idx < 6; idx++) truthP.set(idx, mkP(idx));
  for (let idx = 0; idx < 7; idx++) truthB.set(idx, mkB(idx));
  let drift = 0, skipped = 0;
  for (let tick = 0; tick < 400; tick++) {
    // churn: move some, occasionally add or remove
    for (const [idx] of truthP) if (rnd() < 0.5) truthP.set(idx, mkP(idx));
    for (const [idx] of truthB) if (rnd() < 0.4) truthB.set(idx, mkB(idx));
    if (rnd() < 0.05 && truthP.size > 2) truthP.delete([...truthP.keys()][0]);
    if (rnd() < 0.05) { const i = 20 + tick; truthP.set(i, mkP(i)); }
    if (rnd() < 0.05 && truthB.size > 2) truthB.delete([...truthB.keys()][0]);

    const congested = rnd() < 0.15; // a tick the host skips for this connection
    const out = { t: 's', p: [], b: [] };
    if (!congested) {
      for (const [key, truth, sent] of [['p', truthP, sentP], ['b', truthB, sentB]]) {
        const cur = new Set();
        for (const row of truth.values()) {
          cur.add(row[0]);
          const prev = sent.get(row[0]);
          if (!prev || !rowsEq(prev, row)) { out[key].push(row); sent.set(row[0], row); }
        }
        const rm = [];
        for (const idx of sent.keys()) if (!cur.has(idx)) { rm.push(idx); sent.delete(idx); }
        if (rm.length) (out.rm ??= {})[key] = rm;
      }
      mergeSnapshot(fullP, fullB, out);
    } else skipped++;
    // after any delivered tick the reconstruction must equal the truth
    if (!congested) {
      if (fullP.size !== truthP.size || fullB.size !== truthB.size) drift++;
      else for (const [idx, row] of truthP) {
        const got = fullP.get(idx);
        if (!got || Math.abs(got[0] - row[1] / 256) > 1e-9) { drift++; break; }
      }
    }
  }
  ok('reconstruction tracks the host across 400 ticks of churn', drift === 0, `${drift} divergences`);
  note(`${skipped} ticks were skipped for backpressure and resent intact`);
  ok('a skipped tick leaves nothing stranded', fullP.size === truthP.size && fullB.size === truthB.size,
    `${fullP.size}/${truthP.size} players, ${fullB.size}/${truthB.size} bots`);
}

export async function run() {
  collapseTests();
  wireTests();
  mapgenTests();
  raycastTests();
  meshingTests();
  hostileInputTests();
  bodyTests();
  timings();
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(fail
    ? '\nThe failures marked [known failure] are the open bugs from the audit.\n'
    : '\nAll green.\n');
  return fail ? 1 : 0;
}
