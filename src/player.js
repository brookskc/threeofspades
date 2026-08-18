// player.js — first-person controls, tools (rifle / smg / spade / block), viewmodel.
import * as THREE from 'three';
import { Body } from './entities.js';
import { sfx } from './audio.js';

// kick: degrees of aim climb per shot (recoil). aimSpread: hip-fire spread
// multiplier while sighted. The SMG's small kick compounds at 10 rounds/s —
// spray without pulling down walks over heads past ~25 blocks; the rifle's
// big kick fully recovers between its slow shots, so tap-fire stays laser.
export const TOOLS = [
  { key: 'rifle', name: 'RIFLE', damage: 55, headMult: 2, interval: 0.55, spread: 0.0012,
    mag: 10, reload: 2.2, auto: false, zoom: 1.5, kick: 0.021, aimSpread: 0.5 },
  { key: 'smg', name: 'SMG', damage: 22, headMult: 1.6, interval: 0.1, spread: 0.02,
    mag: 30, reload: 1.8, auto: true, zoom: 1.2, kick: 0.0105, aimSpread: 0.7 },
  { key: 'spade', name: 'SPADE', interval: 0.3 },
  { key: 'block', name: 'BLOCK', interval: 0.18 },
  { key: 'nade', name: 'GRENADE', interval: 0.8 },
];

const BASE_FOV = 75;

export class Player {
  constructor(game, camera, dom) {
    this.game = game;
    this.camera = camera;
    this.dom = dom;
    this.team = 'green';
    const b = game.spawnPoint('green');
    this.body = new Body(game.world, b.x, b.y, b.z);
    this.health = 100;
    this.alive = true;
    this.yaw = 0; // face the enemy base (+x)
    this.pitch = 0;
    this.keys = {};
    this.mouseDown = [false, false, false];
    this.tool = 0;
    this.ammo = TOOLS.map(t => t.mag ?? 0);
    this.blocks = 50;
    this.grenades = 3;
    this.grenadeRegen = 0;
    this.cooldown = 0;
    this.reloading = 0;
    this.bob = 0;
    this.recoil = 0;
    this.climb = 0;      // accumulated recoil climb — part of the AIM, not cosmetic
    this._sinceShot = 99; // recovery starts 0.12s after the last shot
    this.aiming = false;  // RMB held with a gun out
    this.aimK = 0;        // 0..1 iron-sights blend (viewmodel + crosshair)
    this.stepK = 0;       // banked auto-step rise the camera is easing out
    this.swing = 0; // spade chop animation
    this.crouched = false; // hold CTRL: slower, steadier aim, ledge grip
    this.carrier = false; // carrying the enemy flag?

    this._buildViewmodel();
    this._bind(dom);
  }

  // ---------------- input ----------------
  _bind(dom) {
    addEventListener('keydown', e => {
      if (e.repeat) return;
      // Typing beats game keys — but only where typing makes sense: the
      // chat box, or a lobby input while the menu is actually up. The menu
      // fades out with opacity (still laid out), so a callsign box left
      // focused after deploy would otherwise keep eating WASD mid-match.
      if (e.target.tagName === 'INPUT') {
        const menuUp = !document.getElementById('menu').classList.contains('hidden');
        if (e.target.id === 'chatin' || menuUp) return;
      }
      this.keys[e.code] = true;
      // TAB scoreboard works while dead too — the redeploy wait is exactly
      // when you want it. preventDefault keeps browser focus in the page.
      if (e.code === 'Tab') { e.preventDefault(); this.game.hud.statsShow(this.game); return; }
      if (!this.alive) return;
      if (e.code >= 'Digit1' && e.code <= 'Digit5')
        this._selectTool(Number(e.code.slice(-1)) - 1);
      if (e.code === 'KeyQ' || e.code === 'KeyE') // cycle back / forward
        this._selectTool((this.tool + (e.code === 'KeyE' ? 1 : -1) + TOOLS.length) % TOOLS.length);
      if (e.code === 'KeyR' && this.tool < 2 && this.ammo[this.tool] < TOOLS[this.tool].mag)
        this._reload();
      if (e.code === 'Space') { this.slideT = 0; this.body.jump(); } // hop out of a slide
    });
    addEventListener('keyup', e => {
      this.keys[e.code] = false;
      if (e.code === 'Tab') this.game.hud.statsHide();
    });
    // A click only counts if the pointer was already locked when it landed.
    // The click that re-locks the pointer must never fire the tool: it used
    // to throw a grenade nobody aimed (lock engaged a moment later, the held
    // flag was still set, and the "first" grenade went off on its own).
    dom.addEventListener('mousedown', e => {
      if (document.pointerLockElement === dom) this.mouseDown[e.button] = true;
    });
    addEventListener('mouseup', e => { this.mouseDown[e.button] = false; });
    document.addEventListener('pointerlockchange', () => {
      this.mouseDown = [false, false, false];
    });
    addEventListener('mousemove', e => {
      if (document.pointerLockElement !== dom) return;
      // Sensitivity follows the zoom: sighted in, the same mouse travel
      // covers less view, so fine aim stays reachable.
      const sens = 0.0022 * (this.camera.fov / BASE_FOV);
      this.yaw -= e.movementX * sens;
      this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - e.movementY * sens));
    });
    addEventListener('contextmenu', e => e.preventDefault());
  }

  _selectTool(i) {
    if (i === this.tool) return;
    this.tool = i;
    this.reloading = 0;
    sfx.click();
    this._syncViewmodel();
    this.game.hud.refreshTool(this);
  }

  _reload() {
    if (this.reloading > 0) return;
    this.reloading = TOOLS[this.tool].reload;
    sfx.click();
    this.game.hud.refreshTool(this);
  }

  _throwGrenade() {
    if (!this.alive) return;
    if (this.grenades <= 0) { sfx.click(); return; } // dry — the pin clicks on nothing
    this.grenades--;
    this.recoil = Math.min(1, this.recoil + 0.35);   // little throwing-arm kick
    sfx.throw_();
    this.game.requestNade(this);
    this._syncViewmodel(); // the last one leaves an empty hand
    this.game.hud.refreshTool(this);
  }

  lookDir() {
    const pitch = this.pitch + this.climb; // recoil climb steers real shots
    return new THREE.Vector3(
      Math.cos(pitch) * Math.cos(this.yaw),
      Math.sin(pitch),
      -Math.cos(pitch) * Math.sin(this.yaw)
    );
  }

  // ---------------- viewmodel ----------------
  _buildViewmodel() {
    const dark = new THREE.MeshBasicMaterial({ color: 0x23252b });
    const wood = new THREE.MeshBasicMaterial({ color: 0x6b4a2c });
    const green = new THREE.MeshBasicMaterial({ color: 0x4a9e4a });
    const skin = new THREE.MeshBasicMaterial({ color: 0xd9a066 });
    const mk = (w, h, d, mat, x, y, z, parent) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };
    this.vm = {};
    const root = new THREE.Group();
    this.camera.add(root);
    this.vmRoot = root;

    // Iron sights are REAL: a rear notch and a front post, on ONE sight
    // plane. Sighted in (aimK = 1) the gun sits at (0, -0.09) under the eye,
    // so the local y of the aim line is +0.09 — the front post tip AND the
    // rear wing tops both live exactly there (the wings run down flush with
    // the barrel). Line the post up with the target between the wings, fire.
    const sights = (g, frontZ, rearZ) => {
      mk(0.012, 0.055, 0.012, dark, 0, 0.0625, frontZ, g);     // front post
      mk(0.012, 0.055, 0.03, dark, -0.024, 0.0625, rearZ, g);  // rear wing L
      mk(0.012, 0.055, 0.03, dark,  0.024, 0.0625, rearZ, g);  // rear wing R
    };
    const rifle = new THREE.Group();
    mk(0.05, 0.07, 0.85, dark, 0, 0, -0.5, rifle);       // barrel
    mk(0.07, 0.12, 0.35, wood, 0, -0.05, -0.05, rifle);  // stock
    mk(0.05, 0.1, 0.06, skin, 0, -0.12, 0.05, rifle);    // hand
    sights(rifle, -0.85, -0.12);
    this.vm.rifle = rifle;

    const smg = new THREE.Group();
    mk(0.06, 0.08, 0.5, dark, 0, 0, -0.32, smg);
    mk(0.05, 0.16, 0.07, dark, 0, -0.11, -0.12, smg);    // magazine
    mk(0.05, 0.1, 0.06, skin, 0, -0.1, 0.05, smg);
    sights(smg, -0.53, -0.1);
    this.vm.smg = smg;

    const spade = new THREE.Group();
    mk(0.035, 0.035, 0.5, wood, 0, 0, -0.25, spade);     // handle
    mk(0.12, 0.16, 0.03, dark, 0, 0, -0.52, spade);      // blade
    this.vm.spade = spade;

    const block = new THREE.Group();
    mk(0.16, 0.16, 0.16, green, 0, 0, -0.3, block);
    mk(0.05, 0.1, 0.06, skin, 0, -0.12, -0.2, block);
    this.vm.block = block;

    const nade = new THREE.Group();
    mk(0.09, 0.11, 0.09, dark, 0, 0, -0.3, nade);        // body
    mk(0.03, 0.05, 0.03, dark, 0, 0.07, -0.3, nade);     // spoon
    mk(0.05, 0.1, 0.06, skin, 0, -0.1, -0.22, nade);     // hand
    this.vm.nade = nade;

    // All three thrown: the hand stays up, but it's holding nothing.
    const empty = new THREE.Group();
    mk(0.05, 0.1, 0.06, skin, 0, -0.1, -0.22, empty);    // empty hand
    this.vm.empty = empty;

    for (const k in this.vm) root.add(this.vm[k]);
    this.vmRoot.position.set(0.28, -0.26, -0.25);
    this._syncViewmodel();
  }

  _syncViewmodel() {
    for (const k in this.vm) this.vm[k].visible = false;
    const key = TOOLS[this.tool].key;
    // Dry on frags? Show the empty hand, not a phantom grenade.
    this.vm[key === 'nade' && this.grenades <= 0 ? 'empty' : key].visible = true;
  }

  // ---------------- per-frame ----------------
  update(dt) {
    if (!this.alive) return;
    const b = this.body;
    // Crouch (hold CTRL): trades speed for a steadier aim. Both heights still
    // span two voxel rows, so standing up can never wedge us into a ceiling.
    this.crouched = !!(this.keys['ControlLeft'] || this.keys['ControlRight']);
    // Slide: crouch mid-sprint at speed and you skid low — a burst of
    // momentum, barely any steering, no ledge-guard. Jump pops out of it.
    this.slideT = Math.max(0, (this.slideT ?? 0) - dt);
    this.slideCd = Math.max(0, (this.slideCd ?? 0) - dt);
    const hspeed = Math.hypot(b.vel.x, b.vel.z);
    if (this.crouched && !this._wasCrouched && this.keys['ShiftLeft']
        && b.onGround && hspeed > 6 && this.slideCd <= 0) {
      this.slideT = 0.7; this.slideCd = 1.4;
      const boost = 9 / Math.max(hspeed, 0.01);
      b.vel.x *= boost; b.vel.z *= boost;
      sfx.slide();
    }
    if (hspeed < 3) this.slideT = 0;
    this._wasCrouched = this.crouched;
    const sliding = this.slideT > 0;
    const targetH = sliding ? 1.0 : this.crouched ? 1.15 : 1.75;
    b.half.h += (targetH - b.half.h) * Math.min(1, dt * 10);
    // Crouch-walking grips the rim: no falling into ravines or off parapets.
    // A slide has no such brakes — skidding off the edge is the whole point.
    b.guard = this.crouched && !sliding;
    const shift = !!(this.keys['ShiftLeft'] || this.keys['ShiftRight']);
    const sprint = !this.crouched && this.keys['ShiftLeft'] ? 1.45 : 1;
    // Iron sights: RMB with a gun trades mobility for accuracy.
    this.aiming = !!(this.mouseDown[2] && this.tool < 2);
    const speed = (b.inWater ? 3.2 : 5.4) * sprint * (this.crouched ? 0.45 : 1)
      * (this.aiming ? 0.6 : 1);
    // Auto-step climbs one-block rises. Crouching keeps you hugging the
    // ground — no clambering while sneaking — unless you hold SHIFT to
    // climb anyway; a slide skids over nothing.
    b.step = (!this.crouched || shift) && !sliding;
    const f = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const r = new THREE.Vector3(-f.z, 0, f.x);
    const wish = new THREE.Vector3();
    if (this.keys['KeyW']) wish.add(f);
    if (this.keys['KeyS']) wish.sub(f);
    if (this.keys['KeyD']) wish.add(r);
    if (this.keys['KeyA']) wish.sub(r);
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
    // Snappy but not slippery. A slide overrides steering entirely: momentum
    // and a little ground friction decide where you stop.
    if (sliding) {
      const fr = Math.max(0, 1 - dt * 1.6);
      b.vel.x *= fr; b.vel.z *= fr;
    } else {
      b.vel.x += (wish.x - b.vel.x) * Math.min(1, dt * 12);
      b.vel.z += (wish.z - b.vel.z) * Math.min(1, dt * 12);
    }
    b.move(dt);

    // Auto-step smoothing: the body pops up a full block in one physics
    // frame; the camera shouldn't. A step banks +1 into stepK and the eye
    // eases it back out, so stair-climbing reads as a smooth rise.
    if (b._stepped) { this.stepK = Math.min(1.05, (this.stepK ?? 0) + 1); b._stepped = false; }
    this.stepK = Math.max(0, (this.stepK ?? 0) - dt * 7);

    // Camera: eye + walk bob + recoil kick.
    const moving = wish.lengthSq() > 1 && b.onGround;
    this.bob = moving ? this.bob + dt * 10 : 0;
    this.recoil = Math.max(0, this.recoil - dt * 6);
    // Recoil climb recovers only once you've stopped firing for a beat:
    // sustained spray accumulates it, disciplined bursts never feel it.
    this._sinceShot += dt;
    if (this._sinceShot > 0.12) this.climb = Math.max(0, this.climb - dt * 0.105);
    const eye = b.eye();
    this.camera.position.set(eye.x,
      eye.y + Math.sin(this.bob) * 0.045 * (moving ? 1 : 0) - (this.stepK ?? 0), eye.z);
    this.camera.rotation.set(this.pitch + this.climb + this.recoil * 0.05, this.yaw - Math.PI / 2, 0, 'YXZ');
    // three.js cameras look down -Z; the -PI/2 offset aligns it with our yaw convention.

    // Viewmodel sway + reload dip + spade chop (raise, then strike forward).
    // Sighted in, the gun slides to center-screen and the crosshair fades —
    // you're looking down the sights instead.
    this.aimK += ((this.aiming ? 1 : 0) - this.aimK) * Math.min(1, dt * 10);
    this.swing = Math.max(0, this.swing - dt * 3.3);
    const chop = this.tool === 2 ? Math.sin(this.swing * Math.PI) : 0;
    this.vmRoot.position.x = 0.28 * (1 - this.aimK);
    this.vmRoot.position.y = -0.26 + this.aimK * 0.17
      + Math.sin(this.bob * 2) * 0.008 * (1 - this.aimK) - this.recoil * 0.04
      + chop * 0.06
      - (this.reloading > 0 ? 0.18 * Math.sin(Math.PI * (1 - this.reloading / TOOLS[this.tool].reload)) : 0);
    this.vmRoot.position.z = -0.25 - chop * 0.22 + this.aimK * 0.1;
    this.vmRoot.rotation.x = -this.recoil * 0.35 - chop * 0.5;
    // Fully sighted in, the dot is gone entirely — the sights do the aiming.
    const xh = document.getElementById('crosshair');
    if (xh) xh.style.opacity = 1 - this.aimK;

    // Aim zoom.
    const aiming = this.mouseDown[2] && this.tool < 2;
    const targetFov = aiming ? BASE_FOV / TOOLS[this.tool].zoom : BASE_FOV;
    if (Math.abs(this.camera.fov - targetFov) > 0.1) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 14);
      this.camera.updateProjectionMatrix();
    }

    // Tool usage.
    this.cooldown -= dt;
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        this.ammo[this.tool] = TOOLS[this.tool].mag;
        this.game.hud.refreshTool(this);
      }
    // The lock gate: a click that lands while the pointer is unlocked (the
    // click that re-locks it) must never fire the tool — it used to throw a
    // grenade nobody aimed.
    } else if (this.mouseDown[0] && this.cooldown <= 0
               && document.pointerLockElement === this.dom) {
      const t = TOOLS[this.tool];
      if (!t.auto) this.mouseDown[0] = false;
      this.cooldown = t.interval;
      this._useTool();
    }

    // Grenade trickle-back.
    if (this.grenades < 3) {
      this.grenadeRegen += dt;
      if (this.grenadeRegen > 12) { this.grenadeRegen = 0; this.grenades++;
        this._syncViewmodel(); this.game.hud.refreshTool(this); }
    }
  }

  _useTool() {
    const t = TOOLS[this.tool];
    if (t.key === 'spade') { this.swing = 1; return this.game.requestDig(this); }
    if (t.key === 'block') return this.game.requestPlace(this);
    if (t.key === 'nade') return this._throwGrenade();
    if (this.ammo[this.tool] <= 0) { sfx.click(); return this._reload(); }
    this.ammo[this.tool]--;
    this.recoil = Math.min(1, this.recoil + (t.key === 'rifle' ? 0.9 : 0.35));
    sfx[t.key]();
    // Fire FIRST, then kick: the shot leaves along the aim you had when you
    // squeezed, and the climb only taxes the FOLLOW-UP shots. (Applying the
    // kick before firing made every first shot land high — players were
    // aiming low to compensate.)
    this.game.requestShoot(this, t);
    this.climb = Math.min(0.14, this.climb + (t.kick ?? 0)); // aim climbs per shot
    this._sinceShot = 0;
    this.game.hud.refreshTool(this);
  }

  die(killer) {
    this.alive = false;
    this.health = 0;
    this.deadT = 0;
    this.crouched = false;
    this.body.half.h = 1.75;
    this.swing = 0;
    this.vmRoot.visible = false; // no floating gun while down
    sfx.hurt();
    this.game.onDeath(this, killer);
  }

  // First-person death: crumple to the dirt with a roll, hold until respawn.
  deathCam(dt) {
    this.deadT = Math.min(1, this.deadT + dt * 2.4);
    const k = this.deadT * this.deadT * (3 - 2 * this.deadT); // smoothstep
    const eye = this.body.eye();
    this.camera.position.set(eye.x, eye.y - k * 1.2, eye.z);
    this.camera.rotation.set(this.pitch + k * 0.3, this.yaw - Math.PI / 2, k * 0.5, 'YXZ');
  }

  respawn(at = null) {
    const p = at ?? this.game.spawnPoint(this.team);
    this.body.pos.set(p.x, p.y, p.z);
    this.body.vel.set(0, 0, 0);
    this.yaw = this.team === 'green' ? 0 : Math.PI; // face the enemy
    this.pitch = 0;
    this.climb = 0;
    this.aiming = false; this.aimK = 0;
    this.health = 100;
    this.alive = true;
    this.protT = 2; // spawn protection: 2s, drains twice as fast moving, gone if you fire
    this.slideT = 0; this.slideCd = 0;
    this.stepK = 0;
    this.ammo = TOOLS.map(t => t.mag ?? 0);
    this.grenades = 3;      // fresh loadout on every life — a spent belt used
    this.grenadeRegen = 0;  // to follow you through respawns and map rotations
    this.blocks = 50;
    this.cooldown = 0;
    this.reloading = 0;
    this.deadT = 0;
    this.crouched = false;
    this.body.half.h = 1.75;
    this.vmRoot.visible = true;
    this._syncViewmodel(); // full belt: the hand holds a frag again
    sfx.respawn();
  }
}
