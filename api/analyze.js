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
TOTAL: 영수증에_인쇄된_최종결제총액

[핵심 판독 및 검증 규칙]
- 영수증 하단에 인쇄된 '총구 매액', '합계', '신용카드', '결제금액' 등 최종 지불된 총액을 반드시 찾아내어 'TOTAL: 금액' 형태로 마지막 줄에 출력하십시오.
- 영수증 내에 표기된 모든 종류의 일괄 할인(결제 할인, 포인트 할인, 멤버십 할인 등)은 기호(* 등) 유무와 관계없이 ETC 양식으로 출력하십시오[cite: 5].`;

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
              { text: "영수증의 품목, 일괄 할인, 그리고 최하단의 최종 결제 총액(TOTAL)을 정확히 분석하여 지정된 양식으로 출력하시오[cite: 5]." },
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
      products: [],
      receiptTotal: 0
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
          const basePrice = cleanNum(parts[2], '0');
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
        const totalStr = trimmed.substring(6);
        resultData.receiptTotal = Number(cleanNum(totalStr, '0'));
      } else if (trimmed.startsWith('ETC:') || /할인|DC|차감/i.test(trimmed)) {
        let name = "일괄 할인";
        let amountStr = "0";

        if (trimmed.startsWith('ETC:')) {
          const parts = trimmed.substring(4).split('|').map(cleanStr);
          name = parts[0].replace(/^[*\s]+/, '') || '할인';
          amountStr = cleanNum(parts[1], '0');
        } else {
          const matchNums = trimmed.match(/\d[\d,.]*/g);
          if (matchNums && matchNums.length > 0) {
            amountStr = cleanNum(matchNums[matchNums.length - 1], '0');
            name = trimmed.replace(/[\d,.-]+/g, '').replace(/^[*\s]+/, '').trim() || "일괄 할인";
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

    // [핵심 자가 검산(Self-Correction) 및 누락 할인 역산 보정 로직]
    let sumProductsFinal = resultData.products.reduce((acc, p) => acc + Number(p.finalPrice), 0);
    let sumOverallEtc = resultData.overallElements.reduce((acc, el) => acc + Number(el.amount), 0);
    let calculatedTotal = sumProductsFinal - sumOverallEtc;

    // 만약 영수증에 인쇄된 총액(receiptTotal)이 존재하고, 앱이 산출한 금액과 차이가 발생한다면?
    if (resultData.receiptTotal > 0 && calculatedTotal !== resultData.receiptTotal) {
      let discrepancy = calculatedTotal - resultData.receiptTotal;
      
      // 차액이 정확히 양수로 발생하고, 기존에 잡힌 일괄 할인이 없거나 차액과 다르다면 누락된 할인으로 간주하여 자동 보정
      if (discrepancy > 0) {
        let existingDiscount = resultData.overallElements.find(el => el.name.includes('할인') || el.name.includes('DC'));
        if (existingDiscount) {
          // 기존 할인 금액에 누락된 차액을 합산
          existingDiscount.amount = String(Number(existingDiscount.amount) + discrepancy);
        } else {
          // 누락된 할인 항목을 자동 생성하여 추가
          resultData.overallElements.push({
            name: "현장/결제 할인 (자동 검산 보정)",
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
