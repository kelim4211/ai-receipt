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

    const systemPrompt = `전문 영수증 분석기입니다. JSON을 절대 출력하지 마십시오.
오직 아래의 줄 단위 텍스트 형식 규칙에 맞춰서만 출력하십시오.

[출력 양식]
SHOP: 상호명 | 업종및가게성격 | 일자 | 사업자번호 | 전화번호 | 주소
ITEM: 원본제품명 | 복원제품명 | 단가또는총액 | 할인금액 | 최종금액
ETC: 항목명 | 금액

[영수증 금액 산출 핵심 규칙]
- 품목 행의 가장 오른쪽에 있는 가격이 '단가*수량(정가)'에 해당합니다.
- 아랫줄에 할인액이 나오면, 단가*수량(정가)에서 해당 할인액을 차감한 결과가 가장 오른쪽의 '최종 금액'이 됩니다. 이 구조를 정확히 반영하여 출력하십시오.

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
              { text: "영수증 이미지를 분석하여 윗줄의 가장 오른쪽 숫자를 단가*수량으로 잡고, 할인액을 차감한 금액을 최종 금액으로 설정하여 [출력 양식]에 맞춰 줄 단위로 추출하시오." },
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
      } else if (trimmed.startsWith('ITEM:')) {
        const parts = trimmed.substring(5).split('|').map(cleanStr);
        if (parts[0]) {
          const basePrice = cleanNum(parts[2], '0'); // 윗줄 가장 오른쪽 숫자 (단가*수량 / 정가)
          const rawDiscount = cleanNum(parts[3], '0');

          const newProd = {
            productOcr: parts[0],
            productAi: parts[1] || parts[0],
            totalPrice: basePrice,
            discount: rawDiscount,
            finalPrice: basePrice // 초기값은 정가로 설정 후 할인액 발생 시 차감
          };

          resultData.products.push(newProd);
        }
      } else if (trimmed.includes('-T') || trimmed.includes('CPN') || trimmed.toLowerCase().includes('cpn') || trimmed.includes('IRC') || trimmed.includes('할인')) {
        const matchNums = trimmed.match(/\d[\d,.]*/g);
        if (matchNums && matchNums.length > 0 && resultData.products.length > 0) {
          const discountVal = Number(cleanNum(matchNums[matchNums.length - 1], '0'));
          if (discountVal > 0 && discountVal < 50000) {
            const lastProduct = resultData.products[resultData.products.length - 1];
            lastProduct.discount = String(discountVal);
            
            // 핵심 원칙 적용: 단가*수량(정가)에서 할인액을 차감한 것이 최종 금액이 되도록 설정
            const origPrice = Number(lastProduct.totalPrice);
            const calculatedFinal = origPrice - discountVal;
            lastProduct.finalPrice = String(calculatedFinal > 0 ? calculatedFinal : origPrice);
          }
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

    // 최종 유효성 검사: 할인액이 있는데 최종금액이 정가와 똑같이 남아있다면 차감 금액 재계산
    resultData.products.forEach(p => {
      const tPrice = Number(p.totalPrice);
      const disc = Number(p.discount);
      const fPrice = Number(p.finalPrice);
      if (disc > 0 && tPrice === fPrice) {
        p.finalPrice = String(tPrice - disc);
      }
    });

    return res.status(200).json(resultData);

  } catch (error) {
    return res.status(500).json({ error: error.message || '서버 내부 처리 오류가 발생했습니다.' });
  }
}
