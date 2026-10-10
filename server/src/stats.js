/**
 * Bộ đếm byte và thống kê lưu lượng theo từng phòng
 */

class StatsManager {
  constructor() {
    this.roomStats = new Map();
  }

  get(roomCode) {
    const code = (roomCode || '').toUpperCase();
    if (!this.roomStats.has(code)) {
      this.roomStats.set(code, {
        signalingBytes: 0,
        relayUploadBytes: 0,
        relayDownloadBytes: 0
      });
    }
    return this.roomStats.get(code);
  }

  addSignalingBytes(roomCode, bytes) {
    if (!roomCode || !bytes) return;
    const s = this.get(roomCode);
    s.signalingBytes += bytes;
  }

  addRelayUploadBytes(roomCode, bytes) {
    if (!roomCode || !bytes) return;
    const s = this.get(roomCode);
    s.relayUploadBytes += bytes;
  }

  addRelayDownloadBytes(roomCode, bytes) {
    if (!roomCode || !bytes) return;
    const s = this.get(roomCode);
    s.relayDownloadBytes += bytes;
  }

  remove(roomCode) {
    if (!roomCode) return;
    this.roomStats.delete(roomCode.toUpperCase());
  }

  clear() {
    this.roomStats.clear();
  }
}

export const statsManager = new StatsManager();
