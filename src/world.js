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
const FACE_SHADE = [0.72, 0.72, 0.45, 1.0, 0.84, 0.84]; // -x +x -y +y -z +z
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
  }

  get(x, y, z) {
    if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ) return 0;
    return this.data[idx(x, y, z)];
  }
  solid(x, y, z) { return this.get(x | 0, y | 0, z | 0) !== 0; }

  set(x, y, z, v) {
    if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ) return false;
    this.data[idx(x, y, z)] = v;
    this.rebuildAt(x, z);
    return true;
  }

  rebuildAt(x, z) {
    const cx = x >> 4, cz = z >> 4;
    this.buildChunk(cx, cz);
    if ((x & 15) === 0)  this.buildChunk(cx - 1, cz);
    if ((x & 15) === 15) this.buildChunk(cx + 1, cz);
    if ((z & 15) === 0)  this.buildChunk(cx, cz - 1);
    if ((z & 15) === 15) this.buildChunk(cx, cz + 1);
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
          for (let f = 0; f < 6; f++) {
            const face = FACES[f], d = face.dir;
            if (this.get(x + d[0], y + d[1], z + d[2])) continue;
            const shade = FACE_SHADE[f];
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
              const b = shade * AO_LEVEL[a];
              col.push(c.r * b, c.g * b, c.b * b);
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
    const touched = new Set();
    for (const p of removed) {
      touched.add((p.x >> 4) + ',' + (p.z >> 4));
      if ((p.x & 15) === 0)  touched.add(((p.x >> 4) - 1) + ',' + (p.z >> 4));
      if ((p.x & 15) === 15) touched.add(((p.x >> 4) + 1) + ',' + (p.z >> 4));
      if ((p.z & 15) === 0)  touched.add((p.x >> 4) + ',' + ((p.z >> 4) - 1));
      if ((p.z & 15) === 15) touched.add((p.x >> 4) + ',' + ((p.z >> 4) + 1));
    }
    for (const k of touched) {
      const [cx2, cz2] = k.split(',').map(Number);
      this.buildChunk(cx2, cz2);
    }
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
  }

  animateWater(t) {
    const attr = this.water.geometry.attributes.position;
    const base = this._waterBase;
    for (let i = 0; i < attr.count; i++) {
      const bx = base[i * 3], by = base[i * 3 + 1];
      attr.array[i * 3 + 2] = Math.sin(t * 1.3 + bx * 0.12 + by * 0.09) * 0.14;
    }
    attr.needsUpdate = true;
  }
}
