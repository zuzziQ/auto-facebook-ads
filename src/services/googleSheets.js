const path = require('path');
const { google } = require('googleapis');
const { config } = require('../config');
const logger = require('../utils/logger');

/**
 * Get authenticated Google Sheets client
 */
function getSheetsClient() {
  const credPath = path.resolve(config.googleDrive.credentialsPath);
  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });

  return google.sheets({ version: 'v4', auth });
}

/**
 * Append a row to the master spreadsheet
 * Columns: STT | Kênh | Ngày | Giờ | Pillar | Angle | Định dạng | Pic | Content Link | Design Link | Media Link | Trạng thái | Link nghiệm thu
 */
async function appendRow({
  channel = 'Fanpage Phòng khám',
  date,
  time,
  pillar = '',
  angle = '',
  format = '',
  pic = '',
  contentLink = '',
  designLink = '',
  mediaLink = '',
  status = '',
  reviewLink = '',
}) {
  if (config.dryRun) {
    logger.info('[DRY RUN] Google Sheets: Would append row', { pillar, angle, status });
    return {
      platform: 'google_sheets',
      success: true,
      dryRun: true,
    };
  }

  try {
    const sheets = getSheetsClient();
    const sheetName = config.googleSheets.sheetName;

    // First, find the next empty row (after headers and week labels)
    const getResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: config.googleSheets.spreadsheetId,
      range: `${sheetName}!A:A`,
    });

    const existingRows = getResponse.data.values || [];
    // Find the next row number (1-indexed)
    let nextRow = existingRows.length + 1;

    // Calculate STT by counting non-empty, non-header, non-week-label rows
    let stt = 0;
    for (const row of existingRows) {
      const val = (row[0] || '').toString().trim();
      if (val && !isNaN(val)) {
        stt = Math.max(stt, parseInt(val));
      }
    }
    stt += 1;

    const row = [
      stt,                    // A: STT
      channel,                // B: Kênh
      date || '',             // C: Ngày
      time || '',             // D: Giờ
      pillar,                 // E: Pillar
      angle,                  // F: Angle
      format,                 // G: Định dạng
      pic,                    // H: Pic (người viết bài)
      contentLink,            // I: Content Link
      designLink,             // J: Design Link
      mediaLink,              // K: Media Link
      status,                 // L: Trạng thái
      reviewLink,             // M: Link nghiệm thu
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: config.googleSheets.spreadsheetId,
      range: `${sheetName}!A:M`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [row],
      },
    });

    logger.info('Google Sheets: Row appended', { stt, pillar, angle, status });

    return {
      platform: 'google_sheets',
      success: true,
      stt,
      row: nextRow,
    };
  } catch (err) {
    logger.error('Google Sheets: Failed to append row', { error: err.message });

    return {
      platform: 'google_sheets',
      success: false,
      error: err.message,
    };
  }
}

module.exports = { appendRow };
