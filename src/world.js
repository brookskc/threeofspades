// world.js — the voxel world: storage, chunked meshing, raycasting, editing.
import * as THREE from 'three';

export const SX = 256, SY = 64, SZ = 256;   // world dimensions in voxels
export const SEA = 20;                       // water plane height
const CHUNK = 16;                            // chunk footprint (full height columns)

// Block palette. 0 = air, everything else indexes this table.
export const PALETTE = [
  null,
  { color: 0x69a84f, name: 'grass' },
  { color: 0x7a5a38, name: 'dirt'  },
  { color: 0xc8b579, name: 'sand'  },
  { color: 0x8a8d94, name: 'stone' },
  { color: 0x4a6cd4, name: 'blue'  },
  { color: 0x4a9e4a, name: 'green' },
];
export const BLOCK = { GRASS: 1, DIRT: 2, SAND: 3, STONE: 4, BLUE: 5, GREEN: 6 };

// Classic per-face shading baked into vertex colors — crisp, flat, cheap.
// Tinted per channel: the sunlit top reads warm, the shadowed sides cool.
const FACE_TINT = [
  [0.68, 0.72, 0.79], // -x
  [0.68, 0.72, 0.79], // +x
  [0.45, 0.45, 0.47], // -y
  [1.08, 1.03, 0.90], // +y (sun)
  [0.80, 0.84, 0.91], // -z
  [0.80, 0.84, 0.91], // +z
];
// Deterministic per-voxel brightness jitter — breaks up flat walls of one
// block type without any texture. ±5%, baked like everything else.
function jitter(x, y, z) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return 0.95 + 0.1 * (s - Math.floor(s));
}
// Baked per-vertex ambient occlusion: a corner walled in by solid neighbors
// renders darker than an open one. Pure vertex color — free on the GPU.
const AO_LEVEL = [0.52, 0.69, 0.85, 1.0];
// Corner order matters: with indices (0,1,2),(2,1,3) the triangles must wind
// counter-clockwise seen from OUTSIDE, or the face is backface-culled and the
// terrain shows sky-holes when viewed along ±z.
const FACES = [
  { dir: [-1, 0, 0], corners: [[0,1,0],[0,0,0],[0,1,1],[0,0,1]] },
  { dir: [ 1, 0, 0], corners: [[1,1,1],[1,0,1],[1,1,0],[1,0,0]] },
  { dir: [ 0,-1, 0], corners: [[1,0,1],[0,0,1],[1,0,0],[0,0,0]] },
  { dir: [ 0, 1, 0], corners: [[0,1,1],[1,1,1],[0,1,0],[1,1,0]] },
  { dir: [ 0, 0,-1], corners: [[0,1,0],[1,1,0],[0,0,0],[1,0,0]] },
  { dir: [ 0, 0, 1], corners: [[1,1,1],[0,1,1],[1,0,1],[0,0,1]] },
];

const idx = (x, y, z) => (y * SZ + z) * SX + x;

// Small seeded PRNG so the cloud layout is identical on every load.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class VoxelWorld {
  constructor(scene) {
    this.data = new Uint8Array(SX * SY * SZ);
    this.group = new THREE.Group();
    this.chunks = new Map();
    this.material = new THREE.MeshBasicMaterial({ vertexColors: true });
    scene.add(this.group);

    // Water — one translucent animated sheet.
    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(SX, SZ, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0x2f6fb8, transparent: true, opacity: 0.62 })
    );
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.set(SX / 2, SEA + 0.42, SZ / 2);
    scene.add(this.water);
    this._waterBase = this.water.geometry.attributes.position.array.slice();

    // Clouds — the signature AoS sky: puffy clusters of scaled voxel boxes,
    // one shared geometry, one shared translucent material. They drift slowly
    // past the map and wrap around; ~80 boxes total, so this is free.
    this.clouds = new THREE.Group();
    const puffGeo = new THREE.BoxGeometry(1, 1, 1);
    const puffMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.82, depthWrite: false,
    });
    const rnd = mulberry32(20240);
    for (let i = 0; i < 16; i++) {
      const cl = new THREE.Group();
      const puffs = 3 + (i % 4);
      for (let p = 0; p < puffs; p++) {
        const m = new THREE.Mesh(puffGeo, puffMat);
        m.scale.set(7 + rnd() * 12, 2.2 + rnd() * 1.6, 6 + rnd() * 9);
        m.position.set((p - puffs / 2) * (5 + rnd() * 4), (rnd() - 0.5) * 1.5, (rnd() - 0.5) * 8);
        cl.add(m);
      }
      cl.position.set(rnd() * SX, 66 + rnd() * 8, rnd() * SZ); // above the menu orbit (y=58)
      cl.userData.x0 = cl.position.x + 260;      // offset so the wrap window is wide
      cl.userData.speed = 1.1 + rnd() * 1.3;     // voxels per second, leisurely
      this.clouds.add(cl);
    }
    scene.add(this.clouds);
  }

  get(x, y, z) {
    if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ) return 0;
    return this.data[idx(x, y, z)];
  }
  solid(x, y, z) { return this.get(x | 0, y | 0, z | 0) !== 0; }

  set(x, y, z, v) {
    if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ) return false;
    this.data[idx(x, y, z)] = v;
    // Queue, don't rebuild: a bot dig swing can land 20 set() calls in one
    // frame, and each used to synchronously remesh up to 5 chunks. The flush
    // at end of Game.update remeshes each dirty chunk once.
    this._markDirty(x, z);
    this.onEdit?.(x, z); // minimap: this column's pixel may have changed
    return true;
  }

  // Chunks an edit at (x,z) can visibly affect: the home chunk, the
  // orthogonal neighbor across a shared face, AND the diagonal neighbor
  // across a shared corner — baked AO probes diagonals, so skipping the
  // corner chunk leaves stale vertex colors there.
  _markDirty(x, z, d = this.dirty ?? (this.dirty = new Set())) {
    const cx = x >> 4, cz = z >> 4, xm = x & 15, zm = z & 15;
    d.add(cx + ',' + cz);
    if (xm === 0)  d.add((cx - 1) + ',' + cz);
    if (xm === 15) d.add((cx + 1) + ',' + cz);
    if (zm === 0)  d.add(cx + ',' + (cz - 1));
    if (zm === 15) d.add(cx + ',' + (cz + 1));
    if (xm === 0  && zm === 0)  d.add((cx - 1) + ',' + (cz - 1));
    if (xm === 0  && zm === 15) d.add((cx - 1) + ',' + (cz + 1));
    if (xm === 15 && zm === 0)  d.add((cx + 1) + ',' + (cz - 1));
    if (xm === 15 && zm === 15) d.add((cx + 1) + ',' + (cz + 1));
  }

  flushDirty() {
    if (!this.dirty?.size) return;
    for (const k of this.dirty) {
      const [cx, cz] = k.split(',').map(Number);
      this.buildChunk(cx, cz);
    }
    this.dirty.clear();
  }

  rebuildAt(x, z) {
    this._markDirty(x, z);
    this.flushDirty();
  }

  buildAll() {
    for (let cx = 0; cx < SX / CHUNK; cx++)
      for (let cz = 0; cz < SZ / CHUNK; cz++) this.buildChunk(cx, cz);
  }

  buildChunk(cx, cz) {
    if (cx < 0 || cz < 0 || cx >= SX / CHUNK || cz >= SZ / CHUNK) return;
    const key = cx + ',' + cz;
    const old = this.chunks.get(key);
    if (old) { this.group.remove(old); old.geometry.dispose(); this.chunks.delete(key); }

    const pos = [], col = [], ind = [];
    const c = new THREE.Color();
    const x0 = cx * CHUNK, z0 = cz * CHUNK;

    for (let y = 0; y < SY; y++)
      for (let z = z0; z < z0 + CHUNK; z++)
        for (let x = x0; x < x0 + CHUNK; x++) {
          const v = this.data[idx(x, y, z)];
          if (!v) continue;
          c.setHex(PALETTE[v].color);
          const j = jitter(x, y, z);
          const jr = c.r * j, jg = c.g * j, jb = c.b * j;
          for (let f = 0; f < 6; f++) {
            const face = FACES[f], d = face.dir;
            if (this.get(x + d[0], y + d[1], z + d[2])) continue;
            const tint = FACE_TINT[f];
            // AO probes live in the air cell touching this face, one step to
            // each side of the corner plus the diagonal.
            const n = [x + d[0], y + d[1], z + d[2]];
            const t0 = d[0] === 0 ? 0 : 1, t1 = d[2] === 0 ? 2 : 1; // tangent axes
            const ao = [];
            const base = pos.length / 3;
            for (const [ox, oy, oz] of face.corners) {
              pos.push(x + ox, y + oy, z + oz);
              const o = [ox, oy, oz];
              const s0 = o[t0] ? 1 : -1, s1 = o[t1] ? 1 : -1;
              const p = [n[0], n[1], n[2]];
              p[t0] += s0;
              const side0 = this.get(p[0], p[1], p[2]) ? 1 : 0;
              p[t0] -= s0; p[t1] += s1;
              const side1 = this.get(p[0], p[1], p[2]) ? 1 : 0;
              p[t0] += s0;
              const corn = this.get(p[0], p[1], p[2]) ? 1 : 0;
              const a = side0 && side1 ? 0 : 3 - (side0 + side1 + corn);
              ao.push(a);
              const b = AO_LEVEL[a];
              col.push(jr * tint[0] * b, jg * tint[1] * b, jb * tint[2] * b);
            }
            // Flip the quad diagonal toward the brighter corners — otherwise
            // the interpolation seam shows through the gradient.
            if (ao[0] + ao[3] > ao[1] + ao[2])
              ind.push(base, base + 1, base + 3, base, base + 3, base + 2);
            else
              ind.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
          }
        }

    if (!ind.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(ind);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.matrixAutoUpdate = false;
    this.chunks.set(key, mesh);
    this.group.add(mesh);
  }

  // Amanatides & Woo grid traversal. Returns { x, y, z, nx, ny, nz } of the
  // first solid voxel hit plus the entry-face normal, or null.
  raycast(origin, dir, maxDist) {
    let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
    const stepX = Math.sign(dir.x), stepY = Math.sign(dir.y), stepZ = Math.sign(dir.z);
    const tDeltaX = stepX !== 0 ? Math.abs(1 / dir.x) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(1 / dir.y) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dir.z) : Infinity;
    const fx = stepX > 0 ? x + 1 - origin.x : origin.x - x;
    const fy = stepY > 0 ? y + 1 - origin.y : origin.y - y;
    const fz = stepZ > 0 ? z + 1 - origin.z : origin.z - z;
    let tMaxX = tDeltaX === Infinity ? Infinity : tDeltaX * fx;
    let tMaxY = tDeltaY === Infinity ? Infinity : tDeltaY * fy;
    let tMaxZ = tDeltaZ === Infinity ? Infinity : tDeltaZ * fz;
    let nx = 0, ny = 0, nz = 0, t = 0;

    while (t <= maxDist) {
      if (this.solid(x, y, z)) return { x, y, z, nx, ny, nz, dist: t };
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
      }
    }
    return null;
  }

  // Remove a sphere of voxels (grenades). Returns removed positions for debris.
  carve(cx, cy, cz, r) {
    // Radius is wire-influenced in two places ('b' events, edit-log replay):
    // an unbounded r is a synchronous 100k-voxel stall. One clamp, here,
    // covers every caller. Nothing in the game carves deeper than ~4.
    r = Math.min(Math.max(r || 0, 0), 6);
    const removed = [];
    const R = Math.ceil(r);
    for (let y = cy - R; y <= cy + R; y++)
      for (let z = cz - R; z <= cz + R; z++)
        for (let x = cx - R; x <= cx + R; x++) {
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy, z + 0.5 - cz);
          if (d > r || !this.get(x, y, z)) continue;
          removed.push({ x, y, z, v: this.get(x, y, z) });
          this.data[idx(x, y, z)] = 0;
        }
    // Same neighbor rule as _markDirty, corners included: an explosion
    // removing a corner voxel changes AO in the diagonal chunk too.
    const touched = new Set();
    for (const p of removed) this._markDirty(p.x, p.z, touched);
    for (const k of touched) {
      const [cx2, cz2] = k.split(',').map(Number);
      this.buildChunk(cx2, cz2);
    }
    if (this.onEdit) for (const p of removed) this.onEdit(p.x, p.z); // minimap
    return removed;
  }

  // Highest solid voxel in a column (for spawning / flag placement).
  surface(x, z) {
    for (let y = SY - 1; y >= 0; y--) if (this.solid(x, y, z)) return y;
    return 0;
  }

  // Release everything this world holds on the GPU (map rebuilds).
  dispose() {
    for (const m of this.chunks.values()) m.geometry.dispose();
    this.chunks.clear();
    this.group.removeFromParent();
    this.water.removeFromParent();
    this.water.geometry.dispose();
    this.water.material.dispose();
    this.material.dispose();
    this.clouds.removeFromParent();
    if (this.clouds.children.length) { // shared puff resources, freed once
      this.clouds.children[0].children[0].geometry.dispose();
      this.clouds.children[0].children[0].material.dispose();
    }
  }

  // Per-frame sky life: water ripples, clouds drift and wrap past the map.
  animateSky(t) {
    const attr = this.water.geometry.attributes.position;
    const base = this._waterBase;
    for (let i = 0; i < attr.count; i++) {
      const bx = base[i * 3], by = base[i * 3 + 1];
      attr.array[i * 3 + 2] = Math.sin(t * 1.3 + bx * 0.12 + by * 0.09) * 0.14;
    }
    attr.needsUpdate = true;
    for (const cl of this.clouds.children)
      cl.position.x = ((cl.userData.x0 + t * cl.userData.speed) % (SX + 520)) - 260;
  }
}
