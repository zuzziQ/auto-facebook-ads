const axios = require('axios');
const crypto = require('crypto');
const { config } = require('../config');
const logger = require('../utils/logger');

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

function fixNewlinesInJSONStrings(text) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }

    if (inString) {
      if (ch === '\n') { result += '\\n'; continue; }
      if (ch === '\r') { result += '\\r'; continue; }
      if (ch === '\t') { result += '\\t'; continue; }
    }

    result += ch;
  }

  return result;
}

function extractJSONFromResponse(responseData) {
  const parts = responseData.candidates?.[0]?.content?.parts || [];
  let fullText = '';
  for (const part of parts) {
    if (part.thought === true) continue;
    fullText += (part.text || '');
  }

  const text = fullText.trim();
  if (!text) {
    throw new Error('No valid JSON found: empty text parts');
  }

  try {
    return JSON.parse(text);
  } catch (e) {
  }

  try {
    const fixed = fixNewlinesInJSONStrings(text);
    return JSON.parse(fixed);
  } catch (e) {
  }

  try {
    const stripped = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const fixed = fixNewlinesInJSONStrings(stripped);
    return JSON.parse(fixed);
  } catch (e) {
  }

  throw new Error('No valid JSON found in any response part');
}

function describeTargetingSnippet(t = {}) {
  if (!t || typeof t !== 'object') return 'Tệp không xác định';
  if (typeof t === 'string') {
    try { t = JSON.parse(t); } catch (_) { return t; }
  }
  const specs = Array.isArray(t.flexible_spec) ? t.flexible_spec : [];
  const interests = specs.flatMap(x => x.interests || []).map(x => x.name || x.id).filter(Boolean);
  const geo = t.geo_locations || {};

  const places = [...(geo.places || []), ...(geo.custom_locations || [])].map(x => {
    const lat = Number(x.latitude), lng = Number(x.longitude);
    const name = x.name || x.address || (!isNaN(lat) && !isNaN(lng) && x.latitude !== undefined && x.longitude !== undefined ? `Ghim (${lat.toFixed(2)}, ${lng.toFixed(2)})` : '');
    const radius = x.radius ? ` (+${x.radius}${x.distance_unit === 'kilometer' || x.distance_unit === 'km' ? 'km' : (x.distance_unit || 'km')})` : '';
    return name ? `${name}${radius}` : '';
  }).filter(Boolean);

  const cities = (geo.cities || []).map(x => (typeof x === 'string' ? x : x.name || x.key)).filter(Boolean);
  const regions = (geo.regions || []).map(x => (typeof x === 'string' ? x : x.name || x.key)).filter(Boolean);
  const countries = (geo.countries || []).map(x => (typeof x === 'string' ? x : x.name || x.key || String(x))).filter(Boolean);

  let locationSummary = 'Toàn quốc';
  if (places.length > 0) {
    locationSummary = `Thả ghim bán kính: ${places.join(', ')}`;
  } else if (cities.length > 0 || regions.length > 0) {
    locationSummary = [...cities, ...regions].join(', ');
  } else if (countries.length > 0) {
    locationSummary = countries.includes('VN') ? 'Toàn quốc (Việt Nam)' : countries.join(', ');
  }

  const age = `${t.age_min || 18}–${t.age_max || 65}`;
  const gender = (t.genders || []).length === 1 ? (t.genders[0] === 2 ? 'Nữ' : 'Nam') : 'Tất cả giới tính';
  return `${gender}, ${age} tuổi; Vị trí: ${locationSummary}${interests.length ? `; Sở thích: ${interests.slice(0, 5).join(', ')}` : '; Broad'}`;
}

function inspectTargetingRadius(targeting) {
  let t = targeting;
  if (typeof t === 'string') {
    try { t = JSON.parse(t); } catch (_) { return { hasPin: false, minRadius: null, isNarrow: false }; }
  }
  if (!t || typeof t !== 'object') return { hasPin: false, minRadius: null, isNarrow: false };
  const geo = t.geo_locations || {};
  const places = [...(geo.places || []), ...(geo.custom_locations || [])];
  if (!places.length) return { hasPin: false, minRadius: null, isNarrow: false };

  let minRadius = Infinity;
  for (const p of places) {
    if (p.radius !== undefined && p.radius !== null) {
      const r = Number(p.radius);
      if (!isNaN(r) && r < minRadius) {
        minRadius = r;
      }
    }
  }
  return {
    hasPin: true,
    minRadius: minRadius === Infinity ? null : minRadius,
    isNarrow: minRadius !== Infinity && minRadius <= 2
  };
}

// Bảng tích lũy % ngân sách kỳ vọng theo từng giờ (từ 0h đến 24h) cho ngành dịch vụ/clinic
const HOURLY_CUMULATIVE_PACING = [
  0,    // 00:00
  0.5,  // 01:00
  1.0,  // 02:00
  1.5,  // 03:00
  2.0,  // 04:00
  2.5,  // 05:00
  3.5,  // 06:00
  5.5,  // 07:00
  8.5,  // 08:00
  12.0, // 09:00
  16.5, // 10:00
  22.0, // 11:00
  30.0, // 12:00 (Bắt đầu Peak 1 trưa)
  38.0, // 13:00
  44.0, // 14:00 (Kết thúc Peak 1 trưa)
  49.5, // 15:00
  55.0, // 16:00
  61.0, // 17:00
  67.5, // 18:00
  75.0, // 19:00 (Bắt đầu Peak 2 tối)
  83.0, // 20:00
  90.0, // 21:00
  95.5, // 22:00
  98.5, // 23:00
  100   // 24:00
];

function getExpectedPacingPct(hourVn, minuteVn) {
  const h = Math.max(0, Math.min(23, Number(hourVn) || 0));
  const m = Math.max(0, Math.min(59, Number(minuteVn) || 0));
  const start = HOURLY_CUMULATIVE_PACING[h];
  const end = HOURLY_CUMULATIVE_PACING[h + 1];
  const frac = m / 60;
  return Math.round((start + (end - start) * frac) * 10) / 10;
}

const HOURLY_DISTRIBUTION_GUIDE = {
  peak_hours: [
    { label: "Nghỉ trưa (Peak 1)", range: "11:30 – 13:30", spend_share_pct: 20, mess_share_pct: 25 },
    { label: "Giờ vàng tối (Peak 2)", range: "19:30 – 22:30", spend_share_pct: 32, mess_share_pct: 45 }
  ],
  lull_hours: { label: "Thấp điểm đêm/sáng sớm", range: "00:00 – 07:00", spend_share_pct: 5 },
  hourly_curve: HOURLY_CUMULATIVE_PACING.slice(0, 24).map((val, idx) => Math.round((HOURLY_CUMULATIVE_PACING[idx + 1] - val) * 10) / 10)
};

function evaluateBudgetPacing({
  dailyBudget = 0,
  lifetimeBudget = 0,
  todaySpend = 0,
  spend7d = 0,
  ctr7d = 0,
  frequency7d = 0,
  targeting = null,
  currentHourVn = null,
  currentMinuteVn = null,
  expectedPacingPct = null
}) {
  const now = new Date();
  const hourVn = (currentHourVn !== null && currentHourVn !== undefined)
    ? Number(currentHourVn)
    : (now.getUTCHours() + 7) % 24;
  const minuteVn = (currentMinuteVn !== null && currentMinuteVn !== undefined)
    ? Number(currentMinuteVn)
    : now.getUTCMinutes();
  const expectedPct = (expectedPacingPct !== null && expectedPacingPct !== undefined)
    ? Number(expectedPacingPct)
    : getExpectedPacingPct(hourVn, minuteVn);

  const daily = Number(dailyBudget) || 0;
  const lifetime = Number(lifetimeBudget) || 0;
  const spend = Number(todaySpend) || 0;
  const pacingPct = daily > 0 ? Math.round((spend / daily) * 100) : 0;
  const ctr = Number(ctr7d) || 0;
  const freq = Number(frequency7d) || 0;

  const pinInfo = inspectTargetingRadius(targeting);

  let status = 'ON_TRACK';
  let diagnosis = '';
  let action = '';

  if (daily > 0) {
    const isPeak1 = (hourVn === 11 && minuteVn >= 30) || (hourVn === 12) || (hourVn === 13 && minuteVn <= 30);
    const isPeak2 = (hourVn === 19 && minuteVn >= 30) || (hourVn === 20) || (hourVn === 21) || (hourVn === 22 && minuteVn <= 30);
    const isEarlyMorning = (hourVn < 9 || expectedPct <= 10);
    const timeStr = `${hourVn}h${minuteVn > 0 ? String(minuteVn).padStart(2, '0') + 'p' : ''}`;

    // Đánh giá FAST_BURN: Khi pacingPct >= 40% khi chưa đến 11:00 trưa (đốt ngân sách quá nhanh trong phiên sáng),
    // hoặc tiêu >= 80% trước 17h, hoặc vượt >= 40% so với tiến độ chuẩn (và spend >= 50k).
    const isFastBurn = (hourVn < 11 && pacingPct >= 40)
      || (pacingPct >= 80 && hourVn < 17)
      || (expectedPct > 0 && pacingPct >= Math.round(expectedPct * 1.4) && spend >= 50000 && pacingPct >= 30);

    // Đánh giá UNDER_SPENDING: Trong khung giờ sáng sớm (hourVn < 9 hoặc expectedPct <= 10%),
    // tuyệt đối KHÔNG đánh giá là UNDER_SPENDING trừ khi ad tiêu 0đ khi đã qua 10:00 trưa.
    let isUnderSpending = false;
    if (!isEarlyMorning) {
      if (hourVn >= 10 && spend === 0) {
        isUnderSpending = true;
      } else if (hourVn >= 10 && pacingPct <= Math.round(expectedPct * 0.5)) {
        isUnderSpending = true;
      } else if (pacingPct <= 25 && hourVn >= 14) {
        isUnderSpending = true;
      } else if (hourVn >= 9 && spend > 0 && pacingPct <= Math.round(expectedPct * 0.4)) {
        isUnderSpending = true;
      }
    }

    if (isFastBurn) {
      status = 'FAST_BURN';
      if (hourVn < 11) {
        diagnosis = `Cắn tiền quá nhanh (${pacingPct}% ngân sách lúc ${timeStr}, chuẩn kỳ vọng ${expectedPct}%). Đốt ngân sách quá nhanh trong phiên sáng, nguy cơ "đói tiền" trước các khung giờ vàng trưa (11:30–13:30) và tối (19:30–22:30, chiếm 45% mess).`;
      } else {
        diagnosis = `Cắn tiền quá nhanh (${pacingPct}% ngân sách lúc ${timeStr}, chuẩn kỳ vọng ${expectedPct}%). Tiêu hao ngân sách nhanh (${daily.toLocaleString('vi-VN')}đ/ngày), nguy cơ "đói tiền" trước khung giờ vàng tối 19:30–22:30.`;
      }
      action = 'Đề xuất tăng 15–20% ngân sách trước 18h hoặc cài đặt lịch chạy theo giờ (Dayparting) để giữ nhịp phân phối buổi tối.';
    } else if (isUnderSpending) {
      status = 'UNDER_SPENDING';
      const causes = [];
      const actions = [];

      if (spend === 0 && hourVn >= 10) {
        causes.push(`Đã qua 10:00 trưa nhưng ad tiêu 0đ (kẹt phân phối / không thắng phiên đấu thầu)`);
      }
      if (pinInfo.isNarrow) {
        causes.push(`Tệp thả ghim quá hẹp (+${pinInfo.minRadius}km không đủ volume đấu thầu)`);
        actions.push(`Nới rộng bán kính ghim từ +${pinInfo.minRadius}km lên +3km/+4km`);
      }
      if (ctr > 0 && ctr < 0.8) {
        causes.push(`CTR thấp (${ctr}% < 0.8%) hoặc điểm chất lượng quảng cáo kém khiến Facebook hạn chế phân phối`);
        actions.push('Làm mới visual/hook 3s đầu');
      }
      if (freq >= 2.5) {
        causes.push(`Tần suất Freq cao (${freq}x >= 2.5x) bão hòa tệp`);
        actions.push('Làm mới tệp đối tượng hoặc thay đổi creative mới');
      }
      if (causes.length === 0) {
        causes.push('Trùng lặp đấu thầu (Auction Overlap) giữa các AdSet trong tài khoản hoặc ngưỡng giá thầu thấp');
        actions.push('Nới rộng bán kính ghim từ +2km lên +3km/+4km, làm mới visual/hook, hoặc gộp nhóm adset');
      }
      if (actions.length === 0) {
        actions.push('Nới rộng tệp đối tượng, làm mới content/visual hoặc tăng nhẹ giá thầu');
      }

      diagnosis = `Không cắn tiền / Kẹt phân phối (${pacingPct}% ngân sách lúc ${timeStr}, kỳ vọng chuẩn ${expectedPct}%). Nguyên nhân: ${causes.join('; ')}.`;
      action = `Đề xuất: ${actions.join('; ')}.`;
    } else {
      status = 'ON_TRACK';
      if (isPeak1) {
        diagnosis = `Nhịp độ tiêu tiền tối ưu (${pacingPct}% lúc ${timeStr} so với kỳ vọng ${expectedPct}%). Đang trong khung giờ cao điểm nghỉ trưa (11:30–13:30, chiếm ~25% tin nhắn), hệ thống đang tập trung phân phối hiệu quả.`;
        action = 'Duy trì cấu hình ngân sách hiện tại, sẵn sàng chốt tin nhắn trong phiên trưa.';
      } else if (isPeak2) {
        diagnosis = `Nhịp độ tiêu tiền tối ưu (${pacingPct}% lúc ${timeStr} so với kỳ vọng ${expectedPct}%). Đang trong khung giờ vàng tối (19:30–22:30, chiếm ~45% tin nhắn), ngân sách dồn lực chuyển đổi tốt nhất.`;
        action = 'Duy trì ngân sách và đảm bảo đội ngũ trực chat phản hồi nhanh dưới 5 phút.';
      } else if (isEarlyMorning) {
        diagnosis = `Nhịp độ tiêu tiền chuẩn theo đường cong phân bổ (${pacingPct}% lúc ${timeStr}, kỳ vọng ${expectedPct}%). Khung giờ thấp điểm sáng sớm, hệ thống giữ nhịp ngân sách để dồn vào các khung giờ cao điểm trưa và tối.`;
        action = 'Duy trì cấu hình, không can thiệp tăng giảm ngân sách trong khung giờ thấp điểm.';
      } else {
        diagnosis = `Nhịp độ tiêu tiền cân bằng, bám sát đường cong phân bổ ngành dịch vụ/clinic (${pacingPct}% lúc ${timeStr} so với chuẩn ${expectedPct}%).`;
        action = 'Duy trì cấu hình ngân sách hiện tại và theo dõi định kỳ.';
      }
    }
  } else if (lifetime > 0) {
    status = 'LIFETIME_SCHEDULED';
    diagnosis = 'Quảng cáo chạy theo lịch ngân sách trọn đời (Lifetime Budget) và thuật toán phân phối tự động của Meta.';
    action = 'Theo dõi tiến độ phân phối tổng thể theo thời gian kết thúc của chiến dịch.';
  } else {
    status = 'ON_TRACK';
    diagnosis = 'Quảng cáo đang chạy nhưng chưa gán ngân sách riêng hoặc phụ thuộc ngân sách chiến dịch.';
    action = 'Kiểm tra ngân sách cấp Campaign/AdSet và duy trì theo dõi.';
  }

  return {
    status,
    currentPacingPct: pacingPct,
    pacing_pct: pacingPct,
    expectedPacingPct: expectedPct,
    expected_pacing_pct: expectedPct,
    currentHourVn: hourVn,
    current_hour_vn: hourVn,
    currentMinuteVn: minuteVn,
    current_minute_vn: minuteVn,
    diagnosis,
    pacing_diagnosis: diagnosis,
    action,
    pacing_action: action
  };
}

async function generateRecommendations(insightsData) {
  const prompt = `Bạn là Strategy Director Facebook Ads ngành thẩm mỹ. Phân tích TOÀN BỘ dữ liệu thật bên dưới theo dịch vụ, targeting, ngân sách, creative và hiệu suất:
${JSON.stringify(insightsData, null, 2)}

Mỗi ad có insights hiện tại 7 ngày, recentTrend so sánh 3 ngày gần nhất với 3 ngày trước, history30d và lifetimeSynced. Dùng 7D/3D để quyết định hành động hiện tại; dùng history30d để xác nhận hiệu suất có bền hay chỉ là dao động ngắn; lifetimeSynced chỉ làm bối cảnh lịch sử đã đồng bộ. Không được để thành tích quá khứ phủ nhận tín hiệu xấu gần đây. Nếu 7D trái ngược 30D, phải nêu rõ sự đảo chiều và ưu tiên KEEP/cảnh báo trước khi REDUCE, trừ khi ngưỡng Rule đã vượt rõ.

Đưa ra 4-8 hướng TEST QUẢNG CÁO MỚI, không đưa lệnh tắt/scale từng ad. Mỗi item JSON phải có:
- adSetName: tên dịch vụ hoặc chủ đề chiến lược
- currentPerformance: insight tổng hợp có số liệu làm căn cứ
- strategy: hướng tạo quảng cáo mới
- targetGoal: KPI test rõ ràng
- nextStepIfFailed: phương án vòng test tiếp theo
- angle: angle mới cần thử
- hook: 1 câu hook mẫu
- headline: tiêu đề quảng cáo ngắn
- contentDirection: cấu trúc nội dung đề xuất
- fullContent: một bài quảng cáo tiếng Việt hoàn chỉnh 180-350 từ, có xuống dòng, dùng được ngay, không bịa cam kết y khoa
- cta: lời kêu gọi hành động phù hợp mục tiêu tin nhắn
- creativeFormat: Video/Ảnh/Carousel và mô tả cảnh
- audience: tệp khách hàng đề xuất
- evidenceAds: tối đa 3 tên ad làm căn cứ
- sourceAdId: ID thật của một ad trong dữ liệu đầu vào phù hợp nhất để làm ad gốc; không được tự bịa ID
- suggestedSettings: object gồm { testLevel: "SAME_ADSET"|"NEW_ADSET"|"NEW_CAMPAIGN", ageMin: number, ageMax: number, gender: "ALL"|"FEMALE"|"MALE", location: "VN"|"HN"|"HCM", interests: string[], dailyBudget: number, objective: "OUTCOME_MESSAGES", placement: "ADVANTAGE_PLUS"|"MANUAL", rationale: string }

Chỉ trả JSON array hợp lệ, viết tiếng Việt, không bịa doanh thu hay ROAS.`;

  try {
    const response = await axios.post(
      `${GEMINI_API_URL}?key=${config.gemini.apiKey}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
        },
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 90000,
      }
    );

    return extractJSONFromResponse(response.data);
  } catch (err) {
    logger.error('generateRecommendations failed', { error: err.message });
    throw err;
  }
}

/**
 * Filter and compress ads for LLM analysis.
 * Identifies Top 5-10 critical anomalies/risks and top 2-3 winners.
 * Compresses context into concise snippets to save ~85% tokens.
 */
function filterAndCompressAds(allAds = [], businessTargets = {}) {
  const targetPurchase = Number(businessTargets.cost_per_purchase_max || 0);
  const targetLead = Number(businessTargets.cost_per_lead_max || 0);
  const targetCpmess = Number(businessTargets.cost_per_message_max || 250000);

  const scoredAds = allAds.map(ad => {
    const i = ad.insights || {};
    const spend = Number(i.spend || 0);
    const purchases = Number(i.purchases || 0);
    const leads = Number(i.leads || 0);
    const mess = Number(i.mess || 0);
    const runDays = Number(i.runDays || 0);
    const ctr = Number(i.ctr || 0);
    const freq = Number(i.frequency || 0);
    const cpmess = Number(i.cpmess || (mess > 0 ? Math.round(spend / mess) : 0));
    const cpp = Number(i.costPerPurchase || (purchases > 0 ? Math.round(spend / purchases) : 0));
    const cpl = Number(i.costPerLead || (leads > 0 ? Math.round(spend / leads) : 0));

    let primaryMetric = 'message';
    let primaryCost = cpmess;
    let targetCost = targetCpmess;
    let primaryCount = mess;

    if (purchases > 0) {
      primaryMetric = 'purchase';
      primaryCost = cpp;
      targetCost = targetPurchase || targetCpmess;
      primaryCount = purchases;
    } else if (leads > 0) {
      primaryMetric = 'lead';
      primaryCost = cpl;
      targetCost = targetLead || targetCpmess;
      primaryCount = leads;
    }

    const ratio = (targetCost && primaryCost) ? (primaryCost / targetCost) : null;
    const trend3d = i.recentTrend?.costPerMessage?.changePct ?? null;
    const daysWithMess = Number(i.days_with_mess || i.daysWithMess || 0);
    const messPrev3d = Number(i.mess_prev_3d || i.messPrev3d || i.recentTrend?.messPrev3d || 0);
    const spendPrev3d = Number(i.spend_prev_3d || i.spendPrev3d || i.recentTrend?.spendPrev3d || 0);
    const cpmessPrev3d = Number(i.cpmess_prev_3d || i.cpmessPrev3d || i.recentTrend?.cpmessPrev3d || (messPrev3d > 0 ? Math.round(spendPrev3d / messPrev3d) : 0));
    const todaySpend = Number(i.today_spend || i.todaySpend || i.spendToday || 0);
    const todayMess = Number(i.today_mess || i.todayMess || i.messToday || 0);
    const spend3d = Number(i.spend_3d || i.spend3d || 0);
    const mess3d = Number(i.mess_3d || i.mess3d || 0);

    const hasGoodHistory = (
      daysWithMess >= 3 ||
      messPrev3d >= 2 ||
      (cpmessPrev3d > 0 && cpmessPrev3d <= targetCost * 1.2)
    );

    const isSuddenDip = hasGoodHistory && (
      (todaySpend >= targetCost * 0.8 && todayMess <= 1) ||
      (spend3d >= targetCost * 0.8 && mess3d <= 1 && (daysWithMess >= 3 || messPrev3d >= 2)) ||
      (trend3d !== null && trend3d >= 40)
    );

    let anomalyScore = 0;
    let anomalyType = 'KEEP';
    let anomalyReason = '';

    if (runDays >= 3) {
      if (isSuddenDip) {
        anomalyScore = 850 + spend;
        anomalyType = 'SUDDEN_DIP';
        anomalyReason = `Lịch sử tốt nhưng hôm nay đột ngột chững tin nhắn / CPMess tăng vọt (+${trend3d || 0}%)`;
      } else if (purchases === 0 && targetPurchase > 0 && spend >= targetPurchase * 1.5) {
        anomalyScore = 1000 + spend;
        anomalyType = 'PAUSE';
        anomalyReason = `0 Purchase sau ${spend.toLocaleString('vi-VN')}đ (${(spend / targetPurchase).toFixed(1)}x target CPP)`;
      } else if (primaryCount === 0 && targetCost > 0 && spend >= targetCost * 2) {
        anomalyScore = 900 + spend;
        anomalyType = 'PAUSE';
        anomalyReason = `0 ${primaryMetric} sau ${spend.toLocaleString('vi-VN')}đ (${(spend / targetCost).toFixed(1)}x target)`;
      } else if (ratio && ratio > 1.3) {
        anomalyScore = 800 + spend;
        anomalyType = 'DECREASE_20';
        anomalyReason = `Chi phí ${primaryCost.toLocaleString('vi-VN')}đ vượt ${(ratio * 100 - 100).toFixed(0)}% target`;
      } else if (trend3d !== null && trend3d > 30) {
        anomalyScore = 700 + spend;
        anomalyType = 'DECLINING';
        anomalyReason = `Chi phí 3D tăng vọt +${trend3d}%`;
      } else if (freq >= 2.5) {
        anomalyScore = 600 + spend;
        anomalyType = 'NEW_CREATIVE';
        anomalyReason = `Tần suất bão hòa ${freq}x`;
      } else if (i.impressions >= 1000 && ctr < 0.8) {
        anomalyScore = 550 + spend;
        anomalyType = 'NEW_HOOK';
        anomalyReason = `CTR ${ctr}% thấp sau ${i.impressions} impressions (Hook yếu)`;
      } else if (i.clicks >= 20 && (i.messRate < 1.5 || (mess === 0 && i.clicks >= 20))) {
        anomalyScore = 500 + spend;
        anomalyType = 'FIX_CTA';
        anomalyReason = `Tỷ lệ nhắn thấp dù có ${i.clicks} click (CTA/Offer yếu)`;
      } else if (ratio && ratio <= 0.8 && primaryCount >= 3 && (trend3d === null || trend3d <= 15)) {
        anomalyScore = 400 + spend;
        anomalyType = 'SCALE';
        anomalyReason = `Hiệu suất tốt (${primaryCost.toLocaleString('vi-VN')}đ = ${(ratio * 100).toFixed(0)}% target)`;
      }
    } else if (runDays < 3 && primaryCount === 0 && targetCost > 0 && spend >= targetCost * 2) {
      anomalyScore = 750 + spend;
      anomalyType = 'DECREASE_20';
      anomalyReason = `Ad mới (${runDays} ngày) nhưng tiêu ${(spend / targetCost).toFixed(1)}x target`;
    }

    return {
      ad,
      anomalyScore,
      anomalyType,
      anomalyReason,
      primaryMetric,
      primaryCost,
      targetCost,
      ratio,
      trend3d
    };
  });

  const riskCandidates = scoredAds.filter(x => ['PAUSE', 'DECREASE_20', 'SUDDEN_DIP', 'DECLINING', 'NEW_HOOK', 'NEW_CREATIVE', 'FIX_CTA'].includes(x.anomalyType))
    .sort((a, b) => b.anomalyScore - a.anomalyScore);
  const winnerCandidates = scoredAds.filter(x => x.anomalyType === 'SCALE')
    .sort((a, b) => b.anomalyScore - a.anomalyScore);

  const selectedRisks = riskCandidates.slice(0, 7);
  const selectedWinners = winnerCandidates.slice(0, 3);
  const selected = [...selectedRisks, ...selectedWinners];

  if (selected.length < 5) {
    const selectedIds = new Set(selected.map(s => String(s.ad.adId)));
    const remaining = scoredAds.filter(s => !selectedIds.has(String(s.ad.adId)))
      .sort((a, b) => (b.ad.insights?.spend || 0) - (a.ad.insights?.spend || 0));
    selected.push(...remaining.slice(0, 5 - selected.length));
  }

  const compressedAds = selected.map(({ ad, anomalyType, anomalyReason, primaryMetric, primaryCost, targetCost, trend3d }) => {
    const i = ad.insights || {};
    const bodyText = String(ad.creative?.body || '').replace(/\s+/g, ' ').trim();
    const creativeSnippet = bodyText.length > 180 ? bodyText.slice(0, 180) + '...' : bodyText;
    let targetingSummary = '';
    if (ad.targeting) {
      if (typeof ad.targeting === 'object' && ad.targeting.summary) {
        targetingSummary = ad.targeting.summary;
      } else if (typeof ad.targeting === 'string') {
        try {
          targetingSummary = describeTargetingSnippet(JSON.parse(ad.targeting));
        } catch (_) {
          targetingSummary = ad.targeting;
        }
      } else if (typeof ad.targeting === 'object') {
        targetingSummary = describeTargetingSnippet(ad.targeting);
      }
    }
    const aud = ad.audienceProfile || {};
    const audSummary = targetingSummary || `${aud.label || 'Tệp'}${aud.interests?.length ? `: ${aud.interests.slice(0, 3).join(', ')}` : ''} (${aud.genderLabel || 'All'}, ${aud.ageMin || 18}-${aud.ageMax || 65})`;

    return {
      adId: String(ad.adId),
      adName: ad.adName,
      service: ad.service || 'Chưa phân loại',
      status: ad.status,
      runDays: Number(i.runDays || 0),
      dailyBudget: ad.daily_budget || 0,
      spend7d: Number(i.spend || 0),
      primaryMetric,
      primaryResults7d: Number(i[primaryMetric === 'purchase' ? 'purchases' : primaryMetric === 'lead' ? 'leads' : 'mess'] || 0),
      primaryCost7d: primaryCost,
      targetCost,
      trend3dPct: trend3d !== null ? `${trend3d > 0 ? '+' : ''}${trend3d}%` : 'N/A',
      ctr: Number(i.ctr || 0),
      frequency: Number(i.frequency || 0),
      anomalyFlag: anomalyType,
      anomalyReason,
      creativeSnippet,
      audience: audSummary,
      targeting: targetingSummary || audSummary
    };
  });

  return {
    compressedAds,
    selectedAdIds: new Set(selected.map(s => String(s.ad.adId))),
    scoredAds
  };
}

/**
 * Synthesizes deterministic ad decisions for healthy/unselected ads.
 */
function synthesizeHealthyAdDecisions(allAds = [], selectedAdIds = new Set(), businessTargets = {}) {
  const targetPurchase = Number(businessTargets.cost_per_purchase_max || 0);
  const targetCpmess = Number(businessTargets.cost_per_message_max || 250000);

  return allAds.filter(ad => !selectedAdIds.has(String(ad.adId))).map(ad => {
    const i = ad.insights || {};
    const runDays = Number(i.runDays || 0);
    const purchases = Number(i.purchases || 0);
    const mess = Number(i.mess || 0);
    const spend = Number(i.spend || 0);
    const cpmess = Number(i.cpmess || (mess > 0 ? Math.round(spend / mess) : 0));
    const cpp = Number(i.costPerPurchase || (purchases > 0 ? Math.round(spend / purchases) : 0));

    let category = 'KEEP';
    let confidence = 'MEDIUM';
    let verdictTitle = 'Giữ nguyên · Vùng an toàn';
    let coreInsight = 'Hiệu suất ổn định trong ngưỡng an toàn, chi phí kiểm soát tốt.';
    let budgetAction = 'Giữ nguyên ngân sách hiện tại, theo dõi phân phối.';

    if (runDays < 3) {
      category = 'KEEP';
      confidence = 'LOW';
      verdictTitle = 'Ad mới · Đang học máy';
      coreInsight = `Mới chạy ${runDays} ngày (${mess} kết quả); giữ nguyên để hoàn tất giai đoạn học máy.`;
      budgetAction = 'Giữ nguyên ngân sách, tránh thay đổi làm gián đoạn máy học.';
    } else if (purchases > 0 && targetPurchase > 0 && cpp <= targetPurchase * 0.8) {
      category = 'SCALE';
      confidence = 'HIGH';
      verdictTitle = 'Scale +20% · Chi phí Purchase tối ưu';
      coreInsight = `Cost/Purchase (${cpp.toLocaleString('vi-VN')}đ) thấp hơn 20% so với mục tiêu (${targetPurchase.toLocaleString('vi-VN')}đ).`;
      budgetAction = 'Tăng 15–20% ngân sách.';
    } else if (mess > 0 && targetCpmess > 0 && cpmess <= targetCpmess * 0.8) {
      category = 'SCALE';
      confidence = 'HIGH';
      verdictTitle = 'Scale +20% · CPMess tối ưu';
      coreInsight = `CPMess (${cpmess.toLocaleString('vi-VN')}đ) tối ưu so với mục tiêu (${targetCpmess.toLocaleString('vi-VN')}đ).`;
      budgetAction = 'Tăng 15–20% ngân sách.';
    }

    return {
      adId: String(ad.adId),
      adName: ad.adName,
      category,
      confidence,
      verdictTitle,
      coreInsight,
      actions: {
        budget: budgetAction,
        creative: 'Giữ nguyên visual và thông điệp đang chạy hiệu quả',
        audience: 'Giữ nguyên tệp phân phối hiện tại'
      },
      suggestedHook: '',
      suggestedCTA: '',
      variantBrief: '',
      assessment: coreInsight,
      evidence: `Chi tiêu: ${spend.toLocaleString('vi-VN')}đ, Kết quả: ${purchases ? `${purchases} Purchase` : `${mess} Tin nhắn`}`,
      action: budgetAction
    };
  });
}

async function analyzeRunningAds(insightsData) {
  const allAds = Array.isArray(insightsData.ads) ? insightsData.ads : [];
  const businessTargets = insightsData.businessTargets || {};

  // Targeted Anomaly Compression (reduce token by ~85%)
  const { compressedAds, selectedAdIds } = filterAndCompressAds(allAds, businessTargets);

  const compressedPayload = {
    businessTargets: insightsData.businessTargets,
    portfolioSummary: insightsData.portfolioSummary,
    analyzedAnomalyAds: compressedAds,
    totalPortfolioAds: allAds.length,
    compressionNote: `Đã lọc ${compressedAds.length} quảng cáo trọng điểm (Anomalies/Risks & Top Performers) để phân tích chuyên sâu.`
  };

  const prompt = `Bạn là Giám đốc Chiến lược Performance & Creative Facebook Ads cấp cao. Phân tích dữ liệu tài khoản và các quảng cáo trọng điểm (Anomaly & Top Performers) dưới đây:

${JSON.stringify(compressedPayload, null, 2)}

NGUYÊN TẮC PHÂN TÍCH & MA TRẬN QUYẾT ĐỊNH:
1. LƯU Ý QUAN TRỌNG VỀ VỊ TRÍ & TARGETING:
   Đọc kỹ thông tin Vị trí (Vị trí / Targeting / Audience). Nếu quảng cáo thả ghim bán kính cụ thể (ví dụ: Ngõ 78 Duy Tân, Cầu Giấy +2km) thì đây là tệp CỰC KỲ CHUẨN XÁC theo địa phương của cơ sở y tế / phòng khám, TUYỆT ĐỐI KHÔNG đánh giá là quảng cáo chạy Toàn quốc.
2. Phân tầng theo phễu chuyển đổi: Purchase/CPP -> Lead/CPL -> Mess/CPMess.
   - Nếu ad có Purchase > 0: Đánh giá theo Cost/Purchase vs Target Purchase.
   - Nếu ad 0 Purchase:
     * Đánh giá CPMess so với Target CPMess. Nếu CPMess > Target * 1.2 -> REDUCE hoặc VARIANT (nếu CTR/MessRate kém).
     * Nếu chi tiêu >= 1.5x-2x Target Purchase mà 0 Purchase -> PAUSE để cắt lỗ.
3. Dùng xu hướng 3D gần nhất vs 3D trước để quyết định hành động tức thì.
4. Ma trận hành động:
   - SUDDEN_DIP (confidence HIGH/MEDIUM): Ad có lịch sử chạy tốt (days_with_mess >= 3 hoặc CPMess trước đó tốt), nhưng hôm nay đột ngột chững tin nhắn (tiêu >= 0.8x target CPMess mà 0-1 tin) hoặc chi phí 3D tăng vọt >= 40%. TUYỆT ĐỐI KHÔNG TẮT NGAY VÀ KHÔNG SỬA TRỰC TIẾP BÀI ĐANG CHẠY làm hỏng tệp máy học. BẮT BUỘC cung cấp "suddenDipPlaybook" gồm 3 nhịp thời gian:
     * phase1_24h: "Nhịp 0h–24h (Hôm nay): Giữ nguyên hoặc giảm nhẹ 20% ngân sách để hãm chi phí; TUYỆT ĐỐI KHÔNG TẮT và KHÔNG SỬA TRỰC TIẾP bài viết để tránh reset máy học."
     * phase2_48h: "Nhịp 24h–48h (Ngày mai): Nếu tin nhắn tự hồi phục -> đưa ngân sách về cũ. Nếu vẫn chững -> Tạo và kích hoạt Variant mới đổi Hook 3s đầu."
     * phase3_72h: "Nhịp >48h (Ngày thứ 3): Nếu vẫn đắt sau 3 ngày liên tiếp -> Tắt bài cũ, chuyển toàn bộ ngân sách sang Variant mới."
     * suggestedHook: "Câu hook 3s đầu mới sắc bén dự phòng thay thế"
     * suggestedCTA: "CTA kêu gọi hành động điều chỉnh"
   - SCALE (confidence HIGH/MEDIUM): Chi phí ≤ 80% target, phong độ ổn định. Tăng 10-20% ngân sách.
   - KEEP (confidence HIGH/MEDIUM/LOW): Trong vùng an toàn hoặc ad mới < 3 ngày. Không coi ad ≥ 3 ngày là "đang học máy".
   - REDUCE (confidence HIGH/MEDIUM): Chi phí vượt 120-150% target hoặc tăng vọt > 30% trong 3 ngày (không thuộc diện Sudden Dip). Giảm 20% ngân sách.
   - PAUSE (confidence HIGH): Chi tiêu ≥ 1.5×-2× target không ra chuyển đổi (và không có lịch sử tốt), hoặc cháy ngân sách. Tắt ngay.
   - VARIANT (confidence HIGH/MEDIUM): Frequency ≥ 2.5x (bão hòa) hoặc CTR < 0.8% (đổi hook) hoặc click nhiều không nhắn (sửa CTA).

portfolioSummary là số tổng toàn tài khoản. Phân tích sâu từng ad trong analyzedAnomalyAds và xu hướng vĩ mô toàn tài khoản.

Trả về DUY NHẤT một JSON object hợp lệ:
{
  "executiveSummary": "Tổng quan tình hình tài khoản 2-3 câu ngắn gọn có số liệu cụ thể.",
  "trendAnalysis": [
    {
      "title": "Tên xu hướng quan trọng",
      "status": "POSITIVE|WARNING|NEGATIVE|UNKNOWN",
      "observation": "Nhận xét ngắn",
      "evidence": "Số liệu chứng minh",
      "implication": "Tác động đến phễu",
      "action": "Hành động khắc phục/tận dụng"
    }
  ],
  "adDecisions": [
    {
      "adId": "ID thật của ad trong danh sách analyzedAnomalyAds",
      "adName": "Tên quảng cáo",
      "category": "SCALE|KEEP|REDUCE|PAUSE|VARIANT|SUDDEN_DIP",
      "confidence": "HIGH|MEDIUM|LOW",
      "verdictTitle": "Tiêu đề quyết định ngắn gọn, dứt khoát (VD: ⚠️ Đột biến giảm 24h · Theo dõi / Scale +20% · Đạt chuẩn phễu / Giảm 20% · Chi phí tăng vọt / Tắt ngay · Cháy ngân sách không ra đơn / Tạo biến thể hook mới · Bão hòa)",
      "coreInsight": "1 câu nhận định cốt lõi vì sao được scale / phải giảm / tắt / theo dõi 24h",
      "actions": {
        "budget": "Hành động ngân sách cụ thể",
        "creative": "Hành động creative cụ thể (giữ hook hay đổi hook nào)",
        "audience": "Đề xuất tệp cụ thể"
      },
      "suddenDipPlaybook": {
        "phase1_24h": "Nhịp 0h-24h",
        "phase2_48h": "Nhịp 24h-48h",
        "phase3_72h": "Nhịp >48h",
        "suggestedHook": "Hook dự phòng",
        "suggestedCTA": "CTA dự phòng"
      },
      "suggestedHook": "Câu hook mẫu tiếng Việt viết sẵn dùng được ngay (hoặc rỗng)",
      "suggestedCTA": "CTA đề xuất cụ thể (hoặc rỗng)",
      "variantBrief": "Hướng làm biến thể ngắn gọn",
      "assessment": "Tóm tắt đánh giá ngắn gọn",
      "evidence": "Bằng chứng số liệu ngắn gọn",
      "action": "Tóm tắt hành động chính"
    }
  ],
  "contentPatterns": [
    {
      "patternName": "Tên dạng content thắng",
      "whyWorks": "Lý do hiệu quả",
      "sourceAdIds": ["ID thật"],
      "evidence": "Số liệu chứng minh",
      "variantDirections": ["Hướng biến thể 1", "Hướng biến thể 2"],
      "sampleHooks": ["Câu hook mẫu 1", "Câu hook mẫu 2"]
    }
  ],
  "contentRepairs": [
    {
      "sourceAdId": "ID thật",
      "adName": "Tên ad",
      "problem": "Vấn đề cốt lõi",
      "whyUnderperforming": "Vì sao kém hiệu quả",
      "keep": "Phần nên giữ",
      "change": "Phần phải sửa",
      "newAngle": "Góc tiếp cận mới",
      "newHook": "Hook mới mẫu"
    }
  ],
  "targetingAnalysis": [
    {
      "scope": "Tên ad/ad set/nhóm target",
      "adId": "ID thật hoặc rỗng",
      "audienceType": "BROAD|INTEREST|LOOKALIKE|RETARGET|UNKNOWN",
      "verdict": "EXPAND|KEEP|NARROW|TEST_BROAD|RETARGET|CREATIVE_FIRST|UNKNOWN",
      "confidence": "HIGH|MEDIUM|LOW",
      "currentTarget": "Mô tả target hiện tại",
      "diagnosis": "Chẩn đoán",
      "evidence": "Số liệu",
      "testRecommendation": "Đề xuất test",
      "successMetric": "Chỉ số thành công",
      "missingData": ""
    }
  ],
  "testPlan": [
    {
      "priority": 1,
      "title": "Tên bài test",
      "objective": "Mục tiêu",
      "sourceAdId": "ID thật hoặc rỗng",
      "contentDirection": "Định hướng nội dung",
      "successMetric": "Chỉ số thành công",
      "nextStep": "Bước tiếp theo"
    }
  ],
  "winners": [
    {
      "adId": "ID thật",
      "adName": "Tên ad",
      "assessment": "Đánh giá",
      "evidence": "Số liệu",
      "action": "Hành động scale/nhân rộng"
    }
  ],
  "risks": [
    {
      "adId": "ID thật",
      "adName": "Tên ad",
      "assessment": "Đánh giá rủi ro",
      "evidence": "Số liệu",
      "action": "Hành động xử lý"
    }
  ],
  "contentInsights": [
    {
      "title": "Tiêu đề insight",
      "contentDiagnosis": "Phân tích hook, offer, proof, CTA, angle",
      "evidence": "Số liệu",
      "action": "Hành động"
    }
  ],
  "recommendations": [
    {
      "title": "Tiêu đề",
      "insight": "Ưu tiên hành động cụ thể",
      "evidence": "Số liệu",
      "action": "Hành động cụ thể"
    }
  ]
}`;

  try {
    const response = await axios.post(`${GEMINI_API_URL}?key=${config.gemini.apiKey}`, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.15, responseMimeType: 'application/json' }
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 120000 });

    const rawAnalysis = extractJSONFromResponse(response.data);

    // Auto-synthesize decisions for remaining healthy ads
    const healthyDecisions = synthesizeHealthyAdDecisions(allAds, selectedAdIds, businessTargets);
    const analyzedDecisions = Array.isArray(rawAnalysis.adDecisions) ? rawAnalysis.adDecisions : [];

    rawAnalysis.adDecisions = [...analyzedDecisions, ...healthyDecisions];
    rawAnalysis.tokenOptimization = {
      totalAds: allAds.length,
      compressedAdsAnalyzedByLLM: compressedAds.length,
      ruleSynthesizedAds: healthyDecisions.length,
      tokenSavedPct: allAds.length > 10 ? 85 : 0
    };

    return rawAnalysis;
  } catch (err) {
    logger.error('analyzeRunningAds failed', { error: err.message });
    throw err;
  }
}

function normalizeHooks(rawHooks, service = 'làm đẹp') {
  const defaultHooks = [
    {
      angle: 'Đánh trúng nỗi đau & sai lầm',
      hook: `3 sai lầm phổ biến khi điều trị ${service} khiến chi phí tăng gấp đôi mà không hiệu quả.`
    },
    {
      angle: 'Bóc tách sự thật / Phản trực giác',
      hook: `Sự thật về liệu trình ${service} mà các cơ sở thẩm mỹ ít khi chia sẻ thẳng thắn.`
    },
    {
      angle: 'Bằng chứng thực tế & Kết quả',
      hook: `Xem ngay hình ảnh thực tế trước và sau liệu trình ${service} của khách hàng tuần này.`
    }
  ];

  let list = [];
  if (Array.isArray(rawHooks)) {
    list = rawHooks.map((item, idx) => {
      if (!item) return defaultHooks[idx % defaultHooks.length];
      if (typeof item === 'object') {
        const hookText = String(item.hook || item.text || item.title || '').trim();
        const angleText = String(item.angle || item.angleName || `Góc tiếp cận ${idx + 1}`).trim();
        if (hookText) {
          return { hook: hookText, angle: angleText || `Góc tiếp cận ${idx + 1}` };
        }
      }
      let str = String(item).trim();
      if (!str) return defaultHooks[idx % defaultHooks.length];

      let angle = `Góc tiếp cận ${idx + 1}`;
      let hook = str;

      const bracketMatch = str.match(/^(?:Hook\s*\d*|\d+[\.\)]|\bAngle\s*\d*|Gợi ý\s*\d*)?\s*[\(\[]\s*([^()\[\]]+)\s*[\)\]]\s*[:\-–—]?\s*(.+)$/i);
      if (bracketMatch && bracketMatch[2]) {
        angle = bracketMatch[1].trim();
        hook = bracketMatch[2].trim();
      } else {
        const prefixMatch = str.match(/^(?:Hook\s*\d*|\d+[\.\)]|\bAngle\s*\d*|Gợi ý\s*\d*)\s*[:\-–—]\s*(.+)$/i);
        if (prefixMatch && prefixMatch[1]) {
          hook = prefixMatch[1].trim();
        } else {
          const colonMatch = str.match(/^([A-Za-zÀ-ỹ0-9\s]{2,20})\s*[:\-–—]\s*(.+)$/i);
          if (colonMatch && colonMatch[2] && colonMatch[2].length > 10) {
            angle = colonMatch[1].trim();
            hook = colonMatch[2].trim();
          }
        }
      }

      hook = hook.replace(/^[:\-–—\s"']+|[:\-–—\s"']+$/g, '').trim();

      return { hook: hook || str, angle: angle || `Góc tiếp cận ${idx + 1}` };
    }).filter(h => Boolean(h && h.hook));
  }

  if (list.length === 0) {
    list = [...defaultHooks];
  } else {
    while (list.length < 3) {
      list.push(defaultHooks[list.length % defaultHooks.length]);
    }
  }

  return list.slice(0, 3);
}


function buildSuggestedCopy({ service = 'làm đẹp', primaryHook = '', suggestedCTA = '' }) {
  const hook = primaryHook || `3 sai lầm phổ biến khi điều trị ${service} khiến chi phí tăng gấp đôi mà không hiệu quả.`;
  const cta = suggestedCTA || `Nhắn tin ngay để nhận tư vấn phác đồ ${service} chuyên sâu cùng ưu đãi giới hạn.`;
  return [
    `🚨 ${hook}`,
    '',
    `Bạn đang gặp khó khăn và chưa tìm được giải pháp điều trị ${service} an toàn, dứt điểm? Rất nhiều người đã tốn kém thời gian và chi phí chỉ vì chọn sai phương pháp hoặc chăm sóc chưa đúng cách.`,
    '',
    `✨ PHÁC ĐỒ CHUYÊN SÂU TẠI VIỆN:`,
    `• Thăm khám 1:1 và soi da/tư vấn trực tiếp cùng chuyên gia.`,
    `• Ứng dụng công nghệ hiện đại, liệu trình chuẩn y khoa, không xâm lấn, không cần nghỉ dưỡng.`,
    `• Cam kết hiệu quả rõ rệt ngay sau liệu trình đầu tiên.`,
    '',
    `🎁 Ưu đãi độc quyền dành cho 20 khách hàng đăng ký sớm nhất trong tuần này!`,
    '',
    `👉 ${cta}`
  ].join('\n');
}

function generateFallbackSingleAdDiagnosis(adData, businessTargets = {}, benchmark = 250000) {
  const { ad = {}, stats = {}, creative = {} } = adData || {};
  const cpmess = Number(stats.cpmess || 0);
  const target = Number(businessTargets.cost_per_message_max || benchmark || 250000);
  const spend = Number(stats.spend || 0);
  const mess = Number(stats.mess || 0);
  const ctr = Number(stats.ctr || 0);
  const freq = Number(stats.frequency || 0);
  const runDays = Number(stats.run_days || 0);
  const daysWithMess = Number(stats.days_with_mess || 0);
  const messPrev3d = Number(stats.mess_prev_3d || 0);
  const spendPrev3d = Number(stats.spend_prev_3d || 0);
  const cpmessPrev3d = Number(stats.cpmess_prev_3d || (messPrev3d > 0 ? Math.round(spendPrev3d / messPrev3d) : 0));
  const todaySpend = Number(stats.today_spend || stats.todaySpend || stats.spendToday || 0);
  const todayMess = Number(stats.today_mess || stats.todayMess || stats.messToday || 0);
  const spend3d = Number(stats.spend_3d || stats.spend3d || 0);
  const mess3d = Number(stats.mess_3d || stats.mess3d || 0);
  const cpmess3d = Number(stats.cpmess_3d || (mess3d > 0 ? Math.round(spend3d / mess3d) : 0));
  const trend3dPct = (cpmess3d > 0 && cpmessPrev3d > 0) ? Math.round((cpmess3d - cpmessPrev3d) * 100 / cpmessPrev3d) : null;

  const hasGoodHistory = (
    daysWithMess >= 3 ||
    messPrev3d >= 2 ||
    (cpmessPrev3d > 0 && cpmessPrev3d <= target * 1.2)
  );

  const isSuddenDip = hasGoodHistory && (
    (todaySpend >= target * 0.8 && todayMess <= 1) ||
    (spend3d >= target * 0.8 && mess3d <= 1 && (daysWithMess >= 3 || messPrev3d >= 2)) ||
    (trend3dPct !== null && trend3dPct >= 40)
  );

  let verdict = 'KEEP';
  let verdictTitle = 'Giữ nguyên theo dõi';
  let diagnosis = 'Hiệu suất đang trong ngưỡng theo dõi bình thường.';
  let score = 70;
  let budgetAction = 'Giữ nguyên ngân sách và theo dõi thêm 24h.';
  let creativeAction = 'Giữ nguyên visual & copy hiện tại.';

  if (isSuddenDip) {
    verdict = 'SUDDEN_DIP';
    verdictTitle = '⚠️ Đột biến giảm trong ngày · Cần theo dõi 24h';
    diagnosis = `Lịch sử chạy rất tốt (${daysWithMess > 0 ? `${daysWithMess} ngày ra mess đều` : 'lịch sử ổn định'}${cpmessPrev3d > 0 ? `, CPMess cũ ${cpmessPrev3d.toLocaleString('vi-VN')}đ` : ''}), nhưng hôm nay đột ngột chững tin nhắn sau khi tiêu ${(todaySpend || spend3d || spend).toLocaleString('vi-VN')}đ. Không nên tắt ngay làm hỏng tệp.`;
    score = 60;
    budgetAction = 'Giảm nhẹ 20% ngân sách hoặc giữ nguyên để hãm chi phí, theo dõi 24h; tuyệt đối không tắt ngay và không sửa trực tiếp bài viết.';
    creativeAction = 'Chuẩn bị sẵn 1-2 biến thể hook mới (3s đầu), chưa sửa trực tiếp vào bài đang chạy.';
  } else if (runDays >= 3 && mess === 0 && spend >= target * 1.5) {
    verdict = 'PAUSE';
    verdictTitle = 'Tắt ngay · Cháy ngân sách không ra tin';
    diagnosis = `Đã tiêu ${spend.toLocaleString('vi-VN')}đ mà không có tin nhắn nào.`;
    score = 20;
    budgetAction = 'Tắt ngay quảng cáo này để cắt lỗ.';
    creativeAction = 'Ngừng visual & copy này, thử nghiệm concept góc nhìn hoàn toàn mới.';
  } else if (cpmess > target * 1.3) {
    verdict = 'REDUCE';
    verdictTitle = 'Giảm 20% · CPMess vượt ngưỡng';
    diagnosis = `CPMess (${cpmess.toLocaleString('vi-VN')}đ) vượt mục tiêu ${target.toLocaleString('vi-VN')}đ.`;
    score = 45;
    budgetAction = 'Giảm 20% ngân sách để kiểm soát chi phí.';
    creativeAction = 'Thử nghiệm hook mới để giảm chi phí chuyển đổi.';
  } else if (freq >= 2.5) {
    verdict = 'REFRESH_CREATIVE';
    verdictTitle = 'Bão hòa tệp · Cần làm mới Creative';
    diagnosis = `Frequency đạt ${freq}x cho thấy khán giả đã nhìn thấy quảng cáo nhiều lần.`;
    score = 55;
    budgetAction = 'Giữ nguyên ngân sách.';
    creativeAction = 'Tạo 2–3 video/hình ảnh mới với Hook 3s đầu sắc bén hơn.';
  } else if (ctr < 0.8 && ctr > 0) {
    verdict = 'REFRESH_CREATIVE';
    verdictTitle = 'Đổi Hook mới · CTR thấp';
    diagnosis = `CTR (${ctr}%) thấp hơn chuẩn, người xem lướt qua mà không dừng lại.`;
    score = 50;
    budgetAction = 'Giữ nguyên ngân sách.';
    creativeAction = 'Thử nghiệm hook 3 giây đầu mạnh hơn.';
  } else if (cpmess > 0 && cpmess <= target * 0.8 && mess >= 3) {
    verdict = 'SCALE';
    verdictTitle = 'Scale +20% · Hiệu suất xuất sắc';
    diagnosis = `CPMess (${cpmess.toLocaleString('vi-VN')}đ) rẻ hơn mục tiêu, tỷ lệ chuyển đổi tốt.`;
    score = 90;
    budgetAction = 'Tăng 15–20% ngân sách để mở rộng kết quả.';
    creativeAction = 'Giữ nguyên creative thắng, nhân bản thêm biến thể để scale.';
  }

  const service = ad.service || 'làm đẹp';
  const defaultHooks = normalizeHooks([], service);
  const defaultCTA = `Nhắn tin ngay để nhận tư vấn phác đồ ${service} chuyên sâu cùng ưu đãi giới hạn.`;
  const defaultCopy = buildSuggestedCopy({
    service,
    primaryHook: defaultHooks[0].hook,
    suggestedCTA: defaultCTA
  });

  const actionPlan = {
    budget: budgetAction,
    creative: creativeAction,
    targeting: 'Giữ nguyên tệp khách hàng hiện tại'
  };

  const currentHourVn = (new Date().getUTCHours() + 7) % 24;
  const currentMinuteVn = new Date().getUTCMinutes();
  const expectedPacingPct = getExpectedPacingPct(currentHourVn, currentMinuteVn);
  const budgetPacing = evaluateBudgetPacing({
    dailyBudget: Number(ad.budget || ad.daily_budget || ad.adset_budget || ad.campaign_budget || 0),
    lifetimeBudget: Number(ad.lifetime_budget || 0),
    todaySpend,
    spend7d: spend,
    ctr7d: ctr,
    frequency7d: freq,
    targeting: ad.targeting?.raw || ad.targeting,
    currentHourVn,
    currentMinuteVn,
    expectedPacingPct
  });

  return {
    adId: String(ad.ad_id || ''),
    adName: ad.ad_name || 'Quảng cáo',
    verdict,
    verdictTitle,
    diagnosis,
    coreDiagnosis: diagnosis,
    summary: diagnosis,
    performanceScore: score,
    healthScore: score,
    actionPlan,
    recommendedActions: actionPlan,
    budgetPacingAnalysis: {
      status: budgetPacing.status,
      currentPacingPct: budgetPacing.currentPacingPct,
      expectedPacingPct: budgetPacing.expectedPacingPct,
      diagnosis: budgetPacing.diagnosis,
      action: budgetPacing.action
    },
    suddenDipPlaybook: isSuddenDip ? {
      phase1_24h: 'Nhịp 0h–24h (Hôm nay): Giữ nguyên hoặc giảm nhẹ 20% ngân sách để hãm chi phí; TUYỆT ĐỐI KHÔNG TẮT và KHÔNG SỬA TRỰC TIẾP bài viết để tránh reset máy học.',
      phase2_48h: 'Nhịp 24h–48h (Ngày mai): Nếu tin nhắn tự hồi phục -> đưa ngân sách về cũ. Nếu vẫn chững -> Tạo và kích hoạt Variant mới đổi Hook 3s đầu.',
      phase3_72h: 'Nhịp >48h (Ngày thứ 3): Nếu vẫn đắt sau 3 ngày liên tiếp -> Tắt bài cũ, chuyển toàn bộ ngân sách sang Variant mới.',
      suggestedHook: defaultHooks[0].hook,
      suggestedCTA: defaultCTA
    } : null,
    suggestedHooks: defaultHooks,
    suggestedCTA: defaultCTA,
    suggestedCopy: defaultCopy,
    bottlenecks: [diagnosis],
    variantBrief: `Sản xuất video ngắn 25-35s tập trung vào quá trình thăm khám thực tế và kết quả đo lường rõ ràng.`,
    newAngle: `Góc tiếp cận chuyên gia / Bác sĩ trực tiếp bóc tách nguyên nhân và đưa ra giải pháp.`
  };
}

function normalizeSingleAdDiagnosis(raw = {}, adData = {}, targetCpmess = 250000) {
  const verdict = raw.verdict || raw.status || 'KEEP';
  const score = Number(raw.performanceScore ?? raw.healthScore ?? 70);
  const service = adData?.ad?.service || 'làm đẹp';

  // 1. summary & coreDiagnosis: Luôn là chuỗi không rỗng, không bao giờ null/undefined
  const coreDiagnosis = String(
    raw.coreDiagnosis ||
    raw.summary ||
    raw.diagnosis ||
    (verdict === 'SUDDEN_DIP' ? 'Quảng cáo có dấu hiệu đột biến giảm hiệu suất trong ngày dù lịch sử tốt. Cần theo dõi 24h trước khi can thiệp.' :
     verdict === 'PAUSE' ? 'Quảng cáo không mang lại chuyển đổi sau thời gian chạy, chi phí lãng phí cao.' :
     verdict === 'REDUCE' ? 'Chi phí trên mỗi tin nhắn vượt ngưỡng mục tiêu, cần giảm ngân sách để tối ưu.' :
     verdict === 'SCALE' ? 'Hiệu suất quảng cáo xuất sắc với chi phí tin nhắn thấp và tỷ lệ chuyển đổi cao.' :
     verdict === 'REFRESH_CREATIVE' ? 'Creative hoặc Hook mở đầu đã giảm hiệu quả giữ chân khách hàng.' :
     'Hiệu suất quảng cáo đang trong ngưỡng theo dõi bình thường.')
  ).trim();
  const summary = coreDiagnosis;

  // 2. suggestedHooks: Mảng các object chuẩn { hook: string, angle: string }
  const suggestedHooks = normalizeHooks(raw.suggestedHooks, service);

  // 3. suggestedCTA: Luôn là chuỗi không rỗng
  const suggestedCTA = String(raw.suggestedCTA || `Nhắn tin ngay để nhận tư vấn phác đồ ${service} chuyên sâu cùng ưu đãi giới hạn.`).trim();

  // 4. suggestedCopy: Bài viết copy hoàn chỉnh (chuẩn AIDA từ service và hook nếu thiếu)
  let suggestedCopy = raw.suggestedCopy || raw.fullContent || raw.copy || raw.variantCopy || '';
  if (!suggestedCopy || typeof suggestedCopy !== 'string' || !suggestedCopy.trim()) {
    suggestedCopy = buildSuggestedCopy({
      service,
      primaryHook: suggestedHooks[0]?.hook,
      suggestedCTA
    });
  } else {
    suggestedCopy = suggestedCopy.trim();
  }

  // 5. actionPlan: Object { budget: string, creative: string, targeting: string }
  const rawActionPlan = raw.actionPlan || raw.recommendedActions || {};
  const budgetAction = String(
    rawActionPlan.budget ||
    (verdict === 'PAUSE' ? 'Tắt ngay quảng cáo này để cắt lỗ.' :
     verdict === 'REDUCE' ? 'Giảm 20% ngân sách để kiểm soát chi phí.' :
     verdict === 'SCALE' ? 'Tăng 15–20% ngân sách để mở rộng kết quả.' :
     verdict === 'SUDDEN_DIP' ? 'Giảm nhẹ 20% ngân sách hoặc giữ nguyên để hãm chi phí, theo dõi 24h.' :
     'Giữ nguyên ngân sách và theo dõi thêm 24h.')
  ).trim();

  const creativeAction = String(
    rawActionPlan.creative ||
    (verdict === 'REFRESH_CREATIVE' ? 'Tạo 2–3 biến thể video/hình ảnh mới với Hook 3s đầu sắc bén hơn.' :
     verdict === 'SUDDEN_DIP' ? 'Chuẩn bị sẵn 1-2 biến thể hook mới (3s đầu), chưa sửa trực tiếp vào bài đang chạy.' :
     verdict === 'PAUSE' ? 'Ngừng visual & copy này, thử nghiệm concept góc nhìn hoàn toàn mới.' :
     'Giữ nguyên visual & copy, chuẩn bị sẵn hook mới dự phòng.')
  ).trim();

  const targetingAction = String(
    rawActionPlan.targeting ||
    rawActionPlan.audience ||
    'Duy trì tệp đối tượng hiện tại, mở rộng thêm tệp tương tự nếu tần suất tăng cao.'
  ).trim();

  const actionPlan = {
    budget: budgetAction,
    creative: creativeAction,
    targeting: targetingAction,
    audience: targetingAction
  };

  const { stats = {} } = adData || {};
  const daysWithMess = Number(stats.days_with_mess || 0);
  const messPrev3d = Number(stats.mess_prev_3d || 0);
  const spendPrev3d = Number(stats.spend_prev_3d || 0);
  const cpmessPrev3d = Number(stats.cpmess_prev_3d || (messPrev3d > 0 ? Math.round(spendPrev3d / messPrev3d) : 0));
  const todaySpend = Number(stats.today_spend || stats.todaySpend || stats.spendToday || 0);
  const todayMess = Number(stats.today_mess || stats.todayMess || stats.messToday || 0);
  const spend3d = Number(stats.spend_3d || stats.spend3d || 0);
  const mess3d = Number(stats.mess_3d || stats.mess3d || 0);
  const cpmess3d = Number(stats.cpmess_3d || (mess3d > 0 ? Math.round(spend3d / mess3d) : 0));
  const trend3dPct = (cpmess3d > 0 && cpmessPrev3d > 0) ? Math.round((cpmess3d - cpmessPrev3d) * 100 / cpmessPrev3d) : null;

  const hasGoodHistory = (
    daysWithMess >= 3 ||
    messPrev3d >= 2 ||
    (cpmessPrev3d > 0 && cpmessPrev3d <= targetCpmess * 1.2)
  );

  const isSuddenDip = hasGoodHistory && (
    (todaySpend >= targetCpmess * 0.8 && todayMess <= 1) ||
    (spend3d >= targetCpmess * 0.8 && mess3d <= 1 && (daysWithMess >= 3 || messPrev3d >= 2)) ||
    (trend3dPct !== null && trend3dPct >= 40)
  );

  const bottlenecks = Array.isArray(raw.bottlenecks) && raw.bottlenecks.length > 0
    ? raw.bottlenecks.map(b => typeof b === 'string' ? b : JSON.stringify(b))
    : [coreDiagnosis];

  const healthStatus = ['PAUSE', 'REDUCE', 'danger'].includes(verdict) || score < 50
    ? 'danger'
    : (['REFRESH_CREATIVE', 'FIX_CTA', 'SUDDEN_DIP', 'warning'].includes(verdict) || score < 75 ? 'warning' : 'healthy');

  const primaryHookText = suggestedHooks[0]?.hook || `3 sai lầm phổ biến khi điều trị ${service} khiến chi phí tăng gấp đôi mà không hiệu quả.`;

  let suddenDipPlaybook = raw.suddenDipPlaybook || null;
  if (!suddenDipPlaybook && (verdict === 'SUDDEN_DIP' || isSuddenDip)) {
    suddenDipPlaybook = {
      phase1_24h: 'Nhịp 0h–24h (Hôm nay): Giữ nguyên hoặc giảm nhẹ 20% ngân sách để hãm chi phí; TUYỆT ĐỐI KHÔNG TẮT và KHÔNG SỬA TRỰC TIẾP bài viết để tránh reset máy học.',
      phase2_48h: 'Nhịp 24h–48h (Ngày mai): Nếu tin nhắn tự hồi phục -> đưa ngân sách về cũ. Nếu vẫn chững -> Tạo và kích hoạt Variant mới đổi Hook 3s đầu.',
      phase3_72h: 'Nhịp >48h (Ngày thứ 3): Nếu vẫn đắt sau 3 ngày liên tiếp -> Tắt bài cũ, chuyển toàn bộ ngân sách sang Variant mới.',
      suggestedHook: primaryHookText,
      suggestedCTA
    };
  } else if (suddenDipPlaybook) {
    suddenDipPlaybook = {
      phase1_24h: suddenDipPlaybook.phase1_24h || 'Nhịp 0h–24h (Hôm nay): Giữ nguyên hoặc giảm nhẹ 20% ngân sách để hãm chi phí; TUYỆT ĐỐI KHÔNG TẮT và KHÔNG SỬA TRỰC TIẾP bài viết để tránh reset máy học.',
      phase2_48h: suddenDipPlaybook.phase2_48h || 'Nhịp 24h–48h (Ngày mai): Nếu tin nhắn tự hồi phục -> đưa ngân sách về cũ. Nếu vẫn chững -> Tạo và kích hoạt Variant mới đổi Hook 3s đầu.',
      phase3_72h: suddenDipPlaybook.phase3_72h || 'Nhịp >48h (Ngày thứ 3): Nếu vẫn đắt sau 3 ngày liên tiếp -> Tắt bài cũ, chuyển toàn bộ ngân sách sang Variant mới.',
      suggestedHook: suddenDipPlaybook.suggestedHook || primaryHookText,
      suggestedCTA: suddenDipPlaybook.suggestedCTA || suggestedCTA
    };
  }

  // Budget Pacing Analysis
  const currentHourVn = (new Date().getUTCHours() + 7) % 24;
  const currentMinuteVn = new Date().getUTCMinutes();
  const expectedPacingPct = getExpectedPacingPct(currentHourVn, currentMinuteVn);
  const defaultPacing = evaluateBudgetPacing({
    dailyBudget: Number(adData?.ad?.budget || adData?.ad?.daily_budget || adData?.ad?.adset_budget || adData?.ad?.campaign_budget || 0),
    lifetimeBudget: Number(adData?.ad?.lifetime_budget || 0),
    todaySpend,
    spend7d: Number(stats.spend || 0),
    ctr7d: Number(stats.ctr || 0),
    frequency7d: Number(stats.frequency || 0),
    targeting: adData?.targeting?.raw || adData?.targeting || adData?.ad?.targeting,
    currentHourVn,
    currentMinuteVn,
    expectedPacingPct
  });

  const rawPacing = raw.budgetPacingAnalysis || {};
  const budgetPacingAnalysis = {
    status: rawPacing.status || defaultPacing.status,
    currentPacingPct: Number(rawPacing.currentPacingPct ?? defaultPacing.currentPacingPct),
    expectedPacingPct: Number(rawPacing.expectedPacingPct ?? defaultPacing.expectedPacingPct),
    diagnosis: String(rawPacing.diagnosis || defaultPacing.diagnosis),
    action: String(rawPacing.action || defaultPacing.action)
  };

  return {
    ...raw,
    adId: String(raw.adId || adData?.ad?.ad_id || ''),
    adName: raw.adName || adData?.ad?.ad_name || 'Quảng cáo',
    status: verdict,
    verdict,
    verdictTitle: raw.verdictTitle || (
      verdict === 'SUDDEN_DIP' ? '⚠️ Đột biến giảm trong ngày · Cần theo dõi 24h' :
      verdict === 'PAUSE' ? 'Tắt ngay · Cháy ngân sách không ra tin' :
      verdict === 'REDUCE' ? 'Giảm 20% · CPMess vượt ngưỡng' :
      verdict === 'SCALE' ? 'Scale +20% · Hiệu suất xuất sắc' :
      verdict === 'REFRESH_CREATIVE' ? 'Làm mới Creative · Tối ưu Hook' :
      'Giữ nguyên theo dõi'
    ),
    healthStatus,
    healthScore: score,
    performanceScore: score,
    coreDiagnosis,
    diagnosis: coreDiagnosis,
    summary,
    bottlenecks,
    budgetPacingAnalysis,
    suggestedHooks,
    suggestedCTA,
    suggestedCopy,
    suddenDipPlaybook,
    actionPlan,
    recommendedActions: actionPlan,
    variantBrief: raw.variantBrief || `Sản xuất video ngắn 25-35s tập trung vào quá trình thăm khám thực tế dịch vụ ${service} và kết quả đo lường rõ ràng.`,
    newAngle: raw.newAngle || `Góc tiếp cận chuyên gia / Bác sĩ trực tiếp bóc tách nguyên nhân và đưa ra giải pháp.`
  };
}

/**
 * Single-Ad On-Demand AI Diagnosis (~300 tokens)
 */
async function diagnoseSingleAd({ adData, businessTargets = {}, benchmark = 250000 }) {
  const { ad = {}, stats = {}, creative = {}, targeting = {} } = adData || {};
  const targetCpmess = Number(businessTargets.cost_per_message_max || benchmark || 250000);

  const daysWithMess = Number(stats.days_with_mess || 0);
  const messPrev3d = Number(stats.mess_prev_3d || 0);
  const spendPrev3d = Number(stats.spend_prev_3d || 0);
  const cpmessPrev3d = Number(stats.cpmess_prev_3d || (messPrev3d > 0 ? Math.round(spendPrev3d / messPrev3d) : 0));
  const todaySpend = Number(stats.today_spend || stats.todaySpend || stats.spendToday || 0);
  const todayMess = Number(stats.today_mess || stats.todayMess || stats.messToday || 0);
  const spend3d = Number(stats.spend_3d || stats.spend3d || 0);
  const mess3d = Number(stats.mess_3d || stats.mess3d || 0);
  const cpmess3d = Number(stats.cpmess_3d || (mess3d > 0 ? Math.round(spend3d / mess3d) : 0));
  const trend3dPct = (cpmess3d > 0 && cpmessPrev3d > 0) ? Math.round((cpmess3d - cpmessPrev3d) * 100 / cpmessPrev3d) : null;
  const trendPctStr = trend3dPct !== null ? `${trend3dPct > 0 ? '+' : ''}${trend3dPct}%` : 'chưa đủ dữ liệu';
  const targetingSummary = targeting.summary || (targeting.raw ? describeTargetingSnippet(targeting.raw) : (typeof targeting === 'object' && Object.keys(targeting).length ? describeTargetingSnippet(targeting) : 'Broad'));

  const now = new Date();
  const currentHourVn = (now.getUTCHours() + 7) % 24;
  const currentMinuteVn = now.getUTCMinutes();
  const expectedPacingPct = getExpectedPacingPct(currentHourVn, currentMinuteVn);
  const dailyBudget = Number(ad.budget || ad.daily_budget || ad.adset_budget || ad.campaign_budget || 0);
  const pacingPct = dailyBudget > 0 ? Math.round((todaySpend / dailyBudget) * 100) : 0;

  const prompt = `Bạn là Chuyên gia Tối ưu Performance & Creative Facebook Ads. Hãy chẩn đoán chi tiết duy nhất quảng cáo này:
THÔNG TIN QUẢNG CÁO:
- ID: ${ad.ad_id} | Tên: ${ad.ad_name} | Dịch vụ: ${ad.service || 'Chưa phân loại'}
- Ngân sách: ${Number(ad.budget || 0).toLocaleString('vi-VN')}đ/ngày | Đã chạy: ${stats.run_days || 0} ngày (Số ngày có tin nhắn: ${daysWithMess} ngày)
- Hôm nay: Đã tiêu ${todaySpend.toLocaleString('vi-VN')}đ (${pacingPct}% ngân sách lúc ${currentHourVn}h, chuẩn ${expectedPacingPct}%) | Tin nhắn: ${todayMess} tin
- Chi tiêu 7D: ${Number(stats.spend || 0).toLocaleString('vi-VN')}đ (3D gần nhất: ${spend3d.toLocaleString('vi-VN')}đ, 3D trước: ${spendPrev3d.toLocaleString('vi-VN')}đ)
- Kết quả 7D: ${stats.mess || 0} tin nhắn (3D gần nhất: ${mess3d} mess, 3D trước: ${messPrev3d} mess), ${stats.leads || 0} lead, ${stats.purchases || 0} purchase
- Chi phí: CPMess ${stats.cpmess ? Number(stats.cpmess).toLocaleString('vi-VN') + 'đ' : '—'} (Mục tiêu: ${targetCpmess.toLocaleString('vi-VN')}đ)
- CTR: ${stats.ctr || 0}% | Frequency: ${stats.frequency || 0} | Mess Rate: ${stats.mess_rate || 0}%
- Xu hướng 3D: CPMess 3D = ${stats.cpmess_3d ? Number(stats.cpmess_3d).toLocaleString('vi-VN') + 'đ' : '—'} vs 3D trước = ${stats.cpmess_prev_3d ? Number(stats.cpmess_prev_3d).toLocaleString('vi-VN') + 'đ' : '—'} (Biến động: ${trendPctStr})
- Nội dung/Hook: """${String(creative.body_text || '').slice(0, 350)}"""
- Target / Vị trí: ${targetingSummary}

LƯU Ý QUAN TRỌNG VỀ VỊ TRÍ & TARGETING:
Đọc kỹ thông tin Vị trí (Vị trí / Targeting). Nếu quảng cáo thả ghim bán kính cụ thể (ví dụ: Ngõ 78 Duy Tân, Cầu Giấy +2km) thì đây là tệp CỰC KỲ CHUẨN XÁC theo địa phương của cơ sở y tế / phòng khám, TUYỆT ĐỐI KHÔNG đánh giá là quảng cáo chạy Toàn quốc.

HƯỚNG DẪN ĐẶC BIỆT KHI PHÁT HIỆN "SUDDEN DIP" (Đột biến giảm hiệu suất trong ngày dù lịch sử tốt):
- Dấu hiệu: Lịch sử ad chạy tốt (days_with_mess >= 3 hoặc 3D trước CPMess tốt), nhưng hôm nay đã tiêu >= 0.8x target mà 0-1 tin nhắn, hoặc chi phí 3D tăng vọt >= 40%.
- Nếu là Sudden Dip:
  * Trả về status/verdict: "SUDDEN_DIP"
  * Trả về verdictTitle: "⚠️ Đột biến giảm trong ngày · Cần theo dõi 24h"
  * Cung cấp "suddenDipPlaybook" với Cẩm nang hành động 3 nhịp thời gian:
    1. phase1_24h: "Nhịp 0h–24h (Hôm nay): Giữ nguyên hoặc giảm nhẹ 20% ngân sách để hãm chi phí; TUYỆT ĐỐI KHÔNG TẮT và KHÔNG SỬA TRỰC TIẾP bài viết để tránh reset máy học."
    2. phase2_48h: "Nhịp 24h–48h (Ngày mai): Nếu tin nhắn tự hồi phục -> đưa ngân sách về cũ. Nếu vẫn chững -> Tạo và kích hoạt Variant mới đổi Hook 3s đầu."
    3. phase3_72h: "Nhịp >48h (Ngày thứ 3): Nếu vẫn đắt sau 3 ngày liên tiếp -> Tắt bài cũ, chuyển toàn bộ ngân sách sang Variant mới."
    4. suggestedHook: "Câu hook 3s đầu mới sắc bén dự phòng thay thế"
    5. suggestedCTA: "Lời kêu gọi hành động điều chỉnh"

Trả về duy nhất 1 JSON object:
{
  "adId": "${ad.ad_id}",
  "adName": "${ad.ad_name}",
  "status": "SCALE|KEEP|REDUCE|PAUSE|REFRESH_CREATIVE|FIX_CTA|SUDDEN_DIP",
  "verdict": "SCALE|KEEP|REDUCE|PAUSE|REFRESH_CREATIVE|FIX_CTA|SUDDEN_DIP",
  "verdictTitle": "Tiêu đề ngắn gọn dứt khoát",
  "coreDiagnosis": "1-2 câu chẩn đoán chính xác điểm nghẽn hoặc ưu điểm",
  "summary": "1-2 câu tóm tắt chẩn đoán cốt lõi",
  "diagnosis": "1-2 câu chẩn đoán chính xác điểm nghẽn hoặc ưu điểm",
  "healthScore": 0-100,
  "performanceScore": 0-100,
  "bottlenecks": [
    "Điểm nghẽn 1",
    "Điểm nghẽn 2"
  ],
  "budgetPacingAnalysis": {
    "status": "FAST_BURN|UNDER_SPENDING|ON_TRACK|LIFETIME_SCHEDULED",
    "currentPacingPct": 0-100,
    "expectedPacingPct": 0-100,
    "diagnosis": "1-2 câu phân tích nhịp độ tiêu ngân sách và nguyên nhân",
    "action": "Đề xuất hành động điều chỉnh nhịp ngân sách"
  },
  "suddenDipPlaybook": {
    "phase1_24h": "Nhịp 0h-24h",
    "phase2_48h": "Nhịp 24h-48h",
    "phase3_72h": "Nhịp >48h",
    "suggestedHook": "Hook dự phòng",
    "suggestedCTA": "CTA dự phòng"
  },
  "actionPlan": {
    "budget": "Hành động ngân sách cụ thể",
    "creative": "Hành động nội dung/creative cụ thể",
    "targeting": "Đề xuất đối tượng"
  },
  "recommendedActions": {
    "budget": "Hành động ngân sách cụ thể",
    "creative": "Hành động nội dung/creative cụ thể",
    "targeting": "Đề xuất đối tượng"
  },
  "suggestedHooks": [
    {
      "angle": "Nỗi đau / Sai lầm",
      "hook": "Câu hook mở đầu sắc bén đánh vào nỗi đau thật của khách hàng"
    },
    {
      "angle": "Bóc tách sự thật / Phản trực giác",
      "hook": "Câu hook bóc tách sự thật / phản trực giác"
    },
    {
      "angle": "Bằng chứng & Kết quả thực tế",
      "hook": "Câu hook bằng chứng / case study / kết quả thực tế"
    }
  ],
  "suggestedCTA": "Lời kêu gọi hành động cụ thể kèm ưu đãi hấp dẫn",
  "suggestedCopy": "Bài viết quảng cáo hoàn chỉnh chuẩn AIDA (150-250 từ) gồm Hook mở đầu, Nỗi đau & Giải pháp chuyên sâu, Cam kết hiệu quả chuẩn y khoa và Kêu gọi hành động CTA",
  "variantBrief": "Gợi ý 2-3 câu về kịch bản video hoặc hình ảnh mới để test A/B",
  "newAngle": "Góc tiếp cận (Angle) mới lạ cần thử"
}`;

  try {
    const response = await axios.post(`${GEMINI_API_URL}?key=${config.gemini.apiKey}`, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 45000 });

    const raw = extractJSONFromResponse(response.data);
    return normalizeSingleAdDiagnosis(raw, adData, targetCpmess);
  } catch (err) {
    logger.error('diagnoseSingleAd LLM failed, using fallback', { error: err.message, adId: ad.ad_id });
    const fallback = generateFallbackSingleAdDiagnosis(adData, businessTargets, targetCpmess);
    return normalizeSingleAdDiagnosis(fallback, adData, targetCpmess);
  }
}

/**
 * Computes a SHA256 snapshot hash of the portfolio data for Delta Caching (Tier 3).
 */
function computePortfolioSnapshotHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

/**
 * Evaluates whether cached portfolio analysis is eligible for reuse based on metric delta (< 10%).
 */
function evaluateDeltaCacheEligible(currentTotals = {}, cachedTotals = {}, maxDeltaPct = 0.10, maxAgeHours = 24, cachedCreatedAt = null) {
  const currentSpend = Number(currentTotals.totalSpend || 0);
  const cachedSpend = Number(cachedTotals.totalSpend || 0);
  const currentMess = Number(currentTotals.totalMessages || currentTotals.mess || 0);
  const cachedMess = Number(cachedTotals.totalMessages || cachedTotals.mess || 0);
  const currentLeads = Number(currentTotals.totalLeads || currentTotals.leads || 0);
  const cachedLeads = Number(cachedTotals.totalLeads || cachedTotals.leads || 0);
  const currentPurchases = Number(currentTotals.totalPurchases || currentTotals.purchases || 0);
  const cachedPurchases = Number(cachedTotals.totalPurchases || cachedTotals.purchases || 0);
  const currentActiveAds = Number(currentTotals.activeAds || currentTotals.totalAds || 0);
  const cachedActiveAds = Number(cachedTotals.activeAds || cachedTotals.totalAds || 0);

  const spendDelta = Math.abs(currentSpend - cachedSpend) / Math.max(cachedSpend, 1);
  const messDelta = Math.abs(currentMess - cachedMess) / Math.max(cachedMess, 1);
  const leadsDelta = Math.abs(currentLeads - cachedLeads) / Math.max(cachedLeads, 1);
  const purchasesDelta = Math.abs(currentPurchases - cachedPurchases) / Math.max(cachedPurchases, 1);
  const adsDelta = Math.abs(currentActiveAds - cachedActiveAds) / Math.max(cachedActiveAds, 1);

  const maxMetricDelta = Math.max(spendDelta, messDelta, leadsDelta, purchasesDelta, adsDelta);

  let ageHours = 0;
  if (cachedCreatedAt) {
    const str = String(cachedCreatedAt);
    const cacheDate = new Date(str.includes('Z') ? str : str.replace(' ', 'T') + 'Z');
    const time = isNaN(cacheDate.getTime()) ? new Date(str).getTime() : cacheDate.getTime();
    ageHours = !isNaN(time) ? (Date.now() - time) / 3600000 : 0;
  }

  const isFresh = isNaN(ageHours) || ageHours < maxAgeHours;
  const isEligible = maxMetricDelta < maxDeltaPct && isFresh;

  return {
    isEligible,
    maxMetricDelta: Number((maxMetricDelta * 100).toFixed(1)),
    ageHours: Number(ageHours.toFixed(1))
  };
}

module.exports = {
  generateRecommendations,
  analyzeRunningAds,
  diagnoseSingleAd,
  normalizeSingleAdDiagnosis,
  generateFallbackSingleAdDiagnosis,
  filterAndCompressAds,
  synthesizeHealthyAdDecisions,
  computePortfolioSnapshotHash,
  evaluateDeltaCacheEligible,
  describeTargetingSnippet,
  inspectTargetingRadius,
  evaluateBudgetPacing,
  HOURLY_CUMULATIVE_PACING,
  getExpectedPacingPct,
  HOURLY_DISTRIBUTION_GUIDE
};


