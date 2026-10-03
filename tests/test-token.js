require('dotenv').config();
const axios = require('axios');

async function testToken() {
  const token = process.env.FB_ADS_ACCESS_TOKEN;
  if (!token) throw new Error('Missing FB_ADS_ACCESS_TOKEN');
  try {
    const res = await axios.get(`https://graph.facebook.com/v21.0/me?access_token=${token}&fields=id,name`);
    console.log("Token User:", res.data);
  } catch (e) {
    console.error("Token test error:", e.response ? e.response.data : e.message);
  }
}
testToken();
