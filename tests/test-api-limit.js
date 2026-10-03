require('dotenv').config();
const axios = require('axios');
const API_VERSION = process.env.FACEBOOK_API_VERSION || 'v21.0';
const ACCESS_TOKEN = process.env.FB_ADS_ACCESS_TOKEN;

async function run() {
  const url = `https://graph.facebook.com/${API_VERSION}/act_437824737746244/insights`;
  try {
    const response = await axios.get(url, {
      params: {
        access_token: ACCESS_TOKEN,
        fields: 'ad_id',
        date_preset: 'this_month',
        time_increment: 1,
        level: 'ad'
      }
    });
    console.log("Without limit:", response.data.data.length);

    const limResponse = await axios.get(url, {
      params: {
        access_token: ACCESS_TOKEN,
        fields: 'ad_id',
        date_preset: 'this_month',
        time_increment: 1,
        level: 'ad',
        limit: 5000
      }
    });
    console.log("With limit 5000:", limResponse.data.data.length);
  } catch (error) {
    console.error(error.message);
  }
}
run();
