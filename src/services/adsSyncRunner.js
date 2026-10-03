const { db } = require('../db/database');
const logger = require('../utils/logger');
const { loadSecrets } = require('./secretStore');
const { clearApiCache } = require('../utils/apiCache');
let running = false;

const set = (key, value) => db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value ?? ''));
const get = key => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value || null;

function nextHourlyRun(now = new Date()) {
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return next;
}

async function runAdsSync(source = 'manual', options = {}) {
  if (running) return { accepted:false, reason:'Đang có một phiên đồng bộ chạy' };
  running = true;
  const started = new Date();
  const requestedId=Number(options.workspaceId||0),statusKey=id=>`ads_sync_${id}_`;set('ads_sync_status', 'running');set('ads_sync_started_at',started.toISOString());set('ads_sync_source',source);set('ads_sync_error','');
  try {
    const { syncAdsDataToSheets, syncAdsConfigToSheets, syncKPIsFromSheets } = require('./facebookAds');
    const secrets=loadSecrets();
    const workspaces=requestedId?db.prepare('SELECT id,name FROM workspaces WHERE id=? AND is_active=1').all(requestedId):db.prepare('SELECT id,name FROM workspaces WHERE is_active=1').all();
    let connectionCount=0;
    for(const workspace of workspaces){
      const adAccountIds=db.prepare('SELECT account_id FROM workspace_ad_accounts WHERE workspace_id=?').all(workspace.id).map(r=>r.account_id);
      const accessToken=secrets[`WORKSPACE_${workspace.id}_ADS_TOKEN`];
      if(!adAccountIds.length||!accessToken){logger.warn('Skipping workspace without complete Meta connection',{workspaceId:workspace.id,name:workspace.name});continue;}
      connectionCount++;
      const prefix=statusKey(workspace.id);set(prefix+'status','running');set(prefix+'started_at',started.toISOString());set(prefix+'source',source);set(prefix+'error','');
      try {
        await syncAdsDataToSheets({adAccountIds,accessToken,historyDays:options.historyDays||30});
        await syncAdsConfigToSheets({adAccountIds,accessToken});
        const workspaceFinished=new Date();set(prefix+'status','success');set(prefix+'finished_at',workspaceFinished.toISOString());set(prefix+'duration_ms',workspaceFinished-started);
      } catch (wsError) {
        const wsFinished=new Date();set(prefix+'status','error');set(prefix+'finished_at',wsFinished.toISOString());set(prefix+'duration_ms',wsFinished-started);set(prefix+'error',wsError.message);
        logger.error(`Workspace ${workspace.name} (ID: ${workspace.id}) sync failed`, { error: wsError.message });
      }
    }
    if(!connectionCount)throw new Error('Không có Workspace nào đủ Ads Token và Ad Account để đồng bộ');
    await syncKPIsFromSheets();
    const finished = new Date();
    set('ads_sync_status', 'success'); set('ads_sync_finished_at', finished.toISOString()); set('ads_sync_duration_ms', finished-started);
    clearApiCache();
    logger.info('Facebook Ads sync completed', { source, durationMs:finished-started });
    return { accepted:true, success:true };
  } catch (error) {
    const finished = new Date();
    set('ads_sync_status', 'error'); set('ads_sync_finished_at', finished.toISOString()); set('ads_sync_duration_ms', finished-started); set('ads_sync_error', error.message);
    if(requestedId){const prefix=statusKey(requestedId);set(prefix+'status','error');set(prefix+'finished_at',finished.toISOString());set(prefix+'duration_ms',finished-started);set(prefix+'error',error.message);}
    logger.error('Facebook Ads sync failed', { source, error:error.message });
    return { accepted:true, success:false, error:error.message };
  } finally { running = false; }
}

function getAdsSyncStatus(workspaceId = 0) {
  const now = new Date(), next = nextHourlyRun(now);
  const integrity = db.pragma('quick_check', { simple:true });
  const ids=workspaceId?db.prepare('SELECT account_id FROM workspace_ad_accounts WHERE workspace_id=?').all(workspaceId).map(x=>x.account_id):[];const marks=ids.map(()=>'?').join(',');
  const stats=ids.length?db.prepare(`SELECT MAX(s.date) latest_data_date,COUNT(*) stat_rows,COUNT(DISTINCT s.ad_id) stat_ads FROM ad_daily_stats s JOIN ad_config c ON c.ad_id=s.ad_id WHERE c.account_id IN (${marks})`).get(...ids):db.prepare('SELECT MAX(date) latest_data_date,COUNT(*) stat_rows,COUNT(DISTINCT ad_id) stat_ads FROM ad_daily_stats').get();
  const config=ids.length?db.prepare(`SELECT MAX(updated_at) config_synced_at,COUNT(*) config_count FROM ad_config WHERE account_id IN (${marks})`).get(...ids):db.prepare('SELECT MAX(updated_at) config_synced_at,COUNT(*) config_count FROM ad_config').get();
  const creatives=ids.length?db.prepare(`SELECT MAX(cr.synced_at) creative_synced_at,MAX(cr.content_updated_at) creative_changed_at,COUNT(*) creative_count,SUM(cr.content_updated_at>=datetime('now','-1 day')) changed_24h FROM ad_creatives cr JOIN ad_config c ON c.ad_id=cr.ad_id WHERE c.account_id IN (${marks})`).get(...ids):db.prepare("SELECT MAX(synced_at) creative_synced_at,MAX(content_updated_at) creative_changed_at,COUNT(*) creative_count,SUM(content_updated_at>=datetime('now','-1 day')) changed_24h FROM ad_creatives").get();
  const prefix=workspaceId?`ads_sync_${workspaceId}_`:'ads_sync_';return { schedule:'0 * * * *', timezone:'Asia/Ho_Chi_Minh', frequency:'Mỗi giờ, phút 00', now:now.toISOString(), next_run_at:next.toISOString(), seconds_to_next:Math.max(0,Math.round((next-now)/1000)), running, status:get(prefix+'status')||'not_recorded', started_at:get(prefix+'started_at'), finished_at:get(prefix+'finished_at'), duration_ms:Number(get(prefix+'duration_ms')||0), source:get(prefix+'source'), error:get(prefix+'error'), db:{integrity,...stats,...config,...creatives} };
}

module.exports = { runAdsSync, getAdsSyncStatus };
