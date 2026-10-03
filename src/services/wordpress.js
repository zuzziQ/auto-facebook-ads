const fs = require('fs');
const path = require('path');
const axios = require('axios');
const mime = require('mime-types');
const { config } = require('../config');
const logger = require('../utils/logger');

/**
 * Upload a single media file to WordPress. Returns { id, url, title }.
 */
async function uploadMedia(filePath) {
  const fileName = path.basename(filePath);
  const mimeType = mime.lookup(filePath) || 'application/octet-stream';
  const fileBuffer = fs.readFileSync(filePath);

  const response = await axios.post(
    `${config.wordpress.url}/wp-json/wp/v2/media`,
    fileBuffer,
    {
      headers: {
        Authorization: config.wordpress.authHeader,
        'Content-Type': mimeType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
      },
      timeout: 120000,
      maxContentLength: 500 * 1024 * 1024,
    }
  );

  logger.info('WordPress: Media uploaded', { mediaId: response.data.id, fileName });
  return { id: response.data.id, url: response.data.source_url, title: response.data.title?.rendered || fileName };
}

/**
 * Create a WordPress draft post. Embeds extra images in the post body as a gallery.
 */
async function createPost(title, content, featuredMediaId = null, extraMediaUrls = []) {
  if (config.dryRun) {
    logger.info('[DRY RUN] WordPress: Would create draft post', { title });
    return {
      platform: 'wordpress',
      success: true,
      postId: 'dry_run_post_id',
      url: `${config.wordpress.url}/?p=dry_run`,
      editUrl: `${config.wordpress.url}/wp-admin/post.php`,
      status: 'draft',
      dryRun: true,
    };
  }

  try {
    // Replace [image:N] placeholders with Gutenberg image blocks.
    // N is 1-indexed and matches the upload order of the images.
    // Images not referenced by any placeholder are appended after the last paragraph.
    const usedIndexes = new Set();

    let processedContent = content.replace(/\[image:(\d+)\]/gi, (match, num) => {
      const idx = parseInt(num, 10) - 1; // convert 1-based to 0-based
      const url = extraMediaUrls[idx];
      if (!url) return match; // placeholder left as-is if no image at that index
      usedIndexes.add(idx);
      return `<!-- /wp:paragraph -->\n<!-- wp:image {"sizeSlug":"large"} -->\n<figure class="wp-block-image size-large"><img src="${url}" alt=""/></figure>\n<!-- /wp:image -->\n<!-- wp:paragraph -->\n<p>`;
    });

    // Wrap full content in paragraph blocks
    let blockContent = `<!-- wp:paragraph -->\n<p>${processedContent.replace(/\n/g, '</p>\n<!-- /wp:paragraph -->\n<!-- wp:paragraph -->\n<p>')}</p>\n<!-- /wp:paragraph -->`;

    // Append images that were NOT referenced by any [image:N] placeholder
    const unusedImages = extraMediaUrls.filter((_, i) => !usedIndexes.has(i));
    if (unusedImages.length > 0) {
      const appendedBlocks = unusedImages
        .map(url => `<!-- wp:image {"sizeSlug":"large"} -->\n<figure class="wp-block-image size-large"><img src="${url}" alt=""/></figure>\n<!-- /wp:image -->`)
        .join('\n');
      blockContent += '\n\n' + appendedBlocks;
    }

    const postData = {
      title,
      content: blockContent,
      status: 'draft',
    };

    if (featuredMediaId) postData.featured_media = featuredMediaId;

    const response = await axios.post(
      `${config.wordpress.url}/wp-json/wp/v2/posts`,
      postData,
      {
        headers: {
          Authorization: config.wordpress.authHeader,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    logger.info('WordPress: Draft created', { postId: response.data.id });

    return {
      platform: 'wordpress',
      success: true,
      postId: response.data.id,
      url: response.data.link,
      editUrl: `${config.wordpress.url}/wp-admin/post.php?post=${response.data.id}&action=edit`,
      status: 'draft',
    };
  } catch (err) {
    const errorMsg = err.response?.data?.message || err.message;
    logger.error('WordPress: Failed to create post', { error: errorMsg });
    return { platform: 'wordpress', success: false, error: errorMsg };
  }
}

/**
 * Full WordPress flow: upload ALL media files then create draft post.
 * First image → featured image. Rest → embedded in post body.
 */
async function publishToWordPress(title, content, mediaPaths = []) {
  if (config.dryRun) return createPost(title, content, null, []);

  try {
    let featuredMediaId = null;
    const allUrls = [];

    for (let i = 0; i < mediaPaths.length; i++) {
      const p = mediaPaths[i];
      if (!p) continue;
      const media = await uploadMedia(p);
      if (i === 0) featuredMediaId = media.id; // first = featured image
      allUrls.push(media.url); // ALL images (including first) available to [image:N]
    }

    return await createPost(title, content, featuredMediaId, allUrls);
  } catch (err) {
    const errorMsg = err.response?.data?.message || err.message;
    logger.error('WordPress: Publish flow failed', { error: errorMsg });
    return { platform: 'wordpress', success: false, error: errorMsg };
  }
}

module.exports = { publishToWordPress, uploadMedia, createPost };
