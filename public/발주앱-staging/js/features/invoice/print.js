// ============================================================
// features/invoice/print.js — 거래명세서 인쇄
// @media print 스타일은 style.css 에서 #print-area 만 표시하도록 설정.
// 따라서 명세서 내용을 #print-area 로 복사 후 print, 복원.
// ============================================================

let _printInFlight = false;
function printInvoice() {
  // [2026-08-03 fix] 중복 호출 방어 — 첫 print 복원 완료 전엔 재진입 차단
  if (_printInFlight) return;
  const src = document.getElementById('invoiceContent');
  const printArea = document.getElementById('print-area');
  if (!src || !printArea) { window.print(); return; }
  _printInFlight = true;
  // 원본 유지, 클론만 print-area 로
  const clone = src.cloneNode(true);
  // 편집 UI(삭제 버튼 등) 인쇄에서 숨김
  clone.querySelectorAll('.invoice-row-del, .invoice-add-row-btn, .invoice-add-row-wrap, button, input, select').forEach(el => {
    // input/select 는 값만 static text 로 대체
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT') {
      const span = document.createElement('span');
      span.textContent = el.value || '';
      span.style.cssText = 'font-size:12px';
      el.parentNode && el.parentNode.replaceChild(span, el);
    } else {
      el.style.display = 'none';
    }
  });
  const prev = printArea.innerHTML;
  printArea.innerHTML = '';
  printArea.appendChild(clone);
  const restore = () => {
    printArea.innerHTML = prev;
    window.removeEventListener('afterprint', restore);
    _printInFlight = false;
  };
  window.addEventListener('afterprint', restore);
  window.print();
  // 브라우저에 따라 afterprint가 안 뜰 수 있음. 모바일 인쇄 미리보기가
  // 준비되기 전에 DOM을 지우지 않도록 충분히 긴 최종 안전 타임아웃만 둔다.
  setTimeout(() => {
    if (_printInFlight) {
      printArea.innerHTML = prev;
      window.removeEventListener('afterprint', restore);
      _printInFlight = false;
    }
  }, 120000);
}
