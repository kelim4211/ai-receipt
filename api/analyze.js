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

    const systemPrompt = `전문 영수증 판독 AI. 반드시 완벽한 단일 JSON 객체 형태로만 응답할 것. 마크다운 기호 금지.`;

    const promptText = `영수증 이미지를 분석하여 아래 JSON 포맷으로만 응답하시오. 문자열 값 내부에 미처리된 줄바꿈이나 따옴표를 넣지 마시오:
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
      "productAi": "복원된 제품명",
      "totalPrice": "우측 끝 인쇄 금액",
      "discount": "0",
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

    // 마크다운 및 불필요한 공백 제거
    rawJsonText = rawJsonText.replace(/```json/gi, '').replace(/```/g, '').trim();
    
    const firstBrace = rawJsonText.indexOf('{');
    const lastBrace = rawJsonText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      rawJsonText = rawJsonText.substring(firstBrace, lastBrace + 1);
    }

    let finalData;
    try {
      // 1차 표준 파싱 시도
      finalData = JSON.parse(rawJsonText);
    } catch (err) {
      try {
        // [근본 방어 로직] JSON 내부의 깨진 줄바꿈(\n), 제어문자, 따옴표 충돌을 강제로 정제
        let sanitized = rawJsonText
          .replace(/\r?\n|\r/g, " ")                    // 문자열 값 내부의 줄바꿈을 공백으로 치환하여 문법 깨짐 방지
          .replace(/[\u0000-\u001F]+/g, " ")             // 제어 문자 제거
          .replace(/,\s*([}\]])/g, '$1');                // trailing comma 제거
          
        finalData = JSON.parse(sanitized);
      } catch (innerErr) {
        console.error("JSON 파싱 최종 실패 원본 텍스트:", rawJsonText);
        return res.status(500).json({ error: '영수증 데이터 구조 파싱 중 오류가 발생했습니다.' });
      }
    }

    return res.status(200).json(finalData);

  } catch (error) {
    return res.status(500).json({ error: error.message || '서버 에러가 발생했습니다.' });
  }
}