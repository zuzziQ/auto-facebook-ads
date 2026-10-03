/**
 * Facebook Token Exchange Helper
 * Gets a NEVER-EXPIRING Page Access Token from a short-lived User Token.
 *
 * Usage:
 *   node get-fb-token.js <SHORT_LIVED_USER_TOKEN> <APP_ID> <APP_SECRET>
 *
 * Example:
 *   node get-fb-token.js EAAVZBl... 123456789 abcdef1234567890
 */

const axios = require('axios');
require('dotenv').config();

// Read from args OR from .env
const shortToken = process.argv[2] || process.env.FACEBOOK_PAGE_TOKENS?.split(',')[0]?.trim();
const appId     = process.argv[3] || process.env.FACEBOOK_APP_ID;
const appSecret = process.argv[4] || process.env.FACEBOOK_APP_SECRET;

if (!shortToken || !appId || !appSecret) {
  console.log('\nUsage: node get-fb-token.js <SHORT_TOKEN> <APP_ID> <APP_SECRET>\n');
  console.log('Get SHORT_TOKEN from: https://developers.facebook.com/tools/explorer/');
  console.log('Get APP_ID and APP_SECRET from: https://developers.facebook.com → Your App → Settings → Basic\n');
  process.exit(1);
}

const API = 'https://graph.facebook.com/v23.0';

async function main() {
  // Step 1: Exchange short-lived → long-lived user token (60 days)
  console.log('\n📡 Step 1: Exchanging for long-lived user token...');
  const exchangeRes = await axios.get(`${API}/oauth/access_token`, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortToken,
    },
  });

  const longLivedToken = exchangeRes.data.access_token;
  const expiresIn = exchangeRes.data.expires_in;
  console.log(`✅ Got long-lived user token (expires in ${Math.round(expiresIn / 86400)} days)`);

  // Step 2: Get permanent Page Access Tokens from /me/accounts
  console.log('\n📡 Step 2: Fetching Page Access Tokens (never expire)...');
  const accountsRes = await axios.get(`${API}/me/accounts`, {
    params: { access_token: longLivedToken, fields: 'id,name,access_token' },
  });

  const pages = accountsRes.data.data;
  if (!pages || pages.length === 0) {
    console.log('❌ No pages found. Make sure your app has pages_manage_posts permission.');
    return;
  }

  console.log('\n✅ PERMANENT PAGE TOKENS (copy these into Settings):');
  console.log('='.repeat(70));
  pages.forEach((page, i) => {
    console.log(`\nPage ${i + 1}: ${page.name}`);
    console.log(`  Page ID:    ${page.id}`);
    console.log(`  Page Token: ${page.access_token}`);
    console.log(`  (This token NEVER expires)`);
  });
  console.log('\n' + '='.repeat(70));
  console.log('\n📋 For your .env / Settings:');
  console.log(`FACEBOOK_PAGE_IDS=${pages.map(p => p.id).join(',')}`);
  console.log(`FACEBOOK_PAGE_TOKENS=${pages.map(p => p.access_token).join(',')}`);
  console.log(`FACEBOOK_PAGE_NAMES=${pages.map(p => p.name).join(',')}\n`);
}

main().catch(err => {
  const msg = err?.response?.data?.error?.message || err.message;
  console.error('\n❌ Error:', msg, '\n');
});
