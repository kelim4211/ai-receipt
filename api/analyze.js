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

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const systemPrompt = `전문 영수증 분석기입니다. JSON을 절대 출력하지 마십시오.
오직 아래의 줄 단위 텍스트 형식 규칙에 맞춰서만 출력하십시오.

[출력 양식]
SHOP: 상호명 | 업종및가게성격 | 일자 | 사업자번호 | 전화번호 | 주소
ITEM: 원본제품명 | 복원제품명 | 정가(단가수량곱한값) | 할인금액 | 최종결제금액
ETC: 항목명 | 금액

[필수 작성 규칙]
- SHOP 라인은 반드시 'SHOP:'으로 시작하고 각 항목을 파이프(|)로 구분하십시오.
- [업종및가게성격]은 상호와 품목을 분석해 '업종 (주력 판매 제품군 및 성격)' 형태의 짧은 한 문장으로 반드시 작성하십시오.
- 영수증에 인쇄된 일자, 사업자번호, 전화번호, 주소를 정확히 추출하되, 인쇄되어 있지 않거나 보이지 않으면 "미확인"으로 적으십시오. 절대 날짜를 임의로 지어내지 마십시오.
- 코스트코 등 CPN(쿠폰 할인)이 아래줄에 따로 인쇄된 경우, 해당 품목의 '정가(할인 전 금액)'와 '할인액', 그리고 '최종결제금액(정가-할인액)'을 각각 구분하여 정확히 분리 기재하십시오.

[금액 추출 핵심 규칙 - 필수 준수]
- ITEM 라인의 세 번째 값은 [정가(할인 전 단가*수량 금액)], 네 번째 값은 [할인액], 다섯 번째 값은 [최종결제금액]을 기재할 것.
  * 예: 비비고수제깻잎의 경우 정가는 16490, 할인액은 6500, 최종금액은 9990으로 각각 분리하여 추출해야 합니다.

[복원제품명 작성 규칙]
- 영수증 인쇄 글자 수 한계로 끊긴 단어는 온전한 완제품 명칭으로 자연스럽게 복원하십시오.
- 상품 고유 품번(숫자 6~7자리), 물리적 규격/중량(g, ml, cm 등), 포장 단위 및 낱개 수량, 특수기호(*, [], () 등)는 복원 제품명에서 제거하십시오.

[정산 및 요약(ETC) 금지 규칙]
- '과세 합계', '과세', '부가세', '세액', 'VAT', '판매 합계', '합계', '총액', '받은금액', '거스름돈', '카드결제' 등 세금 및 단순 결제 합계 관련 항목은 일체 출력 금지.
- 오직 통신사 할인, 포인트 사용 등 실질적인 할인/차감 항목만 ETC로 출력할 것.

[출력 예시]
SHOP: 이마트 안양점 | 대형마트 | 2026-03-29 | 123-45-67890 | 031-000-0000 | 경기도 안양시
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
              { text: "영수증 이미지를 분석하여 [출력 양식]에 맞춰 줄 단위로 추출하시오. 품목별로 정가, 할인액, 최종결제금액을 각각 분리하여 정확히 기재하고, 부가세/합계 라인은 제외하시오." },
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
          const rawOriginal = cleanNum(parts[2], '0');
          const rawDiscount = cleanNum(parts[3], '0');
          const rawFinal = cleanNum(parts[4] || parts[2], '0');

          resultData.products.push({
            productOcr: parts[0],
            productAi: parts[1] || parts[0],
            totalPrice: rawOriginal, // 단가*수량 (정가) 영역에 16490 매핑
            discount: rawDiscount,   // 할인액 영역에 6500 매핑
            finalPrice: rawFinal     // 금액 영역에 9990 매핑
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
