/**
 * Đọc và chuẩn hóa cấu hình từ biến môi trường
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

export const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '127.0.0.1',

  clientDir: process.env.CLIENT_DIR
    ? path.resolve(projectRoot, process.env.CLIENT_DIR)
    : path.resolve(projectRoot, '../client'),

  relayDir: process.env.RELAY_DIR
    ? path.resolve(projectRoot, process.env.RELAY_DIR)
    : path.resolve(projectRoot, './tmp/relay'),

  maxFileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 104857600, // 100 MB
  maxRelayStorage: parseInt(process.env.MAX_RELAY_STORAGE, 10) || 524288000, // 500 MB
  relayTtlMs: parseInt(process.env.RELAY_TTL_MS, 10) || 600000, // 10 phút
  joinTimeoutMs: parseInt(process.env.JOIN_TIMEOUT_MS, 10) || 60000, // 60 giây
  maxRooms: parseInt(process.env.MAX_ROOMS, 10) || 200,

  chunkSizeBytes: 16384,

  iceServers: process.env.ICE_SERVERS
    ? JSON.parse(process.env.ICE_SERVERS)
    : [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        {
          urls: [
            'turn:p2pfilesharing.duckdns.org:3478?transport=udp',
            'turn:p2pfilesharing.duckdns.org:3478?transport=tcp'
          ],
          username: 'p2puser',
          credential: 'p2ppassword2026'
        }
      ]
};
