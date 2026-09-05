export const maxDuration = 30;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '잘못된 접근입니다.' });
  }

  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: '이미지 데이터가 없습니다.' });

    const imageBase64 = image.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.' });

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    // 핵심: AI의 사전 지식을 동원한 오타 교정 지시문 추가
    const systemPrompt = `전문 영수증 판독 AI. 세금 항목 무시, 실제 결제 금액 기준 정산.
[엄격한 출력 및 지능형 보정 규칙]
- 마크다운 없이 순수 JSON만 출력하십시오.
- productOcr: 영수증에 인쇄된 글자를 펜 자국이나 구김이 있더라도 눈에 보이는 그대로 100% 발췌하십시오.
- productAi: productOcr의 글자가 펜 자국 등으로 심하게 훼손되거나 축약되어 검색이 불가능한 경우(예: '액티더블세' 등), 한국 편의점 및 마트 상품 데이터베이스 지식을 동원하여 '실제로 존재하는 정확한 표준 제품명(예: 액티비아 더블)'으로 문맥에 맞게 지능적으로 교정하십시오. 단, 존재하지 않는 제품을 임의로 창조하지는 마십시오.`;

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
      "productAi": "사전 지식 기반으로 오타/축약어가 교정된 정확한 복원 제품명",
      "totalPrice": "우측 끝 인쇄 금액 (증정은 0)",
      "discount": "할인액(없으면 0)",
      "finalPrice": "실제 결제 금액 (증정은 0)"
    }
  ]
}`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          response_mime_type: "application/json",
          max_output_tokens: 4000
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
    if (!response.ok) return res.status(500).json({ error: 'AI 서버 통신 중 오류가 발생했습니다.' });

    let parsedApiResponse;
    try {
      parsedApiResponse = JSON.parse(responseText);
    } catch (e) {
      return res.status(500).json({ error: 'AI 응답 형식이 올바르지 않습니다.' });
    }

    let rawJsonText = parsedApiResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawJsonText) return res.status(500).json({ error: 'AI가 빈 응답을 반환했습니다.' });

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