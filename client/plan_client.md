# PLAN CLIENT – P2P File Sharing (WebRTC, đề tài T10)

> Dành cho agent làm **client** (trình duyệt). Server được làm song song theo `PLAN_SERVER.md`. Hai bên chỉ giao tiếp qua **Hợp đồng giao thức (mục 2)**. Không tự ý đổi hợp đồng; nếu cần đổi, dừng lại và báo người dùng. Khi server chưa sẵn sàng, tự dựng một mock server nhỏ cho đúng hợp đồng để chạy thử.

## 1. Mục tiêu và phạm vi

Một trang web (JavaScript thuần, không framework, không bundler) cho phép:

1. Nhập nickname, **tạo phòng** (nhận mã 6 ký tự) hoặc **vào phòng** bằng mã.
2. Chủ phòng thấy yêu cầu "X muốn vào phòng" và bấm **Cho phép / Từ chối**. Cho phép xong thì bắt tay WebRTC tự động.
3. Sau khi DataChannel mở: **gửi file P2P** (chia chunk 16 KB, backpressure, kiểm tra SHA-256).
4. **Gửi file qua server** (upload rồi bên kia tải về) để **so sánh tốc độ** với P2P trên cùng một file.
5. Hiển thị quá trình bắt tay và log kỹ thuật để phục vụ thuyết trình (SDP, ICE candidate, loại đường truyền đang dùng).

Không làm: video call, nhiều người trong phòng, TURN (sẽ thêm sau qua `/api/config`), reconnect.

## 2. Hợp đồng giao thức (GIỮ GIỐNG HỆT trong PLAN_SERVER.md)

### 2.1 WebSocket `/ws`

- Cùng origin với trang web. Dev: `ws://localhost:3000/ws`. Production: `wss://<domain>/ws`. Chọn `ws`/`wss` theo `location.protocol`.
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

## 3. Giao thức truyền file trên DataChannel (nội bộ giữa hai client)

Một DataChannel tên `file`, `binaryType = "arraybuffer"`, **ordered + reliable**. Mỗi lúc chỉ truyền **một file**, các file khác xếp hàng ở bên gửi.

Message văn bản (JSON, trường `t`):

| t | trường | hướng |
|---|---|---|
| `file-meta` | `id`, `name`, `size`, `mime`, `chunkSize` (16384), `totalChunks`, `sha256` | gửi → nhận |
| `file-accept` / `file-reject` | `id` (+ `reason`) | nhận → gửi |
| `file-end` | `id` | gửi → nhận, sau chunk cuối |
| `file-result` | `id`, `ok`, `sha256Received`, `recvMs` | nhận → gửi |
| `file-cancel` | `id` | cả hai |

Message nhị phân: `ArrayBuffer` chunk thô (không header), chunk cuối có thể nhỏ hơn 16384. Vì kênh ordered + reliable và chỉ một file mỗi lúc, bên nhận chỉ cần nối chunk theo thứ tự đến.

## 4. Cấu trúc thư mục

```
client/
├─ index.html
├─ css/style.css
└─ js/
   ├─ main.js            # khởi động, điều phối trạng thái ứng dụng
   ├─ ui.js              # thao tác DOM, modal, toast, stepper, log panel
   ├─ signaling.js       # bọc WebSocket: connect, send, on(type, handler)
   ├─ peer.js            # RTCPeerConnection + DataChannel + ICE + getStats
   ├─ transfer-p2p.js    # gửi/nhận file qua DataChannel
   ├─ transfer-relay.js  # upload/download qua server (XHR)
   ├─ benchmark.js       # chạy so sánh và tính kết quả
   ├─ hash.js            # SHA-256 bằng crypto.subtle
   └─ util.js            # định dạng byte/tốc độ/thời gian, uuid, now()
```

ES Modules (`<script type="module">`). Không thư viện ngoài. Giao diện **tiếng Việt**, responsive dùng được trên điện thoại.

## 5. Các giai đoạn

### C1 – Khung giao diện và lobby
- [ ] Màn hình Lobby: ô nickname (validate 1–20 ký tự), nút **Tạo phòng**, ô nhập mã + nút **Vào phòng** (tự viết hoa, giới hạn 6 ký tự).
- [ ] Các màn hình/trạng thái: `lobby` → `waiting-host` / `waiting-guest` → `connecting` → `connected`. Mỗi trạng thái chỉ hiện đúng phần UI của nó.
- [ ] Kiểm tra `window.isSecureContext` và `crypto.subtle`; nếu thiếu thì hiện cảnh báo rõ ràng "cần HTTPS hoặc localhost".

**Nghiệm thu:** chuyển được qua lại các màn hình bằng dữ liệu giả; nickname sai bị chặn.

### C2 – Signaling client (`signaling.js`)
- [ ] Kết nối `/ws` theo `location.protocol`; API: `connect()`, `send(type, payload)`, `on(type, fn)`, `close()`.
- [ ] Parse JSON an toàn; message `error` hiện toast thân thiện theo `code` (ví dụ `ROOM_NOT_FOUND` → "Không tìm thấy phòng", `ROOM_FULL` → "Phòng đã đủ người").
- [ ] WS đóng bất ngờ → thông báo và về lobby.

**Nghiệm thu:** gửi/nhận được `create-room` → `room-created` với server thật hoặc mock.

### C3 – Luồng phòng và xác nhận
- [ ] **Chủ phòng:** hiển thị mã phòng to, nút copy, trạng thái "Đang chờ khách…". Khi nhận `join-request` hiện **modal** "<nickname> muốn vào phòng" với **Cho phép / Từ chối**; gửi `join-decision`.
- [ ] **Khách:** sau `join-pending` hiện "Đang chờ chủ phòng chấp nhận…" (có nút Hủy = `leave-room`). Nhận `join-rejected` → báo lý do và về lobby.
- [ ] Hiển thị tên đối tác khi đã vào.
- [ ] `peer-left` / `room-closed` → báo và về lobby, đóng RTCPeerConnection nếu có.

**Nghiệm thu:** hai tab chạy được toàn bộ trình tự bước 1–3 của mục 2.1, gồm cả từ chối và timeout.

### C4 – Bắt tay WebRTC (`peer.js`)
- [ ] Lấy `iceServers` từ `GET /api/config`, tạo `new RTCPeerConnection({ iceServers })`.
- [ ] **Khách:** nhận `join-accepted` → tạo PC, gắn `pc.ondatachannel`, gửi `peer-ready`.
- [ ] **Chủ phòng:** nhận `peer-ready` → `pc.createDataChannel("file", { ordered: true })` → `createOffer` → `setLocalDescription` → gửi `offer`.
- [ ] **Khách** nhận `offer` → `setRemoteDescription` → `createAnswer` → `setLocalDescription` → gửi `answer`. **Chủ phòng** nhận `answer` → `setRemoteDescription`.
- [ ] **Trickle ICE:** `pc.onicecandidate` gửi từng candidate qua `ice-candidate` (bỏ qua `null`). Phía nhận: nếu `remoteDescription` chưa được set thì **đưa candidate vào hàng đợi**, set xong mới `addIceCandidate` hết hàng đợi (tránh race condition).
- [ ] Theo dõi `connectionState` / `iceConnectionState`. Nếu `failed` hoặc quá 15 s chưa kết nối: hiện "Không thể kết nối trực tiếp (có thể do NAT đối xứng/mạng 4G – cần TURN)" và nút về lobby.
- [ ] Khi DataChannel `open`: chuyển sang `connected`.
- [ ] **Thông tin kết nối:** dùng `pc.getStats()` lấy candidate-pair đang dùng (`nominated`/`succeeded`), đọc `candidateType` của local và remote, hiển thị nhãn: `host` = "Mạng nội bộ (LAN)", `srflx` = "Public IP qua STUN", `relay` = "Qua TURN". Cập nhật RTT (`currentRoundTripTime`) mỗi 2 s. Đo và hiển thị **thời gian thiết lập kết nối** (từ lúc tạo offer/nhận offer đến khi DataChannel open).
- [ ] Dọn dẹp: đóng DataChannel, PC, hủy interval khi rời phòng.

**Nghiệm thu:** hai tab cùng máy và hai thiết bị cùng Wi-Fi mở được DataChannel; gửi thử một chuỗi "ping/pong" qua kênh; UI hiển thị đúng loại candidate.

### C5 – Truyền file P2P (`transfer-p2p.js`, `hash.js`)

**Chuẩn bị file (bên gửi):**
- [ ] Chọn file bằng nút hoặc kéo-thả. Từ chối file rỗng hoặc lớn hơn `maxFileSizeBytes`, báo rõ.
- [ ] Tính SHA-256 **ngay khi chọn file** (`crypto.subtle.digest("SHA-256", await file.arrayBuffer())`), hiện "Đang tính mã băm…". Thời gian băm **không** được tính vào thời gian truyền.

**Gửi:**
- [ ] Gửi `file-meta`, chờ `file-accept` (hoặc `file-reject`).
- [ ] Đọc file theo **khối 1 MB** bằng `file.slice(o, o + 1MB).arrayBuffer()`, rồi cắt thành chunk **16 384 byte** để `dc.send()`. (Đọc khối lớn giảm số lần `await`, nhanh hơn đọc từng chunk 16 KB.)
- [ ] **Backpressure:** `HIGH_WATER = 1 MiB`, `dc.bufferedAmountLowThreshold = 256 KiB`. Trước mỗi lần gửi, nếu `dc.bufferedAmount > HIGH_WATER` thì dừng vòng lặp và `await` sự kiện `bufferedamountlow`. Các hằng số đặt ở đầu file để chỉnh khi demo.
- [ ] Gửi `file-end` sau chunk cuối, chờ `file-result`.
- [ ] Hiển thị thanh tiến trình, tốc độ tức thời, dung lượng đã gửi. Cập nhật UI tối đa ~10 lần/giây (throttle), không cập nhật mỗi chunk.
- [ ] Nút Hủy gửi `file-cancel`.

**Nhận:**
- [ ] Nhận `file-meta` → hiện hộp "X muốn gửi file `<tên>` (`<dung lượng>`) – Nhận / Từ chối". Có checkbox **"Tự động nhận (chế độ so sánh)"**. Gửi `file-accept`/`file-reject`.
- [ ] Gom chunk vào mảng `ArrayBuffer[]`, cộng dồn số byte. Đo `recvMs` từ chunk đầu tiên đến chunk cuối.
- [ ] Khi nhận `file-end`: kiểm tra đủ `size`, tạo `Blob`, tính SHA-256 trên dữ liệu vừa ráp, so với `sha256` trong meta, gửi `file-result { ok, sha256Received, recvMs }`.
- [ ] Hiển thị ✅/❌ toàn vẹn và hai chuỗi băm (rút gọn, bấm xem đầy đủ). Nếu ok: nút **Lưu file** (tạo `<a download>` từ `URL.createObjectURL`, nhớ `revokeObjectURL`).
- [ ] Ngắt kết nối giữa chừng → hủy truyền, báo lỗi, giải phóng bộ nhớ.

**Nghiệm thu:** gửi file 1 KB, 1 MB, 50 MB, 100 MB giữa hai tab, mã băm trùng; file 0 byte và file 101 MB bị từ chối; thêm log/assert khi chạy dev: `bufferedAmount` không bao giờ vượt `HIGH_WATER + 1 MB`, và bộ nhớ trang không phình quá nhiều so với kích thước file.

### C6 – Truyền file qua server (`transfer-relay.js`)
- [ ] **Upload bằng `XMLHttpRequest`** (không dùng `fetch`, vì `fetch` không có tiến trình upload). Gửi trực tiếp `File` làm body, kèm các header ở mục 2.2 (`X-Peer-Id`, `X-File-Name` đã `encodeURIComponent`, `X-File-Sha256` dùng lại mã băm đã tính ở C5). Dùng `xhr.upload.onprogress` để hiển thị tiến trình. Đo `uploadMs` từ `send()` đến khi nhận response `201`.
- [ ] **Download:** khi nhận `relay-file-available`: nếu bật tự động nhận thì tải ngay, ngược lại hiện nút "Tải về". Dùng XHR `responseType = "blob"` với `onprogress`, đo `downloadMs`. Sau khi tải xong, tính SHA-256 và so với `sha256` trong thông báo, rồi gửi `relay-report { fileId, downloadMs, ok }`.
- [ ] Bên gửi nhận `relay-report` thì hoàn tất bản ghi: `uploadMs`, `downloadMs`, tổng.
- [ ] Xử lý lỗi `413` / `403` / `404` và lỗi mạng bằng thông báo tiếng Việt dễ hiểu.

**Nghiệm thu:** gửi 50 MB qua server giữa hai thiết bị, mã băm trùng, tiến trình upload và download đều chạy.

### C7 – So sánh tốc độ (`benchmark.js`)
- [ ] Nút **"So sánh P2P vs Server"** cho file đang chọn, chạy **tuần tự** (không song song để khỏi tranh băng thông): P2P trước, relay sau. Có tuỳ chọn lặp 1–5 lần, hiển thị **trung vị**.
- [ ] Định nghĩa thời gian (phải thống nhất, không tính thời gian băm):
  - P2P: `recvMs` do bên nhận báo trong `file-result`.
  - Server: `uploadMs + downloadMs` (mô hình store-and-forward: tải lên xong mới tải xuống).
  - Ghi riêng "thời gian thiết lập kết nối P2P" (từ C4) như một thông số thêm, không gộp vào thời gian truyền.
- [ ] Bảng kết quả: thời gian, tốc độ MB/s và Mbps, **hệ số nhanh hơn** (ví dụ "P2P nhanh gấp 4,2 lần"), thanh bar so sánh bằng CSS thuần.
- [ ] Gọi `GET /api/stats/:roomCode` sau mỗi lượt và hiển thị "Server đã xử lý: X KB tín hiệu, Y MB relay", để minh họa P2P gần như không tốn băng thông server.
- [ ] Nhắc người dùng bật "Tự động nhận" ở máy nhận trước khi chạy.

**Nghiệm thu:** chạy được so sánh với file 20 MB và 50 MB, ra bảng kết quả hợp lý, số liệu P2P và server khác biệt rõ khi hai máy cùng LAN còn server ở Oracle.

### C8 – Hiển thị quá trình bắt tay và log kỹ thuật (phục vụ thuyết trình)
- [ ] **Stepper** hiển thị tiến trình: ① Tạo phòng ② Xin vào ③ Chủ phòng chấp nhận ④ Offer ⑤ Answer ⑥ ICE ⑦ DataChannel mở. Mỗi bước sáng lên khi sự kiện tương ứng xảy ra.
- [ ] **Log panel** thu gọn được, mỗi dòng có timestamp (ms) và nhãn: `WS↑`, `WS↓`, `PC`, `ICE`, `DC`, `XFER`, `RELAY`.
- [ ] Bấm vào dòng `offer`/`answer` để xem SDP đầy đủ (`<details>`), có tô sáng các dòng `m=`, `a=fingerprint`, `a=sctp-port`.
- [ ] Dòng `ice-candidate` được phân tích hiển thị: loại (host/srflx/relay), IP, port, priority.
- [ ] Nút **Xuất log** ra file `.txt` để đưa vào báo cáo.

**Nghiệm thu:** chạy một phiên đầy đủ và thấy đủ 7 bước sáng lên; xem được SDP và danh sách candidate.

### C9 – Hoàn thiện và kiểm thử thủ công
Chạy và ghi kết quả vào `docs/TEST_RESULTS.md`:

| Kịch bản | Kỳ vọng |
|---|---|
| Chrome ↔ Chrome, hai tab cùng máy | kết nối được, loại `host` |
| Chrome ↔ Firefox | kết nối và truyền file đúng |
| Hai máy cùng Wi-Fi, server trên Oracle (HTTPS) | kết nối được, loại `host`, P2P nhanh hơn rõ so với relay |
| Chủ phòng từ chối | khách thấy thông báo, về lobby |
| Hết thời gian chờ duyệt | khách thấy "hết thời gian" |
| Khách thứ hai vào khi phòng đang đầy | báo "Phòng đã đủ người" |
| Đóng tab giữa lúc truyền | bên còn lại báo lỗi, không treo |
| File 20/50/100 MB | mã băm trùng |
| File 0 byte, file 101 MB | bị từ chối rõ ràng |

(Kịch bản 4G ↔ mạng nhà sẽ làm sau cùng với TURN.)

**Rủi ro khi demo tại lớp:** Wi-Fi trường/công ty hay bật chế độ cô lập client (AP isolation) hoặc chặn mDNS, khiến hai máy cùng mạng không thấy nhau theo đường `host` và phải đi đường `srflx` (có thể thất bại nếu router không hỗ trợ hairpin NAT). Hãy thử trước tại chỗ, và chuẩn bị phương án dự phòng như hai máy cùng một hotspot hoặc thiết bị mạng riêng.

## 6. Lưu ý kỹ thuật lệch so với tài liệu báo cáo (cần cập nhật khi viết báo cáo)

1. **Không truyền `maxRetransmits: null`** khi tạo kênh tin cậy. Một số trình duyệt ép `null` thành `0`, biến kênh thành *unreliable*. Chế độ ordered + reliable chỉ cần `{ ordered: true }` và **bỏ hẳn** `maxRetransmits`/`maxPacketLifeTime`.
2. **Ngưỡng backpressure:** tài liệu ghi cảnh báo ở `bufferedAmount > 16 MB`, nhưng 16 MB gần với giới hạn bộ đệm của một số trình duyệt, vượt là `send()` ném lỗi. Plan dùng `HIGH_WATER = 1 MiB` và `bufferedAmountLowThreshold = 256 KiB` (đủ lớn để không làm đường truyền bị "đói", đủ nhỏ để an toàn). Cơ chế (dừng khi đầy, tiếp tục ở sự kiện `bufferedamountlow`) giữ nguyên.
3. **Đọc file:** dùng `Blob.slice().arrayBuffer()` (phiên bản promise của `FileReader.readAsArrayBuffer`, cùng bản chất).
4. **SHA-256 chỉ chạy được ở secure context** (HTTPS hoặc `localhost`), một lý do để deploy server có HTTPS.

## 7. Quy ước code

- Module nhỏ, hàm ngắn, comment tiếng Việt ở những chỗ giải thích cơ chế (người dùng sẽ đọc lại khi thuyết trình).
- Mọi hằng số có thể chỉnh (chunk size, high water, low threshold, khối đọc) đặt ở đầu `transfer-p2p.js`.
- Không dùng `localStorage` cho trạng thái phòng; mất trang = rời phòng.

## 8. Định nghĩa hoàn thành

- Hoàn thành C1–C9, kịch bản kiểm thử ở C9 đạt (trừ mục 4G).
- Chạy được trên server Oracle qua HTTPS với hai thiết bị thật.
- Có thể trình diễn liền mạch: tạo phòng → xin vào → chấp nhận → xem stepper và log → gửi file P2P → bấm "So sánh" ra bảng kết quả.