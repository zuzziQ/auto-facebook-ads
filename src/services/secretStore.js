const fs = require('fs');
const path = require('path');
const os = require('os');

const SECRET_KEYS = new Set([
  'GEMINI_API_KEY', 'FB_ADS_ACCESS_TOKEN', 'FACEBOOK_PAGE_TOKENS',
  'FACEBOOK_APP_SECRET', 'WORDPRESS_APP_PASSWORD',
  'DASHBOARD_AUTH_USER', 'DASHBOARD_AUTH_PASSWORD'
]);
const secretDir = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'Nexus AI')
  : path.join(os.homedir(), '.local', 'share', 'nexus-ai');
const secretPath = path.join(secretDir, 'secrets.env');

function parse(content = '') {
  const out = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function ensureStore() {
  fs.mkdirSync(secretDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(secretDir, 0o700); } catch (_) {}
  if (!fs.existsSync(secretPath)) fs.writeFileSync(secretPath, '', { mode: 0o600 });
  try { fs.chmodSync(secretPath, 0o600); } catch (_) {}
}

function loadSecrets() {
  ensureStore();
  return parse(fs.readFileSync(secretPath, 'utf8'));
}

function saveSecrets(values) {
  ensureStore();
  const current = loadSecrets();
  for (const [key, value] of Object.entries(values || {})) {
    if ((SECRET_KEYS.has(key) || /^WORKSPACE_\d+_(ADS|PAGE_[A-Za-z0-9]+)_TOKEN$/.test(key)) && value) current[key] = String(value).replace(/[\r\n]/g, '');
  }
  const content = Object.entries(current).filter(([,v]) => v !== '').map(([k,v]) => `${k}=${v}`).join('\n');
  const tmp = `${secretPath}.tmp`;
  fs.writeFileSync(tmp, content ? `${content}\n` : '', { mode: 0o600 });
  fs.renameSync(tmp, secretPath);
  fs.chmodSync(secretPath, 0o600);
}

function migrateFromProjectEnv(envPath) {
  ensureStore();
  if (!fs.existsSync(envPath)) return false;
  const content = fs.readFileSync(envPath, 'utf8');
  const parsed = parse(content);
  const found = Object.fromEntries(Object.entries(parsed).filter(([key, value]) => SECRET_KEYS.has(key) && value));
  if (!Object.keys(found).length) return false;
  saveSecrets(found);
  const cleaned = content.split(/\r?\n/).filter(line => {
    const match = line.match(/^([^#=\s]+)\s*=/);
    return !match || !SECRET_KEYS.has(match[1]);
  }).join('\n').replace(/\n+$/, '') + '\n';
  const backupPath = path.join(secretDir, 'project.env.before-secret-migration');
  if (!fs.existsSync(backupPath)) fs.copyFileSync(envPath, backupPath);
  fs.writeFileSync(envPath, cleaned, { mode: 0o600 });
  return true;
}

module.exports = { SECRET_KEYS, secretDir, secretPath, loadSecrets, saveSecrets, migrateFromProjectEnv };
