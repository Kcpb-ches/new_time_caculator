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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
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
              text: '請辨識這張台灣警察系統智慧照片截圖中的資料，以JSON格式回傳以下欄位（找不到的欄位留空字串）：{"name":"姓名","gender":"性別只填男或女","idNumber":"身分證號","birthDate":"出生日期民國格式如052/12/24","householdAddr":"戶籍地","currentAddr":"現居地"}。只回傳JSON，不要其他文字。'
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
