# DEBUG HISTORY — Content Distributor (Aeslatek Ads Hub)
📍 **Path:** `H:\ai-folder\external\content-distributor`
🔗 **Ký ức nguồn:** `4ba8c0c6` · `145eac3c` · `828038c8`

---

## [2026-04-15] Port Lệch Môi Trường — Server Bind Sai Cổng
- **Triệu chứng:** Server start nhưng truy cập `localhost:3005` bị 404.
- **Root Cause:** `.env` và code không thống nhất PORT, một nơi dùng `3000`, nơi khác `3005`.
- **Giải pháp:** Đồng bộ `PORT=3005` vào cả file `.env` và hardcode fallback trong `server.js`. Chốt cứng một cổng duy nhất.

## [2026-04-17] Nút "Cố Vấn AI" Không Phản Hồi — Missing JS Function
- **Triệu chứng:** Click nút "Cố vấn AI" không có gì xảy ra.
- **Root Cause:** HTML button có `onclick="showAiStrategy()"` nhưng function này chưa được khai báo trong JS.
- **Giải pháp:** Thêm `function showAiStrategy() { window.location.href = '/ai-strategy.html'; }` vào file script.

## [2026-04-17] Copy To Clipboard Không Hoạt Động
- **Triệu chứng:** Nút Copy content brief không copy gì.
- **Root Cause:** `navigator.clipboard.writeText()` bị block trên HTTP (chỉ hoạt động trên HTTPS hoặc localhost).
- **Giải pháp:** Kiểm tra context (`window.isSecureContext`) và fallback về `document.execCommand('copy')` nếu không phải HTTPS.

## [2026-04-15] AI Strategy Token Overflow — Báo Cáo Bị Cắt Giữa Chừng
- **Triệu chứng:** Báo cáo AI Strategy bị cắt đứt ở giữa, không hoàn chỉnh.
- **Root Cause:** Single prompt quá dài vượt output token limit của model.
- **Giải pháp:** Implement kiến trúc Chained Prompt — chia báo cáo thành nhiều phase (Executive Summary → Deep Dive → Action Plan), call sequentially, ghép kết quả cuối.
