// game.js — orchestration: combat, flags, grenades, score, HUD.
import * as THREE from 'three';
import { VoxelWorld, SEA, BLOCK, PALETTE } from './world.js';
import { generateMap, BASE } from './mapgen.js';
import { Player, TOOLS } from './player.js';
import { Bot } from './bots.js';
import { Effects } from './effects.js';
import { sfx } from './audio.js';

const WIN_SCORE = 3;
const $ = id => document.getElementById(id);

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

// ---------------------------------------------------------------- game
export class Game {
  constructor(scene, camera, dom) {
    this.scene = scene;
    this.camera = camera;
    this.time = 0;
    this.over = false;

    this.world = new VoxelWorld(scene);
    generateMap(this.world);
    this.effects = new Effects(scene);
    this.player = new Player(this, camera, dom);
    this.player.name = 'You';
    this.hud = hud;

    this.bots = [];
    for (let i = 0; i < 4; i++) this.bots.push(new Bot(this, 'blue'));
    for (let i = 0; i < 3; i++) this.bots.push(new Bot(this, 'green'));

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

  enemyOf(team) { return team === 'blue' ? 'green' : 'blue'; }

  entities() { return [this.player, ...this.bots]; }
  foesOf(team) { return this.entities().filter(e => e.team !== team); }

  spawnPoint(team) {
    const b = BASE[team];
    const dir = team === 'green' ? 1 : -1; // just outside the gate, facing the field
    const x = b.x + dir * 12 + (Math.random() - 0.5) * 5;
    const z = b.z + (Math.random() - 0.5) * 6;
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
    this.effects.tracer(muzzle, end);

    if (shooter !== this.player) {
      if (from.distanceTo(this.player.body.pos) < 55) sfx.smg();
    }

    if (hit) {
      const dmg = spec.damage * (head ? (spec.headMult ?? 1.5) : 1);
      this.effects.burst(end, 10, 0xc0392b, 4);
      if (shooter === this.player) { sfx.hit(); hud.hitmark(); }
      this.damage(hit, dmg, shooter);
    } else if (voxel) {
      const hex = PALETTE[this.world.get(voxel.x, voxel.y, voxel.z)].color;
      this.effects.burst(end, 6, hex, 3);
    }
  }

  damage(victim, amount, attacker) {
    if (!victim.alive || this.over) return;
    victim.health -= amount;
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
  digVoxel(who, x, y, z) {
    const v = this.world.get(x, y, z);
    if (!v) return;
    this.world.set(x, y, z, 0);
    this.effects.blockBurst([{ x, y, z, v }]);
    if (who === this.player) {
      this.player.blocks = Math.min(99, this.player.blocks + 1);
      sfx.dig();
      hud.refreshTool(this.player);
    }
  }

  playerDig(p) {
    const hit = this.world.raycast(p.body.eye(), p.lookDir(), 5);
    // Spade doubles as a melee weapon.
    for (const e of this.foesOf(p.team)) {
      if (e.alive && e.body.eye().distanceTo(p.body.eye()) < 3.2) {
        this.effects.burst(e.body.eye(), 10, 0xc0392b, 4);
        sfx.hit(); hud.hitmark();
        this.damage(e, 45, p);
        return;
      }
    }
    if (hit) this.digVoxel(p, hit.x, hit.y, hit.z);
    else sfx.dig();
  }

  playerPlace(p) {
    if (p.blocks <= 0) { sfx.click(); return; }
    const hit = this.world.raycast(p.body.eye(), p.lookDir(), 6);
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
    this.world.set(x, y, z, BLOCK.GREEN);
    p.blocks--;
    sfx.place();
    hud.refreshTool(p);
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
    this.effects.explode(g.pos);
    sfx.explosion();
    const r = 3.6;
    const removed = this.world.carve(
      Math.floor(g.pos.x), Math.floor(g.pos.y), Math.floor(g.pos.z), r);
    this.effects.blockBurst(removed);
    const dp = g.pos.distanceTo(this.player.body.pos);
    this.effects.addShake(Math.max(0, 0.5 - dp * 0.012));
    for (const e of this.entities()) {
      if (!e.alive) continue;
      const d = g.pos.distanceTo(e.body.eye());
      if (d < 7) this.damage(e, Math.max(15, 130 * (1 - d / 7)), g.owner);
    }
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
        hud.feed(`${nameSpan(e)} took the ${this.enemyOf(e.team).toUpperCase()} flag`);
        if (e === this.player) hud.message('YOU HAVE THE FLAG — RUN HOME!', '#ffd97a');
        else if (e.team === 'blue') hud.message('ENEMY HAS OUR FLAG!', '#e74c3c');
      }
      // Touching your own dropped flag sends it home.
      if (ownFlag.state === 'dropped' && e.body.pos.distanceTo(ownFlag.pos) < 1.9) {
        ownFlag.returnHome();
        hud.feed(`${nameSpan(e)} returned the ${e.team.toUpperCase()} flag`);
        if (e === this.player) hud.message('FLAG RETURNED', '#8fd98f');
      }
      // Capture: reach your stand with the enemy flag while yours is home.
      if (e.carrier && ownFlag.state === 'home' &&
          e.body.pos.distanceTo(ownFlag.home) < 3.2) {
        e.carrier = false;
        this.captures[e.team]++;
        enemyFlag.returnHome();
        sfx.capture();
        hud.feed(`${nameSpan(e)} <b>CAPTURED</b> the flag`);
        hud.message(e.team === 'green' ? 'CAPTURE! GREEN SCORES' : 'BLUE SCORES',
          e.team === 'green' ? '#8fd98f' : '#e74c3c');
        hud.score(this);
        if (this.captures[e.team] >= WIN_SCORE) this._end(e.team);
      }
    }
    hud.score(this);
  }

  _end(winner) {
    this.over = true;
    document.exitPointerLock();
    $('hud').classList.remove('on');
    $('endTitle').textContent = winner === 'green' ? 'VICTORY' : 'DEFEAT';
    $('endTitle').style.color = winner === 'green' ? '#8fd98f' : '#e74c3c';
    $('endDetail').textContent =
      `${winner.toUpperCase()} wins ${this.captures.green} — ${this.captures.blue}`;
    $('end').classList.remove('hidden');
    if (winner !== 'green') sfx.lose();
  }

  // ---------------- main tick ----------------
  update(dt) {
    this.time += dt;
    this.world.animateWater(this.time);

    if (this.player.alive) this.player.update(dt);
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

    // Camera shake rides on top of whatever the player camera did.
    if (this.effects.shake > 0.001) {
      const s = this.effects.shake;
      this.camera.position.x += (Math.random() - .5) * s * 0.4;
      this.camera.position.y += (Math.random() - .5) * s * 0.4;
      this.camera.rotation.z = (Math.random() - .5) * s * 0.05;
    }
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
