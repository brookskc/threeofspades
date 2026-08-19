// stats.js — lifetime stats and gun-color unlocks. Entirely client-side:
// localStorage, same as the tos.mode/tos.map lobby prefs main.js already
// keeps. No account, no server, no sync between machines — this progress
// lives on this browser, same as everything else about this game.
const KEY = 'tos.stats';

// Kill-count thresholds for gun color unlocks (first-person viewmodel only
// — see Player#setGunColor). Reachable within a session or two at the low
// end, genuinely earned by the top.
export const GUN_COLORS = [
  { kills: 0,   name: 'GUNMETAL', hex: 0x2b2b30 },
  { kills: 10,  name: 'SLATE',    hex: 0x3d4a5c },
  { kills: 25,  name: 'COPPER',   hex: 0x8a5a3a },
  { kills: 50,  name: 'SILVER',   hex: 0xb8bec7 },
  { kills: 100, name: 'GOLD',     hex: 0xd4af37 },
  { kills: 250, name: 'CRIMSON',  hex: 0xb0272d },
  { kills: 500, name: 'PRISM',    hex: 0x4fd4d0 },
];
const DEFAULT_HEX = GUN_COLORS[0].hex;

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      kills: raw.kills | 0, deaths: raw.deaths | 0,
      matches: raw.matches | 0, wins: raw.wins | 0,
      gunColor: Number.isFinite(raw.gunColor) ? raw.gunColor : DEFAULT_HEX,
    };
  } catch {
    return { kills: 0, deaths: 0, matches: 0, wins: 0, gunColor: DEFAULT_HEX };
  }
}
function save(s) {
  // Private browsing, a full quota, a locked-down browser — stats just
  // don't persist. Nothing here is load-bearing for the match itself.
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* best effort */ }
}

let state = load();

export const stats = {
  get() { return { ...state }; },
  unlocked() { return GUN_COLORS.filter(c => state.kills >= c.kills); },
  addKill() { state.kills++; save(state); },
  addDeath() { state.deaths++; save(state); },
  addMatch(won) { state.matches++; if (won) state.wins++; save(state); },
  gunColor() { return state.gunColor; },
  // Refuses a color the kill count hasn't actually unlocked yet — the menu
  // never offers one, but this is the real gate regardless of what built
  // the click.
  setGunColor(hex) {
    if (!GUN_COLORS.some(c => c.hex === hex && state.kills >= c.kills)) return false;
    state.gunColor = hex;
    save(state);
    return true;
  },
};
