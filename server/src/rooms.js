/**
 * RoomManager: Quản lý trạng thái và vòng đời các phòng kết nối (Logic thuần)
 */

import crypto from 'node:crypto';

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class RoomManager {
  constructor({ maxRooms = 200, joinTimeoutMs = 60000, onRoomClosed = null } = {}) {
    this.maxRooms = maxRooms;
    this.joinTimeoutMs = joinTimeoutMs;
    this.onRoomClosed = onRoomClosed;
    this.rooms = new Map(); // roomCode -> room object
  }

  /**
   * Sinh mã phòng 6 ký tự ngẫu nhiên an toàn bằng crypto.randomInt
   */
  generateCode() {
    let code = '';
    for (let i = 0; i < 6; i++) {
      const idx = crypto.randomInt(0, ROOM_CODE_CHARS.length);
      code += ROOM_CODE_CHARS[idx];
    }
    return code;
  }

  /**
   * Xác định trạng thái phòng: 'open' | 'pending' | 'full'
   */
  getState(room) {
    if (!room) return null;
    if (room.guest) return 'full';
    if (room.pending) return 'pending';
    return 'open';
  }

  /**
   * Tạo phòng mới cho Chủ phòng (Host)
   */
  createRoom(nickname, ws = null) {
    if (this.rooms.size >= this.maxRooms) {
      const err = new Error('Đã đạt số lượng phòng tối đa');
      err.code = 'RATE_LIMITED';
      throw err;
    }

    let code;
    let attempts = 0;
    do {
      code = this.generateCode();
      attempts++;
      if (attempts > 100) {
        throw new Error('Không thể sinh mã phòng duy nhất');
      }
    } while (this.rooms.has(code));

    const peerId = crypto.randomUUID();
    const room = {
      code,
      host: { peerId, nickname, ws },
      guest: null,
      pending: null,
      createdAt: Date.now(),
      files: new Map() // fileId -> metadata
    };

    this.rooms.set(code, room);
    return { roomCode: code, peerId, room };
  }

  /**
   * Khách yêu cầu tham gia phòng
   */
  joinRoom(roomCode, nickname, ws = null, onTimeout = null) {
    const code = (roomCode || '').trim().toUpperCase();
    const room = this.rooms.get(code);

    if (!room) {
      const err = new Error('Không tìm thấy phòng');
      err.code = 'ROOM_NOT_FOUND';
      throw err;
    }

    const state = this.getState(room);
    if (state !== 'open') {
      const err = new Error('Phòng đã đủ người hoặc đang có người chờ duyệt');
      err.code = 'ROOM_FULL';
      throw err;
    }

    const peerId = crypto.randomUUID();

    // Thiết lập bộ đếm thời gian chờ chủ phòng duyệt
    const timer = setTimeout(() => {
      if (room.pending && room.pending.peerId === peerId) {
        const expiredPending = room.pending;
        room.pending = null;
        if (onTimeout) {
          onTimeout(code, expiredPending);
        }
      }
    }, this.joinTimeoutMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    room.pending = { peerId, nickname, ws, timer };

    return {
      roomCode: code,
      peerId,
      room,
      host: room.host
    };
  }

  /**
   * Chủ phòng xét duyệt yêu cầu (accept: true / false)
   */
  decideJoin(roomCode, hostPeerId, accept) {
    const code = (roomCode || '').trim().toUpperCase();
    const room = this.rooms.get(code);

    if (!room) {
      const err = new Error('Không tìm thấy phòng');
      err.code = 'ROOM_NOT_FOUND';
      throw err;
    }

    if (!room.host || room.host.peerId !== hostPeerId) {
      const err = new Error('Chỉ chủ phòng mới có quyền duyệt');
      err.code = 'NOT_HOST';
      throw err;
    }

    const pending = room.pending;
    if (!pending) {
      const err = new Error('Không có yêu cầu chờ duyệt');
      err.code = 'INVALID_STATE';
      throw err;
    }

    clearTimeout(pending.timer);
    pending.timer = null;
    room.pending = null;

    if (accept) {
      room.guest = pending;
      return {
        accepted: true,
        room,
        guest: pending,
        host: room.host
      };
    } else {
      return {
        accepted: false,
        room,
        guest: pending,
        reason: 'host-declined'
      };
    }
  }

  /**
   * Tìm phòng theo mã phòng
   */
  get(roomCode) {
    if (!roomCode) return null;
    return this.rooms.get(roomCode.trim().toUpperCase()) || null;
  }

  /**
   * Xử lý khi một peer rời phòng hoặc ngắt kết nối
   */
  leaveRoom(roomCode, peerId) {
    const code = (roomCode || '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) return null;

    // 1. Nếu Chủ phòng rời đi -> Đóng phòng hoàn toàn
    if (room.host && room.host.peerId === peerId) {
      if (room.pending && room.pending.timer) {
        clearTimeout(room.pending.timer);
        room.pending.timer = null;
      }

      const guest = room.guest;
      const pending = room.pending;
      this.rooms.delete(code);

      if (this.onRoomClosed) {
        this.onRoomClosed(code);
      }

      return {
        role: 'host',
        roomCode: code,
        guest,
        pending
      };
    }

    // 2. Nếu Khách chính thức (Guest) rời đi -> Phòng trở lại trạng thái 'open'
    if (room.guest && room.guest.peerId === peerId) {
      const leavingGuest = room.guest;
      room.guest = null;
      return {
        role: 'guest',
        roomCode: code,
        guest: leavingGuest,
        host: room.host
      };
    }

    // 3. Nếu Khách đang chờ (Pending) hủy yêu cầu
    if (room.pending && room.pending.peerId === peerId) {
      clearTimeout(room.pending.timer);
      room.pending.timer = null;
      const leavingPending = room.pending;
      room.pending = null;
      return {
        role: 'pending',
        roomCode: code,
        pending: leavingPending,
        host: room.host
      };
    }

    return null;
  }

  /**
   * Xóa toàn bộ phòng
   */
  clear() {
    for (const [code, room] of this.rooms.entries()) {
      if (room.pending && room.pending.timer) {
        clearTimeout(room.pending.timer);
      }
      if (this.onRoomClosed) {
        this.onRoomClosed(code);
      }
    }
    this.rooms.clear();
  }
}
