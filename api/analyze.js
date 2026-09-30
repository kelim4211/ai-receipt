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
      return res.status(500).json({ error: 'Vercel 환경 변수에 GEMINI_API_KEY가 설정되지 않았습니다.' });
    }

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const systemPrompt = `전문 영수증 분석기입니다. JSON을 절대 출력하지 마십시오.
오직 아래의 줄 단위 텍스트 형식 규칙에 맞춰서만 출력하십시오.

[출력 양식]
SHOP: 상호명[OCR] | 상호명[AI복원] | 업종및가게성격 | 일자 | 사업자번호 | 전화번호 | 주소 | 상호명발췌근거
ITEM: 원본제품명 | 정밀복원제품명(표준품명) | 단가곱하기수량의합 | 할인액 | 품목종속할인명(없으면 '없음') | 최종금액
ETC: 항목명 | 부호를포함한금액
TOTAL: 영수증에_인쇄된_최종결제총액

[상호명 규칙]
1. 상호명[OCR]: 영수증에 식별 가능한 경우만 표기, 없으면 반드시 '정보없음'.
2. 상호명[AI복원]: OCR이 '정보없음'일 때 고유 제품명 등을 통해 확실한 경우만 상호명 기재, 모호하면 '정보없음'.
3. 상호명발췌근거: "제품 검색을 통해 확인된 신뢰할 수 있는 고유 제품명 [제품명]을(를) 통해 정확하다고 판단되는 [상호명] 발췌"

[할인 및 제외 규칙]
- 특정 품목에 종속된 할인은 ITEM 행의 '할인액'과 '품목종속할인명'에만 기재하고 ETC 중복 기재 금지.
- 세금 분리 라인(과세, 과세금액, 부가세, 세액, 면세) 및 단순 수납 라인(총매출액, 받은돈, 거스름돈, 승인금액 등)은 ITEM/ETC에서 완전 제외.
- 개별 품목 할인들의 단순 총합인 '할인합계', '총할인', '할인총액'은 ETC로 절대 추출하지 말 것.
- 장바구니 전체 쿠폰, 통합 포인트 차감 등 '영수증 전체 단위 할인/추가금'만 ETC로 추출.`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemPrompt }]
        },
        generationConfig: {
          max_output_tokens: 4000
        },
        contents: [
          {
            parts: [
              { text: "영수증을 규칙대로 정밀 분석하여 출력하십시오." },
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
      return res.status(500).json({ error: `AI 응답 파싱 실패: ${responseText.substring(0, 80)}` });
    }

    const rawText = parsedApiResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) {
      return res.status(500).json({ error: 'AI 분석 결과가 비어 있습니다. 영수증을 다시 촬영해 주세요.' });
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
      receiptTotal: 0,
      verificationStatus: 'NORMAL',
      verificationMessage: ''
    };

    const cleanStr = (str) => (str ? str.replace(/^["']|["']$/g, '').trim() : '');
    const cleanNum = (str, fallback = '0') => {
      if (!str) return fallback;
      const numOnly = str.replace(/[^0-9]/g, '');
      return numOnly || fallback;
    };

    const excludedRegex = /과세|부가세|세액|면세|총매출|받은돈|받을금액|거스름|결제금액|합계금액|카드결제|할인합계|총할인|할인총액|할인액합계/i;
    const isExcluded = (name) => excludedRegex.test(name.replace(/\s+/g, ''));

    const lines = rawText.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('SHOP:')) {
        const parts = trimmed.substring(5).split('|').map(cleanStr);
        let rawShopOcr = parts[0] || '정보없음';
        let rawShopAi = parts[1] || '정보없음';
        
        let isOcrValid = !(rawShopOcr.includes('미확인') || rawShopOcr.includes('정보없음') || rawShopOcr.length < 2);
        resultData.shopOcr = isOcrValid ? rawShopOcr : '정보없음';

        if (!isOcrValid && rawShopAi && !rawShopAi.includes('정보없음') && rawShopAi.length >= 2) {
          resultData.shopName = rawShopAi;
          resultData.shopConfidence = 'estimated';
          resultData.shopReason = parts[7] || '';
        } else {
          resultData.shopName = isOcrValid ? rawShopOcr : '정보없음';
          resultData.shopConfidence = isOcrValid ? 'official' : 'none';
          resultData.shopReason = '';
        }

        resultData.shopIndustry = parts[2] || '';
        resultData.date = parts[3] || '미확인';
        resultData.bizNo = parts[4] || '정보없음';
        resultData.phone = parts[5] || '정보없음';
        resultData.address = parts[6] || '정보없음';
      } else if (trimmed.startsWith('ITEM:')) {
        const parts = trimmed.substring(5).split('|').map(cleanStr);
        if (parts[0]) {
          if (isExcluded(parts[0])) continue;

          const basePrice = cleanNum(parts[2], '0');
          const rawDiscount = cleanNum(parts[3], '0');
          let discountName = parts.length >= 6 && parts[4] !== '없음' ? parts[4] : '';
          let finalPriceVal = parts.length >= 6 ? cleanNum(parts[5], basePrice) : cleanNum(parts[4], basePrice);

          resultData.products.push({
            productOcr: parts[0],
            productAi: parts[1] || parts[0],
            totalPrice: basePrice,
            discount: rawDiscount,
            discountName: discountName,
            finalPrice: finalPriceVal
          });
        }
      } else if (trimmed.startsWith('TOTAL:')) {
        resultData.receiptTotal = Number(cleanNum(trimmed.substring(6), '0'));
      } else if (trimmed.startsWith('ETC:')) {
        const parts = trimmed.substring(4).split('|').map(cleanStr);
        let name = parts[0].replace(/^[*\s]+/, '') || '전체 할인/추가';
        
        if (isExcluded(name)) continue;

        let amountStr = parts[1] || '0';
        let isNegative = amountStr.includes('-') || /할인|DC|차감|쿠폰|마이너스/i.test(name);
        let amt = Number(cleanNum(amountStr, '0'));

        if (amt > 0) {
          resultData.overallElements.push({
            name: name,
            amount: isNegative ? `-${amt}` : String(amt)
          });
        }
      }
    }

    // 중복 제거: 개별 품목 할인 총액과 동일한 집계성 ETC 항목 필터링
    const sumProductDiscounts = resultData.products.reduce((acc, p) => acc + Number(p.discount || 0), 0);
    if (sumProductDiscounts > 0) {
      resultData.overallElements = resultData.overallElements.filter(el => {
        const val = Math.abs(Number(el.amount || 0));
        return !((val === sumProductDiscounts) && /할인|차감|DC/i.test(el.name));
      });
    }

    const sumProductsFinal = resultData.products.reduce((acc, p) => acc + Number(p.finalPrice), 0);
    const sumOverallEtc = resultData.overallElements.reduce((acc, el) => acc + Number(el.amount), 0);
    const calculatedTotal = sumProductsFinal + sumOverallEtc;

    if (resultData.receiptTotal > 0) {
      const discrepancy = resultData.receiptTotal - calculatedTotal;
      if (discrepancy === 0) {
        resultData.verificationStatus = 'MATCHED';
        resultData.verificationMessage = '금액 검증 완료';
      } else {
        resultData.verificationStatus = 'DISCREPANCY_AUTO_CORRECTED';
        resultData.verificationMessage = `금액 자동 보정 (${discrepancy}원)`;
        resultData.overallElements.push({
          name: discrepancy < 0 ? "누락 할인 보정" : "누락 추가 요금 보정",
          amount: String(discrepancy)
        });
      }
    }

    return res.status(200).json(resultData);
  } catch (error) {
    return res.status(500).json({ error: error.message || '서버 내부 오류가 발생했습니다.' });
  }
}
