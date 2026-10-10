#!/usr/bin/env bash
# Script triển khai và cập nhật P2P File Sharing Server trên Oracle VM
set -euo pipefail

echo "=========================================================="
echo "🚀 Triển khai cập nhật P2P File Sharing Server"
echo "=========================================================="

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$SERVER_DIR"

echo "📥 1. Kéo mã nguồn mới nhất (nếu dùng git)..."
if [ -d "../.git" ]; then
    git pull || true
fi

echo "📦 2. Cài đặt các gói phụ thuộc (production)..."
npm ci --omit=dev

echo "🔄 3. Khởi động lại dịch vụ systemd p2p-share..."
if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl restart p2p-share
    echo "✅ Trạng thái dịch vụ:"
    sudo systemctl --no-pager status p2p-share || true
else
    echo "⚠️ Không tìm thấy systemctl, vui lòng khởi động thủ công: node src/index.js"
fi

echo "=========================================================="
echo "🎉 Triển khai hoàn tất thành công!"
echo "=========================================================="
