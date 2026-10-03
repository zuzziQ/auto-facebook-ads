const { syncAdsDataToSheets, syncAdsConfigToSheets } = require('./src/services/facebookAds');
async function run() {
  console.log("Syncing configs...");
  await syncAdsConfigToSheets();
  console.log("Syncing stats...");
  await syncAdsDataToSheets();
  console.log("Done");
}
run();
