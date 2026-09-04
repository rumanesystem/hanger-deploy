// ============================================================
// features/settlement/query.js — 데이터 가져오기 (현재 Mock, 추후 Firestore)
// ============================================================

/** @type {Order[]} */
const MOCK_ORDERS = [
  { id: 1, orderNum: '20260601-001', status: '출고완료', orderDate: '2026-06-01', shipDate: '2026-06-03', deliveryTo: '홍길동', address: '서울시 강남구 역삼동 123', warehouse: '시흥', totalSupply: 150000, totalVat: 15000, totalAmount: 165000, ecountSlipNos: ['SLIP-001'] },
  { id: 2, orderNum: '20260602-001', status: '출고완료', orderDate: '2026-06-02', shipDate: '2026-06-05', deliveryTo: '박규태', address: '경기 성남시 분당구 정자동 456', warehouse: '평택', totalSupply: 200000, totalVat: 20000, totalAmount: 220000, ecountSlipNos: ['SLIP-002'] },
  { id: 3, orderNum: '20260603-001', status: '출고완료', orderDate: '2026-06-03', shipDate: '2026-06-06', deliveryTo: '홍길동', address: '서울 마포구 합정동 789', warehouse: '시흥', totalSupply: 180000, totalVat: 18000, totalAmount: 198000, ecountSlipNos: ['SLIP-003'] },
  { id: 4, orderNum: '20260605-001', status: '출고완료', orderDate: '2026-06-05', shipDate: '2026-06-08', deliveryTo: '김철수', address: '인천 부평구 부평동 11', warehouse: '시흥', totalSupply: 120000, totalVat: 12000, totalAmount: 132000, ecountSlipNos: [] },
  { id: 5, orderNum: '20260607-001', status: '출고완료', orderDate: '2026-06-07', shipDate: '2026-06-10', deliveryTo: '박규태', address: '서울 송파구 잠실동 22', warehouse: '평택', totalSupply: 250000, totalVat: 25000, totalAmount: 275000, ecountSlipNos: ['SLIP-005'] },
  { id: 6, orderNum: '20260608-001', status: '출고완료', orderDate: '2026-06-08', shipDate: '2026-06-11', deliveryTo: '홍길동', address: '서울 종로구 인사동 33', warehouse: '시흥', totalSupply: 160000, totalVat: 16000, totalAmount: 176000, ecountSlipNos: ['SLIP-006'] },
  { id: 7, orderNum: '20260610-001', status: '출고완료', orderDate: '2026-06-10', shipDate: '2026-06-13', deliveryTo: '이영희', address: '경기 안양시 동안구 평촌동 44', warehouse: '시흥', totalSupply: 140000, totalVat: 14000, totalAmount: 154000, ecountSlipNos: ['SLIP-007'] },
  { id: 8, orderNum: '20260612-001', status: '출고완료', orderDate: '2026-06-12', shipDate: '2026-06-15', deliveryTo: '홍길동', address: '서울 강남구 청담동 55', warehouse: '평택', totalSupply: 220000, totalVat: 22000, totalAmount: 242000, ecountSlipNos: ['SLIP-008'] },
  { id: 9, orderNum: '20260614-001', status: '출고완료', orderDate: '2026-06-14', shipDate: '2026-06-17', deliveryTo: '김철수', address: '인천 서구 청라동 66', warehouse: '시흥', totalSupply: 130000, totalVat: 13000, totalAmount: 143000, ecountSlipNos: ['SLIP-009'] },
  { id: 10, orderNum: '20260615-001', status: '출고완료', orderDate: '2026-06-15', shipDate: '2026-06-18', deliveryTo: '박규태', address: '서울 영등포구 여의도동 77', warehouse: '시흥', totalSupply: 190000, totalVat: 19000, totalAmount: 209000, ecountSlipNos: [] },
  { id: 11, orderNum: '20260617-001', status: '출고완료', orderDate: '2026-06-17', shipDate: '2026-06-20', deliveryTo: '이영희', address: '경기 광명시 철산동 88', warehouse: '평택', totalSupply: 175000, totalVat: 17500, totalAmount: 192500, ecountSlipNos: ['SLIP-011'] },
  { id: 12, orderNum: '20260618-001', status: '출고완료', orderDate: '2026-06-18', shipDate: '2026-06-21', deliveryTo: '홍길동', address: '서울 서초구 서초동 99', warehouse: '시흥', totalSupply: 145000, totalVat: 14500, totalAmount: 159500, ecountSlipNos: ['SLIP-012'] },
  { id: 13, orderNum: '20260620-001', status: '출고완료', orderDate: '2026-06-20', shipDate: '2026-06-23', deliveryTo: '박규태', address: '경기 수원시 영통구 매탄동 111', warehouse: '평택', totalSupply: 210000, totalVat: 21000, totalAmount: 231000, ecountSlipNos: ['SLIP-013'] },
  { id: 14, orderNum: '20260622-001', status: '출고완료', orderDate: '2026-06-22', shipDate: '2026-06-25', deliveryTo: '홍길동', address: '서울 강동구 천호동 222', warehouse: '시흥', totalSupply: 165000, totalVat: 16500, totalAmount: 181500, ecountSlipNos: ['SLIP-014'] },
  { id: 15, orderNum: '20260624-001', status: '출고완료', orderDate: '2026-06-24', shipDate: '2026-06-27', deliveryTo: '김철수', address: '인천 남동구 구월동 333', warehouse: '시흥', totalSupply: 155000, totalVat: 15500, totalAmount: 170500, ecountSlipNos: [] },
  { id: 16, orderNum: '20260625-001', status: '출고완료', orderDate: '2026-06-25', shipDate: '2026-06-28', deliveryTo: '이영희', address: '경기 김포시 장기동 444', warehouse: '평택', totalSupply: 185000, totalVat: 18500, totalAmount: 203500, ecountSlipNos: ['SLIP-016'] },
  { id: 17, orderNum: '20260626-001', status: '출고완료', orderDate: '2026-06-26', shipDate: '2026-06-29', deliveryTo: '박규태', address: '서울 마포구 상암동 555', warehouse: '평택', totalSupply: 230000, totalVat: 23000, totalAmount: 253000, ecountSlipNos: ['SLIP-017'] },
  { id: 18, orderNum: '20260627-001', status: '출고완료', orderDate: '2026-06-27', shipDate: '2026-06-30', deliveryTo: '홍길동', address: '서울 노원구 상계동 666', warehouse: '시흥', totalSupply: 170000, totalVat: 17000, totalAmount: 187000, ecountSlipNos: ['SLIP-018'] },
  { id: 19, orderNum: '20260628-001', status: '출고완료', orderDate: '2026-06-28', shipDate: '2026-07-01', deliveryTo: '김철수', address: '인천 연수구 송도동 777', warehouse: '시흥', totalSupply: 135000, totalVat: 13500, totalAmount: 148500, ecountSlipNos: ['SLIP-019'] },
  { id: 20, orderNum: '20260629-001', status: '출고완료', orderDate: '2026-06-29', shipDate: '2026-07-02', deliveryTo: '이영희', address: '경기 의왕시 포일동 888', warehouse: '평택', totalSupply: 195000, totalVat: 19500, totalAmount: 214500, ecountSlipNos: [] },
  { id: 21, orderNum: '20260630-001', status: '출고완료', orderDate: '2026-06-30', shipDate: '2026-07-03', deliveryTo: '홍길동', address: '서울 광진구 자양동 999', warehouse: '시흥', totalSupply: 175000, totalVat: 17500, totalAmount: 192500, ecountSlipNos: ['SLIP-021'] },
  { id: 22, orderNum: '20260630-002', status: '출고완료', orderDate: '2026-06-30', shipDate: '2026-07-03', deliveryTo: '박규태', address: '서울 용산구 한남동 1010', warehouse: '평택', totalSupply: 215000, totalVat: 21500, totalAmount: 236500, ecountSlipNos: ['SLIP-022'] },
];

/**
 * 출고완료 발주서 조회 + 클라이언트 필터링
 * (추후 Firestore where 쿼리로 교체 → 서버측 필터링)
 *
 * @param {SettlementFilter} filter
 * @returns {Promise<Order[]>}
 */
async function fetchCompletedOrders(filter) {
  const adminView = (typeof isAdmin === 'function') && isAdmin();
  let allOrders = [];
  if (adminView) {
    allOrders = (typeof DB !== 'undefined' && typeof DB.get === 'function')
      ? DB.get('orders', [])
      : [];
  } else {
    if (typeof window === 'undefined' || !window._FS || typeof window._FS.getAllOrders !== 'function') return [];
    try {
      allOrders = await window._FS.getAllOrders({ fromServer: true });
    } catch (e) {
      console.warn('[settlement] 발주자용 orders 서버 조회 실패 → 차단:', e && e.message);
      return [];
    }
  }
  if (!Array.isArray(allOrders)) return [];
  const invoiceMap = await _fetchSettlementInvoiceMap();
  return allOrders.filter(o => {
    if (!o) return false;
    if (!_canViewSettlementOrder(o)) return false;
    // [2026-08-31] 정책 변경: 출고확정만으로 발주자한테도 정산 표시
    //   기존엔 관리자가 [전송] 별도 클릭 → 명세서 sentToCustomer:true 되어야 발주자한테 보였음.
    //   신규: 관리자 [전송] 버튼 없앰. 출고확정 = 곧 발주자한테 노출. UX 단순화.
    // [2026-09-04] 컷오프 도입: orderDate < '2026-09-01' 옛 발주는 옛 정책 유지
    //   (관리자 [전송] 눌러야 발주자 정산 목록에 뜸). 8월 이하 미전송 명세서 자동노출 방지.
    // [2026-08-26] 발주대기(화면 '출고대기') 제외 → 관리자 '출고 확정' 이후만 정산 편입
    if (o.status !== '출고완료' && o.status !== '발주확정') return false;
    if (!adminView) {
      const _autoP = (typeof isInvoiceAutoVisiblePolicy === 'function') ? isInvoiceAutoVisiblePolicy(o) : false;
      if (!_autoP) {
        // 옛 정책: sentToCustomer=true 인 활성 invoice 있어야 발주자에게 노출
        const _inv = o.orderNum ? invoiceMap[o.orderNum] : null;
        if (!_inv || !_inv.sentToCustomer) return false;
      }
    }
    const dateField = getSettlementDate(o);
    if (!dateField) return false;
    if (dateField < filter.range.startDate || dateField > filter.range.endDate) return false;
    if (filter.ordererSearch && !(o.deliveryTo || '').includes(filter.ordererSearch)) return false;
    if (filter.warehouse && o.warehouse !== filter.warehouse) return false;
    return true;
  }).map(o => _applySettlementInvoiceAmount(o, o.orderNum ? invoiceMap[o.orderNum] : null));
}

async function _fetchSettlementInvoiceMap() {
  const adminView = (typeof isAdmin === 'function') && isAdmin();
  let invoices = [];
  if (!adminView) {
    if (typeof window === 'undefined' || !window._FS || typeof window._FS.get !== 'function') return {};
    try {
      invoices = await window._FS.get('invoices', { fromServer: true });
    } catch (e) {
      console.warn('[settlement] 발주자용 invoices 서버 조회 실패 → 차단:', e && e.message);
      return {};
    }
  } else {
    if (typeof DB !== 'undefined' && typeof DB.get === 'function') {
      invoices = DB.get('invoices', []);
    }
    if ((!Array.isArray(invoices) || invoices.length === 0) && typeof window !== 'undefined' && window._FS && typeof window._FS.get === 'function') {
      try {
        invoices = await window._FS.get('invoices');
      } catch (e) {
        console.warn('[settlement] invoices fetch 실패:', e && e.message);
      }
    }
  }
  const map = {};
  // [2026-08-31] 정책 변경: 발주자에게도 sentToCustomer 무관하게 invoice 금액 반영 (정산 목록 노출과 정합)
  //   기존: 발주자는 sentToCustomer:true인 invoice 금액만 봄 → 목록엔 있는데 금액이 order 원본
  //   신규: 활성 invoice 있으면 그 금액 사용 (목록/금액 정책 통일)
  //   단 needsManualReview 상태 invoice는 관리자 재검토 대기 → 발주자한테 stale 금액 노출 금지
  (Array.isArray(invoices) ? invoices : []).forEach(inv => {
    if (!inv || !inv.orderNum || inv.cancelled) return;
    if (!adminView && inv.needsManualReview) return;
    map[inv.orderNum] = inv;
  });
  return map;
}

function _applySettlementInvoiceAmount(order, invoice) {
  if (!invoice) return order;
  return {
    ...order,
    totalSupply: typeof invoice.totalSupply === 'number' ? invoice.totalSupply : order.totalSupply,
    totalVat: typeof invoice.totalVat === 'number' ? invoice.totalVat : order.totalVat,
    totalAmount: typeof invoice.totalAmount === 'number' ? invoice.totalAmount : order.totalAmount,
  };
}

function _canViewSettlementOrder(o) {
  if (typeof isAdmin === 'function' && isAdmin()) return true;
  const user = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
  if (!user) return false;
  if (o.createdBy) return o.createdBy === user.id;
  const deliveryName = String(user.deliveryName || user.name || '').trim();
  const orderDelivery = String(o.deliveryTo || o.siteName || '').trim();
  return !!deliveryName && orderDelivery === deliveryName;
}

/**
 * 발주서 단건 업데이트 (인라인 수정용)
 * (추후 firestore.collection('hanger_orders').doc(orderNum).update(patch) 로 교체)
 *
 * @param {number} orderId
 * @param {Partial<Order>} patch
 * @returns {Promise<void>}
 */
async function updateOrder(orderId, patch) {
  if (typeof isAdmin !== 'function' || !isAdmin()) {
    throw new Error('관리자만 정산 정보를 수정할 수 있습니다.');
  }
  throw new Error('정산 화면 직접 수정은 중단되었습니다. 발주 상세에서 수정해주세요.');
  // Codex 3차 보강 (Low): 실제 DB 우선 — DB.get('orders')에서 찾아 patch 후 DB.set
  // DB.set이 stale 캐시 차단 + hanger_orders 단건 듀얼 라이트까지 처리
  if (typeof DB !== 'undefined' && typeof DB.get === 'function' && typeof DB.set === 'function') {
    const orders = DB.get('orders', []);
    const idx = orders.findIndex(o => o && o.id === orderId);
    if (idx >= 0) {
      const updated = { ...orders[idx], ...patch, updatedAt: new Date().toISOString() };
      const newArr = [...orders];
      newArr[idx] = updated;
      await DB.set('orders', newArr);
      return;
    }
  }
  // fallback: 옛 mock 데이터에만 있는 경우
  const target = (typeof MOCK_ORDERS !== 'undefined') ? MOCK_ORDERS.find(o => o.id === orderId) : null;
  if (!target) throw new Error('발주서를 찾을 수 없습니다: id=' + orderId);
  Object.assign(target, patch);
}
