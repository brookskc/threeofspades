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
    this.lastDig = -9;         // last shovel swing, game time
    this.face = new THREE.Vector3(this.heading, 0, 0); // where the head points
    this.memoryT = 0;          // keeps tracking a target just out of sight
    this.responding = false;   // rushing to recover our dropped flag?
    this.deadT = -1;           // corpse tumble timer, while dead
  }

  goal() {
    const g = this.game;
    this.responding = false;
    if (this.carrier) return g.flags[this.team].standPos();          // run it home
    const own = g.flags[this.team];
    // Flag defense: the two closest free bots drop everything — sprint at the
    // thief while it's carried, converge on the flag while it's on the ground.
    if (own.state === 'carried' && own.carrier) {
      this.responding = this._isResponder(own.carrier.body.pos);
      if (this.responding) return own.carrier.body.pos;              // hunt the thief
    }
    if (own.state === 'dropped') {
      this.responding = this._isResponder(own.pos);
      if (this.responding) return own.pos;
    }
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

    // --- pick something to shoot (it has to actually see it first) ---
    const seen = this._acquire();
    if (seen !== this.target) this.aimT = 0;    // fresh eyes: reaction time
    if (seen) { this.target = seen; this.memoryT = 1.2; }
    else if ((this.memoryT -= dt) <= 0) this.target = null;
    if (this.target) this.aimT += dt;

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

    // --- terrain negotiation: tunnel level, stair-step uphill, hop steps ---
    // The passage ahead is two voxels high at foot level; whatever of it is
    // solid gets shovelled, one swing every 0.32s, feet planted (airborne
    // swings gouge random heights). A full wall with the goal uphill and open
    // sky becomes a staircase: clear a ledge above the step, hop on, repeat —
    // that climbs out of any pit. Anything else is tunnelled through level.
    // While the shovel is swinging the bot holds a digger's pace so it never
    // bumps the wall between swings (that bump used to trigger the stuck-hop,
    // pop it onto the ridge crest, and abandon the tunnel).
    this.digT -= dt;
    const w = g.world, fy = Math.floor(b.pos.y);
    // Probe the contact column first, then a step beyond: a bot pressed
    // against the face is closer than shovel reach, and both columns block.
    let tx = 0, tz = 0, lo = false, hi = false;
    for (const reach of [0.9, 1.5]) {
      const px = Math.floor(b.pos.x + dir.x * reach);
      const pz = Math.floor(b.pos.z + dir.z * reach);
      lo = w.solid(px, fy, pz); hi = w.solid(px, fy + 1, pz);
      if (lo || hi) { tx = px; tz = pz; break; }
      lo = hi = false;
    }
    if (!this.target && dist > 2 && this.digT <= 0 && hi && b.onGround) {
      this.digT = 0.32;
      this.lastDig = g.time;
      const uphill = goal.y - b.pos.y > 1.5;
      const ceiling = w.solid(Math.floor(b.pos.x), fy + 2, Math.floor(b.pos.z));
      if (lo && uphill && !ceiling) {
        this._digV(tx, fy + 1, tz); this._digV(tx, fy + 2, tz); // ledge, then hop on
        b.jump();
      } else {
        this._digV(tx, fy, tz); this._digV(tx, fy + 1, tz);     // wall face or lip
      }
    }
    const digging = g.time - this.lastDig < 0.9;

    const speed = b.inWater ? 2.6
      : this.target ? 3.4
      : digging ? 2.2           // shovel pace: never outrun the swing
      : this.responding ? 5.8   // urgency: our flag is on the ground
      : 4.6;
    b.vel.x += (dir.x * speed - b.vel.x) * Math.min(1, dt * 8);
    b.vel.z += (dir.z * speed - b.vel.z) * Math.min(1, dt * 8);

    // Stuck detection: sample displacement every 0.4s — hop over one-high
    // steps, sidestep when truly wedged. Suppressed mid-dig: a tunneler at
    // the face is making progress even while momentarily pressed still.
    // (Per-frame thresholds lie: a full-speed bot only moves ~0.08 vox a
    // frame, so any fixed per-frame cutoff reads as "stuck".)
    this.sampleT -= dt;
    if (this.sampleT <= 0) {
      this.sampleT = 0.4;
      const moved = b.pos.distanceTo(this.lastPos);
      this.stuck = moved < 0.5 && dist > 2 ? this.stuck + 1 : 0;
      this.lastPos.copy(b.pos);
    }
    if (this.stuck >= 1 && !(digging && hi)) b.jump();
    if (this.stuck >= 4) { // wedged on something unshovelled — sidestep
      this.wander.set((Math.random() - .5) * 30, 0, (Math.random() - .5) * 30);
      this.wanderT = 2;
      this.stuck = 0;
    }

    b.move(dt);

    // --- shooting ---
    this.cooldown -= dt;
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) this.ammo = GUN.mag;
    } else if (this.target && this.aimT > 0.35 && this.cooldown <= 0) {
      if (this.ammo <= 0) { this.reloading = GUN.reload; }
      else {
        const from = b.eye();
        const toFoe = new THREE.Vector3().subVectors(this.target.body.pos, b.pos).setY(0).normalize();
        // The muzzle only speaks once the head has turned on target — and
        // opening shots go wide before the aim settles. No 180° no-scopes.
        if (this.face.dot(toFoe) > 0.87 && g.losClear(from, this.target.body.eye())) {
          this.ammo--;
          this.cooldown = GUN.interval * (Math.random() < 0.25 ? 4 : 1); // burst rhythm
          const err = Math.max(0.015, 0.2 - this.aimT * 0.16);
          const aim = new THREE.Vector3().subVectors(this.target.body.eye(), from).normalize();
          aim.x += (Math.random() - .5) * err * 2;
          aim.y += (Math.random() - .5) * err;
          aim.z += (Math.random() - .5) * err * 2;
          g.fireHitscan(this, from, aim.normalize(), GUN);
        }
      }
    }

    // --- presentation: eyes track the fight, but heads take time to turn ---
    const pg = this.parts.group;
    pg.position.copy(b.pos);
    const want = this.target
      ? new THREE.Vector3().subVectors(this.target.body.pos, b.pos).setY(0).normalize()
      : dir;
    if (want.lengthSq() > 0.01) {
      const ang = this.face.angleTo(want);
      if (ang > 1e-3) this.face.lerp(want, Math.min(1, 7 * dt / ang)).normalize();
    }
    pg.rotation.y = Math.atan2(-this.face.x, -this.face.z);
    animateSoldier(this.parts, Math.hypot(b.vel.x, b.vel.z), g.time + this.name.length);
  }

  _acquire() {
    // A designated defender tunnel-visions the flag thief, even from afar.
    const own = this.game.flags[this.team];
    if (this.responding && own.state === 'carried' && own.carrier?.alive) {
      const c = own.carrier;
      if (this.body.pos.distanceTo(c.body.pos) < 64 &&
          this.game.losClear(this.body.eye(), c.body.eye())) return c;
    }
    // Everyone else must be in front of you — or close enough to hear.
    const to = new THREE.Vector3();
    let best = null, bestD = 48;
    for (const f of this.game.foesOf(this.team)) {
      if (!f.alive) continue;
      const d = this.body.pos.distanceTo(f.body.pos);
      if (d >= bestD) continue;
      if (f !== this.target) { // a target already being tracked stays tracked
        to.subVectors(f.body.pos, this.body.pos).setY(0).normalize();
        if (d > 7 && this.face.dot(to) < 0.26) continue; // outside the ~150° cone
      }
      if (this.game.losClear(this.body.eye(), f.body.eye())) { best = f; bestD = d; }
    }
    return best;
  }

  // Shot in the back? Whirl toward the shooter — seeing is believing.
  alert(from) {
    if (from?.alive) this.face.subVectors(from.body.pos, this.body.pos).setY(0).normalize();
  }

  // Shovel a single voxel (debris, edit log, network sync all handled inside).
  _digV(x, y, z) {
    if (this.game.world.solid(x, y, z)) this.game.digVoxel(this, x, y, z);
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
    this.digT = 0;
    this.lastDig = -9;
    this.target = null;
    this.aimT = 0;
    this.memoryT = 0;
    this.face.set(this.heading, 0, 0);
    this.lastPos.copy(this.body.pos);
    this.deadT = -1;
    resetDeath(this.parts);
    this.parts.group.visible = true;
  }
}
