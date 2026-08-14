# THREE of SPADES

**A voxel arena FPS in the spirit of Ace of Spades / Build and Shoot — rebuilt from scratch on three.js, running entirely in your browser.**

## ▶ Play now

**[brookskc.github.io/three-of-spades](https://brookskc.github.io/three-of-spades/)** — no install, no build, no terminal. Just click.

![Title screen](docs/title.png)

## The game

Green vs. Blue capture-the-flag on a fully destructible voxel island. Dig trenches
with your spade, wall off chokepoints with blocks, crater the midfield with
grenades — then steal the enemy flag and run it home. First team to
**3 captures** wins. You play alongside 3 AI teammates against 4 AI enemies
who hunt flags, strafe, and will literally dig through your walls.

![Gameplay](docs/gameplay.png)

### Arsenal

| Tool | Behavior |
|---|---|
| **Rifle** | Slow, precise, deadly. Headshots drop anyone. RMB to aim. |
| **SMG** | Fast, sprayable, chews through people and cover alike. |
| **Spade** | Digs any block in one hit — and doubles as a melee weapon. |
| **Blocks** | Place team-colored cover anywhere. Dig blocks back to restock. |
| **Grenades** | Bounce, cook for 2.4s, then carve a real crater out of the map. |

### Controls

`WASD` move · `Space` jump/swim · `Shift` sprint · `LMB` fire/dig/place ·
`RMB` aim · `1–4` select tool · `G` grenade · `R` reload · `Esc` pause

## Tech notes

- **No build step.** Plain ES modules + an import map; three.js r170 is vendored
  in `vendor/`. Any static file server can host it.
- **Chunked voxel engine** (`src/world.js`) — 256×256×64 world, 16×16 full-height
  chunks, culled-face meshing with classic per-face shading baked into vertex
  colors, DDA raycasting for hitscan weapons and block picking.
- **Everything is synthesized.** All audio (gunfire, digs, explosions, the capture
  jingle) is generated live with WebAudio — the repo contains zero binary assets
  besides screenshots.
- **Bots** (`src/bots.js`) run a small sense–decide–act loop: acquire targets with
  line-of-sight checks, strafe while firing, path toward flags, and shovel through
  obstacles when stuck.

## Run it locally

Optional — the live demo above is the same code. But if you want a local copy:

```sh
git clone https://github.com/brookskc/three-of-spades.git
cd three-of-spades
python3 -m http.server 8000   # or: npx serve
# open http://localhost:8000
```

(Opening `index.html` directly from disk won't work — browsers block ES module
imports over `file://`. Any static server avoids this.)

## Roadmap

- **Multiplayer.** GitHub Pages is static-only, so a dedicated server
  (piqueserver-style) is out — but WebRTC data channels make real
  browser-to-browser multiplayer possible on pure static hosting, with a free
  signaling service (e.g. PeerJS cloud) doing the introductions and the first
  player's browser acting as the authoritative host. That's the plan.
- Classic 512² maps, more modes (TC), map seed selector.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free to play, study, modify, and share
for noncommercial purposes. Commercial use requires a separate license.

*Not affiliated with the original Ace of Spades, Build and Shoot, openspades,
or piqueserver — this is a clean-room fan tribute.*
