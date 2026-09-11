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
[핵심 규칙 및 JSON 안정성 지침]
- OCR 텍스트는 눈에 보이는 그대로 100% 발췌하되, JSON 문법을 깨뜨리는 미처리 따옴표나 제어 문자는 안전하게 이스케이프 처리하거나 정제할 것.
- shopIndustry: 영수증 정보(상호,주소,전화번호) 기반 지도/포털 등록 업종·업태 및 한 줄 요약 기재.
- productAi: 다이소, 올리브영, 대형마트 등 PB/유통사 상품은 '유통사/브랜드 + 제품명' 형태로 교정. 단, 품목명 내부의 복잡한 괄호나 기호로 인해 파싱 오류가 나지 않도록 간결한 표준 형태로 교정할 것.
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
      "productAi": "복원된 제품명 (유통사 브랜드 결합 및 기호 정제 반영)",
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
          .replace(/[\u0000-\u001F]+/g, " ") 
          .replace(/,\s*([}\]])/g, '$1') 
          .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":');
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