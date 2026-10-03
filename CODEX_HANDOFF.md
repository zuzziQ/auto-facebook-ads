# HANDOFF — Auto Facebook Ads

Cập nhật: 26/08/2026 (Asia/Ho_Chi_Minh)

## 1. Mục tiêu và trạng thái

Dashboard quản trị nhiều doanh nghiệp/profile chạy Facebook Ads. Hệ thống đồng bộ Meta vào SQLite, hiển thị Dashboard, Ad Library, báo cáo, Rule tối ưu realtime, phân tích LLM, target/creative diagnostics và thao tác ngân sách.

Profile hiện có:

- Workspace `1`: Aeslatek.
- Workspace `2`: Phan Thuỷ.

Mọi dữ liệu, target, rule phân loại, lịch sử LLM, cron/backfill và kết nối Meta phải được scope theo workspace. Không để dữ liệu hai profile trộn nhau.

## 2. Môi trường

- Local: `/Users/imam/content-distributor_backup`
- Local URL: `http://localhost:3500/agentic-dashboard`
- VPS: `173.249.19.167`
- SSH alias: `storymee-vps`
- App VPS: `/opt/nexus-ai-dashboard`
- PM2: `nexus-ai-dashboard`
- Public URL: `http://173.249.19.167:3500/agentic-dashboard`
- Stack: Node.js, Express, vanilla HTML/CSS/JS, SQLite (`better-sqlite3`), Gemini, Meta Graph API.
- DB: `data/ads.db` (local và VPS có DB riêng).

Không ghi token, App Secret, Gemini key hoặc mật khẩu vào source/handoff. Secrets dùng `src/services/secretStore.js`. `.env` và JSON credentials là dữ liệu nhạy cảm, không commit/chia sẻ.

SSH ổn định:

```bash
env -u SSH_AUTH_SOCK ssh -o BatchMode=yes -o IdentityAgent=none \
  -i ~/.ssh/id_ed25519_storymee storymee-vps
```

Deploy:

```bash
env -u SSH_AUTH_SOCK scp -o BatchMode=yes -o IdentityAgent=none \
  -i ~/.ssh/id_ed25519_storymee <files> storymee-vps:/opt/nexus-ai-dashboard/

env -u SSH_AUTH_SOCK ssh -o BatchMode=yes -o IdentityAgent=none \
  -i ~/.ssh/id_ed25519_storymee storymee-vps \
  'cd /opt/nexus-ai-dashboard && pm2 restart nexus-ai-dashboard --update-env'
```

Nếu scp route/service vào root app, phải `mv` về đúng `src/...`. Static HTML copy thẳng vào `public/`, không bắt buộc restart.

## 3. File quan trọng

```text
src/server.js                       Express entry, workspace API, Meta actions, LLM
src/routes/adsDashboard.js          Report/rule/sync/backfill/Ad Library API
src/services/facebookAds.js         Meta Insights/config/creative sync
src/services/adsSyncRunner.js       Sync theo workspace, cron/backfill status
src/services/aiOptimizer.js         Prompt và parse Gemini
src/services/secretStore.js         Secrets local
src/services/facebookAdsManager.js  Thao tác ad/adset/campaign
src/db/database.js                  Schema + migrations
public/agentic-dashboard.html       SPA chính; phần lớn UI/logic client
public/settings.html                Kết nối doanh nghiệp/token/page/account
public/report-settings.html         KPI target + classification theo profile
```

Root hiện không có `.git`, nên `git diff` không dùng được. Xem chính xác vùng code trước khi patch.

## 4. DB và workspace scope

Bảng chính:

- `ad_daily_stats`: một dòng/ngày/ad; spend, impressions, clicks, reach, CPM, CTR, frequency, Mess, Lead, Purchase.
- `ad_config`: Campaign/Ad Set/Ad, tên, status, budget, targeting, account.
- `ad_creatives`: body, image/video, thumbnail, sync/change time.
- `workspaces`, `workspace_ad_accounts`, `workspace_pages`.
- `workspace_cpmess_targets`, `workspace_funnel_targets`.
- `workspace_classification_rules`: prefix Ad Name nhận diện dịch vụ/người chạy.
- `workspace_llm_analysis_history`: snapshot LLM riêng profile.

`ad_daily_stats` không có `workspace_id`; scope qua `ad_config.account_id` nối `workspace_ad_accounts`. Query mới phải filter account IDs của workspace.

Classification dựa Ad Name, ví dụ dịch vụ `nam_`, `umau_`, `chambot_`; người chạy `minhlq_`, `huynq_`. Ưu tiên priority cao rồi prefix dài.

## 5. Profile Phan Thuỷ

Workspace ID `2`, 5 ad account. Đã backfill riêng 120 ngày ngày 25/08/2026.

Target:

- Budget 4.000.000đ/ngày.
- Cost/Mess ≤200.000đ; 20–22 Mess/ngày.
- 12–15 qualified Lead/ngày (Meta Lead không đồng nghĩa qualified Lead).
- 5–7 booking/ngày; 3–5 show/ngày (chưa có CRM thì unavailable).
- ≥2 Purchase/ngày; CPP ≤2.000.000đ.
- Revenue ≥8.000.000đ/ngày; ROAS ≥2 (không phân tích nếu chưa có revenue).

Ad đã audit: `120249422189500325`.

- 30D: khoảng 2.609.110đ, 19 Mess, 4 Lead, 4 Purchase.
- Lifetime synced: khoảng 8.500.301đ, 59 Mess, 16 Lead, 4 Purchase.

Meta có thể revise attribution; số sau sync mới nhất là nguồn đúng.

## 6. Cron và backfill

- Cron `0 * * * *`, timezone `Asia/Ho_Chi_Minh`, mỗi giờ phút 00.
- Cuối `src/server.js` gọi `runAdsSync('cron')`.
- Status: `GET /api/ads/sync/status?workspaceId=<id>`.
- Manual: `POST /api/ads/sync` với `workspaceId`.
- Backfill: `POST /api/ads/backfill`, body `{ workspaceId, historyDays }`, 31–1095 ngày.
- Runner có cờ `running` toàn process, không chạy hai sync đồng thời.

Meta Insights theo ngày, level ad, lấy actions/cost_per_action_type. Mapping Mess/Lead/Purchase nằm trong `facebookAds.js`. Sửa mapping xong phải backfill lại lịch sử.

Log Google Sheets `Missing required parameters: spreadsheetId` có thể xuất hiện khi không cấu hình Sheet; SQLite/Meta sync vẫn có thể hoàn tất.

## 7. Ad Library và kỳ dữ liệu

`GET /api/ads/creatives` trả:

- `*_7d`: 7 ngày.
- `*_month`: rolling 30 ngày tính đến `MAX(date)` trong DB.
- `*_lifetime`: toàn bộ ngày đã sync/backfill.

UI chọn `30 ngày gần nhất` (mặc định), `Trọn đời đã đồng bộ`, hoặc `7 ngày`. Kỳ chọn điều khiển số chính và sorting: Spend, Mess, CPMess, Lead, CPL, Purchase, CPP.

Lifetime synced không tự động bằng lifetime thật trên Meta nếu chưa backfill đến ngày tạo ad.

## 8. Rule, Decision Center, LLM

Rule endpoint: `GET /api/ads/rule-optimizations`.

Rule dùng 7D, 3D gần nhất, 3D trước, target, độ tuổi/mẫu và lần đổi budget. Quy tắc cốt lõi:
- **Độ tuổi ad (`run_days`)**: Chỉ trả về `WAIT` (Giai đoạn máy học) khi `run_days < 3` VÀ `spend < target`. Khi `run_days >= 3` (Mature ad), **tuyệt đối không để WAIT ảo** mà bắt buộc đưa ra quyết định hành động (`SCALE_20`, `SCALE_10`, `KEEP`, `DECREASE_20`, `PAUSE`, `NEW_CREATIVE`, `NEW_HOOK`, `FIX_CTA`).
- **Phan Thuỷ ưu tiên đa tầng phễu (Multi-Tier Funnel Evaluation)**:
  1. Purchase/CPP nếu có Purchase (`purchases > 0`).
  2. Nếu `purchases = 0`:
     - Cắt lỗ: Tiêu $\ge 1\times$ target Purchase (2tr) $\to$ `DECREASE_20`; Tiêu $\ge 1.5\times$ target $\to$ `PAUSE`.
     - Đánh giá tầng Tin nhắn/Lead: So sánh CPMess với `target_cpmess` (200k). Nếu CPMess $> 1.2\times$ target (ví dụ 292k) $\to$ đề xuất `DECREASE_20` kèm chẩn đoán Hook/Offer/CTA và điểm nghẽn phễu.
     - Nếu CTR thấp $(< 0.8\%)$ $\to$ `NEW_HOOK`; Mess Rate thấp $(< 5\%)$ $\to$ `FIX_CTA`; Frequency $\ge 2.5\times$ $\to$ `NEW_CREATIVE`.
  3. Tin nhắn/CPMess nếu không có cấu hình phễu conversion.

Decision Center trên card:
- Hero Decision Banner nổi bật: Action Badge (`SCALE +20%`, `GIẢM 20%`, `CÂN NHẮC TẮT`, `ĐỔI HOOK/CREATIVE`, `SỬA CTA`, `THEO DÕI`).
- Lý do cốt lõi (1 câu): Nêu rõ số liệu thực tế so với Target và xu hướng 3 ngày.
- 3 Hành động cụ thể (Action Checklist): 💰 Ngân sách, 🎨 Creative/Content (có hook mẫu trích xuất từ LLM), 🎯 Target/Tệp.
- Accordion thu gọn (`<details class="fb-card-accordion">`): Toàn phễu 7D/3D/30D, 5 điểm nghẽn chẩn đoán, Bối cảnh dài hạn.

LLM endpoint: `GET /api/ads/optimize?workspaceId=<id>&mode=analysis`.
- LLM phối hợp với Rule để giải thích nguyên nhân cốt lõi, trích xuất `actions: { budget, creative, audience }`, `suggestedHook` và `suggestedCTA`.

Snapshot Phan Thuỷ gần nhất sau backfill/context time: history ID `12`, 22 active ads, hash lúc chạy `1abde0d0136e08d6`.

## 9. Popup Ad Library

Đã sửa popup:

- Reset `info.scrollTop=0` mỗi lần mở; trước đây giữ scroll và nhìn như mất header.
- Panel phải `min-height:0; overflow:auto`, close button sticky.
- Media `object-fit:contain`.
- Campaign → Ad Set → Ad Name → Ad ID.
- 7D chart/metrics, 30D, lifetime synced.
- CTR/CTA/Frequency/funnel diagnostics.
- Target test proposal và LLM snapshot.
- Content, target chips, tạo variant, mở Facebook.

Nếu lại bị cắt, kiểm tra scrollTop/CSS và browser cache trước khi đổi layout.

## 10. Image/video

Proxy: `GET /api/ads/img-proxy?adId=<id>&workspaceId=<id>`.

Ảnh/video mờ thường do thumbnail Meta thấp. Creative sync cố lấy source/video picture. Nút Patch ảnh chạy API patch creative. Một số Page Post phụ thuộc Page permission/CDN; không upscale giả bằng CSS.

## 11. Settings và bảo mật

- Dashboard/report dự kiến xem không login.
- Settings chứa token/API key phải yêu cầu admin auth.
- Profile selector kiểu Netflix, mỗi profile có PIN.
- Token/Page/Ad Account/App ID/App Secret ở integration settings.
- Report settings chỉ chứa KPI target, dịch vụ, prefix người chạy.
- API phải mask secrets; không render key ra HTML/localStorage.

Public hiện dùng HTTP/IP. Trước khi chia sẻ rộng cần HTTPS/reverse proxy, session auth, CSRF và rate limit PIN.

## 12. Endpoint quan trọng

```text
GET/POST /api/workspaces...
POST     /api/profile-access
GET/POST /api/settings

GET  /api/ads/summary
GET  /api/ads/reports
GET  /api/ads/performance
GET  /api/ads/daily
GET  /api/ads/monthly
GET  /api/ads/creatives
GET  /api/ads/daily/:adId
GET  /api/ads/rule-optimizations
GET  /api/ads/strategy-overview
GET  /api/ads/llm-analysis-history
GET  /api/ads/llm-analysis-latest
POST /api/ads/sync
GET  /api/ads/sync/status
POST /api/ads/backfill
POST /api/ads/:adId/budget|scale|pause

GET  /api/ads/optimize
POST /api/ads/optimize-ad
POST /api/ads/execute-action
GET  /api/ads/img-proxy
POST /api/ads/patch-creatives
POST /api/ads/auto-publish
```

## 13. Validate/deploy

```bash
node -c src/server.js
node -c src/routes/adsDashboard.js
node -c src/services/aiOptimizer.js

node - <<'NODE'
const fs=require('fs');
const html=fs.readFileSync('public/agentic-dashboard.html','utf8');
for (const [i,m] of [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].entries()) {
  new Function(m[1]);
  console.log('inline script',i,'OK');
}
NODE
```

VPS:

```bash
pm2 show nexus-ai-dashboard
pm2 logs nexus-ai-dashboard --lines 50 --nostream
curl -fsS -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:3500/agentic-dashboard
sqlite3 data/ads.db 'pragma quick_check;'
```

## 14. Việc nên làm tiếp

1. Tách `agentic-dashboard.html` thành CSS/JS modules; template literals một dòng rất khó patch/test.
2. Test tự động phép tính 3D/7D/30D/lifetime và workspace scope.
3. Thêm data-completeness theo metric để phân biệt zero thật với ngày lịch sử chưa có Lead/Purchase.
4. Đồng bộ breakdown age/gender/placement/geo theo conversion để target analysis có bằng chứng.
5. Kết nối CRM/Pancake cho qualified Lead, booking, show, revenue.
6. Bảo vệ Settings/API mutation bằng session auth, HTTPS, CSRF, rate limiting.
7. Dùng helper/component chung cho card, popup và AI Optimizer diagnostics.
8. Thêm `analysis_version` và nút regenerate khi Rule/prompt/window thay đổi.

Known caveats:

- Meta attribution có thể revise lịch sử.
- Bộ lọc kỳ trên card không đổi cửa sổ Rule.
- CPL chưa có business target riêng; không gọi benchmark học từ lịch sử là “target kinh doanh”.
- Escape dữ liệu người dùng bằng `analyticsEscape` trong inline HTML.

## 15. Trạng thái bàn giao

- VPS process online sau deploy gần nhất.
- Phan Thuỷ đã backfill 120 ngày và tạo snapshot LLM mới.
- Ad Library mặc định 30D, có lifetime synced và 7D.
- Card/popup có funnel, creative và target diagnostics.
- Các lần audit/backfill gần nhất không tự thay budget/status quảng cáo.
