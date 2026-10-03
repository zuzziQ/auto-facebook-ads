/**
 * Diagnostic test — run with: node test-connections.js
 * Tests: Google Drive folder access, Facebook token validity
 */
require('dotenv').config();
const { google } = require('googleapis');
const axios = require('axios');
const path = require('path');

const CREDS = process.env.GOOGLE_CREDENTIALS_PATH;
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const FB_PAGE_IDS = (process.env.FACEBOOK_PAGE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const FB_TOKENS = (process.env.FACEBOOK_PAGE_TOKENS || '').split(',').map(s => s.trim()).filter(Boolean);
const FB_API = process.env.FACEBOOK_API_VERSION || 'v23.0';

async function testDrive() {
  console.log('\n=== Google Drive ===');
  console.log('Folder ID:', FOLDER_ID);
  console.log('Credentials:', CREDS);

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: path.resolve(CREDS),
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    const drive = google.drive({ version: 'v3', auth });

    // Try to get the folder metadata
    const res = await drive.files.get({
      fileId: FOLDER_ID,
      fields: 'id, name, mimeType',
      supportsAllDrives: true,
    });
    console.log('✅ Drive folder found:', res.data);
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err.message;
    console.error('❌ Drive error:', msg);
    if (msg.includes('File not found')) {
      console.log('   → The service account does NOT have access to this folder.');
      console.log('   → Fix: Share the Google Drive folder with your service account email and give it Editor access.');
    }
  }
}

async function testFacebook() {
  console.log('\n=== Facebook ===');
  for (let i = 0; i < FB_PAGE_IDS.length; i++) {
    const pageId = FB_PAGE_IDS[i];
    const token = FB_TOKENS[i];
    console.log(`\nPage ID: ${pageId}`);
    console.log('Token (first 30 chars):', token ? token.substring(0, 30) + '...' : 'MISSING');
    try {
      const res = await axios.get(
        `https://graph.facebook.com/${FB_API}/${pageId}?fields=id,name&access_token=${token}`,
        { timeout: 8000 }
      );
      console.log('✅ Facebook page accessible:', res.data.name, `(ID: ${res.data.id})`);
    } catch (err) {
      const msg = err?.response?.data?.error?.message || err.message;
      console.error('❌ Facebook error:', msg);
      if (msg.includes('expired') || msg.includes('Session')) {
        console.log('   → Token is EXPIRED. Get a new Page Access Token from Graph API Explorer.');
        console.log('   → Go to: https://developers.facebook.com/tools/explorer/');
        console.log('   → Run GET /me/accounts → copy the access_token for page', pageId);
      }
    }
  }
}

(async () => {
  await testDrive();
  await testFacebook();
  console.log('\n=== Done ===\n');
})();
