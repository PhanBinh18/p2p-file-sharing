/**
 * Quản lý gửi và nhận file P2P qua WebRTC DataChannel (kênh ordered + reliable)
 */

import { sha256, hashFile } from './hash.js';
import { uuidv4, now } from './util.js';

// Các hằng số theo quy ước ở mục 5 và mục 6 của plan_client.md
export const CHUNK_SIZE = 16384;             // 16 KiB
export const READ_BLOCK_SIZE = 1024 * 1024;  // 1 MiB khối đọc file
export const HIGH_WATER = 1024 * 1024;       // 1 MiB ngưỡng đệm tối đa
export const LOW_WATER = 256 * 1024;         // 256 KiB ngưỡng đệm hồi phục
export const MAX_FILE_SIZE = 104857600;      // 100 MiB giới hạn tối đa

export class P2PFileTransfer {
  constructor({ dc, onLog, onProgress, onComplete, onError, onRequestAccept }) {
    this.dc = dc;
    this.onLog = onLog;
    this.onProgress = onProgress;
    this.onComplete = onComplete;
    this.onError = onError;
    this.onRequestAccept = onRequestAccept;

    this.autoAccept = false;
    this.isTransferring = false;
    this.currentTransferRole = null; // 'sender' | 'receiver'

    // Trạng thái bên gửi
    this.currentSendSession = null;

    // Trạng thái bên nhận
    this.currentReceiveSession = null;

    this._bindDataChannel(dc);
  }

  /**
   * Cập nhật DataChannel mới khi kết nối lại
   */
  updateDataChannel(dc) {
    this.dc = dc;
    this._bindDataChannel(dc);
  }

  setAutoAccept(val) {
    this.autoAccept = !!val;
  }

  _bindDataChannel(dc) {
    if (!dc) return;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER;

    dc.onmessage = (event) => {
      if (typeof event.data === 'string') {
        this._handleTextMessage(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        this._handleBinaryChunk(event.data);
      }
    };
  }

  /**
   * Xử lý thông điệp văn bản JSON
   */
  _handleTextMessage(jsonStr) {
    let msg;
    try {
      msg = JSON.parse(jsonStr);
    } catch (e) {
      return;
    }

    if (!msg || !msg.t) return;

    if (this.onLog) {
      this.onLog('XFER', `Nhận message DataChannel: ${msg.t}`, msg);
    }

    switch (msg.t) {
      case 'file-meta':
        this._onReceiveFileMeta(msg);
        break;

      case 'file-accept':
        if (this.currentSendSession && this.currentSendSession.id === msg.id) {
          this.currentSendSession.onAccepted();
        }
        break;

      case 'file-reject':
        if (this.currentSendSession && this.currentSendSession.id === msg.id) {
          this.currentSendSession.onRejected(msg.reason || 'Bên nhận đã từ chối nhận file.');
        }
        break;

      case 'file-end':
        this._onReceiveFileEnd(msg.id);
        break;

      case 'file-result':
        if (this.currentSendSession && this.currentSendSession.id === msg.id) {
          this.currentSendSession.onResult(msg);
        }
        break;

      case 'file-cancel':
        this._onReceiveFileCancel(msg.id);
        break;
    }
  }

  /**
   * Gửi file qua P2P
   * @param {File} file
   * @param {string} precomputedSha256
   * @returns {Promise<object>} Kết quả { ok, recvMs, sendMs, speedMBps, sha256 }
   */
  async sendFile(file, precomputedSha256 = null) {
    if (!this.dc || this.dc.readyState !== 'open') {
      throw new Error('Kênh DataChannel chưa mở hoặc đã bị đóng');
    }

    if (this.isTransferring) {
      throw new Error('Đang có một tiến trình truyền file khác. Vui lòng chờ hoặc hủy.');
    }

    if (!file || file.size === 0) {
      throw new Error('File rỗng (0 bytes). Không thể gửi file rỗng.');
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new Error(`File vượt quá dung lượng tối đa cho phép (${MAX_FILE_SIZE / (1024 * 1024)} MB).`);
    }

    this.isTransferring = true;
    this.currentTransferRole = 'sender';

    const fileId = uuidv4();
    const sha256Hash = precomputedSha256 || (await hashFile(file));
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    const meta = {
      t: 'file-meta',
      id: fileId,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      chunkSize: CHUNK_SIZE,
      totalChunks,
      sha256: sha256Hash
    };

    if (this.onLog) {
      this.onLog('XFER', `Gửi file-meta cho file "${file.name}" (${file.size} bytes, ${totalChunks} chunks)`);
    }

    return new Promise((resolve, reject) => {
      let isCancelled = false;
      let sendStartTime = null;

      this.currentSendSession = {
        id: fileId,
        file,
        meta,
        cancel: () => {
          isCancelled = true;
          try {
            this.dc.send(JSON.stringify({ t: 'file-cancel', id: fileId }));
          } catch (e) {}
          this._cleanUp();
          reject(new Error('Đã hủy gửi file'));
        },
        onAccepted: async () => {
          if (isCancelled) return;
          if (this.onLog) this.onLog('XFER', `Bên nhận đã đồng ý. Bắt đầu truyền dữ liệu...`);

          try {
            sendStartTime = now();
            let sentBytes = 0;
            let lastUiUpdate = 0;

            const fileSize = file.size;
            let offset = 0;

            // Đọc file theo từng khối READ_BLOCK_SIZE (1 MB)
            while (offset < fileSize) {
              if (isCancelled || !this.dc || this.dc.readyState !== 'open') {
                throw new Error('Kết nối bị gián đoạn khi đang gửi');
              }

              const blockEnd = Math.min(offset + READ_BLOCK_SIZE, fileSize);
              const blockBlob = file.slice(offset, blockEnd);
              const blockBuffer = await blockBlob.arrayBuffer();

              let blockOffset = 0;
              while (blockOffset < blockBuffer.byteLength) {
                if (isCancelled || !this.dc || this.dc.readyState !== 'open') {
                  throw new Error('Kết nối bị gián đoạn khi đang gửi');
                }

                // Kiểm tra backpressure: nếu bufferedAmount > HIGH_WATER thì đợi bufferedamountlow
                if (this.dc.bufferedAmount > HIGH_WATER) {
                  await this._waitForBufferLow();
                }

                const chunkEnd = Math.min(blockOffset + CHUNK_SIZE, blockBuffer.byteLength);
                const chunk = blockBuffer.slice(blockOffset, chunkEnd);

                this.dc.send(chunk);
                sentBytes += chunk.byteLength;
                blockOffset = chunkEnd;

                // Throttling cập nhật UI (~10 lần/s)
                const currentTime = now();
                if (currentTime - lastUiUpdate > 100 || sentBytes === fileSize) {
                  lastUiUpdate = currentTime;
                  const elapsedSec = (currentTime - sendStartTime) / 1000;
                  const speed = elapsedSec > 0 ? sentBytes / elapsedSec : 0;
                  if (this.onProgress) {
                    this.onProgress({
                      role: 'sender',
                      fileId,
                      fileName: file.name,
                      sentBytes,
                      totalBytes: fileSize,
                      percentage: Math.round((sentBytes / fileSize) * 100),
                      speedBytesPerSec: speed
                    });
                  }
                }
              }

              offset = blockEnd;
            }

            // Gửi file-end sau khi đã gửi chunk cuối cùng
            if (this.onLog) this.onLog('XFER', `Đã gửi hết bytes, gửi file-end (chờ xác nhận băm từ bên nhận)`);
            this.dc.send(JSON.stringify({ t: 'file-end', id: fileId }));
          } catch (err) {
            this._cleanUp();
            reject(err);
          }
        },
        onRejected: (reason) => {
          this._cleanUp();
          reject(new Error(`Bên nhận đã từ chối: ${reason}`));
        },
        onResult: (resultMsg) => {
          const totalSendMs = now() - sendStartTime;
          this._cleanUp();

          const finalRes = {
            id: fileId,
            ok: resultMsg.ok,
            recvMs: resultMsg.recvMs,
            sendMs: totalSendMs,
            sha256Expected: sha256Hash,
            sha256Received: resultMsg.sha256Received,
            fileSize: file.size,
            fileName: file.name
          };

          if (this.onComplete) {
            this.onComplete({ role: 'sender', ...finalRes });
          }
          resolve(finalRes);
        }
      };

      // Gửi file-meta
      this.dc.send(JSON.stringify(meta));
    });
  }

  /**
   * Đợi sự kiện bufferedamountlow trên DataChannel
   */
  _waitForBufferLow() {
    return new Promise((resolve) => {
      const onLow = () => {
        this.dc.removeEventListener('bufferedamountlow', onLow);
        resolve();
      };
      this.dc.addEventListener('bufferedamountlow', onLow);
    });
  }

  /**
   * Xử lý khi nhận file-meta từ đối tác
   */
  async _onReceiveFileMeta(meta) {
    if (this.isTransferring) {
      this.dc.send(JSON.stringify({
        t: 'file-reject',
        id: meta.id,
        reason: 'Đang bận nhận hoặc gửi một file khác'
      }));
      return;
    }

    this.isTransferring = true;
    this.currentTransferRole = 'receiver';

    this.currentReceiveSession = {
      meta,
      chunks: [],
      receivedBytes: 0,
      startTime: null,
      lastUiUpdate: 0
    };

    // Nếu bật tự động nhận (chế độ so sánh tốc độ)
    if (this.autoAccept) {
      if (this.onLog) this.onLog('XFER', `[Tự động nhận] Chấp nhận nhận file "${meta.name}"`);
      this.dc.send(JSON.stringify({ t: 'file-accept', id: meta.id }));
      return;
    }

    // Hiển thị modal hỏi ý kiến người dùng
    if (this.onRequestAccept) {
      this.onRequestAccept({
        meta,
        accept: () => {
          if (this.currentReceiveSession && this.currentReceiveSession.meta.id === meta.id) {
            this.dc.send(JSON.stringify({ t: 'file-accept', id: meta.id }));
          }
        },
        reject: (reason = 'Người nhận từ chối yêu cầu') => {
          this.dc.send(JSON.stringify({ t: 'file-reject', id: meta.id, reason }));
          this._cleanUp();
        }
      });
    } else {
      // Mặc định chấp nhận nếu không có UI hook
      this.dc.send(JSON.stringify({ t: 'file-accept', id: meta.id }));
    }
  }

  /**
   * Xử lý từng chunk nhị phân nhận được
   */
  _handleBinaryChunk(chunk) {
    const session = this.currentReceiveSession;
    if (!session) return;

    if (!session.startTime) {
      session.startTime = now();
    }

    session.chunks.push(chunk);
    session.receivedBytes += chunk.byteLength;

    const currentTime = now();
    if (currentTime - session.lastUiUpdate > 100 || session.receivedBytes === session.meta.size) {
      session.lastUiUpdate = currentTime;
      const elapsedSec = (currentTime - session.startTime) / 1000;
      const speed = elapsedSec > 0 ? session.receivedBytes / elapsedSec : 0;

      if (this.onProgress) {
        this.onProgress({
          role: 'receiver',
          fileId: session.meta.id,
          fileName: session.meta.name,
          receivedBytes: session.receivedBytes,
          totalBytes: session.meta.size,
          percentage: Math.round((session.receivedBytes / session.meta.size) * 100),
          speedBytesPerSec: speed
        });
      }
    }
  }

  /**
   * Xử lý file-end: đo thời gian, ráp Blob, kiểm tra SHA-256
   */
  async _onReceiveFileEnd(fileId) {
    const session = this.currentReceiveSession;
    if (!session || session.meta.id !== fileId) return;

    const recvMs = session.startTime ? (now() - session.startTime) : 0;
    if (this.onLog) {
      this.onLog('XFER', `Đã nhận xong dữ liệu file (thời gian truyền: ${Math.round(recvMs)} ms). Đang kiểm tra SHA-256...`);
    }

    // Ghép blob
    const blob = new Blob(session.chunks, { type: session.meta.mime });
    session.chunks = []; // Giải phóng mảng buffer chunks

    let ok = false;
    let computedHash = '';

    try {
      computedHash = await hashFile(blob);
      ok = (computedHash.toLowerCase() === session.meta.sha256.toLowerCase());
    } catch (e) {
      if (this.onLog) this.onLog('XFER', `Lỗi tính băm: ${e.message}`);
    }

    // Gửi kết quả file-result về bên gửi
    this.dc.send(JSON.stringify({
      t: 'file-result',
      id: fileId,
      ok,
      sha256Received: computedHash,
      recvMs
    }));

    const result = {
      role: 'receiver',
      id: fileId,
      ok,
      recvMs,
      fileSize: session.meta.size,
      fileName: session.meta.name,
      mime: session.meta.mime,
      sha256Expected: session.meta.sha256,
      sha256Received: computedHash,
      blob
    };

    this._cleanUp();

    if (this.onComplete) {
      this.onComplete(result);
    }
  }

  /**
   * Hủy truyền file từ phía đối tác
   */
  _onReceiveFileCancel(fileId) {
    if (this.currentReceiveSession && this.currentReceiveSession.meta.id === fileId) {
      if (this.onLog) this.onLog('XFER', 'Đối tác đã hủy truyền file');
      this._cleanUp();
      if (this.onError) {
        this.onError(new Error('Đối tác đã hủy quá trình truyền file'));
      }
    }
  }

  /**
   * Hủy tiến trình hiện tại
   */
  cancelCurrent() {
    if (this.currentSendSession) {
      this.currentSendSession.cancel();
    } else if (this.currentReceiveSession) {
      try {
        this.dc.send(JSON.stringify({ t: 'file-cancel', id: this.currentReceiveSession.meta.id }));
      } catch (e) {}
      this._cleanUp();
    }
  }

  _cleanUp() {
    this.isTransferring = false;
    this.currentTransferRole = null;
    this.currentSendSession = null;
    this.currentReceiveSession = null;
  }
}
