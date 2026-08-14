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
    this.pos[axis] += delta;
    const p = this.pos, h = this.half;
    const x0 = Math.floor(p.x - h.x), x1 = Math.floor(p.x + h.x);
    const y0 = Math.floor(p.y),        y1 = Math.floor(p.y + h.h);
    const z0 = Math.floor(p.z - h.x),  z1 = Math.floor(p.z + h.x);
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          if (!this.world.solid(x, y, z)) continue;
          if (axis === 'y') {
            if (delta < 0) { p.y = y + 1; this.onGround = true; }
            else p.y = y - h.h - 0.001;
            this.vel.y = 0;
          } else {
            const sign = Math.sign(delta);
            p[axis] = sign > 0
              ? (axis === 'x' ? x : z) - h.x - 0.001
              : (axis === 'x' ? x : z) + 1 + h.x + 0.001;
            this.vel[axis] = 0;
          }
          return;
        }
  }

  jump() {
    if (this.onGround) this.vel.y = 9.5;
    else if (this.inWater) this.vel.y = 4; // swim upward
  }

  eye() { return new THREE.Vector3(this.pos.x, this.pos.y + this.half.h - 0.18, this.pos.z); }
}

// A blocky AoS-style soldier: legs, torso, arms, head, gun — team colored.
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
  box(0.4, 0.12, 0.4, cloth, 0, 1.62, 0); // helmet brim
  const gun = box(0.09, 0.12, 0.7, dark, 0.2, 1.1, -0.35);

  return { group: g, legL, legR, armL, armR, head, torso, gun };
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

// Remove an object from its parent and release all GPU resources below it.
export function disposeObject(root) {
  root.removeFromParent();
  root.traverse(o => {
    o.geometry?.dispose();
    if (o.material) {
      o.material.map?.dispose();
      o.material.dispose();
    }
  });
}
