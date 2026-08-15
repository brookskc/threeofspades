// mapgen.js — procedural terrain with two team bases, in four themed maps.
// MAPS order is the rotation order; generateMap(world, seed, mapIndex) fills
// world.data, re-anchors BASE, and meshes everything via world.buildAll().
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

export const MAPS = [
  { key: 'island', name: 'GREENBELT' },
  { key: 'beach',  name: 'BEACHHEAD' },
  { key: 'forest', name: 'PINEFALL'  },
  { key: 'desert', name: 'DUNES'     },
];

// Mutated by each generator; game.js reads spawn points and flag stands here.
export const BASE = {
  green: { x: 36,     z: SZ / 2, flag: null, plateau: 16 },
  blue:  { x: SX - 36, z: SZ / 2, flag: null, plateau: 16 },
};
const BASE_H = SEA + 7; // plateau height above the sea

const at = (x, z) => (z * SX + x);

// Fill every column up to its height: cap block on top, dirt, then stone.
function fillColumns(world, height, cap, dirt = BLOCK.DIRT) {
  for (let z = 0; z < SZ; z++)
    for (let x = 0; x < SX; x++) {
      const h = Math.floor(height[at(x, z)]);
      for (let y = 0; y <= h; y++) {
        let v;
        if (y === h) v = cap(x, z, h);
        else if (y > h - 4) v = dirt;
        else v = BLOCK.STONE;
        world.data[(y * SZ + z) * SX + x] = v;
      }
    }
}

// Flatten both base plateaus into the height field.
function flattenBases(height) {
  for (const team of ['green', 'blue']) {
    const b = BASE[team];
    for (let z = 0; z < SZ; z++)
      for (let x = 0; x < SX; x++) {
        const d = Math.hypot(x - b.x, z - b.z);
        if (d < b.plateau + 10) {
          const t = Math.min(1, Math.max(0, (d - b.plateau) / 10));
          const i = at(x, z);
          height[i] = height[i] * t + BASE_H * (1 - t);
        }
      }
  }
}

// Team-colored bunker: ring wall with two gates, corner towers, flag plinth.
function buildBase(world, height, team) {
  const b = BASE[team];
  const block = team === 'green' ? BLOCK.GREEN : BLOCK.BLUE;
  const fx = b.x, fz = b.z, fy = Math.floor(height[at(fx, fz)]);
  b.flag = { x: fx, y: fy + 1, z: fz };

  const R = 9;
  for (let a = 0; a < Math.PI * 2; a += 0.02) {
    const wx = Math.round(fx + Math.cos(a) * R), wz = Math.round(fz + Math.sin(a) * R);
    if (Math.abs(wz - fz) < 2 && Math.abs(wx - fx) > R - 2) continue; // gates face east/west
    const wy = Math.floor(height[at(wx, wz)]);
    for (let y = wy + 1; y <= wy + 3; y++) world.data[(y * SZ + wz) * SX + wx] = block;
  }
  for (const [tx, tz] of [[-R, -R], [R, -R], [-R, R], [R, R]]) {
    const px = fx + tx, pz = fz + tz;
    const py = Math.floor(height[at(px, pz)]);
    for (let y = py + 1; y <= py + 6; y++)
      for (let ox = -1; ox <= 1; ox++)
        for (let oz = -1; oz <= 1; oz++)
          world.data[((y) * SZ + (pz + oz)) * SX + (px + ox)] = block;
  }
  for (let ox = -1; ox <= 1; ox++)
    for (let oz = -1; oz <= 1; oz++)
      world.data[(fy * SZ + fz + oz) * SX + fx + ox] = block;
}

// ---------------------------------------------------------------- island
function genIsland(world, seed) {
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
      // Clean shorelines: steepen the waterline crossing so few columns
      // straddle the sea plane (kills the speckled-shallows moiré).
      if (h > SEA - 2 && h < SEA + 2) {
        const t = (h - (SEA - 2)) / 4;
        h = SEA - 2 + 4 * t * t * (3 - 2 * t);
      }
      height[at(x, z)] = Math.min(SY - 8, h);
    }

  flattenBases(height);

  // A gentle road between the bases — pulled toward its target height in both
  // directions: causeway over water, soft valley through hills, wide smooth
  // shoulders. (Hard clamping used to leave picket-fence cliffs along the edge.)
  for (let x = BASE.green.x; x <= BASE.blue.x; x++) {
    const rz = SZ / 2 + 8 * Math.sin(x * 0.05);
    const target = SEA + 3 + 3 * noise(x * 0.02, 7);
    for (let z = Math.floor(rz - 12); z <= Math.ceil(rz + 12); z++) {
      if (z < 1 || z >= SZ - 1) continue;
      const t = Math.min(1, Math.max(0, (Math.abs(z - rz) - 4) / 8)); // 0 roadbed → 1 off-road
      const i = at(x, z);
      height[i] = height[i] * t + target * (1 - t);
    }
  }

  fillColumns(world, height, (x, z, h) => h <= SEA + 1 ? BLOCK.SAND : BLOCK.GRASS);
  buildBase(world, height, 'green');
  buildBase(world, height, 'blue');
}

// ---------------------------------------------------------------- beach
// D-day: green storms out of the western surf, across open sand studded with
// landing craft and tank traps, up a fortified bluff, and into blue's ridge.
function genBeach(world, seed) {
  const noise = makeNoise(seed);
  const height = new Float32Array(SX * SZ);
  BASE.green.x = 40; BASE.blue.x = SX - 40;

  for (let z = 0; z < SZ; z++)
    for (let x = 0; x < SX; x++) {
      let h;
      if (x < 34)       h = SEA - 3.5 + noise(x * 0.05, z * 0.05) * 1.5;   // sea floor
      else if (x < 58)  h = SEA - 3.5 + ((x - 34) / 24) * 5.5;             // surf slope
      else if (x < 100) h = SEA + 2 + ((x - 58) / 42) * 2.5                // the long sand
                        + noise(x * 0.06, z * 0.06) * 1.1;
      else if (x < 158) {                                                   // the bluff
        const b = (x - 100) / 58;
        h = SEA + 4.5 + b * b * 13 + noise(x * 0.08, z * 0.08) * 2.2 * b;
      } else h = SEA + 17.5 + noise(x * 0.03, z * 0.03) * 3;               // blue's ridge
      // Coastline falloff at the z edges, so the map reads as a peninsula.
      const ez = Math.min(z, SZ - 1 - z);
      if (ez < 26) h = Math.min(h, SEA - 2 + (ez / 26) * (h - SEA + 2 + 6) - 6 * (1 - ez / 26));
      height[at(x, z)] = Math.min(SY - 8, h);
    }

  flattenBases(height);
  fillColumns(world, height, (x, z, h) => h <= SEA + 5 ? BLOCK.SAND : BLOCK.GRASS);

  // Landing craft in the surf — U-shaped stone hulls with the bow ramp open
  // toward the beach. Hard cover the moment you wade ashore.
  for (const bz of [SZ / 2 - 38, SZ / 2 + 36, SZ / 2 + 56]) {
    const bx = 22 + Math.floor(noise(bz, 3) * 8); // in the surf, clear of the LZ
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = 0; dx < 9; dx++) {
        const x = bx + dx, z = bz + dz;
        world.data[(SEA * SZ + z) * SX + x] = BLOCK.STONE;          // dry deck
        const wall = Math.abs(dz) === 2 || dx === 0;                 // sides + stern
        if (wall) for (let y = SEA + 1; y <= SEA + 2; y++)
          world.data[(y * SZ + z) * SX + x] = BLOCK.STONE;
      }
  }
  // Czech hedgehogs scattered across the sand — little triangles of cover.
  const rnd = mulberry32(seed ^ 0xBEAC);
  for (let i = 0; i < 30; i++) {
    const x = 62 + Math.floor(rnd() * 36), z = 24 + Math.floor(rnd() * (SZ - 48));
    const y = Math.floor(height[at(x, z)]);
    world.data[((y + 1) * SZ + z) * SX + x] = BLOCK.STONE;
    world.data[((y + 2) * SZ + z) * SX + x] = BLOCK.STONE;
    world.data[((y + 1) * SZ + z) * SX + x + 1] = BLOCK.STONE;
  }
  // MG pillboxes dug into the bluff top, guns slitted toward the beach.
  for (const pz of [SZ / 2 - 48, SZ / 2, SZ / 2 + 48]) {
    const px = 150 + Math.floor(noise(pz, 11) * 6);
    const py = Math.floor(height[at(px, pz)]);
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++) {
        const x = px + dx, z = pz + dz;
        const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2;
        if (!edge) continue;
        if (dx === 2 && Math.abs(dz) <= 0) continue;                  // rear door (east)
        for (let y = py + 1; y <= py + 3; y++) {
          if (dx === -2 && Math.abs(dz) <= 1 && y === py + 2) continue; // firing slit
          world.data[(y * SZ + z) * SX + x] = BLOCK.STONE;
        }
      }
    for (let dx = -2; dx <= 2; dx++)                                  // roof
      for (let dz = -2; dz <= 2; dz++)
        world.data[((py + 4) * SZ + pz + dz) * SX + px + dx] = BLOCK.STONE;
  }

  buildBase(world, height, 'green');
  buildBase(world, height, 'blue');
}

// ---------------------------------------------------------------- forest
// Rolling inland hills under a dense voxel canopy, a creek cutting the
// midfield — short sightlines, ambushes, and trees you can fell for cover.
function genForest(world, seed) {
  const noise = makeNoise(seed);
  const height = new Float32Array(SX * SZ);

  for (let z = 0; z < SZ; z++)
    for (let x = 0; x < SX; x++) {
      const dx = (x - SX / 2) / (SX / 2), dz = (z - SZ / 2) / (SZ / 2);
      const rim = Math.max(0, 1 - (dx * dx + dz * dz) * 1.35); // gentler than island
      let h = SEA + 4
        + rim * 18 * (0.6 * noise(x * 0.016, z * 0.016)
                    + 0.4 * noise(x * 0.05,  z * 0.05));
      // A winding creek carved just below the waterline.
      const creekZ = SZ / 2 + 58 * Math.sin(x * 0.017 + seed % 7);
      const cd = Math.abs(z - creekZ);
      if (cd < 3.5 && x > 60 && x < SX - 60) h = Math.min(h, SEA - 1);
      height[at(x, z)] = Math.min(SY - 8, h);
    }

  flattenBases(height);
  fillColumns(world, height, (x, z, h) => h < SEA ? BLOCK.DIRT : BLOCK.GRASS);

  // Trees: dirt trunk, two-layer grass canopy. Pure blocks — fully
  // destructible, and felling one drops instant cover.
  const rnd = mulberry32(seed ^ 0xf0e57);
  for (let i = 0; i < 260; i++) {
    const x = 6 + Math.floor(rnd() * (SX - 12)), z = 6 + Math.floor(rnd() * (SZ - 12));
    if (Math.hypot(x - BASE.green.x, z - BASE.green.z) < 26) continue;
    if (Math.hypot(x - BASE.blue.x, z - BASE.blue.z) < 26) continue;
    const y = Math.floor(height[at(x, z)]);
    if (y < SEA + 1) continue; // no trees in the creek or the sea
    const trunk = 3 + Math.floor(rnd() * 3);
    for (let t = 1; t <= trunk; t++) world.data[((y + t) * SZ + z) * SX + x] = BLOCK.DIRT;
    for (let dy = 0; dy < 2; dy++)
      for (let ox = -1; ox <= 1; ox++)
        for (let oz = -1; oz <= 1; oz++)
          world.data[((y + trunk + dy) * SZ + z + oz) * SX + x + ox] = BLOCK.GRASS;
    world.data[((y + trunk + 2) * SZ + z) * SX + x] = BLOCK.GRASS;
  }

  buildBase(world, height, 'green');
  buildBase(world, height, 'blue');
}

// ---------------------------------------------------------------- desert
// Sweeping dunes, flat-topped mesas for snipers, a ruined sandstone village
// at midfield. Long sightlines — move dune-to-dune or get picked off.
function genDesert(world, seed) {
  const noise = makeNoise(seed);
  const height = new Float32Array(SX * SZ);
  const mesas = [];
  const rnd0 = mulberry32(seed ^ 0xde5e37);
  for (let i = 0; i < 5; i++)
    mesas.push([50 + rnd0() * (SX - 100), 40 + rnd0() * (SZ - 80)]);

  for (let z = 0; z < SZ; z++)
    for (let x = 0; x < SX; x++) {
      // Ridged dune field marching diagonally across the map.
      const dune = Math.abs(Math.sin((x + z) * 0.045 + noise(x * 0.01, z * 0.01) * 3));
      let h = SEA + 6 + dune * 7 + noise(x * 0.03, z * 0.03) * 2.5;
      for (const [mx, mz] of mesas) {
        const d = Math.hypot(x - mx, z - mz);
        if (d < 12) { // flat top, sheer sides
          const t = Math.min(1, Math.max(0, (d - 7) / 5));
          h = h * t + (SEA + 22) * (1 - t);
        }
      }
      height[at(x, z)] = Math.min(SY - 8, Math.max(SEA + 3, h)); // no sea here
    }

  flattenBases(height);
  fillColumns(world, height, () => BLOCK.SAND, BLOCK.SAND);

  // Mesas cap in stone — the perch reads as rock and tunnels stay sandy.
  for (const [mx, mz] of mesas)
    for (let dx = -7; dx <= 7; dx++)
      for (let dz = -7; dz <= 7; dz++) {
        if (Math.hypot(dx, dz) > 7) continue;
        const x = Math.round(mx + dx), z = Math.round(mz + dz);
        const y = Math.floor(height[at(x, z)]);
        world.data[(y * SZ + z) * SX + x] = BLOCK.STONE;
      }

  // Midfield ruins: two broken sandstone rectangles, waist-to-head high.
  const rnd = mulberry32(seed ^ 0x2015);
  for (const [rx, rz] of [[SX / 2 - 14, SZ / 2 - 10], [SX / 2 + 8, SZ / 2 + 8]]) {
    for (let per = 0; per < 22; per++) {
      const side = per % 4, step = Math.floor(per / 4);
      const x = rx + (side === 0 ? step * 2 : side === 1 ? 8 : side === 2 ? step * 2 : 0);
      const z = rz + (side === 0 ? 0 : side === 1 ? step * 2 : side === 2 ? 8 : step * 2);
      if (rnd() < 0.3) continue; // collapsed gaps
      const y = Math.floor(height[at(x, z)]);
      const wallH = 2 + Math.floor(rnd() * 3);
      for (let wy = 1; wy <= wallH; wy++)
        world.data[((y + wy) * SZ + z) * SX + x] = BLOCK.STONE;
    }
  }
  // Cacti.
  for (let i = 0; i < 42; i++) {
    const x = 6 + Math.floor(rnd() * (SX - 12)), z = 6 + Math.floor(rnd() * (SZ - 12));
    if (Math.hypot(x - BASE.green.x, z - BASE.green.z) < 24) continue;
    if (Math.hypot(x - BASE.blue.x, z - BASE.blue.z) < 24) continue;
    const y = Math.floor(height[at(x, z)]);
    const cactusH = 2 + Math.floor(rnd() * 2);
    for (let cy = 1; cy <= cactusH; cy++)
      world.data[((y + cy) * SZ + z) * SX + x] = BLOCK.GREEN;
  }

  buildBase(world, height, 'green');
  buildBase(world, height, 'blue');
}

// ---------------------------------------------------------------- entry
export function generateMap(world, seed = 1979, mapIndex = 0) {
  // Re-anchor the bases to this map's defaults before the generator runs.
  BASE.green.x = 36; BASE.green.z = SZ / 2; BASE.green.plateau = 16;
  BASE.blue.x = SX - 36; BASE.blue.z = SZ / 2; BASE.blue.plateau = 16;
  world.data.fill(0);
  [genIsland, genBeach, genForest, genDesert][mapIndex % MAPS.length](world, seed);
  world.buildAll();
  return mapIndex % MAPS.length;
}
