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
SHOP: 상호명[OCR] | 상호명[AI복원] | 업종및가게성격 | 일자 | 사업자번호 | 전화번호 | 주소 | 상호명발췌근거
ITEM: 원본제품명 | 정밀복원제품명(실제유통데이터및검색일치도가가장높은표준품명) | 단가곱하기수량의합 | 할인액 | 최종금액
ETC: 항목명 | 부호를포함한금액
TOTAL: 영수증에_인쇄된_최종결제총액

[상호명 로직 절대 규칙 - 반드시 숙지할 것]
1. 상호명[OCR]: 영수증에 있는 상호 그대로 OCR 판독해서 보여줍니다. 영수증에 상호명이 없거나 잘려서 식별 불가한 경우 반드시 '정보없음'으로 기재하십시오. (절대 임의 유추 금지)
2. 상호명[AI복원]: 
   - 상호명[OCR]이 '정보없음'일 때만 작동합니다.
   - 제품 검색 버튼을 눌렀을 때 보여지는 인터넷 검색 내용 중, 신뢰할 수 있는 고유 제품명, 품번 등을 통해 정확하다고 판단되는 상호명이 있을 때만 상호명을 '발췌'해서 해당 항목에 보여줍니다. (예: '럭키 모짜라이스롤 떡볶이' 인터넷 검색 정보를 통해 '명랑핫도그'가 정확하다고 판단될 때만 발췌)
   - 검색을 통한 확신이 불가능한 일반 명사(예: 단순 떡볶이, 치킨 등)인 경우 무리하게 유추하지 말고 반드시 '정보없음'으로 기재하십시오.
3. 상호명발췌근거: 상호명[AI복원] 항목에 상호를 발췌해서 보여준 경우, "제품 검색을 통해 확인된 신뢰할 수 있는 고유 제품명 [활용한 제품명]을(를) 통해 정확하다고 판단되는 [상호명] 발췌" 형태로 8번째 필드에 기재하십시오.

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
              { text: "영수증에 상호가 없으면 OCR은 '정보없음'으로 처리하고, AI복원은 제품 검색 인터넷 정보를 통해 신뢰할 수 있는 고유 제품명으로 판단되는 정확한 상호명이 있을 때만 발췌해서 기재하십시오. 또한 모든 추가 요금/할인(ETC)과 최종 총액(TOTAL)을 정확히 분석하여 출력하시오." },
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
        let rawShopAi = parts[1] || '정보없음';
        
        let isOcrValid = true;
        if (!rawShopOcr || rawShopOcr.includes('미확인') || rawShopOcr.includes('정보없음') || rawShopOcr.length < 2) {
          rawShopOcr = '정보없음';
          isOcrValid = false;
        }

        resultData.shopOcr = rawShopOcr;
        let rawReason = parts[7] || '';
        
        if (!isOcrValid) {
          if (rawShopAi && !rawShopAi.includes('정보없음') && rawShopAi.length >= 2) {
            resultData.shopName = rawShopAi;
            resultData.shopConfidence = 'estimated';
            resultData.shopReason = rawReason;
          } else {
            resultData.shopName = '정보없음';
            resultData.shopConfidence = 'none';
            resultData.shopReason = '';
          }
        } else {
          resultData.shopName = rawShopOcr;
          resultData.shopConfidence = 'official';
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
