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

    const systemPrompt = `전문 영수증 판독 AI. 세금 항목 무시, 실제 결제 금액 기준 정산. 사칙연산·나눗셈·단가 역산 금지.
[엄격한 출력 규칙]
- 마크다운(backticks) 기호(\`\`\`, \`\`\`json)를 절대 포함하지 마십시오. 오직 순수한 JSON 문자열만 출력하십시오.
- 할인 항목(-)이나 증정 등 복잡한 텍스트가 있더라도 유효한 JSON 문법을 철저히 준수하십시오.
- productAi는 지점명을 빼고, 다이소나 마트 PB상품은 유통사명이나 품번을 결합하여 포털 검색에 최적화된 명사형 표준 제품명으로 복원하십시오.`;

    const promptText = `영수증 이미지를 분석하여 아래 포맷의 순수 JSON으로만 응답하시오:
{
  "shopOcr": "상호명",
  "shopName": "정식 상호명",
  "shopMatchBasis": "판독 근거",
  "date": "YYYY-MM-DD",
  "bizNo": "사업자번호",
  "phone": "전화번호",
  "address": "매장주소",
  "overallElements": [
    { "name": "항목명", "amount": "할인은 -금액, 추가는 +금액" }
  ],
  "products": [
    {
      "productOcr": "원본 텍스트 및 품번",
      "productAi": "검색에 최적화된 복원 제품명",
      "totalPrice": "우측 끝 인쇄 금액",
      "discount": "할인액(숫자만, 없으면 0)",
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
          max_output_tokens: 1500
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
      return res.status(500).json({ error: 'AI 응답 형식이 올바르지 않습니다.' });
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
        return res.status(500).json({ error: '영수증 데이터 구조 파싱 중 오류가 발생했습니다. 다시 시도해 주세요.' });
      }
    }

    return res.status(200).json(finalData);

  } catch (error) {
    return res.status(500).json({ error: error.message || '서버 에러가 발생했습니다.' });
  }
}