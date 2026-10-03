const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const { config, validateConfig, reloadFromDisk } = require('./config');
const { distribute } = require('./distributor');
const { reviewContent, getGuidelines, updateGuidelines } = require('./services/aiReviewer');
const { publishToWordPress } = require('./services/wordpress');
const logger = require('./utils/logger');
const adsDashboardRouter = require('./routes/adsDashboard');
const contentGeneratorRouter = require('./routes/contentGenerator');
const facebookExportRouter = require('./routes/facebookExport');
const pageAnalyticsRouter = require('./routes/pageAnalytics');
const { loadSecrets, saveSecrets, migrateFromProjectEnv, secretPath } = require('./services/secretStore');

const projectEnvPath = path.join(__dirname, '..', '.env');
if (migrateFromProjectEnv(projectEnvPath)) {
  reloadFromDisk();
  logger.info('Sensitive keys migrated to macOS local secret store', { path: secretPath });
}
try {
  const { db: secretMigrationDb } = require('./db/database');
  const workspaceSecrets = {};
  secretMigrationDb.prepare("SELECT id,ads_access_token FROM workspaces WHERE ads_access_token IS NOT NULL AND ads_access_token!=''").all().forEach(w=>workspaceSecrets[`WORKSPACE_${w.id}_ADS_TOKEN`]=w.ads_access_token);
  secretMigrationDb.prepare("SELECT workspace_id,page_id,access_token FROM workspace_pages WHERE access_token IS NOT NULL AND access_token!=''").all().forEach(p=>workspaceSecrets[`WORKSPACE_${p.workspace_id}_PAGE_${p.page_id}_TOKEN`]=p.access_token);
  if (Object.keys(workspaceSecrets).length) {
    saveSecrets(workspaceSecrets);
    secretMigrationDb.exec("UPDATE workspaces SET ads_access_token=''; UPDATE workspace_pages SET access_token='';");
    logger.info('Workspace tokens migrated out of SQLite', { path: secretPath });
  }
} catch (error) { logger.warn('Workspace secret migration skipped', { error:error.message }); }

const app = express();

// Ensure directories exist
const uploadsDir = path.join(__dirname, '..', 'uploads');
const logsDir = path.join(__dirname, '..', 'logs');
[uploadsDir, logsDir].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

if (config.auth.user && config.auth.password) {
  const crypto = require('crypto');
  app.use((req, res, next) => {
    const publicGet=['GET','HEAD'].includes(req.method)&&(
      ['/','/agentic-dashboard','/ads-dashboard','/report-settings','/api/workspaces'].includes(req.path)||
      req.path.startsWith('/api/ads/')||req.path.startsWith('/api/pages')||req.path.startsWith('/css/')||req.path.startsWith('/js/')||req.path.startsWith('/images/')||req.path==='/favicon.ico'
    );
    const publicReportWrite=req.method==='POST'&&(
      ['/api/ads/cpmess-targets','/api/ads/funnel-targets','/api/ads/classification-rules','/api/profile-access','/api/ads/diagnose-single-ad','/api/ads/execute-action','/api/ads/patch-creatives','/api/ads/sync','/api/ads/backfill'].includes(req.path)||
      req.path.startsWith('/api/ads/')||req.path.startsWith('/api/pages')
    );
    if(publicGet||publicReportWrite)return next();
    const encoded = String(req.headers.authorization || '').replace(/^Basic\s+/i, '');
    let user = '', password = '';
    try { [user, password] = Buffer.from(encoded, 'base64').toString('utf8').split(/:(.*)/s, 2); } catch (_) {}
    const same = (a, b) => { const aa=Buffer.from(String(a));const bb=Buffer.from(String(b));return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb); };
    if (!same(user, config.auth.user) || !same(password, config.auth.password)) {
      res.set('WWW-Authenticate', 'Basic realm="Auto Facebook Ads", charset="UTF-8"');
      return res.status(401).send('Authentication required');
    }
    next();
  });
}

app.use(express.static(path.join(__dirname, '..', 'public')));

// File upload config — supports multiple files
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    cb(null, `${timestamp}-${file.originalname}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 1024 * 1024 * 1024 } }); // 1 GB

const scratchUploadsDir = path.join(__dirname, '..', 'scratch', 'uploads');
if (!fs.existsSync(scratchUploadsDir)) fs.mkdirSync(scratchUploadsDir, { recursive: true });
const scratchStorage = multer.diskStorage({
  destination: scratchUploadsDir,
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});
const scratchUpload = multer({ storage: scratchStorage });

function workspaceAdsToken(workspaceId, accountId) {
  const { db } = require('./db/database');
  const id = Number(workspaceId || 0);
  if (!id) {
    if (accountId) {
      const match = db.prepare('SELECT workspace_id FROM workspace_ad_accounts WHERE account_id=? ORDER BY is_default DESC LIMIT 1').get(accountId);
      if (match?.workspace_id) {
        const wsToken = loadSecrets()[`WORKSPACE_${match.workspace_id}_ADS_TOKEN`];
        if (wsToken) return wsToken;
        const ws = db.prepare('SELECT ads_access_token FROM workspaces WHERE id=?').get(match.workspace_id);
        if (ws?.ads_access_token) return ws.ads_access_token;
      }
    }
    return loadSecrets().FB_ADS_ACCESS_TOKEN || config.facebook.adsAccessToken || null;
  }
  const allowed = accountId
    ? db.prepare('SELECT 1 FROM workspace_ad_accounts WHERE workspace_id=? AND account_id=?').get(id, accountId)
    : db.prepare('SELECT 1 FROM workspaces WHERE id=? AND is_active=1').get(id);
  if (!allowed) return null;
  return loadSecrets()[`WORKSPACE_${id}_ADS_TOKEN`] || db.prepare('SELECT ads_access_token FROM workspaces WHERE id=?').get(id)?.ads_access_token || null;
}

// ==========================================
// API Routes
// ==========================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    dryRun: config.dryRun,
    timestamp: new Date().toISOString(),
  });
});

// Ads Dashboard API
app.get('/api/ads/config', (req, res) => {
  const { db } = require('./db/database');
  const workspaceId = Number(req.query.workspaceId || 0);
  if (workspaceId) {
    const workspace = db.prepare('SELECT id,name FROM workspaces WHERE id=? AND is_active=1').get(workspaceId);
    if (!workspace) return res.status(404).json({ error:'Không tìm thấy doanh nghiệp' });
    return res.json({ workspace, pages:db.prepare('SELECT page_id id,name FROM workspace_pages WHERE workspace_id=? ORDER BY is_default DESC,name').all(workspaceId), adAccounts:db.prepare('SELECT account_id FROM workspace_ad_accounts WHERE workspace_id=? ORDER BY is_default DESC,name').all(workspaceId).map(r=>r.account_id) });
  }
  res.json({
    pages: (config.facebook.pages || []).map(p => ({ id: p.id, name: p.name || p.id })),
    adAccounts: config.facebook.adAccountIds || []
  });
});
app.use('/api/ads', adsDashboardRouter);
app.use('/api/pages', pageAnalyticsRouter);

const adsManager = require('./services/facebookAdsManager');
const { generateRecommendations, analyzeRunningAds, diagnoseSingleAd } = require('./services/aiOptimizer');

app.post('/api/ads/auto-publish', scratchUpload.array('media', 30), async (req, res) => {
  try {
    let { adAccountId, accessToken, pageId, budget, targeting, content, link, objective, location, interests, gender, age_min, age_max, campaignName, adsetName, ads } = req.body;
    if (req.body.workspaceId) {
      const { db } = require('./db/database');
      const connection=db.prepare('SELECT ads_access_token FROM workspaces WHERE id=? AND is_active=1').get(Number(req.body.workspaceId));
      accessToken=loadSecrets()[`WORKSPACE_${Number(req.body.workspaceId)}_ADS_TOKEN`]||connection?.ads_access_token;
      const allowedAccount=db.prepare('SELECT 1 FROM workspace_ad_accounts WHERE workspace_id=? AND account_id=?').get(Number(req.body.workspaceId),adAccountId);
      const allowedPage=db.prepare('SELECT access_token FROM workspace_pages WHERE workspace_id=? AND page_id=?').get(Number(req.body.workspaceId),pageId);
      if (!connection || !allowedAccount || !allowedPage) return res.status(403).json({error:'Ad Account hoặc Page không thuộc doanh nghiệp đang chọn'});
    }
    accessToken = accessToken || config.facebook.adsAccessToken;
    const files = req.files || [];

    if (!files.length) return res.status(400).json({ error: 'Cần ít nhất một ảnh hoặc video' });
    let adItems = [];
    try { adItems = ads ? JSON.parse(ads) : []; } catch (_) {}

    // 1. Create Campaign
    const campaign = await adsManager.createCampaign(
      adAccountId, 
      accessToken, 
      campaignName || `Batch Ads ${new Date().toISOString().slice(0, 10)}`,
      objective || 'OUTCOME_TRAFFIC', 
      parseInt(budget, 10), 
      ['NONE']
    );

    // 2. Create Ad Set
    let targetObj = {};
    try {
        targetObj = typeof targeting === 'string' ? JSON.parse(targeting) : (targeting || {});
    } catch(e) {
        targetObj = {};
    }

    if (location) {
        targetObj.geo_locations = adsManager.getLocation(location);
    }
    if (interests) {
        const foundInterests = await adsManager.searchInterests(accessToken, interests);
        if (foundInterests.length > 0) {
            targetObj.flexible_spec = [{ interests: foundInterests }];
        }
    }
    if (age_min) targetObj.age_min = parseInt(age_min, 10);
    if (age_max) targetObj.age_max = parseInt(age_max, 10);
    if (gender === 'FEMALE') targetObj.genders = [2];
    if (gender === 'MALE') targetObj.genders = [1];
    
    const adSet = await adsManager.createAdSet(
      adAccountId, 
      accessToken, 
      campaign.id, 
      adsetName || `${location || 'VN'} · ${age_min || 18}-${age_max || 65}`,
      targetObj, 
      parseInt(budget, 10), 
      100 // default dummy bid amount
    );

    const results = [];
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const item = adItems[index] || {};
      try {
        const mediaRes = await adsManager.uploadMedia(adAccountId, accessToken, file.path);
        const firstImage = mediaRes.images && mediaRes.images[Object.keys(mediaRes.images)[0]];
        const creative = await adsManager.createAdCreative(adAccountId, accessToken, pageId,
          `${item.name || file.originalname} · Creative`, item.content || content || '', link || '', firstImage?.hash || null, mediaRes.id || null);
        const ad = await adsManager.createAd(adAccountId, accessToken, adSet.id, creative.id, item.name || file.originalname.replace(/\.[^.]+$/, ''));
        results.push({ success: true, file: file.originalname, adId: ad.id });
      } catch (error) {
        results.push({ success: false, file: file.originalname, error: error.response?.data?.error?.message || error.message });
      }
    }
    files.forEach(file => { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); });
    res.json({ success: results.some(item => item.success), campaignId: campaign.id, adsetId: adSet.id, results });
  } catch (err) {
    (req.files || []).forEach(file => { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); });
    logger.error('Auto publish error', { error: err.message });
    res.status(500).json({ error: 'Failed to auto publish ad', details: err.message, response: err.response?.data });
  }
});

app.get('/api/ads/optimize', async (req, res) => {
  try {
    const adAccountId = req.query.adAccountId || req.body.adAccountId || 'all';
    const workspaceId=Number(req.query.workspaceId||0);
    const accountIds=String(req.query.account_ids||'').split(',').map(x=>x.trim()).filter(Boolean);
    const mode=req.query.mode==='analysis'?'analysis':'generate';

    const { db } = require('./db/database');
    
    let query = `
      SELECT 
        c.ad_id, c.ad_name, c.account_id, c.ad_status,
        c.campaign_id, c.campaign_name, c.campaign_status,
        c.adset_id, c.adset_name, c.adset_status,
        c.adset_budget, c.campaign_budget, c.targeting,
        c.post_url, c.budget_trend,
        cr.thumbnail_url, cr.video_url, cr.body_text,
        cr.video_id, cr.content_updated_at, cr.synced_at,
        ROUND(SUM(s.spend), 0) as spend_7d,
        SUM(s.mess_started) as mess_7d,
        SUM(s.leads) as leads_7d,
        SUM(s.purchases) as purchases_7d,
        CASE WHEN SUM(s.mess_started) > 0
          THEN ROUND(SUM(s.spend) / SUM(s.mess_started), 0)
          ELSE NULL
        END as cpmess_7d,
        CASE WHEN SUM(s.leads)>0 THEN ROUND(SUM(s.spend)/SUM(s.leads),0) END as cost_per_lead_7d,
        CASE WHEN SUM(s.purchases)>0 THEN ROUND(SUM(s.spend)/SUM(s.purchases),0) END as cost_per_purchase_7d,
        ROUND((SELECT COALESCE(SUM(h.spend),0) FROM ad_daily_stats h WHERE h.ad_id=c.ad_id AND h.date BETWEEN date((SELECT MAX(date) FROM ad_daily_stats),'-29 days') AND (SELECT MAX(date) FROM ad_daily_stats)),0) as spend_30d,
        (SELECT COALESCE(SUM(h.mess_started),0) FROM ad_daily_stats h WHERE h.ad_id=c.ad_id AND h.date BETWEEN date((SELECT MAX(date) FROM ad_daily_stats),'-29 days') AND (SELECT MAX(date) FROM ad_daily_stats)) as mess_30d,
        (SELECT COALESCE(SUM(h.leads),0) FROM ad_daily_stats h WHERE h.ad_id=c.ad_id AND h.date BETWEEN date((SELECT MAX(date) FROM ad_daily_stats),'-29 days') AND (SELECT MAX(date) FROM ad_daily_stats)) as leads_30d,
        (SELECT COALESCE(SUM(h.purchases),0) FROM ad_daily_stats h WHERE h.ad_id=c.ad_id AND h.date BETWEEN date((SELECT MAX(date) FROM ad_daily_stats),'-29 days') AND (SELECT MAX(date) FROM ad_daily_stats)) as purchases_30d,
        ROUND((SELECT COALESCE(SUM(h.spend),0) FROM ad_daily_stats h WHERE h.ad_id=c.ad_id),0) as spend_lifetime,
        (SELECT COALESCE(SUM(h.mess_started),0) FROM ad_daily_stats h WHERE h.ad_id=c.ad_id) as mess_lifetime,
        (SELECT COALESCE(SUM(h.leads),0) FROM ad_daily_stats h WHERE h.ad_id=c.ad_id) as leads_lifetime,
        (SELECT COALESCE(SUM(h.purchases),0) FROM ad_daily_stats h WHERE h.ad_id=c.ad_id) as purchases_lifetime,
        SUM(CASE WHEN s.date>=date((SELECT MAX(date) FROM ad_daily_stats),'-2 days') THEN s.spend ELSE 0 END) as spend_3d,
        SUM(CASE WHEN s.date>=date((SELECT MAX(date) FROM ad_daily_stats),'-2 days') THEN s.mess_started ELSE 0 END) as mess_3d,
        SUM(CASE WHEN s.date>=date((SELECT MAX(date) FROM ad_daily_stats),'-2 days') THEN s.leads ELSE 0 END) as leads_3d,
        SUM(CASE WHEN s.date>=date((SELECT MAX(date) FROM ad_daily_stats),'-2 days') THEN s.purchases ELSE 0 END) as purchases_3d,
        SUM(CASE WHEN s.date BETWEEN date((SELECT MAX(date) FROM ad_daily_stats),'-5 days') AND date((SELECT MAX(date) FROM ad_daily_stats),'-3 days') THEN s.spend ELSE 0 END) as spend_prev_3d,
        SUM(CASE WHEN s.date BETWEEN date((SELECT MAX(date) FROM ad_daily_stats),'-5 days') AND date((SELECT MAX(date) FROM ad_daily_stats),'-3 days') THEN s.mess_started ELSE 0 END) as mess_prev_3d,
        SUM(CASE WHEN s.date BETWEEN date((SELECT MAX(date) FROM ad_daily_stats),'-5 days') AND date((SELECT MAX(date) FROM ad_daily_stats),'-3 days') THEN s.leads ELSE 0 END) as leads_prev_3d,
        SUM(CASE WHEN s.date BETWEEN date((SELECT MAX(date) FROM ad_daily_stats),'-5 days') AND date((SELECT MAX(date) FROM ad_daily_stats),'-3 days') THEN s.purchases ELSE 0 END) as purchases_prev_3d,
        SUM(s.impressions) as impressions_7d, SUM(s.clicks) as clicks_7d,
        CASE WHEN SUM(s.impressions)>0 THEN ROUND(SUM(s.clicks)*100.0/SUM(s.impressions),2) ELSE 0 END as ctr_7d,
        ROUND(AVG(s.frequency),2) as frequency_7d,
        COUNT(DISTINCT CASE WHEN s.spend>0 THEN s.date END) as run_days_7d,
        ROUND(SUM(s.spend) / NULLIF(COUNT(DISTINCT s.date), 0), 0) as spend_per_day
      FROM ad_config c
      LEFT JOIN ad_creatives cr ON cr.ad_id = c.ad_id
      LEFT JOIN ad_daily_stats s ON s.ad_id = c.ad_id
        AND s.date >= date((SELECT MAX(date) FROM ad_daily_stats), '-6 days')
      WHERE c.ad_status = 'ACTIVE' AND c.adset_status='ACTIVE' AND c.campaign_status='ACTIVE'
    `;
    
    const params = {};
    if (adAccountId !== 'all') {
      query += " AND c.account_id = @accountId";
      params.accountId = adAccountId;
    }
    if(accountIds.length){query+=` AND c.account_id IN (${accountIds.map((_,i)=>`@scope${i}`).join(',')})`;accountIds.forEach((id,i)=>params[`scope${i}`]=id);}
    if(workspaceId&&!accountIds.length){query+=' AND c.account_id IN (SELECT account_id FROM workspace_ad_accounts WHERE workspace_id=@workspaceId)';params.workspaceId=workspaceId;}
    
    query += " GROUP BY c.ad_id ORDER BY spend_7d DESC NULLS LAST LIMIT 40";
    
    let dbRows = [];
    try {
      dbRows = db.prepare(query).all(params);
    } catch (dbErr) {
      logger.error('DB query failed in optimize', { error: dbErr.message });
    }
    
    const nameRules=workspaceId?db.prepare(`SELECT kind,prefix,label,priority FROM workspace_classification_rules WHERE workspace_id=? ORDER BY priority DESC,LENGTH(prefix) DESC`).all(workspaceId):[];
    const classify=(name,kind)=>{const value=String(name||'').toLowerCase(),match=nameRules.find(r=>r.kind===kind&&value.includes(String(r.prefix||'').toLowerCase()));return match?.label||'Chưa phân loại'};
    const cost=(spend,count)=>Number(count)>0?Math.round(Number(spend||0)/Number(count)):null;
    const trend=(current,previous)=>current&&previous?Math.round((current-previous)*100/previous):null;
    const describeAudience=raw=>{
      const t=raw&&typeof raw==='object'?raw:{};
      const specs=Array.isArray(t.flexible_spec)?t.flexible_spec:[],interests=specs.flatMap(x=>x.interests||[]),behaviors=specs.flatMap(x=>x.behaviors||[]),custom=[...(t.custom_audiences||[]),...(t.excluded_custom_audiences||[])];
      const hasLookalike=custom.some(x=>/lookalike|tương tự|lal/i.test(String(x.name||x.id||'')))||Boolean(t.lookalike_spec),hasCustom=custom.length>0;
      const type=hasLookalike?'LOOKALIKE':hasCustom?'RETARGET':(interests.length||behaviors.length)?'INTEREST':'BROAD';
      const geo=t.geo_locations||{},pins=[...(geo.custom_locations||[]),...(geo.places||[])],locations=[...(geo.countries||[]),...(geo.regions||[]).map(x=>x.name||x.key),...(geo.cities||[]).map(x=>x.name||x.key),...pins.map(x=>x.name||x.address||(x.latitude&&x.longitude?`Ghim (${Number(x.latitude).toFixed(2)}, ${Number(x.longitude).toFixed(2)})`:'')).filter(Boolean)].filter(Boolean),radii=pins.map(x=>Number(x.radius||0)).filter(Boolean);
      return{type,ageMin:Number(t.age_min||18),ageMax:Number(t.age_max||65),genders:t.genders||[],genderLabel:(t.genders||[]).length===1?(t.genders[0]===2?'Nữ':'Nam'):'Tất cả giới tính',locations:locations.slice(0,5),geoPinCount:pins.length,radiusMin:radii.length?Math.min(...radii):null,radiusMax:radii.length?Math.max(...radii):null,locationTypes:geo.location_types||[],interestCount:interests.length,interests:interests.slice(0,8).map(x=>x.name||x.id),behaviors:behaviors.slice(0,5).map(x=>x.name||x.id),customAudienceCount:custom.length,hasExclusions:Boolean((t.excluded_custom_audiences||[]).length),advantageAudience:Boolean(t.targeting_automation?.advantage_audience),label:type==='BROAD'?'Tệp rộng':type==='INTEREST'?'Tệp sở thích':type==='LOOKALIKE'?'Tệp tương tự':'Tệp remarketing'};
    };
    let adsContext = dbRows.map(row => {
      const cpmess3d=cost(row.spend_3d,row.mess_3d),cpmessPrev3d=cost(row.spend_prev_3d,row.mess_prev_3d),cpl3d=cost(row.spend_3d,row.leads_3d),cplPrev3d=cost(row.spend_prev_3d,row.leads_prev_3d),cpp3d=cost(row.spend_3d,row.purchases_3d),cppPrev3d=cost(row.spend_prev_3d,row.purchases_prev_3d);
      return ({
      adId: row.ad_id,
      adName: row.ad_name,
      service:classify(row.ad_name,'service'),
      operator:classify(row.ad_name,'operator'),
      status: row.ad_status,
      adsetName: row.adset_name,
      targeting: row.targeting ? JSON.parse(row.targeting) : {},
      audienceProfile:describeAudience(row.targeting?JSON.parse(row.targeting):{}),
      daily_budget: row.adset_budget || row.campaign_budget || 0,
      creative: {
        thumbnail_url: row.thumbnail_url,
        body: String(row.body_text||'').slice(0,1600)
      },
      insights: {
        spend: row.spend_7d || 0,
        cpmess: row.cpmess_7d || 0,
        mess: row.mess_7d || 0,
        leads:row.leads_7d||0,
        costPerLead:row.cost_per_lead_7d||0,
        purchases:row.purchases_7d||0,
        costPerPurchase:row.cost_per_purchase_7d||0,
        impressions:row.impressions_7d||0,
        clicks:row.clicks_7d||0,
        ctr:row.ctr_7d||0,
        frequency:row.frequency_7d||0,
        runDays:row.run_days_7d||0,
        history30d:{spend:row.spend_30d||0,messages:row.mess_30d||0,leads:row.leads_30d||0,purchases:row.purchases_30d||0,costPerMessage:cost(row.spend_30d,row.mess_30d),costPerLead:cost(row.spend_30d,row.leads_30d),costPerPurchase:cost(row.spend_30d,row.purchases_30d)},
        lifetimeSynced:{spend:row.spend_lifetime||0,messages:row.mess_lifetime||0,leads:row.leads_lifetime||0,purchases:row.purchases_lifetime||0,costPerMessage:cost(row.spend_lifetime,row.mess_lifetime),costPerLead:cost(row.spend_lifetime,row.leads_lifetime),costPerPurchase:cost(row.spend_lifetime,row.purchases_lifetime)},
        recentTrend:{costPerMessage:{current3d:cpmess3d,previous3d:cpmessPrev3d,changePct:trend(cpmess3d,cpmessPrev3d)},costPerLead:{current3d:cpl3d,previous3d:cplPrev3d,changePct:trend(cpl3d,cplPrev3d)},costPerPurchase:{current3d:cpp3d,previous3d:cppPrev3d,changePct:trend(cpp3d,cppPrev3d)}}
      }
    })});

    if (!adsContext.length) return res.json({ success:true, recommendations:[] });

    if(mode==='analysis'){
      const targetRow=db.prepare('SELECT targets_json FROM workspace_funnel_targets WHERE workspace_id=?').get(workspaceId||1);
      let businessTargets={};try{businessTargets=targetRow?JSON.parse(targetRow.targets_json):{}}catch(_){}
      const dataAvailability={messages:true,metaLeads:true,purchases:true,qualifiedLeads:false,bookings:false,shows:false,revenue:false,roas:false};
      const sum=key=>adsContext.reduce((total,ad)=>total+Number(ad.insights?.[key]||0),0);
      const totalSpend=sum('spend'),totalMessages=sum('mess'),totalLeads=sum('leads'),totalPurchases=sum('purchases');
      const audienceDiagnostics=adsContext.map(ad=>{const i=ad.insights||{},a=ad.audienceProfile||{},purchase=Number(i.purchases||0),lead=Number(i.leads||0),mess=Number(i.mess||0),resultCount=purchase||lead||mess,metric=purchase?'Purchase':lead?'Lead':'Tin nhắn',metricCost=purchase?Number(i.costPerPurchase||0):lead?Number(i.costPerLead||0):Number(i.cpmess||0),target=purchase?Number(businessTargets.cost_per_purchase_max||0):Number(businessTargets.cost_per_message_max||0),ratio=target&&metricCost?metricCost/target:null,days=Number(i.runDays||0),freq=Number(i.frequency||0),ctr=Number(i.ctr||0);let verdict='KEEP',confidence='MEDIUM',reason='Tệp chưa có dấu hiệu bất thường rõ ràng.',recommendation='Giữ tệp hiện tại và chỉ thay một biến mỗi lần test.';if(days<3||resultCount<2){verdict='INSUFFICIENT';confidence='LOW';reason=`Mới có ${days} ngày dữ liệu và ${resultCount} ${metric}; chưa đủ để kết luận nguyên nhân do tệp.`;recommendation='Không đổi targeting; áp dụng rule ngân sách riêng và chờ đủ mẫu trước khi A/B test tệp.';}else if(a.type==='BROAD'&&ratio!==null&&ratio<=1&&resultCount>=3){verdict='EXPAND';confidence=resultCount>=5?'HIGH':'MEDIUM';reason=`Tệp rộng đang tạo ${resultCount} ${metric}, chi phí bằng ${Math.round(ratio*100)}% target.`;recommendation='Giữ broad và mở địa lý theo một nhánh test riêng; không đổi tuổi, creative và ngân sách cùng lúc.';}else if(a.type!=='BROAD'&&ratio!==null&&ratio<=1&&resultCount>=3&&freq>=2){verdict='TEST_BROAD';reason=`Tệp ${a.label.toLowerCase()} đạt target nhưng Frequency ${freq}x cho thấy quy mô có thể bắt đầu hạn chế.`;recommendation='Nhân Ad Set PAUSED, giữ nguyên creative và test một nhánh broad song song.';}else if(ratio!==null&&ratio>1.2&&ctr>=1.5){verdict='NARROW';reason=`Creative vẫn tạo CTR ${ctr}% nhưng ${metric} có chi phí ${Math.round(ratio*100)}% target; có dấu hiệu click chưa chuyển đổi đúng chất lượng.`;recommendation='Test interest có ý định cao hoặc remarketing ở một Ad Set riêng; chưa khẳng định target sai nếu thiếu lead chất lượng.';}else if(ratio!==null&&ratio>1.2&&ctr<1.5){verdict='CREATIVE_FIRST';reason=`CTR ${ctr}% và chi phí ${metric} đều yếu; chưa đủ bằng chứng quy trách nhiệm cho audience.`;recommendation='Test hook/thumbnail/offer trước, giữ nguyên tệp để cô lập nguyên nhân.';}else if(freq>=3){verdict='TEST_BROAD';reason=`Frequency ${freq}x cho thấy dấu hiệu bão hòa tệp.`;recommendation='Mở rộng tệp hoặc tạo nhánh broad, đồng thời làm creative mới.';}const geo=a.geoPinCount?`${a.geoPinCount} điểm ghim, bán kính ${a.radiusMin||'—'}–${a.radiusMax||'—'}km`:(a.locations?.join(', ')||'Không giới hạn chi tiết'),interestText=a.interests?.length?a.interests.join(', '):'Không chọn sở thích',currentSetup=`${a.label}: ${a.genderLabel}, ${a.ageMin}–${a.ageMax} tuổi; ${geo}; ${interestText}${a.behaviors?.length?`; hành vi: ${a.behaviors.join(', ')}`:''}.`,expandedRadius=a.radiusMax?Math.min(a.radiusMax+2,15):null;let proposedSetup=verdict==='EXPAND'?`Bản test B: giữ ${a.genderLabel}, ${a.ageMin}–${a.ageMax} tuổi, bỏ toàn bộ interest/custom audience; ${expandedRadius?`mở bán kính lên ${expandedRadius}km quanh cùng cơ sở`:'mở thêm khu vực liền kề'}, giữ nguyên creative.`:verdict==='TEST_BROAD'?`Bản test B: giữ nguyên tuổi, giới tính và địa lý; bỏ interest/behavior/custom audience để tạo Broad. Creative giống bản A.`:verdict==='NARROW'?`Bản test B: giữ tuổi và địa lý; dùng nhóm interest có ý định cao hoặc remarketing người đã tương tác/xem video. Không chồng nhiều nhóm sở thích.`:verdict==='CREATIVE_FIRST'?`Chưa đổi target. Tạo creative B trong cùng Ad Set để kiểm tra hook/offer trước.`:`Giữ nguyên: ${a.genderLabel}, ${a.ageMin}–${a.ageMax} tuổi, bán kính và ${a.interests?.length?'nhóm sở thích hiện tại':'Broad hiện tại'}.`;const testDesign=`A = target hiện tại; B = target đề xuất. Cùng creative, ngân sách và thời gian; đọc sau ≥3 ngày và ưu tiên CPP/CPL rồi CPMess.`;return{adId:ad.adId,adName:ad.adName,adsetName:ad.adsetName,audienceType:a.type,audienceLabel:a.label,audienceDefinition:a.type==='BROAD'?'Không chọn interest/custom audience; Meta tự tìm người trong giới hạn tuổi, giới tính và địa lý.':a.type==='INTEREST'?'Meta chỉ phân phối trong nhóm sở thích/hành vi đã chọn.':a.type==='LOOKALIKE'?'Tệp người tương tự nguồn khách hàng đã chọn.':'Người đã tương tác với Page, video, form hoặc website.',currentSetup,proposedSetup,testDesign,verdict,confidence,metric,resultCount,metricCost,target,ratioPct:ratio===null?null:Math.round(ratio*100),ctr,freq,reason,recommendation,limitations:['Chưa có breakdown tuổi/giới tính/vị trí theo chuyển đổi','Chưa có lead đủ điều kiện/booking/show từ CRM']};});
      const detailedAudienceDiagnostics=audienceDiagnostics.map(x=>{const gate=x.metric==='Purchase'?'ít nhất 5 Purchase tổng hoặc mỗi nhánh tiêu ≥1× target CPP':x.metric==='Lead'?'ít nhất 10 Lead tổng hoặc mỗi nhánh tiêu ≥1× CPL hiện tại':'ít nhất 15 tin nhắn tổng hoặc mỗi nhánh tiêu ≥1× target CPMess';let design;if(x.verdict==='EXPAND')design=`TEST MỞ ĐỊA LÝ: Nhân Ad Set A thành B. A giữ target hiện tại; B dùng đúng thiết lập đề xuất. Chia ngân sách 50/50, cùng creative, placement, tuổi và giới tính. Chạy tối thiểu 5 ngày và ${gate}. Chọn B nếu số ${x.metric} tăng ≥20% mà chi phí không cao hơn A quá 10%; chi phí tăng >20% thì quay lại A.`;else if(x.verdict==='TEST_BROAD')design=`TEST INTEREST vs BROAD: A giữ interest/behavior; B bỏ toàn bộ interest, behavior và custom audience nhưng giữ tuổi, giới tính, địa lý, creative, placement. Ngân sách 50/50 trong 5–7 ngày, đạt ${gate}. Chọn theo CPP trước, rồi CPL/CPMess; Broad chỉ thắng nếu volume tăng và chi phí không cao hơn A quá 10%.`;else if(x.verdict==='NARROW')design=`TEST CHẤT LƯỢNG TỆP: A giữ target hiện tại; B dùng đúng 1 cụm interest có ý định cao; C remarketing người tương tác/video/form 30–90 ngày, loại trừ Purchase. Không trộn B với C. Chia ngân sách 40/30/30 trong 5–7 ngày, đạt ${gate}. Chọn theo CPP/CPL và Lead→Purchase, không chọn chỉ vì CPM rẻ.`;else if(x.verdict==='CREATIVE_FIRST')design=`TEST CREATIVE TRƯỚC: Giữ duy nhất target hiện tại. A là creative gốc; B chỉ đổi hook + thumbnail; C chỉ đổi offer/CTA. Chia đều ngân sách, chạy ≥3 ngày và ${gate}. Chọn bản có CTR tăng đồng thời ${x.metric} cost giảm; sau khi có creative thắng mới test audience.`;else if(x.verdict==='INSUFFICIENT')design=`CHƯA TEST TARGET: Giữ nguyên tệp đến khi đủ 3 ngày và ${gate}. Nếu đã tiêu >120% target nhưng ít kết quả, giảm ngân sách theo Rule; không đổi target và creative cùng lúc vì sẽ mất dấu nguyên nhân.`;else design=`THEO DÕI/VALIDATE: Giữ cấu hình thêm 3–5 ngày hoặc đến ${gate}. Nếu Frequency ≥2.5x hoặc ${x.metric} cost tăng >20% trong 3 ngày, mới nhân một nhánh test; bản gốc luôn làm control và mỗi lần chỉ đổi một biến.`;return{...x,testDesign:design}});
      const audienceSummary=Object.values(audienceDiagnostics.reduce((out,x)=>{const k=x.audienceType||'UNKNOWN',g=out[k]||(out[k]={audienceType:k,audienceLabel:x.audienceLabel,ads:0,spend:0,messages:0,leads:0,purchases:0});const ad=adsContext.find(a=>String(a.adId)===String(x.adId));g.ads++;g.spend+=Number(ad?.insights?.spend||0);g.messages+=Number(ad?.insights?.mess||0);g.leads+=Number(ad?.insights?.leads||0);g.purchases+=Number(ad?.insights?.purchases||0);return out;},{})).map(g=>({...g,costPerMessage:cost(g.spend,g.messages),costPerLead:cost(g.spend,g.leads),costPerPurchase:cost(g.spend,g.purchases)}));
      const trendTotal=(metric,countKey)=>{const currentSpend=dbRows.reduce((t,r)=>t+Number(r.spend_3d||0),0),previousSpend=dbRows.reduce((t,r)=>t+Number(r.spend_prev_3d||0),0),currentCount=dbRows.reduce((t,r)=>t+Number(r[`${countKey}_3d`]||0),0),previousCount=dbRows.reduce((t,r)=>t+Number(r[`${countKey}_prev_3d`]||0),0),current=cost(currentSpend,currentCount),previous=cost(previousSpend,previousCount);return{metric,current3d:current,previous3d:previous,changePct:trend(current,previous)}};
      const snapshotCore={analysisVersion:'decision-center-v3-detailed-tests',asOf:db.prepare(`SELECT MAX(date) value FROM ad_daily_stats WHERE ad_id IN (${dbRows.map((_,i)=>`@ad${i}`).join(',')})`).get(Object.fromEntries(dbRows.map((r,i)=>[`ad${i}`,r.ad_id])))?.value||null,activeAds:adsContext.length,totalSpend,totalMessages,totalLeads,totalPurchases,costPerMessage:cost(totalSpend,totalMessages),costPerLead:cost(totalSpend,totalLeads),costPerPurchase:cost(totalSpend,totalPurchases),audienceSummary,trends:{costPerMessage:trendTotal('Cost/Mess','mess'),costPerLead:trendTotal('Cost/Lead','leads'),costPerPurchase:trendTotal('Cost/Purchase','purchases')}};
      const snapshotHash = crypto.createHash('sha256').update(JSON.stringify({ workspaceId, businessTargets, snapshotCore, adsContext })).digest('hex').slice(0, 16);
      const dataSnapshot = { ...snapshotCore, hash: snapshotHash };
      const forceRefresh = req.query.force === 'true' || req.body?.force === true;
      const latestSaved = db.prepare(`SELECT id,result_json,created_at FROM workspace_llm_analysis_history WHERE workspace_id=? AND analysis_type='running_ads' ORDER BY id DESC LIMIT 1`).get(workspaceId || 1);

      const audienceById = new Map(detailedAudienceDiagnostics.map(diag => [String(diag.adId), diag]));

      function normalizeAdDecisions(adsContextList, existingDecisionsMap) {
        return adsContextList.map(ad => {
          const adId = String(ad.adId);
          const item = existingDecisionsMap.get(adId) || {
            adId: ad.adId,
            adName: ad.adName,
            category: 'KEEP',
            confidence: 'MEDIUM',
            verdictTitle: 'Giữ nguyên · Theo dõi',
            coreInsight: 'Hiệu suất đang trong vùng an toàn hoặc đang thu thập thêm dữ liệu.',
            actions: {
              budget: 'Giữ nguyên ngân sách',
              creative: 'Giữ nguyên nội dung và visual hiện tại',
              audience: 'Giữ tệp hiện tại'
            },
            suggestedHook: '',
            suggestedCTA: '',
            variantBrief: ''
          };

          const i = ad.insights || {};
          const runDays = Number(i.runDays || 0);
          const purchaseCount = Number(i.purchases || 0);
          const leadCount = Number(i.leads || 0);
          const messageCount = Number(i.mess || 0);
          const targetPurchase = Number(businessTargets.cost_per_purchase_max || 0);
          const targetLead = Number(businessTargets.cost_per_lead_max || 0);
          const targetCpmess = Number(businessTargets.cost_per_message_max || 0);
          const isFunnelWorkspace = workspaceId === 2 || targetPurchase > 0;

          let primaryMetric = 'message', primaryLabel = 'Tin nhắn';
          let primaryCount = messageCount;
          let primaryCost = Number(i.cpmess || 0);
          let primaryTarget = targetCpmess;

          if (purchaseCount > 0) {
            primaryMetric = 'purchase';
            primaryLabel = 'Purchase';
            primaryCount = purchaseCount;
            primaryCost = Number(i.costPerPurchase || 0);
            primaryTarget = targetPurchase || targetCpmess;
          } else if (leadCount > 0) {
            primaryMetric = 'lead';
            primaryLabel = 'Lead';
            primaryCount = leadCount;
            primaryCost = Number(i.costPerLead || 0);
            primaryTarget = targetLead || targetCpmess;
          }

          const ratio = primaryTarget && primaryCost ? primaryCost / primaryTarget : null;
          const freq = Number(i.frequency || 0);
          const ctr = Number(i.ctr || 0);
          const messRate = Number(i.messRate || (i.clicks > 0 ? (messageCount * 100 / i.clicks) : 0));
          const spend = Number(i.spend || 0);
          const cpmess = Number(i.cpmess || 0);
          const diag = audienceById.get(adId);

          item.actions = (item.actions && typeof item.actions === 'object') ? item.actions : {};

          // Harmonize with hard rules
          if (runDays < 3) {
            item.originalCategory = item.category;
            if (primaryCount === 0 && primaryTarget && (spend >= primaryTarget * 2 || (targetPurchase > 0 && spend >= targetPurchase))) {
              item.category = 'REDUCE';
              item.confidence = 'MEDIUM';
              item.verdictTitle = 'Cảnh báo sớm · Giảm 20%';
              item.coreInsight = `Ad mới (${runDays} ngày) nhưng đã tiêu ${(spend / primaryTarget).toFixed(1)}× mục tiêu mà chưa có kết quả.`;
              item.actions.budget = 'Giảm 20% ngân sách để hạn chế rủi ro trong khi theo dõi tiếp 24–48h.';
            } else {
              item.category = 'KEEP';
              item.confidence = 'LOW';
              item.verdictTitle = 'Ad mới · Đang học máy';
              item.coreInsight = `Mới chạy ${runDays} ngày (${primaryCount} kết quả); giữ nguyên để hoàn tất tối thiểu 3 ngày học máy.`;
              item.actions.budget = 'Giữ nguyên ngân sách, không điều chỉnh để tránh ngắt quãng giai đoạn học máy.';
            }
          } else {
            // runDays >= 3 (Mature Ad - đã qua giai đoạn học máy)
            if (isFunnelWorkspace && purchaseCount === 0) {
              if (targetPurchase > 0 && spend >= targetPurchase * 1.5) {
                item.originalCategory = item.category;
                item.category = 'PAUSE';
                item.confidence = 'HIGH';
                item.verdictTitle = 'Tắt ngay · Cháy ngân sách không ra đơn';
                item.coreInsight = `Đã chạy ${runDays} ngày và tiêu ${spend.toLocaleString('vi-VN')}đ (${(spend / targetPurchase).toFixed(1)}× mục tiêu Purchase ${targetPurchase.toLocaleString('vi-VN')}đ) mà không có Purchase.`;
                item.actions.budget = 'Tắt ngay quảng cáo này để cắt lỗ và dồn ngân sách cho ad hiệu quả.';
              } else if (targetPurchase > 0 && spend >= targetPurchase) {
                item.originalCategory = item.category;
                item.category = 'REDUCE';
                item.confidence = 'MEDIUM';
                item.verdictTitle = 'Giảm 20% · Tiêu chạm trần Purchase';
                item.coreInsight = `Đã chạy ${runDays} ngày, tiêu ${spend.toLocaleString('vi-VN')}đ (≥ mục tiêu Purchase) nhưng chưa tạo Purchase.`;
                item.actions.budget = 'Giảm 20% ngân sách để kiểm soát chi phí trong khi theo dõi thêm.';
              } else if (messageCount > 0 && targetCpmess > 0 && cpmess > targetCpmess * 1.2) {
                item.originalCategory = item.category;
                if (ctr < 1.0 && ctr > 0) {
                  item.category = 'VARIANT';
                  item.confidence = 'MEDIUM';
                  item.verdictTitle = 'Đổi hook mới · CPMess cao';
                  item.coreInsight = `Đã chạy ${runDays} ngày, có ${messageCount} tin nhắn nhưng CPMess (${cpmess.toLocaleString('vi-VN')}đ) vượt mục tiêu ${targetCpmess.toLocaleString('vi-VN')}đ và chưa tạo Purchase sau ${spend.toLocaleString('vi-VN')}đ chi tiêu. CTR (${ctr}%) thấp cần đổi hook/thumbnail mới.`;
                  item.actions.creative = 'Thay hook/thumbnail mới để tăng tỷ lệ nhấp và kéo CPMess xuống.';
                  item.actions.budget = 'Giảm 20% hoặc giữ nguyên ngân sách nhỏ để test hook mới.';
                } else if (messRate < 1.5 && messRate > 0) {
                  item.category = 'VARIANT';
                  item.confidence = 'MEDIUM';
                  item.verdictTitle = 'Sửa CTA/Offer · CPMess cao';
                  item.coreInsight = `Đã chạy ${runDays} ngày, có ${messageCount} tin nhắn nhưng CPMess (${cpmess.toLocaleString('vi-VN')}đ) vượt mục tiêu ${targetCpmess.toLocaleString('vi-VN')}đ và chưa tạo Purchase sau ${spend.toLocaleString('vi-VN')}đ chi tiêu. Mess Rate (${messRate.toFixed(2)}%) thấp cần sửa CTA và ưu đãi.`;
                  item.actions.creative = 'Củng cố lời kêu gọi hành động (CTA) và làm rõ ưu đãi trên bài viết.';
                  item.actions.budget = 'Giảm 20% ngân sách và tối ưu lại nội dung CTA.';
                } else {
                  item.category = 'REDUCE';
                  item.confidence = 'MEDIUM';
                  item.verdictTitle = 'Giảm 20% · CPMess vượt mục tiêu';
                  item.coreInsight = `Đã chạy ${runDays} ngày, có ${messageCount} tin nhắn nhưng CPMess (${cpmess.toLocaleString('vi-VN')}đ) vượt mục tiêu ${targetCpmess.toLocaleString('vi-VN')}đ và chưa tạo Purchase sau ${spend.toLocaleString('vi-VN')}đ chi tiêu. Cần giảm ngân sách và làm mới nội dung.`;
                  item.actions.budget = 'Giảm 20% ngân sách để kiểm soát chi phí.';
                }
              } else if (freq >= 2.5) {
                item.originalCategory = item.category;
                item.category = 'VARIANT';
                item.confidence = 'MEDIUM';
                item.verdictTitle = 'Tạo creative mới · Bão hòa tệp';
                item.coreInsight = `Frequency ${freq}x cho thấy dấu hiệu bão hòa tệp khán giả; cần thay visual/video mới.`;
                item.actions.creative = 'Sản xuất 2–3 creative mới để tiếp cận góc nhìn mới cho tệp khách hàng.';
              } else if (messageCount > 0 && targetCpmess > 0 && cpmess <= targetCpmess) {
                item.originalCategory = item.category;
                item.category = 'KEEP';
                item.confidence = 'MEDIUM';
                item.verdictTitle = 'Nghẽn khâu chốt đơn · 0 Purchase';
                item.coreInsight = `CPMess (${cpmess.toLocaleString('vi-VN')}đ) đạt mục tiêu (${targetCpmess.toLocaleString('vi-VN')}đ) nhưng chưa tạo Purchase sau ${messageCount} tin nhắn (${spend.toLocaleString('vi-VN')}đ chi tiêu); nghẽn ở khâu tư vấn/chốt đơn hoặc cần tối ưu CTA.`;
                item.actions.budget = 'Giữ nguyên ngân sách, kiểm tra lại kịch bản tư vấn và chốt sale.';
              } else if (messageCount === 0 && targetCpmess > 0 && spend >= targetCpmess * 2) {
                item.originalCategory = item.category;
                item.category = 'PAUSE';
                item.confidence = 'HIGH';
                item.verdictTitle = 'Tắt ngay · 0 tin nhắn';
                item.coreInsight = `Đã chạy ${runDays} ngày, tiêu ${spend.toLocaleString('vi-VN')}đ mà chưa có tin nhắn hay chuyển đổi nào.`;
                item.actions.budget = 'Tắt ngay quảng cáo này để cắt lỗ.';
              }
            } else if (primaryCount < 2) {
              item.originalCategory = item.category;
              if (primaryCount === 0 && primaryTarget && spend >= primaryTarget * 2) {
                item.category = 'PAUSE';
                item.confidence = 'HIGH';
                item.verdictTitle = 'Tắt ngay · Cháy ngân sách không ra đơn';
                item.coreInsight = `Đã chạy ${runDays} ngày và tiêu ${(spend / primaryTarget).toFixed(1)}× mục tiêu mà không có kết quả nào.`;
                item.actions.budget = 'Tắt ngay quảng cáo này để cắt lỗ và dồn ngân sách cho ad hiệu quả.';
              } else if ((primaryCount === 0 && primaryTarget && spend >= primaryTarget) || (primaryCount === 1 && ratio !== null && ratio > 1.2)) {
                item.category = 'REDUCE';
                item.confidence = 'MEDIUM';
                item.verdictTitle = 'Giảm 20% · Chi phí cao';
                item.coreInsight = `Đã chạy ${runDays} ngày; chi phí ${primaryCost ? primaryCost.toLocaleString('vi-VN') + 'đ' : '—'} bằng ${Math.round((ratio || spend / primaryTarget) * 100)}% mục tiêu.`;
                item.actions.budget = 'Giảm 20% ngân sách, theo dõi 24–48h.';
              } else {
                item.originalCategory = item.category;
                item.category = 'KEEP';
                item.confidence = 'LOW';
                item.verdictTitle = 'Giữ nguyên · Theo dõi';
                item.coreInsight = `Đã chạy ${runDays} ngày với ${primaryCount} kết quả; chi phí đang trong ngưỡng an toàn.`;
                item.actions.budget = 'Giữ nguyên ngân sách theo dõi.';
              }
            } else if (['REDUCE', 'PAUSE'].includes(item.category) && primaryTarget && primaryCost && primaryCost <= primaryTarget && ratio <= 1.0) {
              item.originalCategory = item.category;
              item.category = 'KEEP';
              item.confidence = 'MEDIUM';
              item.verdictTitle = 'Giữ nguyên · Vùng an toàn';
              item.coreInsight = `Chi phí hiện tại (${primaryCost.toLocaleString('vi-VN')}đ) vẫn đạt target (${primaryTarget.toLocaleString('vi-VN')}đ); tiếp tục theo dõi phong độ.`;
              item.actions.budget = 'Giữ nguyên ngân sách, theo dõi thêm 24–48h.';
            } else if (item.category === 'SCALE') {
              const scalePercent = (ratio && ratio <= 0.5) ? 20 : 10;
              if (!item.verdictTitle || item.verdictTitle.includes('Giữ nguyên')) {
                item.verdictTitle = `Scale +${scalePercent}% · Đạt chuẩn phễu`;
              }
              if (!item.coreInsight) {
                item.coreInsight = `Chi phí ${primaryCost.toLocaleString('vi-VN')}đ đạt chuẩn (${Math.round((ratio || 0) * 100)}% target), mẫu đủ (${primaryCount} kết quả) và phong độ ổn định.`;
              }
              if (!item.actions.budget) {
                item.actions.budget = `Tăng ${scalePercent}% ngân sách và theo dõi phân phối trong 24–48h.`;
              }
            }
          }

          // Fill default actions if empty
          if (!item.actions.budget) {
            item.actions.budget = item.category === 'SCALE' ? 'Tăng 10–20% ngân sách' :
              item.category === 'REDUCE' ? 'Giảm 20% ngân sách' :
              item.category === 'PAUSE' ? 'Tắt ngay quảng cáo' : 'Giữ nguyên ngân sách theo dõi';
          }
          if (!item.actions.creative) {
            item.actions.creative = freq >= 3.0 ? 'Tạo 2–3 biến thể video/ảnh mới do tần suất cao' :
              ctr < 1.0 && ctr > 0 ? 'Thử nghiệm hook 3 giây đầu hoặc thumbnail mới' : 'Giữ nguyên visual & copy đang chạy';
          }
          if (!item.actions.audience) {
            item.actions.audience = diag?.recommendation || (diag?.verdict === 'EXPAND' ? 'Mở rộng địa lý hoặc tệp broad' : 'Giữ nguyên tệp đối tượng hiện tại');
          }

          item.verdictTitle = item.verdictTitle || (item.category === 'SCALE' ? 'Scale ngân sách' : item.category === 'REDUCE' ? 'Giảm ngân sách 20%' : item.category === 'PAUSE' ? 'Cân nhắc tắt' : 'Giữ nguyên theo dõi');
          item.coreInsight = item.coreInsight || item.assessment || 'Hiệu suất đang trong vùng an toàn theo dõi.';
          item.suggestedHook = item.suggestedHook || '';
          item.suggestedCTA = item.suggestedCTA || '';
          item.variantBrief = item.variantBrief || '';
          item.assessment = item.coreInsight;
          item.evidence = item.evidence || `Chi phí: ${primaryCost ? primaryCost.toLocaleString('vi-VN') + 'đ' : '—'} / Target: ${primaryTarget ? primaryTarget.toLocaleString('vi-VN') + 'đ' : '—'}`;
          item.action = item.actions.budget;

          return item;
        });
      }

      // Smart Hash & Delta Caching
      if (!forceRefresh && latestSaved) {
        try {
          const saved = JSON.parse(latestSaved.result_json);
          // 1. Exact SHA256 Hash match
          if (saved.dataSnapshot?.hash === snapshotHash) {
            return res.json({
              success: true,
              workspaceId,
              analyzedAds: adsContext.length,
              historyId: latestSaved.id,
              analysis: saved,
              cached: true,
              cacheType: 'exact_hash',
              snapshotHash
            });
          }

          // 2. Smart Delta Caching (< 10% change in metrics)
          const cachedSpend = Number(saved.dataSnapshot?.totalSpend || 0);
          const cachedMessages = Number(saved.dataSnapshot?.totalMessages || 0);
          const cachedLeads = Number(saved.dataSnapshot?.totalLeads || 0);
          const cachedPurchases = Number(saved.dataSnapshot?.totalPurchases || 0);
          const cachedActiveAds = Number(saved.dataSnapshot?.activeAds || 0);

          const spendDelta = Math.abs(totalSpend - cachedSpend) / Math.max(cachedSpend, 1);
          const messDelta = Math.abs(totalMessages - cachedMessages) / Math.max(cachedMessages, 1);
          const leadsDelta = Math.abs(totalLeads - cachedLeads) / Math.max(cachedLeads, 1);
          const purchasesDelta = Math.abs(totalPurchases - cachedPurchases) / Math.max(cachedPurchases, 1);
          const adsDelta = Math.abs(adsContext.length - cachedActiveAds) / Math.max(cachedActiveAds, 1);

          const maxMetricDelta = Math.max(spendDelta, messDelta, leadsDelta, purchasesDelta, adsDelta);
          const createdAtStr = String(latestSaved.created_at || '');
          const cacheDate = new Date(createdAtStr.includes('Z') ? createdAtStr : createdAtStr + 'Z');
          const cacheAgeHours = (Date.now() - cacheDate.getTime()) / 3600000;

          if (maxMetricDelta < 0.10 && (isNaN(cacheAgeHours) || cacheAgeHours < 24)) {
            const existingDecisions = new Map((saved.adDecisions || []).map(d => [String(d.adId), d]));
            const updatedDecisions = normalizeAdDecisions(adsContext, existingDecisions);

            const updatedAnalysis = {
              ...saved,
              dataSnapshot,
              adDecisions: updatedDecisions,
              audienceDiagnostics: detailedAudienceDiagnostics,
              audienceSummary: audienceSummary
            };

            return res.json({
              success: true,
              workspaceId,
              analyzedAds: adsContext.length,
              historyId: latestSaved.id,
              analysis: updatedAnalysis,
              cached: true,
              cacheType: 'delta_cache',
              deltaPct: Number((maxMetricDelta * 100).toFixed(1)),
              snapshotHash
            });
          }
        } catch (e) {
          logger.warn('Delta cache check failed, proceeding to full analysis', { error: e.message });
        }
      }

      // Targeted Anomaly Compression analysis via LLM
      const analysis = await analyzeRunningAds({ businessTargets, dataAvailability, portfolioSummary: dataSnapshot, ads: adsContext });
      analysis.audienceDiagnostics = detailedAudienceDiagnostics;
      analysis.audienceSummary = audienceSummary;

      const existingDecisions = new Map((analysis.adDecisions || []).map(d => [String(d.adId), d]));
      const normalizedDecisions = normalizeAdDecisions(adsContext, existingDecisions);

      analysis.adDecisions = normalizedDecisions;
      analysis.dataSnapshot = dataSnapshot;
      const historyId = db.prepare(`INSERT INTO workspace_llm_analysis_history(workspace_id,analysis_type,analyzed_ads,result_json) VALUES (?,?,?,?)`).run(workspaceId || 1, 'running_ads', adsContext.length, JSON.stringify(analysis)).lastInsertRowid;
      return res.json({ success: true, workspaceId, analyzedAds: adsContext.length, historyId, analysis, cached: false, snapshotHash });
    }
    const recommendations = await generateRecommendations(adsContext);
    res.json({
      success: true,
      recommendations,
      sourceAds: dbRows.map(ad => ({
        adId: ad.ad_id,
        adName: ad.ad_name,
        accountId: ad.account_id,
        campaignName: ad.campaign_name,
        adsetName: ad.adset_name,
        dailyBudget: ad.adset_budget || ad.campaign_budget || 0
      }))
    });
  } catch (err) {
    logger.error('Optimization endpoint error', { error: err.message });
    res.status(500).json({ error: 'Optimization failed', details: err.message });
  }
});

const _optimizeCache = {};

function runRuleEngine(stats) {
  const recs = [];
  const { spend_7d, mess_7d, cpmess, ctr_7d, avg_frequency_7d, impressions_7d, adset_budget } = stats;
  
  // Rule 1: CPMess quá cao
  if (cpmess > 350000) {
    recs.push({
      title: 'Tạm dừng ngưng lủ ngân sách',
      reason: `CPMess ${(cpmess/1000).toFixed(0)}K đ vượt ngưỡng 350K đ. Mỗi tin nhắn đang mất quá nhiều tiền.`,
      action_type: 'PAUSE_AD',
      priority: 'HIGH',
      detail: 'Dừng ad này, phân tích và tạo lại với creative và target khác'
    });
  }
  
  // Rule 2: Ad fatigue
  if (avg_frequency_7d > 3.5) {
    recs.push({
      title: 'Creative mởi — người dùng đã nhàm',
      reason: `Tần suất ${parseFloat(avg_frequency_7d).toFixed(1)}x: cùng 1 người xem quảng cáo ${parseFloat(avg_frequency_7d).toFixed(1)} lần. Tỷ lệ phản hồi đang giảm dần.`,
      action_type: 'CREATE_VARIANT',
      priority: 'HIGH',
      detail: 'Tạo 2-3 biến thể creative mới để làm mới ad'
    });
  }
  
  // Rule 3: CTR thấp
  if (ctr_7d !== undefined && ctr_7d < 0.5 && impressions_7d > 5000) {
    recs.push({
      title: 'Creative yếu — CTR dưới 0.5%',
      reason: `CTR ${ctr_7d}%: Chỉ ${ctr_7d}% người xem click. Creative chưa thu hút đủ.`,
      action_type: 'CREATE_VARIANT',
      priority: 'MEDIUM',
      detail: 'Thử 3 thumbnail khác nhau: mặt người, kết quả trước/sau, video ngắn'
    });
  }
  
  // Rule 4: CPMess tốt, nâng ngân sách
  if (cpmess > 0 && cpmess < 120000 && mess_7d >= 5) {
    const newBudget = Math.round((adset_budget || 200000) * 1.3 / 1000) * 1000;
    recs.push({
      title: 'Scale mạnh — Ad đang hiệu quả tốt',
      reason: `CPMess ${(cpmess/1000).toFixed(0)}K đ rất tốt và đạt ${mess_7d} tin nhắn/7 ngày. Nâng ngân sách sẽ tăng số lượng tin nhắn.`,
      action_type: 'SCALE_BUDGET',
      priority: 'MEDIUM',
      detail: `Tăng từ ${(adset_budget/1000).toFixed(0)}K → ${(newBudget/1000).toFixed(0)}K/ngày (+30%)`,
      parameters: { newBudget }
    });
  }
  
  // Rule 5: Zombie ad (spend không có mess)
  if (spend_7d > 200000 && mess_7d === 0) {
    recs.push({
      title: 'Zombie Ad — Chi tiêu không ra kết quả',
      reason: `Đã chi ${(spend_7d/1000).toFixed(0)}K đ trong 7 ngày nhưng 0 tin nhắn. Ad chạy nhưng không convert.`,
      action_type: 'PAUSE_AD',
      priority: 'HIGH',
      detail: 'Kiểm tra lại target và landing page/chat'
    });
  }
  
  return recs;
}

// POST /api/ads/optimize-ad
app.post('/api/ads/optimize-ad', async (req, res) => {
  try {
    const { adId } = req.body;
    if (!adId) {
      return res.status(400).json({ success: false, error: 'adId is required' });
    }

    const { db } = require('./db/database');

    // 1. Query DB for ad info + full 7-day stats
    const fullStatsSelect = `
        c.ad_id, c.ad_name, c.ad_status, c.adset_status, c.campaign_status,
        c.adset_id, c.adset_name, c.campaign_id, c.account_id,
        c.adset_budget, c.campaign_budget, c.targeting,
        cr.body_text, cr.thumbnail_url,
        ROUND(SUM(s.spend), 0) as spend_7d,
        SUM(s.mess_started) as mess_7d,
        SUM(s.impressions) as impressions_7d,
        SUM(s.clicks) as clicks_7d,
        ROUND(AVG(s.frequency), 2) as avg_frequency_7d,
        CASE WHEN SUM(s.impressions) > 0 THEN ROUND(SUM(s.clicks)*100.0/SUM(s.impressions), 2) ELSE 0 END as ctr_7d,
        CASE WHEN SUM(s.impressions) > 0 THEN ROUND(SUM(s.spend)*1000/SUM(s.impressions), 0) ELSE 0 END as cpm_7d,
        CASE WHEN SUM(s.clicks) > 0 THEN ROUND(SUM(s.mess_started)*100.0/SUM(s.clicks), 1) ELSE 0 END as mess_rate_7d,
        CASE WHEN SUM(s.mess_started) > 0 THEN ROUND(SUM(s.spend) / SUM(s.mess_started), 0) ELSE NULL END as cpmess
    `;

    const query = `SELECT ${fullStatsSelect}
      FROM ad_config c
      JOIN ad_creatives cr ON cr.ad_id = c.ad_id
      LEFT JOIN ad_daily_stats s ON s.ad_id = c.ad_id AND s.date >= date('now', '-7 days')
      WHERE c.ad_id = ?
      GROUP BY c.ad_id
    `;

    let adRow = db.prepare(query).get(adId);
    if (!adRow) {
      const fallbackQuery = `SELECT ${fullStatsSelect}
        FROM ad_config c
        LEFT JOIN ad_creatives cr ON cr.ad_id = c.ad_id
        LEFT JOIN ad_daily_stats s ON s.ad_id = c.ad_id AND s.date >= date('now', '-7 days')
        WHERE c.ad_id = ?
        GROUP BY c.ad_id
      `;
      adRow = db.prepare(fallbackQuery).get(adId);
    }


    if (!adRow) {
      return res.status(404).json({ success: false, error: 'Ad not found' });
    }

    const isEffectivelyActive = adRow.ad_status === 'ACTIVE' && adRow.adset_status === 'ACTIVE' && adRow.campaign_status === 'ACTIVE';
    const effective_status = isEffectivelyActive ? 'ACTIVE' : 'PAUSED';
    const adset_budget = parseInt(adRow.adset_budget) || parseInt(adRow.campaign_budget) || 0;
    const spend_7d = adRow.spend_7d || 0;
    const mess_7d = adRow.mess_7d || 0;
    const cpmess = adRow.cpmess || (mess_7d > 0 ? Math.round(spend_7d / mess_7d) : 0);
    const targeting_summary_full = adRow.targeting || 'Broad';

    const stats = {
      ...adRow,
      effective_status,
      adset_budget,
      spend_7d,
      mess_7d,
      cpmess,
      targeting_summary: targeting_summary_full
    };

    // Try rule engine first (free, fast)
    const ruleRecs = runRuleEngine(stats);
    if (ruleRecs.length >= 2) {
      // Enough signal from rules, no need for LLM
      return res.json({ success: true, recommendations: ruleRecs, ad_name: adRow.ad_name, source: 'rules' });
    }
    // Else: rules inconclusive, call LLM with compressed context

    const cacheKey = `${adId}_${Math.round(stats.spend_7d)}_${stats.mess_7d}`;
    if (_optimizeCache[cacheKey] && Date.now() - _optimizeCache[cacheKey].t < 6*3600*1000) {
      return res.json({ ..._optimizeCache[cacheKey].data, cached: true });
    }

    const creativeData = {
      title: adRow.ad_name,
      body: adRow.body_text,
      thumbnail_url: adRow.thumbnail_url
    };

    let recommendations = null;
    const aiReviewer = require('./services/aiReviewer');

    if (typeof aiReviewer.analyzeAdPerformance === 'function') {
      try {
        const aiRes = await aiReviewer.analyzeAdPerformance(stats, creativeData);
        if (aiRes && aiRes.recommendations && Array.isArray(aiRes.recommendations) && aiRes.recommendations.length > 0) {
          recommendations = aiRes.recommendations;
        }
      } catch (e) {
        logger.warn('aiReviewer.analyzeAdPerformance failed, falling back to Gemini direct', { error: e.message });
      }
    }

    if (!recommendations) {
      let targetingSummary = 'Broad';
      try {
        const t = typeof adRow.targeting === 'string' ? JSON.parse(adRow.targeting) : (adRow.targeting || {});
        const parts = [];
        if (t.age_min && t.age_max) parts.push(`${t.age_min}-${t.age_max}t`);
        if (t.genders?.length === 1) parts.push(t.genders[0] === 2 ? 'Nữ' : 'Nam');
        const geos = t.geo_locations;
        if (geos?.regions?.length) parts.push(geos.regions.map(r=>r.name||r.key).join(','));
        if (geos?.countries?.length) parts.push(geos.countries.join(','));
        if (t.flexible_spec?.[0]?.interests?.length) {
          parts.push(t.flexible_spec[0].interests.slice(0,3).map(i=>i.name).join(','));
        }
        if (parts.length) targetingSummary = parts.join(' | ');
      } catch(e) {}

      // Fetch 30-day history for context comparison
      let histNote = '';
      try {
        const hist = db.prepare(`
          SELECT ROUND(SUM(spend)/NULLIF(SUM(mess_started),0), 0) as cpmess_30d,
                 SUM(mess_started) as mess_30d,
                 ROUND(SUM(spend),0) as spend_30d
          FROM ad_daily_stats
          WHERE ad_id = ? AND date >= date('now','-30 days')
        `).get(adId);
        if (hist?.cpmess_30d) {
          histNote = `\nLịch sử 30 ngày: Spend=${Math.round((hist.spend_30d||0)/1000)}K | Mess=${hist.mess_30d||0} | CPMess_30d=${Math.round(hist.cpmess_30d/1000)}Kđ`;
        }
      } catch(e) {}

      const ctr7d  = adRow.ctr_7d  || 0;
      const cpm7d  = adRow.cpm_7d  || 0;
      const freq7d = parseFloat(adRow.avg_frequency_7d || 0).toFixed(1);
      const messRate7d = adRow.mess_rate_7d || 0;

      const compactPrompt = `Bạn là chuyên gia tối ưu Facebook Ads Việt Nam (dịch vụ spa/thẩm mỹ/nám da).
Phân tích ad và đưa ra 1-3 đề xuất cụ thể. QUAN TRỌNG: đọc kỹ lịch sử trước khi kết luận.

AD: ${adRow.ad_name}
Target: ${targetingSummary}
Budget: ${Math.round((adRow.adset_budget||adRow.campaign_budget||0)/1000)}Kđ/ngày
KPI 7 ngày: Spend=${Math.round(stats.spend_7d/1000)}K | Mess=${stats.mess_7d} | CPMess=${Math.round(stats.cpmess/1000)}Kđ | CTR=${ctr7d}% | CPM=${Math.round(cpm7d/1000)}K | Freq=${freq7d}x | MessRate=${messRate7d}%${histNote}
Body: "${(adRow.body_text||'').slice(0,80)}..."

Ngưỡng tham chiếu: CPMess tốt <150K, tạm <250K, cần xem lại >350K. CTR tốt >2%, Freq tệ >3.5x.

Trả về JSON:
{ "recommendations": [
  { "title": string, "reason": string (tiếng Việt, ngắn, dựa số liệu cụ thể), "action_type": "PAUSE_AD|SCALE_BUDGET|CREATE_VARIANT|DUPLICATE_ADSET|CHANGE_TARGETING", "detail": string, "parameters": {} }
]}`.trim();


      const apiKey = process.env.GEMINI_API_KEY || config.gemini.apiKey;
      try {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(apiKey);
        // Use gemini-2.5-flash with regex JSON extraction (handles thinking prefix)
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const resAi = await model.generateContent(compactPrompt);
        const text = resAi.response.text();
        // Extract JSON object robustly (model may add explanation before/after)
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          recommendations = parsed.recommendations || (Array.isArray(parsed) ? parsed : [parsed]);
          if (!Array.isArray(recommendations)) recommendations = [recommendations];
        }
      } catch (err) {
        logger.warn('Gemini LLM call failed', { error: err.message });
        // recommendations stays null — responseData will use ruleRecs fallback
      }
    }

    const responseData = {
      success: true,
      recommendations: (recommendations && recommendations.length > 0) ? recommendations : ruleRecs,
      ad_name: adRow.ad_name,
      source: (recommendations && recommendations.length > 0) ? 'llm' : (ruleRecs.length > 0 ? 'rules_fallback' : 'no_signal')
    };
    
    _optimizeCache[cacheKey] = { t: Date.now(), data: responseData };
    
    res.json(responseData);
  } catch (err) {
    logger.error('Optimize ad endpoint error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/ads/img-proxy?adId=xxx — Proxy fetch ad creative image fresh from FB API
app.get('/api/ads/img-proxy', async (req, res) => {
  try {
    const { adId } = req.query;
    if (!adId) return res.status(400).send('Missing adId');
    
    const axios = require('axios');
    const { db } = require('./db/database');
    const apiVersion = config.facebook.apiVersion || 'v21.0';
    
    // Look up video_id, thumbnail_url, and account_id from DB
    const row = db.prepare(`
      SELECT cr.image_hash, cr.video_id, cr.thumbnail_url, c.account_id
      FROM ad_config c
      LEFT JOIN ad_creatives cr ON c.ad_id = cr.ad_id
      WHERE c.ad_id = ?
    `).get(adId);
    const token = workspaceAdsToken(req.query.workspaceId, row?.account_id);
    let imgUrl = null;
    
    if (token) {
      // Strategy 1: Video ad in DB — use /{video_id}?fields=picture (stable accessible URL)
      if (row?.video_id && row.video_id !== '') {
        try {
          const vidRes = await axios.get(`https://graph.facebook.com/${apiVersion}/${row.video_id}`, {
            params: { fields: 'picture', access_token: token },
            timeout: 10000
          });
          imgUrl = vidRes.data.picture || null;
        } catch(e) { /* try next */ }
      }
      
      // Strategy 2: Fetch fresh creative from API — get image_hash + video_id
      if (!imgUrl) {
        try {
          const apiRes = await axios.get(`https://graph.facebook.com/${apiVersion}/${adId}`, {
            params: { fields: 'creative{image_url,image_hash,thumbnail_url,object_story_spec,video_id}', access_token: token },
            timeout: 10000
          });
          const creative = apiRes.data.creative || {};
          const spec = creative.object_story_spec || {};
          
          // 2a: If creative has video_id, use video picture endpoint
          if (!imgUrl && creative.video_id) {
            try {
              const vidRes = await axios.get(`https://graph.facebook.com/${apiVersion}/${creative.video_id}`, {
                params: { fields: 'picture', access_token: token },
                timeout: 10000
              });
              imgUrl = vidRes.data.picture || null;
            } catch(e) {}
          }
          
          // 2b: If image_hash from API, try adimages endpoint (actual FB hash, not our MD5)
          if (!imgUrl && creative.image_hash && row?.account_id) {
            try {
              const hashRes = await axios.get(`https://graph.facebook.com/${apiVersion}/${row.account_id}/adimages`, {
                params: { 'hashes[0]': creative.image_hash, fields: 'url', access_token: token },
                timeout: 10000
              });
              const imgData = hashRes.data.data || [];
              if (imgData.length > 0 && imgData[0].url) imgUrl = imgData[0].url;
            } catch(e) {}
          }
          
          // 2c: image_url / link_data / thumbnail_url fallback
          if (!imgUrl) imgUrl = creative.image_url || spec.link_data?.picture || spec.video_data?.image_url || creative.thumbnail_url || null;
        } catch(e) { /* give up */ }
      }
    }
    
    // Fallback: If Graph API didn't yield an imgUrl (or error/no token), MUST fallback to row.thumbnail_url from DB
    if (!imgUrl && row?.thumbnail_url) {
      imgUrl = row.thumbnail_url;
    }
    
    if (!imgUrl) return res.status(404).send('No image found');
    
    try {
      const imgRes = await axios.get(imgUrl, {
        responseType: 'stream',
        headers: { 'User-Agent': 'facebookexternalhit/1.1' },
        timeout: 15000
      });
      res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=604800');
      imgRes.data.pipe(res);
    } catch (streamErr) {
      // Fallback: If axios stream errors, redirect client to load image directly
      return res.redirect(imgUrl);
    }
  } catch(e) {
    res.status(500).send('Proxy error: ' + e.message);
  }
});


app.post('/api/ads/patch-creatives', async (req, res) => {
  try {
    const { db, insertAdCreative } = require('./db/database');
    const crypto = require('crypto');
    const axios = require('axios');
    const workspaceId = Number(req.body.workspaceId || 0);
    const apiVersion = config.facebook.apiVersion || 'v21.0';
    
    // Find ads with missing thumbnail
    const missingAds = db.prepare(`
      SELECT c.ad_id,c.account_id FROM ad_config c 
      LEFT JOIN ad_creatives cr ON cr.ad_id = c.ad_id
      WHERE (cr.ad_id IS NULL OR cr.thumbnail_url IS NULL OR cr.thumbnail_url = '')
      ${workspaceId ? 'AND c.account_id IN (SELECT account_id FROM workspace_ad_accounts WHERE workspace_id=@workspaceId)' : ''}
      LIMIT 200
    `).all({ workspaceId });
    
    if (missingAds.length === 0) {
      return res.json({ success: true, message: 'Tất cả ads đã có ảnh!', patched: 0 });
    }
    
    function cleanThumbUrl(url) {
      if (!url) return null;
      try {
        const u = new URL(url);
        u.searchParams.delete('stp');
        u.searchParams.delete('_nc_tpa');
        return u.toString();
      } catch(e) { return url; }
    }
    
    let patched = 0;
    const errors = [];
    
    // Batch fetch: 20 ads per request using ?ids=
    const batchSize = 20;
    const fields = 'creative{image_url,thumbnail_url,body,object_story_spec,video_id}';
    
    for (let i = 0; i < missingAds.length; i += batchSize) {
      const batchRows = missingAds.slice(i, i + batchSize);
      const batch = batchRows.map(r => r.ad_id);
      const token = workspaceAdsToken(workspaceId, batchRows[0]?.account_id);
      if (!token) { errors.push(`Không tìm thấy token cho workspace ${workspaceId || 'mặc định'}`); continue; }
      try {
        const response = await axios.get(`https://graph.facebook.com/${apiVersion}/`, {
          params: { ids: batch.join(','), fields, access_token: token }
        });
        
        for (const [adId, adData] of Object.entries(response.data)) {
          const creative = adData.creative || {};
          const spec = creative.object_story_spec || {};
          const bodyText = creative.body || spec.link_data?.message || spec.video_data?.message || '';
          const rawThumb = creative.image_url || spec.link_data?.picture || spec.video_data?.image_url || creative.thumbnail_url || null;
          const thumbnailUrl = cleanThumbUrl(rawThumb);
          const videoId = creative.video_id || spec.video_data?.video_id || null;
          const bodyHash = crypto.createHash('md5').update(bodyText).digest('hex');
          const imageHash = thumbnailUrl ? crypto.createHash('md5').update(thumbnailUrl).digest('hex') : '';
          
          insertAdCreative({ ad_id: adId, thumbnail_url: thumbnailUrl, video_url: null, body_text: bodyText, image_hash: imageHash, video_id: videoId || '', body_hash: bodyHash });
          if (thumbnailUrl) patched++;
        }
      } catch(batchErr) {
        errors.push(`Batch ${i}-${i+batchSize}: ${batchErr.message}`);
      }
    }
    
    res.json({ success: true, total_missing: missingAds.length, patched, errors });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

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
    } = require('./services/facebookAdsBudget');
    const { db, stmts, insertAdCreative } = require('./db/database');
    const { clearApiCache } = require('./utils/apiCache');

    const targetId = action.targetId || action.id || action.adId;
    if (!targetId && action.type !== 'CHANGE_TARGETING') {
      return res.status(400).json({ success: false, error: 'Missing targetId in action' });
    }

    const accountIdParam = action.adAccountId || action.accountId || req.body.adAccountId || req.body.accountId;
    const workspaceIdParam = req.body.workspaceId;

    // 1. Dùng resolveAdsContext đồng bộ cho mọi action
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

    // ─── PAUSE AD ─────────────────────────────────────────────────────────────
    if (action.type === 'PAUSE_AD') {
      result = await executePauseAd({
        adId: targetId,
        workspaceId: workspaceIdParam,
        accountId: accountIdParam
      });
    }

    // ─── PAUSE ADSET ──────────────────────────────────────────────────────────
    else if (action.type === 'PAUSE_ADSET') {
      result = await executePauseAdset({
        adsetId: targetId,
        adId: targetId,
        workspaceId: workspaceIdParam,
        accountId: accountIdParam
      });
    }

    // ─── SCALE BUDGET / INCREASE / DECREASE ──────────────────────────────────
    else if (
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
          if (num > 1000) {
            newBudget = num;
          } else {
            percent = num;
          }
        }
      }

      if (action.type === 'INCREASE_BUDGET' && percent === undefined && newBudget === undefined) {
        percent = 20;
      }
      if (action.type === 'DECREASE_BUDGET' && percent === undefined && newBudget === undefined) {
        percent = -20;
      }

      result = await executeBudgetChange({
        adId: targetId,
        targetId: targetId,
        newBudget,
        percent,
        workspaceId: workspaceIdParam,
        accountId: accountIdParam
      });
    }

    // ─── DUPLICATE ADSET (with ad & lifetime budget protection) ───────────────
    else if (action.type === 'DUPLICATE_ADSET') {
      // 1. Lấy thông tin từ SQLite DB
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

      // 2. Lấy cấu hình đầy đủ từ Meta Graph API
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

      if (!accountId) {
        return res.status(400).json({ success: false, error: 'Không tìm thấy Ad Account ID của AdSet' });
      }
      if (!campaignId) {
        return res.status(400).json({ success: false, error: 'Không tìm thấy Campaign ID của AdSet' });
      }

      // 3. Chuẩn bị payload AdSet mới với xử lý Lifetime Budget & Thời gian
      const newAdsetName = `${adsetData.name || adRow?.adset_name || 'AdSet'} - Copy`;
      const newAdsetPayload = {
        name: newAdsetName,
        campaign_id: campaignId,
        billing_event: adsetData.billing_event || 'IMPRESSIONS',
        optimization_goal: adsetData.optimization_goal || 'REPLIES',
        status: 'PAUSED',
        access_token: token
      };

      // Targeting
      if (adsetData.targeting) {
        newAdsetPayload.targeting = typeof adsetData.targeting === 'object'
          ? JSON.stringify(adsetData.targeting)
          : adsetData.targeting;
      } else if (adRow?.targeting) {
        newAdsetPayload.targeting = typeof adRow.targeting === 'string'
          ? adRow.targeting
          : JSON.stringify(adRow.targeting);
      }

      // Xử lý Lifetime Budget vs Daily Budget
      const now = Date.now();
      if (adsetData.lifetime_budget && Number(adsetData.lifetime_budget) > 0) {
        newAdsetPayload.lifetime_budget = adsetData.lifetime_budget;
        let durationMs = 7 * 24 * 60 * 60 * 1000; // 7 ngày mặc định
        if (adsetData.start_time && adsetData.end_time) {
          const origStart = new Date(adsetData.start_time).getTime();
          const origEnd = new Date(adsetData.end_time).getTime();
          if (origEnd > origStart) {
            durationMs = Math.max(86400000, origEnd - origStart);
          }
        }
        const startTimeDate = new Date(now + 120000); // 2 phút sau
        const endTimeDate = new Date(startTimeDate.getTime() + durationMs);
        newAdsetPayload.start_time = startTimeDate.toISOString();
        newAdsetPayload.end_time = endTimeDate.toISOString();
      } else if (adsetData.daily_budget && Number(adsetData.daily_budget) > 0) {
        newAdsetPayload.daily_budget = adsetData.daily_budget;
        if (adsetData.end_time && new Date(adsetData.end_time).getTime() > now) {
          newAdsetPayload.end_time = adsetData.end_time;
        }
      }

      if (adsetData.bid_strategy) {
        newAdsetPayload.bid_strategy = adsetData.bid_strategy;
      }
      if (adsetData.promoted_object) {
        newAdsetPayload.promoted_object = typeof adsetData.promoted_object === 'object'
          ? JSON.stringify(adsetData.promoted_object)
          : adsetData.promoted_object;
      }
      if (adsetData.destination_type) {
        newAdsetPayload.destination_type = adsetData.destination_type;
      }

      // Tạo AdSet mới trên Meta
      const newAdsetRes = await axios.post(`${BASE}/${accountId}/adsets`, newAdsetPayload);
      const newAdsetId = newAdsetRes.data.id;

      // 4. Lấy creative gốc và tạo Ad mới trong AdSet mới
      let origAdId = adRow?.ad_id;
      let origCreative = null;
      let adName = adRow?.ad_name || adsetData.name || 'Ad';

      if (!origAdId) {
        try {
          const listAdsRes = await axios.get(`${BASE}/${origAdsetId}/ads`, {
            params: {
              fields: 'id,name,creative{id,name,object_story_spec,effective_object_story_id,thumbnail_url,image_url,video_id,body}',
              limit: 1,
              access_token: token
            }
          });
          if (listAdsRes.data.data && listAdsRes.data.data.length > 0) {
            origAdId = listAdsRes.data.data[0].id;
            adName = listAdsRes.data.data[0].name;
            origCreative = listAdsRes.data.data[0].creative;
          }
        } catch (listErr) {
          logger.warn('Could not list ads in original adset', { error: listErr.message });
        }
      }

      if (origAdId && !origCreative) {
        try {
          const origAdRes = await axios.get(`${BASE}/${origAdId}`, {
            params: {
              fields: 'id,name,creative{id,name,object_story_spec,effective_object_story_id,thumbnail_url,image_url,video_id,body}',
              access_token: token
            }
          });
          adName = origAdRes.data.name || adName;
          origCreative = origAdRes.data.creative;
        } catch (adErr) {
          logger.warn('Could not fetch original ad details', { error: adErr.message });
        }
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

      // 5. Lưu ngay vào SQLite DB (ad_config & ad_creatives)
      if (newAdId) {
        const adsetBudgetVal = String(newAdsetPayload.daily_budget || newAdsetPayload.lifetime_budget || adsetData.daily_budget || adsetData.lifetime_budget || '0');
        const targetingVal = newAdsetPayload.targeting || (adRow?.targeting ? (typeof adRow.targeting === 'string' ? adRow.targeting : JSON.stringify(adRow.targeting)) : null);
        const isLifetime = (Number(adsetData.lifetime_budget || 0) > 0 && Number(adsetData.daily_budget || 0) === 0) || (adRow?.budget_type === 'LIFETIME');
        const budgetType = isLifetime ? 'LIFETIME' : 'DAILY';

        stmts.upsertAdConfig.run({
          ad_id: newAdId,
          account_id: accountId,
          campaign_id: campaignId || '',
          campaign_name: adRow?.campaign_name || '',
          campaign_status: adRow?.campaign_status || 'ACTIVE',
          campaign_start_time: adRow?.campaign_start_time || '',
          campaign_end_time: adRow?.campaign_end_time || '',
          campaign_budget: adRow?.campaign_budget || '0',
          campaign_daily_budget: adRow?.campaign_daily_budget || '0',
          campaign_lifetime_budget: adRow?.campaign_lifetime_budget || '0',
          adset_id: newAdsetId,
          adset_name: newAdsetName,
          adset_status: 'PAUSED',
          adset_start_time: newAdsetPayload.start_time || new Date().toISOString(),
          adset_end_time: newAdsetPayload.end_time || adRow?.adset_end_time || '',
          adset_budget: adsetBudgetVal,
          adset_daily_budget: String(newAdsetPayload.daily_budget || adsetData.daily_budget || (isLifetime ? 0 : adsetBudgetVal) || '0'),
          adset_lifetime_budget: String(newAdsetPayload.lifetime_budget || adsetData.lifetime_budget || (isLifetime ? adsetBudgetVal : 0) || '0'),
          budget_type: budgetType,
          ad_name: newAdName,
          ad_status: 'PAUSED',
          created_time: new Date().toISOString(),
          post_url: adRow?.post_url || null,
          targeting: targetingVal
        });

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
    }

    // ─── CREATE VARIANT (duplicate ad with new creative from request) ──────────
    else if (action.type === 'CREATE_VARIANT') {
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

      // Lấy thông tin ad gốc từ Meta
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

      if (!adsetId) {
        return res.status(404).json({ success: false, error: 'Không tìm thấy AdSet ID của quảng cáo gốc' });
      }
      if (!accountId) {
        return res.status(400).json({ success: false, error: 'Không tìm thấy Ad Account ID của quảng cáo gốc' });
      }

      // Yêu cầu 3: Nếu !origCreative.object_story_spec && origCreative.id -> Gọi Graph API để lấy spec đầy đủ
      if (!origCreative.object_story_spec && origCreative.id) {
        try {
          const creativeRes = await axios.get(`${BASE}/${origCreative.id}`, {
            params: {
              fields: 'id,name,object_story_spec,effective_object_story_id,thumbnail_url,image_url,video_id,body',
              access_token: token
            }
          });
          origCreative = { ...origCreative, ...creativeRes.data };
        } catch (cErr) {
          logger.warn('Could not fetch full creative details from Meta', { error: cErr.message, creativeId: origCreative.id });
        }
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

          // Hỗ trợ đổi message/caption trên tất cả các loại spec
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
            // Fallback: giữ creative và thông báo
            creativeId = origCreative.id;
            variantMessage = 'Đã tạo Ad bản sao (Bài viết Fanpage/Story ID không cho phép sửa trực tiếp copy qua API)';
          }
        } else {
          // Page Post không có spec
          creativeId = origCreative.id;
          variantMessage = 'Đã tạo Ad bản sao trong AdSet (Creative nguồn là bài viết Page có sẵn không thể ghi đè nội dung qua API)';
        }
      } else {
        variantMessage = 'Đã nhân bản Ad thành công trong cùng AdSet (trạng thái: Tạm dừng)';
      }

      if (!creativeId) {
        return res.status(400).json({ success: false, error: 'Không tìm thấy Creative ID để tạo Ad' });
      }

      // Tạo Ad mới trong cùng AdSet với trạng thái PAUSED
      const newAdName = `${adName} - Variant`;
      const newAdRes = await axios.post(`${BASE}/${accountId}/ads`, {
        name: newAdName,
        adset_id: adsetId,
        creative: JSON.stringify({ creative_id: creativeId }),
        status: 'PAUSED',
        access_token: token
      });
      const newAdId = newAdRes.data.id;

      // Lưu ngay vào SQLite DB (ad_config & ad_creatives)
      const isLifetime = adRow?.budget_type === 'LIFETIME' || (Number(adRow?.adset_lifetime_budget || adRow?.campaign_lifetime_budget || 0) > 0 && Number(adRow?.adset_daily_budget || adRow?.campaign_daily_budget || 0) === 0);
      const budgetType = isLifetime ? 'LIFETIME' : 'DAILY';

      stmts.upsertAdConfig.run({
        ad_id: newAdId,
        account_id: accountId,
        campaign_id: campaignId || '',
        campaign_name: adRow?.campaign_name || '',
        campaign_status: adRow?.campaign_status || 'ACTIVE',
        campaign_start_time: adRow?.campaign_start_time || '',
        campaign_end_time: adRow?.campaign_end_time || '',
        campaign_budget: adRow?.campaign_budget || '0',
        campaign_daily_budget: adRow?.campaign_daily_budget || '0',
        campaign_lifetime_budget: adRow?.campaign_lifetime_budget || '0',
        adset_id: adsetId,
        adset_name: adRow?.adset_name || '',
        adset_status: adRow?.adset_status || 'ACTIVE',
        adset_start_time: adRow?.adset_start_time || '',
        adset_end_time: adRow?.adset_end_time || '',
        adset_budget: adRow?.adset_budget || '0',
        adset_daily_budget: adRow?.adset_daily_budget || (isLifetime ? '0' : adRow?.adset_budget || '0'),
        adset_lifetime_budget: adRow?.adset_lifetime_budget || (isLifetime ? adRow?.adset_budget || '0' : '0'),
        budget_type: budgetType,
        ad_name: newAdName,
        ad_status: 'PAUSED',
        created_time: new Date().toISOString(),
        post_url: adRow?.post_url || null,
        targeting: adRow?.targeting ? (typeof adRow.targeting === 'string' ? adRow.targeting : JSON.stringify(adRow.targeting)) : null
      });

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
    }

    // ─── CHANGE TARGETING (informational — open UI) ──────────────────────────
    else if (action.type === 'CHANGE_TARGETING') {
      result = {
        message: 'Mở Auto-Publisher Studio để chỉnh targeting',
        redirect: '/agentic-dashboard#auto-publisher'
      };
    }

    else {
      return res.status(400).json({ success: false, error: `Unknown action type: ${action.type}` });
    }

    clearApiCache();
    res.json({ success: true, result });
  } catch (err) {
    logger.error('Execute action error', { error: err.message, stack: err.stack?.split('\n')[0] });
    const fbError = err.response?.data?.error;
    const msg = fbError?.error_user_msg || fbError?.error_user_title || fbError?.message || err.message;
    res.status(err.statusCode || (err.response?.status) || 500).json({
      success: false,
      error: msg,
      fb_error_code: fbError?.code
    });
  }
});

app.get('/ads-dashboard', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'ads-dashboard.html')));
app.get('/agentic-dashboard', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'agentic-dashboard.html')));

// Content Generator API
app.use('/api/content', contentGeneratorRouter);
app.use('/api/facebook/export', facebookExportRouter);
app.get('/content-hub', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'content-hub.html')));

// Computer Audit Info API
const { saveAuditData, getAllComputers } = require('./services/auditService');

app.get('/computer-info', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'computer-info.html')));

app.get('/api/audit/computers', (req, res) => {
  try {
    const computers = getAllComputers();
    res.json({ success: true, computers });
  } catch (err) {
    logger.error('Failed to get computers', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/audit', async (req, res) => {
  const auditData = req.body;
  if (!auditData || !auditData.hostname) {
    return res.status(400).json({ error: 'Invalid audit data' });
  }
  try {
    const result = await saveAuditData(auditData);
    if (result.success) {
      res.json({ success: true, message: 'Audit data saved to Local DB and Google Sheets', warning: result.warning });
    } else {
      res.status(500).json({ error: 'Failed to save audit data', details: result.error });
    }
  } catch (err) {
    logger.error('Audit endpoint error', { error: err.message });
    res.status(500).json({ error: 'Audit failed', details: err.message });
  }
});

// Upload multiple media files
app.post('/api/upload', upload.array('media', 20), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  const files = req.files.map((f) => ({
    path: f.path,
    originalName: f.originalname,
    size: f.size,
    mimeType: f.mimetype,
  }));

  res.json({ success: true, files });
});

// AI content review
app.post('/api/review', async (req, res) => {
  const { content } = req.body;

  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Content is required' });
  }

  const errors = validateConfig(['review']);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Configuration error', details: errors });
  }

  try {
    const result = await reviewContent(content);
    res.json(result);
  } catch (err) {
    logger.error('Review endpoint error', { error: err.message });
    res.status(500).json({ error: 'Review failed', details: err.message });
  }
});

// Return list of configured Facebook pages (for per-page checkboxes)
app.get('/api/pages', (req, res) => {
  const pages = (config.facebook.pages || []).map(p => ({ id: p.id, name: p.name || p.id }));
  res.json({ pages });
});

// Distribute content
app.post('/api/distribute', async (req, res) => {
  const { content, title, mediaPaths, platforms, pillar, angle, pic, scheduledTime, selectedPageIds } = req.body;

  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Content is required' });
  }

  const selectedPlatforms = platforms || ['facebook', 'drive'];
  const errors = validateConfig(selectedPlatforms);

  if (errors.length > 0 && !config.dryRun) {
    return res.status(400).json({ error: 'Configuration error', details: errors });
  }

  try {
    const result = await distribute({ content, title, mediaPaths: mediaPaths || [], platforms: selectedPlatforms, pillar, angle, pic, scheduledTime: scheduledTime || null, selectedPageIds: selectedPageIds || null });
    res.json(result);
  } catch (err) {
    logger.error('Distribution endpoint error', { error: err.message });
    res.status(500).json({ error: 'Distribution failed', details: err.message });
  }
});

// WordPress: Save as Draft (separate from distribute)
app.post('/api/wordpress', upload.array('media', 20), async (req, res) => {
  const { title, content, pillar, angle, pic } = req.body;

  if (!title || !content) {
    return res.status(400).json({ error: 'Title and content are required' });
  }

  const errors = validateConfig(['wordpress']);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'WordPress not configured', details: errors });
  }

  try {
    const mediaPaths = (req.files || []).map((f) => f.path);
    const result = await publishToWordPress(title, content, mediaPaths);

    // Log to Google Sheets if draft was saved successfully
    if (result.success) {
      try {
        const { appendRow } = require('./services/googleSheets');
        const now = new Date();
        await appendRow({
          channel: 'WordPress (Draft)',
          date: now.toLocaleDateString('vi-VN'),
          time: now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
          pillar: pillar || '',
          angle: angle || '',
          format: mediaPaths.length > 0 ? 'Ảnh' : 'Text',
          pic: pic || '',
          contentLink: result.editUrl || result.url || '',
          designLink: '',
          mediaLink: '',
          status: 'WP Draft đã lưu',
          reviewLink: result.editUrl || '',
        });
      } catch (sheetErr) {
        logger.warn('Could not log WP draft to Sheets', { error: sheetErr.message });
      }
    }

    res.json(result);
  } catch (err) {
    logger.error('WordPress endpoint error', { error: err.message });
    res.status(500).json({ error: 'WordPress post failed', details: err.message });
  }
});

// ==========================================
// Settings API
// ==========================================

app.get('/api/workspaces', (req, res) => {
  const { db } = require('./db/database');
  let rows=db.prepare(`SELECT w.id,w.name,w.business_id,w.avatar_emoji,w.profile_color,CASE WHEN w.pin_hash!='' THEN 1 ELSE 0 END has_pin,w.is_active,
    (SELECT COUNT(*) FROM workspace_ad_accounts a WHERE a.workspace_id=w.id) account_count,
    (SELECT COUNT(*) FROM workspace_pages p WHERE p.workspace_id=w.id) page_count
    FROM workspaces w WHERE w.is_active=1 ORDER BY w.name`).all();
  if (!rows.length && (config.facebook.adAccountIds.length || config.facebook.pages.length)) {
    const id=db.prepare('INSERT INTO workspaces(name,ads_access_token) VALUES (?,?)').run('Doanh nghiệp mặc định','').lastInsertRowid;
    if(config.facebook.adsAccessToken)saveSecrets({[`WORKSPACE_${id}_ADS_TOKEN`]:config.facebook.adsAccessToken});
    const addAccount=db.prepare('INSERT OR IGNORE INTO workspace_ad_accounts(workspace_id,account_id,name,is_default) VALUES (?,?,?,?)');
    config.facebook.adAccountIds.forEach((account,index)=>addAccount.run(id,account,account,index===0?1:0));
    const addPage=db.prepare('INSERT OR IGNORE INTO workspace_pages(workspace_id,page_id,name,access_token,is_default) VALUES (?,?,?,?,?)');
    config.facebook.pages.forEach((page,index)=>{addPage.run(id,page.id,page.name,'',index===0?1:0);if(page.token)saveSecrets({[`WORKSPACE_${id}_PAGE_${page.id}_TOKEN`]:page.token});});
    rows=db.prepare(`SELECT w.id,w.name,w.business_id,w.avatar_emoji,w.profile_color,CASE WHEN w.pin_hash!='' THEN 1 ELSE 0 END has_pin,w.is_active,(SELECT COUNT(*) FROM workspace_ad_accounts a WHERE a.workspace_id=w.id) account_count,(SELECT COUNT(*) FROM workspace_pages p WHERE p.workspace_id=w.id) page_count FROM workspaces w WHERE w.is_active=1 ORDER BY w.name`).all();
  }
  res.json({success:true,workspaces:rows});
});

app.get('/api/workspaces/:id', (req,res) => {
  const { db } = require('./db/database');
  const workspace=db.prepare("SELECT id,name,business_id,avatar_emoji,profile_color,ads_access_token,CASE WHEN pin_hash!='' THEN 1 ELSE 0 END has_pin FROM workspaces WHERE id=?").get(Number(req.params.id));
  if(!workspace)return res.status(404).json({success:false,error:'Không tìm thấy doanh nghiệp'});
  const localSecrets=loadSecrets();workspace.has_ads_access_token=!!(localSecrets[`WORKSPACE_${workspace.id}_ADS_TOKEN`]||workspace.ads_access_token); workspace.ads_access_token='';
  workspace.adAccounts=db.prepare('SELECT account_id,name,is_default FROM workspace_ad_accounts WHERE workspace_id=? ORDER BY is_default DESC,id').all(workspace.id);
  workspace.pages=db.prepare("SELECT page_id,name,'' access_token,CASE WHEN access_token!='' THEN 1 ELSE 0 END has_access_token,is_default FROM workspace_pages WHERE workspace_id=? ORDER BY is_default DESC,id").all(workspace.id).map(p=>({...p,has_access_token:!!(p.has_access_token||localSecrets[`WORKSPACE_${workspace.id}_PAGE_${p.page_id}_TOKEN`])}));
  res.json({success:true,workspace});
});

app.post('/api/workspaces', (req,res) => {
  const { db } = require('./db/database');
  const {id,name,businessId,avatarEmoji,profileColor,profilePin,adsAccessToken,adAccounts=[],pages=[]}=req.body;
  if(!String(name||'').trim())return res.status(400).json({success:false,error:'Tên doanh nghiệp là bắt buộc'});
  const save=db.transaction(()=>{
    let workspaceId=Number(id||0);
    const oldWorkspace=workspaceId?db.prepare('SELECT ads_access_token FROM workspaces WHERE id=?').get(workspaceId):null;
    if(workspaceId) db.prepare('UPDATE workspaces SET name=?,business_id=?,avatar_emoji=?,profile_color=?,ads_access_token=?,updated_at=datetime(\'now\') WHERE id=?').run(name.trim(),businessId||'',avatarEmoji||'🏢',profileColor||'#38bdf8',adsAccessToken||oldWorkspace?.ads_access_token||'',workspaceId);
    else workspaceId=Number(db.prepare('INSERT INTO workspaces(name,business_id,avatar_emoji,profile_color,ads_access_token) VALUES (?,?,?,?,?)').run(name.trim(),businessId||'',avatarEmoji||'🏢',profileColor||'#38bdf8',adsAccessToken||'').lastInsertRowid);
    if(String(profilePin||'').trim()) { const salt=crypto.randomBytes(16).toString('hex');const hash=crypto.scryptSync(String(profilePin).trim(),salt,64).toString('hex');db.prepare('UPDATE workspaces SET pin_hash=?,pin_salt=? WHERE id=?').run(hash,salt,workspaceId); }
    db.prepare('DELETE FROM workspace_ad_accounts WHERE workspace_id=?').run(workspaceId);
    const oldPageTokens=new Map(db.prepare('SELECT page_id,access_token FROM workspace_pages WHERE workspace_id=?').all(workspaceId).map(p=>[p.page_id,p.access_token]));
    db.prepare('DELETE FROM workspace_pages WHERE workspace_id=?').run(workspaceId);
    const aa=db.prepare('INSERT INTO workspace_ad_accounts(workspace_id,account_id,name,is_default) VALUES (?,?,?,?)');
    adAccounts.filter(a=>a.accountId).forEach((a,i)=>aa.run(workspaceId,a.accountId.trim(),a.name||'',a.isDefault||i===0?1:0));
    const pp=db.prepare('INSERT INTO workspace_pages(workspace_id,page_id,name,access_token,is_default) VALUES (?,?,?,?,?)');
    pages.filter(p=>p.pageId).forEach((p,i)=>pp.run(workspaceId,p.pageId.trim(),p.name||'',p.accessToken||oldPageTokens.get(p.pageId.trim())||'',p.isDefault||i===0?1:0));
    const workspaceSecrets={};if(adsAccessToken)workspaceSecrets[`WORKSPACE_${workspaceId}_ADS_TOKEN`]=adsAccessToken;
    pages.filter(p=>p.pageId&&p.accessToken).forEach(p=>workspaceSecrets[`WORKSPACE_${workspaceId}_PAGE_${p.pageId.trim()}_TOKEN`]=p.accessToken);
    saveSecrets(workspaceSecrets);
    db.prepare("UPDATE workspaces SET ads_access_token='' WHERE id=?").run(workspaceId);
    db.prepare("UPDATE workspace_pages SET access_token='' WHERE workspace_id=?").run(workspaceId);
    return workspaceId;
  });
  try{res.json({success:true,id:save()});}catch(error){res.status(400).json({success:false,error:error.message});}
});

app.delete('/api/workspaces/:id',(req,res)=>{
  const { db }=require('./db/database');
  db.prepare('UPDATE workspaces SET is_active=0,updated_at=datetime(\'now\') WHERE id=?').run(Number(req.params.id));
  res.json({success:true});
});

app.post('/api/profile-access',(req,res)=>{
  const { db }=require('./db/database');const id=Number(req.body?.workspaceId||0);const pin=String(req.body?.pin||'');
  const profile=db.prepare('SELECT id,pin_hash,pin_salt FROM workspaces WHERE id=? AND is_active=1').get(id);if(!profile)return res.status(404).json({success:false,error:'Không tìm thấy profile'});
  if(!profile.pin_hash)return res.json({success:true,workspaceId:id,pinRequired:false});
  const candidate=crypto.scryptSync(pin,profile.pin_salt,64);const expected=Buffer.from(profile.pin_hash,'hex');const valid=candidate.length===expected.length&&crypto.timingSafeEqual(candidate,expected);
  if(!valid)return res.status(401).json({success:false,error:'Mã PIN không đúng'});res.json({success:true,workspaceId:id,pinRequired:true});
});

// GET /api/settings — read .env and return (masking secrets)
app.get('/api/settings', (req, res) => {
  const envPath = path.join(__dirname, '..', '.env');
  let envContent = '';
  try {
    envContent = fs.readFileSync(envPath, 'utf-8');
  } catch (e) { /* file missing */ }

  const parsed = {};
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (match) parsed[match[1]] = match[2];
  }
  const secrets = loadSecrets();

  res.json({
    geminiApiKey: '', hasGeminiApiKey: !!secrets.GEMINI_API_KEY,
    facebookPageIds: parsed.FACEBOOK_PAGE_IDS || '',
    facebookPageTokens: '', hasFacebookPageTokens: !!secrets.FACEBOOK_PAGE_TOKENS,
    facebookPageNames: parsed.FACEBOOK_PAGE_NAMES || '',
    facebookAdAccountIds: parsed.FB_AD_ACCOUNT_IDS || parsed.FB_AD_ACCOUNT_ID || '',
    facebookAdsAccessToken: '', hasFacebookAdsAccessToken: !!secrets.FB_ADS_ACCESS_TOKEN,
    facebookApiVersion: parsed.FACEBOOK_API_VERSION || 'v23.0',
    facebookAppId: parsed.FACEBOOK_APP_ID || '',
    facebookAppSecret: '', hasFacebookAppSecret: !!secrets.FACEBOOK_APP_SECRET,
    wordpressUrl: parsed.WORDPRESS_URL || '',
    wordpressUsername: parsed.WORDPRESS_USERNAME || '',
    wordpressAppPassword: '', hasWordpressAppPassword: !!secrets.WORDPRESS_APP_PASSWORD,
    googleDriveFolderId: parsed.GOOGLE_DRIVE_FOLDER_ID || '',
    googleSheetsSpreadsheetId: parsed.GOOGLE_SHEETS_SPREADSHEET_ID || '',
    googleSheetsSheetName: parsed.GOOGLE_SHEETS_SHEET_NAME || 'master',
  });
});

// POST /api/settings — write to .env and reload config
app.post('/api/settings', (req, res) => {
  const {
    geminiApiKey, facebookPageIds, facebookPageTokens, facebookPageNames,
    facebookAdAccountIds, facebookAdsAccessToken, facebookApiVersion,
    facebookAppId, facebookAppSecret,
    wordpressUrl, wordpressUsername, wordpressAppPassword,
    googleDriveFolderId, googleSheetsSpreadsheetId, googleSheetsSheetName,
  } = req.body;

  const envPath = path.join(__dirname, '..', '.env');
  saveSecrets({ GEMINI_API_KEY:geminiApiKey, FACEBOOK_PAGE_TOKENS:facebookPageTokens, FB_ADS_ACCESS_TOKEN:facebookAdsAccessToken, FACEBOOK_APP_SECRET:facebookAppSecret, WORDPRESS_APP_PASSWORD:wordpressAppPassword });

  // Read existing .env to preserve PORT, DRY_RUN, GOOGLE_CREDENTIALS_PATH
  let existing = {};
  try {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const match = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
      if (match) existing[match[1]] = match[2];
    }
  } catch (e) { /* file missing */ }

  const updated = {
    ...existing,
    FACEBOOK_PAGE_IDS: facebookPageIds ?? existing.FACEBOOK_PAGE_IDS ?? '',
    FACEBOOK_PAGE_NAMES: facebookPageNames ?? existing.FACEBOOK_PAGE_NAMES ?? '',
    FB_AD_ACCOUNT_IDS: facebookAdAccountIds ?? existing.FB_AD_ACCOUNT_IDS ?? existing.FB_AD_ACCOUNT_ID ?? '',
    FACEBOOK_API_VERSION: facebookApiVersion ?? existing.FACEBOOK_API_VERSION ?? 'v23.0',
    FACEBOOK_APP_ID: facebookAppId ?? existing.FACEBOOK_APP_ID ?? '',
    WORDPRESS_URL: wordpressUrl ?? existing.WORDPRESS_URL ?? '',
    WORDPRESS_USERNAME: wordpressUsername ?? existing.WORDPRESS_USERNAME ?? '',
    GOOGLE_DRIVE_FOLDER_ID: googleDriveFolderId ?? existing.GOOGLE_DRIVE_FOLDER_ID ?? '',
    GOOGLE_SHEETS_SPREADSHEET_ID: googleSheetsSpreadsheetId ?? existing.GOOGLE_SHEETS_SPREADSHEET_ID ?? '',
    GOOGLE_SHEETS_SHEET_NAME: googleSheetsSheetName ?? existing.GOOGLE_SHEETS_SHEET_NAME ?? 'master',
  };

  const lines = Object.entries(updated).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.writeFileSync(envPath, lines + '\n', 'utf-8');

  reloadFromDisk();

  res.json({ success: true, message: 'Settings saved and reloaded.' });
});

// ==========================================
// Connection Test APIs
// ==========================================

// Facebook: Exchange short-lived token for permanent Page Tokens
app.post('/api/facebook/exchange-token', async (req, res) => {
  const { appId, appSecret, shortToken } = req.body;
  if (!appId || !appSecret || !shortToken)
    return res.json({ success: false, message: 'appId, appSecret, and shortToken are required' });
  const API = `https://graph.facebook.com/${config.facebook.apiVersion}`;
  try {
    // Step 1: exchange for long-lived user token
    const exch = await axios.get(`${API}/oauth/access_token`, {
      params: { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: shortToken },
      timeout: 15000,
    });
    const longToken = exch.data.access_token;
    // Step 2: get permanent page tokens
    const accounts = await axios.get(`${API}/me/accounts`, {
      params: { access_token: longToken, fields: 'id,name,access_token' },
      timeout: 15000,
    });
    res.json({ success: true, pages: accounts.data.data || [] });
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err.message;
    res.json({ success: false, message: msg });
  }
});

app.post('/api/test/facebook-ads', async (req, res) => {
  const token = req.body.accessToken || config.facebook.adsAccessToken;
  const apiVersion = /^v\d+\.\d+$/.test(req.body.apiVersion || '') ? req.body.apiVersion : config.facebook.apiVersion;
  const rawIds = req.body.adAccountIds || config.facebook.adAccountIds.join(',');
  const ids = String(rawIds).split(',').map(id => id.trim()).filter(Boolean).map(id => id.startsWith('act_') ? id : `act_${id}`);
  if (!token) return res.json({ success:false, message:'Thiếu Ads Access Token' });
  if (!ids.length) return res.json({ success:false, message:'Thiếu Ad Account ID' });
  try {
    const checks = await Promise.all(ids.map(async id => {
      const response = await axios.get(`https://graph.facebook.com/${apiVersion}/${id}`, {
        params: { fields:'id,name,account_status,currency,timezone_name', access_token:token }, timeout:15000
      });
      return response.data;
    }));
    res.json({ success:true, message:`Kết nối thành công ${checks.length} tài khoản: ${checks.map(a=>a.name||a.id).join(' · ')}`, accounts:checks });
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err.message;
    res.json({ success:false, message:msg });
  }
});

// ==========================================
// Connection Test APIs
// ==========================================

// Test: Gemini
app.post('/api/test/gemini', async (req, res) => {
  const apiKey = req.body.apiKey || config.gemini.apiKey;
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      { contents: [{ parts: [{ text: 'Reply with: OK' }] }], generationConfig: { maxOutputTokens: 5 } },
      { timeout: 15000 }
    );
    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.json({ success: true, message: `Gemini OK — Model replied: "${text.trim()}"` });
  } catch (err) {
    res.json({ success: false, message: err.response?.data?.error?.message || err.message });
  }
});

// Test: Facebook Page Token
app.post('/api/test/facebook', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ success: false, message: 'Access token is required' });
  try {
    const response = await axios.get(`https://graph.facebook.com/me?fields=id,name&access_token=${token}`, { timeout: 10000 });
    res.json({ success: true, message: `Token valid ✔ — Page: "${response.data.name}" (ID: ${response.data.id})` });
  } catch (err) {
    res.json({ success: false, message: err.response?.data?.error?.message || err.message });
  }
});

// Test: WordPress
app.post('/api/test/wordpress', async (req, res) => {
  const url = req.body.url || config.wordpress.url;
  const username = req.body.username || config.wordpress.username;
  const appPassword = req.body.appPassword || config.wordpress.appPassword;
  if (!url || !username || !appPassword) return res.json({ success: false, message: 'URL, username and app password required' });
  try {
    const auth = Buffer.from(`${username}:${appPassword}`).toString('base64');
    // Use /wp/v2/types — public endpoint, not blocked by REST-restriction plugins
    const response = await axios.get(`${url.replace(/\/$/, '')}/wp-json/wp/v2/types`, {
      headers: { Authorization: `Basic ${auth}` },
      timeout: 10000,
    });
    const types = Object.keys(response.data || {}).join(', ');
    res.json({ success: true, message: `WordPress OK ✔ — REST API reachable. Post types: ${types}` });
  } catch (err) {
    res.json({ success: false, message: err.response?.data?.message || err.message });
  }
});

// ==========================================
// Live Log Viewer (SSE)
// ==========================================

// In-memory list of SSE clients
const logClients = new Set();

// Patch the logger to broadcast to SSE clients
const originalLog = logger.log.bind(logger);
logger.log = (level, message, meta) => {
  originalLog(level, message, meta);
  const entry = JSON.stringify({ level, message, error: meta?.error, timestamp: new Date().toISOString() });
  for (const cl of logClients) {
    try { cl.write(`event: log\ndata: ${entry}\n\n`); } catch (_) { logClients.delete(cl); }
  }
};

// SSE endpoint
app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send last 100 lines from error.log as history
  const errorLogPath = path.join(__dirname, '..', 'logs', 'error.log');
  try {
    const raw = fs.readFileSync(errorLogPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean).slice(-100);
    const history = lines.map(l => { try { return JSON.parse(l); } catch { return { level: 'info', message: l }; } });
    res.write(`event: history\ndata: ${JSON.stringify(history)}\n\n`);
  } catch (_) {
    res.write(`event: history\ndata: []\n\n`);
  }

  logClients.add(res);
  req.on('close', () => logClients.delete(res));

  // Keepalive ping every 20s
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); logClients.delete(res); }
  }, 20000);
});

// Serve log viewer page
app.get('/logs', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'logs.html')));

// Get brand guidelines
app.get('/api/guidelines', (req, res) => {
  try {
    const content = getGuidelines();
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load guidelines' });
  }
});

// Update brand guidelines
app.put('/api/guidelines', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'Content is required' });
  try {
    updateGuidelines(content);
    res.json({ success: true, message: 'Guidelines updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update guidelines' });
  }
});

// Serve pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'settings.html')));
app.get('/report-settings', (req,res)=>res.sendFile(path.join(__dirname,'..','public','report-settings.html')));

// Global Error Handler to guarantee JSON responses for API errors
app.use((err, req, res, next) => {
  logger.error('Unhandled server error:', { error: err.message, stack: err.stack });
  
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
  }
  
  // For API routes, always return JSON
  if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json')) {
    return res.status(err.status || 500).json({
      success: false, 
      error: err.message || 'Internal Server Error'
    });
  }
  
  next(err);
});

// Start server
const server = app.listen(config.port, '0.0.0.0', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  let localIp = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) { localIp = net.address; break; }
    }
  }
  logger.info(`Content Distributor running on port ${config.port}`);
  console.log(`\n  🚀 Content Distributor`);
  console.log(`  📍 Dashboard: http://localhost:${config.port}`);
  console.log(`  ⚙️  Settings:  http://localhost:${config.port}/settings`);
  console.log(`  📍 Network:   http://${localIp}:${config.port}`);
  console.log(`  🔒 Dry-run:   ${config.dryRun ? 'ON' : 'OFF'}\n`);
  
  // Start automated cron jobs
  const cron = require('node-cron');
  const { runAdsSync } = require('./services/adsSyncRunner');
  
  // Cron jobs runs every hour at minute 0
  cron.schedule('0 * * * *', async () => {
    logger.info('Running scheduled hourly Facebook Ads sync...');
    console.log('[CRON] Starting Hourly Sync at 00 minute');
    await runAdsSync('cron');
    console.log('[CRON] Hourly Sync Completed.');
  }, {
    scheduled: true,
    timezone: "Asia/Ho_Chi_Minh"
  });
  logger.info('Scheduled hourly cron job for Facebook Ads sync (Vietnam Time).');

});

// Graceful shutdown to release port (especially for nodemon/watch mode on Windows)
function shutdown() {
  console.log('\n[SERVER] Tiết trình đang đóng cổng mạng để giải phóng...');
  server.close(() => {
    console.log('[SERVER] Đã giải phóng hoàn toàn cổng mạng. Thoát.');
    process.exit(0);
  });
  
  // Timeout in case connections are lingering
  setTimeout(() => {
    console.log('[SERVER] Đóng ép buộc do quá thời gian.');
    process.exit(1);
  }, 3000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Windows specific nodemon signal
process.on('message', (msg) => { if (msg === 'shutdown') shutdown(); });

module.exports = app;
