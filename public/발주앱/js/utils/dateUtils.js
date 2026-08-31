// Date Utilities Section
// Date parsing, formatting, and synchronization

// [2026-07-03] 년도 정규화 — "26", "0026", "2026" 모두 "2026"으로
// - 1~2자리 → 2000 + n (26 → 2026)
// - 4자리인데 0000이면 그대로 반환 (0000-00-00은 미정 표시)
// - 4자리인데 100 미만이면 2000 + n (0026 → 2026)
// - 4자리 정상은 그대로
function normalizeYear(yStr) {
  if (!yStr) return '';
  const n = parseInt(yStr, 10);
  if (isNaN(n)) return yStr;
  if (n === 0) return '0000';           // 0000-00-00 미정 표시 유지
  if (n < 100) return String(2000 + n); // "26", "0026" → "2026"
  return String(n).padStart(4, '0');
}

// 발주서 저장 시 사용 — YYYY-MM-DD 형식 정규화
// "0026-06-15" / "26-06-15" → "2026-06-15"
// "0000-00-00" 유지 (미정)
// "" 유지
function normalizeDateStr(s) {
  if (!s || typeof s !== 'string') return '';
  if (s === '0000-00-00') return s; // 미정 표시 그대로
  const m = s.match(/^(\d{1,4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return s;
  const y = normalizeYear(m[1]);
  const mm = m[2].padStart(2, '0');
  const dd = m[3].padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

// 정산·원장 필터에서 사용 — 옛 오염 데이터도 인식하도록 파싱만 관대하게
// (실제 데이터는 안 바꿈, 필터 비교용 정규화만)
function coerceDateForFilter(s) {
  return normalizeDateStr(s);
}

// [2026-08-27] KST 변환 헬퍼 — UTC ISO 문자열/Date/Timestamp를 KST 날짜(YYYY-MM-DD)로
// changedAt은 UTC(new Date().toISOString())로 기록되므로 .slice(0,10)은 UTC 날짜.
// KST(UTC+9)로 변환 후 잘라야 자정~오전 9시 처리 건이 하루 밀리지 않음.
function _toKstDateStr(raw) {
  if (!raw) return '';
  let d;
  if (typeof raw === 'string') {
    d = new Date(raw);
  } else if (typeof raw === 'number') {
    // epoch ms
    d = new Date(raw);
  } else if (raw && typeof raw.toDate === 'function') {
    // Firestore Timestamp 객체 방어 (향후 Admin SDK 경로 대비)
    d = raw.toDate();
  } else if (raw && (typeof raw.seconds === 'number' || typeof raw._seconds === 'number')) {
    // JSON 직렬화된 Firestore Timestamp: {seconds, nanoseconds} 또는 {_seconds, _nanoseconds}
    const sec = typeof raw.seconds === 'number' ? raw.seconds : raw._seconds;
    const nano = typeof raw.nanoseconds === 'number' ? raw.nanoseconds
      : (typeof raw._nanoseconds === 'number' ? raw._nanoseconds : 0);
    d = new Date(sec * 1000 + Math.floor(nano / 1e6));
  } else if (raw instanceof Date) {
    d = raw;
  } else {
    return '';
  }
  if (isNaN(d.getTime())) return '';
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

// 정산·원장 기준일: **최초** 관리자 발주확정 시각 우선(KST 기준, 회계 관행: 최초 확정일 고정)
// 폴백: shipDate → orderDate (옛 데이터에 statusHistory 없고 shipDate=0000-00-00인 경우 방어)
// [2026-08-31] 정책 A 적용 컷오프: orderDate >= '2026-09-01'인 신규 발주서만 새 정책.
//   그 이전 발주서는 옛 규칙 (shipDate → orderDate) 유지 → 회계 마감된 옛 정산월 안 흔들림.
const SETTLEMENT_POLICY_A_CUTOFF = '2026-09-01';
function getSettlementDate(order) {
  if (!order) return '';
  // 컷오프 이전 발주서: 옛 규칙 (shipDate → orderDate)
  const _od = coerceDateForFilter(order.orderDate || '');
  if (_od && _od !== '0000-00-00' && _od < SETTLEMENT_POLICY_A_CUTOFF) {
    const _sd = coerceDateForFilter(order.shipDate || '');
    if (_sd && _sd !== '0000-00-00') return _sd;
    return _od;
  }
  // 컷오프 이후 발주서: 새 정책 (최초 발주확정 시점)
  const history = Array.isArray(order.statusHistory) ? order.statusHistory : [];
  // [2026-08-27] 최초 확정일 정책: 앞에서부터 스캔 → 첫 '발주확정' 이벤트 채택.
  //   재확정(취소→되돌리기, 해제→재확정 등) 시에도 정산 월이 흔들리지 않도록 고정.
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (!entry || entry.status !== '발주확정') continue;
    const kstDate = _toKstDateStr(entry.changedAt);
    if (kstDate) return coerceDateForFilter(kstDate);
  }
  const shipDate = coerceDateForFilter(order.shipDate || '');
  if (shipDate && shipDate !== '0000-00-00') return shipDate;
  // [2026-08-27] 옛 데이터 회귀 방어: statusHistory 없고 shipDate도 무효면 orderDate로 폴백
  const orderDate = coerceDateForFilter(order.orderDate || '');
  return orderDate === '0000-00-00' ? '' : orderDate;
}

if (typeof window !== 'undefined') {
  window.normalizeYear = normalizeYear;
  window.normalizeDateStr = normalizeDateStr;
  window.coerceDateForFilter = coerceDateForFilter;
  window.getSettlementDate = getSettlementDate;
}

// ── 분리형 날짜 입력 헬퍼 ──
// 날짜 prefix → 분리칸 ID prefix 변환 (o-ship-date → o-ship, o-date → o-date)
function _datePartPrefix(prefix){
  if(prefix==='o-ship-date')return 'o-ship';
  return prefix; // o-date → o-date-y/m/d
}
function syncDateParts(prefix){
  const p=_datePartPrefix(prefix);
  const yEl=document.getElementById(p+'-y');
  const mEl=document.getElementById(p+'-m');
  const dEl=document.getElementById(p+'-d');
  const hidden=document.getElementById(prefix);
  if(!yEl||!mEl||!dEl||!hidden)return;
  // [2026-07-03] "26" 또는 "0026" 입력도 "2026"으로 정규화 (0026-XX-XX 저장 방지)
  const y=normalizeYear(yEl.value);
  const m=(mEl.value||'').padStart(2,'0');
  const d=(dEl.value||'').padStart(2,'0');
  if(y.length===4&&m.length===2&&d.length===2&&/\d{4}/.test(y)&&/\d{2}/.test(m)&&/\d{2}/.test(d)){
    hidden.value=`${y}-${m}-${d}`;
    // [2026-07-15 H3] 정상 날짜 입력 시 미정 버튼 하이라이트 자동 해제 (출고일만)
    if(prefix==='o-ship-date'){
      const btn=document.getElementById('o-ship-undecided-btn');
      if(btn){btn.style.background='';btn.style.color='';btn.style.borderColor='';}
    }
  } else {
    // [2026-07-15 H2] 미정('0000-00-00') 보존은 y/m/d 모두 비어있을 때만
    // 부분입력(년만·월만 등) 상태에서는 hidden도 미완성으로 처리
    const hasAnyInput = (yEl.value||'').length>0 || (mEl.value||'').length>0 || (dEl.value||'').length>0;
    if(hasAnyInput){
      hidden.value=''; // 부분입력 → 미완성
      // 미정 버튼도 해제 (사용자가 날짜 입력 중이므로)
      if(prefix==='o-ship-date'){
        const btn=document.getElementById('o-ship-undecided-btn');
        if(btn){btn.style.background='';btn.style.color='';btn.style.borderColor='';}
      }
    } else if(hidden.value !== '0000-00-00'){
      hidden.value=''; // 완전 빈 상태, 미정 아니면 비움
    }
    // hidden.value === '0000-00-00' && 모든 입력 비어있으면 미정 상태 그대로 보존
  }
}
// 출고일 미정 상태 토글
function orderSelectWarehouse(wh){
  const sel=document.getElementById('o-warehouse');
  if(sel&&sel.tagName==='SELECT')sel.value=wh;
  // 색상 포함해서 재고 갱신
  const color=(document.getElementById('shared-color-sel')||{}).value||'';
  _refreshDrawerStockDisplay(wh,color);
}
// 창고+색상 기준으로 발주서 내 모든 재고 추적 품목 표시 일괄 갱신
function _refreshDrawerStockDisplay(wh,color){
  const items=getItems();
  document.querySelectorAll('.drawer-qty[data-item-id]').forEach(inp=>{
    const itemId=parseInt(inp.dataset.itemId);
    const item=items.find(i=>i.id===itemId);
    if(!item||!isTrackStock(item))return;
    const tr=inp.closest('tr');if(!tr)return;
    const stockSpan=tr.querySelector('.cur-stock-val');
    const shortageEl=document.getElementById(`oshortage-${itemId}`);
    const ownColorSel=tr.querySelector('.item-color-select');
    const effectiveColor=ownColorSel?ownColorSel.value:(item.noColor?'':color);
    const colorRequired=!!ownColorSel||!item.noColor;
    if(!effectiveColor){
      // 색상 미선택: 창고 합계 재고 표시
      const whKey2=getWhKey(wh);
      const total=item[whKey2]||0;
      inp.dataset.stock=total;
      if(stockSpan){stockSpan.textContent=total+'개';stockSpan.className='cur-stock-val'+(total===0?' zero':'');}
      const qty=parseInt(inp.value)||0;
      if(shortageEl){
        if(colorRequired){
          shortageEl.innerHTML='<span style="font-size:11px;color:var(--text-3)">색상 선택 필요</span>';
        }else{
          const shortage=Math.max(0,qty-total);
          shortageEl.innerHTML=shortage>0?`<span class="sh-ng">부족 ${shortage}개</span>`:`<span class="sh-ok">부족없음</span>`;
        }
      }
      return;
    }
    const stock=getWarehouseStock(item,wh,effectiveColor);
    inp.dataset.stock=stock;
    if(stockSpan){stockSpan.textContent=stock+'개';stockSpan.className='cur-stock-val'+(stock===0?' zero':'');}
    const qty=parseInt(inp.value)||0;
    if(shortageEl){
      const shortage=Math.max(0,qty-stock);
      shortageEl.innerHTML=shortage>0?`<span class="sh-ng">부족 ${shortage}개</span>`:`<span class="sh-ok">부족없음</span>`;
    }
  });
}
function _setShipDateUndecided(isUndecided){
  const p=_datePartPrefix('o-ship-date');
  const yEl=document.getElementById(p+'-y');
  const mEl=document.getElementById(p+'-m');
  const dEl=document.getElementById(p+'-d');
  const hidden=document.getElementById('o-ship-date');
  const btn=document.getElementById('o-ship-undecided-btn');
  if(!yEl||!mEl||!dEl||!hidden)return;
  if(isUndecided){
    yEl.value=''; mEl.value=''; dEl.value='';
    hidden.value='0000-00-00';
    if(btn){btn.style.background='var(--primary)';btn.style.color='#fff';btn.style.borderColor='var(--primary)';}
  }else{
    yEl.value=''; mEl.value=''; dEl.value='';
    hidden.value='';
    if(btn){btn.style.background='';btn.style.color='';btn.style.borderColor='';}
  }
}
function setDateValue(prefix, val){
  // val: 'YYYY-MM-DD'
  if(!val){
    const p=_datePartPrefix(prefix);
    const yEl=document.getElementById(p+'-y');
    const mEl=document.getElementById(p+'-m');
    const dEl=document.getElementById(p+'-d');
    const hidden=document.getElementById(prefix);
    if(yEl)yEl.value='';
    if(mEl)mEl.value='';
    if(dEl)dEl.value='';
    if(hidden)hidden.value='';
    // [2026-07-15] 출고일 빈값 세팅 시 미정 버튼 스타일 초기화 (이전 상태 잔여 방지)
    if(prefix==='o-ship-date'){
      const btn=document.getElementById('o-ship-undecided-btn');
      if(btn){btn.style.background='';btn.style.color='';btn.style.borderColor='';}
    }
    return;
  }
  // 미정 처리 (출고일만)
  if(val==='0000-00-00'&&prefix==='o-ship-date'){
    _setShipDateUndecided(true);
    return;
  }
  const parts=val.split('-');
  if(parts.length!==3)return;
  const p=_datePartPrefix(prefix); // 분리칸 ID prefix 변환
  const yEl=document.getElementById(p+'-y');
  const mEl=document.getElementById(p+'-m');
  const dEl=document.getElementById(p+'-d');
  const hidden=document.getElementById(prefix);
  if(yEl)yEl.value=parts[0];
  if(mEl)mEl.value=parts[1].replace(/^0/,'');
  if(dEl)dEl.value=parts[2].replace(/^0/,'');
  if(hidden)hidden.value=val;
}
function getDateValue(prefix){
  return (document.getElementById(prefix)||{}).value||'';
}
function setupDateInput(id){
  // 분리형으로 교체됐으므로 no-op (호환용)
}
