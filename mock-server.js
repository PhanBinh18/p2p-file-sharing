/**
 * Mock Server phục vụ chạy thử và kiểm thử Client theo đúng hợp đồng giao thức:
 * - Phục vụ file tĩnh trong client/ (HTML, CSS, JS)
 * - WebSocket /ws (Signaling bắt tay WebRTC)
 * - HTTP API: /healthz, /api/config, /api/relay/:roomCode/upload, /api/relay/:roomCode/:fileId, /api/stats/:roomCode
 *
 * Chạy độc lập hoàn toàn bằng Node.js thuần (Zero dependencies).
 * Sử dụng: node mock-server.js
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const CLIENT_DIR = path.join(__dirname, 'client');
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Lưu trữ bộ nhớ
const rooms = new Map(); // roomCode -> { code, host: { peerId, nickname, ws }, guest: { peerId, nickname, ws } | null, pending: { peerId, nickname, ws, timer } | null, files: Map }
const stats = new Map(); // roomCode -> { signalingBytes: 0, relayUploadBytes: 0, relayDownloadBytes: 0 }
const relayFiles = new Map(); // fileId -> { roomCode, fileName, fileSize, sha256, buffer, createdAt }

function getRoomStats(code) {
  if (!stats.has(code)) {
    stats.set(code, { signalingBytes: 0, relayUploadBytes: 0, relayDownloadBytes: 0 });
  }
  return stats.get(code);
}

function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    const idx = crypto.randomInt(0, ROOM_CODE_CHARS.length);
    code += ROOM_CODE_CHARS[idx];
  }
  return code;
}

// MIME types cho file tĩnh
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  // 1. GET /healthz
  if (req.method === 'GET' && pathname === 'healthz' || pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // 2. GET /api/config
  if (req.method === 'GET' && pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ],
      maxFileSizeBytes: 104857600,
      chunkSizeBytes: 16384
    }));
    return;
  }

  // 3. GET /api/stats/:roomCode
  const statsMatch = pathname.match(/^\/api\/stats\/([A-Za-z0-9]{6})$/);
  if (req.method === 'GET' && statsMatch) {
    const roomCode = statsMatch[1].toUpperCase();
    const s = getRoomStats(roomCode);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(s));
    return;
  }

  // 4. POST /api/relay/:roomCode/upload
  const uploadMatch = pathname.match(/^\/api\/relay\/([A-Za-z0-9]{6})\/upload$/);
  if (req.method === 'POST' && uploadMatch) {
    const roomCode = uploadMatch[1].toUpperCase();
    const peerId = req.headers['x-peer-id'];
    const fileNameEncoded = req.headers['x-file-name'];
    const fileSha256 = req.headers['x-file-sha256'];

    if (!peerId || !fileNameEncoded || !fileSha256) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required headers' }));
      return;
    }

    const room = rooms.get(roomCode);
    if (!room) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Room not found' }));
      return;
    }

    const fileName = decodeURIComponent(fileNameEncoded);
    const chunks = [];
    const startTime = Date.now();
    let totalBytes = 0;

    req.on('data', chunk => {
      chunks.push(chunk);
      totalBytes += chunk.length;
    });

    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const receivedMs = Date.now() - startTime;
      const fileId = crypto.randomUUID();

      relayFiles.set(fileId, {
        roomCode,
        fileName,
        fileSize: buffer.length,
        sha256: fileSha256,
        buffer,
        createdAt: Date.now()
      });

      const s = getRoomStats(roomCode);
      s.relayUploadBytes += buffer.length;

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fileId, size: buffer.length, receivedMs }));

      // Thông báo cho người còn lại trong phòng qua WebSocket
      const otherPeer = (room.host && room.host.peerId === peerId) ? room.guest : room.host;
      if (otherPeer && otherPeer.ws) {
        otherPeer.ws.sendJson({
          type: 'relay-file-available',
          fileId,
          fileName,
          fileSize: buffer.length,
          sha256: fileSha256,
          uploadMs: receivedMs
        });
      }
    });
    return;
  }

  // 5. GET /api/relay/:roomCode/:fileId?peerId=<id>
  const downloadMatch = pathname.match(/^\/api\/relay\/([A-Za-z0-9]{6})\/([a-f0-9\-]+)$/);
  if (req.method === 'GET' && downloadMatch) {
    const roomCode = downloadMatch[1].toUpperCase();
    const fileId = downloadMatch[2];
    const peerId = urlObj.searchParams.get('peerId');

    const fileData = relayFiles.get(fileId);
    if (!fileData || fileData.roomCode !== roomCode) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
      return;
    }

    const s = getRoomStats(roomCode);
    s.relayDownloadBytes += fileData.buffer.length;

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': fileData.buffer.length,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileData.fileName)}"`
    });
    res.end(fileData.buffer);
    return;
  }

  // 6. Serve static files trong CLIENT_DIR
  let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') safePath = '/index.html';

  const filePath = path.join(CLIENT_DIR, safePath);
  const ext = path.extname(filePath).toLowerCase();

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

// RFC 6455 WebSocket Handshake & Minimal Server
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') {
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`
  ];

  socket.write(headers.join('\r\n') + '\r\n\r\n');

  // WebSocket Wrapper cho socket
  const ws = {
    socket,
    peerId: null,
    roomCode: null,
    sendJson(obj) {
      const jsonStr = JSON.stringify(obj);
      const payload = Buffer.from(jsonStr, 'utf8');
      const len = payload.length;

      let frameHeader;
      if (len < 126) {
        frameHeader = Buffer.from([0x81, len]);
      } else if (len <= 65535) {
        frameHeader = Buffer.alloc(4);
        frameHeader[0] = 0x81;
        frameHeader[1] = 126;
        frameHeader.writeUInt16BE(len, 2);
      } else {
        frameHeader = Buffer.alloc(10);
        frameHeader[0] = 0x81;
        frameHeader[1] = 127;
        frameHeader.writeBigUInt64BE(BigInt(len), 2);
      }

      try {
        socket.write(Buffer.concat([frameHeader, payload]));
      } catch (e) {}

      // Cộng byte vào thống kê
      if (ws.roomCode) {
        const s = getRoomStats(ws.roomCode);
        s.signalingBytes += frameHeader.length + payload.length;
      }
    }
  };

  // Đọc frame đơn giản
  let buffer = Buffer.alloc(0);

  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (ws.roomCode) {
      const s = getRoomStats(ws.roomCode);
      s.signalingBytes += chunk.length;
    }

    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (opcode === 0x8) {
        // Close frame
        socket.end();
        return;
      }

      if (payloadLen === 126) {
        if (buffer.length < offset + 2) break;
        payloadLen = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (buffer.length < offset + 8) break;
        payloadLen = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      let maskKey = null;
      if (isMasked) {
        if (buffer.length < offset + 4) break;
        maskKey = buffer.slice(offset, offset + 4);
        offset += 4;
      }

      if (buffer.length < offset + payloadLen) break;

      const payload = buffer.slice(offset, offset + payloadLen);
      buffer = buffer.slice(offset + payloadLen);

      if (isMasked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      if (opcode === 0x1) {
        // Text message
        try {
          const msg = JSON.parse(payload.toString('utf8'));
          handleWsMessage(ws, msg);
        } catch (e) {
          ws.sendJson({ type: 'error', code: 'INVALID_MESSAGE', message: 'Invalid JSON' });
        }
      }
    }
  });

  socket.on('close', () => {
    handleWsClose(ws);
  });

  socket.on('error', () => {
    handleWsClose(ws);
  });
});

function handleWsMessage(ws, msg) {
  const { type } = msg;

  // 1. create-room
  if (type === 'create-room') {
    const nick = (msg.nickname || '').trim();
    if (!nick || nick.length > 20) {
      ws.sendJson({ type: 'error', code: 'INVALID_NICKNAME', message: 'Biệt danh không hợp lệ' });
      return;
    }

    let code;
    do {
      code = generateRoomCode();
    } while (rooms.has(code));

    const peerId = crypto.randomUUID();
    ws.peerId = peerId;
    ws.roomCode = code;

    const room = {
      code,
      host: { peerId, nickname: nick, ws },
      guest: null,
      pending: null,
      createdAt: Date.now()
    };
    rooms.set(code, room);

    ws.sendJson({ type: 'room-created', roomCode: code, peerId });
    console.log(`[Room ${code}] Tạo bởi chủ phòng: ${nick} (${peerId})`);
    return;
  }

  // 2. join-room
  if (type === 'join-room') {
    const code = (msg.roomCode || '').trim().toUpperCase();
    const nick = (msg.nickname || '').trim();

    if (!nick || nick.length > 20) {
      ws.sendJson({ type: 'error', code: 'INVALID_NICKNAME', message: 'Biệt danh không hợp lệ' });
      return;
    }

    const room = rooms.get(code);
    if (!room) {
      ws.sendJson({ type: 'error', code: 'ROOM_NOT_FOUND', message: 'Phòng không tồn tại' });
      return;
    }

    if (room.guest || room.pending) {
      ws.sendJson({ type: 'error', code: 'ROOM_FULL', message: 'Phòng đã đủ người hoặc đang có người chờ' });
      return;
    }

    const peerId = crypto.randomUUID();
    ws.peerId = peerId;
    ws.roomCode = code;

    // Timer 60s timeout
    const timer = setTimeout(() => {
      if (room.pending && room.pending.peerId === peerId) {
        room.pending.ws.sendJson({ type: 'join-rejected', reason: 'timeout' });
        room.pending = null;
      }
    }, 60000);

    room.pending = { peerId, nickname: nick, ws, timer };

    ws.sendJson({ type: 'join-pending', roomCode: code, peerId });
    room.host.ws.sendJson({ type: 'join-request', peerId, nickname: nick });
    console.log(`[Room ${code}] Khách ${nick} (${peerId}) xin vào phòng`);
    return;
  }

  // 3. join-decision
  if (type === 'join-decision') {
    const room = rooms.get(ws.roomCode);
    if (!room || room.host.peerId !== ws.peerId) {
      ws.sendJson({ type: 'error', code: 'NOT_HOST', message: 'Không phải chủ phòng' });
      return;
    }

    const pending = room.pending;
    if (!pending) return;

    clearTimeout(pending.timer);
    room.pending = null;

    if (msg.accept) {
      room.guest = pending;
      pending.ws.sendJson({ type: 'join-accepted', hostNickname: room.host.nickname });
      console.log(`[Room ${room.code}] Chủ phòng duyệt cho khách ${pending.nickname}`);
    } else {
      pending.ws.sendJson({ type: 'join-rejected', reason: 'host-declined' });
      console.log(`[Room ${room.code}] Chủ phòng từ chối khách ${pending.nickname}`);
    }
    return;
  }

  // 4. peer-ready
  if (type === 'peer-ready') {
    const room = rooms.get(ws.roomCode);
    if (!room) return;

    if (room.guest && room.guest.peerId === ws.peerId) {
      room.host.ws.sendJson({ type: 'peer-ready', peerId: ws.peerId, nickname: room.guest.nickname });
    }
    return;
  }

  // 5. offer / answer / ice-candidate
  if (type === 'offer' || type === 'answer' || type === 'ice-candidate') {
    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const isHost = room.host.peerId === ws.peerId;
    const dest = isHost ? room.guest : room.host;

    if (dest && dest.ws) {
      dest.ws.sendJson({ ...msg, from: ws.peerId });
    }
    return;
  }

  // 6. relay-report
  if (type === 'relay-report') {
    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const isHost = room.host.peerId === ws.peerId;
    const dest = isHost ? room.guest : room.host;
    if (dest && dest.ws) {
      dest.ws.sendJson(msg);
    }
    return;
  }

  // 7. leave-room
  if (type === 'leave-room') {
    handleWsClose(ws);
    return;
  }
}

function handleWsClose(ws) {
  if (!ws.roomCode) return;
  const room = rooms.get(ws.roomCode);
  if (!room) return;

  const isHost = room.host && room.host.peerId === ws.peerId;

  if (isHost) {
    console.log(`[Room ${room.code}] Chủ phòng thoát -> đóng phòng`);
    if (room.guest && room.guest.ws) {
      room.guest.ws.sendJson({ type: 'room-closed', reason: 'host-left' });
    }
    if (room.pending && room.pending.ws) {
      clearTimeout(room.pending.timer);
      room.pending.ws.sendJson({ type: 'join-rejected', reason: 'host-declined' });
    }
    rooms.delete(room.code);
  } else {
    if (room.guest && room.guest.peerId === ws.peerId) {
      console.log(`[Room ${room.code}] Khách thoát`);
      room.host.ws.sendJson({ type: 'peer-left', peerId: ws.peerId, nickname: room.guest.nickname });
      room.guest = null;
    } else if (room.pending && room.pending.peerId === ws.peerId) {
      clearTimeout(room.pending.timer);
      room.pending = null;
    }
  }

  ws.roomCode = null;
  ws.peerId = null;
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`=======================================================`);
  console.log(`🚀 Mock Signaling & Relay Server đang chạy tại:`);
  console.log(`👉 http://localhost:${PORT}`);
  console.log(`Mở trình duyệt ở 2 tab để thử nghiệm kết nối P2P!`);
  console.log(`=======================================================`);
});
