// player.js — first-person controls, tools (rifle / smg / spade / block), viewmodel.
import * as THREE from 'three';
import { Body } from './entities.js';
import { sfx } from './audio.js';
import { stats } from './stats.js';
import { SX, SY, SZ } from './world.js';

// kick: degrees of aim climb per shot (recoil). aimSpread: hip-fire spread
// multiplier while sighted. The SMG's small kick compounds at 10 rounds/s —
// spray without pulling down walks over heads past ~25 blocks; the rifle's
// big kick fully recovers between its slow shots, so tap-fire stays laser.
// dropVel: bullet-drop "velocity" — see Game#_dropCompensate. Not a literal
// muzzle velocity; tuned so drop is felt at THIS game's actual engagement
// ranges (max 130 units) rather than true-to-life numbers, which would be
// imperceptible at that distance for any real firearm. Lower = more drop:
// the SMG's slower round punishes trying to snipe with it far more than it
// ever affects its real, close-range job.
// punch: per-shot camera-shake strength (Player#_useTool's this.recoil) —
// separate from kick/climb, which is aim DRIFT across shots, not a single
// jolt. Used to be hardcoded to "rifle gets 0.9, everything else gets
// 0.35"; data-driven now so the sniper (1.0, the max the clamp allows) can
// actually feel like the heaviest gun in the game rather than being lumped
// in with the SMG.
export const TOOLS = [
  { key: 'rifle', name: 'RIFLE', damage: 55, headMult: 2, interval: 0.55, spread: 0.0012,
    mag: 10, reload: 2.2, auto: false, zoom: 1.5, kick: 0.021, aimSpread: 0.5, dropVel: 410, punch: 0.9 },
  { key: 'smg', name: 'SMG', damage: 22, headMult: 1.6, interval: 0.1, spread: 0.02,
    mag: 30, reload: 1.8, auto: true, zoom: 1.2, kick: 0.0105, aimSpread: 0.7, dropVel: 225, punch: 0.35 },
  { key: 'spade', name: 'SPADE', interval: 0.3 },
  { key: 'block', name: 'BLOCK', interval: 0.18 },
  { key: 'nade', name: 'GRENADE', interval: 0.8 },
  // Bolt-action: slow, small mag, tight spread once compensated — the
  // difficulty is meant to come entirely from reading range, not from the
  // gun ALSO being inherently inaccurate on top of that. Highest headMult
  // in the game: a clean headshot at range is a real kill (90*2.75=247.5,
  // comfortably over 100hp); a body hit alone (90) isn't automatic.
  { key: 'sniper', name: 'SNIPER', damage: 90, headMult: 2.75, interval: 1.35, spread: 0.0006,
    mag: 5, reload: 3.0, auto: false, zoom: 4, kick: 0.04, aimSpread: 0.3, dropVel: 290, punch: 1.0 },
];
// Which TOOLS slots are "class" guns for the one-gun-per-life restriction —
// spade/block/nade stay universally available regardless of class.
export const GUN_CLASSES = [0, 1, 5]; // rifle, smg, sniper

const BASE_FOV = 75;
// Bullet-drop gravity, duplicated from game.js's GRAVITY_DROP rather than
// imported — game.js already imports FROM this file, so importing back
// would be circular. Small tuning constants living separately per file
// this way already happens elsewhere (world gravity vs. grenade gravity);
// if this ever gets tuned, update both.
const GRAVITY_DROP = 30;
// Calibration ranges for the sniper's scope notches (units, ≈ meters).
const NOTCH_RANGES = [40, 70, 100, 130];

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
    // One gun class per life — the other two simply aren't in the belt
    // this spawn. Persisted like gun color/lobby prefs so it carries over
    // between lives without re-picking every time; _pendingClass is what
    // you'll spawn with NEXT (changeable while dead), gunClass is what
    // you're actually using RIGHT NOW. Same try/catch discipline as
    // stats.js — private browsing or a full quota just means it doesn't
    // persist, never a broken constructor.
    let savedClass = NaN;
    try { savedClass = Number(localStorage.getItem('tos.class')); } catch { /* best effort */ }
    this.gunClass = GUN_CLASSES.includes(savedClass) ? savedClass : GUN_CLASSES[0];
    this._pendingClass = this.gunClass;
    this.tool = this.gunClass;
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

  // A plain accessor rather than a property write: the block viewmodel is
  // built once at construction and then just sits there for the rest of
  // the session, but team can change AFTER that — an initial coin flip, a
  // guest's welcome message, and now a full swap on every map rotation.
  // Every one of those is a plain `this.player.team = x` assignment
  // somewhere else in the codebase; routing them all through this setter
  // means the held block recolors automatically no matter which of those
  // paths changed it, rather than needing each call site to separately
  // remember to also recolor a material.
  get team() { return this._team; }
  set team(t) {
    this._team = t;
    this._blockMat?.color.setHex(t === 'blue' ? 0x4a6cd4 : 0x4a9e4a);
  }

  // ---------------- input ----------------
  _bind(dom) {
    addEventListener('keydown', e => {
      // Typing beats game keys — but only where typing makes sense: the
      // chat box, or a lobby widget while the menu is actually up. The menu
      // fades out with opacity (still laid out), so a callsign box left
      // focused after deploy would otherwise keep eating WASD mid-match.
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
        const menuUp = !document.getElementById('menu').classList.contains('hidden');
        if (e.target.id === 'chatin' || menuUp) return;
        // A hidden widget holding focus is a trap: the OS treats held keys
        // as text entry and macOS pops the accented-character picker
        // mid-sprint. Drop the focus outright — the hold's repeats then
        // land on the body like they should have all along.
        e.target.blur();
        e.preventDefault();
      }
      // Pointer-locked means the game owns the keyboard: no stray-focused
      // widget may perform its default action. A focused <select> opens its
      // native dropdown on Space (and arrows change it) — the dropdown is
      // browser UI, which yanks pointer lock and pops the cursor + menu
      // mid-fight; Space on a focused button clicks it; Space scrolls.
      // Browser shortcuts (Ctrl/Meta/Alt, F-keys) stay reachable.
      //
      // This has to run on every repeat event, not just the first press —
      // macOS shows its press-and-hold accent popup (ẃ ŵ ẅ...) on a letter
      // key the moment the page stops preventing default on the REPEATED
      // keydowns a held key generates, even if the initial press was
      // prevented. Returning early on e.repeat (as this used to) meant every
      // WASD hold handed its repeats straight to the OS text layer.
      if (document.pointerLockElement === dom
          && !e.ctrlKey && !e.metaKey && !e.altKey && !/^F\d{1,2}$/.test(e.code))
        e.preventDefault();
      this.keys[e.code] = true;
      if (e.repeat) return; // one-shot actions below: only on the initial press
      // TAB scoreboard works while dead too — the redeploy wait is exactly
      // when you want it. preventDefault keeps browser focus in the page —
      // though Tab (and its sibling Shift+Tab) can still force pointer lock
      // itself closed on some browsers as an unblockable accessibility
      // escape hatch that no preventDefault stops. main.js's
      // pointerlockchange handler watches this timestamp to tell that case
      // apart from an actual Esc/alt-tab and re-lock silently instead of
      // pausing the match over a keystroke that only meant to check the
      // score.
      if (e.code === 'Tab') {
        e.preventDefault();
        this.game._tabUnlockAt = performance.now();
        this.game.hud.statsShow(this.game);
        return;
      }
      if (!this.alive) {
        // Class select while waiting to respawn: 1/2/3 for rifle/smg/
        // sniper. Applied at the moment respawn() actually fires, not
        // immediately — changing your mind mid-wait just changes what
        // you're about to spawn with, not your current (dead) loadout.
        if (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3') {
          const idx = GUN_CLASSES[Number(e.code.slice(-1)) - 1];
          this._pendingClass = idx;
          try { localStorage.setItem('tos.class', String(idx)); } catch { /* best effort */ }
          if (this.game.mode === 'client') this.game.net.send({ t: 'a', k: 'class', cls: idx });
          this.game.hud.classPick(idx);
        }
        return;
      }
      if (e.code >= 'Digit1' && e.code <= 'Digit4')
        this._selectTool(this._toolSlots()[Number(e.code.slice(-1)) - 1]);
      if (e.code === 'KeyQ' || e.code === 'KeyE') // cycle back / forward
        this._cycleTool(e.code === 'KeyE' ? 1 : -1);
      // A real gun has a mag; spade/block/nade don't — checking for that
      // instead of a hardcoded tool index is what makes adding a gun (the
      // sniper) not require touching this line at all.
      if (e.code === 'KeyR' && TOOLS[this.tool].mag !== undefined
          && this.ammo[this.tool] < TOOLS[this.tool].mag)
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

  // Logical belt slots: 1=your class gun, 2=spade, 3=block, 4=grenade —
  // always 4 keys regardless of which gun you're carrying. The class
  // system means there's only ever ONE gun in the belt, so it should
  // always live on the same key rather than moving depending on which of
  // the three you picked (it used to sit on 1, 2, or 6 depending on class,
  // which is exactly the kind of thing that reads as broken under stress).
  _toolSlots() {
    return [this.gunClass, 2, 3, 4];
  }

  _selectTool(i) {
    if (i === this.tool) return;
    // Class-locked for the life: the other two guns simply aren't in the
    // belt this spawn. Spade/block/nade stay switchable as always, and
    // your chosen class is always available.
    if (GUN_CLASSES.includes(i) && i !== this.gunClass) { sfx.click(); return; }
    this.tool = i;
    this.reloading = 0;
    sfx.click();
    this._syncViewmodel();
    this.game.hud.refreshTool(this);
  }

  // Cycles through the SAME 4 logical slots the digit keys use. No need to
  // skip anything now — _toolSlots() only ever contains available tools by
  // construction, unlike raw TOOLS indices which include the two forbidden
  // guns.
  _cycleTool(dir) {
    const slots = this._toolSlots();
    const i = Math.max(0, slots.indexOf(this.tool));
    this._selectTool(slots[(i + dir + slots.length) % slots.length]);
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
    // Unlocked at kill milestones (see stats.js) — a small personal touch
    // that's genuinely yours: nothing here rides the network, so it's
    // exactly what YOU see when you look at your own gun, not something
    // shown off to anyone else.
    //
    // dark is deliberately gun-only (rifle/smg/sniper barrels + sights) —
    // toolDark is a SEPARATE, fixed material for the spade and grenade at
    // the same default color. Both used to be the same shared material,
    // which meant unlocking "gold" or "crimson" silently recolored the
    // spade blade and the entire grenade too — well past what "gun colors"
    // was ever pitched as.
    const dark = new THREE.MeshBasicMaterial({ color: stats.gunColor() });
    this._gunMat = dark; // kept for live recoloring when the menu changes it mid-session
    const toolDark = new THREE.MeshBasicMaterial({ color: 0x2b2b30 });
    const wood = new THREE.MeshBasicMaterial({ color: 0x6b4a2c });
    const blockMat = new THREE.MeshBasicMaterial({
      color: this.team === 'blue' ? 0x4a6cd4 : 0x4a9e4a });
    this._blockMat = blockMat; // live-recolored by the team setter below
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
    // Old notch: post half-width 0.006, wings' inner edges at ±0.018 — a
    // 0.012 sliver of daylight on EACH side, twice the post's own
    // half-width. That's a genuinely loose notch: you could be off-center
    // by a real margin and never see it, which is exactly the kind of
    // imprecision that gets worse, not better, once holdover for bullet
    // drop is part of aiming. Thinner post, thinner wings, and a sliver
    // (0.0015/side) smaller than the post's own half-width — centered now
    // means centered, not "somewhere in a loose gap." Same top-alignment
    // invariant as before (post tip and wing tops both land on the y=0.09
    // aim line) — only the geometry making up that line changed.
    const sights = (g, frontZ, rearZ) => {
      // Post height reverted to span from the barrel's own top (0.035, both
      // rifle and smg) up to the aim line (0.09) — thinning it down last
      // time left its bottom floating 0.015 above the barrel with nothing
      // connecting them. Width stays thin; only height needed the fix.
      mk(0.006, 0.055, 0.012, dark, 0, 0.0625, frontZ, g);   // front post
      mk(0.008, 0.04, 0.03, dark, -0.0085, 0.07, rearZ, g);  // rear wing L
      mk(0.008, 0.04, 0.03, dark,  0.0085, 0.07, rearZ, g);  // rear wing R
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

    // Bolt-action, scoped — no iron sights; a scope box above the barrel
    // does the aiming instead (the calibrated range notches live in a 2D
    // HUD overlay while scoped, not on the gun itself — see
    // _updateScopeNotches below). A longer barrel than the rifle's sells
    // "deliberate, long-range" at a glance, same box-only vocabulary as
    // everything else.
    const sniper = new THREE.Group();
    mk(0.045, 0.06, 1.05, dark, 0, 0, -0.55, sniper);       // long barrel
    mk(0.08, 0.13, 0.4, wood, 0, -0.055, -0.02, sniper);    // stock
    mk(0.05, 0.1, 0.06, skin, 0, -0.12, 0.06, sniper);      // hand
    const scopeBody = mk(0.06, 0.06, 0.28, dark, 0, 0.09, -0.35, sniper);
    const scopeLens = mk(0.07, 0.07, 0.03, dark, 0, 0.09, -0.5, sniper);
    // Both sit right on the aim line (y=0.09 lands on-axis with the camera
    // when fully aimed, same as the iron sights) — fine off-axis at hip
    // fire, but dead center it's a solid opaque box parked directly in
    // front of the lens, which is the whole "all black, can't see through
    // it" bug: there was never a see-through scope, just geometry that
    // happened to block the view completely once it was centered. Hidden
    // once scoped in (see _updateScopeNotches, which already runs every
    // frame and already knows when that is) — a real scope's own housing
    // isn't in your view when you're looking through it either.
    this.vm.sniper = sniper;
    this._scopeParts = [scopeBody, scopeLens];

    const spade = new THREE.Group();
    mk(0.035, 0.035, 0.5, wood, 0, 0, -0.25, spade);     // handle
    mk(0.12, 0.16, 0.03, toolDark, 0, 0, -0.52, spade);  // blade — fixed color, not a "gun"
    this.vm.spade = spade;

    const block = new THREE.Group();
    mk(0.16, 0.16, 0.16, blockMat, 0, 0, -0.3, block);
    mk(0.05, 0.1, 0.06, skin, 0, -0.12, -0.2, block);
    this.vm.block = block;

    const nade = new THREE.Group();
    mk(0.09, 0.11, 0.09, toolDark, 0, 0, -0.3, nade);    // body — fixed color, not a "gun"
    mk(0.03, 0.05, 0.03, toolDark, 0, 0.07, -0.3, nade); // spoon
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

  // Called from the menu when an already-unlocked color is picked — the
  // Player (and its viewmodel) is constructed once at page load and
  // persists across every match, so a live material recolor is what makes
  // a mid-session choice actually show up.
  setGunColor(hex) {
    this._gunMat?.color.setHex(hex);
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
    this.aiming = !!(this.mouseDown[2] && TOOLS[this.tool].zoom !== undefined);
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
    const aiming = this.mouseDown[2] && TOOLS[this.tool].zoom !== undefined;
    const targetFov = aiming ? BASE_FOV / TOOLS[this.tool].zoom : BASE_FOV;
    if (Math.abs(this.camera.fov - targetFov) > 0.1) {
      // Ease rate scales inversely with zoom — "a heavier, more magnified
      // optic takes proportionally longer to shoulder and stabilize."
      // Barely touches rifle (14/1.5≈9.3) or smg (14/1.2≈11.7), both
      // already so close to 1x that the difference is hard to notice;
      // sniper (14/4=3.5) is a genuine ~4x slower scope-in, specifically
      // to cost something for quick-scoping into a close fight rather than
      // holding a deliberate long-range position.
      const easeRate = 14 / TOOLS[this.tool].zoom;
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * easeRate);
      this.camera.updateProjectionMatrix();
    }
    this._updateScopeNotches(aiming);

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
    this.recoil = Math.min(1, this.recoil + (t.punch ?? 0.35));
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
    this.resetZoom(); // don't die scoped in — the death camera shouldn't render through a sniper scope
    // Bots and remote players already burst apart on death (see their die()
    // methods) — your own death was the one case that never called this,
    // since it went straight to deathCam with no particle effect at all.
    this.game.effects.burst(this.body.eye(), 26, this.team === 'blue' ? 0x4a6cd4 : 0x4a9e4a, 6);
    sfx.hurt();
    this.game.hud.classPick(this._pendingClass); // show the current pick before any key is pressed
    this.game.onDeath(this, killer);
  }

  // The FOV-easing (and the scope notch/vignette overlay it drives) lives
  // entirely inside update(), which stops running the instant you die —
  // nothing else would ever bring it back to normal, so dying while zoomed
  // in left the death camera (and the flycam after it) rendering through
  // whatever FOV you happened to be holding at the exact instant you died.
  // No easing here on purpose: you're dead, there's no "smoothly" un-aim a
  // scope you can no longer use.
  resetZoom() {
    this.camera.fov = BASE_FOV;
    this.camera.updateProjectionMatrix();
    this.aiming = false;
    this._updateScopeNotches(false); // un-hides the scope body/lens, hides the notch overlay + vignette
  }

  // First-person death: crumple to the dirt with a roll, then a free-roam
  // fly camera for the rest of the respawn wait — no killcam. That system
  // kept failing in ways that were hard to pin down without a browser to
  // reproduce in, and a simple flycam is something that just works: no
  // trail data, no wire fields, no per-frame math that can throw.
  deathCam(dt) {
    this.deadT = Math.min(1.6, this.deadT + dt * 2.4);
    if (this.deadT < 1.6) {
      // Crumple, then settle out of the tilt. Mouselook already updates
      // pitch/yaw with no alive-check anywhere in _bind, which is what
      // makes both this settle AND the free-roam below actually work.
      const fall = Math.min(1, this.deadT);
      const k = fall * fall * (3 - 2 * fall); // 0..1 over the fall
      const settleT = Math.max(0, Math.min(1, (this.deadT - 1) / 0.6));
      const settled = settleT * settleT * (3 - 2 * settleT); // 0..1, un-tilting after the fall
      const eye = this.body.eye();
      this.camera.position.set(eye.x, eye.y - k * 1.2, eye.z);
      this.camera.rotation.set(this.pitch + k * 0.3 * (1 - settled),
        this.yaw - Math.PI / 2, k * 0.5 * (1 - settled), 'YXZ');
      return;
    }

    // Free roam: fly through space for the rest of the wait, with real
    // voxel collision — no clipping through the floor or a wall, though
    // you can still slide along one, since each axis is moved and checked
    // independently rather than freezing the whole move the instant ANY
    // component would clip something. W/S move along the full look
    // direction (so looking up and holding W climbs, same convention a
    // spectator cam usually uses), A/D strafe horizontally only, same as
    // normal movement. SPACE/CTRL add pure vertical for when you're not
    // looking straight up or down. SHIFT doubles speed. World-bounds
    // clamping stays on top of the voxel collision — that catches flying
    // off the EDGE of the map into open sky, which has no terrain to
    // collide with in the first place.
    if (!this._flyPos) {
      const eye = this.body.eye();
      this._flyPos = new THREE.Vector3(eye.x, eye.y - 1.2, eye.z);
    }
    const dir = this.lookDir();
    const f = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const r = new THREE.Vector3(-f.z, 0, f.x);
    const wish = new THREE.Vector3();
    if (this.keys['KeyW']) wish.add(dir);
    if (this.keys['KeyS']) wish.sub(dir);
    if (this.keys['KeyD']) wish.add(r);
    if (this.keys['KeyA']) wish.sub(r);
    if (this.keys['Space']) wish.y += 1;
    if (this.keys['ControlLeft'] || this.keys['ControlRight']) wish.y -= 1;
    if (wish.lengthSq() > 0) wish.normalize();
    const shift = this.keys['ShiftLeft'] || this.keys['ShiftRight'];
    const speed = 9 * (shift ? 2 : 1);
    // A small cube (all 8 corners checked) around the point rather than a
    // single-pixel test — cheap regardless (a handful of voxel lookups,
    // once a frame, for one entity, not a hot path) and keeps the near
    // clip plane from dipping into geometry at a glancing angle, without
    // needing the full body-sized hitbox a real entity's collision uses.
    const R = 0.4, world = this.game.world;
    const blocked = (x, y, z) => {
      for (const ox of [-R, R]) for (const oy of [-R, R]) for (const oz of [-R, R])
        if (world.solid(x + ox, y + oy, z + oz)) return true;
      return false;
    };
    const p = this._flyPos;
    const dx = wish.x * speed * dt, dy = wish.y * speed * dt, dz = wish.z * speed * dt;
    if (!blocked(p.x + dx, p.y, p.z)) p.x += dx;
    if (!blocked(p.x, p.y + dy, p.z)) p.y += dy;
    if (!blocked(p.x, p.y, p.z + dz)) p.z += dz;
    p.x = Math.max(-8, Math.min(SX + 8, p.x));
    p.y = Math.max(-8, Math.min(SY + 24, p.y));
    p.z = Math.max(-8, Math.min(SZ + 8, p.z));
    this.camera.position.copy(p);
    this.camera.rotation.set(this.pitch, this.yaw - Math.PI / 2, 0, 'YXZ');
  }

  // Calibrated range marks below the crosshair — real rangefinding, not
  // decoration: each tick's screen position is derived from the sniper's
  // own drop formula, the same one _dropCompensate uses to resolve shots.
  // Standard perspective conversion: a world drop d at range r subtends
  // angle atan2(d,r) as seen from the eye; tan(that)/tan(halfFov) gives the
  // fraction of HALF the screen height it projects to at the current zoom.
  _updateScopeNotches(aiming) {
    const el = this._notchEl ??= document.getElementById('scopeNotches');
    const vignette = this._vignetteEl ??= document.getElementById('scopeVignette');
    if (!el) return;
    const spec = TOOLS[this.tool];
    const scoped = aiming && spec.key === 'sniper' && this.aimK > 0.85;
    // The scope's own housing sits dead center once fully aimed (same
    // on-axis alignment the iron sights use) — a real scope's body isn't
    // in your view when you're looking through it either, so it hides
    // right when the notch overlay (the actual aiming reference at that
    // point) takes over.
    if (this._scopeParts) for (const m of this._scopeParts) m.visible = !scoped;
    el.classList.toggle('on', scoped);
    vignette?.classList.toggle('on', scoped);
    if (!scoped) return;
    if (!this._notchTicks) {
      this._notchTicks = NOTCH_RANGES.map(r => {
        const t = document.createElement('div');
        t.className = 'tick';
        t.dataset.r = r + 'm';
        el.appendChild(t);
        return { el: t, r };
      });
    }
    const halfFovRad = (this.camera.fov / 2) * Math.PI / 180;
    const halfH = innerHeight / 2;
    for (const { el: tickEl, r } of this._notchTicks) {
      const dropAmt = GRAVITY_DROP * r * r / (2 * spec.dropVel * spec.dropVel);
      const angle = Math.atan2(dropAmt, r);
      const frac = Math.min(0.95, Math.tan(angle) / Math.tan(halfFovRad));
      tickEl.style.top = (halfH * frac) + 'px';
    }
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
    this.protT = 3; // spawn protection: 3s, drains twice as fast moving, gone if you fire
    this.slideT = 0; this.slideCd = 0;
    this.stepK = 0;
    this.gunClass = this._pendingClass; // whatever was picked (or kept) while dead
    this.tool = this.gunClass;
    this.ammo = TOOLS.map(t => t.mag ?? 0);
    this.grenades = 3;      // fresh loadout on every life — a spent belt used
    this.grenadeRegen = 0;  // to follow you through respawns and map rotations
    this.blocks = 50;
    this.cooldown = 0;
    this.reloading = 0;
    this.deadT = 0;
    this._flyPos = null; // fresh flycam start point next death, not wherever it last was
    this.crouched = false;
    this.body.half.h = 1.75;
    this.vmRoot.visible = true;
    this._syncViewmodel(); // full belt: the hand holds a frag again
    sfx.respawn();
  }
}
