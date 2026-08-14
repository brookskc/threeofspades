// main.js — boot, renderer, sky, lobby flow (solo / host / join), main loop.
import * as THREE from 'three';
import { Game } from './game.js';
import { initAudio } from './audio.js';
import { SX, SZ } from './world.js';
import { Net, makeCode } from './net.js';

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
game.player.vmRoot.visible = false; // hidden until first deploy

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

function callsign() {
  const v = $('nameInput').value.trim().replace(/[^\w \-]/g, '').slice(0, 12);
  return v || CALLSIGNS[Math.floor(Math.random() * CALLSIGNS.length)] + Math.floor(Math.random() * 90 + 10);
}
function status(html) { $('lobbyStatus').innerHTML = html; }

function setPlaying(v) {
  playing = v;
  $('menu').classList.toggle('hidden', v);
  $('hud').classList.toggle('on', v);
  game.player.vmRoot.visible = v;
  $('roomcode').style.display = v && roomCode ? 'block' : 'none';
}

function deploy() {
  initAudio();
  renderer.domElement.requestPointerLock();
}

// --- solo / resume ---
// After a dead connection the button becomes a way back to a clean menu.
let netDead = false;
$('playBtn').addEventListener('click', () => {
  if (netDead) return location.reload();
  if (game.mode === 'client' && !game.myId) return; // still connecting
  deploy();
});

// --- host a room ---
$('hostBtn').addEventListener('click', () => {
  if (net) return;
  initAudio();
  game.mode = 'host';
  game.player.name = callsign();
  game.rebuild(Math.floor(Math.random() * 1e9));
  const tryCode = () => {
    roomCode = params.get('code')?.toUpperCase() ?? makeCode();
    net = Net.host(roomCode, {
      onOpen: () => {
        status(`room code <b>${roomCode}</b> — share it, then deploy`);
        $('roomcode').querySelector('b').textContent = roomCode;
        $('playBtn').textContent = 'DEPLOY — START MATCH';
        if (params.get('auto')) setPlaying(true);
      },
      onError: e => {
        if (e.type === 'unavailable-id' && !params.get('code')) {
          net.destroy();
          net = null;
          tryCode(); // roll again with a fresh peer
        } else status(`network error: ${e.type}`);
      },
      onData: (id, d) => game.hostOnData(id, d),
      onLeave: id => game.hostOnLeave(id),
    });
    game.net = net;
  };
  tryCode();
  status('creating room…');
});

// --- join a room ---
$('joinBtn').addEventListener('click', () => {
  if (net) return;
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length !== 4) return status('enter the 4-letter room code');
  initAudio();
  game.mode = 'client';
  game.player.name = callsign();
  status('connecting…');
  net = Net.join(code, {
    onOpen: () => {
      roomCode = code;
      $('roomcode').querySelector('b').textContent = code;
      net.send({ t: 'hi', name: game.player.name });
    },
    onData: d => game.clientOnData(d),
    onClose: () => {
      netDead = true;
      status('connection lost — the host left');
      $('playBtn').textContent = 'RETURN TO MENU';
      if (playing) { setPlaying(false); document.exitPointerLock?.(); }
    },
    onError: e => {
      // Join failed before the match started — reset so the lobby still works.
      net.destroy();
      net = null;
      game.net = null;
      game.mode = 'solo';
      status(e.type === 'peer-unavailable' ? 'room not found — check the code' : `network error: ${e.type}`);
    },
  });
  game.net = net;
  game.onWelcome = () => {
    status(`connected — you are <b>${game.player.team.toUpperCase()}</b>`);
    $('playBtn').textContent = 'DEPLOY';
    if (params.get('auto')) setPlaying(true);
  };
});

$('codeInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('joinBtn').click();
});

$('againBtn').addEventListener('click', () => location.reload());

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  if (locked) { setPlaying(true); return; }
  // Drop all held inputs so nobody runs/shoots blind while the menu is up.
  game.player.keys = {};
  game.player.mouseDown = [false, false, false];
  if (!game.over && !netDead) {
    setPlaying(false);
    $('playBtn').textContent = 'RESUME';
  }
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// Headless/test hooks: ?mp=host&code=TEST&auto=1 · ?mp=join&code=TEST&auto=1
if (params.get('mp') === 'host') {
  $('codeInput').value = '';
  $('hostBtn').click();
} else if (params.get('mp') === 'join') {
  $('codeInput').value = params.get('code') ?? 'TEST';
  setTimeout(() => $('joinBtn').click(), 800);
}

// ---------------- loop ----------------
const clock = new THREE.Clock();
let menuT = Math.PI * 0.15;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);

  // The host is authoritative — the simulation must never pause, even while
  // the host's own menu is up, or every client freezes with it.
  if (playing || game.mode === 'host') {
    game.update(dt);
  } else {
    // Slow cinematic orbit behind the menu.
    menuT += dt * 0.05;
    camera.position.set(
      SX / 2 + Math.cos(menuT) * 95,
      58,
      SZ / 2 + Math.sin(menuT) * 95
    );
    camera.lookAt(SX / 2, 24, SZ / 2);
    game.world.animateWater(game.time += dt);
    for (const f of ['green', 'blue']) game.flags[f].clientUpdate(game.time);
    game.effects.update(dt);
  }
  renderer.render(scene, camera);
}
frame();
