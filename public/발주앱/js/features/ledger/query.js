// ============================================================
// features/ledger/query.js — 원장 데이터 가져오기/저장 (Mock 데이터)
// 추후 Firestore 쿼리·쓰기로 교체 예정
// ============================================================

/**
 * Mock 데이터 — 발주서 + 품목 상세
 * items: [{ name, color, qty, unitPrice }]
 *   - 표시: name [color] / qty * unitPrice = amount (부가세 포함)
 *   - 실제 Firestore 연결 시 upperMaterials/shelfItems/drawerItems 등에서 추출
 * @type {Order[]}
 */
const LEDGER_MOCK_ORDERS = [
  { id: 1, orderNum: '20260601-001', status: '출고완료', orderDate: '2026-06-01', shipDate: '2026-06-03', deliveryTo: '홍길동', address: '101-204', warehouse: '시흥', totalSupply: 150000, totalVat: 15000, totalAmount: 165000,
    items: [
      { name: '포스트바 2250', color: '화이트', qty: 9, unitPrice: 10000 },
      { name: '선반바 400', color: '화이트', qty: 20, unitPrice: 2000 },
      { name: '코너바 2200', color: '화이트', qty: 2, unitPrice: 5800 },
      { name: '조절발', color: '화이트', qty: 18, unitPrice: 900 },
      { name: '옷봉 2400', color: '화이트', qty: 4, unitPrice: 5000 },
    ]
  },
  { id: 2, orderNum: '20260603-001', status: '출고완료', orderDate: '2026-06-03', shipDate: '2026-06-06', deliveryTo: '홍길동', address: '909동1701호', warehouse: '시흥', totalSupply: 180000, totalVat: 18000, totalAmount: 198000,
    items: [
      { name: '포스트바 2250', color: '화이트', qty: 6, unitPrice: 10000 },
      { name: '선반바 400', color: '화이트', qty: 12, unitPrice: 2000 },
      { name: '선반', color: '솔리드 770mm', qty: 8, unitPrice: 4600 },
      { name: '겉서랍 2단', color: '솔리드', qty: 1, unitPrice: 69000 },
    ]
  },
  { id: 3, orderNum: '20260605-001', status: '출고완료', orderDate: '2026-06-05', shipDate: '2026-06-08', deliveryTo: '김철수', address: '107동1009호', warehouse: '시흥', totalSupply: 120000, totalVat: 12000, totalAmount: 132000,
    items: [
      { name: '포스트바 2250', color: '실버', qty: 4, unitPrice: 10000 },
      { name: '선반바 400', color: '실버', qty: 12, unitPrice: 2000 },
      { name: '선반', color: '스톤그레이 520mm', qty: 4, unitPrice: 3600 },
      { name: '코너선반', color: '스톤그레이 710×520', qty: 2, unitPrice: 11000 },
    ]
  },
  { id: 4, orderNum: '20260608-001', status: '출고완료', orderDate: '2026-06-08', shipDate: '2026-06-11', deliveryTo: '홍길동', address: '107동1904호', warehouse: '시흥', totalSupply: 160000, totalVat: 16000, totalAmount: 176000,
    items: [
      { name: '포스트바 2250', color: '화이트', qty: 7, unitPrice: 10000 },
      { name: '선반바 400', color: '화이트', qty: 17, unitPrice: 2000 },
      { name: '선반', color: '솔리드 770mm', qty: 6, unitPrice: 4600 },
      { name: '겉서랍 3단', color: '솔리드', qty: 1, unitPrice: 92000 },
    ]
  },
  { id: 5, orderNum: '20260610-001', status: '출고완료', orderDate: '2026-06-10', shipDate: '2026-06-13', deliveryTo: '이영희', address: '716동505호', warehouse: '시흥', totalSupply: 140000, totalVat: 14000, totalAmount: 154000,
    items: [
      { name: '포스트바 2250', color: '블랙', qty: 8, unitPrice: 11000 },
      { name: '선반바 400', color: '블랙', qty: 14, unitPrice: 2100 },
      { name: '선반', color: '스톤그레이 570mm', qty: 9, unitPrice: 4200 },
    ]
  },
  { id: 6, orderNum: '20260612-001', status: '출고완료', orderDate: '2026-06-12', shipDate: '2026-06-15', deliveryTo: '홍길동', address: '111동101호', warehouse: '평택', totalSupply: 220000, totalVat: 22000, totalAmount: 242000,
    items: [
      { name: '포스트바 2250', color: '화이트', qty: 7, unitPrice: 11000 },
      { name: '선반바 400', color: '화이트', qty: 21, unitPrice: 2100 },
      { name: '선반', color: '솔리드 770mm', qty: 7, unitPrice: 5300 },
      { name: '겉서랍 3단', color: '솔리드', qty: 1, unitPrice: 92000 },
      { name: '거울장 목대', color: '솔리드', qty: 1, unitPrice: 87000 },
    ]
  },
  { id: 7, orderNum: '20260614-001', status: '출고완료', orderDate: '2026-06-14', shipDate: '2026-06-17', deliveryTo: '김철수', address: '103-1803', warehouse: '시흥', totalSupply: 130000, totalVat: 13000, totalAmount: 143000,
    items: [
      { name: '포스트바 2250', color: '블랙', qty: 3, unitPrice: 11000 },
      { name: '선반바 400', color: '블랙', qty: 6, unitPrice: 2100 },
      { name: '선반', color: '메이플 2400mm', qty: 3, unitPrice: 16000 },
    ]
  },
  { id: 8, orderNum: '20260615-001', status: '출고완료', orderDate: '2026-06-15', shipDate: '2026-06-18', deliveryTo: '박규태', address: '송파504호', warehouse: '시흥', totalSupply: 190000, totalVat: 19000, totalAmount: 209000,
    items: [
      { name: '포스트바 2250', color: '화이트', qty: 10, unitPrice: 11000 },
      { name: '선반바 400', color: '화이트', qty: 38, unitPrice: 2100 },
      { name: '선반', color: '솔리드 370mm', qty: 14, unitPrice: 3200 },
      { name: '겉서랍 2단', color: '솔리드', qty: 2, unitPrice: 69000 },
    ]
  },
  { id: 9, orderNum: '20260617-001', status: '출고완료', orderDate: '2026-06-17', shipDate: '2026-06-20', deliveryTo: '이영희', address: '호매실402호', warehouse: '평택', totalSupply: 175000, totalVat: 17500, totalAmount: 192500,
    items: [
      { name: '포스트바 2250', color: '실버', qty: 5, unitPrice: 11000 },
      { name: '선반바 400', color: '실버', qty: 9, unitPrice: 2100 },
      { name: '선반', color: '스톤그레이 570mm', qty: 6, unitPrice: 4200 },
      { name: '코너선반', color: '스톤그레이 780×585', qty: 3, unitPrice: 13000 },
    ]
  },
  { id: 10, orderNum: '20260620-001', status: '출고완료', orderDate: '2026-06-20', shipDate: '2026-06-23', deliveryTo: '박규태', address: '광주 2층계단', warehouse: '평택', totalSupply: 210000, totalVat: 21000, totalAmount: 231000,
    items: [
      { name: '포스트바 2250', color: '화이트', qty: 9, unitPrice: 11000 },
      { name: '선반바 400', color: '화이트', qty: 24, unitPrice: 2100 },
      { name: '겉서랍 4단', color: '솔리드', qty: 1, unitPrice: 139000 },
    ]
  },
  { id: 11, orderNum: '20260622-001', status: '출고완료', orderDate: '2026-06-22', shipDate: '2026-06-25', deliveryTo: '홍길동', address: '102-804', warehouse: '시흥', totalSupply: 165000, totalVat: 16500, totalAmount: 181500,
    items: [
      { name: '포스트바 2250', color: '골드', qty: 12, unitPrice: 11000 },
      { name: '선반바 400', color: '골드', qty: 34, unitPrice: 2100 },
      { name: '선반', color: '스톤그레이 570mm', qty: 21, unitPrice: 4200 },
    ]
  },
  { id: 12, orderNum: '20260624-001', status: '출고완료', orderDate: '2026-06-24', shipDate: '2026-06-27', deliveryTo: '김철수', address: '303-1704', warehouse: '시흥', totalSupply: 155000, totalVat: 15500, totalAmount: 170500,
    items: [
      { name: '포스트바 2250', color: '화이트', qty: 5, unitPrice: 11000 },
      { name: '선반바 400', color: '화이트', qty: 10, unitPrice: 2100 },
      { name: '겉서랍 3단', color: '화이트 오크', qty: 1, unitPrice: 92000 },
    ]
  },
  { id: 13, orderNum: '20260625-001', status: '출고완료', orderDate: '2026-06-25', shipDate: '2026-06-28', deliveryTo: '이영희', address: '103-1203', warehouse: '평택', totalSupply: 185000, totalVat: 18500, totalAmount: 203500,
    items: [
      { name: '포스트바 2250', color: '골드', qty: 15, unitPrice: 11000 },
      { name: '선반바 400', color: '골드', qty: 24, unitPrice: 2100 },
      { name: '이불 긴장문', color: '메이플', qty: 2, unitPrice: 70000 },
    ]
  },
];

/** @type {Payment[]} */
let LEDGER_MOCK_PAYMENTS = [
  { id: 'p1', customer: '홍길동', date: '2026-06-08', amount: 500000, memo: '6월 1차 정산' },
  { id: 'p2', customer: '박규태', date: '2026-06-22', amount: 440000, memo: '계좌이체' },
  { id: 'p3', customer: '김철수', date: '2026-06-10', amount: 200000, memo: '카드결제' },
  { id: 'p4', customer: '홍길동', date: '2026-06-20', amount: 300000, memo: '현금' },

];

/**
 * 전체 출고완료 발주서 조회
 * 발주앱 메인 통합 환경: DB.get 메모리 캐시 사용 (syncFromServer 후)
 * 폴백 환경: 빈 배열
 * @returns {Promise<Order[]>}
 */
async function fetchAllCompletedOrders() {
  const allOrders = (typeof DB !== 'undefined' && typeof DB.get === 'function')
    ? DB.get('orders', [])
    : [];
  // [2026-08-26] 정책: 발주대기(화면 '출고대기') 제외 → 관리자 '출고 확정' 이후만 원장 반영
  // 출고완료 + 발주확정(=UI '출고확정') 둘 다 매출 인식 (운영 워크플로우)
  return allOrders.filter(o => o && _canViewLedgerOrder(o) && (o.status === '출고완료' || o.status === '발주확정'));
}

function _canViewLedgerOrder(o) {
  if (typeof isAdmin === 'function' && isAdmin()) return true;
  const user = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
  if (!user) return false;
  if (o.createdBy) return o.createdBy === user.id;
  const deliveryName = String(user.deliveryName || user.name || '').trim();
  const orderDelivery = String(o.deliveryTo || o.siteName || '').trim();
  return !!deliveryName && orderDelivery === deliveryName;
}

function _visibleLedgerCustomers() {
  if (typeof isAdmin === 'function' && isAdmin()) return null;
  const user = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
  const names = new Set();
  if (user) {
    if (user.deliveryName) names.add(String(user.deliveryName).trim());
    if (user.name) names.add(String(user.name).trim());
  }
  const allOrders = (typeof DB !== 'undefined' && typeof DB.get === 'function')
    ? DB.get('orders', [])
    : [];
  allOrders.filter(_canViewLedgerOrder).forEach(o => {
    const name = String(o.deliveryTo || o.siteName || '').trim();
    if (name) names.add(name);
  });
  names.delete('');
  return names;
}

/**
 * 전체 입금 내역 조회 — hanger_payments 컬렉션 (문서 단위)
 * @returns {Promise<Payment[]>}
 */
async function fetchAllPayments() {
  if (typeof window === 'undefined' || !window._FS || typeof window._FS.collectionGet !== 'function') return [];
  const arr = await window._FS.collectionGet('hanger_payments');
  if (!Array.isArray(arr)) return [];
  const allowed = _visibleLedgerCustomers();
  if (!allowed) return arr;
  return arr.filter(p => p && allowed.has(String(p.customer || '').trim()));
}

/**
 * 감사 로그 기록 — hanger_payment_logs 컬렉션 (race-free)
 * @param {object} log
 * @returns {Promise<void>}
 */
async function _appendPaymentLog(log) {
  if (typeof window === 'undefined' || !window._FS || typeof window._FS.collectionAdd !== 'function') return;
  const id = 'plog_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const entry = {
    id,
    at: new Date().toISOString(),
    by: (typeof currentUser !== 'undefined' && currentUser) ? (currentUser.id || currentUser.name || 'unknown') : 'unknown',
    ...log
  };
  try { await window._FS.collectionAdd('hanger_payment_logs', id, entry); }
  catch (e) { console.warn('[payment_logs 저장 실패]', e.message); }
}

/**
 * 입금 등록 — hanger_payments 컬렉션에 단건 저장 (race-free, 1MB 무한)
 * @param {Omit<Payment, 'id'>} payment
 * @returns {Promise<Payment>}
 */
async function createPayment(payment) {
  if (typeof isAdmin !== 'function' || !isAdmin()) {
    throw new Error('관리자만 입금을 등록할 수 있습니다.');
  }
  const id = 'p' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const saved = {
    ...payment,
    id,
    createdAt: new Date().toISOString(),
    createdBy: (typeof currentUser !== 'undefined' && currentUser) ? (currentUser.id || currentUser.name || 'unknown') : 'unknown'
  };
  if (typeof window === 'undefined' || !window._FS || typeof window._FS.collectionAdd !== 'function') {
    throw new Error('DB 사용 불가 — 저장할 수 없습니다.');
  }
  // 단건 문서 저장 — 다른 관리자의 저장과 충돌 없음 (각자 다른 문서)
  await window._FS.collectionAdd('hanger_payments', id, saved);
  // [D] 감사 로그
  await _appendPaymentLog({
    action: 'create',
    paymentId: id,
    customer: saved.customer,
    date: saved.date,
    amount: saved.amount,
    memo: saved.memo || ''
  });
  return saved;
}

/**
 * 입금 삭제 — hanger_payments 컬렉션 단건 삭제 + 감사 로그 (사유 필수)
 * @param {string} paymentId
 * @param {string} reason
 * @returns {Promise<void>}
 */
async function deletePayment(paymentId, reason) {
  if (typeof isAdmin !== 'function' || !isAdmin()) {
    throw new Error('관리자만 입금을 삭제할 수 있습니다.');
  }
  if (typeof window === 'undefined' || !window._FS || typeof window._FS.collectionDelete !== 'function') return;
  // 삭제 전 스냅샷 (감사 로그용)
  let target = null;
  try {
    const arr = await window._FS.collectionGet('hanger_payments');
    target = arr.find(p => p && p.id === paymentId) || null;
  } catch(_) {}
  await window._FS.collectionDelete('hanger_payments', paymentId);
  if (target) {
    await _appendPaymentLog({
      action: 'delete',
      paymentId,
      customer: target.customer,
      date: target.date,
      amount: target.amount,
      memo: target.memo || '',
      reason: String(reason || '')
    });
  }
}

/**
 * 전체 거래명세서(invoice) 조회 — 원장의 출고 매출에 적용
 * 발주앱 메인 통합 환경에서만 작동 (window._FS 필요)
 * 단독 페이지(Firebase 미초기화)에선 빈 배열 반환
 * @returns {Promise<Array>}
 */
async function fetchAllInvoices() {
  if (typeof window === 'undefined' || !window._FS) {
    return []; // 단독 페이지/Mock 환경
  }
  try {
    const list = await window._FS.get('invoices');
    if (!Array.isArray(list)) return [];
    if (typeof isAdmin === 'function' && isAdmin()) return list;
    const allOrders = (typeof DB !== 'undefined' && typeof DB.get === 'function')
      ? DB.get('orders', [])
      : [];
    const allowedOrderNums = new Set(
      allOrders.filter(_canViewLedgerOrder).map(o => o && o.orderNum).filter(Boolean)
    );
    // [2026-08-31] 정책 변경: 출고확정만으로 발주자한테 원장 표시 (sentToCustomer 요구 제거)
    //   단 needsManualReview 상태 invoice는 관리자 재검토 대기 → 발주자한테 stale 금액 노출 금지
    const adminView = (typeof isAdmin === 'function') && isAdmin();
    return list.filter(inv => {
      if (!inv || inv.cancelled) return false;
      if (!allowedOrderNums.has(inv.orderNum)) return false;
      if (!adminView && inv.needsManualReview) return false;
      return true;
    });
  } catch (e) {
    console.warn('[ledger] invoices fetch 실패:', e && e.message);
    return [];
  }
}
