/**
 * Module thực thi kiểm thử và so sánh hiệu năng truyền file: P2P WebRTC vs Server Relay
 */

import { formatBytes, formatDuration, formatSpeed } from './util.js';

export class BenchmarkRunner {
  constructor({ p2pTransfer, relayTransfer, getRoomCode, getConnectionSetupTime, onLog, onUpdateProgress, onBenchmarkComplete }) {
    this.p2pTransfer = p2pTransfer;
    this.relayTransfer = relayTransfer;
    this.getRoomCode = getRoomCode;
    this.getConnectionSetupTime = getConnectionSetupTime;
    this.onLog = onLog;
    this.onUpdateProgress = onUpdateProgress;
    this.onBenchmarkComplete = onBenchmarkComplete;

    this.isRunning = false;
  }

  /**
   * Tính trung vị (median) của mảng số
   */
  static median(arr) {
    if (!arr || arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 !== 0) {
      return sorted[mid];
    }
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * Lấy thống kê băng thông từ Server GET /api/stats/:roomCode
   */
  async fetchServerStats() {
    const roomCode = this.getRoomCode();
    if (!roomCode) return null;
    try {
      const res = await fetch(`/api/stats/${encodeURIComponent(roomCode)}`);
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      // bỏ qua nếu server chưa có route stats
    }
    return null;
  }

  /**
   * Chạy kiểm thử so sánh
   * @param {File} file File để test
   * @param {string} precomputedSha256 Mã băm đã tính sẵn
   * @param {number} iterations Số lượt lặp (1 - 5)
   */
  async run({ file, precomputedSha256, iterations = 1 }) {
    if (this.isRunning) {
      throw new Error('Tiến trình so sánh đang chạy');
    }

    this.isRunning = true;

    if (this.onLog) {
      this.onLog('BENCH', `Bắt đầu benchmark: file "${file.name}" (${formatBytes(file.size)}), số lần lặp: ${iterations}`);
    }

    const p2pRuns = [];
    const relayRuns = [];

    try {
      for (let i = 1; i <= iterations; i++) {
        if (!this.isRunning) break;

        // --- Giai đoạn 1: Đo P2P ---
        if (this.onUpdateProgress) {
          this.onUpdateProgress({
            phase: 'p2p',
            iteration: i,
            totalIterations: iterations,
            label: `Lượt ${i}/${iterations}: Đang truyền P2P (WebRTC DataChannel)...`
          });
        }
        if (this.onLog) {
          this.onLog('BENCH', `[Lượt ${i}/${iterations}] Đo P2P...`);
        }

        const p2pRes = await this.p2pTransfer.sendFile(file, precomputedSha256);
        const p2pTimeMs = p2pRes.recvMs || p2pRes.sendMs;
        p2pRuns.push({
          iteration: i,
          timeMs: p2pTimeMs,
          speedBytesPerSec: (file.size / (p2pTimeMs / 1000)),
          ok: p2pRes.ok
        });

        // Tạm nghỉ 500ms giữa các giai đoạn để giải phóng tài nguyên mạng
        await new Promise(r => setTimeout(r, 500));
        if (!this.isRunning) break;

        // --- Giai đoạn 2: Đo Relay Server ---
        if (this.onUpdateProgress) {
          this.onUpdateProgress({
            phase: 'relay',
            iteration: i,
            totalIterations: iterations,
            label: `Lượt ${i}/${iterations}: Đang truyền qua Server Relay (Upload + Download)...`
          });
        }
        if (this.onLog) {
          this.onLog('BENCH', `[Lượt ${i}/${iterations}] Đo Server Relay...`);
        }

        const relayRes = await this.relayTransfer.uploadFile(file, precomputedSha256);
        const relayTimeMs = relayRes.totalMs || (relayRes.uploadMs + (relayRes.downloadMs || 0));
        relayRuns.push({
          iteration: i,
          uploadMs: relayRes.uploadMs,
          downloadMs: relayRes.downloadMs,
          timeMs: relayTimeMs,
          speedBytesPerSec: (file.size / (relayTimeMs / 1000)),
          ok: relayRes.ok
        });

        await new Promise(r => setTimeout(r, 500));
      }

      // Lấy số liệu stats từ server sau khi kết thúc
      const serverStats = await this.fetchServerStats();

      // Tính toán giá trị trung vị
      const p2pMedianMs = BenchmarkRunner.median(p2pRuns.map(r => r.timeMs));
      const relayMedianMs = BenchmarkRunner.median(relayRuns.map(r => r.timeMs));

      const p2pMedianSpeed = p2pMedianMs > 0 ? (file.size / (p2pMedianMs / 1000)) : 0;
      const relayMedianSpeed = relayMedianMs > 0 ? (file.size / (relayMedianMs / 1000)) : 0;

      // Tính hệ số nhanh hơn (Speedup factor)
      let speedupRatio = 1;
      let winner = 'p2p';
      if (relayMedianMs > 0 && p2pMedianMs > 0) {
        if (p2pMedianMs <= relayMedianMs) {
          speedupRatio = (relayMedianMs / p2pMedianMs);
          winner = 'p2p';
        } else {
          speedupRatio = (p2pMedianMs / relayMedianMs);
          winner = 'relay';
        }
      }

      const p2pSetupTimeMs = this.getConnectionSetupTime ? this.getConnectionSetupTime() : null;

      const summary = {
        fileName: file.name,
        fileSize: file.size,
        fileSizeFormatted: formatBytes(file.size),
        iterations,
        p2p: {
          medianMs: p2pMedianMs,
          medianSpeedBytesPerSec: p2pMedianSpeed,
          medianSpeedFormatted: formatSpeed(p2pMedianSpeed),
          durationFormatted: formatDuration(p2pMedianMs),
          runs: p2pRuns
        },
        relay: {
          medianMs: relayMedianMs,
          medianSpeedBytesPerSec: relayMedianSpeed,
          medianSpeedFormatted: formatSpeed(relayMedianSpeed),
          durationFormatted: formatDuration(relayMedianMs),
          runs: relayRuns
        },
        p2pSetupTimeMs,
        speedupRatio: parseFloat(speedupRatio.toFixed(2)),
        winner,
        serverStats
      };

      if (this.onLog) {
        this.onLog('BENCH', `Hoàn tất Benchmark! P2P: ${formatDuration(p2pMedianMs)}, Server: ${formatDuration(relayMedianMs)}. ${winner === 'p2p' ? `P2P nhanh gấp ${summary.speedupRatio} lần` : `Server nhanh gấp ${summary.speedupRatio} lần`}`);
      }

      if (this.onBenchmarkComplete) {
        this.onBenchmarkComplete(summary);
      }

      return summary;
    } finally {
      this.isRunning = false;
    }
  }

  cancel() {
    this.isRunning = false;
    this.p2pTransfer.cancelCurrent();
    this.relayTransfer.cancel();
  }
}
