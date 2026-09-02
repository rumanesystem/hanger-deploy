// ============================================================
// features/ledger/types.js — 거래처 원장 도메인 타입
// ============================================================

/**
 * 입금 내역 (Firestore hanger_payments 컬렉션 문서)
 * @typedef {Object} Payment
 * @property {string} id - 문서 ID (auto-generated)
 * @property {string} customer - 납품처 이름
 * @property {string} date - 입금일 (YYYY-MM-DD)
 * @property {number} amount - 입금 금액 (원 단위 정수)
 * @property {string} [memo] - 메모 (선택)
 * @property {string} [createdAt] - 등록일시 (ISO string)
 * @property {string} [createdBy] - 등록자 ID
 */

/**
 * 거래처 통계 (원장 화면 상단 카드용)
 * @typedef {Object} CustomerStats
 * @property {number} orderCount - 출고완료 건수
 * @property {number} totalOut - 총 출고금액
 * @property {number} totalIn - 총 입금액
 * @property {number} balance - 미수금 잔액 (totalOut - totalIn)
 * @property {Order[]} orders
 * @property {Payment[]} payments
 */

/**
 * 원장 표의 한 행 (출고 또는 입금)
 * @typedef {Object} LedgerEvent
 * @property {string} date - 발생 날짜 (YYYY-MM-DD)
 * @property {'out'|'in'} type - 출고 또는 입금
 * @property {string} description - 표시 내용
 * @property {number} amount
 * @property {string|number} id - 원본 ID (출고면 order.id, 입금이면 payment.id)
 * @property {string} [orderNum] - 출고 행일 때 발주번호
 * @property {string} [address] - 출고 행일 때 시공 주소
 * @property {Warehouse} [warehouse] - 출고 행일 때 창고
 * @property {number} [balance] - 잔액 누적값 (시간순 정렬 후 계산)
 */

/**
 * 거래처 목록 한 행 (목록 화면용)
 * @typedef {Object} CustomerSummary
 * @property {string} name
 * @property {number} orderCount
 * @property {number} totalOut
 * @property {number} totalIn
 * @property {number} balance
 */
