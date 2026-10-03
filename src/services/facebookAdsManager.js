const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const API_VERSION = process.env.FACEBOOK_API_VERSION || 'v23.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;
const accountPath = id => `act_${String(id).replace(/^act_/, '')}`;

/**
 * createCampaign
 */
async function createCampaign(adAccountId, accessToken, name, objective, budget, specialAdCategories = ['NONE']) {
    const response = await axios.post(`${BASE_URL}/${accountPath(adAccountId)}/campaigns`, {
        name: name,
        objective: objective,
        status: 'PAUSED',
        special_ad_categories: specialAdCategories,
        daily_budget: budget,
        access_token: accessToken
    });
    return response.data;
}

/**
 * createAdSet
 */
async function createAdSet(adAccountId, accessToken, campaignId, name, targeting, budget, bidAmount, billingEvent = 'IMPRESSIONS', optimizationGoal = 'REACH') {
    const response = await axios.post(`${BASE_URL}/${accountPath(adAccountId)}/adsets`, {
        name: name,
        campaign_id: campaignId,
        targeting: targeting,
        daily_budget: budget,
        billing_event: billingEvent,
        optimization_goal: optimizationGoal,
        bid_amount: bidAmount,
        status: 'PAUSED',
        access_token: accessToken
    });
    return response.data;
}

/**
 * uploadMedia
 */
async function uploadMedia(adAccountId, accessToken, filePath) {
    const form = new FormData();
    form.append('access_token', accessToken);
    form.append('file', fs.createReadStream(filePath));
    
    const isVideo = filePath.match(/\.(mp4|mov|avi)$/i);
    const endpoint = isVideo ? 'advideos' : 'adimages';
    
    const response = await axios.post(`${BASE_URL}/${accountPath(adAccountId)}/${endpoint}`, form, {
        headers: {
            ...form.getHeaders()
        }
    });
    
    return response.data;
}

/**
 * createAdCreative
 */
async function createAdCreative(adAccountId, accessToken, pageId, name, message, link, imageHash, videoId) {
    const objectStorySpec = {
        page_id: pageId,
    };
    if (videoId) {
        objectStorySpec.video_data = {
            video_id: videoId,
            message: message,
            call_to_action: { type: 'LEARN_MORE', value: { link } }
        };
    } else {
        objectStorySpec.link_data = {
            image_hash: imageHash,
            link: link,
            message: message,
            call_to_action: { type: 'LEARN_MORE', value: { link } }
        };
    }

    const response = await axios.post(`${BASE_URL}/${accountPath(adAccountId)}/adcreatives`, {
        name: name,
        object_story_spec: objectStorySpec,
        access_token: accessToken
    });
    return response.data;
}

/**
 * createAd
 */
async function createAd(adAccountId, accessToken, adsetId, creativeId, name) {
    const response = await axios.post(`${BASE_URL}/${accountPath(adAccountId)}/ads`, {
        name: name,
        adset_id: adsetId,
        creative: { creative_id: creativeId },
        status: 'PAUSED',
        access_token: accessToken
    });
    return response.data;
}

/**
 * searchInterests
 */
async function searchInterests(accessToken, keywords) {
    if (!keywords) return [];
    const kws = keywords.split(',').map(k => k.trim()).filter(Boolean);
    const interests = [];
    for (const kw of kws) {
        try {
            const res = await axios.get(`${BASE_URL}/search`, {
                params: {
                    type: 'adinterest',
                    q: kw,
                    access_token: accessToken
                }
            });
            if (res.data && res.data.data && res.data.data.length > 0) {
                interests.push({ id: res.data.data[0].id, name: res.data.data[0].name });
            }
        } catch(e) {
            console.error(`Error searching interest for ${kw}:`, e.message);
        }
    }
    return interests;
}

/**
 * getLocation
 */
function getLocation(locationType) {
    if (locationType === 'HN') {
        return { regions: [{ key: '3167' }] };
    } else if (locationType === 'HCM') {
        return { regions: [{ key: '3174' }] };
    }
    return { countries: ['VN'] };
}

/**
 * updateAdSetStatus
 */
async function updateAdSetStatus(adAccountId, accessToken, adsetId, status) {
    const response = await axios.post(`${BASE_URL}/${adsetId}`, {
        status: status,
        access_token: accessToken
    });
    return response.data;
}

/**
 * updateAdSetBudget
 */
async function updateAdSetBudget(adAccountId, accessToken, adsetId, newBudget) {
    const response = await axios.post(`${BASE_URL}/${adsetId}`, {
        daily_budget: newBudget,
        access_token: accessToken
    });
    return response.data;
}

/**
 * fetchActiveAdsContext
 */
async function fetchActiveAdsContext(adAccountId, accessToken) {
    try {
        const cleanAccountId = adAccountId.replace(/^act_/, '');
        const response = await axios.get(`${BASE_URL}/act_${cleanAccountId}/ads`, {
            params: {
                fields: 'id,name,status,adset{name,targeting,daily_budget},creative{image_url,thumbnail_url,body,object_story_spec,video_id},insights.date_preset(last_7d){spend,cpm,actions,cost_per_action_type}',
                limit: 20,
                access_token: accessToken
            }
        });
        
        const adsData = response.data.data || [];
        return adsData.map(ad => {
            const creative = ad.creative || {};
            const adset = ad.adset || {};
            const insights = (ad.insights && ad.insights.data && ad.insights.data[0]) ? ad.insights.data[0] : {};
            
            return {
                adId: ad.id,
                adName: ad.name,
                status: ad.status,
                adsetName: adset.name,
                targeting: adset.targeting,
                daily_budget: adset.daily_budget,
                creative: {
                    image_url: creative.image_url,
                    thumbnail_url: creative.thumbnail_url,
                    body: creative.body,
                    video_id: creative.video_id,
                    message: creative.object_story_spec?.link_data?.message || creative.object_story_spec?.video_data?.message
                },
                insights: {
                    spend: insights.spend,
                    cpm: insights.cpm,
                    actions: insights.actions,
                    cost_per_action_type: insights.cost_per_action_type
                }
            };
        });
    } catch (error) {
        const details = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error('Error fetching active ads context:', details);
        throw error;
    }
}

module.exports = {
    createCampaign,
    createAdSet,
    uploadMedia,
    createAdCreative,
    createAd,
    searchInterests,
    getLocation,
    updateAdSetStatus,
    updateAdSetBudget,
    fetchActiveAdsContext
};
