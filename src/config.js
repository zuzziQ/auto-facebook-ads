const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { loadSecrets } = require('./services/secretStore');
const localSecrets = loadSecrets();
for (const [key, value] of Object.entries(localSecrets)) {
  if (value) process.env[key] = value;
}

const config = {
  // Server
  port: parseInt(process.env.PORT) || 3000,
  dryRun: process.env.DRY_RUN === 'true',
  auth: {
    user: localSecrets.DASHBOARD_AUTH_USER || process.env.DASHBOARD_AUTH_USER || '',
    password: localSecrets.DASHBOARD_AUTH_PASSWORD || process.env.DASHBOARD_AUTH_PASSWORD || '',
  },

  // Gemini AI
  gemini: {
    apiKey: localSecrets.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '',
  },

  // Facebook
  facebook: {
    pageIds: (process.env.FACEBOOK_PAGE_IDS || '').split(',').filter(Boolean),
    pageTokens: (localSecrets.FACEBOOK_PAGE_TOKENS || process.env.FACEBOOK_PAGE_TOKENS || '').split(',').filter(Boolean),
    pageNames: (process.env.FACEBOOK_PAGE_NAMES || '').split(',').filter(Boolean),
    adAccountIds: (process.env.FB_AD_ACCOUNT_IDS || '').split(',').filter(Boolean),
    adsAccessToken: localSecrets.FB_ADS_ACCESS_TOKEN || process.env.FB_ADS_ACCESS_TOKEN || '',
    apiVersion: process.env.FACEBOOK_API_VERSION || 'v23.0',
    get pages() {
      return this.pageIds.map((id, i) => ({
        id,
        token: this.pageTokens[i] || '',
        name: this.pageNames[i] || `Page ${id}`,
      }));
    },
  },

  // WordPress
  wordpress: {
    url: process.env.WORDPRESS_URL || '',
    username: process.env.WORDPRESS_USERNAME || '',
    appPassword: localSecrets.WORDPRESS_APP_PASSWORD || process.env.WORDPRESS_APP_PASSWORD || '',
    get authHeader() {
      const encoded = Buffer.from(`${this.username}:${this.appPassword}`).toString('base64');
      return `Basic ${encoded}`;
    },
  },

  // Google Drive
  googleDrive: {
    credentialsPath: process.env.GOOGLE_CREDENTIALS_PATH || './google-credentials.json',
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
  },

  // Google Sheets
  googleSheets: {
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '',
    sheetName: process.env.GOOGLE_SHEETS_SHEET_NAME || 'master',
  },
};

function validateConfig(platforms = []) {
  const errors = [];

  if (platforms.includes('facebook')) {
    if (config.facebook.pageIds.length === 0) errors.push('FACEBOOK_PAGE_IDS is required');
    if (config.facebook.pageTokens.length === 0) errors.push('FACEBOOK_PAGE_TOKENS is required');
    if (config.facebook.pageIds.length !== config.facebook.pageTokens.length) {
      errors.push('FACEBOOK_PAGE_IDS and FACEBOOK_PAGE_TOKENS must have the same number of entries');
    }
  }

  if (platforms.includes('wordpress')) {
    if (!config.wordpress.url) errors.push('WORDPRESS_URL is required');
    if (!config.wordpress.username) errors.push('WORDPRESS_USERNAME is required');
    if (!config.wordpress.appPassword) errors.push('WORDPRESS_APP_PASSWORD is required');
  }

  if (platforms.includes('drive')) {
    if (!config.googleDrive.folderId) errors.push('GOOGLE_DRIVE_FOLDER_ID is required');
  }

  if (platforms.includes('sheets')) {
    if (!config.googleSheets.spreadsheetId) errors.push('GOOGLE_SHEETS_SPREADSHEET_ID is required');
  }

  if (platforms.includes('review')) {
    if (!config.gemini.apiKey) errors.push('GEMINI_API_KEY is required for AI review');
  }

  return errors;
}

/**
 * Reload config values from .env file (called after settings are saved).
 */
function reloadFromDisk() {
  const dotenv = require('dotenv');
  const envPath = path.join(__dirname, '..', '.env');
  const parsed = dotenv.config({ path: envPath, override: true }).parsed || {};
  const secrets = loadSecrets();

  config.gemini.apiKey = secrets.GEMINI_API_KEY || parsed.GEMINI_API_KEY || '';
  config.facebook.pageIds = (parsed.FACEBOOK_PAGE_IDS || '').split(',').filter(Boolean);
  config.facebook.pageTokens = (secrets.FACEBOOK_PAGE_TOKENS || parsed.FACEBOOK_PAGE_TOKENS || '').split(',').filter(Boolean);
  config.facebook.pageNames = (parsed.FACEBOOK_PAGE_NAMES || '').split(',').filter(Boolean);
  config.facebook.adAccountIds = (parsed.FB_AD_ACCOUNT_IDS || '').split(',').filter(Boolean);
  config.facebook.adsAccessToken = secrets.FB_ADS_ACCESS_TOKEN || parsed.FB_ADS_ACCESS_TOKEN || '';
  config.facebook.apiVersion = parsed.FACEBOOK_API_VERSION || 'v23.0';
  config.wordpress.url = parsed.WORDPRESS_URL || '';
  config.wordpress.username = parsed.WORDPRESS_USERNAME || '';
  config.wordpress.appPassword = secrets.WORDPRESS_APP_PASSWORD || parsed.WORDPRESS_APP_PASSWORD || '';
  config.googleDrive.folderId = parsed.GOOGLE_DRIVE_FOLDER_ID || '';
  config.googleSheets.spreadsheetId = parsed.GOOGLE_SHEETS_SPREADSHEET_ID || '';
  config.googleSheets.sheetName = parsed.GOOGLE_SHEETS_SHEET_NAME || 'master';
}

module.exports = { config, validateConfig, reloadFromDisk };
