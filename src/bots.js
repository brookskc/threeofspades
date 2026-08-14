// bots.js — AI soldiers: they hunt the flag, fight back, and dig through walls.
import * as THREE from 'three';
import { Body, makeSoldier, animateSoldier, animateDeath, resetDeath } from './entities.js';

const NAMES = {
  blue:  ['Vex', 'Havoc', 'Irons', 'Dagger', 'Rook', 'Frost'],
  green: ['Sarge', 'Pine', 'Moss', 'Flint', 'Clover', 'Briar'],
};
const GUN = { damage: 16, headMult: 1.5, interval: 0.14, spread: 0.035, mag: 24, reload: 2.0 };

let n = 0;        // name rotation
let nextId = 0;   // stable identity for network snapshots

export class Bot {
  constructor(game, team) {
    this.game = game;
    this.team = team;
    this.id = nextId++;
    this.name = NAMES[team][n++ % NAMES[team].length];
    const p = game.spawnPoint(team);
    this.body = new Body(game.world, p.x, p.y, p.z);
    this.parts = makeSoldier(team === 'blue' ? 0x4a6cd4 : 0x4a9e4a);
    game.scene.add(this.parts.group);
    this.health = 100;
    this.alive = true;
    this.carrier = false;
    this.heading = team === 'blue' ? -1 : 1; // general advance direction
    this.state = 'advance';
    this.target = null;        // enemy entity currently engaged
    this.aimT = 0;             // reaction timer after acquiring target
    this.cooldown = Math.random();
    this.ammo = GUN.mag;
    this.reloading = 0;
    this.stuck = 0;            // consecutive motionless samples
    this.sampleT = 0.4;        // displacement sampling timer
    this.lastPos = this.body.pos.clone();
    this.wander = new THREE.Vector3();
    this.wanderT = 0;
    this.digT = 0;             // tunneling swing cooldown
    this.responding = false;   // rushing to recover our dropped flag?
    this.deadT = -1;           // corpse tumble timer, while dead
  }

  goal() {
    const g = this.game;
    this.responding = false;
    if (this.carrier) return g.flags[this.team].standPos();          // run it home
    const own = g.flags[this.team];
    // Our flag is on the ground — the two closest free bots sprint back for it.
    this.responding = own.state === 'dropped' && this._isResponder(own.pos);
    if (this.responding) return own.pos;
    const enemyFlag = g.flags[g.enemyOf(this.team)];
    if (enemyFlag.state === 'dropped') return enemyFlag.pos;         // grab the loose flag
    return enemyFlag.standPos();                                     // storm their base
  }

  // Am I one of the two closest living, non-carrying teammates to the spot?
  _isResponder(pos) {
    const mates = this.game.bots
      .filter(b => b.alive && b.team === this.team && !b.carrier)
      .sort((a, b) => a.body.pos.distanceTo(pos) - b.body.pos.distanceTo(pos));
    const i = mates.indexOf(this);
    return i >= 0 && i < 2;
  }

  update(dt) {
    if (!this.alive) { // corpse: tumble where it fell, then vanish
      if (this.deadT >= 0 && this.deadT <= 1.4) {
        this.deadT += dt;
        animateDeath(this.parts, this.deadT);
      }
      return;
    }
    const g = this.game, b = this.body;

    // --- pick something to shoot ---
    this.target = this._acquire();
    if (this.target) this.aimT += dt; else this.aimT = 0;

    // --- movement ---
    const goal = this.goal();
    this.wanderT -= dt;
    if (this.wanderT <= 0) {
      this.wanderT = 1.5 + Math.random() * 2;
      this.wander.set((Math.random() - .5) * 8, 0, (Math.random() - .5) * 8);
    }
    const dest = this.responding ? goal : goal.clone().add(this.wander); // responders beeline
    const dir = new THREE.Vector3(dest.x - b.pos.x, 0, dest.z - b.pos.z);
    const dist = dir.length();
    if (dist > 1.2) dir.normalize();

    // Combat strafe when engaged up close.
    if (this.target && this.aimT > 0.3) {
      const toFoe = new THREE.Vector3().subVectors(this.target.body.pos, b.pos).setY(0).normalize();
      const side = new THREE.Vector3(-toFoe.z, 0, toFoe.x).multiplyScalar(Math.sin(g.time * 1.7 + this.name.length) > 0 ? 1 : -1);
      dir.multiplyScalar(0.4).add(side.multiplyScalar(0.6)).normalize();
    }

    const speed = b.inWater ? 2.6
      : this.target ? 3.4
      : this.responding ? 5.8   // urgency: our flag is on the ground
      : 4.6;
    b.vel.x += (dir.x * speed - b.vel.x) * Math.min(1, dt * 8);
    b.vel.z += (dir.z * speed - b.vel.z) * Math.min(1, dt * 8);

    // Tunnel through ridges instead of detouring around them: a two-high
    // wall dead ahead gets shovelled, one swing every 0.35s.
    this.digT -= dt;
    if (!this.target && dist > 2 && this.digT <= 0) {
      const ax = Math.floor(b.pos.x + dir.x * 1.5);
      const az = Math.floor(b.pos.z + dir.z * 1.5);
      const fy = Math.floor(b.pos.y);
      if (g.world.solid(ax, fy, az) && g.world.solid(ax, fy + 1, az)) {
        this.digT = 0.35;
        this._dig(dir);
      }
    }

    // Stuck detection: sample displacement every 0.4s — hop, then dig through
    // whatever is in the way. (Per-frame thresholds lie: a full-speed bot only
    // moves ~0.08 vox a frame, so any fixed per-frame cutoff reads as "stuck".)
    this.sampleT -= dt;
    if (this.sampleT <= 0) {
      this.sampleT = 0.4;
      const moved = b.pos.distanceTo(this.lastPos);
      this.stuck = moved < 0.5 && dist > 2 ? this.stuck + 1 : 0;
      this.lastPos.copy(b.pos);
    }
    if (this.stuck >= 1) b.jump();
    if (this.stuck >= 3) { this._dig(dir); this.stuck = 1; }

    b.move(dt);

    // --- shooting ---
    this.cooldown -= dt;
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) this.ammo = GUN.mag;
    } else if (this.target && this.aimT > 0.35 && this.cooldown <= 0) {
      if (this.ammo <= 0) { this.reloading = GUN.reload; }
      else {
        this.ammo--;
        this.cooldown = GUN.interval * (Math.random() < 0.25 ? 4 : 1); // burst rhythm
        const from = b.eye();
        const aim = new THREE.Vector3().subVectors(this.target.body.eye(), from).normalize();
        g.fireHitscan(this, from, aim, GUN);
      }
    }

    // --- presentation ---
    const pg = this.parts.group;
    pg.position.copy(b.pos);
    const face = this.target
      ? new THREE.Vector3().subVectors(this.target.body.pos, b.pos).setY(0).normalize()
      : dir;
    if (face.lengthSq() > 0.01) pg.rotation.y = Math.atan2(-face.x, -face.z);
    animateSoldier(this.parts, Math.hypot(b.vel.x, b.vel.z), g.time + this.name.length);
  }

  _acquire() {
    const foes = this.game.foesOf(this.team);
    let best = null, bestD = 48;
    for (const f of foes) {
      if (!f.alive) continue;
      const d = this.body.pos.distanceTo(f.body.pos);
      if (d < bestD && this.game.losClear(this.body.eye(), f.body.eye())) {
        best = f; bestD = d;
      }
    }
    return best;
  }

  _dig(dir) {
    // Shovel out the voxel blocking the path at foot and head height.
    const fx = Math.floor(this.body.pos.x + dir.x * 1.4);
    const fz = Math.floor(this.body.pos.z + dir.z * 1.4);
    for (const fy of [Math.floor(this.body.pos.y), Math.floor(this.body.pos.y) + 1])
      if (this.game.world.solid(fx, fy, fz)) this.game.digVoxel(this, fx, fy, fz);
  }

  die(killer) {
    this.alive = false;
    this.deadT = 0; // corpse tumble starts; the body hides itself when done
    this.game.effects.burst(this.body.eye(), 26, this.team === 'blue' ? 0x4a6cd4 : 0x4a9e4a, 6);
    this.game.onDeath(this, killer);
  }

  respawn() {
    const p = this.game.spawnPoint(this.team);
    this.body.pos.set(p.x, p.y, p.z);
    this.body.vel.set(0, 0, 0);
    this.health = 100;
    this.alive = true;
    this.ammo = GUN.mag;
    this.stuck = 0;
    this.sampleT = 0.4;
    this.lastPos.copy(this.body.pos);
    this.deadT = -1;
    resetDeath(this.parts);
    this.parts.group.visible = true;
  }
}
