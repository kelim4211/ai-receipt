export const maxDuration = 30; //[cite: 7]

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '잘못된 접근입니다.' }); //[cite: 7]
  }

  try {
    const { image, userCode } = req.body; //[cite: 7]

    // 1. 3인 전용 인증 검증 로직 (환경변수 빠른 검사)
    const allowedKeys = (process.env.ALLOWED_KEYS || '')
      .split(',')
      .map(key => key.trim());

    if (!userCode || !allowedKeys.includes(userCode)) {
      return res.status(403).json({ 
        error: '등록되지 않은 기기이거나 허용되지 않은 사용자입니다.' 
      });
    }

    if (!image) {
      return res.status(400).json({ error: '이미지 데이터가 없습니다.' }); //[cite: 7]
    }

    const imageBase64 = image.replace(/^data:image\/(png|jpeg|jpg);base64,/, ''); //[cite: 7]

    const apiKey = process.env.GEMINI_API_KEY; //[cite: 7]
    if (!apiKey) {
      return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.' }); //[cite: 7]
    }

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const systemPrompt = `전문 영수증 분석기입니다. JSON을 절대 출력하지 마십시오.
오직 아래의 줄 단위 텍스트 형식 규칙에 맞춰서만 출력하십시오.

[출력 양식]
SHOP: 상호명 | 업종및가게성격 | 일자 | 사업자번호 | 전화번호 | 주소
ITEM: 원본제품명 | 복원제품명 | 단가또는총액 | 할인금액 | 최종금액
ETC: 항목명 | 금액

[상호명 및 업종및가게성격 작성 규칙 - 필수 준수]
- [업종및가게성격] 항목은 단어 하나로 끝내지 말고, 기본 업종과 함께 '주력 판매 제품군' 및 '가게의 구체적인 성격'을 담아 매끄러운 짧은 한 문장으로 작성하십시오.

[금액 추출 핵심 규칙 - 필수 준수]
- 낱개 '단가'나 '수량'은 절대 가져오지 마십시오.
- 오직 해당 라인 맨 우측 끝의 "단가x수량이 계산된 최종 합산 금액"만을 [단가또는총액]과 [최종금액]에 기재하십시오.

[PB 상품 및 복원제품명 작성 규칙 - 필수 준수]
- 대형마트, 편의점, 다이소 등의 전용 PB 상품은 제품명 맨 앞에 PB 브랜드(노브랜드, 피코크, 홈플러스 시그니처, 오늘좋은, 유어스, 헤이루, 득템, 다이소 등)를 반드시 포함하십시오.
- 규격/중량(g, ml, cm), 품번(6~7자리), 특수기호는 제거하십시오.

[정산 및 요약(ETC) 금지 규칙]
- 과세, 부가세, 판매합계, 총액, 받은금액, 거스름돈, 카드결제 등 단순 정산 라인은 출력 금지. 실질적인 할인/차감 항목만 ETC로 출력하십시오.`;

    // 2. max_output_tokens를 2000으로 줄여 불필요한 토큰 지연 제거
    const response = await fetch(apiUrl, {
      method: 'POST', //[cite: 7]
      headers: { 
        'Content-Type': 'application/json', //[cite: 7]
        'x-goog-api-key': apiKey //[cite: 7]
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemPrompt }] //[cite: 7]
        },
        generationConfig: {
          max_output_tokens: 2000 // 8000 -> 2000 최적화
        },
        contents: [
          {
            parts: [
              { text: "영수증 이미지를 분석하여 [출력 양식]에 맞춰 줄 단위로 추출하시오. JSON 절대 금지." },
              { inline_data: { mime_type: "image/jpeg", data: imageBase64 } } //[cite: 7]
            ]
          }
        ]
      })
    });

    // 3. 효율적인 JSON 파싱
    if (!response.ok) {
      const errText = await response.text();
      return res.status(500).json({ error: `AI 서버 통신 실패 (${response.status}): ${errText}` });
    }

    const parsedApiResponse = await response.json();
    const rawText = parsedApiResponse.candidates?.[0]?.content?.parts?.[0]?.text || ''; //[cite: 7]
    if (!rawText) {
      return res.status(500).json({ error: 'AI 분석 결과가 비어 있습니다.' }); //[cite: 7]
    }

    const resultData = {
      shopOcr: '', //[cite: 7]
      shopName: '', //[cite: 7]
      shopIndustry: '', //[cite: 7]
      date: '', //[cite: 7]
      bizNo: '', //[cite: 7]
      phone: '', //[cite: 7]
      address: '', //[cite: 7]
      overallElements: [], //[cite: 7]
      products: [] //[cite: 7]
    };

    const cleanStr = (str) => (str || '').trim();
    const cleanNum = (str, fallback = '0') => {
      if (!str) return fallback; //[cite: 7]
      return str.replace(/,/g, '').trim() || fallback; //[cite: 7]
    };

    const blockedTermsRegex = /(과세|면세|부가세|세액|vat|판매\s*합계|합계|총액|받은\s*금액|거스름\s*돈|결제|카드)/i; //[cite: 7]
    const lines = rawText.split('\n'); //[cite: 7]

    for (const line of lines) {
      const trimmed = line.trim(); //[cite: 7]
      if (!trimmed) continue; //[cite: 7]

      if (trimmed.startsWith('SHOP:')) { //[cite: 7]
        const parts = trimmed.substring(5).split('|').map(cleanStr); //[cite: 7]
        resultData.shopName = parts[0] || '상호명 미확인'; //[cite: 7]
        resultData.shopOcr = parts[0] || ''; //[cite: 7]
        resultData.shopIndustry = parts[1] || ''; //[cite: 7]
        resultData.date = parts[2] || ''; //[cite: 7]
        resultData.bizNo = parts[3] || ''; //[cite: 7]
        resultData.phone = parts[4] || ''; //[cite: 7]
        resultData.address = parts[5] || ''; //[cite: 7]
      } else if (trimmed.startsWith('ITEM:')) { //[cite: 7]
        const parts = trimmed.substring(5).split('|').map(cleanStr); //[cite: 7]
        if (parts[0]) { //[cite: 7]
          const targetPrice = cleanNum(parts[4] || parts[2], '0'); //[cite: 7]
          resultData.products.push({
            productOcr: parts[0], //[cite: 7]
            productAi: parts[1] || parts[0], //[cite: 7]
            totalPrice: targetPrice, //[cite: 7]
            discount: cleanNum(parts[3], '0'), //[cite: 7]
            finalPrice: targetPrice //[cite: 7]
          });
        }
      } else if (trimmed.startsWith('ETC:')) { //[cite: 7]
        const parts = trimmed.substring(4).split('|').map(cleanStr); //[cite: 7]
        const name = parts[0] || ''; //[cite: 7]
        if (name && !blockedTermsRegex.test(name)) { //[cite: 7]
          resultData.overallElements.push({
            name: name, //[cite: 7]
            amount: cleanNum(parts[1], '0') //[cite: 7]
          });
        }
      }
    }

    return res.status(200).json(resultData); //[cite: 7]
  } catch (error) {
    return res.status(500).json({ error: error.message || '서버 내부 처리 오류가 발생했습니다.' }); //[cite: 7]
  }
}
