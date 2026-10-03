const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const ACCESS_TOKEN = process.env.FB_ADS_ACCESS_TOKEN;
const AD_ACCOUNT_IDS = (process.env.FB_AD_ACCOUNT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const VERSIONS = ['v19.0', 'v20.0', 'v21.0'];

async function testBilling(accountId, version) {
  const base = `https://graph.facebook.com/${version}/${accountId}`;
  
  const endpoints = [
    { name: 'Payment Cycles',    url: `${base}/adspaymentcycles`,        params: { fields: 'ads_currency,threshold_amount,total_amount', limit: 3 } },
    { name: 'Billing Tx',        url: `${base}/billing_transactions`,     params: { fields: 'amount,currency,time,type', limit: 3 } },
    { name: 'Billing History',   url: `${base}/adaccountbillinghistory`,  params: { fields: 'id,billed_amount_details,bill_from,bill_to,payment_term', limit: 3 } },
  ];

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`📊 Account: ${accountId}  API: ${version}`);
  console.log(`${'─'.repeat(55)}`);

  for (const ep of endpoints) {
    try {
      const res = await axios.get(ep.url, { params: { ...ep.params, access_token: ACCESS_TOKEN } });
      const data = res.data.data || [];
      console.log(`✅ [${ep.name}] OK — ${data.length} record(s)`);
      if (data.length > 0) console.log(`   Sample:`, JSON.stringify(data[0], null, 2).split('\n').slice(0,10).join('\n'));
    } catch (err) {
      const e = err?.response?.data?.error || {};
      console.log(`❌ [${ep.name}] FAILED (${e.code}): ${e.message || err.message}`);
    }
  }
}

(async () => {
  const testId = AD_ACCOUNT_IDS[0];
  for (const v of VERSIONS) {
    await testBilling(testId, v);
  }
  console.log('\n✔ Done.');
})();
