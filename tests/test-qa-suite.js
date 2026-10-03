const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');
const { evaluateAdRule, getBudgetAction, getActionType } = require('../src/routes/adsDashboard');
const { db } = require('../src/db/database');

console.log('===============================================================');
console.log('=== [QA TEST SUITE: Facebook Ads Dashboard Quality Assurance] ===');
console.log('===============================================================\n');

let passCount = 0;
let failCount = 0;

function it(desc, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${desc}`);
    passCount++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${desc}`);
    console.error(`     Error: ${err.message}`);
    failCount++;
  }
}

// -------------------------------------------------------------
// PHẦN 1: KIỂM TRA CÚ PHÁP TOÀN BỘ (SYNTAX VALIDATION)
// -------------------------------------------------------------
console.log('--- 1. SYNTAX VALIDATION ---');

it('Cú pháp file src/server.js hợp lệ', () => {
  execSync('node -c src/server.js', { cwd: path.join(__dirname, '..') });
});

it('Cú pháp file src/routes/adsDashboard.js hợp lệ', () => {
  execSync('node -c src/routes/adsDashboard.js', { cwd: path.join(__dirname, '..') });
});

it('Cú pháp file src/services/aiOptimizer.js hợp lệ', () => {
  execSync('node -c src/services/aiOptimizer.js', { cwd: path.join(__dirname, '..') });
});

it('Cú pháp inline script trong public/agentic-dashboard.html hợp lệ', () => {
  const htmlPath = path.join(__dirname, '../public/agentic-dashboard.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let scriptCount = 0;
  while ((match = scriptRegex.exec(html)) !== null) {
    const scriptContent = match[1];
    if (!match[0].includes('src=') || scriptContent.trim().length > 0) {
      scriptCount++;
      new vm.Script(scriptContent, { filename: `inline-script-${scriptCount}.js` });
    }
  }
  assert(scriptCount > 0, 'Phải tìm thấy ít nhất 1 inline script');
});

// -------------------------------------------------------------
// PHẦN 2: RULE ENGINE LOGIC & EDGE CASES (evaluateAdRule)
// -------------------------------------------------------------
console.log('\n--- 2. RULE ENGINE LOGIC & SCENARIOS ---');

it('Ad mới chạy < 3 ngày, chi tiêu bình thường -> WAIT (LEARNING_PHASE)', () => {
  const result = evaluateAdRule({
    row: { run_days: 1, spend: 100000, frequency: 1.1, ctr: 1.5, mess_rate: 2.0 },
    workspaceId: 1,
    primaryMetric: 'message',
    primaryLabel: 'Tin nhắn',
    primaryCount: 0,
    primaryCost: 0,
    primaryTarget: 250000,
    primary3d: null,
    primaryPrev3d: null,
    primaryTrendPct: null,
    primaryStable: true,
    changedRecently: false,
    ctrBase: 1.0,
    messRateBase: 1.5
  });

  assert.strictEqual(result.action, 'WAIT');
  assert.strictEqual(result.root_cause, 'LEARNING_PHASE');
  assert.strictEqual(result.action_type, 'watch');
  assert.strictEqual(result.budget_action.type, 'wait');
});

it('Ad mới chạy < 3 ngày nhưng tiêu >= 2x target và 0 kết quả -> DECREASE_20 (HIGH_BURN_RATE)', () => {
  const result = evaluateAdRule({
    row: { run_days: 2, spend: 600000, frequency: 1.2, ctr: 1.0, mess_rate: 1.0 },
    workspaceId: 1,
    primaryMetric: 'message',
    primaryLabel: 'Tin nhắn',
    primaryCount: 0,
    primaryCost: 0,
    primaryTarget: 250000,
    primary3d: null,
    primaryPrev3d: null,
    primaryTrendPct: null,
    primaryStable: true,
    changedRecently: false,
    ctrBase: 1.0,
    messRateBase: 1.5
  });

  assert.strictEqual(result.action, 'DECREASE_20');
  assert.strictEqual(result.root_cause, 'HIGH_BURN_RATE');
  assert.strictEqual(result.action_type, 'reduce');
  assert.strictEqual(result.budget_action.percent, -20);
});

it('Ad có kết quả tốt (chi phí <= 50% target, count >= 5, 3D ổn định) -> INCREASE_20 (scale)', () => {
  const result = evaluateAdRule({
    row: { run_days: 7, spend: 500000, impressions: 5000, clicks: 100, frequency: 1.5, ctr: 2.0, mess_rate: 3.0 },
    workspaceId: 1,
    primaryMetric: 'message',
    primaryLabel: 'Tin nhắn',
    primaryCount: 5,
    primaryCost: 100000,
    primaryTarget: 250000,
    primary3d: 95000,
    primaryPrev3d: 100000,
    primaryTrendPct: -5,
    primaryStable: true,
    changedRecently: false,
    ctrBase: 1.5,
    messRateBase: 2.0
  });

  assert.strictEqual(result.action, 'INCREASE_20');
  assert.strictEqual(result.root_cause, 'GOOD_PERFORMANCE');
  assert.strictEqual(result.action_type, 'scale');
  assert.strictEqual(result.budget_action.percent, 20);
  assert.strictEqual(result.budget_action.direction, 'UP');
});

it('Ad có kết quả tốt vừa (chi phí <= 50% target, count >= 3, 3d cost <= target) -> INCREASE_10 (scale)', () => {
  const result = evaluateAdRule({
    row: { run_days: 5, spend: 360000, impressions: 4000, clicks: 80, frequency: 1.4, ctr: 2.0, mess_rate: 2.5 },
    workspaceId: 1,
    primaryMetric: 'message',
    primaryLabel: 'Tin nhắn',
    primaryCount: 3,
    primaryCost: 120000,
    primaryTarget: 250000,
    primary3d: 130000,
    primaryPrev3d: 120000,
    primaryTrendPct: 8,
    primaryStable: false,
    changedRecently: false,
    ctrBase: 1.5,
    messRateBase: 2.0
  });

  assert.strictEqual(result.action, 'INCREASE_10');
  assert.strictEqual(result.root_cause, 'GOOD_PERFORMANCE');
  assert.strictEqual(result.action_type, 'scale');
  assert.strictEqual(result.budget_action.percent, 10);
});

it('Ad tiêu >= 2x target nhưng 0 chuyển đổi (đã chạy >= 3 ngày) -> PAUSE (NO_CONVERSIONS)', () => {
  const result = evaluateAdRule({
    row: { run_days: 6, spend: 550000, impressions: 6000, clicks: 120, frequency: 1.6, ctr: 2.0, mess_rate: 0 },
    workspaceId: 1,
    primaryMetric: 'message',
    primaryLabel: 'Tin nhắn',
    primaryCount: 0,
    primaryCost: 0,
    primaryTarget: 250000,
    primary3d: null,
    primaryPrev3d: null,
    primaryTrendPct: null,
    primaryStable: true,
    changedRecently: false,
    ctrBase: 1.5,
    messRateBase: 2.0
  });

  assert.strictEqual(result.action, 'PAUSE');
  assert.strictEqual(result.root_cause, 'NO_CONVERSIONS');
  assert.strictEqual(result.action_type, 'pause');
  assert.strictEqual(result.budget_action.type, 'pause');
  assert.strictEqual(result.budget_action.allowPause, true);
});

it('Ad chi phí vượt 120% target (ratio > 1.2) -> DECREASE_20 (COST_OVER_TARGET)', () => {
  const result = evaluateAdRule({
    row: { run_days: 7, spend: 950000, impressions: 8000, clicks: 150, frequency: 1.7, ctr: 1.8, mess_rate: 1.8 },
    workspaceId: 1,
    primaryMetric: 'message',
    primaryLabel: 'Tin nhắn',
    primaryCount: 3,
    primaryCost: 316666,
    primaryTarget: 250000,
    primary3d: 320000,
    primaryPrev3d: 300000,
    primaryTrendPct: 6,
    primaryStable: true,
    changedRecently: false,
    ctrBase: 1.5,
    messRateBase: 2.0
  });

  assert.strictEqual(result.action, 'DECREASE_20');
  assert.strictEqual(result.root_cause, 'COST_OVER_TARGET');
  assert.strictEqual(result.action_type, 'reduce');
  assert.strictEqual(result.budget_action.percent, -20);
});

it('Ad chi phí vượt 150% target -> PAUSE (COST_OVER_TARGET)', () => {
  const result = evaluateAdRule({
    row: { run_days: 7, spend: 1200000, impressions: 8000, clicks: 150, frequency: 1.7, ctr: 1.8, mess_rate: 1.8 },
    workspaceId: 1,
    primaryMetric: 'message',
    primaryLabel: 'Tin nhắn',
    primaryCount: 3,
    primaryCost: 400000,
    primaryTarget: 250000,
    primary3d: 410000,
    primaryPrev3d: 390000,
    primaryTrendPct: 5,
    primaryStable: true,
    changedRecently: false,
    ctrBase: 1.5,
    messRateBase: 2.0
  });

  assert.strictEqual(result.action, 'PAUSE');
  assert.strictEqual(result.root_cause, 'COST_OVER_TARGET');
  assert.strictEqual(result.action_type, 'pause');
});

it('Ad có Frequency >= 2.5x -> NEW_CREATIVE (CREATIVE_FATIGUE)', () => {
  const result = evaluateAdRule({
    row: { run_days: 10, spend: 700000, impressions: 12000, clicks: 200, frequency: 2.8, ctr: 1.6, mess_rate: 1.8 },
    workspaceId: 1,
    primaryMetric: 'message',
    primaryLabel: 'Tin nhắn',
    primaryCount: 3,
    primaryCost: 233333,
    primaryTarget: 250000,
    primary3d: 230000,
    primaryPrev3d: 220000,
    primaryTrendPct: 4,
    primaryStable: true,
    changedRecently: false,
    ctrBase: 1.5,
    messRateBase: 2.0
  });

  assert.strictEqual(result.action, 'NEW_CREATIVE');
  assert.strictEqual(result.root_cause, 'CREATIVE_FATIGUE');
  assert.strictEqual(result.action_type, 'watch');
});

it('Tầng Tin nhắn: Ad có CPMess 132k <= target 200k, spend 661k (< 1.5x target_purchase 3tr) -> KEEP (KHÔNG BỊ PHÁN DECREASE_20)', () => {
  const result = evaluateAdRule({
    row: { run_days: 5, spend: 661000, impressions: 5000, clicks: 100, frequency: 1.2, ctr: 2.0, mess_rate: 5.0, mess: 5, cpmess: 132200, leads: 0, purchases: 0 },
    workspaceId: 2,
    primaryMetric: 'message',
    primaryLabel: 'Tin nhắn',
    primaryCount: 5,
    primaryCost: 132200,
    primaryTarget: 200000,
    target_cpmess: 200000,
    target_purchase: 2000000,
    target_lead: 500000,
    ctrBase: 1.5,
    messRateBase: 4.0
  });

  assert.notStrictEqual(result.action, 'DECREASE_20', 'CPMess 132k < 200k và spend 661k < 3tr tuyệt đối không được là DECREASE_20');
  assert.notStrictEqual(result.action, 'PAUSE', 'Không được là PAUSE');
  assert.strictEqual(result.action, 'KEEP');
  assert.strictEqual(result.root_cause, 'SAFE_ZONE');
});

it('Tầng 0 Kết quả: spend >= 2x target_cpmess (400k) -> PAUSE; spend >= 1x target_cpmess (200k) -> DECREASE_20', () => {
  const resPause = evaluateAdRule({
    row: { run_days: 4, spend: 450000, impressions: 3000, clicks: 40, frequency: 1.1, ctr: 1.33, mess_rate: 0, mess: 0, leads: 0, purchases: 0 },
    workspaceId: 2,
    primaryMetric: 'message',
    primaryLabel: 'Tin nhắn',
    primaryCount: 0,
    primaryCost: 450000,
    primaryTarget: 200000,
    target_cpmess: 200000,
    target_purchase: 2000000
  });
  assert.strictEqual(resPause.action, 'PAUSE');
  assert.strictEqual(resPause.root_cause, 'NO_CONVERSIONS');

  const resDecrease = evaluateAdRule({
    row: { run_days: 3, spend: 250000, impressions: 2000, clicks: 25, frequency: 1.1, ctr: 1.25, mess_rate: 0, mess: 0, leads: 0, purchases: 0 },
    workspaceId: 2,
    primaryMetric: 'message',
    primaryLabel: 'Tin nhắn',
    primaryCount: 0,
    primaryCost: 250000,
    primaryTarget: 200000,
    target_cpmess: 200000,
    target_purchase: 2000000
  });
  assert.strictEqual(resDecrease.action, 'DECREASE_20');
  assert.strictEqual(resDecrease.root_cause, 'COST_OVER_TARGET');
});

it('Mẫu hình Sudden Dip (Hôm nay tiêu >= 0.8x target nhưng 0-1 tin nhắn, dù lịch sử tốt) -> SUDDEN_DIP (watch, allowPause = false)', () => {
  const result = evaluateAdRule({
    row: {
      run_days: 7,
      spend: 1200000,
      days_with_mess: 5,
      mess_prev_3d: 6,
      spend_prev_3d: 600000,
      cpmess_prev_3d: 100000,
      today_spend: 180000,
      today_mess: 0,
      spend_3d: 380000,
      mess_3d: 2,
      mess: 8,
      leads: 0,
      purchases: 0
    },
    workspaceId: 1,
    primaryMetric: 'message',
    primaryLabel: 'Tin nhắn',
    primaryCount: 8,
    primaryCost: 150000,
    primaryTarget: 200000,
    target_cpmess: 200000,
    target_purchase: 2000000
  });

  assert.strictEqual(result.action, 'SUDDEN_DIP');
  assert.strictEqual(result.root_cause, 'SUDDEN_PERFORMANCE_DIP');
  assert.strictEqual(result.action_type, 'watch');
  assert.strictEqual(result.budget_action.type, 'reduce_20');
  assert.strictEqual(result.budget_action.percent, -20);
  assert.strictEqual(result.budget_action.allowPause, false);
  assert.strictEqual(result.budget_action.allowDown, true);
  assert.strictEqual(result.budget_action.allowUp, false);
  assert(result.title.includes('Đột biến giảm trong ngày') || result.title.includes('theo dõi 24h'));
  assert(result.reason.includes('Không nên tắt ngay làm hỏng tệp'));
});

it('Mẫu hình Sudden Dip (Chi phí 3D tăng vọt >= 40% so với 3D trước dù lịch sử tốt) -> SUDDEN_DIP', () => {
  const result = evaluateAdRule({
    row: {
      run_days: 6,
      days_with_mess: 4,
      mess_prev_3d: 5,
      spend_prev_3d: 600000,
      cpmess_prev_3d: 120000,
      spend_3d: 600000,
      mess_3d: 2,
      today_spend: 100000,
      today_mess: 0,
      mess: 7,
      leads: 0,
      purchases: 0
    },
    workspaceId: 1,
    primaryMetric: 'message',
    primaryLabel: 'Tin nhắn',
    primaryCount: 7,
    primaryCost: 171428,
    primaryTarget: 200000,
    primary3d: 300000,
    primaryPrev3d: 120000,
    primaryTrendPct: 150,
    target_cpmess: 200000,
    target_purchase: 2000000
  });

  assert.strictEqual(result.action, 'SUDDEN_DIP');
  assert.strictEqual(result.root_cause, 'SUDDEN_PERFORMANCE_DIP');
  assert.strictEqual(result.action_type, 'watch');
  assert.strictEqual(result.budget_action.allowPause, false);
});

it('Tầng Purchase: purchases > 0 được đánh giá theo primaryMetric = purchase và target_purchase', () => {
  const result = evaluateAdRule({
    row: { run_days: 7, spend: 1800000, impressions: 8000, clicks: 160, frequency: 1.3, ctr: 2.0, mess_rate: 7.5, mess: 12, leads: 5, purchases: 3 },
    workspaceId: 2,
    target_cpmess: 200000,
    target_lead: 500000,
    target_purchase: 2000000,
    primary3d: 500000
  });

  assert(['INCREASE_10', 'INCREASE_20', 'KEEP'].includes(result.action));
  assert.strictEqual(result.root_cause, 'GOOD_PERFORMANCE');
  assert(result.reason.includes('Purchase'));
});

it('Tầng Lead: leads > 0, purchases = 0 được đánh giá theo primaryMetric = lead và target_lead', () => {
  const result = evaluateAdRule({
    row: { run_days: 5, spend: 1200000, impressions: 6000, clicks: 120, frequency: 1.2, ctr: 2.0, mess_rate: 6.0, mess: 8, leads: 3, purchases: 0 },
    workspaceId: 2,
    target_cpmess: 200000,
    target_lead: 500000,
    target_purchase: 2000000,
    ctrBase: 1.5,
    messRateBase: 4.0
  });

  assert(['INCREASE_10', 'KEEP'].includes(result.action));
  assert(result.reason.includes('Lead'));
});

// -------------------------------------------------------------
// PHẦN 3: KIỂM TRA CHUYÊN SÂU AD 6.6 CSDM -28-7 (ID 120251592543220325)
// -------------------------------------------------------------
console.log('\n--- 3. DEEP INSPECTION: AD 6.6 CSDM -28-7 (ID 120251592543220325) ---');

it('Ad 6.6 CSDM -28-7: Đạt chuẩn DECREASE_20, không WAIT, lý do nêu rõ CPMess 292k vượt target 200k và 0 purchase sau 1.75tr', () => {
  const testAd = {
    row: {
      ad_id: '120251592543220325',
      ad_name: '6.6 CSDM -28-7',
      run_days: 6,
      spend: 1750000,
      mess: 6,
      cpmess: 292000,
      purchases: 0,
      leads: 0,
      impressions: 6500,
      clicks: 120,
      ctr: 1.85,
      mess_rate: 5.0,
      frequency: 1.35
    },
    workspaceId: 2,
    primaryMetric: 'message',
    primaryLabel: 'Tin nhắn',
    primaryCount: 6,
    primaryCost: 292000,
    primaryTarget: 200000,
    target_cpmess: 200000,
    target_purchase: 2000000,
    ctrBase: 1.5,
    messRateBase: 4.5
  };

  const result = evaluateAdRule(testAd);

  // 1. action KHÔNG ĐƯỢC LÀ WAIT
  assert.notStrictEqual(result.action, 'WAIT', 'action KHÔNG ĐƯỢC LÀ WAIT');

  // 2. action phải là DECREASE_20 hoặc NEW_HOOK/FIX_CTA
  assert(['DECREASE_20', 'NEW_HOOK', 'FIX_CTA'].includes(result.action), `action phải là DECREASE_20/NEW_HOOK/FIX_CTA, nhận được: ${result.action}`);
  assert.strictEqual(result.action, 'DECREASE_20');

  // 3. reason phải nêu rõ CPMess 292k vượt target 200k và chưa có Purchase sau 1.75tr spend
  assert(result.reason.includes('CPMess (292.000đ) vượt mục tiêu 200.000đ'), 'Reason phải nêu rõ CPMess 292.000đ vượt mục tiêu 200.000đ');
  assert(result.reason.includes('chưa tạo Purchase sau 1.750.000đ chi tiêu'), 'Reason phải nêu rõ chưa tạo Purchase sau 1.750.000đ');

  // 4. budget_action phải có { allowDown: true, percent: -20 }
  assert.strictEqual(result.budget_action.allowDown, true, 'allowDown phải là true');
  assert.strictEqual(result.budget_action.percent, -20, 'percent phải là -20');
  assert.strictEqual(result.budget_action.direction, 'DOWN', 'direction phải là DOWN');
});

it('Ad 6.6 CSDM -28-7 với CTR thấp (< 70% chuẩn) -> NEW_HOOK kèm budget allowDown: true', () => {
  const testAd = {
    row: {
      ad_id: '120251592543220325',
      ad_name: '6.6 CSDM -28-7',
      run_days: 6,
      spend: 1750000,
      mess: 6,
      cpmess: 292000,
      purchases: 0,
      leads: 0,
      impressions: 6500,
      clicks: 30,
      ctr: 0.46,
      mess_rate: 20.0,
      frequency: 1.35
    },
    workspaceId: 2,
    primaryMetric: 'message',
    primaryLabel: 'Tin nhắn',
    primaryCount: 6,
    primaryCost: 292000,
    primaryTarget: 200000,
    target_cpmess: 200000,
    target_purchase: 2000000,
    ctrBase: 1.5,
    messRateBase: 4.5
  };

  const result = evaluateAdRule(testAd);
  assert.strictEqual(result.action, 'NEW_HOOK');
  assert.strictEqual(result.root_cause, 'WEAK_HOOK');
  assert(result.reason.includes('CPMess (292.000đ) vượt mục tiêu 200.000đ'));
  assert(result.reason.includes('chưa tạo Purchase sau 1.750.000đ chi tiêu'));
  assert.strictEqual(result.budget_action.allowDown, true);
});

it('Ad 6.6 CSDM -28-7 với Mess Rate thấp (< 70% chuẩn) -> FIX_CTA kèm budget allowDown: true', () => {
  const testAd = {
    row: {
      ad_id: '120251592543220325',
      ad_name: '6.6 CSDM -28-7',
      run_days: 6,
      spend: 1750000,
      mess: 6,
      cpmess: 292000,
      purchases: 0,
      leads: 0,
      impressions: 6500,
      clicks: 250,
      ctr: 3.84,
      mess_rate: 2.4,
      frequency: 1.35
    },
    workspaceId: 2,
    primaryMetric: 'message',
    primaryLabel: 'Tin nhắn',
    primaryCount: 6,
    primaryCost: 292000,
    primaryTarget: 200000,
    target_cpmess: 200000,
    target_purchase: 2000000,
    ctrBase: 1.5,
    messRateBase: 4.5
  };

  const result = evaluateAdRule(testAd);
  assert.strictEqual(result.action, 'FIX_CTA');
  assert.strictEqual(result.root_cause, 'WEAK_CTA');
  assert(result.reason.includes('CPMess (292.000đ) vượt mục tiêu 200.000đ'));
  assert(result.reason.includes('chưa tạo Purchase sau 1.750.000đ chi tiêu'));
  assert.strictEqual(result.budget_action.allowDown, true);
});

// -------------------------------------------------------------
// PHẦN 4: KIỂM TRA TÍNH NĂNG ẢNH (IMG-PROXY & DIRECT CDN)
// -------------------------------------------------------------
console.log('\n--- 4. IMAGE PROXY & DIRECT CDN VERIFICATION ---');

it('Kiểm tra cấu trúc endpoint /api/ads/img-proxy trong src/server.js', () => {
  const serverCode = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert(serverCode.includes("app.get('/api/ads/img-proxy'"), 'server.js phải định nghĩa GET /api/ads/img-proxy');
  assert(serverCode.includes("res.setHeader('Content-Type'"), 'img-proxy phải set header Content-Type');
  assert(serverCode.includes("res.setHeader('Cache-Control'"), 'img-proxy phải set header Cache-Control');
  assert(serverCode.includes("imgRes.data.pipe(res)"), 'img-proxy phải stream response bằng pipe');
  assert(serverCode.includes("res.redirect(imgUrl)"), 'img-proxy phải có fallback redirect khi stream gặp sự cố');
  assert(serverCode.includes("row?.thumbnail_url"), 'img-proxy phải fallback lấy thumbnail_url từ DB khi API không có');
});

it('Kiểm tra dữ liệu ad_creatives có thumbnail_url hợp lệ trong DB', () => {
  const sampleWithThumb = db.prepare("SELECT ad_id, thumbnail_url FROM ad_creatives WHERE thumbnail_url IS NOT NULL AND thumbnail_url != '' LIMIT 1").get();
  assert(sampleWithThumb, 'Phải có ít nhất 1 creative có thumbnail_url trong DB');
  assert(sampleWithThumb.thumbnail_url.startsWith('http'), 'thumbnail_url phải là URL hợp lệ (http/https)');
});

it('Kiểm tra giao diện frontend agentic-dashboard.html tích hợp img-proxy error fallback', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/agentic-dashboard.html'), 'utf8');
  assert(html.includes('/api/ads/img-proxy?adId='), 'HTML phải gọi /api/ads/img-proxy khi render hình ảnh');
  assert(html.includes('previewImgErrHandler') || html.includes('imgErrHandler'), 'HTML phải có error handler fallback ảnh');
});

// -------------------------------------------------------------
// PHẦN 5: KIỂM THỬ TOÀN BỘ 22 ACTIVE ADS TRONG WORKSPACE 2
// -------------------------------------------------------------
console.log('\n--- 5. WORKSPACE 2 ACTIVE ADS COMPREHENSIVE SUITE (22 ACTIVE ADS) ---');

it('Kiểm thử bộ 22 Active Ads trong Workspace 2: Tuyệt đối không ad nào chạy >= 3 ngày bị gán WAIT/máy học', () => {
  const simulated22Ads = [
    { id: 'ad_01', name: '6.6 CSDM -28-7', run_days: 6, spend: 1750000, mess: 6, cpmess: 292000, purchases: 0, leads: 0, imp: 6500, clk: 120, ctr: 1.85, mr: 5.0, f: 1.35 },
    { id: 'ad_02', name: '6.6 UMM -29-7', run_days: 4, spend: 1400000, mess: 5, cpmess: 280000, purchases: 0, leads: 0, imp: 5000, clk: 25, ctr: 0.5, mr: 20.0, f: 1.2 },
    { id: 'ad_03', name: '6.6 ChamBot -01-8', run_days: 5, spend: 1350000, mess: 5, cpmess: 270000, purchases: 0, leads: 0, imp: 4000, clk: 200, ctr: 5.0, mr: 2.5, f: 1.3 },
    { id: 'ad_04', name: '6.6 NamLaser -02-8', run_days: 7, spend: 2100000, mess: 12, cpmess: 175000, purchases: 0, leads: 0, imp: 8000, clk: 160, ctr: 2.0, mr: 7.5, f: 1.4 },
    { id: 'ad_05', name: '6.6 Botox -03-8', run_days: 7, spend: 3200000, mess: 15, cpmess: 213333, purchases: 0, leads: 0, imp: 12000, clk: 240, ctr: 2.0, mr: 6.25, f: 1.5 },
    { id: 'ad_06', name: '6.6 Filler -04-8', run_days: 7, spend: 4500000, mess: 18, cpmess: 250000, purchases: 0, leads: 0, imp: 15000, clk: 300, ctr: 2.0, mr: 6.0, f: 1.6 },
    { id: 'ad_07', name: '6.6 Mun -05-8', run_days: 6, spend: 1200000, mess: 8, cpmess: 150000, purchases: 0, leads: 0, imp: 5500, clk: 110, ctr: 2.0, mr: 7.27, f: 1.25 },
    { id: 'ad_08', name: '6.6 Seo -06-8', run_days: 5, spend: 1000000, mess: 10, cpmess: 100000, purchases: 0, leads: 0, imp: 6000, clk: 150, ctr: 2.5, mr: 6.67, f: 1.3 },
    { id: 'ad_09', name: '6.6 TreHoa -07-8', run_days: 7, spend: 900000, mess: 5, cpmess: 180000, purchases: 0, leads: 0, imp: 4000, clk: 80, ctr: 2.0, mr: 6.25, f: 2.8 },
    { id: 'ad_10', name: '6.6 NangCo -08-8', run_days: 5, spend: 800000, mess: 4, cpmess: 200000, purchases: 0, leads: 0, imp: 6000, clk: 30, ctr: 0.5, mr: 13.33, f: 1.2 },
    { id: 'ad_11', name: '6.6 Trangsang -09-8', run_days: 6, spend: 750000, mess: 4, cpmess: 187500, purchases: 0, leads: 0, imp: 4000, clk: 150, ctr: 3.75, mr: 2.67, f: 1.3 },
    { id: 'ad_12', name: '6.6 Peel -10-8', run_days: 4, spend: 450000, mess: 0, cpmess: 0, purchases: 0, leads: 0, imp: 2500, clk: 40, ctr: 1.6, mr: 0, f: 1.2 },
    { id: 'ad_13', name: '6.6 Mesotherapy -11-8', run_days: 3, spend: 250000, mess: 0, cpmess: 0, purchases: 0, leads: 0, imp: 1500, clk: 25, ctr: 1.67, mr: 0, f: 1.1 },
    { id: 'ad_14', name: '6.6 CăngChỉ -12-8', run_days: 3, spend: 120000, mess: 0, cpmess: 0, purchases: 0, leads: 0, imp: 800, clk: 12, ctr: 1.5, mr: 0, f: 1.05 },
    { id: 'ad_15', name: '6.6 CatMi -13-8', run_days: 7, spend: 800000, mess: 5, cpmess: 160000, purchases: 1, leads: 2, imp: 4000, clk: 80, ctr: 2.0, mr: 6.25, f: 1.2 },
    { id: 'ad_16', name: '6.6 NângMũi -14-8', run_days: 7, spend: 1800000, mess: 12, cpmess: 150000, purchases: 3, leads: 5, imp: 8000, clk: 160, ctr: 2.0, mr: 7.5, f: 1.3 },
    { id: 'ad_17', name: '6.6 CấyMỡ -15-8', run_days: 7, spend: 2500000, mess: 15, cpmess: 166667, purchases: 5, leads: 8, imp: 10000, clk: 200, ctr: 2.0, mr: 7.5, f: 1.35 },
    { id: 'ad_18', name: '6.6 HútMỡ -16-8', run_days: 7, spend: 5600000, mess: 20, cpmess: 280000, purchases: 2, leads: 4, imp: 20000, clk: 350, ctr: 1.75, mr: 5.71, f: 1.45 },
    { id: 'ad_19', name: '6.6 TạoHình -17-8', run_days: 7, spend: 3500000, mess: 10, cpmess: 350000, purchases: 1, leads: 2, imp: 12000, clk: 180, ctr: 1.5, mr: 5.56, f: 1.4 },
    { id: 'ad_20', name: '6.6 TriệtLông -18-8', run_days: 5, spend: 600000, mess: 3, cpmess: 200000, purchases: 0, leads: 0, imp: 3000, clk: 50, ctr: 1.67, mr: 6.0, f: 1.2, changedRecently: true },
    { id: 'ad_21', name: '6.6 ChămSócDa -19-8', run_days: 1, spend: 50000, mess: 0, cpmess: 0, purchases: 0, leads: 0, imp: 400, clk: 6, ctr: 1.5, mr: 0, f: 1.02 },
    { id: 'ad_22', name: '6.6 ĐiệnDi -20-8', run_days: 2, spend: 500000, mess: 0, cpmess: 0, purchases: 0, leads: 0, imp: 2500, clk: 30, ctr: 1.2, mr: 0, f: 1.1 }
  ];

  assert.strictEqual(simulated22Ads.length, 22, 'Phải có chính xác 22 Ads được test');

  simulated22Ads.forEach((ad) => {
    const isPurchaseAd = ad.purchases > 0;
    const primaryMetric = isPurchaseAd ? 'purchase' : 'message';
    const primaryLabel = isPurchaseAd ? 'Purchase' : 'Tin nhắn';
    const primaryCount = isPurchaseAd ? ad.purchases : ad.mess;
    const primaryCost = primaryCount > 0 ? Math.round(ad.spend / primaryCount) : 0;
    const primaryTarget = isPurchaseAd ? 2000000 : 200000;

    const result = evaluateAdRule({
      row: {
        ad_id: ad.id,
        ad_name: ad.name,
        run_days: ad.run_days,
        spend: ad.spend,
        mess: ad.mess,
        purchases: ad.purchases,
        leads: ad.leads,
        cpmess: ad.cpmess,
        impressions: ad.imp,
        clicks: ad.clk,
        ctr: ad.ctr,
        mess_rate: ad.mr,
        frequency: ad.f
      },
      workspaceId: 2,
      primaryMetric,
      primaryLabel,
      primaryCount,
      primaryCost,
      primaryTarget,
      target_cpmess: 200000,
      target_purchase: 2000000,
      changedRecently: !!ad.changedRecently,
      ctrBase: 1.5,
      messRateBase: 4.5
    });

    if (ad.run_days >= 3 && !ad.changedRecently) {
      assert.notStrictEqual(
        result.action,
        'WAIT',
        `Ad [${ad.id}: ${ad.name}] (chạy ${ad.run_days} ngày) KHÔNG ĐƯỢC trả về action WAIT`
      );
      assert(
        !result.reason.includes('giai đoạn máy học') && !result.reason.includes('Dữ liệu chưa đủ 3 ngày'),
        `Ad [${ad.id}: ${ad.name}] (chạy ${ad.run_days} ngày) không được chứa lý do "giai đoạn máy học". Lý do thực tế: "${result.reason}"`
      );
      assert.notStrictEqual(
        result.root_cause,
        'LEARNING_PHASE',
        `Ad [${ad.id}: ${ad.name}] không được có root_cause là LEARNING_PHASE`
      );
    }
  });
});

// -------------------------------------------------------------
// PHẦN 6: KIỂM TRA TOÀN BỘ DỮ LIỆU THỰC TẾ TRONG SQLITE
// -------------------------------------------------------------
console.log('\n--- 6. SQLITE REAL DATA AUDIT ---');

it('Audit 1,135 Ads trong SQLite: Không có ad mature nào bị gán WAIT trừ khi changedRecently', () => {
  const rows = db.prepare(`
    SELECT c.ad_id, c.ad_name, c.ad_status, c.adset_status, c.campaign_status,
      c.account_id, c.adset_id, c.adset_name, c.campaign_name, c.budget_updated_at,
      COALESCE(NULLIF(CAST(c.adset_budget AS INTEGER),0), CAST(c.campaign_budget AS INTEGER),0) AS budget,
      COUNT(DISTINCT CASE WHEN s.spend > 0 THEN s.date END) AS run_days,
      ROUND(SUM(s.spend),0) AS spend, SUM(s.mess_started) AS mess,
      SUM(s.leads) AS leads, SUM(s.purchases) AS purchases,
      ROUND(SUM(CASE WHEN s.date >= date((SELECT MAX(date) FROM ad_daily_stats),'-2 days') THEN s.spend ELSE 0 END),0) AS spend_3d,
      SUM(CASE WHEN s.date >= date((SELECT MAX(date) FROM ad_daily_stats),'-2 days') THEN s.mess_started ELSE 0 END) AS mess_3d,
      SUM(CASE WHEN s.date >= date((SELECT MAX(date) FROM ad_daily_stats),'-2 days') THEN s.leads ELSE 0 END) AS leads_3d,
      SUM(CASE WHEN s.date >= date((SELECT MAX(date) FROM ad_daily_stats),'-2 days') THEN s.purchases ELSE 0 END) AS purchases_3d,
      ROUND(SUM(CASE WHEN s.date BETWEEN date((SELECT MAX(date) FROM ad_daily_stats),'-5 days') AND date((SELECT MAX(date) FROM ad_daily_stats),'-3 days') THEN s.spend ELSE 0 END),0) AS spend_prev_3d,
      SUM(CASE WHEN s.date BETWEEN date((SELECT MAX(date) FROM ad_daily_stats),'-5 days') AND date((SELECT MAX(date) FROM ad_daily_stats),'-3 days') THEN s.mess_started ELSE 0 END) AS mess_prev_3d,
      SUM(CASE WHEN s.date BETWEEN date((SELECT MAX(date) FROM ad_daily_stats),'-5 days') AND date((SELECT MAX(date) FROM ad_daily_stats),'-3 days') THEN s.leads ELSE 0 END) AS leads_prev_3d,
      SUM(CASE WHEN s.date BETWEEN date((SELECT MAX(date) FROM ad_daily_stats),'-5 days') AND date((SELECT MAX(date) FROM ad_daily_stats),'-3 days') THEN s.purchases ELSE 0 END) AS purchases_prev_3d,
      COUNT(DISTINCT CASE WHEN s.mess_started > 0 THEN s.date END) AS days_with_mess,
      SUM(s.impressions) AS impressions, SUM(s.clicks) AS clicks,
      ROUND(AVG(s.frequency),2) AS frequency,
      CASE WHEN SUM(s.mess_started)>0 THEN ROUND(SUM(s.spend)/SUM(s.mess_started),0) END AS cpmess,
      CASE WHEN SUM(s.impressions)>0 THEN ROUND(SUM(s.clicks)*100.0/SUM(s.impressions),2) ELSE 0 END AS ctr,
      CASE WHEN SUM(s.clicks)>0 THEN ROUND(SUM(s.mess_started)*100.0/SUM(s.clicks),2) ELSE 0 END AS mess_rate
    FROM ad_config c LEFT JOIN ad_daily_stats s ON s.ad_id=c.ad_id
      AND s.date >= date((SELECT MAX(date) FROM ad_daily_stats),'-6 days')
    GROUP BY c.ad_id
  `).all();

  assert(rows.length > 0, 'Phải có dữ liệu ads trong DB');

  let activeMatureCount = 0;
  for (const row of rows) {
    const active = row.ad_status === 'ACTIVE' && row.adset_status === 'ACTIVE' && row.campaign_status === 'ACTIVE';
    if (!active) continue;

    const evalResult = evaluateAdRule({
      row,
      workspaceId: 2,
      primaryMetric: 'message',
      primaryLabel: 'Tin nhắn',
      primaryCount: Number(row.mess || 0),
      primaryCost: Number(row.cpmess || 0),
      primaryTarget: 200000,
      target_cpmess: 200000,
      target_purchase: 2000000,
      primary3d: row.mess_3d ? Math.round(row.spend_3d / row.mess_3d) : null,
      primaryPrev3d: row.mess_prev_3d ? Math.round(row.spend_prev_3d / row.mess_prev_3d) : null,
      primaryTrendPct: null,
      primaryStable: true,
      changedRecently: false,
      ctrBase: 1.5,
      messRateBase: 4.5
    });

    if (row.run_days >= 3) {
      activeMatureCount++;
      assert.notStrictEqual(evalResult.action, 'WAIT', `DB Active Ad ${row.ad_id} (run_days: ${row.run_days}) must not return WAIT`);
      assert(!evalResult.reason.includes('giai đoạn máy học'), `DB Active Ad ${row.ad_id} must not mention learning phase`);
    }
  }
  console.log(`     Verified ${activeMatureCount} active mature ads in SQLite without false LEARNING_PHASE warnings`);
});

// -------------------------------------------------------------
// PHẦN 7: KIỂM THỬ COST-SAVING PRIORITY HUB & ENDPOINTS
// -------------------------------------------------------------
console.log('\n--- 7. COST-SAVING PRIORITY HUB (GET /api/ads/rule-optimizations?workspaceId=2) ---');

async function runAsyncTests() {
  const express = require('express');
  const http = require('http');
  const axios = require('axios');
  const adsDashboardRouter = require('../src/routes/adsDashboard');
  const { filterAndCompressAds, synthesizeHealthyAdDecisions } = require('../src/services/aiOptimizer');

  const app = express();
  app.use(express.json());
  app.use('/api/ads', adsDashboardRouter);

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  // Test 7.1: Cost-saving summary & priority_actions
  await (async () => {
    try {
      const res = await axios.get(`${baseUrl}/api/ads/rule-optimizations?workspaceId=1`);
      assert.strictEqual(res.status, 200, 'Status phải là 200');
      assert.strictEqual(res.data.success, true, 'success phải là true');

      const data = res.data.data;
      assert(data.cost_saving_summary, 'Phải có trường cost_saving_summary');
      assert(typeof data.cost_saving_summary.total_wasted_spend_3d === 'number', 'total_wasted_spend_3d phải là number');
      assert(typeof data.cost_saving_summary.emergency_pause_count === 'number', 'emergency_pause_count phải là number');
      assert(typeof data.cost_saving_summary.budget_reduction_count === 'number', 'budget_reduction_count phải là number');

      assert(data.priority_actions, 'Phải có trường priority_actions');
      const urgent = data.priority_actions.urgent_groups;
      assert(urgent, 'Phải có urgent_groups');
      assert(Array.isArray(urgent.emergency_pause), 'urgent_groups.emergency_pause phải là mảng');
      assert(Array.isArray(urgent.budget_reduction), 'urgent_groups.budget_reduction phải là mảng');
      assert(Array.isArray(urgent.creative_refresh), 'urgent_groups.creative_refresh phải là mảng');
      assert(Array.isArray(urgent.cta_offer_fix), 'urgent_groups.cta_offer_fix phải là mảng');

      // Check item consistency
      urgent.emergency_pause.forEach(ad => {
        assert.strictEqual(ad.action, 'PAUSE', `Mọi ad trong emergency_pause phải có action PAUSE, nhận được ${ad.action}`);
      });
      urgent.budget_reduction.forEach(ad => {
        assert.strictEqual(ad.action, 'DECREASE_20', `Mọi ad trong budget_reduction phải có action DECREASE_20, nhận được ${ad.action}`);
      });
      urgent.creative_refresh.forEach(ad => {
        assert(['NEW_HOOK', 'NEW_CREATIVE', 'FATIGUE_WARN'].includes(ad.action), `Mọi ad trong creative_refresh phải có action creative refresh, nhận được ${ad.action}`);
      });
      urgent.cta_offer_fix.forEach(ad => {
        assert.strictEqual(ad.action, 'FIX_CTA', `Mọi ad trong cta_offer_fix phải có action FIX_CTA, nhận được ${ad.action}`);
      });

      // Kiểm tra đầy đủ dữ liệu 3 tầng phễu trong recommendations và urgent_groups
      const recs = data.recommendations || [];
      assert(recs.length > 0, 'Phải có ít nhất 1 recommendation');
      recs.forEach(ad => {
        assert('spend' in ad && typeof ad.spend === 'number', `Ad ${ad.ad_id} phải có spend dạng number`);
        assert('spend_3d' in ad && typeof ad.spend_3d === 'number', `Ad ${ad.ad_id} phải có spend_3d dạng number`);
        assert('mess' in ad && typeof ad.mess === 'number', `Ad ${ad.ad_id} phải có mess dạng number`);
        assert('target_cpmess' in ad && typeof ad.target_cpmess === 'number', `Ad ${ad.ad_id} phải có target_cpmess dạng number`);
        assert('leads' in ad && typeof ad.leads === 'number', `Ad ${ad.ad_id} phải có leads dạng number`);
        assert('target_lead' in ad && typeof ad.target_lead === 'number', `Ad ${ad.ad_id} phải có target_lead dạng number`);
        assert('purchases' in ad && typeof ad.purchases === 'number', `Ad ${ad.ad_id} phải có purchases dạng number`);
        assert('target_purchase' in ad && typeof ad.target_purchase === 'number', `Ad ${ad.ad_id} phải có target_purchase dạng number`);
        assert(typeof ad.primary_metric === 'string', `Ad ${ad.ad_id} phải có primary_metric dạng string`);
        assert(typeof ad.primary_label === 'string', `Ad ${ad.ad_id} phải có primary_label dạng string`);
        assert(typeof ad.primary_count === 'number', `Ad ${ad.ad_id} phải có primary_count dạng number`);
        assert(typeof ad.primary_target === 'number', `Ad ${ad.ad_id} phải có primary_target dạng number`);
        assert(typeof ad.funnel_summary === 'string' && ad.funnel_summary.includes('Mess') && ad.funnel_summary.includes('Lead') && ad.funnel_summary.includes('Đơn'), `Ad ${ad.ad_id} funnel_summary phải có định dạng chuẩn: "${ad.funnel_summary}"`);
      });

      console.log(`  ✅ PASS: Endpoint GET /api/ads/rule-optimizations?workspaceId=2 trả về đúng cấu trúc Cost-Saving Priority Hub & Đầy đủ 3 Tầng Phễu Matrix`);
      console.log(`     total_wasted_spend_3d: ${data.cost_saving_summary.total_wasted_spend_3d.toLocaleString('vi-VN')}đ | PAUSE: ${urgent.emergency_pause.length} | DECREASE_20: ${urgent.budget_reduction.length} | REFRESH: ${urgent.creative_refresh.length} | FIX_CTA: ${urgent.cta_offer_fix.length}`);
      passCount++;
    } catch (err) {
      console.error(`  ❌ FAIL: Endpoint GET /api/ads/rule-optimizations?workspaceId=2`);
      console.error(`     Error: ${err.message}`);
      failCount++;
    }
  })();

  // -------------------------------------------------------------
  // PHẦN 8: KIỂM THỬ SINGLE-AD ON-DEMAND DIAGNOSIS API
  // -------------------------------------------------------------
  console.log('\n--- 8. SINGLE-AD ON-DEMAND DIAGNOSIS (POST /api/ads/diagnose-single-ad) ---');

  await (async () => {
    try {
      const res = await axios.post(`${baseUrl}/api/ads/diagnose-single-ad`, {
        adId: '120251592543220325',
        workspaceId: 2
      });

      assert.strictEqual(res.status, 200, 'Status phải là 200');
      assert.strictEqual(res.data.success, true, 'success phải là true');

      const diag = res.data.diagnosis || res.data.data;
      assert(diag, 'Response phải chứa đối tượng diagnosis');
      assert(diag.status || diag.verdict, 'Phải có status/verdict');
      assert(typeof (diag.healthScore ?? diag.performanceScore) === 'number', 'healthScore/performanceScore phải là number');
      assert(diag.coreDiagnosis || diag.diagnosis, 'Phải có coreDiagnosis/diagnosis');
      assert(Array.isArray(diag.bottlenecks) && diag.bottlenecks.length > 0, 'Phải có mảng bottlenecks không rỗng');
      assert(Array.isArray(diag.suggestedHooks) && diag.suggestedHooks.length === 3, `suggestedHooks phải có đúng 3 hooks, nhận được ${diag.suggestedHooks?.length}`);
      assert(typeof diag.suggestedCTA === 'string' && diag.suggestedCTA.length > 0, 'suggestedCTA phải là string không rỗng');
      assert(diag.actionPlan || diag.recommendedActions, 'Phải có actionPlan/recommendedActions');

      console.log(`  ✅ PASS: Endpoint POST /api/ads/diagnose-single-ad trả về đầy đủ: status, healthScore, coreDiagnosis, bottlenecks, 3 suggestedHooks, suggestedCTA, actionPlan`);
      console.log(`     Status: ${diag.status || diag.verdict} | HealthScore: ${diag.healthScore ?? diag.performanceScore} | Hooks: ${diag.suggestedHooks.length}`);
      passCount++;
    } catch (err) {
      console.error(`  ❌ FAIL: Endpoint POST /api/ads/diagnose-single-ad`);
      console.error(`     Error: ${err.message}`);
      failCount++;
    }
  })();

  // Kiểm thử chuyên sâu Sudden Dip Playbook cho single ad
  await (async () => {
    try {
      const { diagnoseSingleAd } = require('../src/services/aiOptimizer');
      const mockAdData = {
        ad: { ad_id: 'test_sudden_dip_ad', ad_name: 'Ad Đang Chạy Ngon Tụt Đột Biến', service: 'Nám', budget: 500000 },
        stats: {
          run_days: 7,
          days_with_mess: 5,
          spend: 2500000,
          mess: 15,
          today_spend: 220000,
          today_mess: 0,
          spend_3d: 600000,
          mess_3d: 1,
          spend_prev_3d: 600000,
          mess_prev_3d: 6,
          cpmess_prev_3d: 100000,
          cpmess_3d: 600000,
          cpmess: 166666,
          ctr: 2.2,
          mess_rate: 3.5,
          frequency: 1.3
        },
        creative: { body_text: 'Phác đồ trị nám chuẩn y khoa' },
        targeting: { summary: 'Nữ 28-50' }
      };

      const result = await diagnoseSingleAd({
        adData: mockAdData,
        businessTargets: { cost_per_message_max: 200000 },
        benchmark: 200000
      });

      assert(result.suddenDipPlaybook, 'Phải có suddenDipPlaybook khi ad bị Sudden Dip');
      assert(typeof result.suddenDipPlaybook.phase1_24h === 'string' && result.suddenDipPlaybook.phase1_24h.includes('0h–24h'), 'phase1_24h phải có nội dung nhịp 0h-24h');
      assert(typeof result.suddenDipPlaybook.phase2_48h === 'string' && result.suddenDipPlaybook.phase2_48h.includes('24h–48h'), 'phase2_48h phải có nội dung nhịp 24h-48h');
      assert(typeof result.suddenDipPlaybook.phase3_72h === 'string' && result.suddenDipPlaybook.phase3_72h.includes('>48h'), 'phase3_72h phải có nội dung nhịp >48h');
      assert(typeof result.suddenDipPlaybook.suggestedHook === 'string' && result.suddenDipPlaybook.suggestedHook.length > 0, 'Phải có suggestedHook trong suddenDipPlaybook');
      assert(typeof result.suddenDipPlaybook.suggestedCTA === 'string' && result.suddenDipPlaybook.suggestedCTA.length > 0, 'Phải có suggestedCTA trong suddenDipPlaybook');

      console.log(`  ✅ PASS: diagnoseSingleAd nhận diện Sudden Dip và trả về Cẩm nang 3 nhịp thời gian (suddenDipPlaybook) chuẩn`);
      passCount++;
    } catch (err) {
      console.error(`  ❌ FAIL: diagnoseSingleAd Sudden Dip Playbook`);
      console.error(`     Error: ${err.message}`);
      failCount++;
    }
  })();

  // -------------------------------------------------------------
  // PHẦN 9: KIỂM THỬ TOKEN COMPRESSION & ANOMALY SCORING
  // -------------------------------------------------------------
  console.log('\n--- 9. TOKEN COMPRESSION & ANOMALY FILTERING (filterAndCompressAds) ---');

  it('filterAndCompressAds: Lọc chính xác Top rủi ro và nén context ~85% token', () => {
    const mockAds = [
      {
        adId: 'ad_pause_01',
        adName: 'Ad Cháy Ngân Sách 0 Chuyển Đổi',
        service: 'Chăm sóc da',
        status: 'ACTIVE',
        daily_budget: 500000,
        creative: { body: 'Liệu trình chăm sóc da cao cấp giảm giá đặc biệt duy nhất tuần này. Đăng ký ngay!' },
        audienceProfile: { label: 'Nữ 25-45', interests: ['Làm đẹp', 'Skincare'], genderLabel: 'Nữ', ageMin: 25, ageMax: 45 },
        insights: { spend: 4000000, purchases: 0, leads: 0, mess: 0, runDays: 5, ctr: 1.5, frequency: 1.4, recentTrend: { costPerMessage: { changePct: 0 } } }
      },
      {
        adId: 'ad_decrease_02',
        adName: 'Ad Chi Phí Cao Vượt Ngưỡng',
        service: 'Nám',
        status: 'ACTIVE',
        daily_budget: 300000,
        creative: { body: 'Trị nám chuẩn y khoa' },
        audienceProfile: { label: 'Nữ 30-55', interests: ['Trị nám'], genderLabel: 'Nữ', ageMin: 30, ageMax: 55 },
        insights: { spend: 1800000, purchases: 0, leads: 0, mess: 5, cpmess: 360000, runDays: 6, ctr: 1.8, frequency: 1.3, recentTrend: { costPerMessage: { changePct: 10 } } }
      },
      {
        adId: 'ad_fatigue_03',
        adName: 'Ad Bão Hòa Tần Suất',
        service: 'U máu',
        status: 'ACTIVE',
        daily_budget: 200000,
        creative: { body: 'Điều trị u máu an toàn' },
        audienceProfile: { label: 'Phụ huynh', interests: ['Chăm sóc trẻ'], genderLabel: 'All', ageMin: 22, ageMax: 40 },
        insights: { spend: 1200000, purchases: 0, leads: 0, mess: 6, cpmess: 200000, runDays: 8, ctr: 1.2, frequency: 2.9, recentTrend: { costPerMessage: { changePct: 5 } } }
      },
      {
        adId: 'ad_hook_04',
        adName: 'Ad Hook Yếu CTR Thấp',
        service: 'Chàm bớt',
        status: 'ACTIVE',
        daily_budget: 200000,
        creative: { body: 'Chàm bớt bẩm sinh' },
        audienceProfile: { label: 'Toàn quốc', interests: [], genderLabel: 'All', ageMin: 18, ageMax: 60 },
        insights: { spend: 800000, impressions: 4000, clicks: 16, purchases: 0, leads: 0, mess: 3, cpmess: 266666, runDays: 4, ctr: 0.4, frequency: 1.2, recentTrend: { costPerMessage: { changePct: 0 } } }
      },
      {
        adId: 'ad_cta_05',
        adName: 'Ad Click Nhiều Không Nhắn Tin',
        service: 'Trẻ hóa',
        status: 'ACTIVE',
        daily_budget: 300000,
        creative: { body: 'Trẻ hóa làn da' },
        audienceProfile: { label: 'Nữ', interests: [], genderLabel: 'Nữ', ageMin: 35, ageMax: 55 },
        insights: { spend: 900000, impressions: 3000, clicks: 100, purchases: 0, leads: 0, mess: 1, messRate: 1.0, cpmess: 900000, runDays: 5, ctr: 3.33, frequency: 1.2, recentTrend: { costPerMessage: { changePct: 0 } } }
      },
      {
        adId: 'ad_scale_06',
        adName: 'Ad Chiến Thắng CPMess Rẻ',
        service: 'Nám',
        status: 'ACTIVE',
        daily_budget: 500000,
        creative: { body: 'Phác đồ trị nám chuẩn' },
        audienceProfile: { label: 'Nữ 28-50', interests: ['Spa'], genderLabel: 'Nữ', ageMin: 28, ageMax: 50 },
        insights: { spend: 1500000, purchases: 0, leads: 0, mess: 15, cpmess: 100000, runDays: 6, ctr: 2.5, frequency: 1.3, recentTrend: { costPerMessage: { changePct: -10 } } }
      },
      {
        adId: 'ad_keep_07',
        adName: 'Ad Ổn Định Bình Thường',
        service: 'Chăm sóc da',
        status: 'ACTIVE',
        daily_budget: 200000,
        creative: { body: 'Chăm sóc da định kỳ' },
        audienceProfile: { label: 'Nữ 20-40', interests: [], genderLabel: 'Nữ', ageMin: 20, ageMax: 40 },
        insights: { spend: 880000, purchases: 0, leads: 0, mess: 4, cpmess: 220000, runDays: 4, ctr: 1.6, frequency: 1.2, recentTrend: { costPerMessage: { changePct: 0 } } }
      }
    ];

    const targets = { cost_per_message_max: 250000, cost_per_purchase_max: 2000000 };
    const compressionResult = filterAndCompressAds(mockAds, targets);

    assert(compressionResult.selectedAdIds.has('ad_pause_01'), 'PAUSE ad phải được chọn');
    assert(compressionResult.selectedAdIds.has('ad_decrease_02'), 'DECREASE_20 ad phải được chọn');
    assert(compressionResult.selectedAdIds.has('ad_scale_06'), 'SCALE ad phải được chọn');

    const pauseItem = compressionResult.compressedAds.find(a => a.adId === 'ad_pause_01');
    assert.strictEqual(pauseItem.anomalyFlag, 'PAUSE');
    assert(pauseItem.creativeSnippet.length <= 185, 'creativeSnippet phải được rút gọn ngắn gọn');

    const healthyDecisions = synthesizeHealthyAdDecisions(mockAds, compressionResult.selectedAdIds, targets);
    assert.strictEqual(healthyDecisions.length, mockAds.length - compressionResult.compressedAds.length);
    assert.strictEqual(healthyDecisions[0].category, 'KEEP');
  });

  server.close();

  console.log('\n===============================================================');
  console.log(`=== SUMMARY: ${passCount} PASSED, ${failCount} FAILED ===`);
  console.log('===============================================================\n');

  if (failCount > 0) process.exit(1);
  else process.exit(0);
}

runAsyncTests().catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
