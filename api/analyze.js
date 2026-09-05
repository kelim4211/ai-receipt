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

    const systemPrompt = `전문 영수증 판독 AI. 
[엄격한 출력 및 발췌 규칙]
- 마크다운(backticks) 기호를 절대 포함하지 말고 순수 JSON만 출력하십시오.
- 글자가 흐릿하거나 구겨져 있어도 절대 임의의 단어를 지어내거나 유추하지 마십시오.
- productOcr: 영수증에 인쇄된 글자를 펜 자국이나 구김이 있더라도 눈에 보이는 그대로 100% 발췌하십시오.
- productAi: productOcr의 글자가 심하게 훼손/축약되어 검색이 불가능한 경우, 편의점 및 마트 상품 지식을 동원하여 '실제로 존재하는 정확한 표준 제품명'으로 교정하십시오. (없는 제품 창조 금지)
- 증정품은 totalPrice와 finalPrice를 "0"으로 처리하십시오.
- [중복 계산 방지 규칙]: 세금 항목(부가세, 과세물품가액 등), 총합계, 받은금액, 거스름돈, 결제금액(신용카드 등 단순 결제수단 금액), 품목 할인의 단순 합산액은 절대 overallElements에 포함하지 마십시오.
- overallElements에는 품목별 할인이 아닌, 영수증 전체에 적용된 일괄 할인과 추가 비용(봉투값 등)만 포함하십시오. 영수증 전체 일괄 할인의 항목명은 반드시 "총액 차감 (할인명)" 형태로 구체적인 명칭을 병기하십시오. (예: "총액 차감 (결제 할인)", "총액 차감 (포인트 사용)")`;

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
    { "name": "항목명 (반드시 '총액 차감 (할인명칭)' 형태로 기재. 예: 총액 차감 (포인트 사용). 부가세 및 결제금액 절대 제외)", "amount": "할인은 -금액, 추가는 +금액" }
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
        system_instruction: {
          parts: [{ text: systemPrompt }]
        },
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
        return res.status(500).json({ error: '영수증 데이터 구조 파싱 중 오류가 발생했습니다.' });
      }
    }

    return res.status(200).json(finalData);

  } catch (error) {
    return res.status(500).json({ error: error.message || '서버 에러가 발생했습니다.' });
  }
}