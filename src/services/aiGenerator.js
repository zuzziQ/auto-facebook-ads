const axios = require('axios');
const { config } = require('../config');
const logger = require('../utils/logger');

const MODEL_ID = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL_ID + ':generateContent';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  if (!text) return null;

  try { return JSON.parse(text); } catch (e) {}

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const jsonStr = text.substring(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(jsonStr);
    } catch(e) {
      try {
        return JSON.parse(fixNewlinesInJSONStrings(jsonStr));
      } catch(ex) {}
    }
  }

  try {
    const stripped = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const fixed = fixNewlinesInJSONStrings(stripped);
    return JSON.parse(fixed);
  } catch (e) {
    console.error("FAILED TO PARSE JSON. RAW TEXT WAS:", text);
    return null;
  }
}

function extractTextFromResponse(responseData) {
  const parts = responseData.candidates?.[0]?.content?.parts || [];
  let fullText = '';
  for (const part of parts) {
    if (part.thought === true) continue;
    fullText += (part.text || '');
  }
  return fullText.trim();
}

async function generateWithGemini(prompt, expectJson = false, jsonSchema = null) {
  const MAX_RETRIES = 6;
  const BASE_DELAY = 4000;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192
    }
  };

  if (expectJson && jsonSchema) {
    payload.generationConfig.responseMimeType = 'application/json';
    payload.generationConfig.responseSchema = jsonSchema;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(
        `${GEMINI_API_URL}?key=${config.gemini.apiKey}`,
        payload,
        { headers: { 'Content-Type': 'application/json' }, timeout: 90000 }
      );
      
      if (expectJson) {
        const jsonRes = extractJSONFromResponse(response.data);
        if(!jsonRes) throw new Error("Could not parse JSON format.");
        return jsonRes;
      } else {
        return extractTextFromResponse(response.data);
      }
    } catch (err) {
      const status = err.response?.status;
      if ((status === 429 || status === 503 || status === 500) && attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY * Math.pow(2, attempt - 1));
        continue;
      }
      if (status === 503) {
        throw new Error("Hệ thống Google Gemini đang bị quá tải Server (Lỗi 503). Chờ 1 chút rớt thử lại nha sếp!");
      }
      throw err;
    }
  }
}

async function generateContent(kbClinic, kbDoctor, kbService, kbTech, kbRules, kbDesign, kbVideo, templateStructure, topic, formatType, videoDuration) {
  
  // ---------------------------------------------------------
  // PHASE 1: AGENT DỰNG KHUNG (OUTLINE AGENT)
  // ---------------------------------------------------------
  const outlinePrompt = `Bạn là một Chuyên gia Lên Concept (Outline Agent) cho phòng khám Aeslatek.

Dựa trên thông tin đầu vào:
--- KNOWLEDGE BASE: PHÒNG KHÁM AESLATEK ---
${kbClinic}

--- KNOWLEDGE BASE: BÁC SĨ ---
${kbDoctor}

--- KNOWLEDGE BASE: DỊCH VỤ ---
${kbService}

--- KNOWLEDGE BASE: THIẾT BỊ & CÔNG NGHỆ ---
${kbTech}

--- QUY TẮC NỘI DUNG Y TẾ ---
${kbRules}

--- ĐẶT HÀNG CONTENT YÊU CẦU ---
Chủ đề / Yêu cầu chính (Topic): ${topic}
Định dạng phát hành (Format): ${formatType}

--- CẤU TRÚC YÊU CẦU (TEMPLATE) ---
${templateStructure}

Nhiệm vụ: Bạn hãy tạo ra Dàn Ý Chi Tiết (Outline) cho một bài đăng hoặc kịch bản dựa vào tiêu chí Đặt hàng Content trên, lồng ghép hợp lý các thông tin từ Knowledge Base mà khách hàng cung cấp.
Không cần viết văn bản hoàn chỉnh, chỉ cần liệt kê Dàn ý chi tiết của từng đoạn văn sẽ nói những gì, nhấn mạnh ý gì. Chú ý tối ưu nội dung để phù hợp đặc thù của định dạng ${formatType}. Đặc biệt TUÂN THỦ NGHIÊM NGẶT CÁC QUY TẮC NỘI DUNG Y TẾ.`;

  const outline = await generateWithGemini(outlinePrompt, false);

  // ---------------------------------------------------------
  // PHASE 2: AGENT VIẾT BÀI (COPYWRITER AGENT)
  // ---------------------------------------------------------
  const copywriterPrompt = `Bạn là một Copywriter xuất chúng của phòng khám Aeslatek.

Dựa vào bộ Dàn Ý Chi Tiết (Outline) dưới đây:
--- OUTLINE ---
${outline}
---------------

Và định dạng được nhắm tới là: ${formatType} (Chủ đề: ${topic}).
Nhiệm vụ: Hãy chắp bút viết nội dung hoàn chỉnh có đầy đủ tính thuyết phục, cách kể chuyện (storytelling) tự nhiên nhưng không đánh mất tính chuyên gia Y Khoa. Sử dụng icon hợp lý. TUYỆT ĐỐI KHÔNG xuất ra bất kỳ lời bình luận hay giải thích nào khác ngoài Nội dung Bài Viết.`;

  const fbPostRaw = await generateWithGemini(copywriterPrompt, false);

  // ---------------------------------------------------------
  // PHASE 3: AGENT CREATIVE (CREATIVE DIRECTOR AGENT)
  // ---------------------------------------------------------
  const creativePrompt = `Bạn là một Giám Đốc Sáng Tạo (Creative Director).

Dưới đây là nội dung Content đã được duyệt:
--- NỘI DUNG CONTENT ---
${fbPostRaw}
--------------------------
Mục tiêu là phát hành dưới định dạng: ${formatType}.

--- QUY TẮC THIẾT KẾ (NẾU CÓ) ---
${kbDesign}

--- QUY TẮC VIDEO (NẾU CÓ) ---
${kbVideo}
(THỜI LƯỢNG VIDEO YÊU CẦU: ${formatType.includes('Video') ? videoDuration : 'Không áp dụng, đây không phải định dạng Video'})

Nhiệm vụ: Phân tích thông điệp của bài viết và trích xuất ra Yêu cầu hình ảnh và Yêu cầu kịch bản Video.
- Nếu định dạng là Ảnh/Album, hãy focus vào Design Brief. 
- Nếu định dạng là Video, ĐẢM BẢO kịch bản (số lượng cảnh quay, độ dài của lời bình Voiceover) phải được đo lường chính xác và NGẮN GỌN để khớp tuyệt đối với thời lượng ${videoDuration} (nhắc lại: tốc độ đọc bình thường là khoảng 3-4 từ/giây). Tuyệt đối không viết lan man vượt quá thời gian đã chọn!

Trình bày rõ ràng dưới dạng Markdown (dùng bullet, in đậm, list). TUÂN THỦ NGHIÊM NGẶT các quy tắc thiết kế và video bên trên nếu có.
Output MUST be in valid JSON format:
{
  "design_brief": "Markdown chi tiết yêu cầu thiết kế ảnh (Concept, Moodboard, Bố cục, Text chính trên mặt ảnh).",
  "video_brief": "Markdown chi tiết kịch bản, lời bình (Voice/Text), hiệu ứng cho Video Editor được kiểm soát chặt chẽ theo đúng thời lượng."
}`;

  const schema = {
    type: 'OBJECT',
    properties: {
      design_brief: { type: 'STRING' },
      video_brief: { type: 'STRING' }
    },
    required: ['design_brief', 'video_brief']
  };

  const briefs = await generateWithGemini(creativePrompt, true, schema);

  return {
    fb_post: fbPostRaw,
    design_brief: briefs.design_brief,
    video_brief: briefs.video_brief
  };
}

module.exports = { generateContent };
