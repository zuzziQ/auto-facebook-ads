(() => {
  let targets = [],
    rules = [],
    funnelTargets = {};
  const workspaceId = localStorage.getItem("workspaceId") || "1";
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const status = (id, text, ok) => {
    const e = document.getElementById(id);
    e.textContent = text;
    e.className = `status ${ok ? "ok" : "fail"}`;
  };
  const funnelFields = [
    ["daily_budget", "Ngân sách/ngày", "VNĐ"], ["cost_per_message_max", "Cost/Mess tối đa", "VNĐ"],
    ["messages_min", "Mess tối thiểu/ngày", "Số lượng"], ["messages_max", "Mess kỳ vọng/ngày", "Số lượng"],
    ["qualified_leads_min", "Lead đủ ĐK tối thiểu/ngày", "CRM"], ["qualified_leads_max", "Lead đủ ĐK kỳ vọng/ngày", "CRM"],
    ["bookings_min", "Đặt lịch tối thiểu/ngày", "CRM"], ["bookings_max", "Đặt lịch kỳ vọng/ngày", "CRM"],
    ["shows_min", "Khách đến tối thiểu/ngày", "CRM"], ["shows_max", "Khách đến kỳ vọng/ngày", "CRM"],
    ["purchases_min", "Purchase tối thiểu/ngày", "Số lượng"], ["cost_per_purchase_max", "Cost/Purchase tối đa", "VNĐ"],
    ["revenue_min", "Doanh thu tối thiểu/ngày", "CRM"], ["roas_min", "ROAS tối thiểu", "CRM"],
  ];
  function renderFunnel() {
    document.getElementById("funnelTargets").innerHTML = funnelFields.map(([key,label,note]) =>
      `<div class="funnel-field"><label class="label">${label}</label><input class="input" type="number" min="0" step="${key === "roas_min" ? "0.1" : "1"}" value="${funnelTargets[key] ?? ""}" placeholder="Để trống nếu chưa có" oninput="funnelTargets['${key}']=this.value"><small>${note}</small></div>`).join("");
  }
  function renderTargets() {
    document.getElementById("targets").innerHTML = targets
      .map(
        (x, i) =>
          `<div class="target-row"><div><label class="label">Dịch vụ</label><input class="input" value="${esc(x.service)}" oninput="reportTargets[${i}].service=this.value"></div><div><label class="label">CPMess mục tiêu</label><input class="input" type="number" min="10000" step="1000" value="${Number(x.target_cpmess || 0)}" oninput="reportTargets[${i}].target_cpmess=this.value"></div><button class="remove" onclick="reportTargets.splice(${i},1);renderReportTargets()">✕</button></div>`,
      )
      .join("");
  }
  function renderRules() {
    document.getElementById("rules").innerHTML = rules
      .map(
        (x, i) =>
          `<div class="rule-row"><div><label class="label">Loại</label><select class="input" onchange="reportRules[${i}].kind=this.value"><option value="service" ${x.kind === "service" ? "selected" : ""}>Dịch vụ</option><option value="operator" ${x.kind === "operator" ? "selected" : ""}>Người chạy</option></select></div><div><label class="label">Prefix</label><input class="input" value="${esc(x.prefix)}" oninput="reportRules[${i}].prefix=this.value"></div><div><label class="label">Tên hiển thị</label><input class="input" value="${esc(x.label)}" oninput="reportRules[${i}].label=this.value"></div><div><label class="label">Ưu tiên</label><input class="input" type="number" value="${Number(x.priority || 0)}" oninput="reportRules[${i}].priority=this.value"></div><button class="remove" onclick="reportRules.splice(${i},1);renderReportRules()">✕</button></div>`,
      )
      .join("");
  }
  window.renderReportTargets = renderTargets;
  window.renderReportRules = renderRules;
  async function load() {
    const [a, b, c] = await Promise.all([
      fetch(`/api/ads/cpmess-targets?workspaceId=${workspaceId}`).then((r) =>
        r.json(),
      ),
      fetch(`/api/ads/classification-rules?workspaceId=${workspaceId}`).then(
        (r) => r.json(),
      ),
      fetch(`/api/ads/funnel-targets?workspaceId=${workspaceId}`).then((r) => r.json()),
    ]);
    targets = a.data || [];
    rules = b.data || [];
    funnelTargets = c.data || {};
    delete funnelTargets.updated_at;
    window.reportTargets = targets;
    window.reportRules = rules;
    window.funnelTargets = funnelTargets;
    renderTargets();
    renderRules();
    renderFunnel();
  }
  document.getElementById("addTarget").onclick = () => {
    targets.push({ service: "", target_cpmess: 150000 });
    renderTargets();
  };
  document.getElementById("addService").onclick = () => {
    rules.push({ kind: "service", prefix: "", label: "", priority: 10 });
    renderRules();
  };
  document.getElementById("addOperator").onclick = () => {
    rules.push({ kind: "operator", prefix: "", label: "", priority: 10 });
    renderRules();
  };
  document.getElementById("saveTargets").onclick = async () => {
    try {
      const r = await fetch("/api/ads/cpmess-targets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId, targets }),
        }),
        d = await r.json();
      if (!r.ok) throw Error(d.error);
      status("targetStatus", "Đã lưu CPMess mục tiêu cho profile này.", true);
    } catch (e) {
      status("targetStatus", e.message, false);
    }
  };
  document.getElementById("saveRules").onclick = async () => {
    try {
      const r = await fetch("/api/ads/classification-rules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId, rules }),
        }),
        d = await r.json();
      if (!r.ok) throw Error(d.error);
      status("ruleStatus", "Đã lưu quy tắc phân loại cho profile này.", true);
    } catch (e) {
      status("ruleStatus", e.message, false);
    }
  };
  document.getElementById("saveFunnelTargets").onclick = async () => {
    try {
      const r = await fetch("/api/ads/funnel-targets", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({workspaceId,targets:funnelTargets})});
      const d = await r.json(); if (!r.ok) throw Error(d.error);
      funnelTargets = d.data || {}; window.funnelTargets = funnelTargets; renderFunnel();
      status("funnelStatus", "Đã lưu mục tiêu phễu riêng cho profile này.", true);
    } catch (e) { status("funnelStatus", e.message, false); }
  };
  load().catch((e) => status("ruleStatus", e.message, false));
})();
