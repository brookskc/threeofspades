// net.js — PeerJS wrapper. Host-authoritative star topology over WebRTC.
// Signaling rides the free PeerJS cloud; gameplay is pure browser-to-browser.
const PREFIX = 'threeofspades-';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function makeCode() {
  return Array.from({ length: 4 }, () =>
    CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
}

export class Net {
  // ---------------- host ----------------
  static host(code, handlers) {
    const net = new Net();
    net.isHost = true;
    net.id = 'HOST';
    net.conns = new Map(); // peerId -> DataConnection
    net.peer = new Peer(PREFIX + code);
    window.__net = net; // debug handle
    net.peer.on('open', () => handlers.onOpen?.());
    net.peer.on('error', e => handlers.onError?.(e));
    net.peer.on('connection', conn => {
      conn.on('open', () => handlers.onJoin?.(conn.peer, conn));
      conn.on('data', d => handlers.onData?.(conn.peer, d));
      const drop = () => {
        if (net.conns.delete(conn.peer)) handlers.onLeave?.(conn.peer);
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
    net.peer = new Peer();
    window.__net = net; // debug handle
    net.peer.on('error', e => handlers.onError?.(e));
    net.peer.on('open', () => {
      net.conn = net.peer.connect(PREFIX + code, { reliable: true });
      net.conn.on('open', () => handlers.onOpen?.());
      net.conn.on('data', d => handlers.onData?.(d));
      net.conn.on('close', () => handlers.onClose?.());
      net.conn.on('error', () => handlers.onClose?.());
    });
    return net;
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
