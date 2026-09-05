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
[검색어 생성 규칙]
- 각 품목별로 인터넷 쇼핑이나 포털에서 해당 제품을 가장 정확히 찾을 수 있는 최적의 맞춤 검색어('searchQuery')를 생성할 것.
- 다이소나 마트 PB 상품은 유통사명이나 품번을 포함하고, 일반 공산품은 지점명(예: 비산점)을 배제하고 순수 상품명 중심의 가장 정확한 쿼리를 구성할 것.`;

    const promptText = `영수증을 판독하여 마크다운(백틱 등) 없이 순수 JSON만 출력하라:
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
      "productAi": "표준 제품명",
      "searchQuery": "포털 검색 적중률을 극대화한 맞춤 검색어",
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
      console.error('Gemini API Error Response:', responseText);
      return res.status(500).json({ error: 'AI 서버 통신 중 오류가 발생했습니다.' });
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      console.error('Invalid JSON from Gemini API:', responseText);
      return res.status(500).json({ error: 'AI 응답 형식이 올바르지 않습니다.' });
    }

    let rawJsonText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawJsonText) {
      return res.status(500).json({ error: 'AI가 빈 응답을 반환했습니다. 다시 시도해 주세요.' });
    }

    rawJsonText = rawJsonText.replace(/```json\n?|```/g, '').trim();
    const firstBrace = rawJsonText.indexOf('{');
    const lastBrace = rawJsonText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      rawJsonText = rawJsonText.substring(firstBrace, lastBrace + 1);
    }

    let parsedData;
    try {
      parsedData = JSON.parse(rawJsonText);
    } catch (parseError) {
      console.error('JSON Parse Error:', rawJsonText);
      return res.status(500).json({ error: '영수증 데이터를 JSON으로 변환하는 데 실패했습니다.' });
    }

    return res.status(200).json(parsedData);

  } catch (error) {
    console.error('Backend API Exception:', error);
    return res.status(500).json({ error: error.message || '서버 에러가 발생했습니다.' });
  }
}