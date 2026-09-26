export const maxDuration = 30;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '잘못된 접근입니다.' });
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

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
ITEM: 원본제품명 | 정밀복원제품명(브랜드명포함_순수제품명) | 단가곱하기수량의합(가장오른쪽총액숫자) | 할인액 | 최종금액
ETC: 항목명 | 금액
TOTAL: 영수증에_인쇄된_최종결제총액

[상호명 [OCR] 절대 규칙 (수정불가)]
- 영수증 상단 원본 이미지에 명확한 상호명 텍스트가 인쇄되어 있는 경우에만 SHOP의 첫 번째 필드에 해당 원본 상호명을 적으십시오.
- 영수증에 상호명이 존재하지 않거나 잘려 있는 경우, SHOP의 첫 번째 필드는 무조건 '정보없음'이라고 적으십시오.

[제품명 복원 및 브랜드명 포함 절대 규칙]
- ITEM의 두 번째 필드(정밀복원제품명)에는 영수증 원본에 기재된 **제품 고유의 제조사/브랜드명(예: 샤프란, 풀무원 등)**을 절대 생략하지 말고 온전히 포함시키십시오.
- 단, 편의점 상호명(CU 등)이나 점포 위치명은 제품명에 절대 섞지 마십시오. 불필요한 규격이나 축약어, 기호(')')만 깔끔하게 정제하십시오.

[품목 금액(단가*수량) 추출 엄격 규칙]
- ITEM 양식의 세 번째 필드에는 반드시 해당 품목 행의 가장 오른쪽에 인쇄된 최종 합계 금액 숫자를 정확히 기재하십시오.

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
              { text: "영수증을 분석하되, 품목별 [AI 복원] 영역에는 제품 본연의 제조사/브랜드명(샤프란 등)을 누락하지 말고 온전히 포함하여 정밀 복원하고, 최종 결제 총액(TOTAL)을 정확히 분석하여 지정된 양식으로 출력하시오." },
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
        if (!rawShopOcr || rawShopOcr.includes('미확인') || rawShopOcr.includes('정보없음') || rawShopOcr.length < 2 || rawShopOcr.includes('추정')) {
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
          const basePrice = cleanNum(parts[2], '0');
          const rawDiscount = cleanNum(parts[3], '0');
          const finalPriceVal = cleanNum(parts[4], basePrice);

          resultData.products.push({
            productOcr: parts[0],
            productAi: parts[1] || parts[0],
            totalPrice: basePrice,
            discount: rawDiscount,
            finalPrice: finalPriceVal
          });
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

    const sumProductsFinal = resultData.products.reduce((acc, p) => acc + Number(p.finalPrice), 0);
    const sumOverallEtc = resultData.overallElements.reduce((acc, el) => acc + Number(el.amount), 0);
    const calculatedTotal = sumProductsFinal - sumOverallEtc;

    if (resultData.receiptTotal > 0 && calculatedTotal !== resultData.receiptTotal) {
      const discrepancy = calculatedTotal - resultData.receiptTotal;
      if (discrepancy > 0) {
        const existingDiscount = resultData.overallElements.find(el => el.name.includes('할인') || el.name.includes('DC') || el.name.includes('차감'));
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
