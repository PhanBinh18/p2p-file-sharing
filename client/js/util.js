/**
 * Tiện ích định dạng dữ liệu, thời gian, mã băm và phân tích WebRTC SDP/ICE
 */

export function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 B';
  if (!bytes || isNaN(bytes)) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 MB/s (0 Mbps)';
  const mbPerSec = bytesPerSec / (1024 * 1024);
  const mbps = (bytesPerSec * 8) / (1000 * 1000);
  return `${mbPerSec.toFixed(2)} MB/s (${mbps.toFixed(2)} Mbps)`;
}

export function formatDuration(ms) {
  if (ms == null || isNaN(ms)) return '0 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function uuidv4() {
  if (crypto && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function now() {
  return performance.now();
}

/**
 * Phân tích chuỗi candidate ICE theo RFC 5245 / RFC 8445
 * Chuỗi mẫu: candidate:4234997325 1 udp 2122260223 192.168.1.10 54321 typ host generation 0
 */
export function parseIceCandidate(candStr) {
  if (!candStr) return null;
  const line = candStr.startsWith('candidate:') ? candStr.slice(10) : candStr;
  const parts = line.trim().split(/\s+/);
  if (parts.length < 8) return { raw: candStr, type: 'unknown' };

  const [foundation, component, protocol, priority, ip, port, , type] = parts;
  let typeLabel = type;
  if (type === 'host') typeLabel = 'host (LAN / nội bộ)';
  else if (type === 'srflx') typeLabel = 'srflx (STUN / Public IP)';
  else if (type === 'relay') typeLabel = 'relay (TURN server)';
  else if (type === 'prflx') typeLabel = 'prflx (Peer reflexive)';

  return {
    foundation,
    component,
    protocol,
    priority,
    ip,
    port,
    type,
    typeLabel,
    raw: candStr
  };
}

/**
 * Tô sáng cú pháp SDP để phục vụ minh họa và thuyết trình
 * Nhận diện các dòng m=, a=fingerprint, a=sctp-port, a=candidate
 */
export function highlightSdp(sdp) {
  if (!sdp) return '';
  const lines = sdp.split(/\r?\n/);
  return lines
    .map(line => {
      const escaped = escapeHtml(line);
      if (line.startsWith('m=')) {
        return `<span class="sdp-hl-media">${escaped}</span>`;
      }
      if (line.startsWith('a=fingerprint:')) {
        return `<span class="sdp-hl-fingerprint">${escaped}</span>`;
      }
      if (line.startsWith('a=sctp-port:')) {
        return `<span class="sdp-hl-sctp">${escaped}</span>`;
      }
      if (line.startsWith('a=candidate:')) {
        return `<span class="sdp-hl-candidate">${escaped}</span>`;
      }
      if (line.startsWith('c=')) {
        return `<span class="sdp-hl-conn">${escaped}</span>`;
      }
      return escaped;
    })
    .join('\n');
}

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function truncateStr(str, maxLen = 30) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}
