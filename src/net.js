// net.js — PeerJS wrapper. Host-authoritative star topology over WebRTC.
// Signaling rides the free PeerJS cloud; gameplay is pure browser-to-browser.
// ?ns=name scopes all peer ids — tests and events get their own universe.
const ns = new URLSearchParams(location.search).get('ns')?.replace(/[^\w-]/g, '').slice(0, 16);
const PREFIX = 'threeofspades-' + (ns ? ns + '-' : '');
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// Quick-match rendezvous: deterministic public room ids. Private codes are
// drawn from an alphabet without digits, so 'PUB0'…'PUB7' can never collide.
export const PUBLIC_SLOTS = 8;
export const slotCode = i => 'PUB' + i;

export function makeCode() {
  return Array.from({ length: 4 }, () =>
    CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
}

export class Net {
  // Handlers live on the instance so the lobby can rewire a connection after
  // the matchmaking handshake (e.g. attach the game once a room accepts us).
  constructor() { this.handlers = {}; }

  // ---------------- host ----------------
  static host(code, handlers) {
    const net = new Net();
    net.isHost = true;
    net.id = 'HOST';
    net.conns = new Map(); // peerId -> DataConnection
    net.handlers = handlers;
    net.peer = new Peer(PREFIX + code);
    window.__net = net; // debug handle
    net.peer.on('open', () => net.handlers.onOpen?.());
    net.peer.on('error', e => net.handlers.onError?.(e));
    net.peer.on('connection', conn => {
      conn.on('open', () => net.handlers.onJoin?.(conn.peer, conn));
      conn.on('data', d => net.handlers.onData?.(conn.peer, d));
      const drop = () => {
        if (net.conns.delete(conn.peer)) net.handlers.onLeave?.(conn.peer);
      };
      conn.on('close', drop);
      conn.on('error', drop);
      net.conns.set(conn.peer, conn);
    });
    return net;
  }

  // ---------------- client ----------------
  static join(code, handlers) {
    const net = new Net();
    net.isHost = false;
    net.handlers = handlers;
    net.peer = new Peer();
    window.__net = net; // debug handle
    net.peer.on('error', e => net.handlers.onError?.(e));
    net.peer.on('open', () => {
      net.conn = net.peer.connect(PREFIX + code, { reliable: true });
      net.conn.on('open', () => net.handlers.onOpen?.());
      net.conn.on('data', d => net.handlers.onData?.(d));
      net.conn.on('close', () => net.handlers.onClose?.());
      net.conn.on('error', () => net.handlers.onClose?.());
    });
    return net;
  }

  // Knock on one room with an existing anon peer. Resolves:
  //   { kind: 'join', conn, welcome } — welcomed in; adopt the connection
  //   { kind: 'full' }  — room answered but is at capacity
  //   { kind: 'dead' }  — no such room / wedged / refused mid-knock
  //   { kind: 'down' }  — signaling unreachable
  static _knock(peer, code, name, timeoutMs) {
    return new Promise(resolve => {
      let settled = false;
      const done = v => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.off('error', onErr);
        resolve(v);
      };
      const timer = setTimeout(() => { conn.close(); done({ kind: 'dead' }); }, timeoutMs);
      const onErr = e => done({ kind: e.type === 'peer-unavailable' ? 'dead' : 'down' });
      peer.on('error', onErr); // the broker reports unknown room ids on the peer
      const conn = peer.connect(PREFIX + code, { reliable: true });
      conn.on('open', () => conn.send({ t: 'hi', name }));
      conn.on('data', d => {
        if (d.t === 'w') done({ kind: 'join', conn, welcome: d });
        else if (d.t === 'full') { conn.close(); done({ kind: 'full' }); }
      });
      conn.on('close', () => done({ kind: 'dead' }));
      conn.on('error', () => done({ kind: 'dead' }));
    });
  }

  // Claim a public slot id as host. Resolves { kind: 'host', net } — real
  // handlers attach on adoption — or { kind: 'taken' } / { kind: 'down' }.
  static _claim(code, timeoutMs) {
    return new Promise(resolve => {
      let settled = false;
      const net = Net.host(code, {});
      const done = v => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (v.kind !== 'host') net.destroy();
        resolve(v);
      };
      const timer = setTimeout(() => done({ kind: 'down' }), timeoutMs);
      net.peer.on('open', () => done({ kind: 'host', net }));
      net.peer.on('error', e =>
        done({ kind: e.type === 'unavailable-id' ? 'taken' : 'down' }));
    });
  }

  // Wrap a welcomed knock connection as a client Net for adoption.
  static adoptGuest(peer, conn) {
    const net = new Net();
    net.isHost = false;
    net.peer = peer;
    net.conn = conn;
    window.__net = net; // debug handle
    peer.on('error', e => net.handlers.onError?.(e));
    conn.on('data', d => net.handlers.onData?.(d));
    conn.on('close', () => net.handlers.onClose?.());
    conn.on('error', () => net.handlers.onClose?.());
    return net;
  }

  // Peek at one room without joining: resolves { kind: 'room', humans, max },
  // { kind: 'dead' } (nobody home), or { kind: 'down' } (signaling broken).
  // Probes run concurrently on ONE peer, and the broker reports a dead target
  // as a peer-level 'peer-unavailable' error naming that target — so a miss
  // for slot N must not sink the probe still talking to slot M.
  static _probe(peer, code, timeoutMs) {
    return new Promise(resolve => {
      const target = PREFIX + code;
      let settled = false;
      const done = v => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.off('error', onErr);
        conn.close();
        resolve(v);
      };
      const timer = setTimeout(() => done({ kind: 'dead' }), timeoutMs);
      const onErr = e => {
        if (e.type === 'peer-unavailable') {
          if (String(e.message).includes(target)) done({ kind: 'dead' });
          return; // somebody else's miss — not ours
        }
        done({ kind: 'down' });
      };
      peer.on('error', onErr);
      const conn = peer.connect(target, { reliable: true });
      conn.on('open', () => conn.send({ t: 'ping' }));
      conn.on('data', d => { if (d.t === 'pong') done({ kind: 'room', humans: d.humans, max: d.max }); });
      conn.on('close', () => done({ kind: 'dead' }));
      conn.on('error', () => done({ kind: 'dead' }));
    });
  }

  // Quick match over ONE anon guest peer — the broker throttles IPs that open
  // many signaling sockets, so the whole scan multiplexes over a single socket.
  // All slots are probed concurrently (data connections are cheap; sockets are
  // not), then we join the FULLEST room that still has space (ties break to
  // the lowest slot) so strangers pile into the same games. Only if nobody
  // has room do we claim a dead slot and host it ourselves.
  // Resolves { kind: 'host'|'join', net, slot, welcome? }
  //      or  { kind: 'full-all' } | { kind: 'down' }.
  static async quickScan(name, timeoutMs = 9000) {
    const guest = new Peer();
    const ready = new Promise((res, rej) => {
      guest.on('open', res);
      guest.on('error', rej); // pre-open error = broker unreachable
    });
    try { await ready; } catch { guest.destroy(); return { kind: 'down' }; }
    try {
      const results = await Promise.all(
        Array.from({ length: PUBLIC_SLOTS }, (_, i) =>
          Net._probe(guest, slotCode(i), timeoutMs).then(p => ({ slot: i, p }))));
      const open = [], dead = [];
      for (const { slot, p } of results) {
        console.debug(`[qm] probe ${slotCode(slot)} -> ${p.kind}${p.kind === 'room' ? ` ${p.humans}/${p.max}` : ''}`);
        if (p.kind === 'room') { if (p.humans < p.max) open.push({ slot, humans: p.humans }); }
        else if (p.kind === 'dead') dead.push(slot);
        else { guest.destroy(); return { kind: 'down' }; }
      }
      // Fullest first, ties to the lowest slot number.
      open.sort((a, b) => b.humans - a.humans || a.slot - b.slot);
      for (const room of open) {
        const k = await Net._knock(guest, slotCode(room.slot), name, timeoutMs);
        console.debug(`[qm] knock ${slotCode(room.slot)} -> ${k.kind}`);
        if (k.kind === 'join')
          return { kind: 'join', net: Net.adoptGuest(guest, k.conn), slot: room.slot, welcome: k.welcome };
        if (k.kind === 'down') { guest.destroy(); return { kind: 'down' }; }
        // 'full'/'dead': lost a race — try the next room
      }
      for (const i of dead) {
        const c = await Net._claim(slotCode(i), timeoutMs);
        console.debug(`[qm] claim ${slotCode(i)} -> ${c.kind}`);
        if (c.kind === 'host') { guest.destroy(); return { kind: 'host', net: c.net, slot: i }; }
        if (c.kind === 'down') { guest.destroy(); return { kind: 'down' }; }
        // 'taken': the probe said dead but the id is registered — the broker
        // never lies about that, so the probe was a false negative (slow net).
        // Give a proven-live room one direct knock before moving on.
        const k = await Net._knock(guest, slotCode(i), name, timeoutMs);
        console.debug(`[qm] knock ${slotCode(i)} (taken) -> ${k.kind}`);
        if (k.kind === 'join')
          return { kind: 'join', net: Net.adoptGuest(guest, k.conn), slot: i, welcome: k.welcome };
        if (k.kind === 'down') { guest.destroy(); return { kind: 'down' }; }
        // 'full'/'dead': genuinely unavailable — try the next dead slot
      }
      guest.destroy();
      return { kind: 'full-all' };
    } catch (e) {
      guest.destroy();
      return { kind: 'down' };
    }
  }

  get clientIds() { return [...this.conns.keys()]; }

  broadcast(obj) {
    for (const c of this.conns.values()) if (c.open) c.send(obj);
  }
  sendTo(id, obj) {
    const c = this.conns.get(id);
    if (c?.open) c.send(obj);
  }
  send(obj) { // client -> host
    if (this.conn?.open) this.conn.send(obj);
  }
  destroy() { this.peer?.destroy(); }
}
