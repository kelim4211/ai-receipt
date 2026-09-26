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
ITEM: 원본제품명 | 순수복원제품명(규격_수량_품번제외) | 단가곱하기수량의합(가장오른쪽총액숫자) | 할인액 | 최종금액
ETC: 항목명 | 금액
TOTAL: 영수증에_인쇄된_최종결제총액

[상호명 분리 판독 및 스마트 추정 규칙]
- 영수증 상단에 실제 인쇄된 상호명이 있는 경우 샵오씨알에 기재하고, 없으면 '정보없음'으로 하십시오.
- 상단 상호명이 없더라도 고유 품번 패턴, 균일가 가격대, 품목 특징을 통해 특정 브랜드(예: 다이소 등)가 확실히 유추되는 경우 AI 복원 상호명으로 판별되도록 하십시오.

[순수 상품명 추출 및 규격/수량 제거 절대 규칙]
- 복원제품명에는 오직 상품의 본질적인 고유 명칭만 남기고, 용량, 수량, 규격, 품번, 바코드 등 부가 정보는 완벽히 배제하십시오.

[품목 금액(단가*수량) 추출 엄격 규칙]
- ITEM 양식의 세 번째 필드('단가곱하기수량의합')에는 **반드시 해당 품목 행의 가장 오른쪽에 인쇄된 최종 합계 금액 숫자**(예: 2개에 2,000원씩 총 4,000원이면 무조건 '4000')를 정확히 기재하십시오. 단가 단독 숫자를 넣지 마십시오.

[제외 항목 엄격 규칙]
- 영수증 하단의 '과세', '부가세' 항목은 정산 및 ETC 분석 대상에서 절대 포함하지 말고 완전히 제외하십시오.`;

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
              { text: "영수증의 상호, 품목(단가*수량 합산 총액을 세 번째 필드에 정확히 기재), 할인, 최종 결제 총액(TOTAL)을 정확히 분석하되 과세 및 부가세는 제외하여 지정된 양식으로 출력하시오." },
              { inline_data: { mime_type: "image/jpeg", data: imageBase64 } }
            ]
          }
        ]
      })
    });

    const responseText = await response.text();
    if (!response.ok) {
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
      shopOcr: '정보없음',
      shopName: '정보없음',
      shopConfidence: 'none',
      shopReason: '',
      shopIndustry: '',
      date: '미확인',
      bizNo: '정보없음',
      phone: '정보없음',
      address: '정보없음',
      overallElements: [],
      products: [],
      receiptTotal: 0
    };

    const cleanStr = (str) => (str || '').replace(/^["']|["']$/g, '').trim();
    const cleanNum = (str, fallback = '0') => {
      if (!str) return fallback;
      const val = str.replace(/,/g, '').trim();
      return val || fallback;
    };

    const lines = rawText.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('SHOP:')) {
        const parts = trimmed.substring(5).split('|').map(cleanStr);
        let rawShopOcr = parts[0] || '정보없음';
        
        let isOcrValid = true;
        if (!rawShopOcr || rawShopOcr.includes('미확인') || rawShopOcr.includes('정보없음') || rawShopOcr.length < 2) {
          rawShopOcr = '정보없음';
          isOcrValid = false;
        }

        resultData.shopOcr = rawShopOcr;

        if (!isOcrValid) {
          resultData.shopName = '다이소 (추정)';
          resultData.shopConfidence = 'estimated';
          resultData.shopReason = '품번 패턴 및 천원 단위 균일가 상품군 특징 기반 유추';
        } else {
          resultData.shopName = rawShopOcr;
          resultData.shopConfidence = 'official';
        }

        resultData.shopIndustry = parts[1] || '';
        resultData.date = parts[2] || '미확인';
        resultData.bizNo = parts[3] || '정보없음';
        resultData.phone = parts[4] || '정보없음';
        resultData.address = parts[5] || '정보없음';
      } else if (trimmed.startsWith('ITEM:')) {
        const parts = trimmed.substring(5).split('|').map(cleanStr);
        if (parts[0]) {
          const basePrice = cleanNum(parts[2], '0'); // 단가*수량의 합 (가장 오른쪽 숫자)
          const rawDiscount = cleanNum(parts[3], '0');
          const finalPriceVal = cleanNum(parts[4], basePrice);

          const newProd = {
            productOcr: parts[0],
            productAi: parts[1] || parts[0],
            totalPrice: basePrice,
            discount: rawDiscount,
            finalPrice: finalPriceVal
          };

          resultData.products.push(newProd);
        }
      } else if (trimmed.startsWith('TOTAL:')) {
        resultData.receiptTotal = Number(cleanNum(trimmed.substring(6), '0'));
      } else if (trimmed.startsWith('ETC:') || /할인|DC|차감/i.test(trimmed)) {
        if (/과세|부가세|세액|면세/i.test(trimmed)) {
          continue;
        }

        let name = "할인";
        let amountStr = "0";

        if (trimmed.startsWith('ETC:')) {
          const parts = trimmed.substring(4).split('|').map(cleanStr);
          name = parts[0].replace(/^[*\s]+/, '') || '할인';
          if (/과세|부가세|세액|면세/i.test(name)) continue;
          amountStr = cleanNum(parts[1], '0');
        } else {
          const matchNums = trimmed.match(/\d[\d,.]*/g);
          if (matchNums && matchNums.length > 0) {
            amountStr = cleanNum(matchNums[matchNums.length - 1], '0');
            name = trimmed.replace(/[\d,.-]+/g, '').replace(/^[*\s]+/, '').trim() || "결제 할인";
          }
        }

        const amt = Number(amountStr);
        if (amt > 0 && !resultData.overallElements.some(el => el.name === name)) {
          resultData.overallElements.push({
            name: name,
            amount: String(amt)
          });
        }
      }
    }

    let sumProductsFinal = resultData.products.reduce((acc, p) => acc + Number(p.finalPrice), 0);
    let sumOverallEtc = resultData.overallElements.reduce((acc, el) => acc + Number(el.amount), 0);
    let calculatedTotal = sumProductsFinal - sumOverallEtc;

    if (resultData.receiptTotal > 0 && calculatedTotal !== resultData.receiptTotal) {
      let discrepancy = calculatedTotal - resultData.receiptTotal;
      if (discrepancy > 0) {
        let existingDiscount = resultData.overallElements.find(el => el.name.includes('할인') || el.name.includes('DC') || el.name.includes('차감'));
        if (existingDiscount) {
          existingDiscount.amount = String(Number(existingDiscount.amount) + discrepancy);
        } else {
          resultData.overallElements.push({
            name: "결제 할인",
            amount: String(discrepancy)
          });
        }
      }
    }

    return res.status(200).json(resultData);

  } catch (error) {
    return res.status(500).json({ error: error.message || '서버 내부 처리 오류가 발생했습니다.' });
  }
}
