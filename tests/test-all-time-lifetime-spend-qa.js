const assert = require('assert');
const http = require('http');
const express = require('express');
const axios = require('axios');
const { db } = require('../src/db/database');
const adsDashboardRouter = require('../src/routes/adsDashboard');

console.log('======================================================================');
console.log('=== [QA TEST SUITE: ALL-TIME LIFETIME SPEND & ADSET DEDUPLICATION] ===');
console.log('======================================================================');

const WS_TEST_ID = 888;
const ACC_TEST_ID = 'act_qa_lifetime_alltime_001';

async function runTest() {
  // Clean up test data
  db.prepare('DELETE FROM workspace_ad_accounts WHERE workspace_id = ?').run(WS_TEST_ID);
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(WS_TEST_ID);
  db.prepare('DELETE FROM ad_config WHERE account_id = ?').run(ACC_TEST_ID);
  db.prepare('DELETE FROM ad_daily_stats WHERE account_name = ?').run('QA Lifetime AllTime Account');

  // Insert workspace
  db.prepare('INSERT OR REPLACE INTO workspaces(id, name) VALUES (?, ?)').run(WS_TEST_ID, 'QA Lifetime AllTime Workspace');
  db.prepare('INSERT OR REPLACE INTO workspace_ad_accounts(workspace_id, account_id, name, is_default) VALUES (?, ?, ?, ?)').run(WS_TEST_ID, ACC_TEST_ID, 'QA Lifetime AllTime Account', 1);

  // We set up 2 Lifetime Adsets under campaign 'MT 26-5':
  // AdSet 1: 'MT 26-5 –1' (lifetime budget 10.000.000₫)
  //   - Ad 1: 'Ad MT 26-5 –1 A'
  //       * today_spend: 15.000₫, today_mess: 1
  //       * 7d spend: 200.000₫
  //       * historical spend (beyond 7d): 6.000.000₫
  //       * total all-time spend: 6.215.000₫, all-time mess: 30
  //   - Ad 2: 'Ad MT 26-5 –1 B'
  //       * today_spend: 10.000₫, today_mess: 0
  //       * historical spend: 1.000.000₫
  //       * total all-time spend: 1.010.000₫, all-time mess: 5
  //   => AdSet 1 Total All-Time Spend: 7.225.000₫, today_spend: 25.000₫, spend_pct: 72%
  //
  // AdSet 2: 'MT 26-5 –2' (lifetime budget 10.000.000₫)
  //   - Ad 3: 'Ad MT 26-5 –2'
  //       * today_spend: 25.463₫, today_mess: 2
  //       * historical spend: 8.569.090₫
  //       * total all-time spend: 8.594.553₫, all-time mess: 42
  //   => AdSet 2 Total All-Time Spend: 8.594.553₫, today_spend: 25.463₫, spend_pct: 86%
  //
  // Plus 1 Daily AdSet:
  // AdSet 3: 'Daily Adset' (daily budget 500.000₫)
  //   - Ad 4: 'Ad Daily 1' (today_spend: 150.000₫, 7d: 1.000.000₫, all-time: 3.000.000₫)

  db.prepare(`
    INSERT INTO ad_config (ad_id, account_id, campaign_id, campaign_name, campaign_status, adset_id, adset_name, adset_status, ad_name, ad_status, adset_budget, adset_daily_budget, adset_lifetime_budget, budget_type)
    VALUES 
      ('ad_lt_01', ?, 'cmp_mt_26_5', 'Chiến dịch MT 26-5', 'ACTIVE', 'as_mt_01', 'MT 26-5 –1', 'ACTIVE', 'Ad MT 26-5 –1 A', 'ACTIVE', '10000000', '0', '10000000', 'LIFETIME'),
      ('ad_lt_02', ?, 'cmp_mt_26_5', 'Chiến dịch MT 26-5', 'ACTIVE', 'as_mt_01', 'MT 26-5 –1', 'ACTIVE', 'Ad MT 26-5 –1 B', 'ACTIVE', '10000000', '0', '10000000', 'LIFETIME'),
      ('ad_lt_03', ?, 'cmp_mt_26_5', 'Chiến dịch MT 26-5', 'ACTIVE', 'as_mt_02', 'MT 26-5 –2', 'ACTIVE', 'MT 26-5 –2', 'ACTIVE', '10000000', '0', '10000000', 'LIFETIME'),
      ('ad_daily_01', ?, 'cmp_daily_01', 'Chiến dịch Daily', 'ACTIVE', 'as_daily_01', 'Nhóm Daily 01', 'ACTIVE', 'Ad Daily 01', 'ACTIVE', '500000', '500000', '0', 'DAILY')
  `).run(ACC_TEST_ID, ACC_TEST_ID, ACC_TEST_ID, ACC_TEST_ID);

  const todayDate = db.prepare('SELECT COALESCE((SELECT MAX(date) FROM ad_daily_stats), date(\'now\')) as d').get().d;

  // Insert stats for Ad 1 (ad_lt_01):
  // today: 15.000 spend, 1 mess
  db.prepare(`
    INSERT INTO ad_daily_stats (date, account_name, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, spend, mess_started)
    VALUES (?, 'QA Lifetime AllTime Account', 'cmp_mt_26_5', 'Chiến dịch MT 26-5', 'as_mt_01', 'MT 26-5 –1', 'ad_lt_01', 'Ad MT 26-5 –1 A', 15000, 1)
  `).run(todayDate);
  // 7d recent: 200.000 spend, 4 mess
  db.prepare(`
    INSERT INTO ad_daily_stats (date, account_name, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, spend, mess_started)
    VALUES (date(?, '-2 days'), 'QA Lifetime AllTime Account', 'cmp_mt_26_5', 'Chiến dịch MT 26-5', 'as_mt_01', 'MT 26-5 –1', 'ad_lt_01', 'Ad MT 26-5 –1 A', 200000, 4)
  `).run(todayDate);
  // historical (>7d ago): 6.000.000 spend, 25 mess
  db.prepare(`
    INSERT INTO ad_daily_stats (date, account_name, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, spend, mess_started)
    VALUES (date(?, '-20 days'), 'QA Lifetime AllTime Account', 'cmp_mt_26_5', 'Chiến dịch MT 26-5', 'as_mt_01', 'MT 26-5 –1', 'ad_lt_01', 'Ad MT 26-5 –1 A', 6000000, 25)
  `).run(todayDate);

  // Insert stats for Ad 2 (ad_lt_02):
  // today: 10.000 spend, 0 mess
  db.prepare(`
    INSERT INTO ad_daily_stats (date, account_name, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, spend, mess_started)
    VALUES (?, 'QA Lifetime AllTime Account', 'cmp_mt_26_5', 'Chiến dịch MT 26-5', 'as_mt_01', 'MT 26-5 –1', 'ad_lt_02', 'Ad MT 26-5 –1 B', 10000, 0)
  `).run(todayDate);
  // historical (>7d ago): 1.000.000 spend, 5 mess
  db.prepare(`
    INSERT INTO ad_daily_stats (date, account_name, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, spend, mess_started)
    VALUES (date(?, '-15 days'), 'QA Lifetime AllTime Account', 'cmp_mt_26_5', 'Chiến dịch MT 26-5', 'as_mt_01', 'MT 26-5 –1', 'ad_lt_02', 'Ad MT 26-5 –1 B', 1000000, 5)
  `).run(todayDate);

  // Insert stats for Ad 3 (ad_lt_03 - MT 26-5 –2):
  // today: 25.463 spend, 2 mess
  db.prepare(`
    INSERT INTO ad_daily_stats (date, account_name, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, spend, mess_started)
    VALUES (?, 'QA Lifetime AllTime Account', 'cmp_mt_26_5', 'Chiến dịch MT 26-5', 'as_mt_02', 'MT 26-5 –2', 'ad_lt_03', 'MT 26-5 –2', 25463, 2)
  `).run(todayDate);
  // historical: 8.569.090 spend, 40 mess
  db.prepare(`
    INSERT INTO ad_daily_stats (date, account_name, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, spend, mess_started)
    VALUES (date(?, '-25 days'), 'QA Lifetime AllTime Account', 'cmp_mt_26_5', 'Chiến dịch MT 26-5', 'as_mt_02', 'MT 26-5 –2', 'ad_lt_03', 'MT 26-5 –2', 8569090, 40)
  `).run(todayDate);

  // Insert stats for Ad 4 (Daily):
  db.prepare(`
    INSERT INTO ad_daily_stats (date, account_name, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, spend, mess_started)
    VALUES (?, 'QA Lifetime AllTime Account', 'cmp_daily_01', 'Chiến dịch Daily', 'as_daily_01', 'Nhóm Daily 01', 'ad_daily_01', 'Ad Daily 01', 150000, 3)
  `).run(todayDate);

  // Setup Express server
  const app = express();
  app.use(express.json());
  app.use('/api/ads', adsDashboardRouter);
  const server = http.createServer(app);

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    console.log('\n--- 1. TEST GET /api/ads/budget-pacing ---');
    const resPacing = await axios.get(`${baseUrl}/api/ads/budget-pacing?workspaceId=${WS_TEST_ID}`);
    assert.strictEqual(resPacing.status, 200);
    assert.strictEqual(resPacing.data.success, true);

    const { summary, pacing_items, lifetime_adsets } = resPacing.data.data;

    console.log('  pacing_items count:', pacing_items.length);
    console.log('  lifetime_adsets count:', lifetime_adsets.length);

    // Verify pacing_items
    const mt2Ad = pacing_items.find(i => i.ad_id === 'ad_lt_03');
    assert.ok(mt2Ad, 'MT 26-5 –2 ad must be found in pacing_items');
    console.log('  MT 26-5 –2 Item:');
    console.log(`    - all_time_spend: ${mt2Ad.all_time_spend.toLocaleString('vi-VN')}₫ (Expected: 8.594.553₫)`);
    console.log(`    - lifetime_spend: ${mt2Ad.lifetime_spend.toLocaleString('vi-VN')}₫ (Expected: 8.594.553₫)`);
    console.log(`    - lifetime_budget: ${mt2Ad.lifetime_budget.toLocaleString('vi-VN')}₫ (Expected: 10.000.000₫)`);
    console.log(`    - lifetime_spend_pct: ${mt2Ad.lifetime_spend_pct}% (Expected: 86%)`);
    console.log(`    - today_spend: ${mt2Ad.today_spend.toLocaleString('vi-VN')}₫ (Expected: 25.463₫)`);

    assert.strictEqual(mt2Ad.all_time_spend, 8594553, 'MT 26-5 –2 all_time_spend must be 8.594.553₫');
    assert.strictEqual(mt2Ad.lifetime_spend, 8594553, 'MT 26-5 –2 lifetime_spend must be 8.594.553₫ (not 25.463₫)');
    assert.strictEqual(mt2Ad.lifetime_budget, 10000000, 'MT 26-5 –2 lifetime_budget must be 10.000.000₫');
    assert.strictEqual(mt2Ad.lifetime_spend_pct, 86, 'MT 26-5 –2 lifetime_spend_pct must be 86%');
    assert.strictEqual(mt2Ad.today_spend, 25463, 'MT 26-5 –2 today_spend must be 25.463₫');
    assert.strictEqual(mt2Ad.all_time_mess, 42, 'MT 26-5 –2 all_time_mess must be 42');

    // Verify lifetime_adsets deduplication & grouping
    console.log('\n--- 2. VERIFY lifetime_adsets STRUCTURE & ADSET DEDUPLICATION ---');
    assert.strictEqual(lifetime_adsets.length, 2, 'Must have exactly 2 unique lifetime adsets (as_mt_01 and as_mt_02)');

    const groupMt1 = lifetime_adsets.find(g => g.adset_id === 'as_mt_01');
    assert.ok(groupMt1, 'Group for as_mt_01 must exist');
    console.log('  AdSet 1 (MT 26-5 –1) Group:');
    console.log(`    - ad_count: ${groupMt1.ad_count} (Expected: 2 ads)`);
    console.log(`    - lifetime_budget: ${groupMt1.lifetime_budget.toLocaleString('vi-VN')}₫ (Expected: 10.000.000₫)`);
    console.log(`    - all_time_spend: ${groupMt1.all_time_spend.toLocaleString('vi-VN')}₫ (Expected: 7.225.000₫)`);
    console.log(`    - all_time_mess: ${groupMt1.all_time_mess} (Expected: 35)`);
    console.log(`    - today_spend: ${groupMt1.today_spend.toLocaleString('vi-VN')}₫ (Expected: 25.000₫)`);
    console.log(`    - spend_pct: ${groupMt1.spend_pct}% (Expected: 72%)`);

    assert.strictEqual(groupMt1.ad_count, 2, 'AdSet 1 must contain 2 ads');
    assert.strictEqual(groupMt1.lifetime_budget, 10000000, 'AdSet 1 lifetime_budget must be 10.000.000₫');
    assert.strictEqual(groupMt1.all_time_spend, 7225000, 'AdSet 1 all_time_spend must be 7.225.000₫');
    assert.strictEqual(groupMt1.all_time_mess, 35, 'AdSet 1 all_time_mess must be 35');
    assert.strictEqual(groupMt1.today_spend, 25000, 'AdSet 1 today_spend must be 25.000₫');
    assert.strictEqual(groupMt1.spend_pct, 72, 'AdSet 1 spend_pct must be 72%');
    assert.strictEqual(groupMt1.ads.length, 2, 'groupMt1.ads must contain 2 ad items');

    const groupMt2 = lifetime_adsets.find(g => g.adset_id === 'as_mt_02');
    assert.ok(groupMt2, 'Group for as_mt_02 must exist');
    assert.strictEqual(groupMt2.ad_count, 1, 'AdSet 2 must contain 1 ad');
    assert.strictEqual(groupMt2.lifetime_budget, 10000000, 'AdSet 2 lifetime_budget must be 10.000.000₫');
    assert.strictEqual(groupMt2.all_time_spend, 8594553, 'AdSet 2 all_time_spend must be 8.594.553₫');
    assert.strictEqual(groupMt2.spend_pct, 86, 'AdSet 2 spend_pct must be 86%');

    // Verify summary.lifetime
    console.log('\n--- 3. VERIFY summary.lifetime ---');
    console.log('  summary.lifetime:');
    console.log(`    - total_lifetime_budget: ${summary.lifetime.total_lifetime_budget.toLocaleString('vi-VN')}₫ (Expected: 20.000.000₫)`);
    console.log(`    - total_lifetime_spend: ${summary.lifetime.total_lifetime_spend.toLocaleString('vi-VN')}₫ (Expected: 15.819.553₫)`);
    console.log(`    - count: ${summary.lifetime.count} (Expected: 2)`);

    assert.strictEqual(summary.lifetime.total_lifetime_budget, 20000000, 'total_lifetime_budget must be exactly 20.000.000₫ (10M + 10M)');
    assert.strictEqual(summary.lifetime.total_lifetime_spend, 15819553, 'total_lifetime_spend must be sum of unique all_time_spend (7.225.000 + 8.594.553 = 15.819.553₫)');
    assert.strictEqual(summary.lifetime.count, 2, 'summary.lifetime.count must be 2 unique adsets');

    // Verify Daily summary separation
    assert.strictEqual(summary.total_daily_budget, 500000, 'Daily budget must be 500.000₫ (not polluted by lifetime 20M)');
    assert.strictEqual(summary.total_today_spend, 150000, 'Daily today spend must be 150.000₫');
    assert.strictEqual(summary.overall_pacing_pct, 30, 'Daily pacing pct must be 30% (150k / 500k)');

    // Verify GET /api/ads/rule-optimizations
    console.log('\n--- 4. TEST GET /api/ads/rule-optimizations ---');
    const resOpt = await axios.get(`${baseUrl}/api/ads/rule-optimizations?workspaceId=${WS_TEST_ID}`);
    assert.strictEqual(resOpt.status, 200);
    assert.strictEqual(resOpt.data.success, true);

    const { recommendations, budget_pacing_summary } = resOpt.data.data;
    const optMt2 = recommendations.find(r => r.ad_id === 'ad_lt_03');
    assert.ok(optMt2, 'MT 26-5 –2 ad must be in recommendations');
    console.log('  Rule-optimizations MT 26-5 –2:');
    console.log(`    - all_time_spend: ${optMt2.all_time_spend.toLocaleString('vi-VN')}₫`);
    console.log(`    - lifetime_spend: ${optMt2.lifetime_spend.toLocaleString('vi-VN')}₫`);
    console.log(`    - lifetime_budget: ${optMt2.lifetime_budget.toLocaleString('vi-VN')}₫`);

    assert.strictEqual(optMt2.all_time_spend, 8594553, 'Rule-opt all_time_spend must be 8.594.553₫');
    assert.strictEqual(optMt2.lifetime_spend, 8594553, 'Rule-opt lifetime_spend must be 8.594.553₫');
    assert.strictEqual(optMt2.lifetime_budget, 10000000, 'Rule-opt lifetime_budget must be 10.000.000₫');
    assert.strictEqual(optMt2.is_lifetime, true, 'is_lifetime must be true');
    assert.strictEqual(optMt2.budget_type, 'LIFETIME', 'budget_type must be LIFETIME');

    // Verify rule-optimizations budget_pacing_summary.lifetime
    assert.strictEqual(budget_pacing_summary.lifetime.total_lifetime_budget, 20000000, 'Rule-opt lifetime budget must be 20.000.000₫');
    assert.strictEqual(budget_pacing_summary.lifetime.total_lifetime_spend, 15819553, 'Rule-opt lifetime spend must be 15.819.553₫');
    assert.strictEqual(budget_pacing_summary.lifetime.count, 2, 'Rule-opt unique lifetime adsets count must be 2');

    console.log('\n======================================================================');
    console.log('=== SUMMARY: ALL ALL-TIME LIFETIME SPEND QA TESTS PASSED (0 ERRORS) ===');
    console.log('======================================================================');
  } finally {
    server.close();
    // Clean up test data
    db.prepare('DELETE FROM workspace_ad_accounts WHERE workspace_id = ?').run(WS_TEST_ID);
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(WS_TEST_ID);
    db.prepare('DELETE FROM ad_config WHERE account_id = ?').run(ACC_TEST_ID);
    db.prepare('DELETE FROM ad_daily_stats WHERE account_name = ?').run('QA Lifetime AllTime Account');
  }
}

runTest().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
