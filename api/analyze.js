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
ITEM: 원본제품명_및_고유식별정보 | 복원제품명 | 단가또는총액 | 할인금액 | 최종금액
ETC: 항목명 | 금액
TOTAL: 영수증에_인쇄된_최종결제총액

[상호명 판독 및 엄격한 보류 규칙]
- 사업자등록번호, 전화번호, 매장 주소 중 가맹점을 특정할 수 있는 고유 식별 정보가 1개 이상 명백히 존재하는 경우에만 상호명을 추출하십시오.
- 식별 정보가 없어 확신할 수 없는 경우, 품번이나 제품명만으로 짐작하지 말고 반드시 '정보없음'으로 출력하십시오.

[제품 및 고유식별정보 활용 규칙]
- 영수증 품목명 아래에 적힌 고유 품번, 바코드 번호 등 고유 식별 정보가 있다면 제품명(ITEM)에 함께 포함하여 추출하십시오. (단, 수량이나 단순 포장 규격은 제외)`;

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
              { text: "영수증의 품목, 고유식별정보, 할인 항목, 최종 결제 총액(TOTAL)을 정확히 분석하여 지정된 양식으로 출력하시오." },
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
      shopOcr: '',
      shopName: '정보없음',
      shopIndustry: '',
      date: '미확인',
      bizNo: '미확인',
      phone: '미확인',
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
        let rawShop = parts[0] || '정보없음';
        if (!rawShop || rawShop.includes('미확인') || rawShop.length < 2) {
          resultData.shopName = '정보없음';
          resultData.shopOcr = '';
        } else {
          resultData.shopName = rawShop;
          resultData.shopOcr = rawShop;
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
        let name = "할인";
        let amountStr = "0";

        if (trimmed.startsWith('ETC:')) {
          const parts = trimmed.substring(4).split('|').map(cleanStr);
          name = parts[0].replace(/^[*\s]+/, '') || '할인';
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
