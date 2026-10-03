const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const DB_PATH = path.join(DB_DIR, 'ads.db');
const db = new Database(DB_PATH);

// Enable WAL mode for concurrent reads
db.pragma('journal_mode = WAL');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS ad_daily_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    account_name TEXT,
    campaign_id TEXT,
    campaign_name TEXT,
    adset_id TEXT,
    adset_name TEXT,
    ad_id TEXT NOT NULL,
    ad_name TEXT,
    spend REAL DEFAULT 0,
    impressions INTEGER DEFAULT 0,
    cpm REAL DEFAULT 0,
    frequency REAL DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    reach INTEGER DEFAULT 0,
    link_clicks INTEGER DEFAULT 0,
    ctr REAL DEFAULT 0,
    cpc REAL DEFAULT 0,
    mess_started INTEGER DEFAULT 0,
    cost_per_mess REAL DEFAULT 0,
    leads INTEGER DEFAULT 0,
    cost_per_lead REAL DEFAULT 0,
    purchases INTEGER DEFAULT 0,
    cost_per_purchase REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(date, ad_id)
  );

  CREATE TABLE IF NOT EXISTS ad_config (
    ad_id TEXT PRIMARY KEY,
    account_id TEXT,
    campaign_id TEXT,
    campaign_name TEXT,
    campaign_status TEXT,
    campaign_start_time TEXT,
    campaign_end_time TEXT,
    campaign_budget TEXT,
    campaign_daily_budget TEXT DEFAULT '0',
    campaign_lifetime_budget TEXT DEFAULT '0',
    adset_id TEXT,
    adset_name TEXT,
    adset_status TEXT,
    adset_start_time TEXT,
    adset_end_time TEXT,
    adset_budget TEXT,
    adset_daily_budget TEXT DEFAULT '0',
    adset_lifetime_budget TEXT DEFAULT '0',
    budget_type TEXT DEFAULT 'DAILY',
    ad_name TEXT,
    ad_status TEXT,
    created_time TEXT,
    post_url TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ai_strategy_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    time_label TEXT,
    service_label TEXT,
    report_content TEXT
  );
  CREATE TABLE IF NOT EXISTS workspace_llm_analysis_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    analysis_type TEXT NOT NULL DEFAULT 'running_ads',
    analyzed_ads INTEGER DEFAULT 0,
    result_json TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS kpi_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_date TEXT,
    end_date TEXT,
    service TEXT,
    kpi_spend INTEGER,
    kpi_mess INTEGER,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS service_cpmess_targets (
    service TEXT PRIMARY KEY,
    target_cpmess INTEGER NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ad_name_classification_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK(kind IN ('service','operator')),
    prefix TEXT NOT NULL,
    label TEXT NOT NULL,
    priority INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(kind,prefix)
  );

  CREATE TABLE IF NOT EXISTS workspace_cpmess_targets (
    workspace_id INTEGER NOT NULL,
    service TEXT NOT NULL,
    target_cpmess INTEGER NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(workspace_id,service)
  );

  CREATE TABLE IF NOT EXISTS workspace_funnel_targets (
    workspace_id INTEGER PRIMARY KEY,
    targets_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS workspace_classification_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('service','operator')),
    prefix TEXT NOT NULL,
    label TEXT NOT NULL,
    priority INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(workspace_id,kind,prefix)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    avatar_emoji TEXT DEFAULT '🏢',
    profile_color TEXT DEFAULT '#38bdf8',
    pin_hash TEXT DEFAULT '',
    pin_salt TEXT DEFAULT '',
    business_id TEXT,
    ads_access_token TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS workspace_ad_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    account_id TEXT NOT NULL,
    name TEXT,
    is_default INTEGER DEFAULT 0,
    UNIQUE(workspace_id, account_id),
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS workspace_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    page_id TEXT NOT NULL,
    name TEXT,
    access_token TEXT,
    is_default INTEGER DEFAULT 0,
    UNIQUE(workspace_id, page_id),
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ad_creatives (
    ad_id TEXT PRIMARY KEY,
    thumbnail_url TEXT,
    video_url TEXT,
    body_text TEXT,
    image_hash TEXT,
    video_id TEXT,
    body_hash TEXT,
    content_updated_at TEXT DEFAULT (datetime('now')),
    synced_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ad_ai_diagnoses (
    ad_id TEXT PRIMARY KEY,
    workspace_id INTEGER DEFAULT 1,
    service TEXT,
    diagnosis_json TEXT,
    snapshot_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_ad_ai_diagnoses_workspace ON ad_ai_diagnoses(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_ad_ai_diagnoses_updated ON ad_ai_diagnoses(updated_at);

  CREATE INDEX IF NOT EXISTS idx_ad_daily_stats_ad_id ON ad_daily_stats(ad_id);
  CREATE INDEX IF NOT EXISTS idx_ad_daily_stats_date ON ad_daily_stats(date);
  CREATE INDEX IF NOT EXISTS idx_ad_daily_stats_ad_id_date ON ad_daily_stats(ad_id, date);
  CREATE INDEX IF NOT EXISTS idx_ad_config_account_id ON ad_config(account_id);
  CREATE INDEX IF NOT EXISTS idx_ad_config_ad_status ON ad_config(ad_status);

  CREATE VIEW IF NOT EXISTS llm_analysis_history AS SELECT * FROM workspace_llm_analysis_history;

  CREATE TABLE IF NOT EXISTS page_daily_insights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    page_id TEXT NOT NULL,
    page_name TEXT,
    date TEXT NOT NULL,
    fans_total INTEGER DEFAULT 0,
    fan_adds INTEGER DEFAULT 0,
    fan_removes INTEGER DEFAULT 0,
    reach_total INTEGER DEFAULT 0,
    reach_organic INTEGER DEFAULT 0,
    reach_paid INTEGER DEFAULT 0,
    impressions_total INTEGER DEFAULT 0,
    impressions_organic INTEGER DEFAULT 0,
    impressions_paid INTEGER DEFAULT 0,
    post_engagements INTEGER DEFAULT 0,
    page_views INTEGER DEFAULT 0,
    demographics_json TEXT,
    cities_json TEXT,
    audience_quality_score INTEGER DEFAULT 100,
    misalignment_pct REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(page_id, date)
  );

  CREATE INDEX IF NOT EXISTS idx_page_daily_insights_page_date ON page_daily_insights(page_id, date);
  CREATE INDEX IF NOT EXISTS idx_page_daily_insights_ws_date ON page_daily_insights(workspace_id, date);
`);
try { db.prepare(`INSERT OR IGNORE INTO workspaces(id,name) VALUES (1,'Doanh nghiệp mặc định'),(2,'Phan Thủy')`).run(); } catch(e) {}
try { db.prepare(`INSERT OR IGNORE INTO workspace_pages(workspace_id,page_id,name,is_default) VALUES (2,'245392165331140','Phan Thủy Beauty & Clinic',1)`).run(); } catch(e) {}
db.prepare(`INSERT OR IGNORE INTO service_cpmess_targets(service,target_cpmess) VALUES ('U máu',150000),('Chàm bớt',150000),('Nám',250000)`).run();
db.prepare(`INSERT OR IGNORE INTO ad_name_classification_rules(kind,prefix,label,priority) VALUES ('service','nam_','Nám',10),('service','umau_','U máu',10),('service','chambot_','Chàm bớt',10),('service','trehoa_','Trẻ hóa',10),('service','lumislim_','LumiSlim',10),('service','csd_','Chăm sóc da',10),('operator','minhlq_','Minh LQ',10),('operator','huynq_','Huy NQ',10)`).run();
try { db.exec(`INSERT OR IGNORE INTO workspace_cpmess_targets(workspace_id,service,target_cpmess) SELECT 1,service,target_cpmess FROM service_cpmess_targets; INSERT OR IGNORE INTO workspace_classification_rules(workspace_id,kind,prefix,label,priority) SELECT 1,kind,prefix,label,priority FROM ad_name_classification_rules;`); } catch(e) {}
try { db.prepare(`INSERT OR IGNORE INTO workspace_funnel_targets(workspace_id,targets_json) VALUES (2,?)`).run(JSON.stringify({daily_budget:4000000,cost_per_message_max:200000,messages_min:20,messages_max:22,qualified_leads_min:12,qualified_leads_max:15,bookings_min:5,bookings_max:7,shows_min:3,shows_max:5,purchases_min:2,cost_per_purchase_max:2000000,revenue_min:8000000,roas_min:2})); } catch(e) {}

try { db.exec(`ALTER TABLE ad_daily_stats ADD COLUMN impressions INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE ad_daily_stats ADD COLUMN clicks INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE ad_daily_stats ADD COLUMN frequency REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE ad_daily_stats ADD COLUMN reach INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE ad_daily_stats ADD COLUMN leads INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE ad_daily_stats ADD COLUMN cost_per_lead REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE ad_daily_stats ADD COLUMN purchases INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE ad_daily_stats ADD COLUMN cost_per_purchase REAL DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE ad_config ADD COLUMN name_updated_at TEXT DEFAULT NULL`); } catch(e) {}
try { db.exec(`ALTER TABLE workspaces ADD COLUMN avatar_emoji TEXT DEFAULT '🏢'`); } catch(e) {}
try { db.exec(`ALTER TABLE workspaces ADD COLUMN profile_color TEXT DEFAULT '#38bdf8'`); } catch(e) {}
try { db.exec(`ALTER TABLE workspaces ADD COLUMN pin_hash TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE workspaces ADD COLUMN pin_salt TEXT DEFAULT ''`); } catch(e) {}
try { db.exec(`ALTER TABLE kpi_config ADD COLUMN workspace_id INTEGER DEFAULT 1`); } catch(e) {}
try { db.exec(`ALTER TABLE ad_config ADD COLUMN adset_daily_budget TEXT DEFAULT '0'`); } catch(e) {}
try { db.exec(`ALTER TABLE ad_config ADD COLUMN adset_lifetime_budget TEXT DEFAULT '0'`); } catch(e) {}
try { db.exec(`ALTER TABLE ad_config ADD COLUMN campaign_daily_budget TEXT DEFAULT '0'`); } catch(e) {}
try { db.exec(`ALTER TABLE ad_config ADD COLUMN campaign_lifetime_budget TEXT DEFAULT '0'`); } catch(e) {}
try { db.exec(`ALTER TABLE ad_config ADD COLUMN budget_type TEXT DEFAULT 'DAILY'`); } catch(e) {}
try { db.exec(`ALTER TABLE ad_config ADD COLUMN adset_end_time TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE ad_config ADD COLUMN campaign_end_time TEXT`); } catch(e) {}

// Migration to ensure lifetime budgets >= 2,000,000 are properly marked as LIFETIME
try {
  db.exec(`UPDATE ad_config SET budget_type = 'LIFETIME', adset_lifetime_budget = adset_budget, adset_daily_budget = '0' WHERE CAST(adset_budget AS INTEGER) >= 2000000 OR CAST(campaign_budget AS INTEGER) >= 2000000;`);
} catch(e) {}

// Migration to convert MT 26-5 campaigns/adsets to LIFETIME
try {
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
} catch(e) {}

// Migration to add targeting column if it doesn't exist
try {
  db.exec('ALTER TABLE ad_config ADD COLUMN targeting TEXT;');
} catch (e) {
  // Ignore error if column already exists
}

// Prepared statements
const stmts = {
  upsertDailyStat: db.prepare(`
    INSERT INTO ad_daily_stats
      (date, account_name, campaign_id, campaign_name, adset_id, adset_name,
       ad_id, ad_name, spend, impressions, cpm, frequency, clicks, reach, link_clicks,
       ctr, cpc, mess_started, cost_per_mess, leads, cost_per_lead, purchases, cost_per_purchase)
    VALUES
      (@date, @account_name, @campaign_id, @campaign_name, @adset_id, @adset_name,
       @ad_id, @ad_name, @spend, @impressions, @cpm, @frequency, @clicks, @reach, @link_clicks,
       @ctr, @cpc, @mess_started, @cost_per_mess, @leads, @cost_per_lead, @purchases, @cost_per_purchase)
    ON CONFLICT(date, ad_id) DO UPDATE SET
      account_name = excluded.account_name,
      campaign_id = excluded.campaign_id,
      campaign_name = excluded.campaign_name,
      adset_id = excluded.adset_id,
      adset_name = excluded.adset_name,
      ad_name = excluded.ad_name,
      spend = excluded.spend,
      impressions = excluded.impressions,
      cpm = excluded.cpm,
      frequency = excluded.frequency,
      clicks = excluded.clicks,
      reach = excluded.reach,
      link_clicks = excluded.link_clicks,
      ctr = excluded.ctr,
      cpc = excluded.cpc,
      mess_started = excluded.mess_started,
      cost_per_mess = excluded.cost_per_mess,
      leads = excluded.leads,
      cost_per_lead = excluded.cost_per_lead,
      purchases = excluded.purchases,
      cost_per_purchase = excluded.cost_per_purchase
  `),

  upsertAdConfig: (() => {
    const rawStmt = db.prepare(`
    INSERT INTO ad_config
      (ad_id, account_id, campaign_id, campaign_name, campaign_status,
       campaign_start_time, campaign_end_time, campaign_budget, campaign_daily_budget, campaign_lifetime_budget,
       adset_id, adset_name, adset_status, adset_start_time, adset_end_time,
       adset_budget, adset_daily_budget, adset_lifetime_budget, budget_type,
       ad_name, ad_status, created_time, post_url, targeting, updated_at)
    VALUES
      (@ad_id, @account_id, @campaign_id, @campaign_name, @campaign_status,
       @campaign_start_time, COALESCE(@campaign_end_time, ''), @campaign_budget,
       COALESCE(@campaign_daily_budget, '0'), COALESCE(@campaign_lifetime_budget, '0'),
       @adset_id, @adset_name, @adset_status, @adset_start_time, COALESCE(@adset_end_time, ''),
       @adset_budget, COALESCE(@adset_daily_budget, '0'), COALESCE(@adset_lifetime_budget, '0'),
       COALESCE(@budget_type, 'DAILY'),
       @ad_name, @ad_status, @created_time, @post_url, @targeting, datetime('now'))
    ON CONFLICT(ad_id) DO UPDATE SET
      account_id = excluded.account_id,
      campaign_id = excluded.campaign_id,
      campaign_name = excluded.campaign_name,
      campaign_status = excluded.campaign_status,
      campaign_start_time = excluded.campaign_start_time,
      campaign_end_time = excluded.campaign_end_time,
      campaign_budget = excluded.campaign_budget,
      campaign_daily_budget = excluded.campaign_daily_budget,
      campaign_lifetime_budget = excluded.campaign_lifetime_budget,
      adset_id = excluded.adset_id,
      adset_name = excluded.adset_name,
      adset_status = excluded.adset_status,
      adset_start_time = excluded.adset_start_time,
      adset_end_time = excluded.adset_end_time,
      adset_budget = excluded.adset_budget,
      adset_daily_budget = excluded.adset_daily_budget,
      adset_lifetime_budget = excluded.adset_lifetime_budget,
      budget_type = excluded.budget_type,
      ad_name = excluded.ad_name,
      ad_status = excluded.ad_status,
      created_time = COALESCE(NULLIF(excluded.created_time, ''), ad_config.created_time),
      name_updated_at = CASE
        WHEN COALESCE(excluded.campaign_name, '') != COALESCE(ad_config.campaign_name, '')
          OR COALESCE(excluded.adset_name, '') != COALESCE(ad_config.adset_name, '')
          OR COALESCE(excluded.ad_name, '') != COALESCE(ad_config.ad_name, '')
        THEN datetime('now')
        ELSE ad_config.name_updated_at
      END,
      budget_trend = CASE 
        WHEN CAST(excluded.adset_budget AS INTEGER) > CAST(ad_config.adset_budget AS INTEGER) OR CAST(excluded.campaign_budget AS INTEGER) > CAST(ad_config.campaign_budget AS INTEGER) THEN 'UP'
        WHEN (CAST(excluded.adset_budget AS INTEGER) < CAST(ad_config.adset_budget AS INTEGER) AND CAST(excluded.adset_budget AS INTEGER) > 0) OR (CAST(excluded.campaign_budget AS INTEGER) < CAST(ad_config.campaign_budget AS INTEGER) AND CAST(excluded.campaign_budget AS INTEGER) > 0) THEN 'DOWN'
        ELSE ad_config.budget_trend
      END,
      budget_updated_at = CASE
        WHEN excluded.adset_budget != ad_config.adset_budget OR excluded.campaign_budget != ad_config.campaign_budget THEN datetime('now')
        ELSE ad_config.budget_updated_at
      END,
      campaign_budget = excluded.campaign_budget,
      adset_budget = excluded.adset_budget,
      post_url = excluded.post_url,
      targeting = excluded.targeting,
      updated_at = datetime('now')
    `);

    return new Proxy(rawStmt, {
      get(target, prop) {
        if (prop === 'run') {
          return function(row = {}) {
            const rawAsDaily = Number(row.adset_daily_budget || 0);
            const rawAsLifetime = Number(row.adset_lifetime_budget || 0);
            const rawCmpDaily = Number(row.campaign_daily_budget || 0);
            const rawCmpLifetime = Number(row.campaign_lifetime_budget || 0);
            const rawBudget = Number(row.adset_budget || row.campaign_budget || 0);
            const hasEndTime = Boolean((row.adset_end_time && String(row.adset_end_time).trim()) || (row.campaign_end_time && String(row.campaign_end_time).trim()));
            const noDailyBudget = rawAsDaily === 0 && rawCmpDaily === 0;

            const isMtCamp = String(row.adset_name || '').includes('MT 26-5') ||
                             String(row.campaign_name || '').includes('MT 26-5') ||
                             String(row.ad_name || '').includes('MT 26-5');

            const isLifetime = (row.budget_type === 'LIFETIME') ||
              isMtCamp ||
              (rawAsLifetime > 0 && rawAsDaily === 0) ||
              (rawCmpLifetime > 0 && rawCmpDaily === 0) ||
              (rawBudget >= 2000000) ||
              (hasEndTime && noDailyBudget);

            const budgetType = isLifetime ? 'LIFETIME' : (row.budget_type || 'DAILY');
            const adsetDaily = isLifetime ? '0' : (row.adset_daily_budget ?? String(row.adset_budget || '0'));
            const adsetLifetime = isLifetime ? (rawAsLifetime > 0 ? String(rawAsLifetime) : (isMtCamp ? '10000000' : String(row.adset_budget || rawBudget || '0'))) : '0';
            const cmpDaily = isLifetime ? '0' : (row.campaign_daily_budget ?? String(row.campaign_budget || '0'));
            const cmpLifetime = isLifetime ? (rawCmpLifetime > 0 ? String(rawCmpLifetime) : (isMtCamp ? '10000000' : String(row.campaign_budget || rawBudget || '0'))) : '0';

            const normalized = {
              ad_id: row.ad_id,
              account_id: row.account_id,
              campaign_id: row.campaign_id ?? '',
              campaign_name: row.campaign_name ?? '',
              campaign_status: row.campaign_status ?? '',
              campaign_start_time: row.campaign_start_time ?? '',
              campaign_end_time: row.campaign_end_time ?? '',
              campaign_budget: row.campaign_budget ?? '0',
              campaign_daily_budget: String(cmpDaily),
              campaign_lifetime_budget: String(cmpLifetime),
              adset_id: row.adset_id ?? '',
              adset_name: row.adset_name ?? '',
              adset_status: row.adset_status ?? '',
              adset_start_time: row.adset_start_time ?? '',
              adset_end_time: row.adset_end_time ?? '',
              adset_budget: row.adset_budget ?? '0',
              adset_daily_budget: String(adsetDaily),
              adset_lifetime_budget: String(adsetLifetime),
              budget_type: budgetType,
              ad_name: row.ad_name ?? '',
              ad_status: row.ad_status ?? '',
              created_time: row.created_time ?? '',
              post_url: row.post_url ?? null,
              targeting: row.targeting ?? null
            };
            return target.run(normalized);
          };
        }
        const val = target[prop];
        return typeof val === 'function' ? val.bind(target) : val;
      }
    });
  })(),

  upsertAdCreative: db.prepare(`
    INSERT INTO ad_creatives (ad_id, thumbnail_url, video_url, body_text, image_hash, video_id, body_hash, content_updated_at, synced_at)
    VALUES (@ad_id, @thumbnail_url, @video_url, @body_text, @image_hash, @video_id, @body_hash, datetime('now'), datetime('now'))
    ON CONFLICT(ad_id) DO UPDATE SET
      thumbnail_url = excluded.thumbnail_url,
      video_url = excluded.video_url,
      body_text = excluded.body_text,
      image_hash = excluded.image_hash,
      video_id = excluded.video_id,
      body_hash = excluded.body_hash,
      content_updated_at = CASE
        WHEN excluded.body_hash != COALESCE(ad_creatives.body_hash, '') 
          OR excluded.image_hash != COALESCE(ad_creatives.image_hash, '')
          OR excluded.video_id != COALESCE(ad_creatives.video_id, '')
        THEN datetime('now')
        ELSE ad_creatives.content_updated_at
      END,
      synced_at = datetime('now')
  `),

  clearKpiConfig: db.prepare(`DELETE FROM kpi_config`),
  
  insertKpiConfig: db.prepare(`
    INSERT INTO kpi_config (start_date, end_date, service, kpi_spend, kpi_mess)
    VALUES (@start_date, @end_date, @service, CASE WHEN @kpi_spend = '' THEN 0 ELSE @kpi_spend END, CASE WHEN @kpi_mess = '' THEN 0 ELSE @kpi_mess END)
  `),

  getKpis: db.prepare(`SELECT * FROM kpi_config`),

  // Get aggregated performance per ad
  getAdPerformance: db.prepare(`
    SELECT
      c.ad_id,
      c.ad_name,
      c.post_url,
      c.targeting,
      c.ad_status,
      c.created_time,
      c.campaign_id,
      c.campaign_name,
      c.campaign_status,
      c.adset_id,
      c.adset_name,
      c.adset_status,
      c.account_id,
      c.campaign_budget,
      c.adset_budget,
      c.budget_type,
      c.adset_daily_budget,
      c.adset_lifetime_budget,
      c.campaign_daily_budget,
      c.campaign_lifetime_budget,
      c.adset_end_time,
      c.campaign_end_time,
      c.budget_trend,
      c.budget_updated_at,
      COUNT(DISTINCT s.date) as run_days,
      ROUND(SUM(s.spend), 0) as total_spend,
      SUM(s.impressions) as total_impressions,
      SUM(s.clicks) as total_clicks,
      SUM(s.link_clicks) as total_link_clicks,
      SUM(s.mess_started) as total_mess,
      CASE WHEN SUM(s.mess_started) > 0
        THEN ROUND(SUM(s.spend) / SUM(s.mess_started), 0)
        ELSE ROUND(SUM(s.spend), 0)
      END as cost_per_mess,
      CASE WHEN COUNT(DISTINCT s.date) > 0
        THEN ROUND(SUM(s.spend) / COUNT(DISTINCT s.date), 0)
        ELSE 0
      END as avg_spend_per_day,
      CASE WHEN SUM(s.impressions) > 0
        THEN ROUND(SUM(s.spend) / SUM(s.impressions) * 1000, 0)
        ELSE 0
      END as cpm,
      ROUND(AVG(s.frequency), 2) as avg_frequency,
      CASE WHEN SUM(s.impressions) > 0
        THEN ROUND(CAST(SUM(s.clicks) AS REAL) / SUM(s.impressions) * 100, 2)
        ELSE 0
      END as ctr_all,
      CASE WHEN SUM(s.impressions) > 0
        THEN ROUND(CAST(SUM(s.link_clicks) AS REAL) / SUM(s.impressions) * 100, 2)
        ELSE 0
      END as ctr_link,
      MAX(s.date) as last_date
    FROM ad_config c
    LEFT JOIN ad_daily_stats s ON c.ad_id = s.ad_id AND s.date >= date('now', '-30 days')
    WHERE c.ad_status = 'ACTIVE' OR s.ad_id IS NOT NULL
    GROUP BY c.ad_id
    ORDER BY cost_per_mess ASC
  `),

  // Get content-level performance
  getContentPerformance: db.prepare(`
    SELECT
      COALESCE(NULLIF(c.post_url, ''), c.ad_name) as content_id,
      MAX(c.ad_name) as sample_ad_name,
      MAX(c.post_url) as post_url,
      MAX(c.targeting) as targeting,
      COUNT(DISTINCT c.ad_id) as total_ads,
      SUM(CASE WHEN c.ad_status = 'ACTIVE' AND c.adset_status = 'ACTIVE' AND c.campaign_status = 'ACTIVE' THEN 1 ELSE 0 END) as active_ads,
      ROUND(SUM(s.spend), 0) as total_spend,
      SUM(s.impressions) as total_impressions,
      SUM(s.clicks) as total_clicks,
      SUM(s.link_clicks) as total_link_clicks,
      SUM(s.mess_started) as total_mess,
      CASE WHEN SUM(s.mess_started) > 0
        THEN ROUND(SUM(s.spend) / SUM(s.mess_started), 0)
        ELSE ROUND(SUM(s.spend), 0)
      END as cost_per_mess,
      CASE WHEN SUM(s.impressions) > 0
        THEN ROUND(SUM(s.spend) / SUM(s.impressions) * 1000, 0)
        ELSE 0
      END as cpm,
      CASE WHEN SUM(s.impressions) > 0
        THEN ROUND(CAST(SUM(s.clicks) AS REAL) / SUM(s.impressions) * 100, 2)
        ELSE 0
      END as ctr_all,
      GROUP_CONCAT(DISTINCT c.ad_id) as ad_ids
    FROM ad_config c
    JOIN ad_daily_stats s ON c.ad_id = s.ad_id AND s.date >= date('now', '-30 days')
    GROUP BY content_id
    HAVING total_spend > 0
    ORDER BY total_spend DESC
  `),

  getStrategyPerformance: db.prepare(`
    SELECT
      COALESCE(NULLIF(c.post_url, ''), c.ad_name) as content_id,
      MAX(c.ad_name) as sample_ad_name,
      MAX(c.post_url) as post_url,
      MAX(c.targeting) as targeting,
      ROUND(SUM(s.spend), 0) as total_spend,
      SUM(s.impressions) as total_impressions,
      SUM(s.clicks) as total_clicks,
      SUM(s.mess_started) as total_mess,
      CASE WHEN SUM(s.mess_started) > 0
        THEN ROUND(SUM(s.spend) / SUM(s.mess_started), 0)
        ELSE ROUND(SUM(s.spend), 0)
      END as cost_per_mess,
      CASE WHEN SUM(s.impressions) > 0
        THEN ROUND(SUM(s.spend) / SUM(s.impressions) * 1000, 0)
        ELSE 0
      END as cpm,
      CASE WHEN SUM(s.impressions) > 0
        THEN ROUND(CAST(SUM(s.clicks) AS REAL) / SUM(s.impressions) * 100, 2)
        ELSE 0
      END as ctr_all,
      GROUP_CONCAT(DISTINCT c.ad_id) as ad_ids
    FROM ad_config c
    JOIN ad_daily_stats s ON c.ad_id = s.ad_id 
    WHERE s.date >= @start_date AND s.date <= @end_date
      AND (@service = 'ALL' OR LOWER(c.ad_name) LIKE '%' || @service_key || '%')
    GROUP BY content_id
    HAVING total_spend > 0
  `),

  saveAiStrategy: db.prepare(`
    INSERT INTO ai_strategy_history (time_label, service_label, report_content)
    VALUES (@time_label, @service_label, @report_content)
  `),

  getAiStrategyHistory: db.prepare(`
    SELECT id, created_at, time_label, service_label 
    FROM ai_strategy_history 
    ORDER BY id DESC LIMIT 50
  `),

  getAiStrategyById: db.prepare(`
    SELECT * FROM ai_strategy_history WHERE id = ?
  `),

  // Get daily stats for chart
  getDailyStats: db.prepare(`
    SELECT
      s.date,
      s.ad_id,
      c.ad_name,
      s.spend,
      s.impressions,
      s.mess_started,
      CASE WHEN s.mess_started > 0
        THEN ROUND(s.spend / s.mess_started, 0)
        ELSE NULL
      END as cost_per_mess
    FROM ad_daily_stats s
    LEFT JOIN ad_config c ON s.ad_id = c.ad_id
    WHERE s.date >= date('now', :days)
    ORDER BY s.date DESC, s.ad_id
  `),

  getDailyReportWithAvg: db.prepare(`
    WITH avg_stats AS (
      SELECT
        ad_id,
        ROUND(AVG(spend), 0) as avg_spend,
        ROUND(AVG(mess_started), 1) as avg_mess,
        CASE WHEN SUM(mess_started) > 0 THEN ROUND(SUM(spend) / SUM(mess_started), 0) ELSE NULL END as avg_cost_per_mess,
        ROUND(AVG(impressions), 0) as avg_impressions,
        CASE WHEN SUM(impressions) > 0 THEN ROUND(SUM(spend) / SUM(impressions) * 1000, 0) ELSE 0 END as avg_cpm,
        ROUND(AVG(frequency), 2) as avg_frequency,
        ROUND(AVG(clicks), 1) as avg_clicks,
        CASE WHEN SUM(impressions) > 0 THEN ROUND(CAST(SUM(clicks) AS REAL) / SUM(impressions) * 100, 2) ELSE 0 END as avg_ctr
      FROM ad_daily_stats
      GROUP BY ad_id
    )
    SELECT
      s.date,
      s.ad_id,
      c.ad_name,
      c.post_url,
      c.targeting,
      c.campaign_name,
      c.adset_name,
      s.spend as today_spend,
      s.mess_started as today_mess,
      s.cost_per_mess as today_cost_per_mess,
      s.impressions as today_impressions,
      s.cpm as today_cpm,
      s.frequency as today_frequency,
      s.clicks as today_clicks,
      s.ctr as today_ctr,
      a.avg_spend,
      a.avg_mess,
      a.avg_cost_per_mess,
      a.avg_impressions,
      a.avg_cpm,
      a.avg_frequency,
      a.avg_clicks,
      a.avg_ctr,
      c.adset_budget
    FROM ad_daily_stats s
    LEFT JOIN ad_config c ON s.ad_id = c.ad_id
    LEFT JOIN avg_stats a ON s.ad_id = a.ad_id
    WHERE s.date = COALESCE(:target_date, (SELECT MAX(date) FROM ad_daily_stats))
    ORDER BY s.cost_per_mess ASC
  `),

  getMonthlyStats: db.prepare(`
    SELECT
      strftime('%Y-%m', s.date) as month,
      COUNT(DISTINCT c.campaign_id) as total_campaigns,
      COUNT(DISTINCT s.ad_id) as total_ads,
      ROUND(SUM(s.spend), 0) as spend,
      ROUND(SUM(s.spend) * 1.1, 0) as spend_vat,
      SUM(s.impressions) as impressions,
      SUM(s.clicks) as clicks,
      SUM(s.link_clicks) as link_clicks,
      SUM(s.mess_started) as mess_started,
      ROUND(AVG(s.frequency), 2) as avg_frequency,
      CASE WHEN SUM(s.mess_started) > 0
        THEN ROUND(SUM(s.spend) / SUM(s.mess_started), 0)
        ELSE ROUND(SUM(s.spend), 0)
      END as cost_per_mess,
      CASE WHEN SUM(s.impressions) > 0
        THEN ROUND(SUM(s.spend) / SUM(s.impressions) * 1000, 0)
        ELSE 0
      END as cpm,
      CASE WHEN SUM(s.impressions) > 0
        THEN ROUND(CAST(SUM(s.clicks) AS REAL) / SUM(s.impressions) * 100, 2)
        ELSE 0
      END as ctr_all,
      CASE WHEN SUM(s.impressions) > 0
        THEN ROUND(CAST(SUM(s.link_clicks) AS REAL) / SUM(s.impressions) * 100, 2)
        ELSE 0
      END as ctr_link
    FROM ad_daily_stats s
    LEFT JOIN ad_config c ON s.ad_id = c.ad_id
    GROUP BY strftime('%Y-%m', s.date)
    ORDER BY month DESC
  `),

  getSummary: db.prepare(`
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
      WHERE c.ad_status = 'ACTIVE' OR s.ad_id IS NOT NULL
      GROUP BY c.ad_id
    )
    SELECT
      COUNT(*) as total_ads,
      SUM(CASE WHEN run_days < 2 AND is_active = 1 THEN 1 ELSE 0 END) as testing,
      SUM(CASE WHEN run_days >= 2 AND (cost_per_mess > 250000 OR (total_mess = 0 AND total_spend > 250000)) AND is_active = 1 THEN 1 ELSE 0 END) as need_pause,
      SUM(CASE WHEN run_days >= 2 AND cost_per_mess <= 250000 AND is_active = 1 AND NOT (budget_trend = 'UP' AND budget_updated_at >= datetime('now', '-24 hours')) THEN 1 ELSE 0 END) as can_scale,
      SUM(CASE WHEN run_days >= 2 AND cost_per_mess <= 250000 AND is_active = 1 AND (budget_trend = 'UP' AND budget_updated_at >= datetime('now', '-24 hours')) THEN 1 ELSE 0 END) as already_scaled,
      SUM(CASE WHEN run_days >= 2 AND (cost_per_mess > 250000 OR (total_mess = 0 AND total_spend > 250000)) AND is_active = 0 THEN 1 ELSE 0 END) as already_paused,
      (SELECT SUM(spend) FROM ad_daily_stats WHERE date = COALESCE((SELECT MAX(date) FROM ad_daily_stats), date('now'))) as today_spend,
      (SELECT SUM(mess_started) FROM ad_daily_stats WHERE date = COALESCE((SELECT MAX(date) FROM ad_daily_stats), date('now'))) as today_mess,
      (SELECT ROUND(AVG(d_spend),0) FROM (SELECT SUM(spend) as d_spend FROM ad_daily_stats GROUP BY date)) as avg_daily_spend,
      (SELECT SUM(mess_started) FROM ad_daily_stats WHERE strftime('%Y-%m', date) = strftime('%Y-%m', COALESCE((SELECT MAX(date) FROM ad_daily_stats), date('now')))) as month_mess,
      (SELECT SUM(spend)/NULLIF(SUM(mess_started),0) FROM ad_daily_stats) as avg_cost_per_mess,
      (SELECT COUNT(*) FROM ad_config WHERE ad_status = 'ACTIVE' AND adset_status = 'ACTIVE' AND campaign_status = 'ACTIVE') as active_ads,
      (SELECT COUNT(*) FROM ad_config WHERE substr(created_time, 1, 10) = date('now')) as today_created,
      (SELECT COUNT(*) FROM ad_config WHERE substr(created_time, 1, 7) = strftime('%Y-%m', 'now')) as month_created,
      (SELECT COUNT(*) FROM ad_config WHERE budget_trend = 'UP' AND date(budget_updated_at) = date('now')) as today_scaled,
      (SELECT COUNT(*) FROM ad_config WHERE budget_trend = 'UP' AND substr(budget_updated_at, 1, 7) = strftime('%Y-%m', 'now')) as month_scaled,
      (SELECT COUNT(*) FROM ad_config WHERE budget_trend = 'DOWN' AND date(budget_updated_at) = date('now')) as today_down,
      (SELECT COUNT(*) FROM ad_config WHERE budget_trend = 'DOWN' AND substr(budget_updated_at, 1, 7) = strftime('%Y-%m', 'now')) as month_down,
      (SELECT COUNT(*) FROM ad_config WHERE budget_trend = 'PAUSE' AND date(budget_updated_at) = date('now')) as today_paused,
      (SELECT COUNT(*) FROM ad_config WHERE budget_trend = 'PAUSE' AND substr(budget_updated_at, 1, 7) = strftime('%Y-%m', 'now')) as month_paused,
      (SELECT MAX(updated_at) FROM ad_config) as last_sync_time
    FROM agg
  `),

  getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  setSetting: db.prepare(`INSERT INTO settings (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = :value`),

  getWalletData: db.prepare(`
    SELECT 
      COALESCE((SELECT SUM(spend) FROM ad_daily_stats), 0) as all_time_spend_raw,
      COALESCE((SELECT SUM(spend) * 1.1 FROM ad_daily_stats), 0) as all_time_spend_vat,
      COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key = 'total_deposits'), 0) as total_deposits
  `),

  updateDeposit: db.prepare(`
    INSERT INTO settings (key, value) VALUES ('total_deposits', :val)
    ON CONFLICT(key) DO UPDATE SET value = :val
  `),

  upsertAdAiDiagnosis: db.prepare(`
    INSERT INTO ad_ai_diagnoses (ad_id, workspace_id, service, diagnosis_json, snapshot_hash, created_at, updated_at)
    VALUES (@ad_id, @workspace_id, @service, @diagnosis_json, @snapshot_hash, datetime('now'), datetime('now'))
    ON CONFLICT(ad_id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      service = excluded.service,
      diagnosis_json = excluded.diagnosis_json,
      snapshot_hash = excluded.snapshot_hash,
      updated_at = datetime('now')
  `),

  getAdAiDiagnosis: db.prepare(`
    SELECT ad_id, workspace_id, service, diagnosis_json, snapshot_hash, created_at, updated_at
    FROM ad_ai_diagnoses
    WHERE ad_id = ?
  `),

  upsertPageDailyInsight: db.prepare(`
    INSERT INTO page_daily_insights (
      workspace_id, page_id, page_name, date,
      fans_total, fan_adds, fan_removes,
      reach_total, reach_organic, reach_paid,
      impressions_total, impressions_organic, impressions_paid,
      post_engagements, page_views,
      demographics_json, cities_json,
      audience_quality_score, misalignment_pct, created_at
    ) VALUES (
      :workspace_id, :page_id, :page_name, :date,
      :fans_total, :fan_adds, :fan_removes,
      :reach_total, :reach_organic, :reach_paid,
      :impressions_total, :impressions_organic, :impressions_paid,
      :post_engagements, :page_views,
      :demographics_json, :cities_json,
      :audience_quality_score, :misalignment_pct, datetime('now')
    )
    ON CONFLICT(page_id, date) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      page_name = excluded.page_name,
      fans_total = excluded.fans_total,
      fan_adds = excluded.fan_adds,
      fan_removes = excluded.fan_removes,
      reach_total = excluded.reach_total,
      reach_organic = excluded.reach_organic,
      reach_paid = excluded.reach_paid,
      impressions_total = excluded.impressions_total,
      impressions_organic = excluded.impressions_organic,
      impressions_paid = excluded.impressions_paid,
      post_engagements = excluded.post_engagements,
      page_views = excluded.page_views,
      demographics_json = excluded.demographics_json,
      cities_json = excluded.cities_json,
      audience_quality_score = excluded.audience_quality_score,
      misalignment_pct = excluded.misalignment_pct,
      created_at = datetime('now')
  `),

  getPageInsights: db.prepare(`
    SELECT * FROM page_daily_insights
    WHERE page_id = ? AND date >= ? AND date <= ?
    ORDER BY date ASC
  `),

  getLatestPageInsight: db.prepare(`
    SELECT * FROM page_daily_insights
    WHERE page_id = ?
    ORDER BY date DESC LIMIT 1
  `)
};

// Bulk insert helpers
const insertManyStats = db.transaction((rows) => {
  for (const row of rows) stmts.upsertDailyStat.run(row);
});

const insertManyConfig = db.transaction((rows) => {
  for (const row of rows) stmts.upsertAdConfig.run(row);
});

const insertManyPageInsights = db.transaction((rows) => {
  for (const row of rows) stmts.upsertPageDailyInsight.run(row);
});

function insertAdCreative(row) {
  return stmts.upsertAdCreative.run(row);
}

function insertAdAiDiagnosis(row) {
  return stmts.upsertAdAiDiagnosis.run({
    ad_id: String(row.ad_id),
    workspace_id: Number(row.workspace_id || 1),
    service: row.service || null,
    diagnosis_json: typeof row.diagnosis_json === 'string' ? row.diagnosis_json : JSON.stringify(row.diagnosis_json),
    snapshot_hash: row.snapshot_hash || null
  });
}

function getAdAiDiagnosisRecord(adId) {
  return stmts.getAdAiDiagnosis.get(String(adId));
}

// Seed initial page insights if needed
try {
  const { seedPageInsightsIfNeeded } = require('../services/facebookPageAnalytics');
  seedPageInsightsIfNeeded(db);
} catch (e) {
  // Graceful initialization
}

module.exports = {
  db,
  stmts,
  insertManyStats,
  insertManyConfig,
  insertManyPageInsights,
  insertAdCreative,
  insertAdAiDiagnosis,
  getAdAiDiagnosisRecord,
};
