const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const mime = require('mime-types');
const { config } = require('../config');
const logger = require('../utils/logger');

/**
 * Get authenticated Google Drive client
 */
function getDriveClient() {
  const credPath = path.resolve(config.googleDrive.credentialsPath);
  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });

  return google.drive({ version: 'v3', auth });
}

/**
 * Create a subfolder inside the shared folder
 * @param {string} folderName - Name for the new folder
 * @param {string} [parentFolderId] - Parent folder ID
 * @returns {Object} - { folderId, webViewLink }
 */
async function createFolder(folderName, parentFolderId) {
  const parentId = parentFolderId || config.googleDrive.folderId;

  if (config.dryRun) {
    logger.info('[DRY RUN] Google Drive: Would create folder', { folderName });
    return {
      folderId: 'dry_run_folder_id',
      webViewLink: 'https://drive.google.com/dry_run_folder',
    };
  }

  const drive = getDriveClient();

  const response = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });

  logger.info('Google Drive: Folder created', {
    folderId: response.data.id,
    folderName,
  });

  return {
    folderId: response.data.id,
    webViewLink: response.data.webViewLink,
  };
}

/**
 * Upload a file to a specific Google Drive folder
 * @param {string} filePath - Local file path to upload
 * @param {string} [folderId] - Target folder ID
 * @returns {Object}
 */
async function uploadFile(filePath, folderId) {
  const targetFolder = folderId || config.googleDrive.folderId;
  const fileName = path.basename(filePath);
  const mimeType = mime.lookup(filePath) || 'application/octet-stream';

  if (config.dryRun) {
    logger.info('[DRY RUN] Google Drive: Would upload file', { fileName, folderId: targetFolder });
    return {
      success: true,
      fileId: 'dry_run_file_id',
      fileName,
      webViewLink: 'https://drive.google.com/dry_run',
      dryRun: true,
    };
  }

  const drive = getDriveClient();

  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [targetFolder],
    },
    media: {
      mimeType,
      body: fs.createReadStream(filePath),
    },
    fields: 'id, name, webViewLink, webContentLink',
    supportsAllDrives: true,
  });

  logger.info('Google Drive: File uploaded', {
    fileId: response.data.id,
    fileName: response.data.name,
  });

  return {
    success: true,
    fileId: response.data.id,
    fileName: response.data.name,
    webViewLink: response.data.webViewLink,
    webContentLink: response.data.webContentLink,
  };
}

/**
 * Save content as a text file to a specific folder
 */
async function uploadContentAsFile(content, fileName = 'content.txt', folderId) {
  const targetFolder = folderId || config.googleDrive.folderId;

  if (config.dryRun) {
    logger.info('[DRY RUN] Google Drive: Would save content as file', { fileName });
    return {
      success: true,
      fileId: 'dry_run_content_file',
      fileName,
      dryRun: true,
    };
  }

  const drive = getDriveClient();
  const { Readable } = require('stream');
  const stream = Readable.from([content]);

  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [targetFolder],
      mimeType: 'text/plain',
    },
    media: {
      mimeType: 'text/plain',
      body: stream,
    },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });

  logger.info('Google Drive: Content saved as file', {
    fileId: response.data.id,
    fileName: response.data.name,
  });

  return {
    success: true,
    fileId: response.data.id,
    fileName: response.data.name,
    webViewLink: response.data.webViewLink,
  };
}

/**
 * Organize a post into its own subfolder:
 *   parent-folder/
 *     2026-03-13_Post-Title/
 *       content.txt
 *       image1.jpg
 *       image2.png
 *
 * @param {string} content - Post text content
 * @param {string} title - Post title (used for folder name)
 * @param {string[]} mediaPaths - Array of media file paths
 * @returns {Object} - { folderLink, contentLink, mediaLinks[] }
 */
async function organizePost(content, title, mediaPaths = []) {
  if (config.dryRun) {
    logger.info('[DRY RUN] Google Drive: Would organize post in subfolder');
    return {
      platform: 'google_drive',
      success: true,
      dryRun: true,
      folderLink: 'https://drive.google.com/dry_run_folder',
      contentLink: 'https://drive.google.com/dry_run_content',
      mediaLinks: mediaPaths.map(() => 'https://drive.google.com/dry_run_media'),
    };
  }

  try {
    // Create subfolder
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // 2026-03-13
    const safeName = (title || 'post').substring(0, 40).replace(/[^\w\s-]/g, '').trim();
    const folderName = `${dateStr}_${safeName}`;

    const folder = await createFolder(folderName);

    // Upload content.txt
    const contentResult = await uploadContentAsFile(content, 'content.txt', folder.folderId);

    // Upload all media files
    const mediaResults = [];
    for (const mediaPath of mediaPaths) {
      const result = await uploadFile(mediaPath, folder.folderId);
      mediaResults.push(result);
    }

    logger.info('Google Drive: Post organized in folder', {
      folderName,
      folderId: folder.folderId,
      mediaCount: mediaResults.length,
    });

    return {
      platform: 'google_drive',
      success: true,
      folderLink: folder.webViewLink,
      folderId: folder.folderId,
      contentLink: contentResult.webViewLink,
      mediaLinks: mediaResults.map((r) => r.webViewLink),
      results: [
        { type: 'folder', success: true, fileName: folderName, webViewLink: folder.webViewLink },
        { type: 'content', success: true, fileName: 'content.txt', webViewLink: contentResult.webViewLink },
        ...mediaResults.map((r) => ({ type: 'media', success: r.success, fileName: r.fileName, webViewLink: r.webViewLink })),
      ],
    };
  } catch (err) {
    logger.error('Google Drive: Failed to organize post', { error: err.message });

    return {
      platform: 'google_drive',
      success: false,
      error: err.message,
    };
  }
}

module.exports = { uploadFile, uploadContentAsFile, createFolder, organizePost };
