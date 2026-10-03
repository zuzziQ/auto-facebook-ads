const { google } = require('googleapis');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ADS_SPREADSHEET_ID;
const NEW_SHEET_NAME = 'Content-Analytics';

async function createSheet2() {
  try {
    const credPath = path.resolve(process.env.GOOGLE_CREDENTIALS_PATH || './mkt-data-436605-eb606f873884.json');
    const auth = new google.auth.GoogleAuth({
      keyFile: credPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    
    // Attempt to add 'Content-Analytics'
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{
            addSheet: { properties: { title: NEW_SHEET_NAME } }
          }]
        }
      });
      console.log("Created Content-Analytics tab.");
    } catch (e) {
      if (e.message.includes("already exists")) {
        console.log("Tab already exists, proceeding to clear and write.");
      } else {
        throw e;
      }
    }

    // Clear it
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `${NEW_SHEET_NAME}`,
    });

    const headers = [
      'Ad ID', 'Tên Ad', 'Created Time Ad', 'Status Ad', 'Tên Campaign', 'Tên Adset', // A - F
      'Tổng Chi phí (Spend)',  // G
      'Tổng Impressions',      // H
      'Tổng Clicks (All)',     // I
      'Tổng Link Clicks',      // J
      'Tổng Mess Started',     // K
      'CPM',                   // L
      'CTR (All Clicks)',      // M
      'CTR (Link Clicks)',     // N
      'CPC (All Clicks)',      // O
      'CPC (Link Clicks)',     // P
      'Cost per Mess',         // Q
      'Thời gian chạy (Ngày)', // R
      'Chi phí TB / Ngày',     // S
      'Gợi ý Tối ưu'           // T
    ];

    const formulas = [
      `=UNIQUE(FILTER('bao-cao-ad-config'!L2:L; 'bao-cao-ad-config'!L2:L<>""))`,           // A
      `=ARRAYFORMULA(IF(ISBLANK(A2:A); ""; XLOOKUP(A2:A; 'bao-cao-ad-config'!L2:L; 'bao-cao-ad-config'!M2:M; "")))`, // B
      `=ARRAYFORMULA(IF(ISBLANK(A2:A); ""; XLOOKUP(A2:A; 'bao-cao-ad-config'!L2:L; 'bao-cao-ad-config'!O2:O; "")))`, // C
      `=ARRAYFORMULA(IF(ISBLANK(A2:A); ""; XLOOKUP(A2:A; 'bao-cao-ad-config'!L2:L; 'bao-cao-ad-config'!N2:N; "")))`, // D: Status
      `=ARRAYFORMULA(IF(ISBLANK(A2:A); ""; XLOOKUP(A2:A; 'bao-cao-ad-config'!L2:L; 'bao-cao-ad-config'!C2:C; "")))`, // E
      `=ARRAYFORMULA(IF(ISBLANK(A2:A); ""; XLOOKUP(A2:A; 'bao-cao-ad-config'!L2:L; 'bao-cao-ad-config'!H2:H; "")))`, // F
      `=ARRAYFORMULA(IF(ISBLANK(A2:A); ""; SUMIF('bao-cao-ad-daily'!G2:G; A2:A; 'bao-cao-ad-daily'!I2:I)))`, // G
      `=ARRAYFORMULA(IF(ISBLANK(A2:A); ""; SUMIF('bao-cao-ad-daily'!G2:G; A2:A; 'bao-cao-ad-daily'!J2:J)))`, // H
      `=ARRAYFORMULA(IF(ISBLANK(A2:A); ""; SUMIF('bao-cao-ad-daily'!G2:G; A2:A; 'bao-cao-ad-daily'!M2:M)))`, // I
      `=ARRAYFORMULA(IF(ISBLANK(A2:A); ""; SUMIF('bao-cao-ad-daily'!G2:G; A2:A; 'bao-cao-ad-daily'!N2:N)))`, // J
      `=ARRAYFORMULA(IF(ISBLANK(A2:A); ""; SUMIF('bao-cao-ad-daily'!G2:G; A2:A; 'bao-cao-ad-daily'!Q2:Q)))`, // K
      `=ARRAYFORMULA(IF(ISBLANK(A2:A); ""; IF(H2:H=0; 0; (G2:G/H2:H)*1000)))`, // L
      `=ARRAYFORMULA(IF(ISBLANK(A2:A); ""; IF(H2:H=0; 0; I2:I/H2:H)))`,       // M
      `=ARRAYFORMULA(IF(ISBLANK(A2:A); ""; IF(H2:H=0; 0; J2:J/H2:H)))`,       // N
      `=ARRAYFORMULA(IF(ISBLANK(A2:A); ""; IF(I2:I=0; 0; G2:G/I2:I)))`,       // O
      `=ARRAYFORMULA(IF(ISBLANK(A2:A); ""; IF(J2:J=0; 0; G2:G/J2:J)))`,       // P
      `=ARRAYFORMULA(IF(ISBLANK(A2:A); ""; IF(K2:K=0; 0; G2:G/K2:K)))`,       // Q
      `=ARRAYFORMULA(IF(ISBLANK(A2:A); ""; COUNTIF('bao-cao-ad-daily'!G2:G; A2:A)))`, // R
      `=ARRAYFORMULA(IF(ISBLANK(A2:A); ""; IF(R2:R=0; 0; G2:G/R2:R)))`,       // S
      `=ARRAYFORMULA(IF(ISBLANK(A2:A); ""; IF(R2:R>=2; IF(OR(Q2:Q>250000; AND(K2:K=0; G2:G>250000)); IF(D2:D="ACTIVE"; "🚨 TẮT QUẢNG CÁO GẤP!"; "✅ Đã tắt an toàn"); "🟢 Giữ"); "🟡 Đang Test")))` // T
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${NEW_SHEET_NAME}!A1:T2`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [headers, formulas] },
    });

    console.log("Successfully wrote formulas to Content-Analytics!");
  } catch (error) {
    console.error("Error:", error.message);
  }
}

createSheet2();
