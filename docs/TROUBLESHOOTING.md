# 🛠️ Nhật Ký Gỡ Lỗi & Xử Lý Sự Cố (Bugfix & Troubleshooting Log)

Tài liệu này ghi lại toàn bộ quá trình phát hiện sự cố, phân tích nguyên nhân gốc rễ (Root Cause), và các giải pháp đã thực hiện trong quá trình phát triển và triển khai hệ thống **WebRTC P2P File Sharing & HTTP Server Relay**.

---

## 📅 Ngày: 10/10/2026 – Triển Khai Cơ Bản & Sửa Lỗi UI / WebRTC Race Condition

### 1. Lỗi ICE Candidate Race Condition khi Signaling bắt đầu sớm
* **Hiện tượng:** Khi Peer B (khách) nhận Offer và gửi Answer về cho Peer A (chủ phòng), các gói ICE candidate đầu tiên từ B gửi tới A bị báo lỗi: *"Remote hoặc Local Description chưa sẵn sàng, đưa candidate vào hàng đợi..."*. Đôi khi nếu không xử lý kỹ, các candidate này bị bỏ rơi làm ICE negotiation bị timeout.
* **Nguyên nhân:** Theo chuẩn W3C WebRTC, `RTCPeerConnection.addIceCandidate()` sẽ ném ngoại lệ nếu gọi trước khi `setRemoteDescription()` hoàn tất. Khi mạng có độ trễ hoặc các message WebSocket đến lệch thứ tự (out-of-order), candidate có thể tới trước hoặc cùng lúc với SDP Answer.
* **Cách khắc phục:**
  * Thêm hàng đợi `earlyIceCandidateQueue` trong [`client/js/peer.js`](../client/js/peer.js).
  * Chỉ gọi `addIceCandidate()` khi trạng thái `remoteDescription` đã tồn tại. Nếu chưa có, đẩy candidate vào hàng đợi.
  * Ngay khi `setRemoteDescription()` thực thi thành công, thực hiện xả (flush) toàn bộ hàng đợi candidate.

### 2. Lỗi Stepper UI bị nhảy giật lùi (Regression UI)
* **Hiện tượng:** Khi peer đã kết nối P2P thành công (bước 6: Sẵn sàng gửi file), thanh Stepper tiến trình thỉnh thoảng bị nhảy thụt lùi về bước 5 (Đang bắt tay kết nối).
* **Nguyên nhân:** Hàm `setStep(step)` trong [`client/js/ui.js`](../client/js/ui.js) được gọi từ nhiều sự kiện bất đồng bộ (`signaling.on('peer-ready')` và `peer.on('connection-state')`), một callback tới chậm đã vô tình hạ bậc step hiện tại.
* **Cách khắc phục:** Thêm kiểm tra điều kiện bảo vệ trong [`ui.js`](../client/js/ui.js): Không cho phép stepper hạ cấp từ step 6 xuống step 5 một khi trạng thái DataChannel đã mở.

---

## 📅 Ngày: 11/10/2026 – Triển Khai Production Server & Sự Cố NAT / ICE Traversal

### 1. Triển khai Caddy Reverse Proxy & Mở Firewall Oracle Cloud
* **Hiện tượng:** 
  * Node.js server chạy nội bộ cổng `3000` tốt, nhưng gọi `curl -I https://p2p-file-sharing.duckdns.org/healthz` từ ngoài vào bị `Connection refused` hoặc timeout port 443.
* **Nguyên nhân:** 
  * Caddy chưa mở lắng nghe cổng 443 do xung đột với Docker đang chiếm cổng 80 (làm ACME HTTP challenge thất bại).
  * Firewall cấp hệ điều hành (Ubuntu `iptables` / `ufw`) và Oracle Cloud Security List chưa mở ingress rule cho TCP 443.
* **Cách khắc phục:**
  * Cấu hình Caddyfile với chỉ thị `auto_https disable_redirects` để Caddy phục vụ HTTPS trên 443 mà không cần bind cổng 80.
  * Mở firewall Linux:
    ```bash
    sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
    sudo netfilter-persistent save
    ```
  * Mở Ingress Rule trên Oracle Cloud Console: Protocol TCP, Port 443, Source `0.0.0.0/0`.

---

### 2. Sự Cố ICE Failed khi kết nối giữa 2 máy (hoặc Laptop & Điện thoại) cùng mạng Wi-Fi
* **Hiện tượng:**
  * Signaling qua WebSocket (`wss://p2p-file-sharing.duckdns.org/ws`) hoàn toàn mượt mà: Tạo phòng, nhận diện nickname, trao đổi SDP Offer/Answer đều thành công 100%.
  * Nhưng tới bước ICE negotiation thì trạng thái kết nối chuyển thành: `checking` ➡️ `failed`. DataChannel không thể mở (`DC: DataChannel 'file' đã ĐÓNG`).
  * Trích xuất Candidate log từ trình duyệt:
    * Host candidate sinh ra dạng tên miền lạ: `[host] 3bb6839a-a248-43ae-ad1c-a42c356fcdc2.local:63082`
    * STUN server trả về candidate công khai (srflx): `[srflx] 42.112.12.178:63082`

* **Phân tích nguyên nhân gốc rễ (Root Cause Analysis):**
  1. **Cơ chế mDNS IP Hiding của Chrome (RFC 8828):**
     * Để bảo vệ quyền riêng tư người dùng (chống các trang web quảng cáo đọc trộm địa chỉ IP LAN thật như `192.168.1.x`), trình duyệt Chrome/Edge tự động mã hóa IP LAN thành một tên miền ảo dạng `<uuid>.local`.
     * Khi hai thiết bị muốn kết nối nội bộ, chúng phải giải mã tên miền này thông qua giao thức mDNS (Multicast DNS qua UDP port 5353).
     * **Điểm nghẽn:** Hầu hết các Modem/Router Wi-Fi của nhà mạng Việt Nam (VNPT, FPT, Viettel) mặc định **chặn gói tin Multicast** giữa các cổng Wi-Fi (Client Isolation hoặc drop Multicast để tiết kiệm băng thông sóng). Do đó, Laptop không thể phân giải được IP của Điện thoại qua tên miền `.local` này ➡️ **Candidate loại `host` thất bại hoàn toàn**.
  2. **Router không hỗ trợ NAT Loopback (NAT Hairpinning):**
     * Khi không kết nối được qua IP nội bộ, WebRTC cố gắng fallback sang ứng viên `srflx` (Server Reflexive) do STUN Server cấp: gửi gói tin tới IP Public của Router (`42.112.12.178`).
     * Tuy nhiên, cả 2 thiết bị đều đang nằm *phía sau* cùng 1 Router đó. Router nhận được gói tin từ cổng LAN nhưng địa chỉ đích lại là chính IP WAN công khai của nó. Đa số router gia đình không có tính năng **NAT Hairpinning / NAT Loopback**, nên router lập tức vứt bỏ (drop) gói tin này ➡️ **Candidate loại `srflx` cũng thất bại**.
  3. Kết quả: Toàn bộ candidate đều bị drop ➡️ Trạng thái ICE chuyển thành `failed`.

---

### 3. Phương Án Xử Lý & Đánh Giá Bảo Mật

#### ✅ Giải pháp A (Dùng để kiểm thử & cô lập lỗi): Tắt cờ ẩn IP mDNS trên Chrome
* **Thao tác:**
  * Truy cập `chrome://flags/#enable-webrtc-hide-local-ips-with-mdns`
  * Đổi giá trị thành **Disabled** và khởi động lại trình duyệt (Relaunch).
* **Kết quả:**
  * Trình duyệt không sinh candidate `.local` nữa mà đưa thẳng IP LAN thực (`192.168.1.15`).
  * Hai máy kết nối P2P trực tiếp qua IP LAN tức thì mà không cần thông qua mDNS hay Router Loopback.
* **Giải đáp câu hỏi: "Tắt ẩn IP thật có mất an toàn bảo mật không?":**
  * **Về mặt an ninh mạng (Hacking/Network Security):** Hoàn toàn **KHÔNG** làm bạn dễ bị hack từ bên ngoài Internet. Dải IP `192.168.x.x` là dải Private (RFC 1918), hacker từ Internet không thể định tuyến hay bắn gói tin trực tiếp vào IP này.
  * **Về mặt quyền riêng tư (Privacy/Fingerprinting):** Đây là lý do chính mà Google tạo ra cơ chế ẩn IP. Nếu bật IP thật, các trang web theo dõi quảng cáo có thể dùng JavaScript WebRTC để đọc IP LAN của bạn nhằm "đóng dấu vân tay" thiết bị (Browser Fingerprinting), ngay cả khi bạn đang bật Tab ẩn danh hay đổi VPN.

---

#### 🚀 Giải pháp B (Chuẩn Production cho người dùng cuối): Dựng TURN Server riêng (Coturn)
* **Vấn đề đặt ra:** Không thể yêu cầu người dùng cuối truy cập `chrome://flags` để tắt cờ khi vào trang web.
* **Giải pháp bền vững:**
  * Dựng một **TURN Server riêng (Coturn)** chạy trực tiếp trên VPS Oracle Cloud (`168.107.75.167`).
  * Khi mạng Wi-Fi của người dùng chặn Multicast mDNS và chặn NAT Loopback, WebRTC sẽ tự động kích hoạt candidate loại `relay`.
  * Lưu lượng file vẫn được mã hóa đầu-cuối (E2EE) bằng DTLS/SCTP, TURN server chỉ đóng vai trò chuyển tiếp UDP trung gian với độ trễ thấp và băng thông tối đa của VPS.
  * Người dùng trên bất kỳ thiết bị nào (Chrome, Safari iOS, Android) đều kết nối thông suốt 100% mà không cần cấu hình thêm bất kỳ cài đặt trình duyệt nào.

---

## 📅 Ngày: 12/10/2026 – Đổi Domain Mới, Dựng Coturn TURN Server & Xử Lý Symmetric NAT

### 1. Sự Cố Khi Đổi Tên Miền DuckDNS Mới (`p2pfilesharing.duckdns.org`)
* **Hiện tượng:** Sau khi tạo domain mới trên DuckDNS và trỏ về IP VPS, truy cập HTTPS vào domain mới bị lỗi SSL / Connection Refused.
* **Nguyên nhân:** Caddy Reverse Proxy trên VPS vẫn đang bind theo domain cũ (`p2p-file-sharing.duckdns.org`), chưa cập nhật cấu hình nên Caddy chưa xin cấp chứng chỉ HTTPS (Let's Encrypt / ZeroSSL) cho domain mới.
* **Cách khắc phục:**
  1. Cập nhật file `/etc/caddy/Caddyfile`: Thay domain cũ bằng `p2pfilesharing.duckdns.org`.
  2. Khởi động lại Caddy: `sudo systemctl restart caddy`. Caddy tự động hoàn tất TLS challenge và cấp SSL tức thì.

---

### 2. Sự Cố ICE Failed Khi Kết Nối Khác Mạng Wi-Fi (Symmetric NAT)
* **Hiện tượng:** 
  * Khi 2 thiết bị kết nối ở **2 mạng khác nhau** (ví dụ 1 máy dùng 4G Viettel, 1 máy dùng Wi-Fi; hoặc 2 mạng Wi-Fi khác nhau), Signaling WebSocket thành công 100%, nhưng ICE Connection chuyển trạng thái: `checking` ➡️ `disconnected` ➡️ `failed`.
  * Kiểm tra qua `chrome://webrtc-internals`: Không có bất kỳ candidate loại `relay` nào được sinh ra, chỉ có `stun:...`.
* **Phân tích nguyên nhân:**
  * Các mạng di động 4G/5G hoặc mạng gia đình áp dụng CGNAT đều là loại **Symmetric NAT (NAT Đối Xứng)**.
  * Router liên tục đổi ngẫu nhiên port ngoại vi (External Mapping Port) cho từng IP đích. Các gói tin UDP gửi trực tiếp giữa 2 máy bị firewall của 2 router drop hoàn toàn.
  * Trong điều kiện Symmetric NAT, **STUN thuần túy bất lực 100%**. WebRTC bắt buộc phải có **TURN Server** mới có thể đục lỗ hoặc chuyển tiếp dữ liệu.

---

### 3. Quá Trình Triển Khai & Khắc Phục Lỗi Coturn Trên Oracle Cloud VPS

#### A. Mở cổng Firewall (Oracle Cloud Security List & Linux iptables)
* **Mở trên Oracle Cloud Ingress Rules:**
  * Port `3478` (UDP & TCP) – Cổng điều khiển STUN/TURN.
  * Dải port `49152-65535` (UDP) – Dải port chuyển tiếp WebRTC relay.
* **Mở trên Linux iptables:**
  * Đưa các rule `ACCEPT` lên vị trí đầu tiên của bảng `INPUT` để tránh bị các rule chặn mặc định của Oracle Linux drop:
    ```bash
    sudo iptables -I INPUT 1 -p udp --dport 3478 -j ACCEPT
    sudo iptables -I INPUT 1 -p tcp --dport 3478 -j ACCEPT
    sudo iptables -I INPUT 1 -p udp --dport 49152:65535 -j ACCEPT
    ```

#### B. Khắc phục lỗi Coturn không bind vào card mạng chính
* **Lỗi phát hiện:** Ban đầu Coturn chỉ bind vào `127.0.0.1` và `172.17.0.1` (docker bridge), khiến gói tin từ Internet bên ngoài vào port 3478 không tới được tiến trình.
* **Khắc phục:** Bổ sung cấu hình `listening-ip=0.0.0.0` trong `/etc/turnserver.conf` để Coturn lắng nghe trên toàn bộ interface mạng của VPS.

#### C. Khắc phục lỗi `403: Forbidden IP` khi đục lỗ WebRTC qua Coturn
* **Hiện tượng trong log Coturn:** 
  ```text
  ALLOCATE processed, success
  incoming packet CREATE_PERMISSION processed, error 403: Forbidden IP
  ```
* **Nguyên nhân gốc rễ:** 
  * Theo mặc định RFC 5766, Coturn tự động chặn chuyển tiếp tới các dải IP Private/Loopback (`10.0.0.0/8`, `127.0.0.0/8`).
  * Máy ảo Oracle Cloud có IP Private nội bộ là `10.0.0.116`, hoặc peer gửi candidate private, khiến Coturn chặn quyền (Forbidden IP).
* **Khắc phục triệt để:**
  * Trong `/etc/turnserver.conf`, cấu hình ánh xạ rõ ràng: `external-ip=168.107.75.167/10.0.0.116`.
  * Kích hoạt cờ `allow-loopback-peers`.
  * Khởi động lại Coturn: `sudo systemctl restart coturn`.

---

### 4. Kết Quả Sau Cùng: Xuất Hiện Ứng Viên `prflx` (Peer Reflexive)
* **Kết quả thực tế:**
  * Sau khi cấu hình Coturn hoàn tất, hai thiết bị khác mạng đã kết nối P2P thành công mỹ mãn.
  * Trạng thái cặp candidate được WebRTC lựa chọn là **`prflx` (Peer Reflexive)**: Nhờ có TURN Server đóng vai trò trung gian "mồi" ban đầu, hai máy đã tự phát hiện ra một đường hầm UDP trực tiếp xuyên qua lớp Symmetric NAT của router.
  * Kênh dữ liệu **DataChannel mở ngay lập tức**, truyền file trực tiếp với tốc độ tối đa của đường truyền mà không bị nghẽn mạng!
