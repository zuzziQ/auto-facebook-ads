/**
 * Content Distributor — Frontend Application
 */
(function () {
  // ---- Tab state ----
  let activeTab = 'fb'; // 'fb' or 'wp'

  // Exposed globally for onclick="switchTab(...)" in HTML
  window.switchTab = function(tab) {
    activeTab = tab;
    document.getElementById('tabContentFb').style.display = tab === 'fb' ? '' : 'none';
    document.getElementById('tabContentWp').style.display = tab === 'wp' ? '' : 'none';
    document.getElementById('tabFb').className = 'tab-btn' + (tab === 'fb' ? ' tab-btn--active' : '');
    document.getElementById('tabWp').className = 'tab-btn' + (tab === 'wp' ? ' tab-btn--active' : '');
  };

  // DOM Elements
  const postContent = document.getElementById('postContent');
  const postPillar = document.getElementById('postPillar');
  const postAngle = document.getElementById('postAngle');
  const postPic = document.getElementById('postPic');
  const charCount = document.getElementById('charCount');
  const dropZone = document.getElementById('dropZone');
  const mediaInput = document.getElementById('mediaInput');
  const mediaList = document.getElementById('mediaList');
  const clearAllMediaBtn = document.getElementById('clearAllMedia');
  const reviewBtn = document.getElementById('reviewBtn');
  const distributeBtn = document.getElementById('distributeBtn');
  const reviewContent_el = document.getElementById('reviewContent');
  const resultsSection = document.getElementById('resultsSection');
  const resultsContent = document.getElementById('resultsContent');
  const guidelinesBtn = document.getElementById('guidelinesBtn');
  const guidelinesModal = document.getElementById('guidelinesModal');
  const guidelinesEditor = document.getElementById('guidelinesEditor');
  const closeModal = document.getElementById('closeModal');
  const saveGuidelines = document.getElementById('saveGuidelines');
  const loadingOverlay = document.getElementById('loadingOverlay');
  const loadingText = document.getElementById('loadingText');
  const statusBadge = document.getElementById('statusBadge');
  // WordPress Draft panel
  const wpTitle = document.getElementById('wpTitle');
  const wpPillar = document.getElementById('wpPillar');
  const wpAngle = document.getElementById('wpAngle');
  const wpPic = document.getElementById('wpPic');
  const wpContent = document.getElementById('wpContent');
  const wpMediaInput = document.getElementById('wpMediaInput');
  const saveDraftBtn = document.getElementById('saveDraftBtn');
  const wpDraftResult = document.getElementById('wpDraftResult');
  // Schedule
  const scheduleToggle = document.getElementById('scheduleToggle');
  const scheduleTimeRow = document.getElementById('scheduleTimeRow');
  const scheduleTimeInput = document.getElementById('scheduleTime');

  if (scheduleToggle) {
    scheduleToggle.addEventListener('change', () => {
      scheduleTimeRow.style.display = scheduleToggle.checked ? 'block' : 'none';
      if (scheduleToggle.checked && !scheduleTimeInput.value) {
        const d = new Date(Date.now() + 60 * 60 * 1000);
        scheduleTimeInput.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      }
      distributeBtn.innerHTML = scheduleToggle.checked
        ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Schedule`
        : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Distribute`;
    });
  }

  // Load Facebook pages from API and render per-page checkboxes
  async function loadFbPages() {
    const container = document.getElementById('fbPageCheckboxes');
    try {
      const res = await fetch('/api/pages');
      const data = await res.json();
      if (!data.pages || data.pages.length === 0) {
        container.innerHTML = '<span style="font-size:.8rem;color:var(--text-dim)">No pages configured. Add pages in Settings.</span>';
        return;
      }
      container.innerHTML = '';
      data.pages.forEach(page => {
        const label = document.createElement('label');
        label.className = 'page-checkbox-row';
        label.innerHTML = `
          <input type="checkbox" class="fb-page-cb" data-id="${page.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
          ${escapeHtml(page.name || page.id)}`;
        container.appendChild(label);
      });
    } catch (err) {
      container.innerHTML = `<span style="font-size:.8rem;color:#f87171">Failed to load pages: ${err.message}</span>`;
    }
  }

  function getSelectedPageIds() {
    return [...document.querySelectorAll('.fb-page-cb:checked')].map(cb => cb.dataset.id);
  }

  let uploadedFiles = []; // Array of { path, originalName, size, mimeType, localUrl }


  // ---- Initialize ----
  checkHealth();
  loadFbPages();

  // ---- Character Counter ----
  postContent.addEventListener('input', () => {
    const len = postContent.value.length;
    charCount.textContent = `${len} chars`;
    charCount.className = len > 500 ? 'badge badge--warning' : 'badge badge--neutral';
  });

  // ---- Drag & Drop (multi-file) ----
  dropZone.addEventListener('click', () => mediaInput.click());

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drop-zone--active');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drop-zone--active');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drop-zone--active');
    if (e.dataTransfer.files.length > 0) {
      handleMultiFileUpload(Array.from(e.dataTransfer.files));
    }
  });

  mediaInput.addEventListener('change', () => {
    if (mediaInput.files.length > 0) {
      handleMultiFileUpload(Array.from(mediaInput.files));
    }
  });

  clearAllMediaBtn.addEventListener('click', () => {
    uploadedFiles = [];
    mediaList.innerHTML = '';
    clearAllMediaBtn.hidden = true;
    mediaInput.value = '';
  });

  // ---- Multi-File Upload ----
  async function handleMultiFileUpload(files) {
    const maxSize = 1024 * 1024 * 1024; // 1 GB video limit
    const imageMaxSize = 30 * 1024 * 1024; // 30 MB max for images/GIFs on Facebook
    
    const validFiles = files.filter((f) => {
      const isImage = f.type.startsWith('image/');
      if (isImage && f.size > imageMaxSize) {
        showToast(`File ${f.name} (Ảnh/GIF) quá nặng (${formatFileSize(f.size)}). Facebook giới hạn tối đa 30MB. Hãy xuất ra file MP4 nhé!`, 'error');
        return false;
      }
      if (f.size > maxSize) {
        showToast(`${f.name} vượt quá dung lượng cho phép (max 1GB)`, 'error');
        return false;
      }
      return true;
    });

    if (validFiles.length === 0) return;

    showLoading(`Uploading ${validFiles.length} file(s)...`);

    const formData = new FormData();
    validFiles.forEach((f) => formData.append('media', f));

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();

      if (!data.success) throw new Error(data.error);

      // Add to tracking
      data.files.forEach((serverFile, i) => {
        const localFile = validFiles[i];
        const localUrl = URL.createObjectURL(localFile);
        uploadedFiles.push({
          ...serverFile,
          localUrl,
          localType: localFile.type,
        });
      });

      renderMediaList();
      showToast(`${validFiles.length} file(s) uploaded`, 'success');
    } catch (err) {
      showToast(`Upload failed: ${err.message}`, 'error');
    } finally {
      hideLoading();
      mediaInput.value = '';
    }
  }

  function renderMediaList() {
    clearAllMediaBtn.hidden = uploadedFiles.length === 0;

    mediaList.innerHTML = uploadedFiles
      .map((f, i) => {
        const isImage = f.localType?.startsWith('image/');
        const isVideo = f.localType?.startsWith('video/');
        let thumb = '';
        if (isImage) thumb = `<img src="${f.localUrl}" alt="Preview">`;
        else if (isVideo) thumb = `<video src="${f.localUrl}" muted></video>`;

        return `
          <div class="media-item" data-index="${i}">
            ${thumb}
            <div class="media-item__info">
              <div class="media-item__name">${escapeHtml(f.originalName)}</div>
              <div class="media-item__size">${formatFileSize(f.size)}</div>
            </div>
            <button class="media-item__remove" onclick="window._removeMedia(${i})" title="Remove">✕</button>
          </div>`;
      })
      .join('');
  }

  window._removeMedia = (index) => {
    uploadedFiles.splice(index, 1);
    renderMediaList();
  };

  // ---- AI Review ----
  reviewBtn.addEventListener('click', async () => {
    const content = postContent.value.trim();
    if (!content) {
      showToast('Please enter some content first', 'error');
      return;
    }

    showLoading('AI is reviewing your content...');
    reviewBtn.disabled = true;

    try {
      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          pillar: postPillar.value.trim(),
          angle: postAngle.value.trim(),
        }),
      });
      const data = await res.json();

      if (data.error) throw new Error(data.details || data.error);

      renderReviewResult(data);
    } catch (err) {
      showToast(`Review failed: ${err.message}`, 'error');
    } finally {
      hideLoading();
      reviewBtn.disabled = false;
    }
  });

  function renderReviewResult(data, targetEl) {
    const container = targetEl || reviewContent_el;
    const { approved, issues, suggestedContent, summary } = data;

    let html = '<div class="review-result">';

    if (approved) {
      html += `<div class="review-summary review-summary--pass"><span>✅</span> ${escapeHtml(summary)}</div>`;
    } else {
      html += `<div class="review-summary review-summary--fail"><span>⚠️</span> ${escapeHtml(summary)}</div>`;
    }

    if (issues && issues.length > 0) {
      html += '<div class="review-issues">';
      issues.forEach((issue) => {
        const cls = issue.type === 'error' ? 'review-issue--error' : 'review-issue--warning';
        html += `
          <div class="review-issue ${cls}">
            <div class="review-issue__rule">${escapeHtml(issue.rule || '')}</div>
            <div class="review-issue__desc">${escapeHtml(issue.description || '')}</div>
            ${issue.suggestion ? `<div class="review-issue__fix">💡 ${escapeHtml(issue.suggestion)}</div>` : ''}
          </div>`;
      });
      html += '</div>';
    }

    if (suggestedContent) {
      const formattedContent = escapeHtml(suggestedContent).replace(/\\n/g, '<br>').replace(/\n/g, '<br>');
      html += `
        <div class="review-suggestion">
          <div class="review-suggestion__header">
            <span class="review-suggestion__label">✨ AI Suggested Fix</span>
          </div>
          <div class="review-suggestion__text">${formattedContent}</div>
        </div>`;
    }

    html += '</div>';
    container.innerHTML = html;
  }

  // ---- Distribute ----
  distributeBtn.addEventListener('click', async () => {
    const content = postContent.value.trim();
    if (!content) {
      showToast('Please enter some content first', 'error');
      return;
    }

    const platforms = getSelectedPlatforms();
    if (platforms.length === 0) {
      showToast('Please select at least one platform', 'error');
      return;
    }

    showLoading('Distributing to all platforms...');
    distributeBtn.disabled = true;

    try {
      // Compute scheduledTime (Unix seconds) if schedule toggle is on
      let scheduledTime = null;
      if (scheduleToggle && scheduleToggle.checked && scheduleTimeInput.value) {
        const ts = new Date(scheduleTimeInput.value).getTime();
        if (isNaN(ts)) {
          showToast('Invalid schedule date/time', 'error');
          return;
        }
        const minTime = Date.now() + 10 * 60 * 1000; // 10 min from now
        if (ts < minTime) {
          showToast('Schedule time must be at least 10 minutes in the future', 'error');
          return;
        }
        scheduledTime = Math.floor(ts / 1000);
      }

      const body = {
        content,
        title: content.substring(0, 80),
        mediaPaths: uploadedFiles.map((f) => f.path),
        platforms,
        pillar: postPillar.value.trim(),
        angle: postAngle.value.trim(),
        pic: postPic.value.trim(),
        scheduledTime,
        selectedPageIds: getSelectedPageIds(),
      };

      const res = await fetch('/api/distribute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (data.error) throw new Error(data.details || data.error);

      renderResults(data);
      showToast(data.success ? 'Distribution complete!' : 'Some platforms had issues', data.success ? 'success' : 'error');
    } catch (err) {
      showToast(`Distribution failed: ${err.message}`, 'error');
    } finally {
      hideLoading();
      distributeBtn.disabled = false;
    }
  });

  // ---- WordPress AI Review ----
  const wpReviewBtn = document.getElementById('wpReviewBtn');
  const wpReviewResult = document.getElementById('wpReviewResult');

  if (wpReviewBtn) {
    wpReviewBtn.addEventListener('click', async () => {
      const content = wpContent.value.trim();
      if (!content) {
        showToast('Please enter WP content first', 'error');
        return;
      }

      wpReviewBtn.disabled = true;
      wpReviewResult.style.display = 'none';
      showLoading('Running AI Review on WP content...');

      try {
        const res = await fetch('/api/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
        const data = await res.json();

        if (data.error) throw new Error(data.details || data.error);

        wpReviewResult.style.display = 'block';
        wpReviewResult.innerHTML = '';
        // Reuse the same HTML rendering as the main review panel
        renderReviewResult(data, wpReviewResult, content);
      } catch (err) {
        wpReviewResult.style.display = 'block';
        wpReviewResult.innerHTML = `<div class="review-error"><span>⚠️ Review failed: ${escapeHtml(err.message)}</span></div>`;
      } finally {
        hideLoading();
        wpReviewBtn.disabled = false;
      }
    });
  }

  // ---- WordPress Save Draft ----
  if (saveDraftBtn) {
    saveDraftBtn.addEventListener('click', async () => {
      const title = wpTitle.value.trim();
      const content = wpContent.value.trim();
      if (!title || !content) {
        showToast('WP Title and Content are required', 'error');
        return;
      }

      saveDraftBtn.disabled = true;
      wpDraftResult.style.display = 'none';
      showLoading('Saving draft to WordPress...');

      try {
        const formData = new FormData();
        formData.append('title', title);
        formData.append('content', content);
        formData.append('pillar', wpPillar?.value?.trim() || '');
        formData.append('angle', wpAngle?.value?.trim() || '');
        formData.append('pic', wpPic?.value?.trim() || '');
        // Append ALL selected files
        const files = wpMediaInput.files;
        for (let i = 0; i < files.length; i++) {
          formData.append('media', files[i]);
        }

        const res = await fetch('/api/wordpress', { method: 'POST', body: formData });
        const data = await res.json();

        if (data.success) {
          wpDraftResult.style.cssText = 'display:block;background:rgba(34,197,94,.1);color:#4ade80;border:1px solid rgba(34,197,94,.25);margin-top:.6rem;font-size:.82rem;padding:.5rem .75rem;border-radius:8px';
          wpDraftResult.innerHTML = `✅ Draft saved! <a href="${data.url || '#'}" target="_blank" style="color:inherit;text-decoration:underline">View in WordPress →</a>`;
          showToast('Draft saved to WordPress!', 'success');
        } else {
          wpDraftResult.style.cssText = 'display:block;background:rgba(239,68,68,.1);color:#f87171;border:1px solid rgba(239,68,68,.25);margin-top:.6rem;font-size:.82rem;padding:.5rem .75rem;border-radius:8px';
          wpDraftResult.textContent = `❌ ${data.error || data.details || 'Failed'}`;
        }
      } catch (err) {
        wpDraftResult.style.cssText = 'display:block;background:rgba(239,68,68,.1);color:#f87171;border:1px solid rgba(239,68,68,.25);margin-top:.6rem;font-size:.82rem;padding:.5rem .75rem;border-radius:8px';
        wpDraftResult.textContent = `❌ ${err.message}`;
      } finally {
        hideLoading();
        saveDraftBtn.disabled = false;
      }
    });
  }

  function renderResults(data) {
    resultsSection.hidden = false;

    const platformNames = {
      facebook: 'Facebook',
      wordpress: 'WordPress',
      google_drive: 'Google Drive',
      google_sheets: 'Google Sheets',
    };

    const platformIcons = {
      facebook: '📘',
      wordpress: '📝',
      google_drive: '📁',
      google_sheets: '📊',
    };

    let html = '';

    data.results.forEach((r) => {
      const iconCls = r.success ? 'result-card__icon--success' : 'result-card__icon--error';
      const icon = r.success ? '✅' : '❌';
      const name = platformNames[r.platform] || r.platform;
      const emoji = platformIcons[r.platform] || '📦';

      let detail = r.success ? 'Success' : (r.error || 'Failed');
      let link = '';

      if (r.url) link = `<a href="${r.url}" target="_blank" class="result-card__link">Open →</a>`;
      if (r.editUrl) link = `<a href="${r.editUrl}" target="_blank" class="result-card__link">Edit Draft →</a>`;
      if (r.folderLink) link = `<a href="${r.folderLink}" target="_blank" class="result-card__link">Open Folder →</a>`;
      if (r.dryRun) detail = 'Dry run — no real action taken';

      if (r.results && r.results.length > 0) {
        r.results.forEach((sub) => {
          const subIcon = sub.success ? '✅' : '❌';
          const subIconCls = sub.success ? 'result-card__icon--success' : 'result-card__icon--error';
          const subDetail = sub.success ? (sub.dryRun ? 'Dry run' : 'Success') : (sub.error || 'Failed');
          const subLabel = sub.pageId || sub.type || sub.fileName || '';
          let subLink = '';
          if (sub.url) subLink = `<a href="${sub.url}" target="_blank" class="result-card__link">Open →</a>`;
          if (sub.webViewLink) subLink = `<a href="${sub.webViewLink}" target="_blank" class="result-card__link">Open →</a>`;

          html += `
            <div class="result-card">
              <div class="result-card__icon ${subIconCls}">${subIcon}</div>
              <div class="result-card__info">
                <div class="result-card__platform">${emoji} ${name} — ${escapeHtml(subLabel)}</div>
                <div class="result-card__detail">${escapeHtml(subDetail)}</div>
              </div>
              ${subLink}
            </div>`;
        });
      } else {
        html += `
          <div class="result-card">
            <div class="result-card__icon ${iconCls}">${icon}</div>
            <div class="result-card__info">
              <div class="result-card__platform">${emoji} ${name}</div>
              <div class="result-card__detail">${escapeHtml(detail)}</div>
            </div>
            ${link}
          </div>`;
      }
    });

    html += `<div style="text-align:center;color:var(--text-dim);font-size:0.8rem;margin-top:8px;">Completed in ${data.elapsed}</div>`;
    resultsContent.innerHTML = html;
  }

  // ---- Guidelines Modal ----
  guidelinesBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/guidelines');
      const data = await res.json();
      guidelinesEditor.value = data.content || '';
      guidelinesModal.hidden = false;
    } catch (err) {
      showToast('Failed to load guidelines', 'error');
    }
  });

  closeModal.addEventListener('click', () => { guidelinesModal.hidden = true; });
  guidelinesModal.querySelector('.modal__backdrop').addEventListener('click', () => { guidelinesModal.hidden = true; });

  saveGuidelines.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/guidelines', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: guidelinesEditor.value }),
      });
      const data = await res.json();
      if (data.success) {
        showToast('Brand guidelines saved!', 'success');
        guidelinesModal.hidden = true;
      } else {
        throw new Error(data.error);
      }
    } catch (err) {
      showToast(`Save failed: ${err.message}`, 'error');
    }
  });

  // ---- Helpers ----
  function getSelectedPlatforms() {
    const platforms = ['facebook'];
    if (document.getElementById('platDrive')?.checked) platforms.push('drive');
    return platforms;
  }

  async function checkHealth() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      if (data.dryRun) {
        statusBadge.textContent = 'Dry Run';
        statusBadge.className = 'badge badge--info';
      } else {
        statusBadge.textContent = 'Live';
        statusBadge.className = 'badge badge--success';
      }
    } catch {
      statusBadge.textContent = 'Offline';
      statusBadge.className = 'badge badge--error';
    }
  }

  function showLoading(text) {
    loadingText.textContent = text || 'Processing...';
    loadingOverlay.hidden = false;
  }

  function hideLoading() { loadingOverlay.hidden = true; }

  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(40px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
