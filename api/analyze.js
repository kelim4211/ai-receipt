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

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`;

    const systemPrompt = `전문 영수증 분석기입니다. JSON을 절대 출력하지 마십시오.
오직 아래의 줄 단위 텍스트 형식 규칙에 맞춰서만 출력하십시오.

[출력 양식]
SHOP: 상호명 | 업종및가게성격 | 일자 | 사업자번호 | 전화번호 | 주소
ITEM: 원본제품명 | 복원제품명 | 단가또는총액 | 할인금액 | 최종금액
ETC: 항목명 | 금액

[사실 기반 원칙 - 절대 준수]
- 영수증 이미지에 실제로 인쇄되어 눈으로 명확히 확인 가능한 정보만 사실대로 추출하십시오.
- 일자, 사업자번호, 전화번호, 주소 항목 중 이미지에서 잘려 있거나 보이지 않는 정보는 절대로 가상의 값(날짜, 특정 지점 번호 등)을 지어내지 말고 반드시 "미확인"으로 표기하십시오.

[상호명 및 업종및가게성격 작성 규칙 - 필수 준수]
- SHOP: 라인의 2번째 항목인 [업종및가게성격]은 영수증에 별도 인쇄가 없더라도, 상호명과 구매 품목을 분석하여 반드시 '기본 업종/업태 (주력 판매 제품군 및 가게 성격)' 형태의 짧은 한 문장으로 작성하십시오. 빈칸이나 미확인으로 두지 마십시오.

[코스트코 및 2줄 영수증 처리 특수 규칙 - 필수 준수]
- 코스트코 영수증은 윗줄에 [제품명], 아랫줄에 [상품코드 수량x 단가 최종금액 T] 구조로 인쇄됩니다. 이 두 줄을 반드시 하나의 상품으로 결합하여 추출하십시오.
- 금액 뒤에 붙은 과세 표시 'T'나 특수문자는 제거하고 순수 숫자 금액만 추출하십시오.
- 바로 아래에 'CPN'으로 붙은 쿠폰 할인은 해당 제품의 할인금액에 반영하거나, 별도 제품이 아닌 경우 할인으로 계산하십시오.
- 코스트코 매장인 경우 자체 PB 상품은 '커클랜드(Kirkland)'를 붙여 복원하십시오.

[PB 상품 및 복원제품명 작성 규칙 - 필수 준수]
- 대형마트, 편의점, 다이소 등의 전용 PB 상품(노브랜드, 피코크, 홈플러스 시그니처, 요리하다, 오늘좋은, 유어스, 헤이루, 득템, 다이소 등)은 복원 제품명 맨 앞에 PB 브랜드명을 반드시 포함하십시오.
- 일반 제조사 제품은 기존 브랜드명을 유지하고, 규격/중량(g, ml, cm), 품번(6~7자리), 특수기호는 제거하십시오.

[정산 및 요약(ETC) 금지 규칙 - 필수 준수]
- 과세, 면세, 부가세, 세액, VAT 등 세금 및 정산 관련 항목은 분리하거나 출력하지 말고 분석에서 완전히 제외하십시오.
- 판매합계, 합계, 총액, 받은금액, 거스름돈, 카드결제 등 단순 결제 합계 관련 항목 역시 일체 출력 금지.
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
          max_output_tokens: 1500
        },
        contents: [
          {
            parts: [
              { text: "영수증 이미지를 정밀 판독하여 지정된 양식대로 출력하십시오. 이미지에 확인되지 않는 날짜나 사업자번호는 일체 추측하지 말고 반드시 '미확인'으로 출력하고, 2번째 항목인 [업종및가게성격]은 품목을 토대로 한 문장으로 작성하십시오." },
              { inline_data: { mime_type: "image/jpeg", data: imageBase64 } }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(500).json({ error: `AI 서버 통신 실패 (${response.status}): ${errText}` });
    }

    const parsedApiResponse = await response.json();
    const rawText = parsedApiResponse.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) {
      return res.status(500).json({ error: 'AI 분석 결과가 비어 있습니다.' });
    }

    const resultData = {
      shopOcr: '',
      shopName: '',
      shopIndustry: '',
      date: '',
      bizNo: '',
      phone: '',
      address: '',
      overallElements: [],
      products: []
    };

    const cleanStr = (str) => (str || '').trim();
    const cleanNum = (str, fallback = '0') => {
      if (!str) return fallback;
      const digits = str.replace(/[^0-9-]/g, '');
      return digits || fallback;
    };

    const lines = rawText.split('\n');

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (/^SHOP\s*:/i.test(line)) {
        const parts = line.replace(/^SHOP\s*:/i, '').split('|').map(cleanStr);
        resultData.shopName = parts[0] || '상호명 미확인';
        resultData.shopOcr = parts[0] || '';
        resultData.shopIndustry = parts[1] || '';
        resultData.date = parts[2] || '미확인';
        resultData.bizNo = parts[3] || '미확인';
        resultData.phone = parts[4] || '미확인';
        resultData.address = parts[5] || '미확인';

        if (/\d{4}[-.]\d{2}[-.]\d{2}/.test(resultData.shopIndustry)) {
          resultData.date = resultData.shopIndustry;
          resultData.shopIndustry = '';
        }
      } else if (/^ITEM\s*:/i.test(line)) {
        const parts = line.replace(/^ITEM\s*:/i, '').split('|').map(cleanStr);
        if (parts.length >= 2) {
          const productOcr = parts[0];
          const productAi = parts[1] || productOcr;
          const origPrice = cleanNum(parts[2] || '0');
          const discount = cleanNum(parts[3] || '0');
          const finalPrice = cleanNum(parts[4] || origPrice);

          resultData.products.push({
            productOcr: productOcr,
            productAi: productAi,
            totalPrice: origPrice,
            discount: discount,
            finalPrice: finalPrice
          });
        }
      } else if (/^ETC\s*:/i.test(line)) {
        const parts = line.replace(/^ETC\s*:/i, '').split('|').map(cleanStr);
        if (parts[0]) {
          resultData.overallElements.push({
            name: parts[0],
            amount: cleanNum(parts[1], '0')
          });
        }
      }
    }

    if (!resultData.shopIndustry || resultData.shopIndustry === '미확인' || resultData.shopIndustry === '-') {
      if (resultData.shopName.includes('코스트코')) {
        resultData.shopIndustry = '대형마트 (식료품 및 대용량 잡화 중심의 창고형 할인매장)';
      } else if (resultData.products.length > 0) {
        resultData.shopIndustry = '소매/유통점 (식음료 및 생활필수품 판매)';
      } else {
        resultData.shopIndustry = '소매업 (소비재 및 잡화 매장)';
      }
    }

    return res.status(200).json(resultData);
  } catch (error) {
    return res.status(500).json({ error: error.message || '서버 내부 처리 오류가 발생했습니다.' });
  }
}
