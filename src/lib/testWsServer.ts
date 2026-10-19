import http from 'node:http';
import crypto from 'node:crypto';
import type { Socket } from 'node:net';

/**
 * Minimal RFC 6455 text-frame WebSocket server for tests (no dependency). One handler gets each
 * parsed JSON message and a `send` that writes a JSON text frame back.
 */
export class WebSocketServer {
  private constructor(
    private server: http.Server,
    readonly url: string,
  ) {}

  static async start(onMessage: (msg: unknown, send: (obj: unknown) => void) => void): Promise<WebSocketServer> {
    const server = http.createServer();
    server.on('upgrade', (req, socket: Socket) => {
      const key = String(req.headers['sec-websocket-key'] || '');
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const send = (obj: unknown) => {
        const payload = Buffer.from(JSON.stringify(obj));
        const len = payload.length;
        const head = len < 126 ? Buffer.from([0x81, len]) : Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
        socket.write(Buffer.concat([head, payload]));
      };
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const op = buf[0]! & 0x0f;
          let len = buf[1]! & 0x7f;
          let off = 2;
          if (len === 126) {
            len = buf.readUInt16BE(2);
            off = 4;
          }
          const masked = (buf[1]! & 0x80) !== 0;
          const need = off + (masked ? 4 : 0) + len;
          if (buf.length < need) return;
          const mask = masked ? buf.subarray(off, off + 4) : null;
          const data = Buffer.from(buf.subarray(off + (masked ? 4 : 0), need));
          if (mask) for (let i = 0; i < data.length; i++) data[i] = data[i]! ^ mask[i % 4]!;
          buf = buf.subarray(need);
          if (op === 0x8) {
            socket.end();
            return;
          }
          if (op === 0x1) onMessage(JSON.parse(data.toString('utf8')), send);
        }
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    return new WebSocketServer(server, `ws://127.0.0.1:${port}/devtools/page/T`);
  }

  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }
}
