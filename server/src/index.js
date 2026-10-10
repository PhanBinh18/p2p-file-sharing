/**
 * Server khởi động chính: Tích hợp Express tĩnh, Relay HTTP và WebSocket Signaling
 */

import http from 'node:http';
import express from 'express';
import { config } from './config.js';
import { RoomManager } from './rooms.js';
import { RelayManager, createRelayRouter } from './relay.js';
import { SignalingServer } from './signaling.js';
import { statsManager } from './stats.js';

const app = express();

// Khởi tạo các thành phần quản lý
const roomManager = new RoomManager({
  maxRooms: config.maxRooms,
  joinTimeoutMs: config.joinTimeoutMs,
  onRoomClosed: (roomCode) => {
    relayManager.deleteFilesByRoom(roomCode);
    statsManager.remove(roomCode);
  }
});

const relayManager = new RelayManager({
  roomManager,
  relayDir: config.relayDir,
  maxFileSize: config.maxFileSize,
  maxRelayStorage: config.maxRelayStorage,
  relayTtlMs: config.relayTtlMs
});

const signalingServer = new SignalingServer({
  roomManager,
  relayManager
});

// 1. Phục vụ Web tĩnh từ clientDir
app.use(express.static(config.clientDir));

// 2. GET /healthz
app.get('/healthz', (req, res) => {
  res.status(200).send('ok');
});

// 3. GET /api/config
app.get('/api/config', (req, res) => {
  res.json({
    iceServers: config.iceServers,
    maxFileSizeBytes: config.maxFileSize,
    chunkSizeBytes: config.chunkSizeBytes
  });
});

// 4. GET /api/stats/:roomCode
app.get('/api/stats/:roomCode', (req, res) => {
  const roomCode = req.params.roomCode;
  const stats = statsManager.get(roomCode);
  res.json(stats);
});

// 5. Gắn route Relay HTTP (upload / download)
app.use('/api/relay', createRelayRouter(relayManager));

// Tạo HTTP Server
const server = http.createServer(app);

// Quan trọng theo mục S4: Tắt timeout upload để việc truyền file lớn hoặc mạng chậm không bị cắt
server.requestTimeout = 0; // Không giới hạn timeout cho request upload stream
server.headersTimeout = 65000;
server.keepAliveTimeout = 60000;

// Gắn WebSocket upgrade ở path /ws
server.on('upgrade', (req, socket, head) => {
  signalingServer.handleUpgrade(req, socket, head);
});

// Khởi chạy server
server.listen(config.port, config.host, () => {
  console.log('====================================================');
  console.log(`⚡ P2P File Sharing Server đã sẵn sàng!`);
  console.log(`🌐 Web Client: http://${config.host}:${config.port}`);
  console.log(`🔌 WebSocket:  ws://${config.host}:${config.port}/ws`);
  console.log(`📁 Client Dir: ${config.clientDir}`);
  console.log(`📦 Relay Dir:  ${config.relayDir}`);
  console.log('====================================================');
});

// Xử lý Graceful shutdown
const shutdown = () => {
  console.log('\nĐang dừng server an toàn...');
  signalingServer.close();
  relayManager.close();
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app, server, roomManager, relayManager, signalingServer };
