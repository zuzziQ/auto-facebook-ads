const { google } = require('googleapis');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

async function createConfigSheet() {
  try {
    const credPath = path.resolve(process.env.GOOGLE_CREDENTIALS_PATH || './mkt-data-436605-eb606f873884.json');
    const auth = new google.auth.GoogleAuth({
      keyFile: credPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEETS_ADS_SPREADSHEET_ID,
      requestBody: {
        requests: [{
          addSheet: {
            properties: {
              title: "bao-cao-ad-config"
            }
          }
        }]
      }
    });

    await sheets.spreadsheets.values.clear({
      spreadsheetId: process.env.GOOGLE_SHEETS_ADS_SPREADSHEET_ID,
      range: 'bao-cao-ad-daily',
    });

    console.log("Created config sheet and cleared daily sheet");
  } catch (error) {
    if (error.message.includes("already exists")) {
       console.log("Config sheet already exists, just clearing daily sheet");
       const sheets = google.sheets({ version: 'v4', auth: new google.auth.GoogleAuth({
          keyFile: credPath, scopes: ['https://www.googleapis.com/auth/spreadsheets'],
       })});
       await sheets.spreadsheets.values.clear({
         spreadsheetId: process.env.GOOGLE_SHEETS_ADS_SPREADSHEET_ID,
         range: 'bao-cao-ad-daily',
       });
    } else {
       console.error("Error:", error.message);
    }
  }
}

createConfigSheet();
