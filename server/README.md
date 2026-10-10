# 🖥️ Server – Signaling & HTTP Relay cho P2P File Sharing

Server chịu trách nhiệm 3 nhiệm vụ chính theo đề tài WebRTC P2P:
1. **Phục vụ Web tĩnh**: Phục vụ toàn bộ giao diện HTML/CSS/JS từ thư mục `client/`.
2. **Signaling Server qua WebSocket (`/ws`)**: Thiết lập và quản lý phòng 1-1, kiểm duyệt khách vào phòng và chuyển tiếp các thông điệp bắt tay WebRTC (`offer`, `answer`, `ice-candidate`).
3. **HTTP Relay (Chế độ đối chứng)**: Nhận file tải lên bằng kỹ thuật stream thẳng xuống đĩa (không tốn RAM), cho phép bên kia tải về để đo và so sánh tốc độ với P2P WebRTC.

---

## 🚀 Công nghệ sử dụng

- **Runtime**: Node.js 20+ (chuẩn ECMAScript Modules - ESM).
- **Web Framework**: Express 4.x.
- **WebSocket**: Thư viện `ws` chuẩn RFC 6455.
- **Zero Heavy Dependencies**: Sử dụng tối đa các module có sẵn của Node.js (`node:stream/promises`, `node:crypto`, `node:fs`, `node:test`).

---

## 📂 Cấu trúc thư mục

```text
server/
├── package.json         # Cấu hình project, script chạy và danh sách thư viện
├── .env.example         # Template biến môi trường
├── src/
│   ├── index.js         # Điểm khởi động HTTP & WebSocket Server
│   ├── config.js        # Đọc và chuẩn hóa cấu hình từ biến môi trường
│   ├── rooms.js         # RoomManager: Máy trạng thái quản lý phòng (open, pending, full)
│   ├── signaling.js     # WebSocketServer: Validate hợp đồng giao thức, rate limit, heartbeat
│   ├── relay.js         # Router Relay: Upload/Download stream, bộ dọn file tự động (sweeper)
│   └── stats.js         # Bộ đếm lưu lượng băng thông phục vụ từng phòng
├── test/
│   ├── rooms.test.js    # Unit test máy trạng thái phòng (10 test cases)
│   └── signaling.test.js# Integration test WebSocket signaling với 2 client giả lập
└── deploy/
    ├── Caddyfile        # Cấu hình reverse proxy Caddy tự động cấp phát HTTPS Let's Encrypt
    ├── p2p-share.service# File dịch vụ systemd chạy nền tự khởi động
    └── deploy.sh        # Script tự động cập nhật và restart server trên Linux
```

---

## 📋 Hợp đồng giao thức (Protocol Contract)

### 1. WebSocket `/ws`

Giao tiếp bằng chuỗi JSON có trường `type`, kích thước tối đa 64 KB/tin nhắn:

| Tin nhắn Client gửi | Tham số | Ý nghĩa |
|---|---|---|
| `create-room` | `nickname` | Tạo phòng mới, nhận mã 6 ký tự |
| `join-room` | `roomCode`, `nickname` | Xin vào phòng đã có |
| `join-decision` | `accept` (boolean) | Chủ phòng phản hồi duyệt (Chấp nhận / Từ chối) |
| `peer-ready` | – | Khách báo đã dựng xong RTCPeerConnection |
| `offer` | `sdp` (string) | Chủ phòng gửi Offer SDP |
| `answer` | `sdp` (string) | Khách gửi Answer SDP |
| `ice-candidate` | `candidate` (object) | Cả hai phía gửi ứng viên ICE |
| `relay-report` | `fileId`, `downloadMs`, `ok` | Khách báo cáo kết quả tải qua server |
| `leave-room` | – | Rời khỏi phòng hiện tại |

| Tin nhắn Server trả về | Tham số | Ý nghĩa |
|---|---|---|
| `room-created` | `roomCode`, `peerId` | Gửi cho chủ phòng khi tạo thành công |
| `join-pending` | `roomCode`, `peerId` | Báo cho khách đã gửi yêu cầu thành công |
| `join-request` | `peerId`, `nickname` | Báo cho chủ phòng có người xin vào |
| `join-accepted` | `hostNickname` | Báo cho khách biết đã được chấp thuận |
| `join-rejected` | `reason`: `host-declined` \| `timeout` | Khách bị từ chối hoặc hết giờ duyệt |
| `offer` / `answer` / `ice-candidate` | `...`, `from` | Forward nguyên vẹn cho bên còn lại kèm `from` |
| `relay-file-available` | `fileId`, `fileName`, `fileSize`, `sha256`, `uploadMs` | Báo cho bên còn lại file đã upload xong |
| `peer-left` | `peerId`, `nickname` | Báo cho người còn lại đối tác đã thoát |
| `room-closed` | `reason` | Báo cho khách biết chủ phòng đã đóng phòng |
| `error` | `code`, `message` | Báo lỗi (`ROOM_NOT_FOUND`, `ROOM_FULL`, `RATE_LIMITED`...) |

### 2. HTTP REST Endpoints

- `GET /healthz`: Kiểm tra trạng thái hoạt động (trả `200 ok`).
- `GET /api/config`: Trả về danh sách ICE STUN servers và giới hạn kích thước file.
- `POST /api/relay/:roomCode/upload`:
  - Headers bắt buộc: `X-Peer-Id`, `X-File-Name` (encoded), `X-File-Sha256`, `Content-Length`.
  - Body: Bytes nhị phân thô (`application/octet-stream`).
  - Trả về: `201 { fileId, size, receivedMs }`.
- `GET /api/relay/:roomCode/:fileId?peerId=<id>`: Tải file nhị phân kèm header `Content-Disposition`.
- `GET /api/stats/:roomCode`: Trả về `{ signalingBytes, relayUploadBytes, relayDownloadBytes }`.

---

## 🛠️ Cài đặt và Chạy cục bộ (Local Development)

### 1. Cài đặt các gói phụ thuộc:
```bash
npm install
```

### 2. Cấu hình biến môi trường:
Tạo file `.env` từ file mẫu:
```bash
cp .env.example .env
```

Các thông số cấu hình:
```env
PORT=3000                     # Cổng chạy ứng dụng
HOST=127.0.0.1                # Địa chỉ lắng nghe
CLIENT_DIR=../client          # Thư mục web tĩnh client
RELAY_DIR=./tmp/relay         # Thư mục lưu file tạm relay
MAX_FILE_SIZE=104857600       # Giới hạn file tối đa (100 MB)
MAX_RELAY_STORAGE=524288000   # Tổng dung lượng tối đa cho file tạm (500 MB)
RELAY_TTL_MS=600000           # Thời gian sống của file relay (10 phút)
JOIN_TIMEOUT_MS=60000         # Hạn chờ chủ phòng duyệt (60 giây)
MAX_ROOMS=200                 # Giới hạn số phòng đồng thời
```

### 3. Chạy Server:
```bash
npm start
```
Mở trình duyệt tại: `http://localhost:3000`

### 4. Chạy kiểm thử tự động (Unit & Integration Tests):
```bash
npm test
```
Tất cả 14 test cases sẽ được thực thi bằng test runner có sẵn của Node.js (`node --test`).

---

## ☁️ Hướng dẫn Triển khai Production (Oracle Cloud VM)

WebRTC và Web Crypto bắt buộc phải có **HTTPS** để chạy trên Internet.

### Bước 1: Mở Port trên Oracle Cloud & VM Firewall
1. **Oracle Cloud Console**: Mở Ingress Rule cho TCP port `80` và `443` (CIDR `0.0.0.0/0`).
2. **Trên VM Linux**:
   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```

### Bước 2: Thiết lập Caddy Reverse Proxy
Cài đặt Caddy và chỉnh sửa `/etc/caddy/Caddyfile` sử dụng file mẫu trong `deploy/Caddyfile`:
```caddy
your-domain.duckdns.org {
    reverse_proxy 127.0.0.1:3000
}
```
Khởi động lại Caddy:
```bash
sudo systemctl restart caddy
```
Caddy sẽ tự động cấp chứng chỉ SSL Let's Encrypt hoàn toàn miễn phí.

### Bước 3: Cấu hình Systemd Service
Copy file cấu hình service:
```bash
sudo cp deploy/p2p-share.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now p2p-share
```
Kiểm tra trạng thái server:
```bash
sudo systemctl status p2p-share
```
