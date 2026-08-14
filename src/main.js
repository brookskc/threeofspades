// main.js — boot, renderer, sky, menu flow, main loop.
import * as THREE from 'three';
import { Game } from './game.js';
import { initAudio } from './audio.js';
import { SX, SZ } from './world.js';

const $ = id => document.getElementById(id);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = skyGradient();
scene.fog = new THREE.Fog(0xcfe4f7, 70, 230);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 500);
scene.add(camera); // so the viewmodel renders

const game = new Game(scene, camera, renderer.domElement);

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

// ---------------- menu / pause flow ----------------
let playing = false;

function setPlaying(v) {
  playing = v;
  $('menu').classList.toggle('hidden', v);
  $('hud').classList.toggle('on', v);
  game.player.vmRoot.visible = v;
}

game.player.vmRoot.visible = false; // hidden until first deploy

// ?spectate boots straight into first person (no pointer lock) for testing.
if (location.search.includes('spectate')) setPlaying(true);

$('playBtn').addEventListener('click', () => {
  initAudio();
  renderer.domElement.requestPointerLock();
});
$('againBtn').addEventListener('click', () => location.reload());

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  if (locked) setPlaying(true);
  else if (!game.over) {
    setPlaying(false);
    $('playBtn').textContent = 'RESUME';
  }
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------- loop ----------------
const clock = new THREE.Clock();
let menuT = Math.PI * 0.15;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (playing) {
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
    for (const f of ['green', 'blue']) game.flags[f].update(dt, game.time);
    game.effects.update(dt);
  }
  renderer.render(scene, camera);
}
frame();
