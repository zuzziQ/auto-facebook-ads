const db = require('better-sqlite3')('data/ads.db');
db.prepare("UPDATE ad_config SET budget_trend = 'PAUSE', budget_updated_at = datetime('now') WHERE ad_id = '120238480811360269'").run();
console.log("Updated!");
