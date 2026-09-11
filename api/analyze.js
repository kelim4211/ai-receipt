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

    const systemPrompt = `전문 영수증 판독 AI. 지정된 JSON Schema 형식에 맞춰 데이터를 정확히 추출할 것.
[데이터 정제 및 조합 원칙]
1. productOcr: 영수증 원본 텍스트를 줄바꿈 없이 한 줄로 평탄화하여 그대로 발췌할 것.
2. productAi: 외부 지식 배제, 오직 영수증 판독 정보만 활용. 상세 치수(cm 등)와 기호 제거 후 "유통사명 + 핵심 품목명 + 대괄호 없는 순수 품번" 조합으로 작성 (예: "다이소 타포린백 1039523"). 정보 부족 시 원본 반영.
3. JSON 문자열 값 내부에 실제 줄바꿈 문자(\n) 금지, 한 줄로 출력할 것.
4. 세금, 총합계, 받은금액, 거스름돈, 단순 결제수단 금액은 overallElements 제외. 일괄 할인은 '총액 차감 (할인명)' 기재.`;

    const responseSchema = {
      type: "OBJECT",
      properties: {
        shopOcr: { type: "STRING" },
        shopName: { type: "STRING" },
        shopIndustry: { type: "STRING" },
        date: { type: "STRING" },
        bizNo: { type: "STRING" },
        phone: { type: "STRING" },
        address: { type: "STRING" },
        overallElements: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              name: { type: "STRING" },
              amount: { type: "STRING" }
            },
            required: ["name", "amount"]
          }
        },
        products: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              productOcr: { type: "STRING" },
              productAi: { type: "STRING" },
              totalPrice: { type: "STRING" },
              discount: { type: "STRING" },
              finalPrice: { type: "STRING" }
            },
            required: ["productOcr", "productAi", "totalPrice", "discount", "finalPrice"]
          }
        }
      },
      required: ["shopOcr", "shopName", "date", "products"]
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemPrompt }]
        },
        generationConfig: {
          response_mime_type: "application/json",
          response_schema: responseSchema,
          max_output_tokens: 4000 // 4000 토큰 설정
        },
        contents: [
          {
            parts: [
              { text: "제공된 영수증 이미지를 분석하여 스키마에 맞는 JSON 데이터를 출력하시오." },
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
      // 1차 소독 및 파싱 시도
      let sanitized = rawJsonText
        .replace(/[\u0000-\u001F]+/g, " ")
        .replace(/\r?\n|\r/g, " ");
      finalData = JSON.parse(sanitized);
    } catch (err1) {
      try {
        // 2차 강력 소독 및 파싱 시도
        let aggressiveSanitized = rawJsonText
          .replace(/[\u0000-\u001F]+/g, " ")
          .replace(/\r?\n|\r/g, " ")
          .replace(/,\s*([}\]])/g, '$1');
        finalData = JSON.parse(aggressiveSanitized);
      } catch (err2) {
        console.error("JSON 파싱 최종 실패 원본:", rawJsonText);
        return res.status(500).json({ error: '영수증 데이터 구조 파싱 중 오류가 발생했습니다.' });
      }
    }

    return res.status(200).json(finalData);

  } catch (error) {
    return res.status(500).json({ error: error.message || '서버 에러가 발생했습니다.' });
  }
}
