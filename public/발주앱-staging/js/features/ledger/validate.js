// ============================================================
// features/ledger/validate.js — 원장 입력 검증
// ============================================================

/**
 * 입금 등록 데이터 검증
 * @param {Partial<Payment>} payment
 * @returns {string|null} 에러 메시지 또는 null
 */
function validatePayment(payment) {
  if (!payment) return '입금 정보가 없습니다';
  if (!payment.customer || typeof payment.customer !== 'string' || payment.customer.trim() === '') {
    return '납품처 정보가 없습니다';
  }
  if (!payment.date || typeof payment.date !== 'string') {
    return '입금일을 입력해주세요';
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payment.date)) {
    return '입금일 형식이 올바르지 않습니다 (YYYY-MM-DD)';
  }
  if (typeof payment.amount !== 'number' || isNaN(payment.amount)) {
    return '입금 금액을 숫자로 입력해주세요';
  }
  if (payment.amount <= 0) {
    return '입금 금액은 0보다 커야 합니다';
  }
  if (payment.amount > 100_000_000_000) {
    return '입금 금액이 너무 큽니다 (1000억 초과)';
  }
  if (payment.memo && typeof payment.memo === 'string' && payment.memo.length > 200) {
    return '메모는 200자 이내로 입력해주세요';
  }
  return null;
}
