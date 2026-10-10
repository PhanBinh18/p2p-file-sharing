# 🌐 P2P File Sharing – WebRTC & Server Relay Benchmark (Đề tài T10)

Hệ thống ứng dụng web chia sẻ file trực tiếp ngang hàng (**Peer-to-Peer - P2P**) sử dụng công nghệ **WebRTC DataChannel**, kết hợp cơ chế truyền file qua **HTTP Server Relay** để đối chứng và đo đạc so sánh hiệu năng đường truyền thực tế.

---

## 📑 Mục lục
1. [Giới thiệu đề tài](#-giới-thiệu-đề-tài)
2. [Kiến trúc hệ thống](#-kiến-trúc-hệ-thống)
3. [Cấu trúc mã nguồn](#-cấu-trúc-mã-nguồn)
4. [Hướng dẫn cài đặt và Chạy ứng dụng](#-hướng-dẫn-cài-đặt-và-chạy-ứng-dụng)
5. [Kịch bản sử dụng từng bước (Demo Walkthrough)](#-kịch-bản-sử-dụng-từng-bước-demo-walkthrough)
6. [Chạy kiểm thử tự động (Automated Tests)](#-chạy-kiểm-thử-tự-động-automated-tests)
7. [Triển khai Production lên Cloud (HTTPS & WSS)](#-triển-khai-production-lên-cloud-https--wss)
8. [Tài liệu chi tiết các phân hệ](#-tài-liệu-chi-tiết-các-phân-hệ)

---

## 🎯 Giới thiệu đề tài

Trong các hệ thống chia sẻ file truyền thống, dữ liệu bắt buộc phải đi qua máy chủ trung gian (Client-Server), gây tốn kém băng thông máy chủ và gia tăng độ trễ mạng. 

Đề tài này hiện thực hóa giải pháp:
- **P2P WebRTC**: Sau giai đoạn bắt tay tín hiệu (Signaling), hai trình duyệt truyền dữ liệu trực tiếp với nhau qua kênh **DataChannel** (giao thức SCTP trên nền DTLS/UDP). Máy chủ **không đọc và không tham gia vào luồng dữ liệu file**, giải phóng 100% băng thông truyền tải của server.
- **Đối chứng hiệu năng (Benchmark)**: Cung cấp chế độ truyền qua Server Relay để so sánh trực quan thời gian truyền, tốc độ (MB/s, Mbps) và minh chứng sự khác biệt vượt trội của P2P khi hoạt động trong mạng nội bộ (LAN).

---

## 🏗️ Kiến trúc hệ thống

```text
                        ┌─────────────────────────────────────────┐
                        │      Signaling & Relay Server           │
                        │    (Node.js / Express / ws :3000)       │
                        └───────┬─────────────────────────┬───────┘
                                │                         │
              1. WebSocket      │                         │  1. WebSocket
              Signaling (/ws)   │                         │  Signaling (/ws)
                                ▼                         ▼
                     ┌──────────────────┐         ┌──────────────────┐
                     │ Client A (Host)  │         │ Client B (Guest) │
                     │   Trình duyệt    │         │   Trình duyệt    │
                     └─────────┬────────┘         └────────┬─────────┘
                               │                           │
                               │  2. Thu thập ICE Candidate│
                               ▼  từ Google STUN Server    ▼
                     ┌───────────────────────────────────────────────┐
                     │            stun:stun.l.google.com:19302       │
                     └───────────────────────────────────────────────┘
                               │                           │
                               │   3. P2P WebRTC DataChannel│
                               └───────────────────────────┘
                               (Truyền file trực tiếp: 16 KB chunks,
                                backpressure, kiểm tra SHA-256)
```

### 🔁 Tiến trình kết nối (7 bước Stepper)
1. **Tạo phòng**: Chủ phòng (Host) nhập nickname, tạo phòng nhận mã 6 ký tự.
2. **Xin vào**: Khách (Guest) nhập nickname và mã phòng để gửi yêu cầu.
3. **Duyệt vào**: Chủ phòng nhận pop-up xác nhận và bấm **Cho phép**.
4. **Offer SDP**: Chủ phòng sinh Local Description (Offer) và gửi qua WebSocket.
5. **Answer SDP**: Khách nhận Offer, sinh Answer và gửi ngược lại.
6. **Trao đổi ICE**: Hai bên trao đổi ứng viên ICE Candidate (Trickle ICE) để tìm đường kết nối tối ưu.
7. **P2P Sẵn sàng**: Kênh `RTCDataChannel` chuyển sang trạng thái `open`. Dữ liệu truyền trực tiếp giữa hai máy.

---

## 📂 Cấu trúc mã nguồn

```text
file-sharing-p2p/
├── README.md               # Tài liệu tổng quan và hướng dẫn sử dụng chính (file này)
├── mock-server.js          # Mock Server độc lập (Node.js thuần, 0 dependencies) để test nhanh
├── test-e2e.js             # Kịch bản kiểm thử tích hợp toàn bộ luồng Signaling WebRTC
├── test-relay.js           # Kịch bản kiểm thử luồng upload, download và thống kê qua Server
│
├── client/                 # Mã nguồn phía trình duyệt (Vanilla JS, HTML5, CSS3)
│   ├── README.md           # Hướng dẫn chi tiết phân hệ Client
│   ├── plan_client.md      # Đặc tả kế hoạch và hợp đồng kỹ thuật Client
│   ├── index.html          # Giao diện chính, Stepper 7 bước, Modals, Log Drawer
│   ├── css/style.css       # Toàn bộ CSS phong cách Dark theme, responsive
│   └── js/                 # Các module ES Modules (main, ui, peer, transfer-p2p, benchmark...)
│
└── server/                 # Mã nguồn máy chủ Signaling & HTTP Relay
    ├── README.md           # Hướng dẫn chi tiết phân hệ Server
    ├── plan_server.md      # Đặc tả kế hoạch và hợp đồng kỹ thuật Server
    ├── package.json        # Cấu hình dependency (Express, ws) và test runner
    ├── .env.example        # File mẫu cấu hình biến môi trường
    ├── src/                # Mã nguồn Server (index, config, rooms, signaling, relay, stats)
    ├── test/               # Kiểm thử tự động (rooms.test.js, signaling.test.js)
    └── deploy/             # File cấu hình triển khai Linux (Caddyfile, systemd service, deploy.sh)
```

---

## 🚀 Hướng dẫn cài đặt và Chạy ứng dụng

Yêu cầu môi trường: **Node.js phiên bản 20 trở lên** và trình duyệt web hiện đại (Chrome, Edge, Firefox, Safari).

### Cách 1: Khởi chạy Server chính thức (Khuyên dùng)

1. **Mở terminal và di chuyển vào thư mục server:**
   ```bash
   cd server
   ```

2. **Cài đặt các gói phụ thuộc:**
   ```bash
   npm install
   ```

3. **Khởi động server:**
   ```bash
   npm start
   ```

4. **Truy cập ứng dụng:**
   Mở trình duyệt tại địa chỉ: **`http://localhost:3000`**

---

### Cách 2: Khởi chạy Mock Server nhanh (Không cần cài dependencies)

Nếu muốn kiểm thử nhanh mà không cần cài đặt `node_modules`:
```bash
# Đứng tại thư mục gốc của project
node mock-server.js
```
Mở trình duyệt tại: **`http://localhost:3000`**

---

## 🖥️ Kịch bản sử dụng từng bước (Demo Walkthrough)

Để trải nghiệm trọn vẹn quá trình bắt tay và truyền file P2P:

### Bước 1: Mở 2 phiên làm việc
- Mở **2 tab trình duyệt** (hoặc 1 tab thường + 1 tab ẩn danh, hoặc 2 thiết bị khác nhau cùng kết nối vào server).

### Bước 2: Tạo phòng (Tab 1 – Chủ phòng)
- Tại Tab 1: Nhập Biệt danh (ví dụ: `Alice`) và bấm nút **Tạo phòng**.
- Màn hình sẽ chuyển sang trạng thái chờ, hiển thị **Mã phòng gồm 6 ký tự** (ví dụ: `K8P9XY`) kèm nút **Sao chép**.

### Bước 3: Tham gia phòng (Tab 2 – Khách)
- Tại Tab 2: Nhập Biệt danh (ví dụ: `Bob`), nhập mã phòng `K8P9XY` vào ô mã và bấm nút **Vào phòng**.
- Tab 2 sẽ hiển thị thông báo: *"Đang chờ chủ phòng xét duyệt..."*.

### Bước 4: Xét duyệt vào phòng
- Tại Tab 1 (Alice): Một cửa sổ pop-up xuất hiện: *"Người dùng Bob đang xin phép vào phòng"*.
- Bấm nút **Cho phép**.

### Bước 5: Theo dõi bắt tay WebRTC
- Quan sát **Stepper 7 bước** trên thanh tiến trình: Các bước từ 1 đến 7 sẽ sáng lên lần lượt khi Offer, Answer và ICE Candidate được trao đổi thành công.
- Khi bước 7 sáng xanh (**P2P Sẵn sàng**), giao diện kết nối sẽ hiển thị:
  - Tên đối tác đang kết nối.
  - **Loại đường truyền**: `LAN (Nội bộ)` hoặc `STUN (Public IP)`.
  - **Độ trễ hai chiều (RTT)** cập nhật mỗi 2 giây (thường < 5 ms trong mạng LAN).
  - **Thời gian bắt tay kết nối** (Setup duration).

### Bước 6: Truyền file P2P
1. Chọn file bất kỳ bằng cách kéo thả vào ô vuông hoặc bấm chọn từ thiết bị (hỗ trợ tối đa 100 MB).
2. Hệ thống tự động tính toán mã băm **SHA-256** của file.
3. Bấm nút **⚡ Gửi file P2P (WebRTC)**.
4. Quan sát thanh tiến trình cập nhật theo thời gian thực (tỷ lệ %, dung lượng, tốc độ tức thời).
5. Sau khi truyền xong:
   - Hệ thống tự động kiểm tra tính toàn vẹn dữ liệu.
   - Hiển thị huy hiệu **✅ Toàn vẹn (SHA-256 trùng khớp)**.
   - Bên nhận có nút **💾 Lưu file về máy** để tải file vừa ghép xong về thiết bị.

### Bước 7: So sánh tốc độ (Benchmark)
1. Tại bên nhận: Đảm bảo đã tích chọn checkbox **"Tự động nhận file"**.
2. Tại bên gửi: Chọn số lần lặp (1, 3 hoặc 5 lượt) và bấm **📊 So sánh P2P vs Server**.
3. Hệ thống sẽ chạy tuần tự:
   - Lượt đo P2P (WebRTC DataChannel).
   - Lượt đo Server Relay (HTTP Upload + Download).
4. Xem kết quả hiển thị:
   - **Tỷ lệ tăng tốc**: Ví dụ *"P2P nhanh gấp 4.2 lần so với Server Relay"*.
   - **Biểu đồ thanh trực quan (CSS Bar)** so sánh tốc độ MB/s của 2 phương thức.
   - **Bảng chi tiết** các lượt đo và giá trị trung vị (median).
   - **Thống kê băng thông Server**: Minh họa số KB mà server xử lý cho signaling so với số MB khi relay.

### Bước 8: Xem và xuất Nhật ký kỹ thuật (Log Panel)
- Bấm nút **📋 Nhật ký kỹ thuật** ở góc trên cùng bên phải.
- Xem chi tiết các gói tin: Bấm nút **🔍 Chi tiết** tại các dòng `offer`/`answer` để xem cú pháp SDP được tô sáng hoặc phân tích địa chỉ IP/port của ICE Candidate.
- Bấm **Xuất log** để tải về file `.txt` phục vụ báo cáo.

---

## 🧪 Chạy kiểm thử tự động (Automated Tests)

Project đã được viết sẵn bộ unit test và integration test đạt độ tin cậy cao:

```bash
# 1. Chạy toàn bộ 14 test cases của server (State machine & WebSocket integration)
cd server
npm test

# 2. Chạy test kịch bản giao thức bắt tay độc lập
node test-e2e.js

# 3. Chạy test luồng upload/download và stats của Relay HTTP
node test-relay.js
```

---

## ☁️ Triển khai Production lên Cloud (HTTPS & WSS)

> **Lưu ý quan trọng**: Do Web Crypto (`crypto.subtle`) chỉ hoạt động trên **Secure Context**, khi triển khai lên máy chủ công cộng (như Oracle Cloud VM, AWS EC2, DigitalOcean), bắt buộc phải có chứng chỉ **HTTPS**.

1. **Mở cổng Firewall / Security List**: Ingress TCP `80` và `443`.
2. **Cấu hình Caddy Reverse Proxy**: Sử dụng file [Caddyfile](server/deploy/Caddyfile) để tự động cấp phát SSL miễn phí từ Let's Encrypt.
3. **Quản lý tiến trình bằng Systemd**: Cài đặt file [p2p-share.service](server/deploy/p2p-share.service) để server tự động chạy ngầm và tự khởi động lại khi reboot VM.
4. **Script tự động cập nhật**: Sử dụng file [deploy.sh](server/deploy/deploy.sh) để tự động pull mã nguồn mới và reload service.
5. Xem hướng dẫn chi tiết từng bước tại [server/README.md](server/README.md#-hướng-dẫn-triển-khai-production-oracle-cloud-vm).

---

## 📖 Tài liệu chi tiết các phân hệ

- 📘 [Tài liệu chi tiết Phân hệ Client (client/README.md)](client/README.md)
- 📗 [Tài liệu chi tiết Phân hệ Server (server/README.md)](server/README.md)
- 📑 [Kế hoạch chi tiết Client (client/plan_client.md)](client/plan_client.md)
- 📑 [Kế hoạch chi tiết Server (server/plan_server.md)](server/plan_server.md)
