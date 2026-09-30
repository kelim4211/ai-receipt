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

[상호명 로직]
1. 상호명[OCR]: 영수증에 식별 가능한 경우만 표기, 없으면 반드시 '정보없음'.
2. 상호명[AI복원]: OCR이 '정보없음'일 때 고유 제품명 등을 통해 확실한 경우만 상호명 기재, 모호하면 '정보없음'.
3. 상호명발췌근거: "제품 검색을 통해 확인된 신뢰할 수 있는 고유 제품명 [제품명]을(를) 통해 정확하다고 판단되는 [상호명] 발췌"

[할인 분리 절대 규칙]
- 특정 품목 바로 아래에 인쇄된 할인(예: [과일] S-Point 행사, 개별 품목 밑 할인)은 ITEM 행의 '할인액'과 '품목종속할인명'에만 기재하고 ETC에는 절대 중복 기재하지 마십시오.
- 장바구니 전체 쿠폰, 통합 포인트 차감 등 '영수증 전체 단위 할인'만 ETC로 추출하십시오.

[제외 항목 및 수납/단순 집계 내역 엄격 규칙 (중복/오인식 절대 방지)]
1. 세금 내역 절대 제외:
   - '과세', '과세금액', '과 세 금 액', '부가세', '부 가 세', '세액', '면세' 등 세금 분리 표시는 정산/ETC/ITEM에서 완전히 제외하십시오.
2. 수납/결제 확인 내역 절대 제외:
   - '총매출액', '합계', '받은돈', '받 은 돈', '받을금액', '거스름돈', '거 스 름 돈', '현금', '카드결제액', '승인금액' 등 단순 결제 수납 라인은 ETC나 ITEM으로 절대 추출하지 마십시오.
3. 품목 할인 단순 집계(Subtotal) 라인 절대 제외:
   - 영수증 하단에 개별 품목 할인들을 단순히 합산해 놓은 '할인합계', '총할인', '할인액합계', '할인총액' 등은 ETC로 절대 추출하지 말고 완전히 제외하십시오.`;

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
          max_output_tokens: 4096
        },
        contents: [
          {
            parts: [
              { text: "영수증을 줄 단위 형식 규칙대로 정밀 분석하여 출력하십시오. 개별 품목 할인의 단순 총합인 '할인합계' 및 과세/부가세/수납 확인 라인을 ETC로 잘못 추출하지 마십시오." },
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
      return res.status(500).json({ error: `AI 응답 파싱 실패: ${responseText.substring(0, 100)}` });
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

    const cleanStr = (str) => (str || '').replace(/^["']|["']$/g, '').trim();
    const cleanNum = (str, fallback = '0') => {
      if (!str) return fallback;
      const val = str.replace(/,/g, '').trim();
      return val || fallback;
    };

    // 세금, 단순 수납 라인 및 개별 품목 할인 단순 집계(Subtotal) 필터링
    const isExcludedEtcItem = (name) => {
      const normalized = name.replace(/\s+/g, '');
      return /과세|부가세|세액|면세|총매출|받은돈|받을금액|거스름|결제금액|합계금액|카드결제|할인합계|총할인|할인총액|할인액합계/i.test(normalized);
    };

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
          if (isExcludedEtcItem(parts[0])) continue;

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
        
        if (isExcludedEtcItem(name)) continue;

        let amountStr = cleanNum(parts[1], '0');
        let isNegative = amountStr.includes('-') || /할인|DC|차감|쿠폰|마이너스/i.test(name);
        let amt = Number(amountStr.replace(/[^0-9]/g, ''));

        if (amt > 0) {
          resultData.overallElements.push({
            name: name,
            amount: isNegative ? `-${amt}` : String(amt)
          });
        }
      }
    }

    // 방법 2 적용: 품목별 할인 총합 산출 및 동일 금액의 중복 집계성 ETC 상쇄 제거
    const sumProductDiscounts = resultData.products.reduce((acc, p) => acc + Number(p.discount || 0), 0);
    if (sumProductDiscounts > 0) {
      resultData.overallElements = resultData.overallElements.filter(el => {
        const val = Math.abs(Number(el.amount || 0));
        const isDuplicateDiscount = (val === sumProductDiscounts) && /할인|차감|DC/i.test(el.name);
        return !isDuplicateDiscount;
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
