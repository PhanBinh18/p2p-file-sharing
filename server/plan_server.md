# PLAN SERVER – P2P File Sharing (WebRTC, đề tài T10)

> Dành cho agent làm **server**. Client được làm song song theo `PLAN_CLIENT.md`. Hai bên chỉ giao tiếp qua **Hợp đồng giao thức (mục 2)**. Không tự ý đổi hợp đồng; nếu cần đổi, dừng lại và báo người dùng.

## 1. Mục tiêu và phạm vi

Server làm 3 việc:

1. **Phục vụ web tĩnh** (thư mục `client/`).
2. **Signaling qua WebSocket**: tạo phòng bằng mã 6 ký tự, phòng 1-1 (chủ phòng + 1 khách), chủ phòng phải xác nhận trước khi khách vào, sau đó chuyển tiếp `offer` / `answer` / `ice-candidate`. Server **không đọc, không hiểu SDP**, chỉ forward.
3. **Relay HTTP (chế độ đối chứng)**: nhận file upload rồi cho bên kia tải về, để client đo và so sánh tốc độ "qua server" với "P2P". Giới hạn file **100 MB**.

Không làm: database, đăng nhập, TURN (làm sau), nhiều phòng nhiều người, reconnect.

## 2. Hợp đồng giao thức (GIỮ GIỐNG HỆT trong PLAN_CLIENT.md)

### 2.1 WebSocket `/ws`

- Cùng origin với trang web. Dev: `ws://localhost:3000/ws`. Production: `wss://<domain>/ws`.
- Mỗi message là một JSON object có trường `type`. Tối đa 64 KB/message.
- Server cấp `peerId` (UUID v4) khi tạo/vào phòng. Kết nối WS được gắn với `peerId` đó, nên client không gửi lại `peerId` qua WS.
- Không có reconnect: WS đứt = rời phòng.
- Mã phòng: 6 ký tự từ bảng `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (32 ký tự, bỏ I/O/0/1), sinh bằng `crypto.randomInt`. Khi nhập, so khớp không phân biệt hoa thường.
- Nickname: sau `trim` dài 1–20 ký tự, không chứa ký tự điều khiển.

**Client → Server**

| type | trường | ghi chú |
|---|---|---|
| `create-room` | `nickname` | |
| `join-room` | `roomCode`, `nickname` | |
| `join-decision` | `accept` (boolean) | chỉ chủ phòng; trả lời khách đang chờ |
| `peer-ready` | – | khách báo đã dựng xong RTCPeerConnection |
| `offer` | `sdp` (string) | chỉ chủ phòng gửi |
| `answer` | `sdp` (string) | chỉ khách gửi |
| `ice-candidate` | `candidate` (object từ `RTCIceCandidate.toJSON()`) | cả hai phía |
| `relay-report` | `fileId`, `downloadMs`, `ok` | người nhận báo kết quả tải qua server |
| `leave-room` | – | |

**Server → Client**

| type | trường | gửi cho | ghi chú |
|---|---|---|---|
| `room-created` | `roomCode`, `peerId` | chủ phòng | |
| `join-pending` | `roomCode`, `peerId` | khách | đã gửi yêu cầu, chờ chủ phòng |
| `join-request` | `peerId`, `nickname` | chủ phòng | |
| `join-accepted` | `hostNickname` | khách | khách dựng PC rồi gửi `peer-ready` |
| `join-rejected` | `reason`: `host-declined` \| `timeout` | khách | |
| `peer-ready` | `peerId`, `nickname` | chủ phòng | chủ phòng tạo DataChannel + offer |
| `offer` / `answer` / `ice-candidate` | giữ nguyên trường + thêm `from` (peerId) | bên còn lại | forward nguyên vẹn |
| `relay-file-available` | `fileId`, `fileName`, `fileSize`, `sha256`, `uploadMs` | bên không upload | |
| `relay-report` | `fileId`, `downloadMs`, `ok` | bên upload | forward từ người nhận |
| `peer-left` | `peerId`, `nickname` | người còn lại | |
| `room-closed` | `reason` | khách | chủ phòng đã thoát |
| `error` | `code`, `message` | người gửi | |

Mã lỗi: `INVALID_MESSAGE`, `INVALID_NICKNAME`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `NOT_HOST`, `NOT_IN_ROOM`, `INVALID_STATE`, `RATE_LIMITED`.

**Trình tự chuẩn**

1. A `create-room` → A nhận `room-created`.
2. B `join-room` → B nhận `join-pending`; A nhận `join-request`.
3. A `join-decision {accept:true}` → B nhận `join-accepted`. (Từ chối → B nhận `join-rejected`.)
4. B dựng RTCPeerConnection, gửi `peer-ready` → A nhận `peer-ready`.
5. A tạo DataChannel + offer → `offer` tới B → B `answer` tới A → hai bên trao `ice-candidate` (trickle).
6. DataChannel mở → client chuyển sang màn hình truyền file. Server không còn tham gia luồng dữ liệu.

### 2.2 HTTP

| Method + path | Mô tả |
|---|---|
| `GET /healthz` | trả `200 ok` |
| `GET /api/config` | `{ "iceServers": [{"urls":"stun:stun.l.google.com:19302"}], "maxFileSizeBytes": 104857600, "chunkSizeBytes": 16384 }` – để sau này thêm TURN mà không sửa client |
| `POST /api/relay/:roomCode/upload` | Header bắt buộc: `X-Peer-Id`, `X-File-Name` (đã `encodeURIComponent`), `X-File-Sha256` (hex), `Content-Length`. Body = bytes thô (`application/octet-stream`). Trả `201 {fileId, size, receivedMs}`. Lỗi: `400` thiếu header, `403` peerId không thuộc phòng, `404` phòng không tồn tại, `413` quá giới hạn |
| `GET /api/relay/:roomCode/:fileId?peerId=<id>` | Stream file về, có `Content-Length` và `Content-Disposition`. `403`/`404` tương tự |
| `GET /api/stats/:roomCode` | `{ signalingBytes, relayUploadBytes, relayDownloadBytes }` – để client minh họa "server gần như không tốn băng thông khi dùng P2P" |

Sau khi upload thành công, server gửi `relay-file-available` cho **bên còn lại** trong phòng.

## 3. Cấu trúc thư mục

```
p2p-share/
├─ server/
│  ├─ package.json            # "type": "module"; deps: express, ws
│  ├─ .env.example
│  ├─ src/
│  │  ├─ index.js             # khởi động http + ws
│  │  ├─ config.js            # đọc env
│  │  ├─ rooms.js             # RoomManager: logic thuần, không phụ thuộc ws
│  │  ├─ signaling.js         # WebSocketServer: validate + forward
│  │  ├─ relay.js             # route upload/download + dọn file
│  │  └─ stats.js             # bộ đếm byte theo phòng
│  ├─ test/
│  │  ├─ rooms.test.js
│  │  └─ signaling.test.js    # dùng node:test + client ws giả lập
│  └─ deploy/
│     ├─ Caddyfile
│     ├─ p2p-share.service
│     └─ deploy.sh
└─ client/                    # làm theo PLAN_CLIENT.md
```

Biến môi trường (`.env.example`): `PORT=3000`, `HOST=127.0.0.1`, `CLIENT_DIR=../client`, `RELAY_DIR=./tmp/relay`, `MAX_FILE_SIZE=104857600`, `RELAY_TTL_MS=600000`, `JOIN_TIMEOUT_MS=60000`, `MAX_ROOMS=200`.

## 4. Các giai đoạn

Mỗi giai đoạn xong phải qua tiêu chí nghiệm thu rồi mới sang giai đoạn tiếp.

### S1 – Khung server
- [ ] Node.js 20+ (ESM), `express` + `ws`. Không thêm framework khác.
- [ ] Serve static `CLIENT_DIR`, `GET /healthz`, `GET /api/config`.
- [ ] Đọc cấu hình từ env, có giá trị mặc định ở `config.js`.

**Nghiệm thu:** `npm start` chạy được; `curl localhost:3000/healthz` trả `ok`; `/api/config` trả đúng JSON ở mục 2.2.

### S2 – RoomManager (`rooms.js`)
Logic thuần, test được mà không cần mạng.
- [ ] Cấu trúc: `rooms: Map<code, {code, host:{peerId,nickname,ws}, guest|null, pending:{peerId,nickname,ws,timer}|null, createdAt, files:Map}>`.
- [ ] Trạng thái phòng: `open` (chưa có khách) → `pending` (có khách đang chờ duyệt, **chỉ cho 1**) → `full` (đủ 2 người).
- [ ] Sinh mã không trùng; trả `ROOM_NOT_FOUND` / `ROOM_FULL` đúng ngữ cảnh. Khách thứ hai vào khi đang `pending` hoặc `full` → `ROOM_FULL`.
- [ ] Timer `JOIN_TIMEOUT_MS` cho yêu cầu chờ; hết hạn → `join-rejected {reason:"timeout"}` và phòng về `open`.
- [ ] Khách rời: phòng về `open`, báo `peer-left` cho chủ phòng. Chủ phòng rời: gửi `room-closed` cho khách, hủy phòng, xóa file relay của phòng.
- [ ] Giới hạn `MAX_ROOMS`.

**Nghiệm thu:** unit test cho mọi chuyển trạng thái trên (vào, duyệt, từ chối, timeout, rời, chủ phòng rời, phòng đầy).

### S3 – Signaling WebSocket (`signaling.js`)
- [ ] `WebSocketServer({ noServer:true, maxPayload: 64*1024 })`, chỉ nhận upgrade ở path `/ws`; path khác thì `socket.destroy()`.
- [ ] Parse JSON an toàn; sai định dạng → `error INVALID_MESSAGE`. Validate nickname, roomCode.
- [ ] Ràng buộc quyền: `join-decision` và `offer` chỉ chủ phòng (`NOT_HOST`); `answer` chỉ khách; `offer/answer/ice-candidate` chỉ forward khi phòng ở trạng thái `full` và người gửi thuộc phòng (`NOT_IN_ROOM` / `INVALID_STATE`).
- [ ] `peer-ready` của khách được forward cho chủ phòng kèm `peerId`, `nickname`.
- [ ] Forward giữ nguyên `sdp` / `candidate`, chỉ thêm `from`.
- [ ] Heartbeat: gửi ping mỗi 30 s, không nhận pong thì `terminate()` và coi như rời phòng.
- [ ] Rate limit trong bộ nhớ theo IP (đọc IP từ `X-Forwarded-For` vì chạy sau Caddy): tối đa 10 `create-room`/phút và 20 `join-room`/phút → `RATE_LIMITED`.
- [ ] Mọi byte WS của phòng cộng vào `stats.signalingBytes`.

**Nghiệm thu:** test tích hợp với 2 client `ws` chạy đủ trình tự mục 2.1 (kể cả từ chối, timeout, khách thứ hai bị `ROOM_FULL`, ngắt kết nối giữa chừng).

### S4 – Relay HTTP (`relay.js`)
- [ ] Upload **stream thẳng xuống đĩa** bằng `stream/promises.pipeline` + một `Transform` đếm byte; không dùng body-parser cho route này, không đọc cả file vào RAM.
- [ ] Từ chối sớm bằng `Content-Length` > `MAX_FILE_SIZE` (`413`); trong lúc stream vẫn đếm byte và hủy nếu vượt.
- [ ] Lưu file theo `fileId` (UUID), **không dùng tên file làm đường dẫn**. Tên gốc chỉ lưu trong metadata để trả `Content-Disposition` (đã sanitize).
- [ ] Nếu client hủy giữa chừng (`aborted`/`close`), xóa file dở.
- [ ] Đo `receivedMs` (từ byte đầu tới khi ghi xong), trả trong response và trong `relay-file-available.uploadMs`.
- [ ] Download dùng `fs.createReadStream`, có `Content-Length`; cho phép cả hai thành viên của phòng tải.
- [ ] Quan trọng: Node có `server.requestTimeout` mặc định 300 s, upload chậm sẽ bị cắt. Đặt `server.requestTimeout = 0` (hoặc ≥ 15 phút) và `server.headersTimeout` hợp lý.
- [ ] Dọn file: sweeper mỗi 60 s xóa file quá `RELAY_TTL_MS`; xóa theo phòng khi phòng đóng; xóa toàn bộ `RELAY_DIR` khi server khởi động. Tổng dung lượng relay tối đa 500 MB (vượt thì `507` hoặc `413`).
- [ ] Cộng `relayUploadBytes` / `relayDownloadBytes` vào stats; `GET /api/stats/:roomCode`.

**Nghiệm thu:** `curl` upload file 50 MB thành công, tải về `sha256sum` trùng; file 101 MB bị `413`; ngắt giữa chừng không để lại file rác; theo dõi RAM của tiến trình không tăng theo kích thước file.

### S5 – Logging
- [ ] Log gọn, có timestamp: tạo phòng, vào phòng, duyệt/từ chối, forward offer/answer (không log nội dung SDP), rời phòng, upload/download (kích thước, thời gian). Không log toàn bộ ICE candidate (chứa IP).

### S6 – Test tự động
- [ ] `npm test` chạy `node --test` cho `rooms.test.js` và `signaling.test.js`, tất cả pass.

### S7 – Deploy lên Oracle VM

**Lý do bắt buộc có HTTPS:** client dùng `crypto.subtle` (SHA-256), API này **chỉ tồn tại ở secure context** (HTTPS hoặc `localhost`). Chạy HTTP thuần trên IP công cộng sẽ làm `crypto.subtle` là `undefined`. Khi trang là HTTPS thì WS phải là `wss://`.

1. **Tên miền:** dùng domain sẵn có hoặc subdomain miễn phí DuckDNS trỏ về public IP của VM. Nên đặt Reserved Public IP để IP không đổi.
2. **Mở cổng (làm cả hai lớp, thiếu một lớp là không vào được):**
   - Oracle Cloud Console → VCN → Security List (hoặc NSG): ingress TCP 80 và 443 từ `0.0.0.0/0`.
   - Trên VM: image Ubuntu của Oracle có sẵn rule iptables chặn; thêm rule cho 80/443 trước rule REJECT rồi lưu (`netfilter-persistent save`). Nếu dùng Oracle Linux thì dùng `firewall-cmd --permanent --add-service=http --add-service=https`.
3. **Cài đặt:** Node.js 20/22 LTS, Caddy (từ repo chính thức).
4. **Caddy:** `deploy/Caddyfile`
   ```
   <domain-cua-ban> {
       reverse_proxy 127.0.0.1:3000
   }
   ```
   Caddy tự xin và gia hạn chứng chỉ Let's Encrypt, tự xử lý nâng cấp WebSocket.
5. **Node chạy bằng systemd:** `deploy/p2p-share.service` (User không phải root, `WorkingDirectory=/opt/p2p-share/server`, `Environment=NODE_ENV=production PORT=3000 HOST=127.0.0.1`, `ExecStart=/usr/bin/node src/index.js`, `Restart=always`). Server chỉ lắng nghe `127.0.0.1`, Internet chỉ vào qua Caddy.
6. **`deploy/deploy.sh`:** `git pull` (hoặc rsync) → `npm ci --omit=dev` → `systemctl restart p2p-share`.
7. **Ghi chú cho giai đoạn TURN sau này (chưa làm):** coturn cần mở UDP/TCP 3478 và một dải cổng UDP relay ở cả Security List lẫn iptables.

**Nghiệm thu:** mở `https://<domain>` từ 2 thiết bị khác nhau, tạo phòng → vào phòng → duyệt thành công; `curl https://<domain>/healthz` trả `ok`; reboot VM thì dịch vụ tự lên lại.

## 5. Quy ước code

- ESM, không TypeScript, không bundler. Comment tiếng Việt ở những chỗ giải thích cơ chế (để người dùng đọc lại khi thuyết trình).
- Tách logic phòng (`rooms.js`) khỏi tầng mạng để dễ test.
- Không lưu trạng thái ra đĩa ngoài file relay tạm. Khởi động lại server = mất hết phòng, chấp nhận được.

## 6. Định nghĩa hoàn thành

- `npm test` pass; chạy được local theo S1–S6.
- Deploy chạy thật trên Oracle theo S7.
- Với client thật (làm theo PLAN_CLIENT.md): hai trình duyệt hoàn tất trình tự mục 2.1 và relay 50 MB hoạt động qua HTTPS.