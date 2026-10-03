const axios = require('axios');
const { db } = require('../db/database');
const { loadSecrets } = require('./secretStore');
const config = require('../config');

const MIN_DAILY_BUDGET = 25000;

function money(val) {
  return (val !== null && val !== undefined && !isNaN(val))
    ? Number(val).toLocaleString('vi-VN') + '₫'
    : '—';
}

/**
 * Phân giải Dynamic Workspace Token và thông tin đối tượng Ad/AdSet/Campaign
 */
function resolveAdsContext({ adId, accountId, workspaceId }) {
  const cleanId = adId ? String(adId).replace(/^'/, '').trim() : null;
  let adConfig = null;

  if (cleanId) {
    adConfig = db.prepare(`
      SELECT ad_id, ad_name, account_id, adset_id, adset_name, campaign_id, campaign_name,
             adset_budget, campaign_budget, ad_status, adset_status, campaign_status
      FROM ad_config WHERE ad_id = ?
    `).get(cleanId);

    if (!adConfig) {
      // cleanId có thể là adset_id hoặc campaign_id
      adConfig = db.prepare(`
        SELECT ad_id, ad_name, account_id, adset_id, adset_name, campaign_id, campaign_name,
               adset_budget, campaign_budget, ad_status, adset_status, campaign_status
        FROM ad_config WHERE adset_id = ? OR campaign_id = ? LIMIT 1
      `).get(cleanId, cleanId);
    }
  }

  let resolvedAccountId = accountId || adConfig?.account_id || null;
  let resolvedWorkspaceId = (workspaceId !== undefined && workspaceId !== null && workspaceId !== '')
    ? Number(workspaceId)
    : null;

  if (!resolvedWorkspaceId && resolvedAccountId) {
    const wsAccount = db.prepare(`
      SELECT workspace_id FROM workspace_ad_accounts WHERE account_id = ? ORDER BY is_default DESC LIMIT 1
    `).get(resolvedAccountId);
    if (wsAccount) {
      resolvedWorkspaceId = wsAccount.workspace_id;
    }
  }

  if (resolvedWorkspaceId && resolvedAccountId) {
    const allowed = db.prepare(`
      SELECT 1 FROM workspace_ad_accounts WHERE workspace_id = ? AND account_id = ?
    `).get(resolvedWorkspaceId, resolvedAccountId);
    if (!allowed) {
      const err = new Error('Quảng cáo không thuộc doanh nghiệp đang chọn');
      err.statusCode = 403;
      throw err;
    }
  }

  const secrets = loadSecrets();
  let token = null;

  if (resolvedWorkspaceId) {
    token = secrets[`WORKSPACE_${resolvedWorkspaceId}_ADS_TOKEN`];
    if (!token) {
      const ws = db.prepare('SELECT ads_access_token FROM workspaces WHERE id = ?').get(resolvedWorkspaceId);
      if (ws?.ads_access_token) token = ws.ads_access_token;
    }
    if (!token) {
      const err = new Error(`Workspace ${resolvedWorkspaceId} chưa có Ads/System User Token`);
      err.statusCode = 400;
      throw err;
    }
  } else {
    token = secrets.FB_ADS_ACCESS_TOKEN || process.env.FB_ADS_ACCESS_TOKEN || config.facebook?.adsAccessToken;
    if (!token) {
      const err = new Error('Chưa cấu hình Ads Access Token');
      err.statusCode = 400;
      throw err;
    }
  }

  const apiVersion = process.env.FACEBOOK_API_VERSION || config.facebook?.apiVersion || 'v21.0';

  return {
    cleanId,
    adConfig,
    token,
    workspaceId: resolvedWorkspaceId,
    accountId: resolvedAccountId,
    apiVersion
  };
}

/**
 * Thực hiện điều chỉnh ngân sách cho AdSet / Campaign với bảo vệ Lifetime Budget và phân biệt ABO vs CBO
 */
async function executeBudgetChange({ adId, targetId, percent, newBudget, workspaceId, accountId }) {
  const queryId = adId || targetId;
  const { cleanId, adConfig, token, apiVersion } = resolveAdsContext({ adId: queryId, accountId, workspaceId });

  if (!cleanId) {
    const err = new Error('Thiếu mã định danh quảng cáo (adId / targetId)');
    err.statusCode = 400;
    throw err;
  }

  let adsetId = adConfig?.adset_id;
  let campaignId = adConfig?.campaign_id;
  if (!adsetId && cleanId) adsetId = cleanId;

  // 1. Kiểm tra cấu hình AdSet trực tiếp trên Meta Graph API
  let adsetData = null;
  try {
    const res = await axios.get(`https://graph.facebook.com/${apiVersion}/${adsetId}`, {
      params: {
        fields: 'id,name,daily_budget,lifetime_budget,status,campaign_id',
        access_token: token
      }
    });
    adsetData = res.data;
    if (adsetData.campaign_id && !campaignId) campaignId = adsetData.campaign_id;
  } catch (apiErr) {
    const errData = apiErr?.response?.data?.error || {};
    const msg = errData.error_user_msg || errData.error_user_title || errData.message || apiErr.message;
    const err = new Error(`Lỗi truy vấn AdSet từ Meta Graph API (${adsetId}): ${msg}`);
    err.statusCode = apiErr?.response?.status || 500;
    throw err;
  }

  const adsetDaily = Number(adsetData.daily_budget || 0);
  const adsetLifetime = Number(adsetData.lifetime_budget || 0);

  // Bảo vệ Ngân Sách Trọn Đời (Lifetime Budget Protection) tại cấp AdSet
  if (adsetLifetime > 0 && !adsetDaily) {
    const err = new Error(`Quảng cáo đang sử dụng Ngân sách trọn đời (Lifetime Budget: ${money(adsetLifetime)}), không thể điều chỉnh tăng/giảm theo % ngày.`);
    err.statusCode = 400;
    throw err;
  }

  let level = 'Adset';
  let updateTargetId = adsetId;
  let targetName = adsetData.name || adConfig?.adset_name || adsetId;
  let currentBudget = adsetDaily;

  // 2. Nếu AdSet không có daily_budget -> Kiểm tra Campaign (CBO)
  if (currentBudget === 0) {
    if (!campaignId) {
      const err = new Error('AdSet không có Daily Budget và không tìm thấy Campaign ID để kiểm tra CBO.');
      err.statusCode = 400;
      throw err;
    }

    let campData = null;
    try {
      const res = await axios.get(`https://graph.facebook.com/${apiVersion}/${campaignId}`, {
        params: {
          fields: 'id,name,daily_budget,lifetime_budget,status',
          access_token: token
        }
      });
      campData = res.data;
    } catch (apiErr) {
      const errData = apiErr?.response?.data?.error || {};
      const msg = errData.error_user_msg || errData.error_user_title || errData.message || apiErr.message;
      const err = new Error(`Lỗi truy vấn Campaign từ Meta Graph API (${campaignId}): ${msg}`);
      err.statusCode = apiErr?.response?.status || 500;
      throw err;
    }

    const campDaily = Number(campData.daily_budget || 0);
    const campLifetime = Number(campData.lifetime_budget || 0);

    // Bảo vệ Ngân Sách Trọn Đời tại cấp Campaign
    if (campLifetime > 0 && !campDaily) {
      const err = new Error(`Quảng cáo đang sử dụng Ngân sách trọn đời (Lifetime Budget: ${money(campLifetime)}), không thể điều chỉnh tăng/giảm theo % ngày.`);
      err.statusCode = 400;
      throw err;
    }

    if (campDaily > 0) {
      level = 'Campaign';
      updateTargetId = campaignId;
      targetName = campData.name || adConfig?.campaign_name || campaignId;
      currentBudget = campDaily;
    } else {
      const err = new Error('Không thể điều chỉnh ngân sách: Cả AdSet và Chiến dịch trên Meta đều không có Daily Budget hợp lệ.');
      err.statusCode = 400;
      throw err;
    }
  }

  // 3. Tính toán ngân sách mới & % điều chỉnh
  let nextBudget = 0;
  let calcPercent = 0;

  if (newBudget !== undefined && newBudget !== null && newBudget !== '') {
    const rawVal = Number(newBudget);
    if (!Number.isFinite(rawVal) || rawVal <= 0) {
      const err = new Error('Ngân sách mới không hợp lệ');
      err.statusCode = 400;
      throw err;
    }
    nextBudget = Math.max(MIN_DAILY_BUDGET, Math.round(rawVal));
    calcPercent = Math.round(((nextBudget - currentBudget) / currentBudget) * 100);
  } else if (percent !== undefined && percent !== null && percent !== '') {
    const p = Number(percent);
    if (!Number.isFinite(p) || p < -90 || p > 500 || p === 0) {
      const err = new Error('Phần trăm điều chỉnh không hợp lệ (hỗ trợ từ -90% đến +500%, khác 0%)');
      err.statusCode = 400;
      throw err;
    }
    nextBudget = Math.max(MIN_DAILY_BUDGET, Math.round(currentBudget * (1 + p / 100)));
    calcPercent = p;
  } else {
    // Mặc định scale +20%
    calcPercent = 20;
    nextBudget = Math.max(MIN_DAILY_BUDGET, Math.round(currentBudget * 1.2));
  }

  const trend = calcPercent > 0 ? 'UP' : (calcPercent < 0 ? 'DOWN' : 'HOLD');

  // 4. Cập nhật Meta Graph API
  try {
    await axios.post(
      `https://graph.facebook.com/${apiVersion}/${updateTargetId}`,
      { daily_budget: nextBudget, access_token: token }
    );
  } catch (apiErr) {
    const errData = apiErr?.response?.data?.error || {};
    const msg = errData.error_user_msg || errData.error_user_title || errData.message || apiErr.message;
    const err = new Error(`Lỗi cập nhật ngân sách trên Meta: ${msg}`);
    err.statusCode = apiErr?.response?.status || 500;
    throw err;
  }

  // 5. Cập nhật SQLite DB ngay lập tức
  if (level === 'Campaign') {
    db.prepare("UPDATE ad_config SET campaign_budget = ?, campaign_daily_budget = ?, budget_type = 'DAILY', budget_trend = ?, budget_updated_at = datetime('now') WHERE campaign_id = ?").run(String(nextBudget), String(nextBudget), trend, updateTargetId);
  } else {
    db.prepare("UPDATE ad_config SET adset_budget = ?, adset_daily_budget = ?, budget_type = 'DAILY', budget_trend = ?, budget_updated_at = datetime('now') WHERE adset_id = ?").run(String(nextBudget), String(nextBudget), trend, updateTargetId);
  }

  const sign = calcPercent > 0 ? '+' : '';
  return {
    success: true,
    level,
    targetId: updateTargetId,
    targetName,
    oldBudget: currentBudget,
    newBudget: nextBudget,
    percent: calcPercent,
    message: `${level} budget ${sign}${calcPercent}%: ${money(currentBudget)} → ${money(nextBudget)}`
  };
}

/**
 * Tạm dừng quảng cáo (Ad level) với dynamic token và cập nhật DB
 */
async function executePauseAd({ adId, workspaceId, accountId }) {
  const { cleanId, token, apiVersion } = resolveAdsContext({ adId, accountId, workspaceId });
  if (!cleanId) {
    const err = new Error('Thiếu mã định danh quảng cáo (adId)');
    err.statusCode = 400;
    throw err;
  }

  try {
    await axios.post(
      `https://graph.facebook.com/${apiVersion}/${cleanId}`,
      { status: 'PAUSED', access_token: token }
    );
  } catch (apiErr) {
    const errData = apiErr?.response?.data?.error || {};
    const msg = errData.error_user_msg || errData.error_user_title || errData.message || apiErr.message;
    const err = new Error(`Lỗi tạm dừng quảng cáo trên Meta: ${msg}`);
    err.statusCode = apiErr?.response?.status || 500;
    throw err;
  }

  db.prepare("UPDATE ad_config SET ad_status = 'PAUSED', budget_trend = 'PAUSE', budget_updated_at = datetime('now') WHERE ad_id = ?").run(cleanId);

  return {
    success: true,
    message: `Quảng cáo ${cleanId} đã được tạm dừng thành công.`
  };
}

/**
 * Tạm dừng nhóm quảng cáo (AdSet level) với dynamic token và cập nhật DB
 */
async function executePauseAdset({ adsetId, adId, workspaceId, accountId }) {
  const targetId = adsetId || adId;
  const { cleanId, token, apiVersion, adConfig } = resolveAdsContext({ adId: targetId, accountId, workspaceId });
  const realAdsetId = adsetId || adConfig?.adset_id || cleanId;

  if (!realAdsetId) {
    const err = new Error('Thiếu mã định danh nhóm quảng cáo (adsetId)');
    err.statusCode = 400;
    throw err;
  }

  try {
    await axios.post(
      `https://graph.facebook.com/${apiVersion}/${realAdsetId}`,
      { status: 'PAUSED', access_token: token }
    );
  } catch (apiErr) {
    const errData = apiErr?.response?.data?.error || {};
    const msg = errData.error_user_msg || errData.error_user_title || errData.message || apiErr.message;
    const err = new Error(`Lỗi tạm dừng nhóm quảng cáo trên Meta: ${msg}`);
    err.statusCode = apiErr?.response?.status || 500;
    throw err;
  }

  db.prepare("UPDATE ad_config SET adset_status = 'PAUSED', budget_trend = 'PAUSE', budget_updated_at = datetime('now') WHERE adset_id = ?").run(realAdsetId);

  return {
    success: true,
    message: `Nhóm quảng cáo ${realAdsetId} đã được tạm dừng thành công.`
  };
}

module.exports = {
  MIN_DAILY_BUDGET,
  money,
  resolveAdsContext,
  executeBudgetChange,
  executeChangeBudget: executeBudgetChange,
  executePauseAd,
  executePauseAdset
};
