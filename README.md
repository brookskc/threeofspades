# THREE of SPADES

**A voxel arena FPS in the spirit of Ace of Spades / Build and Shoot — rebuilt from scratch on three.js, running entirely in your browser.**

## ▶ Play now

**[prairielab.net/threeofspades](https://prairielab.net/threeofspades/)** — no install, no build, no terminal. Just click.

![Title screen](docs/title.png)

## The game

Green vs. Blue capture-the-flag on a fully destructible voxel island. Dig trenches
with your spade, wall off chokepoints with blocks, crater the midfield with
grenades — then steal the enemy flag and run it home. First team to
**3 captures** wins. Play solo with AI teammates and enemies who hunt flags,
strafe, and will literally dig through your walls — or host a room and fight
your friends.

## Multiplayer

Real browser-to-browser multiplayer over WebRTC — no server, no install, works
straight from GitHub Pages:

1. **Host** clicks `HOST`, gets a 4-letter room code, shares it, then deploys.
2. **Friends** enter the code and a callsign, click `JOIN`, then deploy.

The host's browser runs the authoritative match (bots, flags, damage, grenades,
terrain edits); everyone else connects directly to it over a peer-to-peer data
channel. Joining mid-match is fine — a bot steps aside to make room, and steps
back in if the player leaves. Up to ~8 players is the comfortable zone. Signaling
(the initial introduction between browsers) rides the free PeerJS cloud; after
that, gameplay traffic never leaves the peers.

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
git clone https://github.com/brookskc/threeofspades.git
cd threeofspades
python3 -m http.server 8000   # or: npx serve
# open http://localhost:8000
```

(Opening `index.html` directly from disk won't work — browsers block ES module
imports over `file://`. Any static server avoids this.)

## Tech notes (multiplayer)

- `src/net.js` wraps PeerJS in a host-authoritative star: clients send inputs and
  actions, the host simulates, everyone renders snapshots with ~130 ms
  interpolation (`src/avatar.js`).
- Maps are seed-deterministic, so joiners regenerate the identical island locally
  and replay a compact edit log to catch up on every dug trench and crater.

## Roadmap

- Classic 512² maps, more modes (TC), map seed selector, host migration.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free to play, study, modify, and share
for noncommercial purposes. Commercial use requires a separate license.

*Not affiliated with the original Ace of Spades, Build and Shoot, openspades,
or piqueserver — this is a clean-room fan tribute.*
