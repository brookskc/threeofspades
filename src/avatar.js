// avatar.js — remote soldiers: model, nametag, snapshot interpolation.
import * as THREE from 'three';
import { makeSoldier, animateSoldier, disposeObject } from './entities.js';

function makeNameSprite(name, team) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 56;
  const g = c.getContext('2d');
  g.font = '700 30px system-ui, sans-serif';
  g.textAlign = 'center';
  g.shadowColor = 'rgba(0,0,0,.8)';
  g.shadowBlur = 6;
  g.fillStyle = team === 'blue' ? '#a8bcff' : '#b5ecb5';
  g.fillText(name, 128, 38);
  const tex = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  s.scale.set(2.2, 0.48, 1);
  s.position.y = 2.15;
  return s;
}

export class Avatar {
  constructor(parent, team, name) {
    this.team = team;
    this.parts = makeSoldier(team === 'blue' ? 0x4a6cd4 : 0x4a9e4a);
    this.group = this.parts.group;
    this.group.add(makeNameSprite(name, team));
    parent.add(this.group);
    this.samples = []; // [receiptTime, x, y, z, yaw]
    this.alive = true;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
  }

  // ry is model-space rotation.y (soldier forward is -Z).
  push(x, y, z, ry) {
    this.samples.push([performance.now() / 1000, x, y, z, ry]);
    if (this.samples.length > 12) this.samples.shift();
  }

  // Render ~130ms in the past, interpolating between bracketing snapshots.
  update(gameT) {
    const rt = performance.now() / 1000 - 0.13;
    const s = this.samples;
    if (!s.length) return;
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
    const speed = this.pos.distanceTo(new THREE.Vector3(nx, ny, nz)) * 10;
    this.pos.set(nx, ny, nz);

    this.group.visible = this.alive;
    this.group.position.copy(this.pos);
    this.group.rotation.y = a[4] + dry * k;
    animateSoldier(this.parts, speed, gameT + this.pos.x);
  }

  dispose() { disposeObject(this.group); }
}
