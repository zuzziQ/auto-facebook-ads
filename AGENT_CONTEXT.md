# AGENT CONTEXT — Content Distributor (Aeslatek Ads Hub)
📍 **Root:** `H:\ai-folder\external\content-distributor`
🌐 **URL Local:** `http://localhost:3500`

## Vai Trò
Máy bơm nội dung tự động lên đa nền tảng: Facebook Pages, WordPress, Google Drive. Tích hợp Gemini AI review nội dung + AI Strategy Advisor cho chiến lược quảng cáo.

## Stack
- **Runtime:** Node.js + Express
- **AI:** Google Gemini API (content review + strategy)
- **Integrations:** Facebook Graph API, WordPress REST API, Google Sheets API, Google Drive
- **Cron:** Hourly sync Facebook Ads data

## Files Quan Trọng
- `src/server.js` hoặc `index.js` — Entry point
- `scripts/auth/get-fb-token.js` — Lấy Facebook access token
- `scripts/check/` — Health check, verify scripts
- `docs/DEBUG_HISTORY.md` — Lịch sử bug

## Đọc Thêm
- `H:\ai-folder\.ai-profile\04-ports-registry.md`
- `H:\ai-folder\ai-outputs\logs\GLOBAL_DEBUG_HISTORY.md`

## AI Sessions (Past Conversations)
| Ngày | Conversation ID | Nội dung chính |
|---|---|---|
| 2026-03-25 → 04-18 | `4ba8c0c6-1ffd-4b05-a978-28e5199089ed` | Fix port 3005→3500 env conflict, Knowledge Base 7 fields, video duration constraint, clipboard fix |
| 2026-04-17 | `145eac3c-1d71-495d-a34e-ed258c8cb75c` | Fix AI Advisor button (showAiStrategy function missing) |
| 2026-04-15 → 16 | `828038c8-c77b-416b-a678-4ff582b0feb6` | AI Strategy multi-phase chained prompt, history management, delete reports |
| 2026-04-19 → 20 | `8ca891e6-b08b-4042-9c8c-6c4662ecd48a` | Quy hoạch scripts/, gom 21 loose files vào subfolders |
