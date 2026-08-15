# THREE of SPADES

**A voxel arena shooter made with three.js — running entirely in your browser.**

## ▶ Play now

**[prairielab.net/threeofspades](https://prairielab.net/threeofspades/)** — no install, no build, no terminal. Just click.

![Title screen](docs/title.png)

## The game

Green vs. Blue capture-the-flag on fully destructible voxel battlefields. Dig
trenches with your spade, wall off chokepoints with blocks, crater the midfield
with grenades — even ordinary gunfire chews through cover — then steal the
enemy flag and run it home. First team to **3 captures** wins.

Every room runs with AI soldiers who hunt flags, strafe, and will literally dig
through your walls — so a quiet room still plays a full match while it waits
for humans to drop in. When they do, bots step aside to make room, and step
back in if someone leaves.

## Multiplayer

Real browser-to-browser multiplayer over WebRTC — no server, no install, works
straight from GitHub Pages.

**QUICK MATCH is the front door.** Type a callsign, hit deploy, and you're in a
public room with strangers. It peeks at a small set of deterministic public
slots, then joins the **fullest room that still has space** — so players pile
into the same games instead of scattering across empty ones. If no room is
open, it quietly claims a slot and hosts one for the next quick-matcher to
find. Rooms are capped at **8 human players**, with humans always split across
opposing teams (you fight *each other*, not side-by-side against bots).

Want a private lobby instead? The small `host` / `join` links under the main
button give you a 4-letter room code to share with friends.

The host's browser runs the authoritative match (bots, flags, damage, grenades,
terrain edits); everyone else connects directly to it over a peer-to-peer data
channel. Joining mid-match is fine. Signaling (the initial introduction between
browsers) rides the free PeerJS cloud; after that, gameplay traffic never
leaves the peers.

### How many players can it handle?

- **Per room:** 8 humans, by design. The host's browser simulates everything,
  so the practical limit is the host's upload bandwidth — a full room costs
  roughly **1–3 Mbps of upload**, comfortable on most home connections.
- **Globally:** effectively unbounded. There is no game server — every room is
  hosted by a player in it, so 10 rooms or 10,000 rooms cost the project
  nothing. The only shared infrastructure is the free PeerJS signaling broker,
  which handles brief introductions, not gameplay.
- **Quick-match pool:** 8 public slots × 8 seats = **64 concurrent
  quick-matchers** before the pool reports full (one constant in `src/net.js`
  raises it). Private rooms use 32⁴ ≈ 1.05M possible codes, each an
  independent battlefield.

## Maps

Four themed battlefields, seeded so every player generates the identical world.
After each match the room automatically rotates to the next map with a fresh
seed:

| Map | Theme |
|---|---|
| **GREENBELT** | The classic rolling green island. Open hills, midfield ridgelines — pure arena CTF. |
| **BEACHHEAD** | D-Day. Green team storms out of landing craft onto open sand dotted with tank traps; Blue holds the bluff in concrete MG pillboxes with firing slits. |
| **PINEFALL** | Dense pine forest cut by a winding creek. Short sightlines, flanking routes, ambush country. |
| **DUNES** | Desert mesas and ridged dunes. Long sniper lanes between sheer rock towers, ruins at midfield. |

![Gameplay](docs/gameplay.png)

### Arsenal

| Tool | Behavior |
|---|---|
| **Rifle** | Slow, precise, deadly. Headshots drop anyone. RMB to aim. |
| **SMG** | Fast, sprayable, chews through people and cover alike. |
| **Spade** | Digs any block in one hit — and doubles as a melee weapon. |
| **Blocks** | Place team-colored cover anywhere. Dig blocks back to restock. |
| **Grenades** | Bounce, cook for 2.4s, then carve a real crater out of the map. |

All terrain is destructible: spades and grenades remove blocks outright, and
sustained gunfire breaks blocks too — cover is temporary.

### Controls

`WASD` move · `Space` jump/swim · `Shift` sprint · `C` crouch (steadier aim) ·
`LMB` fire/dig/place · `RMB` aim · `1–4` / `Q`·`E` select tool · `F` grenade ·
`R` reload · `Esc` pause

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
- **Multiplayer** (`src/net.js`) wraps PeerJS in a host-authoritative star:
  clients send inputs and actions, the host simulates, everyone renders
  snapshots with ~130 ms interpolation (`src/avatar.js`). Maps are
  seed-deterministic, so joiners regenerate the identical world locally and
  replay a compact edit log to catch up on every dug trench and crater.

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

## Roadmap

- Classic 512² maps, more modes (TC), map seed selector, host migration.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free to play, study, modify, and share
for noncommercial purposes. Commercial use requires a separate license.

*A clean-room tribute to the voxel-shooter genre; not affiliated with any
other project.*
