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

[코스트코 및 2줄 영수증 처리 특수 규칙 - 필수 준수]
- 코스트코 영수증은 윗줄에 [제품명], 아랫줄에 [상품코드 수량x 단가 최종금액 T] 구조로 인쇄됩니다. 이 두 줄을 반드시 하나의 상품으로 결합하여 추출하십시오.
- 금액 뒤에 붙은 과세 표시 'T'나 특수문자는 제거하고 순수 숫자 금액만 추출하십시오. (예: 17,970 T ➔ 17970)
- 바로 아래에 'CPN'으로 붙은 쿠폰 할인은 해당 제품의 할인금액에 반영하거나, 별도 제품이 아닌 경우 할인으로 계산하십시오. (예: 6,500-T ➔ 할인 6500)
- 코스트코 매장인 경우 자체 PB 상품은 '커클랜드(Kirkland)'를 붙여 복원하십시오.

[출력 예시]
SHOP: (주)코스트코 코리아 광명점 | 회원제 대형 창고형 할인매장 (식료품, 대용량 가공식품 및 수입잡화 전문 유통점) | 2026-03-29 | 107-81-63829 | 1899-9900 | 경기 광명시 일직로 40
ITEM: 프라이드치킨 | 프라이드치킨 | 17970 | 0 | 17970
ITEM: 비비고수제깻잎 | 비비고 수제 깻잎만두 | 16490 | 6500 | 9990
ITEM: 프레지덤무가염 | 프레지던트 무가염버터 | 29990 | 6000 | 23990
ITEM: HIMUNE MILKSHAKE | 하이뮨 밀크쉐이크 | 33490 | 0 | 33490
ITEM: 바삭바삭야채부각 | 바삭바삭 야채부각 | 13990 | 3000 | 10990
ITEM: 콜롬비아그라운드 | 커클랜드 콜롬비아 분쇄원두커피 | 37990 | 0 | 37990
ITEM: CENTRUM GUMMIES | 센트룸 구미 비타민 | 29990 | 0 | 29990`;

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
          max_output_tokens: 3000
        },
        contents: [
          {
            parts: [
              { text: "영수증 이미지를 분석하여 모든 구매 품목을 빠짐없이 ITEM: 양식으로 추출하시오. 2줄 구조 영수증은 상품명과 아래 금액을 한 줄로 합쳐 처리하시오. JSON 절대 금지." },
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
        resultData.date = parts[2] || '';
        resultData.bizNo = parts[3] || '';
        resultData.phone = parts[4] || '';
        resultData.address = parts[5] || '';
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

    return res.status(200).json(resultData);
  } catch (error) {
    return res.status(500).json({ error: error.message || '서버 내부 처리 오류가 발생했습니다.' });
  }
}
