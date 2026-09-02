// ============================================================
// shared/format.js — 공용 포맷 함수 (정산·원장·발주앱 어디서나 사용)
// ============================================================

/**
 * 금액을 ₩ 포맷으로 변환
 * @param {number|null|undefined} n
 * @returns {string} 예: "₩1,650,000"
 */
function fmtMoney(n) {
  return '₩' + (n ?? 0).toLocaleString('ko-KR');
}

/**
 * ISO 날짜 문자열을 한국 형식으로 변환
 * @param {string} iso - 예: "2026-06-11T01:30:00.000Z"
 * @returns {string} 예: "2026. 6. 11."
 */
function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });
  } catch (e) {
    return iso;
  }
}

/**
 * 날짜 문자열 (YYYY-MM-DD) → 짧은 형식 (M/D)
 * @param {string} dateStr - 예: "2026-06-15"
 * @returns {string} 예: "6/15"
 */
function fmtShortDate(dateStr) {
  if (!dateStr || dateStr.length < 10) return dateStr || '';
  return parseInt(dateStr.slice(5, 7)) + '/' + parseInt(dateStr.slice(8, 10));
}

/**
 * 두 자리 숫자 패딩 (예: 6 → "06")
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * HTML 특수문자를 엔티티로 치환해 XSS 방어
 * @param {string|null|undefined} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
