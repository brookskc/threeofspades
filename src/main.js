// main.js — boot, renderer, sky, lobby flow (solo / host / join), main loop.
import * as THREE from 'three';
import { Game } from './game.js';
import { initAudio } from './audio.js';
import { SX, SZ } from './world.js';
import { MAPS } from './mapgen.js';
import { Net, makeCode, PUBLIC_SLOTS, slotCode } from './net.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = skyGradient();
scene.fog = new THREE.Fog(0xcfe4f7, 70, 230);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 500);
scene.add(camera); // so the viewmodel renders

// Boots as a solo game — it doubles as the menu's orbiting backdrop.
const game = new Game(scene, camera, renderer.domElement);
window.__game = game; // debugging/testing handle
window.__renderer = renderer;
game.player.vmRoot.visible = false; // hidden until first deploy

// A soft sun sprite high in the sky — one textured quad, always faces the
// camera, excluded from fog so it keeps its glow at any distance.
function makeSun() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(64, 64, 6, 64, 64, 62);
  rg.addColorStop(0, 'rgba(255,252,235,1)');
  rg.addColorStop(0.25, 'rgba(255,244,200,.9)');
  rg.addColorStop(1, 'rgba(255,244,200,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, 128, 128);
  const mat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), fog: false, depthWrite: false });
  const s = new THREE.Sprite(mat);
  s.position.set(180, 210, 60);
  s.scale.setScalar(56);
  return s;
}
scene.add(makeSun());

// Soft vertical sky gradient, painted once on a canvas.
function skyGradient() {
  const c = document.createElement('canvas');
  c.width = 2; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#4f9be8');
  grad.addColorStop(0.55, '#9ecdf3');
  grad.addColorStop(1, '#dceefc');
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------- lobby ----------------
let playing = false;
let net = null;
let roomCode = null;
const CALLSIGNS = ['Ace', 'Deuce', 'Trey', 'Joker', 'King', 'Queen', 'Jack', 'Ten'];

function rawName() {
  return $('nameInput').value.trim().replace(/[^\w \-]/g, '').slice(0, 12);
}
function callsign() {
  return rawName() || CALLSIGNS[Math.floor(Math.random() * CALLSIGNS.length)] + Math.floor(Math.random() * 90 + 10);
}
// No anonymous soldiers: every lobby action needs a callsign first, so the
// name above your head means something to the people shooting at you.
function requireName() {
  if (rawName()) return true;
  status('enter a callsign first — your squad needs to know you');
  $('nameInput').classList.add('need');
  $('nameInput').focus();
  return false;
}
$('nameInput').addEventListener('input', () => $('nameInput').classList.remove('need'));
function status(html) { $('lobbyStatus').innerHTML = html; }

// The big DEPLOY/RESUME button only exists once there's a session to enter.
function showPlay(label) {
  $('playBtn').style.display = 'block';
  $('playBtn').textContent = label;
}

function setPlaying(v) {
  playing = v;
  $('menu').classList.toggle('hidden', v);
  // In-session menu (Esc pause / rotation break) is a different screen from
  // the home lobby: no callsign, no QUICK MATCH — just resume or leave.
  $('menu').classList.toggle('paused', !v && !!net);
  $('hud').classList.toggle('on', v);
  game.player.vmRoot.visible = v;
  $('roomcode').style.display = v && roomCode ? 'block' : 'none';
}

$('leaveBtn').addEventListener('click', () => location.reload());

function deploy() {
  initAudio();
  renderer.domElement.requestPointerLock();
}

// --- solo / resume ---
// After a dead connection the button becomes a way back to a clean menu.
let netDead = false;
let matchmaking = false;   // quick-match scan in flight — lobby buttons hold
let searchCanceled = false; // Esc pressed mid-search: discard the result
let suppressResume = false; // unlock came from a failed search, not the player
$('playBtn').addEventListener('click', () => {
  if (netDead) return location.reload();
  if (matchmaking) return;
  if (game.mode === 'client' && !game.myId) return; // still connecting
  deploy();
});

// --- room wiring, shared by HOST / JOIN / QUICK MATCH ---
// Handlers live on the Net instance, so these adopt functions can attach (or
// re-attach) the full game wiring to a connection at any moment — including
// one that quick match already used for its handshake.

// Adopt a claimed host peer: UI text, lobby hooks, game handlers.
// opts.alreadyOpen: the claim succeeded before adoption — fire onOpen now.
function adoptHost(n, code, opts = {}) {
  net = n;
  window.__net = n;
  roomCode = code;
  game.net = n;
  n.handlers = {
    onOpen: () => {
      if (opts.public) {
        const num = +code.slice(3) + 1;
        status(`hosting <b>PUBLIC ROOM ${num}</b> — quick-match players will drop in`);
        $('roomcode').querySelector('b').textContent = 'PUBLIC ' + num;
      } else {
        status(`room code <b>${code}</b> — share it, then deploy`);
        $('roomcode').querySelector('b').textContent = code;
      }
      showPlay('DEPLOY — START MATCH');
      if (playing) setPlaying(true); // quick match dropped in already: resync HUD
      if (params.get('auto')) setPlaying(true);
      opts.onOpen?.();
    },
    onError: e => {
      if (e.type === 'unavailable-id' && (opts.public || !params.get('code'))) {
        n.destroy();
        if (net === n) net = null;
        opts.onTaken?.(); // roll again with a fresh peer
      } else status(`network error: ${e.type}`);
    },
    onData: (id, d) => game.hostOnData(id, d),
    onLeave: id => game.hostOnLeave(id),
  };
  if (opts.alreadyOpen) n.handlers.onOpen();
}

// Adopt a welcomed guest connection: HUD code, game handlers, welcome/full
// callbacks. The caller that opened the channel decides whether 'hi' still
// needs sending (quick match already sent it during the knock).
function adoptJoin(n, code) {
  net = n;
  window.__net = n;
  roomCode = code;
  game.net = n;
  const pub = /^PUB(\d+)$/.exec(code); // public slots show as "PUBLIC n"
  $('roomcode').querySelector('b').textContent = pub ? `PUBLIC ${+pub[1] + 1}` : code;
  n.handlers.onData = d => game.clientOnData(d);
  n.handlers.onClose = () => {
    netDead = true;
    $('end').classList.add('hidden'); // a dead host ends the rotation wait too
    status('connection lost — the host left');
    showPlay('RETURN TO MENU');
    if (playing) { setPlaying(false); document.exitPointerLock?.(); }
  };
  n.handlers.onError = e => {
    // Join failed before the match started — reset so the lobby still works.
    if (net === n) { net = null; game.net = null; game.mode = 'solo'; }
    n.destroy();
    status(e.type === 'peer-unavailable' ? 'room not found — check the code' : `network error: ${e.type}`);
    if (playing) bailToMenu(); // we were warming up in-world for a quick match
  };
  game.onFull = () => {
    if (net === n) { net = null; game.net = null; game.mode = 'solo'; }
    n.handlers.onClose = null; // a polite refusal, not a dropped connection
    n.destroy();
    status('that room is full — 8 players max');
    if (playing) bailToMenu();
  };
  game.onWelcome = () => {
    status(`connected — you are <b>${game.player.team.toUpperCase()}</b>`);
    showPlay('DEPLOY');
    if (playing) setPlaying(true); // quick match dropped in already: resync HUD
    if (params.get('auto')) setPlaying(true);
  };
}

$('hostBtn').addEventListener('click', () => {
  if (net || matchmaking) return;
  if (!requireName()) return;
  initAudio();
  game.mode = 'host';
  game.player.name = callsign();
  game.rebuild(Math.floor(Math.random() * 1e9));
  const tryCode = () => {
    const code = params.get('code')?.toUpperCase() ?? makeCode();
    adoptHost(Net.host(code, {}), code, { onTaken: tryCode });
  };
  tryCode();
  status('creating room…');
});

$('joinBtn').addEventListener('click', () => {
  if (net || matchmaking) return;
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length !== 4) return status('enter the 4-letter room code');
  if (!requireName()) return;
  initAudio();
  game.mode = 'client';
  game.player.name = callsign();
  status('connecting…');
  const n = Net.join(code, {});
  adoptJoin(n, code);
  n.handlers.onOpen = () => n.send({ t: 'hi', name: game.player.name });
});

// --- quick match: drop into a public room with strangers ---
// Net.quickScan probes the public slots over a single signaling socket, joins
// the fullest room that still has space, or claims a dead slot and hosts it —
// the next quick-matcher then finds you. If every room is full we wait a beat
// and scan once more: rooms churn fast, and a probe may have raced a join.
// ?qmt=30000 stretches per-step timeouts (CI/very slow networks).
//
// The first click drops you straight in: pointer lock is only guaranteed
// inside this click's gesture, not when the async scan resolves seconds
// later — so lock NOW and hold it behind a searching ticker; when the room
// is ready the menu drops away and you're already playing. If the browser
// refuses the lock, the DEPLOY button flow is the fallback.
const qmTimeout = parseInt(params.get('qmt'), 10) || 9000;

// Back to a clean menu with no session: nothing to resume into.
function bailToMenu() {
  $('playBtn').style.display = 'none';
  if (document.pointerLockElement === renderer.domElement) {
    suppressResume = true;
    document.exitPointerLock();
  }
}

$('quickBtn').addEventListener('click', async () => {
  if (net || matchmaking) return;
  if (!requireName()) return;
  matchmaking = true;
  searchCanceled = false;
  initAudio();
  game.player.name = callsign();
  const lock = renderer.domElement.requestPointerLock(); // gesture-valid only now
  lock?.catch?.(() => {}); // refused → DEPLOY fallback below
  $('menu').classList.add('searching');
  status('searching for a public room…');
  try {
    let r = await Net.quickScan(game.player.name, qmTimeout);
    if (r.kind === 'full-all') { // one retry: a room may have just opened up
      status('all rooms full — rescanning…');
      await new Promise(res => setTimeout(res, 1500));
      r = await Net.quickScan(game.player.name, qmTimeout);
    }
    if (searchCanceled) { r.net?.destroy(); return; } // bailed with Esc mid-search
    $('menu').classList.remove('searching');
    if (r.kind === 'join') {
      game.mode = 'client';
      adoptJoin(r.net, slotCode(r.slot));
      const plain = game.onWelcome;
      game.onWelcome = () => { // richer line than the code-join default
        plain();
        status(`joined <b>PUBLIC ROOM ${r.slot + 1}</b> — you are <b>${game.player.team.toUpperCase()}</b>`);
        game.hud.message(`JOINED PUBLIC ROOM ${r.slot + 1} — YOU ARE ${game.player.team.toUpperCase()}`, '#ffd97a');
      };
      game.clientOnData(r.welcome); // replay the welcome through the normal path
    } else if (r.kind === 'host') {
      game.mode = 'host';
      game.rebuild(Math.floor(Math.random() * 1e9));
      adoptHost(r.net, slotCode(r.slot), { public: true, alreadyOpen: true });
      game.hud.message(`HOSTING PUBLIC ROOM ${r.slot + 1} — PLAYERS WILL DROP IN`, '#ffd97a');
    } else {
      status(r.kind === 'down'
        ? 'cannot reach the matchmaking service — check your connection'
        : 'all public rooms are full — try again shortly, or HOST a private room');
      bailToMenu();
      return;
    }
    // Lock held since the click: drop straight in, no DEPLOY gate. (If the
    // lock was refused, adopt* already surfaced the DEPLOY button instead.)
    if (document.pointerLockElement === renderer.domElement) setPlaying(true);
  } finally { matchmaking = false; }
});

$('codeInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('joinBtn').click();
});

// Map rotation: the room moves to the next map after each match. The end
// screen offers no choices while it turns — only once the new map is built
// does the lobby come back with DEPLOY ready (pointer lock needs a fresh
// click anyway). The old PLAY AGAIN reloaded the page, which for the host
// tore the whole room down mid-rotation.
game.onRestart = mapName => {
  $('end').classList.add('hidden');
  $('pausedTitle').textContent = '— MATCH OVER —';
  if (playing) setPlaying(false);
  showPlay('DEPLOY');
  status(`new map — <b>${mapName}</b>`);
};

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  // While a quick-match search runs, the lock is held behind the searching
  // ticker — don't start playing until the room is actually ready.
  if (locked) { if (!(matchmaking && !net)) setPlaying(true); return; }
  // Drop all held inputs so nobody runs/shoots blind while the menu is up.
  game.player.keys = {};
  game.player.mouseDown = [false, false, false];
  if (matchmaking && !net) { // Esc mid-search, before any room adopted us
    searchCanceled = true;
    $('menu').classList.remove('searching');
    status('search canceled');
  }
  if (!game.over && !netDead) {
    $('pausedTitle').textContent = '— PAUSED —';
    setPlaying(false);
    // A canceled/failed search leaves no session — RESUME would be a solo
    // backdoor into the menu map, so the button stays hidden.
    if (searchCanceled || suppressResume) $('playBtn').style.display = 'none';
    else showPlay('RESUME');
    suppressResume = false;
  }
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// Headless/test hooks: ?mp=host&code=TEST&auto=1 · ?mp=join&code=TEST&auto=1
// ?mp=quick&auto=1&ns=<namespace> · host cap override: &cap=2
// Auto runs can't type, so they get a callsign to satisfy the lobby gate.
if (params.get('auto') && !rawName())
  $('nameInput').value = 'TEST' + Math.floor(Math.random() * 90 + 10);
if (params.get('mp') === 'host') {
  $('codeInput').value = '';
  $('hostBtn').click();
} else if (params.get('mp') === 'join') {
  $('codeInput').value = params.get('code') ?? 'TEST';
  setTimeout(() => $('joinBtn').click(), 800);
} else if (params.get('mp') === 'quick') {
  setTimeout(() => $('quickBtn').click(), 400);
}

// ---------------- loop ----------------
const clock = new THREE.Clock();
let menuT = Math.PI * 0.15;
let menuMapT = 0; // seconds the current backdrop map has been showing
// Test hook: ?mmt=2 rotates every 2s.
const MENU_MAP_EVERY = parseInt(params.get('mmt'), 10) || 30;
// The backdrop carousel only runs on the idle solo menu — never while
// hosting (host world is authoritative) or connected as a client (a rebuild
// would wipe the synced match). ?auto= disables it: tests drive the world
// directly and would lose their terrain mid-scenario.
const carouselOn = !params.get('auto');

function frame() {
  requestAnimationFrame(frame);
  const wallDt = clock.getDelta();          // real elapsed time
  const dt = Math.min(wallDt, 0.05);        // sim step, capped for physics

  // The host is authoritative — the simulation must never pause, even while
  // the host's own menu is up, or every client freezes with it.
  if (playing || game.mode === 'host') {
    game.update(dt);
  } else {
    // Slow cinematic orbit behind the menu.
    menuT += dt * 0.05;
    // Rotate the backdrop across the four maps with a fresh seed each time.
    if (carouselOn && game.mode === 'solo' && !net && !matchmaking) {
      menuMapT += wallDt; // wall-clock: a stalled frame still counts its time
      if (menuMapT >= MENU_MAP_EVERY) {
        menuMapT = 0;
        const next = (game.mapIndex + 1) % MAPS.length;
        game.rebuild(Math.floor(Math.random() * 1e9), next);
        game.player.vmRoot.visible = false; // rebuild respawns: no menu gun
        $('mapname').innerHTML = `now showing — <b>${MAPS[next].name}</b>`;
      }
    }
    camera.position.set(
      SX / 2 + Math.cos(menuT) * 95,
      58,
      SZ / 2 + Math.sin(menuT) * 95
    );
    camera.lookAt(SX / 2, 24, SZ / 2);
    game.world.animateSky(game.time += dt);
    for (const f of ['green', 'blue']) game.flags[f].clientUpdate(game.time);
    game.effects.update(dt);
  }
  renderer.render(scene, camera);
}
frame();
