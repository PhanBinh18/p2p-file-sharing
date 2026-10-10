/**
 * Relay HTTP: Upload và Download file qua server (chế độ đối chứng P2P)
 * Stream thẳng xuống đĩa với Pipeline và Transform stream, không chiếm dụng RAM.
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { statsManager } from './stats.js';

export class RelayManager {
  constructor({ roomManager, relayDir, maxFileSize = 104857600, maxRelayStorage = 524288000, relayTtlMs = 600000 }) {
    this.roomManager = roomManager;
    this.relayDir = relayDir;
    this.maxFileSize = maxFileSize;
    this.maxRelayStorage = maxRelayStorage;
    this.relayTtlMs = relayTtlMs;

    this.files = new Map(); // fileId -> { fileId, roomCode, fileName, fileSize, sha256, filePath, createdAt }
    this.currentTotalStorage = 0;
    this.sweeperInterval = null;

    this._initDir();
    this._startSweeper();
  }

  /**
   * Khởi tạo và dọn sạch thư mục tạm khi server khởi động
   */
  _initDir() {
    try {
      if (fs.existsSync(this.relayDir)) {
        fs.rmSync(this.relayDir, { recursive: true, force: true });
      }
      fs.mkdirSync(this.relayDir, { recursive: true });
    } catch (err) {
      console.error('Lỗi khởi tạo thư mục relay:', err);
    }
  }

  /**
   * Bộ dọn dẹp (sweeper) định kỳ mỗi 60 giây xóa file quá hạn TTL
   */
  _startSweeper() {
    this.sweeperInterval = setInterval(() => {
      this.cleanupExpiredFiles();
    }, 60000);

    if (typeof this.sweeperInterval.unref === 'function') {
      this.sweeperInterval.unref();
    }
  }

  cleanupExpiredFiles() {
    const now = Date.now();
    for (const [fileId, fileInfo] of this.files.entries()) {
      if (now - fileInfo.createdAt > this.relayTtlMs) {
        this.deleteFile(fileId);
      }
    }
  }

  deleteFile(fileId) {
    const fileInfo = this.files.get(fileId);
    if (!fileInfo) return;

    this.files.delete(fileId);
    this.currentTotalStorage = Math.max(0, this.currentTotalStorage - fileInfo.fileSize);

    try {
      if (fs.existsSync(fileInfo.filePath)) {
        fs.unlinkSync(fileInfo.filePath);
      }
    } catch (e) {
      // bỏ qua lỗi file không tồn tại
    }
  }

  /**
   * Xóa toàn bộ file liên kết với một phòng khi phòng đóng
   */
  deleteFilesByRoom(roomCode) {
    const code = (roomCode || '').toUpperCase();
    for (const [fileId, fileInfo] of this.files.entries()) {
      if (fileInfo.roomCode === code) {
        this.deleteFile(fileId);
      }
    }
  }

  close() {
    if (this.sweeperInterval) {
      clearInterval(this.sweeperInterval);
      this.sweeperInterval = null;
    }
  }
}

/**
 * Tạo Router Express phục vụ các API Relay
 */
export function createRelayRouter(relayManager) {
  const router = express.Router();

  // POST /api/relay/:roomCode/upload
  router.post('/:roomCode/upload', async (req, res) => {
    const roomCode = (req.params.roomCode || '').toUpperCase();
    const peerId = req.headers['x-peer-id'];
    const fileNameHeader = req.headers['x-file-name'];
    const fileSha256 = req.headers['x-file-sha256'];
    const contentLength = parseInt(req.headers['content-length'], 10);

    // 1. Kiểm tra headers bắt buộc
    if (!peerId || !fileNameHeader || !fileSha256) {
      return res.status(400).json({ error: 'Thiếu header bắt buộc (X-Peer-Id, X-File-Name, X-File-Sha256)' });
    }

    // 2. Kiểm tra phòng tồn tại
    const room = relayManager.roomManager.get(roomCode);
    if (!room) {
      return res.status(404).json({ error: 'Không tìm thấy phòng' });
    }

    // 3. Kiểm tra peerId thuộc phòng
    const isHost = room.host && room.host.peerId === peerId;
    const isGuest = room.guest && room.guest.peerId === peerId;
    if (!isHost && !isGuest) {
      return res.status(403).json({ error: 'Bạn không thuộc phòng này' });
    }

    // 4. Từ chối sớm nếu Content-Length vượt giới hạn
    if (contentLength && contentLength > relayManager.maxFileSize) {
      return res.status(413).json({ error: 'File vượt quá kích thước tối đa cho phép (100 MB)' });
    }

    // 5. Kiểm tra tổng dung lượng relay của server
    if (relayManager.currentTotalStorage + (contentLength || 0) > relayManager.maxRelayStorage) {
      return res.status(507).json({ error: 'Server tạm thời hết dung lượng lưu trữ relay' });
    }

    const fileId = crypto.randomUUID();
    const filePath = path.join(relayManager.relayDir, `${fileId}.bin`);
    const fileName = decodeURIComponent(fileNameHeader).replace(/[\r\n"/\\]/g, '_');

    let writtenBytes = 0;
    const startTime = Date.now();
    let aborted = false;

    // Transform stream đếm byte và bảo vệ dung lượng trong khi stream
    const byteCounter = new Transform({
      transform(chunk, encoding, callback) {
        writtenBytes += chunk.length;
        if (writtenBytes > relayManager.maxFileSize) {
          const err = new Error('File vượt quá giới hạn dung lượng');
          err.code = 'LIMIT_EXCEEDED';
          return callback(err);
        }
        callback(null, chunk);
      }
    });

    const fileWriteStream = fs.createWriteStream(filePath);

    // Lắng nghe hủy kết nối giữa chừng từ client
    req.on('aborted', () => {
      aborted = true;
      fileWriteStream.destroy();
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (e) {}
    });

    try {
      await pipeline(req, byteCounter, fileWriteStream);
      const receivedMs = Date.now() - startTime;

      if (aborted) {
        return;
      }

      // Lưu thông tin file vào bộ nhớ
      const fileRecord = {
        fileId,
        roomCode,
        fileName,
        fileSize: writtenBytes,
        sha256: fileSha256,
        filePath,
        createdAt: Date.now()
      };

      relayManager.files.set(fileId, fileRecord);
      relayManager.currentTotalStorage += writtenBytes;

      // Cộng thống kê lưu lượng
      statsManager.addRelayUploadBytes(roomCode, writtenBytes);

      // Trả kết quả 201 cho bên upload
      res.status(201).json({
        fileId,
        size: writtenBytes,
        receivedMs
      });

      // Gửi relay-file-available cho bên còn lại trong phòng qua WebSocket
      const recipient = isHost ? room.guest : room.host;
      if (recipient && recipient.ws && recipient.ws.readyState === 1 /* OPEN */) {
        recipient.ws.send(JSON.stringify({
          type: 'relay-file-available',
          fileId,
          fileName,
          fileSize: writtenBytes,
          sha256: fileSha256,
          uploadMs: receivedMs
        }));
      }
    } catch (err) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (e) {}

      if (err.code === 'LIMIT_EXCEEDED') {
        return res.status(413).json({ error: 'File vượt quá kích thước tối đa cho phép' });
      }
      if (!res.headersSent) {
        res.status(500).json({ error: 'Lỗi ghi file relay' });
      }
    }
  });

  // GET /api/relay/:roomCode/:fileId?peerId=<id>
  router.get('/:roomCode/:fileId', (req, res) => {
    const roomCode = (req.params.roomCode || '').toUpperCase();
    const fileId = req.params.fileId;
    const peerId = req.query.peerId;

    // 1. Kiểm tra phòng tồn tại
    const room = relayManager.roomManager.get(roomCode);
    if (!room) {
      return res.status(404).json({ error: 'Không tìm thấy phòng' });
    }

    // 2. Kiểm tra peerId thuộc phòng
    const isHost = room.host && room.host.peerId === peerId;
    const isGuest = room.guest && room.guest.peerId === peerId;
    if (!isHost && !isGuest) {
      return res.status(403).json({ error: 'Bạn không có quyền tải file này' });
    }

    // 3. Tìm file
    const fileInfo = relayManager.files.get(fileId);
    if (!fileInfo || fileInfo.roomCode !== roomCode || !fs.existsSync(fileInfo.filePath)) {
      return res.status(404).json({ error: 'File không tồn tại hoặc đã hết hạn' });
    }

    // 4. Phục vụ file với Content-Length và Content-Disposition an toàn
    const sanitizedName = encodeURIComponent(fileInfo.fileName);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', fileInfo.fileSize);
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizedName}"; filename*=UTF-8''${sanitizedName}`);

    const readStream = fs.createReadStream(fileInfo.filePath);

    readStream.on('data', (chunk) => {
      statsManager.addRelayDownloadBytes(roomCode, chunk.length);
    });

    readStream.pipe(res);
  });

  return router;
}
