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

    // gemini-3.6-flash 엔드포인트 적용
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    const systemPrompt = `너는 전문 영수증 판독 AI이다. 첨부된 영수증의 텍스트와 하드 데이터만을 정확히 추출하라.
부가세(VAT), 과세물품가액, 면세가액 등 세금 항목은 완전히 무시하고 오직 실제 결제 금액 기준으로 정산하라.

[규칙 1: 제품명 추출 및 정규화]
- 영수증의 축약어, 잘린 문자열, 품번을 추출하고 내장된 유통 지식을 바탕으로 표준 제품명(productAi)으로 완성하라.

[규칙 2: 금액 추출 절대 원칙]
- 사칙연산, 나눗셈, 단가 역산 절대 금지.
- 'totalPrice'에는 영수증 행 우측 끝에 인쇄된 최종 금액 숫자를 있는 그대로 기입하라.`;

    const promptText = `영수증 이미지를 판독하여 아래 JSON 규격으로만 응답하라. 마크다운(백틱)이나 앞뒤 설명 없이 순수 JSON만 출력하라.
{
  "shopOcr": "영수증 상단 상호명",
  "shopName": "복원된 정식 상호명",
  "shopMatchBasis": "판독 근거(간결히)",
  "date": "YYYY-MM-DD",
  "bizNo": "사업자번호",
  "phone": "전화번호",
  "address": "매장주소",
  "overallElements": [
    { "name": "전체 할인/추가비용 명칭", "amount": "할인은 -금액, 추가비용은 +금액" }
  ],
  "products": [
    {
      "productOcr": "영수증 텍스트 및 품번",
      "productAi": "표준 제품명",
      "totalPrice": "우측 끝 인쇄 금액 숫자",
      "discount": "해당 품목 할인액(없으면 0)",
      "finalPrice": "실제 결제 금액(할인 없으면 totalPrice와 동일)"
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
          max_output_tokens: 3000 // 품목 수가 많아도 JSON이 중간에 잘리지 않도록 확장
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

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || 'Google API 통신 에러');
    }

    const data = await response.json();
    let rawJsonText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

    // 마크다운 백틱 및 앞뒤 잡다한 공백 완벽 제거
    rawJsonText = rawJsonText.replace(/```json\n?|```/g, '').trim();

    // 혹시 모를 설명 문구가 섞였을 때 가장 바깥쪽 { ... }만 추출
    const firstBrace = rawJsonText.indexOf('{');
    const lastBrace = rawJsonText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      rawJsonText = rawJsonText.substring(firstBrace, lastBrace + 1);
    }

    let parsedData;
    try {
      parsedData = JSON.parse(rawJsonText);
    } catch (parseError) {
      console.error('Raw AI Response Fail:', rawJsonText);
      throw new Error('AI 응답을 JSON으로 변환하는 데 실패했습니다.');
    }

    res.status(200).json(parsedData);

  } catch (error) {
    console.error('Backend API Error:', error);
    res.status(500).json({ error: error.message || '서버 에러가 발생했습니다.' });
  }
}