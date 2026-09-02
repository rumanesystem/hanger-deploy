// ── 재고 관리 / 발주 필요 목록 / 재고 로그 ──
// 의존: js/store/db.js, js/utils/uiUtils.js, js/price.js

// 품목별 재고 색상 목록. 개별 옵션 색상 → 품목코드 색상 → 공통 가구 색상 순으로 사용한다.
// noColor 품목은 창고 합계 재고만 관리한다.
function inventoryColorsForItem(item){
  if(!item||item.noColor)return[];
  let colors;
  if(Array.isArray(item.colorOptions)&&item.colorOptions.length>0)colors=item.colorOptions;
  else{
    const mapped=Object.keys(item.colorProdCdMap||{}).filter(color=>color&&item.colorProdCdMap[color]&&item.colorProdCdMap[color]!=='N/A');
    colors=mapped.length>0?mapped:SHELF_COLORS;
  }
  ['colorStockSiheung','colorStockPyeongtaek','colorStockOsan'].forEach(key=>{
    Object.keys(item[key]||{}).forEach(color=>{
      if(color&&!colors.includes(color))colors.push(color);
    });
  });
  const seen=new Set();
  const normalized=[];
  colors.forEach(color=>{
    const c=typeof normalizeStockColor==='function'?normalizeStockColor(color):color;
    if(!seen.has(c)){seen.add(c);normalized.push(c);}
  });
  const order=Array.isArray(SHELF_COLORS)?SHELF_COLORS:[];
  normalized.sort((a,b)=>{
    const ai=order.indexOf(a),bi=order.indexOf(b);
    if(ai!==-1||bi!==-1)return(ai===-1?99:ai)-(bi===-1?99:bi);
    return a.localeCompare(b,'ko');
  });
  return normalized;
}
function inventoryColorStock(map,color){
  return typeof getColorStock==='function'?getColorStock(map,color):((map||{})[color]||0);
}

// 발주 필요 목록
let prFilterStatus='',prFilterItem='',prFilterOrderNum='',prFilterDateFrom='',prFilterDateTo='',prSortBy='';
function renderPurchaseRequests(){
  // 모바일 카드형 CSS 1회 등록
  if (!document.getElementById('_pr-mobile-css')) {
    const s = document.createElement('style');
    s.id = '_pr-mobile-css';
    s.textContent = `
      @media (max-width: 640px) {
        /* 필터 영역: grid 2컬럼으로 컴팩트 */
        .pr-filter-bar {
          display: grid !important;
          grid-template-columns: 1fr 1fr;
          gap: 6px !important;
          padding: 10px;
          background:#fff;
          border:1px solid var(--border);
          border-radius: 10px;
          margin-bottom: 12px;
        }
        .pr-filter-bar > * { max-width: none !important; width: 100% !important; }
        .pr-filter-bar > input, .pr-filter-bar > select { padding: 8px 10px; font-size: 12px; }
        .pr-filter-bar > button { grid-column: 1; padding: 8px; font-size: 12px; }
        .pr-filter-bar > span { grid-column: 2; text-align: right; align-self: center; font-size: 11px; }

        .pr-table-wrap .table-wrap { overflow:visible !important; }
        .pr-table-wrap table { display:block !important; width:100% !important; }
        .pr-table-wrap thead { display:none !important; }
        .pr-table-wrap tbody { display:block !important; }
        .pr-table-wrap tr.pr-row {
          display:grid !important;
          grid-template-columns: 1fr auto;
          grid-template-rows: auto auto auto auto;
          column-gap: 8px; row-gap: 4px;
          padding: 12px 12px;
          margin-bottom: 8px;
          background:#fff;
          border:1px solid var(--border);
          border-radius: 10px;
          width:100%; max-width:100%; overflow:hidden;
        }
        .pr-table-wrap tr.pr-row td {
          display:block !important; padding:0 !important; border:none !important; background:transparent !important;
        }
        /* Row 1: 품목명(좌) + 상태(우) */
        .pr-table-wrap tr.pr-row td:nth-child(1) { grid-column:1; grid-row:1; font-size:14px; font-weight:800; }
        .pr-table-wrap tr.pr-row td:nth-child(8) { grid-column:2; grid-row:1; justify-self:end; }
        /* Row 2: 구분(좌) + 생성일(우) */
        .pr-table-wrap tr.pr-row td:nth-child(2) { grid-column:1; grid-row:2; font-size:11px; }
        .pr-table-wrap tr.pr-row td:nth-child(7) { grid-column:2; grid-row:2; justify-self:end; font-size:11px; color:var(--text-3); }
        /* Row 3: 현장 전체 너비 */
        .pr-table-wrap tr.pr-row td:nth-child(3) { grid-column:1/-1; grid-row:3; font-size:12px; }
        /* Row 4: 부족만 강조, 필요/재고 숨김 (모바일은 핵심만) */
        .pr-table-wrap tr.pr-row td:nth-child(4),
        .pr-table-wrap tr.pr-row td:nth-child(5) { display: none !important; }
        .pr-table-wrap tr.pr-row td:nth-child(6) {
          grid-column: 1; grid-row: 4;
          font-size: 13px; font-weight: 800; color: #dc2626;
        }
        .pr-table-wrap tr.pr-row td:nth-child(6)::before {
          content: "부족 "; color: var(--text-3); font-weight: 600; font-size: 11px;
        }
        .pr-table-wrap tr.pr-row td:nth-child(9) { grid-column: 2; grid-row: 4; justify-self: end; }
      }
    `;
    document.head.appendChild(s);
  }
  const allPRs=getPRs();
  let prs=allPRs.filter(p=>{
    if(prFilterStatus&&p.status!==prFilterStatus)return false;
    if(prFilterItem){const it=getItem(p.itemId);if(!it||!it.name.includes(prFilterItem))return false;}
    if(prFilterOrderNum){const ord=getOrders().find(o=>o.id===p.orderId);const num=ord?(ord.orderNum||('#'+ord.id)):'';if(!num.includes(prFilterOrderNum))return false;}
    if(prFilterDateFrom&&(p.createdAt||'').slice(0,10)<prFilterDateFrom)return false;
    if(prFilterDateTo&&(p.createdAt||'').slice(0,10)>prFilterDateTo)return false;
    return true;
  });
  if(prSortBy==='shortage')prs=prs.slice().sort((a,b)=>b.shortageQty-a.shortageQty);
  else prs=prs.slice().sort((a,b)=>b.id-a.id);
  const pending=allPRs.filter(p=>p.status==='대기').length;
  const done=allPRs.filter(p=>p.status==='발주완료').length;
  const hasFilter=!!(prFilterStatus||prFilterItem||prFilterOrderNum||prFilterDateFrom||prFilterDateTo);
  let tableHtml='';
  if(prs.length===0){
    tableHtml=`<div class="empty"><i class="fas fa-clipboard-check"></i><p>${hasFilter?'검색 결과가 없습니다.':'발주 필요 목록이 없습니다. 관리 품목 재고가 충분한 상태입니다.'}</p></div>`;
  }else{
    tableHtml=`<div class="table-wrap"><table><thead><tr><th>품목명</th><th class="td-center">구분</th><th>현장</th><th class="td-center">필요</th><th class="td-center">당시재고</th><th class="td-center">부족</th><th class="td-center">생성일</th><th class="td-center">상태</th><th class="td-center">처리</th></tr></thead><tbody>
    ${prs.map(pr=>{
      const it=getItem(pr.itemId);const ord=getOrders().find(o=>o.id===pr.orderId);
      return `<tr class="pr-row" id="pr-row-${pr.id}"${pr.status==='발주완료'?' style="opacity:.6"':''}>
        <td class="td-name">${it?it.name:'?'}</td>
        <td class="td-center">${it?drawerBadge(it):'-'}</td>
        <td><button class="btn btn-ghost btn-xs order-detail-btn" data-order-id="${pr.orderId}" style="padding:2px 0;font-weight:600">${ord?ord.siteName:'?'}</button><p class="td-muted" style="font-size:11px">${ord?ord.customerName:''}</p></td>
        <td class="td-center">${pr.requiredQty}</td>
        <td class="td-center td-muted">${pr.currentStockSnapshot}</td>
        <td class="td-center td-shortage">${pr.shortageQty}</td>
        <td class="td-center td-muted">${fmt(pr.createdAt)}</td>
        <td class="td-center"><span class="badge ${pr.status==='발주완료'?'badge-done':'badge-pending'}">${pr.status}</span></td>
        <td class="td-center" id="pr-action-${pr.id}">${pr.status==='대기'?`<button class="btn btn-outline btn-xs pr-complete-btn" data-pr-id="${pr.id}"><i class="fas fa-check"></i> 발주완료</button>`:''}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
  }
  document.getElementById('content').innerHTML=`
    <div class="section-title">발주 필요 목록</div>
    <div class="section-sub">서랍장 부족 수량이 발생한 품목 목록입니다.</div>
    <div class="grid-2" style="margin-bottom:16px">
      <div style="background:var(--warning-bg);border:1px solid #fde68a;border-radius:var(--r);padding:14px 18px"><p style="font-size:11px;font-weight:700;color:var(--warning)">대기</p><p style="font-size:26px;font-weight:800;color:var(--warning)">${pending}건</p></div>
      <div style="background:var(--success-bg);border:1px solid #bbf7d0;border-radius:var(--r);padding:14px 18px"><p style="font-size:11px;font-weight:700;color:var(--success)">발주완료</p><p style="font-size:26px;font-weight:800;color:var(--success)">${done}건</p></div>
    </div>
    ${pending>0?`<div style="background:var(--warning-bg);border:1px solid #fde68a;border-radius:var(--r);padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <p style="font-size:13px;color:var(--warning)">대기 중인 발주 요청 <strong>${pending}건</strong>을 일괄 처리합니다.</p>
      <div id="bulk-btn-wrap"><button class="btn btn-success btn-sm" id="bulk-complete-btn"><i class="fas fa-check-double"></i> 전체 발주완료 처리</button></div>
    </div>`:''}
    <div class="filter-bar pr-filter-bar" style="flex-wrap:wrap;row-gap:8px">
      <input class="form-input" placeholder="품목명 검색" id="pr-item-search" value="${prFilterItem}" style="max-width:160px"/>
      <input class="form-input" placeholder="발주번호" id="pr-order-num" value="${prFilterOrderNum}" style="max-width:120px"/>
      <select class="form-input" id="pr-status-filter" style="max-width:130px">
        <option value="">전체 상태</option>
        <option value="대기"${prFilterStatus==='대기'?' selected':''}>대기</option>
        <option value="발주완료"${prFilterStatus==='발주완료'?' selected':''}>발주완료</option>
      </select>
      <input type="date" class="form-input" id="pr-from" value="${prFilterDateFrom}" style="max-width:140px"/>
      <input type="date" class="form-input" id="pr-to" value="${prFilterDateTo}" style="max-width:140px"/>
      <select class="form-input" id="pr-sort" style="max-width:150px">
        <option value=""${prSortBy===''?' selected':''}>최신 순</option>
        <option value="shortage"${prSortBy==='shortage'?' selected':''}>부족 수량 순</option>
      </select>
      <button class="btn btn-outline btn-xs" onclick="prFilterStatus='';prFilterItem='';prFilterOrderNum='';prFilterDateFrom='';prFilterDateTo='';prSortBy='';renderPurchaseRequests()">초기화</button>
      <span style="font-size:12px;color:var(--text-3)">총 ${prs.length}건</span>
    </div>
    <div class="card pr-table-wrap">${tableHtml}</div>`;
  _imeSafeSearchInput(document.getElementById('pr-item-search'), v=>{prFilterItem=v;renderPurchaseRequests();}, {focusFlagKey:'_prItemSearchFocused'});
  _imeSafeSearchInput(document.getElementById('pr-order-num'), v=>{prFilterOrderNum=v;renderPurchaseRequests();}, {focusFlagKey:'_prOrderNumFocused'});
  document.getElementById('pr-status-filter').addEventListener('change',e=>{prFilterStatus=e.target.value;renderPurchaseRequests();});
  document.getElementById('pr-from').addEventListener('change',e=>{prFilterDateFrom=e.target.value;renderPurchaseRequests();});
  document.getElementById('pr-to').addEventListener('change',e=>{prFilterDateTo=e.target.value;renderPurchaseRequests();});
  document.getElementById('pr-sort').addEventListener('change',e=>{prSortBy=e.target.value;renderPurchaseRequests();});
  const bcb=document.getElementById('bulk-complete-btn');
  if(bcb)bcb.addEventListener('click',showBulkConfirm);
}

function showPRConfirm(prId){
  const cell=document.getElementById('pr-action-'+prId);
  cell.innerHTML='<div class="confirm-btns"><button class="btn btn-success btn-xs pr-confirm-yes" data-pr-id="'+prId+'">확인</button><button class="btn btn-ghost btn-xs pr-confirm-no">취소</button></div>';
  cell.querySelector('.pr-confirm-yes').addEventListener('click',()=>completePR(prId));
  cell.querySelector('.pr-confirm-no').addEventListener('click',renderPurchaseRequests);
}
function completePR(prId){
  const prs=getPRs();const idx=prs.findIndex(p=>p.id===prId);if(idx===-1)return;
  prs[idx].status='발주완료';prs[idx].updatedAt=new Date().toISOString();
  DB.set('purchase_requests',prs);toast('발주완료 처리되었습니다.','success');renderPurchaseRequests();
}
function showBulkConfirm(){
  const wrap=document.getElementById('bulk-btn-wrap');
  wrap.innerHTML='<div class="confirm-btns"><span style="font-size:12px;color:var(--warning)">전체 발주완료로 변경할까요?</span><button class="btn btn-success btn-sm" id="bulk-yes">확인</button><button class="btn btn-ghost btn-sm" id="bulk-no">취소</button></div>';
  document.getElementById('bulk-yes').addEventListener('click',bulkComplete);
  document.getElementById('bulk-no').addEventListener('click',renderPurchaseRequests);
}
function bulkComplete(){
  const prs=getPRs();let count=0;
  prs.forEach(p=>{if(p.status==='대기'){p.status='발주완료';p.updatedAt=new Date().toISOString();count++;}});
  DB.set('purchase_requests',prs);toast(`${count}건 일괄 발주완료 처리되었습니다.`,'success');renderPurchaseRequests();
}

// ── 발주자 전용 재고 현황 페이지 ──
// ── 발주자 전용: 재고 부족 페이지 ──
function renderShortageView(){
  const items=getItems().filter(i=>i.isActive&&isTrackStock(i));
  const logs=getLogs();
  const lastLog={};
  logs.forEach(l=>{if(!lastLog[l.itemId]||l.createdAt>lastLog[l.itemId])lastLog[l.itemId]=l.createdAt;});

  const shortageItems=items.filter(i=>i.currentStock===0);
  const lowItems=items.filter(i=>i.currentStock>0&&i.currentStock<=3);
  const normalItems=items.filter(i=>i.currentStock>3);

  function makeRow(item, level){
    const color=level==='zero'?'#dc2626':level==='low'?'#d97706':'#16a34a';
    const bg=level==='zero'?'#fef2f2':level==='low'?'#fffbeb':'';
    const label=level==='zero'?'재고 없음':level==='low'?'부족 주의':'충분';
    const labelCls=level==='zero'?'badge-red':level==='low'?'badge-pending':'badge-done';
    return `<tr style="background:${bg}">
      <td class="td-name">${item.name} ${drawerBadge(item)}</td>
      <td class="td-center"><span style="font-size:17px;font-weight:800;color:${color}">${item.currentStock}</span></td>
      <td class="td-center"><span class="badge ${labelCls}">${label}</span></td>
      <td class="td-center td-muted" style="font-size:12px">${lastLog[item.id]?fmtDt(lastLog[item.id]):'-'}</td>
    </tr>`;
  }

  const allRows=[
    ...shortageItems.map(i=>makeRow(i,'zero')),
    ...lowItems.map(i=>makeRow(i,'low')),
    ...normalItems.map(i=>makeRow(i,'normal')),
  ].join('');

  document.getElementById('content').innerHTML=`
    <div class="section-title">재고 부족 현황</div>
    <div class="section-sub">재고 관리 품목의 상태를 확인합니다. (재고 없음 → 부족 주의 → 충분 순)</div>
    <div style="display:flex;gap:10px;margin-bottom:18px;flex-wrap:wrap">
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:var(--r);padding:12px 20px;min-width:110px">
        <p style="font-size:11px;font-weight:700;color:#dc2626;margin-bottom:3px">재고 없음</p>
        <p style="font-size:26px;font-weight:800;color:#dc2626">${shortageItems.length}개</p>
      </div>
      <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:var(--r);padding:12px 20px;min-width:110px">
        <p style="font-size:11px;font-weight:700;color:#d97706;margin-bottom:3px">부족 주의 (1~3개)</p>
        <p style="font-size:26px;font-weight:800;color:#d97706">${lowItems.length}개</p>
      </div>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:var(--r);padding:12px 20px;min-width:110px">
        <p style="font-size:11px;font-weight:700;color:#16a34a;margin-bottom:3px">재고 충분</p>
        <p style="font-size:26px;font-weight:800;color:#16a34a">${normalItems.length}개</p>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><h3>품목별 재고 상태</h3></div>
      <div class="table-wrap"><table>
        <thead><tr><th>품목명</th><th class="td-center">현재고</th><th class="td-center">상태</th><th class="td-center">최근 변동일</th></tr></thead>
        <tbody>${allRows||'<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--text-3)">품목 없음</td></tr>'}</tbody>
      </table></div>
    </div>`;
}

let _stockViewSearch='';
function renderStockView(){
  // +손잡이 제외
  let items=getItems().filter(i=>i.isActive&&isTrackStock(i)&&i.drawerType!=='handle');
  const categoryOrder={'서랍장':0,'옵션':1,'상부자재':2,'옷봉':3,'선반':4,'코너선반':5};
  items.sort((a,b)=>(categoryOrder[a.category]??99)-(categoryOrder[b.category]??99));
  if(_stockViewSearch)items=items.filter(i=>i.name.includes(_stockViewSearch));
  const siheungTotal=items.reduce((s,i)=>s+(i.stockSiheung!==undefined?i.stockSiheung:i.currentStock),0);
  const pyeongtaekTotal=items.reduce((s,i)=>s+(i.stockPyeongtaek||0),0);
  // [2026-07-24] 오산 창고 재고 (발주 대상 아님, 관리 전용)
  const osanTotal=items.reduce((s,i)=>s+(i.stockOsan||0),0);

  // 품목별 색상 행 생성 (클릭 시 접기/펼치기)
  const rows=items.map(item=>{
    const sTotal=item.stockSiheung!==undefined?item.stockSiheung:item.currentStock;
    const pTotal=item.stockPyeongtaek||0;
    const oTotal=item.stockOsan||0;
    // [2026-07-24 Codex-High-3] 합계·경고 색상 기준은 발주 가능 재고(시흥+평택). 오산은 발주 대상 아님.
    const orderableTotal=sTotal+pTotal;
    const itemBg=orderableTotal===0?'background:#fef2f2':orderableTotal<=3?'background:#fffbeb':'';

    const colorRows=inventoryColorsForItem(item).map(color=>{
      const sC=inventoryColorStock(item.colorStockSiheung||{},color);
      const pC=inventoryColorStock(item.colorStockPyeongtaek||{},color);
      const oC=inventoryColorStock(item.colorStockOsan||{},color);
      // [2026-07-24 Codex-High-3] 색상 합계도 발주 가능 재고 기준 (시흥+평택). 오산 별도 컬럼 표시.
      const tot=sC+pC;
      const sColor=sC===0?'#9ca3af':sC<=2?'#d97706':'#1e40af';
      const pColor=pC===0?'#9ca3af':pC<=2?'#d97706':'#065f46';
      const oColor=oC===0?'#9ca3af':oC<=2?'#d97706':'#7c2d12';
      const tColor=tot===0?'#9ca3af':tot<=2?'#d97706':'#111827';
      return `<tr class="sv-color-row sv-cr-${item.id}" style="display:none;background:#fafafa">
        <td style="padding-left:22px;font-size:12px;color:#374151;border-bottom:1px solid #f1f5f9">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${tot===0?'#e5e7eb':tot<=2?'#fbbf24':'#60a5fa'};margin-right:6px;vertical-align:middle"></span>${color}
        </td>
        <td class="td-center" style="font-size:13px;font-weight:700;color:${sColor};border-bottom:1px solid #f1f5f9">${sC}</td>
        <td class="td-center" style="font-size:13px;font-weight:700;color:${pColor};border-bottom:1px solid #f1f5f9">${pC}</td>
        <td class="td-center" style="font-size:13px;font-weight:700;color:${oColor};border-bottom:1px solid #f1f5f9">${oC}</td>
        <td class="td-center" style="font-size:13px;font-weight:800;color:${tColor};border-bottom:1px solid #f1f5f9">${tot}</td>
      </tr>`;
    }).join('');

    return `<tr class="sv-item-row" data-sv-id="${item.id}" style="${itemBg}cursor:pointer" title="클릭해서 색상별 재고 보기">
      <td class="td-name" style="font-weight:800">
        <span class="sv-toggle-icon" data-sv-id="${item.id}" style="font-size:10px;color:#94a3b8;margin-right:6px">▶</span>${item.name}
      </td>
      <td class="td-center"><span style="font-size:15px;font-weight:800;color:${sTotal===0?'#dc2626':sTotal<=3?'#d97706':'#1e40af'}">${sTotal}</span></td>
      <td class="td-center"><span style="font-size:15px;font-weight:800;color:${pTotal===0?'#dc2626':pTotal<=3?'#d97706':'#065f46'}">${pTotal}</span></td>
      <td class="td-center"><span style="font-size:15px;font-weight:800;color:${oTotal===0?'#9ca3af':'#7c2d12'}" title="오산은 발주 대상 아님(재고 관리 전용)">${oTotal}</span></td>
      <td class="td-center"><span style="font-size:15px;font-weight:800;color:${orderableTotal===0?'#dc2626':orderableTotal<=3?'#d97706':'#111827'}">${orderableTotal}</span></td>
    </tr>${colorRows}`;
  }).join('');

  document.getElementById('content').innerHTML=`
    <div class="section-title">재고 현황</div>
    <div class="section-sub">서랍장·옵션 품목의 창고별 · 색상별 현재 재고입니다.</div>
    <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:var(--r);padding:12px 20px">
        <p style="font-size:11px;font-weight:700;color:#3b82f6;margin-bottom:2px">시흥 재고</p>
        <p style="font-size:28px;font-weight:800;color:#1e40af">${siheungTotal}개</p>
      </div>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:var(--r);padding:12px 20px">
        <p style="font-size:11px;font-weight:700;color:#16a34a;margin-bottom:2px">평택 재고</p>
        <p style="font-size:28px;font-weight:800;color:#065f46">${pyeongtaekTotal}개</p>
      </div>
      <!-- [2026-07-24] 오산 재고 카드 (발주 대상 아님, 재고 관리 전용) -->
      <div style="background:#fef7ed;border:1px solid #fed7aa;border-radius:var(--r);padding:12px 20px">
        <p style="font-size:11px;font-weight:700;color:#c2410c;margin-bottom:2px">오산 재고</p>
        <p style="font-size:28px;font-weight:800;color:#7c2d12">${osanTotal}개</p>
      </div>
    </div>
    <div class="card">
      <div class="card-header">
        <h3>관리 품목 재고 (창고별 · 색상별)</h3>
        <input class="form-input" id="sv-search-input" placeholder="품목명 검색" value="${_stockViewSearch}" style="max-width:150px;padding:5px 8px;font-size:12px"/>
      </div>
      <p style="font-size:12px;color:#94a3b8;padding:0 16px 8px">품목 행을 클릭하면 색상별 재고를 확인할 수 있습니다. <span style="color:#c2410c">*오산은 발주 대상 아님 (재고 관리 전용).</span></p>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>품목 / 색상</th>
          <th class="td-center" style="color:#1e40af">시흥</th>
          <th class="td-center" style="color:#065f46">평택</th>
          <th class="td-center" style="color:#7c2d12" title="오산은 발주 대상 아님(재고 관리 전용)">오산*</th>
          <th class="td-center" title="발주 가능 재고 (시흥+평택)">발주가능</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;

  // 검색 이벤트 바인딩
  const svSearchEl=document.getElementById('sv-search-input');
  if(svSearchEl)_imeSafeSearchInput(svSearchEl, v=>{_stockViewSearch=v;renderStockView();}, {focusFlagKey:'_svSearchFocused'});

  // 아코디언 이벤트 바인딩
  document.querySelectorAll('.sv-item-row').forEach(row=>{
    row.addEventListener('click',()=>{
      const id=row.dataset.svId;
      const colorRows=document.querySelectorAll(`.sv-cr-${id}`);
      const icon=document.querySelector(`.sv-toggle-icon[data-sv-id="${id}"]`);
      const isOpen=colorRows[0]&&colorRows[0].style.display!=='none';
      colorRows.forEach(r=>r.style.display=isOpen?'none':'');
      if(icon)icon.textContent=isOpen?'▶':'▼';
    });
  });
}

// ── 재고 기록 페이지 (관리자 전용) ──
let stockLogFilter='',stockLogType='',stockLogItem='',stockLogDateFrom='',stockLogDateTo='';
let stockLogPage=1; // 재고 기록 페이지 (독립 페이지)
let invLogPage=1;   // 재고 관리 내 기록 섹션 페이지
let invItemSearch='',invOnlyZero=false,invOnlyLow=false;

// makePaginationHtml, logTypeCls → js/utils.js
function renderStockLogs(){
  const allLogs=getLogs().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const items=getItems();
  // 선택 품목 요약
  const selItem=stockLogItem?items.find(i=>i.id===parseInt(stockLogItem)):null;
  const filtered=allLogs.filter(l=>{
    if(stockLogItem&&l.itemId!==parseInt(stockLogItem))return false;
    if(stockLogFilter){const it=items.find(i=>i.id===l.itemId);if(!it||!it.name.includes(stockLogFilter))return false;}
    if(stockLogType&&l.type!==stockLogType)return false;
    if(stockLogDateFrom&&l.createdAt.slice(0,10)<stockLogDateFrom)return false;
    if(stockLogDateTo&&l.createdAt.slice(0,10)>stockLogDateTo)return false;
    return true;
  });
  // 요약 계산
  const selLogs=stockLogItem?allLogs.filter(l=>l.itemId===parseInt(stockLogItem)):[];
  const totalIn=selLogs.filter(l=>l.qty>0).reduce((s,l)=>s+l.qty,0);
  const totalOut=selLogs.filter(l=>l.qty<0).reduce((s,l)=>s+Math.abs(l.qty),0);
  const last7=new Date();last7.setDate(last7.getDate()-7);
  const recent7=selLogs.filter(l=>new Date(l.createdAt)>=last7).length;
  const lastLog=selLogs[0];
  const itemOpts=items.filter(i=>i.isActive&&isTrackStock(i)&&i.drawerType!=='handle').map(i=>`<option value="${i.id}"${stockLogItem===String(i.id)?' selected':''}>${i.name}</option>`).join('');
  const typeOpts=['입고','출고','조정','발주차감','발주수정재반영','취소롤백'].map(t=>`<option value="${t}"${stockLogType===t?' selected':''}>${t}</option>`).join('');
  const PER=20;
  const totalFiltered=filtered.length;
  if(stockLogPage>Math.ceil(totalFiltered/PER)||stockLogPage<1)stockLogPage=1;
  const paginated=filtered.slice((stockLogPage-1)*PER, stockLogPage*PER);
  const rows=paginated.map(l=>{
    const it=items.find(i=>i.id===l.itemId);
    const logOrder=l.orderId?getOrders().find(o=>o.id===l.orderId):null;
    const orderLink=l.orderId?`<button class="btn btn-ghost btn-xs slog-order-link" data-order-id="${l.orderId}" style="font-size:11px;padding:1px 5px">${logOrder?(logOrder.orderNum||('#'+l.orderId)):('#'+l.orderId)}</button>`:'-';
    return`<tr>
      <td class="td-muted" style="font-size:11px;white-space:nowrap">${fmtDt(l.createdAt)}</td>
      <td class="td-name" style="font-size:12px">${it?it.name:'?'}</td>
      <td class="td-center"><span class="badge ${logTypeCls(l.type)}" style="font-size:10px">${l.type}</span></td>
      <td class="td-center" style="font-weight:800;color:${l.qty>=0?'#16a34a':'#dc2626'}">${l.qty>0?'+':''}${l.qty}</td>
      <td class="td-center">${l.beforeStock} → <strong>${l.afterStock}</strong></td>
      <td class="td-center">${orderLink}</td>
      <td class="td-muted" style="font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis">${l.memo||'-'}</td>
      <td class="td-muted" style="font-size:11px">${l.createdBy||'-'}</td>
    </tr>`;
  }).join('');
  const pgHtml=makePaginationHtml(totalFiltered,stockLogPage,PER,'_goStockLogPage');
  const summaryHtml=selItem?`<div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
    <div style="background:#fff;border:1px solid var(--border);border-radius:var(--r);padding:10px 16px;min-width:110px">
      <p style="font-size:10px;font-weight:700;color:var(--text-3);margin-bottom:2px">현재 재고</p>
      <p style="font-size:22px;font-weight:800;color:${selItem.currentStock===0?'#dc2626':'#111827'}">${selItem.currentStock}</p>
    </div>
    <div style="background:#fff;border:1px solid var(--border);border-radius:var(--r);padding:10px 16px;min-width:110px">
      <p style="font-size:10px;font-weight:700;color:var(--text-3);margin-bottom:2px">누적 입고</p>
      <p style="font-size:22px;font-weight:800;color:#16a34a">+${totalIn}</p>
    </div>
    <div style="background:#fff;border:1px solid var(--border);border-radius:var(--r);padding:10px 16px;min-width:110px">
      <p style="font-size:10px;font-weight:700;color:var(--text-3);margin-bottom:2px">누적 출고</p>
      <p style="font-size:22px;font-weight:800;color:#dc2626">-${totalOut}</p>
    </div>
    <div style="background:#fff;border:1px solid var(--border);border-radius:var(--r);padding:10px 16px;min-width:110px">
      <p style="font-size:10px;font-weight:700;color:var(--text-3);margin-bottom:2px">최근 7일 변동</p>
      <p style="font-size:22px;font-weight:800;color:#1d4ed8">${recent7}건</p>
    </div>
    <div style="background:#fff;border:1px solid var(--border);border-radius:var(--r);padding:10px 16px;min-width:160px">
      <p style="font-size:10px;font-weight:700;color:var(--text-3);margin-bottom:2px">마지막 변동</p>
      <p style="font-size:12px;font-weight:700;color:#374151">${lastLog?fmtDt(lastLog.createdAt):'-'}</p>
    </div>
  </div>`:'';
  document.getElementById('content').innerHTML=`
    <div class="section-title">재고 기록</div>
    <div class="section-sub">입출고·조정·발주 차감·취소 롤백 이력을 확인합니다.</div>
    <div class="filter-bar" style="flex-wrap:wrap;gap:8px">
      <select class="form-input" id="slog-item-sel" style="max-width:160px">
        <option value="">전체 품목</option>${itemOpts}
      </select>
      <input class="form-input" placeholder="품목명 검색" id="slog-item" value="${stockLogFilter}" style="max-width:140px"/>
      <select class="form-input" id="slog-type" style="max-width:140px">
        <option value="">전체 유형</option>${typeOpts}
      </select>
      <input type="date" class="form-input" id="slog-date-from" value="${stockLogDateFrom}" style="max-width:130px"/>
      <input type="date" class="form-input" id="slog-date-to" value="${stockLogDateTo}" style="max-width:130px"/>
      <button class="btn btn-outline btn-sm" id="slog-reset">초기화</button>
      <span style="font-size:12px;color:var(--text-3)">총 ${totalFiltered}건</span>
    </div>
    ${summaryHtml}
    <div class="card">
      ${rows?`<div class="table-wrap"><table>
        <thead><tr><th>일시</th><th>품목명</th><th class="td-center">구분</th><th class="td-center">수량</th><th class="td-center">변동</th><th class="td-center">발주</th><th>메모</th><th>처리자</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>${pgHtml}`:'<div class="empty"><i class="fas fa-clock-rotate-left"></i><p>기록이 없습니다.</p></div>'}
    </div>`;
  document.getElementById('slog-item-sel').addEventListener('change',e=>{stockLogItem=e.target.value;stockLogPage=1;renderStockLogs();});
  _imeSafeSearchInput(document.getElementById('slog-item'), v=>{stockLogFilter=v;stockLogPage=1;renderStockLogs();}, {focusFlagKey:'_slogItemFocusedA'});
  document.getElementById('slog-type').addEventListener('change',e=>{stockLogType=e.target.value;stockLogPage=1;renderStockLogs();});
  document.getElementById('slog-date-from').addEventListener('change',e=>{stockLogDateFrom=e.target.value;stockLogPage=1;renderStockLogs();});
  document.getElementById('slog-date-to').addEventListener('change',e=>{stockLogDateTo=e.target.value;stockLogPage=1;renderStockLogs();});
  document.getElementById('slog-reset').addEventListener('click',()=>{stockLogFilter='';stockLogType='';stockLogItem='';stockLogDateFrom='';stockLogDateTo='';stockLogPage=1;renderStockLogs();});
  // 페이지 버튼 이벤트 위임
  document.querySelectorAll('.pg-btn[data-fn="_goStockLogPage"]').forEach(btn=>{
    btn.addEventListener('click',()=>{stockLogPage=parseInt(btn.dataset.pg);renderStockLogs();window.scrollTo(0,0);});
  });
  document.querySelectorAll('.pg-go-btn[data-fn="_goStockLogPage"]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const val=parseInt(document.getElementById(btn.dataset.input)?.value)||1;
      stockLogPage=Math.max(1,Math.min(parseInt(btn.dataset.max),val));
      renderStockLogs();window.scrollTo(0,0);
    });
  });
}

// 재고 관리 (관리자·서랍장만)
let invModalState={itemId:null,type:'입고',bulk:false};
function renderInventory(filterItemId){
  if(!requireAdmin())return;
  // 모바일 카드형 CSS 1회 등록
  if (!document.getElementById('_inv-mobile-css')) {
    const s = document.createElement('style');
    s.id = '_inv-mobile-css';
    s.textContent = `
      .inv-stock-card { overflow: visible; }
      .inv-stock-card > .card-header {
        position: sticky;
        top: 56px;
        z-index: 45;
        background: #fff;
        box-shadow: 0 2px 8px rgba(15, 23, 42, .08);
      }
      .inv-stock-card .table-wrap { overflow: visible; }
      #inv-stock-table thead th {
        position: sticky;
        top: 111px;
        z-index: 40;
        background: #f8fafc;
        box-shadow: 0 1px 0 var(--border), 0 2px 6px rgba(15, 23, 42, .06);
      }
      @media (max-width: 640px) {
        .inv-stock-card > .card-header {
          top: 52px;
          align-items: flex-start;
          gap: 8px;
        }
        .inv-stock-card .table-wrap { overflow: visible !important; }
        #inv-stock-table { display:block !important; width:100% !important; }
        #inv-stock-table thead { display:none !important; }
        #inv-stock-table thead th { position: static; top: auto; box-shadow: none; }
        #inv-stock-table tbody { display:block !important; }
        /* 메인 행 → 카드 */
        #inv-stock-table tr.inv-main-row {
          display:grid !important;
          grid-template-columns:auto auto auto 1fr;
          grid-template-rows:auto auto auto;
          gap:6px 18px;
          padding:12px;
          margin-bottom:6px;
          background:#fff;
          border:1px solid var(--border);
          border-radius:8px;
          cursor:pointer;
        }
        #inv-stock-table tr.inv-main-row td { display:block !important; padding:0 !important; border:none !important; }
        /* [2026-07-28] 열 순서: 1=품목 2=구분 3=시흥 4=평택 5=오산 6=발주가능 7=처리 */
        /* Row 1: 품목명 (좌 2열) | 발주가능 (우) */
        #inv-stock-table tr.inv-main-row td:nth-child(1) { grid-column:1/4; grid-row:1; font-size:14px; font-weight:700; display:flex !important; align-items:center; gap:4px; }
        #inv-stock-table tr.inv-main-row td:nth-child(1)::before { content:"▶"; color:#94a3b8; font-size:9px; }
        #inv-stock-table tr.inv-main-row.expanded td:nth-child(1)::before { content:"▼"; }
        #inv-stock-table tr.inv-main-row td:nth-child(6) { grid-column:4; grid-row:1; justify-self:end; }
        #inv-stock-table tr.inv-main-row td:nth-child(6)::before { content:"발주가능 "; color:var(--text-3); font-size:11px; }
        /* 구분 chip 숨김 (공간 절약) */
        #inv-stock-table tr.inv-main-row td:nth-child(2) { display:none !important; }
        /* Row 2: 시흥 | 평택 | 오산 (왼쪽으로 모아 표시) */
        #inv-stock-table tr.inv-main-row td:nth-child(3),
        #inv-stock-table tr.inv-main-row td:nth-child(4),
        #inv-stock-table tr.inv-main-row td:nth-child(5) { grid-row:2; font-size:12px; text-align:left; white-space:nowrap; justify-self:start; }
        #inv-stock-table tr.inv-main-row td:nth-child(3) { grid-column:1; }
        #inv-stock-table tr.inv-main-row td:nth-child(3)::before { content:"시흥 "; color:#1e40af; font-size:11px; font-weight:800; }
        #inv-stock-table tr.inv-main-row td:nth-child(4) { grid-column:2; }
        #inv-stock-table tr.inv-main-row td:nth-child(4)::before { content:"평택 "; color:#065f46; font-size:11px; font-weight:800; }
        #inv-stock-table tr.inv-main-row td:nth-child(5) { grid-column:3; }
        #inv-stock-table tr.inv-main-row td:nth-child(5)::before { content:"오산* "; color:#c2410c; font-size:11px; font-weight:800; }
        /* Row 3: 처리 버튼 (3열 전체) */
        #inv-stock-table tr.inv-main-row td:nth-child(7) { grid-column:1/-1; grid-row:3; margin-top:4px; padding-top:6px !important; border-top:1px solid #f1f5f9; }

        /* 색상별 서브 행 — 기본 숨김, 부모 확장 시 표시 */
        #inv-stock-table tr.inv-color-row { display:none !important; }
        #inv-stock-table tr.inv-color-row.expanded {
          display:grid !important;
          grid-template-columns:1fr 1fr 1fr 1fr;
          gap:4px 6px;
          padding:6px 12px;
          margin-bottom:4px;
          margin-top:-4px;
          background:#f8fafc;
          border:1px solid #e2e8f0;
          border-top:none;
          border-radius:0 0 8px 8px;
          font-size:11px;
        }
        #inv-stock-table tr.inv-color-row.expanded td { display:block !important; padding:0 !important; border:none !important; }
        /* 색상 서브: 1=색상명 | 2=시흥 | 3=평택 | 4=오산 (5,6,7 숨김) */
        #inv-stock-table tr.inv-color-row.expanded td:nth-child(1) { grid-column:1; font-weight:600; color:var(--text-2); }
        #inv-stock-table tr.inv-color-row.expanded td:nth-child(2) { display:none !important; }
        #inv-stock-table tr.inv-color-row.expanded td:nth-child(3) { grid-column:2; text-align:center; }
        #inv-stock-table tr.inv-color-row.expanded td:nth-child(3)::before { content:"시 "; color:#94a3b8; font-size:10px; }
        #inv-stock-table tr.inv-color-row.expanded td:nth-child(4) { grid-column:3; text-align:center; }
        #inv-stock-table tr.inv-color-row.expanded td:nth-child(4)::before { content:"평 "; color:#94a3b8; font-size:10px; }
        #inv-stock-table tr.inv-color-row.expanded td:nth-child(5) { grid-column:4; text-align:center; color:var(--text-3); }
        #inv-stock-table tr.inv-color-row.expanded td:nth-child(5)::before { content:"오 "; color:#94a3b8; font-size:10px; }
        #inv-stock-table tr.inv-color-row.expanded td:nth-child(6),
        #inv-stock-table tr.inv-color-row.expanded td:nth-child(7) { display:none !important; }

        /* 재고 기록 표 — 카드형 */
        #inv-log-table { display:block !important; width:100% !important; }
        #inv-log-table thead { display:none !important; }
        #inv-log-table tbody { display:block !important; }
        #inv-log-table tr {
          display:grid !important;
          grid-template-columns:1fr auto;
          grid-template-rows:auto auto auto;
          gap:4px 8px;
          padding:10px;
          margin-bottom:6px;
          background:#fff;
          border:1px solid var(--border);
          border-radius:8px;
        }
        #inv-log-table tr td { display:block !important; padding:0 !important; border:none !important; white-space:normal !important; }
        /* Row 1: 품목명(좌, bold) | 수량(우, 큰글씨) */
        #inv-log-table tr td:nth-child(2) { grid-column:1; grid-row:1; font-size:13px; font-weight:700; }
        #inv-log-table tr td:nth-child(6) { grid-column:2; grid-row:1; justify-self:end; font-size:16px !important; }
        /* Row 2: 일시 + chip들 한 줄 */
        #inv-log-table tr td:nth-child(1) { grid-column:1; grid-row:2; font-size:11px; }
        #inv-log-table tr td:nth-child(3) { grid-column:1; grid-row:2; justify-self:end; }
        /* 창고/색상 chip은 모바일 숨김 (정보 과부하) */
        #inv-log-table tr td:nth-child(4),
        #inv-log-table tr td:nth-child(5) { display:none !important; }
        /* Row 3: 변동(좌) | 발주번호(우), 메모 숨김 */
        #inv-log-table tr td:nth-child(7) { grid-column:1; grid-row:3; font-size:11px; color:var(--text-3); }
        #inv-log-table tr td:nth-child(7)::before { content:"재고 "; }
        #inv-log-table tr td:nth-child(8) { grid-column:2; grid-row:3; justify-self:end; font-size:11px; }
        #inv-log-table tr td:nth-child(9) { display:none !important; }
      }
    `;
    document.head.appendChild(s);
  }
  const allItems=getItems().filter(i=>i.isActive&&isTrackStock(i)&&i.drawerType!=='handle');
  const categoryOrder={'서랍장':0,'옵션':1,'상부자재':2,'옷봉':3,'선반':4,'코너선반':5};
  allItems.sort((a,b)=>(categoryOrder[a.category]??99)-(categoryOrder[b.category]??99));
  // 현재고 표 필터 적용
  let items=allItems;
  if(invItemSearch)items=items.filter(i=>i.name.includes(invItemSearch));
  if(invOnlyZero)items=items.filter(i=>i.currentStock===0);
  else if(invOnlyLow)items=items.filter(i=>i.currentStock>0&&i.currentStock<=3);

  const totalStock=allItems.reduce((s,i)=>s+i.currentStock,0);
  const zeroCount=allItems.filter(i=>i.currentStock===0).length;
  const lowCount=allItems.filter(i=>i.currentStock>0&&i.currentStock<=3).length;

  // 현재고 표 — 색상별 행 표시
  // [2026-07-24] 오산 창고 컬럼 추가 (재고 관리 전용, 발주 대상 아님)
  // [2026-07-30] 카테고리 바뀔 때 구분 헤더 삽입 (예: 서랍장 뒤에 옵션 시작 표시)
  let _prevCat=null;
  const tableRows=items.map(item=>{
    let _divider='';
    if(item.category!==_prevCat){
      const catCount=items.filter(x=>x.category===item.category).length;
      _divider=`<tr class="inv-cat-divider"><td colspan="7" style="background:#f1f5f9;padding:8px 14px;font-size:12px;font-weight:800;color:#334155;border-top:2px solid #cbd5e1">━━ ${item.category} (${catCount}개) ━━</td></tr>`;
      _prevCat=item.category;
    }
    const sTotal=item.stockSiheung!==undefined?item.stockSiheung:item.currentStock;
    const pTotal=item.stockPyeongtaek||0;
    const oTotal=item.stockOsan||0;
    // [2026-07-24 Codex-High-4] 필터(currentStock=시흥+평택)와 표시 기준 통일. 오산은 발주 대상 아님.
    const orderableTotal=sTotal+pTotal;
    const rowBg=orderableTotal===0?'background:#fef2f2':orderableTotal<=3?'background:#fffbeb':'';
    // 색상별 행 생성
    const colorRows=inventoryColorsForItem(item).map(color=>{
      const sC=inventoryColorStock(item.colorStockSiheung||{},color);
      const pC=inventoryColorStock(item.colorStockPyeongtaek||{},color);
      const oC=inventoryColorStock(item.colorStockOsan||{},color);
      // [2026-07-24 Codex-High-4] 색상 합계도 발주 가능 재고(시흥+평택)만
      const tot=sC+pC;
      const cColor=tot===0?'#9ca3af':tot<=3?'#d97706':'var(--text)';
      return `<tr class="inv-color-row" style="background:#fafafa">
        <td style="padding-left:24px;font-size:12px;color:var(--text-2)">${color}</td>
        <td class="td-center" style="font-size:11px;color:#9ca3af"></td>
        <td class="td-center"><span style="font-size:13px;font-weight:600;color:${sC===0?'#9ca3af':sC<=3?'#d97706':'#1e40af'}">${sC}</span></td>
        <td class="td-center"><span style="font-size:13px;font-weight:600;color:${pC===0?'#9ca3af':pC<=3?'#d97706':'#065f46'}">${pC}</span></td>
        <td class="td-center"><span style="font-size:13px;font-weight:600;color:${oC===0?'#9ca3af':oC<=3?'#d97706':'#7c2d12'}">${oC}</span></td>
        <td class="td-center"><span style="font-size:13px;font-weight:700;color:${cColor}">${tot}</span></td>
        <td></td>
      </tr>`;
    }).join('');
    return `${_divider}<tr class="inv-main-row" style="${rowBg}">
      <td class="td-name">${item.name}</td>
      <td class="td-center">${drawerBadge(item)}</td>
      <td class="td-center"><span class="td-num" style="font-size:14px;font-weight:700;color:${sTotal===0?'#dc2626':sTotal<=3?'#d97706':'#1e40af'}">${sTotal}</span></td>
      <td class="td-center"><span class="td-num" style="font-size:14px;font-weight:700;color:${pTotal===0?'#dc2626':pTotal<=3?'#d97706':'#065f46'}">${pTotal}</span></td>
      <td class="td-center"><span class="td-num" style="font-size:14px;font-weight:700;color:${oTotal===0?'#9ca3af':'#7c2d12'}" title="오산은 발주 대상 아님">${oTotal}</span></td>
      <td class="td-center"><span class="td-num" style="font-size:14px;font-weight:700;color:${orderableTotal===0?'#dc2626':orderableTotal<=3?'#d97706':'var(--text)'}" title="발주 가능 재고 (시흥+평택)">${orderableTotal}</span></td>
      <td class="td-center">
        <div style="display:flex;gap:4px;justify-content:center;flex-wrap:wrap">
          <button class="btn btn-xs inv-action-btn" style="background:#dbeafe;color:#1e40af;border:none" data-inv-id="${item.id}" data-inv-type="입고">입고</button>
          <button class="btn btn-xs inv-action-btn" style="background:#fee2e2;color:#991b1b;border:none" data-inv-id="${item.id}" data-inv-type="출고">출고</button>
          <button class="btn btn-xs inv-action-btn" style="background:#f3f4f6;color:#374151;border:none" data-inv-id="${item.id}" data-inv-type="조정">조정</button>
          <button class="btn btn-xs inv-log-filter-btn" data-item-id="${item.id}" style="background:#f0fdf4;color:#15803d;border:none"><i class="fas fa-list-ul"></i> 기록</button>
        </div>
      </td>
    </tr>${colorRows}`;
  }).join('')||'<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-3)">검색 결과가 없습니다.</td></tr>';

  // 재고 기록 필터 상태 (renderInventory 호출 시 품목 필터 주입 가능)
  if(filterItemId!==undefined)stockLogItem=String(filterItemId);
  const allLogs=getLogs().sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const logItems=getItems();
  const selItem=stockLogItem?logItems.find(i=>i.id===parseInt(stockLogItem)):null;
  const filtered=allLogs.filter(l=>{
    if(stockLogItem&&l.itemId!==parseInt(stockLogItem))return false;
    if(stockLogFilter){const it=logItems.find(i=>i.id===l.itemId);if(!it||!it.name.includes(stockLogFilter))return false;}
    if(stockLogType&&l.type!==stockLogType)return false;
    if(stockLogDateFrom&&l.createdAt.slice(0,10)<stockLogDateFrom)return false;
    if(stockLogDateTo&&l.createdAt.slice(0,10)>stockLogDateTo)return false;
    return true;
  });
  const selLogs=stockLogItem?allLogs.filter(l=>l.itemId===parseInt(stockLogItem)):[];
  const totalIn=selLogs.filter(l=>l.qty>0).reduce((s,l)=>s+l.qty,0);
  const totalOut=selLogs.filter(l=>l.qty<0).reduce((s,l)=>s+Math.abs(l.qty),0);
  const last7=new Date();last7.setDate(last7.getDate()-7);
  const recent7=selLogs.filter(l=>new Date(l.createdAt)>=last7).length;
  const lastLog=selLogs[0];
  const itemOpts=allItems.filter(i=>i.drawerType!=='handle').map(i=>`<option value="${i.id}"${stockLogItem===String(i.id)?' selected':''}>${i.name}</option>`).join('');
  const typeOpts=['입고','출고','조정','발주차감','발주수정재반영','취소롤백'].map(t=>`<option value="${t}"${stockLogType===t?' selected':''}>${t}</option>`).join('');
  const INVPER=20;
  const totalInvLog=filtered.length;
  if(invLogPage>Math.ceil(totalInvLog/INVPER)||invLogPage<1)invLogPage=1;
  const invPaginated=filtered.slice((invLogPage-1)*INVPER, invLogPage*INVPER);
  const logRows=invPaginated.map(l=>{
    const it=logItems.find(i=>i.id===l.itemId);
    const typeCls=logTypeCls(l.type);
    const orderLink=l.orderId?`<button class="btn btn-ghost btn-xs slog-order-link" data-order-id="${l.orderId}" style="font-size:11px;padding:1px 5px">#${l.orderId}</button>`:'-';
    // [2026-07-24] 오산 뱃지 색상 (평택=녹색, 시흥=파랑, 오산=주황)
    const _whBg=l.warehouse==='시흥'?'#dbeafe':l.warehouse==='평택'?'#dcfce7':l.warehouse==='오산'?'#fef7ed':'#f3f4f6';
    const _whFg=l.warehouse==='시흥'?'#1e40af':l.warehouse==='평택'?'#065f46':l.warehouse==='오산'?'#7c2d12':'#6b7280';
    const whBadge=l.warehouse?`<span style="font-size:10px;padding:1px 6px;border-radius:20px;font-weight:700;background:${_whBg};color:${_whFg}">${l.warehouse}</span>`:'<span style="font-size:10px;color:var(--text-3)">-</span>';
    const colorBadge=l.color?`<span style="font-size:10px;padding:1px 6px;border-radius:20px;background:#ede9fe;color:#6d28d9;font-weight:700">${l.color}</span>`:'<span style="font-size:10px;color:var(--text-3)">-</span>';
    return`<tr>
      <td class="td-muted" style="font-size:11px;white-space:nowrap">${fmtDt(l.createdAt)}</td>
      <td class="td-name" style="font-size:12px">${it?it.name:'?'}</td>
      <td class="td-center"><span class="badge ${typeCls}" style="font-size:10px">${l.type}</span></td>
      <td class="td-center">${whBadge}</td>
      <td class="td-center">${colorBadge}</td>
      <td class="td-center" style="font-weight:800;color:${l.qty>=0?'#16a34a':'#dc2626'}">${l.qty>0?'+':''}${l.qty}</td>
      <td class="td-center">${l.beforeStock} → <strong>${l.afterStock}</strong></td>
      <td class="td-center">${orderLink}</td>
      <td class="td-muted" style="font-size:11px">${l.memo||'-'}</td>
    </tr>`;
  }).join('');
  const invPgHtml=makePaginationHtml(totalInvLog,invLogPage,INVPER,'_goInvLogPage');
  const selSiheung=selItem?(selItem.stockSiheung!==undefined?selItem.stockSiheung:selItem.currentStock):0;
  const selPyeongtaek=selItem?(selItem.stockPyeongtaek||0):0;
  const selOsan=selItem?(selItem.stockOsan||0):0;
  const summaryHtml=selItem?`<div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:var(--r);padding:10px 16px"><p style="font-size:10px;font-weight:700;color:#3b82f6;margin-bottom:2px">시흥 재고</p><p style="font-size:22px;font-weight:800;color:${selSiheung===0?'#dc2626':'#1e40af'}">${selSiheung}</p></div>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:var(--r);padding:10px 16px"><p style="font-size:10px;font-weight:700;color:#16a34a;margin-bottom:2px">평택 재고</p><p style="font-size:22px;font-weight:800;color:${selPyeongtaek===0?'#dc2626':'#065f46'}">${selPyeongtaek}</p></div>
    <div style="background:#fef7ed;border:1px solid #fed7aa;border-radius:var(--r);padding:10px 16px"><p style="font-size:10px;font-weight:700;color:#c2410c;margin-bottom:2px">오산 재고</p><p style="font-size:22px;font-weight:800;color:${selOsan===0?'#dc2626':'#7c2d12'}">${selOsan}</p></div>
    <div style="background:#fff;border:1px solid var(--border);border-radius:var(--r);padding:10px 16px"><p style="font-size:10px;font-weight:700;color:var(--text-3);margin-bottom:2px">누적 입고</p><p style="font-size:22px;font-weight:800;color:#16a34a">+${totalIn}</p></div>
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:var(--r);padding:10px 16px"><p style="font-size:10px;font-weight:700;color:#dc2626;margin-bottom:2px">누적 출고</p><p style="font-size:22px;font-weight:800;color:#dc2626">-${totalOut}</p></div>
    <div style="background:#fff;border:1px solid var(--border);border-radius:var(--r);padding:10px 16px"><p style="font-size:10px;font-weight:700;color:var(--text-3);margin-bottom:2px">최근 7일</p><p style="font-size:22px;font-weight:800;color:#1d4ed8">${recent7}건</p></div>
    <div style="background:#fff;border:1px solid var(--border);border-radius:var(--r);padding:10px 16px"><p style="font-size:10px;font-weight:700;color:var(--text-3);margin-bottom:2px">마지막 변동</p><p style="font-size:13px;font-weight:700;color:#374151">${lastLog?fmtDt(lastLog.createdAt):'-'}</p></div>
  </div>`:'';

  document.getElementById('content').innerHTML=`
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:2px">
      <div class="section-title" style="margin-bottom:0">재고 관리</div>
      <button onclick="downloadInventoryExcel()" class="btn btn-outline btn-sm" style="border:1.5px solid #15803d;color:#15803d;font-weight:700"><i class="fas fa-file-excel"></i> 재고 현황 엑셀</button>
    </div>
    <div class="section-sub">현재고 확인 · 입고/출고/조정 처리 · 재고 기록 조회를 한 화면에서 처리합니다.</div>

    <!-- 상단 요약 카드 -->
    <div style="display:flex;gap:10px;margin-bottom:18px;flex-wrap:wrap">
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:var(--r);padding:12px 20px;min-width:120px">
        <p style="font-size:11px;font-weight:700;color:#3b82f6;margin-bottom:3px">시흥 재고</p>
        <p style="font-size:26px;font-weight:800;color:#1e40af">${allItems.reduce((s,i)=>s+(i.stockSiheung!==undefined?i.stockSiheung:i.currentStock),0)}</p>
      </div>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:var(--r);padding:12px 20px;min-width:120px">
        <p style="font-size:11px;font-weight:700;color:#16a34a;margin-bottom:3px">평택 재고</p>
        <p style="font-size:26px;font-weight:800;color:#065f46">${allItems.reduce((s,i)=>s+(i.stockPyeongtaek||0),0)}</p>
      </div>
      <!-- [2026-07-24] 오산 재고 (재고 관리 전용, 발주 대상 아님) -->
      <div style="background:#fef7ed;border:1px solid #fed7aa;border-radius:var(--r);padding:12px 20px;min-width:120px">
        <p style="font-size:11px;font-weight:700;color:#c2410c;margin-bottom:3px">오산 재고</p>
        <p style="font-size:26px;font-weight:800;color:#7c2d12">${allItems.reduce((s,i)=>s+(i.stockOsan||0),0)}</p>
      </div>
      <div style="background:#fff;border:1px solid var(--border);border-radius:var(--r);padding:12px 20px;min-width:120px">
        <p style="font-size:11px;font-weight:700;color:var(--text-3);margin-bottom:3px">전체 합계 (발주 대상)</p>
        <p style="font-size:26px;font-weight:800;color:#374151">${totalStock}</p>
      </div>
      <div style="background:#fff;border:1px solid var(--border);border-radius:var(--r);padding:12px 20px;min-width:120px">
        <p style="font-size:11px;font-weight:700;color:var(--text-3);margin-bottom:3px">관리 품목</p>
        <p style="font-size:26px;font-weight:800;color:#374151">${allItems.length}</p>
      </div>
      ${zeroCount>0?`<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:var(--r);padding:12px 20px;min-width:120px;cursor:pointer" onclick="invOnlyZero=!invOnlyZero;invOnlyLow=false;renderInventory()">
        <p style="font-size:11px;font-weight:700;color:#dc2626;margin-bottom:3px">재고 없음</p>
        <p style="font-size:26px;font-weight:800;color:#dc2626">${zeroCount}</p>
      </div>`:''}
      ${lowCount>0?`<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:var(--r);padding:12px 20px;min-width:120px;cursor:pointer" onclick="invOnlyLow=!invOnlyLow;invOnlyZero=false;renderInventory()">
        <p style="font-size:11px;font-weight:700;color:#d97706;margin-bottom:3px">부족 위험 (≤3)</p>
        <p style="font-size:26px;font-weight:800;color:#d97706">${lowCount}</p>
      </div>`:''}
    </div>

    <!-- 현재고 표 -->
    <div class="card inv-stock-card" style="margin-bottom:24px">
      <div class="card-header">
        <h3>품목별 현재고 (창고별)</h3>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <input class="form-input" id="inv-item-search" placeholder="품목명 검색" value="${invItemSearch}" style="max-width:150px;padding:5px 8px;font-size:12px"/>
          <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;white-space:nowrap">
            <input type="checkbox" id="inv-only-zero" ${invOnlyZero?'checked':''}> 재고 0만
          </label>
          <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;white-space:nowrap">
            <input type="checkbox" id="inv-only-low" ${invOnlyLow?'checked':''}> 부족 위험만
          </label>
          ${(invItemSearch||invOnlyZero||invOnlyLow)?`<button class="btn btn-ghost btn-xs" onclick="invItemSearch='';invOnlyZero=false;invOnlyLow=false;renderInventory()">초기화</button>`:''}
          <span style="font-size:12px;color:var(--text-3)">${items.length}/${allItems.length}</span>
        </div>
      </div>
      <div class="table-wrap"><table id="inv-stock-table">
        <thead><tr><th>품목명</th><th class="td-center">구분</th><th class="td-center" style="color:#1e40af">시흥</th><th class="td-center" style="color:#065f46">평택</th><th class="td-center" style="color:#7c2d12" title="오산은 발주 대상 아님(재고 관리 전용)">오산*</th><th class="td-center" title="발주 가능 재고 (시흥+평택)">발주가능</th><th class="td-center" style="min-width:200px">처리</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table></div>
    </div>

    <!-- 재고 기록 조회 -->
    <div class="card">
      <div class="card-header"><h3 id="inv-log-section-title">재고 기록${selItem?' — '+selItem.name:''}</h3>${selItem?`<button class="btn btn-ghost btn-xs" id="inv-log-clear-filter" style="font-size:12px">전체 보기</button>`:''}</div>
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select class="form-input" id="slog-item-sel" style="max-width:150px">
          <option value="">전체 품목</option>${itemOpts}
        </select>
        <input class="form-input" placeholder="품목명 검색" id="slog-item" value="${stockLogFilter}" style="max-width:130px"/>
        <select class="form-input" id="slog-type" style="max-width:140px">
          <option value="">전체 유형</option>${typeOpts}
        </select>
        <input type="date" class="form-input" id="slog-date-from" value="${stockLogDateFrom}" style="max-width:130px"/>
        <span style="font-size:12px;color:var(--text-3)">~</span>
        <input type="date" class="form-input" id="slog-date-to" value="${stockLogDateTo}" style="max-width:130px"/>
        <button class="btn btn-outline btn-sm" id="slog-reset">초기화</button>
        <span style="font-size:12px;color:var(--text-3)">총 ${filtered.length}건</span>
      </div>
      ${summaryHtml?`<div style="padding:12px 16px;border-bottom:1px solid var(--border)">${summaryHtml}</div>`:''}
      ${logRows?`<div class="table-wrap"><table id="inv-log-table">
        <thead><tr><th>일시</th><th>품목명</th><th class="td-center">구분</th><th class="td-center">창고</th><th class="td-center">색상</th><th class="td-center">수량</th><th class="td-center">변동</th><th class="td-center">발주</th><th>메모</th></tr></thead>
        <tbody>${logRows}</tbody>
      </table></div>${invPgHtml}`:'<div class="empty"><i class="fas fa-clock-rotate-left"></i><p>기록이 없습니다.</p></div>'}
    </div>`;

  // 이벤트 바인딩 — 현재고 표 필터
  // [2026-07-30] 재렌더로 인한 포커스·한글 IME 문제 방어
  // - 한글 조합 중(compositionstart~end)에는 re-render 하지 않음 (조합 버퍼 깨짐 방지)
  // - 재렌더 후 자동 포커스 복원 + 커서 끝으로
  // IME 안전 debounced 검색 헬퍼로 통합
  _imeSafeSearchInput(document.getElementById('inv-item-search'), v=>{invItemSearch=v;renderInventory();}, {focusFlagKey:'_invSearchWasFocused'});
  const invZeroChk=document.getElementById('inv-only-zero');
  if(invZeroChk)invZeroChk.addEventListener('change',e=>{invOnlyZero=e.target.checked;invOnlyLow=false;renderInventory();});
  const invLowChk=document.getElementById('inv-only-low');
  if(invLowChk)invLowChk.addEventListener('change',e=>{invOnlyLow=e.target.checked;invOnlyZero=false;renderInventory();});
  // 재고 기록 필터 (페이지 초기화)
  document.getElementById('slog-item-sel').addEventListener('change',e=>{stockLogItem=e.target.value;invLogPage=1;renderInventory();});
  _imeSafeSearchInput(document.getElementById('slog-item'), v=>{stockLogFilter=v;invLogPage=1;renderInventory();}, {focusFlagKey:'_slogItemFocusedB'});
  document.getElementById('slog-type').addEventListener('change',e=>{stockLogType=e.target.value;invLogPage=1;renderInventory();});
  document.getElementById('slog-date-from').addEventListener('change',e=>{stockLogDateFrom=e.target.value;invLogPage=1;renderInventory();});
  document.getElementById('slog-date-to').addEventListener('change',e=>{stockLogDateTo=e.target.value;invLogPage=1;renderInventory();});
  document.getElementById('slog-reset').addEventListener('click',()=>{stockLogFilter='';stockLogType='';stockLogItem='';stockLogDateFrom='';stockLogDateTo='';invLogPage=1;renderInventory();});
  const clearFilter=document.getElementById('inv-log-clear-filter');
  if(clearFilter)clearFilter.addEventListener('click',()=>{stockLogItem='';invLogPage=1;renderInventory();});
  // 페이지 버튼 이벤트 위임
  document.querySelectorAll('.pg-btn[data-fn="_goInvLogPage"]').forEach(btn=>{
    btn.addEventListener('click',()=>{invLogPage=parseInt(btn.dataset.pg);renderInventory();document.getElementById('inv-log-section-title')?.scrollIntoView({behavior:'smooth'});});
  });
  document.querySelectorAll('.pg-go-btn[data-fn="_goInvLogPage"]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const val=parseInt(document.getElementById(btn.dataset.input)?.value)||1;
      invLogPage=Math.max(1,Math.min(parseInt(btn.dataset.max),val));
      renderInventory();document.getElementById('inv-log-section-title')?.scrollIntoView({behavior:'smooth'});
    });
  });
}

function openItemLog(itemId, itemName){
  const logs=getLogs().filter(l=>l.itemId===itemId).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  document.getElementById('item-log-title').textContent=itemName+' — 재고 기록';
  const typeCls=t=>t==='입고'?'type-in':t==='출고'?'type-out':t==='발주차감'?'badge-red':t==='취소롤백'?'badge-done':'type-adj';
  const rows=logs.map(l=>`<tr>
    <td class="td-muted" style="font-size:12px">${fmtDt(l.createdAt)}</td>
    <td class="td-center"><span class="badge ${typeCls(l.type)}">${l.type}</span></td>
    <td class="td-center" style="font-weight:700;color:${l.qty>=0?'#16a34a':'#dc2626'}">${l.qty>0?'+':''}${l.qty}</td>
    <td class="td-center">${l.beforeStock} → <strong>${l.afterStock}</strong></td>
    <td class="td-muted" style="font-size:12px">${l.memo||'-'}</td>
    <td class="td-muted" style="font-size:12px">${l.createdBy||'-'}</td>
  </tr>`).join('');
  document.getElementById('item-log-body').innerHTML=rows
    ?`<div class="table-wrap"><table>
        <thead><tr><th>일시</th><th class="td-center">구분</th><th class="td-center">수량</th><th class="td-center">변동</th><th>메모</th><th>처리자</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
    :'<div class="empty"><i class="fas fa-list-ul"></i><p>기록이 없습니다.</p></div>';
  openModal('item-log-modal');
}

function invSelectWarehouse(wh){
  document.getElementById('inv-warehouse').value=wh;
  const sBtn=document.getElementById('inv-wh-siheung');
  const pBtn=document.getElementById('inv-wh-pyeongtaek');
  const oBtn=document.getElementById('inv-wh-osan');
  if(sBtn){sBtn.style.background=wh==='시흥'?'var(--primary)':'';sBtn.style.color=wh==='시흥'?'#fff':'';sBtn.style.borderColor=wh==='시흥'?'var(--primary)':'';}
  if(pBtn){pBtn.style.background=wh==='평택'?'var(--primary)':'';pBtn.style.color=wh==='평택'?'#fff':'';pBtn.style.borderColor=wh==='평택'?'var(--primary)':'';}
  // [2026-07-24] 오산 버튼 처리 (재고 관리 전용)
  if(oBtn){oBtn.style.background=wh==='오산'?'var(--primary)':'';oBtn.style.color=wh==='오산'?'#fff':'';oBtn.style.borderColor=wh==='오산'?'var(--primary)':'';}
  updateInvPreview();
  updateInvBulkPreview();
}

function invEscape(s){
  if(typeof escapeHtml==='function')return escapeHtml(s);
  return String(s||'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function renderInvBulkRows(item,type,colors){
  const wh=document.getElementById('inv-warehouse')?.value||'시흥';
  const label=type==='조정'?'조정 후 수량':'수량';
  return colors.map(color=>{
    const before=getWarehouseStock(item,wh,color)||0;
    const safeColor=invEscape(color);
    return `<div class="inv-bulk-row" data-color="${safeColor}" style="display:grid;grid-template-columns:1.2fr .8fr 1fr .8fr;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid #e5e7eb">
      <div style="font-weight:700;color:var(--text)">${safeColor}</div>
      <div style="font-size:13px;color:var(--text-3)">현재 <span class="inv-bulk-before" style="font-weight:800;color:var(--text)">${before}</span></div>
      <input type="text" inputmode="numeric" pattern="[0-9]*" class="form-input inv-bulk-qty" data-color="${safeColor}" placeholder="${label}" oninput="updateInvBulkPreview()" style="height:36px;font-weight:700"/>
      <div class="inv-bulk-after" style="font-size:13px;text-align:right;color:var(--text-3)">-</div>
    </div>`;
  }).join('');
}

function updateInvBulkPreview(){
  if(!invModalState.bulk)return;
  const item=getItem(invModalState.itemId);if(!item)return;
  const wh=document.getElementById('inv-warehouse')?.value||'시흥';
  const type=invModalState.type;
  let count=0,totalDiff=0,hasError=false;
  document.querySelectorAll('.inv-bulk-row').forEach(row=>{
    const color=row.dataset.color||'';
    const input=row.querySelector('.inv-bulk-qty');
    const beforeEl=row.querySelector('.inv-bulk-before');
    const afterEl=row.querySelector('.inv-bulk-after');
    const before=getWarehouseStock(item,wh,color)||0;
    if(beforeEl)beforeEl.textContent=before;
    const raw=(input?.value||'').trim();
    if(!raw){if(afterEl){afterEl.textContent='-';afterEl.style.color='var(--text-3)';}return;}
    const qty=Number(raw);
    if(!Number.isFinite(qty)||!Number.isInteger(qty)||!Number.isSafeInteger(qty)||qty<0){
      hasError=true;
      if(afterEl){afterEl.textContent='정수만';afterEl.style.color='#dc2626';}
      return;
    }
    let after=type==='입고'?before+qty:type==='출고'?before-qty:qty;
    if(type==='출고'&&qty>before){
      hasError=true;
      if(afterEl){afterEl.textContent='재고부족';afterEl.style.color='#dc2626';}
      return;
    }
    count++;
    totalDiff+=after-before;
    if(afterEl){
      afterEl.innerHTML=`→ <strong>${after}</strong>`;
      afterEl.style.color=after<before?'#dc2626':'#16a34a';
    }
  });
  const preview=document.getElementById('inv-preview');
  if(!preview)return;
  if(hasError){
    preview.innerHTML='<div class="preview-box" style="color:#dc2626">입력값 중 처리할 수 없는 색상이 있습니다.</div>';
  }else if(count>0){
    preview.innerHTML=`<div class="preview-box">[${wh}] ${count}개 색상 처리 예정 <span style="color:${totalDiff<0?'#dc2626':'#16a34a'};font-weight:800">(${totalDiff>0?'+':''}${totalDiff})</span></div>`;
  }else{
    preview.innerHTML='';
  }
}

function openInvModal(itemId,type){
  invModalState={itemId,type,bulk:false};
  const item=getItem(itemId);
  const typeColor=type==='입고'?'#1e40af':type==='출고'?'#991b1b':'#713f12';
  document.getElementById('inv-modal-title').innerHTML=`<span style="color:${typeColor}">${type}</span> 처리`;
  const sStock=item.stockSiheung!==undefined?item.stockSiheung:item.currentStock;
  const pStock=item.stockPyeongtaek||0;
  const oStock=item.stockOsan||0;
  // 색상별 재고 요약 표시 (오산 포함)
  const inventoryColors=inventoryColorsForItem(item);
  invModalState.bulk=inventoryColors.length>0;
  const colorSummary=inventoryColors.map(c=>{
    const cs=item.colorStockSiheung||{};
    const cp=item.colorStockPyeongtaek||{};
    const co=item.colorStockOsan||{};
    const tot=inventoryColorStock(cs,c)+inventoryColorStock(cp,c)+inventoryColorStock(co,c);
    return tot>0?`${c}:${tot}`:null;
  }).filter(Boolean).join(', ');
  document.getElementById('inv-modal-info').innerHTML=
    `<strong>${item.name}</strong><br>`+
    `<span style="font-size:12px;color:#1e40af">시흥: ${sStock}</span> &nbsp;/&nbsp; <span style="font-size:12px;color:#065f46">평택: ${pStock}</span> &nbsp;/&nbsp; <span style="font-size:12px;color:#7c2d12">오산: ${oStock}</span>`+
    (colorSummary?`<br><span style="font-size:11px;color:var(--text-3)">${colorSummary}</span>`:'');
  document.getElementById('inv-qty-label').innerHTML=type==='조정'?'조정 후 재고 수량 <span class="req">*</span>':`${type} 수량 <span class="req">*</span>`;
  document.getElementById('inv-qty').value='';
  document.getElementById('inv-qty').placeholder=type==='조정'?'조정 후 수량 (0 이상)':'수량 입력';
  document.getElementById('inv-date').value=new Date().toISOString().slice(0,10);
  document.getElementById('inv-memo').value='';
  document.getElementById('inv-preview').innerHTML='';
  // 품목별 색상 선택. noColor 품목은 창고 합계 재고로 처리한다.
  const colorGroup=document.getElementById('inv-color-group');
  const colorSel=document.getElementById('inv-color');
  const qtyGroup=document.getElementById('inv-qty')?.closest('.form-group');
  const bulkGroup=document.getElementById('inv-bulk-group');
  const bulkList=document.getElementById('inv-bulk-list');
  colorGroup.style.display=invModalState.bulk?'none':(inventoryColors.length>0?'':'none');
  if(qtyGroup)qtyGroup.style.display=invModalState.bulk?'none':'';
  if(bulkGroup)bulkGroup.style.display=invModalState.bulk?'':'none';
  if(bulkList)bulkList.innerHTML=invModalState.bulk?renderInvBulkRows(item,type,inventoryColors):'';
  colorSel.innerHTML='<option value="">색상 선택 (필수)</option>'+inventoryColors.map(c=>`<option value="${c}">${c}</option>`).join('');
  colorSel.value='';
  // 창고 선택 초기화 (시흥 기본)
  invSelectWarehouse('시흥');
  updateInvBulkPreview();
  const btn=document.getElementById('inv-submit-btn');
  btn.className='btn '+(type==='입고'?'btn-primary':type==='출고'?'btn-danger':'btn-outline');
  btn.textContent=type+' 처리';
  openModal('inv-modal');
  setTimeout(()=>{
    const focusTarget=invModalState.bulk?document.querySelector('.inv-bulk-qty'):(inventoryColors.length>0?colorSel:document.getElementById('inv-qty'));
    if(focusTarget)focusTarget.focus();
  },100);
}

function updateInvPreview(){
  const item=getItem(invModalState.itemId);if(!item)return;
  const qtyStr=document.getElementById('inv-qty').value;
  const preview=document.getElementById('inv-preview');
  if(!qtyStr){preview.innerHTML='';return;}
  // [2026-07-24 Codex-Low-7] submitInventory와 동일 검증 (정수·안전정수) — 1.9 입력 시 미리보기도 거부
  const qty=Number(qtyStr);
  if(!Number.isFinite(qty)||!Number.isInteger(qty)||!Number.isSafeInteger(qty)){
    preview.innerHTML='<div class="preview-box" style="color:#dc2626">수량은 정수만 입력 가능합니다.</div>';return;
  }
  const{type}=invModalState;
  const wh=document.getElementById('inv-warehouse')?.value||'시흥';
  const color=document.getElementById('inv-color')?.value||'';
  const whStock=getWarehouseStock(item,wh,color)||0;
  let after;
  if(type==='입고')after=whStock+qty;
  else if(type==='출고')after=Math.max(whStock-qty,0);
  else after=qty;
  const diff=after-whStock;
  const colorLabel=color?`[${color}] `:'';
  preview.innerHTML=`<div class="preview-box">${colorLabel}[${wh}] 변경 결과: ${whStock}개 → <strong style="color:${after<whStock?'#dc2626':'#16a34a'}">${after}개</strong> <span style="color:var(--text-3)">(${diff>0?'+':''}${diff})</span></div>`;
}

// [2026-07-24 방어] Enter 연타·더블 클릭 방지 — 진행 중 재호출 차단
let _invSubmitting = false;

async function submitInventory(){
  // [Critical 방어] 이미 처리 중이면 무시 (Enter 연타·더블 클릭 시 재고 배수 반영 방지)
  if (_invSubmitting) return;
  const{itemId,type}=invModalState;
  if(invModalState.bulk)return submitInventoryBulk();
  const qtyStr=document.getElementById('inv-qty').value;
  const memo=document.getElementById('inv-memo').value.trim();
  const warehouse=document.getElementById('inv-warehouse')?.value||'시흥';
  const logDate=document.getElementById('inv-date')?.value||'';
  const color=document.getElementById('inv-color')?.value||'';
  const item=getItem(itemId);
  if(!logDate){toast('날짜를 입력해주세요.','error');return;}
  if(inventoryColorsForItem(item).length>0&&!color){toast('색상을 선택해주세요.','error');return;}
  if(!qtyStr){toast('수량을 입력해주세요.','error');return;}
  // [Medium 방어] parseInt는 '1e5'→1, '1.9'→1 조용한 절삭 → 정수만 명시적으로 허용
  // Number.isSafeInteger로 정밀도 손실(2^53 초과) 방어 (재고량이 이런 값일 리 없지만 안전)
  const qtyNum = Number(qtyStr);
  if (!Number.isFinite(qtyNum) || !Number.isInteger(qtyNum) || !Number.isSafeInteger(qtyNum)) {
    toast('수량은 정수만 입력 가능합니다.','error');
    return;
  }
  const qty = qtyNum;
  if((type==='입고'||type==='출고')&&qty<1){toast('입고/출고 수량은 1 이상이어야 합니다.','error');return;}
  if(type==='조정'&&qty<0){toast('조정 후 재고는 0 이상이어야 합니다.','error');return;}
  _invSubmitting = true;
  try{
    const{before,after,warehouse:wh}=await processInventory({itemId,type,qty,memo,warehouse,logDate,color});
    const colorLabel=color?`[${color}] `:'';
    closeModal('inv-modal');toast(`${colorLabel}[${wh}] ${type} 처리 완료: ${before} → ${after}`,'success');renderInventory(stockLogItem?parseInt(stockLogItem):undefined);
  }catch(e){toast(e.message,'error');}
  finally{ _invSubmitting = false; }
}
document.getElementById('inv-qty').addEventListener('keydown',e=>{if(e.key==='Enter')submitInventory();});

async function submitInventoryBulk(){
  if(_invSubmitting)return;
  const{itemId,type}=invModalState;
  const memo=document.getElementById('inv-memo').value.trim();
  const warehouse=document.getElementById('inv-warehouse')?.value||'시흥';
  const logDate=document.getElementById('inv-date')?.value||'';
  if(!logDate){toast('날짜를 입력해주세요.','error');return;}
  const entries=[];
  document.querySelectorAll('.inv-bulk-qty').forEach(input=>{
    const raw=(input.value||'').trim();
    if(!raw)return;
    entries.push({color:input.dataset.color||'',qty:Number(raw)});
  });
  if(entries.length===0){toast('처리할 색상 수량을 입력해주세요.','error');return;}
  for(const e of entries){
    if(!Number.isFinite(e.qty)||!Number.isInteger(e.qty)||!Number.isSafeInteger(e.qty)){
      toast(`[${e.color}] 수량은 정수만 입력 가능합니다.`,'error');return;
    }
    if((type==='입고'||type==='출고')&&e.qty<1){toast(`[${e.color}] 입고/출고 수량은 1 이상이어야 합니다.`,'error');return;}
    if(type==='조정'&&e.qty<0){toast(`[${e.color}] 조정 후 재고는 0 이상이어야 합니다.`,'error');return;}
  }
  _invSubmitting=true;
  try{
    const result=await processInventoryBatch({itemId,type,entries,memo,warehouse,logDate});
    closeModal('inv-modal');
    toast(`[${result.warehouse}] ${result.count}개 색상 ${type} 처리 완료`,'success');
    renderInventory(stockLogItem?parseInt(stockLogItem):undefined);
  }catch(e){toast(e.message,'error');}
  finally{_invSubmitting=false;}
}
document.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&e.target&&e.target.classList&&e.target.classList.contains('inv-bulk-qty'))submitInventory();
});
