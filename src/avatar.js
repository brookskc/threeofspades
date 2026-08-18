// avatar.js — remote soldiers: model, nametag, snapshot interpolation.
import * as THREE from 'three';
import { makeSoldier, makeNametag, animateSoldier, animateDeath, resetDeath, disposeObject, setCrouch } from './entities.js';
import { sfx } from './audio.js';

export class Avatar {
  constructor(parent, team, name) {
    this.team = team;
    this.parts = makeSoldier(team === 'blue' ? 0x4a6cd4 : 0x4a9e4a);
    this.group = this.parts.group;
    this.group.add(makeNametag(name, team));
    parent.add(this.group);
    this.group.visible = false; // until the first update() places us
    this.samples = []; // [receiptTime, x, y, z, yaw]
    this.alive = true;
    this.crouch = false;
    this.deadAt = null;  // wall-clock time of death, while the corpse tumbles
    this.pos = new THREE.Vector3();
    this.yaw = 0;
  }

  // ry is model-space rotation.y (soldier forward is -Z).
  push(x, y, z, ry) {
    // Measure the arrival process: EWMA of the gap between snapshots and of
    // its jitter. The render delay below is derived from this, so a clean
    // link gets a small buffer and a jittery one gets what it needs — nothing
    // on the wire, nothing advertised by the host.
    const now = performance.now() / 1000;
    if (this.lastArrival) {
      const gap = now - this.lastArrival;
      this.interval = this.interval ? this.interval + 0.1 * (gap - this.interval) : gap;
      this.jitter = (this.jitter ?? 0) + 0.1 * (Math.abs(gap - this.interval) - (this.jitter ?? 0));
    }
    this.lastArrival = now;
    const s = this.samples, last = s[s.length - 1];
    // Teleports (respawn, lag stall) snap instead of gliding from the old spot.
    if (last && Math.hypot(x - last[1], y - last[2], z - last[3]) > 8) s.length = 0;
    s.push([now, x, y, z, ry]);
    if (s.length > 12) s.shift();
  }

  // Death starts the corpse tumble; respawn drops position history so the
  // avatar snaps to its spawn instead of gliding from the corpse. Respawn
  // also hides the body until a fresh snapshot places it — otherwise it
  // stands at the death spot for a frame or two (the mid-map ghost flash).
  // A brand-new avatar learning its owner is already dead skips the tumble
  // replay: that corpse fell long before we got here.
  setAlive(alive) {
    if (alive === this.alive) return;
    this.alive = alive;
    if (alive) {
      this.samples.length = 0;
      this.lastArrival = null; this.interval = 0; this.jitter = 0; // fresh stats
      this.deadAt = null;
      this.group.visible = false;
      resetDeath(this.parts);
    } else {
      this.deadAt = performance.now() / 1000 - (this.samples.length ? 0 : 2);
    }
  }

  setCrouch(on) { this.crouch = on; }

  // Render just far enough in the past to bracket two snapshots: one
  // observed interval plus two jitter sigmas, clamped to sanity. A clean
  // 15Hz link lands near 80ms; the old fixed 130ms assumed the worst.
  update(gameT) {
    const now = performance.now() / 1000;
    const delay = Math.min(0.22, Math.max(0.06,
      1.15 * (this.interval || 0.083) + 2 * (this.jitter ?? 0)));
    const rt = now - delay;
    const s = this.samples;
    if (!s.length) { this.group.visible = false; return; } // nothing valid to show
    let a = s[0], b = s[s.length - 1];
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i][0] <= rt) { a = s[i]; b = s[Math.min(i + 1, s.length - 1)]; break; }
    }
    const span = b[0] - a[0];
    const k = span > 0 ? Math.min(1, Math.max(0, (rt - a[0]) / span)) : 1;
    const nx = a[1] + (b[1] - a[1]) * k;
    const ny = a[2] + (b[2] - a[2]) * k;
    const nz = a[3] + (b[3] - a[3]) * k;
    let dry = b[4] - a[4];
    if (dry > Math.PI) dry -= Math.PI * 2;
    if (dry < -Math.PI) dry += Math.PI * 2;
    // Walk-cycle speed from real velocity: per-frame displacement divided by
    // the actual frame delta, so high-refresh displays don't slow the gait.
    const fdt = this._lastUpd ? Math.max(1e-3, now - this._lastUpd) : 1 / 60;
    this._lastUpd = now;
    const speed = this.pos.distanceTo(new THREE.Vector3(nx, ny, nz)) / fdt;
    this.pos.set(nx, ny, nz);
    this.group.position.copy(this.pos);
    // Footsteps off the interpolated ground truth: 2.2 blocks of travel, one
    // step sound where they actually are.
    if (this.alive && this._px !== undefined) {
      this._stepAcc = (this._stepAcc ?? 0) + Math.hypot(nx - this._px, nz - this._pz);
      if (this._stepAcc >= 2.2) { this._stepAcc = 0; sfx.at('step', this.pos); }
    }
    this._px = nx; this._pz = nz;

    if (!this.alive) { // corpse: tumble where it fell, then vanish
      if (this.deadAt !== null) animateDeath(this.parts, performance.now() / 1000 - this.deadAt);
      return;
    }
    this.group.visible = true;
    this.group.rotation.y = a[4] + dry * k;
    animateSoldier(this.parts, speed, gameT + this.pos.x);
    setCrouch(this.parts, this.crouch);
  }

  dispose() { disposeObject(this.group); }
}
