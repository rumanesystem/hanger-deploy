// ============================================================
// features/settlement/validate.js — 입력 검증 함수 (Zod 대신)
// 모든 검증 함수는 에러 메시지 또는 null 반환
// ============================================================

/**
 * 날짜 범위 검증
 * @param {DateRange} range
 * @returns {string|null} 에러 메시지 또는 null (정상)
 */
function validateDateRange(range) {
  if (!range) return '날짜 범위가 없습니다';
  if (!range.startDate || !range.endDate) return '시작일과 종료일을 모두 입력해주세요';
  if (!isValidDateFormat(range.startDate)) return '시작일 형식이 올바르지 않습니다 (YYYY-MM-DD)';
  if (!isValidDateFormat(range.endDate)) return '종료일 형식이 올바르지 않습니다 (YYYY-MM-DD)';
  if (range.startDate > range.endDate) return '시작일이 종료일보다 늦습니다';
  return null;
}

/**
 * YYYY-MM-DD 형식 검증
 * @param {string} dateStr
 * @returns {boolean}
 */
function isValidDateFormat(dateStr) {
  if (typeof dateStr !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(dateStr);
  return !isNaN(d.getTime());
}

/**
 * 수정된 발주서 데이터 검증 (인라인 수정 시)
 * @param {Partial<Order>} edited
 * @returns {string|null}
 */
function validateOrderEdit(edited) {
  if (edited.totalSupply !== undefined && (typeof edited.totalSupply !== 'number' || edited.totalSupply < 0)) {
    return '공급가액은 0 이상의 숫자여야 합니다';
  }
  if (edited.totalVat !== undefined && (typeof edited.totalVat !== 'number' || edited.totalVat < 0)) {
    return '부가세는 0 이상의 숫자여야 합니다';
  }
  if (edited.totalAmount !== undefined && (typeof edited.totalAmount !== 'number' || edited.totalAmount < 0)) {
    return '합계 금액은 0 이상의 숫자여야 합니다';
  }
  if (edited.orderDate !== undefined && !isValidDateFormat(edited.orderDate)) {
    return '발주일 형식이 올바르지 않습니다';
  }
  if (edited.warehouse !== undefined && edited.warehouse !== '시흥' && edited.warehouse !== '평택') {
    return '창고는 시흥 또는 평택만 선택 가능합니다';
  }
  return null;
}
