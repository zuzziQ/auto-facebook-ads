const db = require('better-sqlite3')('data/ads.db', { readonly: true });
console.log(db.prepare("SELECT ad_id, ad_name, ad_status, budget_trend, budget_updated_at FROM ad_config WHERE ad_id = '120238480811360269' OR ad_name LIKE '%0004%' LIMIT 10").all());
