// ============================================================
// features/invoice/render.js — 거래명세서 HTML 렌더링 (편집 가능)
// ============================================================

const SUPPLIER = {
  name:    '루마네시스템',
  bizno:   '793-81-02453',
  ceo:     '조영석',
  address: '경기도 시흥시 수인로3077번길 24-8',
  tel:     ''
};

// XSS 방어: innerHTML 에 박히는 모든 사용자 데이터(납품처/주소/품목명)는 escHtml 거치기
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 편집 가능한 td (contenteditable) — 클릭하면 입력
// data-field 로 어떤 필드인지 표시 (저장 시 DOM에서 값 수집)
function _editTd(value, field, opts) {
  opts = opts || {};
  const cls = 'invoice-td invoice-editable' + (opts.right ? ' invoice-td-right' : '') + (opts.center ? ' invoice-td-center' : '');
  const safe = escHtml(value == null ? '' : value);
  return `<td class="${cls}" contenteditable="true" data-field="${field}" spellcheck="false">${safe}</td>`;
}

// 일자 표시: YYYY-MM-DD → MM/DD (원본 양식)
function _shortDate(d) {
  if (!d) return '';
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}` : String(d);
}

// 행 단위 HTML 생성 (편집 가능)
function _itemRowHTML(item, shipDate) {
  item = item || {};
  const name = item.spec ? `${item.name || ''} [${item.spec}]` : (item.name || '');
  const dateVal = item.date || shipDate || '';
  const supplyText = item.supply != null && item.supply !== '' ? Number(item.supply).toLocaleString() : '';
  const vatText    = item.vat    != null && item.vat    !== '' ? Number(item.vat).toLocaleString() : '';
  return `<tr class="invoice-item-row">
    ${_editTd(_shortDate(dateVal), 'date', { center: true })}
    ${_editTd(name, 'name')}
    ${_editTd(item.qty != null ? item.qty : '', 'qty', { right: true })}
    ${_editTd(item.unitPrice != null ? item.unitPrice : '', 'unitPrice', { right: true })}
    <td class="invoice-td invoice-td-right invoice-td-supply invoice-editable" contenteditable="true" data-field="supply" spellcheck="false">${supplyText}</td>
    <td class="invoice-td invoice-td-right invoice-td-vat invoice-editable" contenteditable="true" data-field="vat" spellcheck="false">${vatText}</td>
    <td class="invoice-td invoice-td-center invoice-row-del-cell no-print"><button type="button" class="invoice-row-del" title="행 삭제">×</button></td>
  </tr>`;
}

/**
 * 거래명세서 HTML 문자열 생성 (한국 표준 거래명세서 양식 — 가로 landscape)
 * 좌상단: 제목 + 공급받는자 박스 (貴 中 형식)
 * 우상단: 공급자 박스 (일련번호/TEL/사업자등록번호/성명/상호/주소)
 * 상단 중앙: 금액 강조 박스
 * 표: 일자/품목명[규격]/수량(단위포함)/단가/공급가액/부가세
 * 하단: 한 줄 합계 (수량/공급가액/VAT/합계/인수)
 * @param {Invoice} invoice
 * @returns {string}
 */
function buildInvoiceHTML(invoice) {
  const items = invoice.items || [];
  // 모바일에선 빈 행 최소화 (세로 길이 축소), 데스크탑은 원본 영수증 느낌 유지
  // 짤림 0% — Math.max로 items 전부 + 빈 행 1 보장, 부족할 때만 5까지 채움
  const _isMobile = (typeof window !== 'undefined') && window.innerWidth < 768;
  const MIN_ROWS = _isMobile ? Math.max(items.length + 1, 5) : 13;
  const rows = [...items];
  while (rows.length < MIN_ROWS) rows.push(null);

  const itemRowsHTML = rows.map(it => _itemRowHTML(it, invoice.shipDate)).join('');

  const totalQty   = items.reduce((s, i) => s + (Number(i.qty) || 0), 0);
  const totalSupply = invoice.totalSupply != null ? invoice.totalSupply : items.reduce((s,i)=>s+(Number(i.supply)||0),0);
  const totalVat    = invoice.totalVat    != null ? invoice.totalVat    : items.reduce((s,i)=>s+(Number(i.vat)||0),0);
  const totalAmount = invoice.totalAmount != null ? invoice.totalAmount : (totalSupply + totalVat);

  // 일련번호 형식: YYYY/MM/DD -N
  const serialDisplay = invoice.serial
    ? (invoice.serial.includes('-') || invoice.serial.includes('/') ? invoice.serial : invoice.serial)
    : '';
  const revisionDisplay = Math.max(1, Number(invoice.revision) || 1);
  const manualReviewBanner = invoice.needsManualReview
    ? '<div class="no-print" style="margin-bottom:10px;padding:9px 12px;border:1px solid #f59e0b;background:#fffbeb;color:#92400e;border-radius:6px;font-weight:700">수기 편집본과 최신 발주 내용이 다릅니다. 확인 후 다시 저장·전송해주세요.</div>'
    : '';

  return `
<style>
  .invoice-editable { background: #fffef0; cursor: text; outline: none; }
  .invoice-editable:hover { background: #fef9c3; }
  .invoice-editable:focus { background: #fff; box-shadow: inset 0 0 0 2px #2563eb; }
  .invoice-row-del { background: none; border: none; color: #cbd5e1; font-size: 16px; font-weight: 700; cursor: pointer; padding: 0 4px; line-height: 1; }
  .invoice-row-del:hover { color: #dc2626; }
  .invoice-item-row:hover .invoice-row-del { color: #94a3b8; }
  .invoice-add-row-wrap { padding: 8px 0; text-align: center; }
  .invoice-add-row-btn { background: #eff6ff; color: #1e40af; border: 1px dashed #2563eb; padding: 6px 18px; border-radius: 6px; font-size: 12px; font-weight: 700; cursor: pointer; }
  .invoice-add-row-btn:hover { background: #dbeafe; }
  .invoice-receipt-input { background: #fffef0; outline: none; cursor: text; min-width: 80px; display: inline-block; padding: 2px 6px; border-radius: 3px; }
  .invoice-receipt-input:hover { background: #fef9c3; }
  .invoice-receipt-input:focus { background: #fff; box-shadow: inset 0 0 0 2px #2563eb; }
</style>
<div class="invoice-wrap classic" data-invoice-id="${escHtml(invoice.id || '')}" data-invoice-order-num="${escHtml(invoice.orderNum || '')}" data-invoice-serial="${escHtml(invoice.serial || '')}" data-invoice-ship-date="${escHtml(invoice.shipDate || '')}" data-invoice-delivery-to="${escHtml(invoice.deliveryTo || '')}" data-invoice-address="${escHtml(invoice.address || '')}">
  ${manualReviewBanner}

  <!-- 상단: 좌(제목 + 받는자) | 우(공급자) -->
  <div class="ci-top">
    <div class="ci-top-left">
    <div class="ci-title">거래명세서 <span style="font-size:12px;font-weight:700;color:#475569">Rev.${revisionDisplay}</span></div>
      <table class="ci-receiver-tbl">
        <tbody>
          <tr><td class="ci-receiver-name"><span contenteditable="true" data-field="recv-name" class="invoice-editable">${escHtml(invoice.deliveryTo || '')}</span> <span class="ci-gwiing">貴 中</span></td></tr>
          <tr><td class="ci-receiver-addr"><span class="ci-row-label">시공주소</span> <span contenteditable="true" data-field="recv-addr" class="invoice-editable">${escHtml(invoice.address || '')}</span></td></tr>
          <tr><td class="ci-receiver-tel"><span class="ci-tel-icon">☎</span> <span contenteditable="true" data-field="recv-tel" class="invoice-editable">${escHtml(invoice.receiverTel || '')}</span></td></tr>
        </tbody>
      </table>
    </div>
    <div class="ci-top-right">
      <table class="ci-supplier-tbl">
        <tbody>
          <tr>
            <td class="ci-sup-side" rowspan="5">공<br>급<br>자</td>
            <th>발주번호</th><td class="ci-sup-val">${escHtml(invoice.orderNum || '')}</td>
            <th>TEL</th><td class="ci-sup-val">${escHtml(SUPPLIER.tel)}</td>
          </tr>
          <tr>
            <th>사업자등록<br>번호</th><td class="ci-sup-val">${escHtml(SUPPLIER.bizno)}</td>
            <th>성명</th><td class="ci-sup-val">${escHtml(SUPPLIER.ceo)}</td>
          </tr>
          <tr>
            <th>상호</th><td class="ci-sup-val" colspan="3">${escHtml(SUPPLIER.name)}</td>
          </tr>
          <tr>
            <th>주소</th><td class="ci-sup-val" colspan="3">${escHtml(SUPPLIER.address)}</td>
          </tr>
          <tr>
            <th>담당자</th><td class="ci-sup-val" colspan="3">${escHtml(invoice.issuerName || (typeof currentUser !== 'undefined' && currentUser && currentUser.name) || '')}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- 상단 금액 강조 박스 -->
  <div class="ci-amount-bar">
    <span class="ci-amount-label">금  액 :</span>
    <span class="ci-amount-korean">${numberToKorean(totalAmount || 0)}</span>
    <span class="ci-amount-won">(<span class="ci-amount-won-value">${(totalAmount || 0).toLocaleString()}</span>)</span>
  </div>

  <!-- 메인 표 -->
  <table class="ci-items-tbl">
    <thead>
      <tr>
        <th style="width:80px">일자</th>
        <th>품목명[규격]</th>
        <th style="width:80px">수량<br>(단위포함)</th>
        <th style="width:90px">단가</th>
        <th style="width:100px">공급가액</th>
        <th style="width:90px">부가세</th>
        <th class="no-print" style="width:30px"></th>
      </tr>
    </thead>
    <tbody class="invoice-items-tbody">${itemRowsHTML}</tbody>
  </table>

  <div class="invoice-add-row-wrap no-print">
    <button type="button" class="invoice-add-row-btn"><i class="fas fa-plus"></i> 행 추가</button>
  </div>

  <!-- 하단 합계 한 줄 -->
  <table class="ci-total-tbl">
    <tbody>
      <tr>
        <th style="width:70px">수량</th>
        <td class="ci-total-num"><span class="invoice-td-total-qty">${totalQty.toLocaleString()}</span></td>
        <th style="width:90px">공급가액</th>
        <td class="ci-total-num"><span class="invoice-td-total-supply">${(totalSupply || 0).toLocaleString()}</span></td>
        <th style="width:60px">VAT</th>
        <td class="ci-total-num"><span class="invoice-td-total-vat">${(totalVat || 0).toLocaleString()}</span></td>
        <th style="width:60px">합계</th>
        <td class="ci-total-num"><span class="invoice-summary-amount">${(totalAmount || 0).toLocaleString()}</span></td>
        <th style="width:60px">인수</th>
        <td class="ci-receiver-cell"><span contenteditable="true" data-field="receiver-name" class="invoice-receipt-input">${escHtml(invoice.receiverName || '')}</span><span class="ci-in-mark">인</span></td>
      </tr>
    </tbody>
  </table>

  <!-- 합계금액/한글금액은 hidden span 으로 유지 (실시간 재계산용) -->
  <div class="invoice-hidden-totals" style="display:none">
    <span class="invoice-summary-supply">${(totalSupply || 0).toLocaleString()} 원</span>
    <span class="invoice-summary-vat">${(totalVat || 0).toLocaleString()} 원</span>
    <span class="invoice-korean-amount">${numberToKorean(totalAmount || 0)}</span>
  </div>
</div>
`;
}

// 한 행의 입력값에서 supply/vat 계산하여 같은 행에 반영
function _recalcRow(tr) {
  if (!tr) return;
  const qty = Number((tr.querySelector('[data-field="qty"]')?.textContent || '').replace(/[,\s]/g,'')) || 0;
  const unitPrice = Number((tr.querySelector('[data-field="unitPrice"]')?.textContent || '').replace(/[,\s]/g,'')) || 0;
  const supply = Math.round(qty * unitPrice);
  const vat = Math.round(supply * 0.1);
  const supplyCell = tr.querySelector('.invoice-td-supply');
  const vatCell = tr.querySelector('.invoice-td-vat');
  if (supplyCell) supplyCell.textContent = supply ? supply.toLocaleString() : '';
  if (vatCell) vatCell.textContent = vat ? vat.toLocaleString() : '';
}

// 모든 행 합계 → 표 푸터·하단 요약·한글금액 갱신
function _recalcTotals(wrap) {
  if (!wrap) return;
  let totalQty = 0, totalSupply = 0, totalVat = 0;
  wrap.querySelectorAll('.invoice-item-row').forEach(tr => {
    const qty = Number((tr.querySelector('[data-field="qty"]')?.textContent || '').replace(/[,\s]/g,'')) || 0;
    const supply = Number((tr.querySelector('.invoice-td-supply')?.textContent || '').replace(/[,\s]/g,'')) || 0;
    const vat = Number((tr.querySelector('.invoice-td-vat')?.textContent || '').replace(/[,\s]/g,'')) || 0;
    totalQty += qty;
    totalSupply += supply;
    totalVat += vat;
  });
  const totalAmount = totalSupply + totalVat;
  const setText = (sel, val) => { const el = wrap.querySelector(sel); if (el) el.textContent = val; };
  setText('.invoice-td-total-qty', totalQty.toLocaleString());
  setText('.invoice-td-total-supply', totalSupply.toLocaleString());
  setText('.invoice-td-total-vat', totalVat.toLocaleString());
  setText('.invoice-summary-supply', totalSupply.toLocaleString() + ' 원');
  setText('.invoice-summary-vat', totalVat.toLocaleString() + ' 원');
  setText('.invoice-summary-amount', totalAmount.toLocaleString() + ' 원');
  setText('.invoice-korean-amount', numberToKorean(totalAmount));
}

// 모달 내 이벤트 위임 — 편집·삭제·추가
function _attachInvoiceEditEvents(wrap) {
  if (!wrap || wrap._invEditAttached) return;
  wrap._invEditAttached = true;

  // 셀 편집 시 같은 행 재계산 + 전체 합계 갱신
  wrap.addEventListener('input', e => {
    // 수량/단가 → 공급가액·부가세 자동 계산 + 합계 갱신
    const qtyOrPrice = e.target.closest('[data-field="qty"], [data-field="unitPrice"]');
    if (qtyOrPrice) {
      const tr = qtyOrPrice.closest('tr');
      _recalcRow(tr);
      _recalcTotals(wrap);
      return;
    }
    // 공급가액/부가세 직접 수정 → 합계만 갱신 (행 자동 계산 안 함, 사용자 입력 보존)
    const supplyOrVat = e.target.closest('[data-field="supply"], [data-field="vat"]');
    if (supplyOrVat) {
      _recalcTotals(wrap);
    }
  });

  // 행 삭제
  wrap.addEventListener('click', e => {
    const delBtn = e.target.closest('.invoice-row-del');
    if (delBtn) {
      const tr = delBtn.closest('tr');
      if (tr) tr.remove();
      _recalcTotals(wrap);
      return;
    }
    const addBtn = e.target.closest('.invoice-add-row-btn');
    if (addBtn) {
      const tbody = wrap.querySelector('.invoice-items-tbody');
      if (tbody) {
        const shipDate = wrap.dataset.invoiceShipDate || '';
        tbody.insertAdjacentHTML('beforeend', _itemRowHTML(null, shipDate));
        _recalcTotals(wrap);
      }
    }
  });
}

/**
 * 현재 모달 DOM에서 사용자가 편집한 최종 invoice 객체를 수집
 * @param {Invoice} baseInvoice - 원본 invoice (id, orderNum 등 메타 유지용)
 * @returns {Invoice}
 */
function collectInvoiceFromDOM(baseInvoice) {
  const wrap = document.querySelector('#invoiceContent .invoice-wrap');
  if (!wrap) return baseInvoice;
  const items = [];
  wrap.querySelectorAll('.invoice-item-row').forEach(tr => {
    const date = tr.querySelector('[data-field="date"]')?.textContent.trim() || '';
    const nameRaw = tr.querySelector('[data-field="name"]')?.textContent.trim() || '';
    const qty = Number((tr.querySelector('[data-field="qty"]')?.textContent || '').replace(/[,\s]/g,'')) || 0;
    const unitPrice = Number((tr.querySelector('[data-field="unitPrice"]')?.textContent || '').replace(/[,\s]/g,'')) || 0;
    // 모두 빈 행은 제외
    // 공급가액·부가세도 셀에서 직접 읽음 (사용자가 수정한 값 보존)
    const supplyText = (tr.querySelector('[data-field="supply"]')?.textContent || '').replace(/[,\s]/g,'');
    const vatText = (tr.querySelector('[data-field="vat"]')?.textContent || '').replace(/[,\s]/g,'');
    const supplyParsed = Number(supplyText) || 0;
    const vatParsed = Number(vatText) || 0;
    if (!date && !nameRaw && !qty && !unitPrice && !supplyParsed && !vatParsed) return;
    // 품목명 [규격] 형식 파싱
    let name = nameRaw, spec = '';
    const m = nameRaw.match(/^(.*?)\s*\[(.+?)\]\s*$/);
    if (m) { name = m[1].trim(); spec = m[2].trim(); }
    // 사용자가 입력한 supply/vat 우선, 없으면 수량×단가 자동 계산
    const supply = supplyParsed || Math.round(qty * unitPrice);
    const vat = vatParsed || Math.round(supply * 0.1);
    items.push({ date, name, spec, qty, unitPrice, supply, vat });
  });
  const totalSupply = items.reduce((s,i)=>s+(i.supply||0),0);
  const totalVat = items.reduce((s,i)=>s+(i.vat||0),0);
  const deliveryTo = wrap.querySelector('[data-field="recv-name"]')?.textContent.trim() || '';
  const address = wrap.querySelector('[data-field="recv-addr"]')?.textContent.trim() || '';
  const receiverTel = wrap.querySelector('[data-field="recv-tel"]')?.textContent.trim() || '';
  const receiverName = wrap.querySelector('[data-field="receiver-name"]')?.textContent.trim() || '';
  const receiverStamp = wrap.querySelector('[data-field="receiver-stamp"]')?.textContent.trim() || '';
  return {
    ...baseInvoice,
    items,
    totalSupply,
    totalVat,
    totalAmount: totalSupply + totalVat,
    deliveryTo,
    address,
    receiverTel,
    receiverName,
    receiverStamp
  };
}

/**
 * 거래명세서 모달 표시
 * @param {Object} orderOrInvoice
 * @param {'preview'|'view'} mode
 */
function openInvoiceModal(orderOrInvoice, mode) {
  const modal   = document.getElementById('invoiceModal');
  const content = document.getElementById('invoiceContent');
  if (!modal || !content) { console.warn('[Invoice] 모달 DOM 없음'); return; }
  content.innerHTML = buildInvoiceHTML(orderOrInvoice);
  modal.style.display = 'flex';
  // 편집 이벤트 위임 등록 + 초기 합계 재계산 (DOM 값으로)
  const wrap = content.querySelector('.invoice-wrap');
  _attachInvoiceEditEvents(wrap);
  // 초기 표시는 invoice.items가 supply/vat 가지고 있어서 totalSupply 이미 채워져 있음 — recalc 안 함
}

// 글로벌 노출 (invoice/index.js의 저장 핸들러에서 사용)
window._collectInvoiceFromDOM = collectInvoiceFromDOM;
