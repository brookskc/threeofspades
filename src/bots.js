// bots.js — AI soldiers: they hunt the flag, fight back, and dig through walls.
import * as THREE from 'three';
import { Body, makeSoldier, makeNametag, animateSoldier, animateDeath, resetDeath, setCrouch } from './entities.js';

const NAMES = {
  blue:  ['Vex', 'Havoc', 'Irons', 'Dagger', 'Rook', 'Frost'],
  green: ['Sarge', 'Pine', 'Moss', 'Flint', 'Clover', 'Briar'],
};
const GUN = { damage: 16, headMult: 1.5, interval: 0.14, spread: 0.035, mag: 24, reload: 2.0 };

let n = 0;        // name rotation
let nextId = 0;   // stable identity for network snapshots

export class Bot {
  constructor(game, team, name = null) {
    this.game = game;
    this.team = team;
    this.id = nextId++;
    // Host migration restores fallen bots by name so their tags survive.
    this.name = name ?? NAMES[team][n++ % NAMES[team].length];
    const p = game.spawnPoint(team);
    this.body = new Body(game.world, p.x, p.y, p.z);
    this.parts = makeSoldier(team === 'blue' ? 0x4a6cd4 : 0x4a9e4a);
    this.parts.group.add(makeNametag(this.name, team)); // know your enemy
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
    this.blocks = 16;          // combat engineering inventory (cover + bridges)
    this.buildT = 0;           // cooldown between throwing up cover
    this.coverT = 0;           // hold-and-fight timer behind fresh cover
    this.duckT = 0;            // duck rhythm: reloads and burst pauses
    this.bridgeT = 0;          // plank-laying cooldown
    this.lastBridge = -9;      // last plank placed, game time
    this.face = new THREE.Vector3(this.heading, 0, 0); // where the head points
    this.memoryT = 0;          // keeps tracking a target just out of sight
    this.responding = false;   // rushing to recover our dropped flag?
    this.deadT = -1;           // corpse tumble timer, while dead
  }

  goal() {
    const g = this.game;
    this.responding = false;
    if (this.carrier) return g.standOf(this.team);                   // run it home
    const own = g.flags?.[this.team];
    if (!own) return g.standOf(g.enemyOf(this.team));                // deathmatch: hunt
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
    return g.standOf(g.enemyOf(this.team));                          // storm their base
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
    let toFoe = null;
    if (this.target && this.aimT > 0.3) {
      toFoe = new THREE.Vector3().subVectors(this.target.body.pos, b.pos).setY(0).normalize();
      const side = new THREE.Vector3(-toFoe.z, 0, toFoe.x).multiplyScalar(Math.sin(g.time * 1.7 + this.name.length) > 0 ? 1 : -1);
      dir.multiplyScalar(0.4).add(side.multiplyScalar(0.6)).normalize();
    }

    // --- combat engineering: caught in the open at range, throw up a
    // knee-high wall toward the threat, then fight from behind it ---
    this.buildT -= dt; this.coverT -= dt; this.duckT -= dt;
    if (this.target && !this.carrier && !this.responding && toFoe &&
        b.onGround && !b.inWater && this.blocks >= 3 && this.buildT <= 0 &&
        this.coverT <= 0) {
      const foeD = b.pos.distanceTo(this.target.body.pos);
      if (foeD > 8 && foeD < 42 && !this._hasCover(toFoe)) this._build(toFoe);
    }
    // Behind fresh cover: hold the line instead of advancing.
    if (this.coverT > 0 && this.target) dir.multiplyScalar(0.15);

    // --- terrain negotiation: tunnel level, stair-step uphill, hop steps ---
    // The passage ahead is two voxels high at foot level; whatever of it is
    // solid gets shovelled, one swing every 0.32s, feet planted or swimming
    // (airborne swings gouge random heights). A full wall with the goal
    // uphill becomes a staircase: clear the ledge, the headroom above it,
    // and any block hanging over the bot's own head — then hop on and
    // repeat. That climbs out of pits AND the Pinefall ravine: the old code
    // demanded dry feet and open sky, so a bot treading creek water under a
    // sheer bank could only bob there forever.
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
    if (!this.target && dist > 2 && this.digT <= 0 && hi && (b.onGround || b.inWater)) {
      this.digT = 0.32;
      this.lastDig = g.time;
      const uphill = goal.y - b.pos.y > 1.5;
      if (lo && uphill) {
        this._digV(tx, fy + 1, tz); this._digV(tx, fy + 2, tz);  // the ledge
        this._digV(tx, fy + 3, tz);                              // its headroom
        // The block above our own head: an overhang would guillotine the hop.
        this._digV(Math.floor(b.pos.x), fy + 2, Math.floor(b.pos.z));
        b.jump();
        if (b.inWater) b.vel.y = 6; // swim-hop needs extra lift to crest the lip
      } else {
        this._digV(tx, fy, tz); this._digV(tx, fy + 1, tz);      // wall face or lip
      }
    }
    const digging = g.time - this.lastDig < 0.9;

    // --- bridging: never launch into a ravine we could span. If the column
    // a pace ahead drops away deeper than a couple of blocks (and the goal
    // isn't downhill anyway, where descending is the point), lay the next
    // plank at foot level. A bridgelayer's pace keeps us from outrunning
    // the plank cadence and walking off our own bridge tip. ---
    this.bridgeT -= dt;
    if (!this.target && dist > 2 && b.onGround && !b.inWater &&
        this.blocks > 0 && dir.lengthSq() > 0 && this.bridgeT <= 0) {
      const gx = Math.floor(b.pos.x + dir.x * 1.4);
      const gz = Math.floor(b.pos.z + dir.z * 1.4);
      let drop = 0;
      for (let y = fy - 1; y >= fy - 4 && !w.solid(gx, y, gz); y--) drop++;
      // Bridge only when the goal sits ABOVE the bottom of the drop ahead:
      // a ravine between two banks qualifies (even when the far bank is
      // lower); a valley we're descending into doesn't — walking down is
      // the point there.
      if (drop >= 3 && goal.y > fy - drop) {
        this.bridgeT = 0.35;
        if (g.tryBuild(this, gx, fy - 1, gz)) this.lastBridge = g.time;
      }
    }
    const bridging = g.time - this.lastBridge < 0.9;

    const speed = b.inWater ? 2.6
      : this.target ? 3.4
      : digging || bridging ? 2.2  // shovel/plank pace: never outrun the tool
      : this.responding ? 5.8      // urgency: our flag is on the ground
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

    // Cover posture: duck while reloading behind the wall or riding out a
    // burst pause; stand to shoot. Same bounded lerp as the player crouch.
    if (this.reloading > 0 && this.coverT > 0) this.duckT = Math.max(this.duckT, 0.2);
    const ducking = this.duckT > 0;
    b.half.h += ((ducking ? 1.15 : 1.75) - b.half.h) * Math.min(1, dt * 10);
    setCrouch(this.parts, ducking);

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
          const burstPause = Math.random() < 0.25;
          this.cooldown = GUN.interval * (burstPause ? 4 : 1); // burst rhythm
          if (burstPause && this.coverT > 0) this.duckT = this.cooldown + 0.15;
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

  // Knee-high cover already standing between us and the foe?
  _hasCover(toFoe) {
    const w = this.game.world, b = this.body, fy = Math.floor(b.pos.y);
    for (const reach of [1.2, 2.2, 3.2]) {
      const px = Math.floor(b.pos.x + toFoe.x * reach);
      const pz = Math.floor(b.pos.z + toFoe.z * reach);
      if (w.solid(px, fy, pz)) return true;
    }
    return false;
  }

  // A three-wide knee wall two paces toward the threat: tall enough to hide a
  // crouch, low enough to shoot over standing. Follows the ground one step
  // down so walls on a downhill slope don't float.
  _build(toFoe) {
    const b = this.body, fy = Math.floor(b.pos.y), w = this.game.world;
    const perp = new THREE.Vector3(-toFoe.z, 0, toFoe.x);
    let placed = 0;
    for (const off of [-1, 0, 1]) {
      const cx = Math.floor(b.pos.x + toFoe.x * 2.2 + perp.x * off);
      const cz = Math.floor(b.pos.z + toFoe.z * 2.2 + perp.z * off);
      const gy = w.solid(cx, fy - 1, cz) ? fy : w.solid(cx, fy - 2, cz) ? fy - 1 : null;
      if (gy !== null && this.game.tryBuild(this, cx, gy, cz)) placed++;
    }
    if (placed) { this.buildT = 9; this.coverT = 6; }
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
    this.blocks = 16;
    this.bridgeT = 0;
    this.lastBridge = -9;
    this.buildT = 0;
    this.coverT = 0;
    this.duckT = 0;
    this.body.half.h = 1.75;
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
