/**
 * Quản lý RTCPeerConnection, DataChannel, ICE Candidate và WebRTC Stats
 */

export class PeerManager {
  constructor({ isHost, signaling, onDataChannelOpen, onDataChannelClose, onLog, onStatsUpdate, onConnectionStateChange }) {
    this.isHost = isHost;
    this.signaling = signaling;
    this.onDataChannelOpen = onDataChannelOpen;
    this.onDataChannelClose = onDataChannelClose;
    this.onLog = onLog;
    this.onStatsUpdate = onStatsUpdate;
    this.onConnectionStateChange = onConnectionStateChange;

    this.pc = null;
    this.dc = null;
    this.iceCandidateQueue = [];
    this.statsInterval = null;
    this.connectTimeoutTimer = null;
    this.setupStartTime = null;
    this.setupDurationMs = null;
    this.activeCandidateType = null;
  }

  /**
   * Khởi tạo RTCPeerConnection với cấu hình STUN từ server hoặc mặc định
   * @param {Array} [iceServers]
   */
  async init(iceServers = null) {
    if (!iceServers) {
      try {
        const res = await fetch('/api/config');
        if (res.ok) {
          const cfg = await res.json();
          iceServers = cfg.iceServers;
        }
      } catch (e) {
        // Fallback STUN mặc định
      }
    }

    if (!iceServers || iceServers.length === 0) {
      iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        {
          urls: [
            'turn:openrelay.metered.ca:80',
            'turn:openrelay.metered.ca:443',
            'turn:openrelay.metered.ca:443?transport=tcp'
          ],
          username: 'openrelay',
          credential: 'openrelay'
        }
      ];
    }

    if (this.onLog) {
      this.onLog('PC', `Khởi tạo RTCPeerConnection với ${iceServers.length} ICE server`);
    }

    this.pc = new RTCPeerConnection({ iceServers });
    this.iceCandidateQueue = [];

    // Bắt đầu timer 15 giây theo dõi kết nối
    this._startConnectionTimer();

    // Lắng nghe ICE Candidate từ trình duyệt
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        if (this.onLog) {
          const c = event.candidate;
          this.onLog('ICE', `Sinh candidate: [${c.type}] ${c.address || c.ip || ''}:${c.port}`, {
            candidate: c.candidate,
            type: c.type,
            protocol: c.protocol,
            address: c.address || c.ip,
            port: c.port,
            priority: c.priority
          });
        }
        this.signaling.send('ice-candidate', {
          candidate: event.candidate.toJSON()
        });
      } else {
        if (this.onLog) this.onLog('ICE', 'Đã thu thập xong toàn bộ ICE candidates (null candidate)');
      }
    };

    // Theo dõi trạng thái ICE Connection
    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      if (this.onLog) this.onLog('ICE', `Trạng thái kết nối ICE đổi thành: ${state}`);
      if (state === 'failed') {
        this._handleConnectionFailure();
      }
    };

    // Theo dõi Connection State
    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (this.onLog) this.onLog('PC', `Trạng thái kết nối đổi thành: ${state}`);
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(state);
      }
      if (state === 'connected') {
        this._clearConnectionTimer();
        this._startStatsPolling();
      } else if (state === 'failed') {
        this._handleConnectionFailure();
      }
    };

    // Phía Khách (Guest): Lắng nghe sự kiện mở DataChannel từ Host
    if (!this.isHost) {
      this.pc.ondatachannel = (event) => {
        if (this.onLog) this.onLog('DC', `Nhận DataChannel từ host: "${event.channel.label}"`);
        this._setupDataChannel(event.channel);
      };
    }
  }

  /**
   * Thiết lập và cấu hình kênh dữ liệu (DataChannel)
   */
  _setupDataChannel(channel) {
    this.dc = channel;
    this.dc.binaryType = 'arraybuffer';

    this.dc.onopen = () => {
      this._clearConnectionTimer();
      if (this.setupStartTime && !this.setupDurationMs) {
        this.setupDurationMs = performance.now() - this.setupStartTime;
      }
      if (this.onLog) {
        this.onLog('DC', `DataChannel '${this.dc.label}' đã MỞ! (Thời gian bắt tay: ${Math.round(this.setupDurationMs || 0)} ms)`);
      }
      this._startStatsPolling();
      if (this.onDataChannelOpen) {
        this.onDataChannelOpen(this.dc, this.setupDurationMs);
      }
    };

    this.dc.onclose = () => {
      if (this.onLog) this.onLog('DC', `DataChannel '${this.dc?.label}' đã ĐÓNG`);
      if (this.onDataChannelClose) {
        this.onDataChannelClose();
      }
    };

    this.dc.onerror = (err) => {
      if (this.onLog) this.onLog('DC', `Lỗi DataChannel: ${err.message || 'Lỗi không xác định'}`);
    };
  }

  /**
   * Chủ phòng: Tạo DataChannel và gửi Offer
   */
  async createOffer() {
    this.setupStartTime = performance.now();
    if (this.onLog) this.onLog('PC', 'Chủ phòng bắt đầu tạo DataChannel "file" và sinh Offer SDP');

    // Chú ý: Chỉ { ordered: true }, không truyền maxRetransmits theo mục 6.1 của plan
    const channel = this.pc.createDataChannel('file', { ordered: true });
    this._setupDataChannel(channel);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    if (this.onLog) {
      this.onLog('PC', 'Đã gán LocalDescription (Offer) thành công', { sdp: offer.sdp, type: offer.type });
    }

    this.signaling.send('offer', { sdp: offer.sdp });
  }

  /**
   * Khách: Nhận Offer, gán RemoteDescription, tạo Answer và gửi đi
   */
  async handleOffer(sdp) {
    this.setupStartTime = performance.now();
    if (this.onLog) this.onLog('PC', 'Khách nhận Offer SDP, đang gán RemoteDescription...', { sdp, type: 'offer' });

    await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    // QUAN TRỌNG: Chỉ xả hàng đợi ICE candidates SAU KHI đã setLocalDescription(answer)
    // Nếu xả trước khi có localDescription, trình duyệt sẽ lỗi InvalidState hoặc bỏ rơi candidate
    await this._flushIceCandidateQueue();

    if (this.onLog) {
      this.onLog('PC', 'Đã gán LocalDescription (Answer) và gửi tới Chủ phòng', { sdp: answer.sdp, type: answer.type });
    }

    this.signaling.send('answer', { sdp: answer.sdp });
  }

  /**
   * Chủ phòng: Nhận Answer từ Khách
   */
  async handleAnswer(sdp) {
    if (this.onLog) this.onLog('PC', 'Chủ phòng nhận Answer SDP, đang gán RemoteDescription...', { sdp, type: 'answer' });

    await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
    await this._flushIceCandidateQueue();

    if (this.onLog) this.onLog('PC', 'Đã hoàn tất trao đổi SDP (Local & Remote descriptions sẵn sàng)');
  }

  /**
   * Xử lý ICE candidate từ đối tác (kèm hàng đợi chống race condition)
   */
  async handleRemoteIceCandidate(candidateObj) {
    if (!candidateObj) return;

    // Đảm bảo cả RemoteDescription và LocalDescription đều đã sẵn sàng trước khi addIceCandidate
    if (!this.pc || !this.pc.remoteDescription || !this.pc.localDescription) {
      if (this.onLog) this.onLog('ICE', 'Remote hoặc Local Description chưa sẵn sàng, đưa candidate vào hàng đợi...');
      this.iceCandidateQueue.push(candidateObj);
      return;
    }

    try {
      if (candidateObj.candidate || candidateObj.candidate === '') {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidateObj));
        if (this.onLog) this.onLog('ICE', `Đã thêm remote ICE candidate [${(candidateObj.candidate || 'end-of-candidates').slice(0, 40)}]`);
      }
    } catch (err) {
      if (this.onLog) this.onLog('ICE', `Lỗi thêm remote ICE candidate: ${err.message}`);
    }
  }

  /**
   * Đẩy toàn bộ candidate trong hàng đợi vào PeerConnection sau khi descriptions sẵn sàng
   */
  async _flushIceCandidateQueue() {
    if (this.iceCandidateQueue.length === 0) return;
    if (this.onLog) this.onLog('ICE', `Đang xả ${this.iceCandidateQueue.length} candidate trong hàng đợi...`);

    const queue = [...this.iceCandidateQueue];
    this.iceCandidateQueue = [];

    for (const cand of queue) {
      try {
        if (cand.candidate || cand.candidate === '') {
          await this.pc.addIceCandidate(new RTCIceCandidate(cand));
        }
      } catch (err) {
        if (this.onLog) this.onLog('ICE', `Lỗi xả ICE candidate: ${err.message}`);
      }
    }
  }

  /**
   * Bắt đầu timer 15 giây phát hiện kết nối thất bại
   */
  _startConnectionTimer() {
    this._clearConnectionTimer();
    this.connectTimeoutTimer = setTimeout(() => {
      if (!this.dc || this.dc.readyState !== 'open') {
        this._handleConnectionFailure('Quá thời gian 15 giây chưa thể thiết lập kết nối trực tiếp.');
      }
    }, 15000);
  }

  _clearConnectionTimer() {
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }
  }

  _handleConnectionFailure(customMsg) {
    this._clearConnectionTimer();
    const reason = customMsg || 'Không thể kết nối trực tiếp (có thể do NAT đối xứng/mạng 4G – cần TURN).';
    if (this.onLog) this.onLog('PC', `❌ Cảnh báo: ${reason}`);
    if (this.onConnectionStateChange) {
      this.onConnectionStateChange('failed', reason);
    }
  }

  /**
   * Thăm dò RTCPeerConnection stats định kỳ mỗi 2 giây
   */
  _startStatsPolling() {
    this._stopStatsPolling();
    this._pollStats(); // Lần đầu tiên chạy ngay
    this.statsInterval = setInterval(() => {
      this._pollStats();
    }, 2000);
  }

  _stopStatsPolling() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  async _pollStats() {
    if (!this.pc) return;
    try {
      const stats = await this.pc.getStats();
      let selectedPair = null;
      let localCand = null;
      let remoteCand = null;

      // Tìm candidate-pair đang được dùng (nominated và state === succeeded)
      stats.forEach(report => {
        if (report.type === 'candidate-pair' && (report.nominated || report.state === 'succeeded' || report.selected)) {
          selectedPair = report;
        }
      });

      if (!selectedPair) {
        // Fallback: tìm pair bất kỳ có bytesSent > 0
        stats.forEach(report => {
          if (report.type === 'candidate-pair' && report.bytesSent > 0) {
            selectedPair = report;
          }
        });
      }

      if (selectedPair) {
        localCand = stats.get(selectedPair.localCandidateId);
        remoteCand = stats.get(selectedPair.remoteCandidateId);
      }

      let candidateType = localCand?.candidateType || 'unknown';
      let typeLabel = 'Đang xác định...';
      if (candidateType === 'host') typeLabel = 'Mạng nội bộ (LAN)';
      else if (candidateType === 'srflx') typeLabel = 'Public IP qua STUN';
      else if (candidateType === 'relay') typeLabel = 'Qua TURN';
      else if (candidateType === 'prflx') typeLabel = 'Peer Reflexive';

      this.activeCandidateType = candidateType;

      const rttMs = selectedPair?.currentRoundTripTime != null
        ? Math.round(selectedPair.currentRoundTripTime * 1000)
        : (selectedPair?.roundTripTime ? Math.round(selectedPair.roundTripTime * 1000) : null);

      const statsData = {
        candidateType,
        typeLabel,
        rttMs,
        localCandidate: localCand,
        remoteCandidate: remoteCand,
        setupDurationMs: this.setupDurationMs,
        bytesSent: selectedPair?.bytesSent || 0,
        bytesReceived: selectedPair?.bytesReceived || 0
      };

      if (this.onStatsUpdate) {
        this.onStatsUpdate(statsData);
      }
    } catch (e) {
      // bỏ qua lỗi stats khi PC đóng
    }
  }

  /**
   * Dọn dẹp toàn bộ kết nối WebRTC khi rời phòng
   */
  destroy() {
    this._clearConnectionTimer();
    this._stopStatsPolling();

    if (this.dc) {
      try {
        this.dc.close();
      } catch (e) {}
      this.dc = null;
    }

    if (this.pc) {
      try {
        this.pc.close();
      } catch (e) {}
      this.pc = null;
    }

    this.iceCandidateQueue = [];
    this.setupStartTime = null;
    this.setupDurationMs = null;
  }
}
