// bots.js — AI soldiers: they hunt intel (gunfire, sightings, kills), patrol
// when the trail is cold, advance in lanes, group up past midfield, crouch-fire
// at range, lob frags over cover, undermine towers, and dig through walls.
import * as THREE from 'three';
import { Body, makeSoldier, makeNametag, animateSoldier, animateDeath, resetDeath, setCrouch, placeShadow } from './entities.js';
import { SEA, SX, SZ, BLOCK } from './world.js';

const NAMES = {
  blue:  ['Vex', 'Havoc', 'Irons', 'Dagger', 'Rook', 'Frost'],
  green: ['Sarge', 'Pine', 'Moss', 'Flint', 'Clover', 'Briar'],
};
const GUN = { damage: 18, headMult: 1.5, interval: 0.12, spread: 0.035, mag: 24, reload: 2.0 };
// ~150 theoretical dps, up from ~114 — closer to the player SMG's ~220 without
// matching it outright. Bots were losing straight fights on paper before a
// single shot missed.

// Difficulty tiers scale reaction time, aim error and target memory.
// ?botq=easy|hard skews the whole room; every bot still gets its own jitter.
const QUERY = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
const BOTQ = { easy: 0.65, normal: 1.0, hard: 1.35 };
const BOT_SKILL = BOTQ[QUERY.get('botq')] ?? 1.0;

let n = 0;        // name rotation
let nextId = 0;   // stable identity for network snapshots

// Host migration restores bots under their OLD ids (clients key avatars by
// them); make sure a future spawn never reissues one.
export function reserveBotId(idx) { if (idx >= nextId) nextId = idx + 1; }

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
    // Callsigns for your own side only — an enemy tag rides above the helmet
    // and gives away a man who is otherwise fully behind cover.
    if (team === game.player?.team) this.parts.group.add(makeNametag(this.name, team));
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
    this.exit = null;          // committed dry-land column while swimming
    this.wetT = 0;             // grace timer: recently-in-water → keep seeking dry
    this.digT = 0;             // tunneling swing cooldown
    this.lastDig = -9;         // last shovel swing, game time
    this.blocks = 16;          // combat engineering inventory (cover + bridges)
    this._cover = [];          // recently self-built columns: {x,z,t} — don't shovel our own wall
    this.buildT = 0;           // cooldown between throwing up cover
    this.coverT = 0;           // hold-and-fight timer behind fresh cover
    this.duckT = 0;            // duck rhythm: reloads and burst pauses
    this.bridgeT = 0;          // plank-laying cooldown
    this.lastBridge = -9;      // last plank placed, game time
    this.face = new THREE.Vector3(this.heading, 0, 0); // where the head points
    this.memoryT = 0;          // keeps tracking a target just out of sight
    this.responding = false;   // rushing to recover our dropped flag?
    this.deadT = -1;           // corpse tumble timer, while dead
    this.skill = BOT_SKILL * (0.85 + Math.random() * 0.3); // individual jitter
    this.lane = ((this.id % 3) - 1) * 18; // advance on a front, not a file
    this.role = 'attack';      // ctf only: defend | mid | attack (recomputed)
    this.patrol = null;        // current roam waypoint when there's no intel
    this.patrolT = 0;
    this.retreatT = 0;         // backing off to lick wounds
    this.retreatCd = 0;
    this.nades = 1;            // one frag per life
    this.nadeT = 0;
    this.crouched = false;     // mirrors the duck posture for fireHitscan
  }

  // Perpendicular offset so a team advances on a broad front instead of
  // single file down the middle of the map.
  _laned(pos) {
    const v = pos.clone ? pos.clone() : new THREE.Vector3(pos.x, pos.y ?? 0, pos.z);
    v.z += this.lane;
    return v;
  }

  // Living non-carrier teammates sorted by id — stable ranks for roles.
  _rank() {
    const mates = this.game.bots
      .filter(b => b.alive && b.team === this.team && !b.carrier)
      .sort((a, b) => a.id - b.id);
    return mates.indexOf(this);
  }

  // Deathmatch has no flag to chase, so hunt the freshest sign of the enemy
  // (gunfire, kills, sightings — the game's intel feed). No intel? Roam.
  _huntGoal() {
    const g = this.game, b = this.body;
    const spot = g.huntSpot(this.team);
    if (spot) {
      const d = Math.hypot(spot.x - b.pos.x, spot.z - b.pos.z);
      // Stood on the spot and nobody's here — the trail is cold. Scratch it
      // off for the whole team so nobody else camps an empty corner.
      if (d < 9 && !this.target) { g.consumeIntel(this.team, spot, 16); return this._patrolGoal(); }
      return this._laned(new THREE.Vector3(spot.x, g.world.surface(spot.x | 0, spot.z | 0), spot.z));
    }
    return this._patrolGoal();
  }

  // Roam the contested middle band, biased toward the enemy half — a patrol,
  // not a camp. Fresh waypoint on arrival or on a timeout.
  _patrolGoal() {
    const b = this.body, w = this.game.world;
    const arrived = this.patrol && Math.hypot(this.patrol.x - b.pos.x, this.patrol.z - b.pos.z) < 7;
    if (!this.patrol || arrived || this.patrolT <= 0) {
      this.patrolT = 18;
      for (let tries = 0; tries < 8; tries++) {
        const x = SX * 0.25 + Math.random() * SX * (this.heading > 0 ? 0.55 : 0.5);
        const px = this.heading > 0 ? x : SX - x; // bias across midfield
        const pz = SZ * 0.2 + Math.random() * SZ * 0.6;
        if (w.surface(px | 0, pz | 0) < SEA) continue; // don't patrol the sea
        this.patrol = new THREE.Vector3(px, w.surface(px | 0, pz | 0), pz);
        break;
      }
      this.patrol ??= new THREE.Vector3(SX / 2, w.surface(SX / 2, SZ / 2), SZ / 2);
    }
    return this._laned(this.patrol);
  }

  // Team-colored masonry overhead is a structure somebody built — and the
  // collapse system can drop it. Don't camp under what you can't vouch for.
  _overhead() {
    const w = this.game.world, b = this.body;
    const fx = Math.floor(b.pos.x), fy = Math.floor(b.pos.y), fz = Math.floor(b.pos.z);
    for (let dy = 3; dy <= 6; dy++) {
      const v = w.get(fx, fy + dy, fz);
      if (v === BLOCK.BLUE || v === BLOCK.GREEN) return true;
    }
    return false;
  }

  goal() {
    const g = this.game;
    this.responding = false;
    if (this.carrier) return g.standOf(this.team);                   // run it home
    if (g.hill) return g.hill.pos;   // koth: converge — the point is the point
    const own = g.flags?.[this.team];
    if (!own) { this.role = 'attack'; return this._huntGoal(); }     // deathmatch: hunt
    // Flag defense: the two closest free bots drop everything — converge on
    // the flag while it's on the ground, and while it's carried... no psychic
    // tracking. The thief is only as found as our intel: chase the freshest
    // sighting of him (he pinged us by firing, killing, or being spotted);
    // with no sightings, cut off the obvious run home across midfield.
    if (own.state === 'carried' && own.carrier) {
      const spot = g.huntSpot(this.team);
      const cut = spot
        ? new THREE.Vector3(spot.x, g.world.surface(spot.x | 0, spot.z | 0), spot.z)
        : g.standOf(this.team).clone().lerp(g.standOf(g.enemyOf(this.team)), 0.5);
      this.responding = this._isResponder(cut);
      if (this.responding) return cut;
    }
    if (own.state === 'dropped') {
      this.responding = this._isResponder(own.pos);
      if (this.responding) return own.pos;
    }
    // Roles by stable rank: one guards the stand, one holds midfield, the
    // rest attack. A team that all charges leaves its flag naked.
    const rank = this._rank();
    this.role = rank === 0 ? 'defend' : rank === 1 ? 'mid' : 'attack';
    if (this.role === 'defend') return this._laned(g.standOf(this.team));
    if (this.role === 'mid')
      return this._laned(new THREE.Vector3(SX / 2, g.world.surface(SX / 2, SZ / 2), SZ / 2));
    const enemyFlag = g.flags[g.enemyOf(this.team)];
    if (enemyFlag.state === 'dropped') return enemyFlag.pos;         // grab the loose flag
    return this._laned(g.standOf(g.enemyOf(this.team)));             // storm their base
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
    if (seen) {
      // New eyes on an enemy: report it. Teammates hunt from these sightings.
      if (seen !== this.target) g.pingIntel(seen.body.pos, seen.team);
      this.target = seen; this.memoryT = 1.2 * this.skill;
    }
    else if ((this.memoryT -= dt) <= 0) this.target = null;
    if (this.target) this.aimT += dt;
    const reactT = 0.35 / this.skill; // better bots shoulder faster

    // --- movement ---
    const goal = this.goal();
    this.wanderT -= dt;
    this.patrolT -= dt; // patrol waypoints go stale even if never reached
    if (this.wanderT <= 0) {
      this.wanderT = 1.5 + Math.random() * 2;
      this.wander.set((Math.random() - .5) * 8, 0, (Math.random() - .5) * 8);
    }
    // Responders beeline; so do bridgelayers — a wander wobble over an open
    // ravine walks the bot off the side of its own deck. Swimmers mostly
    // beeline too — a full-strength wander vector in the water just yanks a
    // climbing bot off its staircase and back into the channel (the old
    // creek-bobbing loop).
    // Rim check ahead in the goal direction: a wander wobble near a
    // drop-off staggers the bot down the face or off the side of its own
    // deck, so near a bridgeable rim the beeline wins. Deep scan — a tall
    // deck over a gorge must read the true bottom, not four blocks down.
    let rimAhead = false;
    if (b.onGround && !b.inWater && this.blocks > 0) {
      const rx = goal.x - b.pos.x, rz = goal.z - b.pos.z;
      const rl = Math.hypot(rx, rz);
      if (rl > 2) {
        const gx = Math.floor(b.pos.x + rx / rl * 1.4);
        const gz = Math.floor(b.pos.z + rz / rl * 1.4);
        const fy = Math.floor(b.pos.y);
        let drop = 0;
        for (let y = fy - 1; y >= fy - 16 && !g.world.solid(gx, y, gz); y--) drop++;
        rimAhead = drop >= 3 && goal.y > fy - drop;
      }
    }
    const bridging = g.time - this.lastBridge < 0.9;
    // Responders, bridgelayers, and rim-climbers beeline on purpose (see the
    // comment above) — the new obstacle-routing below leaves them alone and
    // lets them walk (or dig) straight at their target, same as always.
    const beeline = this.responding || bridging || rimAhead;
    const dest = beeline ? goal.clone() : goal.clone().add(
      b.inWater ? this.wander.clone().multiplyScalar(0.25) : this.wander);

    // Dry-land seeking: swimming or wading the shelf, steer for the nearest
    // dry column — cheap exit first, goal-ward as the tiebreak. A creek that
    // runs roughly parallel to the goal direction otherwise becomes an
    // 80-block swim along the channel (the Pinefall bob). Dry means solid at
    // SEA+1: probing surface() would read tree canopies over the channel as
    // dry land and march the bot straight back in.
    // Engage on recency, not altitude: a tunneler working LOW dry ground
    // (below SEA+1) must not have its dest hijacked toward a "dry column" —
    // only bots that have actually been swimming get the exit scan. The 2s
    // grace carries the commitment through the wading half-steps where the
    // bot bounces in and out of the inWater flag on the shelf.
    this.wetT = b.inWater ? 2 : Math.max(0, this.wetT - dt);
    if (this.wetT > 0) {
      // Commit to the chosen exit column until standing on dry land:
      // re-picking every frame just hops the dest a few blocks goal-ward
      // along the bank, and the bot outswims its own shovel without ever
      // clearing a ledge (the Pinefall bob).
      let exit = this.exit;
      // Validity degrades gracefully: the dig-climb clears the exit column's
      // SEA+1 ledge block as its FIRST swing, so re-testing only SEA+1 would
      // invalidate the commitment mid-climb and restart the scan every swing.
      // Solid at SEA still means "one hop from dry" — keep climbing.
      if (!exit || (!g.world.solid(exit[0], SEA, exit[1]) && !g.world.solid(exit[0], SEA + 1, exit[1]))) {
        let best = null, bestCost = Infinity;
        for (const ring of [5, 9, 13]) {
          for (let a = 0; a < 12; a++) {
            const ang = a / 12 * Math.PI * 2;
            const px = Math.floor(b.pos.x + Math.cos(ang) * ring);
            const pz = Math.floor(b.pos.z + Math.sin(ang) * ring);
            if (!g.world.solid(px, SEA + 1, pz)) continue; // still the channel
            const cost = ring + Math.hypot(px + 0.5 - goal.x, pz + 0.5 - goal.z) * 0.1;
            if (cost < bestCost) { bestCost = cost; best = [px, pz]; }
          }
          if (best) break; // a dry column on the nearest ring wins
        }
        exit = this.exit = best;
      }
      if (exit) dest.set(exit[0] + 0.5, g.world.surface(exit[0], exit[1]), exit[1] + 0.5);
    } else this.exit = null;
    const dir = new THREE.Vector3(dest.x - b.pos.x, 0, dest.z - b.pos.z);
    const dist = dir.length();
    if (dist > 1.2) dir.normalize();

    // Combat movement when engaged: strafe up close, hold and crouch-fire
    // at range — but never in water, where the sideways mix orbits the bot
    // off its committed exit wall.
    let toFoe = null, foeD = Infinity, undermining = false;
    if (this.target && !b.inWater) {
      foeD = b.pos.distanceTo(this.target.body.pos);
      // Undermine: a foe we merely REMEMBER (memoryT keeps the trail) is up
      // a tower we can't see through — walk to the column and let the shovel
      // and gravity argue with his footing. No aim required: the head never
      // settles on a target it can't see, so gating on aimT would forbid this.
      if (!g.losClear(b.eye(), this.target.body.eye()) &&
          this.target.body.pos.y > b.pos.y + 3 && foeD < 14) {
        undermining = true;
        dir.subVectors(this.target.body.pos, b.pos).setY(0).normalize();
      } else if (this.aimT > 0.3) {
        toFoe = new THREE.Vector3().subVectors(this.target.body.pos, b.pos).setY(0).normalize();
        if (foeD < 14) {
          const side = new THREE.Vector3(-toFoe.z, 0, toFoe.x).multiplyScalar(Math.sin(g.time * 1.7 + this.name.length) > 0 ? 1 : -1);
          dir.multiplyScalar(0.4).add(side.multiplyScalar(0.6)).normalize();
        }
      }
    }

    // Wounded and engaged: fall back toward home for a beat (still shooting),
    // throwing a wall up behind us if there's cover to make. Then re-engage.
    this.retreatT -= dt; this.retreatCd -= dt;
    if (this.target && this.health < 35 && this.retreatCd <= 0 && toFoe) {
      this.retreatT = 2.5; this.retreatCd = 9;
    }
    if (this.retreatT > 0 && toFoe) {
      dir.set(-toFoe.x - this.heading * 0.5, 0, -toFoe.z).normalize();
      if (b.onGround && this.blocks >= 3 && this.buildT <= 0 && !this._hasCover(toFoe))
        this._build(toFoe);
    }

    // --- combat engineering: caught in the open at range, throw up a
    // knee-high wall toward the threat, then fight from behind it ---
    this.buildT -= dt; this.coverT -= dt; this.duckT -= dt;
    if (this.target && !this.carrier && !this.responding && toFoe &&
        b.onGround && !b.inWater && this.blocks >= 3 && this.buildT <= 0 &&
        this.coverT <= 0) {
      if (foeD > 8 && foeD < 42 && !this._hasCover(toFoe)) this._build(toFoe);
    }
    // A defender with quiet hands fortifies: wall off the enemy approach to
    // the flag stand, one knee wall at a time.
    else if (this.role === 'defend' && !this.target && this.blocks >= 6 &&
        this.buildT <= 0 && b.onGround && !b.inWater) {
      if (b.pos.distanceTo(g.standOf(this.team)) < 12) {
        this._build(new THREE.Vector3(this.heading, 0, 0));
        this.coverT = 0; // fortifying, not fighting — keep patrolling
      }
    }
    // Behind fresh cover: hold the line instead of advancing — unless there's
    // team-colored masonry overhead, which the collapse system can drop on us.
    // A retreating bot never holds: the wall it just threw up is for falling
    // back BEHIND, not for standing next to.
    const coverHold = this.coverT > 0 && this.target && this.retreatT <= 0 && !this._overhead();
    if (coverHold) dir.multiplyScalar(0.15);
    // Holding a ranged firing line: plant the feet while crouch-firing.
    const holdingLine = this.target && foeD > 18 && this.aimT > reactT && this.coverT <= 0 &&
        !undermining && b.onGround && !b.inWater;
    if (holdingLine) dir.multiplyScalar(0.15);
    // Deliberately near-motionless, either from cover or a held line — the
    // stuck-sampler below must not read discipline as being wedged.
    const holding = coverHold || holdingLine;

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
    // Route around a short obstacle before ever reaching for the shovel: try
    // a couple of headings off the direct line, and steer that way if one's
    // clear. There is no pathfinding in this file — a straight line is the
    // only route a bot ever considers — so without this, ANY solid terrain
    // between a bot and its goal (a hillside, a stand of trees, a single
    // wall) got dug through rather than walked around, on every map, as the
    // routine way bots made progress rather than a rare fallback. The
    // deliberate beeline cases (responding, bridging, mid rim-climb) and the
    // deliberate dig cases (a committed water exit, undermining a tower)
    // keep going straight at their target on purpose — this only touches the
    // ordinary "walking somewhere and a wall is in the way" case.
    if (!beeline && !b.inWater && this.wetT <= 0 && !undermining && dir.lengthSq() > 0.01) {
      const blocked = w.solid(Math.floor(b.pos.x + dir.x * 1.2), fy, Math.floor(b.pos.z + dir.z * 1.2))
        || w.solid(Math.floor(b.pos.x + dir.x * 1.2), fy + 1, Math.floor(b.pos.z + dir.z * 1.2));
      if (blocked) for (const deg of [30, -30, 60, -60]) {
        const rad = deg * Math.PI / 180;
        const rx = dir.x * Math.cos(rad) - dir.z * Math.sin(rad);
        const rz = dir.x * Math.sin(rad) + dir.z * Math.cos(rad);
        const px = Math.floor(b.pos.x + rx * 1.4), pz = Math.floor(b.pos.z + rz * 1.4);
        if (!w.solid(px, fy, pz) && !w.solid(px, fy + 1, pz)) { dir.set(rx, 0, rz).normalize(); break; }
      }
    }
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
    // Never shovel down the wall we ourselves threw up moments ago —
    // without this a bot repositioning through its own fresh cover reads it
    // as just another obstacle and digs it back out, burning the block
    // budget it spent seconds earlier for nothing.
    const ownCover = this._cover.some(c => c.x === tx && c.z === tz && g.time - c.t < 8);
    // Combat suppresses digging on land (fight first), but a swimmer pressed
    // against a bank climbs even mid-fight: bobbing in the creek is a worse
    // look than pausing fire to shovel.
    // Swimmers dig regardless of distance-to-dest: the committed exit column
    // IS a wall, so the bot idles within dist<=2 of it forever otherwise.
    // Gate on lo || hi: under a tree canopy the only obstruction can be a
    // foot-level leaf block while fy+1 is open air between the leaves.
    // A bot wedged against terrain digs even mid-fight (stuck >= 1): trading
    // fire while pressed into a bank it could shovel through is the worse
    // look — combat only pauses digging on open ground.
    // Undermining counts as wedged-in work: shoveling out a tower's legs is
    // worth pausing fire for, same as climbing a bank.
    // activelyFiring is the hard stop: a bot that's actually landing shots
    // never breaks off to swing a shovel over an unrelated stuck sample
    // (undermining and swimming are the deliberate exceptions — those ARE
    // the fight).
    const activelyFiring = this.target && this.aimT > reactT && !undermining && !b.inWater;
    if (!activelyFiring && !ownCover
        && (!this.target || b.inWater || this.stuck >= 1 || undermining)
        && (dist > 2 || b.inWater || this.exit || undermining)
        && this.digT <= 0 && (lo || hi) && (b.onGround || b.inWater)) {
      this.digT = 0.32;
      this.lastDig = g.time;
      const uphill = dest.y - b.pos.y > 1.5;
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
      for (let y = fy - 1; y >= fy - 16 && !w.solid(gx, y, gz); y--) drop++;
      // Bridge only when the goal sits ABOVE the bottom of the drop ahead:
      // a ravine between two banks qualifies (even when the far bank is
      // lower); a valley we're descending into doesn't — walking down is
      // the point there. The scan reaches sixteen deep so a tall deck over
      // a gorge still reads the true bottom, not four blocks below the
      // planks — otherwise the bot stops bridging mid-span and walks off.
      if (drop >= 3 && goal.y > fy - drop) {
        this.bridgeT = 0.35;
        this.lastBridge = g.time; // hold the bridgelayer's pace while a drop is ahead
        // Deck the nearest hole first: hopping between plank tops skips
        // onGround frames, so always aiming 1.4 ahead can skip a column —
        // and a one-column gap in the deck is a fall into the ravine.
        for (const ahead of [0.8, 1.3, 1.8]) {
          const px = Math.floor(b.pos.x + dir.x * ahead);
          const pz = Math.floor(b.pos.z + dir.z * ahead);
          if (w.solid(px, fy - 1, pz)) continue;      // already decked
          if (g.tryBuild(this, px, fy - 1, pz)) break; // nearest hole plugged
        }
      }
    }

    // Group up: past midfield with no teammate in sight is how lone bots get
    // picked off. Creep cautiously until the team catches up. Defenders and
    // responders answer to their own urgency, not this rule.
    let cautious = false;
    if (!this.target && !this.carrier && !this.responding && this.role !== 'defend' && !b.inWater) {
      const over = this.heading > 0 ? b.pos.x > SX / 2 : b.pos.x < SX / 2;
      if (over) {
        cautious = true;
        for (const m of g.entities())
          if (m !== this && m.alive && m.team === this.team &&
              m.body.pos.distanceTo(b.pos) < 18) { cautious = false; break; }
      }
    }

    // Digging pace applies in water too: at full swim speed a bot outswims
    // its own shovel cadence (~1 block per swing) and never sits at a bank
    // face long enough to clear the ledge — the creek-bobbing loop.
    // Bots sprint too: unengaged and with somewhere to be, they run nearly
    // as fast as a sprinting player (5.4 × 1.45). Combat drops to a walk.
    const speed = (b.inWater ? (digging ? 1.4 : 3.2)
      : this.target ? 5.0          // close to patrol pace — a fight is not a standing trade
      : digging || bridging ? 2.2  // shovel/plank pace: never outrun the tool
      : this.responding ? 6.2      // urgency: our flag is on the ground
      : 6.0) * (cautious ? 0.45 : 1);
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
      // Horizontal displacement only: a bot bouncing in place under a low
      // canopy moves a full block vertically per hop and would otherwise
      // read as "making progress", never triggering the sidestep.
      const moved = Math.hypot(b.pos.x - this.lastPos.x, b.pos.z - this.lastPos.z);
      // dist>2 alone would never flag a bot pressed against its committed
      // exit wall (the wall IS the dest), so a wedged climb counts too —
      // but not mid-swing: a dig-climb is horizontal-stationary by nature.
      // A bot that's holding position on purpose (crouched behind cover,
      // planted for a ranged shot) used to trip this the same as one truly
      // wedged against terrain: after ~1.6s it would launch itself into a
      // jump loop and then abandon the position for a random wander,
      // self-sabotaging the exact fight it was winning. Discipline isn't
      // stuck.
      this.stuck = !holding && moved < 0.5 && (dist > 2 || this.exit) && !digging ? this.stuck + 1 : 0;
      this.lastPos.copy(b.pos);
    }
    if (this.stuck >= 1 && !(digging && hi)) b.jump();
    if (this.stuck >= 4) { // wedged on something unshovelled — sidestep
      this.wander.set((Math.random() - .5) * 30, 0, (Math.random() - .5) * 30);
      this.wanderT = 2;
      this.stuck = 0;
      this.exit = null;      // abandon the exit pick that led us here
    }

    b.move(dt);

    // Cover posture: duck while reloading behind the wall or riding out a
    // burst pause; stand to shoot. At range a bot crouch-fires for the
    // steadier spread — same trade the player's crouch makes. Same bounded
    // lerp as the player crouch.
    if (this.reloading > 0 && this.coverT > 0) this.duckT = Math.max(this.duckT, 0.2);
    let rangeDuck = this.target && foeD > 18 && this.aimT > reactT && b.onGround && !b.inWater;
    if (rangeDuck) {
      // Don't duck blind behind our own knee wall: if the crouched eye can't
      // see the foe but the standing eye can, stand and shoot over it.
      const duckEye = new THREE.Vector3(b.pos.x, b.pos.y + 0.97, b.pos.z);
      const standEye = new THREE.Vector3(b.pos.x, b.pos.y + 1.57, b.pos.z);
      if (!g.losClear(duckEye, this.target.body.eye()) &&
          g.losClear(standEye, this.target.body.eye())) rangeDuck = false;
    }
    const ducking = this.duckT > 0 || rangeDuck;
    b.half.h += ((ducking ? 1.15 : 1.75) - b.half.h) * Math.min(1, dt * 10);
    this.crouched = ducking; // fireHitscan reads this for the spread bonus
    setCrouch(this.parts, ducking);

    // --- grenades: one frag per life, lobbed over the knee walls foes
    // duck behind. Arc up a touch so it clears cover and lands at feet. ---
    this.nadeT -= dt;
    if (this.target && this.nades > 0 && this.nadeT <= 0 && !b.inWater &&
        foeD > 10 && foeD < 28 && Math.random() < dt * 0.25 &&
        g.losClear(b.eye(), this.target.body.eye())) {
      const lob = new THREE.Vector3().subVectors(this.target.body.pos, b.pos).normalize();
      lob.y += 0.45; lob.normalize();
      this.nades--; this.nadeT = 7;
      g.throwGrenade(this, b.eye(), lob, 11 + foeD * 0.15);
    }

    // --- shooting ---
    this.cooldown -= dt;
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) this.ammo = GUN.mag;
    } else if (this.target && this.aimT > reactT && this.cooldown <= 0) {
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
          // One randomization source, not two stacked ones: this used to
          // hand-jitter the aim vector AND let fireHitscan add GUN.spread on
          // top of that, every shot. Worse, the manual jitter shrank toward
          // a floor with aimT while GUN.spread never did — so a bot that had
          // held a target for two full seconds was still only as accurate as
          // the weapon's fixed spread allowed, and "holding aim longer" never
          // actually paid off the way the numbers implied it should. Aim
          // precisely and let the weapon's own spread (scaled by hold time
          // and skill, same as a human tightening up) be the only randomness.
          const aim = new THREE.Vector3().subVectors(this.target.body.eye(), from).normalize();
          const held = Math.min(1, (this.aimT - reactT) / 1.0); // 0 fresh -> 1 well-aimed
          const spreadMul = (1.8 - 1.3 * held) / this.skill;
          g.fireHitscan(this, from, aim, { ...GUN, spread: GUN.spread * spreadMul });
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
    placeShadow(this.parts, g.world, pg.rotation.y);
    // Tool in hand matches the work: spade out while the shovel is swinging.
    const shoveling = g.time - this.lastDig < 0.9;
    this.parts.gun.visible = !shoveling;
    this.parts.spade.visible = shoveling;
    animateSoldier(this.parts, Math.hypot(b.vel.x, b.vel.z), g.time + this.name.length);
  }

  _acquire() {
    // The flag thief gets no psychic outline: he is seen by the same eyes as
    // everyone else — in front of you, or close enough to hear.
    const to = new THREE.Vector3();
    let best = null, bestScore = 48;
    for (const f of this.game.foesOf(this.team)) {
      if (!f.alive) continue;
      const d = this.body.pos.distanceTo(f.body.pos);
      if (d >= 48) continue;
      if (f !== this.target) { // a target already being tracked stays tracked
        to.subVectors(f.body.pos, this.body.pos).setY(0).normalize();
        if (d > 7 && this.face.dot(to) < 0.26) continue; // outside the ~150° cone
      }
      // Distance is the baseline, but a flag carrier or someone already hurt
      // is worth reaching past a merely-nearer foe for — press an advantage
      // instead of restarting the fight on whoever's a step closer.
      const score = d - (f.carrier ? 20 : 0) - (100 - f.health) * 0.15;
      if (score >= bestScore) continue;
      if (this.game.losClear(this.body.eye(), f.body.eye())) { best = f; bestScore = score; }
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
    const placed = [];
    for (const off of [-1, 0, 1]) {
      const cx = Math.floor(b.pos.x + toFoe.x * 2.2 + perp.x * off);
      const cz = Math.floor(b.pos.z + toFoe.z * 2.2 + perp.z * off);
      const gy = w.solid(cx, fy - 1, cz) ? fy : w.solid(cx, fy - 2, cz) ? fy - 1 : null;
      if (gy !== null && this.game.tryBuild(this, cx, gy, cz)) placed.push([cx, cz]);
    }
    if (placed.length) {
      this.buildT = 9; this.coverT = 6;
      const now = this.game.time;
      this._cover = this._cover.filter(c => now - c.t < 8)
        .concat(placed.map(([x, z]) => ({ x, z, t: now })));
    }
  }

  die(killer) {
    this.alive = false;
    this.deadT = 0; // corpse tumble starts; the body hides itself when done
    this.parts.gun.visible = true; // drop the spade, back to the rifle
    this.parts.spade.visible = false;
    this.game.effects.burst(this.body.eye(), 26, this.team === 'blue' ? 0x4a6cd4 : 0x4a9e4a, 6);
    this.game.onDeath(this, killer);
  }

  respawn() {
    const p = this.game.spawnPoint(this.team);
    this.body.pos.set(p.x, p.y, p.z);
    this.body.vel.set(0, 0, 0);
    this.health = 100;
    this.alive = true;
    this.protT = 2; // same spawn protection humans get
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
    this.patrol = null;
    this.patrolT = 0;
    this.retreatT = 0;
    this.retreatCd = 0;
    this.nades = 1;
    this.nadeT = 0;
    this.crouched = false;
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
