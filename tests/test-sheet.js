const { google } = require('googleapis');
const path = require('path');

const credPath = path.resolve('./mkt-data-436605-eb606f873884.json');
const auth = new google.auth.GoogleAuth({
  keyFile: credPath,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

async function checkSheet() {
  try {
    const response = await sheets.spreadsheets.get({
      spreadsheetId: '1ew5HWMyURPORuxbMgU5fAoMKlsW_b-c6zxhqaUir6ZI',
    });
    console.log("Sheet names:");
    response.data.sheets.forEach(s => console.log(s.properties.title));
    
    // get first sheet data
    const title = response.data.sheets[0].properties.title;
    const dataResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: '1ew5HWMyURPORuxbMgU5fAoMKlsW_b-c6zxhqaUir6ZI',
      range: `${title}!A1:Z5`,
    });
    console.log("First sheet headers:", dataResponse.data.values);
  } catch (e) {
    console.error("Error:", e.message);
  }
}
checkSheet();
