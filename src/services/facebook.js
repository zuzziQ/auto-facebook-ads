const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const mime = require('mime-types');
const { config } = require('../config');
const logger = require('../utils/logger');

const GRAPH_API_BASE = 'https://graph.facebook.com';
const GRAPH_VIDEO_BASE = 'https://graph-video.facebook.com';

function isVideo(filePath) {
  const mimeType = mime.lookup(filePath) || '';
  return mimeType.startsWith('video/');
}

/**
 * Upload a photo as unpublished (for multi-photo posts)
 */
async function uploadUnpublishedPhoto(pageId, token, mediaPath) {
  const url = `${GRAPH_API_BASE}/${config.facebook.apiVersion}/${pageId}/photos`;
  const form = new FormData();
  form.append('published', 'false');
  form.append('access_token', token);
  const stats = fs.statSync(mediaPath);
  form.append('source', fs.createReadStream(mediaPath), { knownLength: stats.size });
  const headers = form.getHeaders();
  headers['Content-Length'] = form.getLengthSync();
  const response = await axios.post(url, form, {
    headers: headers,
    timeout: 60000,
    maxContentLength: 100 * 1024 * 1024,
  });
  return response.data.id;
}

/**
 * Post multiple photos — with optional scheduling
 */
async function postMultiPhoto(pageId, token, content, mediaPaths, scheduledTime = null) {
  // Step 1: Upload each image as unpublished to get photo IDs
  const photoIds = [];
  for (const mediaPath of mediaPaths) {
    const id = await uploadUnpublishedPhoto(pageId, token, mediaPath);
    photoIds.push(id);
    logger.info(`Facebook: Uploaded unpublished photo ${id}`);
  }

  // Step 2: Create feed post with attached photos
  // IMPORTANT: Facebook requires attached_media[] to be sent as form-urlencoded,
  // not JSON. Using URLSearchParams ensures the correct Content-Type.
  const url = `${GRAPH_API_BASE}/${config.facebook.apiVersion}/${pageId}/feed`;
  const params = new URLSearchParams();
  params.append('message', content);
  params.append('access_token', token);
  photoIds.forEach((id, i) => {
    params.append(`attached_media[${i}]`, JSON.stringify({ media_fbid: id }));
  });
  if (scheduledTime) {
    params.append('published', 'false');
    params.append('scheduled_publish_time', String(scheduledTime));
  }

  const response = await axios.post(url, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30000,
  });
  return { postId: response.data.id, url: `https://facebook.com/${response.data.id}` };
}

/**
 * Post a single photo — uses /photos for immediate, /feed for scheduled
 */
async function postPhoto(pageId, token, content, mediaPath, scheduledTime = null) {
  if (scheduledTime) {
    // Facebook /photos endpoint doesn't support scheduling.
    // Upload photo as unpublished, then create a scheduled feed post.
    // IMPORTANT: attached_media[] must be sent as form-urlencoded, not JSON.
    const photoId = await uploadUnpublishedPhoto(pageId, token, mediaPath);
    const url = `${GRAPH_API_BASE}/${config.facebook.apiVersion}/${pageId}/feed`;
    const params = new URLSearchParams();
    params.append('message', content);
    params.append('access_token', token);
    params.append('published', 'false');
    params.append('scheduled_publish_time', String(scheduledTime));
    params.append('attached_media[0]', JSON.stringify({ media_fbid: photoId }));
    const response = await axios.post(url, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    });
    return { postId: response.data.id, url: `https://facebook.com/${response.data.id}` };
  }

  // Immediate post via /photos
  const url = `${GRAPH_API_BASE}/${config.facebook.apiVersion}/${pageId}/photos`;
  const form = new FormData();
  form.append('message', content);
  form.append('access_token', token);
  const stats = fs.statSync(mediaPath);
  form.append('source', fs.createReadStream(mediaPath), { knownLength: stats.size });
  const headers = form.getHeaders();
  headers['Content-Length'] = form.getLengthSync();
  const response = await axios.post(url, form, {
    headers: headers,
    timeout: 60000,
    maxContentLength: 100 * 1024 * 1024,
  });
  return {
    postId: response.data.post_id || response.data.id,
    url: `https://facebook.com/${response.data.post_id || response.data.id}`,
  };
}

/**
 * Post a video — with optional scheduling (using Resumable Upload API)
 */
async function postVideo(pageId, token, content, mediaPath, scheduledTime = null) {
  const stats = fs.statSync(mediaPath);
  const fileSize = stats.size;
  const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(1);
  logger.info(`Facebook: Uploading video Resumable (${fileSizeMB} MB) to page ${pageId}...`);
  
  const API_VERSION = config.facebook.apiVersion;
  const baseUrl = `${GRAPH_VIDEO_BASE}/${API_VERSION}/${pageId}/videos`;
  
  // 1. START phase
  const startResponse = await axios.post(baseUrl, null, {
    params: {
      upload_phase: 'start',
      access_token: token,
      file_size: fileSize
    },
    timeout: 30000
  });
  
  const { upload_session_id, video_id } = startResponse.data;
  let start_offset = parseInt(startResponse.data.start_offset);
  let end_offset = parseInt(startResponse.data.end_offset);
  
  // 2. TRANSFER phase
  while (start_offset < fileSize) {
    const chunkLength = end_offset - start_offset;
    const chunkStream = fs.createReadStream(mediaPath, { start: start_offset, end: end_offset - 1 });
    
    const form = new FormData();
    form.append('upload_phase', 'transfer');
    form.append('access_token', token);
    form.append('upload_session_id', upload_session_id);
    form.append('start_offset', start_offset.toString());
    form.append('video_file_chunk', chunkStream, { knownLength: chunkLength, filename: 'chunk.mp4', contentType: 'video/mp4' });
    
    const headers = form.getHeaders();
    headers['Content-Length'] = form.getLengthSync();
    
    const transferResponse = await axios.post(baseUrl, form, {
      headers: headers,
      timeout: 300000, // 5 minutes per chunk
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    
    start_offset = parseInt(transferResponse.data.start_offset);
    end_offset = parseInt(transferResponse.data.end_offset);
  }
  
  // 3. FINISH phase
  const finishForm = new FormData();
  finishForm.append('upload_phase', 'finish');
  finishForm.append('access_token', token);
  finishForm.append('upload_session_id', upload_session_id);
  finishForm.append('description', content);
  
  if (scheduledTime) {
    finishForm.append('published', 'false');
    finishForm.append('scheduled_publish_time', String(scheduledTime));
  }
  
  const finishHeaders = finishForm.getHeaders();
  finishHeaders['Content-Length'] = finishForm.getLengthSync();
  
  await axios.post(baseUrl, finishForm, {
    headers: finishHeaders,
    timeout: 60000
  });
  
  logger.info(`Facebook: Video uploaded successfully (Resumable) to page ${pageId}`);
  return { postId: video_id, url: `https://facebook.com/${video_id}` };
}

/**
 * Post text-only — with optional scheduling
 */
async function postText(pageId, token, content, scheduledTime = null) {
  const url = `${GRAPH_API_BASE}/${config.facebook.apiVersion}/${pageId}/feed`;
  const body = { message: content, access_token: token };
  if (scheduledTime) {
    body.published = false;
    body.scheduled_publish_time = scheduledTime;
  }
  const response = await axios.post(url, body, { timeout: 30000 });
  return { postId: response.data.id, url: `https://facebook.com/${response.data.id}` };
}

/**
 * Post content to a single Facebook Page
 * @param {string} pageId
 * @param {string} token
 * @param {string} content
 * @param {string[]} mediaPaths
 * @param {number|null} scheduledTime - Unix timestamp (seconds). null = post immediately.
 */
async function postToPage(pageId, token, content, mediaPaths = [], scheduledTime = null) {
  if (config.dryRun) {
    logger.info(`[DRY RUN] Facebook: Would ${scheduledTime ? 'schedule' : 'post'} to page ${pageId}`);
    return {
      success: true, pageId,
      postId: 'dry_run_post_id',
      url: 'https://facebook.com/dry_run',
      scheduled: !!scheduledTime,
      dryRun: true,
    };
  }

  try {
    let result;
    const imageFiles = mediaPaths.filter((p) => !isVideo(p));
    const videoFiles = mediaPaths.filter((p) => isVideo(p));

    // Handle videos first (each video = separate post on Facebook)
    const videoResults = [];
    for (const videoPath of videoFiles) {
      try {
        const vr = await postVideo(pageId, token, content, videoPath, scheduledTime);
        videoResults.push(vr);
      } catch (vErr) {
        const errMsg = vErr.response?.data?.error?.message || vErr.message;
        logger.error(`Facebook: Video upload failed for page ${pageId}`, { error: errMsg });
        videoResults.push({ success: false, error: errMsg });
      }
    }

    // Handle images
    if (imageFiles.length > 1) {
      result = await postMultiPhoto(pageId, token, content, imageFiles, scheduledTime);
    } else if (imageFiles.length === 1) {
      result = await postPhoto(pageId, token, content, imageFiles[0], scheduledTime);
    } else if (videoResults.length > 0) {
      // Only videos, use first video result as the main result
      result = videoResults[0];
    } else {
      result = await postText(pageId, token, content, scheduledTime);
    }

    // If we had both images and videos, merge video results
    if (imageFiles.length > 0 && videoResults.length > 0) {
      result.videoResults = videoResults;
    }

    logger.info(`Facebook: ${scheduledTime ? 'Scheduled' : 'Posted'} to page ${pageId}`, { postId: result.postId });
    return { success: true, pageId, scheduled: !!scheduledTime, ...result };
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    logger.error(`Facebook: Failed to post to page ${pageId}`, { error: errorMsg });
    return { success: false, pageId, error: errorMsg };
  }
}

/**
 * Post content to all configured Facebook Pages
 * @param {string} content
 * @param {string[]} mediaPaths
 * @param {number|null} scheduledTime - Unix timestamp (seconds). null = immediate.
 */
async function postToAllPages(content, mediaPaths = [], scheduledTime = null) {
  const pages = config.facebook.pages;
  if (pages.length === 0) {
    return { platform: 'facebook', success: false, error: 'No Facebook pages configured', results: [] };
  }

  const results = await Promise.allSettled(
    pages.map((page) => postToPage(page.id, page.token, content, mediaPaths, scheduledTime))
  );

  const pageResults = results.map((r, i) => ({
    pageId: pages[i].id,
    ...(r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message }),
  }));

  return {
    platform: 'facebook',
    success: pageResults.every((r) => r.success),
    results: pageResults,
  };
}

module.exports = { postToAllPages, postToPage };
