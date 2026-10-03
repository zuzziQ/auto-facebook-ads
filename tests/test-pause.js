require('dotenv').config();
const axios = require('axios');
const API_VERSION = process.env.FACEBOOK_API_VERSION || 'v21.0';

async function run() {
  const token = process.env.FB_ADS_ACCESS_TOKEN;
  try {
    const res = await axios.get(
      `https://graph.facebook.com/${API_VERSION}/120238480811360269?fields=id,name,status,effective_status&access_token=${token}`
    );
    console.log("Ad Status GET:", res.data);
  } catch (e) {
    console.error("Ad Status GET error:", e.response ? e.response.data : e.message);
  }
}
run();
