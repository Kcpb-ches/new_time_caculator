// Vercel Serverless Function: OCR via Claude API
// Requires env vars:
//   ANTHROPIC_API_KEY  — Claude API key
//   KV_REST_API_URL    — Upstash Redis (auto-set when connected to project)
//   KV_REST_API_TOKEN  — Upstash Redis (auto-set when connected to project)

const DAILY_LIMIT = 20;

async function kvIncr(url, token, key) {
  // Use Vercel KV REST API directly (no npm package needed)
  const res = await fetch(`${url}/incr/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
  const json = await res.json();
  return json.result;
}

async function kvExpire(url, token, key, seconds) {
  await fetch(`${url}/expire/${key}/${seconds}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // --- IP rate limiting (requires Vercel KV) ---
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  if (kvUrl && kvToken) {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress
      || 'unknown';
    const today = new Date().toISOString().slice(0, 10);
    const key = `ocr:${ip}:${today}`;

    try {
      const count = await kvIncr(kvUrl, kvToken, key);
      if (count === 1) await kvExpire(kvUrl, kvToken, key, 86400);
      if (count > DAILY_LIMIT) {
        return res.status(429).json({
          error: `今日使用次數已達上限（${DAILY_LIMIT} 次），請明日再試。`
        });
      }
    } catch (e) {
      // KV error: skip rate limiting rather than blocking the user
      console.warn('KV rate limit error:', e.message);
    }
  }

  // --- Validate input ---
  const { imageBase64, mediaType } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: '缺少圖片資料' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: '伺服器未設定 API Key，請聯絡管理員。' });

  // --- Call Claude API ---
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType || 'image/jpeg',
                data: imageBase64
              }
            },
            {
              type: 'text',
              text: `你是一個精確的OCR系統，專門辨識台灣警察系統「智慧照片」截圖中的個人資料表格。
圖片右側為一個兩欄表格，左欄是欄位名稱，右欄是資料值。請逐列仔細辨識每個欄位。

辨識規則：
- 【姓名】：中文姓名，通常2到4個字，逐字確認不可猜測
- 【性別】：只填「男」或「女」
- 【身分證號】：固定格式為1個大寫英文字母加9個數字，共10碼，請完整辨識每一碼
- 【出生日期】：民國年格式，如「052/12/24」，保留前導零
- 【戶籍地】：完整地址，包含縣市、區、路名、門牌號碼，逐字辨識不可省略
- 【現居地】：完整地址，包含縣市、區、路名、門牌號碼，逐字辨識不可省略
- 圖片解析度可能較低，請盡力辨識，無法確認的欄位留空字串

只回傳以下JSON格式，不要任何其他文字或說明：
{"name":"","gender":"","idNumber":"","birthDate":"","householdAddr":"","currentAddr":""}`
            }
          ]
        }]
      })
    });

    const json = await response.json();
    if (!response.ok) throw new Error(json.error?.message || response.statusText);

    let text = json.content[0].text.trim();
    // Strip markdown code block if present (e.g. ```json ... ```)
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const data = JSON.parse(text);

    // Convert birthDate: 052/12/24 → 52年12月24日
    if (data.birthDate) {
      const m = data.birthDate.match(/^0*(\d+)\/0*(\d+)\/0*(\d+)$/);
      if (m) {
        data.birthDate = `${parseInt(m[1], 10)}年${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日`;
      }
    }

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: '辨識失敗：' + e.message });
  }
};
