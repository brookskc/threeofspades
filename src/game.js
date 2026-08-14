// game.js — orchestration: combat, flags, grenades, score, HUD.
// Modes: 'solo' (local only), 'host' (authoritative, broadcasts), 'client' (thin).
import * as THREE from 'three';
import { VoxelWorld, SEA, BLOCK, PALETTE } from './world.js';
import { generateMap, BASE } from './mapgen.js';
import { Player, TOOLS } from './player.js';
import { Bot } from './bots.js';
import { Effects } from './effects.js';
import { sfx } from './audio.js';
import { Body, disposeObject } from './entities.js';
import { Avatar } from './avatar.js';

const WIN_SCORE = 3;
const $ = id => document.getElementById(id);
const v3 = a => new THREE.Vector3(a[0], a[1], a[2]);
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
    else if (t.key === 'spade') $('ammo').innerHTML = `∞`;
    else $('ammo').innerHTML = p.reloading > 0
      ? `<small>reloading…</small>`
      : `${p.ammo[p.tool]} <small>/ ${t.mag}</small>`;
    $('toolhint').textContent = `1 rifle · 2 smg · 3 spade · 4 block · G grenade ×${p.grenades}`;
  },
  health(p) {
    $('healthfill').style.width = Math.max(0, p.health) + '%';
    $('healthnum').textContent = Math.max(0, Math.ceil(p.health)) + ' HP';
    $('healthfill').style.background = p.health > 40
      ? 'linear-gradient(90deg,#5db85d,#8fd98f)' : 'linear-gradient(90deg,#c0392b,#e74c3c)';
  },
  score(g) {
    const next =
      `<span class="g">GREEN ${g.captures.green}</span><span style="opacity:.4">—</span><span class="b">${g.captures.blue} BLUE</span>`;
    if (next !== this._lastScore) { this._lastScore = next; $('score').innerHTML = next; }
    this._flagState(g);
  },
  _flagState(g) {
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
};

const nameSpan = e =>
  `<span style="color:${e.team === 'blue' ? '#8fa8ee' : '#8fd98f'}">${e.name}</span>`;

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
    this.remote = new Map();               // host: peerId -> RemoteProxy
    this.avatars = new Map();              // client: key -> Avatar
    this.myId = null;
    this._snapT = 0;
    this._sendT = 0;
    this._lastHealth = 100;

    this.world = new VoxelWorld(scene);
    generateMap(this.world, this.seed);
    this.effects = new Effects(scene);
    this.bots = [];                        // before Player: its first spawnPoint reads these
    this.player = new Player(this, camera, dom);
    this.player.name = opts.name ?? 'You';
    this.hud = hud;

    if (this.mode !== 'client') this._spawnBots();

    this.flags = { green: new Flag(this, 'green'), blue: new Flag(this, 'blue') };
    this.captures = { green: 0, blue: 0 };
    this.grenades = [];
    this.grenadeMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0x2e3b2e })
    );
    scene.add(this.grenadeMesh);
    this.respawnTimers = new Map();

    hud.refreshTool(this.player);
    hud.health(this.player);
    hud.score(this);
  }

  // Tear down and regenerate on a new seed (host room start / client welcome).
  rebuild(seed) {
    this.world.dispose();
    for (const b of this.bots) disposeObject(b.parts.group);
    for (const av of this.avatars.values()) av.dispose();
    this.avatars.clear();
    for (const t of ['green', 'blue']) this.flags[t].dispose();
    this.seed = seed;
    this.world = new VoxelWorld(this.scene);
    generateMap(this.world, seed);
    this.flags = { green: new Flag(this, 'green'), blue: new Flag(this, 'blue') };
    this.bots = [];
    if (this.mode !== 'client') this._spawnBots();
    this.captures = { green: 0, blue: 0 };
    this.editLog = [];
    this.grenades = [];
    this.grenadeMesh.visible = false;
    this.respawnTimers.clear();
    this.over = false;
    this._lastHealth = 100;
    this.player.respawn();
    hud.score(this);
  }

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
    const spread = spec.spread ?? 0;
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

  damage(victim, amount, attacker) {
    if (!victim.alive || this.over) return;
    victim.health -= amount;
    victim.alert?.(attacker); // bots whirl toward whoever shot them
    if (victim === this.player) { hud.damage(); sfx.hurt(); hud.health(this.player); }
    if (victim.health <= 0) victim.die(attacker);
  }

  onDeath(victim, killer) {
    // Flag drops where the carrier fell.
    const enemyFlag = this.flags[this.enemyOf(victim.team)];
    if (victim.carrier) {
      victim.carrier = false;
      enemyFlag.drop(victim.body.pos.clone());
      hud.feed(`${nameSpan(victim)} dropped the flag`);
      hud.message('FLAG DROPPED', '#ffd97a');
    }
    if (killer && killer !== victim) hud.feed(`${nameSpan(killer)} ⚔ ${nameSpan(victim)}`);
    else hud.feed(`${nameSpan(victim)} blew up`);

    if (victim === this.player) {
      this.respawnTimers.set(victim, 3);
      hud.respawn(3);
    } else {
      this.respawnTimers.set(victim, 4);
    }
  }

  // ---------------- block tools ----------------
  applyEdit(x, y, z, v) {
    this.world.set(x, y, z, v);
    if (this.mode === 'host') {
      this.editLog.push([x, y, z, v]);
      this.net.broadcast({ t: 'e', k: 'edit', x, y, z, v });
    }
  }

  digVoxel(who, x, y, z) {
    const v = this.world.get(x, y, z);
    if (!v) return;
    this.applyEdit(x, y, z, 0);
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
    if (this.world.get(x, y, z)) return;
    // Never entomb anyone (including yourself).
    for (const e of this.entities()) {
      if (!e.alive) continue;
      const b = e.body;
      if (x + 1 > b.pos.x - b.half.x && x < b.pos.x + b.half.x &&
          z + 1 > b.pos.z - b.half.x && z < b.pos.z + b.half.x &&
          y + 1 > b.pos.y && y < b.pos.y + b.half.h) return;
    }
    this.applyEdit(x, y, z, p.team === 'blue' ? BLOCK.BLUE : BLOCK.GREEN);
    p.blocks--;
    if (p === this.player) { sfx.place(); hud.refreshTool(p); }
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
    const g0 = this.grenades[0];
    this.grenadeMesh.visible = !!g0;
    if (g0) this.grenadeMesh.position.copy(g0.pos);
  }

  _explode(g) {
    const R = 2.4; // a modest divot: grenades maim players, not landscapes
    this.explodeAt(g.pos.x, g.pos.y, g.pos.z, R);
    if (this.mode === 'host') {
      this.editLog.push(['b', g.pos.x, g.pos.y, g.pos.z, R]);
      this.net.broadcast({ t: 'e', k: 'boom', x: g.pos.x, y: g.pos.y, z: g.pos.z, r: R });
    }
    for (const e of this.entities()) {
      if (!e.alive) continue;
      const d = g.pos.distanceTo(e.body.eye());
      if (d < 7) this.damage(e, Math.max(15, 130 * (1 - d / 7)), g.owner);
    }
  }

  // Visual + terrain side of an explosion — identical on host and clients.
  explodeAt(x, y, z, r) {
    const pos = new THREE.Vector3(x, y, z);
    this.effects.explode(pos);
    sfx.explosion();
    const removed = this.world.carve(Math.floor(x), Math.floor(y), Math.floor(z), r);
    this.effects.blockBurst(removed);
    this.effects.addShake(Math.max(0, 0.5 - pos.distanceTo(this.player.body.pos) * 0.012));
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

  _end(winner) {
    if (this.over) return;
    this.over = true;
    if (this.mode === 'host') this.net.broadcast({ t: 'e', k: 'end', winner });
    document.exitPointerLock();
    $('hud').classList.remove('on');
    const won = winner === this.player.team;
    $('endTitle').textContent = won ? 'VICTORY' : 'DEFEAT';
    $('endTitle').style.color = won ? '#8fd98f' : '#e74c3c';
    $('endDetail').textContent =
      `${winner.toUpperCase()} wins ${this.captures.green} — ${this.captures.blue}`;
    $('end').classList.remove('hidden');
    if (!won) sfx.lose();
  }

  // ---------------- host networking ----------------
  hostOnData(id, d) {
    if (d.t === 'hi') {
      if (this.remote.has(id)) return; // duplicate hello (channel re-announce)
      return this._hostAddPlayer(id, d.name);
    }
    const p = this.remote.get(id);
    if (!p) return;
    if (d.t === 's') {
      p.body.pos.set(d.x, d.y, d.z);
      p.tool = d.tool;
      p.yaw = d.yaw;
      p.avatar.push(d.x, d.y, d.z, d.yaw);
    } else if (d.t === 'a' && p.alive && !this.over) {
      const o = v3(d.o), dir = v3(d.d).normalize();
      // Sanity: actions must originate near the proxy's known position.
      if (o.distanceToSquared(p.body.eye()) > 25) return;
      if (d.k === 'shoot') {
        const spec = TOOLS[d.tool];
        if (spec?.damage) this.fireHitscan(p, o, dir, spec);
      }
      else if (d.k === 'dig') this.playerDig(p, o, dir);
      else if (d.k === 'place') this.playerPlace(p, o, dir);
      else if (d.k === 'nade') this.throwGrenade(p, o, dir, 13);
    }
  }

  _hostAddPlayer(id, name) {
    name = String(name ?? '').replace(/[^\w \-]/g, '').trim().slice(0, 12) || 'recruit';
    const humans = { green: 1, blue: 0 }; // host is green
    for (const p of this.remote.values()) humans[p.team]++;
    const team = humans.green <= humans.blue ? 'green' : 'blue';
    const proxy = new RemoteProxy(this, id, name, team);
    this.remote.set(id, proxy);
    this._removeBot(team);
    this.net.sendTo(id, { t: 'w', id, team, seed: this.seed, log: this.editLog });
    this.feed(`${nameSpan(proxy)} joined ${team.toUpperCase()}`);
  }

  hostOnLeave(id) {
    const p = this.remote.get(id);
    if (!p) return;
    if (p.carrier) {
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
      this.player.carrier ? 1 : 0, this.player.tool, this.player.blocks]];
    for (const p of this.remote.values())
      P.push([p.id, p.team, p.name, ...arr(p.body.pos), p.yaw, Math.round(p.health),
        p.alive ? 1 : 0, p.carrier ? 1 : 0, p.tool, p.blocks]);
    return {
      t: 's',
      p: P,
      b: this.bots.map(b => [b.id, b.name, b.team, ...arr(b.body.pos),
        b.parts.group.rotation.y, Math.round(b.health), b.alive ? 1 : 0, b.carrier ? 1 : 0]),
      f: {
        g: [FLAG_CODE[this.flags.green.state], ...arr(this.flags.green.pos), Math.ceil(this.flags.green.dropTimer)],
        b: [FLAG_CODE[this.flags.blue.state], ...arr(this.flags.blue.pos), Math.ceil(this.flags.blue.dropTimer)],
      },
      c: [this.captures.green, this.captures.blue],
      g: this.grenades.map(g => arr(g.pos)),
      o: this.over ? 1 : 0,
    };
  }

  // ---------------- client networking ----------------
  clientOnData(d) {
    if (d.t === 'w') {
      this.myId = d.id;
      this.player.team = d.team;
      this.rebuild(d.seed);
      for (const e of d.log) {
        if (e[0] === 'b') this.world.carve(Math.floor(e[1]), Math.floor(e[2]), Math.floor(e[3]), e[4]);
        else this.world.set(e[0], e[1], e[2], e[3]);
      }
      this.onWelcome?.();
    } else if (d.t === 's') this._clientSnapshot(d);
    else if (d.t === 'e') this._clientEvent(d);
  }

  _clientSnapshot(d) {
    const seen = new Set();
    for (const e of d.p) {
      const [id, team, name, x, y, z, ry, health, alive, carrier, tool, blocks] = e;
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
      if (!av) { av = new Avatar(this.scene, team, name); this.avatars.set(id, av); }
      av.setAlive(!!alive);
      av.push(x, y, z, ry);
    }
    for (const b of d.b) {
      const key = 'b' + b[0];
      seen.add(key);
      let av = this.avatars.get(key);
      if (!av) { av = new Avatar(this.scene, b[2], b[1]); this.avatars.set(key, av); }
      av.setAlive(!!b[7]);
      av.push(b[3], b[4], b[5], b[6]);
    }
    // Anything not in this snapshot is gone (left the room / bot swapped out).
    for (const [key, av] of this.avatars) {
      if (!seen.has(key)) { av.dispose(); this.avatars.delete(key); }
    }
    const stateName = ['home', 'carried', 'dropped'];
    for (const team of ['green', 'blue']) {
      const f = d.f[team[0]], flag = this.flags[team];
      flag.state = stateName[f[0]];
      flag.pos.set(f[1], f[2], f[3]);
      flag.dropTimer = f[4];
    }
    this.captures.green = d.c[0];
    this.captures.blue = d.c[1];
    hud.score(this);
    if (d.o && !this.over) this._end(d.c[0] >= WIN_SCORE ? 'green' : 'blue');
    this._lastGrenades = d.g;
  }

  _clientEvent(d) {
    switch (d.k) {
      case 'edit': this.world.set(d.x, d.y, d.z, d.v); break;
      case 'boom': this.explodeAt(d.x, d.y, d.z, d.r); break;
      case 'shot':
        if (d.sid !== this.myId) this.shotFx(v3(d.f), v3(d.e), d.hit, d.hex, v3(d.f));
        break;
      case 'feed': hud.feed(d.html); break;
      case 'msg':
        if (!d.team || d.team === this.player.team) hud.message(d.text, d.color);
        break;
      case 'hit': sfx.hit(); hud.hitmark(); break;
      case 'died': this._clientDied(); break;
      case 'spawn':
        this.player.respawn({ x: d.x, y: d.y, z: d.z });
        hud.respawn(0); hud.health(this.player); hud.refreshTool(this.player);
        this._lastHealth = 100;
        break;
      case 'end': this._end(d.winner); break;
    }
  }

  _clientDied() {
    this.player.alive = false;
    sfx.hurt();
    hud.damage();
    $('respawn').style.opacity = 1;
    $('respawn').textContent = 'REDEPLOYING…';
  }

  _clientUpdate(dt) {
    if (this.player.alive) this.player.update(dt);
    else this.player.deathCam(dt);
    for (const av of this.avatars.values()) av.update(this.time);
    this._sendT -= dt;
    if (this._sendT <= 0 && this.net) {
      this._sendT = 1 / 15;
      const p = this.player;
      this.net.send({ t: 's', x: p.body.pos.x, y: p.body.pos.y, z: p.body.pos.z,
        yaw: Math.atan2(-Math.cos(p.yaw), Math.sin(p.yaw)), tool: p.tool });
    }
    for (const team of ['green', 'blue']) this.flags[team].clientUpdate(this.time);
    const g0 = this._lastGrenades?.[0];
    this.grenadeMesh.visible = !!g0;
    if (g0) this.grenadeMesh.position.set(g0[0], g0[1], g0[2]);
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
    this.world.animateWater(this.time);
    if (this.mode === 'client') return this._clientUpdate(dt);

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
      this._updateFlags(dt);
    }

    if (this.mode === 'host') {
      for (const p of this.remote.values()) {
        p.avatar.setAlive(p.alive);
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
