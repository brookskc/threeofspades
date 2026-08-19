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

let sessionLive = false; // a match was entered: pause shows the slim screen
function setPlaying(v) {
  playing = v;
  if (v) sessionLive = true;
  // Dropping in with the callsign box still focused (a click on a
  // non-focusable lobby link doesn't blur it in every browser) leaves the
  // hidden input eating every WASD press — a frozen soldier with a working
  // mouse. Entering play always drops stray focus.
  if (v) document.activeElement?.blur?.();
  $('menu').classList.toggle('hidden', v);
  // In-session menu (Esc pause / rotation break / a lost pointer lock) is a
  // different screen from the home lobby: no callsign, no map selector, no
  // QUICK MATCH — just resume or leave. Applies solo too: an OS-level unlock
  // mid-fight should never dump the lobby chrome on the player.
  $('menu').classList.toggle('paused', !v && (sessionLive || !!net));
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
        status(`room code <b>${code}</b> — share it`);
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
  game.onAbandoned = abandonedNotice;
  n.flushPending?.(); // anything that knocked while the slot had no handlers
  if (opts.alreadyOpen) n.handlers.onOpen();
}

// ---------------- host migration ----------------
// The host's browser IS the simulation, so a host dropping used to end the
// match for everyone. Instead every client keeps a migration-ready replica
// (world edit log + the last full snapshot), and when the connection dies
// the survivors converge on a deterministic fallback room — <code>-M1, then
// -M2 if the baton fumbles again. The lowest-ranked survivor claims it and
// promotes its replica to host; the rest knock until it answers. From the
// players' seats the world freezes for a few seconds, then just continues.
let migrationGen = 0; // which baton pass this room is on

// Every client dropping at once is the signature of the room having moved on
// without us (our tab stalled, our uplink died, the survivors migrated). We
// can't prove it from this side, so tell the player and let them decide.
function abandonedNotice() {
  game.hud.message('EVERYONE DISCONNECTED AT ONCE', '#ffd97a');
  status('every player dropped at once — if your connection stalled, they may have '
    + 'moved to a new room. Leave and quick-match again to find them.');
}

function failMigration(guest) {
  guest?.destroy();
  netDead = true;
  $('end').classList.add('hidden'); // a dead room ends the rotation wait too
  status('connection lost — the host left, and nobody could pick up the baton');
  showPlay('RETURN TO MENU');
  if (playing) { setPlaying(false); document.exitPointerLock?.(); }
}

function adoptMigratedHost(n, code, gen) {
  net = n;
  window.__net = n;
  roomCode = code;
  game.net = n;
  game.migGen = gen; // which baton pass we adopted (0 = original room)
  n.handlers = {
    onData: (id, d) => game.hostOnData(id, d),
    onLeave: id => game.hostOnLeave(id),
    onError: e => status(`network error: ${e.type}`),
  };
  game.onAbandoned = abandonedNotice;
  console.debug(`[mig] promoted to host of ${code}`);
  game.promoteToHost(n);
  // Survivors who knocked between the claim and this moment were buffered,
  // not dropped — hand them to the now-live handlers.
  n.flushPending?.();
  $('roomcode').querySelector('b').textContent = code;
  game.hud.message('BATON PASSED — YOU ARE HOSTING THE MATCH', '#ffd97a');
  status('the host dropped — <b>you are hosting now</b>');
}

function adoptMigratedClient(peer, conn, code, welcome, gen) {
  const n = Net.adoptGuest(peer, conn);
  net = n;
  window.__net = n;
  roomCode = code;
  game.net = n;
  game.migGen = gen;
  n.handlers.onData = d => game.clientOnData(d);
  n.handlers.onClose = () => startMigration(n); // the baton can pass again
  n.handlers.onError = () => {};
  game.onHostSilent = () => startMigration(n);
  console.debug(`[mig] rejoined migrated room ${code} as client`);
  game.clientOnData(welcome); // migrated welcome: world and kit kept as-is
  $('roomcode').querySelector('b').textContent = code;
  game.hud.message('BATON PASSED — THE MATCH CONTINUES', '#ffd97a');
  status('host dropped — a teammate picked it up');
}

async function migrateRoom(deadNet) {
  const gen = ++migrationGen;
  const migCode = `${roomCode}-M${gen}`;
  const myOldId = game.myId;
  const all = [...(game._rosterP?.values() ?? [])].map(m => m.pid)
    .filter(id => id !== 'HOST').sort();
  const rank = Math.max(0, all.indexOf(myOldId)); // lowest survivor claims first
  game.hud.message('HOST DROPPED — PASSING THE BATON…', '#ffd97a');
  const guest = deadNet.peer; // still open: our identity for the knock
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const t0 = performance.now();
  // Wall-clock deadline: without it a flaky broker (claim/knock cycling
  // 'taken' forever) strands the tab on "passing the baton" indefinitely.
  const deadline = t0 + 60000 + rank * 3000;
  while (net === deadNet) { // a newer session would supersede this loop
    if (performance.now() > deadline) return failMigration(guest);
    if (performance.now() - t0 >= rank * 3000) {
      console.debug(`[mig] gen${gen} rank${rank} claiming ${migCode}`);
      // Generous timeouts: a busy tab (throttled, backgrounded, or just
      // loaded) can take many seconds to finish the broker + ICE handshake.
      const c = await Net._claim(migCode, 15000);
      console.debug(`[mig] claim -> ${c.kind}`);
      if (net !== deadNet) { c.net?.destroy(); return; }
      if (c.kind === 'host') { guest.destroy(); return adoptMigratedHost(c.net, migCode, gen); }
      // 'down' is the broker not answering in time — the same flakiness that
      // may have taken the host out in the first place, so it is exactly when
      // giving up is wrong. Fall through, knock, and let the deadline above
      // be the only thing that calls it. 'taken' means someone beat us to the
      // baton: also fall through and knock.
    }
    const k = await Net._knock(guest, migCode, game.player.name, 15000);
    console.debug(`[mig] gen${gen} knock ${migCode} -> ${k.kind}`);
    if (net !== deadNet) { k.conn?.close(); return; }
    if (k.kind === 'join') return adoptMigratedClient(guest, k.conn, migCode, k.welcome, gen);
    await sleep(700); // 'dead' (nobody hosting yet) and 'down' (broker hiccup)
                      // both just mean: try again until the deadline.
  }
}

function startMigration(n) {
  // The silence watchdog fires every frame once the host goes quiet — only
  // the first call may start the loop.
  if (net !== n || n._migrating) return;
  n._migrating = true;
  // Neuter the old session's handlers NOW: its peer-level error listener
  // ("room not found — check the code") is still attached, and every probe
  // of the not-yet-claimed migration room legitimately errors
  // 'peer-unavailable' while we wait for the new host to register. That
  // stale handler would reset the lobby mid-migration and kill the loop.
  n.handlers = {};
  if (game.mode !== 'client' || !game.myId || !game._rosterP)
    return failMigration(n.peer); // died before the first roster — nothing to save
  migrateRoom(n).catch(() => failMigration(n.peer));
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
  n.handlers.onClose = () => startMigration(n);
  game.onHostSilent = () => startMigration(n);
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
    status('that room is full — 10 players max');
    if (playing) bailToMenu();
  };
  game.onWelcome = () => {
    status(`connected — you are <b>${game.player.team.toUpperCase()}</b>`);
    showPlay('DEPLOY');
    if (playing) setPlaying(true); // quick match dropped in already: resync HUD
    if (params.get('auto')) setPlaying(true);
  };
}

// --- host preferences: map + mode, remembered across visits ---
// Applied whenever this player hosts — a private HOST or a quick-match slot
// claim — never on migration promotion, so a replica keeps the room's
// running map and mode. gameMode must be set BEFORE rebuild(), since flags
// only exist in CTF. ?map=2&mode=tdm are test hooks that force the selects.
const mapPref = $('mapPref'), modePref = $('modePref');
{
  // The map list follows the mode: each map declares which modes it supports
  // (DUNES is retired from the CTF rotation; CROWN and CALDERA are hill-first).
  function rebuildMapPref(keep = mapPref.value) {
    mapPref.innerHTML = '';
    const rot = document.createElement('option');
    rot.value = '-1'; rot.textContent = 'rotate';
    mapPref.appendChild(rot);
    MAPS.forEach((m, i) => {
      if (!m.modes.includes(modePref.value)) return;
      const o = document.createElement('option');
      o.value = String(i); o.textContent = m.name;
      mapPref.appendChild(o);
    });
    mapPref.value = [...mapPref.options].some(o => o.value === keep) ? keep : '-1';
  }
  modePref.value = localStorage.getItem('tos.mode') ?? 'ctf';
  rebuildMapPref(localStorage.getItem('tos.map') ?? '-1');
  const save = () => {
    localStorage.setItem('tos.map', mapPref.value);
    localStorage.setItem('tos.mode', modePref.value);
  };
  mapPref.addEventListener('change', save);
  modePref.addEventListener('change', () => { rebuildMapPref(); save(); });
  if (params.get('mode')) modePref.value = params.get('mode');
  rebuildMapPref();
  const pm = parseInt(params.get('map'), 10);
  if (Number.isInteger(pm) && pm >= 0 && pm < MAPS.length) mapPref.value = String(pm);
}

// Returns the map index to start the new room on: the pinned map if it's
// mode-compatible, else a random pick from the maps this mode supports.
function applyHostPrefs() {
  const mode = ['ctf', 'tdm', 'koth'].includes(modePref.value) ? modePref.value : 'ctf';
  game.gameMode = mode;
  const v = parseInt(mapPref.value, 10);
  game.mapLock = (v >= 0 && MAPS[v]?.modes.includes(mode)) ? v : null;
  if (game.mapLock != null) return game.mapLock;
  const pool = MAPS.map((m, i) => i).filter(i => MAPS[i].modes.includes(mode));
  return pool[Math.floor(Math.random() * pool.length)];
}

$('hostBtn').addEventListener('click', () => {
  if (net || matchmaking) return;
  migrationGen = 0; // a fresh room starts the baton count over
  if (!requireName()) return;
  initAudio();
  game.mode = 'host';
  game.player.name = callsign();
  game.rebuild(Math.floor(Math.random() * 1e9), applyHostPrefs());
  // Pointer lock is only gesture-valid inside this click — take it now and
  // drop straight in; a refused lock leaves the DEPLOY button as fallback.
  const lock = renderer.domElement.requestPointerLock();
  lock?.catch?.(() => {});
  const tryCode = () => {
    const code = params.get('code')?.toUpperCase() ?? makeCode();
    adoptHost(Net.host(code, {}), code, { onTaken: tryCode });
  };
  tryCode();
  status('creating room…');
  if (document.pointerLockElement === renderer.domElement) setPlaying(true);
});

$('joinBtn').addEventListener('click', () => {
  if (net || matchmaking) return;
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length !== 4) return status('enter the 4-letter room code');
  migrationGen = 0;
  if (!requireName()) return;
  initAudio();
  game.mode = 'client';
  game.player.name = callsign();
  // Lock in the click, drop straight in: the world snaps to the host's map
  // when the welcome lands a moment later (same warm-up as quick match).
  const lock = renderer.domElement.requestPointerLock();
  lock?.catch?.(() => {});
  status('connecting…');
  const n = Net.join(code, {});
  adoptJoin(n, code);
  n.handlers.onOpen = () => n.send({ t: 'hi', name: game.player.name });
  if (document.pointerLockElement === renderer.domElement) setPlaying(true);
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
      migrationGen = 0;
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
      migrationGen = 0;
      game.mode = 'host';
      game.rebuild(Math.floor(Math.random() * 1e9), applyHostPrefs());
      adoptHost(r.net, slotCode(r.slot), { public: true, alreadyOpen: true });
      game.hud.message(`HOSTING PUBLIC ROOM ${r.slot + 1} — PLAYERS WILL DROP IN`, '#ffd97a');
    } else {
      status(r.kind === 'down' ? 'cannot reach the matchmaking service — check your connection'
        : r.kind === 'timeout' ? 'matchmaking is taking too long — try again, or HOST a private room'
        : 'all public rooms are full — try again shortly, or HOST a private room');
      bailToMenu();
      return;
    }
    // Lock held since the click: drop straight in, no DEPLOY gate. (If the
    // lock was refused, adopt* already surfaced the DEPLOY button instead.)
    if (document.pointerLockElement === renderer.domElement) setPlaying(true);
  } finally { matchmaking = false; }
});

// --- room browser: scan every public slot and list what answers ---
// Unlike quick match this shows the player what's live and lets them pick.
// The scan's guest peer stays open between scans so a row click can knock
// immediately; it's destroyed on BACK or consumed by the join.
const browserEl = $('browser'), browseSt = $('browsestatus'), browseListEl = $('browselist');
let browseGuest = null, scanning = false;

function roomRow(room) {
  const row = document.createElement('div');
  row.className = 'brow';
  const main = document.createElement('div');
  main.className = 'bmain';
  const map = document.createElement('div');
  map.className = 'bmap';
  map.textContent = MAPS[room.map]?.name ?? 'UNKNOWN MAP';
  const meta = document.createElement('div');
  meta.className = 'bmeta';
  const modeName = room.mode === 'tdm' ? 'team deathmatch'
    : room.mode === 'koth' ? 'king of the hill' : 'capture the flag';
  const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const score = room.mode === 'koth' ? `${clock(room.g)} — ${clock(room.b)} held`
    : room.mode === 'tdm' ? `${room.g} — ${room.b} kills` : `${room.g} — ${room.b} captures`;
  meta.textContent = `${modeName} · ${score}`;
  const names = document.createElement('div');
  names.className = 'bnames';
  names.textContent = room.names.join(' · ');
  main.append(map, meta, names);
  const seats = document.createElement('div');
  seats.className = 'bseats';
  seats.textContent = `${room.humans}/${room.max}`;
  const join = document.createElement('div');
  join.className = 'bjoin';
  join.textContent = 'JOIN →';
  row.append(main, seats, join);
  row.addEventListener('click', () => joinFromBrowser(room));
  return row;
}

async function scanRooms() {
  if (scanning) return;
  scanning = true;
  browseGuest?.destroy(); browseGuest = null;
  browseListEl.innerHTML = '';
  browseSt.textContent = 'scanning public rooms…';
  try {
    const r = await Net.roomScan(qmTimeout);
    if (r.kind === 'down') {
      browseSt.textContent = 'cannot reach the matchmaking service — check your connection';
      return;
    }
    browseGuest = r.guest; // kept warm for the join knock
    if (!r.rooms.length) {
      browseSt.innerHTML = 'no public rooms right now — hit <b>QUICK MATCH</b> and one starts with you as host';
      return;
    }
    browseSt.textContent = `${r.rooms.length} room${r.rooms.length === 1 ? '' : 's'} online — click one to join`;
    for (const room of r.rooms) browseListEl.appendChild(roomRow(room));
  } finally { scanning = false; }
}

async function joinFromBrowser(room) {
  if (net || scanning) return;
  const guest = browseGuest; browseGuest = null;
  if (!guest) { scanRooms(); return; } // stale rows: rescan, pick again
  initAudio();
  game.player.name = callsign();
  const lock = renderer.domElement.requestPointerLock(); // gesture-valid only now
  lock?.catch?.(() => {});
  browseSt.textContent = `joining ${MAPS[room.map]?.name ?? 'room'}…`;
  const k = await Net._knock(guest, slotCode(room.slot), game.player.name, qmTimeout);
  if (k.kind === 'join') {
    migrationGen = 0;
    game.mode = 'client';
    browserEl.classList.add('hidden');
    $('menu').classList.remove('hidden');
    adoptJoin(Net.adoptGuest(guest, k.conn), slotCode(room.slot));
    const plain = game.onWelcome;
    game.onWelcome = () => {
      plain();
      status(`joined <b>PUBLIC ROOM ${room.slot + 1}</b> — you are <b>${game.player.team.toUpperCase()}</b>`);
      game.hud.message(`JOINED PUBLIC ROOM ${room.slot + 1} — YOU ARE ${game.player.team.toUpperCase()}`, '#ffd97a');
    };
    game.clientOnData(k.welcome); // replay the welcome through the normal path
    if (document.pointerLockElement === renderer.domElement) setPlaying(true);
  } else {
    guest.destroy();
    browseSt.textContent = k.kind === 'full' ? 'that room just filled up'
      : k.kind === 'down' ? 'cannot reach the matchmaking service — check your connection'
      : 'that room just ended';
    if (k.kind !== 'down') scanRooms(); // show what is actually live now
  }
}

$('browseBtn').addEventListener('click', () => {
  if (net || matchmaking || scanning) return;
  if (!requireName()) return;
  initAudio();
  $('menu').classList.add('hidden');
  browserEl.classList.remove('hidden');
  scanRooms();
});
$('browseBack').addEventListener('click', () => {
  browserEl.classList.add('hidden');
  $('menu').classList.remove('hidden');
  browseGuest?.destroy(); browseGuest = null;
});
$('browseRefresh').addEventListener('click', () => scanRooms());

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

// Tab (and Shift+Tab) can force pointer lock closed on some browsers as an
// unblockable accessibility escape hatch — the keydown handler's
// preventDefault cannot stop it, confirmed by the fact this file already
// had to work around a "Tab keyup lost to the unlock" stranding the
// scoreboard. If that's what just happened mid-match, the player almost
// certainly meant "let me check the score," not "pause the game" — try to
// silently re-acquire the lock instead of dropping into the pause menu.
// pointerlockerror is the failure path: some browsers throttle back-to-back
// lock requests, and if this one is refused we fall back to a normal pause
// rather than stranding the player with no UI at all.
let tabRelockPending = false;
document.addEventListener('pointerlockerror', () => {
  if (!tabRelockPending) return;
  tabRelockPending = false;
  enterPause();
});

function enterPause() {
  // Drop all held inputs so nobody runs/shoots blind while the menu is up.
  game.player.keys = {};
  game.player.mouseDown = [false, false, false];
  game.hud.statsHide(); // a Tab keyup lost to the unlock can't strand it
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
}

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  // While a quick-match search runs, the lock is held behind the searching
  // ticker — don't start playing until the room is actually ready.
  if (locked) { tabRelockPending = false; if (!(matchmaking && !net)) setPlaying(true); return; }
  if (playing && performance.now() - (game._tabUnlockAt ?? 0) < 200) {
    tabRelockPending = true;
    renderer.domElement.requestPointerLock();
    return;
  }
  enterPause();
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// Headless/test hooks: ?mp=host&code=TEST&auto=1 · ?mp=join&code=TEST&auto=1
// ?mp=quick&auto=1&ns=<namespace> · ?mp=browse&auto=1 · host cap: &cap=2
// Pref hooks: &map=0..3&mode=ctf|tdm · TDM kill limit: &killcap=2
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
} else if (params.get('mp') === 'browse') {
  setTimeout(() => $('browseBtn').click(), 400);
}

// ---------------- loop ----------------
const clock = new THREE.Clock();
let menuT = Math.PI * 0.15;
let menuMapT = 0; // seconds the current backdrop map has been showing
// Test hook: ?mmt=2 rotates every 2s.
const MENU_MAP_EVERY = parseInt(params.get('mmt'), 10) || 15;
// The backdrop carousel only runs on the idle solo menu — never while
// hosting (host world is authoritative) or connected as a client (a rebuild
// would wipe the synced match). ?auto= disables it: tests drive the world
// directly and would lose their terrain mid-scenario.
const carouselOn = !params.get('auto');

// Last time the simulation actually stepped, from either driver below.
let lastSimT = performance.now();

// Browsers PAUSE requestAnimationFrame in a hidden tab. Since rAF was the
// only thing calling game.update, a host that alt-tabbed stopped sending
// snapshots entirely, every client's 4s watchdog fired, and the room migrated
// away from a host that was alive and unaware — leaving two rooms and a
// zombie holding the original id. Timers in a hidden tab are throttled to
// ~1Hz but not stopped, so this fallback keeps the authoritative sim (and its
// snapshots) beating slowly instead of dying. While the tab is visible rAF
// runs at 60Hz, lastSimT stays fresh, and this never fires.
setInterval(() => {
  const now = performance.now();
  if (now - lastSimT < 250) return; // rAF is healthy — leave it alone
  if (game.mode === 'client') { game.clientIdleTick(); lastSimT = now; return; }
  if (game.mode !== 'host') { lastSimT = now; return; }
  // Step at most one interval's worth per tick. Catching up fully would fire
  // a burst of ~15 snapshots at once, which scrambles every client's arrival
  // statistics and inflates their send buffer. The honest trade: a hidden
  // host's match runs slowly rather than pausing. Slow is recoverable; the
  // room splitting in two is not.
  let owed = Math.min((now - lastSimT) / 1000, 0.25);
  lastSimT = now;
  while (owed > 0) { const step = Math.min(owed, 0.05); game.update(step); owed -= step; }
}, 250);

function frame() {
  requestAnimationFrame(frame);
  const wallDt = clock.getDelta();          // real elapsed time
  const dt = Math.min(wallDt, 0.05);        // sim step, capped for physics

  // The host is authoritative — the simulation must never pause, even while
  // the host's own menu is up, or every client freezes with it.
  if (playing || game.mode === 'host') {
    lastSimT = performance.now();
    game.update(dt);
  } else if (game.mode === 'client') {
    lastSimT = performance.now();
    // Menu-open client: the world can freeze, but the host-silence watchdog
    // must not — a host dropping while you're in the Esc menu has to fire
    // the baton pass here, not on resume.
    game.clientIdleTick();
    // Slow cinematic orbit behind the menu.
    menuT += dt * 0.05;
  } else {
    // Slow cinematic orbit behind the menu.
    menuT += dt * 0.05;
    // The backdrop follows the host prefs: a pinned map shows ONLY that map;
    // "rotate" cycles just the maps the selected mode supports. The old
    // carousel ignored both and cycled all six every 30s.
    if (carouselOn && game.mode === 'solo' && !net && !matchmaking) {
      const pinned = parseInt(mapPref.value, 10);
      const pool = MAPS.map((m, i) => i).filter(i => MAPS[i].modes.includes(modePref.value));
      let next = -1;
      if (pinned >= 0 && MAPS[pinned]?.modes.includes(modePref.value)) {
        menuMapT = 0;                          // pinned: no rotation, ever
        if (game.mapIndex !== pinned) next = pinned;
      } else {
        menuMapT += wallDt; // wall-clock: a stalled frame still counts its time
        // Also jump when the mode switch stranded the backdrop off-pool.
        if (menuMapT >= MENU_MAP_EVERY || !pool.includes(game.mapIndex)) {
          menuMapT = 0;
          next = pool[(pool.indexOf(game.mapIndex) + 1) % pool.length];
        }
      }
      if (next >= 0) {
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
    if (game.flags) for (const f of ['green', 'blue']) game.flags[f].clientUpdate(game.time);
    game.effects.update(dt);
  }
  renderer.render(scene, camera);
}
frame();
