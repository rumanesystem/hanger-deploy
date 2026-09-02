// ── 공통 유틸리티 ──
// 순수 함수만 포함 (상태·DB 의존 없음)

// 발주 상태 뱃지 HTML
function orderStatusBadge(status){
  const map={
    '임시저장':'<span class="badge badge-draft">임시저장</span>',
    '발주대기':'<span class="badge badge-pending">출고대기</span>',
    '발주확정':'<span class="badge badge-confirmed">출고확정</span>',
    '출고준비':'<span class="badge badge-ready">출고준비</span>',
    '출고완료':'<span class="badge badge-shipped">출고완료</span>',
    '취소':'<span class="badge badge-gray">취소</span>',
    '보관':'<span class="badge badge-archived">보관</span>',
    'active':'<span class="badge badge-confirmed">출고확정</span>',
    'cancelled':'<span class="badge badge-gray">취소</span>',
  };
  return map[status]||`<span class="badge badge-gray">${status}</span>`;
}

// 재고 차감이 된 상태 여부
function statusDeducted(status){
  return ['발주확정','출고준비','출고완료','active'].includes(status);
}

// 상태 전환 가능 목록
function nextStatuses(status){
  const map={
    '임시저장':['발주확정','보관'],
    '발주대기':['발주확정','취소','보관'],
    '발주확정':['출고준비','취소','보관'],
    '출고준비':['출고완료','취소','보관'],
    '출고완료':['보관'],
    '취소':[],
    '보관':['임시저장'],
    'active':['출고준비','취소','보관'],
    'cancelled':[],
  };
  return map[status]||[];
}

// 모바일 여부
function isMobile(){return window.innerWidth<=768;}

// 오늘 날짜 문자열 (YYYY-MM-DD)
function todayStr(){return new Date().toISOString().split('T')[0];}

// 배열을 key 기준으로 그룹핑
function groupBy(arr,key){return arr.reduce((g,x)=>{(g[x[key]]=g[x[key]]||[]).push(x);return g;},{});}

// 서랍 타입 뱃지
function drawerBadge(item,size=''){
  if(!item||item.category!=='서랍장')return '';
  const s=size?` style="font-size:${size}"`:' style="font-size:10px"';
  return item.drawerType==='handle'?`<span class="badge badge-blue"${s}>+손잡이</span>`:`<span class="badge badge-gray"${s}>기본형</span>`;
}

// 페이지네이션 HTML 생성
function makePaginationHtml(total, page, perPage, onClickFn){
  const totalPages=Math.ceil(total/perPage);
  if(totalPages<=1)return '';
  const blockSize=10;
  const blockStart=Math.floor((page-1)/blockSize)*blockSize+1;
  const blockEnd=Math.min(blockStart+blockSize-1,totalPages);
  const has10More=totalPages>=10;
  const btnStyle='min-width:30px;padding:5px 7px;font-size:12px';
  const navStyle='min-width:34px;padding:5px 8px;font-size:11px';
  let html=`<div style="display:flex;align-items:center;justify-content:center;gap:3px;padding:14px 0;flex-wrap:wrap;row-gap:6px">`;

  if(has10More){
    html+=`<button class="btn btn-ghost btn-xs pg-btn" data-pg="${Math.max(1,page-10)}" data-fn="${onClickFn}" title="10페이지 앞으로" style="${navStyle}"><i class="fas fa-angle-double-left"></i></button>`;
    html+=`<button class="btn btn-ghost btn-xs pg-btn" data-pg="${Math.max(1,page-1)}" data-fn="${onClickFn}" title="이전 페이지" style="${navStyle}"><i class="fas fa-angle-left"></i></button>`;
  } else if(blockStart>1){
    html+=`<button class="btn btn-ghost btn-xs pg-btn" data-pg="${blockStart-1}" data-fn="${onClickFn}" style="${navStyle}"><i class="fas fa-angle-left"></i></button>`;
  }

  for(let p=blockStart;p<=blockEnd;p++){
    const act=p===page;
    html+=`<button class="btn btn-xs pg-btn${act?' btn-primary':' btn-ghost'}" data-pg="${p}" data-fn="${onClickFn}" style="${btnStyle}">${p}</button>`;
  }

  if(has10More){
    html+=`<button class="btn btn-ghost btn-xs pg-btn" data-pg="${Math.min(totalPages,page+1)}" data-fn="${onClickFn}" title="다음 페이지" style="${navStyle}"><i class="fas fa-angle-right"></i></button>`;
    html+=`<button class="btn btn-ghost btn-xs pg-btn" data-pg="${Math.min(totalPages,page+10)}" data-fn="${onClickFn}" title="10페이지 뒤로" style="${navStyle}"><i class="fas fa-angle-double-right"></i></button>`;
  } else if(blockEnd<totalPages){
    html+=`<button class="btn btn-ghost btn-xs pg-btn" data-pg="${blockEnd+1}" data-fn="${onClickFn}" style="${navStyle}"><i class="fas fa-angle-right"></i></button>`;
  }

  const pgInputId='pg-input-'+onClickFn;
  html+=`<span style="font-size:12px;color:var(--text-3);margin-left:8px">${page}/${totalPages}</span>`;
  html+=`<div style="display:flex;align-items:center;gap:4px;margin-left:6px">
    <input id="${pgInputId}" type="number" min="1" max="${totalPages}" placeholder="페이지"
      inputmode="numeric" pattern="[0-9]*"
      style="width:54px;padding:4px 6px;font-size:12px;border:1px solid var(--border);border-radius:var(--r-sm);text-align:center"/>
    <button class="btn btn-outline btn-xs pg-go-btn" data-input="${pgInputId}" data-fn="${onClickFn}" data-max="${totalPages}" style="padding:4px 8px;font-size:12px">이동</button>
  </div>`;

  html+=`</div>`;
  return html;
}

// 재고 로그 타입 CSS 클래스
function logTypeCls(t){
  return t==='입고'?'type-in':t==='출고'?'type-out':t==='발주차감'||t==='발주수정재반영'?'badge-red':t==='취소롤백'?'badge-done':'type-adj';
}

// ── IME 안전 debounced 검색 input 헬퍼 ──
// 문제: 한글 조합 중 재렌더 시 IME 상태 초기화로 글자 유실 (예: "겉서랍" → "겉ㅏㅂ")
// 해결: compositionstart/end 감지 + debounce (조합 중엔 skip, 완료 후 delay 지연 재렌더)
// 사용: _imeSafeSearchInput(inputEl, value => { stateVar = value; render(); }, { delay:200, focusFlagKey:'_mySearchFocused' })
function _imeSafeSearchInput(inputEl, onChange, options){
  if(!inputEl || typeof onChange!=='function') return;
  const opts = options || {};
  const delay = typeof opts.delay==='number' ? opts.delay : 200;
  const focusFlagKey = opts.focusFlagKey || null;
  // 타이머 키: focusFlagKey 기반으로 stable
  const timerKey = focusFlagKey ? (focusFlagKey + '_timer') : null;
  const valueKey = focusFlagKey ? (focusFlagKey + '_pendingVal') : null;
  // 재바인딩 시 이전 pending 값 flush (다른 필터 조작으로 재렌더 시 사용자 입력 유실 방지)
  if(timerKey && window[timerKey]){
    clearTimeout(window[timerKey]);
    window[timerKey] = null;
    const pendingVal = valueKey ? window[valueKey] : null;
    if(valueKey) window[valueKey] = null;
    // 사용자가 입력했던 값을 microtask 로 flush → 다음 render 에서 반영
    if(pendingVal != null){
      // focusFlagKey 세팅은 microtask 안에서 (동기 재바인딩이 즉시 소비하지 않게)
      Promise.resolve().then(() => {
        if(focusFlagKey) window[focusFlagKey] = true;
        onChange(pendingVal);
      });
    }
  }
  // 재렌더 직후 포커스 복원 (재렌더 원인이 이 검색이었다면)
  if(focusFlagKey && window[focusFlagKey]){
    window[focusFlagKey] = false;
    try {
      const len = inputEl.value.length;
      inputEl.focus();
      inputEl.setSelectionRange(len, len);
    } catch(_){}
  }
  let _composing = false;
  const trigger = value => {
    if(timerKey && window[timerKey]) clearTimeout(window[timerKey]);
    const _t = setTimeout(() => {
      if(timerKey) window[timerKey] = null;
      if(valueKey) window[valueKey] = null;
      // 검색 직후 다른 메뉴로 이동해 기존 input이 DOM에서 제거된 경우,
      // 오래된 콜백이 이전 화면을 다시 렌더하지 않도록 중단한다.
      if(!inputEl.isConnected) return;
      if(focusFlagKey) window[focusFlagKey] = true; // 실제 render 직전에만 true
      onChange(value);
    }, delay);
    if(timerKey) window[timerKey] = _t;
    if(valueKey) window[valueKey] = value;
  };
  inputEl.addEventListener('compositionstart', () => { _composing = true; });
  inputEl.addEventListener('compositionend', e => {
    _composing = false;
    trigger(e.target.value);
  });
  // 일부 모바일 IME에서 compositionend 없이 포커스가 빠지는 경우 보완.
  inputEl.addEventListener('blur', e => {
    if(!_composing) return;
    _composing = false;
    trigger(e.target.value);
  });
  inputEl.addEventListener('input', e => {
    if(_composing) return; // 한글 조합 중엔 skip (compositionend 에서 처리)
    trigger(e.target.value);
  });
}
