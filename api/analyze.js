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
[핵심 데이터 가공 및 정제 규칙]
1. productOcr: 영수증에 인쇄된 원본 텍스트를 줄바꿈 없이 한 줄로 평탄화하여 그대로 발췌할 것.
2. productAi (필수 준수): 
   - 상세 물리적 치수(cm 등)와 불필요한 기호(*, 괄호 등)는 과감히 제거할 것.
   - 반드시 "유통사명 + 핵심 품목명 + 대괄호를 뺀 순수 품번" 형태로 조합하여 작성할 것. (예: "다이소 타포린백 1039523")
   - 원본 텍스트를 단순히 그대로 복사하지 말고 위 가공 규칙을 철저히 적용할 것.
3. JSON 문자열 값 내부에 실제 줄바꿈 문자(\\n)를 절대 넣지 말고 한 줄로 이어 출력할 것.
4. 세금, 총합계, 받은금액, 거스름돈, 단순 결제수단 금액은 overallElements에서 제외하고 전체 일괄 할인은 '총액 차감 (할인명)' 형태로 기재할 것.`;

    const promptText = `영수증을 분석하여 지정된 JSON Schema 형식에 맞춰 데이터를 추출하시오.`;

    // API 구조 및 타입 강제 스키마
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
        console.error("JSON 파싱 최종 실패 원본:", rawJsonText);
        return res.status(500).json({ error: '영수증 데이터 구조 파싱 중 오류가 발생했습니다.' });
      }
    }

    return res.status(200).json(finalData);

  } catch (error) {
    return res.status(500).json({ error: error.message || '서버 에러가 발생했습니다.' });
  }
}
