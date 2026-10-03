const path = require('path');
const { google } = require('googleapis');
const { config } = require('../config');
const logger = require('../utils/logger');
const Database = require('better-sqlite3');

// Spreadsheet ID requested by the user
const AUDIT_SPREADSHEET_ID = '17ubgPa3xjOG5W_vwfcimezZu0WIFrIRI016Z5QFcCGs';

// Initialize SQLite DB
const dbPath = path.join(__dirname, '..', '..', 'data', 'audit.db');
const db = new Database(dbPath);

// Create table if not exists (Enterprise Audit schema)
db.exec(`
  CREATE TABLE IF NOT EXISTS computers (
    machineId TEXT PRIMARY KEY,
    hostname TEXT,
    mainboard TEXT,
    osVersion TEXT,
    cpu TEXT,
    ram TEXT,
    disk TEXT,
    storageConfig TEXT,
    ipAddress TEXT,
    macAddress TEXT,
    licenseKey TEXT,
    licenseStatus TEXT,
    officeVersion TEXT,
    officeCrack TEXT,
    tpmEnabled TEXT,
    crackDetected TEXT,
    crackReason TEXT,
    score INTEGER,
    tier TEXT,
    windowsPlan TEXT,
    m365Plan TEXT,
    lastSeen TEXT
  )
`);

// Try to auto-migrate old table by adding missing columns if they don't exist
try { db.exec("ALTER TABLE computers ADD COLUMN mainboard TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE computers ADD COLUMN storageConfig TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE computers ADD COLUMN officeVersion TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE computers ADD COLUMN officeCrack TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE computers ADD COLUMN tpmEnabled TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE computers ADD COLUMN crackDetected TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE computers ADD COLUMN crackReason TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE computers ADD COLUMN score INTEGER;"); } catch (e) {}
try { db.exec("ALTER TABLE computers ADD COLUMN tier TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE computers ADD COLUMN windowsPlan TEXT;"); } catch (e) {}
try { db.exec("ALTER TABLE computers ADD COLUMN m365Plan TEXT;"); } catch (e) {}

function getSheetsClient() {
  const credPath = path.resolve(config.googleDrive.credentialsPath);
  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function saveAuditData(data) {
  const now = new Date().toLocaleString('vi-VN');
  
  // 1. Save to SQLite Local DB
  try {
    const stmt = db.prepare(`
      INSERT INTO computers (
        machineId, hostname, mainboard, osVersion, cpu, ram, disk, storageConfig, ipAddress, macAddress, licenseKey, licenseStatus, 
        officeVersion, officeCrack, tpmEnabled, crackDetected, crackReason, score, tier, windowsPlan, m365Plan, lastSeen
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(machineId) DO UPDATE SET
        hostname=excluded.hostname,
        mainboard=excluded.mainboard,
        osVersion=excluded.osVersion,
        cpu=excluded.cpu,
        ram=excluded.ram,
        disk=excluded.disk,
        storageConfig=excluded.storageConfig,
        ipAddress=excluded.ipAddress,
        macAddress=excluded.macAddress,
        licenseKey=excluded.licenseKey,
        licenseStatus=excluded.licenseStatus,
        officeVersion=excluded.officeVersion,
        officeCrack=excluded.officeCrack,
        tpmEnabled=excluded.tpmEnabled,
        crackDetected=excluded.crackDetected,
        crackReason=excluded.crackReason,
        score=excluded.score,
        tier=excluded.tier,
        windowsPlan=excluded.windowsPlan,
        m365Plan=excluded.m365Plan,
        lastSeen=excluded.lastSeen
    `);
    
    stmt.run(
      data.machineId || data.hostname || 'Unknown',
      data.hostname || 'Unknown',
      data.mainboard || '',
      data.osVersion || '',
      data.cpu || '',
      data.ram || '',
      data.disk || '',
      data.storageConfig || '',
      data.ipAddress || '',
      data.macAddress || '',
      data.licenseKey || '',
      data.licenseStatus || '',
      data.officeVersion || '',
      data.officeCrack || '',
      data.tpmEnabled || 'Unknown',
      data.crackDetected ? 'YES' : 'NO',
      data.crackReason || '',
      data.score || 0,
      data.tier || '',
      data.windowsPlan || '',
      data.m365Plan || '',
      now
    );
  } catch (err) {
    logger.error('Audit: Failed to save to local DB', { error: err.message });
    throw new Error('Local DB error: ' + err.message);
  }

  // 2. Append to Google Sheets
  try {
    const sheets = getSheetsClient();
    const sheetName = 'Audit'; // Assumes a sheet named "Audit" exists

    const row = [
      now,
      data.hostname || '',
      data.mainboard || '',
      data.osVersion || '',
      data.cpu || '',
      data.ram || '',
      data.storageConfig || data.disk || '',
      data.ipAddress || '',
      data.macAddress || '',
      data.licenseKey || '',
      data.licenseStatus || '',
      data.officeVersion || '',
      data.officeCrack || '',
      data.crackDetected ? 'CRACKED' : 'CLEAN',
      data.crackReason || '',
      data.tpmEnabled || 'Unknown',
      data.score || 0,
      data.tier || '',
      data.windowsPlan || '',
      data.m365Plan || ''
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: AUDIT_SPREADSHEET_ID,
      range: `${sheetName}!A:T`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [row],
      },
    });

    logger.info('Google Sheets: Audit row appended', { hostname: data.hostname });
  } catch (err) {
    logger.error('Google Sheets: Failed to append audit row', { error: err.message });
    // Not throwing here so the local DB save still counts as a partial success, but we can return warning.
    return { success: true, warning: 'Saved to DB but failed to sync to Google Sheets: ' + err.message };
  }
  
  return { success: true };
}

function getAllComputers() {
  const stmt = db.prepare(`SELECT * FROM computers ORDER BY lastSeen DESC`);
  return stmt.all();
}

module.exports = { saveAuditData, getAllComputers };
