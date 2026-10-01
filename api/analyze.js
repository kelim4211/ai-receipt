// api/analyze.js
// Vercel Serverless Function: 15명 개인 전용 링크 관리 및 Gemini 1.5 Flash 분석

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MAX_TOTAL_USERS = 15;      // 최대 등록 허용 인원: 15명
const USER_USAGE_LIMIT = 200;    // 1인당 분석 횟수: 200회
const DEADLINE_TIMESTAMP = new Date('2026-10-16T18:00:00+09:00').getTime();

// Upstash Redis 명령 헬퍼
async function redisCommand(command, ...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    throw new Error('Upstash Redis 환경변수가 설정되지 않았습니다.');
  }

  const endpoint = `${UPSTASH_URL}/${[command, ...args].map(encodeURIComponent).join('/')}`;
  const res = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
  });
  
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

export default async function handler(req, res) {
  // 1. 유효 기한 확인 (10월 16일 18시)
  if (Date.now() > DEADLINE_TIMESTAMP) {
    return res.status(403).json({
      allowed: false,
      error: '앱 사용 기한이 만료되었습니다. (2026년 10월 16일 18시 마감)'
    });
  }

  // 2. 사용자 인증 코드 확인
  const userId = (req.method === 'GET' ? req.query.userId : req.body.userId)?.trim().toLowerCase();

  if (!userId || userId === 'unauthorized_guest') {
    return res.status(403).json({
      allowed: false,
      message: '개인 전용 링크(?u=코드)를 통해서만 접속하실 수 있습니다.'
    });
  }

  try {
    // 3. 15명 정원 및 등록 여부 검증
    const isMember = await redisCommand('SISMEMBER', 'receipt_allowed_users', userId);
    
    if (isMember !== 1) {
      const currentCount = await redisCommand('SCARD', 'receipt_allowed_users');
      if (currentCount >= MAX_TOTAL_USERS) {
        return res.status(403).json({
          allowed: false,
          message: '초대 정원(15명)이 모두 마감되었습니다.'
        });
      }
      // 신규 인원 등록 (15명 중 1자리 차지)
      await redisCommand('SADD', 'receipt_allowed_users', userId);
    }

    // 4. 해당 사용자의 누적 사용량 조회
    const usageKey = `usage:${userId}`;
    const currentUsage = parseInt((await redisCommand('GET', usageKey)) || '0', 10);
    const remainingQuota = Math.max(0, USER_USAGE_LIMIT - currentUsage);

    // GET 요청: 초기 잔여 쿼터 확인
    if (req.method === 'GET') {
      return res.status(200).json({
        allowed: true,
        remaining: remainingQuota,
        totalQuota: USER_USAGE_LIMIT
      });
    }

    // POST 요청: 영수증 분석 실행
    if (req.method === 'POST') {
      if (remainingQuota <= 0) {
        return res.status(403).json({
          error: `부여된 200회 사용 한도를 모두 소진하셨습니다.`
        });
      }

      const { image } = req.body;
      if (!image) {
        return res.status(400).json({ error: '분석할 영수증 이미지가 없습니다.' });
      }

      // Gemini Vision API 호출
      const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

      const promptText = `
너는 대한민국 가계동향조사 영수증 정밀 판독 AI 엔진이다.
반드시 아래 JSON 포맷으로만 응답하라. 마크다운(\`\`\`json) 기호 없이 순수 JSON만 반환하라.

{
  "shopOcr": "영수증에 적힌 상호명 원문",
  "shopName": "공식 상호명 (예: 다이소 부천중동점, 이마트 역삼점 등 추정 포함)",
  "shopConfidence": "official" 또는 "estimated",
  "shopReason": "AI 복원 유추 근거 (official인 경우 빈 문자열)",
  "searchBrand": "포털 검색용 핵심 브랜드명 (예: 다이소, 이마트, CU)",
  "date": "YYYY-MM-DD",
  "bizNo": "000-00-00000",
  "phone": "00-000-0000",
  "address": "매장 도로명 또는 지번 주소",
  "receiptTotal": 최종 결제 금액 (숫자만),
  "products": [
    {
      "productOcr": "영수증에 찍힌 상품 원문",
      "productAi": "복원된 상품 정식 명칭",
      "totalPrice": 단가*수량 정상가 (숫자만),
      "discount": 단품 할인액 (없으면 0),
      "discountName": "할인명칭 (예: 행사할인, 쿠폰)",
      "finalPrice": 실구매가 (숫자만)
    }
  ],
  "overallElements": [
    {
      "name": "영수증 전체 할인 또는 봉투값/배송비",
      "amount": 금액 (할인은 음수, 추가금은 양수)
    }
  ]
}`;

      const geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: promptText },
              { inline_data: { mime_type: "image/jpeg", data: base64Data } }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            response_mime_type: "application/json"
          }
        })
      });

      const geminiData = await geminiRes.json();
      if (!geminiRes.ok) {
        throw new Error(geminiData.error?.message || 'Gemini AI 호출에 실패했습니다.');
      }

      const rawJson = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
      const cleanJson = rawJson.replace(/```json/g, '').replace(/```/g, '').trim();
      const analysisResult = JSON.parse(cleanJson);

      // 분석 성공 시 사용량 +1 차감
      const newUsage = await redisCommand('INCR', usageKey);
      analysisResult.remainingQuota = Math.max(0, USER_USAGE_LIMIT - newUsage);

      return res.status(200).json(analysisResult);
    }

    return res.status(405).json({ error: '허용되지 않는 메소드입니다.' });
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: error.message || '서버 처리 중 오류가 발생했습니다.' });
  }
}
