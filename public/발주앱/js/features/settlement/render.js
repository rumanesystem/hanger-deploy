// ============================================================
// features/settlement/render.js — UI 렌더링 + 사용자 이벤트 처리
// 의존: shared/format.js, ./types.js, ./utils.js, ./validate.js, ./query.js, ./export.js
// ============================================================

/** @type {PeriodMode} */
let currentMode = 'monthly';
let currentValue = currentMonthValue_();
let settlementSortOrder = 'desc';

function pad2_(n) {
  return String(n).padStart(2, '0');
}

function todayValue_() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2_(d.getMonth() + 1)}-${pad2_(d.getDate())}`;
}

function currentMonthValue_() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2_(d.getMonth() + 1)}`;
}

function currentYearValue_() {
  return String(new Date().getFullYear());
}

function syncSettlementSortButton() {
  const btn = document.getElementById('sort-toggle');
  if (!btn) return;
  btn.dataset.order = settlementSortOrder;
  btn.innerHTML = settlementSortOrder === 'desc'
    ? '<i class="fas fa-sort-amount-down"></i> 최신순'
    : '<i class="fas fa-sort-amount-up"></i> 오래된순';
}

// ============================================================
// 모드별 날짜 입력 UI 갱신
// ============================================================
/**
 * 현재 선택된 기간 모드(currentMode)에 따라
 * 날짜 입력 영역(#date-picker-wrap) 안의 UI를 다시 렌더링
 * @returns {void}
 */
function updateDatePicker() {
  const wrap = document.getElementById('date-picker-wrap');

  /** @type {Record<PeriodMode, string>} */
  const labelMap = {
    daily: '날짜',
    weekly: '주 시작일(월요일)',
    monthly: '연월',
    quarterly: '연도+분기',
    yearly: '연도',
    custom: '기간'
  };

  let html = '';
  if (currentMode === 'daily') {
    html = `<input type="date" id="date-input" value="${todayValue_()}"/>`;
  } else if (currentMode === 'weekly') {
    html = `<input type="date" id="date-input" value="${todayValue_()}"/>`;
  } else if (currentMode === 'monthly') {
    html = `<input type="month" id="date-input" value="${currentMonthValue_()}"/>`;
  } else if (currentMode === 'quarterly') {
    const now = new Date();
    const year = now.getFullYear();
    const quarter = Math.floor(now.getMonth() / 3) + 1;
    html = `<select id="date-year" style="width:90px"><option>${year}</option><option>${year - 1}</option></select>
            <select id="date-quarter" style="width:80px"><option value="1"${quarter===1?' selected':''}>1분기</option><option value="2"${quarter===2?' selected':''}>2분기</option><option value="3"${quarter===3?' selected':''}>3분기</option><option value="4"${quarter===4?' selected':''}>4분기</option></select>`;
  } else if (currentMode === 'yearly') {
    html = `<input type="number" id="date-input" value="${currentYearValue_()}" min="2020" max="2099" style="width:100px"/>`;
  } else if (currentMode === 'custom') {
    const month = currentMonthValue_();
    html = `<input type="date" id="date-start" value="${month}-01"/>
            <span style="color:var(--text-3)">~</span>
            <input type="date" id="date-end" value="${todayValue_()}"/>`;
  }

  wrap.innerHTML = `
    <div class="filter-label">${labelMap[currentMode]}</div>
    <div style="display:flex;gap:6px;align-items:center">${html}</div>
  `;
}

// ============================================================
// 사용자 입력에서 현재 모드 값 추출
// ============================================================
/**
 * 현재 활성 모드에 맞는 사용자 입력값을 DOM에서 추출
 * @returns {string | {year:number, quarter:number} | DateRange}
 *   - daily/weekly: 'YYYY-MM-DD'
 *   - monthly: 'YYYY-MM'
 *   - quarterly: {year, quarter}
 *   - yearly: 'YYYY'
 *   - custom: {startDate, endDate}
 */
function getCurrentValue() {
  if (currentMode === 'quarterly') {
    return {
      year: parseInt(document.getElementById('date-year').value),
      quarter: parseInt(document.getElementById('date-quarter').value)
    };
  }
  if (currentMode === 'custom') {
    return {
      startDate: document.getElementById('date-start').value,
      endDate: document.getElementById('date-end').value
    };
  }
  return document.getElementById('date-input').value;
}

// ============================================================
// 메인 로드 함수: 필터 → 데이터 가져오기 → 렌더
// ============================================================
/**
 * 사용자가 [조회] 버튼·탭 클릭·Enter 시 호출
 * 필터를 읽어 fetch → 요약/표/추이 모두 렌더
 * @returns {Promise<void>}
 */
async function loadData() {
  currentValue = getCurrentValue();
  const range = getDateRange(currentMode, currentValue);

  // 검증
  const dateErr = validateDateRange(range);
  if (dateErr) { alert(dateErr); return; }

  /** @type {SettlementFilter} */
  const filter = {
    range,
    ordererSearch: (document.getElementById('filter-orderer').value || '').trim(),
    warehouse: /** @type {Warehouse|''} */ (document.getElementById('filter-warehouse').value)
  };

  const orders = await fetchCompletedOrders(filter);
  const summary = calcSummary(orders);
  const grouped = groupByCustomer(orders);

  renderSummary(summary);
  renderCustomerTable(grouped, summary);
  renderTrend(orders);
  syncSettlementSortButton();
}

// ============================================================
// 요약 카드 4개 렌더
// ============================================================
/** @param {SettlementSummary} summary */
function renderSummary(summary) {
  document.getElementById('sum-count').textContent = summary.count + '건';
  document.getElementById('sum-supply').textContent = fmtMoney(summary.totalSupply);
  document.getElementById('sum-vat').textContent = fmtMoney(summary.totalVat);
  document.getElementById('sum-total').textContent = fmtMoney(summary.totalAmount);
}

// ============================================================
// 납품처별 정산 표 렌더
// ============================================================
/**
 * @param {Object<string, CustomerStats>} grouped
 * @param {SettlementSummary} totalSummary
 */
function renderCustomerTable(grouped, totalSummary) {
  const tbody = document.getElementById('tbody-ordererwise');
  tbody.innerHTML = '';

  const sortedNames = Object.keys(grouped).sort((a, b) => grouped[b].totalAmount - grouped[a].totalAmount);

  sortedNames.forEach((name, idx) => {
    const g = grouped[name];
    const rowId = `detail-${idx}`;
    tbody.insertAdjacentHTML('beforeend', `
      <tr class="row-main" data-target="${rowId}">
        <td><strong>${escapeHtml(name)}</strong></td>
        <td class="num">${g.orders.length}건</td>
        <td class="num">${fmtMoney(g.totalSupply)}</td>
        <td class="num">${fmtMoney(g.totalVat)}</td>
        <td class="num"><strong>${fmtMoney(g.totalAmount)}</strong></td>
        <td class="center"><i class="fas fa-chevron-down" style="color:var(--text-3)"></i></td>
      </tr>
      <tr class="row-detail hidden" id="${rowId}">
        <td colspan="6" style="padding:0">${renderCustomerDetailTable(g.orders)}</td>
      </tr>
    `);
  });

  // 전체 합계 행
  tbody.insertAdjacentHTML('beforeend', `
    <tr class="row-total">
      <td><strong>전체 합계</strong></td>
      <td class="num"><strong>${totalSummary.count}건</strong></td>
      <td class="num"><strong>${fmtMoney(totalSummary.totalSupply)}</strong></td>
      <td class="num"><strong>${fmtMoney(totalSummary.totalVat)}</strong></td>
      <td class="num"><strong>${fmtMoney(totalSummary.totalAmount)}</strong></td>
      <td class="center">—</td>
    </tr>
  `);

  // 행 토글 이벤트
  document.querySelectorAll('.row-main').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const target = document.getElementById(row.dataset.target);
      target.classList.toggle('hidden');
      const icon = row.querySelector('.fa-chevron-down, .fa-chevron-up');
      if (icon) {
        icon.classList.toggle('fa-chevron-down');
        icon.classList.toggle('fa-chevron-up');
      }
    });
  });
}

// ============================================================
// 발주서 펼침 표 렌더
// ============================================================
/**
 * 납품처별 펼침 영역의 발주서 상세 표 HTML 생성
 * @param {Order[]} orders - 해당 납품처의 발주서들
 * @returns {string} HTML 문자열
 */
function renderCustomerDetailTable(orders) {
  const canEditSettlement = (typeof isAdmin === 'function') && isAdmin();
  const PAGE_SIZE = 10;
  const sorted = [...orders].sort((a,b)=>{
    const da=getSettlementDate(a);
    const db=getSettlementDate(b);
    const cmp = settlementSortOrder === 'asc' ? da.localeCompare(db) : db.localeCompare(da);
    if (cmp !== 0) return cmp;
    // 같은 정산일이면 발주번호로 tiebreaker (정렬 방향 따름)
    const na = String(a.orderNum || '');
    const nb = String(b.orderNum || '');
    return settlementSortOrder === 'asc' ? na.localeCompare(nb) : nb.localeCompare(na);
  });
  const rowsHTML = sorted.map((o, i) => {
    const row = renderOrderRow(o);
    // 11번째부터는 hidden-row 클래스 추가 (모바일에서만 숨김)
    return i >= PAGE_SIZE ? row.replace('<tr ', '<tr class="hidden-row" ') : row;
  }).join('');
  const hasMore = sorted.length > PAGE_SIZE;
  const remaining = sorted.length - PAGE_SIZE;
  return `
    <div class="detail-table-wrap" style="padding:12px 16px;background:#fafafa">
      <table class="detail-table" data-total="${sorted.length}" data-visible="${PAGE_SIZE}" data-page-size="${PAGE_SIZE}" style="background:#fff;border:1px solid var(--border);border-radius:6px">
        <thead>
          <tr>
            <th>발주번호</th>
            <th class="col-addr">시공 주소</th>
            <th class="center col-warehouse">창고</th>
            <th class="center col-date">출고일</th>
            <th class="num col-supply">공급가액</th>
            <th class="num">합계</th>
            <th class="center">거래명세서</th>
            ${canEditSettlement?'<th class="center col-edit">수정</th>':''}
            <th class="center">상세</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHTML}
        </tbody>
      </table>
      ${hasMore ? `<button class="detail-load-more" data-action="load-more">+ 더보기 (${remaining}건 남음)</button>` : ''}
    </div>
  `;
}

/**
 * 발주서 1건의 표 행 HTML 생성
 * @param {Order} o
 * @returns {string} `<tr>...</tr>` HTML
 */
function renderOrderRow(o) {
  const whClass = o.warehouse === '시흥' ? 'badge-wh-siheung' : 'badge-wh-pyeongtaek';
  const canEditSettlement = (typeof isAdmin === 'function') && isAdmin();
  // [2026-08-31] 정책 변경: 출고확정만으로 발주자한테 명세서 버튼 노출 (sentToCustomer 무관)
  //   정산 목록에 뜬 order = 이미 status 필터 통과 = 명세서 열람 가능해야 함
  // [2026-09-01] legacy fallback 추가 — _canViewSettlementOrder(query.js:98)와 동일 로직.
  //   createdBy 없는 옛날 발주도 소유자 본인이 [거래명세서] 버튼 사용 가능해야 함.
  const canOpenInvoice = canEditSettlement || (()=>{
    if (!currentUser) return false;
    if (o.createdBy) return o.createdBy === currentUser.id;
    const deliveryName = String(currentUser.deliveryName || currentUser.name || '').trim();
    const orderDelivery = String(o.deliveryTo || o.siteName || '').trim();
    return !!deliveryName && orderDelivery === deliveryName;
  })();
  // [2026-08-31] 정책 변경: 출고확정만으로 발주자 노출 → 별도 [전송] 버튼 무의미 → 제거
  const sendButton = '';
  const invoiceButton = canOpenInvoice
    ? `<button class="btn-invoice" data-action="open-invoice" data-order-id="${o.id}"><i class="fas fa-file-invoice"></i> 거래명세서</button>`
    : '<span style="font-size:11px;color:var(--text-3)">-</span>';
  return `
    <tr id="order-row-${o.id}">
      <td><code style="background:#eff6ff;color:#1e40af;padding:2px 6px;border-radius:4px;font-weight:700">${escapeHtml(o.orderNum)}</code></td>
      <td class="col-addr" style="font-size:12px;color:var(--text-2)">${escapeHtml(o.address)}</td>
      <td class="center col-warehouse"><span class="badge ${whClass}">${escapeHtml(o.warehouse)}</span></td>
      <td class="center col-date" style="font-size:12px">${(()=>{
        // [2026-08-27] 정산 기준 = 출고 확정 시점(관리자 클릭). getSettlementDate로 통일 (필터·정렬과 동일)
        // [2026-09-03 셀프체크 fix] getSettlementDate 가 pre-cutoff 옛 발주에 orderDate 반환하도록 바뀌면서
        //   출고 셀 UI에 orderDate 표시되는 이상 발생. display 전용 로직 인라인 (orders.js:1155 동일 패턴).
        let _confirmed = '';
        const _sh = Array.isArray(o.statusHistory) ? o.statusHistory : [];
        for (let _i = 0; _i < _sh.length; _i++) {
          const _e = _sh[_i];
          if (!_e || _e.status !== '발주확정') continue;
          const _kst = (typeof _toKstDateStr === 'function') ? _toKstDateStr(_e.changedAt) : null;
          if (_kst) { _confirmed = (typeof coerceDateForFilter === 'function') ? coerceDateForFilter(_kst) : _kst; break; }
        }
        if (!_confirmed) {
          // [Codex P2] 미정규 shipDate ("26-6-15" 등) 방어: coerceDateForFilter 로 정규화
          const _rawShip = (typeof coerceDateForFilter === 'function') ? coerceDateForFilter(o.shipDate || '') : (o.shipDate || '');
          if (_rawShip && _rawShip !== '0000-00-00') _confirmed = _rawShip;
        }
        const _shipTop = _confirmed
          ? `<i class="fas fa-truck" style="margin-right:2px"></i>${fmtShortDate(_confirmed)}`
          : `<span style="color:#b45309"><i class="fas fa-truck" style="margin-right:2px"></i>출고 미정</span>`;
        return `${_shipTop}<div style="font-size:10px;margin-top:2px">발주: ${fmtShortDate(o.orderDate)}</div>`;
      })()}</td>
      <td class="num col-supply">${fmtMoney(o.totalSupply)}</td>
      <td class="num"><strong>${fmtMoney(o.totalAmount)}</strong></td>
      <td class="center" style="white-space:nowrap">${invoiceButton} ${sendButton}</td>
      ${canEditSettlement?`<td class="center col-edit"><button class="btn-edit" data-action="inline-edit" data-order-id="${o.id}"><i class="fas fa-edit"></i> 수정</button></td>`:''}
      <td class="center"><button class="btn-link" data-action="goto-order" data-order-num="${escapeHtml(o.orderNum)}"><i class="fas fa-external-link-alt"></i> 이동</button></td>
    </tr>
  `;
}

// H4 보강 (Codex): 이벤트 위임 — inline onclick 제거 대체
// 한 번만 등록 (중복 방지)
if (typeof document !== 'undefined' && !document._settlementBtnDelegated) {
  document._settlementBtnDelegated = true;
  document.addEventListener('click', function(e) {
    const btn = e.target && e.target.closest && e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'open-invoice' && typeof openInvoiceFromSettlement === 'function') {
      openInvoiceFromSettlement(Number(btn.dataset.orderId));
    } else if (action === 'inline-edit' && typeof startInlineEdit === 'function') {
      startInlineEdit(Number(btn.dataset.orderId));
    } else if (action === 'goto-order' && typeof goToOrder === 'function') {
      goToOrder(btn.dataset.orderNum);
    } else if (action === 'load-more') {
      // 페이지네이션 — 다음 N건 .hidden-row 제거 (search-hidden 행은 제외)
      const table = btn.closest('.detail-table-wrap')?.querySelector('.detail-table');
      if (!table) return;
      const pageSize = Number(table.dataset.pageSize || 10);
      const visible = Number(table.dataset.visible || 10);
      const total = Number(table.dataset.total || 0);
      const hiddenRows = table.querySelectorAll('tr.hidden-row:not(.search-hidden)');
      // 다음 pageSize 만큼 보이게
      for (let i = 0; i < pageSize && i < hiddenRows.length; i++) {
        hiddenRows[i].classList.remove('hidden-row');
      }
      const newVisible = Math.min(visible + pageSize, total);
      table.dataset.visible = newVisible;
      const remaining = total - newVisible;
      if (remaining > 0) {
        btn.textContent = `+ 더보기 (${remaining}건 남음)`;
      } else {
        btn.remove();
      }
    } else if (action === 'save-inline' && typeof saveInlineEdit === 'function') {
      // H4 보강 (Codex): inline onclick 제거 — 이벤트 위임으로 대체
      saveInlineEdit(Number(btn.dataset.orderId));
    } else if (action === 'cancel-inline' && typeof loadData === 'function') {
      loadData();
    }
  });
}

// ─── 정렬 토글 (최신순 ↔ 오래된순) ───
if (typeof document !== 'undefined' && !document._sortToggleDelegated) {
  document._sortToggleDelegated = true;
  document.addEventListener('click', function(e) {
    const btn = e.target && e.target.closest && e.target.closest('#sort-toggle');
    if (!btn) return;
    const order = btn.dataset.order === 'desc' ? 'asc' : 'desc';
    settlementSortOrder = order;
    btn.dataset.order = order;
    btn.innerHTML = order === 'desc'
      ? '<i class="fas fa-sort-amount-down"></i> 최신순'
      : '<i class="fas fa-sort-amount-up"></i> 오래된순';
    // 펼침된 detail-table만 행 순서 뒤집기 + 페이지네이션 리셋
    // M2 보강: 닫힌 카드(.hidden)는 제외하여 추후 펼칠 때 순서 정합 유지
    // B2 보강: 검색 활성 상태에선 search-hidden 유지 (정렬은 검색과 직교)
    const searchInput = document.getElementById('quick-search');
    const isSearching = !!(searchInput && searchInput.value && searchInput.value.trim());
    document.querySelectorAll('.detail-table').forEach(table => {
      const detailContainer = table.closest('.detail-row, [id^="detail-"]');
      // 닫힌 상세표도 같이 정렬해야 나중에 펼쳤을 때 버튼 상태와 순서가 어긋나지 않는다.
      const tbody = table.querySelector('tbody');
      if (!tbody) return;
      const rows = Array.from(tbody.children);
      rows.reverse().forEach(r => tbody.appendChild(r));
      const pageSize = Number(table.dataset.pageSize || 10);
      const allRows = Array.from(tbody.children);
      allRows.forEach((r, i) => {
        r.classList.remove('hidden-row');
        if (!isSearching) r.classList.remove('search-hidden');
        if (i >= pageSize) r.classList.add('hidden-row');
      });
      table.dataset.visible = String(Math.min(pageSize, allRows.length));
      // 더보기 버튼 복원
      const wrap = table.closest('.detail-table-wrap');
      let moreBtn = wrap && wrap.querySelector('.detail-load-more');
      const remaining = allRows.length - pageSize;
      if (remaining > 0) {
        if (!moreBtn) {
          moreBtn = document.createElement('button');
          moreBtn.className = 'detail-load-more';
          moreBtn.dataset.action = 'load-more';
          wrap.appendChild(moreBtn);
        }
        moreBtn.textContent = `+ 더보기 (${remaining}건 남음)`;
      } else if (moreBtn) {
        moreBtn.remove();
      }
    });
  });
}

// ─── 빠른 검색 (발주번호/거래처/주소) — 실시간 필터 ───
if (typeof document !== 'undefined' && !document._quickSearchDelegated) {
  document._quickSearchDelegated = true;
  let _searchTimer = null;
  document.addEventListener('input', function(e) {
    if (!e.target || e.target.id !== 'quick-search') return;
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => _applyQuickSearch(e.target.value), 150);
  });
}

function _applyQuickSearch(query) {
  const q = String(query || '').trim().toLowerCase();
  const tbody = document.getElementById('tbody-ordererwise');
  if (!tbody) return;
  const mainRows = tbody.querySelectorAll('tr.row-main');
  if (!q) {
    // 검색어 없음 → 모든 거래처 표시, 모든 펼침 닫음, hidden-row + search-hidden 복원
    mainRows.forEach(r => {
      r.style.display = '';
      const detail = document.getElementById(r.dataset.target);
      if (detail) detail.classList.add('hidden');
    });
    tbody.querySelectorAll('.detail-table tr.search-hidden').forEach(t => t.classList.remove('search-hidden'));
    // H2 보강: 페이지네이션 hidden-row 재할당 (검색 중 제거된 것 복원)
    tbody.querySelectorAll('.detail-table').forEach(table => {
      const tb = table.querySelector('tbody');
      if (!tb) return;
      const pageSize = Number(table.dataset.pageSize || 10);
      const allRows = Array.from(tb.children);
      allRows.forEach((r, i) => {
        if (i >= pageSize) r.classList.add('hidden-row');
      });
      table.dataset.visible = String(Math.min(pageSize, allRows.length));
      // B3 보강: 검색 비우면 더보기 버튼 복원
      const wrap = table.closest('.detail-table-wrap');
      const moreBtn = wrap && wrap.querySelector('.detail-load-more');
      if (moreBtn) {
        const stillHidden = table.querySelectorAll('tr.hidden-row').length;
        moreBtn.style.display = stillHidden > 0 ? '' : 'none';
        if (stillHidden > 0) moreBtn.textContent = `+ 더보기 (${stillHidden}건 남음)`;
      }
    });
    return;
  }
  mainRows.forEach(r => {
    const detail = document.getElementById(r.dataset.target);
    const mainMatch = r.textContent.toLowerCase().includes(q);
    let detailMatchCount = 0;
    if (detail) {
      const orderRows = detail.querySelectorAll('.detail-table tbody tr');
      orderRows.forEach(or => {
        const match = or.textContent.toLowerCase().includes(q);
        if (match) {
          or.classList.remove('search-hidden');
          or.classList.remove('hidden-row');  // 페이지네이션 무시
          detailMatchCount++;
        } else {
          or.classList.add('search-hidden');
        }
      });
    }
    // 거래처 자체 매칭 OR 안에 매칭 발주서 있으면 표시
    if (mainMatch || detailMatchCount > 0) {
      r.style.display = '';
      if (detail) {
        // 매칭 있으면 자동 펼침
        if (detailMatchCount > 0) detail.classList.remove('hidden');
      }
    } else {
      r.style.display = 'none';
      if (detail) detail.classList.add('hidden');
    }
  });
  // B3 보강: 검색 활성 시 더보기 버튼은 표시될 잠재 행 기준으로 표시/숨김
  document.querySelectorAll('.detail-table-wrap').forEach(wrap => {
    const table = wrap.querySelector('.detail-table');
    const moreBtn = wrap.querySelector('.detail-load-more');
    if (!table || !moreBtn) return;
    const stillHidden = table.querySelectorAll('tr.hidden-row:not(.search-hidden)').length;
    moreBtn.style.display = stillHidden > 0 ? '' : 'none';
    if (stillHidden > 0) moreBtn.textContent = `+ 더보기 (${stillHidden}건 남음)`;
  });
}

// ============================================================
// 인라인 수정
// ============================================================
/**
 * 발주서 행을 수정 입력 폼으로 교체
 * @param {number} orderId - 수정 대상 발주서 ID
 * @returns {void}
 */
function startInlineEdit(orderId) {
  if (typeof isAdmin !== 'function' || !isAdmin()) {
    if (typeof toast === 'function') toast('관리자만 수정할 수 있습니다.', 'error');
    return;
  }
  // 정산 화면의 직접 patch는 재고·수정로그·명세서 갱신을 우회하므로 사용하지 않는다.
  // 발주 상세의 기존 편집 흐름으로 유도해 모든 저장 후처리를 한 곳에서 수행한다.
  if (typeof toast === 'function') toast('발주 상세에서 수정해주세요. 수정 로그와 명세서가 함께 갱신됩니다.', 'info');
  if (typeof openOrderDetail === 'function') openOrderDetail(orderId);
  return;
  // L2 보강 (Codex): 실제 DB 우선 조회 (mock fallback은 보조)
  let order = null;
  if (typeof DB !== 'undefined' && typeof DB.get === 'function') {
    order = DB.get('orders', []).find(o => o && o.id === orderId);
  }
  if (!order && typeof MOCK_ORDERS !== 'undefined') {
    order = MOCK_ORDERS.find(o => o.id === orderId);
  }
  if (!order) return;
  const row = document.getElementById('order-row-' + orderId);
  if (!row) return;

  row.innerHTML = `
    <td colspan="8">
      <div class="inline-edit">
        <div class="inline-edit-row">
          <label>발주번호<input type="text" value="${escapeHtml(order.orderNum)}" disabled style="background:#f3f4f6"/></label>
          <label>공급가액<input type="number" id="edit-supply-${orderId}" value="${order.totalSupply}"/></label>
          <label>부가세<input type="number" id="edit-vat-${orderId}" value="${order.totalVat}"/></label>
          <label>합계<input type="number" id="edit-total-${orderId}" value="${order.totalAmount}"/></label>
          <label>발주일<input type="date" id="edit-date-${orderId}" value="${order.orderDate}"/></label>
          <label>창고
            <select id="edit-wh-${orderId}">
              <option value="시흥" ${order.warehouse === '시흥' ? 'selected' : ''}>시흥</option>
              <option value="평택" ${order.warehouse === '평택' ? 'selected' : ''}>평택</option>
            </select>
          </label>
          <label style="flex:1;min-width:200px">시공 주소<input type="text" id="edit-addr-${orderId}" value="${escapeHtml(order.address)}" style="width:100%"/></label>
        </div>
        <div class="inline-edit-actions">
          <button class="btn-save" data-action="save-inline" data-order-id="${orderId}"><i class="fas fa-check"></i> 저장</button>
          <button class="btn-cancel" data-action="cancel-inline"><i class="fas fa-times"></i> 취소</button>
        </div>
      </div>
    </td>
  `;
}

/**
 * 인라인 수정 폼의 값을 검증 후 저장
 * @param {number} orderId
 * @returns {Promise<void>}
 */
async function saveInlineEdit(orderId) {
  if (typeof isAdmin !== 'function' || !isAdmin()) {
    if (typeof toast === 'function') toast('관리자만 수정할 수 있습니다.', 'error');
    return;
  }
  /** @type {Partial<Order>} */
  const patch = {
    totalSupply: parseInt(document.getElementById('edit-supply-' + orderId).value) || 0,
    totalVat: parseInt(document.getElementById('edit-vat-' + orderId).value) || 0,
    totalAmount: parseInt(document.getElementById('edit-total-' + orderId).value) || 0,
    orderDate: document.getElementById('edit-date-' + orderId).value,
    warehouse: /** @type {Warehouse} */ (document.getElementById('edit-wh-' + orderId).value),
    address: document.getElementById('edit-addr-' + orderId).value
  };

  const err = validateOrderEdit(patch);
  if (err) { alert(err); return; }

  try {
    await updateOrder(orderId, patch);
    alert('저장됨 (미리보기). 실제 배포 시 Firestore에 저장됩니다.');
    loadData();
  } catch (e) {
    alert('저장 실패: ' + e.message);
  }
}

/**
 * 발주서 상세로 이동 (현재 미리보기, 실제는 발주앱 상세 모달 호출)
 * @param {string} orderNum
 * @returns {void}
 */
function goToOrder(orderNum) {
  alert(`발주번호 ${orderNum} 상세로 이동 (실제 배포 시 발주서 상세 모달 열림)`);
}

// ============================================================
// 추이 표 렌더 (월별/분기별/연간만)
// ============================================================
/** @param {Order[]} orders */
function renderTrend(orders) {
  const card = document.getElementById('trend-card');
  if (currentMode === 'daily' || currentMode === 'weekly' || currentMode === 'custom') {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';

  const title = document.getElementById('trend-title');
  const tbody = document.getElementById('tbody-trend');
  tbody.innerHTML = '';

  if (currentMode === 'monthly') {
    title.textContent = '일별 추이 (출고일 기준)';
    aggregateByDay(orders).forEach(row => {
      tbody.insertAdjacentHTML('beforeend',
        `<tr><td>${row.date}</td><td class="num">${row.count}건</td><td class="num">${fmtMoney(row.total)}</td></tr>`);
    });
  } else {
    title.textContent = '월별 추이 (출고일 기준)';
    aggregateByMonth(orders).forEach(row => {
      tbody.insertAdjacentHTML('beforeend',
        `<tr><td>${row.month}</td><td class="num">${row.count}건</td><td class="num">${fmtMoney(row.total)}</td></tr>`);
    });
  }
}

// ============================================================
// 엑셀 내보내기 (export.js 위임)
// ============================================================
/**
 * [엑셀 다운로드] 버튼 핸들러
 * 현재 필터에 맞는 데이터를 다시 fetch한 후 export.js에 위임
 * @returns {Promise<void>}
 */
/**
 * 정산 표에서 거래명세서 버튼 클릭 핸들러
 * Phase D3: 실 발주서 → LumaneInvoice.openFromOrder() 호출
 * inflight 가드 + 발주서 검증
 * @param {number} orderId
 */
async function openInvoiceFromSettlement(orderId) {
  const allOrders = (typeof DB !== 'undefined' && typeof DB.get === 'function')
    ? DB.get('orders', [])
    : [];
  const order = allOrders.find(o => o && o.id === orderId);
  if (!order) {
    if (typeof toast === 'function') toast('발주서를 찾을 수 없습니다.', 'error');
    else alert('발주서를 찾을 수 없습니다.');
    return;
  }
  // [2026-08-31] 정책 변경: 출고확정만으로 발주자한테 명세서 노출 (sentToCustomer 게이트 제거)
  //   본인 발주 검증은 openFromOrder 내부에서 createdBy 체크
  if (!window.LumaneInvoice || typeof window.LumaneInvoice.openFromOrder !== 'function') {
    if (typeof toast === 'function') toast('거래명세서 모듈 로드 실패. 새로고침 후 다시 시도하세요.', 'error');
    else alert('거래명세서 모듈 로드 실패. 새로고침 후 다시 시도하세요.');
    return;
  }
  await window.LumaneInvoice.openFromOrder(order);
}

// [2026-09-01] toggleInvoiceSendFromSettlement 제거 —
//   전송 버튼 자체가 render에서 사라지고 (sendButton=''), 이벤트 위임의
//   'toggle-send' 분기도 삭제됨. 이제 도달 불가능한 함수라 삭제.

async function exportExcel() {
  if (typeof isAdmin !== 'function' || !isAdmin()) {
    if (typeof toast === 'function') toast('관리자만 엑셀을 다운로드할 수 있습니다.', 'error');
    return;
  }
  const range = getDateRange(currentMode, currentValue);
  const filter = {
    range,
    ordererSearch: (document.getElementById('filter-orderer').value || '').trim(),
    warehouse: document.getElementById('filter-warehouse').value
  };
  const orders = await fetchCompletedOrders(filter);
  if (typeof exportSettlementExcel === 'function') {
    exportSettlementExcel(orders, currentMode, currentValue);
  } else {
    alert('엑셀 모듈을 불러올 수 없습니다');
  }
}

// ============================================================
// 초기화 + 이벤트 바인딩
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  // 발주앱 메인 통합 환경 가드: 정산 화면 진입 전엔 자동 실행 안 함 (renderSettlement이 직접 호출)
  if (!document.getElementById('date-picker-wrap')) return;
  // 탭 클릭
  document.querySelectorAll('.period-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.period-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = /** @type {PeriodMode} */ (btn.dataset.mode);
      updateDatePicker();
      loadData();
    });
  });

  // 납품처 검색: Enter 키만 (한글 IME 안전)
  document.getElementById('filter-orderer').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); loadData(); }
  });

  updateDatePicker();
  loadData();
});
