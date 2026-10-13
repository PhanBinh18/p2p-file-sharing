/**
 * UI Module: Quản lý DOM, màn hình, thông báo toast, modal, stepper và log panel
 */

import { formatBytes, formatDuration, formatSpeed, highlightSdp, parseIceCandidate, escapeHtml, truncateStr } from './util.js';

export class UIController {
  constructor() {
    this.currentScreen = 'lobby';
    this.logs = [];
    this.stepperStep = 0;

    // Cache các phần tử DOM chính
    this.els = {
      // Screens
      screenLobby: document.getElementById('screen-lobby'),
      screenWaitingHost: document.getElementById('screen-waiting-host'),
      screenWaitingGuest: document.getElementById('screen-waiting-guest'),
      screenConnecting: document.getElementById('screen-connecting'),
      screenConnected: document.getElementById('screen-connected'),

      // Lobby inputs & buttons
      inputNickname: document.getElementById('input-nickname'),
      btnCreateRoom: document.getElementById('btn-create-room'),
      inputRoomCode: document.getElementById('input-room-code'),
      btnJoinRoom: document.getElementById('btn-join-room'),
      secureContextWarning: document.getElementById('secure-context-warning'),

      // Waiting Host
      displayHostRoomCode: document.getElementById('display-host-room-code'),
      btnCopyRoomCode: document.getElementById('btn-copy-room-code'),
      btnHostCancel: document.getElementById('btn-host-cancel'),

      // Waiting Guest
      displayGuestRoomCode: document.getElementById('display-guest-room-code'),
      btnGuestCancel: document.getElementById('btn-guest-cancel'),

      // Connecting / Status
      connectingStatusText: document.getElementById('connecting-status-text'),
      btnConnectingCancel: document.getElementById('btn-connecting-cancel'),

      // Connected Header & Partner
      connectedPartnerName: document.getElementById('connected-partner-name'),
      connectedRoomCode: document.getElementById('connected-room-code'),
      connectedConnType: document.getElementById('connected-conn-type'),
      connectedRtt: document.getElementById('connected-rtt'),
      connectedSetupTime: document.getElementById('connected-setup-time'),
      btnLeaveRoom: document.getElementById('btn-leave-room'),

      // Stepper
      stepper: document.getElementById('connection-stepper'),

      // File Selection & Hash
      fileDropZone: document.getElementById('file-drop-zone'),
      fileInput: document.getElementById('file-input'),
      selectedFileCard: document.getElementById('selected-file-card'),
      selectedFileName: document.getElementById('selected-file-name'),
      selectedFileSize: document.getElementById('selected-file-size'),
      selectedFileSha: document.getElementById('selected-file-sha'),
      btnRemoveFile: document.getElementById('btn-remove-file'),

      // Transfer Controls
      btnSendP2p: document.getElementById('btn-send-p2p'),
      btnSendRelay: document.getElementById('btn-send-relay'),
      btnBenchmark: document.getElementById('btn-benchmark'),
      benchmarkIterations: document.getElementById('benchmark-iterations'),
      checkboxAutoAccept: document.getElementById('checkbox-auto-accept'),

      // Active Transfer Progress Card
      transferProgressCard: document.getElementById('transfer-progress-card'),
      transferProgressTitle: document.getElementById('transfer-progress-title'),
      transferProgressBar: document.getElementById('transfer-progress-bar'),
      transferPercentText: document.getElementById('transfer-percent-text'),
      transferStatsText: document.getElementById('transfer-stats-text'),
      btnCancelTransfer: document.getElementById('btn-cancel-transfer'),

      // Transfer Completed Card
      transferResultCard: document.getElementById('transfer-result-card'),
      transferResultTitle: document.getElementById('transfer-result-title'),
      transferResultBadge: document.getElementById('transfer-result-badge'),
      transferResultDetails: document.getElementById('transfer-result-details'),
      btnSaveReceivedFile: document.getElementById('btn-save-received-file'),

      // Benchmark Result Card
      benchmarkResultCard: document.getElementById('benchmark-result-card'),
      benchmarkResultSummary: document.getElementById('benchmark-result-summary'),
      benchmarkP2pBar: document.getElementById('benchmark-p2p-bar'),
      benchmarkRelayBar: document.getElementById('benchmark-relay-bar'),
      benchmarkTableBody: document.getElementById('benchmark-table-body'),
      benchmarkServerStats: document.getElementById('benchmark-server-stats'),

      // Log Panel
      logContainer: document.getElementById('log-container'),
      logList: document.getElementById('log-list'),
      btnToggleLog: document.getElementById('btn-toggle-log'),
      btnClearLog: document.getElementById('btn-clear-log'),
      btnExportLog: document.getElementById('btn-export-log'),
      logBadgeCount: document.getElementById('log-badge-count'),

      // Modals
      modalJoinRequest: document.getElementById('modal-join-request'),
      joinRequestNick: document.getElementById('join-request-nick'),
      btnJoinAccept: document.getElementById('btn-join-accept'),
      btnJoinReject: document.getElementById('btn-join-reject'),

      modalFileRequest: document.getElementById('modal-file-request'),
      fileRequestName: document.getElementById('file-request-name'),
      fileRequestSize: document.getElementById('file-request-size'),
      fileRequestSha: document.getElementById('file-request-sha'),
      btnFileAccept: document.getElementById('btn-file-accept'),
      btnFileReject: document.getElementById('btn-file-reject'),

      modalDetails: document.getElementById('modal-details'),
      modalDetailsTitle: document.getElementById('modal-details-title'),
      modalDetailsContent: document.getElementById('modal-details-content'),
      btnModalDetailsClose: document.getElementById('btn-modal-details-close'),

      // Toast Container
      toastContainer: document.getElementById('toast-container')
    };

    this._initDomListeners();
  }

  _initDomListeners() {
    // Tự động viết hoa và giới hạn 6 ký tự ô nhập mã phòng
    if (this.els.inputRoomCode) {
      this.els.inputRoomCode.addEventListener('input', (e) => {
        e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      });
    }

    // Toggle log panel
    if (this.els.btnToggleLog) {
      this.els.btnToggleLog.addEventListener('click', () => {
        this.els.logContainer.classList.toggle('collapsed');
      });
    }

    if (this.els.btnClearLog) {
      this.els.btnClearLog.addEventListener('click', () => {
        this.clearLogs();
      });
    }

    if (this.els.btnExportLog) {
      this.els.btnExportLog.addEventListener('click', () => {
        this.exportLogs();
      });
    }

    if (this.els.btnModalDetailsClose) {
      this.els.btnModalDetailsClose.addEventListener('click', () => {
        this.els.modalDetails.close();
      });
    }
  }

  /**
   * Chuyển đổi trạng thái màn hình
   * Các trạng thái: 'lobby' | 'waiting-host' | 'waiting-guest' | 'connecting' | 'connected'
   */
  setScreen(screenName) {
    this.currentScreen = screenName;
    const screens = [
      { name: 'lobby', el: this.els.screenLobby },
      { name: 'waiting-host', el: this.els.screenWaitingHost },
      { name: 'waiting-guest', el: this.els.screenWaitingGuest },
      { name: 'connecting', el: this.els.screenConnecting },
      { name: 'connected', el: this.els.screenConnected }
    ];

    screens.forEach(s => {
      if (s.el) {
        if (s.name === screenName) {
          s.el.classList.remove('hidden');
        } else {
          s.el.classList.add('hidden');
        }
      }
    });

    // Reset kết quả chuyển giao nếu về lobby
    if (screenName === 'lobby') {
      this.resetTransferUI();
      this.setStepperStep(0);
    }
  }

  /**
   * Cập nhật Stepper 7 bước theo C8
   * 1: Tạo phòng, 2: Xin vào, 3: Chủ phòng duyệt, 4: Offer, 5: Answer, 6: ICE, 7: DataChannel mở
   */
  setStepperStep(stepNumber) {
    // Không lùi về bước nhỏ hơn nếu đang ở bước cao hơn (tránh race condition khi ICE candidate đến trước Answer)
    if (stepNumber < this.stepperStep && stepNumber !== 0) return;
    this.stepperStep = stepNumber;
    if (!this.els.stepper) return;

    const items = this.els.stepper.querySelectorAll('.stepper-item');
    items.forEach((item, idx) => {
      const stepIdx = idx + 1;
      item.classList.remove('active', 'completed');
      if (stepIdx < stepNumber) {
        item.classList.add('completed');
      } else if (stepIdx === stepNumber) {
        item.classList.add('active');
      }
    });
  }

  /**
   * Hiển thị thông báo Toast
   * @param {string} message
   * @param {'info'|'success'|'warning'|'error'} type
   * @param {number} duration
   */
  showToast(message, type = 'info', duration = 3500) {
    if (!this.els.toastContainer) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <span class="toast-icon">${type === 'success' ? '✓' : type === 'error' ? '✕' : type === 'warning' ? '⚠' : 'ℹ'}</span>
      <span class="toast-text">${escapeHtml(message)}</span>
    `;

    this.els.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  /**
   * Ghi một dòng log vào Log Panel
   * @param {string} tag WS↑ | WS↓ | PC | ICE | DC | XFER | RELAY | BENCH
   * @param {string} message
   * @param {object} [details]
   */
  addLog(tag, message, details = null) {
    const time = new Date();
    const timeStr = `${time.toTimeString().split(' ')[0]}.${String(time.getMilliseconds()).padStart(3, '0')}`;
    const logItem = { timeStr, tag, message, details };
    this.logs.push(logItem);

    if (this.els.logBadgeCount) {
      this.els.logBadgeCount.textContent = this.logs.length;
    }

    if (!this.els.logList) return;

    const li = document.createElement('li');
    li.className = `log-entry log-tag-${tag.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

    let detailsBtn = '';
    if (details) {
      detailsBtn = `<button type="button" class="btn-log-details" title="Xem chi tiết">🔍 Chi tiết</button>`;
    }

    li.innerHTML = `
      <span class="log-time">${timeStr}</span>
      <span class="log-tag badge-tag">${tag}</span>
      <span class="log-msg">${escapeHtml(message)}</span>
      ${detailsBtn}
    `;

    if (details) {
      const btn = li.querySelector('.btn-log-details');
      btn.addEventListener('click', () => {
        this.showDetailsModal(`Chi tiết Log [${tag}]: ${message}`, details);
      });
    }

    this.els.logList.appendChild(li);
    // Tự cuộn xuống đáy
    this.els.logList.scrollTop = this.els.logList.scrollHeight;
  }

  clearLogs() {
    this.logs = [];
    if (this.els.logList) this.els.logList.innerHTML = '';
    if (this.els.logBadgeCount) this.els.logBadgeCount.textContent = '0';
  }

  exportLogs() {
    if (this.logs.length === 0) {
      this.showToast('Không có log để xuất', 'warning');
      return;
    }

    const lines = this.logs.map(l => {
      let line = `[${l.timeStr}] [${l.tag}] ${l.message}`;
      if (l.details) {
        line += `\n  Details: ${JSON.stringify(l.details, null, 2)}`;
      }
      return line;
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `p2p-webrtc-logs-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    this.showToast('Đã tải xuống file nhật ký log', 'success');
  }

  /**
   * Hiển thị Modal chi tiết (SDP / Candidate / ICE Diagnostics / Raw Data)
   */
  showDetailsModal(title, data) {
    if (!this.els.modalDetails) return;

    this.els.modalDetailsTitle.textContent = title;
    let contentHtml = '';

    if (data.sdp) {
      contentHtml = `
        <div class="sdp-view-container">
          <p class="text-muted mb-2">Loại SDP: <strong>${escapeHtml(data.type || 'N/A')}</strong></p>
          <pre class="code-block sdp-code"><code>${highlightSdp(data.sdp)}</code></pre>
        </div>
      `;
    } else if (data.iceDiagnostics) {
      const diag = data.iceDiagnostics;
      const rows = (diag.pairs || []).map(p => {
        const badge = p.isSelected
          ? '✅ ĐANG DÙNG'
          : p.state === 'succeeded'
            ? '✓ succeeded'
            : p.state === 'failed'
              ? '❌ failed'
              : `⏳ ${p.state || 'waiting'}`;
        return `
          <tr style="${p.isSelected ? 'font-weight:bold;background:rgba(16,185,129,0.12);' : ''}">
            <td>${escapeHtml(badge)}</td>
            <td><code>[${escapeHtml(p.localType)}]</code> ${escapeHtml(p.localAddr)}</td>
            <td><code>[${escapeHtml(p.remoteType)}]</code> ${escapeHtml(p.remoteAddr)}</td>
            <td>${p.rttMs != null ? `${p.rttMs} ms` : '-'}</td>
            <td>↑${formatBytes(p.bytesSent)} / ↓${formatBytes(p.bytesReceived)}</td>
          </tr>
        `;
      }).join('');

      contentHtml = `
        <div class="candidate-view-container">
          <table class="table-compact mb-3">
            <tr><td>Đường truyền đang chọn</td><td><strong>${escapeHtml(diag.selectedLabel)}</strong></td></tr>
            <tr><td>Local Candidate</td><td><code>${escapeHtml(diag.local)}</code></td></tr>
            <tr><td>Remote Candidate</td><td><code>${escapeHtml(diag.remote)}</code></td></tr>
            <tr><td>Độ trễ (RTT)</td><td>${diag.rttMs != null ? `${diag.rttMs} ms` : 'N/A'}</td></tr>
          </table>
          <p class="text-muted mb-2"><strong>Danh sách tất cả các cặp ICE Candidate đã thử nghiệm (${(diag.pairs || []).length} cặp):</strong></p>
          <div style="overflow-x:auto;">
            <table class="table-compact mb-3" style="width:100%;font-size:0.85rem;">
              <thead>
                <tr>
                  <th>Trạng thái</th>
                  <th>Máy này (Local)</th>
                  <th>Đối tác (Remote)</th>
                  <th>RTT</th>
                  <th>Lưu lượng</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      `;
    } else if (data.candidate && typeof data.candidate === 'string') {
      const parsed = parseIceCandidate(data.candidate);
      contentHtml = `
        <div class="candidate-view-container">
          <table class="table-compact mb-3">
            <tr><td>Loại candidate</td><td><strong>${escapeHtml(parsed?.typeLabel || 'N/A')}</strong></td></tr>
            <tr><td>Giao thức</td><td>${escapeHtml(parsed?.protocol || 'N/A')}</td></tr>
            <tr><td>Địa chỉ IP : Port</td><td>${escapeHtml(parsed?.ip || '')}:${escapeHtml(parsed?.port || '')}</td></tr>
            <tr><td>Độ ưu tiên (Priority)</td><td>${escapeHtml(parsed?.priority || 'N/A')}</td></tr>
          </table>
          <pre class="code-block"><code>${escapeHtml(data.candidate)}</code></pre>
        </div>
      `;
    } else {
      contentHtml = `<pre class="code-block"><code>${escapeHtml(JSON.stringify(data, null, 2))}</code></pre>`;
    }

    this.els.modalDetailsContent.innerHTML = contentHtml;
    this.els.modalDetails.showModal();
  }

  /**
   * Modal hỏi Chủ phòng khi có khách xin vào
   */
  showJoinRequestModal(nickname, onDecision) {
    if (!this.els.modalJoinRequest) return;
    this.els.joinRequestNick.textContent = nickname;

    const acceptBtn = this.els.btnJoinAccept;
    const rejectBtn = this.els.btnJoinReject;

    const clean = () => {
      acceptBtn.onclick = null;
      rejectBtn.onclick = null;
      this.els.modalJoinRequest.close();
    };

    acceptBtn.onclick = () => {
      clean();
      onDecision(true);
    };

    rejectBtn.onclick = () => {
      clean();
      onDecision(false);
    };

    this.els.modalJoinRequest.showModal();
  }

  /**
   * Modal hỏi Người nhận khi có file gửi tới
   */
  showFileRequestModal(meta, onDecision) {
    if (!this.els.modalFileRequest) return;
    this.els.fileRequestName.textContent = meta.name;
    this.els.fileRequestSize.textContent = formatBytes(meta.size);
    this.els.fileRequestSha.textContent = truncateStr(meta.sha256, 16);
    this.els.fileRequestSha.title = meta.sha256;

    const acceptBtn = this.els.btnFileAccept;
    const rejectBtn = this.els.btnFileReject;

    const clean = () => {
      acceptBtn.onclick = null;
      rejectBtn.onclick = null;
      this.els.modalFileRequest.close();
    };

    acceptBtn.onclick = () => {
      clean();
      onDecision(true);
    };

    rejectBtn.onclick = () => {
      clean();
      onDecision(false);
    };

    this.els.modalFileRequest.showModal();
  }

  /**
   * Cập nhật thông tin file được chọn
   */
  setSelectedFile(file, sha256 = null, isHashing = false) {
    if (!file) {
      this.els.selectedFileCard.classList.add('hidden');
      this.els.btnSendP2p.disabled = true;
      this.els.btnSendRelay.disabled = true;
      this.els.btnBenchmark.disabled = true;
      return;
    }

    this.els.selectedFileCard.classList.remove('hidden');
    this.els.selectedFileName.textContent = file.name;
    this.els.selectedFileSize.textContent = formatBytes(file.size);

    if (isHashing) {
      this.els.selectedFileSha.innerHTML = '<span class="text-warning">⏳ Đang tính mã băm SHA-256...</span>';
      this.els.btnSendP2p.disabled = true;
      this.els.btnSendRelay.disabled = true;
      this.els.btnBenchmark.disabled = true;
    } else if (sha256) {
      this.els.selectedFileSha.innerHTML = `SHA-256: <code>${escapeHtml(truncateStr(sha256, 16))}</code>`;
      this.els.selectedFileSha.title = sha256;
      this.els.btnSendP2p.disabled = false;
      this.els.btnSendRelay.disabled = false;
      this.els.btnBenchmark.disabled = false;
    }
  }

  /**
   * Cập nhật thanh tiến trình truyền file (P2P hoặc Relay)
   */
  updateTransferProgress({ mode = 'p2p', role, fileName, percentage, speedBytesPerSec, loaded, total, sentBytes, receivedBytes, totalBytes }) {
    this.els.transferProgressCard.classList.remove('hidden');
    const bytesDone = loaded ?? sentBytes ?? receivedBytes ?? 0;
    const bytesTotal = total ?? totalBytes ?? 0;

    const roleText = role === 'sender' || role === 'uploader' ? 'Đang gửi' : 'Đang nhận';
    const modeText = mode === 'p2p' ? 'P2P (WebRTC)' : 'Server Relay';

    this.els.transferProgressTitle.textContent = `${roleText} [${modeText}]: ${fileName}`;
    this.els.transferProgressBar.style.width = `${percentage}%`;
    this.els.transferPercentText.textContent = `${percentage}%`;
    this.els.transferStatsText.textContent = `${formatBytes(bytesDone)} / ${formatBytes(bytesTotal)} • Tốc độ: ${formatSpeed(speedBytesPerSec)}`;
  }

  hideTransferProgress() {
    this.els.transferProgressCard.classList.add('hidden');
  }

  /**
   * Hiển thị kết quả hoàn thành truyền file
   */
  showTransferResult(result) {
    this.hideTransferProgress();
    this.els.transferResultCard.classList.remove('hidden');

    const isOk = result.ok;
    this.els.transferResultTitle.textContent = `${result.role === 'sender' || result.role === 'uploader' ? 'Đã gửi' : 'Đã nhận'} file thành công`;
    this.els.transferResultBadge.className = `badge ${isOk ? 'badge-success' : 'badge-danger'}`;
    this.els.transferResultBadge.textContent = isOk ? '✅ Toàn vẹn (SHA-256 trùng khớp)' : '❌ LỖI TOÀN VẸN (SHA-256 sai lệch)';

    const durationMs = result.totalMs || result.recvMs || result.sendMs || 0;
    const speed = durationMs > 0 ? (result.fileSize / (durationMs / 1000)) : 0;

    this.els.transferResultDetails.innerHTML = `
      <div class="result-grid">
        <div><strong>Tên file:</strong> ${escapeHtml(result.fileName)}</div>
        <div><strong>Dung lượng:</strong> ${formatBytes(result.fileSize)}</div>
        <div><strong>Thời gian:</strong> ${formatDuration(durationMs)}</div>
        <div><strong>Tốc độ trung bình:</strong> ${formatSpeed(speed)}</div>
        <div class="full-width"><strong>SHA-256 gốc:</strong> <code>${escapeHtml(result.sha256Expected)}</code></div>
        <div class="full-width"><strong>SHA-256 nhận:</strong> <code>${escapeHtml(result.sha256Received)}</code></div>
      </div>
    `;

    // Nút lưu file nếu là bên nhận
    if (result.blob) {
      this.els.btnSaveReceivedFile.classList.remove('hidden');
      this.els.btnSaveReceivedFile.onclick = () => {
        const url = URL.createObjectURL(result.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = result.fileName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      };
    } else {
      this.els.btnSaveReceivedFile.classList.add('hidden');
    }
  }

  /**
   * Hiển thị kết quả Benchmark so sánh tốc độ
   */
  showBenchmarkResult(summary) {
    this.els.benchmarkResultCard.classList.remove('hidden');

    const winnerText = summary.winner === 'p2p'
      ? `<span class="text-success font-bold">P2P nhanh gấp ${summary.speedupRatio} lần</span> so với Server Relay`
      : `<span class="text-info font-bold">Server Relay nhanh gấp ${summary.speedupRatio} lần</span> so với P2P`;

    this.els.benchmarkResultSummary.innerHTML = `
      <div class="benchmark-highlight mb-3">
        <h3>${winnerText}</h3>
        <p class="text-muted">Kiểm nghiệm trên file <strong>${escapeHtml(summary.fileName)}</strong> (${summary.fileSizeFormatted}), tính theo trung vị qua ${summary.iterations} lượt đo.</p>
        ${summary.p2pSetupTimeMs ? `<p class="setup-time-note">⏱ Thời gian thiết lập WebRTC ban đầu: <strong>${Math.round(summary.p2pSetupTimeMs)} ms</strong> (đo riêng biệt, không gộp vào truyền dữ liệu)</p>` : ''}
      </div>
    `;

    // Thanh so sánh trực quan (CSS bar)
    const p2pSpeed = summary.p2p.medianSpeedBytesPerSec;
    const relaySpeed = summary.relay.medianSpeedBytesPerSec;
    const maxSpeed = Math.max(p2pSpeed, relaySpeed, 1);

    const p2pWidth = Math.max(5, Math.round((p2pSpeed / maxSpeed) * 100));
    const relayWidth = Math.max(5, Math.round((relaySpeed / maxSpeed) * 100));

    this.els.benchmarkP2pBar.style.width = `${p2pWidth}%`;
    this.els.benchmarkP2pBar.textContent = `P2P: ${summary.p2p.medianSpeedFormatted} (${summary.p2p.durationFormatted})`;

    this.els.benchmarkRelayBar.style.width = `${relayWidth}%`;
    this.els.benchmarkRelayBar.textContent = `Server Relay: ${summary.relay.medianSpeedFormatted} (${summary.relay.durationFormatted})`;

    // Bảng chi tiết từng lượt
    let rowsHtml = '';
    const iters = Math.max(summary.p2p.runs.length, summary.relay.runs.length);
    for (let i = 0; i < iters; i++) {
      const pRun = summary.p2p.runs[i];
      const rRun = summary.relay.runs[i];
      rowsHtml += `
        <tr>
          <td>Lượt ${i + 1}</td>
          <td>${pRun ? `${formatDuration(pRun.timeMs)} (${formatSpeed(pRun.speedBytesPerSec)})` : '-'}</td>
          <td>${rRun ? `${formatDuration(rRun.timeMs)} [Up: ${formatDuration(rRun.uploadMs)}, Down: ${formatDuration(rRun.downloadMs)}]` : '-'}</td>
          <td>${pRun && rRun ? `${(rRun.timeMs / pRun.timeMs).toFixed(2)}x` : '-'}</td>
        </tr>
      `;
    }
    this.els.benchmarkTableBody.innerHTML = rowsHtml;

    // Hiển thị thông số băng thông tiêu hao của Server
    if (summary.serverStats) {
      const sigKb = (summary.serverStats.signalingBytes / 1024).toFixed(2);
      const relMb = (summary.serverStats.relayUploadBytes / (1024 * 1024)).toFixed(2);
      this.els.benchmarkServerStats.innerHTML = `
        <div class="server-stats-badge">
          🌐 <strong>Băng thông Server đã phục vụ:</strong> ${sigKb} KB tín hiệu Signaling • ${relMb} MB Relay
          <br><small class="text-muted">(Minh họa: P2P gần như không tốn băng thông đường truyền của Server)</small>
        </div>
      `;
    } else {
      this.els.benchmarkServerStats.innerHTML = '';
    }
  }

  /**
   * Cập nhật thông số kết nối PeerConnection định kỳ (RTT, loại candidate)
   */
  updateConnectionStats(stats) {
    if (this.els.connectedConnType) {
      this.els.connectedConnType.textContent = stats.typeLabel;
      this.els.connectedConnType.className = `badge badge-${stats.candidateType === 'host' ? 'lan' : stats.candidateType === 'relay' ? 'turn' : 'stun'}`;
    }

    if (this.els.connectedRtt) {
      this.els.connectedRtt.textContent = stats.rttMs != null ? `${stats.rttMs} ms` : 'N/A';
    }

    if (this.els.connectedSetupTime && stats.setupDurationMs != null) {
      this.els.connectedSetupTime.textContent = `${Math.round(stats.setupDurationMs)} ms`;
    }
  }

  resetTransferUI() {
    this.setSelectedFile(null);
    this.hideTransferProgress();
    if (this.els.transferResultCard) this.els.transferResultCard.classList.add('hidden');
    if (this.els.benchmarkResultCard) this.els.benchmarkResultCard.classList.add('hidden');
  }
}
