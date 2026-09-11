export const maxDuration = 30;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '잘못된 접근입니다.' });
  }

  try {
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: '이미지 데이터가 없습니다.' });
    }

    const imageBase64 = image.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.' });
    }

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    const systemPrompt = `전문 영수증 판독 AI. 마크다운 기호 없이 순수 JSON만 출력할 것.
[엄격한 데이터 정제 및 검색 최적화 규칙]
- productOcr: 영수증에 인쇄된 원본 텍스트를 대괄호와 품번, 규격 포함하여 그대로 100% 발췌할 것.
- productAi: 상세 물리적 치수(cm 등)와 불필요한 기호는 과감히 제거하되, '유통사명 + 핵심 품목명 + 대괄호를 뺀 순수 품번' 조합으로 구성할 것 (예: "다이소 타포린백 1039523").
- [줄바꿈 금지 지침]: JSON 문자열 값 내부에는 실제 줄바꿈(\\n)을 절대 넣지 말고, 여러 줄의 텍스트는 반드시 공백으로 이어 한 줄로 출력할 것.
- 증정품은 totalPrice와 finalPrice를 "0"으로 처리.
- 세금, 총합계, 받은금액, 거스름돈, 단순 결제수단 금액은 overallElements 제외. 전체 일괄 할인은 '총액 차감 (할인명)' 형태로 기재.`;

    const promptText = `영수증 분석 후 아래 JSON 포맷으로만 응답하시오:
{
  "shopOcr": "상호명",
  "shopName": "정식 상호명",
  "shopIndustry": "업종·업태 및 한 줄 요약",
  "date": "YYYY-MM-DD",
  "bizNo": "사업자번호",
  "phone": "전화번호",
  "address": "매장주소",
  "overallElements": [
    { "name": "총액 차감 (할인명)", "amount": "할인은 -금액, 추가는 +금액" }
  ],
  "products": [
    {
      "productOcr": "원본 텍스트",
      "productAi": "유통사명 + 핵심 품목명 + 순수 품번 (대괄호 제거, 줄바꿈 없음)",
      "totalPrice": "우측 끝 인쇄 금액",
      "discount": "할인액(없으면 0)",
      "finalPrice": "실제 결제 금액"
    }
  ]
}`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemPrompt }]
        },
        generationConfig: {
          response_mime_type: "application/json",
          max_output_tokens: 2000
        },
        contents: [
          {
            parts: [
              { text: promptText },
              { inline_data: { mime_type: "image/jpeg", data: imageBase64 } }
            ]
          }
        ]
      })
    });

    const responseText = await response.text();

    if (!response.ok) {
      return res.status(500).json({ error: 'AI 서버 통신 중 오류가 발생했습니다.' });
    }

    let parsedApiResponse;
    try {
      parsedApiResponse = JSON.parse(responseText);
    } catch (e) {
      return res.status(500).json({ error: 'AI 응답 형식을 처리하는 중 오류가 발생했습니다.' });
    }

    let rawJsonText = parsedApiResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawJsonText) {
      return res.status(500).json({ error: 'AI가 빈 응답을 반환했습니다.' });
    }

    rawJsonText = rawJsonText.replace(/```json/gi, '').replace(/```/g, '').trim();
    
    const firstBrace = rawJsonText.indexOf('{');
    const lastBrace = rawJsonText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      rawJsonText = rawJsonText.substring(firstBrace, lastBrace + 1);
    }

    let finalData;
    try {
      finalData = JSON.parse(rawJsonText);
    } catch (err) {
      try {
        let sanitized = rawJsonText
          .replace(/\r?\n|\r/g, " ") 
          .replace(/[\u0000-\u001F]+/g, " ") 
          .replace(/,\s*([}\]])/g, '$1');
        finalData = JSON.parse(sanitized);
      } catch (innerErr) {
        return res.status(500).json({ error: '영수증 데이터 구조 파싱 중 오류가 발생했습니다.' });
      }
    }

    return res.status(200).json(finalData);

  } catch (error) {
    return res.status(500).json({ error: error.message || '서버 에러가 발생했습니다.' });
  }
}
