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

    const systemPrompt = `전문 영수증 판독 AI. 영수증 이미지의 모든 품목과 금액을 누락 없이 정확하게 추출하십시오.`;

    const promptText = `영수증을 분석하여 지정된 JSON Schema 형식에 맞춰 데이터를 추출하시오. 품목명 내부에 실제 줄바꿈을 넣지 말고 한 줄로 평탄화하여 작성하시오.`;

    // [핵심] API 레벨에서 JSON 구조와 타입을 엄격히 강제하는 스키마 정의
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
          response_schema: responseSchema, // API 구조 강제 적용
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
        // [이중 방어] 혹시라도 남어있는 줄바꿈이나 제어문자를 강제 치환
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
