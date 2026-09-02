// ============================================================
// features/invoice/query.js — 거래명세서 Firestore 쿼리
// Q1=B: hanger_data/invoices 문서 배열 push (핫픽스 A 패턴)
// 로컬 폴백 금지 — 서버 미수신 시 빈 배열 반환 + console.warn
// ============================================================

const INVOICE_DOC_KEY = 'invoices';

// H1 보강 (Codex): 같은 탭 직렬화 mutex — 두 호출이 같은 list 베이스로 작업하는 race 차단
let _invoiceWriteChain = Promise.resolve();
function _withInvoiceLock(fn) {
  const prev = _invoiceWriteChain;
  let release;
  _invoiceWriteChain = new Promise(r => { release = r; });
  return prev.then(fn).finally(release);
}

function invoiceContentSignature(invoice) {
  const inv = invoice || {};
  return JSON.stringify({
    shipDate: inv.shipDate || '',
    deliveryTo: inv.deliveryTo || '',
    address: inv.address || '',
    receiverTel: inv.receiverTel || '',
    receiverName: inv.receiverName || '',
    receiverStamp: inv.receiverStamp || '',
    totalSupply: Number(inv.totalSupply) || 0,
    totalVat: Number(inv.totalVat) || 0,
    totalAmount: Number(inv.totalAmount) || 0,
    items: (inv.items || []).map(item => ({
      // [2026-08-03 B1] date 제외. orderToInvoice 는 안 채우고 DOM collect 는 채워서
      // 매 편집마다 signature 불일치 → needsManualReview 무한 트리거되던 문제 방지.
      name: item && item.name || '',
      spec: item && item.spec || '',
      qty: Number(item && item.qty) || 0,
      unitPrice: Number(item && item.unitPrice) || 0,
      supply: Number(item && item.supply) || 0,
      vat: Number(item && item.vat) || 0
    }))
  });
}

function _invoiceEventId(prefix, invoiceId) {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${invoiceId || 'invoice'}_${Date.now()}_${random}`;
}

function _invoiceRevision(before, after, reason) {
  const nextRevision = Math.max(1, Number(before && before.revision) || 1) + 1;
  return {
    id: _invoiceEventId('irev', before && before.id),
    invoiceId: before && before.id || '',
    orderNum: before && before.orderNum || after && after.orderNum || '',
    serial: before && before.serial || after && after.serial || '',
    revision: nextRevision,
    reason: reason || 'invoice-update',
    createdBy: (typeof currentUser !== 'undefined' && currentUser && currentUser.id) || '',
    before: before || null,
    after: after || null
  };
}

function _requireInvoiceTransaction() {
  if (!window._FS || typeof window._FS.transactInvoices !== 'function') {
    throw new Error('안전한 명세서 저장 기능을 불러오지 못했습니다. 새로고침 후 다시 시도해주세요.');
  }
  return window._FS.transactInvoices.bind(window._FS);
}

// H1 보강: set 직전 최신 list와 id 기준 union 병합 (다른 탭 추가본 보존)
async function _unionWithLatest(myList) {
  try {
    const latest = await window._FS.get(INVOICE_DOC_KEY);
    if (!Array.isArray(latest)) return myList;
    const byId = new Map();
    // 최신 서버 데이터를 base로
    latest.forEach(inv => { if (inv && inv.id) byId.set(inv.id, inv); });
    // 내 list의 변경사항으로 덮어쓰기 (내 수정 보존)
    myList.forEach(inv => { if (inv && inv.id) byId.set(inv.id, inv); });
    return [...byId.values()];
  } catch (_e) {
    return myList;
  }
}

/**
 * 안전 fetch + 가드: invoices 통째 덮어쓰기 시나리오 차단
 *   1. _FS.get이 null/undefined 반환 시 throw (저장 중단)
 *   2. 반환된 list가 비배열 + 비-falsy면 throw (예상 외 형식)
 * @returns {Promise<Array>}
 */
async function _safeFetchInvoiceList() {
  if (!window._FS) throw new Error('[Invoice] _FS 미초기화');
  const list = await window._FS.get(INVOICE_DOC_KEY);
  // null/undefined: 진짜 처음(컬렉션 없음) 또는 일시 실패 — 구분 불가하므로 빈 배열 가정 단, 추가 가드
  if (list === null || list === undefined) {
    return null; // 호출처에서 별도 처리 (신규/실패 구분)
  }
  if (!Array.isArray(list)) {
    throw new Error('[Invoice] invoices 형식 불일치 — 저장 중단');
  }
  return list;
}

/**
 * 저장 직전 운영 DB 재검증 — 동시 수정·sync 깨짐 감지
 * 우리가 가진 length보다 운영 list가 더 크면 → 다른 호출이 데이터 추가했음 → 저장 중단
 * @param {{length:number}} known - 저장 직전 우리가 갖고 있던 길이 정보
 * @returns {Promise<void>} 안전하면 그냥 끝, 위험하면 throw
 */
async function _verifyBeforeSave({ length: knownLength }) {
  const verify = await window._FS.get(INVOICE_DOC_KEY);
  if (verify === null || verify === undefined) return; // 신규
  if (!Array.isArray(verify)) {
    throw new Error('[Invoice] 재검증 형식 불일치 — 저장 중단');
  }
  if (verify.length > knownLength) {
    throw new Error(`[Invoice] 동시 수정 감지 (DB ${verify.length}건 > 우리 ${knownLength}건) — 저장 중단, 새로고침 후 재시도`);
  }
}

/**
 * 거래명세서 저장 — hanger_data/invoices 문서의 배열에 push
 * 안전망:
 *   1. _safeFetchInvoiceList — null/형식 가드
 *   2. push 후 길이 검증 (절대 줄어들 수 없음)
 *   3. _verifyBeforeSave — 직전 재검증 (동시 수정 차단)
 * @param {Invoice} invoice
 * @returns {Promise<Invoice>}
 */
async function saveInvoice(invoice) {
  return _withInvoiceLock(async () => {
    const transact = _requireInvoiceTransaction();
    const proposedId = invoice.id || _invoiceEventId('inv', invoice.orderNum);
    return transact(invoice.orderNum, ({ order, invoices }) => {
      if (!order) throw new Error('발주서를 서버에서 확인할 수 없어 명세서 저장을 중단했습니다.');
      const active = invoices.filter(i => i && i.orderNum === invoice.orderNum && !i.cancelled);
      if (active.length > 0) {
        return { invoices, write: false, result: active[active.length - 1] };
      }
      const saved = { ...invoice, id: proposedId, revision: Number(invoice.revision) || 1 };
      if (saved.serial) {
        const prefix = String(saved.serial).split(' ')[0];
        const sameDay = invoices.filter(i => i && typeof i.serial === 'string' && i.serial.startsWith(prefix));
        if (sameDay.some(i => i.serial === saved.serial)) {
          // [2026-08-03 B5] length+1 대신 max+1 로 gaps 있을 때 충돌 방지
          let maxN = 0;
          sameDay.forEach(i => {
            const m = String(i.serial).match(/-\s*(\d+)\s*$/);
            if (m) {
              const n = parseInt(m[1], 10);
              if (!isNaN(n) && n > maxN) maxN = n;
            }
          });
          saved.serial = prefix + ' -' + (maxN + 1);
        }
      }
      return { invoices: [...invoices, saved], result: saved };
    });
  });
}

/**
 * 특정 발주번호의 거래명세서 목록 반환
 * @param {string} orderNum
 * @returns {Promise<Invoice[]>}
 */
async function getInvoicesByOrderNum(orderNum) {
  if (!window._FS) { console.warn('[Invoice] _FS 미초기화 — 빈 배열 반환'); return []; }
  const list = await window._FS.get(INVOICE_DOC_KEY);
  if (!Array.isArray(list)) { console.warn('[Invoice] invoices 문서 없음 — 빈 배열 반환'); return []; }
  return list.filter(inv => inv && inv.orderNum === orderNum);
}

/**
 * 거래명세서 업데이트 (수기 편집 저장)
 * 같은 id로 찾아서 통째 교체 (patch가 아니라 full replace — 사용자 직접 수정한 최종본 반영)
 * 안전망: _safeFetchInvoiceList + 길이 가드(교체는 같음, 신규는 +1) + recheck
 * @param {Invoice} invoice - id 필수, 이외 필드는 갱신될 최종값
 * @returns {Promise<Invoice>}
 */
async function updateInvoice(invoice, options = {}) {
  if (!invoice || !invoice.id) throw new Error('[Invoice] update: id 없음');
  return _withInvoiceLock(async () => {
    const transact = _requireInvoiceTransaction();
    return transact(invoice.orderNum, ({ order, invoices }) => {
      if (!order) throw new Error('발주서를 서버에서 확인할 수 없어 명세서 수정을 중단했습니다.');
      const idx = invoices.findIndex(inv => inv && inv.id === invoice.id);
      if (idx < 0) throw new Error('다른 작업에서 명세서가 삭제 또는 변경되었습니다. 새로고침 후 다시 시도해주세요.');
      const current = invoices[idx];
      if (options.expectedSignature && invoiceContentSignature(current) !== options.expectedSignature) {
        throw new Error('다른 관리자가 명세서를 먼저 수정했습니다. 새로고침 후 다시 시도해주세요.');
      }
      if (options.expectedUpdatedAt !== undefined && String(current.updatedAt || '') !== String(options.expectedUpdatedAt || '')) {
        throw new Error('검토 중 발주 또는 명세서가 다시 변경되었습니다. 최신 내용을 다시 확인해주세요.');
      }
      const changed = invoiceContentSignature(current) !== invoiceContentSignature(invoice);
      if (!changed) return { invoices, write: false, result: current };

      const updated = {
        ...current,
        ...invoice,
        id: current.id,
        serial: current.serial,
        createdAt: current.createdAt,
        createdBy: current.createdBy,
        sentToCustomer: options.keepSent === true ? !!current.sentToCustomer : false,
        sentAt: options.keepSent === true ? (current.sentAt || null) : null,
        _manuallyEdited: options.markManual === true || current._manuallyEdited === true,
        _manualEditedAt: options.markManual === true ? new Date().toISOString() : current._manualEditedAt,
        needsManualReview: false,
        pendingAutoDraft: null,
        updatedAt: new Date().toISOString()
      };
      const revision = _invoiceRevision(current, updated, options.reason || 'manual-edit');
      updated.revision = revision.revision;
      revision.after = updated;
      const next = [...invoices];
      next[idx] = updated;
      return { invoices: next, result: updated, revision };
    });
  });
}

/**
 * 발주확정 취소 시 — 해당 orderNum의 활성 invoice에 cancelled=true 플래그
 * 삭제 X (사용자 수기 편집값 보존 + 복구 가능)
 * 5중 안전망 동일 적용
 * @param {string} orderNum
 * @returns {Promise<number>} 취소 처리된 invoice 수
 */
async function cancelInvoiceByOrderNum(orderNum) {
  if (!window._FS) throw new Error('[Invoice] _FS 미초기화');
  if (!orderNum) return 0;
  return _withInvoiceLock(async () => {
    const transact = _requireInvoiceTransaction();
    return transact(orderNum, ({ invoices }) => {
      let changed = 0;
      const newList = invoices.map(inv => {
      if (inv && inv.orderNum === orderNum && !inv.cancelled) {
        changed++;
        return { ...inv, cancelled: true, cancelledAt: new Date().toISOString(), sentToCustomer: false, sentAt: null, updatedAt: new Date().toISOString() };
      }
      return inv;
      });
      return { invoices: newList, write: changed > 0, result: changed };
    });
  });
}

/**
 * 발주자 전송 상태 토글 — 해당 orderNum의 활성 invoice의 sentToCustomer 갱신
 * 5중 안전망 동일 적용
 * @param {string} orderNum
 * @param {boolean} sent
 * @returns {Promise<number>} 갱신된 invoice 수
 */
async function setInvoiceSent(orderNum, sent) {
  if (!window._FS) throw new Error('[Invoice] _FS 미초기화');
  if (!orderNum) return 0;
  return _withInvoiceLock(async () => {
    const transact = _requireInvoiceTransaction();
    return transact(orderNum, ({ invoices }) => {
      const active = invoices.filter(inv => inv && inv.orderNum === orderNum && !inv.cancelled);
      if (sent && active.some(inv => inv.needsManualReview)) {
        throw new Error('수기 편집 명세서와 최신 발주 내용이 달라 먼저 명세서를 확인·저장해야 합니다.');
      }
      if (sent && active.length !== 1) {
        throw new Error('활성 명세서가 여러 개이거나 없습니다. 중복 명세서를 먼저 정리해주세요.');
      }
      let changed = 0;
      const newList = invoices.map(inv => {
      if (inv && inv.orderNum === orderNum && !inv.cancelled) {
        changed++;
        return {
          ...inv,
          sentToCustomer: !!sent,
          sentAt: sent ? new Date().toISOString() : null,
          needsManualReview: sent ? false : !!inv.needsManualReview,
          updatedAt: new Date().toISOString()
        };
      }
      return inv;
      });
      return { invoices: newList, write: changed > 0, result: changed };
    });
  });
}

/**
 * 특정 날짜의 거래명세서 시리얼 목록 반환 (일련번호 생성용)
 * @param {string} yyyymmdd - 예: "20260612"
 * @returns {Promise<string[]>}
 */
async function getInvoicesByDate(yyyymmdd) {
  if (!window._FS) { console.warn('[Invoice] _FS 미초기화 — 빈 배열 반환'); return []; }
  const list = await window._FS.get(INVOICE_DOC_KEY);
  if (!Array.isArray(list)) { console.warn('[Invoice] invoices 문서 없음 — 빈 배열 반환'); return []; }
  const dateStr = yyyymmdd.slice(0, 4) + '-' + yyyymmdd.slice(4, 6) + '-' + yyyymmdd.slice(6, 8);
  return list
    .filter(inv => inv && inv.shipDate === dateStr)
    .map(inv => inv.serial || '');
}
