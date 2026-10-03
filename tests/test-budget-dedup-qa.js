const assert = require('assert');
const http = require('http');
const express = require('express');
const axios = require('axios');
const { db, stmts } = require('../src/db/database');
const adsDashboardRouter = require('../src/routes/adsDashboard');

console.log('===============================================================');
console.log('=== [QA TEST SUITE: ADSET & LIFETIME BUDGET DEDUPLICATION] ===');
console.log('===============================================================');

// 1. Kiểm tra migration SQLite
console.log('\n--- 1. VERIFY SQLITE DB MIGRATION & AD_CONFIG INTEGRITY ---');
const lifetimeRows = db.prepare(`
  SELECT ad_id, ad_name, budget_type, adset_budget, campaign_budget, adset_daily_budget, adset_lifetime_budget
  FROM ad_config
  WHERE CAST(adset_budget AS INTEGER) >= 2000000 OR CAST(campaign_budget AS INTEGER) >= 2000000
`).all();

console.log(`  Found ${lifetimeRows.length} ads with budget >= 2.000.000₫:`);
lifetimeRows.forEach(row => {
  console.log(`  - [${row.ad_id}] budget_type: ${row.budget_type}, adset_budget: ${row.adset_budget}, daily: ${row.adset_daily_budget}, lifetime: ${row.adset_lifetime_budget}`);
  assert.strictEqual(row.budget_type, 'LIFETIME', `Ad ${row.ad_id} must have budget_type = 'LIFETIME'`);
  assert.strictEqual(row.adset_daily_budget, '0', `Ad ${row.ad_id} must have adset_daily_budget = '0'`);
});
console.log('  ✅ PASS: All high-budget (>= 2.000.000đ) ads properly migrated to LIFETIME with 0 daily budget');

// 2. Kiểm tra API GET /api/ads/budget-pacing & /api/ads/rule-optimizations
const app = express();
app.use(express.json());
app.use('/api/ads', adsDashboardRouter);

const server = http.createServer(app);

server.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    console.log('\n--- 2. TEST GET /api/ads/budget-pacing DEDUPLICATION ---');
    const resPacing = await axios.get(`${baseUrl}/api/ads/budget-pacing?workspaceId=1`);
    assert.strictEqual(resPacing.status, 200);
    assert.strictEqual(resPacing.data.success, true);

    const summary = resPacing.data.data.summary;
    console.log('  Budget Pacing Summary:');
    console.log(`  - total_daily_budget: ${summary.total_daily_budget.toLocaleString('vi-VN')}₫`);
    console.log(`  - total_today_spend: ${summary.total_today_spend.toLocaleString('vi-VN')}₫`);
    console.log(`  - overall_pacing_pct: ${summary.overall_pacing_pct}%`);
    console.log(`  - lifetime budget count: ${summary.counts.lifetime_scheduled}`);
    console.log(`  - total_lifetime_budget: ${summary.lifetime.total_lifetime_budget.toLocaleString('vi-VN')}₫`);

    // Verify daily budget is not inflated (should be around 2.800.000₫, definitely < 5.000.000₫, not 23.658.500₫)
    assert.ok(summary.total_daily_budget > 0 && summary.total_daily_budget < 5000000, `total_daily_budget (${summary.total_daily_budget}) must be ~2.800.000₫, not inflated 23M`);
    assert.strictEqual(summary.total_daily_budget, 2814000, 'total_daily_budget must match deduplicated active adset total (2.814.000₫)');

    console.log('  ✅ PASS: /api/ads/budget-pacing returns exact deduplicated total_daily_budget (2.814.000₫)');

    // 3. Kiểm tra API GET /api/ads/rule-optimizations
    console.log('\n--- 3. TEST GET /api/ads/rule-optimizations BUDGET PACING SUMMARY ---');
    const resOpt = await axios.get(`${baseUrl}/api/ads/rule-optimizations?workspaceId=1`);
    assert.strictEqual(resOpt.status, 200);
    assert.strictEqual(resOpt.data.success, true);

    const optSummary = resOpt.data.data.budget_pacing_summary;
    console.log('  Rule-optimizations Budget Pacing Summary:');
    console.log(`  - total_daily_budget: ${optSummary.total_daily_budget.toLocaleString('vi-VN')}₫`);
    console.log(`  - total_today_spend: ${optSummary.total_today_spend.toLocaleString('vi-VN')}₫`);
    console.log(`  - overall_pacing_pct: ${optSummary.overall_pacing_pct}%`);
    console.log(`  - lifetime_scheduled_count: ${optSummary.lifetime_scheduled_count}`);

    assert.strictEqual(optSummary.total_daily_budget, summary.total_daily_budget, 'rule-optimizations daily budget must match budget-pacing endpoint');
    assert.strictEqual(optSummary.total_today_spend, summary.total_today_spend, 'rule-optimizations today spend must match budget-pacing endpoint');
    assert.strictEqual(optSummary.overall_pacing_pct, summary.overall_pacing_pct, 'rule-optimizations overall pacing pct must match');

    console.log('  ✅ PASS: /api/ads/rule-optimizations budget_pacing_summary is perfectly synchronized');

    // 4. Test CBO and ABO deduplication simulation
    console.log('\n--- 4. SIMULATION: CBO VS ABO MULTI-AD DEDUPLICATION ---');
    const mockRows = [
      { ad_id: 'ad1', adset_id: 'as1', campaign_id: 'cmp1', adset_daily_budget: '300000', campaign_daily_budget: '0', today_spend: 50000, active: true },
      { ad_id: 'ad2', adset_id: 'as1', campaign_id: 'cmp1', adset_daily_budget: '300000', campaign_daily_budget: '0', today_spend: 60000, active: true },
      { ad_id: 'ad3', adset_id: 'as1', campaign_id: 'cmp1', adset_daily_budget: '300000', campaign_daily_budget: '0', today_spend: 40000, active: true },
      { ad_id: 'ad4', adset_id: 'as2', campaign_id: 'cmp2', adset_daily_budget: '0', campaign_daily_budget: '500000', today_spend: 100000, active: true },
      { ad_id: 'ad5', adset_id: 'as3', campaign_id: 'cmp2', adset_daily_budget: '0', campaign_daily_budget: '500000', today_spend: 120000, active: true },
    ];

    const testDailyAdsets = new Map();
    let testSpend = 0;
    mockRows.forEach(r => {
      const asDaily = Number(r.adset_daily_budget || 0);
      const cmpDaily = Number(r.campaign_daily_budget || 0);
      const dailyBudget = asDaily || cmpDaily;
      const dedupeKey = (cmpDaily > 0 && asDaily === 0) ? `cmp_${r.campaign_id}` : `adset_${r.adset_id || r.campaign_id || r.ad_id}`;
      if (!testDailyAdsets.has(dedupeKey)) {
        testDailyAdsets.set(dedupeKey, dailyBudget);
      }
      testSpend += r.today_spend;
    });

    const testTotalDailyBudget = Array.from(testDailyAdsets.values()).reduce((s, b) => s + b, 0);
    // Expected: 300k (from as1) + 500k (from cmp2) = 800,000đ (instead of 300k*3 + 500k*2 = 1.900.000đ)
    assert.strictEqual(testTotalDailyBudget, 800000, 'Deduplicated daily budget must be 800.000₫');
    assert.strictEqual(testSpend, 370000, 'Total today spend must be sum of all ads (370.000₫)');
    const testPacingPct = Math.round((testSpend / testTotalDailyBudget) * 100);
    assert.strictEqual(testPacingPct, 46, 'Pacing percentage must be 46%');
    console.log('  ✅ PASS: CBO + ABO Multi-Ad Deduplication simulation accurate (800k budget, 370k spend, 46% pacing)');

    console.log('\n===============================================================');
    console.log('=== SUMMARY: ALL DEDUPLICATION TESTS PASSED (0 FAILURES) ===');
    console.log('===============================================================');

    server.close();
    process.exit(0);
  } catch (err) {
    console.error('❌ Test failed:', err.message);
    server.close();
    process.exit(1);
  }
});
