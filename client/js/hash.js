/**
 * Tính mã băm SHA-256 sử dụng Web Cryptography API (crypto.subtle)
 * Yêu cầu Secure Context (HTTPS hoặc localhost)
 */

export function isCryptoSupported() {
  return typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined' &&
    typeof crypto.subtle.digest === 'function';
}

/**
 * Tính SHA-256 cho ArrayBuffer
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>} Hex string
 */
export async function sha256(buffer) {
  if (!isCryptoSupported()) {
    throw new Error('Web Cryptography API (crypto.subtle) không khả dụng! Vui lòng dùng HTTPS hoặc localhost.');
  }

  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Tính SHA-256 cho File hoặc Blob
 * @param {File|Blob} file
 * @returns {Promise<string>} Hex string
 */
export async function hashFile(file) {
  if (!file) throw new Error('File không hợp lệ');
  const buffer = await file.arrayBuffer();
  return await sha256(buffer);
}
