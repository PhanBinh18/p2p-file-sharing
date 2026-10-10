/**
 * Quản lý gửi và nhận file qua Server (Relay Mode - HTTP upload/download)
 * Dùng XMLHttpRequest để theo dõi upload/download progress
 */

import { hashFile } from './hash.js';
import { now } from './util.js';

export class RelayFileTransfer {
  constructor({ signaling, getRoomCode, getPeerId, onLog, onProgress, onComplete, onError, onRequestDownload }) {
    this.signaling = signaling;
    this.getRoomCode = getRoomCode;
    this.getPeerId = getPeerId;
    this.onLog = onLog;
    this.onProgress = onProgress;
    this.onComplete = onComplete;
    this.onError = onError;
    this.onRequestDownload = onRequestDownload;

    this.autoAccept = false;
    this.currentUploadXhr = null;
    this.currentDownloadXhr = null;
    this.pendingUploadReports = new Map(); // fileId -> { uploadMs, file, sha256, resolve, reject }

    this._bindSignalingEvents();
  }

  setAutoAccept(val) {
    this.autoAccept = !!val;
  }

  _bindSignalingEvents() {
    // Khi đối tác đã upload xong file lên server, server báo relay-file-available
    this.signaling.on('relay-file-available', (msg) => {
      this._handleFileAvailable(msg);
    });

    // Khi người nhận báo cáo kết quả download về cho người upload
    this.signaling.on('relay-report', (msg) => {
      this._handleRelayReport(msg);
    });
  }

  /**
   * Upload file lên Server qua POST /api/relay/:roomCode/upload
   * @param {File} file
   * @param {string} precomputedSha256
   * @returns {Promise<object>}
   */
  async uploadFile(file, precomputedSha256 = null) {
    const roomCode = this.getRoomCode();
    const peerId = this.getPeerId();

    if (!roomCode || !peerId) {
      throw new Error('Chưa ở trong phòng hợp lệ');
    }

    if (!file || file.size === 0) {
      throw new Error('File rỗng (0 bytes). Không thể upload.');
    }

    const sha256Hash = precomputedSha256 || (await hashFile(file));

    if (this.onLog) {
      this.onLog('RELAY', `Bắt đầu upload file "${file.name}" (${file.size} bytes) lên server...`);
    }

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.currentUploadXhr = xhr;

      const url = `/api/relay/${encodeURIComponent(roomCode)}/upload`;
      xhr.open('POST', url, true);

      xhr.setRequestHeader('X-Peer-Id', peerId);
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      xhr.setRequestHeader('X-File-Sha256', sha256Hash);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');

      let startTime = null;
      let lastUiUpdate = 0;

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const currentTime = now();
          if (currentTime - lastUiUpdate > 100 || event.loaded === event.total) {
            lastUiUpdate = currentTime;
            const elapsedSec = (currentTime - startTime) / 1000;
            const speed = elapsedSec > 0 ? event.loaded / elapsedSec : 0;
            if (this.onProgress) {
              this.onProgress({
                mode: 'relay',
                role: 'uploader',
                fileName: file.name,
                loaded: event.loaded,
                total: event.total,
                percentage: Math.round((event.loaded / event.total) * 100),
                speedBytesPerSec: speed
              });
            }
          }
        }
      };

      xhr.onload = () => {
        this.currentUploadXhr = null;
        const uploadMs = now() - startTime;

        if (xhr.status === 201) {
          let resData;
          try {
            resData = JSON.parse(xhr.responseText);
          } catch (e) {
            resData = {};
          }

          const fileId = resData.fileId;
          if (this.onLog) {
            this.onLog('RELAY', `Upload lên server thành công trong ${Math.round(uploadMs)} ms (fileId: ${fileId}). Đang chờ bên nhận tải về...`);
          }

          // Lưu vào map để chờ bên nhận tải và gửi relay-report
          this.pendingUploadReports.set(fileId, {
            uploadMs,
            file,
            sha256: sha256Hash,
            resolve,
            reject
          });
        } else {
          let errDetail = `Lỗi ${xhr.status}: ${xhr.statusText}`;
          if (xhr.status === 413) errDetail = 'File vượt quá dung lượng tối đa mà server cho phép';
          else if (xhr.status === 403) errDetail = 'Không có quyền upload vào phòng này';
          else if (xhr.status === 404) errDetail = 'Phòng không tồn tại trên server';

          if (this.onLog) this.onLog('RELAY', `❌ Upload thất bại: ${errDetail}`);
          reject(new Error(errDetail));
        }
      };

      xhr.onerror = () => {
        this.currentUploadXhr = null;
        const err = new Error('Lỗi mạng khi upload file lên server');
        if (this.onLog) this.onLog('RELAY', `❌ Lỗi mạng: ${err.message}`);
        reject(err);
      };

      xhr.onabort = () => {
        this.currentUploadXhr = null;
        reject(new Error('Đã hủy upload'));
      };

      startTime = now();
      xhr.send(file);
    });
  }

  /**
   * Xử lý khi nhận sự kiện relay-file-available từ Server
   */
  _handleFileAvailable(msg) {
    const { fileId, fileName, fileSize, sha256: expectedSha256, uploadMs } = msg;

    if (this.onLog) {
      this.onLog('RELAY', `Server thông báo có file sẵn sàng tải: "${fileName}" (${fileSize} bytes)`);
    }

    const doDownload = () => {
      this.downloadFile({ fileId, fileName, fileSize, expectedSha256, uploadMs });
    };

    if (this.autoAccept) {
      if (this.onLog) this.onLog('RELAY', `[Tự động nhận] Tự động tải file "${fileName}" qua server`);
      doDownload();
    } else if (this.onRequestDownload) {
      this.onRequestDownload({
        fileId,
        fileName,
        fileSize,
        expectedSha256,
        uploadMs,
        onDownload: doDownload
      });
    }
  }

  /**
   * Tải file từ Server qua GET /api/relay/:roomCode/:fileId?peerId=<id>
   */
  async downloadFile({ fileId, fileName, fileSize, expectedSha256, uploadMs }) {
    const roomCode = this.getRoomCode();
    const peerId = this.getPeerId();

    if (!roomCode || !peerId) {
      throw new Error('Chưa ở trong phòng hợp lệ');
    }

    if (this.onLog) {
      this.onLog('RELAY', `Bắt đầu tải file "${fileName}" từ server...`);
    }

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this.currentDownloadXhr = xhr;

      const url = `/api/relay/${encodeURIComponent(roomCode)}/${encodeURIComponent(fileId)}?peerId=${encodeURIComponent(peerId)}`;
      xhr.open('GET', url, true);
      xhr.responseType = 'blob';

      let startTime = null;
      let lastUiUpdate = 0;

      xhr.onprogress = (event) => {
        if (event.lengthComputable || fileSize) {
          const total = event.total || fileSize;
          const currentTime = now();
          if (currentTime - lastUiUpdate > 100 || event.loaded === total) {
            lastUiUpdate = currentTime;
            const elapsedSec = (currentTime - startTime) / 1000;
            const speed = elapsedSec > 0 ? event.loaded / elapsedSec : 0;
            if (this.onProgress) {
              this.onProgress({
                mode: 'relay',
                role: 'downloader',
                fileName,
                loaded: event.loaded,
                total,
                percentage: Math.round((event.loaded / total) * 100),
                speedBytesPerSec: speed
              });
            }
          }
        }
      };

      xhr.onload = async () => {
        this.currentDownloadXhr = null;
        const downloadMs = now() - startTime;

        if (xhr.status === 200) {
          const blob = xhr.response;
          let ok = false;
          let computedSha256 = '';

          try {
            computedSha256 = await hashFile(blob);
            ok = (computedSha256.toLowerCase() === expectedSha256.toLowerCase());
          } catch (e) {
            if (this.onLog) this.onLog('RELAY', `Lỗi kiểm tra SHA-256 sau khi tải: ${e.message}`);
          }

          if (this.onLog) {
            this.onLog('RELAY', `Tải xong trong ${Math.round(downloadMs)} ms. Kiểm tra toàn vẹn: ${ok ? '✅ Khớp' : '❌ SAI LỆCH'}`);
          }

          // Gửi relay-report về Server để báo cho người gửi
          try {
            this.signaling.send('relay-report', {
              fileId,
              downloadMs: Math.round(downloadMs),
              ok
            });
          } catch (e) {
            console.error('Không thể gửi relay-report:', e);
          }

          const result = {
            mode: 'relay',
            role: 'downloader',
            fileId,
            fileName,
            fileSize: blob.size,
            uploadMs,
            downloadMs,
            totalMs: uploadMs + downloadMs,
            ok,
            sha256Expected: expectedSha256,
            sha256Received: computedSha256,
            blob
          };

          if (this.onComplete) {
            this.onComplete(result);
          }
          resolve(result);
        } else {
          let errDetail = `Lỗi tải file (${xhr.status})`;
          if (xhr.status === 404) errDetail = 'File hoặc phòng không còn trên server (có thể đã hết hạn)';
          else if (xhr.status === 403) errDetail = 'Không có quyền truy cập file này';

          if (this.onLog) this.onLog('RELAY', `❌ Lỗi download: ${errDetail}`);
          reject(new Error(errDetail));
        }
      };

      xhr.onerror = () => {
        this.currentDownloadXhr = null;
        const err = new Error('Lỗi mạng khi tải file từ server');
        if (this.onLog) this.onLog('RELAY', `❌ ${err.message}`);
        reject(err);
      };

      xhr.onabort = () => {
        this.currentDownloadXhr = null;
        reject(new Error('Đã hủy tải file'));
      };

      startTime = now();
      xhr.send();
    });
  }

  /**
   * Xử lý relay-report từ phía người nhận báo về cho người gửi
   */
  _handleRelayReport(msg) {
    const { fileId, downloadMs, ok } = msg;
    const session = this.pendingUploadReports.get(fileId);
    if (!session) return;

    this.pendingUploadReports.delete(fileId);

    const totalMs = session.uploadMs + downloadMs;
    if (this.onLog) {
      this.onLog('RELAY', `Nhận báo cáo từ người nhận: Download ${downloadMs} ms, Toàn vẹn: ${ok ? 'OK' : 'LỖI'}. Tổng thời gian relay: ${Math.round(totalMs)} ms`);
    }

    const finalRes = {
      mode: 'relay',
      role: 'uploader',
      fileId,
      fileName: session.file.name,
      fileSize: session.file.size,
      uploadMs: session.uploadMs,
      downloadMs,
      totalMs,
      ok,
      sha256Expected: session.sha256,
      sha256Received: session.sha256
    };

    if (this.onComplete) {
      this.onComplete(finalRes);
    }

    session.resolve(finalRes);
  }

  /**
   * Hủy các yêu cầu XHR đang chạy nếu có
   */
  cancel() {
    if (this.currentUploadXhr) {
      this.currentUploadXhr.abort();
      this.currentUploadXhr = null;
    }
    if (this.currentDownloadXhr) {
      this.currentDownloadXhr.abort();
      this.currentDownloadXhr = null;
    }
  }
}
