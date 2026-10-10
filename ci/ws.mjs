// AUDIT-1 T7-03 — a minimal WebSocket CLIENT for Node 20, which has no global WebSocket (Node 22+
// does, and the runner uses it there). Just enough RFC 6455 for a CDP session to Chrome on
// 127.0.0.1: masked text frames out; text/binary/continuation frames in (unmasked, any length);
// ping -> pong; close. The surface is the subset of the browser API the ci/ scripts touch:
// addEventListener('open'|'message'|'error'|'close'), send(string), close().
// Each ci/ script picks it up with
//   const WebSocket = globalThis.WebSocket && !process.env.BF_WS_SHIM ? globalThis.WebSocket : (await import('./ws.mjs')).default;
// BF_WS_SHIM=1 forces this client on a newer Node, which is how it is proven without a Node 20.
import http from 'node:http';
import { randomBytes } from 'node:crypto';

export default class MiniWebSocket {
  constructor(url) {
    this.l = { open: [], message: [], error: [], close: [] };
    this.sock = null;
    const u = new URL(url);
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64') },
    });
    req.on('upgrade', (res, sock, head) => {
      this.sock = sock; sock.setNoDelay(true);
      let buf = head || Buffer.alloc(0), frags = [];
      sock.on('data', (d) => {
        buf = buf.length ? Buffer.concat([buf, d]) : d;
        while (buf.length >= 2) {
          const fin = buf[0] & 0x80, op = buf[0] & 0x0f;
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf[1] & 0x80) off += 4;   // a server never masks, but skip a key if one is there
          if (buf.length < off + len) break;
          const pl = buf.subarray(off, off + len); buf = buf.subarray(off + len);
          if (op === 0x8) { try { sock.end(); } catch { } continue; }
          if (op === 0x9) { this._frame(0x8a, pl); continue; }
          if (op === 0xa) continue;
          frags.push(pl);
          if (fin) { const data = Buffer.concat(frags).toString('utf8'); frags = []; this._emit('message', { data }); }
        }
      });
      sock.on('error', (e) => this._emit('error', e));
      sock.on('close', () => this._emit('close', {}));
      this._emit('open', {});
    });
    req.on('response', (res) => { res.resume(); this._emit('error', new Error('websocket upgrade refused: HTTP ' + res.statusCode)); });
    req.on('error', (e) => this._emit('error', e));
    req.end();
  }
  addEventListener(t, f) { (this.l[t] || (this.l[t] = [])).push(f); }
  _emit(t, ev) { for (const f of this.l[t] || []) f(ev); }
  _frame(b0, payload) {
    const p = Buffer.from(payload), n = p.length, mask = randomBytes(4);
    let hdr;
    if (n < 126) hdr = Buffer.from([b0, 0x80 | n]);
    else if (n < 65536) { hdr = Buffer.alloc(4); hdr[0] = b0; hdr[1] = 0x80 | 126; hdr.writeUInt16BE(n, 2); }
    else { hdr = Buffer.alloc(10); hdr[0] = b0; hdr[1] = 0x80 | 127; hdr.writeBigUInt64BE(BigInt(n), 2); }
    for (let i = 0; i < n; i++) p[i] ^= mask[i & 3];
    this.sock.write(Buffer.concat([hdr, mask, p]));
  }
  send(s) { if (!this.sock) throw new Error('websocket not open'); this._frame(0x81, Buffer.from(String(s), 'utf8')); }
  close() { if (!this.sock) return; try { this._frame(0x88, Buffer.alloc(0)); this.sock.end(); } catch { } }
}
