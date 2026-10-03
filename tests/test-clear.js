const { google } = require('googleapis');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

async function clearSheet() {
  try {
    const credPath = path.resolve(process.env.GOOGLE_CREDENTIALS_PATH || './mkt-data-436605-eb606f873884.json');
    const auth = new google.auth.GoogleAuth({
      keyFile: credPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    
    // Clear the whole sheet
    await sheets.spreadsheets.values.clear({
      spreadsheetId: process.env.GOOGLE_SHEETS_ADS_SPREADSHEET_ID,
      range: 'bao-cao-ad-daily',
    });
    console.log("Cleared Sheet bao-cao-ad-daily completely!");
  } catch (error) {
    console.error("Error clearing sheet:", error.message);
  }
}

clearSheet();
