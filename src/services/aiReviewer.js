const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { config } = require('../config');
const logger = require('../utils/logger');

const GUIDELINES_PATH = path.join(__dirname, '..', '..', 'brand-guidelines.md');
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

function loadGuidelines() {
  try {
    return fs.readFileSync(GUIDELINES_PATH, 'utf-8');
  } catch (err) {
    logger.warn('Could not load brand-guidelines.md, using empty guidelines');
    return '';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fix literal newlines/tabs inside JSON string values.
 * Walks char-by-char tracking whether we're inside a " delimited string.
 */
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

/**
 * Extract the JSON result from Gemini response.
 * Handles thinking models (multi-part) and literal newlines in strings.
 */
function extractJSONFromResponse(responseData) {
  const parts = responseData.candidates?.[0]?.content?.parts || [];
  logger.info(`Gemini response has ${parts.length} part(s)`);

  // Concatenate all non-thinking parts in order
  let fullText = '';
  for (const part of parts) {
    if (part.thought === true) continue;
    fullText += (part.text || '');
  }

  const text = fullText.trim();
  if (!text) {
    throw new Error('No valid JSON found: empty text parts');
  }

  logger.info(`Concatenated text length: ${text.length} chars`);

  // Attempt 1: direct parse
  try {
    return JSON.parse(text);
  } catch (e) {
    logger.error(`Attempt 1 failed: ${e.message}`);
  }

  // Attempt 2: fix literal newlines inside JSON strings
  try {
    const fixed = fixNewlinesInJSONStrings(text);
    return JSON.parse(fixed);
  } catch (e) {
    logger.error(`Attempt 2 failed: ${e.message}`);
  }

  // Attempt 3: strip markdown fences, then fix newlines
  try {
    const stripped = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const fixed = fixNewlinesInJSONStrings(stripped);
    return JSON.parse(fixed);
  } catch (e) {
    logger.error(`Attempt 3 failed: ${e.message}`);
  }

  logger.warn(`All parse attempts failed, first 100 chars: ${text.substring(0, 100)}`);
  throw new Error('No valid JSON found in any response part');
}

/**
 * Call Gemini API with retry for transient errors (429, 503, 500)
 */
async function callGeminiWithRetry(prompt) {
  const MAX_RETRIES = 3;
  const BASE_DELAY = 3000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await axios.post(
        `${GEMINI_API_URL}?key=${config.gemini.apiKey}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'object',
              properties: {
                approved: { type: 'boolean' },
                issues: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: ['error', 'warning'] },
                      rule: { type: 'string' },
                      description: { type: 'string' },
                      suggestion: { type: 'string' },
                    },
                    required: ['type', 'rule', 'description'],
                  },
                },
                suggestedContent: { type: 'string' },
                summary: { type: 'string' },
              },
              required: ['approved', 'issues', 'suggestedContent', 'summary'],
            },
          },
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 90000,
        }
      );
    } catch (err) {
      const status = err.response?.status;
      if ((status === 429 || status === 503 || status === 500) && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY * Math.pow(2, attempt - 1);
        logger.warn(`Gemini API ${status}, retry in ${delay}ms (${attempt}/${MAX_RETRIES})`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Review content against brand guidelines using Gemini AI
 */
async function reviewContent(content) {
  if (config.dryRun) {
    return {
      approved: true,
      issues: [],
      suggestedContent: content,
      summary: '[DRY RUN] Content review skipped',
    };
  }

  const guidelines = loadGuidelines();
  const prompt = `You are a brand content reviewer. Check the following social media post against the brand guidelines.

## Brand Guidelines
${guidelines}

## Content to Review
${content}

## Instructions
Analyze the content against EVERY rule in the brand guidelines.
Return JSON with: approved (boolean), issues (array), suggestedContent (short string), summary (one-line).
If content follows all guidelines, set approved=true, issues=[].
IMPORTANT: DO NOT rewrite the entire post for \`suggestedContent\`. To save output tokens, only provide a short bulleted list of the specific phrases or sentences that need to be changed or added.
CRITICAL: You MUST respond entirely in Vietnamese (Phản hồi hoàn toàn bằng tiếng Việt) cho tất cả các trường.`;

  try {
    const response = await callGeminiWithRetry(prompt);
    const result = extractJSONFromResponse(response.data);

    logger.info('AI Review completed', {
      approved: result.approved,
      issueCount: result.issues?.length || 0,
    });

    return {
      approved: result.approved || false,
      issues: result.issues || [],
      suggestedContent: result.suggestedContent || content,
      summary: result.summary || 'Review completed',
    };
  } catch (err) {
    logger.error('AI Review failed', { error: err.message });
    return {
      approved: false,
      issues: [{
        type: 'error',
        rule: 'System',
        description: `AI review service error: ${err.message}`,
        suggestion: 'Please try again in a moment',
      }],
      suggestedContent: content,
      summary: 'Review failed due to service error',
    };
  }
}

function getGuidelines() { return loadGuidelines(); }

function updateGuidelines(newContent) {
  fs.writeFileSync(GUIDELINES_PATH, newContent, 'utf-8');
  logger.info('Brand guidelines updated');
}

/**
 * Phân tích hiệu suất content dựa trên dữ liệu FB Ads và FB Graph API
 */
async function analyzeAdPerformance(adData, creativeData) {
  const prompt = `Bạn là một Giám đốc Marketing (Media Buying Manager) dày dặn kinh nghiệm, chuyên về mảng Facebook Ads cho các dịch vụ thẩm mỹ (Chàm bớt, U máu, Nám, Trẻ hóa...).
Phân tích quảng cáo sau dựa trên thông số chạy thực tế và nội dung copywriting.

## NỘI DUNG QUẢNG CÁO (CREATIVE)
- Tiêu đề: ${creativeData.title || 'Không có'}
- Nội dung:
${creativeData.body || 'Không thu thập được nội dung'}
- Target tệp: ${adData.targeting || 'Broad / Không có custom target'}
- Dịch vụ suy luận: ${adData.sample_ad_name || 'Khác'}

## CHỈ SỐ BÁO CÁO (METRICS)
- Trạng thái: Đang có ${adData.active_ads} nhóm active trên tổng ${adData.total_ads} nhóm.
- Tổng chi tiêu (Spend): ${adData.total_spend}đ
- Số lượt hiển thị (Impressions): ${adData.total_impressions}
- CPM: ${adData.cpm}đ
- Số Click: ${adData.total_clicks} (CTR: ${adData.ctr_all}%)
- Khách nhắn (Mess): ${adData.total_mess}
- Giá mỗi Mess (CPMess): ${adData.cost_per_mess}đ (Ngưỡng an toàn là <=250000đ)

## YÊU CẦU:
1. Đánh giá TỔNG QUAN xem bài viết này đang thất bại hay thành công (Dựa trên CPM, CTR, Giá Mess).
2. Phân tích nguyên nhân TẠI SAO NGAY TRONG CONTENT TẠO RA KẾT QUẢ ĐÓ (Ví dụ phân tích Hook câu đầu tiên, Góc độ tiếp cận (Angle), Lời gạ gẫm (Call to Action), Điểm chạm tâm lý khách hàng).
3. Gợi ý 2-3 Hướng phát triển: Nếu tốt thì mở rộng ra các dạng nào, nếu xấu thì nên sửa lại angle/hook gì.

Trả về 1 bài phân tích bằng chuẩn định dạng Tiếng Việt MARKDOWN, trình bày chuyên nghiệp, in đậm các ý chính, sử dụng emoji phù hợp. TRẢ VỀ DUY NHẤT VĂN BẢN MARKDOWN, KHÔNG BỌC VÀO JSON.`;

  try {
    const response = await axios.post(
      `${GEMINI_API_URL}?key=${config.gemini.apiKey}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 2048,
        },
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 90000,
      }
    );
    
    const parts = response.data.candidates?.[0]?.content?.parts || [];
    let text = '';
    for (const part of parts) {
      if (!part.thought) text += (part.text || '');
    }
    return { success: true, analysis: text.trim() };
  } catch (err) {
    logger.error('analyzeAdPerformance failed', { error: err.message });
    return { success: false, error: err.message };
  }
}

async function callGeminiText(prompt) {
  const MAX_RETRIES = 3;
  const BASE_DELAY = 3000;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(
        `${GEMINI_API_URL}?key=${config.gemini.apiKey}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.5, maxOutputTokens: 8192 }
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
      );
      const parts = response.data.candidates?.[0]?.content?.parts || [];
      let text = '';
      for (const part of parts) if (!part.thought) text += (part.text || '');
      return text.trim();
    } catch (err) {
      const status = err.response?.status;
      if (attempt < MAX_RETRIES && (status === 429 || status >= 500)) {
        logger.warn(`Gemini API error ${status} (Text), retrying in ${BASE_DELAY * attempt}ms...`);
        await new Promise(r => setTimeout(r, BASE_DELAY * attempt));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Lập kế hoạch Chiến Lược Tổng Thể cho tuần/tháng (Chained 4-Phase System)
 */
async function generateStrategyReport(timeLabel, serviceLabel, stats, winners, losers) {
  const formatAd = (ad) => {
    let body = ad.creative?.body || 'Không có';
    if (body.length > 2500) body = body.substring(0, 2500) + '... (lược bớt)';
    return `
- Tên Ads: ${ad.sample_ad_name}
  * Metric: Tiêu ${ad.total_spend}đ | CPMess ${ad.cost_per_mess}đ | Mess: ${ad.total_mess}
  * Target: ${ad.targeting || 'Broad'}
  * Creative Copy:
    [Tiêu đề]: ${ad.creative?.title || 'Không có'}
    [Nội dung]: ${body}
`;
  };

  let kpiString = 'Chưa có thông số so sánh Target';
  if (stats.targetKpi) {
    kpiString = `Mục tiêu KPI (Cũ): Tối đa ${stats.targetKpi.kpi_spend}đ, Đạt ${stats.targetKpi.kpi_mess} tin nhắn`;
  }
  
  let manualMetricsStr = '';
  if (stats.manualMetrics && (stats.manualMetrics.leads > 0 || stats.manualMetrics.revenue > 0)) {
    const mm = stats.manualMetrics;
    const rev = Number(mm.revenue).toLocaleString('vi-VN');
    manualMetricsStr = `\n[CHỈ SỐ CHUNG TOÀN VIỆN TỪ VẬN HÀNH (THỰC TẾ)]
- Số Leads: ${mm.leads} | Khách Hẹn: ${mm.bookings} | Khách Đến: ${mm.arrivals} | Khách Chốt: ${mm.deals}
- Tổng Doanh Thu: ${rev} VNĐ
*Lưu ý từ Ban Giám Đốc: Hãy phân tích dựa trên sự liên kết giữa cấu trúc phân bổ Ngân sách (Budget) cho các dịch vụ và các chỉ số toàn viện (Leads, Hẹn, Đến, Chốt, Doanh Thu) ở trên. So sánh ngầm định kết quả này với tỷ lệ trung bình tháng để đánh giá mức độ khỏe mạnh của phễu kinh doanh toàn viện.*`;
  }
  
  const isAllServices = serviceLabel.includes('Tất cả');

  const adsList = `🔴 **TOP WINNER ADS (HIỆU QUẢ CAO NHẤT):**\n${winners.length > 0 ? winners.map(formatAd).join('\n') : 'Không có'}\n\n🔴 **TOP LOSER ADS (KÉM HIỆU QUẢ NHẤT):**\n${losers.length > 0 ? losers.map(formatAd).join('\n') : 'Không có'}`;

  // PHASE 1: OVERVIEW
  const overviewPrompt = `Bạn là Giám Đốc Marketing. Dựa trên số liệu Ads mảng ${serviceLabel} thời gian ${timeLabel}:
1. TỔNG QUAN HỆ THỐNG
- Đã tổng tiêu: ${stats.totalSpend}đ | Lượng Mess: ${stats.totalMess} | Giá trung bình: ${stats.avgCpmess}đ (Ngưỡng an toàn là <=250k)
- ${kpiString}${manualMetricsStr}

${stats.campaignMetaString ? '2. TÌNH TRẠNG VẬN HÀNH CHIẾN DỊCH\n' + stats.campaignMetaString + '\n\n' : ''}[DANH SÁCH CÁC CHIẾN DỊCH HIỆN TẠI (ĐỂ THAM KHẢO)]:
(Lưu ý: Tên Ads thường chứa mã dịch vụ, ví dụ umau_ là U máu, chambot_ là Chàm bớt, nam_ là Nám, csd_ là Chăm sóc da...)
${adsList}

YÊU CẦU: Viết 1 đoạn gồm phần [TL;DR] (3 gạch đầu dòng tóm tắt nguyên nhân và giải pháp rủi ro) và phần [PHÂN TÍCH CẤU TRÚC NGÂN SÁCH] để đánh giá sự phân bổ budget giữa các nhánh dịch vụ, xem tiền đang dồn vào đâu, có sinh ra tỷ lệ chốt và doanh thu tương xứng không (Bỏ qua việc chỉ soi KPI tin nhắn). 
Từ Tình trạng vận hành Chiến dịch bên trên, hãy đưa thêm nhận xét đanh thép xem số lượng bài đang chết (Nát/Pause) có quá nhiều so với số lượng bài đang gánh (Scale) hay không để cảnh tỉnh đội ngũ.
${isAllServices ? 'CỰC KỲ QUAN TRỌNG: Bạn phải CHỈ ĐÍCH DANH mảng / nhánh dịch vụ nào đang cứu cánh doanh số, mảng nào đang đốt tiền (ví dụ U Máu hay Chàm bớt).' : ''}
*Lưu ý: Không viết quá dài dòng lặp ý, súc tích nhưng đầy đủ chiều sâu.*
Bắt buộc Format bằng Markdown. Mở đầu bằng Heading 1: "# 1️⃣ TỔNG QUAN & PHÂN TÍCH CẤU TRÚC BUDGET"`;

    // PHASE 2: DEEP DIVE
    const deepDivePrompt = `Bạn là Chuyên gia Copywriter & Tối ưu hóa Ads. Đọc nguyên văn các mẫu content (Win & Lose) sau trong mảng ${serviceLabel}:
${adsList}

YÊU CẦU: Phân tích rành mạch, đi sâu mổ xẻ TỪNG bài một trong danh sách. Tại sao câu Hook này lại hay, vì sao CTA kia bị fail, target có sai không? Tuyệt đối không cần đưa ra quy luật chung, hãy phân tích độ hiệu quả mang tính cá biệt cho mỗi Content để người dùng đọc hiểu tại sao nội dung cụ thể đó lại đạt/hoặc hụt CPMess. 
*Lưu ý: Nội dung xuất ra phải nguyên vẹn không bị cắt xén.*
Bắt buộc Format bằng Markdown. Mở đầu bằng Heading 1: "# 2️⃣ PHÂN TÍCH CHUYÊN SÂU TỪNG CHIẾN DỊCH"`;

    try {
      // Run sequentially to completely avoid Gemini Free Tier 429 Rate Limits (No parallel bursts)
      const overviewRes = await callGeminiText(overviewPrompt);
      const deepDiveRes = await callGeminiText(deepDivePrompt);
    
    // PHASE 3: PATTERNS AND RULES (Depends on Deep Dive)
    const patternsPrompt = `Bạn là Chuyên gia Phân Tích Data Dữ Liệu Marketing. Trong mảng ${serviceLabel}, một đồng nghiệp vừa nộp bản báo cáo mổ xẻ từng Ads dưới đây:
[BÁO CÁO CỦA ĐỒNG NGHIỆP]
${deepDiveRes}

YÊU CẦU: Tổng hợp và tạo ra "SÁCH TRẮNG QUY LUẬT". Đúc kết lại đúng 1 danh sách các "Quy luật Thành công" (những motif Angle, Hook, Từ khóa nào được khách hàng thích) và "Lỗi sai chung cần tránh" (những cạm bẫy từ ngữ, hình ảnh đang đốt tiền) dùng cho mảng ${serviceLabel}. Không cần nói dông dài.
Bắt buộc Format bằng Markdown. Mở đầu bằng Heading 1: "# 3️⃣ QUY LUẬT THÀNH CÔNG & SAI LẦM PHỔ BIẾN"`;
    
    const patternsRes = await callGeminiText(patternsPrompt);

    // PHASE 4: ACTION PLAN (Depends on Patterns)
    const actionPlanPrompt = `Bạn là Giám đốc Sáng tạo và Media. Dựa trên sự thành bại của hệ thống ${serviceLabel} thời gian qua cùng Bộ Quy luật sau:
[QUY LUẬT MARKETING]
${patternsRes}

YÊU CẦU: Lập Bản Kế Hoạch Kỳ Tới cho mảng ${serviceLabel} đi sâu vào tiểu tiết nhất có thể để Planner và Content Creator chạy ngay:
Được quyền phân nhỏ làm nhiều nhóm đối tượng/campaign nếu thích.
1. Target Audience: Chân dung, Độ tuổi, Vị trí địa lý, Tệp Interest (có nên gộp hay tách kĩ?).
2. Mẫu Content Sản Xuất Tiếp Theo: Gợi ý Tối thiểu 3 Công thức Tươi Mới (Chi tiết phần Angle, 3 Câu Hook cụ thể, Idea Creative là Text hay Video, Đoạn CTA đóng đuôi).
3. Cấu trúc Set Ads/Cấu trúc Campaign (Chiến lược phân bổ test và dồn ngân sách).
Bắt buộc Format Markdown sắc diện chuyên nghiệp nhất. Mở đầu bằng Heading 1: "# 4️⃣ KẾ HOẠCH HÀNH ĐỘNG KỲ TỚI (ACTION PLAN)"`;

    const actionPlanRes = await callGeminiText(actionPlanPrompt);

    const finalMarkdown = `${overviewRes}\n\n---\n\n${deepDiveRes}\n\n---\n\n${patternsRes}\n\n---\n\n${actionPlanRes}`;
    return { success: true, report: finalMarkdown };

  } catch (err) {
    logger.error('generateStrategyReport chained failed', { error: err.message });
    return { success: false, error: err.message };
  }
}

module.exports = { reviewContent, getGuidelines, updateGuidelines, analyzeAdPerformance, generateStrategyReport };
