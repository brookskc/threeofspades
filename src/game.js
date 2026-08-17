// game.js — orchestration: combat, flags, grenades, score, HUD.
// Modes: 'solo' (local only), 'host' (authoritative, broadcasts), 'client' (thin).
import * as THREE from 'three';
import { VoxelWorld, SEA, SX, SY, SZ, BLOCK, PALETTE } from './world.js';
import { generateMap, BASE, MAPS, mapsForMode } from './mapgen.js';
import { Player, TOOLS } from './player.js';
import { Bot } from './bots.js';
import { Effects } from './effects.js';
import { sfx } from './audio.js';
import { Body, disposeObject } from './entities.js';
import { Avatar } from './avatar.js';

const WIN_SCORE = 3;
// Team deathmatch: no flags, kills are points. ?killcap= lowers the bar for tests.
// Module-scope URL params are guarded so the file imports headless (Node
// test harnesses have no `location`).
const QUERY = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
const killcapParam = parseInt(QUERY.get('killcap'), 10);
const KILL_LIMIT = Number.isInteger(killcapParam) ? Math.max(2, killcapParam) : 30;
// King of the hill: own the point to accrue hold time; first to HOLD_LIMIT
// seconds wins. Flipping a held point takes CAP_TIME uncontested seconds on
// it. ?kothtime= shrinks the clock for tests.
const kothtimeParam = parseInt(QUERY.get('kothtime'), 10);
const HOLD_LIMIT = Number.isInteger(kothtimeParam) ? Math.max(10, kothtimeParam) : 120;
const CAP_TIME = 6;
const REDEPLOY = 10; // seconds back at base after dying — humans and bots alike
// A terrain block breaks after BLOCK_HP of weapon damage — gunfire hurts
// blocks exactly as much as it hurts people (rifle 55 -> 3 shots, SMG 22 ->
// 7 shots, bot carbine 16 -> 10). The spade still digs in one hit.
const BLOCK_HP = 150;
// Hard cap on humans per room (host + guests). Test hook: ?cap=2.
const capParam = parseInt(QUERY.get('cap'), 10);
export const MAX_HUMANS = Number.isInteger(capParam) ? Math.min(8, Math.max(2, capParam)) : 8;
const $ = id => document.getElementById(id);
const v3 = a => new THREE.Vector3(a[0], a[1], a[2]);
// Wire numbers are untrusted: a patched client sending NaN/Infinity coords
// would poison hit detection and physics for the whole room.
const finite3 = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
const arr = v => [v.x, v.y, v.z];
const FLAG_CODE = { home: 0, carried: 1, dropped: 2 };

// ---------------------------------------------------------------- flags
class Flag {
  constructor(game, team) {
    this.game = game;
    this.team = team;
    const stand = BASE[team].flag;
    this.home = new THREE.Vector3(stand.x + 0.5, stand.y, stand.z + 0.5);
    this.pos = this.home.clone();
    this.state = 'home'; // home | carried | dropped
    this.carrier = null;
    this.dropTimer = 0;

    const color = team === 'blue' ? 0x4a6cd4 : 0x4a9e4a;
    this.group = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 2.4),
      new THREE.MeshBasicMaterial({ color: 0xcccccc })
    );
    pole.position.y = 1.2;
    this.group.add(pole);
    this.cloth = new THREE.Mesh(
      new THREE.PlaneGeometry(1.15, 0.7, 8, 3),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })
    );
    this.cloth.position.set(0.62, 1.95, 0);
    this.group.add(this.cloth);
    game.scene.add(this.group);
  }

  standPos() { return this.home.clone(); }

  dispose() { disposeObject(this.group); }

  drop(at) {
    this.state = 'dropped';
    this.carrier = null;
    this.pos.copy(at);
    this.pos.y = Math.max(this.pos.y, SEA + 0.5);
    this.dropTimer = 30;
    sfx.drop();
  }

  returnHome() {
    this.state = 'home';
    this.carrier = null;
    this.pos.copy(this.home);
    sfx.pickup();
  }

  update(dt, t) {
    if (this.state === 'carried' && this.carrier) {
      this.pos.copy(this.carrier.body.pos);
      this.pos.y += 0.4;
    } else if (this.state === 'dropped') {
      this.dropTimer -= dt;
      if (this.dropTimer <= 0) this.returnHome();
    }
    this.clientUpdate(t);
  }

  // Visuals only — clients set pos/state from snapshots and call this.
  clientUpdate(t) {
    this.group.position.copy(this.pos);
    // Gentle cloth ripple.
    const p = this.cloth.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      p.setZ(i, Math.sin(t * 5 + x * 4) * 0.07 * (x + 0.6));
    }
    p.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- HUD
const hud = {
  refreshTool(p) {
    const t = TOOLS[p.tool];
    $('toolname').textContent = t.name;
    if (t.key === 'block') $('ammo').innerHTML = `${p.blocks} <small>blocks</small>`;
    else if (t.key === 'nade') $('ammo').innerHTML = `${p.grenades} <small>grenades</small>`;
    else if (t.key === 'spade') $('ammo').innerHTML = `∞`;
    else $('ammo').innerHTML = p.reloading > 0
      ? `<small>reloading…</small>`
      : `${p.ammo[p.tool]} <small>/ ${t.mag}</small>`;
    $('toolhint').textContent = `Q·E / 1–5 weapons · CTRL crouch · R reload`;
  },
  health(p) {
    $('healthfill').style.width = Math.max(0, p.health) + '%';
    $('healthnum').textContent = Math.max(0, Math.ceil(p.health)) + ' HP';
    $('healthfill').style.background = p.health > 40
      ? 'linear-gradient(90deg,#5db85d,#8fd98f)' : 'linear-gradient(90deg,#c0392b,#e74c3c)';
  },
  score(g) {
    const next = g.hill
      ? `<span class="g">GREEN ${holdClock(g.captures.green)}</span><span style="opacity:.4">—</span><span class="b">${holdClock(g.captures.blue)} BLUE</span>`
      : `<span class="g">GREEN ${g.captures.green}</span><span style="opacity:.4">—</span><span class="b">${g.captures.blue} BLUE</span>`;
    if (next !== this._lastScore) { this._lastScore = next; $('score').innerHTML = next; }
    this._flagState(g);
  },
  _flagState(g) {
    if (g.hill) { // king of the hill: who owns the point, who's taking it
      const h = g.hill;
      const text = h.contested ? 'CONTESTED'
        : h.progress > 0.1 ? `${h.capTeam.toUpperCase()} CAPTURING ${Math.round(h.progress / CAP_TIME * 100)}%`
        : h.owner ? `${h.owner.toUpperCase()} HOLDS THE HILL`
        : `hold the hill for ${holdClock(HOLD_LIMIT)} to win`;
      if (text !== this._lastFlags) { this._lastFlags = text; $('flagstate').textContent = text; }
      return;
    }
    if (!g.flags) { // team deathmatch: kills are the score
      const text = `first to ${KILL_LIMIT} kills`;
      if (text !== this._lastFlags) { this._lastFlags = text; $('flagstate').textContent = text; }
      return;
    }
    const parts = [];
    for (const team of ['green', 'blue']) {
      const f = g.flags[team];
      const label = team.toUpperCase() + ' FLAG';
      if (f.state === 'carried') parts.push(`${label} TAKEN`);
      else if (f.state === 'dropped') parts.push(`${label} DROPPED ${Math.ceil(f.dropTimer)}s`);
    }
    const text = parts.join(' · ') || `first to ${WIN_SCORE} captures`;
    if (text !== this._lastFlags) { this._lastFlags = text; $('flagstate').textContent = text; }
  },
  // Scoreboard table, sorted by kills. Shared by the TAB overlay and the
  // end-of-round summary. Names are composed here from map keys that were
  // cleanName'd (local) or sanitized on receipt (client), so plain text.
  kdTable(g) {
    const rows = [...g.kd.entries()]
      .sort((a, b) => b[1].k - a[1].k || a[1].d - b[1].d || a[0].localeCompare(b[0]));
    const me = g.player?.name;
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    let html = '<table class="kd"><tr><th></th><th>K</th><th>D</th><th>K/D</th></tr>';
    for (const [name, r] of rows) {
      const c = r.team === 'blue' ? '#8fa8ee' : '#8fd98f';
      const ratio = (r.k / Math.max(1, r.d)).toFixed(2);
      html += `<tr${name === me ? ' class="me"' : ''}>`
        + `<td style="color:${c}">${esc(name)}</td>`
        + `<td>${r.k}</td><td>${r.d}</td><td>${ratio}</td></tr>`;
    }
    return html + '</table>';
  },
  statsShow(g) {
    $('statsbody').innerHTML = this.kdTable(g);
    $('stats').style.display = 'block';
  },
  statsHide() { $('stats').style.display = 'none'; },
  statsRefresh(g) {
    if ($('stats').style.display === 'block')
      $('statsbody').innerHTML = this.kdTable(g);
  },
  feed(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    $('feed').prepend(div);
    setTimeout(() => { div.style.transition = 'opacity .6s'; div.style.opacity = 0; }, 3600);
    setTimeout(() => div.remove(), 4300);
    while ($('feed').children.length > 6) $('feed').lastChild.remove();
  },
  message(text, color = '#fff') {
    const m = $('msg');
    m.textContent = text;
    m.style.color = color;
    m.style.opacity = 1;
    clearTimeout(this._mt);
    this._mt = setTimeout(() => (m.style.opacity = 0), 2200);
  },
  hitmark() {
    const h = $('hitmark');
    h.classList.remove('pop');
    void h.offsetWidth;
    h.classList.add('pop');
  },
  damage() {
    const v = $('vignette');
    v.style.transition = 'none'; v.style.opacity = 1;
    requestAnimationFrame(() => { v.style.transition = 'opacity .7s'; v.style.opacity = 0; });
  },
  respawn(t) {
    $('respawn').style.opacity = t > 0 ? 1 : 0;
    if (t > 0) $('respawn').textContent = `REDEPLOYING IN ${Math.ceil(t)}…`;
  },
  // Chat line. The text goes in as a TEXT NODE — never HTML — so a message
  // can't inject markup.
  chatMsg(m) {
    const log = $('chatlog');
    $('chat').classList.add('haslog');
    const div = document.createElement('div');
    if (m.scope === 'team') {
      const tag = document.createElement('span');
      tag.className = 'tm';
      tag.textContent = 'TEAM';
      div.append(tag);
    }
    const n = document.createElement('span');
    n.className = 'cn';
    n.style.color = m.team === 'blue' ? '#8fa8ee' : '#8fd98f';
    n.textContent = m.name;
    div.append(n, document.createTextNode(m.text));
    log.append(div);
    while (log.children.length > 8) log.firstChild.remove();
    clearTimeout(div._ft); clearTimeout(div._rt);
    div._ft = setTimeout(() => div.classList.add('faded'), 11000);
    div._rt = setTimeout(() => div.remove(), 12000);
  },

  // ---------------- minimap ----------------
  // Chunky top-down view: the world is sampled into MAP_G×MAP_G cells of
  // 4×4 blocks apiece, the tallest column winning so bridges and towers
  // still show. One offscreen pixel per cell, then a nearest-neighbor
  // upscale to the display canvas — crisp voxel squares, no bilinear blur.
  // Brightness bands by height give a terraced look, and a cell standing
  // well above its west/north neighbor catches light while a sunken one
  // sits in shade, so cliffs and craters read as steps. Edits dirty single
  // cells (world.onEdit); markers redraw every frame over the cached terrain.
  mapInit(world) {
    const G = (this._mapG = 64), STEP = (this._mapStep = SX / G);
    const off = document.createElement('canvas');
    off.width = G; off.height = G;
    this._mapOff = off;
    this._mapCtx = off.getContext('2d');
    this._mapImg = this._mapCtx.createImageData(G, G);
    this._mapDirty = new Set();
    this._mapH = new Int16Array(G * G); // tallest surface per cell
    for (let gz = 0; gz < G; gz++)       // row-major: west/north neighbors
      for (let gx = 0; gx < G; gx++)     // are shaded before they are read
        this._mapCell(world, gx, gz);
    this._mapCtx.putImageData(this._mapImg, 0, 0);
  },
  _cellTop(world, gx, gz) {
    const STEP = this._mapStep;
    let top = -1, block = 0;
    for (let dz = 0; dz < STEP; dz++)
      for (let dx = 0; dx < STEP; dx++) {
        const x = gx * STEP + dx, z = gz * STEP + dz;
        const y = world.surface(x, z);
        if (y > top) { top = y; block = world.get(x, y, z); }
      }
    this._mapH[gz * this._mapG + gx] = top;
    return { top, block };
  },
  _mapCell(world, gx, gz) {
    const G = this._mapG;
    const { top, block } = this._cellTop(world, gx, gz);
    const i = (gz * G + gx) * 4;
    const d = this._mapImg.data;
    let r, g, b;
    if (top < SEA) {
      const band = Math.min(3, (SEA - top) >> 1); // discrete depth steps
      const f = 1 - 0.14 * band;
      r = 47 * f; g = 111 * f; b = 184 * f;
    } else {
      const c = PALETTE[block]?.color ?? 0x8a8d94;
      let br = 0.60 + 0.045 * Math.floor(top / 3); // terraced height bands
      const west = gx > 0 ? this._mapH[gz * G + gx - 1] : top;
      const north = gz > 0 ? this._mapH[(gz - 1) * G + gx] : top;
      if (top - Math.min(west, north) >= 3) br += 0.10; // sunlit ledge
      if (Math.max(west, north) - top >= 3) br -= 0.12; // shaded foot
      r = Math.min(255, ((c >> 16) & 255) * br);
      g = Math.min(255, ((c >> 8) & 255) * br);
      b = Math.min(255, (c & 255) * br);
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
  },
  mapDirty(x, z) {
    if (!this._mapDirty) return;
    const G = this._mapG, STEP = this._mapStep;
    const gx = (x / STEP) | 0, gz = (z / STEP) | 0;
    // The east/south neighbors shade off this cell's height too.
    for (let dz = 0; dz <= 1; dz++)
      for (let dx = 0; dx <= 1; dx++) {
        const nx = gx + dx, nz = gz + dz;
        if (nx < G && nz < G) this._mapDirty.add(nz * G + nx);
      }
  },
  minimap(g) {
    const cv = $('minimap');
    if (!cv || !this._mapOff) return;
    // Flush edited cells in one putImageData over their bounding box.
    if (this._mapDirty.size) {
      const G = this._mapG;
      let x0 = G, z0 = G, x1 = -1, z1 = -1;
      for (const k of this._mapDirty) {
        const gx = k % G, gz = (k - gx) / G;
        this._mapCell(g.world, gx, gz);
        if (gx < x0) x0 = gx; if (gx > x1) x1 = gx;
        if (gz < z0) z0 = gz; if (gz > z1) z1 = gz;
      }
      this._mapCtx.putImageData(this._mapImg, 0, 0, x0, z0, x1 - x0 + 1, z1 - z0 + 1);
      this._mapDirty.clear();
    }
    const ctx = cv.getContext('2d');
    const W = cv.width, s = W / SX;
    ctx.imageSmoothingEnabled = false; // crisp voxel squares
    ctx.clearRect(0, 0, W, W);
    ctx.drawImage(this._mapOff, 0, 0, this._mapG, this._mapG, 0, 0, W, W);
    // Base plateaus: team-colored diamonds, always visible — your bearings.
    // Read from BASE rather than the flags so deathmatch (flagless) maps too.
    for (const team of ['green', 'blue']) {
      const st = BASE[team].flag;
      const cx = (st.x + 0.5) * s, cz = (st.z + 0.5) * s;
      ctx.fillStyle = team === 'blue' ? '#7d9bff' : '#8fd98f';
      ctx.beginPath();
      ctx.moveTo(cx, cz - 4); ctx.lineTo(cx + 4, cz);
      ctx.lineTo(cx, cz + 4); ctx.lineTo(cx - 4, cz);
      ctx.fill();
    }
    // Flags: solid dot at home, hollow when dropped, pulsing ring when carried.
    // (Deathmatch has no flags — bases and the wedge carry the map.)
    if (g.flags) for (const team of ['green', 'blue']) {
      const f = g.flags[team];
      const cx = f.pos.x * s, cz = f.pos.z * s;
      const col = team === 'blue' ? '#7d9bff' : '#8fd98f';
      if (f.state === 'carried') {
        const r = 6 + 1.6 * Math.sin(g.time * 6);
        ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(cx, cz, r, 0, 7); ctx.stroke();
      }
      ctx.lineWidth = 1.2;
      if (f.state === 'dropped') {
        ctx.strokeStyle = col;
        ctx.beginPath(); ctx.arc(cx, cz, 3, 0, 7); ctx.stroke();
      } else {
        ctx.fillStyle = col;
        ctx.strokeStyle = 'rgba(255,255,255,.85)';
        ctx.beginPath(); ctx.arc(cx, cz, 3, 0, 7); ctx.fill(); ctx.stroke();
      }
    }
    // King of the hill: the point as a ground ring, tinted by the owner,
    // pulsing while contested. It reads through craters because it's drawn
    // over the terrain, not into it.
    if (g.hill) {
      const h = g.hill;
      const cx = h.pos.x * s, cz = h.pos.z * s;
      const col = h.owner === 'blue' ? '#7d9bff' : h.owner === 'green' ? '#8fd98f' : '#e8ecf2';
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(cx, cz, h.r * s, 0, 7); ctx.stroke();
      if (h.contested) {
        const r = h.r * s + 2 + 1.6 * Math.sin(g.time * 6);
        ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(cx, cz, r, 0, 7); ctx.stroke();
      }
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.arc(cx, cz, 2.4, 0, 7); ctx.fill();
      ctx.globalAlpha = 1;
    }
    // You: a white wedge pointed where you look. lookDir's ground projection
    // is (cos yaw, -sin yaw) in world (x,z), and canvas z runs downward.
    const p = g.player;
    ctx.save();
    ctx.translate(p.body.pos.x * s, p.body.pos.z * s);
    ctx.rotate(-p.yaw);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(8,12,20,.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(6, 0); ctx.lineTo(-4, 3.6); ctx.lineTo(-4, -3.6);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  },
};

// ---------------- chat controller ----------------
// T talks to the room, Y talks to your team, Enter sends, Esc walks away.
// While the box is open the soldier holds still: movement keys are released
// and typing lands in the input, not the bindings.
class Chat {
  constructor(game) {
    this.game = game;
    this.scope = 'all';
    this.box = $('chat');
    this.input = $('chatin');
    addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT') return;        // typing elsewhere
      if (this.isOpen) return;                          // input captures its own keys
      if (!$('hud').classList.contains('on')) return;   // menus own the keyboard
      if (e.code === 'KeyT') { e.preventDefault(); this.open('all'); }
      else if (e.code === 'KeyY') { e.preventDefault(); this.open('team'); }
    });
    this.input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.code === 'Enter') this.send();
      else if (e.code === 'Escape') this.close();
    });
    this.input.addEventListener('blur', () => this.close());
  }
  get isOpen() { return this.box.classList.contains('open'); }
  open(scope) {
    this.scope = scope;
    $('chatscope').textContent = scope === 'team' ? 'TEAM' : 'ALL';
    this.box.classList.add('open');
    this.game.player.keys = {}; // don't keep charging forward while typing
    this.input.value = '';
    this.input.focus();
  }
  close() {
    this.box.classList.remove('open');
    this.input.blur();
  }
  send() {
    const text = this.input.value.trim();
    this.close();
    if (text) this.game.sendChat(text, this.scope);
  }
}

// Hold seconds -> "1:32" for the koth score line.
const holdClock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// The six face-neighbor offsets, for the structural-support flood fill.
const DIRS6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

const nameSpan = e =>
  `<span style="color:${e.team === 'blue' ? '#8fa8ee' : '#8fd98f'}">${e.name}</span>`;

// Names arrive over the network and land in HTML (kill feed) and canvas
// (nametags): keep them to the same alphabet the callsign box enforces.
const cleanName = n =>
  String(n ?? '').replace(/[^\w \-]/g, '').trim().slice(0, 12) || 'Player';

// Feed rows arrive as host-composed HTML and land in innerHTML — and the
// host is untrusted input like anyone else (a malicious room host could
// otherwise XSS every client). Escape everything, then re-admit only the
// two constructs our own composer emits: colored name spans and <b>.
const safeFeedHtml = html => String(html ?? '').slice(0, 300)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/&lt;span style=&quot;color:(#[0-9a-fA-F]{6})&quot;&gt;/g, '<span style="color:$1">')
  .replace(/&lt;span style="color:(#[0-9a-fA-F]{6})"&gt;/g, '<span style="color:$1">')
  .replace(/&lt;\/span&gt;/g, '</span>')
  .replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>');

// A network player as the host sees them: client-authoritative position,
// host-authoritative health, flags, and respawns.
class RemoteProxy {
  constructor(game, id, name, team) {
    this.game = game;
    this.id = id;
    this.name = name;
    this.team = team;
    this.isRemote = true;
    const p = game.spawnPoint(team);
    this.body = new Body(game.world, p.x, p.y, p.z);
    this.health = 100;
    this.alive = true;
    this.carrier = false;
    this.blocks = 50;
    this.tool = 0;
    this.yaw = 0;
    this.nades = 3;            // host-enforced grenade stock (mirrors Player)
    this.nadeRegen = 0;
    this._actT = {};           // per-action rate gates (host enforces, not trusts)
    this.avatar = new Avatar(game.scene, team, name);
    this.avatar.push(p.x, p.y, p.z, 0);
  }
  die(killer) {
    this.alive = false;
    this.game.effects.burst(this.body.eye(), 26,
      this.team === 'blue' ? 0x4a6cd4 : 0x4a9e4a, 6);
    this.game.net.sendTo(this.id, { t: 'e', k: 'died' });
    this.game.onDeath(this, killer);
  }
  respawn() {
    const p = this.game.spawnPoint(this.team);
    this.body.pos.set(p.x, p.y, p.z);
    this.health = 100;
    this.alive = true;
    this.blocks = 50;
    this.nades = 3;
    this.nadeRegen = 0;
    this.game.net.sendTo(this.id, { t: 'e', k: 'spawn', x: p.x, y: p.y, z: p.z });
  }
}

// ---------------------------------------------------------------- game
export class Game {
  constructor(scene, camera, dom, opts = {}) {
    this.scene = scene;
    this.camera = camera;
    this.time = 0;
    this.over = false;
    this.mode = opts.mode ?? 'solo';       // solo | host | client
    this.net = opts.net ?? null;
    this.seed = opts.seed ?? 1979;
    this.editLog = [];                     // host: every world change, for late joiners
    this.blockHits = new Map();            // host/solo: 'x,y,z' -> remaining gunfire HP
    this.remote = new Map();               // host: peerId -> RemoteProxy
    this.avatars = new Map();              // client: key -> Avatar
    this.myId = null;
    this._snapT = 0;
    this._sendT = 0;
    this._lastHealth = 100;
    this._respawnT = 0;                  // client: cosmetic redeploy countdown
    this._chatCd = 0;                    // chat send cooldown (wall clock)

    this.world = new VoxelWorld(scene);
    this.mapIndex = 0;                   // MAPS rotation position
    generateMap(this.world, this.seed, this.mapIndex);
    this.world.onEdit = (x, z) => hud.mapDirty(x, z);
    hud.mapInit(this.world);
    this.effects = new Effects(scene);
    this.bots = [];                        // before Player: its first spawnPoint reads these
    this.player = new Player(this, camera, dom);
    this.player.name = opts.name ?? 'You';
    this.hud = hud;
    this.chat = new Chat(this);

    if (this.mode !== 'client') this._spawnBots();

    this.gameMode = 'ctf';             // 'ctf' | 'tdm' | 'koth' — set before rebuild()
    this.mapLock = null;               // host map pref: fixed index, or null = rotate
    this.hill = null;                  // koth: { pos, r, owner, progress, contested }
    this.flags = { green: new Flag(this, 'green'), blue: new Flag(this, 'blue') };
    this.captures = { green: 0, blue: 0 };
    this.grenades = [];
    // A pool, not one shared mesh: several grenades can be airborne at once
    // (two bots + a player), and a single mesh rendered only grenades[0].
    const nadeGeo = new THREE.SphereGeometry(0.14, 10, 8);
    const nadeMat = new THREE.MeshBasicMaterial({ color: 0x2e3b2e });
    this.grenadeMeshes = [];
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(nadeGeo, nadeMat);
      m.visible = false;
      scene.add(m);
      this.grenadeMeshes.push(m);
    }
    this.respawnTimers = new Map();
    // Scoreboard: name -> { team, k, d }, seeded for every combatant so a
    // 0/0 soldier still shows up. Host broadcasts the table on each death;
    // clients replace their copy wholesale (names are unique enough keys).
    this.kd = new Map();
    this._kdSeed();

    hud.refreshTool(this.player);
    hud.health(this.player);
    hud.score(this);
  }

  // Tear down and regenerate (host room start / client welcome / map rotation).
  rebuild(seed, map = this.mapIndex) {
    this.world.dispose();
    for (const b of this.bots) disposeObject(b.parts.group);
    for (const av of this.avatars.values()) av.dispose();
    this.avatars.clear();
    for (const t of ['green', 'blue']) this.flags?.[t].dispose();
    this.seed = seed;
    this.mapIndex = map;
    this.world = new VoxelWorld(this.scene);
    generateMap(this.world, seed, map);
    this.world.onEdit = (x, z) => hud.mapDirty(x, z);
    hud.mapInit(this.world);
    // Bodies capture the world instance at construction; the player and any
    // remote proxies survive rebuild, so rebind them or they'd keep colliding
    // with the previous map while the new one renders on screen.
    this.player.body.world = this.world;
    for (const rp of this.remote.values()) rp.body.world = this.world;
    // Only capture-the-flag has flags; deathmatch and king of the hill don't.
    this.flags = this.gameMode === 'ctf'
      ? { green: new Flag(this, 'green'), blue: new Flag(this, 'blue') } : null;
    // King of the hill: the zone rides the live terrain, so only the center
    // and radius are fixed; the y-band is re-read per tick as craters form.
    const hd = MAPS[this.mapIndex].hill ?? { x: SX / 2, z: SZ / 2, r: 8 };
    this.hill = this.gameMode === 'koth' && hd
      ? { pos: new THREE.Vector3(hd.x + 0.5, this.world.surface(hd.x, hd.z), hd.z + 0.5),
          r: hd.r, owner: null, progress: 0, contested: false, capTeam: null }
      : null;
    this.bots = [];
    if (this.mode !== 'client') this._spawnBots();
    this.captures = { green: 0, blue: 0 };
    this.editLog = [];
    this.blockHits.clear();
    this.grenades = [];
    for (const m of this.grenadeMeshes) m.visible = false;
    this.respawnTimers.clear();
    this.over = false;
    this._lastHealth = 100;
    this.kd = new Map(); // fresh round, fresh scoreboard
    this._kdSeed();
    this.player.respawn();
    hud.score(this);
  }

  _kdRow(e) {
    let r = this.kd.get(e.name);
    if (!r) this.kd.set(e.name, r = { team: e.team, k: 0, d: 0 });
    r.team = e.team; // migration/rejoin could flip a name's side
    return r;
  }
  _kdSeed() { for (const e of this.entities()) this._kdRow(e); }

  _spawnBots() {
    for (let i = 0; i < 4; i++) this.bots.push(new Bot(this, 'blue'));
    for (let i = 0; i < 3; i++) this.bots.push(new Bot(this, 'green'));
  }

  enemyOf(team) { return team === 'blue' ? 'green' : 'blue'; }

  // this.player is undefined while its constructor asks for its first spawn.
  entities() { return [this.player, ...this.remote.values(), ...this.bots].filter(Boolean); }

  // Announcements: show locally, and relay to clients when hosting.
  feed(html) {
    hud.feed(html);
    if (this.mode === 'host') this.net.broadcast({ t: 'e', k: 'feed', html });
  }
  message(text, color = '#fff') {
    hud.message(text, color);
    if (this.mode === 'host') this.net.broadcast({ t: 'e', k: 'msg', text, color });
  }
  // A centered message for one specific remote player.
  messageTo(e, text, color) {
    if (e === this.player) hud.message(text, color);
    else if (e.isRemote) this.net.sendTo(e.id, { t: 'e', k: 'msg', text, color });
  }
  // A centered message for everyone on a team (host tags it; clients filter).
  messageTeam(team, text, color) {
    if (this.player.team === team) hud.message(text, color);
    if (this.mode === 'host') this.net.broadcast({ t: 'e', k: 'msg', text, color, team });
  }
  foesOf(team) { return this.entities().filter(e => e.team !== team); }

  // Pick a spawn just outside the base gate: never in water, never at the
  // bottom of a fresh crater, and as far from living enemies as the options
  // allow — spawning into a camper's sights is how you get one-shotted.
  spawnPoint(team) {
    const b = BASE[team];
    const dir = team === 'green' ? 1 : -1; // just outside the gate, facing the field
    const foes = this.foesOf(team).filter(e => e.alive).map(e => e.body.pos);
    let best = null, bestScore = -1;
    for (let i = 0; i < 16; i++) {
      const x = b.x + dir * (4 + Math.random() * 16) + (Math.random() - 0.5) * 8;
      const z = b.z + (Math.random() - 0.5) * 36;
      const fx = Math.floor(x), fz = Math.floor(z);
      const h = this.world.surface(fx, fz);
      if (h < SEA) continue; // don't spawn swimming
      let rim = h;
      for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]])
        rim = Math.max(rim, this.world.surface(fx + dx, fz + dz));
      if (rim - h > 3) continue; // crater floor — spawn up on solid ground
      let nearest = 40;
      for (const f of foes) nearest = Math.min(nearest, Math.hypot(f.x - x, f.y - h, f.z - z));
      if (nearest > bestScore) { bestScore = nearest; best = { x, y: h + 1.02, z }; }
    }
    if (best) return best;
    const x = b.x + dir * 12, z = b.z;
    return { x, y: this.world.surface(Math.floor(x), Math.floor(z)) + 1.02, z };
  }

  losClear(a, b) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const d = dir.length();
    return !this.world.raycast(a, dir.normalize(), d);
  }

  // ---------------- combat ----------------
  fireHitscan(shooter, from, dir, spec) {
    // Crouch steadies aim; iron sights steady it more (rifle ×0.5, SMG ×0.7 —
    // the SMG keeps its close-range identity, the rifle owns aimed mid-range).
    const spread = (spec.spread ?? 0) * (shooter.crouched ? 0.35 : 1)
      * (shooter.aiming ? (spec.aimSpread ?? 0.6) : 1);
    const d = dir.clone()
      .add(new THREE.Vector3((Math.random() - .5) * spread * 2,
                             (Math.random() - .5) * spread * 2,
                             (Math.random() - .5) * spread * 2))
      .normalize();

    const RANGE = 130;
    const voxel = this.world.raycast(from, d, RANGE);
    const maxT = voxel ? voxel.dist : RANGE;

    // Nearest entity struck before the wall.
    let hit = null, hitT = maxT, head = false;
    for (const e of this.foesOf(shooter.team)) {
      if (!e.alive) continue;
      const r = rayVsSoldier(from, d, e.body);
      if (r !== null && r.t < hitT) { hit = e; hitT = r.t; head = r.head; }
    }

    const end = hit
      ? from.clone().addScaledVector(d, hitT)
      : voxel
        ? from.clone().addScaledVector(d, Math.max(0, voxel.dist - 0.05))
        : from.clone().addScaledVector(d, RANGE);
    const muzzle = from.clone().addScaledVector(d, 1.2).add(new THREE.Vector3(0, -0.12, 0));
    const hex = voxel ? PALETTE[this.world.get(voxel.x, voxel.y, voxel.z)].color : 0;
    this.shotFx(muzzle, end, !!hit, hex, from);

    if (this.mode === 'host') {
      this.net.broadcast({ t: 'e', k: 'shot', sid: shooter.isRemote ? shooter.id : 'HOST',
        f: arr(muzzle), e: arr(end), hit: !!hit, hex });
    }

    if (hit) {
      const dmg = spec.damage * (head ? (spec.headMult ?? 1.5) : 1);
      if (shooter === this.player) { sfx.hit(); hud.hitmark(); }
      else if (shooter.isRemote) this.net.sendTo(shooter.id, { t: 'e', k: 'hit' });
      this.damage(hit, dmg, shooter);
    }

    // Gunfire chips blocks: the voxel that stopped the bullet accumulates
    // damage and breaks after BLOCK_HP. Skipped when an entity absorbed the
    // shot first — the bullet never reached the wall. (fireHitscan only ever
    // runs on the host/solo side, so this stays authoritative and the break
    // reaches clients through the edit broadcast.)
    if (voxel && !hit) this.hitBlock(voxel.x, voxel.y, voxel.z, spec.damage ?? 20, shooter);
  }

  hitBlock(x, y, z, dmg, who = null) {
    const key = x + ',' + y + ',' + z;
    const hp = (this.blockHits.get(key) ?? BLOCK_HP) - dmg;
    if (hp > 0) { this.blockHits.set(key, hp); return; }
    this.blockHits.delete(key);
    const v = this.world.get(x, y, z);
    this.applyEdit(x, y, z, 0, who);
    this.effects.blockBurst([{ x, y, z, v }]);
  }

  // Tracer + impact particles + report sound (shared by local sim and net replay).
  shotFx(muzzle, end, hit, hex, from) {
    this.effects.tracer(muzzle, end);
    if (hit) this.effects.burst(end, 10, 0xc0392b, 4);
    else if (hex) this.effects.burst(end, 6, hex, 3);
    if (from.distanceTo(this.player.body.pos) < 55 &&
        from.distanceToSquared(this.player.body.eye()) > 4) sfx.smg();
  }

  // Player tool entry points — route locally (solo/host) or to the host (client).
  requestShoot(p, t) {
    if (this.mode !== 'client') return this.fireHitscan(p, p.body.eye(), p.lookDir(), t);
    const from = p.body.eye(), dir = p.lookDir();
    const vox = this.world.raycast(from, dir, 130);
    const end = vox
      ? from.clone().addScaledVector(dir, Math.max(0, vox.dist - 0.05))
      : from.clone().addScaledVector(dir, 130);
    this.effects.tracer(from.clone().addScaledVector(dir, 1.2).add(new THREE.Vector3(0, -0.12, 0)), end);
    this.net.send({ t: 'a', k: 'shoot', o: arr(from), d: arr(dir), tool: p.tool });
  }
  requestDig(p) {
    if (this.mode !== 'client') return this.playerDig(p);
    this.net.send({ t: 'a', k: 'dig', o: arr(p.body.eye()), d: arr(p.lookDir()) });
  }
  requestPlace(p) {
    if (this.mode !== 'client') return this.playerPlace(p);
    if (p.blocks <= 0) { sfx.click(); return; }
    this.net.send({ t: 'a', k: 'place', o: arr(p.body.eye()), d: arr(p.lookDir()) });
  }
  requestNade(p) {
    if (this.mode !== 'client') return this.throwGrenade(p, p.body.eye(), p.lookDir(), 13);
    this.net.send({ t: 'a', k: 'nade', o: arr(p.body.eye()), d: arr(p.lookDir()) });
  }

  // ---------------- chat ----------------
  // Local echo is immediate; in a room the host is the relay (and the spam
  // filter), so a message reaches every screen exactly once.
  sendChat(text, scope) {
    const now = performance.now();
    if (now < this._chatCd) return;         // easy on the enter key
    this._chatCd = now + 1200;
    const p = this.player;
    hud.chatMsg({ name: p.name, team: p.team, text, scope });
    if (this.mode === 'client') this.net.send({ t: 'a', k: 'chat', text, scope });
    else if (this.mode === 'host') this._hostRelayChat(null, p.team, text, scope);
  }

  // Host side: show it here, then forward to everyone the message is for —
  // the whole room, or just the sender's team — never back to the sender.
  _hostRelayChat(fromId, team, text, scope) {
    const m = { t: 'e', k: 'chat', name: fromId == null ? this.player.name
      : this.remote.get(fromId)?.name, team, text, scope };
    for (const [id, p] of this.remote) {
      if (id === fromId) continue;
      if (scope === 'team' && p.team !== team) continue;
      this.net.sendTo(id, m);
    }
  }

  _hostOnChat(id, text, scope) {
    const p = this.remote.get(id);
    if (!p) return;
    const now = performance.now();          // per-sender throttle, host-enforced
    if (now < (p._chatCd ?? 0)) return;
    p._chatCd = now + 1200;
    text = String(text ?? '').trim().slice(0, 120);
    if (!text) return;
    scope = scope === 'team' ? 'team' : 'all';
    // Team chatter is for teammates only — the host included.
    if (scope === 'all' || p.team === this.player.team)
      hud.chatMsg({ name: p.name, team: p.team, text, scope });
    this._hostRelayChat(id, p.team, text, scope);
  }

  damage(victim, amount, attacker) {
    if (!victim.alive || this.over) return;
    victim.health -= amount;
    victim.alert?.(attacker); // bots whirl toward whoever shot them
    if (victim === this.player) { hud.damage(); sfx.hurt(); hud.health(this.player); }
    if (victim.health <= 0) victim.die(attacker);
  }

  onDeath(victim, killer) {
    // Flag drops where the carrier fell (capture-the-flag only).
    if (this.flags && victim.carrier) {
      victim.carrier = false;
      this.flags[this.enemyOf(victim.team)].drop(victim.body.pos.clone());
      // this.feed/this.message, not hud.* — the wrappers relay to clients.
      this.feed(`${nameSpan(victim)} dropped the flag`);
      this.message('FLAG DROPPED', '#ffd97a');
    }
    if (killer && killer !== victim) this.feed(`${nameSpan(killer)} ⚔ ${nameSpan(victim)}`);
    else this.feed(`${nameSpan(victim)} blew up`);

    // Scoreboard: a death for the fallen, a kill for the killer — suicides
    // and terrain score a death only, same as TDM team scoring below.
    this._kdRow(victim).d++;
    if (killer && killer !== victim) this._kdRow(killer).k++;
    if (this.mode === 'host')
      this.net.broadcast({ t: 'e', k: 'kd',
        rows: [...this.kd].map(([n, r]) => [n, r.team, r.k, r.d]) });
    hud.statsRefresh(this); // keep an open TAB overlay live

    // Deathmatch: a kill is a point. Suicides and the terrain score nothing.
    if (this.gameMode === 'tdm' && killer && killer !== victim && !this.over) {
      this.captures[killer.team]++;
      hud.score(this);
      if (this.captures[killer.team] >= KILL_LIMIT) this._end(killer.team);
    }

    // Everyone waits out the same redeploy timer — bots too, or a raid on
    // the enemy base would face a fresh wave every few seconds.
    this.respawnTimers.set(victim, REDEPLOY);
    if (victim === this.player) hud.respawn(REDEPLOY);
  }

  // ---------------- block tools ----------------
  applyEdit(x, y, z, v, who = null) {
    this.blockHits.delete(x + ',' + y + ',' + z);  // fresh block / cleared cell: full HP
    this.world.set(x, y, z, v);
    if (this.mode === 'host') {
      this.editLog.push([x, y, z, v]);
      this.net.broadcast({ t: 'e', k: 'edit', x, y, z, v });
    }
    if (!v) this._collapseFrom([{ x, y, z }], who); // cut the legs out? it falls
  }

  // Structural support: whatever isn't connected to bedrock comes down.
  // Multi-source BFS from every solid face of the void a removal left. A
  // clump that can't reach y=0 within the proof budget collapses; one bigger
  // than the budget is assumed terrain and stays (collapses are for towers,
  // bridges and bunkers — not for half the map). Host/solo only: clients
  // replay the 'col' event so every world converges on the host's.
  _collapseFrom(holes, who = null) {
    if (this.mode === 'client' || !holes.length) return;
    const CAP = 4000;
    const key = (x, y, z) => x + ',' + y + ',' + z;
    const seen = new Set();   // BFS-visited (grounded or doomed)
    const seeded = new Set(); // dedupe only — seeds must NOT count as visited
    const seeds = [];
    for (const h of holes)
      for (const d of DIRS6) {
        const x = h.x + d[0], y = h.y + d[1], z = h.z + d[2], k = key(x, y, z);
        if (!seeded.has(k) && this.world.solid(x, y, z)) { seeded.add(k); seeds.push({ x, y, z }); }
      }
    // Per connected component: a dig at a tower's base touches BOTH the
    // terrain and the tower — the grounded dirt must not vouch for the
    // severed tower. Each clump has to find its own way to bedrock.
    const doomed = new Set();
    for (const s of seeds) {
      const sk = key(s.x, s.y, s.z);
      if (seen.has(sk)) continue;
      const comp = new Set([sk]);
      const q = [s];
      seen.add(sk);
      let grounded = false;
      for (let i = 0; i < q.length && !grounded; i++) {
        const c = q[i];
        if (c.y === 0 || comp.size > CAP) { grounded = true; break; }
        for (const d of DIRS6) {
          const x = c.x + d[0], y = c.y + d[1], z = c.z + d[2], k = key(x, y, z);
          if (seen.has(k) || !this.world.solid(x, y, z)) continue;
          seen.add(k); comp.add(k); q.push({ x, y, z });
        }
      }
      if (!grounded) for (const k of comp) doomed.add(k);
    }
    if (!doomed.size) return;
    // Down it comes: remove the clump, dust it, and hurt anyone standing in
    // it or directly under it — a falling tower should kill.
    const cells = [...doomed].map(k => {
      const [x, y, z] = k.split(',').map(Number);
      return { x, y, z, v: this.world.get(x, y, z) };
    });
    for (const c of cells) this.world.set(c.x, c.y, c.z, 0);
    this.effects.blockBurst(cells.filter((_, i) => i % Math.ceil(cells.length / 48) === 0));
    sfx.crumble();
    for (const e of this.entities()) {
      if (!e.alive) continue;
      const b = e.body;
      const x0 = Math.floor(b.pos.x - b.half.x), x1 = Math.floor(b.pos.x + b.half.x);
      const y0 = Math.floor(b.pos.y),        y1 = Math.floor(b.pos.y + b.half.h);
      const z0 = Math.floor(b.pos.z - b.half.x), z1 = Math.floor(b.pos.z + b.half.x);
      let hit = 0;
      for (let x = x0; x <= x1 && hit < 55; x++)
        for (let z = z0; z <= z1 && hit < 55; z++) {
          for (let y = y0; y <= y1; y++)
            if (doomed.has(key(x, y, z))) { hit = 55; break; }
          for (let y = y1 + 1; !hit && y <= y1 + 3; y++)
            if (doomed.has(key(x, y, z))) hit = 30;
        }
      if (hit) this.damage(e, hit, who);
    }
    if (this.mode === 'host') {
      for (const c of cells) this.editLog.push([c.x, c.y, c.z, 0]); // late joiners
      this.net.broadcast({ t: 'e', k: 'col',
        cells: cells.flatMap(c => [c.x, c.y, c.z]) });
    }
  }

  digVoxel(who, x, y, z) {
    const v = this.world.get(x, y, z);
    if (!v) return;
    this.applyEdit(x, y, z, 0, who);
    this.effects.blockBurst([{ x, y, z, v }]);
    if (who === this.player) {
      this.player.blocks = Math.min(99, this.player.blocks + 1);
      sfx.dig();
      hud.refreshTool(this.player);
    } else if (who.isRemote) {
      who.blocks = Math.min(99, who.blocks + 1);
    }
  }

  playerDig(p, origin = null, dir = null) {
    origin = origin ?? p.body.eye();
    dir = dir ?? p.lookDir();
    const hit = this.world.raycast(origin, dir, 5);
    // Spade doubles as a melee weapon.
    for (const e of this.foesOf(p.team)) {
      if (e.alive && e.body.eye().distanceTo(origin) < 3.2) {
        this.effects.burst(e.body.eye(), 10, 0xc0392b, 4);
        if (p === this.player) { sfx.hit(); hud.hitmark(); }
        else if (p.isRemote) this.net.sendTo(p.id, { t: 'e', k: 'hit' });
        this.damage(e, 45, p);
        return;
      }
    }
    if (hit) this.digVoxel(p, hit.x, hit.y, hit.z);
    else if (p === this.player) sfx.dig();
  }

  playerPlace(p, origin = null, dir = null) {
    if (p.blocks <= 0) { if (p === this.player) sfx.click(); return; }
    origin = origin ?? p.body.eye();
    dir = dir ?? p.lookDir();
    const hit = this.world.raycast(origin, dir, 6);
    if (!hit) return;
    const x = hit.x + hit.nx, y = hit.y + hit.ny, z = hit.z + hit.nz;
    if (this.tryBuild(p, x, y, z) && p === this.player) { sfx.place(); hud.refreshTool(p); }
  }

  // Shared placement rules for players and bots: cell must be empty, nobody
  // gets entombed, the builder's team color is used, inventory decremented.
  tryBuild(p, x, y, z) {
    if (p.blocks <= 0 || this.world.get(x, y, z)) return false;
    for (const e of this.entities()) {
      if (!e.alive) continue;
      const b = e.body;
      if (x + 1 > b.pos.x - b.half.x && x < b.pos.x + b.half.x &&
          z + 1 > b.pos.z - b.half.x && z < b.pos.z + b.half.x &&
          y + 1 > b.pos.y && y < b.pos.y + b.half.h) return false;
    }
    this.applyEdit(x, y, z, p.team === 'blue' ? BLOCK.BLUE : BLOCK.GREEN);
    p.blocks--;
    return true;
  }

  // ---------------- grenades ----------------
  throwGrenade(owner, origin, dir, speed) {
    this.grenades.push({
      pos: origin.clone().addScaledVector(dir, 0.5),
      vel: dir.clone().multiplyScalar(speed).add(new THREE.Vector3(0, 2.5, 0)),
      fuse: 2.4,
      owner,
    });
  }

  _updateGrenades(dt) {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      g.fuse -= dt;
      g.vel.y -= 22 * dt;
      for (const axis of ['x', 'y', 'z']) {
        const next = g.pos[axis] + g.vel[axis] * dt;
        const probe = g.pos.clone(); probe[axis] = next;
        if (this.world.solid(probe.x, probe.y, probe.z)) g.vel[axis] *= -0.42;
        else g.pos[axis] = next;
      }
      if (g.fuse <= 0) {
        this.grenades.splice(i, 1);
        this._explode(g);
      }
    }
    for (let i = 0; i < this.grenadeMeshes.length; i++) {
      const g = this.grenades[i], m = this.grenadeMeshes[i];
      m.visible = !!g;
      if (g) m.position.copy(g.pos);
    }
  }

  _explode(g) {
    const R = 2.4; // a modest divot: grenades maim players, not landscapes
    this.explodeAt(g.pos.x, g.pos.y, g.pos.z, R, g.owner);
    if (this.mode === 'host') {
      this.editLog.push(['b', g.pos.x, g.pos.y, g.pos.z, R]);
      this.net.broadcast({ t: 'e', k: 'boom', x: g.pos.x, y: g.pos.y, z: g.pos.z, r: R });
    }
    // Blast damage: measured to center mass, not the eye — a grenade on the
    // ground used to lose ~1.6 blocks of reach to eye height alone. Radius 9
    // matches what the fireball looks like it should do, and 150 base means
    // point blank (~3 blocks) kills outright.
    const R_DMG = 9;
    for (const e of this.entities()) {
      if (!e.alive) continue;
      const d = g.pos.distanceTo(e.body.pos.clone().add(new THREE.Vector3(0, 0.9, 0)));
      if (d < R_DMG) this.damage(e, Math.max(15, 150 * (1 - d / R_DMG)), g.owner);
    }
  }

  // Visual + terrain side of an explosion — identical on host and clients.
  explodeAt(x, y, z, r, owner = null) {
    const pos = new THREE.Vector3(x, y, z);
    this.effects.explode(pos);
    sfx.explosion();
    const removed = this.world.carve(Math.floor(x), Math.floor(y), Math.floor(z), r);
    this.effects.blockBurst(removed);
    this.effects.addShake(Math.max(0, 0.5 - pos.distanceTo(this.player.body.pos) * 0.012));
    this._collapseFrom(removed, owner); // craters can drop whole structures
  }

  // ---------------- flag logic ----------------
  _updateFlags(dt) {
    for (const team of ['green', 'blue']) this.flags[team].update(dt, this.time);

    for (const e of this.entities()) {
      if (!e.alive) continue;
      const enemyFlag = this.flags[this.enemyOf(e.team)];
      const ownFlag = this.flags[e.team];

      if (enemyFlag.state !== 'carried' && e.body.pos.distanceTo(enemyFlag.pos) < 1.9) {
        enemyFlag.state = 'carried';
        enemyFlag.carrier = e;
        e.carrier = true;
        sfx.pickup();
        this.feed(`${nameSpan(e)} took the ${this.enemyOf(e.team).toUpperCase()} flag`);
        this.messageTo(e, 'YOU HAVE THE FLAG — RUN HOME!', '#ffd97a');
        this.messageTeam(e.team === 'blue' ? 'green' : 'blue', 'OUR FLAG IS TAKEN!', '#e74c3c');
      }
      // Touching your own dropped flag sends it home.
      if (ownFlag.state === 'dropped' && e.body.pos.distanceTo(ownFlag.pos) < 1.9) {
        ownFlag.returnHome();
        this.feed(`${nameSpan(e)} returned the ${e.team.toUpperCase()} flag`);
        this.messageTo(e, 'FLAG RETURNED', '#8fd98f');
      }
      // Capture: reach your stand with the enemy flag while yours is home.
      if (e.carrier && ownFlag.state === 'home' &&
          e.body.pos.distanceTo(ownFlag.home) < 3.2) {
        e.carrier = false;
        this.captures[e.team]++;
        enemyFlag.returnHome();
        sfx.capture();
        this.feed(`${nameSpan(e)} <b>CAPTURED</b> the flag`);
        this.message(e.team === 'green' ? 'CAPTURE! GREEN SCORES' : 'CAPTURE! BLUE SCORES',
          e.team === 'green' ? '#8fd98f' : '#8fa8ee');
        hud.score(this);
        if (this.captures[e.team] >= WIN_SCORE) this._end(e.team);
      }
    }
    hud.score(this);
  }

  // ---------------- king of the hill ----------------
  // One point at map center. Stand on it alone for CAP_TIME seconds to take
  // it (or to flip it); once owned, the owner's clock accrues hold time
  // whether or not anyone is standing there — you lose it only when the
  // enemy flips it. Contested (both teams on the point) freezes a capture
  // in progress but doesn't undo it. First to HOLD_LIMIT seconds of hold
  // wins. "On the point" means inside the radius AND near the local surface
  // — towers above and tunnels below don't count, but a cratered hill does.
  _updateHill(dt) {
    const h = this.hill;
    let g = 0, b = 0;
    for (const e of this.entities()) {
      if (!e.alive) continue;
      const dx = e.body.pos.x - h.pos.x, dz = e.body.pos.z - h.pos.z;
      if (dx * dx + dz * dz > h.r * h.r) continue;
      const surf = this.world.surface(Math.floor(e.body.pos.x), Math.floor(e.body.pos.z));
      if (e.body.pos.y < surf - 4 || e.body.pos.y > surf + 6) continue;
      if (e.team === 'green') g++; else b++;
    }
    h.contested = g > 0 && b > 0;
    const sole = g > 0 && b === 0 ? 'green' : b > 0 && g === 0 ? 'blue' : null;
    if (sole) h.capTeam = sole;
    if (sole && sole !== h.owner) {
      h.progress += dt;
      if (h.progress >= CAP_TIME) {
        h.owner = sole;
        h.progress = 0;
        sfx.capture();
        this.feed(sole === 'green' ? '<b>GREEN</b> holds the hill' : '<b>BLUE</b> holds the hill');
        this.message(sole === 'green' ? 'GREEN HOLDS THE HILL' : 'BLUE HOLDS THE HILL',
          sole === 'green' ? '#8fd98f' : '#8fa8ee');
      }
    } else if (!h.contested && h.progress > 0) {
      h.progress = Math.max(0, h.progress - dt * 1.5); // abandoned or owner-only: decay
    }
    if (h.owner && !this.over) {
      this.captures[h.owner] += dt; // hold seconds (floats; displayed as clocks)
      if (this.captures[h.owner] >= HOLD_LIMIT) this._end(h.owner);
    }
    hud.score(this);
  }

  _end(winner) {
    if (this.over) return;
    this.over = true;
    if (this.mode === 'host') this.net.broadcast({ t: 'e', k: 'end', winner });
    document.exitPointerLock();
    hud.statsHide(); // the summary board replaces the overlay
    $('hud').classList.remove('on');
    const won = winner === this.player.team;
    $('endTitle').textContent = won ? 'VICTORY' : 'DEFEAT';
    $('endTitle').style.color = won ? '#8fd98f' : '#e74c3c';
    const next = MAPS[this._nextMap()].name;
    const score = this.hill
      ? `held the hill ${holdClock(this.captures.green)} — ${holdClock(this.captures.blue)}`
      : `wins ${this.captures.green} — ${this.captures.blue}`;
    $('endDetail').textContent = `${winner.toUpperCase()} ${score} · next up: ${next}`;
    $('endBoard').innerHTML = hud.kdTable(this); // round summary: everyone's K/D
    $('end').classList.remove('hidden');
    if (!won) sfx.lose();
    // The room rotates maps on its own a few seconds after the final capture.
    if (this.mode !== 'client') this._rotateT = 7;
  }

  // Next map in the rotation for the CURRENT mode: a host pin wins if it's
  // mode-compatible, otherwise cycle the maps that support this mode.
  _nextMap() {
    if (this.mapLock != null && MAPS[this.mapLock].modes.includes(this.gameMode))
      return this.mapLock;
    const pool = mapsForMode(this.gameMode);
    return pool[(pool.indexOf(this.mapIndex) + 1) % pool.length];
  }

  _rotate() {
    const map = this._nextMap();
    const seed = Math.floor(Math.random() * 1e9);
    if (this.mode === 'host')
      this.net.broadcast({ t: 'e', k: 'restart', map, seed });
    this.rebuild(seed, map);
    this.onRestart?.(MAPS[map].name);
  }

  // ---------------- host networking ----------------
  hostOnData(id, d) {
    // Matchmaking probe: answer on the same channel, before any join logic.
    if (d.t === 'ping') {
      // Room-browser probe: everything the list row wants to show.
      this.net.sendTo(id, { t: 'pong', humans: this.remote.size + 1, max: MAX_HUMANS,
        map: this.mapIndex, mode: this.gameMode,
        g: this.captures.green, b: this.captures.blue,
        names: [this.player.name, ...[...this.remote.values()].map(p => p.name)].slice(0, 8) });
      return;
    }
    if (d.t === 'hi') {
      if (this.remote.has(id)) return; // duplicate hello (channel re-announce)
      const row = this._migRoster?.get(id);
      if (row) { // a survivor finding the new room: restore, don't respawn
        const p = this._restoreProxy(id, cleanName(d.name), row);
        this._migRoster.delete(id);
        this.net.sendTo(id, { t: 'w', id, team: p.team, migrated: 1, mode: this.gameMode });
        this.feed(`${nameSpan(p)} rejoined ${p.team.toUpperCase()}`);
        return;
      }
      return this._hostAddPlayer(id, cleanName(d.name));
    }
    const p = this.remote.get(id);
    if (!p) return;
    if (d.t === 'a' && d.k === 'chat') return this._hostOnChat(id, d.text, d.scope);
    if (d.t === 's') {
      // Finite + bounded: a NaN here poisons every distance check downstream.
      if (![d.x, d.y, d.z, d.yaw].every(Number.isFinite)) return;
      p.body.pos.set(
        Math.min(Math.max(d.x, 0), SX), Math.min(Math.max(d.y, -8), SY + 8),
        Math.min(Math.max(d.z, 0), SZ));
      p.tool = d.tool;
      p.yaw = d.yaw;
      p.crouched = !!d.c;
      p.avatar.push(p.body.pos.x, p.body.pos.y, p.body.pos.z, p.yaw);
    } else if (d.t === 'a' && p.alive && !this.over) {
      if (!finite3(d.o) || !finite3(d.d)) return;
      const o = v3(d.o), dir = v3(d.d).normalize();
      // Sanity: actions must originate near the proxy's known position.
      if (o.distanceToSquared(p.body.eye()) > 25) return;
      // Rate-limit by the tool's own interval (60% floor for frame jitter):
      // an honest client paces itself — a patched one must not get
      // per-packet full-auto, a shovel blender, or a grenade sprinkler.
      const now = this.time, gap = k => now - (p._actT[k] ?? -9);
      if (d.k === 'shoot') {
        const spec = TOOLS[d.tool];
        if (!spec?.damage || gap('shoot') < spec.interval * 0.6) return;
        p._actT.shoot = now;
        this.fireHitscan(p, o, dir, spec);
      }
      else if (d.k === 'dig') {
        if (gap('dig') < 0.2) return;
        p._actT.dig = now;
        this.playerDig(p, o, dir);
      }
      else if (d.k === 'place') {
        if (gap('place') < 0.12) return;
        p._actT.place = now;
        this.playerPlace(p, o, dir); // tryBuild enforces the block count
      }
      else if (d.k === 'nade') {
        if (gap('nade') < 0.6 || p.nades <= 0) return;
        p._actT.nade = now;
        p.nades--;
        this.throwGrenade(p, o, dir, 13);
      }
    }
  }

  _hostAddPlayer(id, name) {
    if (this.remote.size + 1 >= MAX_HUMANS) { // room full — turn them away politely
      this.net.sendTo(id, { t: 'full' });
      setTimeout(() => this.net.conns.get(id)?.close(), 400); // let the packet land
      return;
    }
    name = String(name ?? '').replace(/[^\w \-]/g, '').trim().slice(0, 12) || 'recruit';
    // Count the host on its ACTUAL team: after a baton pass the promoted
    // host can be blue, and hardcoding green stacked every joiner wrong.
    const humans = { green: 0, blue: 0 };
    humans[this.player.team] = 1;
    for (const p of this.remote.values()) humans[p.team]++;
    const team = humans.green <= humans.blue ? 'green' : 'blue';
    const proxy = new RemoteProxy(this, id, name, team);
    this.remote.set(id, proxy);
    this._kdRow(proxy); // scoreboard seat from the moment they join
    this._removeBot(team);
    this.net.sendTo(id, { t: 'w', id, team, seed: this.seed, map: this.mapIndex, log: this.editLog, mode: this.gameMode });
    this.feed(`${nameSpan(proxy)} joined ${team.toUpperCase()}`);
  }

  // Where a team's home stand is — the flag stand in CTF, the base plateau
  // in deathmatch (which has no flags). Bots navigate by this either way.
  standOf(team) {
    if (this.flags) return this.flags[team].standPos();
    const b = BASE[team].flag;
    return new THREE.Vector3(b.x + 0.5, b.y, b.z + 0.5);
  }

  // ---------------- host migration ----------------
  // The host dropped and the election picked us: promote this client's
  // replica into the authoritative simulation. World, scores, flags, and
  // the edit log are already snapshot-synced; players and bots get real
  // host-side bodies restored to their last replicated state, so the match
  // just… keeps going.
  promoteToHost(net) {
    const oldId = this.myId;
    this.mode = 'host';
    this.net = net;
    this.myId = 'HOST';
    // Client stand-in avatars give way to real bodies — RemoteProxy and Bot
    // construct their own.
    for (const av of this.avatars.values()) av.dispose();
    this.avatars.clear();
    this._migRoster = new Map();
    for (const e of this._roster ?? []) {
      const [id, , name] = e;
      if (id === 'HOST' || id === oldId) continue;
      this._migRoster.set(id, e);
      this._restoreProxy(id, name, e);
    }
    for (const r of this._botRows ?? []) {
      const [, name, team, x, y, z, , health, alive, carrier] = r;
      const bot = new Bot(this, team, name);
      bot.body.pos.set(x, y, z);
      bot.body.vel.set(0, 0, 0);
      bot.health = health;
      bot.carrier = !!carrier;
      if (!alive) {
        bot.alive = false;
        bot.deadT = 1.5; // corpse already finished tumbling on our screen
        bot.parts.group.visible = false;
        this.respawnTimers.set(bot, REDEPLOY);
      }
      this.bots.push(bot);
    }
    // Snapshots record that a flag is carried, not by whom — reattach it to
    // whoever on the enemy team was flagged as carrier. If the carrier was
    // the departed host, the flag drops where it was.
    for (const team of ['green', 'blue']) {
      const f = this.flags?.[team];
      if (f && f.state === 'carried') {
        const c = this.entities().find(e => e.carrier && e.team === this.enemyOf(team));
        if (c) f.carrier = c;
        else { f.state = 'dropped'; f.carrier = null; f.dropTimer = 30; }
      }
    }
    // The hill keeps its owner and capture progress across the handover.
    if (this.hill && this._hillRow) {
      this.hill.owner = this._hillRow[0];
      this.hill.progress = this._hillRow[1];
      this.hill.capTeam = this._hillRow[3];
    }
    // A death mid-handover still gets its respawn; a finished match still
    // gets its rotation.
    if (!this.player.alive) this.respawnTimers.set(this.player, REDEPLOY);
    if (this.over) this._rotateT = 2;
    // Stragglers get a minute to find the new room before their roster entry
    // lapses and any later knock is treated as a fresh join.
    setTimeout(() => { this._migRoster = null; }, 60000);
  }

  // Rebuild one RemoteProxy from its last snapshot row.
  _restoreProxy(id, name, row) {
    const [, team, , x, y, z, ry, health, alive, carrier, tool, blocks, crouch] = row;
    const proxy = new RemoteProxy(this, id, name, team);
    proxy.body.pos.set(x, y, z);
    proxy.avatar.push(x, y, z, ry);
    proxy.health = health;
    proxy.alive = !!alive;
    proxy.carrier = !!carrier;
    proxy.tool = tool;
    proxy.blocks = blocks;
    proxy.crouched = !!crouch;
    if (!proxy.alive) this.respawnTimers.set(proxy, REDEPLOY);
    this.remote.set(id, proxy);
    return proxy;
  }

  hostOnLeave(id) {
    const p = this.remote.get(id);
    if (!p) return;
    if (p.carrier && this.flags) {
      p.carrier = false;
      this.flags[this.enemyOf(p.team)].drop(p.body.pos.clone());
    }
    this.feed(`${nameSpan(p)} left the battle`);
    p.avatar.dispose();
    this.remote.delete(id);
    this.respawnTimers.delete(p);
    if (!this.over) this.bots.push(new Bot(this, p.team));
  }

  _removeBot(team) {
    const i = this.bots.findIndex(b => b.team === team);
    if (i < 0) return;
    const [b] = this.bots.splice(i, 1);
    disposeObject(b.parts.group);
    this.respawnTimers.delete(b);
  }

  snapshot() {
    const ry = yaw => Math.atan2(-Math.cos(yaw), Math.sin(yaw)); // our yaw -> model rotation
    const P = [['HOST', this.player.team, this.player.name, ...arr(this.player.body.pos),
      ry(this.player.yaw), Math.round(this.player.health), this.player.alive ? 1 : 0,
      this.player.carrier ? 1 : 0, this.player.tool, this.player.blocks,
      this.player.crouched ? 1 : 0]];
    for (const p of this.remote.values())
      P.push([p.id, p.team, p.name, ...arr(p.body.pos), p.yaw, Math.round(p.health),
        p.alive ? 1 : 0, p.carrier ? 1 : 0, p.tool, p.blocks, p.crouched ? 1 : 0]);
    return {
      t: 's',
      p: P,
      b: this.bots.map(b => [b.id, b.name, b.team, ...arr(b.body.pos),
        b.parts.group.rotation.y, Math.round(b.health), b.alive ? 1 : 0, b.carrier ? 1 : 0,
        b.parts.crouched ? 1 : 0]), // crouch bit: clients drew ducking bots standing
      f: this.flags && {
        g: [FLAG_CODE[this.flags.green.state], ...arr(this.flags.green.pos), Math.ceil(this.flags.green.dropTimer)],
        b: [FLAG_CODE[this.flags.blue.state], ...arr(this.flags.blue.pos), Math.ceil(this.flags.blue.dropTimer)],
      },
      h: this.hill && [this.hill.owner, Math.round(this.hill.progress * 10) / 10,
        this.hill.contested ? 1 : 0, this.hill.capTeam],
      c: [Math.round(this.captures.green * 10) / 10, Math.round(this.captures.blue * 10) / 10],
      g: this.grenades.map(g => arr(g.pos)),
      o: this.over ? 1 : 0,
    };
  }

  // ---------------- client networking ----------------
  clientOnData(d) {
    this.lastRecv = performance.now(); // host heartbeat (snapshots beat at 12Hz)
    if (d.t === 'full') return this.onFull?.();
    if (d.t === 'w') {
      this.myId = d.id;
      this.player.team = d.team;
      if (d.mode) this.gameMode = d.mode; // rebuild below needs it (flagless TDM)
      if (d.migrated) {
        // Baton-pass rejoin: we never left — keep the world, position, and
        // kit we already have; the new host corrects drift via snapshots.
        this.onWelcome?.();
      } else {
        this.rebuild(d.seed, d.map ?? 0);
        this.editLog = d.log; // kept current below: migration hosting needs it
        for (const e of d.log) {
          if (e[0] === 'b') this.world.carve(Math.floor(e[1]), Math.floor(e[2]), Math.floor(e[3]), e[4]);
          else this.world.set(e[0], e[1], e[2], e[3]);
        }
        this.onWelcome?.();
      }
    } else if (d.t === 's') this._clientSnapshot(d);
    else if (d.t === 'e') this._clientEvent(d);
  }

  _clientSnapshot(d) {
    // Keep the raw rows: if the host drops, any client may be elected to
    // rebuild the authoritative sim from exactly this state.
    this._roster = d.p;
    this._botRows = d.b;
    const seen = new Set();
    for (const e of d.p) {
      const [id, team, name, x, y, z, ry, health, alive, carrier, tool, blocks, crouch] = e;
      if (id === this.myId) {
        if (!alive && this.player.alive) this._clientDied();
        if (health < this._lastHealth) { hud.damage(); sfx.hurt(); }
        this._lastHealth = health;
        this.player.health = health;
        this.player.blocks = blocks;
        this.player.carrier = !!carrier;
        hud.health(this.player);
        if (this.player.tool === 3) hud.refreshTool(this.player);
        continue;
      }
      seen.add(id);
      let av = this.avatars.get(id);
      if (!av) { av = new Avatar(this.scene, team, cleanName(name)); this.avatars.set(id, av); }
      av.setAlive(!!alive);
      av.setCrouch(!!crouch);
      av.push(x, y, z, ry);
    }
    for (const b of d.b) {
      const key = 'b' + b[0];
      seen.add(key);
      let av = this.avatars.get(key);
      if (!av) { av = new Avatar(this.scene, b[2], b[1]); this.avatars.set(key, av); }
      av.setAlive(!!b[7]);
      av.setCrouch?.(!!b[10]); // host shrinks ducking bots; draw them that way
      av.push(b[3], b[4], b[5], b[6]);
    }
    // Anything not in this snapshot is gone (left the room / bot swapped out).
    for (const [key, av] of this.avatars) {
      if (!seen.has(key)) { av.dispose(); this.avatars.delete(key); }
    }
    const stateName = ['home', 'carried', 'dropped'];
    if (d.f && this.flags)
      for (const team of ['green', 'blue']) {
        const f = d.f[team[0]], flag = this.flags[team];
        flag.state = stateName[f[0]];
        flag.pos.set(f[1], f[2], f[3]);
        flag.dropTimer = f[4];
      }
    this._hillRow = d.h ?? null; // kept raw: a promoted replica restores it
    if (d.h && this.hill) {
      this.hill.owner = d.h[0];
      this.hill.progress = d.h[1];
      this.hill.contested = !!d.h[2];
      this.hill.capTeam = d.h[3];
    }
    this.captures.green = d.c[0];
    this.captures.blue = d.c[1];
    hud.score(this);
    const limit = this.gameMode === 'tdm' ? KILL_LIMIT
      : this.gameMode === 'koth' ? HOLD_LIMIT : WIN_SCORE;
    if (d.o && !this.over) this._end(d.c[0] >= limit ? 'green' : 'blue');
    this._lastGrenades = d.g;
  }

  _clientEvent(d) {
    switch (d.k) {
      case 'edit':
        this.world.set(d.x, d.y, d.z, d.v);
        this.editLog.push([d.x, d.y, d.z, d.v]); // migration: late joiners get it from us
        break;
      case 'boom':
        this.explodeAt(d.x, d.y, d.z, d.r);
        this.editLog.push(['b', d.x, d.y, d.z, d.r]);
        break;
      case 'col': { // host collapsed a structure: replay removal + dust only
        const cells = [];
        for (let i = 0; i + 2 < d.cells.length; i += 3) {
          const x = d.cells[i] | 0, y = d.cells[i + 1] | 0, z = d.cells[i + 2] | 0;
          const v = this.world.get(x, y, z);
          if (!v) continue;
          this.world.set(x, y, z, 0);
          this.editLog.push([x, y, z, 0]); // migration: we host next, maybe
          cells.push({ x, y, z, v });
        }
        if (cells.length) {
          this.effects.blockBurst(cells.filter((_, i) => i % Math.ceil(cells.length / 48) === 0));
          sfx.crumble();
        }
        break;
      }
      case 'shot':
        if (d.sid !== this.myId) this.shotFx(v3(d.f), v3(d.e), d.hit, d.hex, v3(d.f));
        break;
      case 'feed': hud.feed(safeFeedHtml(d.html)); break;
      case 'msg':
        if (!d.team || d.team === this.player.team) hud.message(d.text, d.color);
        break;
      case 'hit': sfx.hit(); hud.hitmark(); break;
      case 'chat':
        hud.chatMsg({ name: cleanName(d.name), team: d.team === 'blue' ? 'blue' : 'green',
                      text: String(d.text ?? '').slice(0, 120), scope: d.scope });
        break;
      case 'died': this._clientDied(); break;
      case 'spawn':
        this.player.respawn({ x: d.x, y: d.y, z: d.z });
        hud.respawn(0); hud.health(this.player); hud.refreshTool(this.player);
        this._lastHealth = 100;
        break;
      case 'kd': // host's scoreboard, replaced wholesale on each death
        this.kd = new Map((d.rows || []).map(r =>
          [cleanName(r[0]), { team: r[1] === 'blue' ? 'blue' : 'green',
                              k: r[2] | 0, d: r[3] | 0 }]));
        hud.statsRefresh(this);
        break;
      case 'end': this._end(d.winner); break;
      case 'restart':
        this.rebuild(d.seed, d.map);
        this.onRestart?.(MAPS[d.map].name);
        break;
    }
  }

  _clientDied() {
    this.player.alive = false;
    this._respawnT = 10; // mirrors the host's human redeploy timer
    sfx.hurt();
    hud.damage();
    hud.respawn(10);
  }

  // Menu-open clients skip update() entirely (the frame loop freezes their
  // world), but the watchdog must keep ticking or a host dropping mid-Esc
  // is never detected.
  clientIdleTick() {
    if (this.lastRecv && performance.now() - this.lastRecv > 4000)
      this.onHostSilent?.();
  }

  _clientUpdate(dt) {
    // Host-drop watchdog: a host whose tab is killed (or network unplugged)
    // never sends a close frame — WebRTC silence is the only signal, and ICE
    // can take ages to give up on its own. Snapshots beat at 12Hz; four
    // seconds of silence means the host is gone and the baton must pass.
    this.clientIdleTick();
    // Cosmetic redeploy countdown — the host's 'rs' event is the real one.
    if (!this.player.alive && this._respawnT > 0) {
      this._respawnT -= dt;
      if (this._respawnT > 0) hud.respawn(this._respawnT);
    }
    if (this.player.alive) this.player.update(dt);
    else this.player.deathCam(dt);
    for (const av of this.avatars.values()) av.update(this.time);
    this._sendT -= dt;
    if (this._sendT <= 0 && this.net) {
      this._sendT = 1 / 15;
      const p = this.player;
      this.net.send({ t: 's', x: p.body.pos.x, y: p.body.pos.y, z: p.body.pos.z,
        yaw: Math.atan2(-Math.cos(p.yaw), Math.sin(p.yaw)), tool: p.tool,
        c: p.crouched ? 1 : 0 });
    }
    if (this.flags) for (const team of ['green', 'blue']) this.flags[team].clientUpdate(this.time);
    for (let i = 0; i < this.grenadeMeshes.length; i++) {
      const g = this._lastGrenades?.[i], m = this.grenadeMeshes[i];
      m.visible = !!g;
      if (g) m.position.set(g[0], g[1], g[2]);
    }
    this._shakeCamera();
    this.effects.update(dt);
  }

  // Camera shake rides on top of whatever the player camera did.
  _shakeCamera() {
    if (this.effects.shake <= 0.001) return;
    const s = this.effects.shake;
    this.camera.position.x += (Math.random() - .5) * s * 0.4;
    this.camera.position.y += (Math.random() - .5) * s * 0.4;
    this.camera.rotation.z = (Math.random() - .5) * s * 0.05;
  }

  // ---------------- main tick ----------------
  update(dt) {
    this.time += dt;
    this.world.animateSky(this.time);
    hud.minimap(this);
    if (this.mode === 'client') { this._clientUpdate(dt); this.world.flushDirty(); return; }

    if (this.player.alive) this.player.update(dt);
    else this.player.deathCam(dt);
    for (const b of this.bots) b.update(dt);

    // Respawns.
    for (const [e, t] of this.respawnTimers) {
      const nt = t - dt;
      if (nt <= 0) {
        this.respawnTimers.delete(e);
        e.respawn();
        if (e === this.player) { hud.respawn(0); hud.health(this.player); hud.refreshTool(this.player); }
      } else {
        this.respawnTimers.set(e, nt);
        if (e === this.player) hud.respawn(nt);
      }
    }

    if (!this.over) {
      this._updateGrenades(dt);
      if (this.flags) this._updateFlags(dt);
      if (this.hill) this._updateHill(dt);
    } else if (this._rotateT != null) {
      this._rotateT -= dt;
      if (this._rotateT <= 0) { this._rotateT = null; this._rotate(); }
    }

    if (this.mode === 'host') {
      for (const p of this.remote.values()) {
        p.avatar.setAlive(p.alive);
        p.avatar.setCrouch?.(!!p.crouched);
        // Crouching guests get the same hitbox as everyone else: the proxy
        // body was staying full height, so a crouched guest was drawn short
        // but shot tall. Same lerp the bots use.
        p.body.half.h += ((p.crouched ? 1.15 : 1.75) - p.body.half.h) * Math.min(1, dt * 10);
        // Grenade trickle, same terms as a local player: +1 per 12s, cap 3.
        if (p.nades < 3 && (p.nadeRegen += dt) > 12) { p.nadeRegen = 0; p.nades++; }
        p.avatar.update(this.time);
      }
      this._snapT -= dt;
      if (this._snapT <= 0) {
        this._snapT = 1 / 12;
        this.net.broadcast(this.snapshot());
      }
    }

    // Camera shake rides on top of whatever the player camera did.
    this._shakeCamera();
    this.effects.update(dt);
    // One remesh pass per frame: single-voxel set() calls queue their chunks
    // here instead of each synchronously rebuilding up to 5 of them.
    this.world.flushDirty();
  }
}

// Ray vs upright cylinder (torso) + sphere (head). Returns { t, head } or null.
function rayVsSoldier(origin, dir, body) {
  const cx = body.pos.x, cz = body.pos.z;
  const ox = origin.x - cx, oz = origin.z - cz;
  const a = dir.x * dir.x + dir.z * dir.z;
  const y0 = body.pos.y, y1 = body.pos.y + body.half.h;
  let t = null;

  if (a > 1e-6) {
    const bq = 2 * (ox * dir.x + oz * dir.z);
    const cq = ox * ox + oz * oz - 0.42 * 0.42;
    const disc = bq * bq - 4 * a * cq;
    if (disc >= 0) {
      const t0 = (-bq - Math.sqrt(disc)) / (2 * a);
      if (t0 > 0) {
        const y = origin.y + dir.y * t0;
        if (y >= y0 && y <= y1) t = t0;
      }
    }
  }
  // Head sphere.
  const hy = y1 - 0.18;
  const hx = origin.x - cx, hyy = origin.y - hy, hz = origin.z - cz;
  const bh = 2 * (hx * dir.x + hyy * dir.y + hz * dir.z);
  const ch = hx * hx + hyy * hyy + hz * hz - 0.34 * 0.34;
  const dh = bh * bh - 4 * ch;
  if (dh >= 0) {
    const t0 = (-bh - Math.sqrt(dh)) / 2;
    if (t0 > 0 && (t === null || t0 < t)) return { t: t0, head: true };
  }
  return t === null ? null : { t, head: false };
}
