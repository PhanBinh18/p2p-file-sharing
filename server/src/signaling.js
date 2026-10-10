/**
 * WebSocket Signaling Server: Xác thực hợp đồng, rate limit, heartbeat và chuyển tiếp tin nhắn WebRTC
 */

import { WebSocketServer, WebSocket } from 'ws';
import { statsManager } from './stats.js';

// Regex kiểm tra nickname: 1–20 ký tự, không chứa ký tự điều khiển (ASCII < 32 hoặc 127)
function isValidNickname(nickname) {
  if (typeof nickname !== 'string') return false;
  const trimmed = nickname.trim();
  if (trimmed.length < 1 || trimmed.length > 20) return false;
  // Không chứa ký tự điều khiển
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function isValidRoomCode(code) {
  return typeof code === 'string' && /^[A-HJ-NP-Z2-9]{6}$/i.test(code.trim());
}

export class SignalingServer {
  constructor({ roomManager, relayManager }) {
    this.roomManager = roomManager;
    this.relayManager = relayManager;

    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

    // Rate limiter: Map<ip, { creates: number[], joins: number[] }>
    this.rateLimits = new Map();

    // Map theo dõi thông tin socket: ws -> { peerId, roomCode, ip, isAlive }
    this.sockets = new Map();

    this.heartbeatInterval = null;
    this._initWss();
    this._startHeartbeat();
  }

  _initWss() {
    this.wss.on('connection', (ws, req) => {
      const forwarded = req.headers['x-forwarded-for'];
      const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) ||
        req.socket.remoteAddress || '127.0.0.1';

      this.sockets.set(ws, {
        peerId: null,
        roomCode: null,
        ip,
        isAlive: true
      });

      ws.on('pong', () => {
        const meta = this.sockets.get(ws);
        if (meta) meta.isAlive = true;
      });

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          this._sendError(ws, 'INVALID_MESSAGE', 'Chỉ chấp nhận tin nhắn văn bản JSON');
          return;
        }

        const rawStr = data.toString('utf8');
        const meta = this.sockets.get(ws);
        if (meta && meta.roomCode) {
          statsManager.addSignalingBytes(meta.roomCode, Buffer.byteLength(rawStr, 'utf8'));
        }

        let msg;
        try {
          msg = JSON.parse(rawStr);
        } catch (e) {
          this._sendError(ws, 'INVALID_MESSAGE', 'Tin nhắn không phải định dạng JSON hợp lệ');
          return;
        }

        if (!msg || typeof msg !== 'object' || !msg.type) {
          this._sendError(ws, 'INVALID_MESSAGE', 'Thiếu trường "type" trong tin nhắn');
          return;
        }

        this._handleMessage(ws, msg);
      });

      ws.on('close', () => {
        this._handleClose(ws);
      });

      ws.on('error', () => {
        this._handleClose(ws);
      });
    });
  }

  /**
   * Định kỳ 30 giây gửi Ping kiểm tra kết nối, ngắt socket nếu không phản hồi Pong
   */
  _startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      for (const [ws, meta] of this.sockets.entries()) {
        if (!meta.isAlive) {
          ws.terminate();
          continue;
        }
        meta.isAlive = false;
        try {
          ws.ping();
        } catch (e) {
          ws.terminate();
        }
      }
    }, 30000);

    if (typeof this.heartbeatInterval.unref === 'function') {
      this.heartbeatInterval.unref();
    }
  }

  /**
   * Kiểm tra giới hạn tần suất (Rate Limit) theo IP
   * Tối đa 10 create-room / phút, 20 join-room / phút
   */
  _checkRateLimit(ip, type) {
    const now = Date.now();
    const oneMinAgo = now - 60000;

    if (!this.rateLimits.has(ip)) {
      this.rateLimits.set(ip, { creates: [], joins: [] });
    }

    const record = this.rateLimits.get(ip);
    if (type === 'create-room') {
      record.creates = record.creates.filter(t => t > oneMinAgo);
      if (record.creates.length >= 10) return false;
      record.creates.push(now);
    } else if (type === 'join-room') {
      record.joins = record.joins.filter(t => t > oneMinAgo);
      if (record.joins.length >= 20) return false;
      record.joins.push(now);
    }
    return true;
  }

  _handleMessage(ws, msg) {
    const meta = this.sockets.get(ws);
    const { type } = msg;

    // 1. CREATE-ROOM
    if (type === 'create-room') {
      if (!this._checkRateLimit(meta.ip, 'create-room')) {
        return this._sendError(ws, 'RATE_LIMITED', 'Bạn đã tạo quá nhiều phòng. Vui lòng chờ 1 phút.');
      }

      if (!isValidNickname(msg.nickname)) {
        return this._sendError(ws, 'INVALID_NICKNAME', 'Biệt danh không hợp lệ (1–20 ký tự)');
      }

      try {
        const { roomCode, peerId } = this.roomManager.createRoom(msg.nickname.trim(), ws);
        meta.peerId = peerId;
        meta.roomCode = roomCode;

        this._send(ws, { type: 'room-created', roomCode, peerId });
        console.log(`[${new Date().toISOString()}] Phòng ${roomCode} được tạo bởi Host "${msg.nickname.trim()}" (${peerId})`);
      } catch (err) {
        this._sendError(ws, err.code || 'INVALID_STATE', err.message);
      }
      return;
    }

    // 2. JOIN-ROOM
    if (type === 'join-room') {
      if (!this._checkRateLimit(meta.ip, 'join-room')) {
        return this._sendError(ws, 'RATE_LIMITED', 'Thao tác tham gia quá nhanh. Vui lòng chờ 1 phút.');
      }

      if (!isValidNickname(msg.nickname)) {
        return this._sendError(ws, 'INVALID_NICKNAME', 'Biệt danh không hợp lệ (1–20 ký tự)');
      }

      if (!isValidRoomCode(msg.roomCode)) {
        return this._sendError(ws, 'ROOM_NOT_FOUND', 'Mã phòng không hợp lệ');
      }

      try {
        const { roomCode, peerId, host } = this.roomManager.joinRoom(
          msg.roomCode,
          msg.nickname.trim(),
          ws,
          // Callback khi hết thời gian 60s chờ duyệt
          (code, expiredPending) => {
            if (expiredPending && expiredPending.ws) {
              this._send(expiredPending.ws, { type: 'join-rejected', reason: 'timeout' });
            }
          }
        );

        meta.peerId = peerId;
        meta.roomCode = roomCode;

        // Báo khách đã gửi yêu cầu thành công
        this._send(ws, { type: 'join-pending', roomCode, peerId });

        // Báo chủ phòng có yêu cầu xin vào
        if (host && host.ws) {
          this._send(host.ws, { type: 'join-request', peerId, nickname: msg.nickname.trim() });
        }
        console.log(`[${new Date().toISOString()}] Khách "${msg.nickname.trim()}" xin vào phòng ${roomCode}`);
      } catch (err) {
        this._sendError(ws, err.code || 'INVALID_STATE', err.message);
      }
      return;
    }

    // 3. JOIN-DECISION (Chỉ chủ phòng)
    if (type === 'join-decision') {
      if (!meta.roomCode || !meta.peerId) {
        return this._sendError(ws, 'NOT_IN_ROOM', 'Bạn chưa tham gia phòng nào');
      }

      if (typeof msg.accept !== 'boolean') {
        return this._sendError(ws, 'INVALID_MESSAGE', 'Trường "accept" phải là kiểu boolean');
      }

      try {
        const res = this.roomManager.decideJoin(meta.roomCode, meta.peerId, msg.accept);
        if (res.accepted) {
          // Báo cho khách biết đã được chấp thuận
          this._send(res.guest.ws, { type: 'join-accepted', hostNickname: res.host.nickname });
          console.log(`[${new Date().toISOString()}] Chủ phòng ${meta.roomCode} chấp thuận khách "${res.guest.nickname}"`);
        } else {
          // Báo cho khách biết bị từ chối
          this._send(res.guest.ws, { type: 'join-rejected', reason: res.reason });
          console.log(`[${new Date().toISOString()}] Chủ phòng ${meta.roomCode} từ chối khách "${res.guest.nickname}"`);
        }
      } catch (err) {
        this._sendError(ws, err.code || 'INVALID_STATE', err.message);
      }
      return;
    }

    // 4. PEER-READY (Khách gửi báo đã sẵn sàng RTCPeerConnection)
    if (type === 'peer-ready') {
      const room = this.roomManager.get(meta.roomCode);
      if (!room || !meta.peerId) {
        return this._sendError(ws, 'NOT_IN_ROOM', 'Không ở trong phòng');
      }

      if (room.guest && room.guest.peerId === meta.peerId) {
        // Forward cho host kèm peerId và nickname
        if (room.host && room.host.ws) {
          this._send(room.host.ws, {
            type: 'peer-ready',
            peerId: meta.peerId,
            nickname: room.guest.nickname
          });
        }
      }
      return;
    }

    // 5. OFFER (Chỉ chủ phòng gửi)
    if (type === 'offer') {
      const room = this.roomManager.get(meta.roomCode);
      if (!room || !meta.peerId) {
        return this._sendError(ws, 'NOT_IN_ROOM', 'Không ở trong phòng');
      }

      if (this.roomManager.getState(room) !== 'full') {
        return this._sendError(ws, 'INVALID_STATE', 'Phòng chưa đủ 2 người để trao đổi SDP');
      }

      if (room.host.peerId !== meta.peerId) {
        return this._sendError(ws, 'NOT_HOST', 'Chỉ chủ phòng mới được phép gửi Offer');
      }

      if (typeof msg.sdp !== 'string') {
        return this._sendError(ws, 'INVALID_MESSAGE', 'SDP không hợp lệ');
      }

      // Forward nguyên vẹn tới khách + thêm from
      if (room.guest && room.guest.ws) {
        this._send(room.guest.ws, {
          type: 'offer',
          sdp: msg.sdp,
          from: meta.peerId
        });
        console.log(`[${new Date().toISOString()}] Chuyển tiếp Offer SDP (phòng ${meta.roomCode})`);
      }
      return;
    }

    // 6. ANSWER (Chỉ khách gửi)
    if (type === 'answer') {
      const room = this.roomManager.get(meta.roomCode);
      if (!room || !meta.peerId) {
        return this._sendError(ws, 'NOT_IN_ROOM', 'Không ở trong phòng');
      }

      if (this.roomManager.getState(room) !== 'full') {
        return this._sendError(ws, 'INVALID_STATE', 'Phòng chưa đủ 2 người để trao đổi SDP');
      }

      if (room.guest?.peerId !== meta.peerId) {
        return this._sendError(ws, 'INVALID_STATE', 'Chỉ khách mới được phép gửi Answer');
      }

      if (typeof msg.sdp !== 'string') {
        return this._sendError(ws, 'INVALID_MESSAGE', 'SDP không hợp lệ');
      }

      // Forward nguyên vẹn tới host + thêm from
      if (room.host && room.host.ws) {
        this._send(room.host.ws, {
          type: 'answer',
          sdp: msg.sdp,
          from: meta.peerId
        });
        console.log(`[${new Date().toISOString()}] Chuyển tiếp Answer SDP (phòng ${meta.roomCode})`);
      }
      return;
    }

    // 7. ICE-CANDIDATE (Cả hai bên)
    if (type === 'ice-candidate') {
      const room = this.roomManager.get(meta.roomCode);
      if (!room || !meta.peerId) {
        return this._sendError(ws, 'NOT_IN_ROOM', 'Không ở trong phòng');
      }

      if (this.roomManager.getState(room) !== 'full') {
        return this._sendError(ws, 'INVALID_STATE', 'Phòng chưa đủ 2 người');
      }

      const isHost = room.host.peerId === meta.peerId;
      const recipient = isHost ? room.guest : room.host;

      if (recipient && recipient.ws) {
        this._send(recipient.ws, {
          type: 'ice-candidate',
          candidate: msg.candidate,
          from: meta.peerId
        });
      }
      return;
    }

    // 8. RELAY-REPORT (Bên nhận gửi báo cáo download về cho bên upload)
    if (type === 'relay-report') {
      const room = this.roomManager.get(meta.roomCode);
      if (!room || !meta.peerId) return;

      const isHost = room.host && room.host.peerId === meta.peerId;
      const recipient = isHost ? room.guest : room.host;

      if (recipient && recipient.ws) {
        this._send(recipient.ws, {
          type: 'relay-report',
          fileId: msg.fileId,
          downloadMs: msg.downloadMs,
          ok: msg.ok
        });
      }
      return;
    }

    // 9. LEAVE-ROOM
    if (type === 'leave-room') {
      this._handleClose(ws);
      return;
    }

    this._sendError(ws, 'INVALID_MESSAGE', `Loại tin nhắn không được hỗ trợ: ${type}`);
  }

  _handleClose(ws) {
    const meta = this.sockets.get(ws);
    if (!meta || !meta.roomCode || !meta.peerId) {
      this.sockets.delete(ws);
      return;
    }

    const { roomCode, peerId } = meta;
    const leaveResult = this.roomManager.leaveRoom(roomCode, peerId);

    if (leaveResult) {
      if (leaveResult.role === 'host') {
        console.log(`[${new Date().toISOString()}] Chủ phòng thoát -> đóng phòng ${roomCode}`);
        // Xóa file relay của phòng
        if (this.relayManager) {
          this.relayManager.deleteFilesByRoom(roomCode);
        }

        if (leaveResult.guest && leaveResult.guest.ws) {
          this._send(leaveResult.guest.ws, { type: 'room-closed', reason: 'host-left' });
        }
        if (leaveResult.pending && leaveResult.pending.ws) {
          this._send(leaveResult.pending.ws, { type: 'join-rejected', reason: 'host-declined' });
        }
      } else if (leaveResult.role === 'guest') {
        console.log(`[${new Date().toISOString()}] Khách "${leaveResult.guest?.nickname}" rời phòng ${roomCode}`);
        if (leaveResult.host && leaveResult.host.ws) {
          this._send(leaveResult.host.ws, {
            type: 'peer-left',
            peerId,
            nickname: leaveResult.guest?.nickname
          });
        }
      } else if (leaveResult.role === 'pending') {
        console.log(`[${new Date().toISOString()}] Khách chờ "${leaveResult.pending?.nickname}" hủy yêu cầu phòng ${roomCode}`);
      }
    }

    meta.roomCode = null;
    meta.peerId = null;
    this.sockets.delete(ws);
  }

  _send(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const jsonStr = JSON.stringify(payload);
      ws.send(jsonStr);

      const meta = this.sockets.get(ws);
      if (meta && meta.roomCode) {
        statsManager.addSignalingBytes(meta.roomCode, Buffer.byteLength(jsonStr, 'utf8'));
      }
    }
  }

  _sendError(ws, code, message) {
    this._send(ws, { type: 'error', code, message });
  }

  /**
   * Xử lý HTTP upgrade tới WebSocket /ws
   */
  handleUpgrade(req, socket, head) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    if (urlObj.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  close() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.wss.close();
  }
}
