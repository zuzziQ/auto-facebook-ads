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
        fields: 'ad_id,ad_name,spend',
        date_preset: 'this_month',
        time_increment: 1,
        level: 'ad'
      }
    });
    const match = response.data.data.filter(ad => ad.ad_id === '120242503015770269');
    console.log("Insights for this month:", match);

    const todayResponse = await axios.get(url, {
      params: {
        access_token: ACCESS_TOKEN,
        fields: 'ad_id,ad_name,spend',
        date_preset: 'today',
        time_increment: 1,
        level: 'ad'
      }
    });
    const matchToday = todayResponse.data.data.filter(ad => ad.ad_id === '120242503015770269');
    console.log("Insights for today:", matchToday);

  } catch (error) {
    console.error(error.response ? error.response.data : error.message);
  }
}
run();
