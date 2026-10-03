const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const router = express.Router();
const { stmts, db } = require('../db/database');
const { executeBudgetChange, executePauseAd, resolveAdsContext } = require('../services/facebookAdsBudget');
const { evaluateBudgetPacing, getExpectedPacingPct, HOURLY_DISTRIBUTION_GUIDE } = require('../services/aiOptimizer');
const { apiCache, clearApiCache } = require('../utils/apiCache');

const API_VERSION = process.env.FACEBOOK_API_VERSION || 'v21.0';
const TARGET_CPM = 250000;

function getDecision(row, isEffectivelyActive) {
  if (!isEffectivelyActive) return 'paused';
  if (row.run_days < 2) return 'testing';
  
  const overThreshold = row.cost_per_mess > TARGET_CPM || (row.total_mess === 0 && row.total_spend > TARGET_CPM);
  if (overThreshold) return 'pause';
  
  if (row.total_mess === 0) return 'monitor';
  
  const scaledRecently = row.budget_trend === 'UP' && row.budget_updated_at &&
    (new Date(row.budget_updated_at + 'Z').getTime() > Date.now() - 24 * 60 * 60 * 1000);
    
  if (scaledRecently) return 'scaled';
  
  return 'scale';
}

const classificationCache=new Map();
function classificationRules(workspaceId=1){const id=Number(workspaceId)||1,cached=classificationCache.get(id);if(!cached||Date.now()>cached.expires){const value={expires:Date.now()+5000,rules:db.prepare('SELECT kind,prefix,label,priority FROM workspace_classification_rules WHERE workspace_id=? ORDER BY priority DESC,LENGTH(prefix) DESC').all(id)};classificationCache.set(id,value);return value.rules;}return cached.rules;}
function classifyAdName(adName,kind,fallback,workspaceId=1){const name=String(adName||'').toLowerCase();const rule=classificationRules(workspaceId).find(item=>item.kind===kind&&name.includes(String(item.prefix).toLowerCase()));return rule?.label||fallback;}
function parseService(adName,workspaceId=1){return classifyAdName(adName,'service','Khác',workspaceId);}
function parseOperator(adName,fallback='Chưa xác định',workspaceId=1){return classifyAdName(adName,'operator',fallback,workspaceId);}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function reportRange(period, anchorValue) {
  const anchor = anchorValue ? new Date(`${anchorValue}T12:00:00Z`) : new Date();
  if (Number.isNaN(anchor.getTime())) throw new Error('Ngày báo cáo không hợp lệ');
  const start = new Date(anchor);
  const end = new Date(anchor);

  if (period === 'week') {
    const mondayOffset = (anchor.getUTCDay() + 6) % 7;
    start.setUTCDate(anchor.getUTCDate() - mondayOffset);
    end.setUTCDate(start.getUTCDate() + 6);
  } else if (period === 'month') {
    start.setUTCDate(1);
    end.setUTCMonth(start.getUTCMonth() + 1, 0);
  }

  const days = Math.round((end - start) / 86400000) + 1;
  const previousEnd = new Date(start);
  previousEnd.setUTCDate(previousEnd.getUTCDate() - 1);
  const previousStart = new Date(previousEnd);
  previousStart.setUTCDate(previousStart.getUTCDate() - days + 1);
  return {
    start: isoDate(start), end: isoDate(end),
    previousStart: isoDate(previousStart), previousEnd: isoDate(previousEnd)
  };
}

function reportMetrics(rows) {
  const result = rows.reduce((acc, row) => {
    acc.spend += Number(row.spend) || 0;
    acc.impressions += Number(row.impressions) || 0;
    acc.clicks += Number(row.clicks) || 0;
    acc.reach += Number(row.reach) || 0;
    acc.mess += Number(row.mess) || 0;
    acc.leads += Number(row.leads) || 0;
    acc.purchases += Number(row.purchases) || 0;
    acc.frequencyWeighted += (Number(row.frequency) || 0) * (Number(row.impressions) || 0);
    acc.ads.add(row.ad_id);
    return acc;
  }, { spend: 0, impressions: 0, clicks: 0, reach: 0, mess: 0, leads:0, purchases:0, frequencyWeighted: 0, ads: new Set() });
  return {
    spend: Math.round(result.spend), impressions: result.impressions, clicks: result.clicks,
    reach: result.reach, mess: result.mess, leads:result.leads, purchases:result.purchases, ad_count: result.ads.size,
    cpm: result.impressions ? Math.round(result.spend * 1000 / result.impressions) : 0,
    ctr: result.impressions ? Number((result.clicks * 100 / result.impressions).toFixed(2)) : 0,
    mess_rate: result.clicks ? Number((result.mess * 100 / result.clicks).toFixed(2)) : 0,
    cpmess: result.mess ? Math.round(result.spend / result.mess) : 0,
    cost_per_lead:result.leads?Math.round(result.spend/result.leads):0,
    cost_per_purchase:result.purchases?Math.round(result.spend/result.purchases):0,
    frequency: result.impressions ? Number((result.frequencyWeighted / result.impressions).toFixed(2)) : 0
  };
}

function metricChange(current, previous, key) {
  if (!previous[key]) return null;
  return Number((((current[key] - previous[key]) / previous[key]) * 100).toFixed(1));
}

// GET /api/ads/reports — unified daily/weekly/monthly reporting
router.get('/reports', (req, res) => {
  try {
    const workspaceId=Number(req.query.workspaceId||1);
    const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'day';
    const latest = db.prepare('SELECT MAX(date) AS date FROM ad_daily_stats').get()?.date;
    const anchor = req.query.anchor || latest || isoDate(new Date());
    const range = reportRange(period, anchor);
    const serviceFilter = req.query.service || 'ALL';
    const operatorFilter = req.query.operator || 'ALL';
    const dimension = ['service', 'operator'].includes(req.query.dimension) ? req.query.dimension : 'service';

    const wsAccounts = db.prepare('SELECT account_id FROM workspace_ad_accounts WHERE workspace_id = ?').all(workspaceId).map(r => String(r.account_id));
    const accountIds = new Set(String(req.query.account_ids || req.query.account_id || '').split(',').map(x => x.trim()).filter(Boolean));
    if (!accountIds.size && wsAccounts.length > 0) {
      wsAccounts.forEach(id => accountIds.add(id));
    }
    const totalWsAccs = db.prepare('SELECT COUNT(*) as count FROM workspace_ad_accounts').get()?.count || 0;
    const isAccountAllowed = (accId) => {
      if (accountIds.size > 0) return accountIds.has(String(accId));
      if (totalWsAccs === 0) return true;
      return false;
    };

    const accIdsStr = Array.from(accountIds).sort().join(',');
    const cacheKey = `reports_ws${workspaceId}_${accIdsStr}_${period}_${anchor}_${serviceFilter}_${operatorFilter}_${dimension}`;
    const cached = apiCache.get(cacheKey);
    if (cached) return res.json(cached);

    if (!accountIds.size && totalWsAccs > 0) {
      const emptyResult = { success: true, data: { period, anchor, range, dimension, filters: { service: serviceFilter, operator: operatorFilter }, options: { services: [], operators: [] }, summary: reportMetrics([]), previous: reportMetrics([]), groups: [], series: [] } };
      apiCache.set(cacheKey, emptyResult);
      return res.json(emptyResult);
    }

    const rows = db.prepare(`
      SELECT s.date, s.ad_id, c.account_id, COALESCE(s.ad_name, c.ad_name, 'Không rõ') AS ad_name,
        COALESCE(s.account_name, c.account_id, 'Chưa xác định') AS operator,
        s.spend, s.impressions, s.clicks, s.reach, s.frequency,
        s.mess_started AS mess, s.leads, s.purchases
      FROM ad_daily_stats s LEFT JOIN ad_config c ON c.ad_id = s.ad_id
      WHERE s.date BETWEEN @previousStart AND @end
    `).all(range).map(row => ({ ...row, service:parseService(row.ad_name,workspaceId),operator:parseOperator(row.ad_name,row.operator,workspaceId) }));

    const scopedRows=rows.filter(row => isAccountAllowed(row.account_id));
    const services = [...new Set(scopedRows.map(row => row.service))].sort((a, b) => a.localeCompare(b, 'vi'));
    const operators = [...new Set(scopedRows.map(row => row.operator))].sort((a, b) => a.localeCompare(b, 'vi'));
    const filtered = scopedRows.filter(row =>
      (serviceFilter === 'ALL' || row.service === serviceFilter) &&
      (operatorFilter === 'ALL' || row.operator === operatorFilter)
    );
    const currentRows = filtered.filter(row => row.date >= range.start && row.date <= range.end);
    const previousRows = filtered.filter(row => row.date >= range.previousStart && row.date <= range.previousEnd);
    const summary = reportMetrics(currentRows);
    const previous = reportMetrics(previousRows);
    summary.change = Object.fromEntries(['spend','impressions','clicks','mess','leads','purchases','cpm','ctr','cpmess','cost_per_lead','cost_per_purchase'].map(key => [key, metricChange(summary, previous, key)]));

    const groupMap = new Map();
    currentRows.forEach(row => {
      const key = row[dimension];
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(row);
    });
    const groups = [...groupMap.entries()].map(([name, groupRows]) => ({ name, ...reportMetrics(groupRows) }))
      .sort((a, b) => b.spend - a.spend);

    const dayMap = new Map();
    currentRows.forEach(row => {
      if (!dayMap.has(row.date)) dayMap.set(row.date, []);
      dayMap.get(row.date).push(row);
    });
    const series = [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([date, dayRows]) => ({ date, ...reportMetrics(dayRows) }));

    const responseData = { success: true, data: { period, anchor, range, dimension, filters: { service: serviceFilter, operator: operatorFilter }, options: { services, operators }, summary, previous, groups, series } };
    apiCache.set(cacheKey, responseData);
    res.json(responseData);
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// GET /api/ads/summary
router.get('/summary', (req, res) => {
  try {
    const workspaceId = Number(req.query.workspaceId || 1);
    const wsAccounts = db.prepare('SELECT account_id FROM workspace_ad_accounts WHERE workspace_id = ?').all(workspaceId).map(r => String(r.account_id));
    const accountIds = new Set(String(req.query.account_ids || req.query.account_id || '').split(',').map(x => x.trim()).filter(Boolean));
    if (!accountIds.size && wsAccounts.length > 0) {
      wsAccounts.forEach(id => accountIds.add(id));
    }

    const accIdsStr = Array.from(accountIds).sort().join(',');
    const cacheKey = `summary_ws${workspaceId}_${accIdsStr}`;
    const cached = apiCache.get(cacheKey);
    if (cached) return res.json(cached);

    const totalWsAccs = db.prepare('SELECT COUNT(*) as count FROM workspace_ad_accounts').get()?.count || 0;
    if (!accountIds.size && totalWsAccs > 0) {
      const emptyRes = {
        success: true,
        data: {
          total_ads: 0,
          testing: 0,
          need_pause: 0,
          can_scale: 0,
          already_scaled: 0,
          already_paused: 0,
          today_spend: 0,
          today_mess: 0,
          avg_daily_spend: 0,
          month_mess: 0,
          avg_cost_per_mess: 0,
          active_ads: 0,
          today_created: 0,
          month_created: 0,
          today_scaled: 0,
          month_scaled: 0,
          today_down: 0,
          month_down: 0,
          today_paused: 0,
          month_paused: 0,
          last_sync_time: null
        },
        target_cpm: TARGET_CPM
      };
      apiCache.set(cacheKey, emptyRes);
      return res.json(emptyRes);
    }

    const accFilter = accountIds.size > 0 ? `AND c.account_id IN (${Array.from(accountIds).map(id => `'${id.replace(/'/g, "''")}'`).join(',')})` : '';
    const accWhere = accountIds.size > 0 ? `WHERE c.account_id IN (${Array.from(accountIds).map(id => `'${id.replace(/'/g, "''")}'`).join(',')})` : '';

    const summary = db.prepare(`
      WITH agg AS (
        SELECT
          c.ad_id,
          CASE WHEN c.ad_status = 'ACTIVE' AND c.adset_status = 'ACTIVE' AND c.campaign_status = 'ACTIVE' THEN 1 ELSE 0 END as is_active,
          c.budget_trend,
          c.budget_updated_at,
          COUNT(DISTINCT s.date) as run_days,
          SUM(s.spend) as total_spend,
          SUM(s.mess_started) as total_mess,
          CASE WHEN SUM(s.mess_started) > 0
            THEN SUM(s.spend) / SUM(s.mess_started)
            ELSE NULL
          END as cost_per_mess
        FROM ad_config c
        LEFT JOIN ad_daily_stats s ON c.ad_id = s.ad_id AND s.date >= date('now', '-30 days')
        WHERE (c.ad_status = 'ACTIVE' OR s.ad_id IS NOT NULL) ${accFilter}
        GROUP BY c.ad_id
      )
      SELECT
        COUNT(*) as total_ads,
        SUM(CASE WHEN run_days < 2 AND is_active = 1 THEN 1 ELSE 0 END) as testing,
        SUM(CASE WHEN run_days >= 2 AND (cost_per_mess > 250000 OR (total_mess = 0 AND total_spend > 250000)) AND is_active = 1 THEN 1 ELSE 0 END) as need_pause,
        SUM(CASE WHEN run_days >= 2 AND cost_per_mess <= 250000 AND is_active = 1 AND NOT (budget_trend = 'UP' AND budget_updated_at >= datetime('now', '-24 hours')) THEN 1 ELSE 0 END) as can_scale,
        SUM(CASE WHEN run_days >= 2 AND cost_per_mess <= 250000 AND is_active = 1 AND (budget_trend = 'UP' AND budget_updated_at >= datetime('now', '-24 hours')) THEN 1 ELSE 0 END) as already_scaled,
        SUM(CASE WHEN run_days >= 2 AND (cost_per_mess > 250000 OR (total_mess = 0 AND total_spend > 250000)) AND is_active = 0 THEN 1 ELSE 0 END) as already_paused,
        (SELECT SUM(s.spend) FROM ad_daily_stats s LEFT JOIN ad_config c ON c.ad_id = s.ad_id WHERE s.date = COALESCE((SELECT MAX(date) FROM ad_daily_stats), date('now')) ${accFilter}) as today_spend,
        (SELECT SUM(s.mess_started) FROM ad_daily_stats s LEFT JOIN ad_config c ON c.ad_id = s.ad_id WHERE s.date = COALESCE((SELECT MAX(date) FROM ad_daily_stats), date('now')) ${accFilter}) as today_mess,
        (SELECT ROUND(AVG(d_spend),0) FROM (SELECT SUM(s.spend) as d_spend FROM ad_daily_stats s LEFT JOIN ad_config c ON c.ad_id = s.ad_id ${accWhere} GROUP BY s.date)) as avg_daily_spend,
        (SELECT SUM(s.mess_started) FROM ad_daily_stats s LEFT JOIN ad_config c ON c.ad_id = s.ad_id WHERE strftime('%Y-%m', s.date) = strftime('%Y-%m', COALESCE((SELECT MAX(date) FROM ad_daily_stats), date('now'))) ${accFilter}) as month_mess,
        (SELECT SUM(s.spend)/NULLIF(SUM(s.mess_started),0) FROM ad_daily_stats s LEFT JOIN ad_config c ON c.ad_id = s.ad_id ${accWhere}) as avg_cost_per_mess,
        (SELECT COUNT(*) FROM ad_config c WHERE c.ad_status = 'ACTIVE' AND c.adset_status = 'ACTIVE' AND c.campaign_status = 'ACTIVE' ${accFilter}) as active_ads,
        (SELECT COUNT(*) FROM ad_config c WHERE substr(c.created_time, 1, 10) = date('now') ${accFilter}) as today_created,
        (SELECT COUNT(*) FROM ad_config c WHERE substr(c.created_time, 1, 7) = strftime('%Y-%m', 'now') ${accFilter}) as month_created,
        (SELECT COUNT(*) FROM ad_config c WHERE c.budget_trend = 'UP' AND date(c.budget_updated_at) = date('now') ${accFilter}) as today_scaled,
        (SELECT COUNT(*) FROM ad_config c WHERE c.budget_trend = 'UP' AND substr(c.budget_updated_at, 1, 7) = strftime('%Y-%m', 'now') ${accFilter}) as month_scaled,
        (SELECT COUNT(*) FROM ad_config c WHERE c.budget_trend = 'DOWN' AND date(c.budget_updated_at) = date('now') ${accFilter}) as today_down,
        (SELECT COUNT(*) FROM ad_config c WHERE c.budget_trend = 'DOWN' AND substr(c.budget_updated_at, 1, 7) = strftime('%Y-%m', 'now') ${accFilter}) as month_down,
        (SELECT COUNT(*) FROM ad_config c WHERE c.budget_trend = 'PAUSE' AND date(c.budget_updated_at) = date('now') ${accFilter}) as today_paused,
        (SELECT COUNT(*) FROM ad_config c WHERE c.budget_trend = 'PAUSE' AND substr(c.budget_updated_at, 1, 7) = strftime('%Y-%m', 'now') ${accFilter}) as month_paused,
        (SELECT MAX(c.updated_at) FROM ad_config c ${accWhere}) as last_sync_time
      FROM agg
    `).get();

    const responseData = { success: true, data: summary || {}, target_cpm: TARGET_CPM };
    apiCache.set(cacheKey, responseData);
    res.json(responseData);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/cpmess-targets',(req,res)=>{
  try{const workspaceId=Number(req.query.workspaceId||1);res.json({success:true,data:db.prepare('SELECT service,target_cpmess,updated_at FROM workspace_cpmess_targets WHERE workspace_id=? ORDER BY service').all(workspaceId)});}
  catch(e){res.status(500).json({success:false,error:e.message});}
});

router.post('/cpmess-targets',(req,res)=>{
  try{
    const targets=Array.isArray(req.body?.targets)?req.body.targets:[],workspaceId=Number(req.body?.workspaceId||1);
    if(!targets.length)throw new Error('Cần ít nhất một dịch vụ');
    const save=db.transaction(()=>{db.prepare('DELETE FROM workspace_cpmess_targets WHERE workspace_id=?').run(workspaceId);const insert=db.prepare(`INSERT INTO workspace_cpmess_targets(workspace_id,service,target_cpmess,updated_at) VALUES (?,?,?,datetime('now'))`);targets.forEach(item=>{const service=String(item.service||'').trim(),value=Math.round(Number(item.target_cpmess));if(!service||!Number.isFinite(value)||value<10000)throw new Error(`CPMess mục tiêu không hợp lệ: ${service||'chưa có tên'}`);insert.run(workspaceId,service,value);});});
    save();clearApiCache();res.json({success:true,message:'Đã lưu CPMess mục tiêu'});
  }catch(e){res.status(400).json({success:false,error:e.message});}
});

router.get('/classification-rules',(req,res)=>{try{const workspaceId=Number(req.query.workspaceId||1);res.json({success:true,data:db.prepare('SELECT id,kind,prefix,label,priority,updated_at FROM workspace_classification_rules WHERE workspace_id=? ORDER BY kind,priority DESC,LENGTH(prefix) DESC').all(workspaceId)});}catch(e){res.status(500).json({success:false,error:e.message});}});
const funnelTargetFields=['daily_budget','cost_per_message_max','messages_min','messages_max','qualified_leads_min','qualified_leads_max','bookings_min','bookings_max','shows_min','shows_max','purchases_min','cost_per_purchase_max','revenue_min','roas_min'];
router.get('/funnel-targets',(req,res)=>{try{const workspaceId=Number(req.query.workspaceId||0);if(!workspaceId)throw new Error('Thiếu profile');const row=db.prepare('SELECT targets_json,updated_at FROM workspace_funnel_targets WHERE workspace_id=?').get(workspaceId);res.json({success:true,data:row?{...JSON.parse(row.targets_json),updated_at:row.updated_at}:{}})}catch(e){res.status(400).json({success:false,error:e.message})}});
router.post('/funnel-targets',(req,res)=>{try{const workspaceId=Number(req.body?.workspaceId||0);if(!workspaceId)throw new Error('Thiếu profile');const source=req.body?.targets||{},clean={};funnelTargetFields.forEach(key=>{if(source[key]!==''&&source[key]!==null&&source[key]!==undefined){const value=Number(source[key]);if(!Number.isFinite(value)||value<0)throw new Error(`Chỉ số ${key} không hợp lệ`);clean[key]=value}});db.prepare(`INSERT INTO workspace_funnel_targets(workspace_id,targets_json,updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(workspace_id) DO UPDATE SET targets_json=excluded.targets_json,updated_at=datetime('now')`).run(workspaceId,JSON.stringify(clean));clearApiCache();res.json({success:true,data:clean,message:'Đã lưu mục tiêu phễu cho profile'})}catch(e){res.status(400).json({success:false,error:e.message})}});
router.post('/classification-rules',(req,res)=>{try{const rules=Array.isArray(req.body?.rules)?req.body.rules:[],workspaceId=Number(req.body?.workspaceId||1);const save=db.transaction(()=>{db.prepare('DELETE FROM workspace_classification_rules WHERE workspace_id=?').run(workspaceId);const insert=db.prepare(`INSERT INTO workspace_classification_rules(workspace_id,kind,prefix,label,priority,updated_at) VALUES (?,?,?,?,?,datetime('now'))`);rules.forEach((item,index)=>{const kind=String(item.kind),prefix=String(item.prefix||'').trim().toLowerCase(),label=String(item.label||'').trim();if(!['service','operator'].includes(kind)||!prefix||!label)throw new Error(`Quy tắc dòng ${index+1} chưa hợp lệ`);insert.run(workspaceId,kind,prefix,label,Number(item.priority||0));});});save();classificationCache.delete(workspaceId);clearApiCache();res.json({success:true,message:'Đã lưu quy tắc phân loại'});}catch(e){res.status(400).json({success:false,error:e.message});}});

function getBudgetAction(action) {
  switch (action) {
    case 'INCREASE_20':
      return { type: 'scale_20', percent: 20, direction: 'UP', allowUp: true, allowDown: false, allowPause: false, scalePercent: 20 };
    case 'INCREASE_10':
      return { type: 'scale_10', percent: 10, direction: 'UP', allowUp: true, allowDown: false, allowPause: false, scalePercent: 10 };
    case 'DECREASE_20':
      return { type: 'reduce_20', percent: -20, direction: 'DOWN', allowUp: false, allowDown: true, allowPause: true, scalePercent: -20 };
    case 'SUDDEN_DIP':
      return { type: 'reduce_20', percent: -20, direction: 'DOWN', allowUp: false, allowDown: true, allowPause: false, scalePercent: -20 };
    case 'PAUSE':
      return { type: 'pause', percent: null, direction: 'PAUSE', allowUp: false, allowDown: false, allowPause: true, scalePercent: 0 };
    case 'KEEP':
      return { type: 'keep', percent: 0, direction: 'HOLD', allowUp: false, allowDown: false, allowPause: false, scalePercent: 0 };
    case 'WAIT':
      return { type: 'wait', percent: 0, direction: 'HOLD', allowUp: false, allowDown: false, allowPause: false, scalePercent: 0 };
    case 'DECLINING':
    case 'NEW_CREATIVE':
    case 'NEW_HOOK':
    case 'FIX_CTA':
    default:
      return { type: 'keep', percent: 0, direction: 'HOLD', allowUp: false, allowDown: true, allowPause: true, scalePercent: 0 };
  }
}

function getActionType(action) {
  if (action === 'INCREASE_20' || action === 'INCREASE_10') return 'scale';
  if (action === 'DECREASE_20') return 'reduce';
  if (action === 'PAUSE') return 'pause';
  if (action === 'SUDDEN_DIP') return 'watch';
  return 'watch';
}

function evaluateAdRule({
  row,
  workspaceId = 1,
  primaryMetric = 'message',
  primaryLabel = 'Tin nhắn',
  primaryCount = 0,
  primaryCost = 0,
  primaryTarget = 250000,
  primary3d = null,
  primaryPrev3d = null,
  primaryTrendPct = null,
  primaryStable = true,
  changedRecently = false,
  ctrBase = 1.0,
  messRateBase = 1.0,
  target_cpmess,
  target_purchase,
  target_lead,
  funnelTargets
}) {
  const money = (val) => (val !== null && val !== undefined && !isNaN(val) && Number(val) > 0) ? Number(val).toLocaleString('vi-VN') + 'đ' : '—';

  const runDays = Number(row?.run_days || 0);
  const purchases = Number(row?.purchases || 0);
  const leads = Number(row?.leads || 0);
  const mess = Number(row?.mess || row?.mess_started || 0);
  const spend = Number(row?.spend || 0);
  const ctr = Number(row?.ctr || 0);
  const messRate = Number(row?.mess_rate || 0);
  const frequency = Number(row?.frequency || 0);
  const impressions = Number(row?.impressions || 0);
  const clicks = Number(row?.clicks || 0);

  const targetPurchase = Number(target_purchase || 0) || 2000000;
  const targetLead = Number(target_lead || 0) || 500000;
  const targetCpmess = Number(target_cpmess || (primaryMetric === 'message' ? primaryTarget : 0) || 0) || 200000;

  const daysWithMess = Number(row?.days_with_mess || 0);
  const messPrev3d = Number(row?.mess_prev_3d || 0);
  const cpmessPrev3d = Number(row?.cpmess_prev_3d || primaryPrev3d || (messPrev3d > 0 ? Math.round(Number(row?.spend_prev_3d || 0) / messPrev3d) : 0));
  const todaySpend = Number(row?.today_spend ?? row?.spend_today ?? 0);
  const todayMess = Number(row?.today_mess ?? row?.mess_today ?? 0);
  const spend3d = Number(row?.spend_3d || 0);
  const mess3d = Number(row?.mess_3d || 0);
  const trend3dPct = primaryTrendPct !== null ? primaryTrendPct : (row?.trend_3d_pct !== undefined && row?.trend_3d_pct !== null ? Number(row?.trend_3d_pct) : null);

  const hasGoodHistory = (
    daysWithMess >= 3 ||
    messPrev3d >= 2 ||
    (cpmessPrev3d > 0 && cpmessPrev3d <= targetCpmess * 1.2)
  );

  const hasSuddenDip = hasGoodHistory && (
    (todaySpend >= targetCpmess * 0.8 && todayMess <= 1) ||
    (spend3d >= targetCpmess * 0.8 && mess3d <= 1 && (daysWithMess >= 3 || messPrev3d >= 2)) ||
    (trend3dPct !== null && trend3dPct >= 40)
  );

  // Phân cấp đánh giá chỉ số: Purchase -> Lead -> Message -> 0 kết quả
  let evalMetric = primaryMetric;
  let evalLabel = primaryLabel;
  let evalCount = primaryCount;
  let evalCost = primaryCost;
  let evalTarget = primaryTarget;

  if (purchases > 0) {
    evalMetric = 'purchase';
    evalLabel = 'Purchase';
    evalCount = purchases;
    evalCost = purchases > 0 ? (primaryCost || Math.round(spend / purchases)) : primaryCost;
    evalTarget = targetPurchase;
  } else if (leads > 0) {
    evalMetric = 'lead';
    evalLabel = 'Lead';
    evalCount = leads;
    evalCost = leads > 0 ? (primaryCost || Math.round(spend / leads)) : primaryCost;
    evalTarget = targetLead;
  } else if (mess > 0) {
    evalMetric = 'message';
    evalLabel = 'Tin nhắn';
    evalCount = mess;
    evalCost = Number(row?.cpmess || primaryCost || (mess ? Math.round(spend / mess) : 0));
    evalTarget = targetCpmess;
  } else {
    evalMetric = 'message';
    evalLabel = 'Tin nhắn';
    evalCount = 0;
    evalCost = spend;
    evalTarget = targetCpmess;
  }

  // Giữ cấu hình ghi đè nếu caller cố ý truyền primaryMetric khớp
  if (primaryTarget && primaryTarget > 0 && primaryMetric === evalMetric) {
    evalTarget = primaryTarget;
  }
  if (primaryCost && primaryCost > 0 && primaryMetric === evalMetric) {
    evalCost = primaryCost;
  }
  if (primaryCount !== undefined && primaryCount !== null && primaryMetric === evalMetric) {
    evalCount = primaryCount;
  }

  const ratio = (evalCost > 0 && evalTarget > 0) ? evalCost / evalTarget : null;
  let action = 'KEEP', priority = 'LOW', title = 'Giữ nguyên', root_cause = 'SAFE_ZONE';
  let reason = `Đánh giá theo ${evalLabel}: ${evalCount} kết quả, chi phí ${evalCost ? money(evalCost) : '—'} / mục tiêu ${money(evalTarget)}.`;

  // 1. Ngân sách vừa điều chỉnh trong 36h
  if (changedRecently) {
    action = 'WAIT';
    priority = 'LOW';
    title = 'Chờ sau điều chỉnh';
    root_cause = 'RECENTLY_MODIFIED';
    reason = `Đánh giá theo ${evalLabel}: ${evalCount} kết quả, chi phí ${evalCost ? money(evalCost) : '—'} / mục tiêu ${money(evalTarget)}. Ngân sách vừa thay đổi trong 36 giờ; giữ nguyên để tránh nhiễu phân phối.`;
  }
  // 2. Giai đoạn máy học / Ad mới (< 3 ngày)
  else if (runDays < 3) {
    const isHighBurn = evalCount === 0 && (
      (evalTarget > 0 && spend >= evalTarget * 2) ||
      (targetPurchase > 0 && spend >= targetPurchase * 2)
    );
    if (isHighBurn) {
      action = 'DECREASE_20';
      priority = 'MEDIUM';
      title = 'Cảnh báo sớm · Giảm 20%';
      root_cause = 'HIGH_BURN_RATE';
      reason = `Đánh giá theo ${evalLabel}: ${evalCount} kết quả, chi phí ${evalCost ? money(evalCost) : '—'} / mục tiêu ${money(evalTarget)}. Ad còn mới (${runDays} ngày) nhưng đã tiêu ${(spend / (evalTarget || targetPurchase)).toFixed(1)}× mục tiêu mà chưa có kết quả.`;
    } else {
      action = 'WAIT';
      priority = 'LOW';
      title = 'Ad mới · Chờ ổn định';
      root_cause = 'LEARNING_PHASE';
      reason = `Đánh giá theo ${evalLabel}: ${evalCount} kết quả, chi phí ${evalCost ? money(evalCost) : '—'} / mục tiêu ${money(evalTarget)}. Mới ${runDays} ngày; giữ ngân sách để hoàn tất tối thiểu 3 ngày học máy.`;
    }
  }
  // 3. Ad mature (run_days >= 3) — ĐÃ QUA GIAI ĐOẠN HỌC MÁY
  else {
    // --- TẦNG 1: PURCHASE (purchases > 0) ---
    if (evalMetric === 'purchase') {
      if (ratio !== null && ratio >= 1.5) {
        action = 'PAUSE';
        priority = 'HIGH';
        title = 'Cân nhắc tắt';
        root_cause = 'COST_OVER_TARGET';
        reason = `Đánh giá theo Purchase: ${evalCount} kết quả, chi phí ${money(evalCost)} / mục tiêu ${money(evalTarget)}. Chi phí bằng ${Math.round(ratio * 100)}% mục tiêu (vượt ngưỡng 150%).`;
      } else if (ratio !== null && ratio > 1.2) {
        action = 'DECREASE_20';
        priority = 'MEDIUM';
        title = 'Giảm ngân sách 20%';
        root_cause = 'COST_OVER_TARGET';
        reason = `Đánh giá theo Purchase: ${evalCount} kết quả, chi phí ${money(evalCost)} / mục tiêu ${money(evalTarget)}. Chi phí bằng ${Math.round(ratio * 100)}% mục tiêu (vượt ngưỡng 120%).`;
      } else if (frequency >= 2.5) {
        action = 'NEW_CREATIVE';
        priority = 'MEDIUM';
        title = 'Tạo creative mới';
        root_cause = 'CREATIVE_FATIGUE';
        reason = `Frequency ${frequency}x cho thấy dấu hiệu bão hòa tệp khán giả; cần thay visual/video mới.`;
      } else if (impressions >= 1000 && ctr < ctrBase * 0.7) {
        action = 'NEW_HOOK';
        priority = 'MEDIUM';
        title = 'Test hook/thumbnail mới';
        root_cause = 'WEAK_HOOK';
        reason = `CTR ${ctr}% thấp hơn 30% so với chuẩn dịch vụ (${ctrBase.toFixed(2)}%); hook mở đầu chưa đủ thu hút.`;
      } else if (clicks >= 20 && messRate < messRateBase * 0.7) {
        action = 'FIX_CTA';
        priority = 'MEDIUM';
        title = 'Sửa CTA/offer';
        root_cause = 'WEAK_CTA';
        reason = `CTR ${ctr}% nhưng Mess Rate ${messRate}% thấp hơn chuẩn (${messRateBase.toFixed(2)}%); cần củng cố lời kêu gọi hành động hoặc ưu đãi.`;
      } else if (!primaryStable && primaryTrendPct !== null && ((primary3d && primary3d > evalTarget * 0.9) || (evalCost > evalTarget * 0.9))) {
        action = 'DECLINING';
        priority = 'MEDIUM';
        title = 'Đang tụt phong độ';
        root_cause = 'PERFORMANCE_DECLINING';
        reason = `Đánh giá theo Purchase: ${evalCount} kết quả. Chi phí 3 ngày tăng ${primaryTrendPct}% (đạt ${money(primary3d)}); chưa scale, theo dõi 24–48h.`;
      } else if (evalCount >= 5 && ratio !== null && ratio <= 0.5 && primaryStable) {
        action = 'INCREASE_20';
        priority = 'HIGH';
        title = 'Scale mạnh 20%';
        root_cause = 'GOOD_PERFORMANCE';
        reason = `Đánh giá theo Purchase: ${evalCount} kết quả, chi phí chỉ bằng ${Math.round(ratio * 100)}% mục tiêu (${money(evalCost)} / ${money(evalTarget)}) và phong độ 3 ngày ổn định.`;
      } else if (evalCount >= 3 && ratio !== null && ratio <= 0.5 && primary3d && primary3d <= evalTarget) {
        action = 'INCREASE_10';
        priority = 'MEDIUM';
        title = 'Scale nhẹ 10%';
        root_cause = 'GOOD_PERFORMANCE';
        reason = `Đánh giá theo Purchase: ${evalCount} kết quả, chi phí chỉ bằng ${Math.round(ratio * 100)}% mục tiêu (${money(evalCost)} / ${money(evalTarget)}); chi phí 3 ngày (${money(primary3d)}) vẫn đạt chuẩn. Tăng thận trọng 10% và theo dõi 24–48h.`;
      } else if (evalCount >= 3 && ratio !== null && ratio <= 1.0 && !primaryStable) {
        action = 'DECLINING';
        priority = 'MEDIUM';
        title = 'Đạt target nhưng đang xấu đi';
        root_cause = 'PERFORMANCE_DECLINING';
        reason = `Đánh giá theo Purchase: ${evalCount} kết quả. Chi phí vẫn đạt target nhưng chi phí 3 ngày gần đây tăng ${primaryTrendPct}%; giữ ngân sách, chưa scale hoặc giảm vội.`;
      } else if (evalCount >= 3 && ratio !== null && ratio <= 1.0 && primaryStable) {
        action = 'INCREASE_10';
        priority = 'MEDIUM';
        title = 'Scale nhẹ 10%';
        root_cause = 'GOOD_PERFORMANCE';
        reason = `Đánh giá theo Purchase: ${evalCount} kết quả, chi phí bằng ${Math.round(ratio * 100)}% mục tiêu (${money(evalCost)} / ${money(evalTarget)}) và xu hướng ổn định; tăng thận trọng 10% và theo dõi 24–48h.`;
      } else {
        action = 'KEEP';
        priority = 'LOW';
        title = 'Giữ nguyên';
        root_cause = 'SAFE_ZONE';
        reason = `Đánh giá theo Purchase: ${evalCount} kết quả, chi phí ${money(evalCost)} / mục tiêu ${money(evalTarget)}. Hiệu suất đang trong vùng an toàn.`;
      }
    }
    // --- TẦNG 2: LEAD (leads > 0, purchases === 0) ---
    else if (evalMetric === 'lead') {
      if (targetPurchase > 0 && spend >= targetPurchase * 2) {
        action = 'PAUSE';
        priority = 'HIGH';
        title = 'Cân nhắc tắt';
        root_cause = 'NO_CONVERSIONS';
        reason = `Đã chạy ${runDays} ngày và tiêu ${money(spend)} (${(spend / targetPurchase).toFixed(1)}× mục tiêu Purchase ${money(targetPurchase)}) nhưng chưa tạo được Purchase nào.`;
      } else if (ratio !== null && ratio >= 1.5) {
        action = 'PAUSE';
        priority = 'HIGH';
        title = 'Cân nhắc tắt';
        root_cause = 'COST_OVER_TARGET';
        reason = `Đánh giá theo Lead: ${evalCount} kết quả, chi phí ${money(evalCost)} / mục tiêu ${money(evalTarget)}. Chi phí bằng ${Math.round(ratio * 100)}% mục tiêu (vượt ngưỡng 150%).`;
      } else if (ratio !== null && ratio > 1.2) {
        action = 'DECREASE_20';
        priority = 'MEDIUM';
        title = 'Giảm ngân sách 20%';
        root_cause = 'COST_OVER_TARGET';
        reason = `Đánh giá theo Lead: ${evalCount} kết quả, chi phí ${money(evalCost)} / mục tiêu ${money(evalTarget)}. Chi phí bằng ${Math.round(ratio * 100)}% mục tiêu (vượt ngưỡng 120%).`;
      } else if (frequency >= 2.5) {
        action = 'NEW_CREATIVE';
        priority = 'MEDIUM';
        title = 'Tạo creative mới';
        root_cause = 'CREATIVE_FATIGUE';
        reason = `Frequency ${frequency}x cho thấy dấu hiệu bão hòa tệp khán giả; cần thay visual/video mới.`;
      } else if (impressions >= 1000 && ctr < ctrBase * 0.7) {
        action = 'NEW_HOOK';
        priority = 'MEDIUM';
        title = 'Test hook/thumbnail mới';
        root_cause = 'WEAK_HOOK';
        reason = `CTR ${ctr}% thấp hơn 30% so với chuẩn dịch vụ (${ctrBase.toFixed(2)}%); hook mở đầu chưa đủ thu hút.`;
      } else if (clicks >= 20 && messRate < messRateBase * 0.7) {
        action = 'FIX_CTA';
        priority = 'MEDIUM';
        title = 'Sửa CTA/offer';
        root_cause = 'WEAK_CTA';
        reason = `CTR ${ctr}% nhưng Mess Rate ${messRate}% thấp hơn chuẩn (${messRateBase.toFixed(2)}%); cần củng cố lời kêu gọi hành động hoặc ưu đãi.`;
      } else if (evalCount >= 5 && ratio !== null && ratio <= 0.5 && primaryStable) {
        action = 'INCREASE_20';
        priority = 'HIGH';
        title = 'Scale mạnh 20%';
        root_cause = 'GOOD_PERFORMANCE';
        reason = `Chi phí chỉ bằng ${Math.round(ratio * 100)}% mục tiêu, mẫu đủ (${evalCount} Lead) và phong độ 3 ngày ổn định.`;
      } else if (evalCount >= 3 && ratio !== null && ratio <= 0.5 && primary3d && primary3d <= evalTarget) {
        action = 'INCREASE_10';
        priority = 'MEDIUM';
        title = 'Scale nhẹ 10%';
        root_cause = 'GOOD_PERFORMANCE';
        reason = `Chi phí Lead chỉ bằng ${Math.round(ratio * 100)}% mục tiêu; chi phí 3 ngày (${money(primary3d)}) vẫn đạt chuẩn. Tăng thận trọng 10% và theo dõi 24–48h.`;
      } else if (evalCount >= 3 && ratio !== null && ratio <= 1.0 && primaryStable) {
        action = 'INCREASE_10';
        priority = 'MEDIUM';
        title = 'Scale nhẹ 10%';
        root_cause = 'GOOD_PERFORMANCE';
        reason = `Chi phí Lead bằng ${Math.round(ratio * 100)}% mục tiêu và xu hướng ổn định; tăng thận trọng 10% và theo dõi 24–48h.`;
      } else {
        action = 'KEEP';
        priority = 'LOW';
        title = 'Giữ nguyên';
        root_cause = 'SAFE_ZONE';
        reason = `Đã chạy ${runDays} ngày; có ${evalCount} Lead (chi phí ${money(evalCost)} / mục tiêu ${money(evalTarget)}), hiệu suất ổn định. Tiếp tục theo dõi chuyển đổi.`;
      }
    }
    // --- TẦNG 3: TIN NHẮN (mess > 0, leads === 0, purchases === 0) ---
    else if (evalCount > 0) {
      const effectiveTargetCpmess = evalTarget || targetCpmess || 200000;
      const effectiveCpmess = evalCost || Math.round(spend / evalCount);

      if (hasSuddenDip) {
        action = 'SUDDEN_DIP';
        priority = 'MEDIUM';
        title = '⚠️ Đột biến giảm trong ngày · Cần theo dõi 24h';
        root_cause = 'SUDDEN_PERFORMANCE_DIP';
        const histDetail = daysWithMess > 0 ? `${daysWithMess} ngày ra mess đều` : 'lịch sử chạy tốt';
        const prevCostDetail = cpmessPrev3d > 0 ? `, CPMess cũ ${money(cpmessPrev3d)}` : '';
        const dipSpendVal = todaySpend || spend3d || spend;
        reason = `Lịch sử chạy rất tốt (${histDetail}${prevCostDetail}), nhưng hôm nay đột ngột chững tin nhắn sau khi tiêu ${money(dipSpendVal)}. Không nên tắt ngay làm hỏng tệp.`;
      }
      // 3.1. Quá trần chi tiêu Purchase (tiêu >= 2x target_purchase mà 0 purchase)
      else if (targetPurchase > 0 && spend >= targetPurchase * 2) {
        action = 'PAUSE';
        priority = 'HIGH';
        title = 'Cân nhắc tắt';
        root_cause = 'NO_CONVERSIONS';
        reason = `Đã chạy ${runDays} ngày và tiêu ${money(spend)} (${(spend / targetPurchase).toFixed(1)}× mục tiêu Purchase ${money(targetPurchase)}) nhưng chưa tạo được Purchase nào.`;
      }
      // 3.2. CPMess vượt mục tiêu (> 1.2x target_cpmess, ví dụ 292k > 200k)
      else if (effectiveCpmess > effectiveTargetCpmess * 1.2) {
        if (impressions >= 1000 && ctr < ctrBase * 0.7) {
          action = 'NEW_HOOK';
          priority = 'MEDIUM';
          title = 'Test hook/thumbnail mới';
          root_cause = 'WEAK_HOOK';
          reason = `Đã chạy ${runDays} ngày, có ${evalCount} tin nhắn nhưng CPMess (${money(effectiveCpmess)}) vượt mục tiêu ${money(effectiveTargetCpmess)} và chưa tạo Purchase sau ${money(spend)} chi tiêu. CTR ${ctr}% thấp hơn 30% chuẩn (${ctrBase.toFixed(2)}%), cần đổi hook/thumbnail mới.`;
        } else if (clicks >= 20 && messRate < messRateBase * 0.7) {
          action = 'FIX_CTA';
          priority = 'MEDIUM';
          title = 'Sửa CTA/offer';
          root_cause = 'WEAK_CTA';
          reason = `Đã chạy ${runDays} ngày, có ${evalCount} tin nhắn nhưng CPMess (${money(effectiveCpmess)}) vượt mục tiêu ${money(effectiveTargetCpmess)} và chưa tạo Purchase sau ${money(spend)} chi tiêu. Mess Rate ${messRate}% thấp hơn chuẩn (${messRateBase.toFixed(2)}%), cần củng cố lời kêu gọi hành động hoặc ưu đãi.`;
        } else if (ratio !== null && ratio >= 1.5 && (spend >= targetPurchase * 1.5 || workspaceId === 1)) {
          action = 'PAUSE';
          priority = 'HIGH';
          title = 'Cân nhắc tắt';
          root_cause = 'COST_OVER_TARGET';
          reason = `Đánh giá theo Tin nhắn: ${evalCount} kết quả, chi phí ${money(effectiveCpmess)} / mục tiêu ${money(effectiveTargetCpmess)}. Chi phí bằng ${Math.round(ratio * 100)}% mục tiêu (vượt ngưỡng 150%).`;
        } else {
          action = 'DECREASE_20';
          priority = 'MEDIUM';
          title = 'Giảm ngân sách 20%';
          root_cause = 'COST_OVER_TARGET';
          reason = `Đã chạy ${runDays} ngày, có ${evalCount} tin nhắn nhưng CPMess (${money(effectiveCpmess)}) vượt mục tiêu ${money(effectiveTargetCpmess)} và chưa tạo Purchase sau ${money(spend)} chi tiêu. Cần giảm ngân sách và làm mới nội dung.`;
        }
      }
      // 3.3. Tín hiệu Creative fatigue / Hook / CTA
      else if (frequency >= 2.5) {
        action = 'NEW_CREATIVE';
        priority = 'MEDIUM';
        title = 'Tạo creative mới';
        root_cause = 'CREATIVE_FATIGUE';
        reason = `Frequency ${frequency}x cho thấy dấu hiệu bão hòa tệp khán giả; cần thay visual/video mới.`;
      } else if (impressions >= 1000 && ctr < ctrBase * 0.7) {
        action = 'NEW_HOOK';
        priority = 'MEDIUM';
        title = 'Test hook/thumbnail mới';
        root_cause = 'WEAK_HOOK';
        reason = `CTR ${ctr}% thấp hơn 30% so với chuẩn dịch vụ (${ctrBase.toFixed(2)}%); hook mở đầu chưa đủ thu hút.`;
      } else if (clicks >= 20 && messRate < messRateBase * 0.7) {
        action = 'FIX_CTA';
        priority = 'MEDIUM';
        title = 'Sửa CTA/offer';
        root_cause = 'WEAK_CTA';
        reason = `CTR ${ctr}% nhưng Mess Rate ${messRate}% thấp hơn chuẩn (${messRateBase.toFixed(2)}%); cần củng cố lời kêu gọi hành động hoặc ưu đãi.`;
      }
      // 3.4. CPMess tốt (cpmess <= target_cpmess) và tiêu chưa vượt trần Purchase (< 1.5x target_purchase) -> KEEP hoặc SCALE
      else if (effectiveCpmess <= effectiveTargetCpmess) {
        if (evalCount >= 5 && ratio !== null && ratio <= 0.5 && primaryStable) {
          action = 'INCREASE_20';
          priority = 'HIGH';
          title = 'Scale mạnh 20%';
          root_cause = 'GOOD_PERFORMANCE';
          reason = `Chi phí chỉ bằng ${Math.round(ratio * 100)}% mục tiêu, mẫu đủ (${evalCount} kết quả) và phong độ 3 ngày ổn định.`;
        } else if (evalCount >= 3 && ratio !== null && ratio <= 0.5 && primary3d && primary3d <= effectiveTargetCpmess) {
          action = 'INCREASE_10';
          priority = 'MEDIUM';
          title = 'Scale nhẹ 10%';
          root_cause = 'GOOD_PERFORMANCE';
          reason = `Chi phí chỉ bằng ${Math.round(ratio * 100)}% mục tiêu; chi phí 3 ngày (${money(primary3d)}) vẫn đạt chuẩn. Tăng thận trọng 10% và theo dõi 24–48h.`;
        } else if (evalCount >= 3 && ratio !== null && ratio <= 1.0 && !primaryStable) {
          action = 'DECLINING';
          priority = 'MEDIUM';
          title = 'Đạt target nhưng đang xấu đi';
          root_cause = 'PERFORMANCE_DECLINING';
          reason = `Chi phí vẫn đạt target nhưng chi phí 3 ngày gần đây tăng ${primaryTrendPct}%; giữ ngân sách, chưa scale hoặc giảm vội.`;
        } else if (evalCount >= 3 && ratio !== null && ratio <= 1.0 && primaryStable && (workspaceId === 1 || targetPurchase === 0)) {
          action = 'INCREASE_10';
          priority = 'MEDIUM';
          title = 'Scale nhẹ 10%';
          root_cause = 'GOOD_PERFORMANCE';
          reason = `Chi phí bằng ${Math.round(ratio * 100)}% mục tiêu và xu hướng ổn định; tăng thận trọng 10% và theo dõi 24–48h.`;
        } else if (workspaceId === 2 && evalCount >= 10 && spend >= targetPurchase) {
          action = 'DECLINING';
          priority = 'MEDIUM';
          title = 'Nghẽn khâu chốt đơn';
          root_cause = 'PERFORMANCE_DECLINING';
          reason = `CPMess (${money(effectiveCpmess)}) đạt mục tiêu (${money(effectiveTargetCpmess)}) nhưng chưa tạo Purchase sau ${evalCount} tin nhắn (${money(spend)} chi tiêu); nghẽn ở khâu tư vấn/chốt đơn hoặc cần tối ưu CTA.`;
        } else {
          action = 'KEEP';
          priority = 'LOW';
          title = 'Giữ nguyên';
          root_cause = 'SAFE_ZONE';
          reason = `Đã chạy ${runDays} ngày; có ${evalCount} tin nhắn, CPMess (${money(effectiveCpmess)}) đạt mục tiêu ${money(effectiveTargetCpmess)}. Tiếp tục theo dõi chuyển đổi.`;
        }
      }
      // 3.5. CPMess trong khoảng 1.0x - 1.2x target
      else {
        action = 'KEEP';
        priority = 'LOW';
        title = 'Giữ nguyên';
        root_cause = 'SAFE_ZONE';
        reason = `Đã chạy ${runDays} ngày; có ${evalCount} tin nhắn, CPMess (${money(effectiveCpmess)}) sát ngưỡng mục tiêu ${money(effectiveTargetCpmess)}. Tiếp tục theo dõi.`;
      }
    }
    // --- TẦNG 4: 0 KẾT QUẢ (mess === 0, leads === 0, purchases === 0) ---
    else {
      const effectiveTargetCpmess = evalTarget || targetCpmess || 200000;
      if (hasSuddenDip) {
        action = 'SUDDEN_DIP';
        priority = 'MEDIUM';
        title = '⚠️ Đột biến giảm trong ngày · Cần theo dõi 24h';
        root_cause = 'SUDDEN_PERFORMANCE_DIP';
        const histDetail = daysWithMess > 0 ? `${daysWithMess} ngày ra mess đều` : 'lịch sử chạy tốt';
        const prevCostDetail = cpmessPrev3d > 0 ? `, CPMess cũ ${money(cpmessPrev3d)}` : '';
        const dipSpendVal = todaySpend || spend3d || spend;
        reason = `Lịch sử chạy rất tốt (${histDetail}${prevCostDetail}), nhưng hôm nay đột ngột chững tin nhắn sau khi tiêu ${money(dipSpendVal)}. Không nên tắt ngay làm hỏng tệp.`;
      } else if (spend >= effectiveTargetCpmess * 2) {
        action = 'PAUSE';
        priority = 'HIGH';
        title = 'Cân nhắc tắt';
        root_cause = 'NO_CONVERSIONS';
        reason = `Đã chạy ${runDays} ngày và tiêu ${money(spend)} (≥2× mục tiêu CPMess ${money(effectiveTargetCpmess)}) mà chưa có tin nhắn hay chuyển đổi nào.`;
      } else if (spend >= effectiveTargetCpmess * 1) {
        action = 'DECREASE_20';
        priority = 'MEDIUM';
        title = 'Giảm 20% · Chưa có tin nhắn';
        root_cause = 'COST_OVER_TARGET';
        reason = `Đã chạy ${runDays} ngày, tiêu ${money(spend)} (≥ mục tiêu CPMess ${money(effectiveTargetCpmess)}) nhưng chưa có tin nhắn. Giảm 20% ngân sách để kiểm soát rủi ro.`;
      } else if (impressions >= 1000 && ctr < ctrBase * 0.7) {
        action = 'NEW_HOOK';
        priority = 'MEDIUM';
        title = 'Test hook/thumbnail mới';
        root_cause = 'WEAK_HOOK';
        reason = `CTR ${ctr}% thấp hơn 30% so với chuẩn dịch vụ (${ctrBase.toFixed(2)}%); hook mở đầu chưa đủ thu hút.`;
      } else {
        action = 'KEEP';
        priority = 'LOW';
        title = 'Giữ nguyên';
        root_cause = 'SAFE_ZONE';
        reason = `Đã chạy ${runDays} ngày; chi tiêu ${money(spend)} chưa vượt ngưỡng mục tiêu CPMess ${money(effectiveTargetCpmess)}. Tiếp tục theo dõi.`;
      }
    }
  }

  const budget_action = getBudgetAction(action);
  const action_type = getActionType(action);

  return { action, priority, title, reason, action_type, budget_action, root_cause };
}

// GET /api/ads/rule-optimizations — deterministic optimization, no LLM
router.get('/rule-optimizations', (req, res) => {
  try {
    const workspaceId = Number(req.query.workspaceId || 1);
    const wsAccounts = db.prepare('SELECT account_id FROM workspace_ad_accounts WHERE workspace_id = ?').all(workspaceId).map(r => String(r.account_id));
    const accountIds = new Set(String(req.query.account_ids || req.query.account_id || '').split(',').map(x => x.trim()).filter(Boolean));
    if (!accountIds.size && wsAccounts.length > 0) {
      wsAccounts.forEach(id => accountIds.add(id));
    }
    const totalWsAccs = db.prepare('SELECT COUNT(*) as count FROM workspace_ad_accounts').get()?.count || 0;

    const accIdsStr = Array.from(accountIds).sort().join(',');
    const cacheKey = `rule_optimizations_ws${workspaceId}_${accIdsStr}`;
    const cached = apiCache.get(cacheKey);
    if (cached) return res.json(cached);

    const maxDate = db.prepare('SELECT MAX(date) AS val FROM ad_daily_stats').get()?.val || new Date().toISOString().slice(0, 10);

    const accList = Array.from(accountIds);
    let whereClause = '';
    let historyWhere = '';
    const params = { maxDate };
    const historyParams = { maxDate };

    if (accList.length > 0) {
      const placeholders = accList.map((_, i) => `@acc${i}`).join(',');
      whereClause = `WHERE c.account_id IN (${placeholders})`;
      historyWhere = `AND c.account_id IN (${placeholders})`;
      accList.forEach((id, i) => {
        params[`acc${i}`] = id;
        historyParams[`acc${i}`] = id;
      });
    } else if (totalWsAccs > 0) {
      whereClause = 'WHERE 1 = 0';
      historyWhere = 'AND 1 = 0';
    }

    const rows = db.prepare(`
      SELECT c.ad_id, c.ad_name, c.ad_status, c.adset_status, c.campaign_status,
        c.account_id, c.adset_id, c.adset_name, c.campaign_name, c.budget_updated_at,
        c.targeting,
        c.budget_type,
        c.adset_daily_budget,
        c.adset_lifetime_budget,
        c.campaign_daily_budget,
        c.campaign_lifetime_budget,
        c.adset_end_time,
        c.campaign_end_time,
        COALESCE(NULLIF(CAST(c.adset_budget AS INTEGER),0), CAST(c.campaign_budget AS INTEGER),0) AS budget,
        COALESCE(alt.all_time_spend, 0) AS all_time_spend,
        COALESCE(alt.all_time_mess, 0) AS all_time_mess,
        alt.first_run_date AS first_run_date,
        alt.last_run_date AS last_run_date,
        COUNT(DISTINCT CASE WHEN s.spend > 0 THEN s.date END) AS run_days,
        ROUND(SUM(s.spend),0) AS spend, SUM(s.mess_started) AS mess,
        SUM(s.leads) AS leads, SUM(s.purchases) AS purchases,
        ROUND(SUM(CASE WHEN s.date = @maxDate THEN s.spend ELSE 0 END),0) AS today_spend,
        SUM(CASE WHEN s.date = @maxDate THEN s.mess_started ELSE 0 END) AS today_mess,
        SUM(CASE WHEN s.date = @maxDate THEN s.leads ELSE 0 END) AS today_leads,
        SUM(CASE WHEN s.date = @maxDate THEN s.purchases ELSE 0 END) AS today_purchases,
        ROUND(SUM(CASE WHEN s.date >= date(@maxDate,'-2 days') THEN s.spend ELSE 0 END),0) AS spend_3d,
        SUM(CASE WHEN s.date >= date(@maxDate,'-2 days') THEN s.mess_started ELSE 0 END) AS mess_3d,
        SUM(CASE WHEN s.date >= date(@maxDate,'-2 days') THEN s.leads ELSE 0 END) AS leads_3d,
        SUM(CASE WHEN s.date >= date(@maxDate,'-2 days') THEN s.purchases ELSE 0 END) AS purchases_3d,
        ROUND(SUM(CASE WHEN s.date BETWEEN date(@maxDate,'-5 days') AND date(@maxDate,'-3 days') THEN s.spend ELSE 0 END),0) AS spend_prev_3d,
        SUM(CASE WHEN s.date BETWEEN date(@maxDate,'-5 days') AND date(@maxDate,'-3 days') THEN s.mess_started ELSE 0 END) AS mess_prev_3d,
        SUM(CASE WHEN s.date BETWEEN date(@maxDate,'-5 days') AND date(@maxDate,'-3 days') THEN s.leads ELSE 0 END) AS leads_prev_3d,
        SUM(CASE WHEN s.date BETWEEN date(@maxDate,'-5 days') AND date(@maxDate,'-3 days') THEN s.purchases ELSE 0 END) AS purchases_prev_3d,
        COUNT(DISTINCT CASE WHEN s.mess_started > 0 THEN s.date END) AS days_with_mess,
        SUM(s.impressions) AS impressions, SUM(s.clicks) AS clicks,
        ROUND(AVG(s.frequency),2) AS frequency,
        CASE WHEN SUM(s.mess_started)>0 THEN ROUND(SUM(s.spend)/SUM(s.mess_started),0) END AS cpmess,
        CASE WHEN SUM(s.impressions)>0 THEN ROUND(SUM(s.clicks)*100.0/SUM(s.impressions),2) ELSE 0 END AS ctr,
        CASE WHEN SUM(s.clicks)>0 THEN ROUND(SUM(s.mess_started)*100.0/SUM(s.clicks),2) ELSE 0 END AS mess_rate
      FROM ad_config c
      LEFT JOIN (
        SELECT ad_id, ROUND(SUM(spend),0) AS all_time_spend, SUM(mess_started) AS all_time_mess, MIN(date) AS first_run_date, MAX(date) AS last_run_date
        FROM ad_daily_stats
        GROUP BY ad_id
      ) alt ON alt.ad_id = c.ad_id
      LEFT JOIN ad_daily_stats s ON s.ad_id = c.ad_id
        AND s.date >= date(@maxDate, '-6 days')
      ${whereClause}
      GROUP BY c.ad_id
    `).all(params).map(row => ({ ...row, service:parseService(row.ad_name,workspaceId), active:row.ad_status==='ACTIVE'&&row.adset_status==='ACTIVE'&&row.campaign_status==='ACTIVE' }));

    const history = db.prepare(`
      SELECT s.date, s.ad_name, c.account_id, SUM(s.spend) spend, SUM(s.mess_started) mess, SUM(s.leads) leads, SUM(s.purchases) purchases
      FROM ad_daily_stats s
      LEFT JOIN ad_config c ON c.ad_id = s.ad_id
      WHERE s.date >= date(@maxDate, '-29 days') ${historyWhere}
      GROUP BY s.date, s.ad_id
    `).all(historyParams);
    const daily = new Map();
    history.forEach(row => { const service=parseService(row.ad_name,workspaceId), key=`${service}|${row.date}`, item=daily.get(key)||{service,date:row.date,spend:0,mess:0}; item.spend+=Number(row.spend)||0; item.mess+=Number(row.mess)||0; daily.set(key,item); });
    const globalValues = [...daily.values()].filter(x => x.mess > 0).map(x => x.spend / x.mess);
    const globalBenchmark = Math.max(Math.round(median(globalValues)) || TARGET_CPM, 200000);
    const benchmarks = {};
    [...new Set(rows.map(r => r.service))].forEach(service => {
      const days = [...daily.values()].filter(x => x.service === service && x.mess > 0);
      const total = days.reduce((s, x) => s + x.mess, 0);
      benchmarks[service] = days.length >= 7 && total >= 20 ? Math.max(Math.round(median(days.map(x => x.spend / x.mess))), 200000) : globalBenchmark;
    });

    const configuredTargets = {};
    db.prepare(`SELECT service,target_cpmess FROM workspace_cpmess_targets WHERE workspace_id=?`).all(workspaceId).forEach(item => {
      configuredTargets[item.service] = Number(item.target_cpmess);
    });
    let funnelTargets = {};
    try {
      const saved = db.prepare('SELECT targets_json FROM workspace_funnel_targets WHERE workspace_id=?').get(workspaceId);
      funnelTargets = saved ? JSON.parse(saved.targets_json) : {};
    } catch (_) {}
    
    // Funnel conversion targets from historical 30D data
    const conversionTargets = { lead: { global: 0, services: {} }, purchase: { global: 0, services: {} } };
    for (const metric of ['lead', 'purchase']) {
      const field = metric === 'lead' ? 'leads' : 'purchases';
      const totals = history.reduce((a, r) => (a.spend += Number(r.spend) || 0, a.results += Number(r[field]) || 0, a), { spend: 0, results: 0 });
      conversionTargets[metric].global = totals.results ? Math.round(totals.spend / totals.results) : 0;
      const grouped = {};
      history.forEach(r => {
        const service = parseService(r.ad_name, workspaceId);
        const g = grouped[service] || (grouped[service] = { spend: 0, results: 0 });
        g.spend += Number(r.spend) || 0;
        g.results += Number(r[field]) || 0;
      });
      Object.entries(grouped).forEach(([service, g]) => {
        if (g.results >= 10) conversionTargets[metric].services[service] = Math.round(g.spend / g.results);
      });
    }

    const serviceMetrics = {};
    rows.filter(r => r.active).forEach(row => {
      if (!serviceMetrics[row.service]) serviceMetrics[row.service] = { ctr: [], messRate: [] };
      if (row.impressions >= 500) serviceMetrics[row.service].ctr.push(Number(row.ctr));
      if (row.clicks >= 20) serviceMetrics[row.service].messRate.push(Number(row.mess_rate));
    });

    const money = (val) => (val !== null && val !== undefined && !isNaN(val) && Number(val) > 0) ? Number(val).toLocaleString('vi-VN') + 'đ' : '—';

    const recommendations = rows.filter(row => row.active).map(row => {
      const benchmark = Math.max(benchmarks[row.service] || globalBenchmark, 200000);
      const target = Number(configuredTargets[row.service]) || Number(funnelTargets.cost_per_message_max) || benchmark || 200000;
      const targetSource = configuredTargets[row.service] ? 'service_configured' : (funnelTargets.cost_per_message_max ? 'profile_configured' : 'historical_fallback');
      const ctrBase = median(serviceMetrics[row.service]?.ctr || []) || 1;
      const messRateBase = median(serviceMetrics[row.service]?.messRate || []) || 1;
      const cpmess3d = row.mess_3d ? Math.round(row.spend_3d / row.mess_3d) : null;
      const prevCpmess3d = row.mess_prev_3d ? Math.round(row.spend_prev_3d / row.mess_prev_3d) : null;
      const trendPct = cpmess3d && prevCpmess3d ? Math.round((cpmess3d - prevCpmess3d) * 100 / prevCpmess3d) : null;
      const stable = trendPct === null || trendPct <= 20;
      const changedRecently = row.budget_updated_at && new Date(`${row.budget_updated_at}Z`).getTime() > Date.now() - 36 * 3600000;

      const asDaily = Number(row.adset_daily_budget) || 0;
      const asLifetime = Number(row.adset_lifetime_budget) || 0;
      const cmpDaily = Number(row.campaign_daily_budget) || 0;
      const cmpLifetime = Number(row.campaign_lifetime_budget) || 0;
      const rawAdset = Number(row.budget || row.adset_budget) || 0;
      const rawCamp = Number(row.campaign_budget) || 0;
      const rawBudget = asDaily || asLifetime || cmpDaily || cmpLifetime || rawAdset || rawCamp || 0;
      const hasEndTime = Boolean((row.adset_end_time && String(row.adset_end_time).trim()) || (row.campaign_end_time && String(row.campaign_end_time).trim()));
      const noDailyBudget = asDaily === 0 && cmpDaily === 0;

      const adsetName = String(row.adset_name || '');
      const campaignName = String(row.campaign_name || '');
      const adName = String(row.ad_name || '');
      const isMtCamp = adsetName.includes('MT 26-5') || campaignName.includes('MT 26-5') || adName.includes('MT 26-5');

      let isLifetime = false;
      if (row.budget_type === 'LIFETIME' || isMtCamp || asLifetime > 0 || cmpLifetime > 0 || rawBudget >= 2000000 || (hasEndTime && noDailyBudget)) {
        isLifetime = true;
      } else if (row.budget_type === 'DAILY') {
        isLifetime = false;
      } else {
        isLifetime = (asLifetime > 0 && asDaily === 0) || (asDaily === 0 && asLifetime === 0 && cmpLifetime > 0 && cmpDaily === 0);
      }

      const isCboLifetime = (cmpLifetime > 0 && asLifetime === 0) || (rawCamp > 0 && rawAdset === 0 && asLifetime === 0);
      const lifetime_budget = isLifetime ? (isCboLifetime ? (cmpLifetime || rawCamp) : (asLifetime || rawAdset || cmpLifetime || rawCamp || (rawBudget >= 2000000 ? rawBudget : (isMtCamp ? 10000000 : rawBudget)))) : 0;
      const all_time_spend = Number(row.all_time_spend || 0);
      const all_time_mess = Number(row.all_time_mess || 0);
      const lifetime_spend = isLifetime ? all_time_spend : 0;
      const lifetime_spend_pct = isLifetime ? (lifetime_budget > 0 ? Math.round((all_time_spend / lifetime_budget) * 100) : 0) : null;

      // 1. Chuẩn hóa mục tiêu phễu 3 tầng
      const histPurchaseTarget = Number(conversionTargets.purchase.services[row.service]) || Number(conversionTargets.purchase.global) || 0;
      const targetPurchase = Number(funnelTargets.cost_per_purchase_max) || (histPurchaseTarget >= 2000000 ? histPurchaseTarget : 2000000);

      const histLeadTarget = Number(conversionTargets.lead.services[row.service]) || Number(conversionTargets.lead.global) || 0;
      const targetLead = Number(funnelTargets.cost_per_lead_max) || (histLeadTarget >= 500000 ? histLeadTarget : 500000);

      const cpmess = Number(row.mess) > 0 ? (Number(row.cpmess) || Math.round(Number(row.spend) / Number(row.mess))) : null;
      const costPerLead = Number(row.leads) > 0 ? Math.round(Number(row.spend) / Number(row.leads)) : null;
      const costPerPurchase = Number(row.purchases) > 0 ? Math.round(Number(row.spend) / Number(row.purchases)) : null;

      // 2. Phân cấp đánh giá chỉ số: Purchase -> Lead -> Mess -> 0 kết quả
      let primaryMetric = 'message', primaryLabel = 'Tin nhắn';
      let primaryCount = Number(row.mess || 0);
      let primaryCost = cpmess || 0;
      let primaryTarget = target;
      let primary3d = cpmess3d;
      let primaryPrev3d = prevCpmess3d;

      if (Number(row.purchases) > 0) {
        primaryMetric = 'purchase';
        primaryLabel = 'Purchase';
        primaryCount = Number(row.purchases || 0);
        primaryCost = costPerPurchase || 0;
        primaryTarget = targetPurchase;
        primary3d = row.purchases_3d ? Math.round(row.spend_3d / row.purchases_3d) : null;
        primaryPrev3d = row.purchases_prev_3d ? Math.round(row.spend_prev_3d / row.purchases_prev_3d) : null;
      } else if (Number(row.leads) > 0) {
        primaryMetric = 'lead';
        primaryLabel = 'Lead';
        primaryCount = Number(row.leads || 0);
        primaryCost = costPerLead || 0;
        primaryTarget = targetLead;
        primary3d = row.leads_3d ? Math.round(row.spend_3d / row.leads_3d) : null;
        primaryPrev3d = row.leads_prev_3d ? Math.round(row.spend_prev_3d / row.leads_prev_3d) : null;
      }

      const primaryTrendPct = primary3d && primaryPrev3d ? Math.round((primary3d - primaryPrev3d) * 100 / primaryPrev3d) : null;
      const primaryStable = primaryTrendPct === null || primaryTrendPct <= 20;

      const ruleEval = evaluateAdRule({
        row,
        workspaceId,
        primaryMetric,
        primaryLabel,
        primaryCount,
        primaryCost,
        primaryTarget,
        primary3d,
        primaryPrev3d,
        primaryTrendPct,
        primaryStable,
        changedRecently,
        ctrBase,
        messRateBase,
        target_cpmess: target,
        target_purchase: targetPurchase,
        target_lead: targetLead,
        funnelTargets
      });

      const ratioPct = (primaryCost > 0 && primaryTarget > 0) ? Math.round((primaryCost / primaryTarget) * 100) : null;
      const funnelSummary = `${Number(row.mess || 0)} Mess (${money(cpmess)}) · ${Number(row.leads || 0)} Lead · ${Number(row.purchases || 0)} Đơn`;

      return {
        ...row,
        all_time_spend,
        all_time_mess,
        first_run_date: row.first_run_date || null,
        last_run_date: row.last_run_date || null,
        lifetime_spend,
        lifetime_budget,
        lifetime_spend_pct,
        is_lifetime: isLifetime,
        budget_type: isLifetime ? 'LIFETIME' : 'DAILY',
        spend: Number(row.spend || 0),
        spend_3d: Number(row.spend_3d || 0),
        today_spend: Number(row.today_spend || 0),
        today_mess: Number(row.today_mess || 0),
        today_leads: Number(row.today_leads || 0),
        today_purchases: Number(row.today_purchases || 0),
        mess: Number(row.mess || 0),
        cpmess,
        target_cpmess: target,
        leads: Number(row.leads || 0),
        cost_per_lead: costPerLead,
        target_lead: targetLead,
        purchases: Number(row.purchases || 0),
        cost_per_purchase: costPerPurchase,
        target_purchase: targetPurchase,
        primary_metric: primaryMetric,
        primary_label: primaryLabel,
        primary_count: primaryCount,
        primary_cost: primaryCost,
        primary_target: primaryTarget,
        ratio_pct: ratioPct,
        funnel_summary: funnelSummary,
        benchmark,
        target_source: targetSource,
        cpmess_3d: cpmess3d,
        cpmess_prev_3d: prevCpmess3d,
        trend_3d_pct: trendPct,
        stable,
        changed_recently: !!changedRecently,
        benchmark_ratio: row.cpmess ? Math.round(row.cpmess / benchmark * 100) : null,
        target_ratio: row.cpmess ? Math.round(row.cpmess / target * 100) : null,
        ctr_benchmark: Number(ctrBase.toFixed(2)),
        mess_rate_benchmark: Number(messRateBase.toFixed(2)),
        performance_mode: workspaceId === 2 ? 'conversion_funnel' : 'message',
        primary_3d: primary3d,
        primary_prev_3d: primaryPrev3d,
        primary_trend_pct: primaryTrendPct,
        action: ruleEval.action,
        priority: ruleEval.priority,
        title: ruleEval.title,
        reason: ruleEval.reason,
        action_type: ruleEval.action_type,
        budget_action: ruleEval.budget_action,
        root_cause: ruleEval.root_cause
      };
    }).sort((a, b) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 }[a.priority] - { HIGH: 0, MEDIUM: 1, LOW: 2 }[b.priority]) || (b.spend - a.spend));

    const counts = recommendations.reduce((acc, item) => (acc[item.action] = (acc[item.action] || 0) + 1, acc), {});

    const mapAdActionItem = (item) => ({
      ad_id: item.ad_id,
      ad_name: item.ad_name,
      adset_name: item.adset_name || item.adset_id || 'Chưa xác định',
      campaign_name: item.campaign_name || 'Chưa xác định',
      spend_3d: Number(item.spend_3d || 0),
      spend: Number(item.spend || 0),
      today_spend: Number(item.today_spend || 0),
      today_mess: Number(item.today_mess || 0),
      all_time_spend: Number(item.all_time_spend || 0),
      all_time_mess: Number(item.all_time_mess || 0),
      lifetime_spend: Number(item.lifetime_spend || 0),
      lifetime_budget: Number(item.lifetime_budget || 0),
      is_lifetime: !!item.is_lifetime,
      budget_type: item.budget_type || (item.is_lifetime ? 'LIFETIME' : 'DAILY'),
      mess: Number(item.mess || 0),
      cpmess: item.cpmess || null,
      target_cpmess: Number(item.target_cpmess || 0),
      leads: Number(item.leads || 0),
      cost_per_lead: item.cost_per_lead || (item.leads ? Math.round(item.spend / item.leads) : null),
      target_lead: Number(item.target_lead || 0),
      purchases: Number(item.purchases || 0),
      cost_per_purchase: item.cost_per_purchase || (item.purchases ? Math.round(item.spend / item.purchases) : null),
      target_purchase: Number(item.target_purchase || 0),
      primary_metric: item.primary_metric,
      primary_label: item.primary_label,
      primary_count: item.primary_count,
      primary_cost: item.primary_cost,
      primary_target: item.primary_target,
      ratio_pct: item.ratio_pct,
      funnel_summary: item.funnel_summary,
      ctr: item.ctr || 0,
      mess_rate: item.mess_rate || 0,
      frequency: item.frequency || 0,
      action: item.action,
      priority: item.priority,
      title: item.title,
      reason: item.reason,
      root_cause: item.root_cause || null
    });

    const emergencyPauseAds = recommendations.filter(r => r.action === 'PAUSE').map(mapAdActionItem);
    const budgetReductionAds = recommendations.filter(r => r.action === 'DECREASE_20').map(mapAdActionItem);
    const suddenDipAds = recommendations.filter(r => r.action === 'SUDDEN_DIP').map(mapAdActionItem);
    const creativeRefreshAds = recommendations.filter(r => ['NEW_HOOK', 'NEW_CREATIVE', 'FATIGUE_WARN'].includes(r.action)).map(mapAdActionItem);
    const ctaOfferFixAds = recommendations.filter(r => r.action === 'FIX_CTA').map(mapAdActionItem);

    const pauseWastedSpend3d = emergencyPauseAds.reduce((sum, item) => sum + (Number(item.spend_3d) || 0), 0);
    const decreaseWastedSpend3d = budgetReductionAds.reduce((sum, item) => sum + (Number(item.spend_3d) || 0), 0);
    const suddenDipWastedSpend3d = suddenDipAds.reduce((sum, item) => sum + (Number(item.spend_3d) || 0), 0);
    const totalWastedSpend3d = pauseWastedSpend3d + decreaseWastedSpend3d + suddenDipWastedSpend3d;

    const cost_saving_summary = {
      total_wasted_spend_3d: Math.round(totalWastedSpend3d),
      pause_wasted_spend_3d: Math.round(pauseWastedSpend3d),
      decrease_wasted_spend_3d: Math.round(decreaseWastedSpend3d),
      sudden_dip_wasted_spend_3d: Math.round(suddenDipWastedSpend3d),
      emergency_pause_count: emergencyPauseAds.length,
      budget_reduction_count: budgetReductionAds.length,
      sudden_dip_count: suddenDipAds.length,
      creative_refresh_count: creativeRefreshAds.length,
      cta_offer_fix_count: ctaOfferFixAds.length,
      total_risky_ads: emergencyPauseAds.length + budgetReductionAds.length + suddenDipAds.length
    };

    const priority_actions = {
      total_wasted_spend_3d: Math.round(totalWastedSpend3d),
      urgent_groups: {
        emergency_pause: emergencyPauseAds,
        budget_reduction: budgetReductionAds,
        sudden_dip: suddenDipAds,
        creative_refresh: creativeRefreshAds,
        cta_offer_fix: ctaOfferFixAds
      }
    };

    const now = new Date();
    const current_hour_vn = (now.getUTCHours() + 7) % 24;
    const current_minute_vn = now.getUTCMinutes();
    const expected_pacing_pct = getExpectedPacingPct(current_hour_vn, current_minute_vn);

    const pacingCounts = { fast_burn: 0, on_track: 0, under_spending: 0, lifetime_scheduled: 0 };
    const activeDailyAdsets = new Map();
    const activeLifetimeAdsets = new Map();
    let totalTodaySpend = 0;

    rows.filter(row => row.active).forEach(row => {
      const asDaily = Number(row.adset_daily_budget) || 0;
      const asLifetime = Number(row.adset_lifetime_budget) || 0;
      const cmpDaily = Number(row.campaign_daily_budget) || 0;
      const cmpLifetime = Number(row.campaign_lifetime_budget) || 0;
      const rawAdset = Number(row.budget || row.adset_budget) || 0;
      const rawCamp = Number(row.campaign_budget) || 0;
      const rawBudget = asDaily || asLifetime || cmpDaily || cmpLifetime || rawAdset || rawCamp || 0;
      const hasEndTime = Boolean((row.adset_end_time && String(row.adset_end_time).trim()) || (row.campaign_end_time && String(row.campaign_end_time).trim()));
      const noDailyBudget = asDaily === 0 && cmpDaily === 0;

      const adsetName = String(row.adset_name || '');
      const campaignName = String(row.campaign_name || '');
      const adName = String(row.ad_name || '');
      const isMtCamp = adsetName.includes('MT 26-5') || campaignName.includes('MT 26-5') || adName.includes('MT 26-5');

      let isLifetime = false;
      if (row.budget_type === 'LIFETIME' || isMtCamp || asLifetime > 0 || cmpLifetime > 0 || rawBudget >= 2000000 || (hasEndTime && noDailyBudget)) {
        isLifetime = true;
      } else if (row.budget_type === 'DAILY') {
        isLifetime = false;
      } else {
        isLifetime = (asLifetime > 0 && asDaily === 0) || (asDaily === 0 && asLifetime === 0 && cmpLifetime > 0 && cmpDaily === 0);
      }

      const todaySpend = Number(row.today_spend || 0);
      const allTimeSpend = Number(row.all_time_spend || 0);

      if (isLifetime) {
        const isCboLifetime = (cmpLifetime > 0 && asLifetime === 0) || (rawCamp > 0 && rawAdset === 0 && asLifetime === 0);
        const lifetimeBudget = isCboLifetime ? (cmpLifetime || rawCamp) : (asLifetime || rawAdset || cmpLifetime || rawCamp || (rawBudget >= 2000000 ? rawBudget : (isMtCamp ? 10000000 : rawBudget)));
        pacingCounts.lifetime_scheduled++;
        const dedupeKey = isCboLifetime ? `cmp_${row.campaign_id}` : `adset_${row.adset_id || row.campaign_id || row.ad_id}`;
        if (!activeLifetimeAdsets.has(dedupeKey)) {
          activeLifetimeAdsets.set(dedupeKey, {
            budget: Number(lifetimeBudget),
            all_time_spend: 0
          });
        }
        activeLifetimeAdsets.get(dedupeKey).all_time_spend += allTimeSpend;
      } else {
        const isCbo = (cmpDaily > 0 && asDaily === 0) || (rawCamp > 0 && rawAdset === 0 && asDaily === 0);
        const dailyBudget = isCbo ? (cmpDaily || rawCamp) : (asDaily || rawAdset || cmpDaily || rawCamp || 0);
        const dedupeKey = isCbo ? `cmp_${row.campaign_id}` : `adset_${row.adset_id || row.campaign_id || row.ad_id}`;
        if (!activeDailyAdsets.has(dedupeKey)) {
          activeDailyAdsets.set(dedupeKey, Number(dailyBudget));
        }
        totalTodaySpend += todaySpend;

        const pacing = evaluateBudgetPacing({
          dailyBudget: dailyBudget,
          lifetimeBudget: 0,
          todaySpend: todaySpend,
          spend7d: row.spend,
          ctr7d: row.ctr,
          frequency7d: row.frequency,
          targeting: row.targeting,
          currentHourVn: current_hour_vn,
          currentMinuteVn: current_minute_vn,
          expectedPacingPct: expected_pacing_pct
        });

        if (pacing.status === 'FAST_BURN') pacingCounts.fast_burn++;
        else if (pacing.status === 'UNDER_SPENDING') pacingCounts.under_spending++;
        else pacingCounts.on_track++;
      }
    });

    const totalDailyBudget = Array.from(activeDailyAdsets.values()).reduce((sum, b) => sum + b, 0);
    const totalLifetimeBudget = Array.from(activeLifetimeAdsets.values()).reduce((sum, item) => sum + item.budget, 0);
    const totalLifetimeSpend = Array.from(activeLifetimeAdsets.values()).reduce((sum, item) => sum + item.all_time_spend, 0);
    const overall_pacing_pct = totalDailyBudget > 0 ? Math.round((totalTodaySpend / totalDailyBudget) * 100) : 0;

    const budget_pacing_summary = {
      total_daily_budget: totalDailyBudget,
      total_today_spend: Math.round(totalTodaySpend),
      overall_pacing_pct,
      expected_pacing_pct,
      current_hour_vn,
      counts: pacingCounts,
      fast_burn_count: pacingCounts.fast_burn,
      under_spending_count: pacingCounts.under_spending,
      on_track_count: pacingCounts.on_track,
      lifetime_scheduled_count: pacingCounts.lifetime_scheduled,
      lifetime: {
        total_lifetime_budget: totalLifetimeBudget,
        total_lifetime_spend: Math.round(totalLifetimeSpend),
        count: activeLifetimeAdsets.size
      }
    };

    const responseData = {
      success: true,
      data: {
        generated_at: new Date().toISOString(),
        global_benchmark: globalBenchmark,
        counts,
        recommendations,
        cost_saving_summary,
        priority_actions,
        urgent_groups: priority_actions.urgent_groups,
        budget_pacing_summary
      }
    };
    apiCache.set(cacheKey, responseData);
    res.json(responseData);
  } catch(e){ res.status(500).json({success:false,error:e.message}); }
});

function describeTargetingSnippet(t = {}) {
  if (!t || typeof t !== 'object') return 'Tệp không xác định';
  if (typeof t === 'string') {
    try { t = JSON.parse(t); } catch (_) { return t; }
  }
  const specs = Array.isArray(t.flexible_spec) ? t.flexible_spec : [];
  const interests = specs.flatMap(x => x.interests || []).map(x => x.name || x.id).filter(Boolean);
  const geo = t.geo_locations || {};

  const places = [...(geo.places || []), ...(geo.custom_locations || [])].map(x => {
    const lat = Number(x.latitude), lng = Number(x.longitude);
    const name = x.name || x.address || (!isNaN(lat) && !isNaN(lng) && x.latitude !== undefined && x.longitude !== undefined ? `Ghim (${lat.toFixed(2)}, ${lng.toFixed(2)})` : '');
    const radius = x.radius ? ` (+${x.radius}${x.distance_unit === 'kilometer' || x.distance_unit === 'km' ? 'km' : (x.distance_unit || 'km')})` : '';
    return name ? `${name}${radius}` : '';
  }).filter(Boolean);

  const cities = (geo.cities || []).map(x => (typeof x === 'string' ? x : x.name || x.key)).filter(Boolean);
  const regions = (geo.regions || []).map(x => (typeof x === 'string' ? x : x.name || x.key)).filter(Boolean);
  const countries = (geo.countries || []).map(x => (typeof x === 'string' ? x : x.name || x.key || String(x))).filter(Boolean);

  let locationSummary = 'Toàn quốc';
  if (places.length > 0) {
    locationSummary = `Thả ghim bán kính: ${places.join(', ')}`;
  } else if (cities.length > 0 || regions.length > 0) {
    locationSummary = [...cities, ...regions].join(', ');
  } else if (countries.length > 0) {
    locationSummary = countries.includes('VN') ? 'Toàn quốc (Việt Nam)' : countries.join(', ');
  }

  const age = `${t.age_min || 18}–${t.age_max || 65}`;
  const gender = (t.genders || []).length === 1 ? (t.genders[0] === 2 ? 'Nữ' : 'Nam') : 'Tất cả giới tính';
  return `${gender}, ${age} tuổi; Vị trí: ${locationSummary}${interests.length ? `; Sở thích: ${interests.slice(0, 5).join(', ')}` : '; Broad'}`;
}

// GET /api/ads/budget-pacing — Budget Pacing & Delivery Radar
router.get('/budget-pacing', (req, res) => {
  try {
    const workspaceId = Number(req.query.workspaceId || 1);
    const wsAccounts = db.prepare('SELECT account_id FROM workspace_ad_accounts WHERE workspace_id = ?').all(workspaceId).map(r => String(r.account_id));
    const accountIds = new Set(String(req.query.account_ids || req.query.account_id || '').split(',').map(x => x.trim()).filter(Boolean));
    if (!accountIds.size && wsAccounts.length > 0) {
      wsAccounts.forEach(id => accountIds.add(id));
    }
    const totalWsAccs = db.prepare('SELECT COUNT(*) as count FROM workspace_ad_accounts').get()?.count || 0;

    const accIdsStr = Array.from(accountIds).sort().join(',');
    const cacheKey = `budget_pacing_ws${workspaceId}_${accIdsStr}`;
    const cached = apiCache.get(cacheKey);
    if (cached) return res.json(cached);

    const now = new Date();
    const current_hour_vn = (now.getUTCHours() + 7) % 24;
    const current_minute_vn = now.getUTCMinutes();
    const expected_pacing_pct = getExpectedPacingPct(current_hour_vn, current_minute_vn);

    const maxDate = db.prepare('SELECT MAX(date) AS val FROM ad_daily_stats').get()?.val || new Date().toISOString().slice(0, 10);
    const accList = Array.from(accountIds);
    let accFilter = '';
    const params = { maxDate };

    if (accList.length > 0) {
      const placeholders = accList.map((_, i) => `@acc${i}`).join(',');
      accFilter = `AND c.account_id IN (${placeholders})`;
      accList.forEach((id, i) => { params[`acc${i}`] = id; });
    } else if (totalWsAccs > 0) {
      accFilter = 'AND 1 = 0';
    }

    const rows = db.prepare(`
      SELECT c.ad_id, c.ad_name, c.ad_status, c.adset_status, c.campaign_status,
        c.account_id, c.campaign_id, c.campaign_name, c.adset_id, c.adset_name,
        c.targeting,
        c.budget_type,
        c.adset_daily_budget,
        c.adset_lifetime_budget,
        c.campaign_daily_budget,
        c.campaign_lifetime_budget,
        c.adset_budget,
        c.campaign_budget,
        c.adset_end_time,
        c.campaign_end_time,
        COALESCE(alt.all_time_spend, 0) AS all_time_spend,
        COALESCE(alt.all_time_mess, 0) AS all_time_mess,
        alt.first_run_date AS first_run_date,
        alt.last_run_date AS last_run_date,
        ROUND(SUM(CASE WHEN s.date = @maxDate THEN s.spend ELSE 0 END), 0) AS today_spend,
        SUM(CASE WHEN s.date = @maxDate THEN s.mess_started ELSE 0 END) AS today_mess,
        ROUND(SUM(s.spend), 0) AS spend_7d,
        SUM(s.mess_started) AS mess_7d,
        SUM(s.impressions) AS impressions_7d,
        SUM(s.clicks) AS clicks_7d,
        ROUND(AVG(s.frequency), 2) AS frequency_7d,
        CASE WHEN SUM(s.impressions) > 0 THEN ROUND(SUM(s.clicks) * 100.0 / SUM(s.impressions), 2) ELSE 0 END AS ctr_7d
      FROM ad_config c
      LEFT JOIN (
        SELECT ad_id, ROUND(SUM(spend),0) AS all_time_spend, SUM(mess_started) AS all_time_mess, MIN(date) AS first_run_date, MAX(date) AS last_run_date
        FROM ad_daily_stats
        GROUP BY ad_id
      ) alt ON alt.ad_id = c.ad_id
      LEFT JOIN ad_daily_stats s ON s.ad_id = c.ad_id
        AND s.date >= date(@maxDate, '-6 days')
      WHERE c.ad_status = 'ACTIVE' AND c.adset_status = 'ACTIVE' AND c.campaign_status = 'ACTIVE' ${accFilter}
      GROUP BY c.ad_id
    `).all(params);

    const counts = {
      fast_burn: 0,
      on_track: 0,
      under_spending: 0,
      lifetime_scheduled: 0
    };

    const activeDailyAdsets = new Map();
    let totalTodaySpend = 0;

    const money = (val) => (val !== null && val !== undefined && !isNaN(val) && Number(val) > 0) ? Number(val).toLocaleString('vi-VN') + 'đ' : '0đ';

    const pacing_items = rows.map(row => {
      const asDaily = Number(row.adset_daily_budget) || 0;
      const asLifetime = Number(row.adset_lifetime_budget) || 0;
      const cmpDaily = Number(row.campaign_daily_budget) || 0;
      const cmpLifetime = Number(row.campaign_lifetime_budget) || 0;
      const rawAdset = Number(row.adset_budget) || 0;
      const rawCamp = Number(row.campaign_budget) || 0;
      const rawBudget = asDaily || asLifetime || cmpDaily || cmpLifetime || rawAdset || rawCamp || 0;
      const hasEndTime = Boolean((row.adset_end_time && String(row.adset_end_time).trim()) || (row.campaign_end_time && String(row.campaign_end_time).trim()));
      const noDailyBudget = asDaily === 0 && cmpDaily === 0;

      const adsetName = String(row.adset_name || '');
      const campaignName = String(row.campaign_name || '');
      const adName = String(row.ad_name || '');
      const isMtCamp = adsetName.includes('MT 26-5') || campaignName.includes('MT 26-5') || adName.includes('MT 26-5');

      let isLifetime = false;
      if (row.budget_type === 'LIFETIME' || isMtCamp || asLifetime > 0 || cmpLifetime > 0 || rawBudget >= 2000000 || (hasEndTime && noDailyBudget)) {
        isLifetime = true;
      } else if (row.budget_type === 'DAILY') {
        isLifetime = false;
      } else {
        isLifetime = (asLifetime > 0 && asDaily === 0) || (asDaily === 0 && asLifetime === 0 && cmpLifetime > 0 && cmpDaily === 0);
      }

      const isCbo = (cmpDaily > 0 && asDaily === 0) || (rawCamp > 0 && rawAdset === 0 && asDaily === 0);
      const isCboLifetime = (cmpLifetime > 0 && asLifetime === 0) || (rawCamp > 0 && rawAdset === 0 && asLifetime === 0);

      const budget_type = isLifetime ? 'LIFETIME' : 'DAILY';
      const daily_budget = isLifetime ? 0 : (isCbo ? (cmpDaily || rawCamp) : (asDaily || rawAdset || cmpDaily || rawCamp || 0));
      const lifetime_budget = isLifetime ? (isCboLifetime ? (cmpLifetime || rawCamp) : (asLifetime || rawAdset || cmpLifetime || rawCamp || (rawBudget >= 2000000 ? rawBudget : (isMtCamp ? 10000000 : rawBudget)))) : 0;

      const today_spend = Number(row.today_spend || 0);
      const today_mess = Number(row.today_mess || 0);
      const today_cpmess = today_mess > 0 ? Math.round(today_spend / today_mess) : null;
      const spend_7d = Number(row.spend_7d || 0);
      const ctr_7d = Number(row.ctr_7d || 0);
      const frequency_7d = Number(row.frequency_7d || 0);
      const all_time_spend = Number(row.all_time_spend || 0);
      const all_time_mess = Number(row.all_time_mess || 0);
      const first_run_date = row.first_run_date || null;
      const last_run_date = row.last_run_date || null;
      const lifetime_spend = isLifetime ? all_time_spend : 0;
      const lifetime_spend_pct = isLifetime ? (lifetime_budget > 0 ? Math.round((all_time_spend / lifetime_budget) * 100) : 0) : null;

      let targetingObj = null;
      if (row.targeting) {
        try { targetingObj = JSON.parse(row.targeting); } catch (_) { targetingObj = row.targeting; }
      }
      const targeting_summary = describeTargetingSnippet(targetingObj || row.targeting);

      let pacing_status = 'ON_TRACK';
      let pacing_diagnosis = '';
      let pacing_action = '';
      let pacing_pct = null;

      if (isLifetime) {
        counts.lifetime_scheduled++;
        pacing_status = 'LIFETIME_SCHEDULED';
        pacing_diagnosis = `Chiến dịch đang chạy theo Ngân sách Trọn Đời (${money(lifetime_budget)}). Phân bổ ngân sách được thuật toán Meta tự động tối ưu qua toàn bộ thời gian chiến dịch.`;
        pacing_action = 'Theo dõi tiến độ phân phối tổng thể theo thời gian kết thúc của chiến dịch.';
        pacing_pct = lifetime_spend_pct;
      } else {
        const dedupeKey = isCbo ? `cmp_${row.campaign_id}` : `adset_${row.adset_id || row.campaign_id || row.ad_id}`;
        if (!activeDailyAdsets.has(dedupeKey)) {
          activeDailyAdsets.set(dedupeKey, Number(daily_budget));
        }
        totalTodaySpend += today_spend;

        const pacing = evaluateBudgetPacing({
          dailyBudget: daily_budget,
          lifetimeBudget: 0,
          todaySpend: today_spend,
          spend7d: spend_7d,
          ctr7d: ctr_7d,
          frequency7d: frequency_7d,
          targeting: targetingObj || row.targeting,
          currentHourVn: current_hour_vn,
          currentMinuteVn: current_minute_vn,
          expectedPacingPct: expected_pacing_pct
        });

        if (pacing.status === 'FAST_BURN') counts.fast_burn++;
        else if (pacing.status === 'UNDER_SPENDING') counts.under_spending++;
        else counts.on_track++;

        pacing_status = pacing.status;
        pacing_diagnosis = pacing.diagnosis;
        pacing_action = pacing.action;
        pacing_pct = pacing.currentPacingPct;
      }

      return {
        ad_id: row.ad_id,
        ad_name: row.ad_name,
        adset_id: row.adset_id || '',
        adset_name: row.adset_name || 'Chưa xác định',
        campaign_id: row.campaign_id || '',
        campaign_name: row.campaign_name || 'Chưa xác định',
        account_id: row.account_id || '',
        service: parseService(row.ad_name, workspaceId),
        budget_type,
        daily_budget,
        lifetime_budget,
        all_time_spend,
        all_time_mess,
        first_run_date,
        last_run_date,
        lifetime_spend,
        lifetime_spend_pct,
        adset_end_time: row.adset_end_time || '',
        campaign_end_time: row.campaign_end_time || '',
        today_spend,
        today_mess,
        today_cpmess,
        spend_7d,
        ctr_7d,
        frequency_7d,
        targeting: targetingObj || row.targeting,
        targeting_summary,
        pacing_pct,
        expected_pacing_pct,
        pacing_status,
        pacing_diagnosis,
        pacing_action
      };
    }).sort((a, b) => {
      const priority = { FAST_BURN: 0, UNDER_SPENDING: 1, ON_TRACK: 2, LIFETIME_SCHEDULED: 3 };
      const diff = (priority[a.pacing_status] ?? 99) - (priority[b.pacing_status] ?? 99);
      if (diff !== 0) return diff;
      return b.today_spend - a.today_spend;
    });

    const lifetimeAdsetMap = new Map();
    pacing_items.filter(item => item.budget_type === 'LIFETIME').forEach(item => {
      const key = item.adset_id || item.campaign_id || item.ad_id;
      if (!lifetimeAdsetMap.has(key)) {
        lifetimeAdsetMap.set(key, {
          adset_id: item.adset_id,
          adset_name: item.adset_name,
          campaign_id: item.campaign_id,
          campaign_name: item.campaign_name,
          lifetime_budget: Number(item.lifetime_budget) || 0,
          all_time_spend: 0,
          all_time_mess: 0,
          today_spend: 0,
          spend_pct: 0,
          ad_count: 0,
          ads: []
        });
      }
      const group = lifetimeAdsetMap.get(key);
      group.all_time_spend += item.all_time_spend;
      group.all_time_mess += item.all_time_mess;
      group.today_spend += item.today_spend;
      group.ad_count += 1;
      group.ads.push(item);
    });

    const lifetime_adsets = Array.from(lifetimeAdsetMap.values()).map(group => {
      group.all_time_spend = Math.round(group.all_time_spend);
      group.today_spend = Math.round(group.today_spend);
      group.spend_pct = group.lifetime_budget > 0 ? Math.round((group.all_time_spend / group.lifetime_budget) * 100) : 0;
      return group;
    });

    const totalDailyBudget = Array.from(activeDailyAdsets.values()).reduce((sum, b) => sum + b, 0);
    const totalLifetimeBudget = lifetime_adsets.reduce((sum, g) => sum + g.lifetime_budget, 0);
    const totalLifetimeSpend = lifetime_adsets.reduce((sum, g) => sum + g.all_time_spend, 0);
    const overall_pacing_pct = totalDailyBudget > 0 ? Math.round((totalTodaySpend / totalDailyBudget) * 100) : 0;

    const summary = {
      total_daily_budget: totalDailyBudget,
      total_today_spend: Math.round(totalTodaySpend),
      overall_pacing_pct,
      expected_pacing_pct,
      current_hour_vn,
      current_minute_vn,
      counts,
      lifetime: {
        total_lifetime_budget: totalLifetimeBudget,
        total_lifetime_spend: Math.round(totalLifetimeSpend),
        count: lifetime_adsets.length
      },
      hourly_distribution_guide: HOURLY_DISTRIBUTION_GUIDE
    };

    const responseData = {
      success: true,
      data: {
        summary,
        pacing_items,
        lifetime_adsets,
        hourly_distribution_guide: HOURLY_DISTRIBUTION_GUIDE
      }
    };
    apiCache.set(cacheKey, responseData);
    res.json(responseData);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST & GET /api/ads/diagnose-single-ad — on-demand AI single ad diagnosis (~300 tokens)
// POST & GET /api/ads/diagnose-single-ad — on-demand AI single ad diagnosis with 48h DB snapshot caching (~300 tokens)
const handleDiagnoseSingleAd = async (req, res) => {
  try {
    const adId = String(req.body?.adId || req.query.adId || '').trim();
    const workspaceId = Number(req.body?.workspaceId || req.query.workspaceId || 1);
    const force = req.query.force === 'true' || req.body?.force === true || req.query.forceRefresh === 'true' || req.body?.forceRefresh === true;
    const cachedOnly = req.query.cachedOnly === 'true' || req.body?.cachedOnly === true;

    if (!adId) {
      return res.status(400).json({ success: false, error: 'Thiếu adId' });
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS ad_ai_diagnoses (
        ad_id TEXT PRIMARY KEY,
        workspace_id INTEGER DEFAULT 1,
        service TEXT,
        diagnosis_json TEXT,
        snapshot_hash TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 1. Check existing snapshot in ad_ai_diagnoses (< 48 hours)
    if (!force) {
      try {
        const cached = db.prepare(`
          SELECT ad_id, workspace_id, service, diagnosis_json, snapshot_hash, created_at, updated_at
          FROM ad_ai_diagnoses
          WHERE ad_id = ?
        `).get(adId);

        if (cached && cached.diagnosis_json) {
          const updatedAtStr = String(cached.updated_at || cached.created_at || '');
          const cacheDate = new Date(updatedAtStr.includes('Z') ? updatedAtStr : updatedAtStr.replace(' ', 'T') + 'Z');
          const cacheTime = isNaN(cacheDate.getTime()) ? new Date(updatedAtStr).getTime() : cacheDate.getTime();
          const ageHours = !isNaN(cacheTime) ? (Date.now() - cacheTime) / 3600000 : 999;

          if (ageHours < 48) {
            const diagObj = JSON.parse(cached.diagnosis_json);
            return res.json({
              success: true,
              adId: String(adId),
              service: cached.service || diagObj.service || 'Khác',
              diagnosis: diagObj,
              data: diagObj,
              suddenDipPlaybook: diagObj.suddenDipPlaybook || null,
              cached: true,
              savedAt: cached.updated_at || cached.created_at,
              updatedAt: cached.updated_at || cached.created_at,
              createdAt: cached.created_at,
              cacheAgeHours: Number(ageHours.toFixed(1)),
              snapshotHash: cached.snapshot_hash || null
            });
          }
        }
      } catch (cacheErr) {
        // Fall through to perform fresh diagnosis
      }
    }

    // If cachedOnly was requested and no fresh cache exists
    if (cachedOnly && !force) {
      return res.json({
        success: false,
        cached: false,
        adId: String(adId),
        data: null,
        diagnosis: null,
        error: 'Chưa có bản lưu snapshot trong vòng 48h'
      });
    }

    const adConfig = db.prepare(`
      SELECT c.ad_id, c.ad_name, c.ad_status, c.adset_status, c.campaign_status,
        c.account_id, c.adset_id, c.adset_name, c.campaign_name, c.budget_updated_at,
        c.targeting,
        COALESCE(NULLIF(CAST(c.adset_budget AS INTEGER), 0), CAST(c.campaign_budget AS INTEGER), 0) AS budget
      FROM ad_config c
      WHERE c.ad_id = ?
    `).get(adId);

    if (!adConfig) {
      return res.status(404).json({ success: false, error: `Không tìm thấy quảng cáo với ID: ${adId}` });
    }

    const creative = db.prepare(`
      SELECT thumbnail_url, video_url, body_text, video_id
      FROM ad_creatives
      WHERE ad_id = ?
    `).get(adId) || {};

    const stats = db.prepare(`
      SELECT
        COUNT(DISTINCT CASE WHEN s.spend > 0 THEN s.date END) AS run_days,
        ROUND(SUM(s.spend), 0) AS spend,
        SUM(s.mess_started) AS mess,
        SUM(s.leads) AS leads,
        SUM(s.purchases) AS purchases,
        ROUND(SUM(CASE WHEN s.date = (SELECT MAX(date) FROM ad_daily_stats) THEN s.spend ELSE 0 END), 0) AS today_spend,
        SUM(CASE WHEN s.date = (SELECT MAX(date) FROM ad_daily_stats) THEN s.mess_started ELSE 0 END) AS today_mess,
        SUM(CASE WHEN s.date = (SELECT MAX(date) FROM ad_daily_stats) THEN s.leads ELSE 0 END) AS today_leads,
        SUM(CASE WHEN s.date = (SELECT MAX(date) FROM ad_daily_stats) THEN s.purchases ELSE 0 END) AS today_purchases,
        ROUND(SUM(CASE WHEN s.date >= date((SELECT MAX(date) FROM ad_daily_stats), '-2 days') THEN s.spend ELSE 0 END), 0) AS spend_3d,
        SUM(CASE WHEN s.date >= date((SELECT MAX(date) FROM ad_daily_stats), '-2 days') THEN s.mess_started ELSE 0 END) AS mess_3d,
        SUM(CASE WHEN s.date >= date((SELECT MAX(date) FROM ad_daily_stats), '-2 days') THEN s.leads ELSE 0 END) AS leads_3d,
        SUM(CASE WHEN s.date >= date((SELECT MAX(date) FROM ad_daily_stats), '-2 days') THEN s.purchases ELSE 0 END) AS purchases_3d,
        ROUND(SUM(CASE WHEN s.date BETWEEN date((SELECT MAX(date) FROM ad_daily_stats), '-5 days') AND date((SELECT MAX(date) FROM ad_daily_stats), '-3 days') THEN s.spend ELSE 0 END), 0) AS spend_prev_3d,
        SUM(CASE WHEN s.date BETWEEN date((SELECT MAX(date) FROM ad_daily_stats), '-5 days') AND date((SELECT MAX(date) FROM ad_daily_stats), '-3 days') THEN s.mess_started ELSE 0 END) AS mess_prev_3d,
        SUM(CASE WHEN s.date BETWEEN date((SELECT MAX(date) FROM ad_daily_stats), '-5 days') AND date((SELECT MAX(date) FROM ad_daily_stats), '-3 days') THEN s.leads ELSE 0 END) AS leads_prev_3d,
        SUM(CASE WHEN s.date BETWEEN date((SELECT MAX(date) FROM ad_daily_stats), '-5 days') AND date((SELECT MAX(date) FROM ad_daily_stats), '-3 days') THEN s.purchases ELSE 0 END) AS purchases_prev_3d,
        COUNT(DISTINCT CASE WHEN s.mess_started > 0 THEN s.date END) AS days_with_mess,
        SUM(s.impressions) AS impressions,
        SUM(s.clicks) AS clicks,
        ROUND(AVG(s.frequency), 2) AS frequency,
        CASE WHEN SUM(s.mess_started) > 0 THEN ROUND(SUM(s.spend) / SUM(s.mess_started), 0) END AS cpmess,
        CASE WHEN SUM(s.impressions) > 0 THEN ROUND(SUM(clicks) * 100.0 / SUM(s.impressions), 2) ELSE 0 END AS ctr,
        CASE WHEN SUM(s.clicks) > 0 THEN ROUND(SUM(s.mess_started) * 100.0 / SUM(s.clicks), 2) ELSE 0 END AS mess_rate
      FROM ad_daily_stats s
      WHERE s.ad_id = ? AND s.date >= date((SELECT MAX(date) FROM ad_daily_stats), '-6 days')
    `).get(adId) || { run_days: 0, spend: 0, mess: 0, leads: 0, purchases: 0 };

    stats.cpmess_3d = stats.mess_3d ? Math.round(stats.spend_3d / stats.mess_3d) : null;
    stats.cpmess_prev_3d = stats.mess_prev_3d ? Math.round(stats.spend_prev_3d / stats.mess_prev_3d) : null;

    const service = parseService(adConfig.ad_name, workspaceId);
    adConfig.service = service;

    const configuredTargets = {};
    db.prepare(`SELECT service, target_cpmess FROM workspace_cpmess_targets WHERE workspace_id=?`).all(workspaceId).forEach(item => {
      configuredTargets[item.service] = Number(item.target_cpmess);
    });
    let funnelTargets = {};
    try {
      const saved = db.prepare('SELECT targets_json FROM workspace_funnel_targets WHERE workspace_id=?').get(workspaceId);
      funnelTargets = saved ? JSON.parse(saved.targets_json) : {};
    } catch (_) {}

    const targetCpmess = configuredTargets[service] || Number(funnelTargets.cost_per_message_max) || TARGET_CPM;

    const { diagnoseSingleAd } = require('../services/aiOptimizer');
    const targetingObj = adConfig.targeting ? (typeof adConfig.targeting === 'string' ? JSON.parse(adConfig.targeting) : adConfig.targeting) : {};

    const diagnosis = await diagnoseSingleAd({
      adData: {
        ad: adConfig,
        stats,
        creative,
        targeting: {
          raw: targetingObj,
          summary: describeTargetingSnippet(targetingObj)
        }
      },
      businessTargets: {
        ...funnelTargets,
        cost_per_message_max: targetCpmess
      },
      benchmark: targetCpmess
    });

    const snapshotHash = crypto.createHash('sha256')
      .update(JSON.stringify({ adId, stats, targeting: targetingObj, creative: creative.body_text || '' }))
      .digest('hex').slice(0, 16);

    try {
      db.prepare(`
        INSERT INTO ad_ai_diagnoses (ad_id, workspace_id, service, diagnosis_json, snapshot_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(ad_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          service = excluded.service,
          diagnosis_json = excluded.diagnosis_json,
          snapshot_hash = excluded.snapshot_hash,
          updated_at = datetime('now')
      `).run(String(adId), workspaceId, service, JSON.stringify(diagnosis), snapshotHash);
    } catch (_) {}

    const nowIso = new Date().toISOString();
    res.json({
      success: true,
      adId: String(adId),
      service,
      data: diagnosis,
      diagnosis,
      cached: false,
      savedAt: nowIso,
      updatedAt: nowIso,
      snapshotHash,
      suddenDipPlaybook: diagnosis.suddenDipPlaybook || null
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
};

router.post('/diagnose-single-ad', handleDiagnoseSingleAd);
router.get('/diagnose-single-ad', handleDiagnoseSingleAd);

// GET /api/ads/strategy-overview — aggregate services/operators/trends without LLM
router.get('/strategy-overview', (req, res) => {
  try {
    const workspaceId=Number(req.query.workspaceId||1);
    const accountIds=new Set(String(req.query.account_ids||'').split(',').map(x=>x.trim()).filter(Boolean));
    const latest=db.prepare('SELECT MAX(date) date FROM ad_daily_stats').get().date;
    const raw=db.prepare(`SELECT s.date,s.ad_id,c.account_id,COALESCE(s.ad_name,c.ad_name,'Khác') ad_name,COALESCE(s.account_name,c.account_id,'Chưa xác định') operator,s.spend,s.impressions,s.clicks,s.mess_started mess,s.leads,s.purchases,s.frequency FROM ad_daily_stats s LEFT JOIN ad_config c ON c.ad_id=s.ad_id WHERE s.date>=date(@latest,'-61 days')`).all({latest}).filter(r=>!accountIds.size||accountIds.has(String(r.account_id))).map(r=>({...r,service:parseService(r.ad_name,workspaceId),operator:parseOperator(r.ad_name,r.operator,workspaceId)}));
    const aggregate=rows=>{const m=reportMetrics(rows);return {...m,ads:[...new Set(rows.map(r=>r.ad_id))].length};};
    const inRange=(r,start,end)=>r.date>=start&&r.date<=end;
    const end=new Date(`${latest}T12:00:00Z`), iso=d=>d.toISOString().slice(0,10), shift=n=>{const d=new Date(end);d.setUTCDate(d.getUTCDate()+n);return iso(d)};
    const ranges={week:{start:shift(-6),end:latest,prevStart:shift(-13),prevEnd:shift(-7)},month:{start:shift(-29),end:latest,prevStart:shift(-59),prevEnd:shift(-30)}};
    const buildDimension=(dimension,range)=>{
      const names=[...new Set(raw.filter(r=>inRange(r,range.prevStart,range.end)).map(r=>r[dimension]))];
      return names.map(name=>{const current=aggregate(raw.filter(r=>r[dimension]===name&&inRange(r,range.start,range.end))),previous=aggregate(raw.filter(r=>r[dimension]===name&&inRange(r,range.prevStart,range.prevEnd)));const changes={spend:metricChange(current,previous,'spend'),mess:metricChange(current,previous,'mess'),cpmess:metricChange(current,previous,'cpmess'),ctr:metricChange(current,previous,'ctr')};return{name,current,previous,changes};}).sort((a,b)=>b.current.spend-a.current.spend);
    };
    const weekServices=buildDimension('service',ranges.week),monthServices=buildDimension('service',ranges.month),weekOperators=buildDimension('operator',ranges.week),monthOperators=buildDimension('operator',ranges.month);
    const diagnosis=weekServices.map(item=>{
      const c=item.current,p=item.previous;let status='stable',action='Giữ content và theo dõi',reason='Hiệu suất tuần này ổn định so với tuần trước.';
      if(c.impressions>=1000&&p.ctr&&c.ctr<p.ctr*.8){status='creative';action='Đổi hook/thumbnail, test 2–3 creative mới';reason=`CTR giảm ${Math.abs(item.changes.ctr||0)}%, dấu hiệu creative mất sức hút.`;}
      else if(c.clicks>=20&&p.clicks>=20&&p.mess&&c.mess_rate<p.mess_rate*.75){status='cta';action='Giữ visual, đổi offer và CTA';reason=`Mess Rate giảm từ ${p.mess_rate||0}% xuống ${c.mess_rate||0}%.`;}
      else if(c.frequency>=2.5&&item.changes.cpmess>20){status='fatigue';action='Test angle mới và audience mới';reason=`Frequency ${c.frequency}x, CPMess tăng ${item.changes.cpmess}%.`;}
      else if(item.changes.cpmess>20){status='decline';action='Giảm ngân sách test cũ, tạo batch content mới';reason=`CPMess tăng ${item.changes.cpmess}% so với tuần trước.`;}
      else if(item.changes.cpmess!==null&&item.changes.cpmess<-15&&c.mess>=5){status='growth';action='Giữ angle thắng, tạo 2 biến thể hook/format';reason=`CPMess cải thiện ${Math.abs(item.changes.cpmess)}%, có ${c.mess} mess.`;}
      return{service:item.name,status,action,reason,week:item};
    });
    const angles={
      'Nám':['Sai lầm khiến nám tái lại','Bác sĩ bóc tách tình trạng thật','Hành trình trước–sau có mốc thời gian'],
      'U máu':['Can thiệp sớm cho trẻ','Giải đáp nỗi lo của cha mẹ','Hồ sơ ca điều trị thực tế'],
      'Chàm bớt':['Tự ti và thay đổi cuộc sống','Phân biệt loại bớt trước điều trị','Case thật dưới góc nhìn bác sĩ'],
      'Trẻ hóa':['Dấu hiệu lão hóa ít ai nhận ra','Một ngày trải nghiệm liệu trình','So sánh phương pháp theo độ tuổi'],
      'LumiSlim':['Vì sao ăn ít vẫn tích mỡ','Đo thay đổi bằng số đo','Trải nghiệm không xâm lấn'],
      'Khác':['Problem–Solution','Chuyên gia giải đáp','Case study thực tế']
    };
    const plans=diagnosis.filter(d=>d.status!=='stable').map(d=>({...d,angles:angles[d.service]||angles.Khác,tests:[{format:'Video ngắn',qty:2},{format:'Ảnh proof/quote',qty:2},{format:'Carousel giải thích',qty:1}]}));
    res.json({success:true,data:{latest,ranges,week:{services:weekServices,operators:weekOperators},month:{services:monthServices,operators:monthOperators},diagnosis,plans}});
  } catch(e){res.status(500).json({success:false,error:e.message});}
});

router.get('/llm-analysis-history',(req,res)=>{
  try{
    const workspaceId=Number(req.query.workspaceId||0);if(!workspaceId)return res.status(400).json({success:false,error:'Thiếu profile'});
    const rows=db.prepare(`SELECT id,analysis_type,analyzed_ads,created_at,json_extract(result_json,'$.executiveSummary') executive_summary FROM workspace_llm_analysis_history WHERE workspace_id=? ORDER BY id DESC LIMIT 50`).all(workspaceId);
    res.json({success:true,data:rows});
  }catch(error){res.status(500).json({success:false,error:error.message});}
});

router.get('/llm-analysis-history/:id',(req,res)=>{
  try{
    const workspaceId=Number(req.query.workspaceId||0),id=Number(req.params.id);const row=db.prepare(`SELECT id,analysis_type,analyzed_ads,created_at,result_json FROM workspace_llm_analysis_history WHERE id=? AND workspace_id=?`).get(id,workspaceId);
    if(!row)return res.status(404).json({success:false,error:'Không tìm thấy bản phân tích trong profile này'});
    res.json({success:true,data:{...row,analysis:JSON.parse(row.result_json)}});
  }catch(error){res.status(500).json({success:false,error:error.message});}
});

router.get('/llm-analysis-latest',(req,res)=>{
  try{const workspaceId=Number(req.query.workspaceId||0);const row=db.prepare(`SELECT id,analyzed_ads,created_at,result_json FROM workspace_llm_analysis_history WHERE workspace_id=? AND analysis_type='running_ads' ORDER BY id DESC LIMIT 1`).get(workspaceId);if(!row)return res.json({success:true,data:null});res.json({success:true,data:{id:row.id,analyzed_ads:row.analyzed_ads,created_at:row.created_at,analysis:JSON.parse(row.result_json)}});}
  catch(error){res.status(500).json({success:false,error:error.message});}
});

router.delete('/llm-analysis-history/:id',(req,res)=>{
  try{const info=db.prepare('DELETE FROM workspace_llm_analysis_history WHERE id=? AND workspace_id=?').run(Number(req.params.id),Number(req.body?.workspaceId||0));res.json({success:true,deleted:info.changes});}
  catch(error){res.status(500).json({success:false,error:error.message});}
});

// GET /api/ads/performance
router.get('/performance', (req, res) => {
  try {
    const rows = stmts.getAdPerformance.all();
    const enriched = rows.map(r => {
      const isEffectivelyActive = r.ad_status === 'ACTIVE' && r.adset_status === 'ACTIVE' && r.campaign_status === 'ACTIVE';
      return {
        ...r,
        effective_status: isEffectivelyActive ? 'ACTIVE' : 'PAUSED',
        decision: getDecision(r, isEffectivelyActive),
        target_cpm: TARGET_CPM,
        service: parseService(r.ad_name)
      };
    });
    res.json({ success: true, data: enriched });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/ads/daily?days=7
router.get('/daily', (req, res) => {
  try {
    const days = parseInt(req.query.days || 7);
    const rows = stmts.getDailyStats.all({ days: `-${days} days` });
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/ads/monthly
router.get('/monthly', (req, res) => {
  try {
    const rows = stmts.getMonthlyStats.all();
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/ads/content
router.get('/content', (req, res) => {
  try {
    const rows = stmts.getContentPerformance.all();
    const enriched = rows.map(r => {
      // Logic for Winner vs Fatigue
      let category = 'monitor';
      if (r.cost_per_mess > 0 && r.cost_per_mess <= TARGET_CPM && r.total_spend >= 250000) {
        category = 'winner';
      } else if (r.cost_per_mess > TARGET_CPM && r.total_spend >= TARGET_CPM) {
        category = 'loser';
      } else if (r.total_spend < 250000 && r.cost_per_mess <= TARGET_CPM) {
        category = 'testing';
      }
      return { ...r, category, target_cpm: TARGET_CPM };
    });
    res.json({ success: true, data: enriched });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/ads/content/analyze
router.post('/content/analyze', async (req, res) => {
  try {
    const { adId, stats } = req.body;
    if (!adId) return res.status(400).json({ success: false, error: 'adId is required' });

    // Fetch Content text via Graph API
    let creativeData = {};
    try {
      const { token, apiVersion } = resolveAdsContext({ adId, workspaceId: req.body?.workspaceId });
      const graphRes = await axios.get(`https://graph.facebook.com/${apiVersion}/${adId}?fields=creative{name,body,title,object_story_spec,effective_object_story_id}&access_token=${token}`);
      creativeData = graphRes.data.creative || {};
    } catch (e) {
      console.error('Lỗi lấy creative data', e.message);
    }

    const { analyzeAdPerformance } = require('../services/aiReviewer');
    const result = await analyzeAdPerformance(stats, creativeData);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/ads/strategy
router.post('/strategy', async (req, res) => {
  try {
    const { timeLabel, serviceLabel, start_date, end_date, service_key, leads, bookings, arrivals, deals, revenue } = req.body;
    if (!start_date || !end_date) return res.status(400).json({ success: false, error: 'missing dates' });

    const key = service_key === 'all' ? 'ALL' : service_key;
    const rows = stmts.getStrategyPerformance.all({ start_date, end_date, service: key === 'ALL' ? 'ALL' : 'FILTER', service_key: key });

    // Aggregate stats
    let totalSpend = 0, totalMess = 0;
    const winners = [];
    const losers = [];
    let statusCounts = { testing: 0, scale: 0, scaled: 0, pause: 0, paused: 0, monitor: 0 };
    
    rows.forEach(r => {
      totalSpend += r.total_spend;
      totalMess += r.total_mess;
      
      const isEffectivelyActive = r.ad_status === 'ACTIVE' && r.adset_status === 'ACTIVE' && r.campaign_status === 'ACTIVE';
      const decision = getDecision(r, isEffectivelyActive);
      statusCounts[decision] = (statusCounts[decision] || 0) + 1;
      
      // Categorize
      if (r.cost_per_mess > 0 && r.cost_per_mess <= TARGET_CPM && r.total_spend >= 250000) {
        winners.push(r);
      } else if (r.cost_per_mess > TARGET_CPM && r.total_spend >= TARGET_CPM) {
        losers.push(r);
      }
    });
    
    const avgCpmess = totalMess > 0 ? (totalSpend / totalMess).toFixed(0) : 0;
    const topWinners = winners.sort((a,b) => b.total_spend - a.total_spend).slice(0, 3);
    const topLosers = losers.sort((a,b) => b.total_spend - a.total_spend).slice(0, 3);

    // Fetch creatives in parallel
    async function fetchCreative(ad) {
      if (!ad.ad_ids) return ad;
      const adId = ad.ad_ids.split(',')[0];
      try {
        const { token, apiVersion } = resolveAdsContext({ adId, workspaceId: req.body?.workspaceId });
        const graphRes = await axios.get(`https://graph.facebook.com/${apiVersion}/${adId}?fields=creative{name,body,title,object_story_spec,effective_object_story_id}&access_token=${token}`);
        ad.creative = graphRes.data.creative || {};
      } catch (e) {}
      return ad;
    }

    const [hydratedWinners, hydratedLosers] = await Promise.all([
      Promise.all(topWinners.map(fetchCreative)),
      Promise.all(topLosers.map(fetchCreative))
    ]);

    const { generateStrategyReport } = require('../services/aiReviewer');
    
    // Pass KPIs for the month
    const kpis = stmts.getKpis.all();
    let targetKpi = null;
    if (service_key !== 'all') {
      const matchLabel = Object.values(serviceKeywords).find(val => val === serviceLabel);
      targetKpi = kpis.find(k => k.service === matchLabel);
    } else {
      // Calculate total KPIs if 'all'
      targetKpi = {
        service: 'Tất cả',
        kpi_spend: kpis.reduce((sum,k) => sum + k.kpi_spend, 0),
        kpi_mess: kpis.reduce((sum,k) => sum + k.kpi_mess, 0)
      };
    }

    const campaignMetaString = `- Tổng số chiến dịch ghi nhận: ${rows.length}
- Tình trạng vận hành hiện tại (Phân loại tự động của hệ thống):
  * Mở mới (Testing): ${statusCounts.testing || 0} chiến dịch
  * Đang thắng và gánh team (Scale): ${statusCounts.scale || 0} chiến dịch
  * Vừa được tăng ngân sách (Scaled): ${statusCounts.scaled || 0} chiến dịch
  * Kém hiệu quả (Monitor/Nhìn lơ): ${statusCounts.monitor || 0} chiến dịch
  * Nát, cảnh báo đỏ (Cần Pause): ${statusCounts.pause || 0} chiến dịch
  * Quá nát, đã tự tắt (Paused): ${statusCounts.paused || 0} chiến dịch`;

    const manualMetrics = {
      leads: leads || 0,
      bookings: bookings || 0,
      arrivals: arrivals || 0,
      deals: deals || 0,
      revenue: revenue || 0
    };

    const result = await generateStrategyReport(
      timeLabel, serviceLabel, 
      { totalSpend, totalMess, avgCpmess, targetKpi, campaignMetaString, manualMetrics },
      hydratedWinners, hydratedLosers
    );

    if (result.success && result.report) {
       stmts.saveAiStrategy.run({
         time_label: timeLabel,
         service_label: serviceLabel,
         report_content: result.report
       });
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/ads/strategy/history
router.get('/strategy/history', (req, res) => {
  try {
    const history = stmts.getAiStrategyHistory.all();
    res.json({ success: true, data: history });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/ads/strategy/history/:id
router.get('/strategy/history/:id', (req, res) => {
  try {
    const record = stmts.getAiStrategyById.get(req.params.id);
    if (!record) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, data: record });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// DELETE /api/ads/strategy/history/:id
router.delete('/strategy/history/:id', (req, res) => {
  try {
    const info = db.prepare('DELETE FROM ai_strategy_history WHERE id = ?').run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/ads/services
router.get('/services', (req, res) => {
  try {
    const workspaceId=Number(req.query.workspaceId||1),accountIds=String(req.query.account_ids||'').split(',').filter(Boolean);
    const timeRange = req.query.timeRange || '30';
    const status = req.query.status || '';

    let dateCondition = "s.date >= date('now', '-30 days') AND s.date >= '2026-04-01'";
    if (timeRange.includes('|')) {
      const parts = timeRange.split('|');
      dateCondition = `s.date >= '${parts[0]}' AND s.date <= '${parts[1]}' AND s.date >= '2026-04-01'`;
    } else if (timeRange === 'today') dateCondition = "s.date = (SELECT MAX(date) FROM ad_daily_stats) AND s.date >= '2026-04-01'";
    else if (timeRange === 'yesterday') dateCondition = "s.date = date((SELECT MAX(date) FROM ad_daily_stats), '-1 days') AND s.date >= '2026-04-01'";
    else if (timeRange === 'this_week') dateCondition = "strftime('%W', s.date) = strftime('%W', (SELECT MAX(date) FROM ad_daily_stats)) AND strftime('%Y', s.date) = strftime('%Y', (SELECT MAX(date) FROM ad_daily_stats)) AND s.date >= '2026-04-01'";
    else if (timeRange === 'this_month') dateCondition = "strftime('%Y-%m', s.date) = strftime('%Y-%m', (SELECT MAX(date) FROM ad_daily_stats)) AND s.date >= '2026-04-01'";
    else if (timeRange === 'last_month') dateCondition = "strftime('%Y-%m', s.date) = strftime('%Y-%m', (SELECT MAX(date) FROM ad_daily_stats), '-1 month') AND s.date >= '2026-04-01'";

    let statusCondition = "1=1";
    if (status === 'ACTIVE') statusCondition = "c.ad_status = 'ACTIVE'";
    if (status === 'PAUSED') statusCondition = "(c.ad_status = 'PAUSED' OR c.ad_status = 'ARCHIVED')";

    const { db } = require('../db/database');
    const query = `
      SELECT 
        c.ad_name,
        COUNT(DISTINCT c.ad_id) as raw_ad_count,
        SUM(s.spend) as total_spend,
        SUM(s.impressions) as total_impressions,
        SUM(s.clicks) as total_clicks,
        SUM(s.link_clicks) as total_link_clicks,
        SUM(s.mess_started) as total_mess
      FROM ad_config c
      JOIN ad_daily_stats s ON c.ad_id = s.ad_id AND ${dateCondition}
      WHERE ${statusCondition} ${accountIds.length?`AND c.account_id IN (${accountIds.map(()=>'?').join(',')})`:''}
      GROUP BY c.ad_name
    `;
    const rows = db.prepare(query).all(...accountIds);

    const serviceGroups = {};

    rows.forEach(r => {
      const s = parseService(r.ad_name,workspaceId);
      if (!serviceGroups[s]) {
        serviceGroups[s] = {
          service: s,
          ad_count: 0,
          total_spend: 0,
          total_impressions: 0,
          total_clicks: 0,
          total_link_clicks: 0,
          total_mess: 0,
          ads_created: 0,
          ads_paused: 0,
          ads_scaled: 0,
          ads_decreased: 0
        };
      }
      serviceGroups[s].ad_count += r.raw_ad_count;
      serviceGroups[s].total_spend += (r.total_spend || 0);
      serviceGroups[s].total_impressions += (r.total_impressions || 0);
      serviceGroups[s].total_clicks += (r.total_clicks || 0);
      serviceGroups[s].total_link_clicks += (r.total_link_clicks || 0);
      serviceGroups[s].total_mess += (r.total_mess || 0);
    });

    // Action metrics query
    let createdCond = "1=1", updatedCond = "1=1";
    if (timeRange.includes('|')) {
      const parts = timeRange.split('|');
      createdCond = `substr(created_time, 1, 10) >= '${parts[0]}' AND substr(created_time, 1, 10) <= '${parts[1]}'`;
      updatedCond = `date(budget_updated_at) >= '${parts[0]}' AND date(budget_updated_at) <= '${parts[1]}'`;
    } else if (timeRange === 'today') {
      createdCond = "substr(created_time, 1, 10) = (SELECT MAX(date) FROM ad_daily_stats)";
      updatedCond = "date(budget_updated_at) = (SELECT MAX(date) FROM ad_daily_stats)";
    } else if (timeRange === 'yesterday') {
      createdCond = "substr(created_time, 1, 10) = date((SELECT MAX(date) FROM ad_daily_stats), '-1 days')";
      updatedCond = "date(budget_updated_at) = date((SELECT MAX(date) FROM ad_daily_stats), '-1 days')";
    } else if (timeRange === 'this_week') {
      createdCond = "strftime('%W', substr(created_time, 1, 10)) = strftime('%W', (SELECT MAX(date) FROM ad_daily_stats)) AND strftime('%Y', substr(created_time, 1, 10)) = strftime('%Y', (SELECT MAX(date) FROM ad_daily_stats))";
      updatedCond = "strftime('%W', date(budget_updated_at)) = strftime('%W', (SELECT MAX(date) FROM ad_daily_stats)) AND strftime('%Y', date(budget_updated_at)) = strftime('%Y', (SELECT MAX(date) FROM ad_daily_stats))";
    } else if (timeRange === 'this_month') {
      createdCond = "substr(created_time, 1, 7) = strftime('%Y-%m', (SELECT MAX(date) FROM ad_daily_stats))";
      updatedCond = "strftime('%Y-%m', date(budget_updated_at)) = strftime('%Y-%m', (SELECT MAX(date) FROM ad_daily_stats))";
    } else if (timeRange === 'last_month') {
      createdCond = "substr(created_time, 1, 7) = strftime('%Y-%m', (SELECT MAX(date) FROM ad_daily_stats), '-1 month')";
      updatedCond = "strftime('%Y-%m', date(budget_updated_at)) = strftime('%Y-%m', (SELECT MAX(date) FROM ad_daily_stats), '-1 month')";
    } else if (timeRange === '30') {
      createdCond = "substr(created_time, 1, 10) >= date((SELECT MAX(date) FROM ad_daily_stats), '-30 days')";
      updatedCond = "date(budget_updated_at) >= date((SELECT MAX(date) FROM ad_daily_stats), '-30 days')";
    }

    const actionQuery = `
      SELECT 
        ad_name,
        SUM(CASE WHEN ${createdCond} THEN 1 ELSE 0 END) as ads_created,
        SUM(CASE WHEN budget_trend = 'PAUSE' AND ${updatedCond} THEN 1 ELSE 0 END) as ads_paused,
        SUM(CASE WHEN budget_trend = 'UP' AND ${updatedCond} THEN 1 ELSE 0 END) as ads_scaled,
        SUM(CASE WHEN budget_trend = 'DOWN' AND ${updatedCond} THEN 1 ELSE 0 END) as ads_decreased
      FROM ad_config
      GROUP BY ad_name
    `;
    const actionRows = db.prepare(actionQuery).all();
    
    actionRows.forEach(r => {
      const s = parseService(r.ad_name);
      if (!serviceGroups[s]) {
        serviceGroups[s] = { service: s, ad_count: 0, total_spend: 0, total_impressions: 0, total_clicks: 0, total_link_clicks: 0, total_mess: 0, ads_created: 0, ads_paused: 0, ads_scaled: 0, ads_decreased: 0 };
      }
      if (serviceGroups[s].ads_created === undefined) {
         serviceGroups[s].ads_created = 0; serviceGroups[s].ads_paused = 0;
         serviceGroups[s].ads_scaled = 0; serviceGroups[s].ads_decreased = 0;
      }
      serviceGroups[s].ads_created += r.ads_created;
      serviceGroups[s].ads_paused += r.ads_paused;
      serviceGroups[s].ads_scaled += r.ads_scaled;
      serviceGroups[s].ads_decreased += r.ads_decreased;
    });

    // KPI matching
    let kpiCond = "1=1";
    if (timeRange.includes('|')) {
      const parts = timeRange.split('|');
      kpiCond = `start_date >= '${parts[0]}' AND (end_date <= '${parts[1]}' OR end_date IS NULL)`;
    } else if (timeRange === 'this_week') {
      kpiCond = "strftime('%W', start_date) = strftime('%W', 'now', 'localtime') AND strftime('%Y', start_date) = strftime('%Y', 'now', 'localtime')";
    } else if (timeRange === 'this_month') {
      kpiCond = "substr(start_date, 1, 7) = strftime('%Y-%m', 'now', 'localtime')";
    } else if (timeRange === 'last_month') {
      kpiCond = "substr(start_date, 1, 7) = strftime('%Y-%m', 'now', '-1 month', 'localtime')";
    }
    const kpis = db.prepare(`SELECT service, SUM(kpi_spend) as kpi_spend, SUM(kpi_mess) as kpi_mess FROM kpi_config WHERE workspace_id=? AND ${kpiCond} GROUP BY service`).all(workspaceId);
    const kpiMap = {};
    kpis.forEach(k => { kpiMap[k.service] = k; });

    const result = Object.values(serviceGroups).map(g => {
      g.cost_per_mess = g.total_mess ? Math.round(g.total_spend / g.total_mess) : g.total_spend;
      g.cpm = g.total_impressions ? Math.round((g.total_spend / g.total_impressions) * 1000) : 0;
      g.ctr = g.total_impressions ? (g.total_clicks / g.total_impressions) * 100 : 0;
      g.cpc = g.total_clicks ? Math.round(g.total_spend / g.total_clicks) : 0;
      
      const kpi = kpiMap[g.service] || { kpi_spend: 0, kpi_mess: 0 };
      g.target_spend = kpi.kpi_spend;
      g.target_mess = kpi.kpi_mess;
      
      return g;
    });

    result.sort((a, b) => b.total_spend - a.total_spend);
    
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/ads/sync
router.post('/sync', async (req, res) => {
  try {
    const { runAdsSync } = require('../services/adsSyncRunner');
    const task=runAdsSync('manual',{workspaceId:Number(req.body?.workspaceId||0)});
    const accepted=await Promise.race([task,new Promise(resolve=>setTimeout(()=>resolve({accepted:true,background:true}),30))]);
    clearApiCache();
    res.status(accepted.accepted===false?409:202).json({ success:accepted.accepted!==false, ...accepted, message:accepted.accepted===false?accepted.reason:'Đã bắt đầu đồng bộ nền' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/sync/status', (req,res) => {
  try { const { getAdsSyncStatus }=require('../services/adsSyncRunner');res.json({success:true,data:getAdsSyncStatus(Number(req.query.workspaceId||0))}); }
  catch(error){res.status(500).json({success:false,error:error.message});}
});

router.post('/backfill',(req,res)=>{try{const workspaceId=Number(req.body?.workspaceId||0),historyDays=Math.max(31,Math.min(1095,Number(req.body?.historyDays||365)));if(!workspaceId)return res.status(400).json({success:false,error:'Thiếu profile'});const {runAdsSync}=require('../services/adsSyncRunner');const task=runAdsSync('backfill',{workspaceId,historyDays});Promise.race([task,new Promise(resolve=>setTimeout(()=>resolve({accepted:true,background:true}),30))]).then(result=>{});clearApiCache();res.status(202).json({success:true,accepted:true,message:`Đã bắt đầu backfill ${historyDays} ngày cho profile`});}catch(error){res.status(500).json({success:false,error:error.message});}});

// GET /api/ads/wallet
router.get('/wallet', (req, res) => {
  try {
    const data = stmts.getWalletData.get() || { total_deposits: 0, all_time_spend_vat: 0 };
    const balance = (data.total_deposits || 0) - (data.all_time_spend_vat || 0);
    res.json({ success: true, data: { ...data, balance } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/ads/wallet/deposit
router.post('/wallet/deposit', (req, res) => {
  try {
    const { amount, overwrite } = req.body;
    if (typeof amount !== 'number') return res.status(400).json({ success: false, error: 'Invalid amount' });

    let finalValue = amount;
    if (!overwrite) {
      const current = (stmts.getWalletData.get() || {}).total_deposits || 0;
      finalValue = current + amount;
    }

    stmts.updateDeposit.run({ val: finalValue.toString() });
    clearApiCache();
    res.json({ success: true, message: 'Cập nhật ví thành công', total_deposits: finalValue });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/ads/daily-report
router.get('/daily-report', (req, res) => {
  try {
    const targetDate = req.query.date || null;
    const rows = stmts.getDailyReportWithAvg.all({ target_date: targetDate });
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/ads/:adId/pause — Pause ad via FB API
router.post('/:adId/pause', async (req, res) => {
  try {
    const result = await executePauseAd({
      adId: req.params.adId,
      workspaceId: req.body?.workspaceId || req.query?.workspaceId
    });
    clearApiCache();
    res.json(result);
  } catch (e) {
    const errData = e?.response?.data?.error || {};
    const msg = errData.error_user_msg || errData.error_user_title || errData.message || e.message;
    res.status(e.statusCode || 500).json({ success: false, error: msg });
  }
});

// POST /api/ads/:adId/scale — Increase adset budget (+20% by default or custom percent)
router.post('/:adId/scale', async (req, res) => {
  try {
    const percent = req.body?.percent !== undefined ? Number(req.body.percent) : 20;
    const result = await executeBudgetChange({
      adId: req.params.adId,
      percent,
      newBudget: req.body?.newBudget,
      workspaceId: req.body?.workspaceId || req.query?.workspaceId
    });
    clearApiCache();
    res.json(result);
  } catch (e) {
    const errData = e?.response?.data?.error || {};
    const msg = errData.error_user_msg || errData.error_user_title || errData.message || e.message;
    res.status(e.statusCode || 500).json({ success: false, error: msg });
  }
});

// POST /api/ads/:adId/budget — adjust adset/campaign budget by percentage (+10%, +20%, -20%, -10%, custom) or exact newBudget
router.post('/:adId/budget', async (req, res) => {
  try {
    const percent = req.body?.percent !== undefined ? Number(req.body.percent) : undefined;
    const newBudget = req.body?.newBudget !== undefined ? Number(req.body.newBudget) : undefined;
    if (percent === undefined && newBudget === undefined) {
      return res.status(400).json({ success: false, error: 'Cần cung cấp percent hoặc newBudget' });
    }
    const result = await executeBudgetChange({
      adId: req.params.adId,
      percent,
      newBudget,
      workspaceId: req.body?.workspaceId || req.query?.workspaceId
    });
    clearApiCache();
    res.json(result);
  } catch (e) {
    const errData = e?.response?.data?.error || {};
    const msg = errData.error_user_msg || errData.error_user_title || errData.message || e.message;
    res.status(e.statusCode || 500).json({ success: false, error: msg });
  }
});

// GET /api/ads/creatives - Trả về toàn bộ Ads với Creative + Stats từ DB
router.get('/creatives', (req, res) => {
  try {
    const workspaceId = Number(req.query.workspaceId || 1);
    const wsAccounts = db.prepare('SELECT account_id FROM workspace_ad_accounts WHERE workspace_id = ?').all(workspaceId).map(r => String(r.account_id));
    const accountIds = new Set(String(req.query.account_ids || req.query.account_id || '').split(',').map(x => x.trim()).filter(Boolean));
    if (!accountIds.size && wsAccounts.length > 0) {
      wsAccounts.forEach(id => accountIds.add(id));
    }
    const totalWsAccs = db.prepare('SELECT COUNT(*) as count FROM workspace_ad_accounts').get()?.count || 0;
    const status = req.query.status || null;

    const accIdsStr = Array.from(accountIds).sort().join(',');
    const cacheKey = `creatives_ws${workspaceId}_${accIdsStr}_${status || 'ALL'}`;
    const cached = apiCache.get(cacheKey);
    if (cached) return res.json(cached);

    const maxDate = db.prepare('SELECT MAX(date) AS val FROM ad_daily_stats').get()?.val || new Date().toISOString().slice(0, 10);
    const params = { maxDate };
    const conditions = [];

    if (accountIds.size > 0) {
      const accList = Array.from(accountIds);
      conditions.push(`c.account_id IN (${accList.map((_, i) => `@acc${i}`).join(',')})`);
      accList.forEach((id, i) => params[`acc${i}`] = id);
    } else if (totalWsAccs > 0) {
      conditions.push("1 = 0");
    }

    // Fix: use effective status - all 3 levels must match
    if (status === 'ACTIVE') {
      conditions.push("c.ad_status = 'ACTIVE' AND c.adset_status = 'ACTIVE' AND c.campaign_status = 'ACTIVE'");
    } else if (status === 'PAUSED') {
      conditions.push("(c.ad_status = 'PAUSED' OR c.adset_status = 'PAUSED' OR c.campaign_status = 'PAUSED')");
    }
    
    let query = `
      SELECT 
        c.ad_id, c.ad_name, c.account_id, c.ad_status,
        c.campaign_id, c.campaign_name, c.campaign_status,
        c.adset_id, c.adset_name, c.adset_status,
        c.adset_budget, c.campaign_budget, c.targeting,
        c.post_url, c.budget_trend,
        cr.thumbnail_url, cr.video_url, cr.body_text,
        cr.video_id, cr.content_updated_at, cr.synced_at,
        d.updated_at as ai_diagnosis_saved_at,
        COALESCE(json_extract(d.diagnosis_json, '$.summary'), json_extract(d.diagnosis_json, '$.coreDiagnosis'), json_extract(d.diagnosis_json, '$.diagnosis')) as ai_diagnosis_summary,
        json_extract(d.diagnosis_json, '$.verdict') as ai_diagnosis_verdict,
        json_extract(d.diagnosis_json, '$.verdictTitle') as ai_diagnosis_verdict_title,
        json_extract(d.diagnosis_json, '$.healthScore') as ai_diagnosis_health_score,
        CASE
          WHEN c.ad_status = 'ACTIVE' AND c.adset_status = 'ACTIVE' AND c.campaign_status = 'ACTIVE' THEN 'ACTIVE'
          ELSE 'PAUSED'
        END as effective_status,
        ROUND(SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.spend ELSE 0 END), 0) as spend_7d,
        SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.mess_started ELSE 0 END) as mess_7d,
        CASE WHEN SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.mess_started ELSE 0 END) > 0
          THEN ROUND(SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.spend ELSE 0 END) / SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.mess_started ELSE 0 END), 0)
          ELSE NULL
        END as cpmess_7d,
        SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.leads ELSE 0 END) as leads_7d,
        CASE WHEN SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.leads ELSE 0 END) > 0 THEN ROUND(SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.spend ELSE 0 END) / SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.leads ELSE 0 END), 0) ELSE NULL END as cost_per_lead_7d,
        SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.purchases ELSE 0 END) as purchases_7d,
        CASE WHEN SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.purchases ELSE 0 END) > 0 THEN ROUND(SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.spend ELSE 0 END) / SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.purchases ELSE 0 END), 0) ELSE NULL END as cost_per_purchase_7d,
        COUNT(DISTINCT CASE WHEN s.date >= date(@maxDate, '-6 days') AND s.spend > 0 THEN s.date END) as run_days_7d,
        ROUND(SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.spend ELSE 0 END) / NULLIF(COUNT(DISTINCT CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.date END), 0), 0) as spend_per_day,
        SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.impressions ELSE 0 END) as impressions_7d,
        SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.clicks ELSE 0 END) as clicks_7d,
        CASE WHEN SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.impressions ELSE 0 END) > 0 THEN ROUND(SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.spend ELSE 0 END)*1000/SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.impressions ELSE 0 END), 0) ELSE 0 END as cpm_7d,
        CASE WHEN SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.impressions ELSE 0 END) > 0 THEN ROUND(SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.clicks ELSE 0 END)*100.0/SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.impressions ELSE 0 END), 2) ELSE 0 END as ctr_7d,
        CASE WHEN SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.clicks ELSE 0 END) > 0 THEN ROUND(SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.mess_started ELSE 0 END)*100.0/SUM(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.clicks ELSE 0 END), 1) ELSE 0 END as mess_rate_7d,
        ROUND(AVG(CASE WHEN s.date >= date(@maxDate, '-6 days') THEN s.frequency END), 2) as avg_frequency_7d,
        ROUND(SUM(CASE WHEN s.date = @maxDate THEN s.spend ELSE 0 END), 0) AS spend_today,
        SUM(CASE WHEN s.date = @maxDate THEN s.mess_started ELSE 0 END) AS mess_today,
        SUM(CASE WHEN s.date = @maxDate THEN s.leads ELSE 0 END) AS leads_today,
        SUM(CASE WHEN s.date = @maxDate THEN s.purchases ELSE 0 END) AS purchases_today,
        ROUND(SUM(s.spend), 0) as spend_month,
        SUM(s.mess_started) as mess_month,
        SUM(s.leads) as leads_month,
        SUM(s.purchases) as purchases_month,
        COALESCE(alt.spend_lifetime, 0) as spend_lifetime,
        COALESCE(alt.mess_lifetime, 0) as mess_lifetime,
        COALESCE(alt.leads_lifetime, 0) as leads_lifetime,
        COALESCE(alt.purchases_lifetime, 0) as purchases_lifetime
      FROM ad_config c
      LEFT JOIN ad_creatives cr ON cr.ad_id = c.ad_id
      LEFT JOIN ad_ai_diagnoses d ON d.ad_id = c.ad_id
      LEFT JOIN (
        SELECT ad_id, ROUND(SUM(spend),0) AS spend_lifetime, SUM(mess_started) AS mess_lifetime, SUM(leads) AS leads_lifetime, SUM(purchases) AS purchases_lifetime
        FROM ad_daily_stats
        GROUP BY ad_id
      ) alt ON alt.ad_id = c.ad_id
      LEFT JOIN ad_daily_stats s ON s.ad_id = c.ad_id 
        AND s.date BETWEEN date(@maxDate, '-29 days') AND @maxDate
    `;
    
    if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`;
    query += ` GROUP BY c.ad_id ORDER BY spend_7d DESC NULLS LAST LIMIT 200`;
    
    const rows = db.prepare(query).all(params);

    // Dynamic CPMess benchmark: median daily CPMess per service over the last 30 days.
    // Median is robust against isolated expensive/cheap days. Require >=7 delivery days
    // and >=20 messages for a service benchmark; otherwise use the global benchmark.
    const historyQuery = `
      SELECT s.date, s.ad_name, SUM(s.spend) AS spend, SUM(s.mess_started) AS mess
      FROM ad_daily_stats s
      LEFT JOIN ad_config c ON c.ad_id = s.ad_id
      WHERE s.date >= date(@hMaxDate, '-29 days')
      ${accountIds.size > 0 ? `AND c.account_id IN (${Array.from(accountIds).map((_, i) => `@hacc${i}`).join(',')})` : (totalWsAccs > 0 ? 'AND 1 = 0' : '')}
      GROUP BY s.date, s.ad_id
    `;
    const historyParams = { hMaxDate: maxDate };
    if (accountIds.size > 0) {
      Array.from(accountIds).forEach((id, i) => historyParams[`hacc${i}`] = id);
    }
    const history = db.prepare(historyQuery).all(historyParams);

    const serviceDaily = new Map();
    const globalDaily = new Map();
    history.forEach(item => {
      const service = parseService(item.ad_name, workspaceId);
      const serviceKey = `${service}|${item.date}`;
      const serviceValue = serviceDaily.get(serviceKey) || { service, date:item.date, spend:0, mess:0 };
      serviceValue.spend += Number(item.spend) || 0;
      serviceValue.mess += Number(item.mess) || 0;
      serviceDaily.set(serviceKey, serviceValue);
      const globalValue = globalDaily.get(item.date) || { spend:0, mess:0 };
      globalValue.spend += Number(item.spend) || 0;
      globalValue.mess += Number(item.mess) || 0;
      globalDaily.set(item.date, globalValue);
    });
    const globalEligible = [...globalDaily.values()].filter(item => item.mess > 0);
    const globalBenchmark = Math.round(median(globalEligible.map(item => item.spend / item.mess))) || TARGET_CPM;
    const serviceBuckets = {};
    [...serviceDaily.values()].forEach(item => {
      if (!serviceBuckets[item.service]) serviceBuckets[item.service] = [];
      serviceBuckets[item.service].push(item);
    });
    const benchmarks = {};
    Object.entries(serviceBuckets).forEach(([service, days]) => {
      const eligible = days.filter(item => item.mess > 0);
      const totalMess = days.reduce((sum, item) => sum + item.mess, 0);
      benchmarks[service] = eligible.length >= 7 && totalMess >= 20
        ? { value:Math.round(median(eligible.map(item => item.spend / item.mess))), source:'service', days:eligible.length, mess:totalMess }
        : { value:globalBenchmark, source:'global', days:eligible.length, mess:totalMess };
    });
    const enriched = rows.map(row => {
      const service = parseService(row.ad_name, workspaceId);
      const benchmark = benchmarks[service] || { value:globalBenchmark, source:'global', days:globalEligible.length, mess:globalEligible.reduce((sum,item)=>sum+item.mess,0) };
      return { ...row, service, cpmess_benchmark_30d:benchmark.value, benchmark_source:benchmark.source, benchmark_days:benchmark.days, benchmark_mess:benchmark.mess };
    });
    const responseData = { success: true, data: enriched, benchmark: { global:globalBenchmark, window_days:30 } };
    apiCache.set(cacheKey, responseData);
    res.json(responseData);
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/ads/daily/:adId
router.get('/daily/:adId', (req, res) => {
  try {
    const { adId } = req.params;
    const rows = db.prepare(`
      SELECT date, 
        ROUND(SUM(spend),0) as spend, 
        SUM(mess_started) as mess,
        SUM(impressions) as impressions,
        SUM(clicks) as clicks,
        AVG(frequency) as frequency,
        CASE WHEN SUM(impressions) > 0 THEN ROUND(SUM(spend)*1000/SUM(impressions), 0) ELSE 0 END as cpm,
        CASE WHEN SUM(impressions) > 0 THEN ROUND(SUM(clicks)*100.0/SUM(impressions), 2) ELSE 0 END as ctr,
        CASE WHEN SUM(mess_started) > 0 THEN ROUND(SUM(spend)/SUM(mess_started), 0) ELSE 0 END as cpmess
      FROM ad_daily_stats
      WHERE ad_id = @adId
        AND date BETWEEN date((SELECT MAX(date) FROM ad_daily_stats), '-6 days')
                     AND (SELECT MAX(date) FROM ad_daily_stats)
      GROUP BY date ORDER BY date ASC
    `).all({ adId });
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


router.evaluateAdRule = evaluateAdRule;
router.getBudgetAction = getBudgetAction;
router.getActionType = getActionType;
router.describeTargetingSnippet = describeTargetingSnippet;

module.exports = router;
