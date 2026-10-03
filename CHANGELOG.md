# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]
- **Modified**: Nâng cấp hệ thống AI Advisor, thêm form nhập 5 chỉ số thủ công (Lead, Hẹn, Đến, Chốt, Doanh thu). Thay đổi prompt AI để tập trung phân tích Cấu trúc phân bổ Ngân sách (Budget Structure) và so sánh chéo kết quả thay vì bám víu vào KPI.

- **Fixed**: Viết lại hàm postVideo chuyển sang sử dụng Facebook Resumable Upload API (Chunked) để xử lý dứt điểm lỗi 413 Payload Too Large khi upload file video nặng (trên 100MB).

- **Added**: Mở rộng Knowledge Base từ 5 trường lên 7 trường (thêm Quy tắc Thiết kế & Quy tắc Video). Nạp dữ liệu thành công qua giao diện và DB cục bộ.
- **Added**: Bổ sung menu chọn `Thời lượng Video` (15s, 30s, 60s...) dưới mục Loại Content. Ép luật thời lượng vào Context Prompt của Creative Director để ra Script ngắn/dài tùy ý chuẩn chỉnh.

- **Fixed**: C?p nh?t h�m \copyText()\ b?ng c� ch? Polyfill (document.execCommand) �? n�t Copy ho?t �?ng b?nh th�?ng tr�n m?ng LAN (IP 172.16...). �i?m m� c?a Clipboard API do k?t n?i kh�ng c� ch?ng ch? HTTPS.

- **Fixed**: L?i s?p h? th?ng (Could not parse JSON) khi Gemini xu?t r�c k�m theo JSON, �?ng th?i s?a Schema Type th�nh ch? in hoa chu?n API m?i.

- **Fixed**: T�ng c�?ng b?c th�p ch?ng �?t g?y 503 (Qu� t?i Google Server) b?ng c�ch n�ng Limit Retry t? 3 l�n 6 v� gi?n c? Delay, �?ng th?i b�o l?i TV n?u r?t.
