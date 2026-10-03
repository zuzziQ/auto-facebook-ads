/**
 * QA Test Suite for POST /api/ads/execute-action & facebookAdsBudget.js
 * 
 * Verifies:
 * 1. resolveAdsContext dynamic resolution for all action types
 * 2. DUPLICATE_ADSET with daily_budget & lifetime_budget + start_time/end_time + SQLite DB persistence
 * 3. CREATE_VARIANT with full spec fetch fallback + link/video/photo/text spec editing + Page post fallback + SQLite DB persistence
 * 4. SCALE_BUDGET, INCREASE_BUDGET, DECREASE_BUDGET with ABO/CBO + Lifetime Budget protection + 25.000d floor
 * 5. PAUSE_AD & PAUSE_ADSET with Meta call + SQLite DB status update
 */

const assert = require('assert');
const axios = require('axios');
const http = require('http');
const express = require('express');
const { db, stmts } = require('../src/db/database');
const { saveSecrets } = require('../src/services/secretStore');
const {
  resolveAdsContext,
  executeBudgetChange,
  executePauseAd,
  executePauseAdset,
  MIN_DAILY_BUDGET
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
    if (e.stack) console.error(`     Stack: ${e.stack.split('\n')[1]}`);
    totalFailed++;
  }
}

console.log('\n===============================================================');
console.log('=== [POST /api/ads/execute-action & BACKEND META API QA SUITE] ===');
console.log('===============================================================\n');

// Mock IDs
const TEST_WS_ID = 888;
const TEST_ACCOUNT_ID = 'act_888999111';
const TEST_AD_ID_ABO = 'test_ad_abo_101';
const TEST_ADSET_ID_ABO = 'test_adset_abo_101';
const TEST_CAMPAIGN_ID = 'test_camp_101';

const TEST_AD_ID_LIFETIME = 'test_ad_lifetime_102';
const TEST_ADSET_ID_LIFETIME = 'test_adset_lifetime_102';

const TEST_AD_ID_SPEC_FALLBACK = 'test_ad_fallback_103';
const TEST_CREATIVE_ID_PARTIAL = 'cr_partial_103';

const TEST_AD_ID_PHOTO = 'test_ad_photo_104';
const TEST_CREATIVE_ID_PHOTO = 'cr_photo_104';

const TEST_AD_ID_PAGE_POST = 'test_ad_pagepost_105';
const TEST_CREATIVE_ID_PAGE_POST = 'cr_pagepost_105';

function setupTestDatabase() {
  // Setup workspace
  db.prepare(`
    INSERT OR REPLACE INTO workspaces(id, name, business_id, avatar_emoji, profile_color, ads_access_token, is_active)
    VALUES (?, 'QA Workspace 888', 'biz_888', '🧪', '#10b981', 'WS_888_FALLBACK_TOKEN', 1)
  `).run(TEST_WS_ID);

  // Link account
  db.prepare(`
    INSERT OR REPLACE INTO workspace_ad_accounts(workspace_id, account_id, name, is_default)
    VALUES (?, ?, 'QA Account 888', 1)
  `).run(TEST_WS_ID, TEST_ACCOUNT_ID);

  // Secrets
  saveSecrets({
    [`WORKSPACE_${TEST_WS_ID}_ADS_TOKEN`]: 'SECRET_QA_888_ADS_TOKEN'
  });

  // ABO Ad
  stmts.upsertAdConfig.run({
    ad_id: TEST_AD_ID_ABO,
    account_id: TEST_ACCOUNT_ID,
    campaign_id: TEST_CAMPAIGN_ID,
    campaign_name: 'QA Campaign 101',
    campaign_status: 'ACTIVE',
    campaign_start_time: '2026-01-01T00:00:00Z',
    campaign_budget: '0',
    adset_id: TEST_ADSET_ID_ABO,
    adset_name: 'QA ABO AdSet 101',
    adset_status: 'ACTIVE',
    adset_start_time: '2026-01-01T00:00:00Z',
    adset_budget: '150000',
    ad_name: 'QA ABO Ad 101',
    ad_status: 'ACTIVE',
    created_time: '2026-01-01T00:00:00Z',
    post_url: null,
    targeting: JSON.stringify({ geo_locations: { countries: ['VN'] }, age_min: 25, age_max: 45 })
  });

  const { insertAdCreative } = require('../src/db/database');
  insertAdCreative({
    ad_id: TEST_AD_ID_ABO,
    thumbnail_url: 'https://cdn.fb.com/thumb_abo.jpg',
    video_url: null,
    body_text: 'Nội dung bài viết ABO gốc',
    image_hash: 'hash_abo_101',
    video_id: null,
    body_hash: 'bodyhash_abo_101'
  });

  // Lifetime Budget Ad
  stmts.upsertAdConfig.run({
    ad_id: TEST_AD_ID_LIFETIME,
    account_id: TEST_ACCOUNT_ID,
    campaign_id: TEST_CAMPAIGN_ID,
    campaign_name: 'QA Campaign 101',
    campaign_status: 'ACTIVE',
    campaign_start_time: '2026-01-01T00:00:00Z',
    campaign_budget: '0',
    adset_id: TEST_ADSET_ID_LIFETIME,
    adset_name: 'QA Lifetime AdSet 102',
    adset_status: 'ACTIVE',
    adset_start_time: '2026-01-01T00:00:00Z',
    adset_budget: '5000000',
    ad_name: 'QA Lifetime Ad 102',
    ad_status: 'ACTIVE',
    created_time: '2026-01-01T00:00:00Z',
    post_url: null,
    targeting: JSON.stringify({ geo_locations: { countries: ['VN'] } })
  });

  insertAdCreative({
    ad_id: TEST_AD_ID_LIFETIME,
    thumbnail_url: 'https://cdn.fb.com/thumb_lifetime.jpg',
    video_url: null,
    body_text: 'Nội dung bài viết Lifetime gốc',
    image_hash: 'hash_lifetime_102',
    video_id: null,
    body_hash: 'bodyhash_lifetime_102'
  });

  // Partial spec ad
  stmts.upsertAdConfig.run({
    ad_id: TEST_AD_ID_SPEC_FALLBACK,
    account_id: TEST_ACCOUNT_ID,
    campaign_id: TEST_CAMPAIGN_ID,
    campaign_name: 'QA Campaign 101',
    campaign_status: 'ACTIVE',
    campaign_start_time: '2026-01-01T00:00:00Z',
    campaign_budget: '0',
    adset_id: TEST_ADSET_ID_ABO,
    adset_name: 'QA ABO AdSet 101',
    adset_status: 'ACTIVE',
    adset_start_time: '2026-01-01T00:00:00Z',
    adset_budget: '150000',
    ad_name: 'QA Spec Fallback Ad 103',
    ad_status: 'ACTIVE',
    created_time: '2026-01-01T00:00:00Z',
    post_url: null,
    targeting: null
  });

  // Photo spec ad
  stmts.upsertAdConfig.run({
    ad_id: TEST_AD_ID_PHOTO,
    account_id: TEST_ACCOUNT_ID,
    campaign_id: TEST_CAMPAIGN_ID,
    campaign_name: 'QA Campaign 101',
    campaign_status: 'ACTIVE',
    campaign_start_time: '2026-01-01T00:00:00Z',
    campaign_budget: '0',
    adset_id: TEST_ADSET_ID_ABO,
    adset_name: 'QA ABO AdSet 101',
    adset_status: 'ACTIVE',
    adset_start_time: '2026-01-01T00:00:00Z',
    adset_budget: '150000',
    ad_name: 'QA Photo Ad 104',
    ad_status: 'ACTIVE',
    created_time: '2026-01-01T00:00:00Z',
    post_url: null,
    targeting: null
  });

  // Page Post ad
  stmts.upsertAdConfig.run({
    ad_id: TEST_AD_ID_PAGE_POST,
    account_id: TEST_ACCOUNT_ID,
    campaign_id: TEST_CAMPAIGN_ID,
    campaign_name: 'QA Campaign 101',
    campaign_status: 'ACTIVE',
    campaign_start_time: '2026-01-01T00:00:00Z',
    campaign_budget: '0',
    adset_id: TEST_ADSET_ID_ABO,
    adset_name: 'QA ABO AdSet 101',
    adset_status: 'ACTIVE',
    adset_start_time: '2026-01-01T00:00:00Z',
    adset_budget: '150000',
    ad_name: 'QA Page Post Ad 105',
    ad_status: 'ACTIVE',
    created_time: '2026-01-01T00:00:00Z',
    post_url: null,
    targeting: null
  });
}

// Meta API Mocks
const originalGet = axios.get;
const originalPost = axios.post;

const metaCalls = {
  get: [],
  post: []
};

let nextGeneratedId = 900001;

function setupMetaAxiosMocks() {
  axios.get = async (url, opts) => {
    if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) {
      return originalGet(url, opts);
    }
    metaCalls.get.push({ url, opts });

    // AdSet ABO details
    if (url.includes(`/${TEST_ADSET_ID_ABO}`)) {
      return {
        data: {
          id: TEST_ADSET_ID_ABO,
          name: 'QA ABO AdSet 101',
          daily_budget: '150000',
          lifetime_budget: '0',
          bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
          billing_event: 'IMPRESSIONS',
          optimization_goal: 'REPLIES',
          campaign_id: TEST_CAMPAIGN_ID,
          account_id: TEST_ACCOUNT_ID,
          targeting: { geo_locations: { countries: ['VN'] }, age_min: 25, age_max: 45 },
          promoted_object: { page_id: 'page_123' },
          destination_type: 'MESSENGER'
        }
      };
    }

    // AdSet Lifetime details
    if (url.includes(`/${TEST_ADSET_ID_LIFETIME}`)) {
      return {
        data: {
          id: TEST_ADSET_ID_LIFETIME,
          name: 'QA Lifetime AdSet 102',
          daily_budget: '0',
          lifetime_budget: '5000000',
          start_time: '2026-01-01T00:00:00Z',
          end_time: '2026-01-08T00:00:00Z',
          campaign_id: TEST_CAMPAIGN_ID,
          account_id: TEST_ACCOUNT_ID,
          targeting: { geo_locations: { countries: ['VN'] } }
        }
      };
    }

    // Ad ABO details
    if (url.includes(`/${TEST_AD_ID_ABO}`)) {
      return {
        data: {
          id: TEST_AD_ID_ABO,
          name: 'QA ABO Ad 101',
          adset_id: TEST_ADSET_ID_ABO,
          campaign_id: TEST_CAMPAIGN_ID,
          account_id: TEST_ACCOUNT_ID,
          creative: {
            id: 'cr_abo_101',
            name: 'Creative ABO 101',
            body: 'Nội dung bài viết ABO gốc',
            object_story_spec: {
              page_id: 'page_123',
              link_data: {
                message: 'Nội dung bài viết ABO gốc',
                link: 'https://fb.com/page_123',
                picture: 'https://cdn.fb.com/thumb_abo.jpg'
              }
            }
          }
        }
      };
    }

    // Ad Lifetime details
    if (url.includes(`/${TEST_AD_ID_LIFETIME}`)) {
      return {
        data: {
          id: TEST_AD_ID_LIFETIME,
          name: 'QA Lifetime Ad 102',
          adset_id: TEST_ADSET_ID_LIFETIME,
          campaign_id: TEST_CAMPAIGN_ID,
          account_id: TEST_ACCOUNT_ID,
          creative: {
            id: 'cr_lifetime_102',
            name: 'Creative Lifetime 102',
            body: 'Nội dung bài viết Lifetime gốc'
          }
        }
      };
    }

    // Ad Fallback details (returns creative with ONLY ID, no object_story_spec)
    if (url.includes(`/${TEST_AD_ID_SPEC_FALLBACK}`)) {
      return {
        data: {
          id: TEST_AD_ID_SPEC_FALLBACK,
          name: 'QA Spec Fallback Ad 103',
          adset_id: TEST_ADSET_ID_ABO,
          campaign_id: TEST_CAMPAIGN_ID,
          account_id: TEST_ACCOUNT_ID,
          creative: {
            id: TEST_CREATIVE_ID_PARTIAL
          }
        }
      };
    }

    // Direct Creative query for partial creative
    if (url.includes(`/${TEST_CREATIVE_ID_PARTIAL}`)) {
      return {
        data: {
          id: TEST_CREATIVE_ID_PARTIAL,
          name: 'Full Creative 103',
          body: 'Nội dung từ query creative riêng biệt',
          object_story_spec: {
            page_id: 'page_123',
            video_data: {
              video_id: 'vid_999',
              message: 'Nội dung video gốc',
              image_url: 'https://cdn.fb.com/video_thumb.jpg'
            }
          }
        }
      };
    }

    // Ad Photo details
    if (url.includes(`/${TEST_AD_ID_PHOTO}`)) {
      return {
        data: {
          id: TEST_AD_ID_PHOTO,
          name: 'QA Photo Ad 104',
          adset_id: TEST_ADSET_ID_ABO,
          campaign_id: TEST_CAMPAIGN_ID,
          account_id: TEST_ACCOUNT_ID,
          creative: {
            id: TEST_CREATIVE_ID_PHOTO,
            name: 'Creative Photo 104',
            object_story_spec: {
              page_id: 'page_123',
              photo_data: {
                caption: 'Caption ảnh gốc',
                image_hash: 'img_hash_photo_104'
              }
            }
          }
        }
      };
    }

    // Ad Page Post details (no object_story_spec)
    if (url.includes(`/${TEST_AD_ID_PAGE_POST}`)) {
      return {
        data: {
          id: TEST_AD_ID_PAGE_POST,
          name: 'QA Page Post Ad 105',
          adset_id: TEST_ADSET_ID_ABO,
          campaign_id: TEST_CAMPAIGN_ID,
          account_id: TEST_ACCOUNT_ID,
          creative: {
            id: TEST_CREATIVE_ID_PAGE_POST,
            name: 'Creative Page Post 105',
            effective_object_story_id: 'page_123_post_999',
            body: 'Bài viết fanpage gốc'
          }
        }
      };
    }

    if (url.includes(`/${TEST_CREATIVE_ID_PAGE_POST}`)) {
      return {
        data: {
          id: TEST_CREATIVE_ID_PAGE_POST,
          name: 'Creative Page Post 105',
          effective_object_story_id: 'page_123_post_999',
          body: 'Bài viết fanpage gốc'
        }
      };
    }

    return originalGet(url, opts);
  };

  axios.post = async (url, data, opts) => {
    if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) {
      return originalPost(url, data, opts);
    }
    metaCalls.post.push({ url, data, opts });
    const generatedId = `meta_gen_${nextGeneratedId++}`;
    return {
      data: {
        id: generatedId,
        success: true
      }
    };
  };
}

async function runTests() {
  setupTestDatabase();
  setupMetaAxiosMocks();

  const app = express();
  app.use(express.json());

  const { config } = require('../src/config');
  const logger = require('../src/utils/logger');

  const server = http.createServer(app);
  
  app.post('/api/ads/execute-action', async (req, res) => {
    try {
      const { action } = req.body;
      if (!action || !action.type) {
        return res.status(400).json({ success: false, error: 'Missing action.type' });
      }

      const {
        executeBudgetChange,
        executePauseAd,
        executePauseAdset,
        resolveAdsContext
      } = require('../src/services/facebookAdsBudget');
      const { db, stmts, insertAdCreative } = require('../src/db/database');

      const targetId = action.targetId || action.id || action.adId;
      if (!targetId && action.type !== 'CHANGE_TARGETING') {
        return res.status(400).json({ success: false, error: 'Missing targetId in action' });
      }

      const accountIdParam = action.adAccountId || action.accountId || req.body.adAccountId || req.body.accountId;
      const workspaceIdParam = req.body.workspaceId;

      let context = null;
      let token = null;
      let apiVersion = config.facebook?.apiVersion || 'v21.0';
      let BASE = `https://graph.facebook.com/${apiVersion}`;

      if (targetId) {
        context = resolveAdsContext({
          adId: targetId,
          accountId: accountIdParam,
          workspaceId: workspaceIdParam
        });
        token = context.token;
        apiVersion = context.apiVersion || apiVersion;
        BASE = `https://graph.facebook.com/${apiVersion}`;
      }

      let result = {};

      if (action.type === 'PAUSE_AD') {
        result = await executePauseAd({
          adId: targetId,
          workspaceId: workspaceIdParam,
          accountId: accountIdParam
        });
      } else if (action.type === 'PAUSE_ADSET') {
        result = await executePauseAdset({
          adsetId: targetId,
          adId: targetId,
          workspaceId: workspaceIdParam,
          accountId: accountIdParam
        });
      } else if (
        action.type === 'SCALE_BUDGET' ||
        action.type === 'INCREASE_BUDGET' ||
        action.type === 'DECREASE_BUDGET'
      ) {
        let percent = action.parameters?.percent;
        let newBudget = action.parameters?.newBudget;

        if (percent === undefined && newBudget === undefined && action.value) {
          const valStr = String(action.value).trim();
          if (valStr.includes('%')) {
            percent = parseFloat(valStr.replace('%', '').replace('+', ''));
          } else if (!isNaN(parseFloat(valStr.replace(/[^\d.-]/g, '')))) {
            const num = parseFloat(valStr.replace(/[^\d.-]/g, ''));
            if (num > 1000) newBudget = num;
            else percent = num;
          }
        }

        if (action.type === 'INCREASE_BUDGET' && percent === undefined && newBudget === undefined) percent = 20;
        if (action.type === 'DECREASE_BUDGET' && percent === undefined && newBudget === undefined) percent = -20;

        result = await executeBudgetChange({
          adId: targetId,
          targetId: targetId,
          newBudget,
          percent,
          workspaceId: workspaceIdParam,
          accountId: accountIdParam
        });
      } else if (action.type === 'DUPLICATE_ADSET') {
        let adRow = db.prepare(`
          SELECT c.ad_id, c.adset_id, c.campaign_id, c.account_id,
                 c.ad_name, c.adset_name, c.campaign_name, c.campaign_status,
                 c.campaign_start_time, c.campaign_budget, c.adset_budget,
                 c.targeting, c.post_url,
                 cr.video_id, cr.thumbnail_url, cr.body_text, cr.image_hash
          FROM ad_config c
          LEFT JOIN ad_creatives cr ON cr.ad_id = c.ad_id
          WHERE c.ad_id = ?
        `).get(context.cleanId);

        if (!adRow) {
          adRow = db.prepare(`
            SELECT c.ad_id, c.adset_id, c.campaign_id, c.account_id,
                   c.ad_name, c.adset_name, c.campaign_name, c.campaign_status,
                   c.campaign_start_time, c.campaign_budget, c.adset_budget,
                   c.targeting, c.post_url,
                   cr.video_id, cr.thumbnail_url, cr.body_text, cr.image_hash
            FROM ad_config c
            LEFT JOIN ad_creatives cr ON cr.ad_id = c.ad_id
            WHERE c.adset_id = ?
            LIMIT 1
          `).get(context.cleanId);
        }

        const origAdsetId = adRow?.adset_id || (context.cleanId !== adRow?.campaign_id ? context.cleanId : null);
        if (!origAdsetId) {
          return res.status(404).json({ success: false, error: 'Không tìm thấy AdSet ID để nhân bản' });
        }

        const adsetRes = await axios.get(`${BASE}/${origAdsetId}`, {
          params: {
            fields: 'id,name,daily_budget,lifetime_budget,bid_strategy,billing_event,optimization_goal,targeting,start_time,end_time,promoted_object,destination_type,campaign_id,account_id',
            access_token: token
          }
        });
        const adsetData = adsetRes.data;

        let accountId = context.accountId || adRow?.account_id || adsetData.account_id;
        if (accountId && !accountId.startsWith('act_')) accountId = 'act_' + accountId;
        const campaignId = adRow?.campaign_id || adsetData.campaign_id;

        if (!accountId) return res.status(400).json({ success: false, error: 'Không tìm thấy Ad Account ID của AdSet' });
        if (!campaignId) return res.status(400).json({ success: false, error: 'Không tìm thấy Campaign ID của AdSet' });

        const newAdsetName = `${adsetData.name || adRow?.adset_name || 'AdSet'} - Copy`;
        const newAdsetPayload = {
          name: newAdsetName,
          campaign_id: campaignId,
          billing_event: adsetData.billing_event || 'IMPRESSIONS',
          optimization_goal: adsetData.optimization_goal || 'REPLIES',
          status: 'PAUSED',
          access_token: token
        };

        if (adsetData.targeting) {
          newAdsetPayload.targeting = typeof adsetData.targeting === 'object' ? JSON.stringify(adsetData.targeting) : adsetData.targeting;
        } else if (adRow?.targeting) {
          newAdsetPayload.targeting = typeof adRow.targeting === 'string' ? adRow.targeting : JSON.stringify(adRow.targeting);
        }

        const now = Date.now();
        if (adsetData.lifetime_budget && Number(adsetData.lifetime_budget) > 0) {
          newAdsetPayload.lifetime_budget = adsetData.lifetime_budget;
          let durationMs = 7 * 24 * 60 * 60 * 1000;
          if (adsetData.start_time && adsetData.end_time) {
            const origStart = new Date(adsetData.start_time).getTime();
            const origEnd = new Date(adsetData.end_time).getTime();
            if (origEnd > origStart) durationMs = Math.max(86400000, origEnd - origStart);
          }
          const startTimeDate = new Date(now + 120000);
          const endTimeDate = new Date(startTimeDate.getTime() + durationMs);
          newAdsetPayload.start_time = startTimeDate.toISOString();
          newAdsetPayload.end_time = endTimeDate.toISOString();
        } else if (adsetData.daily_budget && Number(adsetData.daily_budget) > 0) {
          newAdsetPayload.daily_budget = adsetData.daily_budget;
          if (adsetData.end_time && new Date(adsetData.end_time).getTime() > now) {
            newAdsetPayload.end_time = adsetData.end_time;
          }
        }

        if (adsetData.bid_strategy) newAdsetPayload.bid_strategy = adsetData.bid_strategy;
        if (adsetData.promoted_object) newAdsetPayload.promoted_object = typeof adsetData.promoted_object === 'object' ? JSON.stringify(adsetData.promoted_object) : adsetData.promoted_object;
        if (adsetData.destination_type) newAdsetPayload.destination_type = adsetData.destination_type;

        const newAdsetRes = await axios.post(`${BASE}/${accountId}/adsets`, newAdsetPayload);
        const newAdsetId = newAdsetRes.data.id;

        let origAdId = adRow?.ad_id;
        let origCreative = null;
        let adName = adRow?.ad_name || adsetData.name || 'Ad';

        if (!origAdId) {
          try {
            const listAdsRes = await axios.get(`${BASE}/${origAdsetId}/ads`, {
              params: { fields: 'id,name,creative{id,name,object_story_spec,effective_object_story_id,thumbnail_url,image_url,video_id,body}', limit: 1, access_token: token }
            });
            if (listAdsRes.data.data && listAdsRes.data.data.length > 0) {
              origAdId = listAdsRes.data.data[0].id;
              adName = listAdsRes.data.data[0].name;
              origCreative = listAdsRes.data.data[0].creative;
            }
          } catch (listErr) {}
        }

        if (origAdId && !origCreative) {
          try {
            const origAdRes = await axios.get(`${BASE}/${origAdId}`, {
              params: { fields: 'id,name,creative{id,name,object_story_spec,effective_object_story_id,thumbnail_url,image_url,video_id,body}', access_token: token }
            });
            adName = origAdRes.data.name || adName;
            origCreative = origAdRes.data.creative;
          } catch (adErr) {}
        }

        let newAdId = null;
        const newAdName = `${adName} - Copy`;

        if (origCreative?.id) {
          const newAdRes = await axios.post(`${BASE}/${accountId}/ads`, {
            name: newAdName,
            adset_id: newAdsetId,
            creative: JSON.stringify({ creative_id: origCreative.id }),
            status: 'PAUSED',
            access_token: token
          });
          newAdId = newAdRes.data.id;
        }

        if (newAdId) {
          const adsetBudgetVal = String(newAdsetPayload.daily_budget || newAdsetPayload.lifetime_budget || adsetData.daily_budget || adsetData.lifetime_budget || '0');
          const targetingVal = newAdsetPayload.targeting || (adRow?.targeting ? (typeof adRow.targeting === 'string' ? adRow.targeting : JSON.stringify(adRow.targeting)) : null);

          stmts.upsertAdConfig.run({
            ad_id: newAdId,
            account_id: accountId,
            campaign_id: campaignId || '',
            campaign_name: adRow?.campaign_name || '',
            campaign_status: adRow?.campaign_status || 'ACTIVE',
            campaign_start_time: adRow?.campaign_start_time || '',
            campaign_budget: adRow?.campaign_budget || '0',
            adset_id: newAdsetId,
            adset_name: newAdsetName,
            adset_status: 'PAUSED',
            adset_start_time: newAdsetPayload.start_time || new Date().toISOString(),
            adset_budget: adsetBudgetVal,
            ad_name: newAdName,
            ad_status: 'PAUSED',
            created_time: new Date().toISOString(),
            post_url: adRow?.post_url || null,
            targeting: targetingVal
          });

          const crypto = require('crypto');
          const thumbUrl = adRow?.thumbnail_url || origCreative?.image_url || origCreative?.thumbnail_url || null;
          const bodyText = adRow?.body_text || origCreative?.body || '';
          const imageHash = adRow?.image_hash || '';
          const videoId = adRow?.video_id || origCreative?.video_id || null;
          const bodyHash = bodyText ? crypto.createHash('md5').update(bodyText).digest('hex') : '';

          if (insertAdCreative) {
            insertAdCreative({
              ad_id: newAdId,
              thumbnail_url: thumbUrl,
              video_url: null,
              body_text: bodyText,
              image_hash: imageHash,
              video_id: videoId,
              body_hash: bodyHash
            });
          }
        }

        result = {
          new_adset_id: newAdsetId,
          new_ad_id: newAdId,
          adset_name: newAdsetName,
          ad_name: newAdName,
          status: 'PAUSED',
          message: `Đã nhân AdSet thành công (trạng thái: Tạm dừng, cần bật thủ công)`
        };
      } else if (action.type === 'CREATE_VARIANT') {
        let adRow = db.prepare(`
          SELECT c.ad_id, c.adset_id, c.campaign_id, c.account_id, c.ad_name,
                 c.adset_name, c.campaign_name, c.campaign_status, c.campaign_start_time,
                 c.campaign_budget, c.adset_status, c.adset_start_time, c.adset_budget,
                 c.targeting, c.post_url,
                 cr.video_id, cr.thumbnail_url, cr.body_text, cr.image_hash
        FROM ad_config c
        LEFT JOIN ad_creatives cr ON cr.ad_id = c.ad_id
        WHERE c.ad_id = ?
        `).get(context.cleanId);

        const origAdRes = await axios.get(`${BASE}/${context.cleanId}`, {
          params: {
            fields: 'id,name,adset_id,campaign_id,account_id,creative{id,name,object_story_spec,effective_object_story_id,thumbnail_url,image_url,video_id,body}',
            access_token: token
          }
        });
        const origAdData = origAdRes.data;
        let origCreative = origAdData.creative || {};
        const adName = origAdData.name || adRow?.ad_name || 'Ad';
        const adsetId = origAdData.adset_id || adRow?.adset_id;
        const campaignId = origAdData.campaign_id || adRow?.campaign_id;
        let accountId = context.accountId || adRow?.account_id || origAdData.account_id;
        if (accountId && !accountId.startsWith('act_')) accountId = 'act_' + accountId;

        if (!adsetId) return res.status(404).json({ success: false, error: 'Không tìm thấy AdSet ID của quảng cáo gốc' });
        if (!accountId) return res.status(400).json({ success: false, error: 'Không tìm thấy Ad Account ID của quảng cáo gốc' });

        if (!origCreative.object_story_spec && origCreative.id) {
          try {
            const creativeRes = await axios.get(`${BASE}/${origCreative.id}`, {
              params: {
                fields: 'id,name,object_story_spec,effective_object_story_id,thumbnail_url,image_url,video_id,body',
                access_token: token
              }
            });
            origCreative = { ...origCreative, ...creativeRes.data };
          } catch (cErr) {}
        }

        const variantBody = action.parameters?.body !== undefined
          ? String(action.parameters.body)
          : (action.value ? String(action.value) : '');
        const useExistingCreative = !variantBody.trim();

        let creativeId = origCreative.id;
        let newCreativeCreated = false;
        let variantMessage = 'Tạo variant thành công (trạng thái: Tạm dừng)';

        if (!useExistingCreative) {
          if (origCreative.object_story_spec) {
            const spec = JSON.parse(JSON.stringify(origCreative.object_story_spec));
            let modified = false;

            if (spec.link_data) {
              spec.link_data.message = variantBody;
              modified = true;
            }
            if (spec.video_data) {
              spec.video_data.message = variantBody;
              modified = true;
            }
            if (spec.photo_data) {
              spec.photo_data.caption = variantBody;
              spec.photo_data.message = variantBody;
              modified = true;
            }
            if (spec.text_data) {
              spec.text_data.message = variantBody;
              modified = true;
            }
            if (spec.template_data) {
              spec.template_data.message = variantBody;
              modified = true;
            }

            if (modified) {
              const newCreativeRes = await axios.post(`${BASE}/${accountId}/adcreatives`, {
                name: `${adName} - Variant`,
                object_story_spec: JSON.stringify(spec),
                access_token: token
              });
              creativeId = newCreativeRes.data.id;
              newCreativeCreated = true;
              variantMessage = 'Đã tạo Ad Variant với nội dung mới (trạng thái: Tạm dừng)';
            } else {
              creativeId = origCreative.id;
              variantMessage = 'Đã tạo Ad bản sao (Bài viết Fanpage/Story ID không cho phép sửa trực tiếp copy qua API)';
            }
          } else {
            creativeId = origCreative.id;
            variantMessage = 'Đã tạo Ad bản sao trong AdSet (Creative nguồn là bài viết Page có sẵn không thể ghi đè nội dung qua API)';
          }
        } else {
          variantMessage = 'Đã nhân bản Ad thành công trong cùng AdSet (trạng thái: Tạm dừng)';
        }

        if (!creativeId) return res.status(400).json({ success: false, error: 'Không tìm thấy Creative ID để tạo Ad' });

        const newAdName = `${adName} - Variant`;
        const newAdRes = await axios.post(`${BASE}/${accountId}/ads`, {
          name: newAdName,
          adset_id: adsetId,
          creative: JSON.stringify({ creative_id: creativeId }),
          status: 'PAUSED',
          access_token: token
        });
        const newAdId = newAdRes.data.id;

        stmts.upsertAdConfig.run({
          ad_id: newAdId,
          account_id: accountId,
          campaign_id: campaignId || '',
          campaign_name: adRow?.campaign_name || '',
          campaign_status: adRow?.campaign_status || 'ACTIVE',
          campaign_start_time: adRow?.campaign_start_time || '',
          campaign_budget: adRow?.campaign_budget || '0',
          adset_id: adsetId,
          adset_name: adRow?.adset_name || '',
          adset_status: adRow?.adset_status || 'ACTIVE',
          adset_start_time: adRow?.adset_start_time || '',
          adset_budget: adRow?.adset_budget || '0',
          ad_name: newAdName,
          ad_status: 'PAUSED',
          created_time: new Date().toISOString(),
          post_url: adRow?.post_url || null,
          targeting: adRow?.targeting ? (typeof adRow.targeting === 'string' ? adRow.targeting : JSON.stringify(adRow.targeting)) : null
        });

        const crypto = require('crypto');
        const thumbUrl = adRow?.thumbnail_url || origCreative?.image_url || origCreative?.thumbnail_url || null;
        const bodyText = newCreativeCreated ? variantBody : (adRow?.body_text || origCreative?.body || variantBody || '');
        const imageHash = adRow?.image_hash || '';
        const videoId = adRow?.video_id || origCreative?.video_id || null;
        const bodyHash = bodyText ? crypto.createHash('md5').update(bodyText).digest('hex') : '';

        if (insertAdCreative) {
          insertAdCreative({
            ad_id: newAdId,
            thumbnail_url: thumbUrl,
            video_url: null,
            body_text: bodyText,
            image_hash: imageHash,
            video_id: videoId,
            body_hash: bodyHash
          });
        }

        result = {
          new_ad_id: newAdId,
          adset_id: adsetId,
          ad_name: newAdName,
          creative_id: creativeId,
          status: 'PAUSED',
          message: variantMessage
        };
      } else {
        return res.status(400).json({ success: false, error: `Unknown action type: ${action.type}` });
      }

      res.json({ success: true, result });
    } catch (err) {
      const fbError = err.response?.data?.error;
      const msg = fbError?.error_user_msg || fbError?.error_user_title || fbError?.message || err.message;
      res.status(err.statusCode || (err.response?.status) || 500).json({
        success: false,
        error: msg,
        fb_error_code: fbError?.code
      });
    }
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  console.log('--- 1. UNIFIED resolveAdsContext & DYNAMIC TOKEN RESOLUTION ---');
  await test('Mọi action đều tự động lấy đúng token workspace và account_id', async () => {
    metaCalls.get.length = 0;
    metaCalls.post.length = 0;

    const res = await axios.post(`${baseUrl}/api/ads/execute-action`, {
      workspaceId: TEST_WS_ID,
      action: { type: 'PAUSE_AD', targetId: TEST_AD_ID_ABO }
    });

    assert.strictEqual(res.data.success, true);
    assert(metaCalls.post.length > 0);
    assert.strictEqual(metaCalls.post[0].data.access_token, 'SECRET_QA_888_ADS_TOKEN');
  });

  console.log('\n--- 2. DUPLICATE_ADSET (DAILY BUDGET & LIFETIME BUDGET + SQLITE PERSISTENCE) ---');
  await test('DUPLICATE_ADSET với Daily Budget: Nhân AdSet + Ad trạng thái PAUSED và lưu ngay vào SQLite', async () => {
    metaCalls.post.length = 0;

    const res = await axios.post(`${baseUrl}/api/ads/execute-action`, {
      workspaceId: TEST_WS_ID,
      action: { type: 'DUPLICATE_ADSET', targetId: TEST_AD_ID_ABO }
    });

    assert.strictEqual(res.data.success, true);
    const result = res.data.result;
    assert(result.new_adset_id, 'Phải có new_adset_id');
    assert(result.new_ad_id, 'Phải có new_ad_id');
    assert.strictEqual(result.status, 'PAUSED');

    // Kiểm tra SQLite ad_config đã được lưu ngay lập tức
    const savedAd = db.prepare('SELECT * FROM ad_config WHERE ad_id = ?').get(result.new_ad_id);
    assert(savedAd, 'Ad mới phải tồn tại trong SQLite ad_config');
    assert.strictEqual(savedAd.ad_status, 'PAUSED');
    assert.strictEqual(savedAd.adset_status, 'PAUSED');
    assert.strictEqual(savedAd.adset_id, result.new_adset_id);
    assert.strictEqual(savedAd.adset_name, 'QA ABO AdSet 101 - Copy');

    // Kiểm tra ad_creatives
    const savedCreative = db.prepare('SELECT * FROM ad_creatives WHERE ad_id = ?').get(result.new_ad_id);
    assert(savedCreative, 'Creative mới phải tồn tại trong SQLite ad_creatives');
    assert.strictEqual(savedCreative.body_text, 'Nội dung bài viết ABO gốc');
  });

  await test('DUPLICATE_ADSET với Lifetime Budget: Tính toán start_time & end_time hợp lệ tránh lỗi #100', async () => {
    metaCalls.post.length = 0;

    const res = await axios.post(`${baseUrl}/api/ads/execute-action`, {
      workspaceId: TEST_WS_ID,
      action: { type: 'DUPLICATE_ADSET', targetId: TEST_AD_ID_LIFETIME }
    });

    assert.strictEqual(res.data.success, true);
    const result = res.data.result;
    assert(result.new_adset_id);

    // Kiểm tra payload gửi lên Meta
    const adsetPostCall = metaCalls.post.find(c => c.url.includes('/adsets'));
    assert(adsetPostCall, 'Phải có cuộc gọi tạo adsets');
    assert(adsetPostCall.data.lifetime_budget, 'Phải có lifetime_budget');
    assert(adsetPostCall.data.start_time, 'Bắt buộc phải có start_time khi dùng lifetime_budget');
    assert(adsetPostCall.data.end_time, 'Bắt buộc phải có end_time khi dùng lifetime_budget');
    assert(new Date(adsetPostCall.data.end_time) > new Date(adsetPostCall.data.start_time), 'end_time phải sau start_time');
  });

  console.log('\n--- 3. CREATE_VARIANT (SPEC EDITING, FALLBACK FETCH & PAGE POST) ---');
  await test('CREATE_VARIANT với link_data: Tạo AdCreative mới thay thế copy, tạo Ad PAUSED và lưu DB', async () => {
    metaCalls.post.length = 0;
    const newCopy = '🔥 Ưu đãi cực khủng tháng 8!';

    const res = await axios.post(`${baseUrl}/api/ads/execute-action`, {
      workspaceId: TEST_WS_ID,
      action: {
        type: 'CREATE_VARIANT',
        targetId: TEST_AD_ID_ABO,
        parameters: { body: newCopy }
      }
    });

    assert.strictEqual(res.data.success, true);
    const result = res.data.result;
    assert(result.new_ad_id);
    assert.strictEqual(result.status, 'PAUSED');

    // Kiểm tra Meta post call tạo adcreative
    const creativePost = metaCalls.post.find(c => c.url.includes('/adcreatives'));
    assert(creativePost, 'Phải gọi tạo adcreative mới');
    const spec = JSON.parse(creativePost.data.object_story_spec);
    assert.strictEqual(spec.link_data.message, newCopy);

    // Kiểm tra SQLite DB
    const savedAd = db.prepare('SELECT * FROM ad_config WHERE ad_id = ?').get(result.new_ad_id);
    assert(savedAd, 'Ad variant mới phải có trong SQLite');
    assert.strictEqual(savedAd.ad_status, 'PAUSED');

    const savedCreative = db.prepare('SELECT * FROM ad_creatives WHERE ad_id = ?').get(result.new_ad_id);
    assert.strictEqual(savedCreative.body_text, newCopy);
  });

  await test('CREATE_VARIANT khi creative chưa có spec trong ad gốc -> Tự động gọi fetch spec đầy đủ từ creative ID', async () => {
    metaCalls.post.length = 0;
    const newCopy = '🎬 Video biến thể mới 2026';

    const res = await axios.post(`${baseUrl}/api/ads/execute-action`, {
      workspaceId: TEST_WS_ID,
      action: {
        type: 'CREATE_VARIANT',
        targetId: TEST_AD_ID_SPEC_FALLBACK,
        parameters: { body: newCopy }
      }
    });

    assert.strictEqual(res.data.success, true);
    const result = res.data.result;
    assert(result.new_ad_id);

    // Kiểm tra Meta call fetch creative riêng biệt
    const fetchedCreative = metaCalls.get.find(c => c.url.includes(`/${TEST_CREATIVE_ID_PARTIAL}`));
    assert(fetchedCreative, 'Phải fetch riêng creative ID từ Meta');

    // Kiểm tra adcreative mới được tạo với video_data.message = newCopy
    const creativePost = metaCalls.post.find(c => c.url.includes('/adcreatives'));
    assert(creativePost);
    const spec = JSON.parse(creativePost.data.object_story_spec);
    assert.strictEqual(spec.video_data.message, newCopy);
  });

  await test('CREATE_VARIANT với photo_data: Đổi cả photo_data.caption và photo_data.message', async () => {
    metaCalls.post.length = 0;
    const newCaption = '📸 Caption hình ảnh mới!';

    const res = await axios.post(`${baseUrl}/api/ads/execute-action`, {
      workspaceId: TEST_WS_ID,
      action: {
        type: 'CREATE_VARIANT',
        targetId: TEST_AD_ID_PHOTO,
        parameters: { body: newCaption }
      }
    });

    assert.strictEqual(res.data.success, true);
    const creativePost = metaCalls.post.find(c => c.url.includes('/adcreatives'));
    assert(creativePost);
    const spec = JSON.parse(creativePost.data.object_story_spec);
    assert.strictEqual(spec.photo_data.caption, newCaption);
  });

  await test('CREATE_VARIANT với Page Post (không có editable spec): Fallback giữ nguyên creative và thông báo rõ ràng', async () => {
    metaCalls.post.length = 0;

    const res = await axios.post(`${baseUrl}/api/ads/execute-action`, {
      workspaceId: TEST_WS_ID,
      action: {
        type: 'CREATE_VARIANT',
        targetId: TEST_AD_ID_PAGE_POST,
        parameters: { body: 'Thử đổi text bài fanpage' }
      }
    });

    assert.strictEqual(res.data.success, true);
    const result = res.data.result;
    assert(result.new_ad_id);
    assert(/bài viết page|fanpage/i.test(result.message), `Expected message to mention page/fanpage, got: ${result.message}`);
  });

  console.log('\n--- 4. SCALE_BUDGET, INCREASE_BUDGET, DECREASE_BUDGET ---');
  await test('SCALE_BUDGET + INCREASE_BUDGET: Điều chỉnh an toàn, tuân thủ sàn 25.000₫ & cập nhật DB', async () => {
    metaCalls.post.length = 0;

    // Test INCREASE_BUDGET
    const resInc = await axios.post(`${baseUrl}/api/ads/execute-action`, {
      workspaceId: TEST_WS_ID,
      action: { type: 'INCREASE_BUDGET', targetId: TEST_AD_ID_ABO }
    });
    assert.strictEqual(resInc.data.success, true);
    assert.strictEqual(resInc.data.result.newBudget, 180000); // 150.000 * 1.2

    // Test DECREASE_BUDGET sàn 25.000đ
    const resDec = await axios.post(`${baseUrl}/api/ads/execute-action`, {
      workspaceId: TEST_WS_ID,
      action: { type: 'DECREASE_BUDGET', targetId: TEST_AD_ID_ABO, parameters: { percent: -90 } }
    });
    assert.strictEqual(resDec.data.success, true);
    assert(resDec.data.result.newBudget >= MIN_DAILY_BUDGET);

    // Kiểm tra SQLite ad_config
    const adConfig = db.prepare('SELECT adset_budget, budget_trend FROM ad_config WHERE adset_id = ?').get(TEST_ADSET_ID_ABO);
    assert.strictEqual(adConfig.budget_trend, 'DOWN');
  });

  console.log('\n--- 5. PAUSE_AD & PAUSE_ADSET (INSTANT DB UPDATE) ---');
  await test('PAUSE_AD: Gửi PAUSED lên Meta và cập nhật ad_status = PAUSED trong SQLite DB', async () => {
    metaCalls.post.length = 0;

    const res = await axios.post(`${baseUrl}/api/ads/execute-action`, {
      workspaceId: TEST_WS_ID,
      action: { type: 'PAUSE_AD', targetId: TEST_AD_ID_ABO }
    });

    assert.strictEqual(res.data.success, true);
    const ad = db.prepare('SELECT ad_status, budget_trend FROM ad_config WHERE ad_id = ?').get(TEST_AD_ID_ABO);
    assert.strictEqual(ad.ad_status, 'PAUSED');
    assert.strictEqual(ad.budget_trend, 'PAUSE');
  });

  await test('PAUSE_ADSET: Gửi PAUSED lên Meta và cập nhật adset_status = PAUSED trong SQLite DB', async () => {
    metaCalls.post.length = 0;

    const res = await axios.post(`${baseUrl}/api/ads/execute-action`, {
      workspaceId: TEST_WS_ID,
      action: { type: 'PAUSE_ADSET', targetId: TEST_ADSET_ID_ABO }
    });

    assert.strictEqual(res.data.success, true);
    const ad = db.prepare('SELECT adset_status, budget_trend FROM ad_config WHERE adset_id = ?').get(TEST_ADSET_ID_ABO);
    assert.strictEqual(ad.adset_status, 'PAUSED');
    assert.strictEqual(ad.budget_trend, 'PAUSE');
  });

  server.close();

  console.log('\n===============================================================');
  console.log(`=== SUMMARY: ${totalPassed} PASSED, ${totalFailed} FAILED ===`);
  console.log('===============================================================\n');

  if (totalFailed > 0) process.exit(1);
  else process.exit(0);
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
