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

    // 모델명을 gemini-3.5-flash 로 지정
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`;

    const systemPrompt = `전문 영수증 분석기입니다. JSON을 절대 출력하지 마십시오.
오직 아래의 줄 단위 텍스트 형식 규칙에 맞춰서만 출력하십시오.

[출력 양식]
SHOP: 상호명 | 업종및가게성격 | 일자 | 사업자번호 | 전화번호 | 주소
ITEM: 원본제품명 | 복원제품명 | 단가또는총액 | 할인금액 | 최종금액
ETC: 항목명 | 금액

[상호명 및 업종및가게성격 작성 규칙 - 필수 준수]
- [업종및가게성격] 항목은 단어 하나로 끝내지 마십시오.
- 상호명과 영수증 품목을 종합 분석하여, 기본 업종/업태와 함께 '주력 판매 제품군' 및 '가게의 구체적인 성격'을 한눈에 알 수 있도록 매끄러운 '짧은 한 문장'으로 작성하십시오.

[금액 추출 핵심 규칙 - 필수 준수]
- 영수증 품목 표의 열(Column) 구성에 [단가], [수량], [금액] 등이 나뉘어 있는 경우:
  * 낱개 '단가'나 '수량' 숫자는 절대 가져오지 마십시오.
  * 오직 해당 라인의 맨 오른쪽 끝에 인쇄된 "단가x수량이 이미 계산된 최종 합산 금액(Line Total)"만을 [단가또는총액]과 [최종금액]에 기재하십시오.
  * 예: [단가 980 | 수량 2 | 금액 1,960] ➔ 980이나 2는 버리고 무조건 1960만 추출할 것.

[PB 상품 및 복원제품명 작성 규칙 - 필수 준수]
- 상호명(구매처)이 대형마트, 편의점, 다이소 등인 경우, 해당 유통사의 전용 PB 상품(노브랜드, 피코크, 홈플러스 시그니처, 요리하다, 오늘좋은, 유어스, 헤이루, 득템, 다이소 등)은 검색 정확도를 위해 복원 제품명 맨 앞에 'PB 브랜드명' 또는 '유통사명'을 반드시 포함하십시오.
  * 예: '순수수제비 500g' (이마트) ➔ '노브랜드 순수수제비'
  * 예: '물구멍방충망' (다이소) ➔ '다이소 물구멍방충망'
- 일반 제조사(NB) 제품은 기존 브랜드명을 유지하고, 규격/중량(g, ml, cm), 품번(6~7자리), 특수기호는 제거하십시오.

[정산 및 요약(ETC) 금지 규칙]
- 과세, 부가세, 세액, VAT, 판매합계, 합계, 총액, 받은금액, 거스름돈, 카드결제 등 단순 결제 합계 관련 항목은 일체 출력 금지.
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
          max_output_tokens: 2000
        },
        contents: [
          {
            parts: [
              { text: "영수증 이미지를 분석하여 [출력 양식]에 맞춰 줄 단위로 추출하시오. 업종은 주력제품과 성격을 담은 짧은 한 문장으로 작성하고, 품목 금액은 맨 우측 최종 합산 금액을 가져오시오. PB 상품은 브랜드명을 포함하고 부가세/합계 라인은 제외하시오. JSON 절대 금지." },
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
      return str.replace(/,/g, '').trim() || fallback;
    };

    const blockedTermsRegex = /(과세|면세|부가세|세액|vat|판매\s*합계|합계|총액|받은\s*금액|거스름\s*돈|결제|카드)/i;
    const lines = rawText.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('SHOP:')) {
        const parts = trimmed.substring(5).split('|').map(cleanStr);
        resultData.shopName = parts[0] || '상호명 미확인';
        resultData.shopOcr = parts[0] || '';
        resultData.shopIndustry = parts[1] || '';
        resultData.date = parts[2] || '';
        resultData.bizNo = parts[3] || '';
        resultData.phone = parts[4] || '';
        resultData.address = parts[5] || '';
      } else if (trimmed.startsWith('ITEM:')) {
        const parts = trimmed.substring(5).split('|').map(cleanStr);
        if (parts[0]) {
          const targetPrice = cleanNum(parts[4] || parts[2], '0');
          resultData.products.push({
            productOcr: parts[0],
            productAi: parts[1] || parts[0],
            totalPrice: targetPrice,
            discount: cleanNum(parts[3], '0'),
            finalPrice: targetPrice
          });
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
