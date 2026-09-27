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
SHOP: 상호명 | 업종및가게성격 | 일자 | 사업자번호 | 전화번호 | 주소 | 상호명발췌근거
ITEM: 원본제품명 | 정밀복원제품명(실제유통데이터및검색일치도가가장높은표준품명) | 단가곱하기수량의합 | 할인액 | 최종금액
ETC: 항목명 | 부호를포함한금ек
TOTAL: 영수증에_인쇄된_최종결제총액

[상호명 [OCR] 및 실제 유통/검색 데이터 기반 상호명 발췌 절대 규칙]
1. 공식 상호명: 영수증 상단 원본 이미지에 명확한 상호명 텍스트가 인쇄되어 있는 경우 SHOP의 첫 번째 필드에 해당 상호명을 적으십시오.
2. 실거래 유통/검색 데이터 기반 상호명 발췌 (상호명[OCR]이 '정보없음'인 경우 필수 적용):
   - 영수증 상단에 상호명이 없거나 잘려 있는 경우, 하단에 기재된 **개별 품목명(예: 고유 메뉴, 전용 상품명 등)을 실제 인터넷 유통 및 매장 판매 데이터와 대조**하십시오.
   - 해당 제품을 독점적으로 취급하거나 판매하는 실제 프랜차이즈/매장 이름이 검색 결과 데이터로 명확히 특정되는 경우, 그 실제 상호명을 SHOP 첫 번째 필드에 발췌해 오십시오.
   - 일곱 번째 필드(상호명발췌근거)에는 **"품목 [제품명]의 실제 유통·판매처 검색 결과 [상호명]으로 발췌됨"** 형태의 명확한 실거래 기반 근거를 한 문장으로 기재하십시오. 확실한 근거가 없을 때만 '정보없음' 처리하십시오.

[ETC 항목 자율 추출 원칙 (기호/용어 범용 대응)]
- 영수증에 인쇄된 내용 중 품목(ITEM)과 최종 결제총액(TOTAL)을 제외한 나머지 모든 추가 요금, 수수료, 배달팁, 각종 할인/차감/쿠폰 항목은 명칭이나 기호에 구애받지 말고 부호를 포함하여 무조건 ETC 형식으로 빠짐없이 추출하십시오.

[제품검색 기반 최고 정확도 명칭 발췌 절대 규칙]
- ITEM의 두 번째 필드(정밀복원제품명)를 복원할 때, 영수증에 없는 제조사명을 임의로 지어내어 추가하는 행위를 절대 금지합니다.
- 대신 실제 인터넷 쇼핑 및 유통 데이터에서 해당 품목의 가장 정확도와 일치도가 높은 실제 표준 상품명을 매칭하여 발췌하십시오.

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
              { text: "영수증을 분석하되, 상호명이 누락된 경우 품목명을 실제 유통/검색 데이터와 대조하여 해당 제품을 판매하는 실제 상호명을 발췌하고 그 근거를 남기시오. 또한 모든 추가 요금/할인(ETC)과 최종 총액(TOTAL)을 정확히 분석하여 지정된 양식으로 출력하시오." },
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
      return res.status(500).json({ error: `서버 응답 파싱 실패: 원본 응답이 올바르지 않습니다. (${responseText.substring(0, 80)})` });
    }

    const rawText = parsedApiResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) {
      return res.status(500).json({ error: 'AI 분석 결과가 비어 있습니다. 영수증 사진을 다시 선명하게 촬영해 주세요.' });
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
          resultData.shopName = '정보없음';
          resultData.shopConfidence = 'none';
          resultData.shopReason = '';
        } else {
          let rawReason = parts[6] || '';
          // 검색 데이터 기반 발췌 근거가 있는 경우 'estimated' 상태 및 유통 발췌 근거 부여
          if (rawReason && !rawReason.includes('공식 상호명 확인')) {
            resultData.shopName = rawShopOcr;
            resultData.shopConfidence = 'estimated';
            resultData.shopReason = rawReason;
          } else {
            resultData.shopName = rawShopOcr;
            resultData.shopConfidence = 'official';
            resultData.shopReason = '';
          }
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
      } else if (trimmed.startsWith('ETC:') || /[-+]?\d/.test(trimmed)) {
        if (/과세|부가세|세액|면세/i.test(trimmed)) {
          continue;
        }

        let name = "추가/할인 항목";
        let amountStr = "0";

        if (trimmed.startsWith('ETC:')) {
          const parts = trimmed.substring(4).split('|').map(cleanStr);
          name = parts[0].replace(/^[*\s]+/, '') || '추가/할인 항목';
          if (/과세|부가세|세액|면세/i.test(name)) continue;
          amountStr = cleanNum(parts[1], '0');
        } else {
          const matchNums = trimmed.match(/-?\d[\d,.]*/g);
          if (matchNums && matchNums.length > 0) {
            amountStr = cleanNum(matchNums[matchNums.length - 1], '0');
            name = trimmed.replace(/[-?\d,.-]+/g, '').replace(/^[*\s]+/, '').trim() || "추가/할인 항목";
          }
        }

        let isNegative = amountStr.includes('-') || trimmed.includes('-') || /할인|DC|차감|쿠폰|마이너스/i.test(name);
        let cleanAmountVal = amountStr.replace(/[^0-9]/g, '');
        let amt = Number(cleanAmountVal);

        if (amt > 0) {
          let finalAmountFormatted = isNegative ? `-${amt}` : String(amt);
          if (!resultData.overallElements.some(el => el.name === name)) {
            resultData.overallElements.push({
              name: name,
              amount: finalAmountFormatted
            });
          }
        }
      }
    }

    // ==========================================
    // 🔍 [이중 검증 장치 (Double Verification Engine)]
    // ==========================================
    const sumProductsFinal = resultData.products.reduce((acc, p) => acc + Number(p.finalPrice), 0);
    const sumOverallEtc = resultData.overallElements.reduce((acc, el) => acc + Number(el.amount), 0);
    const calculatedTotal = sumProductsFinal + sumOverallEtc;

    if (resultData.receiptTotal > 0) {
      const discrepancy = resultData.receiptTotal - calculatedTotal;
      
      if (discrepancy === 0) {
        resultData.verificationStatus = 'MATCHED';
        resultData.verificationMessage = '금액 이중 검증 완료: 품목 및 추가/할인 합계가 영수증 최종 결제 총액과 완벽히 일치합니다.';
      } else {
        resultData.verificationStatus = 'DISCREPANCY_AUTO_CORRECTED';
        resultData.verificationMessage = `금액 오차 감지 및 자동 보정됨 (차액: ${discrepancy}원)`;
        
        resultData.overallElements.push({
          name: discrepancy < 0 ? "누락 할인/차감 보정" : "누락 추가 요금 보정",
          amount: String(discrepancy)
        });
      }
    } else {
      resultData.verificationStatus = 'NO_TOTAL_FOUND';
      resultData.verificationMessage = '영수증 내 최종 결제 총액 인식 불가로 자체 품목 합계로 대체합니다.';
    }

    return res.status(200).json(resultData);

  } catch (error) {
    return res.status(500).json({ error: error.message || '서버 내부 처리 오류가 발생했습니다.' });
  }
}
