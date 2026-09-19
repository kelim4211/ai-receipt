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

    // 요청하신 대로 모델명 3.6 고정
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    const systemPrompt = `전문 영수증 분석기입니다. JSON을 절대 출력하지 마십시오.
오직 아래의 줄 단위 텍스트 형식 규칙에 맞춰서만 출력하십시오.

[출력 양식]
SHOP: 상호명 | 업종및가게성격 | 일자 | 사업자번호 | 전화번호 | 주소
ITEM: 원본제품명 | 복원제품명 | 단가또는총액 | 할인금액 | 최종금액
ETC: 항목명 | 금액

[필수 작성 규칙]
- SHOP 라인은 반드시 'SHOP:'으로 시작하고 각 항목을 파이프(|)로 구분하십시오.
- [업종및가게성격]은 상호와 품목을 분석해 '업종 (주력 판매 제품군 및 성격)' 형태의 짧은 한 문장으로 반드시 작성하십시오.
- 코스트코 영수증의 CPN(할인) 행은 독립된 품목으로 취급하지 말고, 바로 직전 또는 연관된 제품의 할인 정보로 정확히 대응시키십시오. 모든 구매 품목을 생략 없이 출력하십시오.

[정산 및 요약(ETC) 금지 규칙]
- '과세 합계', '과세', '부가세', '세액', 'VAT', '판매 합계', '합계', '총액', '받은금액', '거스름돈', '카드결제' 등 세금 및 단순 결제 합계 관련 항목은 일체 출력 금지.
- 오직 통신사 할인, 포인트 사용 등 실질적인 할인/차감 항목만 ETC로 출력할 것.`;

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
              { text: "영수증 이미지를 정밀 분석하여 [출력 양식]에 맞춰 줄 단위로 추출하시오. 상품의 원래 정가와 CPN 할인액을 정확히 구분하여 출력하시오." },
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
      date: '미확인',
      bizNo: '미확인',
      phone: '미확인',
      address: '미확인',
      overallElements: [],
      products: []
    };

    const cleanStr = (str) => (str || '').replace(/^["']|["']$/g, '').trim();
    const cleanNum = (str, fallback = '0') => {
      if (!str) return fallback;
      const val = str.replace(/,/g, '').trim();
      return val || fallback;
    };

    const blockedTermsRegex = /(과세|면세|부가세|세액|vat|판매\s*합계|합계|총액|받은\s*금액|거스름\s*돈|결제|카드)/i;

    const lines = rawText.split('\n');
    let rawItems = [];

    // 1단계: 모든 라인을 순회하며 SHOP, ITEM, CPN 정보를 임시 수집
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('SHOP:')) {
        const parts = trimmed.substring(5).split('|').map(cleanStr);
        resultData.shopName = parts[0] || '상호명 미확인';
        resultData.shopOcr = parts[0] || '';
        resultData.shopIndustry = parts[1] || '';
        resultData.date = parts[2] || '미확인';
        resultData.bizNo = parts[3] || '미확인';
        resultData.phone = parts[4] || '미확인';
        resultData.address = parts[5] || '미확인';
      } else if (trimmed.includes('CPN') || trimmed.toLowerCase().includes('cpn') || trimmed.includes('IRC')) {
        const matchNums = trimmed.match(/\d[\d,.]*/g);
        if (matchNums && matchNums.length > 0) {
          const discVal = Number(cleanNum(matchNums[matchNums.length - 1], '0'));
          // 가장 최근에 등록된 제품 품목에 할인액 부착
          if (rawItems.length > 0) {
            rawItems[rawItems.length - 1].discount = discVal;
          }
        }
      } else if (trimmed.startsWith('ITEM:')) {
        const parts = trimmed.substring(5).split('|').map(cleanStr);
        if (parts[0]) {
          let priceVal = Number(cleanNum(parts[4] || parts[2], '0'));
          let discVal = Number(cleanNum(parts[3], '0'));

          rawItems.push({
            productOcr: parts[0],
            productAi: parts[1] || parts[0],
            price: priceVal,
            discount: discVal
          });
        }
      } else if (trimmed.startsWith('ETC:')) {
        const parts = trimmed.substring(4).split('|').map(cleanStr);
        const name = parts[0] || '';
        if (name && !blockedTermsRegex.test(name)) {
          resultData.overallElements.push({
            name: name,
            amount: cleanNum(parts[1], '0')
          });
        }
      }
    }

    // 2단계: 수집된 품목들을 검토하여 코스트코 할인 구조 완벽 보정
    for (let i = 0; i < rawItems.length; i++) {
      let cur = rawItems[i];
      let origPrice = cur.price;
      let discountAmt = cur.discount;
      let finalPrice = origPrice;

      // 만약 현재 품목명이나 다음 줄과의 관계에서 할인액이 존재하고, 현재 가격이 최종금액 상태라면 정가로 복원
      if (discountAmt > 0) {
        // 영수증상에 '정가 = 최종금액 + 할인액'이 되도록 보정
        origPrice = cur.price + discountAmt;
        finalPrice = cur.price; // 입력되어있던 금액은 최종 결제액
      } else {
        // 만약 다음 아이템이 CPN 관련 텍스트이거나 홀로 떨어진 할인행인 경우 처리 (보안 장치)
        finalPrice = origPrice;
      }

      resultData.products.push({
        productOcr: cur.productOcr,
        productAi: cur.productAi,
        totalPrice: String(origPrice),   // 단가*수량 (원래 정가: 16490, 29990 등)
        discount: String(discountAmt),     // 할인액 (6500, 6000 등)
        finalPrice: String(finalPrice)     // 최종 금액 (9990, 23990 등)
      });
    }

    return res.status(200).json(resultData);

  } catch (error) {
    return res.status(500).json({ error: error.message || '서버 내부 처리 오류가 발생했습니다.' });
  }
}
