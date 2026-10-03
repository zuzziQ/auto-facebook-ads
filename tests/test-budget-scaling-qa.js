/**
 * Test Suite: Budget Scaling & Pause Ad System Verification
 * Verifies:
 * 1. Dynamic Workspace Token Resolution
 * 2. Lifetime Budget Protection
 * 3. ABO vs CBO Distinction & >= 25.000đ Floor
 * 4. Multi-level Scaling (+10%, +20%, -20%, -10%, Custom)
 * 5. Pause Ad & Pause AdSet
 */

const assert = require('assert');
const axios = require('axios');
const { db } = require('../src/db/database');
const { saveSecrets, loadSecrets } = require('../src/services/secretStore');
const {
  resolveAdsContext,
  executeBudgetChange,
  executePauseAd,
  executePauseAdset,
  MIN_DAILY_BUDGET,
  money
} = require('../src/services/facebookAdsBudget');

let totalPassed = 0;
let totalFailed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
    totalPassed++;
  } catch (e) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     Error: ${e.message}`);
    totalFailed++;
  }
}

console.log('\n===============================================================');
console.log('=== [BUDGET SCALING & PAUSE AD SYSTEM QA SUITE] ===');
console.log('===============================================================\n');

// Mock setup for tests
const TEST_WS_ID = 999;
const TEST_ACCOUNT_ID = 'act_test_budget_999';
const TEST_AD_ID_ABO = 'test_ad_abo_001';
const TEST_ADSET_ID_ABO = 'test_adset_abo_001';
const TEST_CAMPAIGN_ID_ABO = 'test_camp_abo_001';

const TEST_AD_ID_CBO = 'test_ad_cbo_002';
const TEST_ADSET_ID_CBO = 'test_adset_cbo_002';
const TEST_CAMPAIGN_ID_CBO = 'test_camp_cbo_002';

const TEST_AD_ID_LIFETIME = 'test_ad_lifetime_003';
const TEST_ADSET_ID_LIFETIME = 'test_adset_lifetime_003';

const TEST_AD_ID_CAMP_LIFETIME = 'test_ad_camplifetime_004';
const TEST_ADSET_ID_CAMP_LIFETIME = 'test_adset_camplifetime_004';
const TEST_CAMPAIGN_ID_CAMP_LIFETIME = 'test_camp_camplifetime_004';

function setupMockDatabase() {
  // Ensure workspace
  db.prepare(`
    INSERT OR REPLACE INTO workspaces(id, name, business_id, avatar_emoji, profile_color, ads_access_token, is_active)
    VALUES (?, 'Test Budget WS', 'biz_999', '🏢', '#38bdf8', 'TOKEN_WS_999_FALLBACK', 1)
  `).run(TEST_WS_ID);

  // Link ad account to workspace
  db.prepare(`
    INSERT OR REPLACE INTO workspace_ad_accounts(workspace_id, account_id, name, is_default)
    VALUES (?, ?, 'Test Account 999', 1)
  `).run(TEST_WS_ID, TEST_ACCOUNT_ID);

  // Configure secrets
  saveSecrets({
    [`WORKSPACE_${TEST_WS_ID}_ADS_TOKEN`]: 'SECRET_WORKSPACE_999_ADS_TOKEN'
  });

  // Mock ABO Ad Config
  db.prepare(`
    INSERT OR REPLACE INTO ad_config(ad_id, ad_name, account_id, adset_id, adset_name, campaign_id, campaign_name, adset_budget, campaign_budget, ad_status, adset_status, campaign_status)
    VALUES (?, 'ABO Ad Test', ?, ?, 'ABO Adset Test', ?, 'ABO Camp Test', 100000, 0, 'ACTIVE', 'ACTIVE', 'ACTIVE')
  `).run(TEST_AD_ID_ABO, TEST_ACCOUNT_ID, TEST_ADSET_ID_ABO, TEST_CAMPAIGN_ID_ABO);

  // Mock CBO Ad Config
  db.prepare(`
    INSERT OR REPLACE INTO ad_config(ad_id, ad_name, account_id, adset_id, adset_name, campaign_id, campaign_name, adset_budget, campaign_budget, ad_status, adset_status, campaign_status)
    VALUES (?, 'CBO Ad Test', ?, ?, 'CBO Adset Test', ?, 'CBO Camp Test', 0, 500000, 'ACTIVE', 'ACTIVE', 'ACTIVE')
  `).run(TEST_AD_ID_CBO, TEST_ACCOUNT_ID, TEST_ADSET_ID_CBO, TEST_CAMPAIGN_ID_CBO);

  // Mock Lifetime Budget Adset Ad Config
  db.prepare(`
    INSERT OR REPLACE INTO ad_config(ad_id, ad_name, account_id, adset_id, adset_name, campaign_id, campaign_name, adset_budget, campaign_budget, ad_status, adset_status, campaign_status)
    VALUES (?, 'Lifetime Ad Test', ?, ?, 'Lifetime Adset Test', ?, 'Lifetime Camp Test', 0, 0, 'ACTIVE', 'ACTIVE', 'ACTIVE')
  `).run(TEST_AD_ID_LIFETIME, TEST_ACCOUNT_ID, TEST_ADSET_ID_LIFETIME, 'test_camp_lifetime_003');

  // Mock Lifetime Budget Campaign Ad Config
  db.prepare(`
    INSERT OR REPLACE INTO ad_config(ad_id, ad_name, account_id, adset_id, adset_name, campaign_id, campaign_name, adset_budget, campaign_budget, ad_status, adset_status, campaign_status)
    VALUES (?, 'Camp Lifetime Ad Test', ?, ?, 'Camp Lifetime Adset Test', ?, 'Camp Lifetime Camp Test', 0, 0, 'ACTIVE', 'ACTIVE', 'ACTIVE')
  `).run(TEST_AD_ID_CAMP_LIFETIME, TEST_ACCOUNT_ID, TEST_ADSET_ID_CAMP_LIFETIME, TEST_CAMPAIGN_ID_CAMP_LIFETIME);
}

// Monkey-patch axios for Meta Graph API tests
const originalGet = axios.get;
const originalPost = axios.post;

const metaCalls = {
  get: [],
  post: []
};

function setupMetaAxiosMocks() {
  axios.get = async (url, opts) => {
    metaCalls.get.push({ url, opts });

    // Mock AdSet responses
    if (url.includes(`/${TEST_ADSET_ID_ABO}`)) {
      return {
        data: {
          id: TEST_ADSET_ID_ABO,
          name: 'ABO Adset Test',
          daily_budget: '100000',
          lifetime_budget: '0',
          status: 'ACTIVE',
          campaign_id: TEST_CAMPAIGN_ID_ABO
        }
      };
    }

    if (url.includes(`/${TEST_ADSET_ID_CBO}`)) {
      return {
        data: {
          id: TEST_ADSET_ID_CBO,
          name: 'CBO Adset Test',
          daily_budget: '0',
          lifetime_budget: '0',
          status: 'ACTIVE',
          campaign_id: TEST_CAMPAIGN_ID_CBO
        }
      };
    }

    if (url.includes(`/${TEST_ADSET_ID_LIFETIME}`)) {
      return {
        data: {
          id: TEST_ADSET_ID_LIFETIME,
          name: 'Lifetime Adset Test',
          daily_budget: '0',
          lifetime_budget: '5000000',
          status: 'ACTIVE',
          campaign_id: 'test_camp_lifetime_003'
        }
      };
    }

    if (url.includes(`/${TEST_ADSET_ID_CAMP_LIFETIME}`)) {
      return {
        data: {
          id: TEST_ADSET_ID_CAMP_LIFETIME,
          name: 'Camp Lifetime Adset Test',
          daily_budget: '0',
          lifetime_budget: '0',
          status: 'ACTIVE',
          campaign_id: TEST_CAMPAIGN_ID_CAMP_LIFETIME
        }
      };
    }

    // Mock Campaign responses
    if (url.includes(`/${TEST_CAMPAIGN_ID_CBO}`)) {
      return {
        data: {
          id: TEST_CAMPAIGN_ID_CBO,
          name: 'CBO Camp Test',
          daily_budget: '500000',
          lifetime_budget: '0',
          status: 'ACTIVE'
        }
      };
    }

    if (url.includes(`/${TEST_CAMPAIGN_ID_CAMP_LIFETIME}`)) {
      return {
        data: {
          id: TEST_CAMPAIGN_ID_CAMP_LIFETIME,
          name: 'Camp Lifetime Camp Test',
          daily_budget: '0',
          lifetime_budget: '20000000',
          status: 'ACTIVE'
        }
      };
    }

    return originalGet(url, opts);
  };

  axios.post = async (url, data, opts) => {
    metaCalls.post.push({ url, data, opts });
    return { data: { success: true } };
  };
}

function restoreAxios() {
  axios.get = originalGet;
  axios.post = originalPost;
}

async function runAllTests() {
  setupMockDatabase();
  setupMetaAxiosMocks();

  console.log('--- 1. DYNAMIC WORKSPACE TOKEN RESOLUTION ---');

  await test('Tự động phân giải Workspace Token từ adId khi không truyền workspaceId', () => {
    const context = resolveAdsContext({ adId: TEST_AD_ID_ABO });
    assert.strictEqual(context.workspaceId, TEST_WS_ID);
    assert.strictEqual(context.token, 'SECRET_WORKSPACE_999_ADS_TOKEN');
    assert.strictEqual(context.accountId, TEST_ACCOUNT_ID);
  });

  await test('Truyền workspaceId hợp lệ khớp với ad account -> Phân giải thành công', () => {
    const context = resolveAdsContext({ adId: TEST_AD_ID_ABO, workspaceId: TEST_WS_ID });
    assert.strictEqual(context.token, 'SECRET_WORKSPACE_999_ADS_TOKEN');
  });

  await test('Truyền workspaceId không sở hữu ad account -> Trả về lỗi 403', () => {
    try {
      resolveAdsContext({ adId: TEST_AD_ID_ABO, workspaceId: 888 });
      assert.fail('Phải ném lỗi 403');
    } catch (e) {
      assert.strictEqual(e.statusCode, 403);
      assert(e.message.includes('Quảng cáo không thuộc doanh nghiệp đang chọn'));
    }
  });

  await test('Workspace chưa có Ads Token -> Trả về lỗi 400 rõ ràng', () => {
    db.prepare(`INSERT OR REPLACE INTO workspaces(id, name, is_active) VALUES (777, 'Empty Token WS', 1)`).run();
    db.prepare(`INSERT OR REPLACE INTO workspace_ad_accounts(workspace_id, account_id, name) VALUES (777, 'act_777', 'Acc 777')`).run();
    db.prepare(`INSERT OR REPLACE INTO ad_config(ad_id, account_id) VALUES ('ad_777', 'act_777')`).run();

    try {
      resolveAdsContext({ adId: 'ad_777' });
      assert.fail('Phải ném lỗi 400');
    } catch (e) {
      assert.strictEqual(e.statusCode, 400);
      assert(e.message.includes('chưa có Ads/System User Token'));
    }
  });

  console.log('\n--- 2. LIFETIME BUDGET PROTECTION ---');

  await test('AdSet sử dụng Lifetime Budget -> Chặn đổi daily_budget và báo lỗi chính xác', async () => {
    try {
      await executeBudgetChange({ adId: TEST_AD_ID_LIFETIME, percent: 20 });
      assert.fail('Phải ném lỗi Lifetime Budget');
    } catch (e) {
      assert.strictEqual(e.statusCode, 400);
      assert(e.message.includes('Quảng cáo đang sử dụng Ngân sách trọn đời (Lifetime Budget: 5.000.000₫)'));
      assert(e.message.includes('không thể điều chỉnh tăng/giảm theo % ngày'));
    }
  });

  await test('Campaign CBO sử dụng Lifetime Budget -> Chặn đổi daily_budget và báo lỗi chính xác', async () => {
    try {
      await executeBudgetChange({ adId: TEST_AD_ID_CAMP_LIFETIME, percent: 10 });
      assert.fail('Phải ném lỗi Lifetime Budget ở cấp Campaign');
    } catch (e) {
      assert.strictEqual(e.statusCode, 400);
      assert(e.message.includes('Quảng cáo đang sử dụng Ngân sách trọn đời (Lifetime Budget: 20.000.000₫)'));
      assert(e.message.includes('không thể điều chỉnh tăng/giảm theo % ngày'));
    }
  });

  console.log('\n--- 3. CBO VS ABO & FLOOR BUDGET (>= 25.000₫) ---');

  await test('ABO AdSet: Scale +20% cập nhật đúng daily_budget của AdSet trên Meta & SQLite DB', async () => {
    metaCalls.post = [];
    const res = await executeBudgetChange({ adId: TEST_AD_ID_ABO, percent: 20 });
    assert.strictEqual(res.level, 'Adset');
    assert.strictEqual(res.targetId, TEST_ADSET_ID_ABO);
    assert.strictEqual(res.oldBudget, 100000);
    assert.strictEqual(res.newBudget, 120000);
    assert.strictEqual(res.percent, 20);

    // Check Meta API post call
    const lastMetaPost = metaCalls.post.find(c => c.url.includes(TEST_ADSET_ID_ABO));
    assert(lastMetaPost, 'Phải có Meta POST request tới AdSet');
    assert.strictEqual(lastMetaPost.data.daily_budget, 120000);
    assert.strictEqual(lastMetaPost.data.access_token, 'SECRET_WORKSPACE_999_ADS_TOKEN');

    // Check SQLite DB
    const dbRow = db.prepare('SELECT adset_budget, budget_trend FROM ad_config WHERE ad_id = ?').get(TEST_AD_ID_ABO);
    assert.strictEqual(Number(dbRow.adset_budget), 120000);
    assert.strictEqual(dbRow.budget_trend, 'UP');
  });

  await test('CBO Campaign: Scale +10% cập nhật đúng daily_budget của Campaign trên Meta & SQLite DB', async () => {
    metaCalls.post = [];
    const res = await executeBudgetChange({ adId: TEST_AD_ID_CBO, percent: 10 });
    assert.strictEqual(res.level, 'Campaign');
    assert.strictEqual(res.targetId, TEST_CAMPAIGN_ID_CBO);
    assert.strictEqual(res.oldBudget, 500000);
    assert.strictEqual(res.newBudget, 550000);
    assert.strictEqual(res.percent, 10);

    // Check Meta API post call
    const lastMetaPost = metaCalls.post.find(c => c.url.includes(TEST_CAMPAIGN_ID_CBO));
    assert(lastMetaPost, 'Phải có Meta POST request tới Campaign');
    assert.strictEqual(lastMetaPost.data.daily_budget, 550000);
    assert.strictEqual(lastMetaPost.data.access_token, 'SECRET_WORKSPACE_999_ADS_TOKEN');

    // Check SQLite DB
    const dbRow = db.prepare('SELECT campaign_budget, budget_trend FROM ad_config WHERE ad_id = ?').get(TEST_AD_ID_CBO);
    assert.strictEqual(Number(dbRow.campaign_budget), 550000);
    assert.strictEqual(dbRow.budget_trend, 'UP');
  });

  await test('Ngân sách tối thiểu >= 25.000₫: Giảm sâu không được dưới 25.000₫', async () => {
    // Current adset budget is 100000 from mock, scale -90% -> 10000 -> must clamp to 25000
    const res = await executeBudgetChange({ adId: TEST_AD_ID_ABO, percent: -90 });
    assert.strictEqual(res.newBudget, 25000);
    assert.strictEqual(MIN_DAILY_BUDGET, 25000);
  });

  console.log('\n--- 4. MULTI-LEVEL SCALE (+10%, +20%, -20%, -10%, CUSTOM, NEW_BUDGET) ---');

  await test('Hỗ trợ đầy đủ các mức Scale: +10%', async () => {
    const res = await executeBudgetChange({ adId: TEST_AD_ID_ABO, percent: 10 });
    assert.strictEqual(res.percent, 10);
    assert.strictEqual(res.newBudget, 110000);
  });

  await test('Hỗ trợ đầy đủ các mức Scale: -10%', async () => {
    const res = await executeBudgetChange({ adId: TEST_AD_ID_ABO, percent: -10 });
    assert.strictEqual(res.percent, -10);
    assert.strictEqual(res.newBudget, 90000);
  });

  await test('Hỗ trợ đầy đủ các mức Scale: -20%', async () => {
    const res = await executeBudgetChange({ adId: TEST_AD_ID_ABO, percent: -20 });
    assert.strictEqual(res.percent, -20);
    assert.strictEqual(res.newBudget, 80000);
  });

  await test('Hỗ trợ mức scale tùy chỉnh (Custom newBudget = 250.000₫)', async () => {
    const res = await executeBudgetChange({ adId: TEST_AD_ID_ABO, newBudget: 250000 });
    assert.strictEqual(res.newBudget, 250000);
  });

  console.log('\n--- 5. PAUSE AD & PAUSE ADSET ---');

  await test('Pause Ad: Gửi PAUSED lên Meta với đúng workspace token và cập nhật DB ad_status = PAUSED', async () => {
    metaCalls.post = [];
    const res = await executePauseAd({ adId: TEST_AD_ID_ABO });
    assert.strictEqual(res.success, true);

    const postCall = metaCalls.post.find(c => c.url.includes(TEST_AD_ID_ABO));
    assert(postCall, 'Phải có POST request pause ad');
    assert.strictEqual(postCall.data.status, 'PAUSED');
    assert.strictEqual(postCall.data.access_token, 'SECRET_WORKSPACE_999_ADS_TOKEN');

    const row = db.prepare('SELECT ad_status, budget_trend FROM ad_config WHERE ad_id = ?').get(TEST_AD_ID_ABO);
    assert.strictEqual(row.ad_status, 'PAUSED');
    assert.strictEqual(row.budget_trend, 'PAUSE');
  });

  await test('Pause AdSet: Gửi PAUSED lên Meta với đúng workspace token và cập nhật DB adset_status = PAUSED', async () => {
    metaCalls.post = [];
    const res = await executePauseAdset({ adsetId: TEST_ADSET_ID_ABO, adId: TEST_AD_ID_ABO });
    assert.strictEqual(res.success, true);

    const postCall = metaCalls.post.find(c => c.url.includes(TEST_ADSET_ID_ABO));
    assert(postCall, 'Phải có POST request pause adset');
    assert.strictEqual(postCall.data.status, 'PAUSED');
    assert.strictEqual(postCall.data.access_token, 'SECRET_WORKSPACE_999_ADS_TOKEN');

    const row = db.prepare('SELECT adset_status, budget_trend FROM ad_config WHERE adset_id = ?').get(TEST_ADSET_ID_ABO);
    assert.strictEqual(row.adset_status, 'PAUSED');
    assert.strictEqual(row.budget_trend, 'PAUSE');
  });

  restoreAxios();

  // Cleanup mock test data
  db.prepare("DELETE FROM ad_config WHERE ad_id LIKE 'test_ad_%'").run();
  db.prepare('DELETE FROM workspace_ad_accounts WHERE workspace_id IN (?, 777, 888)').run(TEST_WS_ID);
  db.prepare('DELETE FROM workspaces WHERE id IN (?, 777, 888)').run(TEST_WS_ID);

  console.log('\n===============================================================');
  console.log(`=== SUMMARY: ${totalPassed} PASSED, ${totalFailed} FAILED ===`);
  console.log('===============================================================\n');

  if (totalFailed > 0) process.exit(1);
}

runAllTests().catch(err => {
  console.error('Test Suite Unhandled Exception:', err);
  process.exit(1);
});
