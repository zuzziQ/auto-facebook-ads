const assert = require('assert');
const express = require('express');
const axios = require('axios');
const http = require('http');
const { db, stmts } = require('../src/db/database');
const {
  classifyCity,
  calculateAudienceHealth,
  getPageSummary,
  syncPageInsights
} = require('../src/services/facebookPageAnalytics');
const pageAnalyticsRouter = require('../src/routes/pageAnalytics');

console.log('===============================================================');
console.log('=== [QA TEST SUITE: PAGE ANALYTICS & AUDIENCE HEALTH] ===');
console.log('===============================================================');

async function runTests() {
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error('    Error:', err.message);
      failed++;
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error('    Error:', err.message);
      failed++;
    }
  }

  console.log('\n--- 1. DATABASE SCHEMA & INTEGRITY CHECKS ---');

  test('Table page_daily_insights exists with correct columns', () => {
    const columns = db.prepare(`PRAGMA table_info(page_daily_insights)`).all();
    const colNames = columns.map(c => c.name);

    const requiredCols = [
      'id', 'workspace_id', 'page_id', 'page_name', 'date',
      'fans_total', 'fan_adds', 'fan_removes',
      'reach_total', 'reach_organic', 'reach_paid',
      'impressions_total', 'impressions_organic', 'impressions_paid',
      'post_engagements', 'page_views',
      'demographics_json', 'cities_json',
      'audience_quality_score', 'misalignment_pct', 'created_at'
    ];

    for (const col of requiredCols) {
      assert(colNames.includes(col), `Missing required column: ${col}`);
    }
  });

  test('Page daily insights indexes exist', () => {
    const indexes = db.prepare(`PRAGMA index_list(page_daily_insights)`).all();
    const indexNames = indexes.map(i => i.name);
    assert(indexNames.includes('idx_page_daily_insights_page_date'), 'idx_page_daily_insights_page_date missing');
    assert(indexNames.includes('idx_page_daily_insights_ws_date'), 'idx_page_daily_insights_ws_date missing');
  });

  test('Workspace pages has Page Phan Thủy (245392165331140)', () => {
    const page = db.prepare(`SELECT * FROM workspace_pages WHERE page_id = '245392165331140'`).get();
    assert(page, 'Phan Thuy page missing in workspace_pages');
    assert.strictEqual(page.workspace_id, 2, 'Phan Thuy should belong to workspace 2');
  });

  test('Initial seed data populated for Phan Thủy and Aeslatek pages', () => {
    const countPhanThuy = db.prepare(`SELECT COUNT(*) as cnt FROM page_daily_insights WHERE page_id = '245392165331140'`).get();
    assert(countPhanThuy.cnt >= 30, `Phan Thuy should have >= 30 days of data, found: ${countPhanThuy.cnt}`);

    const countAeslatek = db.prepare(`SELECT COUNT(*) as cnt FROM page_daily_insights WHERE page_id = '106767375864356'`).get();
    assert(countAeslatek.cnt >= 30, `Aeslatek Dr Nghi should have >= 30 days of data, found: ${countAeslatek.cnt}`);
  });

  console.log('\n--- 2. GEOGRAPHIC CLASSIFICATION & AUDIENCE HEALTH ---');

  test('classifyCity correctly identifies city tiers', () => {
    assert.strictEqual(classifyCity('Hanoi, Vietnam').category, 'core');
    assert.strictEqual(classifyCity('Hà Nội').category, 'core');
    assert.strictEqual(classifyCity('Ho Chi Minh City, Vietnam').category, 'major_city');
    assert.strictEqual(classifyCity('Đà Nẵng').category, 'major_city');
    assert.strictEqual(classifyCity('Hải Phòng').category, 'major_city');

    assert.strictEqual(classifyCity('Son La, Vietnam').category, 'remote_unaligned');
    assert.strictEqual(classifyCity('Sơn La').category, 'remote_unaligned');
    assert.strictEqual(classifyCity('Dien Bien Phu, Vietnam').category, 'remote_unaligned');
    assert.strictEqual(classifyCity('Lai Chau, Vietnam').category, 'remote_unaligned');
    assert.strictEqual(classifyCity('Dak Lak, Vietnam').category, 'remote_unaligned');
    assert.strictEqual(classifyCity('Hà Giang').category, 'remote_unaligned');

    assert.strictEqual(classifyCity('Bắc Ninh').category, 'suburban');
    assert.strictEqual(classifyCity('Vinh Phuc, Vietnam').category, 'suburban');
  });

  test('calculateAudienceHealth flags severe remote misalignment for Phan Thuy', () => {
    const mockDemo = {
      'F.18-24': 2450,
      'F.25-34': 4680,
      'F.35-44': 2520,
      'F.45-54': 980,
      'M.25-34': 1350
    };
    const mockCities = {
      'Hanoi, Vietnam': 4850,
      'Son La, Vietnam': 1860,
      'Dien Bien Phu, Vietnam': 1120,
      'Lai Chau, Vietnam': 710,
      'Dak Lak, Vietnam': 680,
      'Ha Giang, Vietnam': 640
    };

    const health = calculateAudienceHealth({
      demographics: mockDemo,
      cities: mockCities,
      reachOrganic: 12000,
      reachPaid: 4000
    });

    assert(health.misalignmentPct >= 35, `Expected misalignment >= 35%, got: ${health.misalignmentPct}%`);
    assert.strictEqual(health.status, 'CRITICAL', `Expected CRITICAL status, got: ${health.status}`);
    assert(health.qualityScore < 60, `Expected qualityScore < 60, got: ${health.qualityScore}`);

    // Check alert message contains key warning details
    const hasRemoteAlert = health.alerts.some(a => a.level === 'critical' && a.title.includes('tỉnh miền núi/vùng cao'));
    assert(hasRemoteAlert, 'Missing critical alert for remote provinces');

    // Check playbook
    assert(health.playbook.adsExclusions.recommendedProvinces.length > 0, 'Playbook missing ads exclusions');
    assert(health.playbook.contentAngles.guidelines.length > 0, 'Playbook missing content guidelines');
  });

  test('calculateAudienceHealth scores healthy medical page appropriately', () => {
    const mockDemo = {
      'F.25-34': 6000,
      'F.35-44': 4500,
      'F.45-54': 2000,
      'M.25-34': 1200
    };
    const mockCities = {
      'Hanoi, Vietnam': 12000,
      'Bac Ninh, Vietnam': 1500,
      'Hai Phong, Vietnam': 1200,
      'Son La, Vietnam': 400,
      'Dak Lak, Vietnam': 300
    };

    const health = calculateAudienceHealth({
      demographics: mockDemo,
      cities: mockCities,
      reachOrganic: 15000,
      reachPaid: 10000
    });

    assert(health.misalignmentPct <= 10, `Expected misalignment <= 10%, got: ${health.misalignmentPct}%`);
    assert.strictEqual(health.status, 'HEALTHY', `Expected HEALTHY status, got: ${health.status}`);
    assert(health.qualityScore >= 80, `Expected qualityScore >= 80, got: ${health.qualityScore}`);
    assert(health.corePct >= 70, `Expected corePct >= 70%, got: ${health.corePct}%`);
  });

  console.log('\n--- 3. API ENDPOINTS & HTTP ROUTING ---');

  const app = express();
  app.use(express.json());
  app.use('/api/pages', pageAnalyticsRouter);

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  await testAsync('GET /api/pages/list returns all pages across workspaces', async () => {
    const res = await axios.get(`${baseUrl}/api/pages/list`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert(res.data.pages.length >= 2, `Expected at least 2 pages, got: ${res.data.pages.length}`);

    const hasPhanThuy = res.data.pages.some(p => p.page_id === '245392165331140');
    assert(hasPhanThuy, 'Page list missing Phan Thuy');
  });

  await testAsync('GET /api/pages/list?workspaceId=2 filters specifically for Phan Thuy', async () => {
    const res = await axios.get(`${baseUrl}/api/pages/list?workspaceId=2`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert(res.data.pages.every(p => p.workspace_id === 2), 'Not all pages belong to workspace 2');

    const pt = res.data.pages.find(p => p.page_id === '245392165331140');
    assert(pt, 'Phan Thuy missing when filtered by workspace 2');
    assert(pt.quality_score < 60, `Phan Thuy quality_score should be < 60, got: ${pt.quality_score}`);
  });

  await testAsync('GET /api/pages/:pageId/insights returns full summary structure', async () => {
    const pageId = '245392165331140';
    const res = await axios.get(`${baseUrl}/api/pages/${pageId}/insights?workspaceId=2`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);

    const d = res.data.data;
    assert.strictEqual(d.page.page_id, pageId);
    assert.strictEqual(d.page.workspace_id, 2);

    // Summary KPIs
    assert(d.summary.fans_total > 0, 'fans_total must be > 0');
    assert(d.summary.reach_total > 0, 'reach_total must be > 0');
    assert(d.summary.reach_organic > 0, 'reach_organic must be > 0');
    assert(d.summary.reach_paid > 0, 'reach_paid must be > 0');
    assert(d.summary.organic_ratio_pct > 0, 'organic_ratio_pct must be > 0');
    assert(d.summary.female_pct > 0, 'female_pct must be > 0');

    // Demographics
    assert(d.demographics.ageGroups.length >= 4, 'demographics.ageGroups missing');
    assert(d.demographics.genderSummary.female > 50, 'female ratio should be > 50%');

    // Cities
    assert(d.cities.length >= 5, 'cities list should have at least 5 cities');
    assert(d.cities[0].name.includes('Hà Nội'), 'Hanoi should be top city');

    // Audience Health
    assert.strictEqual(d.audienceHealth.status, 'CRITICAL');
    assert(d.audienceHealth.misalignmentPct > 35, 'Phan Thuy misalignment should be > 35%');
    assert(d.audienceHealth.alerts.length > 0, 'alerts array should not be empty');
    assert(d.audienceHealth.playbook.adsExclusions.recommendedProvinces.length > 0, 'playbook should have ads exclusions');

    // Timeline
    assert(d.timeline.length >= 25, `Timeline should have >= 25 points, got: ${d.timeline.length}`);
  });

  await testAsync('POST /api/pages/:pageId/sync triggers sync and updates data', async () => {
    const pageId = '245392165331140';
    const res = await axios.post(`${baseUrl}/api/pages/${pageId}/sync`, { workspaceId: 2 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert(res.data.syncResult.syncedRows > 0, 'syncedRows should be > 0');
    assert(res.data.data.summary.fans_total > 0, 'fans_total must be > 0');
  });

  server.close();

  console.log('\n===============================================================');
  console.log(`=== TEST RUN COMPLETED: ${passed} PASSED, ${failed} FAILED ===`);
  console.log('===============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
