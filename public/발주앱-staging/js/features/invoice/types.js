// ============================================================
// features/invoice/types.js — 거래명세서 JSDoc 타입 정의
// ============================================================

/**
 * @typedef {Object} InvoiceItem
 * @property {string} name       - 품목명
 * @property {string} spec       - 규격 (색상, 사이즈 등)
 * @property {number} qty        - 수량
 * @property {number} unitPrice  - 단가
 * @property {number} supply     - 공급가액 (qty * unitPrice, 소수점 절사)
 * @property {number} vat        - 부가세 (supply * 0.1, 반올림)
 */

/**
 * @typedef {Object} Invoice
 * @property {string} id          - 문서 ID (Firestore)
 * @property {string} orderNum    - 발주번호
 * @property {string} shipDate    - 출고일 (YYYY-MM-DD)
 * @property {string} deliveryTo  - 공급받는자 상호
 * @property {string} address     - 공급받는자 주소
 * @property {InvoiceItem[]} items - 품목 배열
 * @property {number} totalSupply  - 공급가액 합계
 * @property {number} totalVat     - 부가세 합계
 * @property {number} totalAmount  - 합계금액
 * @property {string} createdAt    - 생성일시 (ISO)
 * @property {string} createdBy    - 생성자 ID
 * @property {string} serial       - 일련번호 (YYYY/MM/DD -N)
 */
