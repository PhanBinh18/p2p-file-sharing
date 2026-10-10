# 💻 Client – Ứng dụng Chia sẻ File P2P (WebRTC & Server Benchmark)

Trang web thuần JavaScript (Vanilla JS, không framework, không bundler) cho phép hai người dùng kết nối trực tiếp ngang hàng qua **WebRTC DataChannel** để truyền tải file, đồng thời cung cấp chế độ truyền qua Server Relay nhằm đối chứng và so sánh hiệu năng thực tế.

---

## 📌 Tính năng chính

1. **Quản lý phòng 1-1 qua Biệt danh & Mã phòng 6 ký tự:**
   - Tạo phòng mới (vai trò Chủ phòng / Host) hoặc tham gia phòng bằng mã (vai trò Khách / Guest).
   - Kiểm duyệt khách vào phòng: Chủ phòng nhận pop-up xác nhận **Cho phép / Từ chối**.
2. **Bắt tay WebRTC tự động & Trực quan hóa tiến trình (C8):**
   - **Stepper 7 bước** thời gian thực: *Tạo phòng → Xin vào → Chủ phòng duyệt → Offer SDP → Answer SDP → Trao đổi ICE → P2P Sẵn sàng*.
   - **Trickle ICE với hàng đợi chống Race Condition**: Lưu tạm candidate nếu `remoteDescription` chưa sẵn sàng.
   - **Phân tích kết nối thời gian thực**: Sử dụng `pc.getStats()` định kỳ mỗi 2 giây để tự động phát hiện đường truyền đang dùng:
     - `host`: Mạng nội bộ (LAN)
     - `srflx`: Public IP qua STUN
     - `relay`: Qua TURN server
     - Độ trễ hai chiều (RTT) và thời gian thiết lập kết nối (setup duration).
3. **Truyền file P2P qua DataChannel (C5):**
   - Kênh `ordered: true, reliable` (không truyền `maxRetransmits: null`).
   - Tối ưu hóa đọc file: Đọc từng khối **1 MB** (`Blob.slice().arrayBuffer()`), cắt thành các chunk **16 KB** để gửi qua `dc.send()`.
   - **Cơ chế Backpressure**: `HIGH_WATER = 1 MiB`, `LOW_WATER = 256 KiB`. Tạm dừng gửi khi bộ đệm đầy và tiếp tục khi nhận sự kiện `bufferedamountlow`.
   - Kiểm tra toàn vẹn dữ liệu bằng mã băm **SHA-256** (tính toán trước khi truyền, không tính thời gian băm vào thời gian truyền).
4. **Truyền file qua Server Relay (C6):**
   - Upload bằng `XMLHttpRequest` (theo dõi `xhr.upload.onprogress`), body là bytes thô (`application/octet-stream`).
   - Download qua XHR `blob`, tự động tính toán lại SHA-256 và gửi `relay-report` về cho bên gửi.
5. **So sánh hiệu năng P2P vs Server (C7):**
   - Chạy tuần tự trên cùng một file: P2P trước, Server sau (tránh nghẽn băng thông).
   - Hỗ trợ lặp từ 1 đến 5 lần, tính toán giá trị **trung vị (median)** cho tốc độ và thời gian.
   - Hiển thị bảng chi tiết, thanh so sánh trực quan (CSS bar) và hệ số chênh lệch tốc độ.
   - Truy vấn `GET /api/stats/:roomCode` để chứng minh P2P tiết kiệm tối đa băng thông cho Server.
6. **Nhật ký kỹ thuật (Technical Log Panel):**
   - Ghi nhận chi tiết từng sự kiện với nhãn màu: `WS↑`, `WS↓`, `PC`, `ICE`, `DC`, `XFER`, `RELAY`, `BENCH`.
   - Hỗ trợ xem chi tiết SDP (tô sáng các dòng `m=`, `a=fingerprint`, `a=sctp-port`) và phân tích thông số ICE Candidate.
   - Nút **Xuất log** ra file `.txt` phục vụ báo cáo.

---

## 📂 Cấu trúc thư mục

```text
client/
├── index.html           # Khung giao diện HTML5 ngữ nghĩa, Stepper, Form Lobby, Modals
├── css/
│   └── style.css        # Giao diện Dark theme, responsive PC/Mobile, biểu đồ tốc độ
└── js/
    ├── main.js          # Điểm khởi động, điều phối trạng thái ứng dụng
    ├── ui.js            # Điều khiển DOM, thông báo Toast, Modal, Progress bar, Log Panel
    ├── signaling.js     # WebSocket client kết nối /ws theo giao thức hợp đồng
    ├── peer.js          # Quản lý RTCPeerConnection, DataChannel, ICE & getStats()
    ├── transfer-p2p.js  # Logic gửi/nhận file P2P, chunking 16KB, backpressure, ráp Blob
    ├── transfer-relay.js# Upload & Download qua HTTP Server (XHR Progress)
    ├── benchmark.js     # Bộ đo kiểm tốc độ tuần tự P2P vs Relay, thống kê trung vị
    ├── hash.js          # Tính SHA-256 bằng Web Cryptography API (crypto.subtle)
    └── util.js          # Định dạng dung lượng, tốc độ, thời gian, parse ICE & SDP
```

---

## ⚙️ Các thông số kỹ thuật cấu hình

Trong file `client/js/transfer-p2p.js`:
- `CHUNK_SIZE = 16384` (16 KiB): Kích thước mỗi gói dữ liệu nhị phân gửi qua DataChannel.
- `READ_BLOCK_SIZE = 1048576` (1 MiB): Khối đọc file từ đĩa lên bộ nhớ RAM.
- `HIGH_WATER = 1048576` (1 MiB): Ngưỡng đệm tối đa kích hoạt cơ chế backpressure.
- `LOW_WATER = 262144` (256 KiB): Ngưỡng đệm an toàn để tiếp tục gửi dữ liệu.
- `MAX_FILE_SIZE = 104857600` (100 MiB): Giới hạn dung lượng file tối đa cho phép.

---

## 🔒 Yêu cầu Secure Context (Bảo mật)

Web Cryptography API (`window.crypto.subtle`) chỉ hoạt động trong **Secure Context**:
- Môi trường phát triển: `http://localhost:3000` hoặc `http://127.0.0.1:3000`.
- Môi trường Production (mạng LAN / Internet): Bắt buộc phải có chứng chỉ **HTTPS** (ví dụ qua Caddy hoặc Nginx). Nếu mở HTTP trên IP công cộng, trình duyệt sẽ vô hiệu hóa `crypto.subtle` và hiển thị cảnh báo trên màn hình.

---

## 🌐 Tương thích trình duyệt

- **Google Chrome / Chromium**: Hỗ trợ đầy đủ WebRTC DataChannel, `crypto.subtle`, Stream.
- **Mozilla Firefox**: Hỗ trợ đầy đủ kết nối chéo trình duyệt (Chrome ↔ Firefox).
- **Microsoft Edge / Safari 15+**: Hoạt động mượt mà trên cả desktop và điện thoại di động.
