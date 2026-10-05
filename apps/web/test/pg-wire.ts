/**
 * Local stand-in for a hosted Neon database, without Docker: PGlite served over the Postgres
 * wire protocol (@electric-sql/pglite-socket) behind a minimal WebSocket-to-TCP proxy of the
 * kind the Neon serverless driver talks to. TLS and Neon's own proxy are not exercised.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { neonConfig } from '@neondatabase/serverless';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.byteLength;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** WebSocket server that pipes binary frames to and from a TCP port. */
async function startWsTcpProxy(target: { host: string; port: number }) {
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => {
    res.writeHead(426);
    res.end();
  });
  server.on('upgrade', (req, socket: Socket, head: Buffer) => {
    sockets.add(socket);
    const key = String(req.headers['sec-websocket-key'] ?? '');
    const accept = createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const upstream = connect(target.port, target.host);
    sockets.add(upstream);
    let buf = Buffer.from(head);
    const parse = () => {
      for (;;) {
        if (buf.length < 2) return;
        const opcode = (buf[0] as number) & 0x0f;
        const masked = ((buf[1] as number) & 0x80) !== 0;
        let len = (buf[1] as number) & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const maskAt = off;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len));
        if (masked) {
          for (let i = 0; i < payload.length; i++) {
            payload[i] = (payload[i] as number) ^ (buf[maskAt + (i % 4)] as number);
          }
        }
        buf = buf.subarray(off + len);
        if (opcode === 0x8) {
          upstream.end();
          socket.end(frame(0x8, Buffer.alloc(0)));
          return;
        }
        if (opcode === 0x9) socket.write(frame(0xa, payload));
        else if (opcode <= 0x2) upstream.write(payload);
      }
    };
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      parse();
    });
    upstream.on('data', (chunk: Buffer) => {
      if (socket.writable) socket.write(frame(0x2, chunk));
    });
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    if (buf.length > 0) parse();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('proxy did not start');
  return {
    port: address.port,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface FakeNeon {
  /** Connection string to pass where DATABASE_URL would go. */
  url: string;
  /** Value for AGENTHUB_DB_WS_PROXY. */
  wsProxy: string;
  /** Direct access to the database behind the wire, for assertions. */
  pglite: PGlite;
  close(): Promise<void>;
}

/** Start PGlite on a TCP port and route the Neon driver to it through the proxy. */
export async function startFakeNeon(): Promise<FakeNeon> {
  const pglite = new PGlite();
  const server = new PGLiteSocketServer({
    db: pglite,
    host: '127.0.0.1',
    port: 0,
    maxConnections: 32,
  });
  await server.start();
  const port = Number(server.getServerConn().split(':').pop());
  const proxy = await startWsTcpProxy({ host: '127.0.0.1', port });

  const wsProxy = `127.0.0.1:${proxy.port}/v2`;
  neonConfig.wsProxy = (host, p) => `${wsProxy}?address=${host}:${p}`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.forceDisablePgSSL = true;
  neonConfig.pipelineConnect = false;
  neonConfig.pipelineTLS = false;

  return {
    url: 'postgresql://agenthub:not-a-secret@ep-local-test.neon.invalid/agenthub?sslmode=require',
    wsProxy,
    pglite,
    async close() {
      await proxy.close();
      await server.stop();
      await pglite.close();
    },
  };
}
