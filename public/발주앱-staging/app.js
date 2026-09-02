// ── app.js: 앱 코어 (내비게이션, 대시보드, 단가설정, 이력, 품목, 계정, 초기화) ──

let _cancelTargetOrderId=null;

async function _withInventoryWriteLock(work){
  if(typeof window._acquireServerSaveLock!=='function'||typeof window._releaseServerSaveLock!=='function'){
    throw new Error('재고 저장 잠금 기능을 불러오지 못했습니다. 새로고침 후 다시 시도해주세요.');
  }
  const actor=(typeof currentUser!=='undefined'&&currentUser)?currentUser.id:'';
  const lock=await window._acquireServerSaveLock(actor);
  if(!lock||!lock.ok){
    if(lock&&lock.reason==='locked')throw new Error('다른 사용자가 발주 또는 재고를 저장 중입니다. 잠시 후 다시 시도해주세요.');
    throw new Error('재고 저장 잠금 획득에 실패했습니다. 다시 시도해주세요.');
  }
  try{return await work();}
  finally{try{await window._releaseServerSaveLock();}catch(_e){}}
}

async function _serverInventoryState(){
  if(!window._FS||typeof window._FS.get!=='function'||typeof window._FS.transactInventory!=='function'){
    throw new Error('원자 재고 저장 기능을 불러오지 못했습니다. 새로고침 후 다시 시도해주세요.');
  }
  const [items,prs]=await Promise.all([
    window._FS.get('items',{fromServer:true}),
    window._FS.get('purchase_requests',{fromServer:true})
  ]);
  if(!Array.isArray(items)||!Array.isArray(prs))throw new Error('서버 최신 재고를 불러오지 못했습니다.');
  return{items:JSON.parse(JSON.stringify(items)),prs:JSON.parse(JSON.stringify(prs))};
}

async function processInventory(args){
  return _withInventoryWriteLock(()=>_processInventoryUnlocked(args));
}
async function _processInventoryUnlocked({itemId,type,qty,memo,warehouse,logDate,color}){
  const state=await _serverInventoryState();
  const items=state.items,prs=state.prs;
  const expectedItems=JSON.parse(JSON.stringify(items));
  const expectedPrs=JSON.parse(JSON.stringify(prs));
  const idx=items.findIndex(i=>i.id===itemId);
  if(idx===-1)throw new Error('품목을 찾을 수 없습니다.');
  const item=items[idx];
  if(!isTrackStock(item))throw new Error('재고 관리 대상 품목만 재고를 처리할 수 있습니다.');
  if(item.noColor)color='';
  else if(color&&typeof normalizeStockColor==='function')color=normalizeStockColor(color);
  // 서버에서 로그 id 1개 발급 — 실패 시 즉시 throw(상태 변경 전)
  const _logIds=await _serverGetLogIds(1);
  const wh=warehouse||'시흥';
  const whKey=getWhKey(wh);
  const cwKey=getColorWhKey(wh);
  // 마이그레이션 보정
  if(item.stockSiheung===undefined)item.stockSiheung=item.currentStock||0;
  if(item.stockPyeongtaek===undefined)item.stockPyeongtaek=0;
  // [2026-07-24] 오산 재고 필드 초기화 (기존 item에는 없음)
  if(item.stockOsan===undefined)item.stockOsan=0;
  if(item.colorStockOsan===undefined)item.colorStockOsan={};
  const n=Number(qty);
  let before, after;
  if(color){
    // 색상별 재고 처리
    if(!items[idx][cwKey])items[idx][cwKey]={};
    before=typeof getColorStock==='function'?getColorStock(items[idx][cwKey],color):(items[idx][cwKey][color]||0);
    if(type==='입고')after=before+n;
    else if(type==='출고'){if(n>before)throw new Error(`출고 수량(${n})이 [${color}] ${wh} 재고(${before})를 초과합니다.`);after=before-n;}
    else{if(n<0)throw new Error('조정 후 재고는 0 이상이어야 합니다.');after=n;}
    if(typeof setColorStock==='function')setColorStock(items[idx][cwKey],color,after);
    else items[idx][cwKey][color]=after;
    // 창고 합계 재계산
    items[idx][whKey]=typeof sumColorStockMap==='function'?sumColorStockMap(items[idx][cwKey]):Object.values(items[idx][cwKey]).reduce((s,v)=>s+(v||0),0);
  } else {
    // 색상 미지정: 창고 전체 처리 (기존 방식)
    before=item[whKey];
    if(type==='입고')after=before+n;
    else if(type==='출고'){if(n>before)throw new Error(`출고 수량(${n})이 ${wh} 재고(${before})를 초과합니다.`);after=before-n;}
    else{if(n<0)throw new Error('조정 후 재고는 0 이상이어야 합니다.');after=n;}
    items[idx][whKey]=after;
  }
  items[idx].currentStock=(items[idx].stockSiheung||0)+(items[idx].stockPyeongtaek||0);
  const logTs=logDate?(logDate+'T00:00:00.000Z'):new Date().toISOString();
  // qty 부호 규칙: 입고=+n, 출고=-n, 조정=델타(after-before)
  const _logQty = type==='조정' ? (n-before) : (type==='출고' ? -n : n);
  const stockLogs=[{id:_logIds[0],itemId,type,qty:_logQty,beforeStock:before,afterStock:after,warehouse:wh,color:color||'',memo:memo||'',createdAt:logTs}];
  // 입고 시: 해당 품목의 대기 중인 발주 필요 항목 자동 완료 처리
  // [2026-07-24 Codex-3차] 정책: 엄격 FIFO
  // - 오산 입고는 PR 자동완료 X (발주 대상 아님)
  // - 시흥·평택 입고 시: warehouse/color 일치 + createdAt 오래된 순으로 소진
  // - 오래된 PR을 못 채우면 break, 이후 PR도 자동완료하지 않음 (queue jump 방지)
  // - 부분입고 누적은 미지원 (별도 UI에서 수동 처리 필요)
  if(type==='입고' && wh !== '오산' && qty > 0){
    let changed=false;
    let remaining=qty;
    const _now=new Date().toISOString();
    const candidates=prs
      .filter(p=>{
        if(p.itemId!==itemId||p.status!=='대기') return false;
        const whMatch=!p.warehouse||p.warehouse===wh;
        const colorMatch=!color||!p.color||p.color===color;
        return whMatch && colorMatch;
      })
      .sort((a,b)=>new Date(a.createdAt||0)-new Date(b.createdAt||0));
    for(const p of candidates){
      const need=p.shortageQty||p.requiredQty||0;
      if(need<=0) continue;
      if(need>remaining) break; // 엄격 FIFO: 오래된 PR 못 채우면 여기서 종료
      p.status='발주완료';
      p.updatedAt=_now;
      p.autoCompleted=true;
      remaining-=need;
      changed=true;
      if(remaining<=0) break;
    }
  }
  await window._FS.transactInventory({items,expectedItems,stockLogs,purchaseRequests:prs,expectedPurchaseRequests:expectedPrs});
  return{before,after,warehouse:wh};
}

async function processInventoryBatch(args){
  return _withInventoryWriteLock(()=>_processInventoryBatchUnlocked(args));
}
async function _processInventoryBatchUnlocked({itemId,type,entries,memo,warehouse,logDate}){
  const state=await _serverInventoryState();
  const items=state.items,prs=state.prs;
  const expectedItems=JSON.parse(JSON.stringify(items));
  const expectedPrs=JSON.parse(JSON.stringify(prs));
  const idx=items.findIndex(i=>i.id===itemId);
  if(idx===-1)throw new Error('품목을 찾을 수 없습니다.');
  const item=items[idx];
  if(!isTrackStock(item))throw new Error('재고 관리 대상 품목만 재고를 처리할 수 있습니다.');
  if(item.noColor)throw new Error('색상 없는 품목은 기존 재고 처리 화면을 사용해주세요.');

  const wh=warehouse||'시흥';
  if(!['시흥','평택','오산'].includes(wh))throw new Error('올바른 창고를 선택해주세요.');
  if(!['입고','출고','조정'].includes(type))throw new Error('올바른 재고 처리 구분이 아닙니다.');
  const whKey=getWhKey(wh);
  const cwKey=getColorWhKey(wh);
  const allowedColors=new Set(inventoryColorsForItem(item));
  const seenColors=new Set();
  const ops=(entries||[])
    .map(e=>({color:typeof normalizeStockColor==='function'?normalizeStockColor(String(e.color||'')):String(e.color||''),qty:Number(e.qty)}))
    .filter(e=>e.color&&Number.isFinite(e.qty)&&e.qty!==0);

  if(ops.length===0)throw new Error('처리할 색상 수량을 입력해주세요.');
  for(const op of ops){
    if(!allowedColors.has(op.color))throw new Error(`[${op.color}] 이 품목에 없는 색상입니다.`);
    if(seenColors.has(op.color))throw new Error(`[${op.color}] 색상이 중복 입력되었습니다.`);
    seenColors.add(op.color);
    if(!Number.isInteger(op.qty)||!Number.isSafeInteger(op.qty))throw new Error(`[${op.color}] 수량은 정수만 입력 가능합니다.`);
    if((type==='입고'||type==='출고')&&op.qty<1)throw new Error(`[${op.color}] 입고/출고 수량은 1 이상이어야 합니다.`);
    if(type==='조정'&&op.qty<0)throw new Error(`[${op.color}] 조정 후 재고는 0 이상이어야 합니다.`);
  }

  if(!items[idx][cwKey])items[idx][cwKey]={};
  if(items[idx].stockSiheung===undefined)items[idx].stockSiheung=items[idx].currentStock||0;
  if(items[idx].stockPyeongtaek===undefined)items[idx].stockPyeongtaek=0;
  if(items[idx].stockOsan===undefined)items[idx].stockOsan=0;
  if(items[idx].colorStockSiheung===undefined)items[idx].colorStockSiheung={};
  if(items[idx].colorStockPyeongtaek===undefined)items[idx].colorStockPyeongtaek={};
  if(items[idx].colorStockOsan===undefined)items[idx].colorStockOsan={};

  // 저장 전 전체 dry-run: 하나라도 실패하면 로그번호 발급/재고 변경을 시작하지 않는다.
  const planned=ops.map(op=>{
    const before=typeof getColorStock==='function'?getColorStock(items[idx][cwKey],op.color):(items[idx][cwKey][op.color]||0);
    let after;
    if(type==='입고')after=before+op.qty;
    else if(type==='출고'){
      if(op.qty>before)throw new Error(`[${op.color}] 출고 수량(${op.qty})이 ${wh} 재고(${before})를 초과합니다.`);
      after=before-op.qty;
    }else{
      after=op.qty;
    }
    return{color:op.color,qty:op.qty,before,after};
  });

  const _logIds=await _serverGetLogIds(planned.length);
  const results=[];
  planned.forEach((op,i)=>{
    if(typeof setColorStock==='function')setColorStock(items[idx][cwKey],op.color,op.after);
    else items[idx][cwKey][op.color]=op.after;
    results.push({id:_logIds[i],...op});
  });

  items[idx][whKey]=typeof sumColorStockMap==='function'?sumColorStockMap(items[idx][cwKey]):Object.values(items[idx][cwKey]).reduce((s,v)=>s+(v||0),0);
  items[idx].currentStock=(items[idx].stockSiheung||0)+(items[idx].stockPyeongtaek||0);
  const logTs=logDate?(logDate+'T00:00:00.000Z'):new Date().toISOString();
  const stockLogs=[];
  results.forEach(r=>{
    // qty 부호 규칙: 입고=+r.qty, 출고=-r.qty, 조정=델타(after-before)
    const _logQty = type==='조정' ? (r.after-r.before) : (type==='출고' ? -r.qty : r.qty);
    stockLogs.push({id:r.id,itemId,type,qty:_logQty,beforeStock:r.before,afterStock:r.after,warehouse:wh,color:r.color,memo:memo||'',createdAt:logTs});
  });

  if(type==='입고' && wh !== '오산'){
    let changed=false;
    const _now=new Date().toISOString();
    for(const r of results){
      let remaining=r.qty;
      const candidates=prs
        .filter(p=>{
          if(p.itemId!==itemId||p.status!=='대기')return false;
          const whMatch=!p.warehouse||p.warehouse===wh;
          const colorMatch=!p.color||p.color===r.color;
          return whMatch&&colorMatch;
        })
        .sort((a,b)=>new Date(a.createdAt||0)-new Date(b.createdAt||0));
      for(const p of candidates){
        const need=p.shortageQty||p.requiredQty||0;
        if(need<=0)continue;
        if(need>remaining)break;
        p.status='발주완료';
        p.updatedAt=_now;
        p.autoCompleted=true;
        remaining-=need;
        changed=true;
        if(remaining<=0)break;
      }
    }
  }
  await window._FS.transactInventory({items,expectedItems,stockLogs,purchaseRequests:prs,expectedPurchaseRequests:expectedPrs});
  return{count:results.length,warehouse:wh,results};
}

// 라우터
let currentView='';
const NAV_ADMIN=[
  {id:'dashboard',         label:'대시보드',      icon:'fa-gauge'},
  {id:'orders',            label:'발주서 목록',    icon:'fa-file-invoice'},
  {id:'shipping-view',     label:'출고 현황',      icon:'fa-truck-ramp-box'},
  {id:'purchase-requests', label:'발주 필요 목록', icon:'fa-clipboard-list'},
  {id:'inventory',         label:'재고 관리',      icon:'fa-boxes-stacked'},
  {id:'items',             label:'품목 마스터',    icon:'fa-list'},
  {id:'usage-stats',       label:'사용량 통계',    icon:'fa-chart-bar'},
  {id:'price-settings',    label:'단가 관리',      icon:'fa-tags'},
  {id:'settlement',        label:'정산',          icon:'fa-receipt'},
  {id:'accounts',          label:'계정 관리',      icon:'fa-users-gear'},
];
const NAV_ORDERER=[
  {id:'dashboard',         label:'대시보드',      icon:'fa-gauge'},
  {id:'orders',            label:'발주서 목록',    icon:'fa-file-invoice'},
  {id:'stock-view',        label:'재고 현황',      icon:'fa-boxes-stacked'},
  {id:'settlement',        label:'정산',          icon:'fa-receipt'},
];
function getNavItems(){return isAdmin()?NAV_ADMIN:NAV_ORDERER;}

function navigate(view, {addHistory=true}={}){
  const adminOnly=['inventory','items','accounts','usage-stats','price-settings','shipping-view'];
  if(adminOnly.includes(view)&&!isAdmin()){toast('관리자만 접근할 수 있습니다.','error');view='dashboard';}
  if(currentView&&currentView!==view){
    navHistory.push(currentView);
    if(navHistory.length>20)navHistory.shift();
  }
  updateBackBtn();
  currentView=view;renderNav();
  if(typeof setUserPref==='function') setUserPref('lastView',view);
  // History API 연동 — 모바일 뒤로가기 버튼 지원
  if(addHistory){
    history.pushState({view},'',(location.pathname||'')+'#'+view);
  }
  const item=getNavItems().find(n=>n.id===view);
  document.getElementById('topbar-title').textContent=item?item.label:'';
  document.getElementById('content').innerHTML='<div class="loading"><div class="spinner"></div>불러오는 중...</div>';
  setTimeout(()=>{
    if(view==='dashboard')renderDashboard();
    else if(view==='orders')renderOrders();
    else if(view==='shipping-view')renderShippingView();
    else if(view==='purchase-requests')renderPurchaseRequests();
    else if(view==='inventory')renderInventory();
    else if(view==='stock-view')renderStockView();
    else if(view==='shortage-view')renderShortageView();
    else if(view==='history'){orderTab='order-hist';navigate('orders');return;}
    else if(view==='items')renderItems();
    else if(view==='accounts')renderAccounts();
    else if(view==='usage-stats')renderUsageStats();
    else if(view==='price-settings')renderPriceSettings();
    else if(view==='settlement')renderSettlement();
  },30);
}

function renderNav(){
  document.getElementById('sb-nav').innerHTML=getNavItems().map(n=>{
    const cls='sb-item'+(currentView===n.id?' active':'');
    return `<button class="${cls}" data-nav="${n.id}"><i class="fas ${n.icon}"></i>${n.label}</button>`;
  }).join('');
}

// 사이드바 네비게이션 이벤트 위임
document.getElementById('sb-nav').addEventListener('click',e=>{
  const btn=e.target.closest('[data-nav]');
  if(!btn)return;
  navigate(btn.dataset.nav);
  closeSidebar();
});

// ── 뒤로가기 ──
const navHistory=[];
function goBack(){
  if(navHistory.length===0)return;
  const prev=navHistory.pop();
  // goBack은 히스토리 추가 없이 이동
  currentView=currentView; // navigate 내부에서 push되는 것을 방지
  const _backup=navHistory.splice(0); // 임시 백업
  navigate(prev);
  // navigate가 push한 항목 제거 후 백업 복원
  navHistory.length=0;
  _backup.forEach(v=>navHistory.push(v));
  updateBackBtn();
}
// 메인 네비게이션 페이지 목록 — 이 페이지에서는 뒤로가기 숨김
const MAIN_VIEWS=['dashboard','orders','shipping-view','purchase-requests','inventory','items','accounts','stock-view','shortage-view','usage-stats','price-settings','settlement'];

function updateBackBtn(){
  const backBtn=document.getElementById('topbar-back');
  if(!backBtn)return;
  backBtn.style.display=navHistory.length>0?'inline-flex':'none';
}

// ── 모바일 뒤로가기 버튼 처리 (Android PWA 종료 차단) ──
let _lastBackMs=0;
window.addEventListener('popstate',e=>{
  if(e.state&&e.state.view){
    // 앱 내 이전 화면으로 이동
    navigate(e.state.view,{addHistory:false});
    return;
  }
  // guard 상태 도달 — PWA 종료 차단
  const now=Date.now();
  if(now-_lastBackMs<2000){
    // 2초 내 두 번째 누름 → 앱 종료 허용
    return;
  }
  _lastBackMs=now;
  history.go(1); // 앞으로 복구
  toast('한 번 더 누르면 앱이 종료됩니다.');
});

// ── 날짜 입력 개선 ──
function initDateInputs(){
  ['o-date','o-ship-date'].forEach(id=>{
    const el=document.getElementById(id);
    if(!el)return;
    // 클릭 시 해당 구간 자동 선택
    el.addEventListener('click',()=>{try{el.showPicker&&el.showPicker();}catch(e){}});
    // 연도 4자리 초과 방지
    el.addEventListener('input',()=>{
      const v=el.value;
      if(v){
        const parts=v.split('-');
        if(parts[0]&&parts[0].length>4){
          parts[0]=parts[0].slice(0,4);
          el.value=parts.join('-');
        }
      }
    });
    el.addEventListener('keydown',e=>{
      // Tab으로 년→월→일 이동 지원 (브라우저 기본 동작 활용)
    });
  });
}

// ── 프로필 드롭다운 ──
function toggleProfile(){
  const dd=document.getElementById('profile-dropdown');
  dd.style.display=dd.style.display==='none'?'block':'none';
}
document.addEventListener('click',e=>{
  if(!e.target.closest('#profile-btn')&&!e.target.closest('#profile-dropdown')){
    const dd=document.getElementById('profile-dropdown');
    if(dd)dd.style.display='none';
  }
});

// ── 개인정보 수정 ──
function openProfileEdit(){
  const acc=DB.get('accounts',[]).find(a=>a.id===currentUser.id);
  if(!acc)return;
  document.getElementById('profile-id').value=acc.id;
  document.getElementById('profile-name-input').value=acc.name;
  document.getElementById('profile-email').value=acc.email||'';
  document.getElementById('profile-pw').value='';
  document.getElementById('profile-pw2').value='';
  document.getElementById('profile-error').style.display='none';
  const pdGroup=document.getElementById('profile-delivery-group');
  const pdInput=document.getElementById('profile-delivery-name');
  if(pdGroup)pdGroup.style.display=isAdmin()?'none':'';
  if(pdInput)pdInput.value=acc.deliveryName||'';
  openModal('profile-modal');
}
async function submitProfileEdit(){
  const name=document.getElementById('profile-name-input').value.trim();
  const email=document.getElementById('profile-email').value.trim();
  const pw=document.getElementById('profile-pw').value;
  const pw2=document.getElementById('profile-pw2').value;
  const errEl=document.getElementById('profile-error');
  errEl.style.display='none';
  if(!name){errEl.style.display='block';errEl.textContent='이름을 입력해주세요.';return;}
  if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){errEl.style.display='block';errEl.textContent='올바른 이메일 형식이 아닙니다.';return;}
  if(pw&&pw.length<6){errEl.style.display='block';errEl.textContent='비밀번호는 6자 이상이어야 합니다.';return;}
  if(pw&&pw!==pw2){errEl.style.display='block';errEl.textContent='비밀번호가 일치하지 않습니다.';return;}
  const accounts=DB.get('accounts',[]);
  const idx=accounts.findIndex(a=>a.id===currentUser.id);
  if(idx===-1)return;
  const deliveryNameInput=document.getElementById('profile-delivery-name');
  const deliveryNameVal=deliveryNameInput?deliveryNameInput.value.trim():'';
  accounts[idx].name=name;
  if(email)accounts[idx].email=email;
  if(pw){
    // Firebase Auth로 비밀번호 변경 (accounts에는 pw 저장 안 함)
    if(!window._fbAuth||!window._fbAuth.currentUser){
      errEl.style.display='block';errEl.textContent='서버 연결 중입니다. 잠시 후 다시 시도해주세요.';return;
    }
    try{
      await window._fbAuth.currentUser.updatePassword(pw);
    }catch(e){
      errEl.style.display='block';
      if(e.code==='auth/requires-recent-login'){
        errEl.textContent='보안을 위해 다시 로그인 후 비밀번호를 변경해주세요.';
      }else{
        errEl.textContent='비밀번호 변경 중 오류가 발생했습니다.';
        console.warn('[Firebase Auth 비밀번호 변경 실패]',e.code,e.message);
      }
      return;
    }
  }
  if(!isAdmin()&&deliveryNameVal!==undefined)accounts[idx].deliveryName=deliveryNameVal;
  DB.set('accounts',accounts);
  currentUser.name=name;
  if(!isAdmin())currentUser.deliveryName=deliveryNameVal;
  DB.set('session',currentUser);
  // 화면 갱신
  document.getElementById('profile-name').textContent=name;
  document.getElementById('dd-name').textContent=name;
  {const _ui=document.getElementById('sb-user-info');_ui.textContent='';const _s=document.createElement('strong');_s.textContent=name;_ui.appendChild(_s);_ui.appendChild(document.createTextNode(isAdmin()?'관리자':'발주자'));}
  const avatarEl=document.getElementById('profile-avatar');
  if(avatarEl)avatarEl.textContent=name.charAt(0);
  closeModal('profile-modal');
  toast('개인정보가 수정되었습니다.','success');
}

// ══ 분리형 날짜 입력 이벤트 ══
document.addEventListener('input',e=>{
  const el=e.target;
  if(!el.classList.contains('date-part'))return;
  // 숫자만 허용
  el.value=el.value.replace(/[^0-9]/g,'');
  // 월 최대 12, 각 maxlength 체크
  const wrap=el.closest('.date-split-wrap');
  if(!wrap)return;
  const prefix=wrap.id.replace('-wrap','');
  if(el.id.endsWith('-m')&&parseInt(el.value)>12)el.value='12';
  if(el.id.endsWith('-d')&&parseInt(el.value)>31)el.value='31';
  // 출고일 날짜 입력 시 미정 상태 해제
  if(prefix==='o-ship-date'){
    const btn=document.getElementById('o-ship-undecided-btn');
    if(btn){btn.style.background='';btn.style.color='';btn.style.borderColor='';}
  }
  // 자리 채우면 다음 칸으로 이동
  if(el.value.length>=parseInt(el.getAttribute('maxlength'))){
    const parts=wrap.querySelectorAll('.date-part');
    const arr=[...parts];
    const idx=arr.indexOf(el);
    if(idx<arr.length-1)arr[idx+1].focus();
  }
  syncDateParts(prefix);
});
document.addEventListener('focus',e=>{
  if(e.target.classList.contains('date-part'))e.target.select();
},true);
// blur 시 syncDateParts 강제 호출 (키보드 입력 후 포커스 이탈 대응)
document.addEventListener('blur',e=>{
  const el=e.target;
  if(!el.classList.contains('date-part'))return;
  const wrap=el.closest('.date-split-wrap');
  if(!wrap)return;
  const prefix=wrap.id.replace('-wrap','');
  syncDateParts(prefix);
},true);
// 달력 선택 버튼
document.addEventListener('click',e=>{
  const btn=e.target.closest('.date-cal-btn');
  if(!btn)return;
  const prefix=btn.dataset.target;
  const cal=document.getElementById(prefix.replace('o-date','o-date-cal').replace('o-ship-date','o-ship-cal'));
  if(cal){cal.showPicker?cal.showPicker():cal.click();}
});
document.addEventListener('change',e=>{
  if(e.target.id==='o-date-cal'){setDateValue('o-date',e.target.value);}
  if(e.target.id==='o-ship-cal'){setDateValue('o-ship-date',e.target.value);}
});
document.addEventListener('blur',e=>{
  if(!e.target.classList.contains('date-input'))return;
  const v=e.target.value;
  if(v&&!/^\d{4}-\d{2}-\d{2}$/.test(v)){
    e.target.style.borderColor='#dc2626';
    e.target.title='YYYY-MM-DD 형식으로 입력해주세요';
  } else {
    e.target.style.borderColor='';
    e.target.title='';
  }
},true);
document.addEventListener('focus',e=>{
  if(!e.target.classList.contains('date-input'))return;
  e.target.style.borderColor='';
  e.target.select();
},true);

function openSidebar(){
  document.getElementById('sidebar').classList.add('open');
  if(isMobile())document.getElementById('sb-overlay').style.display='block';
}
function closeSidebar(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sb-overlay').style.display='none';
}

// 유틸

// 대시보드
function renderDashboard(){
  // 서랍장 재고 현황 (창고별) 카드 전용 CSS — 헤더 보이게 + 표 강제 펼침
  if (!document.getElementById('_card-stock-wh-style')) {
    const s = document.createElement('style');
    s.id = '_card-stock-wh-style';
    s.textContent = `
      /* 모바일 글로벌 변환(display:block, flex tbody) 카드 한정 오버라이드 */
      .card-stock-wh .table-wrap table { display: table !important; table-layout: fixed !important; width: 100% !important; }
      .card-stock-wh .table-wrap thead { display: table-header-group !important; }
      .card-stock-wh .table-wrap tbody { display: table-row-group !important; flex-direction: initial !important; }
      .card-stock-wh .table-wrap tr { display: table-row !important; }
      .card-stock-wh .table-wrap th, .card-stock-wh .table-wrap td { display: table-cell !important; font-size: 12px; padding: 8px 6px; vertical-align: middle; }
      .card-stock-wh .table-wrap th { font-size: 11px; font-weight: 700; }
      .card-stock-wh .table-wrap .td-name { font-size: 13px; text-align: left; }
      .card-stock-wh .table-wrap .td-center { text-align: center !important; }
      /* 컬럼 균등 분배 */
      .card-stock-wh th:nth-child(1), .card-stock-wh td:nth-child(1) { width: 32% !important; }
      .card-stock-wh th:nth-child(2), .card-stock-wh td:nth-child(2) { width: 24% !important; }
      .card-stock-wh th:nth-child(3), .card-stock-wh td:nth-child(3) { width: 22% !important; }
      .card-stock-wh th:nth-child(4), .card-stock-wh td:nth-child(4) { width: 22% !important; }
    `;
    document.head.appendChild(s);
  }
  const items=getItems().filter(i=>i.isActive);
  const drawerItems=items.filter(i=>isTrackStock(i)&&i.drawerType!=='handle');
  const orders=getOrders(),prs=getPRs(),logs=getLogs();
  const today=todayStr();
  // 관리자: 전체, 발주자: 본인 건만 (취소 제외)
  const VALID_ORDER_STATUSES=['임시저장','발주대기','발주확정','출고준비','출고완료','취소','보관','active','cancelled'];
  const visibleOrders=orders.filter(o=>{if(!o||typeof o.status!=='string'||!VALID_ORDER_STATUSES.includes(o.status))return false;if(isAdmin()&&o.status==='임시저장')return false;if(!isAdmin()&&o.createdBy&&currentUser&&o.createdBy!==currentUser.id)return false;if(o.status==='cancelled')return false;return true;});
  const todayOrders=visibleOrders.filter(o=>o.orderDate===today||o.createdAt?.startsWith(today));
  const pendingPRs=prs.filter(p=>p.status==='대기');
  const shortageItems=[...new Set(pendingPRs.map(p=>p.itemId))].length;
  const recentOrders=[...visibleOrders].sort((a,b)=>b.id-a.id).slice(0,5);
  const recentLogs=[...logs].sort((a,b)=>b.id-a.id).slice(0,6);
  // 오늘 출고 목록 (관리자만, 출고완료는 맨 뒤)
  const todayShipOrders=isAdmin()?visibleOrders.filter(o=>
    o.shipDate===today&&o.status!=='취소'&&o.status!=='보관'
  ).sort((a,b)=>(a.status==='출고완료'?1:0)-(b.status==='출고완료'?1:0)):[];

  const el=document.getElementById('content');
  let html=`
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:4px">
      <div class="section-title" style="margin-bottom:0">대시보드</div>
      ${!isAdmin()?`<button onclick="openOrderModal()" style="display:flex;align-items:center;gap:7px;background:var(--primary);color:#fff;border:none;border-radius:var(--r-sm);padding:9px 18px;font-size:14px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0">
        <i class="fas fa-plus"></i> 발주서 등록
      </button>`:''}

    </div>
    <div class="section-sub">오늘의 발주·재고 현황을 확인합니다.</div>
    <div class="grid-4" style="margin-bottom:20px">
      <div class="stat-card" data-nav="orders">
        <div class="stat-icon bg-amber"><i class="fas fa-file-invoice"></i></div>
        <div><span class="stat-num">${todayOrders.length}</span><span class="stat-label">오늘 발주</span></div>
      </div>
      <div class="stat-card" data-nav="purchase-requests">
        <div class="stat-icon bg-green"><i class="fas fa-clipboard-list"></i></div>
        <div><span class="stat-num">${pendingPRs.length}</span><span class="stat-label">발주 필요 대기</span></div>
      </div>
      <div class="stat-card" data-nav="${isAdmin()?'purchase-requests':'shortage-view'}">
        <div class="stat-icon bg-red"><i class="fas fa-triangle-exclamation"></i></div>
        <div><span class="stat-num">${shortageItems}</span><span class="stat-label">부족 품목</span></div>
      </div>`;
  const totalStock=drawerItems.reduce((s,i)=>s+i.currentStock,0);
  // 관리자/발주자 모두 inventory 카드 클릭 → 재고 현황
  // 발주자는 stock-view 페이지로 이동
  const stockNav=isAdmin()?'inventory':'stock-view';
  const siheungStock=drawerItems.reduce((s,i)=>s+(i.stockSiheung!==undefined?i.stockSiheung:i.currentStock),0);
  const pyeongtaekStock=drawerItems.reduce((s,i)=>s+(i.stockPyeongtaek||0),0);
  html+=`<div class="stat-card" data-nav="${stockNav}"><div class="stat-icon bg-blue"><i class="fas fa-boxes-stacked"></i></div><div><span class="stat-num">${siheungStock}</span><span class="stat-label">시흥 재고</span></div></div>`;
  html+=`<div class="stat-card" data-nav="${stockNav}"><div class="stat-icon" style="background:#dcfce7"><i class="fas fa-boxes-stacked" style="color:#065f46"></i></div><div><span class="stat-num">${pyeongtaekStock}</span><span class="stat-label">평택 재고</span></div></div>`;
  html+=`</div><div class="grid-2">`;

  if(isAdmin()&&todayShipOrders.length>0){
    html+=`<div class="card" style="grid-column:1/-1;border-left:4px solid #2563eb">
      <div class="card-header"><h3 style="color:#1e40af"><i class="fas fa-truck-fast" style="margin-right:6px"></i>오늘 출고 목록 <span style="font-size:13px;font-weight:700;background:#dbeafe;color:#1e40af;padding:2px 8px;border-radius:20px;margin-left:6px">${todayShipOrders.length}건</span></h3>
      <button class="btn btn-outline btn-sm" data-nav="orders">전체 보기</button></div>
      <div class="table-wrap"><table class="dash-ship-tbl"><thead><tr>
        <th>납품처</th><th>시공주소</th><th class="td-center">발주자</th><th class="td-center">출고 창고</th><th class="td-center">상태</th>
      </tr></thead><tbody>
      ${todayShipOrders.map(o=>{
        const dTo=o.deliveryTo||o.siteName||'-';
        const addr=o.address||o.customerName||'-';
        const wh=o.warehouse||'시흥';
        const ordererAcc=DB.get('accounts',[]).find(a=>a.id===o.createdBy);
        const ordererName=ordererAcc?ordererAcc.name:'-';
        const whBadge=wh==='평택'
          ?`<span style="background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700">평택</span>`
          :`<span style="background:#dbeafe;color:#1e40af;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700">시흥</span>`;
        return`<tr class="order-row" data-order-id="${o.id}" style="cursor:pointer${o.status==='출고완료'?';opacity:0.5':''}">
          <td class="td-name">${dTo}<span class="mob-sub">${ordererName} · ${addr}</span></td>
          <td class="td-muted" style="font-size:12px">${addr}</td>
          <td class="td-center" style="font-size:12px">${ordererName}</td>
          <td class="td-center">${whBadge}</td>
          <td class="td-center">${orderStatusBadge(o.status)}</td>
        </tr>`;
      }).join('')}
      </tbody></table></div>
    </div>`;
  }else if(isAdmin()){
    html+=`<div class="card" style="grid-column:1/-1;border-left:4px solid #e2e8f0">
      <div class="card-header"><h3 style="color:#64748b"><i class="fas fa-truck-fast" style="margin-right:6px"></i>오늘 출고 목록</h3></div>
      <div class="empty" style="padding:16px"><i class="fas fa-check-circle" style="color:#86efac"></i><p style="color:#64748b">오늘 출고 예정 발주서가 없습니다.</p></div>
    </div>`;
  }

  if(isAdmin()){
    html+=`<div class="card card-stock-wh"><div class="card-header"><h3>관리 품목 재고 현황 (창고별)</h3><button class="btn btn-outline btn-sm" data-nav="inventory">전체보기</button></div>
    <div class="table-wrap"><table><thead><tr><th>품목명</th><th class="td-center">구분</th><th class="td-center" style="color:#1e40af">시흥</th><th class="td-center" style="color:#065f46">평택</th></tr></thead><tbody>
    ${drawerItems.slice(0,6).map(i=>{const s=i.stockSiheung!==undefined?i.stockSiheung:i.currentStock;const p=i.stockPyeongtaek||0;const typeBadge=drawerBadge(i)||`<span class="badge badge-gray" style="font-size:10px">${i.category||'-'}</span>`;return`<tr><td class="td-name">${i.name}</td><td class="td-center">${typeBadge}</td><td class="td-center"><span style="font-weight:700;color:${s===0?'#dc2626':'#1e40af'}">${s}</span></td><td class="td-center"><span style="font-weight:700;color:${p===0?'#dc2626':'#065f46'}">${p}</span></td></tr>`;}).join('')}
    </tbody></table></div></div>`;
  }else{
    // 발주자: +손잡이 제외, 색상별 재고 표시
    const stockViewItems=drawerItems.filter(i=>i.drawerType!=='handle');
    const dashColorRows=stockViewItems.map(item=>{
      const sTotal=item.stockSiheung!==undefined?item.stockSiheung:item.currentStock;
      const pTotal=item.stockPyeongtaek||0;
      const itemBg=(sTotal+pTotal)===0?'background:#fef2f2':(sTotal+pTotal)<=3?'background:#fffbeb':'';
      const colorList=typeof inventoryColorsForItem==='function'?inventoryColorsForItem(item):SHELF_COLORS;
      const colorDetail=colorList.map(color=>{
        const sC=typeof getColorStock==='function'?getColorStock(item.colorStockSiheung||{},color):((item.colorStockSiheung||{})[color]||0);
        const pC=typeof getColorStock==='function'?getColorStock(item.colorStockPyeongtaek||{},color):((item.colorStockPyeongtaek||{})[color]||0);
        const tot=sC+pC;
        return `<tr class="sv-color-row sv-cr-${item.id}" style="display:none;background:#fafafa">
          <td style="padding-left:20px;font-size:11px;color:#374151">
            <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${tot===0?'#e5e7eb':tot<=2?'#fbbf24':'#60a5fa'};margin-right:5px;vertical-align:middle"></span>${color}
          </td>
          <td class="td-center" style="font-size:12px;font-weight:700;color:${sC===0?'#9ca3af':sC<=2?'#d97706':'#1e40af'}">${sC}</td>
          <td class="td-center" style="font-size:12px;font-weight:700;color:${pC===0?'#9ca3af':pC<=2?'#d97706':'#065f46'}">${pC}</td>
          <td class="td-center" style="font-size:12px;font-weight:800;color:${tot===0?'#9ca3af':tot<=2?'#d97706':'#111827'}">${tot}</td>
        </tr>`;
      }).join('');
      return `<tr class="sv-item-row" data-sv-id="${item.id}" style="${itemBg}cursor:pointer" title="클릭해서 색상별 재고 보기">
        <td class="td-name" style="font-weight:800">
          <span class="sv-toggle-icon" data-sv-id="${item.id}" style="font-size:10px;color:#94a3b8;margin-right:6px">▶</span>${item.name}
        </td>
        <td class="td-center" style="font-weight:800;color:${sTotal===0?'#dc2626':'#1e40af'}">${sTotal}</td>
        <td class="td-center" style="font-weight:800;color:${pTotal===0?'#dc2626':'#065f46'}">${pTotal}</td>
        <td class="td-center" style="font-weight:800;color:${(sTotal+pTotal)===0?'#dc2626':'#111827'}">${sTotal+pTotal}</td>
      </tr>${colorDetail}`;
    }).join('');
    html+=`<div class="card"><div class="card-header"><h3><i class="fas fa-boxes-stacked" style="color:var(--primary-light)"></i> 관리 품목 재고 현황</h3><button class="btn btn-outline btn-sm" data-nav="stock-view">전체 보기</button></div>
    <div class="table-wrap"><table><thead><tr><th>품목 / 색상</th><th class="td-center" style="color:#1e40af">시흥</th><th class="td-center" style="color:#065f46">평택</th><th class="td-center">합계</th></tr></thead><tbody>
    ${dashColorRows}
    </tbody></table></div></div>`;
  }

  html+=`<div class="card"><div class="card-header"><h3>최근 발주 내역</h3><button class="btn btn-outline btn-sm" data-nav="orders">전체 보기</button></div>`;
  if(recentOrders.length===0){
    html+=`<div class="empty"><i class="fas fa-file-invoice"></i><p>등록된 발주서가 없습니다.</p></div>`;
  }else{
    html+=`<div class="table-wrap"><table class="dash-recent-tbl"><thead><tr><th>납품처</th><th>발주번호 / 발주일</th><th class="td-center">발주상태</th><th class="td-center">재고</th></tr></thead><tbody>
    ${recentOrders.map(o=>{const hasS=o.items&&o.items.some(i=>i.shortageQty>0);
      const dTo2=o.deliveryTo||o.siteName||'-';
      const region=(o.address||'').split(' ')[0];
      const orderNumDisp=o.orderNum||('#'+o.id);
      const stockBadge=o.status==='임시저장'?'<span class="badge badge-gray" style="font-size:11px">-</span>':(hasS?'<span class="badge badge-red">부족 발생</span>':'<span class="badge badge-done">재고 충분</span>');
      return `<tr class="order-row" data-order-id="${o.id}" style="cursor:pointer"><td class="td-name">${dTo2}${region?`<span style="font-size:11px;color:#94a3b8;margin-left:5px">${region}</span>`:''}</td><td class="td-muted" style="font-size:12px"><div style="font-weight:700;color:#0f172a">${orderNumDisp}</div><div style="color:#94a3b8;font-size:11px">${fmt(o.orderDate)}</div></td><td class="td-center">${orderStatusBadge(o.status)}</td><td class="td-center">${stockBadge}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  }
  html+=`</div>`;

  if(isAdmin()){
    html+=`<div class="card"><div class="card-header"><h3>최근 재고 변동</h3><button class="btn btn-outline btn-sm" onclick="orderTab='inv-hist';navigate('orders')">전체 보기</button></div>`;
    if(recentLogs.length===0){
      html+=`<div class="empty"><i class="fas fa-clock-rotate-left"></i><p>재고 변동 이력이 없습니다.</p></div>`;
    }else{
      html+=`<div class="table-wrap"><table><thead><tr><th>품목명</th><th class="td-center">창고</th><th class="td-center">유형</th><th class="td-center">변동</th><th class="td-center">일시</th></tr></thead><tbody>
      ${recentLogs.map(l=>{const it=getItem(l.itemId);
        // [2026-07-24] 오산 뱃지 추가 (재고 이력 로그가 오산일 수 있음)
        const _wbBg=l.warehouse==='시흥'?'#dbeafe':l.warehouse==='평택'?'#d1fae5':l.warehouse==='오산'?'#fef7ed':'#f3f4f6';
        const _wbFg=l.warehouse==='시흥'?'#1e40af':l.warehouse==='평택'?'#065f46':l.warehouse==='오산'?'#7c2d12':'#6b7280';
        const whBadge=`<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;background:${_wbBg};color:${_wbFg}">${l.warehouse||'-'}</span>`;
        return `<tr><td class="td-name">${it?it.name:'?'}</td><td class="td-center">${l.warehouse?whBadge:'-'}</td><td class="td-center"><span class="badge ${l.type==='입고'?'type-in':l.type==='출고'?'type-out':'type-adj'}">${l.type}</span></td><td class="td-center">${l.beforeStock} → <strong>${l.afterStock}</strong></td><td class="td-center td-muted">${fmtDt(l.createdAt)}</td></tr>`;
      }).join('')}</tbody></table></div>`;
    }
    html+=`</div>`;
  }
  // 출고 예정일 알림 카드 (관리자만)
  const tomorrowStr=(()=>{const d=new Date();d.setDate(d.getDate()+1);return d.toISOString().slice(0,10);})();
  const shipSoonOrders=isAdmin()?visibleOrders.filter(o=>{
    if(!o.shipDate||o.shipDate==='0000-00-00'||o.status==='취소'||o.status==='출고완료'||o.status==='보관')return false;
    return o.shipDate===today||o.shipDate===tomorrowStr||o.shipDate<today;
  }).sort((a,b)=>a.shipDate.localeCompare(b.shipDate)):[];
  if(shipSoonOrders.length>0){
    html+=`<div class="card" style="border-left:4px solid #f59e0b;grid-column:1/-1">
      <div class="card-header" style="padding-bottom:8px">
        <h3 style="color:#92400e"><i class="fas fa-truck" style="margin-right:6px"></i>출고 예정 발주서</h3>
        <button class="btn btn-outline btn-sm" data-nav="orders">전체 보기</button>
      </div>
      <div class="table-wrap"><table><thead><tr>
        <th>납품처</th><th>출고일</th><th class="td-center">상태</th><th class="td-center">출고 시점</th>
      </tr></thead><tbody>
      ${shipSoonOrders.map(o=>{
        const dTo=o.deliveryTo||o.siteName||'-';
        const isToday=o.shipDate===today;
        const isPast=o.shipDate<today;
        const label=isPast?`<span style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700">기간 초과</span>`
          :isToday?`<span style="background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700">오늘</span>`
          :`<span style="background:#fefce8;color:#a16207;border:1px solid #fde047;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700">내일</span>`;
        return`<tr class="order-row" data-order-id="${o.id}" style="cursor:pointer">
          <td class="td-name">${dTo}</td>
          <td class="td-muted">${fmt(o.shipDate)}</td>
          <td class="td-center">${orderStatusBadge(o.status)}</td>
          <td class="td-center">${label}</td>
        </tr>`;
      }).join('')}
      </tbody></table></div>
    </div>`;
  }

  html+=`</div>
  <div style="margin-top:20px;display:flex;gap:10px;flex-wrap:wrap">
    ${!isAdmin()?'<button class="btn btn-primary" id="dash-new-order-btn"><i class="fas fa-plus"></i> 발주서 등록</button>':''}
    ${isAdmin()?'<button class="btn btn-outline" data-nav="inventory"><i class="fas fa-boxes-stacked"></i> 재고 관리</button>':''}
    <button class="btn btn-outline" data-nav="purchase-requests"><i class="fas fa-clipboard-list"></i> 발주 필요 목록</button>
  </div>`;
  el.innerHTML=html;
  const nb=document.getElementById('dash-new-order-btn');
  if(nb)nb.addEventListener('click',openOrderModal);

  // 대시보드 재고 카드 아코디언 이벤트 바인딩
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

// 발주서 목록
let orderTab='list'; // 'list' | 'order-hist' | 'inv-hist' | 'orderer-stats'
let orderListSubTab='active'; // 'active' | 'cancelled' | 'archived'
let orderFilterSite='';
let orderFilterNum='';
let orderFilterAddr='';
let orderFilterCreator='';
let orderFilterStatus='';
let orderFilterLocked='';
let orderFilterDateFrom='';
let orderFilterDateTo='';
let orderShowArchived=false;
let orderFilterShortage=false;
let orderShowDraft=true;
let orderFilterRegion='';
let orderFilterMinAmount='';
let orderFilterMaxAmount='';
let orderFilterMinSize='';
let orderFilterMaxSize='';
let orderFilterOpen=false;

let statsDateFrom='',statsDateTo='',statsSearch='',statsCategory='',statsSort='qty';
function renderUsageStats(){
  if(!requireAdmin())return;
  const orders=getOrders().filter(o=>o.status!=='임시저장'&&o.status!=='취소');
  const statsMap={};
  function addStat(name,cat,qty,orderId,orderDate,shortage){
    if(!name)return;
    const k=name+'__'+cat;
    if(!statsMap[k])statsMap[k]={name,cat,totalQty:0,orderCount:new Set(),shortageCount:0,lastDate:''};
    statsMap[k].totalQty+=qty;
    statsMap[k].orderCount.add(orderId);
    if(shortage>0)statsMap[k].shortageCount+=1;
    if(orderDate&&orderDate>statsMap[k].lastDate)statsMap[k].lastDate=orderDate;
  }
  orders.forEach(o=>{
    const d=o.orderDate||o.createdAt||'';
    if(statsDateFrom&&d.slice(0,10)<statsDateFrom)return;
    if(statsDateTo&&d.slice(0,10)>statsDateTo)return;
    (o.upperMaterials||[]).forEach(r=>addStat(r.name,'상부자재',r.qty||0,o.id,d,0));
    if(o.rod2400Required>0)addStat('옷봉 2400','옷봉',o.rod2400Required,o.id,d,0);
    (o.shelfItems||[]).forEach(si=>(si.entries||[]).forEach(e=>{
      if(si.name==='선반')addStat('선반 '+e.size,'선반',e.qty||0,o.id,d,0);
      else if(si.name==='코너선반')addStat(`코너선반 ${e.width}×${e.height}`,'코너선반',e.qty||0,o.id,d,0);
    }));
    const drawerRows=o.drawerItems||o.items||[];
    drawerRows.forEach(di=>{
      const it=getItem(di.itemId);
      const nm=it?it.name:(di.itemName||'?');
      addStat(nm,'서랍/옵션',di.requiredQty||0,o.id,d,di.shortageQty||0);
    });
  });

  let stats=Object.values(statsMap).map(s=>({...s,orderCount:s.orderCount.size}));
  if(statsSearch)stats=stats.filter(s=>s.name.includes(statsSearch));
  if(statsCategory)stats=stats.filter(s=>s.cat===statsCategory);
  if(statsSort==='qty')stats.sort((a,b)=>b.totalQty-a.totalQty);
  else if(statsSort==='shortage')stats.sort((a,b)=>b.shortageCount-a.shortageCount);
  else if(statsSort==='date')stats.sort((a,b)=>b.lastDate.localeCompare(a.lastDate));

  const totalItems=stats.length;
  const totalQty=stats.reduce((s,r)=>s+r.totalQty,0);
  const shortageItems=stats.filter(r=>r.shortageCount>0).length;
  const cats=['상부자재','옷봉','선반','코너선반','서랍/옵션'];

  // ── 월별 발주 건수 차트 ──
  const monthlyMap={};
  orders.forEach(o=>{
    const d=o.orderDate||o.createdAt||'';
    if(statsDateFrom&&d.slice(0,10)<statsDateFrom)return;
    if(statsDateTo&&d.slice(0,10)>statsDateTo)return;
    const ym=d.slice(0,7);
    if(!ym||ym.length<7)return;
    if(!monthlyMap[ym])monthlyMap[ym]=0;
    monthlyMap[ym]++;
  });
  const monthKeys=Object.keys(monthlyMap).sort().slice(-12);
  const maxMC=Math.max(...monthKeys.map(k=>monthlyMap[k]),1);
  const monthlyChartHtml=monthKeys.length===0
    ?'<div style="text-align:center;color:var(--text-3);padding:28px 0;font-size:13px">데이터 없음</div>'
    :`<div style="display:flex;align-items:flex-end;gap:3px;height:90px">
      ${monthKeys.map(k=>{
        const cnt=monthlyMap[k];
        const h=Math.max(Math.round((cnt/maxMC)*80),4);
        const mm=k.slice(5).replace(/^0/,'');
        return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
          <span style="font-size:10px;color:var(--text-2);font-weight:700;line-height:1">${cnt}</span>
          <div style="width:100%;background:var(--primary);border-radius:3px 3px 0 0;height:${h}px"></div>
          <span style="font-size:10px;color:var(--text-3);line-height:1">${mm}월</span>
        </div>`;
      }).join('')}
    </div>`;

  // ── 발주 빈도 TOP 10 차트 ──
  const top10=[...stats].sort((a,b)=>b.orderCount-a.orderCount).slice(0,10);
  const maxOC=Math.max(...top10.map(s=>s.orderCount),1);
  const top10Html=top10.length===0
    ?'<div style="text-align:center;color:var(--text-3);padding:28px 0;font-size:13px">데이터 없음</div>'
    :top10.map((s,i)=>{
      const pct=Math.round((s.orderCount/maxOC)*100);
      const rankColor=i===0?'#f59e0b':i===1?'#94a3b8':i===2?'#cd7c3a':'var(--text-3)';
      return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px">
        <span style="width:16px;font-size:11px;font-weight:700;color:${rankColor};text-align:right;flex-shrink:0">${i+1}</span>
        <span style="width:90px;font-size:12px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0" title="${s.name}">${s.name}</span>
        <div style="flex:1;background:#e2e8f0;border-radius:3px;height:14px;overflow:hidden">
          <div style="width:${pct}%;background:var(--primary);height:100%;border-radius:3px"></div>
        </div>
        <span style="font-size:12px;font-weight:700;color:var(--text-2);width:24px;text-align:right;flex-shrink:0">${s.orderCount}</span>
      </div>`;
    }).join('');

  const tableHtml=stats.length===0
    ?'<div class="empty"><i class="fas fa-chart-bar"></i><p>통계 데이터가 없습니다.</p></div>'
    :`<div class="table-wrap"><table>
      <thead><tr><th>품목명</th><th>카테고리</th><th class="td-center">총 사용량</th><th class="td-center">발주서 수</th><th class="td-center">부족 발생</th><th class="td-center">최근 사용일</th></tr></thead>
      <tbody>${stats.map(s=>`<tr>
        <td class="td-name">${s.name}</td>
        <td><span class="badge badge-gray">${s.cat}</span></td>
        <td class="td-center" style="font-weight:700">${s.totalQty.toLocaleString()}</td>
        <td class="td-center">${s.orderCount}</td>
        <td class="td-center">${s.shortageCount>0?`<span style="color:#dc2626;font-weight:700">${s.shortageCount}</span>`:'-'}</td>
        <td class="td-center td-muted">${s.lastDate?fmt(s.lastDate):'-'}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;

  document.getElementById('content').innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;gap:12px;flex-wrap:wrap">
      <div><div class="section-title">품목별 사용량 통계</div><div class="section-sub">발주 확정된 발주서 기준으로 품목별 사용량을 집계합니다.</div></div>
      <button class="btn btn-outline btn-sm" onclick="downloadStatsExcel()" style="border:1.5px solid #15803d;color:#15803d;font-weight:700"><i class="fas fa-file-excel"></i> 엑셀 다운로드</button>
    </div>
    <div class="grid-4" style="margin-bottom:18px">
      <div class="stat-card"><div class="stat-icon bg-blue"><i class="fas fa-boxes-stacked"></i></div><div><span class="stat-num">${totalItems}</span><span class="stat-label">집계 품목 수</span></div></div>
      <div class="stat-card"><div class="stat-icon bg-green"><i class="fas fa-calculator"></i></div><div><span class="stat-num">${totalQty.toLocaleString()}</span><span class="stat-label">총 사용 수량</span></div></div>
      <div class="stat-card"><div class="stat-icon bg-red"><i class="fas fa-triangle-exclamation"></i></div><div><span class="stat-num">${shortageItems}</span><span class="stat-label">부족 발생 품목</span></div></div>
    </div>
    <!-- 차트 영역 -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:18px">
      <div class="card" style="padding:16px">
        <div style="font-size:13px;font-weight:800;color:var(--text);margin-bottom:14px"><i class="fas fa-chart-column" style="margin-right:6px;color:var(--primary)"></i>월별 발주 건수</div>
        ${monthlyChartHtml}
      </div>
      <div class="card" style="padding:16px">
        <div style="font-size:13px;font-weight:800;color:var(--text);margin-bottom:14px"><i class="fas fa-ranking-star" style="margin-right:6px;color:var(--primary)"></i>발주 빈도 TOP 10</div>
        ${top10Html}
      </div>
    </div>
    <div class="filter-bar" style="margin-bottom:14px">
      <input class="form-input" id="stats-search" placeholder="품목명 검색" value="${statsSearch}" style="max-width:180px"/>
      <select class="form-input" id="stats-cat" style="max-width:140px">
        <option value="">전체 카테고리</option>
        ${cats.map(c=>`<option value="${c}"${statsCategory===c?' selected':''}>${c}</option>`).join('')}
      </select>
      <select class="form-input" id="stats-sort" style="max-width:150px">
        <option value="qty"${statsSort==='qty'?' selected':''}>사용량 많은 순</option>
        <option value="shortage"${statsSort==='shortage'?' selected':''}>부족 빈도 순</option>
        <option value="date"${statsSort==='date'?' selected':''}>최근 사용일 순</option>
      </select>
      <input type="date" class="form-input" id="stats-from" value="${statsDateFrom}" style="max-width:140px" placeholder="시작일"/>
      <input type="date" class="form-input" id="stats-to" value="${statsDateTo}" style="max-width:140px" placeholder="종료일"/>
      <button class="btn btn-outline btn-sm" onclick="statsDateFrom='';statsDateTo='';statsSearch='';statsCategory='';statsSort='qty';renderUsageStats()">초기화</button>
      <span style="font-size:12px;color:var(--text-3)">총 ${stats.length}개 품목</span>
    </div>
    <div class="card">${tableHtml}</div>`;
  document.getElementById('stats-search').addEventListener('input',e=>{statsSearch=e.target.value;renderUsageStats();});
  document.getElementById('stats-cat').addEventListener('change',e=>{statsCategory=e.target.value;renderUsageStats();});
  document.getElementById('stats-sort').addEventListener('change',e=>{statsSort=e.target.value;renderUsageStats();});
  document.getElementById('stats-from').addEventListener('change',e=>{statsDateFrom=e.target.value;renderUsageStats();});
  document.getElementById('stats-to').addEventListener('change',e=>{statsDateTo=e.target.value;renderUsageStats();});
}

function downloadStatsExcel(){
  if(typeof XLSX==='undefined'){toast('엑셀 라이브러리를 불러오는 중입니다.','error');return;}
  const orders=getOrders().filter(o=>o.status!=='임시저장'&&o.status!=='취소');
  const statsMap={};
  function addStat(name,cat,qty,orderId,orderDate,shortage){
    if(!name)return;
    const k=name+'__'+cat;
    if(!statsMap[k])statsMap[k]={name,cat,totalQty:0,orderCount:new Set(),shortageCount:0,lastDate:''};
    statsMap[k].totalQty+=qty;statsMap[k].orderCount.add(orderId);
    if(shortage>0)statsMap[k].shortageCount+=1;
    if(orderDate&&orderDate>statsMap[k].lastDate)statsMap[k].lastDate=orderDate;
  }
  orders.forEach(o=>{
    const d=o.orderDate||o.createdAt||'';
    (o.upperMaterials||[]).forEach(r=>addStat(r.name,'상부자재',r.qty||0,o.id,d,0));
    if(o.rod2400Required>0)addStat('옷봉 2400','옷봉',o.rod2400Required,o.id,d,0);
    (o.shelfItems||[]).forEach(si=>(si.entries||[]).forEach(e=>{
      if(si.name==='선반')addStat('선반 '+e.size,'선반',e.qty||0,o.id,d,0);
      else if(si.name==='코너선반')addStat(`코너선반 ${e.width}×${e.height}`,'코너선반',e.qty||0,o.id,d,0);
    }));
    const drawerRows=o.drawerItems||o.items||[];
    drawerRows.forEach(di=>{const it=getItem(di.itemId);addStat(it?it.name:'?','서랍/옵션',di.requiredQty||0,o.id,d,di.shortageQty||0);});
  });
  const rows=[['품목명','카테고리','총 사용량','발주서 수','부족 발생 횟수','최근 사용일']];
  Object.values(statsMap).sort((a,b)=>b.totalQty-a.totalQty).forEach(s=>{
    rows.push([s.name,s.cat,s.totalQty,s.orderCount.size,s.shortageCount,s.lastDate||'']);
  });
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),'사용량통계');
  xlsxDownload(wb,`사용량통계_${xlsxDate()}.xlsx`);
}


// 이카운트 IP 모니터 관련 함수 제거됨 (2026-06-11)

let priceSettingsSearch='',priceSettingsOnlyNull=false;
function renderPriceSettings(){
  if(!requireAdmin())return;
  getPriceSettings();
  const allItems=getPriceSettings().filter(i=>!PRICE_HIDDEN.has(i.name));
  const cats=['상부자재','옷봉','선반','코너선반','서랍/옵션'];

  // 검색 필터
  let filtered=allItems;
  if(priceSettingsSearch) filtered=filtered.filter(i=>(PRICE_DISPLAY_LABEL[i.name]||i.name).includes(priceSettingsSearch));
  if(priceSettingsOnlyNull) filtered=filtered.filter(i=>i.price===null||i.price===undefined);

  // 카테고리별 섹션 렌더링
  const sectionsHtml = cats.map(cat=>{
    const catItems = filtered.filter(i=>i.category===cat);
    if(!catItems.length) return '';
    const rows = catItems.map(item=>{
      const label = PRICE_DISPLAY_LABEL[item.name] || item.name;
      const priceStr = item.price===null||item.price===undefined ? '미정' : item.price.toLocaleString()+'원';
      const priceColor = item.price===null ? 'var(--text-3)' : 'var(--text)';
      const delBtn=item.isCustom?`<button class="btn btn-xs price-del-btn" data-name="${item.name}" style="background:#fee2e2;color:#dc2626;border:1px solid #fca5a5" title="삭제"><i class="fas fa-trash"></i></button>`:'';
      return `<tr class="price-row" data-price-name="${item.name}">
        <td class="td-name price-td-name">${label}${item.isCustom?'<span style="margin-left:6px;font-size:10px;background:#dbeafe;color:#1d4ed8;padding:1px 5px;border-radius:3px;font-weight:600">추가</span>':''}</td>
        <td class="td-center price-td-cur" style="font-weight:700;color:${priceColor}">${priceStr}</td>
        <td class="td-center price-td-input"><input type="number" class="form-input price-edit-input" data-name="${item.name}" value="${item.price===null||item.price===undefined?'':item.price}" placeholder="미정" style="width:120px;text-align:right;padding:5px 8px"/></td>
        <td class="td-center price-td-btn"><div style="display:flex;gap:4px;justify-content:center;align-items:center"><button class="btn btn-outline btn-xs price-save-one-btn" data-name="${item.name}" style="border-color:#3b82f6;color:#1e40af">저장</button>${delBtn}</div></td>
      </tr>`;
    }).join('');
    return `
      <div class="card" style="margin-bottom:14px;overflow:hidden">
        <div style="background:#1e3a5f;color:#fff;padding:10px 16px;font-size:13px;font-weight:700;letter-spacing:.3px">
          ${cat}
        </div>
        <div class="table-wrap" style="margin:0">
          <table>
            <thead><tr><th>품목명 / 규격</th><th class="td-center">현재 단가</th><th class="td-center" style="min-width:140px">수정 단가</th><th class="td-center">저장</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');

  document.getElementById('content').innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;gap:12px;flex-wrap:wrap">
      <div><div class="section-title">단가 관리</div><div class="section-sub">발주 등록 시 자동 적용되는 단가표를 관리합니다.</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-outline btn-sm" onclick="saveAllPrices()" style="border-color:#1e40af;color:#1e40af;font-weight:700"><i class="fas fa-floppy-disk"></i> 전체 저장</button>
        <button class="btn btn-outline btn-sm" onclick="restoreDefaultPrices()" style="border-color:#92400e;color:#92400e;font-weight:700"><i class="fas fa-rotate-left"></i> 기본값 복원</button>
      </div>
    </div>
    <div class="filter-bar" style="margin-bottom:16px">
      <input class="form-input" id="ps-search" placeholder="품목명 검색" value="${priceSettingsSearch}" style="max-width:200px"/>
      <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer">
        <input type="checkbox" id="ps-only-null" ${priceSettingsOnlyNull?'checked':''}> 미정만 보기
      </label>
      <span style="font-size:12px;color:var(--text-3)">총 ${filtered.length}개</span>
    </div>
    ${sectionsHtml}`;

  document.getElementById('ps-search').addEventListener('input',e=>{priceSettingsSearch=e.target.value;renderPriceSettings();});
  document.getElementById('ps-only-null').addEventListener('change',e=>{priceSettingsOnlyNull=e.target.checked;renderPriceSettings();});

  document.querySelectorAll('.price-save-one-btn').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const name=btn.dataset.name;
      const inp=document.querySelector(`.price-edit-input[data-name="${name}"]`);
      if(!inp)return;
      const val=inp.value.trim();
      const price=val===''?null:parseInt(val);
      if(val!==''&&(isNaN(price)||price<0)){toast('단가는 0 이상의 숫자 또는 빈칸(미정)으로 입력해주세요.','error');return;}
      const ps=getPriceSettings();
      const idx=ps.findIndex(p=>p.name===name);
      if(idx!==-1)ps[idx].price=price;
      DB.set('price_settings',ps);
      toast(`${PRICE_DISPLAY_LABEL[name]||name} 단가가 저장되었습니다.`,'success');
      renderPriceSettings();
    });
  });

  document.querySelectorAll('.price-del-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const name=btn.dataset.name;
      if(!confirm(`"${name}" 품목을 삭제할까요?`))return;
      const ps=getPriceSettings().filter(p=>p.name!==name);
      DB.set('price_settings',ps);
      toast(`"${name}" 품목이 삭제되었습니다.`,'success');
      renderPriceSettings();
    });
  });
}

function saveAllPrices(){
  const ps=getPriceSettings();
  document.querySelectorAll('.price-edit-input').forEach(inp=>{
    const name=inp.dataset.name;
    const val=inp.value.trim();
    const price=val===''?null:parseInt(val);
    if(val!==''&&(isNaN(price)||price<0))return;
    const idx=ps.findIndex(p=>p.name===name);
    if(idx!==-1)ps[idx].price=price;
  });
  DB.set('price_settings',ps);
  toast('단가표 전체가 저장되었습니다.','success');
  renderPriceSettings();
}

function restoreDefaultPrices(){
  if(!confirm('기본 단가표로 복원할까요? 수정한 단가는 모두 초기화됩니다.'))return;
  DB.set('price_settings',getDefaultPrices());
  toast('기본 단가표로 복원되었습니다.','success');
  renderPriceSettings();
}

function openAddPriceItemModal(){
  const cats=['상부자재','옷봉','선반','코너선반','서랍/옵션'];
  const overlay=document.createElement('div');
  overlay.className='modal-overlay open';
  overlay.innerHTML=`
    <div class="modal" style="max-width:400px;width:92%">
      <div class="modal-header">
        <div class="modal-title"><i class="fas fa-plus" style="margin-right:6px"></i>품목 추가</div>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:14px;padding:20px">
        <div>
          <label class="form-label">품목명 <span style="color:#dc2626">*</span></label>
          <input id="add-price-name" class="form-input" placeholder="예: 특수 브래킷" style="width:100%"/>
        </div>
        <div>
          <label class="form-label">카테고리 <span style="color:#dc2626">*</span></label>
          <select id="add-price-cat" class="form-input" style="width:100%">
            ${cats.map(c=>`<option value="${c}">${c}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="form-label">단가 (원)</label>
          <input id="add-price-val" type="number" class="form-input" placeholder="비워두면 미정" style="width:100%;text-align:right"/>
        </div>
      </div>
      <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end;padding:12px 20px">
        <button class="btn btn-outline btn-sm" onclick="this.closest('.modal-overlay').remove()">취소</button>
        <button class="btn btn-sm" id="add-price-confirm" style="background:#1e3a5f;color:#fff;font-weight:700">추가</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById('add-price-name').focus();

  document.getElementById('add-price-confirm').addEventListener('click',()=>{
    const name=document.getElementById('add-price-name').value.trim();
    const cat=document.getElementById('add-price-cat').value;
    const val=document.getElementById('add-price-val').value.trim();
    if(!name){toast('품목명을 입력해주세요.','error');return;}
    const price=val===''?null:parseInt(val);
    if(val!==''&&(isNaN(price)||price<0)){toast('단가는 0 이상의 숫자 또는 빈칸(미정)으로 입력해주세요.','error');return;}
    const ps=getPriceSettings();
    if(ps.find(p=>p.name===name)){toast('이미 같은 이름의 품목이 있습니다.','error');return;}
    ps.push({name,category:cat,price,isCustom:true});
    DB.set('price_settings',ps);
    overlay.remove();
    toast(`"${name}" 품목이 추가되었습니다.`,'success');
    renderPriceSettings();
  });
}

/**
 * map의 key도 normalizeName() 처리해서 비교
 * → "포스트바 2050" 원본 키를 "포스트바2050"으로 정규화한 뒤 매칭
 */

/**
 * 품목명으로 단가 반환. 없으면 null(미정).
 * 조회 순서: DRAWER_OPTION_PRICES → PRICE_MAP → 선반 규격 매핑
 * key와 name 모두 normalizeName() 후 비교 → 공백 불일치 버그 해소
 */

/** 코너선반 단가: 780×585 이하면 코너선반 780 단가, 초과면 코너선반 비규격 단가 */

/** 금액 포맷: 12345 → "12,345원" */

/** 부가세 계산 (공급가액의 10%, 원단위 반올림) */

/** 행별 금액 계산 반환 */

/** 발주서 전체 금액 요약 계산 (상세보기/인쇄/엑셀 공통) */

/** 공급가액 셀 HTML */

/** 금액 셀 HTML (검은색, 굵게, 크게) — 하위 호환용 유지 */

/** 단가 셀 표시 HTML */

/** 발주 등록 모달 전체 합계 재계산 후 표시 */

// 상부자재 한 행의 금액 셀 갱신 (수량 변경 시 호출)

// 서랍/옵션 한 행의 금액 셀 갱신

// 상부자재 색상 목록
// [3] 선반: 직접입력, 코너선반: 행 추가형
// 코너선반만 SHELF_SIZES 유지 (addShelfEntry 로직 재사용)
// 선반/코너선반 색상 목록

// 코너선반 행 상태 저장

// ─ 코너선반 행 렌더링 ─

// ─ 코너선반 행 추가 ─

// ─ 옷봉 행 상태 ─

// ─ 옷봉 2400 필요 개수 계산 (절단 최적화) ─

// ─ 옷봉 결과 표시 ─

// ─ 옷봉 행 렌더링 ─

// ─ 옷봉 행 추가 ─

// ══ 모바일 입력 UX ══
(function setupMobileInputUX(){

  // ── 1) 숫자 input focus 시 전체 선택 ──
  document.addEventListener('focus', e=>{
    const el=e.target;
    if(el.tagName!=='INPUT') return;
    if(el.type==='number'||el.inputMode==='numeric'||el.getAttribute('inputmode')==='numeric'){
      // 약간 지연 후 select (모바일 호환)
      setTimeout(()=>{ try{ el.select(); }catch(_){} }, 50);
    }
  }, true);

  // ── 2) 입력 칸 focus 시 스크롤로 보이게 ──
  document.addEventListener('focus', e=>{
    const el=e.target;
    if(!el.closest('#order-modal')) return;
    setTimeout(()=>{
      el.scrollIntoView({block:'nearest', behavior:'smooth'});
    }, 150);
  }, true);

  // ── 3) 옷봉 Enter 흐름: 규격→수량, 수량→추가 ──
  document.addEventListener('keydown', e=>{
    if(e.key!=='Enter') return;
    const id=e.target.id;
    if(id==='rod-size'){
      e.preventDefault();
      const qEl=document.getElementById('rod-qty');
      if(qEl){qEl.focus();qEl.select();}
    } else if(id==='rod-qty'){
      e.preventDefault();
      const v=parseInt(e.target.value)||0;
      const s=parseInt(document.getElementById('rod-size')?.value||'');
      if(!isNaN(s)&&s>0&&v>0) addRodRow();
    }
  });

  // ── 4) 선반 Enter 흐름: 규격→수량, 수량→추가 ──
  document.addEventListener('keydown', e=>{
    if(e.key!=='Enter') return;
    const id=e.target.id;
    if(id==='shelf-size'){
      e.preventDefault();
      const qEl=document.getElementById('shelf-qty');
      if(qEl){qEl.focus();qEl.select();}
    } else if(id==='shelf-qty'){
      e.preventDefault();
      const v=parseInt(e.target.value)||0;
      const s=document.getElementById('shelf-size')?.value.trim();
      if(s&&v>0) addShelfRow();
    }
  });

  // ── 5) 코너선반 Enter 흐름: 가로→세로→수량→추가 ──
  document.addEventListener('keydown', e=>{
    if(e.key!=='Enter') return;
    const id=e.target.id;
    if(id==='corner-width'){
      e.preventDefault();
      const hEl=document.getElementById('corner-height');
      if(hEl){hEl.focus();hEl.select();}
    } else if(id==='corner-height'){
      e.preventDefault();
      const qEl=document.getElementById('corner-qty');
      if(qEl){qEl.focus();qEl.select();}
    } else if(id==='corner-qty'){
      e.preventDefault();
      const v=parseInt(e.target.value)||0;
      const w=document.getElementById('corner-width')?.value.trim();
      const h=document.getElementById('corner-height')?.value.trim();
      if(w&&h&&v>0) addCornerRow();
    }
  });

  // ── 6) 스텝퍼 input — 모바일에서 빠른 연속 입력 보정 ──
  document.addEventListener('focus', e=>{
    const el=e.target;
    if(!el.classList.contains('upper-qty')&&!el.classList.contains('drawer-qty')) return;
    setTimeout(()=>{ try{ el.select(); }catch(_){} }, 30);
  }, true);

})();

// 스텝퍼 HTML 생성

// ─ 선반 행 상태 ─
// ─ 상부 자재 행 상태 ─
// ─ 상부 자재: 고정 품목 테이블 + 공통 색상 방식 ─
// DOM에서 직접 수집하므로 별도 상태 배열 불필요

// 상부자재 고정 품목 테이블 렌더링

// ─ 선반 행 렌더링 ─

// ─ 선반 행 추가 ─

// 규격선택 변경 시 직접입력 토글 (코너선반용, 하위 호환)

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

// ── 재고 기록 페이지 (관리자 전용) ──

// 페이지네이션 HTML 생성 헬퍼

// 재고 관리 (관리자·서랍장만)
// [2026-07-24] Enter 키 리스너 중복 제거 — inventory.js L824가 소유. 이 라인은 5월 파일 분할 시 남은 잔여로 판단
// 유지 시 재고 2배 반영 위험 (adversarial-tester + code-bug-fixer 공통 확인)

// 이력 조회
let histTab='orders',histSite='',histItem='',histType='',histFrom='',histTo='';
function renderHistory(){
  document.getElementById('content').innerHTML=`
    <div class="section-title">이력 조회</div>
    <div class="section-sub">발주 이력과 재고 변동 이력을 조회합니다.</div>
    <div style="display:flex;border-bottom:2px solid var(--border);margin-bottom:16px">
      <button class="btn btn-ghost hist-tab" data-hist-tab="orders" style="border-radius:0">발주 이력</button>
      ${isAdmin()?'<button class="btn btn-ghost hist-tab" data-hist-tab="inventory" style="border-radius:0">재고 변동 이력</button>':''}
      ${isAdmin()?'<button class="btn btn-ghost hist-tab" data-hist-tab="orderer-stats" style="border-radius:0">발주자별 현황</button>':''}
    </div>
    <div class="filter-bar" id="hist-filter-bar"></div>
    <div id="hist-content"></div>`;
  updateHistTabs();
  renderHistoryContent();
}

function updateHistTabs(){
  document.querySelectorAll('.hist-tab').forEach(btn=>{
    const t=btn.dataset.histTab;
    btn.style.borderBottom=histTab===t?'2px solid var(--primary-light)':'2px solid transparent';
    btn.style.color=histTab===t?'var(--primary)':'var(--text-2)';
  });
}

function renderHistoryContent(){
  const fb=document.getElementById('hist-filter-bar');
  const c=document.getElementById('hist-content');
  if(!fb||!c)return;
  if(histTab==='orders'){
    fb.innerHTML=`
      <input class="form-input" placeholder="현장명 검색" id="hist-site-input" value="${histSite}" style="max-width:180px"/>
      <input class="form-input" type="date" id="hist-from-input" value="${histFrom}"/>
      <span style="color:var(--text-3)">~</span>
      <input class="form-input" type="date" id="hist-to-input" value="${histTo}"/>
      <button class="btn btn-outline btn-sm" id="hist-reset-btn">초기화</button>`;
    document.getElementById('hist-site-input').addEventListener('input',e=>{histSite=e.target.value;renderHistoryContent();});
    document.getElementById('hist-from-input').addEventListener('input',e=>{histFrom=e.target.value;renderHistoryContent();});
    document.getElementById('hist-to-input').addEventListener('input',e=>{histTo=e.target.value;renderHistoryContent();});
    document.getElementById('hist-reset-btn').addEventListener('click',()=>{histSite='';histFrom='';histTo='';renderHistoryContent();});
    let orders=getOrders().filter(o=>isAdmin()||(o.createdBy===currentUser.id)||!o.createdBy).sort((a,b)=>b.id-a.id);
    if(histSite)orders=orders.filter(o=>(o.siteName||o.deliveryTo||'').includes(histSite));
    if(histFrom)orders=orders.filter(o=>o.orderDate>=histFrom);
    if(histTo)orders=orders.filter(o=>o.orderDate<=histTo);
    let tbl='';
    if(orders.length===0){tbl='<div class="empty"><i class="fas fa-file-invoice"></i><p>이력이 없습니다.</p></div>';}
    else{
      tbl=`<div class="table-wrap"><table><thead><tr><th>#</th><th>납품처</th><th>시공주소</th><th>발주일</th><th class="td-center">품목 수</th><th class="td-center">부족 발생</th><th class="td-center">등록일시</th><th class="td-center"></th></tr></thead><tbody>
      ${orders.map(o=>{const hasS=o.items&&o.items.some(i=>i.shortageQty>0);
        const dTo3=o.deliveryTo||o.siteName||'-';const addr3=o.address||o.customerName||'-';return`<tr><td class="td-muted">#${o.id}</td><td class="td-name">${dTo3}</td><td class="td-muted" style="font-size:12px">${addr3}</td><td class="td-muted">${fmt(o.orderDate)}</td><td class="td-center">${o.items?o.items.length:0}</td><td class="td-center">${hasS?'<span class="badge badge-red">있음</span>':'<span class="badge badge-done">없음</span>'}</td><td class="td-center td-muted">${fmtDt(o.createdAt)}</td><td class="td-center"><button class="btn btn-ghost btn-xs order-detail-btn" data-order-id="${o.id}"><i class="fas fa-eye"></i></button></td></tr>`;
      }).join('')}</tbody></table></div>`;
    }
    c.innerHTML=`<div class="card"><div class="card-header"><h3>발주 이력 <span style="font-weight:400;color:var(--text-3)">(${orders.length}건)</span></h3></div>${tbl}</div>`;
  }else{
    fb.innerHTML=`
      <input class="form-input" placeholder="품목명 검색" id="hist-item-input" value="${histItem}" style="max-width:180px"/>
      <select class="form-input" id="hist-type-select" style="max-width:120px">
        <option value="">전체 유형</option>
        <option value="입고"${histType==='입고'?' selected':''}>입고</option>
        <option value="출고"${histType==='출고'?' selected':''}>출고</option>
        <option value="조정"${histType==='조정'?' selected':''}>조정</option>
      </select>
      <input class="form-input" type="date" id="hist-from-input" value="${histFrom}"/>
      <span style="color:var(--text-3)">~</span>
      <input class="form-input" type="date" id="hist-to-input" value="${histTo}"/>
      <button class="btn btn-outline btn-sm" id="hist-reset-btn">초기화</button>`;
    document.getElementById('hist-item-input').addEventListener('input',e=>{histItem=e.target.value;renderHistoryContent();});
    document.getElementById('hist-type-select').addEventListener('change',e=>{histType=e.target.value;renderHistoryContent();});
    document.getElementById('hist-from-input').addEventListener('input',e=>{histFrom=e.target.value;renderHistoryContent();});
    document.getElementById('hist-to-input').addEventListener('input',e=>{histTo=e.target.value;renderHistoryContent();});
    document.getElementById('hist-reset-btn').addEventListener('click',()=>{histItem='';histType='';histFrom='';histTo='';renderHistoryContent();});
    let logs=getLogs().sort((a,b)=>b.id-a.id);
    if(histItem)logs=logs.filter(l=>{const it=getItem(l.itemId);return it&&it.name.includes(histItem);});
    if(histType)logs=logs.filter(l=>l.type===histType);
    if(histFrom)logs=logs.filter(l=>l.createdAt.split('T')[0]>=histFrom);
    if(histTo)logs=logs.filter(l=>l.createdAt.split('T')[0]<=histTo);
    let tbl='';
    if(logs.length===0){tbl='<div class="empty"><i class="fas fa-clock-rotate-left"></i><p>이력이 없습니다.</p></div>';}
    else{
      tbl=`<div class="table-wrap"><table><thead><tr><th>품목명</th><th class="td-center">유형</th><th class="td-center">변동 전</th><th class="td-center">변동 후</th><th>메모</th><th class="td-center">일시</th></tr></thead><tbody>
      ${logs.map(l=>{const it=getItem(l.itemId);
        return`<tr><td class="td-name">${it?it.name:'?'}</td><td class="td-center"><span class="badge ${l.type==='입고'?'type-in':l.type==='출고'?'type-out':'type-adj'}">${l.type}</span></td><td class="td-center td-muted">${l.beforeStock}</td><td class="td-center"><strong>${l.afterStock}</strong></td><td class="td-muted">${l.memo||'-'}</td><td class="td-center td-muted">${fmtDt(l.createdAt)}</td></tr>`;
      }).join('')}</tbody></table></div>`;
    }
    c.innerHTML=`<div class="card"><div class="card-header"><h3>재고 변동 이력 <span style="font-weight:400;color:var(--text-3)">(${logs.length}건)</span></h3></div>${tbl}</div>`;
  }
  if(histTab==='orderer-stats'){
    fb.innerHTML='';
    const accounts=DB.get('accounts',[]).filter(a=>a.role!=='admin');
    const orders=getOrders().filter(o=>o.status!=='취소'&&o.status!=='보관');
    // 발주자별 집계
    const statsMap={};
    accounts.forEach(a=>{statsMap[a.id]={name:a.name||a.id,total:0,waiting:0,confirmed:0,shipped:0,amount:0,lastDate:''};});
    orders.forEach(o=>{
      const uid=o.createdBy;
      if(!uid)return;
      if(!statsMap[uid])statsMap[uid]={name:uid,total:0,waiting:0,confirmed:0,shipped:0,amount:0,lastDate:''};
      statsMap[uid].total++;
      if(o.status==='발주대기')statsMap[uid].waiting++;
      else if(o.status==='발주확정')statsMap[uid].confirmed++;
      else if(o.status==='출고준비'||o.status==='출고완료')statsMap[uid].shipped++;
      const amt=typeof o.totalAmount==='number'?o.totalAmount:parseInt((String(o.totalAmount||'')).replace(/[^0-9]/g,''))||0;
      statsMap[uid].amount+=amt;
      if(!statsMap[uid].lastDate||o.orderDate>statsMap[uid].lastDate)statsMap[uid].lastDate=o.orderDate;
    });
    const statsList=Object.values(statsMap).filter(s=>s.total>0||accounts.find(a=>a.name===s.name));
    let tbl='';
    if(statsList.length===0){tbl='<div class="empty"><i class="fas fa-users"></i><p>발주자 데이터가 없습니다.</p></div>';}
    else{
      tbl=`<div class="table-wrap"><table><thead><tr>
        <th>발주자</th>
        <th class="td-center">총 발주</th>
        <th class="td-center">출고대기</th>
        <th class="td-center">출고확정</th>
        <th class="td-center">출고</th>
        <th class="td-center">누적 금액</th>
        <th class="td-center">최근 발주일</th>
      </tr></thead><tbody>
      ${statsList.sort((a,b)=>b.total-a.total).map(s=>`<tr>
        <td class="td-name">${s.name}</td>
        <td class="td-center"><span style="font-weight:700">${s.total}</span></td>
        <td class="td-center">${s.waiting>0?`<span style="background:#fefce8;color:#a16207;border:1px solid #fde047;padding:2px 8px;border-radius:20px;font-size:12px;font-weight:700">${s.waiting}</span>`:'<span style="color:var(--text-3)">0</span>'}</td>
        <td class="td-center">${s.confirmed>0?`<span style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;padding:2px 8px;border-radius:20px;font-size:12px;font-weight:700">${s.confirmed}</span>`:'<span style="color:var(--text-3)">0</span>'}</td>
        <td class="td-center">${s.shipped>0?`<span style="background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0;padding:2px 8px;border-radius:20px;font-size:12px;font-weight:700">${s.shipped}</span>`:'<span style="color:var(--text-3)">0</span>'}</td>
        <td class="td-center" style="font-weight:700">${s.amount>0?s.amount.toLocaleString()+'원':'-'}</td>
        <td class="td-center td-muted">${s.lastDate?fmt(s.lastDate):'-'}</td>
      </tr>`).join('')}</tbody></table></div>`;
    }
    c.innerHTML=`<div class="card"><div class="card-header"><h3>발주자별 현황</h3></div>${tbl}</div>`;
  }
}

function _renderLedgerPanelHTML(){
  return `
    <style>
      .ledger-scope .data-card { background:#fff; border:1px solid var(--border); border-radius:var(--r); padding:16px 18px; margin-bottom:16px; }
      .ledger-scope table { width:100%; border-collapse:collapse; font-size:13px; }
      .ledger-scope th { background:#f9fafb; padding:10px 12px; text-align:left; border-bottom:2px solid var(--border); font-size:12px; font-weight:700; color:var(--text-2); }
      .ledger-scope td { padding:10px 12px; border-bottom:1px solid var(--border); }
      .ledger-scope td.num, .ledger-scope th.num { text-align:right; font-variant-numeric:tabular-nums; }
      .ledger-scope td.center, .ledger-scope th.center { text-align:center; }
      .ledger-scope tr.paid { cursor:pointer; }
      .ledger-scope tr.paid:hover { background:#f0fdf4; }
      .ledger-scope .btn-view { background:var(--primary); color:#fff; border:none; padding:6px 14px; border-radius:var(--r-sm); font-size:12px; font-weight:700; cursor:pointer; white-space:nowrap; }
      /* 모바일: 거래처 행을 카드형으로 (버튼 아래로) */
      @media (max-width: 768px) {
        .ledger-scope #tbody-customers tr.paid {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 6px 12px;
          padding: 12px 14px;
          margin-bottom: 10px;
          background: #fff;
          border: 1px solid var(--border);
          border-radius: 10px;
          box-shadow: 0 1px 2px rgba(0,0,0,0.04);
        }
        .ledger-scope #tbody-customers tr.paid td {
          display: block;
          padding: 0 !important;
          border: none !important;
        }
        /* 납품처: 좌상단 굵게 */
        .ledger-scope #tbody-customers tr.paid td:nth-child(1) {
          grid-column: 1 / -1; grid-row: 1; font-size: 14px; font-weight: 700;
        }
        /* 건수 td 자체는 숨김 (가격 셀의 ::after로 표시) */
        .ledger-scope #tbody-customers tr.paid td:nth-child(2) {
          display: none;
        }
        /* 총 출고금액 + 건수: 좌하단, 좌측 정렬 */
        .ledger-scope #tbody-customers tr.paid td:nth-child(3) {
          grid-column: 1; grid-row: 2;
          font-size: 16px; font-weight: 800; color: #1e40af;
          text-align: left;
          display: flex; align-items: baseline; gap: 6px;
        }
        .ledger-scope #tbody-customers tr.paid td:nth-child(3)::after {
          content: "/ " attr(data-count) "건";
          font-size: 11px; font-weight: 500; color: var(--text-3);
        }
        /* 원장 보기 버튼: 우하단 */
        .ledger-scope #tbody-customers tr.paid td:nth-child(4) {
          grid-column: 2; grid-row: 2;
          align-self: center;
        }
        /* 거래처 표 헤더 숨김 (카드 안 컬럼이 직관적) */
        .ledger-scope table thead { display: none; }
      }
      .ledger-scope .btn-back { background:#fff; color:var(--text-2); border:1px solid var(--border); padding:7px 14px; border-radius:var(--r-sm); font-size:13px; font-weight:600; cursor:pointer; }
      .ledger-scope .btn-add-payment,
      .ledger-scope .btn-save-payment { background:#15803d; color:#fff; border:none; padding:8px 16px; border-radius:var(--r-sm); font-size:13px; font-weight:700; cursor:pointer; }
      .ledger-scope .btn-print { background:#475569; color:#fff; border:none; padding:8px 16px; border-radius:var(--r-sm); font-size:13px; font-weight:700; cursor:pointer; }
      .ledger-scope .btn-search { background:var(--primary); color:#fff; border:none; padding:9px 20px; border-radius:var(--r-sm); font-size:13px; font-weight:700; cursor:pointer; }
      .ledger-scope .hidden { display:none !important; }
      .ledger-scope .ec-print-area { background:#fff; padding:28px 36px; border:1px solid var(--border); border-radius:var(--r); }
      .ledger-scope .ec-doc-title { text-align:center; font-size:22px; font-weight:800; margin-bottom:6px; letter-spacing:-0.5px; }
      .ledger-scope .ec-doc-title-sub { font-weight:600; font-size:14px; }
      .ledger-scope .ec-meta { display:flex; justify-content:space-between; align-items:end; margin:14px 0 8px; font-size:12px; }
      .ledger-scope .ec-meta-left { color:var(--text); font-weight:600; }
      .ledger-scope .ec-meta-right { color:var(--text-2); }
      .ledger-scope .ec-info-table { width:100%; border-collapse:collapse; font-size:12px; margin-bottom:14px; border-top:1.5px solid #94a3b8; border-bottom:1.5px solid #94a3b8; }
      .ledger-scope .ec-info-table th, .ledger-scope .ec-info-table td { padding:7px 12px; border:1px solid #cbd5e1; }
      .ledger-scope .ec-info-table th { background:#f8fafc; font-weight:700; color:var(--text-2); width:110px; text-align:left; }
      .ledger-scope .ec-info-table td { color:var(--text); }
      /* 모바일: 정보표 → 2컬럼 grid */
      @media (max-width: 768px) {
        /* 카드 흰 배경 유지 + 표가 카드 안 가득 (흰 영역은 시각적 테두리로만) */
        .ledger-scope .data-card { padding: 10px !important; margin-bottom: 10px !important; }
        .ledger-scope .ec-print-area { padding: 10px !important; }
        .ledger-scope .ec-info-table { display: block; }
        .ledger-scope .ec-info-table tbody { display: block; }
        .ledger-scope .ec-info-table tr {
          display: grid;
          grid-template-columns: 90px 1fr;
        }
        .ledger-scope .ec-info-table th,
        .ledger-scope .ec-info-table td {
          display: block; padding: 8px 10px; width: auto !important;
          word-break: break-all;
        }
        /* 판매/수금내역 표: 5컬럼 한 화면에 다 표시 (스크롤 없음) */
        .ledger-scope .ec-ledger-wrap { overflow-x: hidden; }
        .ledger-scope .ec-ledger {
          font-size: 9px; width: 100%; table-layout: fixed;
        }
        .ledger-scope .ec-ledger th,
        .ledger-scope .ec-ledger td {
          padding: 5px 2px !important; word-break: break-all;
          width: auto !important;
          color: #000 !important;
          font-weight: 600 !important;
        }
        /* 헤더: 항상 보임 + 한 줄 + sticky */
        .ledger-scope .ec-ledger thead { display: table-header-group !important; }
        .ledger-scope .ec-ledger thead th {
          display: table-cell !important;
          white-space: nowrap !important;
          font-size: 9px !important;
          padding: 5px 1px !important;
          position: sticky; top: 0; z-index: 5;
          background: #f1f5f9 !important;
          visibility: visible !important;
        }
        /* 컬럼 비율: 일자(작게) / 적요(작게 wrap) / 판매/수금/잔액(wrap 허용, 잘림 X) */
        .ledger-scope .ec-ledger th,
        .ledger-scope .ec-ledger td {
          overflow-wrap: anywhere !important;
          word-break: break-all !important;
          overflow: visible !important;
          white-space: normal !important;
        }
        .ledger-scope .ec-ledger th:nth-child(1),
        .ledger-scope .ec-ledger td:nth-child(1) { width: 13% !important; font-size: 7px !important; }
        .ledger-scope .ec-ledger th:nth-child(2),
        .ledger-scope .ec-ledger td:nth-child(2) { width: 22% !important; font-size: 7px !important; }
        .ledger-scope .ec-ledger th:nth-child(3),
        .ledger-scope .ec-ledger td:nth-child(3) { width: 18% !important; font-size: 8px !important; }
        .ledger-scope .ec-ledger th:nth-child(4),
        .ledger-scope .ec-ledger td:nth-child(4) { width: 17% !important; font-size: 8px !important; }
        .ledger-scope .ec-ledger th:nth-child(5),
        .ledger-scope .ec-ledger td:nth-child(5) { width: 30% !important; font-size: 8px !important; }
        /* (L1399-1402 옛 nowrap/76px 강제 제거됨 — 잘림 원인) */
        .ledger-scope #view-detail h2,
        .ledger-scope .ec-detail-title { font-size: 18px; }
        /* 모바일: 출고일 표시 + 삭제 버튼 축소 */
        .ledger-scope .ec-ledger .fa-truck { font-size: 9px !important; margin-right: 2px !important; }
        .ledger-scope .ec-ledger td div[style*="fa-truck"],
        .ledger-scope .ec-ledger .ec-row-header td div:not(:first-child) { font-size: 9px !important; margin-top: 1px !important; }
        .ledger-scope .ec-ledger .btn-payment-delete { font-size: 10px !important; padding: 0 3px !important; margin-left: 2px !important; }
        .ledger-scope .ec-ledger .btn-payment-delete i { font-size: 11px !important; }
      }
      .ledger-scope .ec-ledger-title { background:#e0f2fe; text-align:center; font-weight:800; font-size:13px; padding:7px; border:1px solid #94a3b8; border-bottom:none; }
      .ledger-scope .ec-ledger { width:100%; border-collapse:collapse; font-size:12px; }
      .ledger-scope .ec-ledger th, .ledger-scope .ec-ledger td { border:1px solid #cbd5e1; padding:6px 10px; }
      .ledger-scope .ec-ledger thead th { background:#f1f5f9; font-weight:700; color:var(--text); text-align:center; }
      .ledger-scope .ec-ledger td.num { text-align:right; font-variant-numeric:tabular-nums; }
      .ledger-scope .ec-ledger td.date { width:100px; white-space:nowrap; }
      .ledger-scope .ec-ledger td.summary-cell { width:110px; }
      .ledger-scope .ec-row-header { background:#f8fafc; font-weight:700; }
      .ledger-scope .ec-row-header td { background:#f8fafc; }
      .ledger-scope .ec-row-item td { padding-left:24px; color:var(--text-2); background:#fef2f2; }
      .ledger-scope .ec-row-item td.num { background:#fef2f2; }
      .ledger-scope .ec-row-payment td { background:#f0fdf4; }
      .ledger-scope .ec-row-carry { background:#fffbeb; font-weight:700; }
      .ledger-scope .ec-row-carry td { background:#fffbeb; }
      .ledger-scope .ec-row-month-sum td { background:#dbeafe; font-weight:800; text-align:center; }
      .ledger-scope .ec-row-grand-sum td { background:#bfdbfe; font-weight:800; text-align:center; }
      .ledger-scope .ec-print-footer { text-align:right; font-size:11px; color:var(--text-3); margin-top:10px; }
      .ledger-scope .ec-filter-bar { background:#fff; border:1px solid var(--border); border-radius:var(--r); padding:14px 18px; margin-bottom:14px; display:flex; gap:14px; flex-wrap:wrap; align-items:end; }
      .ledger-scope .ec-filter-bar .fld { display:flex; flex-direction:column; gap:4px; }
      .ledger-scope .ec-filter-bar label { font-size:11px; font-weight:700; color:var(--text-2); }
      .ledger-scope .ec-filter-bar input[type="date"] { padding:6px 10px; border:1px solid var(--border); border-radius:var(--r-sm); font-size:13px; }
      .ledger-scope .ec-filter-bar .spacer { flex:1; }
      .ledger-scope .modal-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:2100; align-items:center; justify-content:center; }
      .ledger-scope .modal-overlay.show { display:flex; }
      .ledger-scope .modal { background:#fff; border-radius:var(--r); width:90%; max-width:420px; }
      .ledger-scope .modal-header { padding:16px 20px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; }
      .ledger-scope .modal-title { font-size:15px; font-weight:700; }
      .ledger-scope .modal-close { background:none; border:none; font-size:20px; cursor:pointer; color:var(--text-3); }
      .ledger-scope .modal-body { padding:20px; display:flex; flex-direction:column; gap:14px; }
      .ledger-scope .modal-body label { display:flex; flex-direction:column; gap:5px; font-size:12px; font-weight:700; color:var(--text-2); }
      .ledger-scope .modal-body input, .ledger-scope .modal-body textarea { padding:9px 12px; border:1px solid var(--border); border-radius:var(--r-sm); font-size:13px; }
      .ledger-scope .modal-footer { padding:12px 20px; border-top:1px solid var(--border); display:flex; gap:8px; justify-content:flex-end; }
    </style>
    <div class="ledger-scope">
      <!-- 거래처 목록 화면 -->
      <div id="view-list">
        <div class="filter-card" style="margin-bottom:12px">
          <div class="fld" style="width:100%">
            <div class="filter-label">🔍 거래처 검색</div>
            <input type="text" id="ledger-search" placeholder="거래처명 입력" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:var(--r-sm);font-size:13px"/>
          </div>
        </div>
        <div class="data-card">
          <div style="overflow-x:auto">
            <table>
              <thead>
                <tr>
                  <th>납품처</th>
                  <th class="num">총 발주 건수</th>
                  <th class="num">총 출고금액</th>
                  <th class="center">상세 보기</th>
                </tr>
              </thead>
              <tbody id="tbody-customers"></tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 거래처 원장 상세 화면 -->
      <div id="view-detail" class="hidden">
        <div class="no-print" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
          <button class="btn-back" onclick="goBackToList()"><i class="fas fa-arrow-left"></i> 거래처 목록</button>
          ${isAdmin()?'<button class="btn-add-payment" onclick="openPaymentModal()"><i class="fas fa-plus"></i> 입금 등록</button>':''}
          <button class="btn-print" onclick="printLedger()"><i class="fas fa-print"></i> 인쇄</button>
        </div>
        <div class="ec-filter-bar no-print">
          <div class="fld"><label>시작일</label><input type="date" id="ec-start-date"/></div>
          <div class="fld"><label>종료일</label><input type="date" id="ec-end-date"/></div>
          <button class="btn-search" onclick="applyDateRange()"><i class="fas fa-search"></i> 조회</button>
          <div class="spacer"></div>
          <div class="fld" style="min-width:220px">
            <label>납품처 검색</label>
            <input type="text" id="ec-customer-search" list="ec-customer-list" placeholder="납품처명 입력" oninput="handleCustomerSearch()"/>
            <datalist id="ec-customer-list"></datalist>
          </div>
        </div>
        <div class="ec-print-area" id="ec-print-area">
          <div class="ec-doc-title"><span id="ec-doc-customer-name">—</span> 관리대장</div>
          <div class="ec-meta">
            <div class="ec-meta-left">회사명 : 루마네시스템</div>
            <div class="ec-meta-right" id="ec-doc-period">—</div>
          </div>
          <table class="ec-info-table">
            <tbody>
              <tr><th>사업자등록번호</th><td id="ec-info-bizno">&nbsp;</td><th>대표자</th><td id="ec-info-ceo">&nbsp;</td></tr>
              <tr><th>여신한도</th><td id="ec-info-credit">0</td><th>전화</th><td id="ec-info-tel">(모바일 : )</td></tr>
              <tr><th>Email</th><td id="ec-info-email">&nbsp;</td><th>Fax</th><td id="ec-info-fax">&nbsp;</td></tr>
              <tr><th>주 소</th><td colspan="3" id="ec-info-addr">&nbsp;</td></tr>
              <tr><th>적 요</th><td colspan="3" id="ec-info-memo">&nbsp;</td></tr>
            </tbody>
          </table>
          <div class="ec-ledger-title">판매/수금내역</div>
          <div class="ec-ledger-wrap">
            <table class="ec-ledger">
              <thead>
                <tr>
                  <th style="width:100px">일자</th>
                  <th>적요</th>
                  <th class="num" style="width:110px">판매</th>
                  <th class="num" style="width:110px">수금</th>
                  <th class="num" style="width:110px">잔액</th>
                </tr>
              </thead>
              <tbody id="tbody-ledger"></tbody>
            </table>
          </div>
          <div class="ec-print-footer" id="ec-print-time">—</div>
        </div>
      </div>

      <!-- 입금 등록 모달 -->
      <div class="modal-overlay" id="payment-modal">
        <div class="modal">
          <div class="modal-header">
            <div class="modal-title">입금 등록</div>
            <button class="modal-close" onclick="closePaymentModal()">×</button>
          </div>
          <div class="modal-body">
            <label>입금일<input type="date" id="payment-date"/></label>
            <label>입금 금액<input type="number" id="payment-amount" placeholder="0" min="0"/></label>
            <label>메모 (선택)<textarea id="payment-memo" rows="2" placeholder="예: 6월 1차 정산, 어음"></textarea></label>
          </div>
          <div class="modal-footer">
            <button class="btn-back" onclick="closePaymentModal()">취소</button>
            <button class="btn-save-payment" onclick="savePayment()"><i class="fas fa-check"></i> 저장</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderSettlement(){
  const settlementReadonly=!isAdmin();
  document.getElementById('content').innerHTML = `
    <style>
      .settlement-scope { padding: 24px; }
      .settlement-scope .filter-card { background: #fff; border: 1px solid var(--border); border-radius: var(--r); padding: 14px 18px; margin-bottom: 16px; }
      .settlement-scope .filter-row { display: flex; flex-wrap: wrap; gap: 14px; align-items: end; }
      .settlement-scope .filter-label { font-size: 11px; font-weight: 700; color: var(--text-2); margin-bottom: 4px; }
      .settlement-scope .filter-card input, .settlement-scope .filter-card select { padding: 7px 10px; border: 1px solid var(--border); border-radius: var(--r-sm); font-size: 13px; }
      .settlement-scope .filter-card .spacer { flex: 1; }
      .settlement-scope .period-tabs { display: flex; gap: 4px; margin-bottom: 12px; flex-wrap: wrap; }
      .settlement-scope .period-tab { padding: 7px 14px; background: #fff; border: 1px solid var(--border); border-radius: var(--r-sm); font-size: 12px; font-weight: 600; color: var(--text-2); cursor: pointer; }
      .settlement-scope .period-tab.active { background: var(--primary); color: #fff; border-color: var(--primary); }
      .settlement-scope .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
      .settlement-scope .summary-card { background: #fff; border: 1px solid var(--border); border-radius: var(--r); padding: 16px 20px; }
      .settlement-scope .summary-label { font-size: 11px; color: var(--text-3); font-weight: 600; margin-bottom: 4px; }
      .settlement-scope .summary-value { font-size: 20px; font-weight: 800; color: var(--text); }
      .settlement-scope .data-card { background: #fff; border: 1px solid var(--border); border-radius: var(--r); padding: 16px 18px; margin-bottom: 16px; }
      .settlement-scope .data-card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
      .settlement-scope .data-card-title { font-size: 14px; font-weight: 700; color: var(--text); }
      .settlement-scope table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .settlement-scope th { background: #f9fafb; padding: 10px 12px; text-align: left; border-bottom: 2px solid var(--border); font-size: 12px; font-weight: 700; color: var(--text-2); }
      .settlement-scope td { padding: 10px 12px; border-bottom: 1px solid var(--border); }
      .settlement-scope td.num, .settlement-scope th.num { text-align: right; font-variant-numeric: tabular-nums; }
      .settlement-scope td.center, .settlement-scope th.center { text-align: center; }
      .settlement-scope tr.row-main { cursor: pointer; }
      .settlement-scope tr.row-main:hover { background: #f0f9ff; }
      .settlement-scope tr.row-total td { background: #eff6ff; font-weight: 700; }
      .settlement-scope tr.row-detail.hidden { display: none; }
      .settlement-scope tr.row-detail td { background: #fafafa; padding: 0; }
      .settlement-scope .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
      .settlement-scope .badge-wh-siheung { background: #dbeafe; color: #1e40af; }
      .settlement-scope .badge-wh-pyeongtaek { background: #fef3c7; color: #92400e; }
      .settlement-scope .btn-edit { background: #f3f4f6; color: var(--text-2); border: none; padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; }
      .settlement-scope .btn-edit:hover { background: #e5e7eb; }
      .settlement-scope .btn-link { background: #fff; color: var(--primary); border: 1px solid var(--primary); padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; }
      .settlement-scope .btn-link:hover { background: #eff6ff; }
      .settlement-scope .btn-invoice { background: #1e40af; color: #fff; border: none; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 600; cursor: pointer; }
      .settlement-scope .btn-invoice:hover { background: #1e3a8a; }
      .settlement-scope .btn-search { background: var(--primary); color: #fff; border: none; padding: 9px 20px; border-radius: var(--r-sm); font-size: 13px; font-weight: 700; cursor: pointer; }
      .settlement-scope .btn-export { background: #15803d; color: #fff; border: none; padding: 9px 16px; border-radius: var(--r-sm); font-size: 13px; font-weight: 700; cursor: pointer; }
      .settlement-scope .inline-edit { padding: 12px 16px; background: #fffbeb; }
      .settlement-scope .inline-edit-row { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 8px; }
      .settlement-scope .inline-edit label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; font-weight: 700; color: var(--text-2); }
      .settlement-scope .inline-edit input, .settlement-scope .inline-edit select { padding: 6px 10px; border: 1px solid var(--border); border-radius: 4px; font-size: 13px; }
      .settlement-scope .inline-edit-actions { display: flex; gap: 6px; }
      .settlement-scope .btn-save { background: #15803d; color: #fff; border: none; padding: 6px 14px; border-radius: 4px; font-size: 12px; font-weight: 700; cursor: pointer; }
      .settlement-scope .btn-cancel { background: #fff; color: var(--text-2); border: 1px solid var(--border); padding: 6px 14px; border-radius: 4px; font-size: 12px; cursor: pointer; }
      @media (max-width: 900px) { .settlement-scope .summary-grid { grid-template-columns: repeat(2, 1fr); } }
      @media (max-width: 768px) {
        .settlement-scope { padding: 12px; }
        .settlement-scope .summary-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; }
        .settlement-scope .summary-card { padding: 10px 12px; }
        .settlement-scope .summary-value { font-size: 16px; }
        .settlement-scope .data-card { padding: 12px; overflow-x: auto; }
        .settlement-scope table { font-size: 11px; min-width: 100%; }
        .settlement-scope th, .settlement-scope td { padding: 6px 4px; }
      }
      /* 데스크탑: hidden-row 무시 (모두 표시), 더보기 버튼 숨김 */
      .settlement-scope .detail-load-more { display: none; }
      /* 빠른 검색: 매칭 안 되는 발주서 즉시 숨김 (데스크탑/모바일 공통) */
      .settlement-scope .detail-table tr.search-hidden { display: none !important; }
      /* 액션 버튼 그룹 — 항상 한 줄 유지 */
      .settlement-scope .filter-actions {
        display: flex; gap: 6px; flex-wrap: nowrap; align-items: center;
      }
      .settlement-scope .filter-actions button { white-space: nowrap; }
      /* 정렬 토글 버튼 — 고정 너비 (텍스트 변해도 layout shift 없음) */
      .settlement-scope .btn-sort-toggle {
        background: #fff; color: #1e40af; border: 1px solid #1e40af;
        padding: 7px 14px; border-radius: var(--r-sm); font-size: 12px;
        font-weight: 700; cursor: pointer;
        min-width: 100px; white-space: nowrap;
      }
      .settlement-scope .btn-sort-toggle:hover { background: #eff6ff; }

      @media (max-width: 768px) {
        /* 외부 표: 부가세만 숨김 (공급가액·합계는 유지) */
        .settlement-scope #tbody-ordererwise tr > *:nth-child(4),
        .settlement-scope table thead th:nth-child(4) { display: none; }

        /* ─── 페이지네이션: 모바일에서만 hidden-row 적용 ─── */
        .settlement-scope .detail-table tr.hidden-row { display: none; }
        .settlement-scope .detail-load-more {
          display: block;
          width: 100%;
          padding: 12px;
          margin-top: 8px;
          background: #fff;
          border: 1px dashed var(--primary);
          border-radius: 8px;
          color: var(--primary);
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
        }
        .settlement-scope .detail-load-more:hover {
          background: #eff6ff;
        }

        /* ─── detail-table: 카드형 레이아웃으로 변환 ─── */
        .settlement-scope .detail-table-wrap { padding: 0; background: transparent; }
        .settlement-scope .detail-table { display: block; width: 100%; background: transparent; border: none; }
        .settlement-scope .detail-table thead { display: none; }
        .settlement-scope .detail-table tbody { display: block; }
        .settlement-scope .detail-table tr {
          display: grid;
          grid-template-columns: 1fr auto;
          align-items: center;
          gap: 8px 12px;
          padding: 14px 14px;
          margin-bottom: 10px;
          background: #fff;
          border: 1px solid var(--border);
          border-radius: 10px;
          box-shadow: 0 1px 2px rgba(0,0,0,0.04);
        }
        .settlement-scope .detail-table td {
          display: block;
          padding: 0 !important;
          border: none !important;
          background: transparent;
        }
        /* 숨겨야 할 보조 컬럼 (이미 col-* 있음) */
        .settlement-scope .detail-table .col-addr,
        .settlement-scope .detail-table .col-warehouse,
        .settlement-scope .detail-table .col-date,
        .settlement-scope .detail-table .col-supply,
        .settlement-scope .detail-table .col-edit { display: none; }
        /* 발주번호: 좌측 상단 */
        .settlement-scope .detail-table tr > td:first-child {
          grid-column: 1; grid-row: 1;
          font-size: 14px; font-weight: 700;
        }
        /* 합계 (num 유일하게 살아있는 것): 우측 상단, 큰 글씨 */
        .settlement-scope .detail-table .num {
          grid-column: 2; grid-row: 1;
          font-size: 17px; font-weight: 800; color: #1e40af;
          text-align: right;
        }
        /* 거래명세서/전송: row 2 전체 너비 (큰 금액에도 버튼 안 뭉개짐) */
        .settlement-scope .detail-table tr > td:nth-child(7) {
          grid-column: 1 / -1; grid-row: 2;
          display: flex; gap: 6px; flex-wrap: nowrap; align-items: center;
          padding-top: 8px !important;
          border-top: 1px solid #f1f5f9 !important;
        }
        /* 이동(상세) 셀: row 3 별도, 우측 정렬 */
        .settlement-scope .detail-table tr > td:last-child {
          grid-column: 1 / -1; grid-row: 3;
          padding-top: 4px !important;
          text-align: right;
        }
        .settlement-scope .detail-table .btn-invoice,
        .settlement-scope .detail-table .btn-invoice-send,
        .settlement-scope .detail-table .btn-link {
          padding: 6px 10px; font-size: 12px; white-space: nowrap;
        }
        /* 거래명세서 셀 안 버튼 그룹 flex-grow 균등 */
        .settlement-scope .detail-table tr > td:nth-child(7) .btn-invoice,
        .settlement-scope .detail-table tr > td:nth-child(7) .btn-invoice-send {
          flex: 1; min-width: 0; text-align: center;
        }
        .settlement-scope .detail-table .btn-invoice-send {
          display: inline-block !important;
          margin-left: 0 !important;
          margin-top: 0 !important;
        }
      }
      @media (max-width: 480px) {
        .settlement-scope { padding: 4px; margin: 0 -8px; }
        /* 카드 박스 흰 배경 유지 (밋밋함 방지) */
        .settlement-scope .filter-card { padding: 8px; }
        .settlement-scope .summary-card { padding: 10px 12px; }
        .settlement-scope .summary-value { font-size: 15px; }
        .settlement-scope .summary-label { font-size: 10px; }
        .settlement-scope table { font-size: 11px; }
        .settlement-scope th, .settlement-scope td { padding: 14px 6px; }
      }
      .stl-tabs { display: flex; gap: 4px; margin-bottom: 18px; border-bottom: 2px solid var(--border); }
      .stl-tab { padding: 10px 20px; background: none; border: none; border-bottom: 3px solid transparent; font-size: 14px; font-weight: 700; color: var(--text-3); cursor: pointer; margin-bottom: -2px; }
      .stl-tab.active { color: var(--primary); border-bottom-color: var(--primary); }
      .stl-panel { display: none; }
      .stl-panel.active { display: block; }
    </style>
    <div class="settlement-scope">
      ${settlementReadonly?`<div style="margin-bottom:12px;padding:10px 14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:var(--r-sm);font-size:12px;font-weight:700;color:#1e40af">
        <i class="fas fa-eye"></i> 발주자 읽기 전용: 정산 내역 조회만 가능하고 수정·전송·입금 등록은 관리자만 가능합니다.
      </div>`:''}
      <div class="stl-tabs">
        <button class="stl-tab active" data-stl-tab="settlement"><i class="fas fa-receipt"></i> 기간별 정산</button>
        <button class="stl-tab" data-stl-tab="ledger"><i class="fas fa-book"></i> 거래처 원장</button>
      </div>

      <!-- 정산 패널 -->
      <div class="stl-panel active" data-stl-panel="settlement">
        <div class="period-tabs">
          <button class="period-tab" data-mode="daily">일별</button>
          <button class="period-tab" data-mode="weekly">주별</button>
          <button class="period-tab active" data-mode="monthly">월별</button>
          <button class="period-tab" data-mode="quarterly">분기</button>
          <button class="period-tab" data-mode="yearly">연도</button>
          <button class="period-tab" data-mode="custom">사용자 지정</button>
        </div>
        <div class="summary-grid">
          <div class="summary-card"><div class="summary-label">출고 건수</div><div class="summary-value" id="sum-count">0건</div></div>
          <div class="summary-card"><div class="summary-label">공급가액</div><div class="summary-value" id="sum-supply">₩0</div></div>
          <div class="summary-card"><div class="summary-label">부가세</div><div class="summary-value" id="sum-vat">₩0</div></div>
          <div class="summary-card"><div class="summary-label" style="color:#1e40af">합계</div><div class="summary-value" id="sum-total" style="color:#1e40af">₩0</div></div>
        </div>
        <div class="filter-card">
          <div class="filter-row">
            <div class="fld" id="date-picker-wrap"></div>
            <div class="fld" style="flex:1;min-width:200px">
              <div class="filter-label">🔍 빠른 검색 (발주번호/거래처/주소)</div>
              <input type="text" id="quick-search" placeholder="입력하면 즉시 필터링" style="width:100%"/>
            </div>
            <div class="fld">
              <div class="filter-label">납품처 검색</div>
              <div style="display:flex;gap:6px;width:180px">
                <input type="text" id="filter-orderer" placeholder="납품처명" style="flex:1;min-width:0"/>
                <button type="button" id="filter-orderer-btn" class="btn btn-primary" style="padding:0 12px;white-space:nowrap"><i class="fas fa-search"></i></button>
              </div>
            </div>
            <div class="fld">
              <div class="filter-label">창고</div>
              <select id="filter-warehouse" style="width:120px">
                <option value="">전체</option>
                <option value="시흥">시흥</option>
                <option value="평택">평택</option>
              </select>
            </div>
            <div class="filter-actions">
              <button class="btn-search" onclick="loadData()"><i class="fas fa-search"></i> 조회</button>
              <button class="btn-sort-toggle" id="sort-toggle" data-order="desc" type="button"><i class="fas fa-sort-amount-down"></i> 최신순</button>
              ${isAdmin()?'<button class="btn-export" onclick="exportExcel()"><i class="fas fa-file-excel"></i> 엑셀</button>':''}
            </div>
          </div>
        </div>
        <div class="data-card">
          <div class="data-card-head"><div class="data-card-title">납품처별 정산 내역</div></div>
          <div style="overflow-x:auto">
            <table>
              <thead><tr><th>납품처</th><th class="num">건수</th><th class="num">공급가액</th><th class="num">부가세</th><th class="num">합계</th><th class="center">상세</th></tr></thead>
              <tbody id="tbody-ordererwise"></tbody>
            </table>
          </div>
        </div>
        <div class="data-card" id="trend-card">
          <div class="data-card-head"><div class="data-card-title" id="trend-title">일별 추이</div></div>
          <div style="overflow-x:auto">
            <table>
              <thead><tr><th>날짜</th><th class="num">건수</th><th class="num">합계</th></tr></thead>
              <tbody id="tbody-trend"></tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 거래처 원장 패널 -->
      <div class="stl-panel" data-stl-panel="ledger">
        ${_renderLedgerPanelHTML()}
      </div>
    </div>
  `;

  // 발주서 이동(onclick="goToOrder('...')") — 정산 표 → 발주서 화면
  if(typeof window.goToOrder!=='function'){
    window.goToOrder = function(orderNum){
      if(!orderNum) return;
      orderFilterNum = orderNum;
      navigate('orders');
    };
  }

  // 탭 전환
  document.querySelectorAll('.stl-tab').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const target = btn.dataset.stlTab;
      document.querySelectorAll('.stl-tab').forEach(b=>b.classList.toggle('active', b===btn));
      document.querySelectorAll('.stl-panel').forEach(p=>p.classList.toggle('active', p.dataset.stlPanel===target));
      // 원장 탭 첫 진입 시 init (lazy)
      if (target === 'ledger' && typeof showListView === 'function') {
        showListView();
      }
    });
  });

  // 원장 모듈 onclick 어댑터 (원장 HTML의 onclick → ledger 모듈 함수)
  if (typeof window.savePayment !== 'function' && typeof handleSavePayment === 'function') {
    window.savePayment = function(){ return handleSavePayment(); };
  }

  // 정산 초기 로드 (settlement 모듈의 init은 단계 2에서, 지금은 직접 호출)
  if(typeof updateDatePicker==='function') updateDatePicker();
  if(typeof loadData==='function') loadData();
  // B1 보강: 탭 재진입 시 정렬 토글을 기본(desc/최신순)으로 리셋 → dataset과 표 일치
  const _sortBtn = document.getElementById('sort-toggle');
  if (_sortBtn) {
    _sortBtn.dataset.order = 'desc';
    _sortBtn.innerHTML = '<i class="fas fa-sort-amount-down"></i> 최신순';
  }

  // 납품처 검색 Enter + 🔍 버튼 핸들러
  const ordererInput = document.getElementById('filter-orderer');
  if(ordererInput){
    ordererInput.addEventListener('keydown',e=>{
      if(e.key==='Enter'){ e.preventDefault(); if(typeof loadData==='function') loadData(); }
    });
  }
  const ordererBtn = document.getElementById('filter-orderer-btn');
  if(ordererBtn){
    ordererBtn.addEventListener('click',()=>{ if(typeof loadData==='function') loadData(); });
  }

  // 기간 모드 탭 클릭
  document.querySelectorAll('.period-tab').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.period-tab').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      if(typeof currentMode!=='undefined') currentMode = btn.dataset.mode;
      if(typeof updateDatePicker==='function') updateDatePicker();
      if(typeof loadData==='function') loadData();
    });
  });
  // [2026-07-03] 연월/날짜 입력값 변경 시 자동 조회 (사용자 UX 개선)
  if (!document._settlementDateAutoLoad) {
    document._settlementDateAutoLoad = true;
    document.addEventListener('change', (e) => {
      const id = e.target && e.target.id;
      if (id === 'date-input' || id === 'date-year' || id === 'date-quarter' || id === 'date-start' || id === 'date-end') {
        if (typeof loadData === 'function') loadData();
      }
    });
  }
}

// 품목 마스터 (관리자)
let itemFilterCat='',itemFilterActive='';

function renderItems(){
  if(!requireAdmin())return;
  // 모바일 카드형 CSS 1회 등록
  if (!document.getElementById('_items-mobile-css')) {
    const s = document.createElement('style');
    s.id = '_items-mobile-css';
    s.textContent = `
      @media (max-width: 640px) {
        /* 필터: grid 2컬럼 */
        .items-filter-bar { display:grid !important; grid-template-columns:1fr 1fr; gap:6px; padding:10px; background:#fff; border:1px solid var(--border); border-radius:10px; }
        .items-filter-bar > * { max-width:none !important; width:100% !important; }
        .items-filter-bar > select { padding:8px 10px; font-size:12px; }
        .items-filter-bar > span { grid-column:1/-1; text-align:center; font-size:11px; color:var(--text-3); }

        /* 표 → 카드형 */
        .items-tbl-wrap .table-wrap { overflow:visible !important; }
        .items-tbl-wrap table { display:block !important; width:100% !important; }
        .items-tbl-wrap thead { display:none !important; }
        .items-tbl-wrap tbody { display:block !important; }
        .items-tbl-wrap tr {
          display:grid !important;
          grid-template-columns:1fr auto;
          grid-template-rows:auto auto auto;
          gap:6px 8px;
          padding:12px;
          margin-bottom:6px;
          background:#fff;
          border:1px solid var(--border);
          border-radius:8px;
        }
        .items-tbl-wrap tr td {
          display:block !important; padding:0 !important; border:none !important;
        }
        /* 품목명: row 1 좌, 활성 토글: row 1 우 (긴 품목명 wrap 허용) */
        .items-tbl-wrap tr td:first-child {
          grid-column:1; grid-row:1; font-size:14px; font-weight:700;
          min-width:0; word-break:keep-all; line-height:1.3;
        }
        .items-tbl-wrap tr td:last-child { grid-column:2; grid-row:1; justify-self:end; align-self:start; flex-shrink:0; }

        /* 서랍장(6컬럼): 구분(2)|현재고(3) row2, 단가(4)|이카운트(5) row3 */
        .items-tbl-wrap tr.items-drawer td:nth-child(2) { grid-column:1; grid-row:2; }
        .items-tbl-wrap tr.items-drawer td:nth-child(3) { grid-column:2; grid-row:2; justify-self:end; font-size:12px; }
        .items-tbl-wrap tr.items-drawer td:nth-child(3)::before { content:"재고 "; color:var(--text-3); font-size:11px; }
        .items-tbl-wrap tr.items-drawer td:nth-child(4) { grid-column:1; grid-row:3; font-size:13px; font-weight:700; }
        .items-tbl-wrap tr.items-drawer td:nth-child(5) { grid-column:2; grid-row:3; justify-self:end; }

        /* 비서랍장(5컬럼): 현재고(2) 숨김(보통 '-'), 단가(3) row2 좌, 이카운트(4) row2 우 */
        .items-tbl-wrap tr.items-other td:nth-child(2) { display:none !important; }
        .items-tbl-wrap tr.items-other td:nth-child(3) { grid-column:1; grid-row:2; font-size:13px; font-weight:700; }
        .items-tbl-wrap tr.items-other td:nth-child(4) { grid-column:2; grid-row:2; justify-self:end; }
      }
    `;
    document.head.appendChild(s);
  }
  let items=getItems().filter(i=>i.drawerType!=='handle'); // 손잡이 항목 제외
  if(itemFilterCat)items=items.filter(i=>i.category===itemFilterCat);
  if(itemFilterActive!=='')items=items.filter(i=>String(i.isActive)===itemFilterActive);
  const cats=groupBy(items,'category');
  let catHtml='';
  for(const[cat,catItems]of Object.entries(cats)){
    catItems.sort((a,b)=>a.name.localeCompare(b.name,'ko'));
    const rows=catItems.map(item=>{
      const curPrice=getUnitPriceFromSettings(item.name);
      const priceStr=curPrice===null||curPrice===undefined?'미정':curPrice.toLocaleString()+'원';
      const priceColor=curPrice===null||curPrice===undefined?'var(--text-3)':'var(--text)';
      const escapedName=item.name.replace(/"/g,'&quot;');
      const isDrawerItem=!item.noColor&&(item.category==='서랍장'||item.category==='옵션'||item.category==='상부자재'||item.category==='선반'||item.category==='옷봉'||item.category==='코너선반');
      const colorMap=item.colorProdCdMap||{};
      const normalizedColorMap={};
      Object.entries(colorMap).forEach(([c,v])=>{
        const key=typeof normalizeStockColor==='function'?normalizeStockColor(c):c;
        if(v&&v!=='N/A')normalizedColorMap[key]=v;
      });
      const colorSetCount=Object.keys(normalizedColorMap).length;
      const prodCdCellInner=isDrawerItem
        ?`<button class="btn btn-outline btn-xs item-color-prodcd-btn" data-item-id="${item.id}" style="border-color:#7c3aed;color:#7c3aed;white-space:nowrap;font-size:11px">${colorSetCount>0?`<i class="fas fa-check-circle" style="color:#7c3aed;margin-right:3px"></i>${colorSetCount}색상 설정됨`:'<i class="fas fa-plus" style="margin-right:3px"></i>색상별 코드 설정'}</button>`
        :`<button class="btn btn-outline btn-xs ${item.noColor?'item-color-prodcd-btn':'item-prodcd-open-btn'}" data-item-id="${item.id}" style="border-color:#7c3aed;color:#7c3aed;white-space:nowrap;font-size:11px">
            ${item.noColor
              ? (item.prodCd ? `<i class="fas fa-check-circle" style="color:#7c3aed;margin-right:3px"></i>코드 설정됨` : '<i class="fas fa-plus" style="margin-right:3px"></i>코드 설정')
              : (item.prodCd ? `<i class="fas fa-check-circle" style="color:#7c3aed;margin-right:3px"></i>${item.prodCd.split(',').length}개 설정됨` : '<i class="fas fa-plus" style="margin-right:3px"></i>코드 설정')}
          </button>`;
      const displayName=PRICE_DISPLAY_LABEL[item.name]||item.name;
      const trackStockItem=isTrackStock(item);
      return `<tr class="${cat==='서랍장'?'items-drawer':'items-other'}"${item.isActive?'':' style="opacity:.5"'}>
        <td class="td-name">${displayName}</td>
        ${cat==='서랍장'?`<td class="td-center">${drawerBadge(item)}</td>`:''}
        <td class="td-center td-num" style="font-weight:700;color:${trackStockItem&&item.currentStock===0?'#dc2626':'var(--text)'}">${trackStockItem?(item.currentStock||0):'-'}</td>
        <td class="td-center"><span class="item-price-display" data-item-name="${escapedName}" style="font-size:13px;font-weight:700;color:${priceColor}">${priceStr}</span></td>
        <td class="td-center">${prodCdCellInner}</td>
        <td class="td-center"><button class="toggle-active-btn" data-item-id="${item.id}"  style="width:44px;height:24px;border-radius:12px;border:none;cursor:pointer;background:${item.isActive?'var(--primary-light)':'#e2e8f0'};position:relative;transition:all .2s"><span style="position:absolute;top:3px;${item.isActive?'right:3px':'left:3px'};width:18px;height:18px;border-radius:9px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:all .2s"></span></button></td>
      </tr>`;
    }).join('');
    catHtml+=`<div class="card items-tbl-wrap" style="margin-bottom:16px">
      <div class="card-header"><h3>${cat} <span style="font-size:12px;font-weight:400;color:var(--text-3)">${cat==='서랍장'||cat==='옵션'?'(재고 관리 대상)':'(발주 기록만)'}</span></h3><span style="font-size:12px;color:var(--text-3)">${catItems.length}개</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>품목명</th>${cat==='서랍장'?'<th class="td-center">구분</th>':''}<th class="td-center">현재고</th><th class="td-center">단가</th><th class="td-center" style="min-width:150px">이카운트 품목코드</th><th class="td-center">활성</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  }
  document.getElementById('content').innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;gap:12px;flex-wrap:wrap">
      <div><div class="section-title">품목 마스터</div><div class="section-sub">전체 품목 목록을 관리합니다. 단가는 단가 관리 페이지에서 수정하세요.</div></div>
      <button class="btn btn-primary" id="add-item-btn"><i class="fas fa-plus"></i> 품목 추가</button>
    </div>
    <div class="filter-bar items-filter-bar">
      <select class="form-input" id="item-cat-filter" style="max-width:160px">
        <option value="">전체 카테고리</option>
        <option value="서랍장"${itemFilterCat==='서랍장'?' selected':''}>서랍장</option>
        <option value="옵션"${itemFilterCat==='옵션'?' selected':''}>옵션</option>
        <option value="상부자재"${itemFilterCat==='상부자재'?' selected':''}>상부자재</option>
        <option value="선반"${itemFilterCat==='선반'?' selected':''}>선반</option>
        <option value="코너선반"${itemFilterCat==='코너선반'?' selected':''}>코너선반</option>
        <option value="옷봉"${itemFilterCat==='옷봉'?' selected':''}>옷봉</option>
        <option value="서비스"${itemFilterCat==='서비스'?' selected':''}>서비스</option>
      </select>
      <select class="form-input" id="item-active-filter" style="max-width:120px">
        <option value="">전체 상태</option>
        <option value="true"${itemFilterActive==='true'?' selected':''}>활성</option>
        <option value="false"${itemFilterActive==='false'?' selected':''}>비활성</option>
      </select>
      <span style="font-size:12px;color:var(--text-3)">${items.length}개</span>
    </div>${catHtml}`;
  document.getElementById('item-cat-filter').addEventListener('change',e=>{itemFilterCat=e.target.value;renderItems();});
  document.getElementById('item-active-filter').addEventListener('change',e=>{itemFilterActive=e.target.value;renderItems();});
  // 신규 품목 추가 모달
  const _addItemBtn=document.getElementById('add-item-btn');
  if(_addItemBtn){
    _addItemBtn.addEventListener('click',()=>{
      const overlay=document.createElement('div');
      overlay.className='modal-overlay';overlay.style.display='flex';
      overlay.innerHTML=`
        <div class="modal" style="max-width:420px;width:92%">
          <div class="modal-header">
            <div class="modal-title"><i class="fas fa-plus" style="margin-right:6px"></i>품목 추가 (마스터)</div>
            <button class="modal-close" onclick="this.closest('.modal-overlay').remove()"><i class="fas fa-times"></i></button>
          </div>
          <div class="modal-body" style="display:flex;flex-direction:column;gap:14px;padding:20px">
            <div>
              <label class="form-label">품목명 <span style="color:#dc2626">*</span></label>
              <input id="new-item-name" class="form-input" placeholder="예: 직결볼트" style="width:100%"/>
            </div>
            <div>
              <label class="form-label">카테고리 <span style="color:#dc2626">*</span></label>
              <select id="new-item-cat" class="form-input" style="width:100%">
                <option value="옵션">옵션</option>
                <option value="상부자재">상부자재</option>
                <option value="선반">선반</option>
                <option value="코너선반">코너선반</option>
                <option value="옷봉">옷봉</option>
                <option value="서비스">서비스</option>
                <option value="서랍장">서랍장 (재고 관리 대상)</option>
              </select>
            </div>
            <div>
              <label class="form-label">단가 (원)</label>
              <input id="new-item-price" type="number" class="form-input" placeholder="비워두면 미정" style="width:100%;text-align:right"/>
            </div>
            <div>
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
                <input type="checkbox" id="new-item-nocolor" checked/>
                <span>색상 없음 (색상 선택 X)</span>
              </label>
              <div style="font-size:11px;color:var(--text-3);margin-top:4px;padding-left:22px">체크 해제 시 색상별로 관리됩니다 (색상 코드는 나중에 설정)</div>
            </div>
            <div style="font-size:11px;color:var(--warning);background:var(--warning-bg);padding:8px 10px;border-radius:6px">
              ⚠️ 저장 후 기존 발주서/재고/정산 데이터는 영향 없습니다. 신규 발주부터 목록에 나타납니다.
            </div>
          </div>
          <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end;padding:12px 20px">
            <button class="btn btn-outline btn-sm" onclick="this.closest('.modal-overlay').remove()">취소</button>
            <button class="btn btn-sm" id="new-item-confirm" style="background:#1e3a5f;color:#fff;font-weight:700">추가</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      document.getElementById('new-item-name').focus();
      document.getElementById('new-item-confirm').addEventListener('click',()=>{
        const name=document.getElementById('new-item-name').value.trim();
        const cat=document.getElementById('new-item-cat').value;
        const priceStr=document.getElementById('new-item-price').value.trim();
        const noColor=document.getElementById('new-item-nocolor').checked;
        if(!name){toast('품목명을 입력해주세요.','error');return;}
        const price=priceStr===''?null:parseInt(priceStr);
        if(priceStr!==''&&(isNaN(price)||price<0)){toast('단가는 0 이상의 숫자 또는 빈칸(미정)으로 입력해주세요.','error');return;}
        // 중복 체크 (items + price_settings)
        const items=getItems();
        if(items.find(i=>i.name===name)){toast('이미 같은 이름의 품목이 있습니다.','error');return;}
        // items 마스터에 push
        const newId=items.reduce((m,i)=>Math.max(m,i.id||0),0)+1;
        const trackStockNew=cat==='서랍장'||cat==='옵션';
        const newItem={
          id:newId,
          name,
          category:cat,
          isActive:true,
          noColor,
          isCustom:true,
          trackStock:trackStockNew?true:undefined,
          currentStock:trackStockNew?0:undefined,
          stockSiheung:trackStockNew?0:undefined,
          stockPyeongtaek:trackStockNew?0:undefined,
          stockOsan:trackStockNew?0:undefined,
          colorStockSiheung:trackStockNew?{}:undefined,
          colorStockPyeongtaek:trackStockNew?{}:undefined,
          colorStockOsan:trackStockNew?{}:undefined,
        };
        // undefined 필드 제거 (Firestore 저장 안정성)
        Object.keys(newItem).forEach(k=>newItem[k]===undefined&&delete newItem[k]);
        items.push(newItem);
        DB.set('items',items);
        // price_settings 동기화
        const ps=getPriceSettings();
        if(!ps.find(p=>p.name===name)){
          ps.push({name,category:cat,price,isCustom:true});
          DB.set('price_settings',ps);
        }
        overlay.remove();
        toast(`"${name}" 품목이 추가되었습니다.`,'success');
        renderItems();
      });
    });
  }
  // 단가 저장 버튼 이벤트
  document.querySelectorAll('.item-price-save-btn').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const name=btn.dataset.itemName;
      const inp=document.querySelector(`.item-price-input[data-item-name="${name}"]`);
      if(!inp)return;
      const val=inp.value.trim();
      const price=val===''?null:parseInt(val);
      if(val!==''&&(isNaN(price)||price<0)){toast('단가는 0 이상의 숫자 또는 빈칸(미정)으로 입력해주세요.','error');return;}
      const ps=getPriceSettings();
      const idx=ps.findIndex(p=>normalizeName(p.name)===normalizeName(name));
      if(idx!==-1){ps[idx].price=price;}
      else{ps.push({name,price,isCustom:true});}
      DB.set('price_settings',ps);
      const display=document.querySelector(`.item-price-display[data-item-name="${name}"]`);
      if(display){
        display.textContent=price===null?'미정':price.toLocaleString()+'원';
        display.style.color=price===null?'var(--text-3)':'var(--text)';
      }
      toast(`${name} 단가가 저장되었습니다.`,'success');

    });
  });
  // ERP 품목코드 설정 버튼 (옵션/서비스 품목)
  document.querySelectorAll('.item-prodcd-open-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{ openProdCdModal(parseInt(btn.dataset.itemId)); });
  });
  // 서랍장 색상별 ERP 품목코드 버튼
  document.querySelectorAll('.item-color-prodcd-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const itemId=parseInt(btn.dataset.itemId);
      openColorProdCdModal(itemId);
    });
  });
}

// 단일 품목 이카운트 코드 설정 모달 (옵션/서비스용)
let _prodCdModalItemId=null;
function openProdCdModal(itemId){
  const items=DB.get('items',[]);
  const item=items.find(i=>i.id===itemId);
  if(!item)return;
  _prodCdModalItemId=itemId;
  let selectedCds=(item.prodCd||'').split(',').map(s=>s.trim()).filter(Boolean);

  const render=()=>{
    const tagsHtml=selectedCds.length
      ? selectedCds.map(cd=>{
          const prod=(_ecountProductCache||[]).find(p=>p.PROD_CD===cd);
          const label=prod?`${prod.PROD_NM}${prod.SIZE_DES?` [${prod.SIZE_DES}]`:''}`:'';
          return `<span style="display:inline-flex;align-items:center;gap:4px;background:#ede9fe;color:#7c3aed;border-radius:12px;padding:3px 10px;font-size:12px;margin:2px">
            ${label?label:cd} <span style="opacity:.7;font-size:10px">${label?cd:''}</span>
            <button onmousedown="event.preventDefault();window._prodCdRemove('${cd}')" style="background:none;border:none;color:#7c3aed;cursor:pointer;font-size:13px;padding:0;line-height:1">✕</button>
          </span>`;
        }).join('')
      : '<span style="color:#94a3b8;font-size:12px">선택된 코드 없음</span>';

    document.getElementById('prodcd-modal-body').innerHTML=`
      <div style="margin-bottom:10px;min-height:32px;padding:6px;border:1px solid #e2e8f0;border-radius:8px;background:#fafafa">${tagsHtml}</div>
      <input type="text" id="prodcd-search-inp" placeholder="품목명 또는 코드 검색..." autocomplete="off"
        style="width:100%;padding:8px 12px;font-size:13px;border:1px solid #a78bfa;border-radius:8px;box-sizing:border-box;margin-bottom:4px"
        oninput="window._prodCdSearch(this.value)"/>
      <div id="prodcd-list" style="max-height:220px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px;display:none"></div>
    `;
    window._prodCdSearch=(kw)=>{
      const products=_ecountProductCache||[];
      const filtered=kw?products.filter(p=>(p.PROD_NM||'').toLowerCase().includes(kw.toLowerCase())||(p.SIZE_DES||'').toLowerCase().includes(kw.toLowerCase())||(p.PROD_CD||'').includes(kw)):[];
      const list=document.getElementById('prodcd-list');
      if(!filtered.length){list.style.display='none';return;}
      list.innerHTML=filtered.slice(0,50).map(p=>{
        const already=selectedCds.includes(p.PROD_CD);
        const label=`${p.PROD_NM}${p.SIZE_DES?` [${p.SIZE_DES}]`:''} — ${p.PROD_CD}`;
        return `<div onmousedown="event.preventDefault();window._prodCdAdd('${p.PROD_CD}')"
          style="padding:8px 12px;font-size:13px;cursor:pointer;border-bottom:1px solid #f1f5f9;${already?'background:#f5f3ff;color:#7c3aed;':''}display:flex;justify-content:space-between;align-items:center"
          onmouseover="this.style.background='#f5f3ff'" onmouseout="this.style.background='${already?'#f5f3ff':'white'}'">
          <span>${label}</span>${already?'<span style="font-size:11px">✓ 선택됨</span>':''}
        </div>`;
      }).join('');
      list.style.display='block';
    };
    window._prodCdAdd=(cd)=>{
      if(!selectedCds.includes(cd))selectedCds.push(cd);
      render();
      const inp=document.getElementById('prodcd-search-inp');
      if(inp){inp.value='';inp.focus();window._prodCdSearch('');}
    };
    window._prodCdRemove=(cd)=>{
      selectedCds=selectedCds.filter(c=>c!==cd);
      render();
    };
  };

  // 모달 열기
  const overlay=document.createElement('div');
  overlay.id='prodcd-modal-overlay';
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:1000;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML=`<div style="background:white;border-radius:16px;padding:24px;width:90%;max-width:420px;box-shadow:0 8px 32px rgba(0,0,0,.2)">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <span style="font-size:15px;font-weight:700">이카운트 품목코드 — ${PRICE_DISPLAY_LABEL[item.name]||item.name}</span>
      <button onmousedown="event.preventDefault();document.getElementById('prodcd-modal-overlay').remove()" style="background:none;border:none;font-size:20px;cursor:pointer;color:#64748b">✕</button>
    </div>
    <div id="prodcd-modal-body"></div>
    <div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
      <button onmousedown="event.preventDefault();document.getElementById('prodcd-modal-overlay').remove()" style="padding:8px 16px;border:1px solid #e2e8f0;border-radius:8px;background:white;cursor:pointer">취소</button>
      <button onmousedown="event.preventDefault();window._prodCdSave()" style="padding:8px 16px;background:#7c3aed;color:white;border:none;border-radius:8px;cursor:pointer;font-weight:700">저장</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  window._prodCdSave=()=>{
    const items2=DB.get('items',[]);
    const idx=items2.findIndex(i=>i.id===_prodCdModalItemId);
    if(idx===-1)return;
    items2[idx].prodCd=selectedCds.join(',');
    DB.set('items',items2);
    document.getElementById('prodcd-modal-overlay')?.remove();
    toast(`ERP 품목코드 저장 완료 (${selectedCds.length}개)`,'success');
    renderItems();
  };

  // 이카운트 품목 로드 후 렌더
  if(_ecountProductCache){ render(); }
  else {
    fetch('/ecount-products.json').then(r=>r.json()).then(p=>{_ecountProductCache=p;render();}).catch(()=>render());
  }
}

// 품목별 서브타입 설정 (팝업에서 섹션으로 나뉨)
const ITEM_SUBTYPES = {
  '거울장': [
    { name: '거울장 목대',                         colors: ['솔리드화이트','화이트오크','메이플','다크월넛','진그레이','스톤그레이'] },
    { name: '거울장 거울문',                        colors: ['골드','블랙','실버'] },
  ],
  '이불 긴장': [
    { name: '이불 긴장문',                                       colors: ['솔리드화이트','화이트오크','메이플','다크월넛','진그레이','스톤그레이'] },
    { name: '이불장 목대',       qty: 2,                         colors: ['솔리드화이트','화이트오크','메이플','다크월넛','진그레이','스톤그레이'] },
    { name: '이불장손잡이(1구)', itemName: '이불장손잡이(1구)', colors: null },
  ],
  '이불 반장': [
    { name: '이불 반장문',                                       colors: SHELF_COLORS },
    { name: '이불장 목대',                                       colors: ['솔리드화이트','화이트오크','메이플','다크월넛','진그레이','스톤그레이'] },
    { name: '이불장손잡이(1구)', itemName: '이불장손잡이(1구)', colors: null },
  ],
  '화장대세트': [
    { name: '화장대(대)',      colors: ['솔리드화이트','화이트오크','메이플','다크월넛','진그레이','스톤그레이'] },
    { name: '화장대 디바이더', colors: ['솔리드화이트','화이트오크','메이플','다크월넛','진그레이','스톤그레이'] },
    { name: '화장대 거울문',   colors: ['실버','블랙'] },
  ],
  '겉서랍 아일랜드': [
    { name: '아일랜드(겉, 유리세트)',   colors: SHELF_COLORS },
    { name: '아일랜드 유리(속서랍용)',  colors: ['골드','실버','블랙'] },
    { name: '아일랜드용 바퀴',          colors: ['화이트','실버','블랙'] },
  ],
  '속서랍 아일랜드': [
    { name: '아일랜드장 속서랍',       colors: SHELF_COLORS },
    { name: '아일랜드 유리(속서랍용)', colors: ['골드','실버','블랙'] },
    { name: '아일랜드용 바퀴',         colors: ['화이트','실버','블랙'] },
  ],
  '인출식 바지걸이': [
    { name: '인출식 바지걸이', colors: ['화이트','블랙'] },
  ],
};

// 카테고리별 색상 설정 (기본은 SHELF_COLORS)
const CATEGORY_COLORS = {
  '상부자재': ['실버','화이트','블랙','골드'],
  '옷봉':    ['실버','화이트','블랙','골드'],
};

// 색상별 이카운트 품목코드 모달 열기
let _colorProdCdItemId=null;
let _ecountProductCache=null; // 이카운트 품목 캐시
let _colorProdCdMap={}; // 현재 편집 중인 colorMap (저장 함수에서 접근용)

function openColorProdCdModal(itemId){
  const items=DB.get('items',[]);
  const item=items.find(i=>i.id===itemId);
  if(!item)return;
  _colorProdCdItemId=itemId;
  document.getElementById('color-prodcd-modal-title').textContent=`이카운트 품목코드 — ${PRICE_DISPLAY_LABEL[item.name]||item.name}`;
  _colorProdCdMap=Object.assign({}, item.colorProdCdMap||{});
  const colorMap=_colorProdCdMap;
  // 서브타입 데이터 (섹션별 색상맵)
  const subTypes = ITEM_SUBTYPES[item.name] || null;
  let _subTypeMap = Object.assign({}, item.subTypeProdCdMap||{}); // { "섹션명": { 색상: 코드 } }
  // 댐퍼/비규격 별도 저장용
  let _damperCd = item.damperProdCd||'';
  let _nonStdCd = item.nonStdProdCd||'';

  // 로딩 표시
  document.getElementById('color-prodcd-rows').innerHTML=`<div style="text-align:center;padding:20px;color:#64748b"><i class="fas fa-spinner fa-spin"></i> 이카운트 품목 불러오는 중...</div>`;
  openModal('color-prodcd-modal');

  // 이카운트 품목 로드 (캐시 있으면 재사용)
  const loadAndRender = (products) => {

    // 고유 list ID 생성
    const makeId = (stName, color) => 'elist__'+(stName+'__'+color).replace(/[^a-zA-Z0-9가-힣]/g,'_');

    // 색상 행 렌더링
    const renderColorRow = (color, savedCd, isNA, stName) => {
      const prod = savedCd ? products.find(p=>p.PROD_CD===savedCd) : null;
      const lbl = prod ? `${prod.PROD_NM}${prod.SIZE_DES?` [${prod.SIZE_DES}]`:''} — ${prod.PROD_CD}` : '';
      const uid = makeId(stName||'', color);
      const stAttr = stName ? `data-subtype="${stName}"` : '';
      return `<div style="margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="font-size:13px;font-weight:600;color:var(--text)">${color}</span>
          <button onclick="window._ecountSetNA(this,'${uid}',${isNA})"
            style="font-size:11px;padding:2px 8px;border-radius:12px;border:1px solid ${isNA?'#94a3b8':'#e2e8f0'};background:${isNA?'#f1f5f9':'white'};color:${isNA?'#64748b':'#94a3b8'};cursor:pointer;font-weight:${isNA?'700':'400'}">해당없음</button>
        </div>
        <div id="wrap-${uid}" style="position:relative;${isNA?'opacity:0.4;pointer-events:none':''}">
          <input type="text" class="form-input color-search-inp" data-color="${color}" ${stAttr} data-uid="${uid}" data-selected="${isNA?'':savedCd}"
            value="${isNA?'':lbl}" placeholder="검색 후 선택..." autocomplete="off"
            style="width:100%;padding:7px 36px 7px 10px;font-size:13px;box-sizing:border-box;${savedCd&&!isNA?'border-color:#7c3aed;color:#7c3aed;':''}"
            oninput="window._ecountShowList(this,'${uid}')"
            onfocus="window._ecountShowList(this,'${uid}')"/>
          <button onmousedown="event.preventDefault();window._ecountClear('${uid}')" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:#94a3b8;cursor:pointer;font-size:16px;line-height:1;padding:0 2px">✕</button>
          <div id="${uid}" style="display:none;position:absolute;z-index:999;left:0;right:0;background:white;border:1px solid #e2e8f0;border-radius:8px;max-height:180px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,.1);margin-top:2px"></div>
        </div>
      </div>`;
    };

    // 단일코드 행 렌더링 (색상 없는 서브타입)
    const renderSingleRow = (stName, savedCd) => {
      const prod = savedCd ? products.find(p=>p.PROD_CD===savedCd) : null;
      const lbl = prod ? `${prod.PROD_NM}${prod.SIZE_DES?` [${prod.SIZE_DES}]`:''} — ${prod.PROD_CD}` : '';
      const uid = makeId(stName, '_single');
      return `<div style="position:relative">
        <input type="text" class="form-input color-search-inp" data-color="_single" data-subtype="${stName}" data-uid="${uid}" data-selected="${savedCd}"
          value="${lbl}" placeholder="검색 후 선택..." autocomplete="off"
          style="width:100%;padding:7px 36px 7px 10px;font-size:13px;box-sizing:border-box;${savedCd?'border-color:#7c3aed;color:#7c3aed;':''}"
          oninput="window._ecountShowList(this,'${uid}')"
          onfocus="window._ecountShowList(this,'${uid}')"/>
        <button onmousedown="event.preventDefault();window._ecountClear('${uid}')" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:#94a3b8;cursor:pointer;font-size:16px;line-height:1;padding:0 2px">✕</button>
        <div id="${uid}" style="display:none;position:absolute;z-index:999;left:0;right:0;background:white;border:1px solid #e2e8f0;border-radius:8px;max-height:180px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,.1);margin-top:2px"></div>
      </div>`;
    };

    // 메인 콘텐츠 구성
    let mainContent = '';
    if(subTypes){
      mainContent = subTypes.map(st => {
        const stMap = _subTypeMap[st.name] || {};
        const seenStColors = new Set();
        const stColors = Array.isArray(st.colors)
          ? st.colors.map(c=>typeof normalizeStockColor==='function'?normalizeStockColor(c):c).filter(c=>{
              if(seenStColors.has(c))return false;
              seenStColors.add(c);
              return true;
            })
          : st.colors;
        const inner = st.colors === null
          ? renderSingleRow(st.name, stMap['_single']||'')
          : stColors.map(c => {
              const saved = typeof getColorAliasValue==='function'?getColorAliasValue(stMap,c):stMap[c];
              return renderColorRow(c, saved==='N/A'?'':saved||'', saved==='N/A', st.name);
            }).join('');
        return `<div style="margin-bottom:24px">
          <div style="font-size:13px;font-weight:700;color:#1e293b;padding:6px 10px;background:#f8fafc;border-radius:8px;margin-bottom:10px;border-left:3px solid #7c3aed">${st.name}</div>
          ${inner}
        </div>`;
      }).join('');
    } else if(item.noColor){
      // 색상 무관 단일 코드 입력
      const savedCd = item.prodCd||'';
      const prod = savedCd ? products.find(p=>p.PROD_CD===savedCd) : null;
      const lbl = prod ? `${prod.PROD_DES||''}${prod.SIZE_DES?` [${prod.SIZE_DES}]`:''} — ${prod.PROD_CD}` : '';
      const uid = 'elist__nocolor_single';
      mainContent = `<div style="margin-bottom:14px">
        <div style="font-size:12px;color:#64748b;margin-bottom:10px">색상 구분 없이 하나의 코드로 연동됩니다.</div>
        <div style="position:relative">
          <input type="text" class="form-input nocolor-prodcd-inp" data-uid="${uid}" data-selected="${savedCd}"
            value="${lbl}" placeholder="검색 후 선택..." autocomplete="off"
            style="width:100%;padding:7px 36px 7px 10px;font-size:13px;box-sizing:border-box;${savedCd?'border-color:#7c3aed;color:#7c3aed;':''}"
            oninput="window._ecountShowList(this,'${uid}')"
            onfocus="window._ecountShowList(this,'${uid}')"/>
          <button onmousedown="event.preventDefault();window._ecountClear('${uid}')" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:#94a3b8;cursor:pointer;font-size:16px;line-height:1;padding:0 2px">✕</button>
          <div id="${uid}" style="display:none;position:absolute;z-index:999;left:0;right:0;background:white;border:1px solid #e2e8f0;border-radius:8px;max-height:180px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,.1);margin-top:2px"></div>
        </div>
      </div>`;
    } else {
      const baseColors = item.colorOptions || CATEGORY_COLORS[item.category] || SHELF_COLORS;
      const seenColors = new Set();
      const colors = baseColors.map(c=>typeof normalizeStockColor==='function'?normalizeStockColor(c):c).filter(c=>{
        if(seenColors.has(c))return false;
        seenColors.add(c);
        return true;
      });
      mainContent = colors.map(c => {
        const saved = typeof getColorAliasValue==='function'?getColorAliasValue(colorMap,c):colorMap[c];
        return renderColorRow(c, saved==='N/A'?'':saved||'', saved==='N/A', '');
      }).join('');
    }

    // 댐퍼/비규격 단일 코드 행 렌더링
    const renderExtraRow = (key, label, emoji) => {
      const cd = key==='damper' ? _damperCd : _nonStdCd;
      const prod = cd ? products.find(p=>p.PROD_CD===cd) : null;
      const dispLabel = prod ? `${prod.PROD_NM}${prod.SIZE_DES?` [${prod.SIZE_DES}]`:''} — ${prod.PROD_CD}` : '';
      return `<div style="margin-bottom:14px">
        <div style="font-size:13px;font-weight:700;color:#0f172a;margin-bottom:4px">${emoji} ${label}</div>
        <div style="position:relative">
          <input type="text" class="form-input extra-prodcd-inp" data-key="${key}" data-selected="${cd}"
            value="${dispLabel}" placeholder="검색 후 선택..." autocomplete="off"
            style="width:100%;padding:7px 36px 7px 10px;font-size:13px;box-sizing:border-box;${cd?'border-color:#0891b2;color:#0891b2;':''}"
            oninput="window._ecountShowExtraList(this,'${key}')"
            onfocus="window._ecountShowExtraList(this,'${key}')"/>
          <button onmousedown="event.preventDefault();window._ecountClearExtra('${key}')" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:#94a3b8;cursor:pointer;font-size:16px;line-height:1;padding:0 2px">✕</button>
          <div class="ecount-list" id="elist-extra-${key}" style="display:none;position:absolute;z-index:999;left:0;right:0;background:white;border:1px solid #e2e8f0;border-radius:8px;max-height:180px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,.1);margin-top:2px"></div>
        </div>
      </div>`;
    };
    const extraRows = `
      <div style="border-top:2px solid #f1f5f9;margin:16px 0 12px;padding-top:12px">
        <div style="font-size:11px;color:#64748b;margin-bottom:10px">▼ 색상 무관 전용 코드</div>
        ${renderExtraRow('damper','댐퍼','🔩')}
        ${renderExtraRow('nonStd','비규격','📐')}
      </div>`;

    document.getElementById('color-prodcd-rows').innerHTML =
      `<div style="font-size:11px;color:#94a3b8;margin-bottom:10px">총 ${products.length}개 품목 · 색상별로 검색해서 선택하세요</div>${mainContent}${extraRows}`;

    // 검색 목록 표시 (uid = 고유 list ID)
    window._ecountShowList = (inp, uid) => {
      const kw = inp.value.toLowerCase();
      // 다른 드롭다운 모두 닫기
      document.querySelectorAll('.ecount-list,[id^="elist__"]').forEach(el=>{if(el.id!==uid)el.style.display='none';});
      const list = document.getElementById(uid);
      if(!list) return;
      const filtered = kw
        ? products.filter(p=>(p.PROD_NM||'').toLowerCase().includes(kw)||(p.SIZE_DES||'').toLowerCase().includes(kw)||(p.PROD_CD||'').includes(kw))
        : products;
      list.innerHTML = filtered.slice(0,50).map(p => {
        const label = `${p.PROD_NM}${p.SIZE_DES?` [${p.SIZE_DES}]`:''} — ${p.PROD_CD}`;
        return `<div style="padding:7px 12px;font-size:13px;cursor:pointer;border-bottom:1px solid #f1f5f9"
          onmousedown="window._ecountSelect(this,'${p.PROD_CD}','${label.replace(/'/g,"&#39;")}')"
          onmouseover="this.style.background='#f5f3ff'" onmouseout="this.style.background=''">${label}</div>`;
      }).join('') || '<div style="padding:10px;color:#94a3b8;font-size:13px">검색 결과 없음</div>';
      list.style.display = 'block';
    };

    // 품목 선택 (listItem의 부모에서 uid 찾아 input 업데이트)
    window._ecountSelect = (listItem, cd, label) => {
      const list = listItem.closest('.ecount-list, [id^="elist__"]') || listItem.parentElement;
      const uid = list?.id;
      const inp = document.querySelector(`.color-search-inp[data-uid="${uid}"]`)
                ||document.querySelector(`.nocolor-prodcd-inp[data-uid="${uid}"]`);
      if(inp){ inp.value=label; inp.dataset.selected=cd; inp.style.borderColor='#7c3aed'; inp.style.color='#7c3aed'; }
      if(list) list.style.display='none';
    };

    // 선택 초기화 (✕ 버튼, uid 기반)
    window._ecountClear = (uid) => {
      const inp = document.querySelector(`.color-search-inp[data-uid="${uid}"]`);
      if(inp){ inp.value=''; inp.dataset.selected=''; inp.style.borderColor=''; inp.style.color=''; inp.focus(); }
      const list = document.getElementById(uid);
      if(list){ list.innerHTML=''; list.style.display='none'; }
    };

    // 댐퍼/비규격 검색 목록 표시
    window._ecountShowExtraList = (inp, key) => {
      const kw = inp.value.toLowerCase();
      const list = document.getElementById(`elist-extra-${key}`);
      if(!list) return;
      document.querySelectorAll('.ecount-list,[id^="elist__"]').forEach(el=>{if(el.id!==`elist-extra-${key}`)el.style.display='none';});
      const filtered = kw ? products.filter(p=>(p.PROD_NM||'').toLowerCase().includes(kw)||(p.SIZE_DES||'').toLowerCase().includes(kw)||(p.PROD_CD||'').includes(kw)) : products;
      if(!filtered.length){list.style.display='none';return;}
      list.innerHTML = filtered.slice(0,50).map(p=>{
        const label=`${p.PROD_NM}${p.SIZE_DES?` [${p.SIZE_DES}]`:''} — ${p.PROD_CD}`;
        return `<div style="padding:7px 12px;font-size:13px;cursor:pointer;border-bottom:1px solid #f1f5f9"
          onmousedown="window._ecountSelectExtra('${key}','${p.PROD_CD}','${label.replace(/'/g,"&#39;")}')"
          onmouseover="this.style.background='#e0f2fe'" onmouseout="this.style.background=''">${label}</div>`;
      }).join('');
      list.style.display='block';
    };

    // 댐퍼/비규격 선택
    window._ecountSelectExtra = (key, cd, label) => {
      if(key==='damper') _damperCd=cd; else _nonStdCd=cd;
      const inp = document.querySelector(`.extra-prodcd-inp[data-key="${key}"]`);
      if(inp){ inp.value=label; inp.dataset.selected=cd; inp.style.borderColor='#0891b2'; inp.style.color='#0891b2'; }
      const list = document.getElementById(`elist-extra-${key}`);
      if(list) list.style.display='none';
    };

    // 댐퍼/비규격 초기화
    window._ecountClearExtra = (key) => {
      if(key==='damper') _damperCd=''; else _nonStdCd='';
      const inp = document.querySelector(`.extra-prodcd-inp[data-key="${key}"]`);
      if(inp){ inp.value=''; inp.dataset.selected=''; inp.style.borderColor=''; inp.style.color=''; inp.focus(); }
      const list = document.getElementById(`elist-extra-${key}`);
      if(list){ list.innerHTML=''; list.style.display='none'; }
    };

    // 해당없음 토글 (uid 기반)
    window._ecountSetNA = (btn, uid, currentIsNA) => {
      const inp = document.querySelector(`.color-search-inp[data-uid="${uid}"]`);
      const wrap = document.getElementById(`wrap-${uid}`);
      const nowNA = !currentIsNA;
      btn.style.background = nowNA?'#f1f5f9':'white';
      btn.style.borderColor = nowNA?'#94a3b8':'#e2e8f0';
      btn.style.color = nowNA?'#64748b':'#94a3b8';
      btn.style.fontWeight = nowNA?'700':'400';
      btn.setAttribute('onclick', `window._ecountSetNA(this,'${uid}',${nowNA})`);
      if(wrap){ wrap.style.opacity=nowNA?'0.4':''; wrap.style.pointerEvents=nowNA?'none':''; }
      if(inp){ inp.dataset.selected = nowNA?'N/A':(inp.dataset.selected==='N/A'?'':inp.dataset.selected); }
    };

    // 외부 클릭 시 목록 닫기
    document.addEventListener('mousedown', (e)=>{
      document.querySelectorAll('.ecount-list').forEach(l=>{ if(!l.contains(e.target)) l.style.display='none'; });
    }, {once:false});
  };

  if(_ecountProductCache){
    loadAndRender(_ecountProductCache);
  } else {
    fetch('/ecount-products.json')
      .then(r=>r.json())
      .then(products=>{
        _ecountProductCache=products;
        loadAndRender(_ecountProductCache);
      }).catch(e=>{
        document.getElementById('color-prodcd-rows').innerHTML=`<div style="color:red;padding:10px">품목 불러오기 실패: ${e.message}</div>`;
      });
  }
}

// 색상별 이카운트 품목코드 저장
function saveColorProdCdMap(){
  if(!_colorProdCdItemId)return;
  const items=DB.get('items',[]);
  const idx=items.findIndex(i=>i.id===_colorProdCdItemId);
  if(idx===-1)return;
  // 색상 무관 단일 코드 저장
  if(items[idx].noColor){
    const singleInp=document.querySelector('.nocolor-prodcd-inp');
    if(singleInp) items[idx].prodCd=(singleInp.dataset.selected||'').trim();
    const damperInpNC=document.querySelector('.extra-prodcd-inp[data-key="damper"]');
    const nonStdInpNC=document.querySelector('.extra-prodcd-inp[data-key="nonStd"]');
    if(damperInpNC) items[idx].damperProdCd=(damperInpNC.dataset.selected||'').trim();
    if(nonStdInpNC) items[idx].nonStdProdCd=(nonStdInpNC.dataset.selected||'').trim();
    DB.set('items',items);
    closeModal('color-prodcd-modal');
    toast(`${items[idx].name} ERP 품목코드 저장 완료`,'success');
    renderItems();
    return;
  }
  const map={};
  // 해당없음(N/A) 먼저 적용
  SHELF_COLORS.forEach(color=>{
    const saved=typeof getColorAliasValue==='function'?getColorAliasValue(_colorProdCdMap,color):_colorProdCdMap[color];
    if(saved==='N/A') map[color]='N/A';
  });
  document.querySelectorAll('.color-search-inp').forEach(inp=>{
    const color=inp.dataset.color;
    if(map[color]==='N/A') return; // 해당없음은 유지
    const val=(inp.dataset.selected||'').trim();
    if(val)map[color]=val;
  });
  items[idx].colorProdCdMap=map;
  // 서브타입 저장
  if(ITEM_SUBTYPES[items[idx].name]){
    const stMapFinal={};
    document.querySelectorAll('.color-search-inp[data-subtype]').forEach(inp=>{
      const st=inp.dataset.subtype;
      const c=inp.dataset.color;
      const v=(inp.dataset.selected||'').trim();
      if(!stMapFinal[st]) stMapFinal[st]={};
      if(v) stMapFinal[st][c]=v;
    });
    items[idx].subTypeProdCdMap=stMapFinal;
  } else {
    // 일반 color 저장
    document.querySelectorAll('.color-search-inp:not([data-subtype])').forEach(inp=>{
      const c=inp.dataset.color; const v=(inp.dataset.selected||'').trim();
      if(c && v) map[c]=v;
    });
  }
  // 댐퍼/비규격 저장
  const damperInp=document.querySelector('.extra-prodcd-inp[data-key="damper"]');
  const nonStdInp=document.querySelector('.extra-prodcd-inp[data-key="nonStd"]');
  items[idx].damperProdCd=(damperInp?.dataset.selected||'').trim();
  items[idx].nonStdProdCd=(nonStdInp?.dataset.selected||'').trim();
  DB.set('items',items);
  closeModal('color-prodcd-modal');
  toast(`${items[idx].name} ERP 품목코드 저장 완료`,'success');
  renderItems();
}

function toggleItemActive(itemId){
  const items=getItems();const idx=items.findIndex(i=>i.id===itemId);if(idx===-1)return;
  items[idx].isActive=!items[idx].isActive;
  items[idx].isActiveUpdatedAt=new Date().toISOString();
  DB.set('items',items);
  toast(`품목이 ${items[idx].isActive?'활성화':'비활성화'}되었습니다.`);renderItems();
}

// 계정 관리 (관리자)
let editAccountId=null;
function renderAccounts(){
  if(!requireAdmin())return;
  // 모바일 카드형 CSS 1회 등록
  if (!document.getElementById('_acc-mobile-css')) {
    const s = document.createElement('style');
    s.id = '_acc-mobile-css';
    s.textContent = `
      @media (max-width: 640px) {
        .acc-tbl-wrap .table-wrap { overflow:visible !important; }
        .acc-tbl-wrap table { display:block !important; width:100% !important; }
        .acc-tbl-wrap thead { display:none !important; }
        .acc-tbl-wrap tbody { display:block !important; }
        .acc-tbl-wrap tr {
          display:grid !important;
          grid-template-columns:1fr auto;
          grid-template-rows:auto auto auto;
          gap:4px 8px;
          padding:12px;
          margin-bottom:6px;
          background:#fff;
          border:1px solid var(--border);
          border-radius:8px;
        }
        .acc-tbl-wrap tr td { display:block !important; padding:0 !important; border:none !important; }
        /* Row 1: 아이디(좌) + 권한 뱃지(우) */
        .acc-tbl-wrap tr td:nth-child(1) { grid-column:1; grid-row:1; font-size:14px; font-weight:700; }
        .acc-tbl-wrap tr td:nth-child(3) { grid-column:2; grid-row:1; justify-self:end; }
        /* Row 2: 이름(좌) + 사원코드(우, 작게) */
        .acc-tbl-wrap tr td:nth-child(2) { grid-column:1; grid-row:2; font-size:12px; color:var(--text-2); }
        .acc-tbl-wrap tr td:nth-child(4) { grid-column:2; grid-row:2; justify-self:end; font-size:11px; color:var(--text-3); }
        .acc-tbl-wrap tr td:nth-child(4)::before { content:"사원 "; }
        /* 거래처코드는 모바일에서 숨김 (상세 모달에서 보임) */
        .acc-tbl-wrap tr td:nth-child(5) { display:none !important; }
        /* Row 3: 수정/삭제 버튼 (우측) */
        .acc-tbl-wrap tr td:nth-child(6) { grid-column:1/-1; grid-row:3; justify-self:end; margin-top:4px; padding-top:6px !important; border-top:1px solid #f1f5f9; }
      }
    `;
    document.head.appendChild(s);
  }
  const accounts=DB.get('accounts',[]);
  const rows=accounts.map(acc=>`<tr>
    <td class="td-name">${acc.id}</td>
    <td>${acc.name}</td>
    <td class="td-center"><span class="badge ${acc.role==='admin'?'badge-blue':'badge-done'}">${acc.role==='admin'?'관리자':'발주자'}</span></td>
    <td class="td-center" style="font-size:12px;color:var(--text-2)">${acc.empCd||'<span style="color:var(--text-3)">미설정</span>'}</td>
    <td class="td-center" style="font-size:12px;color:var(--text-2)">${acc.bizCd||'<span style="color:var(--text-3)">미설정</span>'}</td>
    <td class="td-center"><div style="display:flex;gap:4px;justify-content:center">
      <button class="btn btn-ghost btn-xs acc-edit-btn" data-acc-id="${acc.id}"><i class="fas fa-pen"></i> 수정</button>
      ${acc.id!==currentUser.id?`<button class="btn btn-ghost btn-xs acc-delete-btn" data-acc-id="${acc.id}" style="color:var(--danger)"><i class="fas fa-trash"></i> 삭제</button>`:'<span class="td-muted" style="font-size:11px;padding:3px 8px">현재 계정</span>'}
    </div></td>
  </tr>`).join('');
  document.getElementById('content').innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;gap:12px;flex-wrap:wrap">
      <div><div class="section-title">계정 관리</div><div class="section-sub">관리자 및 발주자 계정을 관리합니다.</div></div>
      <button class="btn btn-primary" id="add-account-btn"><i class="fas fa-plus"></i> 계정 추가</button>
    </div>
    <div class="card acc-tbl-wrap"><div class="table-wrap"><table>
      <thead><tr><th>아이디</th><th>이름</th><th class="td-center">권한</th><th class="td-center">사원코드</th><th class="td-center">거래처코드</th><th class="td-center">관리</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div></div>`;
  document.getElementById('add-account-btn').addEventListener('click',()=>openAccountModal(null));
}

function openAccountModal(accId){
  editAccountId=accId;
  const isEdit=accId!==null;
  document.getElementById('account-modal-title').textContent=isEdit?'계정 수정':'계정 추가';
  if(isEdit){
    const acc=DB.get('accounts',[]).find(a=>a.id===accId);if(!acc)return;
    document.getElementById('acc-id').value=acc.id;document.getElementById('acc-id').disabled=true;
    document.getElementById('acc-name').value=acc.name;
    document.getElementById('acc-email').value=acc.email||'';
    document.getElementById('acc-role').value=acc.role;
    document.getElementById('acc-pw').value='';
    document.getElementById('acc-pw').placeholder='입력 시 재설정 이메일 발송';
    document.getElementById('acc-pw-label').innerHTML='비밀번호';
    document.getElementById('acc-pw-hint').style.display='block';
    document.getElementById('acc-emp-cd').value=acc.empCd||'';
    document.getElementById('acc-biz-cd').value=acc.bizCd||'';
    document.getElementById('acc-ecount-fields').style.display='block';
    // 납품처 필드 (발주자만 표시)
    document.getElementById('acc-delivery-name').value=acc.deliveryName||'';
    document.getElementById('acc-delivery-group').style.display=(acc.role==='orderer')?'':'none';
  }else{
    document.getElementById('acc-id').value='';document.getElementById('acc-id').disabled=false;
    document.getElementById('acc-name').value='';
    document.getElementById('acc-email').value='';
    document.getElementById('acc-role').value='orderer';
    document.getElementById('acc-pw').value='';
    document.getElementById('acc-pw').placeholder='비밀번호';
    document.getElementById('acc-pw-label').innerHTML='비밀번호 <span class="req">*</span>';
    document.getElementById('acc-pw-hint').style.display='none';
    document.getElementById('acc-emp-cd').value='';
    document.getElementById('acc-biz-cd').value='';
    document.getElementById('acc-ecount-fields').style.display='none';
    document.getElementById('acc-delivery-name').value='';
    document.getElementById('acc-delivery-group').style.display='';
  }
  // 권한 변경 시 납품처 필드 표시/숨김 (1회 등록)
  const _roleSel=document.getElementById('acc-role');
  if(_roleSel && !_roleSel._deliveryToggleBound){
    _roleSel._deliveryToggleBound=true;
    _roleSel.addEventListener('change',e=>{
      document.getElementById('acc-delivery-group').style.display=(e.target.value==='orderer')?'':'none';
    });
  }
  openModal('account-modal');
}
async function submitAccount(){
  const id=document.getElementById('acc-id').value.trim();
  const pw=document.getElementById('acc-pw').value;
  const name=document.getElementById('acc-name').value.trim();
  const email=document.getElementById('acc-email').value.trim();
  const role=document.getElementById('acc-role').value;
  const empCd=document.getElementById('acc-emp-cd').value.trim();
  const bizCd=document.getElementById('acc-biz-cd').value.trim();
  const deliveryNameInput=document.getElementById('acc-delivery-name').value.trim();
  // 발주자면 입력값 우선, 비어있으면 name으로 자동 채움 (안전망)
  const deliveryName=(role==='orderer')?(deliveryNameInput||name):'';
  if(!id){toast('아이디를 입력해주세요.','error');return;}
  if(!name){toast('이름을 입력해주세요.','error');return;}
  if(!email){toast('이메일을 입력해주세요.','error');return;}
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){toast('올바른 이메일 형식이 아닙니다.','error');return;}
  const accounts=DB.get('accounts',[]);
  const isEdit=editAccountId!==null;
  if(isEdit){
    const idx=accounts.findIndex(a=>a.id===editAccountId);if(idx===-1)return;
    accounts[idx].name=name;accounts[idx].role=role;accounts[idx].email=email;
    accounts[idx].empCd=empCd;accounts[idx].bizCd=bizCd;
    if(role==='orderer')accounts[idx].deliveryName=deliveryName;
    if(pw){
      // 비밀번호 변경 요청 시 재설정 이메일 발송 (관리자는 타 계정 pw를 직접 변경 불가)
      if(window._fbAuth){
        try{
          await window._fbAuth.sendPasswordResetEmail(email);
          toast('비밀번호 재설정 이메일을 발송했습니다.','success');
        }catch(e){
          toast('재설정 이메일 발송 실패: '+email,'error');
          console.warn('[비밀번호 재설정 이메일 실패]',e.code,e.message);
        }
      }
    }
  }else{
    if(accounts.find(a=>a.id===id)){toast('이미 존재하는 아이디입니다.','error');return;}
    if(accounts.find(a=>a.email&&a.email===email)){toast('이미 가입된 이메일입니다.','error');return;}
    if(!pw){toast('비밀번호를 입력해주세요.','error');return;}
    if(!window._fbAuth){toast('서버 연결 중입니다. 잠시 후 다시 시도해주세요.','error');return;}
    try{
      await window._fbAuth.createUserWithEmailAndPassword(email,pw);
    }catch(e){
      if(e.code==='auth/email-already-in-use'){
        // 툭탁 등 같은 Firebase에서 이미 가입된 이메일 → Auth 생성 건너뛰고 계속 진행
      }else{
        toast('계정 생성 중 오류가 발생했습니다.','error');console.warn('[Firebase Auth 계정 생성 실패]',e.code,e.message);
        return;
      }
    }
    // pw 없이 저장 — 발주자는 납품처 필드 입력값 우선, 없으면 name으로 자동 채움
    const newAcc={id,name,email,role,empCd,bizCd};
    if(role==='orderer') newAcc.deliveryName=deliveryName;
    accounts.push(newAcc);
  }
  DB.set('accounts',accounts);closeModal('account-modal');
  toast(isEdit?'계정이 수정되었습니다.':'계정이 추가되었습니다.','success');renderAccounts();
}
function deleteAccount(accId){
  if(accId===currentUser.id){toast('현재 로그인 중인 계정은 삭제할 수 없습니다.','error');return;}
  if(!confirm('계정을 삭제하시겠습니까?'))return;
  DB.set('accounts',DB.get('accounts',[]).filter(a=>a.id!==accId));
  toast('계정이 삭제되었습니다.','success');renderAccounts();
}

// 전역 이벤트 위임 (content 영역)
document.getElementById('content').addEventListener('click',async e=>{
  // 대시보드/공통 data-nav 카드 클릭
  const navEl=e.target.closest('[data-nav]');
  if(navEl&&!navEl.closest('#sb-nav')){navigate(navEl.dataset.nav);return;}
  // 발주서 상세 버튼
  const orderBtn=e.target.closest('.order-detail-btn');
  if(orderBtn){openOrderDetail(parseInt(orderBtn.dataset.orderId));return;}
  // 발주서 취소 버튼 (관리자 전용)
  // 상태 변경 버튼
  const statusChangeBtn=e.target.closest('.status-change-btn');
  if(statusChangeBtn){
    const oid=parseInt(statusChangeBtn.dataset.orderId);
    const ns=statusChangeBtn.dataset.newStatus;
    const confirmMsg=ns==='취소'?'취소하면 차감된 재고가 복구됩니다. 계속하시겠습니까?':`상태를 '${ns}'으로 변경하시겠습니까?`;
    if(confirm(confirmMsg)){
      try{ if(await changeOrderStatus(oid,ns)){closeModal('order-detail-modal');if(currentView==='orders')renderOrders();else if(currentView==='dashboard')renderDashboard();} }
      catch(_e){ toast(((_e&&_e.message)||'상태 변경 실패. 다시 시도해주세요.'),'error'); }
    }
    return;
  }
  const cancelBtn=e.target.closest('.order-cancel-btn');
  if(cancelBtn){
    const oid=parseInt(cancelBtn.dataset.orderId);
    openOrderCancelModal(oid);
    return;
  }
  // 취소 되돌리기 버튼
  const uncancelBtn=e.target.closest('.order-uncancel-btn');
  if(uncancelBtn){
    e.stopPropagation();
    const oid=parseInt(uncancelBtn.dataset.orderId);
    if(confirm('이 발주서의 취소를 되돌립니다.\n재고가 다시 차감되고 상태가 취소 전으로 복원됩니다.\n계속할까요?')){
      try{ if(await uncancelOrder(oid)) renderOrders(); }
      catch(_e){ toast(((_e&&_e.message)||'취소 되돌리기 실패. 다시 시도해주세요.'),'error'); }
    }
    return;
  }
  // 재발주 버튼
  const reorderBtn=e.target.closest('.reorder-btn');
  if(reorderBtn){
    const oid=parseInt(reorderBtn.dataset.orderId);
    copyOrder(oid);
    return;
  }
  // 발주서 행 클릭
  const orderRow=e.target.closest('.order-row');
  if(orderRow&&!e.target.closest('button')){openOrderDetail(parseInt(orderRow.dataset.orderId));return;}
  // 재고 기록 발주번호 클릭
  const slogOrderLink=e.target.closest('.slog-order-link');
  if(slogOrderLink){openOrderDetail(parseInt(slogOrderLink.dataset.orderId));return;}
  // 발주필요 완료 버튼
  const prBtn=e.target.closest('.pr-complete-btn');
  if(prBtn){showPRConfirm(parseInt(prBtn.dataset.prId));return;}
  // 재고 처리 버튼
  const invBtn=e.target.closest('.inv-action-btn');
  if(invBtn){openInvModal(parseInt(invBtn.dataset.invId),invBtn.dataset.invType);return;}
  // [2026-07-28] 모바일 재고 카드 탭 → 색상별 재고 펼치기/접기
  const invMainRow=e.target.closest('#inv-stock-table tr.inv-main-row');
  if(invMainRow && !e.target.closest('button')){
    invMainRow.classList.toggle('expanded');
    // 인접한 색상 서브 행들도 같이 토글 (다음 inv-main-row 전까지)
    let sib=invMainRow.nextElementSibling;
    while(sib && sib.classList.contains('inv-color-row')){
      sib.classList.toggle('expanded');
      sib=sib.nextElementSibling;
    }
    return;
  }
  // 품목별 재고 기록 버튼 → 하단 기록 영역 필터
  const logBtn=e.target.closest('.inv-log-filter-btn');
  if(logBtn){
    stockLogItem=logBtn.dataset.itemId;
    stockLogFilter='';stockLogType='';stockLogDateFrom='';stockLogDateTo='';
    renderInventory();
    setTimeout(()=>{const el=document.getElementById('inv-log-section-title');if(el)el.scrollIntoView({behavior:'smooth',block:'start'});},100);
    return;
  }

  // 품목 활성 토글
  const toggleBtn=e.target.closest('.toggle-active-btn');
  if(toggleBtn){toggleItemActive(parseInt(toggleBtn.dataset.itemId));return;}
  // 계정 수정 버튼
  const accEditBtn=e.target.closest('.acc-edit-btn');
  if(accEditBtn){openAccountModal(accEditBtn.dataset.accId);return;}
  // 계정 삭제 버튼
  const accDelBtn=e.target.closest('.acc-delete-btn');
  if(accDelBtn){deleteAccount(accDelBtn.dataset.accId);return;}
  // 이력 탭
  const histTabBtn=e.target.closest('.hist-tab');
  if(histTabBtn){histTab=histTabBtn.dataset.histTab;updateHistTabs();renderHistoryContent();return;}
});

// 선반 태그 제거 이벤트 (modal-body 이벤트 위임으로 처리)
// 코너선반 삭제 + 색상 변경 이벤트
document.addEventListener('click',e=>{
  const btn=e.target.closest('.corner-remove-btn');
  if(!btn)return;
  const idx=parseInt(btn.dataset.idx);
  cornerEntries.splice(idx,1);
  renderCornerRows();
});
// 선반 행 삭제 이벤트
document.addEventListener('click',e=>{
  const btn=e.target.closest('.shelf-row-remove-btn');
  if(!btn)return;
  const idx=parseInt(btn.dataset.idx);
  shelfRowEntries.splice(idx,1);
  renderShelfRows();
});
// 옷봉 행 삭제 이벤트
document.addEventListener('click',e=>{
  const btn=e.target.closest('.rod-remove-btn');
  if(!btn)return;
  rodEntries.splice(parseInt(btn.dataset.idx),1);
  renderRodRows();
});

// ── 수량 input 방향키 이동 (ArrowUp/Down) ──
document.addEventListener('keydown',e=>{
  if(e.key!=='ArrowUp'&&e.key!=='ArrowDown')return;
  const el=e.target;
  // 수량 관련 input만 처리 (stepper input, qty input)
  const isQtyInput=el.closest('.qty-stepper')||el.classList.contains('upper-qty')||
    el.classList.contains('drawer-qty')||el.id==='rod-size'||el.id==='rod-qty'||
    el.id==='shelf-qty'||el.id==='corner-qty';
  if(!isQtyInput)return;
  e.preventDefault();
  // 모달 body 안의 모든 수량 input 수집
  const modal=document.getElementById('order-modal');
  if(!modal)return;
  const allQty=[...modal.querySelectorAll('.qty-stepper input, .upper-qty, .drawer-qty')];
  const idx=allQty.indexOf(el);
  if(idx===-1)return;
  const next=e.key==='ArrowDown'?allQty[idx+1]:allQty[idx-1];
  if(next){next.focus();next.select();}
},true);

// 코너선반 Enter 키 추가
document.addEventListener('keydown',e=>{
  if(e.key!=='Enter')return;
  const inp=e.target;
  if(inp.id==='shelf-size'){document.getElementById('shelf-qty')&&document.getElementById('shelf-qty').focus();}
  else if(inp.id==='shelf-qty'){addShelfRow();}
  else if(inp.id==='corner-qty'||inp.id==='corner-width'||inp.id==='corner-height'){
    if(inp.id==='corner-qty')addCornerRow();
    else if(inp.id==='corner-width')document.getElementById('corner-height')&&document.getElementById('corner-height').focus();
    else if(inp.id==='corner-height')document.getElementById('corner-qty')&&document.getElementById('corner-qty').focus();
  }
});

// (shelf-qty-input은 더 이상 사용되지 않음)

// 초기화 및 세션 복원

// ── 앱 시작 (인증 게이트 → Firestore 동기화 → 초기화 → 인증세션 복원) ─────────
let _booted=false; let _authRestored=false;
function attachWatchers(){
  // Codex 4차 보강: 중복 부착 방지 (rules read 제한 시 비로그인 시점 onSnapshot 차단)
  if(window._watchersAttached) return;
  window._watchersAttached = true;
  if(window._FS && typeof window._FS.watchPriceSettings === 'function'){
    window._FS.watchPriceSettings(()=>{
      if(currentView==='price-settings') renderPriceSettings();
      else if(currentView==='items') renderItems();
    });
  }
  if(window._FS && typeof window._FS.watchData === 'function'){
    window._FS.watchData('orders',()=>{ if(currentView==='orders') renderOrders(); else if(currentView==='dashboard') renderDashboard(); });
    window._FS.watchData('inventory',()=>{ if(currentView==='inventory') renderInventory(); else if(currentView==='stock-view') renderStockView(); else if(currentView==='shortage-view') renderShortageView(); });
    window._FS.watchData('logs',()=>{ if(currentView==='dashboard') renderDashboard(); });
    window._FS.watchData('accounts',()=>{ if(currentView==='accounts') renderAccounts(); });
    window._FS.watchData('items',()=>{ if(currentView==='items') renderItems(); else if(currentView==='dashboard') renderDashboard(); else if(currentView==='purchase-requests') renderPurchaseRequests(); });
    window._FS.watchData('purchase_requests',()=>{ if(currentView==='purchase-requests') renderPurchaseRequests(); else if(currentView==='dashboard') renderDashboard(); });
    window._FS.watchData('invoices',()=>{
      if(currentView==='orders'&&typeof renderOrders==='function') renderOrders();
      else if(currentView==='settlement'&&typeof loadData==='function') loadData();
      else if(currentView==='ledger'&&typeof renderLedger==='function') renderLedger();
    });
  }
}
window.addEventListener('hanger:invoices-changed',()=>{
  if(currentView==='orders'&&typeof renderOrders==='function') renderOrders();
  else if(currentView==='settlement'&&typeof loadData==='function') loadData();
  else if(currentView==='ledger'&&typeof renderLedger==='function') renderLedger();
});
async function _bootSequence(){
  if(_booted) return;
  _booted=true;
  try{
    await syncFromServer();
    await loadMigrationsCache();
    await migrateLegacyLocalOnce();
    if(window._fbAuth&&window._fbAuth.currentUser){ await loadUserPrefs(); }
    initData();
    await _seedDemoStock();
    setLoginTab('orderer');
    if(typeof initLocalTestAccountSwitcher==='function')initLocalTestAccountSwitcher();
    ['login-pw','reg-pw','reg-pw2','setup-pw','setup-pw2'].forEach(wrapPwToggle);
    initLoginPrefs_();
  }finally{
    window._booted=true;
  }
  // Codex 4차 보강: attachWatchers 호출은 _postLoginResync 성공 후로 이동
  // (rules read 제한 시 비로그인 부트에서 onSnapshot 권한 거부 차단)
}
(function startApp(){
  if(window._fbAuth&&typeof window._fbAuth.onAuthStateChanged==='function'){
    window._fbAuth.onAuthStateChanged(async (fbUser)=>{
      const _first=!_booted;
      await _bootSequence();
      if(!_first) return;
      if(currentUser) return;
      if(_authRestored) return; _authRestored=true;
      if(fbUser){
        try{
          // Codex 3차 보강: 자동 복원 시점에 인증된 상태로 데이터 다시 받음 (중복 방지 플래그)
          if(typeof window._postLoginResync==='function') await window._postLoginResync();
          const accs=DB.get('accounts',[]);
          let acc=fbUser.email?accs.find(a=>a.email===fbUser.email):null;
          if(acc){
            currentUser={id:acc.id,name:acc.name,deliveryName:acc.deliveryName||'',role:acc.role};
            setLoginTab(acc.role==='admin'?'admin':'orderer');
            showApp();
            return;
          }
          const aOn=localStorage.getItem('sh_auto_login'),aUid=localStorage.getItem('sh_auto_login_user_id');
          if(aOn&&aUid){
            const a2=accs.find(x=>x.id===aUid);
            if(a2){
              currentUser={id:a2.id,name:a2.name,deliveryName:a2.deliveryName||'',role:a2.role};
              setLoginTab(a2.role==='admin'?'admin':'orderer');
              showApp();
              return;
            }
          }
        }catch(e){ console.warn('[인증 복원 실패]',e&&e.message); }
      }
    });
    setTimeout(()=>{ if(!_booted) _bootSequence(); },15000);
  }else{
    _bootSequence();
  }
})();

function initLoginPrefs_(){
// ── 아이디 저장 / 자동로그인 복원 ──
(function initLoginPrefs(){
  try{
    const savedId   =localStorage.getItem('sh_saved_login_id');
    const rememberOn=localStorage.getItem('sh_remember_id');
    const autoOn    =localStorage.getItem('sh_auto_login');
    const autoUserId=localStorage.getItem('sh_auto_login_user_id');

    // 체크박스 상태 복원
    const rememberEl=document.getElementById('remember-id');
    const autoEl    =document.getElementById('auto-login');
    if(rememberEl&&rememberOn) rememberEl.checked=true;
    if(autoEl&&autoOn)         {autoEl.checked=true; if(rememberEl) rememberEl.checked=true;}

    // 저장된 아이디 복원
    const idEl=document.getElementById('login-id');
    if(idEl&&savedId&&rememberOn) idEl.value=savedId;

    // ── localStorage 자동로그인 복원 ──
    // 주의: 신규 기기 최초 오프라인(서버 미수신·로컬 sh_accounts 없음) 시 accounts 비어 자동로그인 조용히 실패 — 온라인 1회 필요
    if(autoOn&&autoUserId){
      const found=DB.get('accounts',[]).find(a=>a.id===autoUserId);
      if(found){
        currentUser={id:found.id,name:found.name,deliveryName:found.deliveryName||'',role:found.role};
        setLoginTab(found.role==='admin'?'admin':'orderer');
        showApp();
        return;
      }
      localStorage.removeItem('sh_auto_login');
      localStorage.removeItem('sh_auto_login_user_id');
    }

    // 자동로그인 체크 ↔ 아이디 저장 연동
    if(autoEl&&rememberEl){
      autoEl.addEventListener('change',()=>{if(autoEl.checked) rememberEl.checked=true;});
      rememberEl.addEventListener('change',()=>{if(!rememberEl.checked) autoEl.checked=false;});
    }
  }catch(e){
    // sessionStorage/localStorage 오류 시 안전하게 무시
  }
})();
} // end initLoginPrefs_

// ── number input에서 e, +, - 입력 차단 ──
document.addEventListener('keydown', function(e){
  if(e.target.tagName==='INPUT' && e.target.type==='number'){
    if(['e','E','+','-'].includes(e.key)) e.preventDefault();
  }
});

// ── 모바일 키보드 감지: 키보드 올라올 때 하단 버튼 숨기기 ──
(function(){
  if(!window.visualViewport) return;
  const KEYBOARD_THRESHOLD = 150; // px 이상 줄어들면 키보드로 판단

  function onViewportResize(){
    const keyboardOpen = (window.innerHeight - window.visualViewport.height) > KEYBOARD_THRESHOLD;
    // 발주 등록 모달 하단 바
    const orderBottom = document.querySelector('#order-modal .order-modal-bottom');
    if(orderBottom) orderBottom.style.display = keyboardOpen ? 'none' : '';
    // 일반 모달 footer (수정 모달 등)
    const editFooter = document.querySelector('#edit-order-modal .modal-footer');
    if(editFooter) editFooter.style.display = keyboardOpen ? 'none' : '';
  }

  window.visualViewport.addEventListener('resize', onViewportResize);
})();

// ── 초기 로드 시 hash 처리 (뒤로가기 히스토리 복원) ──
document.addEventListener('DOMContentLoaded',()=>{
  const hash=location.hash.slice(1);
  if(hash&&hash!==currentView&&getNavItems().some(n=>n.id===hash)){
    navigate(hash,{addHistory:false});
  }
});



// ── 발주서 이미지 저장 (excel-print.js 로드 보장용 fallback 정의) ──
function saveImageOrder(order){
  if(!order){toast('발주 데이터가 없습니다.','error');return;}
  const baseName=(order.orderNum||(order.deliveryTo||order.siteName||'발주서')+'_'+((order.orderDate||'').replaceAll('-','')));
  const fileName=baseName+'.png';
  const imgBtn=document.getElementById('img-order-btn');
  if(imgBtn){imgBtn.disabled=true;imgBtn.innerHTML='<i class="fas fa-spinner fa-spin"></i> 이미지 생성 중...';}
  const resetBtn=()=>{if(imgBtn){imgBtn.disabled=false;imgBtn.innerHTML='<i class="fas fa-image"></i> 이미지 저장';}};

  const loadScript=(src,isLoaded)=>new Promise((res,rej)=>{
    if(isLoaded&&isLoaded()){res();return;}
    if(document.querySelector(`script[src="${src}"]`)){
      const t=setInterval(()=>{if(isLoaded&&isLoaded()){clearInterval(t);res();}},50);
      setTimeout(()=>{clearInterval(t);rej(new Error('timeout'));},10000);
      return;
    }
    const s=document.createElement('script');s.src=src;s.onload=res;s.onerror=rej;document.head.appendChild(s);
  });

  const stale=document.getElementById('__img_render_wrap__');
  if(stale) stale.remove();

  loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',()=>!!window.html2canvas)
  .then(()=>{
    const wrap=document.createElement('div');
    wrap.id='__img_render_wrap__';
    wrap.style.cssText='position:fixed;left:-10000px;top:0;width:794px;background:#fff;z-index:99999;box-sizing:border-box;padding:24px 32px;';
    wrap.innerHTML=renderOrderDocument(order);
    document.body.appendChild(wrap);
    return new Promise(res=>requestAnimationFrame(()=>requestAnimationFrame(()=>res(wrap))));
  })
  .then(wrap=>{
    return html2canvas(wrap,{scale:2,useCORS:true,allowTaint:false,backgroundColor:'#ffffff',logging:false,width:794,windowWidth:794})
      .then(canvas=>{document.body.removeChild(wrap);return canvas;});
  })
  .then(canvas=>{
    canvas.toBlob(blob=>{
      const url=URL.createObjectURL(blob);
      const link=document.createElement('a');
      link.download=fileName;
      link.href=url;
      link.click();
      setTimeout(()=>URL.revokeObjectURL(url),3000);
      resetBtn();
      toast('이미지가 다운로드되었습니다.','success');
    },'image/png');
  })
  .catch(err=>{
    console.error('이미지 생성 오류:',err);
    resetBtn();
    toast('이미지 생성 중 오류가 발생했습니다.','error');
  });
}
