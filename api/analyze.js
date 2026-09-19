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
ITEM: 원본제품명 | 복원제품명 | 정가(단가수량금액) | 할인금액 | 최종금액
ETC: 항목명 | 금액

[금액 추출 핵심 철칙 - 절대 준수]
- 품목 행의 세 번째 값인 [정가]에는 무조건 해당 제품 행의 가장 오른쪽에 인쇄된 원래 가격(예: 비비고 수제 깻잎만두의 경우 절대 9,990이 아닌 원래 정가인 16490)을 정확히 기재할 것.
- 네 번째 값은 [할인액] (예: 6500), 다섯 번째 값은 최종 결제 금액(예: 9990)을 기재할 것. 
- 단가 자리에 이미 할인이 적용된 최종 금액을 넣는 오류를 절대 범하지 마십시오.

[정산 및 요약(ETC) 금지 규칙]
- '과세 합계', '과세', '부가세', '세액', 'VAT', '판매 합계', '합계', '총액', '받은금액', '거스름돈', '카드결제' 등 세금 및 단순 결제 합계 관련 항목은 일체 출력 금지.
- 오직 통신사 할인, 포인트 사용 등 실질적인 할인/차감 항목만 ETC로 출력할 것.

[출력 예시]
SHOP: 코스트코 광명점 | 대형마트 | 미확인 | 107-81-63829 | 1899-9900 | 경기 광명시
ITEM: 비비고수제깻잎 | 비비고 수제 깻잎만두 | 16490 | 6500 | 9990
ITEM: 프레지던트무가염버터 | 프레지던트 무가염버터 | 29990 | 6000 | 23990`;

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
              { text: "영수증 이미지를 분석하여 [출력 양식]에 맞춰 줄 단위로 추출하시오. 품목의 정가(단가*수량) 칸에는 절대 할인가가 아닌 원래 오른쪽에 적힌 정가를 기재하고, 아랫줄 CPN 할인은 바로 위 제품의 할인액으로 정확히 매칭하시오." },
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
    let pendingDiscount = 0;

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
      } else if (trimmed.includes('CPN') || trimmed.toLowerCase().includes('cpn')) {
        const matchNums = trimmed.match(/\d[\d,.]*/g);
        if (matchNums && matchNums.length > 0) {
          pendingDiscount = Number(cleanNum(matchNums[matchNums.length - 1], '0'));
        }
      } else if (trimmed.startsWith('ITEM:')) {
        const parts = trimmed.substring(5).split('|').map(cleanStr);
        if (parts[0]) {
          let rawOriginal = cleanNum(parts[2], '0');
          let rawDiscount = cleanNum(parts[3], '0');
          let rawFinal = cleanNum(parts[4] || parts[2], '0');

          if (pendingDiscount > 0 && Number(rawDiscount) === 0) {
            rawDiscount = String(pendingDiscount);
          }

          let origNum = Number(rawOriginal);
          let discNum = Number(rawDiscount);
          let finalNum = Number(rawFinal);

          // [핵심 보정 로직] 정가와 최종금액이 같거나 잘못 들어왔는데 할인액이 있다면, 정가 = 최종금액 + 할인액으로 강제 복원
          if (discNum > 0 && origNum === finalNum) {
            rawOriginal = String(finalNum + discNum);
          }

          resultData.products.push({
            productOcr: parts[0],
            productAi: parts[1] || parts[0],
            totalPrice: rawOriginal,
            discount: rawDiscount,
            finalPrice: rawFinal
          });

          pendingDiscount = 0;
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

    return res.status(200).json(resultData);

  } catch (error) {
    return res.status(500).json({ error: error.message || '서버 내부 처리 오류가 발생했습니다.' });
  }
}
