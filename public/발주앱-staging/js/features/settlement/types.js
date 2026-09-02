// ============================================================
// features/settlement/types.js — 정산 도메인 타입 정의 (JSDoc)
// 다른 파일에서 import 없이도 VS Code가 인식해서 자동완성·오류 검사
// ============================================================

/**
 * 발주서 (Firestore hanger_orders 컬렉션 문서)
 * @typedef {Object} Order
 * @property {number} id - 서버 발급 ID
 * @property {string} orderNum - 발주번호 (예: "20260611-001")
 * @property {OrderStatus} status - 발주 상태
 * @property {string} orderDate - 발주일 (YYYY-MM-DD)
 * @property {string} shipDate - 출고일 (YYYY-MM-DD)
 * @property {string} deliveryTo - 납품처 이름
 * @property {string} address - 시공 주소
 * @property {Warehouse} warehouse - 출고 창고
 * @property {string} [createdBy] - 발주자 계정 ID
 * @property {number} totalSupply - 공급가액
 * @property {number} totalVat - 부가세
 * @property {number} totalAmount - 합계 금액
 * @property {string[]} [ecountSlipNos] - 이카운트 전표번호 (현재 사용 안 함)
 */

/**
 * 발주 상태
 * @typedef {'임시저장'|'발주대기'|'발주확정'|'출고준비'|'출고완료'|'취소'|'보관'} OrderStatus
 */

/**
 * 출고 창고
 * @typedef {'시흥'|'평택'} Warehouse
 */

/**
 * 정산 기간 단위
 * @typedef {'daily'|'weekly'|'monthly'|'quarterly'|'yearly'|'custom'} PeriodMode
 */

/**
 * 날짜 범위
 * @typedef {Object} DateRange
 * @property {string} startDate - YYYY-MM-DD
 * @property {string} endDate - YYYY-MM-DD
 */

/**
 * 정산 필터
 * @typedef {Object} SettlementFilter
 * @property {DateRange} range
 * @property {string} ordererSearch - 납품처 부분 검색어 (빈 문자열 = 전체)
 * @property {Warehouse|''} warehouse - 빈 문자열 = 전체
 */

/**
 * 납품처별 정산 통계
 * @typedef {Object} CustomerStats
 * @property {Order[]} orders
 * @property {number} totalSupply
 * @property {number} totalVat
 * @property {number} totalAmount
 */

/**
 * 정산 요약 (4개 카드용)
 * @typedef {Object} SettlementSummary
 * @property {number} count - 출고완료 건수
 * @property {number} totalSupply
 * @property {number} totalVat
 * @property {number} totalAmount
 */
