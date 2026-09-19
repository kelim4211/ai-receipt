export const maxDuration = 30;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 1. 카테고리 검색 요청 처리 (GET 또는 POST로 query가 들어온 경우)
  let query = '';
  if (req.method === 'GET' && req.query?.query) {
    query = req.query.query;
  } else if (req.method === 'POST' && req.body?.query && !req.body?.image) {
    query = req.body.query;
  }

  if (query) {
    if (!query.trim()) {
      return res.status(200).json({ category: '미상' });
    }
    try {
      const searchUrl = `https://search.daum.net/search?w=tot&q=${encodeURIComponent(query.trim())}`;
      const response = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      if (!response.ok) {
        return res.status(200).json({ category: '미상' });
      }

      const html = await response.text();
      const match = html.match(/class="(?:txt_category|category|txt_sub)"[^>]*>([^<]+)<\//i) ||
                    html.match(/data-category="([^"]+)"/i);

      if (match && match[1] && match[1].trim()) {
        return res.status(200).json({ category: match[1].trim() });
      }

      return res.status(200).json({ category: '미상' });
    } catch (err) {
      return res.status(200).json({ category: '미상' });
    }
  }

  // 2. 기존 영수증 분석 요청 처리 (POST로 image가 들어온 경우)
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

[상호명 및 업종업태 판독 규칙]
- SHOP 라인의 '업종및가게성격'은 상호명과 매장주소를 바탕으로 매장 특성을 파악하여 작성하십시오.

[유통사 및 영수증 체계 지능형 판독 규칙]
- 코스트코, 이마트, 롯데마트, 홈플러스 등 다양한 유통사별 영수증 형태와 할인 체계를 지능적으로 판단하여 분석하십시오.
- 코스트코 영수증의 경우, 윗줄에 위치한 가장 오른쪽 숫자가 '단가*수량(할인 전 정가)'이며, 그 바로 아랫줄에 '-T' 또는 CPN 형태로 표기된 금액이 '할인액'입니다. 
- 각 품목별 정가와 할인액, 최종 결제 금액을 정확히 분리하여 ITEM 양식에 맞춰 출력하십시오.

[단일 승인 전표 및 품목 미기재 영수증 처리 규칙]
- 세부 품목명 없이 상호명과 총 결제금액(승인금액)만 표기된 영수증(신용카드 전표, 간이영수증, 주유소/택시 전표 등)의 경우, 반드시 단일 기본 품목 1개를 ITEM으로 생성하십시오.
  * 예: ITEM: 승인금액 | [상호명] 이용료 | 결제금액 | 0 | 결제금액

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
              { text: "영수증 이미지의 유통사별 형태와 할인 구조를 분석하여 [출력 양식]에 맞춰 줄 단위로 정확히 추출하시오. 품목 목록이 없는 승인 전표는 [상호명] 이용료 형태의 단일 ITEM으로 구성하시오." },
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
    let lastProduct = null;

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
          lastProduct = newProd;
        }
      } else if (trimmed.includes('-T') || trimmed.includes('CPN') || trimmed.toLowerCase().includes('cpn') || trimmed.includes('IRC') || trimmed.includes('할인')) {
        const matchNums = trimmed.match(/\d[\d,.]*/g);
        if (matchNums && matchNums.length > 0 && lastProduct) {
          const discountVal = Number(cleanNum(matchNums[matchNums.length - 1], '0'));
          if (discountVal > 0 && discountVal < 50000) {
            lastProduct.discount = String(discountVal);
            const origPrice = Number(lastProduct.totalPrice);
            const calcFinal = origPrice - discountVal;
            lastProduct.finalPrice = String(calcFinal > 0 ? calcFinal : origPrice);
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

    return res.status(200).json(resultData);

  } catch (error) {
    return res.status(500).json({ error: error.message || '서버 내부 처리 오류가 발생했습니다.' });
  }
}
