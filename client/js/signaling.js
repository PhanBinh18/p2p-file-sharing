/**
 * Quản lý kết nối Signaling WebSocket giữa Client và Server
 */

const ERROR_MESSAGES = {
  INVALID_MESSAGE: 'Định dạng tin nhắn không hợp lệ',
  INVALID_NICKNAME: 'Biệt danh không hợp lệ (1–20 ký tự, không chứa ký tự điều khiển)',
  ROOM_NOT_FOUND: 'Không tìm thấy phòng',
  ROOM_FULL: 'Phòng đã đủ người hoặc đang có người chờ duyệt',
  NOT_HOST: 'Chỉ chủ phòng mới có quyền thực hiện thao tác này',
  NOT_IN_ROOM: 'Bạn hiện không ở trong phòng nào',
  INVALID_STATE: 'Trạng thái phòng không hợp lệ cho thao tác này',
  RATE_LIMITED: 'Bạn đang thao tác quá nhanh, vui lòng chờ giây lát'
};

export class SignalingClient {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.onLog = null; // Callback ghi log
    this.onCloseCallback = null;
    this.isConnected = false;
  }

  /**
   * Đăng ký callback ghi log
   */
  setLogHandler(fn) {
    this.onLog = fn;
  }

  /**
   * Đăng ký callback khi kết nối bị đóng
   */
  setOnClose(fn) {
    this.onCloseCallback = fn;
  }

  /**
   * Mở kết nối WebSocket tới server
   * @param {string} [customUrl]
   * @returns {Promise<void>}
   */
  connect(customUrl) {
    return new Promise((resolve, reject) => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }

      let url = customUrl;
      if (!url) {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host || 'localhost:3000';
        url = `${proto}//${host}/ws`;
      }

      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        reject(err);
        return;
      }

      this.ws.onopen = () => {
        this.isConnected = true;
        if (this.onLog) this.onLog('WS', `Đã kết nối tới signaling server: ${url}`);
        resolve();
      };

      this.ws.onmessage = (event) => {
        this._handleMessage(event.data);
      };

      this.ws.onerror = (err) => {
        if (this.onLog) this.onLog('WS', `Lỗi kết nối WebSocket`);
      };

      this.ws.onclose = (event) => {
        const wasConnected = this.isConnected;
        this.isConnected = false;
        if (this.onLog) this.onLog('WS', `WebSocket đóng (code: ${event.code}, lý do: ${event.reason || 'không rõ'})`);
        if (this.onCloseCallback) {
          this.onCloseCallback({ code: event.code, reason: event.reason, wasConnected });
        }
      };
    });
  }

  /**
   * Đăng ký hàm xử lý theo loại message
   * @param {string} type
   * @param {Function} handler
   */
  on(type, handler) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type).add(handler);
  }

  /**
   * Hủy đăng ký hàm xử lý
   * @param {string} type
   * @param {Function} handler
   */
  off(type, handler) {
    if (this.handlers.has(type)) {
      this.handlers.get(type).delete(handler);
    }
  }

  /**
   * Gửi message tới server qua WebSocket
   * @param {string} type
   * @param {object} payload
   */
  send(type, payload = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket chưa được kết nối hoặc đã bị đóng');
    }

    const msg = { type, ...payload };
    const jsonStr = JSON.stringify(msg);

    if (this.onLog) {
      let preview = type;
      if (type === 'create-room' || type === 'join-room') {
        preview = `${type} [nick: ${payload.nickname}${payload.roomCode ? ', room: ' + payload.roomCode : ''}]`;
      } else if (type === 'offer' || type === 'answer') {
        preview = `${type} (SDP length: ${payload.sdp?.length || 0} bytes)`;
      } else if (type === 'ice-candidate') {
        preview = `${type} (${payload.candidate?.candidate?.slice(0, 50) || 'null'})`;
      }
      this.onLog('WS↑', preview, msg);
    }

    this.ws.send(jsonStr);
  }

  /**
   * Đóng kết nối WebSocket
   */
  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {
        // bỏ qua
      }
      this.ws = null;
      this.isConnected = false;
    }
  }

  /**
   * Xử lý gói tin nhận từ server
   * @private
   */
  _handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      if (this.onLog) this.onLog('WS↓', `Lỗi parse JSON: ${data}`);
      return;
    }

    if (!msg || typeof msg !== 'object' || !msg.type) {
      return;
    }

    if (this.onLog) {
      let preview = msg.type;
      if (msg.type === 'error') {
        const viMsg = ERROR_MESSAGES[msg.code] || msg.message;
        preview = `error [${msg.code}]: ${viMsg}`;
      } else if (msg.type === 'room-created' || msg.type === 'join-pending') {
        preview = `${msg.type} [roomCode: ${msg.roomCode}, peerId: ${msg.peerId}]`;
      } else if (msg.type === 'offer' || msg.type === 'answer') {
        preview = `${msg.type} (từ ${msg.from}, SDP len: ${msg.sdp?.length || 0})`;
      } else if (msg.type === 'ice-candidate') {
        preview = `${msg.type} (từ ${msg.from})`;
      }
      this.onLog('WS↓', preview, msg);
    }

    // Kích hoạt các handler đã đăng ký cho loại message này
    const set = this.handlers.get(msg.type);
    if (set && set.size > 0) {
      for (const handler of set) {
        try {
          handler(msg);
        } catch (err) {
          console.error(`Lỗi trong handler cho message '${msg.type}':`, err);
        }
      }
    }

    // Kích hoạt handler '*' (bắt tất cả) nếu có
    const allSet = this.handlers.get('*');
    if (allSet && allSet.size > 0) {
      for (const handler of allSet) {
        try {
          handler(msg);
        } catch (err) {
          console.error(`Lỗi trong handler '*':`, err);
        }
      }
    }
  }

  /**
   * Lấy thông báo lỗi thân thiện bằng tiếng Việt
   */
  static getFriendlyErrorMessage(code, defaultMsg) {
    return ERROR_MESSAGES[code] || defaultMsg || 'Đã có lỗi xảy ra';
  }
}
