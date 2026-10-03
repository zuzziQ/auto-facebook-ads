const axios = require('axios');
const path = require('path');
const { google } = require('googleapis');
const logger = require('../utils/logger');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { insertManyStats, insertManyConfig } = require('../db/database');

const AD_ACCOUNT_IDS = (process.env.FB_AD_ACCOUNT_IDS || process.env.FB_AD_ACCOUNT_ID || '').split(',').map(id => id.trim()).filter(Boolean);
const ACCESS_TOKEN = process.env.FB_ADS_ACCESS_TOKEN;
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ADS_SPREADSHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEETS_ADS_SHEET_NAME;
const CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH || './mkt-data-436605-eb606f873884.json';
const API_VERSION = process.env.FACEBOOK_API_VERSION || 'v21.0';
const CONFIG_SHEET_NAME = process.env.GOOGLE_SHEETS_ADS_CONFIG_SHEET_NAME || 'bao-cao-ad-config';

async function getSheetsClient() {
  const credPath = path.resolve(CREDENTIALS_PATH);
  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return google.sheets({ version: 'v4', auth });
}

async function fetchAdsInsights(adAccountId, accessToken = ACCESS_TOKEN, historyDays = 30) {
  if (!accessToken) {
    throw new Error("Missing Facebook Ads access token");
  }

  // Helper hàm gọi API có Retry
  const fetchWithRetry = async (url, config = {}, retries = 3) => {
    for (let i = 0; i < retries; i++) {
      try {
        return await axios.get(url, config);
      } catch (error) {
        const status = error.response ? error.response.status : null;
        const isRateLimitOrTimeout = error.code === 'ECONNABORTED' || status === 429 || (status && status >= 500);
        if (isRateLimitOrTimeout && i < retries - 1) {
          const delay = Math.floor(Math.random() * 1000) + 1000; // 1-2 giây
          logger.warn(`[FB Ads] Yêu cầu thất bại (${status || error.code}). Đang thử lại sau ${delay}ms (Lần ${i + 1}/${retries})...`);
          await new Promise(res => setTimeout(res, delay));
        } else {
          throw error;
        }
      }
    }
  };

  let allData = [];
  try {
    const today = new Date();
    // Đảm bảo lấy theo múi giờ VN hoặc ít nhất là hôm nay (vì server set timezone Asia/Ho_Chi_Minh trong cron)
    // Để an toàn, chúng ta định dạng YYYY-MM-DD
    const tzOffset = 7 * 60 * 60 * 1000; // GMT+7
    const localToday = new Date(today.getTime() + tzOffset);
    historyDays=Math.max(1,Math.min(1095,Number(historyDays||30)));
    const rangeStart = new Date(localToday.getTime() - historyDays * 86400000);
    const chunkDays=historyDays>45?30:historyDays;
    for(let cursor=new Date(rangeStart);cursor<=localToday;cursor.setUTCDate(cursor.getUTCDate()+chunkDays)){
      const chunkEnd=new Date(Math.min(localToday.getTime(),cursor.getTime()+(chunkDays-1)*86400000));
      const since=cursor.toISOString().substring(0,10),until=chunkEnd.toISOString().substring(0,10);
      try{
        let response=await fetchWithRetry(`https://graph.facebook.com/${API_VERSION}/${adAccountId}/insights`,{params:{access_token:accessToken,fields:'account_name,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,reach,inline_link_clicks,cpc,ctr,cpm,cpp,frequency,actions,cost_per_action_type',time_range:JSON.stringify({since,until}),time_increment:1,level:'ad',limit:500}});
        allData=allData.concat(response.data.data||[]);
        while(response.data.paging?.next){response=await fetchWithRetry(response.data.paging.next);allData=allData.concat(response.data.data||[]);}
      }catch(error){logger.error('Meta Insights backfill chunk failed',{adAccountId,since,until,error:error.response?.data?.error?.message||error.message});}
    }

    return allData.map(ad => ({ ...ad, adAccountId }));
  } catch (error) {
    logger.error(`Error fetching Facebook Ads for ${adAccountId}:`, error.response ? error.response.data : error.message);
    return [];
  }
}

// Meta can expose the same result under several action types depending on the
// campaign objective/pixel setup. Use the first available alias so aggregate
// actions (for example omni_purchase) are not double-counted.
function actionMetric(items, aliases) {
  if (!Array.isArray(items)) return 0;
  for (const alias of aliases) {
    const item = items.find(x => x.action_type === alias);
    if (item) return Number(item.value || 0);
  }
  return 0;
}

const MESSAGE_ACTIONS = ['onsite_conversion.messaging_conversation_started_7d','messaging_conversation_started_7d'];
const LEAD_ACTIONS = ['lead','onsite_conversion.lead_grouped','offsite_conversion.fb_pixel_lead'];
const PURCHASE_ACTIONS = ['purchase','omni_purchase','offsite_conversion.fb_pixel_purchase','onsite_web_purchase'];

async function fetchConfig(adAccountId, accessToken = ACCESS_TOKEN) {
  if (!accessToken) return { campaigns: [], adsets: [], ads: [] };
  
  async function fetchAll(url, params) {
    let result = [];
    const getWithRetry=async(target,requestParams)=>{
      let lastError;
      for(let attempt=1;attempt<=3;attempt++){
        try{return await axios.get(target,{params:requestParams,timeout:30000});}
        catch(error){lastError=error;if(attempt<3){logger.warn('Meta config request retry',{adAccountId,attempt,error:error.response?.data?.error?.message||error.message});await new Promise(resolve=>setTimeout(resolve,attempt*1200));}}
      }
      throw lastError;
    };
    try {
      let res = await getWithRetry(url, params);
      result = result.concat(res.data.data);
      while(res.data.paging && res.data.paging.next) {
        res = await getWithRetry(res.data.paging.next);
        result = result.concat(res.data.data);
      }
    } catch(err) {
      logger.error('Error fetching paginated config from Meta', {adAccountId,error:err.response?.data?.error?.message||err.message});
      throw err;
    }
    return result;
  }

  try {
    // Lấy Campaigns
    const campaignsData = await fetchAll(`https://graph.facebook.com/${API_VERSION}/${adAccountId}/campaigns`, {
      access_token: accessToken, fields: 'id,name,daily_budget,lifetime_budget,status,start_time,stop_time', limit: 100
    });
    
    // Lấy Ad Sets
    const adsetsData = await fetchAll(`https://graph.facebook.com/${API_VERSION}/${adAccountId}/adsets`, {
      access_token: accessToken, fields: 'id,name,campaign_id,daily_budget,lifetime_budget,status,start_time,end_time,targeting', limit: 100
    });

    // Lấy Ads
    const adsData = await fetchAll(`https://graph.facebook.com/${API_VERSION}/${adAccountId}/ads`, {
      access_token: accessToken, fields: 'id,name,adset_id,campaign_id,status,created_time,creative{id,effective_object_story_id,instagram_permalink_url,image_hash,image_url,thumbnail_url,body,object_story_spec,video_id}', limit: 100
    });
    
    return {
      campaigns: campaignsData.map(c => ({ ...c, account_id: adAccountId })),
      adsets: adsetsData.map(as => ({ ...as, account_id: adAccountId })),
      ads: adsData.map(ad => {
        let post_url = null;
        if (ad.creative && ad.creative.effective_object_story_id) {
          post_url = 'https://facebook.com/' + ad.creative.effective_object_story_id;
        }
        return { ...ad, account_id: adAccountId, post_url };
      })
    };
  } catch (error) {
    logger.error(`Error fetching Config for ${adAccountId}:`, error.response ? error.response.data : error.message);
    throw error;
  }
}

async function syncAdsDataToSheets(options = {}) {
  try {
    const accountIds=options.adAccountIds||AD_ACCOUNT_IDS;
    const accessToken=options.accessToken||ACCESS_TOKEN;
    if (accountIds.length === 0 || !accessToken) {
      throw new Error("No Ad Account IDs or access token available for sync");
    }

    let allAdsData = [];
    for (const id of accountIds) {
      console.log(`Fetching ads for account: ${id}...`);
      const data = await fetchAdsInsights(id, accessToken, options.historyDays||30);
      allAdsData = allAdsData.concat(data);
    }

    if (!allAdsData || allAdsData.length === 0) {
      console.log("No ads data found for any accounts in the selected date range.");
      return;
    }

    // Luôn lưu DB trước (an toàn nhất)
    try {
      const dbRows = allAdsData.map(ad => {
        const messStarted = actionMetric(ad.actions, MESSAGE_ACTIONS);
        const leads = actionMetric(ad.actions, LEAD_ACTIONS);
        const purchases = actionMetric(ad.actions, PURCHASE_ACTIONS);
        const spend = Number(ad.spend || 0);
        const costPerMess = actionMetric(ad.cost_per_action_type, MESSAGE_ACTIONS) || (messStarted ? spend / messStarted : 0);
        const costPerLead = actionMetric(ad.cost_per_action_type, LEAD_ACTIONS) || (leads ? spend / leads : 0);
        const costPerPurchase = actionMetric(ad.cost_per_action_type, PURCHASE_ACTIONS) || (purchases ? spend / purchases : 0);
        return {
          date: ad.date_start,
          account_name: ad.account_name || ad.adAccountId,
          campaign_id: ad.campaign_id,
          campaign_name: ad.campaign_name,
          adset_id: ad.adset_id,
          adset_name: ad.adset_name,
          ad_id: ad.ad_id,
          ad_name: ad.ad_name,
          spend,
          impressions: parseInt(ad.impressions || 0),
          clicks: parseInt(ad.clicks || 0),
          frequency: parseFloat(ad.frequency || 0),
          reach: parseInt(ad.reach || 0),
          cpm: parseFloat(ad.cpm || 0),
          link_clicks: parseInt(ad.inline_link_clicks || 0),
          ctr: parseFloat(ad.ctr || 0),
          cpc: parseFloat(ad.cpc || 0),
          mess_started: messStarted,
          cost_per_mess: costPerMess,
          leads,
          cost_per_lead: costPerLead,
          purchases,
          cost_per_purchase: costPerPurchase
        };
      });
      insertManyStats(dbRows);
      console.log(`Successfully inserted ${dbRows.length} rows to SQLite.`);
    } catch (dbError) {
      console.error("DB Insert Error:", dbError.message);
    }

    // Bắt đầu luồng Google Sheets
    try {
      const sheets = await getSheetsClient();
      
      // Check if headers exist
      const getResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A1:Z1`,
      });
      
      const existingRows = getResponse.data.values || [];
      if (existingRows.length === 0) {
        // Init Headers
        const headers = ['Ngày', 'Tài khoản', 'Campaign ID', 'Tên chiến dịch', 'Adset ID', 'Tên nhóm quảng cáo', 'Ad ID', 'Tên quảng cáo', 'Chi phí (Spend)', 'Lượt hiển thị (Impressions)', 'CPM', 'Tần suất (Frequency)', 'Lượt Click', 'Link Clicks', 'CTR', 'CPC', 'Mess Started', 'Cost per Mess'];
        await sheets.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEET_NAME}!A1:R1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [headers] },
        });
        console.log("Initialized headers.");
      }

      // Format new rows
      const rows = allAdsData.map(ad => {
        let messStarted = 0;
        if (ad.actions) {
          const messAction = ad.actions.find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d') || ad.actions.find(a => a.action_type === 'lead');
          if (messAction) messStarted = messAction.value;
        }
        
        let costPerMess = 0;
        if (ad.cost_per_action_type) {
          const costAction = ad.cost_per_action_type.find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d') || ad.cost_per_action_type.find(a => a.action_type === 'lead');
          if (costAction) costPerMess = costAction.value;
        } else if (messStarted > 0) {
           costPerMess = parseFloat(ad.spend) / parseInt(messStarted);
        } else {
           costPerMess = parseFloat(ad.spend);
        }

        let formattedDate = ad.date_start;
        if (ad.date_start && ad.date_start.includes('-')) {
          const [yyyy, mm, dd] = ad.date_start.split('-');
          formattedDate = `${dd}/${mm}/${yyyy}`;
        }

        return [
          formattedDate,
          ad.account_name || ad.adAccountId,
          ad.campaign_id ? `'${ad.campaign_id}` : '',
          ad.campaign_name,
          ad.adset_id ? `'${ad.adset_id}` : '',
          ad.adset_name,
          ad.ad_id ? `'${ad.ad_id}` : '',
          ad.ad_name,
          parseFloat(ad.spend || 0),
          parseInt(ad.impressions || 0),
          parseFloat(ad.cpm || 0),
          parseFloat(ad.frequency || 0),
          parseInt(ad.clicks || 0),
          parseInt(ad.inline_link_clicks || 0),
          parseFloat(ad.ctr || 0),
          parseFloat(ad.cpc || 0),
          parseInt(messStarted || 0),
          parseFloat(costPerMess || 0)
        ];
      });

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:R`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: rows },
      });
      console.log(`Successfully synced ${rows.length} rows to Google Sheets (Insights).`);
    } catch (sheetError) {
      console.error("Error syncing to Google Sheets (Insights):", sheetError.message);
    }
  } catch (error) {
    console.error("Sync Failed (Insights):", error.message);
    throw error;
  }
}

async function syncAdsConfigToSheets(options = {}) {
  try {
    const accountIds=options.adAccountIds||AD_ACCOUNT_IDS;
    const accessToken=options.accessToken||ACCESS_TOKEN;
    if (accountIds.length === 0 || !accessToken) throw new Error("No Ad Account IDs or access token available for config sync");

    let allCampaigns = [];
    let allAdsets = [];
    let allAds = [];
    for (const id of accountIds) {
      console.log(`Fetching config for account: ${id}...`);
      try {
        const data = await fetchConfig(id, accessToken);
        allCampaigns = allCampaigns.concat(data.campaigns || []);
        allAdsets = allAdsets.concat(data.adsets || []);
        allAds = allAds.concat(data.ads || []);
      } catch (accErr) {
        logger.error(`Failed to fetch config for account ${id}:`, { error: accErr.response?.data?.error?.message || accErr.message });
      }
    }

    // Map fast lookup
    const campMap = {};
    for (const c of allCampaigns) {
      campMap[c.id] = c;
    }
    const adsetMap = {};
    for (const as of allAdsets) {
       adsetMap[as.id] = as;
    }

    // Luôn lưu DB trước (an toàn nhất)
    try {
      const dbConfigRows = allAds.map(ad => {
        const as = adsetMap[ad.adset_id] || {};
        const cmp = campMap[ad.campaign_id] || {};

        const asDaily = as.daily_budget ? Number(as.daily_budget) : 0;
        const asLifetime = as.lifetime_budget ? Number(as.lifetime_budget) : 0;
        const cmpDaily = cmp.daily_budget ? Number(cmp.daily_budget) : 0;
        const cmpLifetime = cmp.lifetime_budget ? Number(cmp.lifetime_budget) : 0;
        const rawBudget = asDaily || asLifetime || cmpDaily || cmpLifetime || 0;
        const hasEndTime = Boolean(as.end_time || as.stop_time || cmp.stop_time || cmp.end_time);
        const noDaily = asDaily === 0 && cmpDaily === 0;

        const isLifetime = (asLifetime > 0 && asDaily === 0) ||
          (cmpLifetime > 0 && cmpDaily === 0) ||
          (rawBudget >= 2000000) ||
          (hasEndTime && noDaily);
        const budgetType = isLifetime ? 'LIFETIME' : 'DAILY';

        return {
          ad_id: ad.id,
          account_id: ad.account_id,
          campaign_id: ad.campaign_id || '',
          campaign_name: cmp.name || '',
          campaign_status: cmp.status || '',
          campaign_start_time: cmp.start_time || '',
          campaign_end_time: cmp.stop_time || cmp.end_time || '',
          campaign_budget: String(cmpDaily || cmpLifetime || '0'),
          campaign_daily_budget: isLifetime ? '0' : String(cmpDaily),
          campaign_lifetime_budget: isLifetime ? String(cmpLifetime || (cmpDaily >= 2000000 ? cmpDaily : 0) || rawBudget) : '0',
          adset_id: ad.adset_id || '',
          adset_name: as.name || '',
          adset_status: as.status || '',
          adset_start_time: as.start_time || '',
          adset_end_time: as.end_time || as.stop_time || '',
          adset_budget: String(asDaily || asLifetime || '0'),
          adset_daily_budget: isLifetime ? '0' : String(asDaily),
          adset_lifetime_budget: isLifetime ? String(asLifetime || (asDaily >= 2000000 ? asDaily : 0) || rawBudget) : '0',
          budget_type: budgetType,
          ad_name: ad.name,
          ad_status: ad.status,
          created_time: ad.created_time || '',
          post_url: ad.post_url || null,
          targeting: as.targeting ? JSON.stringify(as.targeting) : null
        };
      });
      if (dbConfigRows.length > 0) {
        insertManyConfig(dbConfigRows);
        console.log(`Successfully inserted ${dbConfigRows.length} rows to SQLite (Config).`);
      }

      // Sync creative data
      try {
        const { insertAdCreative } = require('../db/database');
        const crypto = require('crypto');
        
        // Strip Facebook thumbnail size params to get full-resolution image
        function cleanThumbUrl(url) {
          if (!url) return null;
          try {
            const u = new URL(url);
            // Remove size-limiting params
            u.searchParams.delete('stp');
            u.searchParams.delete('_nc_tpa');
            return u.toString();
          } catch(e) {
            return url;
          }
        }

        for (const ad of allAds) {
          const creative = ad.creative || {};
          const spec = creative.object_story_spec || {};
          
          // Extract body text — try all possible locations
          const bodyText = creative.body 
            || spec.link_data?.message 
            || spec.video_data?.message
            || spec.photo_data?.caption
            || '';
          
          // Extract thumbnail — prefer full image, fallback to video thumbnail
          // Then clean the URL to get full resolution (strip p64x64 etc)
          const rawThumb = creative.image_url
            || spec.link_data?.picture
            || spec.video_data?.image_url
            || creative.thumbnail_url
            || null;
          const thumbnailUrl = cleanThumbUrl(rawThumb);
          
          const videoId = creative.video_id || spec.video_data?.video_id || null;
          
          const bodyHash = crypto.createHash('md5').update(bodyText).digest('hex');
          // Facebook CDN query signatures change on every sync. Never fingerprint the full URL.
          // Prefer stable creative/image identifiers so "Mới cập nhật" means an actual creative change.
          let stableImageSource = creative.image_hash
            || spec.link_data?.image_hash
            || spec.photo_data?.image_hash
            || creative.effective_object_story_id
            || creative.id
            || '';
          if (!stableImageSource && thumbnailUrl) {
            try { stableImageSource = new URL(thumbnailUrl).pathname; } catch (_) { stableImageSource = thumbnailUrl.split('?')[0]; }
          }
          const imageHash = stableImageSource ? crypto.createHash('md5').update(String(stableImageSource)).digest('hex') : '';
          
          insertAdCreative({
            ad_id: ad.id,
            thumbnail_url: thumbnailUrl,
            video_url: null,
            body_text: bodyText,
            image_hash: imageHash,
            video_id: videoId || '',
            body_hash: bodyHash
          });
        }
        console.log(`Creative sync done. (${allAds.length} ads)`);
      } catch(creativeErr) {
        console.error('Creative sync error:', creativeErr.message);
      }
    } catch (dbError) {
      console.error("DB Insert Error (Config):", dbError.message);
    }

    try {
      const sheets = await getSheetsClient();
      
      // Clear old config sheet
      await sheets.spreadsheets.values.clear({
        spreadsheetId: SPREADSHEET_ID,
        range: CONFIG_SHEET_NAME,
      });

    // Write new config (Ads combined with Adsets and Campaigns)
    const headers = [
      'Tài khoản', 
      'Campaign ID', 'Tên Campaign', 'Status Campaign', 'Start Time Campaign', 'Ngân sách Campaign', 
      'Adset ID', 'Tên Adset', 'Status Adset', 'Start Time Adset', 'Ngân sách Adset',
      'Ad ID', 'Tên Ad', 'Status Ad', 'Created Time Ad'
    ];
    
    // Map fast lookup
    const campMap = {};
    for (const c of allCampaigns) {
      campMap[c.id] = c;
    }
    const adsetMap = {};
    for (const as of allAdsets) {
       adsetMap[as.id] = as;
    }

    const rows = [headers];
    const adsetSeen = new Set();
    const campSeen = new Set();

    // Hàm format thời gian rút gọn
    const formatTime = (isoString) => isoString ? isoString.substring(0, 10) + ' ' + isoString.substring(11, 16) : '';

    // 1. Quét tất cả các Ads
    for (const ad of allAds) {
       const as = adsetMap[ad.adset_id] || {};
       const cmp = campMap[ad.campaign_id] || {};
       adsetSeen.add(ad.adset_id);
       campSeen.add(ad.campaign_id);

       rows.push([
         ad.account_id,
         (cmp.id || ad.campaign_id) ? `'${cmp.id || ad.campaign_id}` : '',
         cmp.name || '',
         cmp.status || '',
         formatTime(cmp.start_time),
         cmp.daily_budget ? cmp.daily_budget : (cmp.lifetime_budget ? cmp.lifetime_budget : '0'),
         (as.id || ad.adset_id) ? `'${as.id || ad.adset_id}` : '',
         as.name || '',
         as.status || '',
         formatTime(as.start_time),
         as.daily_budget ? as.daily_budget : (as.lifetime_budget ? as.lifetime_budget : '0'),
         ad.id ? `'${ad.id}` : '',
         ad.name,
         ad.status,
         formatTime(ad.created_time)
       ]);
    }

    // 2. Quét bù những Adset không có Ads bên trong
    for (const as of allAdsets) {
       if (!adsetSeen.has(as.id)) {
          const cmp = campMap[as.campaign_id] || {};
          campSeen.add(as.campaign_id);
          rows.push([
            as.account_id,
            (cmp.id || as.campaign_id) ? `'${cmp.id || as.campaign_id}` : '',
            cmp.name || '',
            cmp.status || '',
            formatTime(cmp.start_time),
            cmp.daily_budget ? cmp.daily_budget : (cmp.lifetime_budget ? cmp.lifetime_budget : '0'),
            as.id ? `'${as.id}` : '',
            as.name,
            as.status,
            formatTime(as.start_time),
            as.daily_budget ? as.daily_budget : (as.lifetime_budget ? as.lifetime_budget : '0'),
            '', '', '', ''
          ]);
       }
    }

    // 3. Quét bù những Campaign không có Adset bên trong
    for (const cmp of allCampaigns) {
       if (!campSeen.has(cmp.id)) {
          rows.push([
            cmp.account_id,
            cmp.id ? `'${cmp.id}` : '',
            cmp.name,
            cmp.status,
            formatTime(cmp.start_time),
            cmp.daily_budget ? cmp.daily_budget : (cmp.lifetime_budget ? cmp.lifetime_budget : '0'),
            '', '', '', '', '',
            '', '', '', ''
          ]);
       }
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${CONFIG_SHEET_NAME}!A:O`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    });
    console.log(`Successfully synced Config to Google Sheets.`);
  } catch (sheetError) {
    console.error("Error syncing to Google Sheets (Config):", sheetError.message);
  }
  } catch (error) {
    console.error("Sync Failed (Config):", error.message);
    throw error;
}
}

async function syncKPIsFromSheets() {
  const SPREADSHEET_ID = '18hFk4Q_AMSaEpxds-LEhR3NZ0e76Y-FRYs0agt2aXdo';
  const SHEET_NAME = 'KPI_Settings';
  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A2:I`,
    });
    const rows = res.data.values;
    if (!rows || rows.length === 0) {
      console.log('No KPI data found in Google Sheets.');
      return;
    }
    
    // We need db and stmts
    const { stmts, db } = require('../db/database');
    stmts.clearKpiConfig.run();
    const insert = db.transaction((kpis) => {
      for (const row of kpis) {
        if (!row[0] || !row[2]) continue; // Require start_date and Ngân Sách Target
        
        const kpi_spend = parseInt(String(row[2]).replace(/[^\d]/g, '')) || 0;
        const kpi_mess = row[3] ? parseInt(String(row[3]).replace(/[^\d]/g, '')) || 0 : 0;
        // SL Ad Target = row[4]; We don't save SL Ad target in DB right now, just Spend and Mess.
        
        // Phân tích % tuỳ chỉnh từ cột F, G, H, I (nếu có, không có thì xài số mặc định)
        const parsePct = (val, defaultVal) => {
          if (!val) return defaultVal;
          let num = parseFloat(String(val).replace(/[^\d.]/g, ''));
          if (isNaN(num)) return defaultVal;
          if (String(val).includes('%') || num > 1) return num / 100;
          return num;
        };

        const pct_nam = parsePct(row[5], 0.35);
        const pct_umau = parsePct(row[6], 0.20);
        const pct_chambot = parsePct(row[7], 0.20);
        const pct_lumislim = parsePct(row[8], 0.25);

        const allocations = [
          { service: 'Nám', pct: pct_nam },
          { service: 'U máu', pct: pct_umau },
          { service: 'Chàm bớt', pct: pct_chambot },
          { service: 'LumiSlim', pct: pct_lumislim }
        ];

        for (const dist of allocations) {
          stmts.insertKpiConfig.run({
            start_date: row[0],
            end_date: row[1] || row[0],
            service: dist.service,
            kpi_spend: Math.round(kpi_spend * dist.pct),
            kpi_mess: Math.round(kpi_mess * dist.pct)
          });
        }
      }
    });
    insert(rows);
    console.log(`Successfully synced ${rows.length} global KPI rows into ${rows.length * 4} service KPIs from Google Sheets to SQLite.`);
  } catch (err) {
    console.error('Error syncing KPIs from Sheets:', err.response ? err.response.data : err.message);
  }
}

// Allow running from CLI directly
if (require.main === module) {
  (async () => {
    await syncAdsDataToSheets();
    await syncAdsConfigToSheets();
    await syncKPIsFromSheets();
  })();
}

module.exports = { fetchAdsInsights, syncAdsDataToSheets, syncAdsConfigToSheets, syncKPIsFromSheets };
