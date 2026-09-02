export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '잘못된 접근입니다.' });
  }

  try {
    const { image } = req.body;
    const imageBase64 = image.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.' });
    }

    // 안정적인 gemini-3.5-flash 모델 적용
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`;

    const systemPrompt = `너는 전문 영수증 판독 AI이다. 첨부된 영수증의 텍스트와 하드 데이터만을 정확히 추출하라.
부가세(VAT), 과세물품가액, 면세가액 등 세금 관련 항목은 절대 추출하지 말고 완전히 무시하라. 오직 실제 결제 금액을 기준으로 정산하라.

[핵심 규칙 - 제품명 복원 지침]
- 영수증에 인쇄된 줄임말이나 약어(productOcr)를 그대로 상상해서 지어내지 말고, 반드시 실시간 검색 도구를 사용하여 실제 시중에 유통되는 정확한 쇼핑 제품명이나 표준 상품명으로 'productAi'를 완성하라.
- 존재하지 않는 가상의 제품명(예: 영수증에 없는 임의의 맛이나 형태)을 절대 창조하지 말 것.

'shopName' 필드에는 상호명을 AI로 정밀 복원하여 기입하고, 'shopCategory'에는 업종·업태명, 'shopMatchType'에는 검색에 사용된 정보 종류명만 기입하라. 절대 마크다운 백틱 없이 순수 JSON 객체만 반환하라.`;

    const promptText = `
첨부된 영수증 이미지를 판독하여 아래 JSON 스키마에 맞추어 데이터를 생성하라.
주의사항: 부가세는 포함하지 말 것. 제품 개별 할인은 products 내부에, 결제 단계에서의 전체 가감액(전체 제휴할인, 배송비 등)은 overallElements에 명확히 분리하여 기입하라.

{
  "shopOcr": "영수증 상단 인쇄 상호명",
  "shopName": "AI로 정밀 복원된 상호명",
  "shopCategory": "업종·업태",
  "shopMatchType": "검색 정보 종류명",
  "shopMatchBasis": "판독 근거",
  "date": "YYYY-MM-DD",
  "bizNo": "사업자번호",
  "phone": "전화번호",
  "address": "매장주소",
  "explicitTotal": "최종 결제 금액 숫자만",
  "overallElements": [
    { "name": "전체 할인/가산 항목명 (예: 멤버십할인, 배달비)", "type": "discount 또는 fee", "amount": "금액" }
  ],
  "products": [
    {
      "productOcr": "영수증판독 제품명",
      "productAi": "실제 검색된 정확한 표준 제품명",
      "recoveryProcess": "복원 프로세스 요약 (검색 활용 내용 포함)",
      "logicReview": "무결성 검토",
      "originalPrice": "제품 1개 정가",
      "discount": "해당 제품에만 적용된 할인액",
      "finalPrice": "제품 실구매가"
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
        // [핵심 포인트] Gemini 내부 실시간 검색(Grounding) 툴 활성화
        tools: [
          { google_search: {} }
        ],
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
    const aiTextResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const cleanJsonText = aiTextResponse.replace(/```json\n?|```/g, '').trim();
    
    let parsedData;
    try {
      parsedData = JSON.parse(cleanJsonText);
    } catch (parseError) {
      throw new Error('AI 응답을 JSON으로 변환하는 데 실패했습니다.');
    }

    res.status(200).json(parsedData);

  } catch (error) {
    console.error('Backend API Error:', error);
    res.status(500).json({ error: error.message || '서버 에러가 발생했습니다.' });
  }
}