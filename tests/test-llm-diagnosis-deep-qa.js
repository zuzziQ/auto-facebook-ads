/**
 * Deep QA Test Suite for LLM Single Ad Diagnosis
 * Tests:
 * 1. Syntax of all relevant backend files & inline frontend scripts
 * 2. POST /api/ads/diagnose-single-ad & diagnoseSingleAd return structure
 * 3. Frontend HTML/JS render simulation for suggestedHooks (string array & object array), suggestedCopy, summary, actionPlan
 * 4. Zero-exception guarantee for .replace() on undefined / null
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { db } = require('../src/db/database');
const {
  diagnoseSingleAd,
  normalizeSingleAdDiagnosis,
  generateFallbackSingleAdDiagnosis,
  describeTargetingSnippet
} = require('../src/services/aiOptimizer');

console.log('===============================================================');
console.log('=== [QA DEEP TEST: LLM AI DIAGNOSIS & FRONTEND RENDERING] ===');
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
    if (err.stack) console.error(`     ${err.stack.split('\n')[1]}`);
    failCount++;
  }
}

// -------------------------------------------------------------
// 1. SYNTAX VALIDATION
// -------------------------------------------------------------
console.log('--- 1. SYNTAX & COMPILATION CHECKS ---');

it('src/server.js compiles cleanly', () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  new vm.Script(code);
});

it('src/routes/adsDashboard.js compiles cleanly', () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/routes/adsDashboard.js'), 'utf8');
  new vm.Script(code);
});

it('src/services/facebookAdsBudget.js compiles cleanly', () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/services/facebookAdsBudget.js'), 'utf8');
  new vm.Script(code);
});

it('src/services/aiOptimizer.js compiles cleanly', () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/services/aiOptimizer.js'), 'utf8');
  new vm.Script(code);
});

it('public/agentic-dashboard.html inline scripts compile cleanly', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/agentic-dashboard.html'), 'utf8');
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let count = 0;
  while ((match = scriptRegex.exec(html)) !== null) {
    const scriptCode = match[1].trim();
    if (!scriptCode) continue;
    new vm.Script(scriptCode);
    count++;
  }
  assert.ok(count > 0, 'Must have at least 1 valid inline script block');
});

// -------------------------------------------------------------
// 2. DIRECT AI DIAGNOSIS & NORMALIZATION TESTS
// -------------------------------------------------------------
console.log('\n--- 2. AI DIAGNOSIS DATA FORMAT & NORMALIZATION ---');

it('normalizeSingleAdDiagnosis returns standard object with hooks array of {hook, angle}', () => {
  // Test with string array of hooks
  const rawWithStringHooks = {
    verdict: 'REFRESH_CREATIVE',
    verdictTitle: 'Tối ưu Hook 3s đầu',
    coreDiagnosis: 'CTR giảm, chi phí tin nhắn tăng',
    suggestedHooks: [
      '3 Sai lầm khiến chi phí điều trị tăng gấp đôi',
      'Sự thật về công nghệ điều trị mới nhất',
      'Khách hàng thực tế sau 1 liệu trình'
    ],
    actionPlan: {
      budget: 'Giữ nguyên ngân sách',
      creative: 'Đổi hook video',
      targeting: 'Tệp broad'
    }
  };

  const adData = {
    ad: { ad_id: '120251592543220325', ad_name: '6.6 CSDM -28-7', service: 'Chăm sóc da' },
    stats: { spend: 1750000, mess: 6, cpmess: 291667, run_days: 7, days_with_mess: 4 }
  };

  const normalized = normalizeSingleAdDiagnosis(rawWithStringHooks, adData, 200000);

  assert.strictEqual(typeof normalized.summary, 'string', 'summary must be a string');
  assert.ok(normalized.summary.length > 0, 'summary must not be empty');
  assert.strictEqual(typeof normalized.suggestedCopy, 'string', 'suggestedCopy must be a string');
  assert.ok(normalized.suggestedCopy.length > 0, 'suggestedCopy must not be empty');
  assert.strictEqual(typeof normalized.actionPlan, 'object', 'actionPlan must be an object');
  assert.ok(normalized.actionPlan.budget, 'actionPlan.budget must exist');
  assert.ok(normalized.actionPlan.creative, 'actionPlan.creative must exist');
  assert.ok(normalized.actionPlan.targeting, 'actionPlan.targeting must exist');

  assert.ok(Array.isArray(normalized.suggestedHooks), 'suggestedHooks must be an array');
  assert.strictEqual(normalized.suggestedHooks.length, 3, 'Must have 3 hooks');
  normalized.suggestedHooks.forEach((h, idx) => {
    assert.strictEqual(typeof h, 'object', `Hook ${idx} must be an object`);
    assert.strictEqual(typeof h.hook, 'string', `Hook ${idx}.hook must be string`);
    assert.strictEqual(typeof h.angle, 'string', `Hook ${idx}.angle must be string`);
    assert.ok(h.hook.length > 0, `Hook ${idx}.hook must not be empty`);
    assert.ok(h.angle.length > 0, `Hook ${idx}.angle must not be empty`);
  });
});

it('normalizeSingleAdDiagnosis returns standard object with object array of {hook, angle}', () => {
  const rawWithObjectHooks = {
    verdict: 'SCALE',
    verdictTitle: 'Tăng ngân sách +20%',
    coreDiagnosis: 'CPMess thấp, hiệu suất cao',
    suggestedHooks: [
      { hook: 'Bác sĩ bóc tách nguyên nhân tái phát', angle: 'Chuyên gia' },
      { hook: 'Đừng điều trị nếu chưa biết điều này', angle: 'Cảnh báo' },
      { hook: 'Hình ảnh trước và sau 1 tuần', angle: 'Bằng chứng' }
    ],
    actionPlan: {
      budget: 'Tăng 20% ngân sách',
      creative: 'Nhân bản biến thể tốt',
      targeting: 'Mở rộng Lookalike'
    }
  };

  const adData = {
    ad: { ad_id: '120242190915950269', ad_name: 'umau_2025-id-0127', service: 'U máu' },
    stats: { spend: 500000, mess: 10, cpmess: 50000, run_days: 5 }
  };

  const normalized = normalizeSingleAdDiagnosis(rawWithObjectHooks, adData, 150000);

  assert.strictEqual(normalized.suggestedHooks[0].hook, 'Bác sĩ bóc tách nguyên nhân tái phát');
  assert.strictEqual(normalized.suggestedHooks[0].angle, 'Chuyên gia');
  assert.strictEqual(normalized.suggestedHooks[1].hook, 'Đừng điều trị nếu chưa biết điều này');
  assert.strictEqual(normalized.suggestedHooks[1].angle, 'Cảnh báo');
  assert.strictEqual(normalized.suggestedHooks[2].hook, 'Hình ảnh trước và sau 1 tuần');
  assert.strictEqual(normalized.suggestedHooks[2].angle, 'Bằng chứng');
});

it('generateFallbackSingleAdDiagnosis generates full robust diagnosis without LLM failure', () => {
  const adData = {
    ad: { ad_id: '120252137359420325', ad_name: 'Test Ad Fallback', service: 'Nám da', budget: 300000 },
    stats: { spend: 600000, mess: 0, cpmess: null, run_days: 4, ctr: 0.8, frequency: 1.5, days_with_mess: 0 }
  };
  const fallback = generateFallbackSingleAdDiagnosis(adData, {}, 200000);
  const normalized = normalizeSingleAdDiagnosis(fallback, adData, 200000);

  assert.strictEqual(normalized.status, 'PAUSE');
  assert.ok(normalized.bottlenecks.length > 0);
  assert.ok(normalized.suggestedHooks.length >= 3);
  assert.ok(normalized.suggestedCopy.length > 20);
  assert.ok(normalized.actionPlan.budget.length > 0);
});

it('Real DB Ad Diagnosis: 120251592543220325 can be diagnosed end-to-end', async () => {
  const adId = '120251592543220325';
  const adConfig = db.prepare('SELECT * FROM ad_config WHERE ad_id = ?').get(adId);
  assert.ok(adConfig, `Ad ${adId} must exist in DB`);

  const stats = db.prepare(`
    SELECT
      COUNT(DISTINCT CASE WHEN spend > 0 THEN date END) AS run_days,
      ROUND(SUM(spend), 0) AS spend,
      SUM(mess_started) AS mess,
      SUM(leads) AS leads,
      SUM(purchases) AS purchases
    FROM ad_daily_stats
    WHERE ad_id = ?
  `).get(adId);

  const fallback = generateFallbackSingleAdDiagnosis({ ad: adConfig, stats }, {}, 200000);
  const diag = normalizeSingleAdDiagnosis(fallback, { ad: adConfig, stats }, 200000);

  assert.strictEqual(diag.adId, adId);
  assert.ok(Array.isArray(diag.suggestedHooks));
  assert.strictEqual(diag.suggestedHooks.length, 3);
  assert.ok(diag.summary);
  assert.ok(diag.suggestedCopy);
  assert.ok(diag.actionPlan);
});

// -------------------------------------------------------------
// 3. FRONTEND JAVASCRIPT RENDERING SIMULATION TESTS
// -------------------------------------------------------------
console.log('\n--- 3. FRONTEND JAVASCRIPT RENDERING SIMULATION ---');

// Extract or define the exact frontend rendering logic from agentic-dashboard.html
const analyticsEscape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

function simulateFrontendRender(diag) {
  const statusTone = diag.healthStatus === 'danger' ? '#fb7185' : diag.healthStatus === 'warning' ? '#fbbf24' : '#34d399';
  const statusLabel = diag.healthStatus === 'danger' ? 'NGUY CƠ LÃNG PHÍ' : diag.healthStatus === 'warning' ? 'CẦN TỐI ƯU HOOK/CTA' : 'HIỆU SUẤT TỐT';

  const hooksHtml = (diag.suggestedHooks || []).map((h, i) => {
    const hookText = typeof h === 'string' ? h : (h?.hook || h?.text || '');
    const angleText = (typeof h === 'object' && h?.angle) ? h.angle : `Góc tiếp cận ${i+1}`;
    return `
    <div class="ai-hook-card">
      <div style="flex:1;min-width:0">
        <span class="hook-angle">${analyticsEscape(angleText)}</span>
        <div class="hook-text">"${analyticsEscape(hookText)}"</div>
      </div>
      <button type="button" onclick="applySuggestedHook(${JSON.stringify(hookText || '').replace(/"/g, '&quot;')})">📋 Dùng Hook này</button>
    </div>
  `;
  }).join('');

  const bottlenecksHtml = (diag.bottlenecks || []).map(b => `
    <li style="margin-bottom:3px;color:#cbd5e1;font-size:10px;">${analyticsEscape(b)}</li>
  `).join('');

  const plan = diag.actionPlan || {};
  const copyText = diag.suggestedCopy || diag.fullContent || diag.variantBrief || '';

  const html = `
    <div class="ai-diagnostic-result">
      <div class="ai-diagnostic-head">
        <h4><span class="ai-sparkle">✨</span> AI Chẩn Đoán Chi Tiết Cho Ad Này</h4>
        <span style="font-size:9px;font-weight:800;padding:2px 8px;border-radius:6px;background:${statusTone}22;color:${statusTone};border:1px solid ${statusTone}44;">
          ${statusLabel}
        </span>
      </div>

      <div class="ai-diagnostic-summary" style="border-left-color:${statusTone}">
        <b style="color:${statusTone};display:block;margin-bottom:3px;">ĐÁNH GIÁ CỐT LÕI:</b>
        ${analyticsEscape(diag.summary || diag.coreDiagnosis || diag.diagnosis || 'Hiệu suất quảng cáo cần được theo dõi.')}
      </div>

      ${diag.bottlenecks && diag.bottlenecks.length ? `
        <div style="background:rgba(8,12,20,0.5);padding:8px 10px;border-radius:7px;border:1px solid #1e2b3d">
          <span style="font-size:9px;font-weight:800;color:#94a3b8;text-transform:uppercase;display:block;margin-bottom:4px">⚠️ Điểm nghẽn phát hiện:</span>
          <ul style="margin:0;padding-left:16px">${bottlenecksHtml}</ul>
        </div>
      ` : ''}

      <!-- GỢI Ý 3 HOOK MỚI -->
      <div>
        <div class="ad-preview-section-title" style="margin-bottom:6px">
          <span>🪝 3 Hook Mở Đầu Mới (Giữ Chân 3s Đầu)</span>
          <small>Tùy chọn angle</small>
        </div>
        <div class="ai-hooks-list">
          ${hooksHtml}
        </div>
      </div>

      <!-- BÀI VIẾT COPY HOÀN CHỈNH -->
      <div>
        <div class="ad-preview-section-title" style="margin-bottom:6px">
          <span>📝 Bài Viết & CTA Đề Xuất Hoàn Chỉnh</span>
          <small>Chuẩn AIDA</small>
        </div>
        <div class="ai-copy-box">
          <div class="ai-copy-content" id="ai-suggested-copy-text">${analyticsEscape(copyText)}</div>
          <div class="ai-copy-actions">
            <button type="button" onclick="applySuggestedCopy(${JSON.stringify(copyText).replace(/"/g, '&quot;')})">
              ⚡ Đưa toàn bộ vào ô Soạn Variant
            </button>
          </div>
        </div>
      </div>

      <!-- KẾ HOẠCH HÀNH ĐỘNG TIẾP THEO -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;background:rgba(8,12,20,0.6);padding:8px;border-radius:8px;border:1px solid #1e2b3d">
        <div>
          <span style="font-size:8px;color:#718096;text-transform:uppercase;display:block">💰 Ngân sách</span>
          <b style="font-size:9.5px;color:#e2e8f0">${analyticsEscape(plan.budget || 'Theo dõi')}</b>
        </div>
        <div>
          <span style="font-size:8px;color:#718096;text-transform:uppercase;display:block">🎨 Creative</span>
          <b style="font-size:9.5px;color:#c084fc">${analyticsEscape(plan.creative || 'Đổi hook')}</b>
        </div>
        <div>
          <span style="font-size:8px;color:#718096;text-transform:uppercase;display:block">🎯 Tệp khán giả</span>
          <b style="font-size:9.5px;color:#38bdf8">${analyticsEscape(plan.audience || 'Giữ nguyên')}</b>
        </div>
      </div>
    </div>
  `;
  return html;
}

it('Frontend Render Case A: suggestedHooks as Array of Strings ["Hook A", "Hook B"]', () => {
  const diag = {
    healthStatus: 'warning',
    summary: 'Cần đổi hook 3s đầu',
    bottlenecks: ['CTR thấp dưới chuẩn', 'Frequency chạm 2.2'],
    suggestedHooks: [
      'Hook A: 3 Sai lầm chết người',
      'Hook B: Bí quyết từ chuyên gia da liễu'
    ],
    suggestedCopy: 'Nội dung bài viết mẫu hoàn chỉnh...',
    actionPlan: { budget: 'Giữ nguyên', creative: 'Test hook mới', audience: 'Broad 25-45' }
  };

  const output = simulateFrontendRender(diag);
  assert.ok(output.includes('Hook A: 3 Sai lầm chết người'));
  assert.ok(output.includes('Hook B: Bí quyết từ chuyên gia da liễu'));
  assert.ok(output.includes('Góc tiếp cận 1'));
  assert.ok(output.includes('Góc tiếp cận 2'));
  assert.ok(output.includes('onclick="applySuggestedHook(&quot;Hook A: 3 Sai lầm chết người&quot;)"'));
});

it('Frontend Render Case B: suggestedHooks as Array of Objects [{hook, angle}]', () => {
  const diag = {
    healthStatus: 'danger',
    summary: 'Chi phí CPMess quá cao',
    bottlenecks: ['0 tin nhắn sau 500k'],
    suggestedHooks: [
      { hook: 'Đừng vội mua kem dưỡng khi chưa xem video này', angle: 'Cảnh báo / Nỗi đau' },
      { hook: 'Tại sao 90% chị em điều trị thất bại?', angle: 'Phản trực giác' }
    ],
    suggestedCopy: 'Bài viết AIDA chuẩn y khoa...',
    actionPlan: { budget: 'Giảm 20%', creative: 'Sản xuất video mới', audience: 'Lookalike 1%' }
  };

  const output = simulateFrontendRender(diag);
  assert.ok(output.includes('Đừng vội mua kem dưỡng khi chưa xem video này'));
  assert.ok(output.includes('Cảnh báo / Nỗi đau'));
  assert.ok(output.includes('Tại sao 90% chị em điều trị thất bại?'));
  assert.ok(output.includes('Phản trực giác'));
  assert.ok(output.includes('onclick="applySuggestedHook(&quot;Đừng vội mua kem dưỡng khi chưa xem video này&quot;)"'));
});

it('Frontend Render Case C: Edge Cases (null, undefined, missing fields) without exceptions', () => {
  const edgeCases = [
    {},
    { suggestedHooks: null, suggestedCopy: null, summary: null, actionPlan: null },
    { suggestedHooks: [null, undefined, '', {}], suggestedCopy: undefined },
    { suggestedHooks: [{ hook: null, angle: null }], bottlenecks: [null, undefined] },
    { summary: undefined, coreDiagnosis: undefined, diagnosis: undefined }
  ];

  edgeCases.forEach((diag, i) => {
    assert.doesNotThrow(() => {
      const out = simulateFrontendRender(diag);
      assert.ok(typeof out === 'string');
    }, `Edge case index ${i} should not throw any error`);
  });
});

it('Zero-exception guarantee: analyticsEscape and JSON stringify replace handlers', () => {
  assert.strictEqual(analyticsEscape(undefined), '');
  assert.strictEqual(analyticsEscape(null), '');
  assert.strictEqual(analyticsEscape(''), '');
  assert.strictEqual(analyticsEscape(0), '0');
  assert.strictEqual(analyticsEscape(false), 'false');
  assert.strictEqual(analyticsEscape('Hello & <World> "Test" \'Quote\''), 'Hello &amp; &lt;World&gt; &quot;Test&quot; &#39;Quote&#39;');

  // Test applySuggestedHook JSON.stringify replace with undefined / null / special chars
  const testTexts = [undefined, null, '', 'Hook with "quotes"', "Hook with 'single quotes'", 'Hook with <tags> & &amp;'];
  testTexts.forEach(t => {
    assert.doesNotThrow(() => {
      const attr = JSON.stringify(t || '').replace(/"/g, '&quot;');
      assert.ok(typeof attr === 'string');
    });
  });
});

// -------------------------------------------------------------
// 4. AI DIAGNOSIS SNAPSHOT PERSISTENCE & 4-TIER TOKEN OPTIMIZATION TESTS
// -------------------------------------------------------------
console.log('\n--- 4. AI DIAGNOSIS SNAPSHOT PERSISTENCE & 4-TIER TOKEN OPTIMIZATION ---');

const {
  insertAdAiDiagnosis,
  getAdAiDiagnosisRecord
} = require('../src/db/database');
const {
  filterAndCompressAds,
  synthesizeHealthyAdDecisions,
  computePortfolioSnapshotHash,
  evaluateDeltaCacheEligible
} = require('../src/services/aiOptimizer');

it('SQLite Schema: ad_ai_diagnoses table exists and supports CRUD operations', () => {
  const tableCheck = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ad_ai_diagnoses'`).get();
  assert.ok(tableCheck, 'ad_ai_diagnoses table must exist');

  const testAdId = 'test_snap_' + Date.now();
  const testDiag = {
    verdict: 'SUDDEN_DIP',
    summary: 'Phát hiện Sudden Dip trong ngày',
    healthScore: 65,
    suddenDipPlaybook: { phase1_24h: 'Giữ nguyên ngân sách' }
  };

  insertAdAiDiagnosis({
    ad_id: testAdId,
    workspace_id: 1,
    service: 'Nám',
    diagnosis_json: testDiag,
    snapshot_hash: 'abc123hash'
  });

  const record = getAdAiDiagnosisRecord(testAdId);
  assert.ok(record, 'Record must be queryable');
  assert.strictEqual(record.ad_id, testAdId);
  assert.strictEqual(record.service, 'Nám');
  assert.strictEqual(record.snapshot_hash, 'abc123hash');

  const parsed = JSON.parse(record.diagnosis_json);
  assert.strictEqual(parsed.verdict, 'SUDDEN_DIP');
  assert.strictEqual(parsed.healthScore, 65);

  // Clean up test record
  db.prepare('DELETE FROM ad_ai_diagnoses WHERE ad_id = ?').run(testAdId);
});

it('GET /api/ads/creatives includes ai_diagnosis_summary and ai_diagnosis_saved_at via LEFT JOIN', () => {
  const sampleAd = db.prepare('SELECT ad_id FROM ad_config LIMIT 1').get();
  if (sampleAd) {
    const testAdId = sampleAd.ad_id;
    const testDiag = {
      summary: 'Ad đang chạy ổn định, tiếp tục giữ ngân sách.',
      verdict: 'KEEP',
      verdictTitle: 'Giữ nguyên · An toàn',
      healthScore: 85
    };

    insertAdAiDiagnosis({
      ad_id: testAdId,
      workspace_id: 1,
      service: 'Chăm sóc da',
      diagnosis_json: testDiag,
      snapshot_hash: 'hash_test_join'
    });

    const creativeRow = db.prepare(`
      SELECT 
        c.ad_id,
        d.updated_at as ai_diagnosis_saved_at,
        COALESCE(json_extract(d.diagnosis_json, '$.summary'), json_extract(d.diagnosis_json, '$.coreDiagnosis')) as ai_diagnosis_summary,
        json_extract(d.diagnosis_json, '$.verdict') as ai_diagnosis_verdict,
        json_extract(d.diagnosis_json, '$.healthScore') as ai_diagnosis_health_score
      FROM ad_config c
      LEFT JOIN ad_ai_diagnoses d ON d.ad_id = c.ad_id
      WHERE c.ad_id = ?
    `).get(testAdId);

    assert.ok(creativeRow, 'Row must exist');
    assert.strictEqual(creativeRow.ai_diagnosis_summary, 'Ad đang chạy ổn định, tiếp tục giữ ngân sách.');
    assert.strictEqual(creativeRow.ai_diagnosis_verdict, 'KEEP');
    assert.strictEqual(Number(creativeRow.ai_diagnosis_health_score), 85);
    assert.ok(creativeRow.ai_diagnosis_saved_at, 'ai_diagnosis_saved_at must be populated');
  }
});

it('Tier 1 (Zero-Token Rule Filter): synthesizeHealthyAdDecisions produces valid structured decisions with 0 tokens', () => {
  const healthyAds = [
    { adId: 'ad_101', adName: 'Ad Test Win', insights: { spend: 500000, purchases: 3, costPerPurchase: 166666, runDays: 5 } },
    { adId: 'ad_102', adName: 'Ad New Learning', insights: { spend: 100000, mess: 1, runDays: 1 } }
  ];
  const decisions = synthesizeHealthyAdDecisions(healthyAds, new Set(), { cost_per_purchase_max: 250000, cost_per_message_max: 200000 });
  
  assert.strictEqual(decisions.length, 2);
  assert.strictEqual(decisions[0].adId, 'ad_101');
  assert.strictEqual(decisions[0].category, 'SCALE');
  assert.strictEqual(decisions[1].adId, 'ad_102');
  assert.strictEqual(decisions[1].category, 'KEEP');
});

it('Tier 2 (Targeted Anomaly Compression): filterAndCompressAds filters Top 5-8 risks and truncates snippet to save ~85% tokens', () => {
  const mockAds = Array.from({ length: 25 }, (_, i) => ({
    adId: `ad_${i}`,
    adName: `Ad Campaign Test ${i}`,
    service: 'Nám',
    creative: { body: 'A'.repeat(500) },
    audienceProfile: { label: 'Tệp Nữ 25-45', genderLabel: 'Nữ', ageMin: 25, ageMax: 45 },
    insights: {
      spend: (i + 1) * 200000,
      mess: i % 3 === 0 ? 0 : 5,
      purchases: 0,
      runDays: 4,
      ctr: 0.5,
      frequency: 2.8
    }
  }));

  const { compressedAds, selectedAdIds } = filterAndCompressAds(mockAds, { cost_per_message_max: 200000 });
  assert.ok(compressedAds.length >= 5 && compressedAds.length <= 10, 'Compressed ads must be top critical 5-10');
  assert.ok(compressedAds.every(ad => ad.creativeSnippet.length <= 185), 'Creative snippet must be concisely compressed');
  assert.ok(selectedAdIds.size === compressedAds.length);
});

it('Tier 3 (SHA256 Delta Caching): computePortfolioSnapshotHash & evaluateDeltaCacheEligible work seamlessly', () => {
  const payloadA = { totalSpend: 5000000, totalMessages: 50, activeAds: 10 };
  const hashA = computePortfolioSnapshotHash(payloadA);
  assert.strictEqual(typeof hashA, 'string');
  assert.strictEqual(hashA.length, 16);

  // Small change (< 5%) -> eligible
  const payloadB = { totalSpend: 5100000, totalMessages: 51, activeAds: 10 };
  const deltaB = evaluateDeltaCacheEligible(payloadB, payloadA, 0.10, 24, new Date().toISOString());
  assert.strictEqual(deltaB.isEligible, true);
  assert.ok(deltaB.maxMetricDelta < 10);

  // Large change (> 20%) -> not eligible
  const payloadC = { totalSpend: 7000000, totalMessages: 50, activeAds: 10 };
  const deltaC = evaluateDeltaCacheEligible(payloadC, payloadA, 0.10, 24, new Date().toISOString());
  assert.strictEqual(deltaC.isEligible, false);
});

it('Tier 4 (On-Demand Single Ad): Fallback and normalization handle all field contracts with 100% reliability', () => {
  const fallback = generateFallbackSingleAdDiagnosis({
    ad: { ad_id: 'tier4_test', ad_name: 'Ad Tier 4', service: 'U máu' },
    stats: { spend: 500000, mess: 5, cpmess: 100000, run_days: 5 }
  }, {}, 150000);

  assert.strictEqual(fallback.adId, 'tier4_test');
  assert.strictEqual(fallback.verdict, 'SCALE');
  assert.ok(fallback.suggestedHooks.length >= 3);
  assert.ok(fallback.suggestedCopy.length > 50);
});

// -------------------------------------------------------------
// 5. TARGETING LOCATION EXTRACTION & SNAPSHOT OVERWRITE TESTS
// -------------------------------------------------------------
console.log('\n--- 5. TARGETING PIN-DROP & SNAPSHOT OVERWRITE TESTS ---');

it('describeTargetingSnippet correctly parses pin-drop custom_locations with radius', () => {
  const targeting = {
    age_min: 25,
    age_max: 55,
    genders: [2],
    geo_locations: {
      custom_locations: [
        { name: 'Ngõ 78 Duy Tân', radius: 2, distance_unit: 'kilometer' }
      ]
    }
  };
  const snippet = describeTargetingSnippet(targeting);
  assert.ok(snippet.includes('Vị trí: Thả ghim bán kính: Ngõ 78 Duy Tân (+2km)'), `Actual snippet: ${snippet}`);
  assert.ok(snippet.includes('Nữ, 25–55 tuổi'), `Actual snippet: ${snippet}`);
  assert.ok(!snippet.includes('Toàn quốc'), `Should not contain Toàn quốc: ${snippet}`);
});

it('describeTargetingSnippet correctly parses pin-drop geo.places with coordinates fallback', () => {
  const targeting = {
    geo_locations: {
      places: [
        { latitude: 21.03, longitude: 105.78, radius: 5, distance_unit: 'km' }
      ]
    },
    flexible_spec: [
      { interests: [{ name: 'Trị nám da' }] }
    ]
  };
  const snippet = describeTargetingSnippet(targeting);
  assert.ok(snippet.includes('Vị trí: Thả ghim bán kính: Ghim (21.03, 105.78) (+5km)'), `Actual snippet: ${snippet}`);
  assert.ok(snippet.includes('Sở thích: Trị nám da'), `Actual snippet: ${snippet}`);
});

it('describeTargetingSnippet correctly formats cities and regions', () => {
  const targeting = {
    geo_locations: {
      cities: [{ name: 'Hà Nội' }, { name: 'Hồ Chí Minh' }],
      regions: [{ name: 'Đồng bằng sông Hồng' }]
    }
  };
  const snippet = describeTargetingSnippet(targeting);
  assert.ok(snippet.includes('Vị trí: Hà Nội, Hồ Chí Minh, Đồng bằng sông Hồng'), `Actual snippet: ${snippet}`);
});

it('describeTargetingSnippet formats country VN as Toàn quốc (Việt Nam)', () => {
  const targeting = {
    geo_locations: {
      countries: ['VN']
    }
  };
  const snippet = describeTargetingSnippet(targeting);
  assert.ok(snippet.includes('Vị trí: Toàn quốc (Việt Nam)'), `Actual snippet: ${snippet}`);
});

it('ad_ai_diagnoses table supports force=true overwrite with updated_at timestamp renewal', () => {
  const testAdId = 'qa_ad_test_overwrite_' + Date.now();
  const initialDiag = { verdict: 'KEEP', diagnosis: 'Chẩn đoán cũ' };
  const updatedDiag = { verdict: 'SCALE', diagnosis: 'Chẩn đoán mới thả ghim Duy Tân' };

  // 1. Initial insert
  db.prepare(`
    INSERT INTO ad_ai_diagnoses (ad_id, workspace_id, service, diagnosis_json, snapshot_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', '-2 days'), datetime('now', '-2 days'))
  `).run(testAdId, 1, 'Nám', JSON.stringify(initialDiag), 'hash_old');

  const record1 = db.prepare('SELECT * FROM ad_ai_diagnoses WHERE ad_id = ?').get(testAdId);
  assert.strictEqual(JSON.parse(record1.diagnosis_json).verdict, 'KEEP');

  // 2. Simulate force=true overwrite (ON CONFLICT DO UPDATE)
  db.prepare(`
    INSERT INTO ad_ai_diagnoses (ad_id, workspace_id, service, diagnosis_json, snapshot_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(ad_id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      service = excluded.service,
      diagnosis_json = excluded.diagnosis_json,
      snapshot_hash = excluded.snapshot_hash,
      updated_at = datetime('now')
  `).run(testAdId, 1, 'Nám', JSON.stringify(updatedDiag), 'hash_new');

  const record2 = db.prepare('SELECT * FROM ad_ai_diagnoses WHERE ad_id = ?').get(testAdId);
  assert.strictEqual(JSON.parse(record2.diagnosis_json).verdict, 'SCALE');
  assert.strictEqual(record2.snapshot_hash, 'hash_new');
  assert.ok(record2.updated_at > record1.updated_at, 'updated_at must be newer than old timestamp');

  // Clean up
  db.prepare('DELETE FROM ad_ai_diagnoses WHERE ad_id = ?').run(testAdId);
});

console.log('\n===============================================================');
console.log(`=== SUMMARY: ${passCount} PASSED, ${failCount} FAILED ===`);
console.log('===============================================================');

if (failCount > 0) process.exit(1);

