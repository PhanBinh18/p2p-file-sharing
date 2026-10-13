/**
 * File điều phối trung tâm của ứng dụng P2P File Sharing (WebRTC)
 */

import { UIController } from './ui.js';
import { SignalingClient } from './signaling.js';
import { PeerManager } from './peer.js';
import { P2PFileTransfer, MAX_FILE_SIZE } from './transfer-p2p.js';
import { RelayFileTransfer } from './transfer-relay.js';
import { BenchmarkRunner } from './benchmark.js';
import { hashFile, isCryptoSupported } from './hash.js';
import { formatBytes } from './util.js';

class App {
  constructor() {
    this.ui = new UIController();
    this.signaling = new SignalingClient();
    this.peerManager = null;
    this.p2pTransfer = null;
    this.relayTransfer = null;
    this.benchmarkRunner = null;

    this.nickname = '';
    this.partnerNickname = '';
    this.roomCode = '';
    this.peerId = '';
    this.isHost = false;

    this.selectedFile = null;
    this.selectedFileSha256 = null;

    this._init();
  }

  _init() {
    // 1. Kiểm tra môi trường Secure Context và Web Crypto
    if (!isCryptoSupported()) {
      if (this.ui.els.secureContextWarning) {
        this.ui.els.secureContextWarning.classList.remove('hidden');
      }
      this.ui.showToast('Cần chạy trên HTTPS hoặc localhost để Web Crypto và WebRTC hoạt động đầy đủ!', 'error', 10000);
    }

    // 2. Thiết lập logging từ Signaling
    this.signaling.setLogHandler((tag, msg, details) => {
      this.ui.addLog(tag, msg, details);
    });

    // 3. Xử lý khi WebSocket ngắt kết nối bất ngờ
    this.signaling.setOnClose(({ wasConnected }) => {
      if (wasConnected && this.ui.currentScreen !== 'lobby') {
        this.ui.showToast('Mất kết nối tới Signaling Server. Đang trở về sảnh...', 'warning');
        this.leaveAndReset();
      }
    });

    // 4. Khởi tạo Relay Transfer
    this.relayTransfer = new RelayFileTransfer({
      signaling: this.signaling,
      getRoomCode: () => this.roomCode,
      getPeerId: () => this.peerId,
      onLog: (tag, msg, details) => this.ui.addLog(tag, msg, details),
      onProgress: (prog) => this.ui.updateTransferProgress(prog),
      onComplete: (res) => this.ui.showTransferResult(res),
      onError: (err) => this.ui.showToast(err.message, 'error'),
      onRequestDownload: ({ fileName, fileSize, onDownload }) => {
        this.ui.showToast(`Server có file sẵn sàng: ${fileName} (${formatBytes(fileSize)})`, 'info');
        // Nếu người dùng không bật auto accept, thông báo nút download
        onDownload();
      }
    });

    // 5. Đăng ký các sự kiện Signaling từ server
    this._bindSignalingEvents();

    // 6. Đăng ký các sự kiện tương tác giao diện người dùng
    this._bindUIEvents();
  }

  _bindSignalingEvents() {
    // Nhận room-created (Chủ phòng)
    this.signaling.on('room-created', (msg) => {
      this.roomCode = msg.roomCode;
      this.peerId = msg.peerId;
      this.isHost = true;

      this.ui.els.displayHostRoomCode.textContent = this.roomCode;
      this.ui.setScreen('waiting-host');
      this.ui.setStepperStep(1); // Bước 1: Tạo phòng thành công
      this.ui.showToast(`Phòng ${this.roomCode} đã được tạo! Đang chờ đối tác...`, 'success');
    });

    // Nhận join-pending (Khách)
    this.signaling.on('join-pending', (msg) => {
      this.roomCode = msg.roomCode;
      this.peerId = msg.peerId;
      this.isHost = false;

      this.ui.els.displayGuestRoomCode.textContent = this.roomCode;
      this.ui.setScreen('waiting-guest');
      this.ui.setStepperStep(2); // Bước 2: Đã gửi yêu cầu vào phòng
      this.ui.showToast('Đã gửi yêu cầu, đang chờ chủ phòng duyệt...', 'info');
    });

    // Nhận join-request (Chủ phòng nhận được yêu cầu từ khách)
    this.signaling.on('join-request', (msg) => {
      this.partnerNickname = msg.nickname;
      this.ui.setStepperStep(2);
      this.ui.showJoinRequestModal(msg.nickname, (accept) => {
        this.signaling.send('join-decision', { accept });
        if (accept) {
          this.ui.setStepperStep(3); // Bước 3: Chủ phòng đã chấp nhận
          this.ui.els.connectingStatusText.textContent = `Đã chấp nhận ${msg.nickname}. Đang chuẩn bị WebRTC...`;
          this.ui.setScreen('connecting');
        } else {
          this.ui.showToast(`Đã từ chối yêu cầu của ${msg.nickname}`, 'info');
        }
      });
    });

    // Nhận join-rejected (Khách bị từ chối)
    this.signaling.on('join-rejected', (msg) => {
      const reasonText = msg.reason === 'host-declined'
        ? 'Chủ phòng đã từ chối yêu cầu tham gia.'
        : 'Hết thời gian chờ chủ phòng duyệt.';
      this.ui.showToast(reasonText, 'warning');
      this.leaveAndReset();
    });

    // Nhận join-accepted (Khách được chấp thuận)
    this.signaling.on('join-accepted', async (msg) => {
      this.partnerNickname = msg.hostNickname;
      this.ui.setStepperStep(3);
      this.ui.els.connectingStatusText.textContent = `Chủ phòng "${msg.hostNickname}" đã đồng ý! Đang bắt tay kết nối...`;
      this.ui.setScreen('connecting');

      // Khách khởi tạo RTCPeerConnection và gửi peer-ready
      await this._setupPeerConnection(false);
      this.signaling.send('peer-ready');
    });

    // Chủ phòng nhận peer-ready từ khách
    this.signaling.on('peer-ready', async (msg) => {
      this.ui.addLog('PC', `Khách "${msg.nickname || 'Guest'}" đã sẵn sàng. Chủ phòng tạo Offer...`);
      await this._setupPeerConnection(true);
      await this.peerManager.createOffer();
      this.ui.setStepperStep(4); // Bước 4: Đã tạo và gửi Offer
    });

    // Nhận Offer (Khách)
    this.signaling.on('offer', async (msg) => {
      this.ui.setStepperStep(4);
      if (this.peerManager) {
        await this.peerManager.handleOffer(msg.sdp);
        this.ui.setStepperStep(5); // Bước 5: Đã tạo và gửi Answer
      }
    });

    // Nhận Answer (Chủ phòng)
    this.signaling.on('answer', async (msg) => {
      this.ui.setStepperStep(5);
      if (this.peerManager) {
        await this.peerManager.handleAnswer(msg.sdp);
      }
    });

    // Nhận ICE Candidate (Cả hai phía)
    this.signaling.on('ice-candidate', async (msg) => {
      this.ui.setStepperStep(6); // Bước 6: Trao đổi ICE candidate
      if (this.peerManager) {
        await this.peerManager.handleRemoteIceCandidate(msg.candidate);
      }
    });

    // Nhận peer-left (Đối tác rời phòng)
    this.signaling.on('peer-left', (msg) => {
      this.ui.showToast(`Đối tác "${msg.nickname || 'Bạn cùng phòng'}" đã rời phòng`, 'warning');
      this.leaveAndReset();
    });

    // Nhận room-closed (Chủ phòng đã thoát)
    this.signaling.on('room-closed', (msg) => {
      this.ui.showToast('Chủ phòng đã đóng phòng này.', 'warning');
      this.leaveAndReset();
    });

    // Nhận lỗi từ Signaling Server
    this.signaling.on('error', (msg) => {
      const friendlyMsg = SignalingClient.getFriendlyErrorMessage(msg.code, msg.message);
      this.ui.showToast(`Lỗi: ${friendlyMsg}`, 'error');
    });
  }

  async _setupPeerConnection(isHost) {
    if (this.peerManager) {
      this.peerManager.destroy();
    }

    this.peerManager = new PeerManager({
      isHost,
      signaling: this.signaling,
      onLog: (tag, msg, details) => this.ui.addLog(tag, msg, details),
      onStatsUpdate: (stats) => this.ui.updateConnectionStats(stats),
      onConnectionStateChange: (state, errorMsg) => {
        if (state === 'disconnected') {
          this.ui.showToast('Kết nối P2P đang chập chờn, đang chờ khôi phục...', 'warning', 4000);
        } else if (state === 'failed') {
          if (this.p2pTransfer) {
            this.p2pTransfer.handleDisconnect(errorMsg);
          }
          this.ui.hideTransferProgress();
          this.ui.showToast(errorMsg || 'Kết nối WebRTC thất bại.', 'error', 6000);
        }
      },
      onDataChannelOpen: (dc, setupDurationMs) => {
        this._onWebRtcConnected(dc, setupDurationMs);
      },
      onDataChannelClose: () => {
        if (this.p2pTransfer) {
          this.p2pTransfer.handleDisconnect('DataChannel đã bị đóng giữa chừng.');
        }
        this.ui.hideTransferProgress();
        this.ui.showToast('DataChannel đã bị ngắt kết nối', 'warning');
      }
    });

    await this.peerManager.init();
  }

  _onWebRtcConnected(dc, setupDurationMs) {
    this.ui.setStepperStep(7); // Bước 7: DataChannel mở thành công
    this.ui.showToast('Kết nối P2P thành công!', 'success');

    // Chuyển sang màn hình Connected
    this.ui.setScreen('connected');
    this.ui.els.connectedPartnerName.textContent = this.partnerNickname || 'Đối tác';
    this.ui.els.connectedRoomCode.textContent = this.roomCode;
    if (setupDurationMs != null) {
      this.ui.els.connectedSetupTime.textContent = `${Math.round(setupDurationMs)} ms`;
    }

    // Khởi tạo hoặc cập nhật P2P Transfer
    this.p2pTransfer = new P2PFileTransfer({
      dc,
      onLog: (tag, msg, details) => this.ui.addLog(tag, msg, details),
      onProgress: (prog) => this.ui.updateTransferProgress({ mode: 'p2p', ...prog }),
      onComplete: (res) => this.ui.showTransferResult(res),
      onError: (err) => {
        this.ui.hideTransferProgress();
        this.ui.showToast(err.message, 'error');
      },
      onRequestAccept: ({ meta, accept, reject }) => {
        this.ui.showFileRequestModal(meta, (accepted) => {
          if (accepted) accept();
          else reject();
        });
      }
    });

    // Cập nhật cấu hình auto accept
    this.p2pTransfer.setAutoAccept(this.ui.els.checkboxAutoAccept.checked);
    this.relayTransfer.setAutoAccept(this.ui.els.checkboxAutoAccept.checked);

    // Khởi tạo Benchmark Runner
    this.benchmarkRunner = new BenchmarkRunner({
      p2pTransfer: this.p2pTransfer,
      relayTransfer: this.relayTransfer,
      getRoomCode: () => this.roomCode,
      getConnectionSetupTime: () => this.peerManager?.setupDurationMs,
      onLog: (tag, msg, details) => this.ui.addLog(tag, msg, details),
      onUpdateProgress: (prog) => {
        this.ui.showToast(prog.label, 'info', 2000);
      },
      onBenchmarkComplete: (summary) => {
        this.ui.showBenchmarkResult(summary);
      }
    });
  }

  _bindUIEvents() {
    // 1. Tạo phòng
    this.ui.els.btnCreateRoom.addEventListener('click', async () => {
      const nick = this.ui.els.inputNickname.value.trim();
      if (!nick || nick.length > 20) {
        this.ui.showToast('Biệt danh phải từ 1 đến 20 ký tự', 'warning');
        return;
      }
      this.nickname = nick;

      try {
        await this.signaling.connect();
        this.signaling.send('create-room', { nickname: nick });
      } catch (err) {
        this.ui.showToast(`Không thể kết nối máy chủ: ${err.message}`, 'error');
      }
    });

    // 2. Vào phòng
    this.ui.els.btnJoinRoom.addEventListener('click', async () => {
      const nick = this.ui.els.inputNickname.value.trim();
      const code = this.ui.els.inputRoomCode.value.trim().toUpperCase();

      if (!nick || nick.length > 20) {
        this.ui.showToast('Biệt danh phải từ 1 đến 20 ký tự', 'warning');
        return;
      }
      if (!code || code.length !== 6) {
        this.ui.showToast('Mã phòng phải gồm đúng 6 ký tự', 'warning');
        return;
      }

      this.nickname = nick;
      try {
        await this.signaling.connect();
        this.signaling.send('join-room', { roomCode: code, nickname: nick });
      } catch (err) {
        this.ui.showToast(`Không thể kết nối máy chủ: ${err.message}`, 'error');
      }
    });

    // 3. Sao chép mã phòng
    this.ui.els.btnCopyRoomCode.addEventListener('click', () => {
      if (this.roomCode) {
        navigator.clipboard.writeText(this.roomCode).then(() => {
          this.ui.showToast(`Đã sao chép mã phòng ${this.roomCode}`, 'success');
        }).catch(() => {
          this.ui.showToast(`Mã phòng: ${this.roomCode}`, 'info');
        });
      }
    });

    // 4. Hủy / Rời phòng
    const handleLeave = () => {
      try {
        this.signaling.send('leave-room');
      } catch (e) {}
      this.leaveAndReset();
      this.ui.showToast('Đã rời khỏi phòng', 'info');
    };

    this.ui.els.btnHostCancel.addEventListener('click', handleLeave);
    this.ui.els.btnGuestCancel.addEventListener('click', handleLeave);
    this.ui.els.btnConnectingCancel.addEventListener('click', handleLeave);
    this.ui.els.btnLeaveRoom.addEventListener('click', handleLeave);

    // 5. Checkbox Auto Accept
    this.ui.els.checkboxAutoAccept.addEventListener('change', (e) => {
      const isAuto = e.target.checked;
      if (this.p2pTransfer) this.p2pTransfer.setAutoAccept(isAuto);
      if (this.relayTransfer) this.relayTransfer.setAutoAccept(isAuto);
    });

    // 6. Chọn file (Button & Drag/Drop)
    const handleFileSelect = async (file) => {
      if (!file) return;

      if (file.size === 0) {
        this.ui.showToast('Không thể gửi file rỗng (0 bytes)!', 'warning');
        return;
      }

      if (file.size > MAX_FILE_SIZE) {
        this.ui.showToast(`File vượt quá giới hạn tối đa (${MAX_FILE_SIZE / (1024 * 1024)} MB)!`, 'error');
        return;
      }

      this.selectedFile = file;
      this.selectedFileSha256 = null;
      this.ui.setSelectedFile(file, null, true);

      // Tính SHA-256 trước khi gửi (thời gian băm không tính vào thời gian truyền)
      try {
        const hash = await hashFile(file);
        this.selectedFileSha256 = hash;
        this.ui.setSelectedFile(file, hash, false);
      } catch (err) {
        this.ui.showToast(`Lỗi tính SHA-256: ${err.message}`, 'error');
        this.ui.setSelectedFile(null);
      }
    };

    this.ui.els.fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleFileSelect(file);
    });

    this.ui.els.fileDropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.ui.els.fileDropZone.classList.add('drag-over');
    });

    this.ui.els.fileDropZone.addEventListener('dragleave', () => {
      this.ui.els.fileDropZone.classList.remove('drag-over');
    });

    this.ui.els.fileDropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      this.ui.els.fileDropZone.classList.remove('drag-over');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFileSelect(e.dataTransfer.files[0]);
      }
    });

    this.ui.els.btnRemoveFile.addEventListener('click', () => {
      this.selectedFile = null;
      this.selectedFileSha256 = null;
      this.ui.els.fileInput.value = '';
      this.ui.setSelectedFile(null);
    });

    // 7. Gửi file P2P
    this.ui.els.btnSendP2p.addEventListener('click', async () => {
      if (!this.selectedFile || !this.selectedFileSha256) return;
      try {
        await this.p2pTransfer.sendFile(this.selectedFile, this.selectedFileSha256);
      } catch (err) {
        this.ui.hideTransferProgress();
        this.ui.showToast(err.message, 'error');
      }
    });

    // 8. Gửi file qua Server Relay
    this.ui.els.btnSendRelay.addEventListener('click', async () => {
      if (!this.selectedFile || !this.selectedFileSha256) return;
      try {
        await this.relayTransfer.uploadFile(this.selectedFile, this.selectedFileSha256);
      } catch (err) {
        this.ui.hideTransferProgress();
        this.ui.showToast(err.message, 'error');
      }
    });

    // 9. Nút So sánh tốc độ (Benchmark)
    this.ui.els.btnBenchmark.addEventListener('click', async () => {
      if (!this.selectedFile || !this.selectedFileSha256) return;

      const iters = parseInt(this.ui.els.benchmarkIterations.value, 10) || 1;
      this.ui.showToast('Bắt đầu đo so sánh P2P vs Server. Vui lòng đảm bảo bên nhận đã bật "Tự động nhận"!', 'info', 4000);

      try {
        await this.benchmarkRunner.run({
          file: this.selectedFile,
          precomputedSha256: this.selectedFileSha256,
          iterations: iters
        });
      } catch (err) {
        this.ui.showToast(`Lỗi trong tiến trình Benchmark: ${err.message}`, 'error');
      }
    });

    // 10. Hủy truyền
    this.ui.els.btnCancelTransfer.addEventListener('click', () => {
      if (this.p2pTransfer) this.p2pTransfer.cancelCurrent();
      if (this.relayTransfer) this.relayTransfer.cancel();
      if (this.benchmarkRunner) this.benchmarkRunner.cancel();
      this.ui.hideTransferProgress();
      this.ui.showToast('Đã hủy truyền file', 'info');
    });
  }

  leaveAndReset() {
    if (this.peerManager) {
      this.peerManager.destroy();
      this.peerManager = null;
    }
    this.signaling.close();

    this.roomCode = '';
    this.peerId = '';
    this.partnerNickname = '';
    this.isHost = false;

    this.ui.setScreen('lobby');
  }
}

// Khởi chạy ứng dụng khi DOM đã sẵn sàng
window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
