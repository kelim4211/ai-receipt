export const maxDuration = 30;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  // 환경 변수 설정
  const MAX_DEVICES = Number(process.env.MAX_DEVICES || 15);
  const QUOTA_PER_USER = Number(process.env.QUOTA_PER_USER || 200);
  const expireEnv = process.env.EXPIRATION_DATE || '2026-10-16T18:00:00+09:00';

  // 1. 유효 기한 만료 체크
  if (Date.now() > new Date(expireEnv).getTime()) {
    return res.status(403).json({ error: '사용 기간(10월 16일 18시)이 종료되었습니다.', allowed: false });
  }

  // Upstash Redis URL 및 토큰 포맷 보정
  let rawKvUrl = process.env.KV_REST_API_URL || process.env.STORAGE_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.STORAGE_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

  if (!rawKvUrl.startsWith('http') && rawKvUrl) {
    rawKvUrl = `https://${rawKvUrl}`;
  }
  const kvUrl = rawKvUrl.replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${kvToken}` };

  // ==========================================
  // [A] GET 요청: 최초 접속 시 현재 잔여량 조회
  // ==========================================
  if (req.method === 'GET') {
    const deviceId = req.query.deviceId;
    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId가 필요합니다.' });
    }

    if (!kvUrl || !kvToken) {
      return res.status(200).json({ allowed: true, remaining: QUOTA_PER_USER, totalQuota: QUOTA_PER_USER });
    }

    try {
      const membersRes = await fetch(`${kvUrl}/smembers/receipt_allowed_devices`, { headers });
      const membersData = await membersRes.json();
      const registered = Array.isArray(membersData.result) ? membersData.result : [];

      // 미등록 기기인데 이미 15명이 다 찬 경우
      if (!registered.includes(deviceId) && registered.length >= MAX_DEVICES) {
        return res.status(403).json({ allowed: false, message: `등록 정원(${MAX_DEVICES}명)이 마감되었습니다.` });
      }

      // 등록 보장
      if (!registered.includes(deviceId)) {
        await fetch(`${kvUrl}/sadd/receipt_allowed_devices/${deviceId}`, { headers });
      }

      // 누적 사용량 조회
      const usageRes = await fetch(`${kvUrl}/get/usage:${deviceId}`, { headers });
      const usageData = await usageRes.json();
      const usedCount = Number(usageData.result || 0);
      const remaining = Math.max(0, QUOTA_PER_USER - usedCount);

      return res.status(200).json({
        allowed: true,
        used: usedCount,
        remaining: remaining,
        totalQuota: QUOTA_PER_USER
      });
    } catch (err) {
      return res.status(500).json({ error: err.message || '상태 조회 오류' });
    }
  }

  // ==========================================
  // [B] POST 요청: 영수증 AI 분석 및 1회 차감
  // ==========================================
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '허용되지 않은 메서드입니다.' });
  }

  try {
    const { image, deviceId } = req.body;
    if (!image) {
      return res.status(400).json({ error: '이미지 데이터가 없습니다.' });
    }

    let remainingQuota = QUOTA_PER_USER;

    if (kvUrl && kvToken && deviceId) {
      // 기기 등록 확인
      const membersRes = await fetch(`${kvUrl}/smembers/receipt_allowed_devices`, { headers });
      const membersData = await membersRes.json();
      const registered = Array.isArray(membersData.result) ? membersData.result : [];

      if (!registered.includes(deviceId) && registered.length >= MAX_DEVICES) {
        return res.status(403).json({ error: `등록 인원(${MAX_DEVICES}명)이 마감되었습니다.` });
      }

      if (!registered.includes(deviceId)) {
        await fetch(`${kvUrl}/sadd/receipt_allowed_devices/${deviceId}`, { headers });
      }

      // 카운트 1 증가 (차감)
      const incrRes = await fetch(`${kvUrl}/incr/usage:${deviceId}`, { headers });
      const incrData = await incrRes.json();
      const currentUsed = Number(incrData.result || 1);

      if (currentUsed > QUOTA_PER_USER) {
        return res.status(403).json({ error: `부여된 분석 한도(${QUOTA_PER_USER}회)를 모두 소진하셨습니다.` });
      }

      remainingQuota = Math.max(0, QUOTA_PER_USER - currentUsed);
    }

    // Gemini API 호출
    const imageBase64 = image.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY 환경 변수가 없습니다.' });
    }

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    const systemPrompt = `전문 영수증 분석기입니다. JSON을 절대 출력하지 마십시오.
오직 아래의 줄 단위 텍스트 형식 규칙에 맞춰서만 출력하십시오.

[출력 양식]
SHOP: 상호명[OCR] | 상호명[AI복원] | 업종및가게성격 | 일자 | 사업자번호 | 전화번호 | 주소 | 상호명발췌근거 | 검색용대표브랜드명
ITEM: 원본제품명 | 정밀복원제품명(실제유통데이터및검색일치도가가장높은표준품명) | 단가곱하기수량의합 | 할인액 | 품목종속할인명(없으면 '없음') | 최종금액
ETC: 항목명 | 부호를포함한금액
TOTAL: 영수증에_인쇄된_최종결제총액

[상호명 및 대표 브랜드 규칙]
1. 상호명[OCR]: 영수증에 식별 가능한 경우만 표기, 없으면 반드시 '정보없음'.
2. 상호명[AI복원]: OCR이 '정보없음'일 때 고유 제품명 등을 통해 확실한 경우만 상호명 기재, 모호하면 '정보없음'.
3. 상호명발췌근거: "제품 검색을 통해 확인된 신뢰할 수 있는 고유 제품명 [제품명]을(를) 통해 정확하다고 판단되는 [상호명] 발췌"
4. 검색용대표브랜드명: 
   - 법인명((주) 등)과 지점명(천안본점, 강남점 등)을 완전히 제거한 '핵심 유통/제조 브랜드명' 1단어만 기재하십시오. (예: '(주)아성다이소 천안본점' -> '다이소', '이마트 역삼점' -> '이마트', '나이키 광명' -> '나이키')
   - 일반 자영업 식당, 동네 마트처럼 제품 검색 접두어로 붙였을 때 오히려 방해가 되는 상호는 반드시 '없음'으로 기재하십시오.

[할인 분류 원칙 (원인 주체 및 레이아웃 기반 자체 추론)]
1. 상품 종속 할인 (ITEM 라인에 반영):
   - 발생 원인이 '상품 자체의 행사(1+1, 특정 상품 할인, 유통기한 임박 세일 등)'인 경우.
   - 특정 개별 품목 바로 아래에 들여쓰기나 연이은 줄로 인쇄되어 특정 상품에만 명백히 귀속되는 경우.
2. 거래/결제 종속 할인 (ETC 라인으로 분리 추출):
   - 발생 원인이 '결제 수단(카드사 청구/현장할인), 통신사/멤버십 제휴, 쿠폰, 포인트, 전체 구매조건'인 경우.
   - 영수증 품목 목록 맨 마지막 줄에 단독 마이너스 행으로 표기되거나, 영수증 전체 바스켓 금액에서 차감되는 성격인 경우(예: '결제 할인', '제휴 할인' 등)는 절대 직전 상품의 종속 할인으로 묶지 말고 ETC로 분리하십시오.
   - 단, 개별 품목 할인들의 단순 합계인 '총할인', '할인합계'는 중복 집계되므로 추출하지 마십시오.

[제외 규칙]
- 세금 분리 라인(과세, 과세금액, 부가세, 세액, 면세) 및 단순 수납 라인(총매출액, 받은돈, 거스름돈, 승인금액 등)은 ITEM/ETC에서 완전 제외.`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { max_output_tokens: 4000 },
        contents: [
          {
            parts: [
              { text: "영수증을 규칙대로 정밀 분석하여 출력하십시오." },
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
      return res.status(500).json({ error: `AI 응답 파싱 실패: ${responseText.substring(0, 80)}` });
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
      searchBrand: '',
      overallElements: [],
      products: [],
      receiptTotal: 0,
      verificationStatus: 'NORMAL',
      verificationMessage: '',
      remainingQuota: remainingQuota
    };

    const cleanStr = (str) => (str ? str.replace(/^["']|["']$/g, '').trim() : '');
    const cleanNum = (str, fallback = '0') => {
      if (!str) return fallback;
      const numOnly = str.replace(/[^0-9]/g, '');
      return numOnly || fallback;
    };

    const excludedRegex = /과세|부가세|세액|면세|총매출|받은돈|받을금액|거스름|결제금액|합계금액|카드결제|할인합계|총할인|할인총액|할인액합계/i;
    const isExcluded = (name) => excludedRegex.test(name.replace(/\s+/g, ''));

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
        
        let brandCandidate = parts[8] || '없음';
        resultData.searchBrand = (brandCandidate !== '없음' && !brandCandidate.includes('정보없음')) ? brandCandidate : '';
      } else if (trimmed.startsWith('ITEM:')) {
        const parts = trimmed.substring(5).split('|').map(cleanStr);
        if (parts[0]) {
          if (isExcluded(parts[0])) continue;

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
        
        if (isExcluded(name)) continue;

        let amountStr = parts[1] || '0';
        let isNegative = amountStr.includes('-') || /할인|DC|차감|쿠폰|마이너스/i.test(name);
        let amt = Number(cleanNum(amountStr, '0'));

        if (amt > 0) {
          resultData.overallElements.push({
            name: name,
            amount: isNegative ? `-${amt}` : String(amt)
          });
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
