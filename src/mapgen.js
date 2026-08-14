// mapgen.js — procedural island terrain with two team bases.
import { SX, SY, SZ, SEA, BLOCK } from './world.js';

// Deterministic value noise — smooth, seedable, dependency-free.
function makeNoise(seed) {
  const rand = mulberry32(seed);
  const grid = new Float32Array(64 * 64);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const at = (x, y) => grid[((y & 63) << 6) | (x & 63)];
  const smooth = t => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
}
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BASE = {
  green: { x: 36,  z: SZ / 2, flag: null, plateau: 16 },
  blue:  { x: SX - 36, z: SZ / 2, flag: null, plateau: 16 },
};
const BASE_H = SEA + 7; // plateau height above the sea

export function generateMap(world, seed = 1979) {
  const noise = makeNoise(seed);
  const height = new Float32Array(SX * SZ);

  for (let z = 0; z < SZ; z++)
    for (let x = 0; x < SX; x++) {
      // Island falloff so the map is ringed by sea.
      const dx = (x - SX / 2) / (SX / 2), dz = (z - SZ / 2) / (SZ / 2);
      const island = Math.max(0, 1 - (dx * dx + dz * dz) * 1.05);
      let h = SEA + 2
        + island * 26 * (0.55 * noise(x * 0.012, z * 0.012)
                       + 0.30 * noise(x * 0.04,  z * 0.04)
                       + 0.15 * noise(x * 0.11,  z * 0.11));
      // Rolling central ridge gives the midfield some cover.
      h += island * 5 * noise(x * 0.008 + 40, z * 0.008 + 9);
      height[z * SX + x] = Math.min(SY - 8, h);
    }

  // Flatten both base plateaus and carve a gentle road between them.
  for (const team of ['green', 'blue']) {
    const b = BASE[team];
    for (let z = 0; z < SZ; z++)
      for (let x = 0; x < SX; x++) {
        const d = Math.hypot(x - b.x, z - b.z);
        if (d < b.plateau + 10) {
          const t = Math.min(1, Math.max(0, (d - b.plateau) / 10));
          const i = z * SX + x;
          height[i] = height[i] * t + BASE_H * (1 - t);
        }
      }
  }
  for (let x = BASE.green.x; x <= BASE.blue.x; x++)
    for (let dz = -4; dz <= 4; dz++) {
      const z = Math.round(SZ / 2 + dz + 8 * Math.sin(x * 0.05));
      if (z < 1 || z >= SZ - 1) continue;
      const i = z * SX + x;
      const target = SEA + 3 + 3 * noise(x * 0.02, 7);
      height[i] = Math.min(height[i], target + Math.abs(dz) * 0.8);
    }

  // Fill columns: grass cap, dirt, stone, sand near the waterline.
  for (let z = 0; z < SZ; z++)
    for (let x = 0; x < SX; x++) {
      const h = Math.floor(height[z * SX + x]);
      for (let y = 0; y <= h; y++) {
        let v;
        if (y === h) v = h <= SEA + 1 ? BLOCK.SAND : BLOCK.GRASS;
        else if (y > h - 4) v = BLOCK.DIRT;
        else v = BLOCK.STONE;
        world.data[(y * SZ + z) * SX + x] = v;
      }
    }

  // Base structures: team-colored bunkers with a flag stand at the center.
  for (const team of ['green', 'blue']) {
    const b = BASE[team];
    const block = team === 'green' ? BLOCK.GREEN : BLOCK.BLUE;
    const fx = b.x, fz = b.z, fy = Math.floor(height[fz * SX + fx]);
    b.flag = { x: fx, y: fy + 1, z: fz };

    // Ring wall with two gate openings, plus corner towers.
    const R = 9;
    for (let a = 0; a < Math.PI * 2; a += 0.02) {
      const wx = Math.round(fx + Math.cos(a) * R), wz = Math.round(fz + Math.sin(a) * R);
      if (Math.abs(wz - fz) < 2 && Math.abs(wx - fx) > R - 2) continue; // gates face east/west
      const wy = Math.floor(height[wz * SX + wx]);
      for (let y = wy + 1; y <= wy + 3; y++) world.data[(y * SZ + wz) * SX + wx] = block;
    }
    for (const [tx, tz] of [[-R, -R], [R, -R], [-R, R], [R, R]]) {
      const px = fx + tx, pz = fz + tz;
      const py = Math.floor(height[pz * SX + px]);
      for (let y = py + 1; y <= py + 6; y++)
        for (let ox = -1; ox <= 1; ox++)
          for (let oz = -1; oz <= 1; oz++)
            world.data[((y) * SZ + (pz + oz)) * SX + (px + ox)] = block;
    }
    // Flag plinth.
    for (let ox = -1; ox <= 1; ox++)
      for (let oz = -1; oz <= 1; oz++)
        world.data[(fy * SZ + fz + oz) * SX + fx + ox] = block;
  }

  world.buildAll();
}
