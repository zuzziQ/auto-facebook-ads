/**
 * Settings Page — Frontend Logic
 */
(function () {
  let currentSettings = {};
  let fbPages = [];
  let workspaceAccounts=[];
  let workspacePages=[];
  let cpmessTargets=[];
  let classificationRules=[];

  function renderCpmessTargets(){const el=document.getElementById('cpmessTargets');el.innerHTML=cpmessTargets.map((item,i)=>`<div class="target-row"><div><label class="form-label">Dịch vụ</label><input class="form-input" value="${escHtml(item.service||'')}" placeholder="Ví dụ: U máu" oninput="cpmessTargets[${i}].service=this.value"></div><div><label class="form-label">CPMess mục tiêu (VNĐ)</label><input type="number" min="10000" step="1000" class="form-input" value="${Number(item.target_cpmess||0)}" oninput="cpmessTargets[${i}].target_cpmess=this.value"></div><button class="btn--remove" onclick="cpmessTargets.splice(${i},1);renderCpmessTargets()">✕</button></div>`).join('');}
  async function loadCpmessTargets(){try{const data=await fetch('/api/ads/cpmess-targets').then(r=>r.json());cpmessTargets=data.data||[];window.cpmessTargets=cpmessTargets;renderCpmessTargets();}catch(e){console.error(e)}}
  window.cpmessTargets=cpmessTargets;window.renderCpmessTargets=renderCpmessTargets;
  function renderClassificationRules(){document.getElementById('classificationRules').innerHTML=classificationRules.map((item,i)=>`<div class="rule-row"><div><label class="form-label">Loại</label><select class="form-input" onchange="classificationRules[${i}].kind=this.value"><option value="service" ${item.kind==='service'?'selected':''}>Dịch vụ</option><option value="operator" ${item.kind==='operator'?'selected':''}>Người chạy</option></select></div><div><label class="form-label">Prefix trong Ad Name</label><input class="form-input" value="${escHtml(item.prefix||'')}" placeholder="nam_ / minhlq_" oninput="classificationRules[${i}].prefix=this.value"></div><div><label class="form-label">Tên hiển thị</label><input class="form-input" value="${escHtml(item.label||'')}" placeholder="Nám / Minh LQ" oninput="classificationRules[${i}].label=this.value"></div><div><label class="form-label">Ưu tiên</label><input type="number" class="form-input" value="${Number(item.priority||0)}" oninput="classificationRules[${i}].priority=this.value"></div><button class="btn--remove" onclick="classificationRules.splice(${i},1);renderClassificationRules()">✕</button></div>`).join('')}
  async function loadClassificationRules(){try{const data=await fetch('/api/ads/classification-rules').then(r=>r.json());classificationRules=data.data||[];window.classificationRules=classificationRules;renderClassificationRules()}catch(e){console.error(e)}}
  window.classificationRules=classificationRules;window.renderClassificationRules=renderClassificationRules;

  async function loadWorkspaces() {
    const data=await fetch('/api/workspaces').then(r=>r.json());
    const list=document.getElementById('workspaceList');
    list.innerHTML=(data.workspaces||[]).map(w=>`<div class="workspace-item"><div class="workspace-profile"><span class="workspace-profile-avatar" style="--profile-color:${escHtml(w.profile_color||'#38bdf8')}">${escHtml(w.avatar_emoji||'🏢')}</span><div><b>${escHtml(w.name)}</b><div class="field-help">${w.account_count} Ad Account · ${w.page_count} Page</div></div></div><div style="display:flex;gap:.4rem"><button class="btn btn--ghost btn--sm" onclick="window.editWorkspace(${w.id})">Sửa</button><button class="btn btn--ghost btn--sm" onclick="window.removeWorkspace(${w.id},'${escHtml(w.name).replace(/'/g,'&#39;')}')">Xóa</button></div></div>`).join('')||'<div class="field-help">Chưa có profile doanh nghiệp.</div>';
  }

  function renderWorkspaceAssets() {
    document.getElementById('workspaceAccounts').innerHTML=workspaceAccounts.map((a,i)=>`<div class="asset-row" style="grid-template-columns:1fr 1fr auto"><input class="form-input" value="${escHtml(a.accountId||'')}" placeholder="act_..." oninput="workspaceAccounts[${i}].accountId=this.value"><input class="form-input" value="${escHtml(a.name||'')}" placeholder="Tên tài khoản" oninput="workspaceAccounts[${i}].name=this.value"><button class="btn--remove" onclick="workspaceAccounts.splice(${i},1);renderWorkspaceAssets()">✕</button></div>`).join('');
    document.getElementById('workspacePages').innerHTML=workspacePages.map((p,i)=>`<div class="asset-row"><input class="form-input" value="${escHtml(p.name||'')}" placeholder="Tên Page" oninput="workspacePages[${i}].name=this.value"><input class="form-input" value="${escHtml(p.pageId||'')}" placeholder="Page ID" oninput="workspacePages[${i}].pageId=this.value"><input type="password" class="form-input" value="${escHtml(p.accessToken||'')}" placeholder="Page Token" oninput="workspacePages[${i}].accessToken=this.value"><button class="btn--remove" onclick="workspacePages.splice(${i},1);renderWorkspaceAssets()">✕</button></div>`).join('');
  }
  window.workspaceAccounts=workspaceAccounts; window.workspacePages=workspacePages; window.renderWorkspaceAssets=renderWorkspaceAssets;
  function openWorkspaceEditor(workspace={}) {
    document.getElementById('workspaceEditor').style.display='block';
    document.getElementById('workspaceEditorTitle').textContent=workspace.id?`Sửa: ${workspace.name}`:'Thêm doanh nghiệp mới';
    document.getElementById('workspaceId').value=workspace.id||''; document.getElementById('workspaceName').value=workspace.name||''; document.getElementById('workspaceBusinessId').value=workspace.business_id||'';document.getElementById('workspaceAvatarEmoji').value=workspace.avatar_emoji||'🏢';document.getElementById('workspaceProfileColor').value=workspace.profile_color||'#38bdf8';document.getElementById('workspaceProfilePin').value='';document.getElementById('workspaceProfilePin').placeholder=workspace.has_pin?'Đã có PIN · nhập PIN mới để đổi':'Tạo PIN cho profile'; document.getElementById('workspaceAdsToken').value=workspace.ads_access_token||'';document.getElementById('workspaceAdsToken').placeholder=workspace.has_ads_access_token?'Đã lưu an toàn · nhập token mới để thay đổi':'EAAB...';
    workspaceAccounts=(workspace.adAccounts||[]).map(a=>({accountId:a.account_id,name:a.name||''})); workspacePages=(workspace.pages||[]).map(p=>({pageId:p.page_id,name:p.name||'',accessToken:p.access_token||''}));
    window.workspaceAccounts=workspaceAccounts;window.workspacePages=workspacePages;renderWorkspaceAssets();
  }
  window.editWorkspace=async id=>{const data=await fetch(`/api/workspaces/${id}`).then(r=>r.json());openWorkspaceEditor(data.workspace||{});};
  window.removeWorkspace=async(id,name)=>{if(!confirm(`Ẩn doanh nghiệp “${name}”? Dữ liệu quảng cáo không bị xóa.`))return;await fetch(`/api/workspaces/${id}`,{method:'DELETE'});if(String(localStorage.getItem('workspaceId'))===String(id))localStorage.removeItem('workspaceId');loadWorkspaces();};

  // ---- Load Settings ----
  async function loadSettings() {
    try {
      const res = await fetch('/api/settings');
      currentSettings = await res.json();

      document.getElementById('geminiApiKey').value = currentSettings.geminiApiKey || '';
      document.getElementById('geminiApiKey').placeholder=currentSettings.hasGeminiApiKey?'Đã lưu an toàn · nhập khóa mới để thay đổi':'AIzaSy...';
      document.getElementById('fbAppId').value = currentSettings.facebookAppId || '';
      document.getElementById('fbAppSecret').value = currentSettings.facebookAppSecret || '';
      document.getElementById('facebookAdAccountIds').value = currentSettings.facebookAdAccountIds || '';
      document.getElementById('facebookAdsAccessToken').value = currentSettings.facebookAdsAccessToken || '';
      document.getElementById('facebookAdsAccessToken').placeholder=currentSettings.hasFacebookAdsAccessToken?'Đã lưu an toàn · nhập token mới để thay đổi':'EAAB...';
      document.getElementById('facebookApiVersion').value = currentSettings.facebookApiVersion || 'v23.0';
      document.getElementById('wpUrl').value = currentSettings.wordpressUrl || '';
      document.getElementById('wpUsername').value = currentSettings.wordpressUsername || '';
      document.getElementById('wpAppPassword').value = currentSettings.wordpressAppPassword || '';
      document.getElementById('driveFolderId').value = currentSettings.googleDriveFolderId || '';
      document.getElementById('sheetsId').value = currentSettings.googleSheetsSpreadsheetId || '';
      document.getElementById('sheetsName').value = currentSettings.googleSheetsSheetName || 'master';

      // Parse FB pages from comma-separated strings
      const ids = (currentSettings.facebookPageIds || '').split(',').filter(Boolean);
      const tokens = (currentSettings.facebookPageTokens || '').split(',').filter(Boolean);
      const names = (currentSettings.facebookPageNames || '').split(',').filter(Boolean);
      fbPages = ids.map((id, i) => ({ id: id.trim(), token: (tokens[i] || '').trim(), name: (names[i] || '').trim() }));
      if (fbPages.length === 0) fbPages = [{ id: '', token: '', name: '' }];
      renderFbPages();
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  }

  // ---- FB Page Dynamic List ----
  function renderFbPages() {
    const container = document.getElementById('fbPagesList');
    container.innerHTML = '';

    fbPages.forEach((page, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 2fr auto;gap:.6rem;align-items:end;margin-bottom:.75rem;';
      row.innerHTML = `
        <div>
          <label class="form-label" style="font-size:.7rem">Page Name</label>
          <input type="text" class="form-input fb-name" data-i="${i}" value="${escHtml(page.name)}" placeholder="Aeslatek Fanpage">
        </div>
        <div>
          <label class="form-label" style="font-size:.7rem">Page ID</label>
          <input type="text" class="form-input fb-id" data-i="${i}" value="${escHtml(page.id)}" placeholder="103001749...">
        </div>
        <div>
          <label class="form-label" style="font-size:.7rem">Access Token</label>
          <input type="password" class="form-input fb-token" data-i="${i}" value="${escHtml(page.token)}" placeholder="EAAVZBl...">
        </div>
        <div style="display:flex;gap:.4rem;align-items:flex-end;margin-bottom:.05rem">
          <button class="btn btn--secondary btn--sm fb-test-btn" data-i="${i}" style="height:42px;white-space:nowrap">Test</button>
          ${fbPages.length > 1 ? `<button class="btn--remove fb-remove-btn" data-i="${i}" title="Remove">✕</button>` : ''}
        </div>
      `;
      container.appendChild(row);

      const testResult = document.createElement('div');
      testResult.className = 'test-result';
      testResult.id = `fbResult-${i}`;
      container.appendChild(testResult);
    });

    // Bind change events
    container.querySelectorAll('.fb-name').forEach((el) => el.addEventListener('input', (e) => { fbPages[+e.target.dataset.i].name = e.target.value; }));
    container.querySelectorAll('.fb-id').forEach((el) => el.addEventListener('input', (e) => { fbPages[+e.target.dataset.i].id = e.target.value; }));
    container.querySelectorAll('.fb-token').forEach((el) => el.addEventListener('input', (e) => { fbPages[+e.target.dataset.i].token = e.target.value; }));

    container.querySelectorAll('.fb-test-btn').forEach((btn) => btn.addEventListener('click', async (e) => {
      const i = +e.target.dataset.i;
      const token = fbPages[i].token;
      const resultEl = document.getElementById(`fbResult-${i}`);
      showResult(resultEl, 'Testing...', null);
      try {
        const res = await fetch('/api/test/facebook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
        const data = await res.json();
        showResult(resultEl, data.message, data.success);
      } catch (err) { showResult(resultEl, err.message, false); }
    }));

    container.querySelectorAll('.fb-remove-btn').forEach((btn) => btn.addEventListener('click', (e) => {
      fbPages.splice(+e.target.dataset.i, 1);
      renderFbPages();
    }));
  }

  document.getElementById('addFbPage').addEventListener('click', () => {
    fbPages.push({ id: '', token: '', name: '' });
    renderFbPages();
  });

  document.getElementById('newWorkspace').addEventListener('click',()=>openWorkspaceEditor());
  document.getElementById('cancelWorkspace').addEventListener('click',()=>document.getElementById('workspaceEditor').style.display='none');
  document.getElementById('addWorkspaceAccount').addEventListener('click',()=>{workspaceAccounts.push({accountId:'',name:''});window.workspaceAccounts=workspaceAccounts;renderWorkspaceAssets();});
  document.getElementById('addWorkspacePage').addEventListener('click',()=>{workspacePages.push({pageId:'',name:'',accessToken:''});window.workspacePages=workspacePages;renderWorkspaceAssets();});
  document.getElementById('saveWorkspace').addEventListener('click',async()=>{
    const result=document.getElementById('workspaceResult');const button=document.getElementById('saveWorkspace');button.disabled=true;button.textContent='⏳ Đang lưu...';showResult(result,'Đang lưu...',null);
    try {
      const response=await fetch('/api/workspaces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:document.getElementById('workspaceId').value,name:document.getElementById('workspaceName').value,businessId:document.getElementById('workspaceBusinessId').value,avatarEmoji:document.getElementById('workspaceAvatarEmoji').value,profileColor:document.getElementById('workspaceProfileColor').value,profilePin:document.getElementById('workspaceProfilePin').value,adsAccessToken:document.getElementById('workspaceAdsToken').value,adAccounts:workspaceAccounts,pages:workspacePages})});
      const data=await response.json();if(!response.ok||!data.success)throw new Error(data.error||'Không lưu được doanh nghiệp');
      showResult(result,'✅ Đã lưu doanh nghiệp. Dashboard sẽ chuyển sang workspace này.',true);localStorage.setItem('workspaceId',data.id);await loadWorkspaces();document.getElementById('workspaceId').value=data.id;document.getElementById('workspaceEditorTitle').textContent=`Sửa: ${document.getElementById('workspaceName').value}`;
    } catch(error) { showResult(result,`❌ ${error.message}`,false); }
    finally { button.disabled=false;button.textContent='💾 Lưu doanh nghiệp'; }
  });

  document.getElementById('toggleAdsToken').addEventListener('click', () => {
    const input=document.getElementById('facebookAdsAccessToken');
    input.type=input.type==='password'?'text':'password';
  });

  document.getElementById('testFacebookAds').addEventListener('click', async () => {
    const resultEl=document.getElementById('facebookAdsResult');
    showResult(resultEl,'Đang kiểm tra quyền truy cập...',null);
    try {
      const res=await fetch('/api/test/facebook-ads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        adAccountIds:document.getElementById('facebookAdAccountIds').value,
        accessToken:document.getElementById('facebookAdsAccessToken').value,
        apiVersion:document.getElementById('facebookApiVersion').value
      })});
      const data=await res.json();
      showResult(resultEl,data.message,data.success);
    } catch(err) { showResult(resultEl,err.message,false); }
  });

  // ---- Get Permanent Tokens ----
  document.getElementById('getPermTokensBtn').addEventListener('click', async () => {
    const appId = document.getElementById('fbAppId').value.trim();
    const appSecret = document.getElementById('fbAppSecret').value.trim();
    const shortToken = fbPages[0]?.token?.trim();
    const resultEl = document.getElementById('fbResult');

    if (!appId || !appSecret) {
      showResult(resultEl, '❌ Please fill in App ID and App Secret first', false);
      return;
    }
    if (!shortToken) {
      showResult(resultEl, '❌ Please add at least one page token first', false);
      return;
    }

    showResult(resultEl, '🔄 Exchanging tokens... (takes a few seconds)', null);

    try {
      const res = await fetch('/api/facebook/exchange-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, appSecret, shortToken }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || 'Exchange failed');

      // Auto-fill page fields with permanent tokens
      fbPages = data.pages.map(p => ({ id: p.id, token: p.access_token, name: p.name }));
      renderFbPages();
      showResult(resultEl, `✅ Got ${data.pages.length} permanent page token(s)! Click Save to store them.`, true);
    } catch (err) {
      showResult(resultEl, `❌ ${err.message}`, false);
    }
  });

  // ---- Test buttons ----
  document.getElementById('testGemini').addEventListener('click', async () => {
    const resultEl = document.getElementById('geminiResult');
    showResult(resultEl, 'Testing...', null);
    try {
      const res = await fetch('/api/test/gemini', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: document.getElementById('geminiApiKey').value }) });
      const data = await res.json();
      showResult(resultEl, data.message, data.success);
    } catch (err) { showResult(resultEl, err.message, false); }
  });

  document.getElementById('testWp').addEventListener('click', async () => {
    const resultEl = document.getElementById('wpResult');
    showResult(resultEl, 'Testing...', null);
    try {
      const res = await fetch('/api/test/wordpress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: document.getElementById('wpUrl').value,
          username: document.getElementById('wpUsername').value,
          appPassword: document.getElementById('wpAppPassword').value,
        }),
      });
      const data = await res.json();
      showResult(resultEl, data.message, data.success);
    } catch (err) { showResult(resultEl, err.message, false); }
  });

  // ---- Save Settings ----
  document.getElementById('saveSettings').addEventListener('click', async () => {
    const overlay = document.getElementById('loadingOverlay');
    const loadingText = document.getElementById('loadingText');
    const saveStatus = document.getElementById('saveStatus');
    overlay.style.display = 'flex';
    loadingText.textContent = 'Saving settings...';

    try {
      const body = {
        geminiApiKey: document.getElementById('geminiApiKey').value,
        facebookAppId: document.getElementById('fbAppId').value,
        facebookAppSecret: document.getElementById('fbAppSecret').value,
        facebookAdAccountIds: document.getElementById('facebookAdAccountIds').value,
        facebookAdsAccessToken: document.getElementById('facebookAdsAccessToken').value,
        facebookApiVersion: document.getElementById('facebookApiVersion').value,
        facebookPageIds: fbPages.map((p) => p.id).join(','),
        facebookPageTokens: fbPages.map((p) => p.token).join(','),
        facebookPageNames: fbPages.map((p) => p.name).join(','),
        wordpressUrl: document.getElementById('wpUrl').value,
        wordpressUsername: document.getElementById('wpUsername').value,
        wordpressAppPassword: document.getElementById('wpAppPassword').value,
        googleDriveFolderId: document.getElementById('driveFolderId').value,
        googleSheetsSpreadsheetId: document.getElementById('sheetsId').value,
        googleSheetsSheetName: document.getElementById('sheetsName').value,
      };

      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      saveStatus.textContent = data.success ? '✅ Saved successfully!' : `❌ ${data.error || 'Save failed'}`;
      saveStatus.className = 'save-status ' + (data.success ? 'ok' : 'fail');
    } catch (err) {
      document.getElementById('saveStatus').textContent = `❌ ${err.message}`;
      document.getElementById('saveStatus').className = 'save-status fail';
    } finally {
      overlay.style.display = 'none';
    }
  });

  // ---- Helpers ----
  function showResult(el, message, success) {
    el.style.display = 'block';
    el.textContent = message;
    el.className = 'test-result ' + (success === null ? '' : success ? 'test-result--ok' : 'test-result--fail');
  }

  function escHtml(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(str || ''));
    return d.innerHTML;
  }

  // Init
  loadSettings();
  loadWorkspaces();
})();
