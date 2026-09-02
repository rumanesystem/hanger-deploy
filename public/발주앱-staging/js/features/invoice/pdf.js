// ============================================================
// features/invoice/pdf.js — PDF 다운로드
// 의존: jsPDF CDN, html2canvas CDN
// ============================================================

/**
 * 거래명세서 요소를 캡처하여 landscape A4 PDF로 저장
 * @param {HTMLElement} invoiceEl
 * @param {string} filename
 */
async function downloadInvoicePDF(invoiceEl, filename) {
  const _notify = (msg) => (typeof toast === 'function') ? toast(msg, 'error') : alert(msg);
  if (!window.html2canvas) { _notify('html2canvas 로드 중입니다. 잠시 후 다시 시도해주세요.'); return; }
  if (!window.jspdf && !window.jsPDF) { _notify('jsPDF 로드 중입니다. 잠시 후 다시 시도해주세요.'); return; }

  try {
    const canvas = await html2canvas(invoiceEl, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff'
    });

    const imgData = canvas.toDataURL('image/png');
    const jsPDFClass = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    const pdf = new jsPDFClass({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    const pdfW = pdf.internal.pageSize.getWidth();
    const pdfH = pdf.internal.pageSize.getHeight();
    const ratio = Math.min(pdfW / canvas.width, pdfH / canvas.height);
    const imgW  = canvas.width  * ratio;
    const imgH  = canvas.height * ratio;
    const offsetX = (pdfW - imgW) / 2;
    const offsetY = (pdfH - imgH) / 2;

    pdf.addImage(imgData, 'PNG', offsetX, offsetY, imgW, imgH);
    pdf.save(filename || 'invoice.pdf');
  } catch (e) {
    console.error('[Invoice PDF]', e);
    _notify('PDF 생성 중 오류가 발생했습니다.');
  }
}
