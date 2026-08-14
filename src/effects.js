// effects.js — tracers, debris, explosions, screen shake. Small pools, no GC churn.
import * as THREE from 'three';
import { PALETTE } from './world.js';

const MAX_DEBRIS = 320;
const _m = new THREE.Matrix4(), _c = new THREE.Color(), _q = new THREE.Quaternion();
const _s = new THREE.Vector3(), _p = new THREE.Vector3();

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.shake = 0;

    // Debris — one InstancedMesh, recycled slots.
    this.debris = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.16, 0.16, 0.16),
      new THREE.MeshBasicMaterial(),
      MAX_DEBRIS
    );
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debris.count = 0;
    this.particles = [];
    scene.add(this.debris);

    // Tracers — pooled stretched boxes, additive glow.
    this.tracers = [];
    const tGeo = new THREE.BoxGeometry(0.045, 0.045, 1);
    const tMat = new THREE.MeshBasicMaterial({
      color: 0xffe9a8, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    for (let i = 0; i < 48; i++) {
      const m = new THREE.Mesh(tGeo, tMat.clone());
      m.visible = false;
      scene.add(m);
      this.tracers.push({ mesh: m, life: 0 });
    }

    // Explosion flash — expanding fading sphere.
    this.flash = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xffc46b, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false })
    );
    this.flash.visible = false;
    scene.add(this.flash);
    this.flashLife = 0;
  }

  tracer(from, to) {
    const t = this.tracers.find(t => t.life <= 0);
    if (!t) return;
    const len = from.distanceTo(to);
    t.mesh.position.copy(from).add(to).multiplyScalar(0.5);
    t.mesh.lookAt(to);
    t.mesh.scale.set(1, 1, len);
    t.mesh.visible = true;
    t.mesh.material.opacity = 0.9;
    t.life = 0.09;
  }

  burst(pos, count, hex, power = 5) {
    for (let i = 0; i < count && this.particles.length < MAX_DEBRIS; i++) {
      this.particles.push({
        pos: pos.clone().add(new THREE.Vector3((Math.random() - .5) * .6, Math.random() * .5, (Math.random() - .5) * .6)),
        vel: new THREE.Vector3((Math.random() - .5) * power, Math.random() * power, (Math.random() - .5) * power),
        life: 0.7 + Math.random() * 0.5,
        color: hex,
        spin: Math.random() * 8,
      });
    }
  }

  blockBurst(voxels) {
    for (const v of voxels.slice(0, 40)) {
      _p.set(v.x + 0.5, v.y + 0.5, v.z + 0.5);
      this.burst(_p, 1, PALETTE[v.v].color, 4);
    }
  }

  explode(pos) {
    this.flash.position.copy(pos);
    this.flash.visible = true;
    this.flashLife = 0.45;
    this.burst(pos, 60, 0xffa64d, 11);
    this.burst(pos, 30, 0x5a5a5a, 8);
  }

  addShake(amount) { this.shake = Math.min(this.shake + amount, 0.6); }

  update(dt) {
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      t.mesh.material.opacity = Math.max(0, t.life / 0.09) * 0.9;
      if (t.life <= 0) t.mesh.visible = false;
    }
    if (this.flashLife > 0) {
      this.flashLife -= dt;
      const k = 1 - this.flashLife / 0.45;
      this.flash.scale.setScalar(1 + k * 7);
      this.flash.material.opacity = 0.75 * (1 - k);
      if (this.flashLife <= 0) this.flash.visible = false;
    }
    // Debris physics.
    let n = 0;
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vel.y -= 22 * dt;
      p.pos.addScaledVector(p.vel, dt);
      this.particles[n++] = p;
    }
    this.particles.length = n;
    this.debris.count = n;
    for (let i = 0; i < n; i++) {
      const p = this.particles[i];
      _q.setFromAxisAngle(_s.set(1, 1, 0).normalize(), p.spin * p.life);
      _m.compose(p.pos, _q, _s.setScalar(Math.min(1, p.life * 2)));
      this.debris.setMatrixAt(i, _m);
      this.debris.setColorAt(i, _c.setHex(p.color));
    }
    if (n) {
      this.debris.instanceMatrix.needsUpdate = true;
      if (this.debris.instanceColor) this.debris.instanceColor.needsUpdate = true;
    }
    this.shake = Math.max(0, this.shake - dt * 1.8);
  }
}
