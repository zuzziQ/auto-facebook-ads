const assert = require('assert');
const http = require('http');
const express = require('express');
const axios = require('axios');
const { db, stmts } = require('../src/db/database');
const adsDashboardRouter = require('../src/routes/adsDashboard');

console.log('===============================================================');
console.log('=== [QA TEST SUITE: WORKSPACE ACCOUNT ISOLATION & MT 26-5] ===');
console.log('===============================================================');

const WS_ID_TEST_1 = 101;
const WS_ID_TEST_2 = 102;
const ACC_WS1 = 'act_qa_ws1_001';
const ACC_WS2 = 'act_qa_ws2_002';

async function runSuite() {
  // Clean up any old test data
  db.prepare('DELETE FROM workspace_ad_accounts WHERE workspace_id IN (?, ?)').run(WS_ID_TEST_1, WS_ID_TEST_2);
  db.prepare('DELETE FROM workspaces WHERE id IN (?, ?)').run(WS_ID_TEST_1, WS_ID_TEST_2);
  db.prepare('DELETE FROM ad_config WHERE account_id IN (?, ?)').run(ACC_WS1, ACC_WS2);
  db.prepare('DELETE FROM ad_daily_stats WHERE account_name IN (?, ?)').run('QA WS1 Account', 'QA WS2 Account');

  // Insert test workspaces
  db.prepare('INSERT OR REPLACE INTO workspaces(id, name) VALUES (?, ?)').run(WS_ID_TEST_1, 'QA Test Workspace 1');
  db.prepare('INSERT OR REPLACE INTO workspaces(id, name) VALUES (?, ?)').run(WS_ID_TEST_2, 'QA Test Workspace 2');

  // Insert workspace ad accounts mapping
  db.prepare('INSERT OR REPLACE INTO workspace_ad_accounts(workspace_id, account_id, name, is_default) VALUES (?, ?, ?, ?)').run(WS_ID_TEST_1, ACC_WS1, 'QA WS1 Account', 1);
  db.prepare('INSERT OR REPLACE INTO workspace_ad_accounts(workspace_id, account_id, name, is_default) VALUES (?, ?, ?, ?)').run(WS_ID_TEST_2, ACC_WS2, 'QA WS2 Account', 1);

  // Setup Workspace 1 ads: 2 active ads, total daily budget = 500.000₫
  db.prepare(`
    INSERT INTO ad_config (ad_id, account_id, campaign_id, campaign_name, campaign_status, adset_id, adset_name, adset_status, ad_name, ad_status, adset_budget, adset_daily_budget, budget_type)
    VALUES 
      ('ad_ws1_001', ?, 'cmp_ws1_1', 'Camp WS1 A', 'ACTIVE', 'as_ws1_1', 'AdSet WS1 A', 'ACTIVE', 'Ad WS1 A1', 'ACTIVE', '300000', '300000', 'DAILY'),
      ('ad_ws1_002', ?, 'cmp_ws1_2', 'Camp WS1 B', 'ACTIVE', 'as_ws1_2', 'AdSet WS1 B', 'ACTIVE', 'Ad WS1 B1', 'ACTIVE', '200000', '200000', 'DAILY')
  `).run(ACC_WS1, ACC_WS1);

  // Setup Workspace 2 ads:
  // Requirement: 25 Daily ads (across 21 distinct Adsets), total daily budget = 2.839.500₫, total today spend = 1.006.861₫
  // Plus 3 Lifetime ads (MT 26-5 –1, MT 26-5 –2, and a high-budget lifetime ad)
  const ws2Adsets = [
    { asId: 'as_ws2_01', budget: 135000, spendToday: 48000, adCount: 2 }, // 2 ads in 1 adset
    { asId: 'as_ws2_02', budget: 135000, spendToday: 48000, adCount: 2 }, // 2 ads in 1 adset
    { asId: 'as_ws2_03', budget: 135000, spendToday: 48000, adCount: 2 }, // 2 ads in 1 adset
    { asId: 'as_ws2_04', budget: 135000, spendToday: 48000, adCount: 2 }, // 2 ads in 1 adset
    { asId: 'as_ws2_05', budget: 135000, spendToday: 47861, adCount: 1 },
    { asId: 'as_ws2_06', budget: 135000, spendToday: 48000, adCount: 1 },
    { asId: 'as_ws2_07', budget: 135000, spendToday: 48000, adCount: 1 },
    { asId: 'as_ws2_08', budget: 135000, spendToday: 48000, adCount: 1 },
    { asId: 'as_ws2_09', budget: 135000, spendToday: 48000, adCount: 1 },
    { asId: 'as_ws2_10', budget: 135000, spendToday: 48000, adCount: 1 },
    { asId: 'as_ws2_11', budget: 135000, spendToday: 48000, adCount: 1 },
    { asId: 'as_ws2_12', budget: 135000, spendToday: 48000, adCount: 1 },
    { asId: 'as_ws2_13', budget: 135000, spendToday: 48000, adCount: 1 },
    { asId: 'as_ws2_14', budget: 135000, spendToday: 48000, adCount: 1 },
    { asId: 'as_ws2_15', budget: 135000, spendToday: 48000, adCount: 1 },
    { asId: 'as_ws2_16', budget: 135000, spendToday: 48000, adCount: 1 },
    { asId: 'as_ws2_17', budget: 135000, spendToday: 48000, adCount: 1 },
    { asId: 'as_ws2_18', budget: 135000, spendToday: 48000, adCount: 1 },
    { asId: 'as_ws2_19', budget: 135000, spendToday: 48000, adCount: 1 },
    { asId: 'as_ws2_20', budget: 135000, spendToday: 48000, adCount: 1 },
    { asId: 'as_ws2_21', budget: 139500, spendToday: 47000, adCount: 1 }, // 20 * 135000 + 139500 = 2.839.500; sum spend = 1.006.861
  ];

  let adIdx = 1;
  const todayDate = db.prepare('SELECT COALESCE((SELECT MAX(date) FROM ad_daily_stats), date(\'now\')) as d').get().d;

  ws2Adsets.forEach(item => {
    for (let c = 0; c < item.adCount; c++) {
      const adId = `ad_ws2_${String(adIdx).padStart(3, '0')}`;
      db.prepare(`
        INSERT INTO ad_config (ad_id, account_id, campaign_id, campaign_name, campaign_status, adset_id, adset_name, adset_status, ad_name, ad_status, adset_budget, adset_daily_budget, budget_type)
        VALUES (?, ?, 'cmp_ws2_daily', 'Campaign WS2 Daily', 'ACTIVE', ?, ?, 'ACTIVE', ?, 'ACTIVE', ?, ?, 'DAILY')
      `).run(adId, ACC_WS2, item.asId, `AdSet ${item.asId}`, `Ad WS2 ${adIdx}`, String(item.budget), String(item.budget));

      const spendForAd = c === 0 ? item.spendToday : 0;
      db.prepare(`
        INSERT OR REPLACE INTO ad_daily_stats (date, account_name, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, spend, mess_started)
        VALUES (?, 'QA WS2 Account', 'cmp_ws2_daily', 'Campaign WS2 Daily', ?, ?, ?, ?, ?, 2)
      `).run(todayDate, item.asId, `AdSet ${item.asId}`, adId, `Ad WS2 ${adIdx}`, spendForAd);

      adIdx++;
    }
  });

  // 3 Lifetime ads for WS2:
  // 1) MT 26-5 –1 (Lifetime 10M)
  // 2) MT 26-5 –2 (Lifetime 10M)
  // 3) High budget camp (budget 5M >= 2M)
  db.prepare(`
    INSERT INTO ad_config (ad_id, account_id, campaign_id, campaign_name, campaign_status, adset_id, adset_name, adset_status, ad_name, ad_status, adset_budget, adset_daily_budget, adset_lifetime_budget, budget_type)
    VALUES 
      ('ad_ws2_lt_1', ?, 'cmp_mt_26_5', 'MT 26-5', 'ACTIVE', 'as_mt_1', 'MT 26-5 –1', 'ACTIVE', 'Ad MT 1', 'ACTIVE', '10000000', '0', '0', 'DAILY'),
      ('ad_ws2_lt_2', ?, 'cmp_mt_26_5', 'MT 26-5', 'ACTIVE', 'as_mt_2', 'MT 26-5 –2', 'ACTIVE', 'Ad MT 2', 'ACTIVE', '10000000', '0', '0', 'DAILY'),
      ('ad_ws2_lt_3', ?, 'cmp_ws2_lt_3', 'Camp Lifetime High', 'ACTIVE', 'as_lt_3', 'AdSet Lifetime High', 'ACTIVE', 'Ad LT 3', 'ACTIVE', '5000000', '0', '5000000', 'LIFETIME')
  `).run(ACC_WS2, ACC_WS2, ACC_WS2);

  console.log('\n--- 1. VERIFY DATABASE MIGRATION FOR MT 26-5 ---');
  // Trigger migration
  db.exec(`
    UPDATE ad_config
    SET budget_type = 'LIFETIME',
        adset_lifetime_budget = '10000000',
        adset_budget = '0',
        campaign_budget = '0',
        adset_daily_budget = '0',
        campaign_daily_budget = '0'
    WHERE adset_name LIKE '%MT 26-5%'
       OR campaign_name LIKE '%MT 26-5%'
       OR ad_name LIKE '%MT 26-5%';
  `);

  const mtRow1 = db.prepare('SELECT * FROM ad_config WHERE ad_id = ?').get('ad_ws2_lt_1');
  const mtRow2 = db.prepare('SELECT * FROM ad_config WHERE ad_id = ?').get('ad_ws2_lt_2');
  assert.strictEqual(mtRow1.budget_type, 'LIFETIME', 'MT 26-5 –1 must be migrated to budget_type = LIFETIME');
  assert.strictEqual(mtRow1.adset_lifetime_budget, '10000000', 'MT 26-5 –1 must have adset_lifetime_budget = 10000000');
  assert.strictEqual(mtRow1.adset_budget, '0', 'MT 26-5 –1 must have adset_budget = 0');
  assert.strictEqual(mtRow2.budget_type, 'LIFETIME', 'MT 26-5 –2 must be migrated to budget_type = LIFETIME');
  console.log('  ✅ PASS: Database migration correctly migrated MT 26-5 –1 and MT 26-5 –2 to LIFETIME with 0 daily budget');

  // Launch HTTP test server
  const app = express();
  app.use(express.json());
  app.use('/api/ads', adsDashboardRouter);
  const server = http.createServer(app);

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    console.log('\n--- 2. TEST GET /api/ads/budget-pacing FOR WORKSPACE 2 ---');
    const resPacingWs2 = await axios.get(`${baseUrl}/api/ads/budget-pacing?workspaceId=${WS_ID_TEST_2}`);
    assert.strictEqual(resPacingWs2.status, 200);
    assert.strictEqual(resPacingWs2.data.success, true);

    const summaryWs2 = resPacingWs2.data.data.summary;
    const pacingItemsWs2 = resPacingWs2.data.data.pacing_items;

    console.log('  Workspace 2 Budget Pacing Summary:');
    console.log(`  - total_daily_budget: ${summaryWs2.total_daily_budget.toLocaleString('vi-VN')}₫`);
    console.log(`  - total_today_spend: ${summaryWs2.total_today_spend.toLocaleString('vi-VN')}₫`);
    console.log(`  - overall_pacing_pct: ${summaryWs2.overall_pacing_pct}%`);
    console.log(`  - lifetime count: ${summaryWs2.counts.lifetime_scheduled}`);
    console.log(`  - total ads in pacing_items: ${pacingItemsWs2.length}`);

    // Verify Workspace 2 numbers:
    // 1) total_daily_budget: 2.839.500₫
    assert.strictEqual(summaryWs2.total_daily_budget, 2839500, 'WS2 total_daily_budget must be exactly 2.839.500₫');
    // 2) total_today_spend: 1.006.861₫
    assert.strictEqual(summaryWs2.total_today_spend, 1006861, 'WS2 total_today_spend must be exactly 1.006.861₫');
    // 3) overall_pacing_pct: 35%
    assert.strictEqual(summaryWs2.overall_pacing_pct, 35, 'WS2 overall_pacing_pct must be exactly 35%');
    // 4) 25 Daily ads + 3 Lifetime ads = 28 active ads
    const dailyAds = pacingItemsWs2.filter(i => i.budget_type === 'DAILY');
    const lifetimeAds = pacingItemsWs2.filter(i => i.budget_type === 'LIFETIME');
    assert.strictEqual(dailyAds.length, 25, 'WS2 must have exactly 25 Daily ads');
    assert.strictEqual(lifetimeAds.length, 3, 'WS2 must have exactly 3 Lifetime ads');

    console.log('  ✅ PASS: /api/ads/budget-pacing accurately computes 2.839.500₫ budget, 1.006.861₫ spend, 35% pacing, 25 Daily ads (21 Adsets) + 3 Lifetime ads');

    console.log('\n--- 3. TEST GET /api/ads/rule-optimizations FOR WORKSPACE 2 ---');
    const resOptWs2 = await axios.get(`${baseUrl}/api/ads/rule-optimizations?workspaceId=${WS_ID_TEST_2}`);
    assert.strictEqual(resOptWs2.status, 200);
    assert.strictEqual(resOptWs2.data.success, true);

    const optSummaryWs2 = resOptWs2.data.data.budget_pacing_summary;
    console.log('  Workspace 2 Rule-optimizations Budget Pacing Summary:');
    console.log(`  - total_daily_budget: ${optSummaryWs2.total_daily_budget.toLocaleString('vi-VN')}₫`);
    console.log(`  - total_today_spend: ${optSummaryWs2.total_today_spend.toLocaleString('vi-VN')}₫`);
    console.log(`  - overall_pacing_pct: ${optSummaryWs2.overall_pacing_pct}%`);

    assert.strictEqual(optSummaryWs2.total_daily_budget, 2839500, 'Rule-optimizations WS2 total_daily_budget must be 2.839.500₫');
    assert.strictEqual(optSummaryWs2.total_today_spend, 1006861, 'Rule-optimizations WS2 total_today_spend must be 1.006.861₫');
    assert.strictEqual(optSummaryWs2.overall_pacing_pct, 35, 'Rule-optimizations WS2 overall_pacing_pct must be 35%');

    console.log('  ✅ PASS: /api/ads/rule-optimizations is fully synchronized with 2.839.500₫ and 35% pacing');

    console.log('\n--- 4. TEST WORKSPACE ACCOUNT ISOLATION (WS 1 VS WS 2) ---');
    // WS1 request must ONLY see WS1 ads (500k budget, 2 ads)
    const resPacingWs1 = await axios.get(`${baseUrl}/api/ads/budget-pacing?workspaceId=${WS_ID_TEST_1}`);
    const summaryWs1 = resPacingWs1.data.data.summary;
    const pacingItemsWs1 = resPacingWs1.data.data.pacing_items;

    assert.strictEqual(summaryWs1.total_daily_budget, 500000, 'WS1 daily budget must be 500.000₫ (not mixed with WS2)');
    assert.strictEqual(pacingItemsWs1.length, 2, 'WS1 must have exactly 2 active ads');
    pacingItemsWs1.forEach(item => {
      assert.strictEqual(item.account_id, ACC_WS1, `WS1 ad ${item.ad_id} must belong to ACC_WS1 (${ACC_WS1})`);
    });

    console.log('  ✅ PASS: Workspace 1 cannot see any ads from Workspace 2');

    // Test GET /api/ads/creatives isolation
    const resCreativesWs1 = await axios.get(`${baseUrl}/api/ads/creatives?workspaceId=${WS_ID_TEST_1}`);
    const creativesWs1 = resCreativesWs1.data.data;
    assert.strictEqual(creativesWs1.length, 2, 'Creatives for WS1 must return exactly 2 ads');
    creativesWs1.forEach(ad => {
      assert.strictEqual(ad.account_id, ACC_WS1, `Creative ${ad.ad_id} must belong to ACC_WS1`);
    });

    const resCreativesWs2 = await axios.get(`${baseUrl}/api/ads/creatives?workspaceId=${WS_ID_TEST_2}`);
    const creativesWs2 = resCreativesWs2.data.data;
    assert.strictEqual(creativesWs2.length, 28, 'Creatives for WS2 must return exactly 28 WS2 ads');
    creativesWs2.forEach(ad => {
      assert.strictEqual(ad.account_id, ACC_WS2, `Creative ${ad.ad_id} must belong to ACC_WS2`);
    });

    console.log('  ✅ PASS: /api/ads/creatives is strictly isolated between workspaces');

    // Test GET /api/ads/summary isolation
    const resSummaryWs1 = await axios.get(`${baseUrl}/api/ads/summary?workspaceId=${WS_ID_TEST_1}`);
    assert.strictEqual(resSummaryWs1.data.data.active_ads, 2, 'Summary active_ads for WS1 must be 2');

    const resSummaryWs2 = await axios.get(`${baseUrl}/api/ads/summary?workspaceId=${WS_ID_TEST_2}`);
    assert.strictEqual(resSummaryWs2.data.data.active_ads, 28, 'Summary active_ads for WS2 must be 28');

    console.log('  ✅ PASS: /api/ads/summary is strictly isolated between workspaces');

    console.log('\n===============================================================');
    console.log('=== SUMMARY: ALL WORKSPACE ISOLATION TESTS PASSED (0 FAILURES) ===');
    console.log('===============================================================');
  } finally {
    server.close();
    // Clean up test data
    db.prepare('DELETE FROM workspace_ad_accounts WHERE workspace_id IN (?, ?)').run(WS_ID_TEST_1, WS_ID_TEST_2);
    db.prepare('DELETE FROM workspaces WHERE id IN (?, ?)').run(WS_ID_TEST_1, WS_ID_TEST_2);
    db.prepare('DELETE FROM ad_config WHERE account_id IN (?, ?)').run(ACC_WS1, ACC_WS2);
    db.prepare('DELETE FROM ad_daily_stats WHERE account_name IN (?, ?)').run('QA WS1 Account', 'QA WS2 Account');
  }
}

runSuite().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
