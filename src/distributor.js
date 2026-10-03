const { postToPage } = require('./services/facebook');
const { organizePost } = require('./services/googleDrive');
const { appendRow } = require('./services/googleSheets');
const { config } = require('./config');
const logger = require('./utils/logger');

/**
 * Distribute content to selected platforms (Facebook, Google Drive).
 * WordPress is handled separately via /api/wordpress endpoint.
 */
async function distribute({ content, title, mediaPaths = [], platforms = ['facebook', 'drive'], pillar, angle, pic, scheduledTime = null, selectedPageIds = null }) {
  const startTime = Date.now();
  logger.info('Distribution started', { platforms, mediaCount: mediaPaths.length, scheduled: !!scheduledTime });

  const tasks = [];

  // Facebook — post only to selectedPageIds (or all if not specified)
  if (platforms.includes('facebook')) {
    const allPages = config.facebook.pages;
    const pages = selectedPageIds && selectedPageIds.length > 0
      ? allPages.filter(p => selectedPageIds.includes(p.id))
      : allPages;

    const fbTask = Promise.allSettled(
      pages.map(page => postToPage(page.id, page.token, content, mediaPaths, scheduledTime))
    ).then(results => ({
      platform: 'facebook',
      success: results.every(r => r.status === 'fulfilled' && r.value?.success),
      results: results.map((r, i) => ({
        pageId: pages[i].id,
        ...(r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message }),
      })),
    }));
    tasks.push(fbTask);
  }

  // Google Drive (organized in subfolders)
  if (platforms.includes('drive')) {
    tasks.push(
      organizePost(content, title || 'post', mediaPaths)
        .catch((err) => ({ platform: 'google_drive', success: false, error: err.message }))
    );
  }

  // Run all in parallel
  const results = await Promise.allSettled(tasks);

  const finalResults = results.map((r) =>
    r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message }
  );

  const elapsed = Date.now() - startTime;
  const allSuccess = finalResults.every((r) => r.success);

  // Auto-report to Google Sheets — ONE row per distribution run
  try {
    const now = new Date();
    const date = now.toLocaleDateString('vi-VN');
    const time = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

    // Drive links
    const driveResult = finalResults.find((r) => r.platform === 'google_drive');
    const folderLink = driveResult?.folderLink || '';
    const contentLink = driveResult?.contentLink || folderLink;

    // Split Drive media into Design (images) and Media (videos)
    const imageLinks = [];
    const videoLinks = [];
    if (driveResult && driveResult.mediaLinks) {
      mediaPaths.forEach((p, i) => {
        const mimeType = require('mime-types').lookup(p) || '';
        if (mimeType.startsWith('video/')) videoLinks.push(driveResult.mediaLinks[i]);
        else imageLinks.push(driveResult.mediaLinks[i]);
      });
    }
    const designLink = imageLinks.filter(Boolean).join('\n');
    const mediaLinkStr = videoLinks.filter(Boolean).join('\n');

    // Format
    let format = 'Text';
    if (mediaPaths.length > 1) format = 'Ảnh';
    else if (mediaPaths.length === 1) {
      const mimeType = require('mime-types').lookup(mediaPaths[0]) || '';
      format = mimeType.startsWith('video/') ? 'Video' : 'Ảnh';
    }

    // Build MERGED channel name list and post URL list
    const channelNames = [];
    const reviewLinks = [];

    const fbResult = finalResults.find((r) => r.platform === 'facebook');
    if (fbResult && fbResult.results) {
      for (const pageRes of fbResult.results) {
        if (pageRes.success) {
          // Use friendly page name from config if available
          const pageIdx = config.facebook.pageIds.indexOf(pageRes.pageId);
          const pageName = config.facebook.pageNames[pageIdx] || `Page ${pageRes.pageId}`;
          channelNames.push(pageName);
          if (pageRes.url) reviewLinks.push(pageRes.url);
        }
      }
    }

    // Drive counts as a channel if chosen and succeeded
    if (platforms.includes('drive') && driveResult?.success) {
      channelNames.push('Google Drive');
    }

    // Determine status
    let status = scheduledTime ? 'Đã lên lịch bằng AI' : 'Đã đăng bằng AI';
    if (channelNames.length === 0 && driveResult?.success) {
      channelNames.push('Google Drive');
      status = 'Đã lưu Drive (Chưa đăng)';
    } else if (channelNames.length === 0) {
      status = 'Lỗi – Chưa đăng được';
    }

    const sheetsResult = await appendRow({
      channel: channelNames.join(', ') || 'Chưa xác định',
      date,
      time,
      pillar: pillar || '',
      angle: angle || '',
      format,
      pic: pic || '',
      contentLink,
      designLink,
      mediaLink: mediaLinkStr,
      status,
      reviewLink: reviewLinks.join('\n'),
    });

    finalResults.push(sheetsResult);
  } catch (err) {
    logger.error('Failed to report to Google Sheets', { error: err.message });
    finalResults.push({ platform: 'google_sheets', success: false, error: err.message });
  }

  logger.info('Distribution completed', {
    elapsed: `${elapsed}ms`,
    allSuccess,
  });

  return {
    success: allSuccess,
    elapsed: `${elapsed}ms`,
    results: finalResults,
  };
}

module.exports = { distribute };
