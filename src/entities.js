// entities.js — voxel AABB physics and the little blocky soldiers.
import * as THREE from 'three';
import { SEA } from './world.js';

const GRAVITY = -30;

export class Body {
  constructor(world, x, y, z) {
    this.world = world;
    this.pos = new THREE.Vector3(x, y, z); // feet center
    this.vel = new THREE.Vector3();
    this.half = { x: 0.32, h: 1.75 };      // half-width, full height
    this.onGround = false;
    this.inWater = false;
    this.guard = false; // crouch edge-guard: refuse to walk off a real drop
  }

  // Axis-separated integration: move one axis at a time, clamp on collision.
  move(dt) {
    const g = this.inWater ? GRAVITY * 0.25 : GRAVITY;
    this.vel.y = Math.max(this.vel.y + g * dt, -40);
    this._axis('x', this.vel.x * dt);
    this._axis('z', this.vel.z * dt);
    this.onGround = false;
    this._axis('y', this.vel.y * dt);
    this.inWater = this.pos.y < SEA + 0.4;
    if (this.pos.y < -8) { this.pos.y = SEA + 10; this.vel.set(0, 0, 0); } // safety net
  }

  _axis(axis, delta) {
    if (delta === 0) return;
    const old = this.pos[axis];
    this.pos[axis] += delta;
    const p = this.pos, h = this.half;
    const x0 = Math.floor(p.x - h.x), x1 = Math.floor(p.x + h.x);
    const y0 = Math.floor(p.y),        y1 = Math.floor(p.y + h.h);
    const z0 = Math.floor(p.z - h.x),  z1 = Math.floor(p.z + h.x);
    // Edge-guard (crouch-walking): never let the whole footprint leave solid
    // footing when the far side is more than a single step down. One-block
    // steps still pass, so slopes and stairs stay walkable while crouched;
    // ravine rims and parapets stop you cold.
    if (this.guard && this.onGround && axis !== 'y' && !this._footing(y0)) {
      p[axis] = old;
      this.vel[axis] = 0;
      return;
    }
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          if (!this.world.solid(x, y, z)) continue;
          if (axis === 'y') {
            if (delta < 0) { p.y = y + 1; this.onGround = true; }
            else p.y = y - h.h - 0.001;
            this.vel.y = 0;
          } else {
            // Auto-step: grounded and walking into a one-block rise with
            // headroom? Treat it as a stair, not a wall — lift onto it and
            // let the y-pass settle. Gated on walking (step === false while
            // sprinting) and never mid-air, so it can't grab a ledge you
            // were trying to drop past or turn sprint into a hill-climb.
            // p[axis] already holds the advanced position; _stepFits tests it.
            if (this.step !== false && this.onGround && !this.inWater
                && this.vel.y <= 0.01 && this._stepFits()) {
              p.y += 1.001;
              return;
            }
            const sign = Math.sign(delta);
            p[axis] = sign > 0
              ? (axis === 'x' ? x : z) - h.x - 0.001
              : (axis === 'x' ? x : z) + 1 + h.x + 0.001;
            this.vel[axis] = 0;
          }
          return;
        }
  }

  // Would the AABB fit if lifted one block at the current position, with
  // footing under the lifted feet? Caller has already advanced pos[axis].
  _stepFits() {
    const p = this.pos, h = this.half, y = p.y + 1.001;
    const x0 = Math.floor(p.x - h.x), x1 = Math.floor(p.x + h.x);
    const y0 = Math.floor(y),        y1 = Math.floor(y + h.h);
    const z0 = Math.floor(p.z - h.x), z1 = Math.floor(p.z + h.x);
    for (let yy = y0; yy <= y1; yy++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++)
          if (this.world.solid(x, yy, z)) return false;
    return this._footing(y0);
  }

  // Is there ground within one step anywhere under the footprint?
  _footing(y0) {
    const h = this.half, p = this.pos;
    for (let y = y0 - 1; y >= y0 - 2; y--)
      for (let x = Math.floor(p.x - h.x); x <= Math.floor(p.x + h.x); x++)
        for (let z = Math.floor(p.z - h.x); z <= Math.floor(p.z + h.x); z++)
          if (this.world.solid(x, y, z)) return true;
    return false;
  }

  jump() {
    if (this.onGround) this.vel.y = 9.5;
    else if (this.inWater) this.vel.y = 4; // swim upward
  }

  eye() { return new THREE.Vector3(this.pos.x, this.pos.y + this.half.h - 0.18, this.pos.z); }
}

// A blocky AoS-style soldier: legs, torso, arms, head, gun — team colored.
// Soft blob shadow shared by every soldier — a radial-gradient quad at the
// feet. Grounds the model for two triangles. Shared resources are tagged so
// disposeObject leaves them alone.
let blobGeo = null, blobMat = null;
function blobShadow() {
  if (!blobGeo) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g2 = c.getContext('2d');
    const rg = g2.createRadialGradient(32, 32, 4, 32, 32, 30);
    rg.addColorStop(0, 'rgba(0,0,0,.42)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g2.fillStyle = rg;
    g2.fillRect(0, 0, 64, 64);
    blobGeo = new THREE.PlaneGeometry(1.2, 1.2);
    blobMat = new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false,
    });
  }
  const m = new THREE.Mesh(blobGeo, blobMat);
  m.userData.shared = true;
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.035;
  return m;
}

export function makeSoldier(teamColor) {
  const g = new THREE.Group();
  const skin = new THREE.MeshBasicMaterial({ color: 0xd9a066 });
  const cloth = new THREE.MeshBasicMaterial({ color: teamColor });
  const dark = new THREE.MeshBasicMaterial({ color: 0x2b2b30 });
  const box = (w, h, d, mat, x, y, z, parent = g) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };

  const legL = box(0.22, 0.6, 0.24, dark,  -0.14, 0.3, 0);
  const legR = box(0.22, 0.6, 0.24, dark,   0.14, 0.3, 0);
  legL.geometry.translate(0, -0.3, 0); legL.position.y = 0.6;
  legR.geometry.translate(0, -0.3, 0); legR.position.y = 0.6;
  const torso = box(0.55, 0.62, 0.32, cloth, 0, 0.92, 0);
  const armL = box(0.16, 0.55, 0.18, cloth, -0.36, 1.18, 0);
  const armR = box(0.16, 0.55, 0.18, cloth,  0.36, 1.18, 0);
  armL.geometry.translate(0, -0.26, 0);
  armR.geometry.translate(0, -0.26, 0);
  const head = box(0.34, 0.34, 0.34, skin, 0, 1.42, 0);
  const brim = box(0.4, 0.12, 0.4, cloth, 0, 1.62, 0); // helmet brim
  const gun = box(0.09, 0.12, 0.7, dark, 0.2, 1.1, -0.35);
  const blob = blobShadow();
  g.add(blob);

  return { group: g, legL, legR, armL, armR, head, torso, gun, blob, brim };
}

// A floating callsign: crisp canvas sprite riding above the helmet. It's an
// ordinary depth-tested scene object, so terrain occludes it exactly when the
// soldier underneath is hidden — you never read a name through a hill.
export function makeNametag(name, team) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 56;
  const g2 = c.getContext('2d');
  g2.font = '700 30px system-ui, sans-serif';
  g2.textAlign = 'center';
  g2.shadowColor = 'rgba(0,0,0,.8)';
  g2.shadowBlur = 6;
  g2.fillStyle = team === 'blue' ? '#a8bcff' : '#b5ecb5';
  g2.fillText(name, 128, 38);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), depthWrite: false,
  }));
  s.scale.set(2.2, 0.48, 1);
  s.position.y = 2.15;
  return s;
}

// Crouch pose: legs squash, everything above the hips drops. The collision
// body still spans the same two voxel rows, so standing back up can never
// wedge the soldier into a ceiling.
export function setCrouch(parts, on) {
  if (!!parts.crouched === on) return;
  parts.crouched = on;
  parts.legL.scale.y = parts.legR.scale.y = on ? 0.5 : 1;
  parts.legL.position.y = parts.legR.position.y = on ? 0.3 : 0.6;
  parts.torso.position.y = on ? 0.62 : 0.92;
  parts.armL.position.y = parts.armR.position.y = on ? 0.88 : 1.18;
  parts.head.position.y = on ? 1.12 : 1.42;
  parts.brim.position.y = on ? 1.32 : 1.62;
  parts.gun.position.y = on ? 0.8 : 1.1;
}

// Shared walk-cycle animation for player-less bodies.
export function animateSoldier(parts, speed, t) {
  const swing = Math.min(1, speed / 4) * 0.7;
  const s = Math.sin(t * 9) * swing;
  parts.legL.rotation.x = s;
  parts.legR.rotation.x = -s;
  parts.armL.rotation.x = -s * 0.8;
  parts.armR.rotation.x = s * 0.8;
}

// Death tumble, t seconds since the killing blow: keel over backward around
// the feet, lie still a beat, then sink into the dirt and vanish.
export function animateDeath(parts, t) {
  if (parts.blob) parts.blob.visible = false; // shadows don't tumble
  const g = parts.group;
  const fall = Math.min(1, t / 0.3);
  g.rotation.x = -Math.PI / 2 * fall * (2 - fall); // ease-out tip-over
  if (g.userData.deathY === undefined) g.userData.deathY = g.position.y;
  g.position.y = g.userData.deathY - Math.max(0, t - 0.85) * 2.2;
  if (t > 1.35) g.visible = false;
}

// Back on your feet — called on respawn before the next update tick.
export function resetDeath(parts) {
  parts.group.rotation.x = 0;
  parts.group.userData.deathY = undefined;
  if (parts.blob) parts.blob.visible = true;
}

// Remove an object from its parent and release all GPU resources below it.
export function disposeObject(root) {
  root.removeFromParent();
  root.traverse(o => {
    if (o.userData.shared) return; // shared geometry/material outlives any one soldier
    o.geometry?.dispose();
    if (o.material) {
      o.material.map?.dispose();
      o.material.dispose();
    }
  });
}
