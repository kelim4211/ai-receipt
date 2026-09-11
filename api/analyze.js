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

    // gemini-3.6-flash 엔드포인트 적용
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    const systemPrompt = `전문 영수증 분석기입니다. JSON을 절대 출력하지 마십시오.
오직 아래의 줄 단위 텍스트 형식 규칙에 맞춰서만 출력하십시오.

[출력 양식]
SHOP: 상호명 | 업종 | 일자 | 사업자번호 | 전화번호 | 주소
ITEM: 원본제품명 | 복원제품명 | 단가또는총액 | 할인금액 | 최종금액
ETC: 항목명 | 금액

[복원제품명 작성 규칙]
- 상세 물리적 치수(cm, mm 등)와 기호(*, 괄호 등)는 과감히 제거할 것.
- 외부 지식을 임의로 유추하지 말고, 영수증에 판독된 "유통사명 + 핵심 품목명 + 순수 품번" 조합으로 작성할 것 (예: 다이소 타포린백 1039523).
- 품번이나 유통사 정보가 없으면 원본 품목명을 그대로 반영할 것.

[정산 및 요약(ETC) 금지 규칙 - 엄격 준수]
- '과세 합계', '과세', '부가세', '세액', 'VAT', '판매 합계', '합계', '총액', '받은금액', '거스름돈', '카드결제' 등 세금 및 결제 합계 관련 항목은 일체 ETC에 작성하지 말 것.
- 오직 '통신사 할인', '포인트 사용', '쿠폰 할인' 같은 실질적인 차감/할인 내역만 ETC로 작성할 것. 없으면 ETC 라인을 아예 출력하지 말 것.

[출력 예시]
SHOP: 다이소 안양점 | 소매업 | 2026-03-29 | 123-45-67890 | 031-000-0000 | 경기도 안양시
ITEM: 매장용 종이 소비자봉투(대) [09922] | 다이소 종이봉투 09922 | 200 | 0 | 200
ITEM: 컬러부직포스타핑(핑크) [50031] | 다이소 부직포스타핑 50031 | 1000 | 0 | 1000
ETC: 포인트 사용 | -500`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemPrompt }]
        },
        generationConfig: {
          max_output_tokens: 8000
        },
        contents: [
          {
            parts: [
              { text: "영수증 이미지를 분석하여 [출력 양식]에 맞춰 줄 단위로 추출하시오. 과세, 부가세, 합계 라인은 절대 출력하지 마시오." },
              { inline_data: { mime_type: "image/jpeg", data: imageBase64 } }
            ]
          }
        ]
      })
    });

    const responseText = await response.text();
    if (!response.ok) {
      console.error("Gemini API Error Detail:", responseText);
      return res.status(500).json({ error: `AI 서버 통신 실패 (${response.status}): ${responseText}` });
    }

    let parsedApiResponse;
    try {
      parsedApiResponse = JSON.parse(responseText);
    } catch (e) {
      return res.status(500).json({ error: 'AI 응답 수신 중 오류가 발생했습니다.' });
    }

    const rawText = parsedApiResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) {
      return res.status(500).json({ error: 'AI 분석 결과가 비어 있습니다.' });
    }

    const resultData = {
      shopOcr: '',
      shopName: '',
      shopIndustry: '',
      date: '',
      bizNo: '',
      phone: '',
      address: '',
      overallElements: [],
      products: []
    };

    const cleanStr = (str) => (str || '').replace(/^["']|["']$/g, '').trim();
    const cleanNum = (str, fallback = '0') => {
      if (!str) return fallback;
      const val = str.replace(/,/g, '').trim();
      return val || fallback;
    };

    // 부가세, 단순합계, 결제수단 강제 차단 정규식 (과세 합계, 판매 합계, 부가세 등 원천 제외)
    const blockedTermsRegex = /(과세|면세|부가세|세액|vat|판매\s*합계|합계|총액|받은\s*금액|거스름\s*돈|결제|카드)/i;

    const lines = rawText.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('SHOP:')) {
        const parts = trimmed.substring(5).split('|').map(cleanStr);
        resultData.shopName = parts[0] || '상호명 미확인';
        resultData.shopOcr = parts[0] || '';
        resultData.shopIndustry = parts[1] || '';
        resultData.date = parts[2] || '';
        resultData.bizNo = parts[3] || '';
        resultData.phone = parts[4] || '';
        resultData.address = parts[5] || '';
      } else if (trimmed.startsWith('ITEM:')) {
        const parts = trimmed.substring(5).split('|').map(cleanStr);
        if (parts[0]) {
          const rawTotal = cleanNum(parts[2], '0');
          const rawDiscount = cleanNum(parts[3], '0');
          const rawFinal = cleanNum(parts[4], rawTotal);

          resultData.products.push({
            productOcr: parts[0],
            productAi: parts[1] || parts[0],
            totalPrice: rawTotal,
            discount: rawDiscount,
            finalPrice: rawFinal
          });
        }
      } else if (trimmed.startsWith('ETC:')) {
        const parts = trimmed.substring(4).split('|').map(cleanStr);
        const name = parts[0] || '';
        
        // 부가세 및 단순 합계 항목 제외
        if (name && !blockedTermsRegex.test(name)) {
          resultData.overallElements.push({
            name: name,
            amount: cleanNum(parts[1], '0')
          });
        }
      }
    }

    return res.status(200).json(resultData);

  } catch (error) {
    return res.status(500).json({ error: error.message || '서버 내부 처리 오류가 발생했습니다.' });
  }
}
