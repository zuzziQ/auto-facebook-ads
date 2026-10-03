const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const excelJS = require('exceljs');
const { config } = require('../config');

const router = express.Router();

const FB_ADS_ACCESS_TOKEN = process.env.FB_ADS_ACCESS_TOKEN;
const API_VERSION = process.env.FACEBOOK_API_VERSION || 'v21.0';
const FB_AD_ACCOUNT_ID = process.env.FB_AD_ACCOUNT_ID; // act_...

// In-memory job store
const exportJobs = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// -------------------------------------------------------------
// RECURSIVE FETCH: PAGE PUBLISHED POSTS
// -------------------------------------------------------------
async function fetchPagePosts(jobId) {
  const job = exportJobs.get(jobId);
  if (!job) return;

  if (!config.facebook || !config.facebook.pages || config.facebook.pages.length === 0) {
    job.status = 'error';
    job.error = 'Lỗi chưa có Token. Vui lòng cấu hình Trang Fanpage trong File .env hoặc ở mục Settings!';
    return;
  }

  const allPosts = [];

  try {
    for (const page of config.facebook.pages) {
      if (job.status === 'error') break;
      if (!page.id || !page.token) continue;
      
      let nextUrl = `https://graph.facebook.com/${API_VERSION}/${page.id}/published_posts?fields=id,permalink_url,message,created_time&limit=50&access_token=${page.token}`;

      while (nextUrl) {
        if (job.status === 'error') break;

        const res = await axios.get(nextUrl);
        const data = res.data.data || [];
        
        for (const p of data) {
          allPosts.push({
            page_name: page.name || page.id,
            id: p.id,
            url: p.permalink_url || `https://facebook.com/${p.id}`,
            date: p.created_time ? new Date(p.created_time).toLocaleString('vi-VN') : '',
            message: p.message ? p.message.substring(0, 500) : ''
          });
        }

        job.progress = `Đã lấy ${allPosts.length} bài (${page.name || page.id})...`;
        
        if (res.data.paging && res.data.paging.next) {
          nextUrl = res.data.paging.next;
          await sleep(1500); // 1.5s delay to strictly avoid rate limit
        } else {
          nextUrl = null;
        }
      }
    }

    job.resultData = allPosts;
    await generateExcel(jobId, 'page_posts');

  } catch (err) {
    console.error('Error fetching page posts:', err?.response?.data || err.message);
    job.status = 'error';
    job.error = (err?.response?.data?.error?.message || err.message) + ' (Bạn hãy kiểm tra lại Token ở file .env có bị hết hạn hay sai tên dạng không nha!)';
  }
}

// -------------------------------------------------------------
// RECURSIVE FETCH: AD ACCOUNT DARK POSTS
// -------------------------------------------------------------
async function fetchAdCreatives(jobId) {
  const job = exportJobs.get(jobId);
  if (!job) return;

  if (!FB_AD_ACCOUNT_ID || !FB_ADS_ACCESS_TOKEN) {
    job.status = 'error';
    job.error = 'Lỗi chưa có Token Quảng Cáo. Vui lòng thêm biến FB_AD_ACCOUNT_ID và FB_ADS_ACCESS_TOKEN vào file .env';
    return;
  }

  const allPosts = [];
  let nextUrl = `https://graph.facebook.com/${API_VERSION}/${FB_AD_ACCOUNT_ID}/ads?fields=id,name,creative{effective_object_story_id,body},created_time&limit=50&access_token=${FB_ADS_ACCESS_TOKEN}`;

  try {
    const seenStoryIds = new Set();

    while (nextUrl) {
      if (job.status === 'error') break;

      const res = await axios.get(nextUrl);
      const data = res.data.data || [];
      
      for (const p of data) {
        if (!p.creative || !p.creative.effective_object_story_id) continue;
        const storyId = p.creative.effective_object_story_id;
        
        if (!seenStoryIds.has(storyId)) {
          seenStoryIds.add(storyId);
          const [pageId, postId] = storyId.split('_');
          
          allPosts.push({
            id: storyId,
            url: `https://facebook.com/${pageId}/posts/${postId}`,
            date: p.created_time ? new Date(p.created_time).toLocaleString('vi-VN') : '',
            name: p.name || '',
            message: p.creative.body ? p.creative.body.substring(0, 500) : ''
          });
        }
      }

      job.progress = `Đã quét và lọc được ${allPosts.length} post từ Ads...`;
      
      if (res.data.paging && res.data.paging.next) {
        nextUrl = res.data.paging.next;
        await sleep(1500);
      } else {
        nextUrl = null;
      }
    }

    job.resultData = allPosts;
    await generateExcel(jobId, 'ad_posts');

  } catch (err) {
    console.error('Error fetching ad creatives:', err?.response?.data || err.message);
    job.status = 'error';
    job.error = err?.response?.data?.error?.message || err.message;
  }
}

// -------------------------------------------------------------
// EXCEL EXPORT
// -------------------------------------------------------------
async function generateExcel(jobId, prefix) {
  const job = exportJobs.get(jobId);
  if (!job || job.status === 'error') return;

  job.progress = 'Đang phân tích và đóng gói File Excel...';

  try {
    const workbook = new excelJS.Workbook();
    const worksheet = workbook.addWorksheet('Posts');

    if (prefix === 'page_posts') {
      worksheet.columns = [
        { header: 'Tên Trang', key: 'page_name', width: 25 },
        { header: 'Post ID', key: 'id', width: 20 },
        { header: 'Link Bài', key: 'url', width: 45 },
        { header: 'Ngày Đăng', key: 'date', width: 22 },
        { header: 'Nội Dung (Trích đoạn)', key: 'message', width: 80 }
      ];
    } else {
      worksheet.columns = [
        { header: 'Story ID', key: 'id', width: 30 },
        { header: 'Tên Chiến dịch/Ad', key: 'name', width: 35 },
        { header: 'Link Bài', key: 'url', width: 45 },
        { header: 'Ngày Lên Camp', key: 'date', width: 22 },
        { header: 'Nội Dung Ad', key: 'message', width: 80 }
      ];
    }

    worksheet.getRow(1).font = { bold: true };

    for (const row of job.resultData) {
      worksheet.addRow(row);
    }

    const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const filename = `${prefix}_${Date.now()}.xlsx`;
    const filepath = path.join(uploadsDir, filename);

    await workbook.xlsx.writeFile(filepath);

    job.status = 'completed';
    job.progress = 'Hoàn tất!';
    job.fileUrl = `/api/facebook/export/download?file=${filename}`;

  } catch (err) {
    console.error('Error writing excel:', err);
    job.status = 'error';
    job.error = 'Lỗi khi tạo file Excel.';
  }
}

// -------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------

router.post('/start', (req, res) => {
  const { type } = req.body; // 'page' or 'ads'
  const jobId = `job_${Date.now()}_${Math.floor(Math.random()*1000)}`;

  exportJobs.set(jobId, {
    id: jobId,
    status: 'running',
    progress: 'Đang khởi tạo kết nối...',
    resultData: null,
    fileUrl: null,
    error: null,
    type
  });

  if (type === 'page') {
    fetchPagePosts(jobId);
  } else if (type === 'ads') {
    fetchAdCreatives(jobId);
  } else {
    exportJobs.get(jobId).status = 'error';
    exportJobs.get(jobId).error = 'Loại yêu cầu không hợp lệ';
  }

  res.json({ success: true, jobId });
});

router.get('/status', (req, res) => {
  const { job_id } = req.query;
  const job = exportJobs.get(job_id);
  
  if (!job) {
    return res.json({ success: false, error: 'Job không tồn tại' });
  }

  res.json({
    success: true,
    status: job.status,
    progress: job.progress,
    fileUrl: job.fileUrl,
    error: job.error
  });
});

router.get('/download', (req, res) => {
  const { file } = req.query;
  if (!file) return res.status(400).send('Missing file param');
  
  const filepath = path.join(__dirname, '..', '..', 'uploads', file);
  if (!fs.existsSync(filepath)) {
    return res.status(404).send('File not found');
  }

  res.download(filepath, file, (err) => {
    if (!err) {
      // Optional: Delete file after successful download to save disk space
      setTimeout(() => fs.unlinkSync(filepath), 60000); 
    }
  });
});

module.exports = router;
