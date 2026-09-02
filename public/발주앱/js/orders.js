// ── 발주 관리 (상태/잠금/목록/상세/수정/복사) ──
// 의존: js/store/db.js, js/utils/uiUtils.js, js/utils.js, js/price.js, js/inventory.js

// [2026-07-24 Codex-3차] 발주 재고 조작 창고 방어 헬퍼 (fail-closed)
// - wh가 유효(시흥/평택)면 그대로 사용
// - wh만 invalid이고 fallback이 유효면 fallback 사용 (아이템별 override 오류 방어)
// - 둘 다 invalid이면 throw
function _orderableWh(wh, fallback){
  if(wh==='시흥'||wh==='평택') return wh;
  if(fallback==='시흥'||fallback==='평택') return fallback;
  throw new Error('발주 창고 데이터 오류: wh='+wh+', fallback='+fallback);
}

// 주문 행이 실제 재고 추적 대상으로 저장됐는지 판정.
// 신규 행은 inventoryTracked를 명시한다.
// 표식이 없는 과거 행은 당시부터 재고를 차감하던 서랍장만 하위 호환 처리한다.
function _tracksInventoryLine(oi, item){
  if(oi&&typeof oi.inventoryTracked==='boolean')return oi.inventoryTracked;
  return !!item&&item.category==='서랍장';
}

// 현재 이 주문 행의 재고가 실제로 차감된 상태인지 판정.
// 신규 행은 inventoryDeducted를 사용하고, 과거 서랍장 행만 주문 단위 플래그로 fallback한다.
function _isInventoryLineDeducted(oi, item, order){
  if(oi&&typeof oi.inventoryDeducted==='boolean')return oi.inventoryDeducted;
  return !!(order&&order.stockDeducted&&_tracksInventoryLine(oi,item));
}

// 재고 부족 시 0에서 멈춰 실제 차감량이 요청량보다 작을 수 있다.
// 취소·편집 반환은 요청량이 아니라 실제 차감량만 복구해야 한다.
function _deductedQtyForLine(oi){
  if(oi&&Number.isFinite(Number(oi.inventoryDeductedQty)))return Math.max(0,Number(oi.inventoryDeductedQty));
  const requested=Math.max(0,Number(oi&&oi.requiredQty)||0);
  if(oi&&Number.isFinite(Number(oi.shortageQty)))return Math.max(0,requested-Math.max(0,Number(oi.shortageQty)));
  if(oi&&Number.isFinite(Number(oi.currentStockSnapshot)))return Math.min(requested,Math.max(0,Number(oi.currentStockSnapshot)));
  return requested;
}

// [2026-07-24 Codex-3차 atomicity] 재고 mutation 전에 모든 아이템의 warehouse를 사전 검증.
// 하나라도 실패면 즉시 throw → 어떤 items/logs/order 변경도 발생하지 않음.
// 실제 재고 추적 주문 행만 검증한다.
function _assertOrderableWarehouses(oiList, orderWh, dbItems){
  for(const oi of (oiList||[])){
    const it=dbItems.find(x=>x.id===oi.itemId);
    if(!it) continue; // 삭제된 품목은 어차피 처리 안 됨
    if(!_tracksInventoryLine(oi,it)) continue;
    // _orderableWh 호출 — 유효/fallback 판정, invalid이면 throw
    _orderableWh(oi.warehouse, orderWh);
  }
}

// ── 동시 작업 차단 가드 (Phase 1: race condition 1차 방어) ──
// 같은 발주서 + 같은 작업을 중복 실행하지 못하게 막음.
// 008 발주서 사라짐 같은 사고의 1차 원인(빠른 더블 클릭/중복 호출) 차단.
const _inflightOrders = new Set();
const _ORDER_SHARED_LOCK_TTL = 20000;
function _acquireSharedOrderLock(key){
  try{
    const lockKey='hanger_order_lock_'+key;
    const now=Date.now();
    const raw=localStorage.getItem(lockKey);
    if(raw){
      const cur=JSON.parse(raw);
      if(cur&&cur.expiresAt&&cur.expiresAt>now)return null;
    }
    const token=String(now)+'_'+Math.random().toString(36).slice(2);
    localStorage.setItem(lockKey,JSON.stringify({token,expiresAt:now+_ORDER_SHARED_LOCK_TTL}));
    const saved=JSON.parse(localStorage.getItem(lockKey)||'{}');
    return saved.token===token?{lockKey,token}:null;
  }catch(_e){
    return false;
  }
}
function _releaseSharedOrderLock(lock){
  if(!lock||!lock.lockKey)return;
  try{
    const cur=JSON.parse(localStorage.getItem(lock.lockKey)||'{}');
    if(cur&&cur.token===lock.token)localStorage.removeItem(lock.lockKey);
  }catch(_e){}
}
async function _withOrderLock(orderId, action, fn) {
  const key = `${action}-${orderId}`;
  if (_inflightOrders.has(key)) {
    if (typeof toast === 'function') toast('처리 중입니다. 잠시만 기다려주세요.', 'warning');
    return false;
  }
  const sharedLock=_acquireSharedOrderLock(key);
  if(sharedLock===null){
    if (typeof toast === 'function') toast('다른 창에서 처리 중입니다. 잠시만 기다려주세요.', 'warning');
    return false;
  }
  _inflightOrders.add(key);
  try {
    return await fn();
  } finally {
    _inflightOrders.delete(key);
    _releaseSharedOrderLock(sharedLock);
  }
}


function addStatusHistory(orderIdx, orders, newStatus, note){
  if(!orders[orderIdx].statusHistory) orders[orderIdx].statusHistory=[];
  orders[orderIdx].statusHistory.push({
    status:newStatus,
    changedBy:currentUser?currentUser.id:'',
    changedByName:currentUser?currentUser.name:'',
    changedAt:new Date().toISOString(),
    note:note||''
  });
}

function orderRecentSort(a,b){
  const key=(o)=>{
    const t=Date.parse(o.updatedAt||o.createdAt||'');
    if(!Number.isNaN(t))return t;
    const n=String(o.orderNum||'').replace(/[^0-9]/g,'');
    if(n)return Number(n);
    return Number(o.id)||0;
  };
  return key(b)-key(a);
}

function isOrderLockedState(order){
  return !!(order&&(order.isLocked===true||order.status==='발주확정'));
}


async function changeOrderStatus(orderId, newStatus){
  return _withOrderLock(orderId, 'status', async () => {
  // (핫픽스 B' 20260610) stale 캐시 사용 금지 — 서버 최신본 강제 재조회
  // 6/8 사고 진범: DB.get('orders')로 받은 stale 배열을 DB.set로 통째 덮어써 발주서 손실.
  if(typeof window._fetchOrdersFromServer!=='function'){
    toast('출고 모듈 미초기화. 새로고침 후 다시 시도하세요.','error');return false;
  }
  let orders;
  try{ orders=await window._fetchOrdersFromServer(); }
  catch(e){
    console.error("[핫픽스B'] changeOrderStatus 서버 재조회 실패:", e&&e.message);
    toast('서버 연결 확인 필요. 재시도 하세요.','error');return false;
  }
  const idx=orders.findIndex(o=>o.id===orderId);
  if(idx===-1){toast('발주서를 찾을 수 없습니다.','error');return false;}
  const order=orders[idx];
  const allowed=nextStatuses(order.status);
  if(!allowed.includes(newStatus)){toast(`'${order.status}' 상태에서 '${newStatus}'로 변경할 수 없습니다.`,'error');return false;}

  const now=new Date().toISOString();
  const wasDeducted=order.stockDeducted&&statusDeducted(order.status);
  const shouldRollback=(newStatus==='취소'||newStatus==='보관')&&wasDeducted;

  // 임시저장 → 발주확정: 재고 차감 (임시저장은 재고 미차감 상태)
  // 발주대기 → 발주확정: 발주 넣는 시점에 이미 차감됨 — 추가 차감 없음
  if(newStatus==='발주확정'&&order.status==='임시저장'&&!order.stockDeducted){
    const dbItems=DB.get('items',[]);
    const confWh=order.warehouse||'시흥';
    // 서버에서 로그 id 배치 발급 (forEach 진입 전, 실패 시 throw)
    let _logIds=[];
    const _items=(order.drawerItems||order.items||[]);
    // [2026-07-24 Codex-3차 atomicity] mutation 전에 전수 warehouse 검증
    _assertOrderableWarehouses(_items, confWh, dbItems);
    if(_items.length>0) _logIds=await _serverGetLogIds(_items.length);
    _items.forEach(oi=>{
      const iIdx=dbItems.findIndex(i=>i.id===oi.itemId);
      if(iIdx===-1)return;
      if(!_tracksInventoryLine(oi,dbItems[iIdx]))return;
      if(dbItems[iIdx].stockSiheung===undefined)dbItems[iIdx].stockSiheung=dbItems[iIdx].currentStock||0;
      if(dbItems[iIdx].stockPyeongtaek===undefined)dbItems[iIdx].stockPyeongtaek=0;
      const wh=_orderableWh(oi.warehouse, confWh);
      const whKey=getWhKey(wh);
      const cwKey=getColorWhKey(wh);
      let oiColor=dbItems[iIdx].noColor?'':(oi.color||order.sharedColor||'');
      if(oiColor&&typeof normalizeStockColor==='function')oiColor=normalizeStockColor(oiColor);
      let before, afterVal;
      if(oiColor){
        if(!dbItems[iIdx][cwKey])dbItems[iIdx][cwKey]={};
        before=typeof getColorStock==='function'?getColorStock(dbItems[iIdx][cwKey],oiColor):(dbItems[iIdx][cwKey][oiColor]||0);
        afterVal=Math.max(0,before-oi.requiredQty);
        if(typeof setColorStock==='function')setColorStock(dbItems[iIdx][cwKey],oiColor,afterVal);
        else dbItems[iIdx][cwKey][oiColor]=afterVal;
        dbItems[iIdx][whKey]=typeof sumColorStockMap==='function'?sumColorStockMap(dbItems[iIdx][cwKey]):Object.values(dbItems[iIdx][cwKey]).reduce((s,v)=>s+(v||0),0);
      } else {
        before=dbItems[iIdx][whKey];
        afterVal=Math.max(0,before-oi.requiredQty);
        dbItems[iIdx][whKey]=afterVal;
      }
      dbItems[iIdx].currentStock=(dbItems[iIdx].stockSiheung||0)+(dbItems[iIdx].stockPyeongtaek||0);
      const deductedQty=Math.max(0,before-afterVal);
      const logs=DB.get('logs',[]);
      logs.push({id:_logIds.shift(),itemId:oi.itemId,type:'발주차감',qty:-deductedQty,beforeStock:before,afterStock:afterVal,warehouse:wh,color:oiColor||'',memo:`발주 #${orderId} 확정`,orderId,createdBy:currentUser?currentUser.id:'',createdAt:now});
      DB.set('logs',logs);
      oi.inventoryTracked=true;
      oi.inventoryDeducted=true;
      oi.inventoryDeductedQty=deductedQty;
    });
    await DB.set('items',dbItems);
    orders[idx].stockDeducted=_items.some(oi=>oi.inventoryDeducted===true);
  }

  // 취소/보관 시 재고 롤백
  if(shouldRollback){
    const dbItems=DB.get('items',[]);
    const rollWh=order.warehouse||'시흥';
    // 서버에서 로그 id 배치 발급 (forEach 진입 전, 실패 시 throw)
    let _logIds=[];
    const _items=(order.drawerItems||order.items||[]);
    // [2026-07-24 Codex-3차 atomicity] mutation 전에 전수 warehouse 검증
    _assertOrderableWarehouses(_items, rollWh, dbItems);
    if(_items.length>0) _logIds=await _serverGetLogIds(_items.length);
    _items.forEach(oi=>{
      const iIdx=dbItems.findIndex(i=>i.id===oi.itemId);
      if(iIdx===-1)return;
      if(!_isInventoryLineDeducted(oi,dbItems[iIdx],order))return;
      if(dbItems[iIdx].stockSiheung===undefined)dbItems[iIdx].stockSiheung=dbItems[iIdx].currentStock||0;
      if(dbItems[iIdx].stockPyeongtaek===undefined)dbItems[iIdx].stockPyeongtaek=0;
      const wh=_orderableWh(oi.warehouse, rollWh);
      const whKey=getWhKey(wh);
      const cwKey=getColorWhKey(wh);
      let oiColor=dbItems[iIdx].noColor?'':(oi.color||order.sharedColor||'');
      if(oiColor&&typeof normalizeStockColor==='function')oiColor=normalizeStockColor(oiColor);
      const restoreQty=_deductedQtyForLine(oi);
      let before, afterVal;
      if(oiColor){
        if(!dbItems[iIdx][cwKey])dbItems[iIdx][cwKey]={};
        before=typeof getColorStock==='function'?getColorStock(dbItems[iIdx][cwKey],oiColor):(dbItems[iIdx][cwKey][oiColor]||0);
        afterVal=before+restoreQty;
        if(typeof setColorStock==='function')setColorStock(dbItems[iIdx][cwKey],oiColor,afterVal);
        else dbItems[iIdx][cwKey][oiColor]=afterVal;
        dbItems[iIdx][whKey]=typeof sumColorStockMap==='function'?sumColorStockMap(dbItems[iIdx][cwKey]):Object.values(dbItems[iIdx][cwKey]).reduce((s,v)=>s+(v||0),0);
      } else {
        before=dbItems[iIdx][whKey];
        afterVal=before+restoreQty;
        dbItems[iIdx][whKey]=afterVal;
      }
      dbItems[iIdx].currentStock=(dbItems[iIdx].stockSiheung||0)+(dbItems[iIdx].stockPyeongtaek||0);
      const logs=DB.get('logs',[]);
      logs.push({id:_logIds.shift(),itemId:oi.itemId,type:'취소롤백',qty:restoreQty,beforeStock:before,afterStock:afterVal,warehouse:wh,color:oiColor||'',memo:`발주 #${orderId} ${newStatus}`,orderId,createdBy:currentUser?currentUser.id:'',createdAt:now});
      DB.set('logs',logs);
      oi.inventoryTracked=true;
      oi.inventoryDeducted=false;
    });
    await DB.set('items',dbItems);
    orders[idx].stockDeducted=false;
    // 관련 PR 취소
    const prs=DB.get('purchase_requests',[]);
    prs.forEach(p=>{if(p.orderId===orderId&&p.status==='대기'){p.status='취소';p.updatedAt=now;}});
    DB.set('purchase_requests',prs);
  }

  orders[idx].status=newStatus;
  orders[idx].updatedAt=now;
  addStatusHistory(idx, orders, newStatus, '');
  // [2026-07-09] 유케이 사고 재발 방지: 저장 완료 확인 후 성공 토스트
  try {
    await DB.set('orders',orders);
  } catch (e) {
    toast('저장 실패. 페이지를 새로고침한 후 다시 시도해주세요.','error');
    return false;
  }
  // (핫픽스 B' 20260610) 방금 저장한 로컬 orders 기준 (재조회 불필요)
  const chgOrder=orders.find(o=>o.id===orderId);
  toast(`발주 ${chgOrder?(chgOrder.orderNum||('#'+orderId)):('#'+orderId)} 상태가 '${newStatus}'로 변경되었습니다.`,'success');

  // FM 흐름: 출고확정(출고완료) 시 거래명세서 자동 발급,
  // 취소/보관 시 기존 명세서는 취소 처리한다.
  if(newStatus==='출고완료'&&chgOrder&&window.LumaneInvoice&&typeof window.LumaneInvoice.autoCreateForOrder==='function'){
    window.LumaneInvoice.autoCreateForOrder(chgOrder,{reason:'shipping-complete'}).catch(e=>console.warn('[Invoice 자동발급]',e&&e.message));
  }
  if((newStatus==='취소'||newStatus==='보관')&&chgOrder&&window.LumaneInvoice&&typeof window.LumaneInvoice.cancelByOrderNum==='function'){
    window.LumaneInvoice.cancelByOrderNum(chgOrder.orderNum).catch(e=>console.warn('[Invoice 취소]',e&&e.message));
  }

  return true;
  });
}



// 이카운트 연동 코드 제거됨 (2026-06-11) — _createEcountSaleFromOrder 및 호출부 삭제


// 발주 취소: 차감된 재고 롤백
async function cancelOrder(orderId, cancelReason){
  return _withOrderLock(orderId, 'cancel', async () => {
  const orders=DB.get('orders',[]);
  const idx=orders.findIndex(o=>o.id===orderId);
  if(idx===-1){toast('발주서를 찾을 수 없습니다.','error');return false;}
  const order=orders[idx];
  if(order.status==='cancelled'){toast('이미 취소된 발주서입니다.','error');return false;}

  // [2026-07-31 라운드3 A4] PC간 동시 취소 방지 — 서버 마커 락 획득
  const _actorId=(typeof currentUser!=='undefined'&&currentUser)?currentUser.id:'';
  let _cancelLockAcquired=false;
  if(typeof window._acquireServerCancelLock==='function'){
    const _lockRes=await window._acquireServerCancelLock(orderId,_actorId);
    if(!_lockRes||!_lockRes.ok){
      if(_lockRes&&_lockRes.reason==='locked'){
        toast('다른 사용자가 이미 취소를 진행 중입니다. 잠시 후 다시 시도해주세요.','warning');
      } else {
        toast('취소 잠금 획득 실패. 새로고침 후 다시 시도해주세요.','error');
      }
      return false;
    }
    _cancelLockAcquired=true;
  }
  try{
  // [2026-07-31 Codex] H4 경량 방어: 취소 직전 서버 주문 상태 재확인.
  // 다른 탭/PC가 먼저 취소해서 stockDeducted=false가 된 경우 두 번째 재고 롤백을 막는다.
  if(order.stockDeducted&&window._FS&&typeof window._FS.get==='function'){
    let serverOrders;
    try{
      // [Phase 5] 옛 hanger_data/orders 얼어붙음 → 새 컬렉션 사용
      const _fetcher = (typeof window._FS.getAllOrders==='function')
        ? window._FS.getAllOrders({fromServer:true})
        : window._FS.get('orders',{fromServer:true});
      serverOrders=await Promise.race([
        _fetcher,
        new Promise((_,rj)=>setTimeout(()=>rj(new Error('TIMEOUT')),8000))
      ]);
    }catch(e){
      toast('서버 주문 상태 확인 실패. 새로고침 후 다시 취소해주세요.','error');
      return false;
    }
    if(Array.isArray(serverOrders)){
      const serverOrder=serverOrders.find(o=>o&&o.id===orderId);
      if(serverOrder&&(serverOrder.status==='취소'||serverOrder.status==='cancelled'||serverOrder.stockDeducted===false)){
        orders[idx]={...order,...serverOrder};
        try{ await DB.set('orders',orders); }catch(_e){}
        toast('이미 취소 처리된 발주서입니다. 새로고침 후 확인해주세요.','warning');
        return false;
      }
    }
  }

  // 재고 롤백: stockDeducted가 true인 경우에만
  if(order.stockDeducted){
    // [2026-07-31 라운드2 A3] mutation 시작점을 서버 최신 items로 강제.
    // 로컬 stale에서 rollback하면 다른 탭이 방금 조정한 값이 덮어써져 소실됨.
    // 서버 스냅샷에 +qty 얹으면 다른 탭 조정도 보존됨.
    let items;
    if(window._FS&&typeof window._FS.get==='function'){
      let serverItems;
      try{
        serverItems=await Promise.race([
          window._FS.get('items',{fromServer:true}),
          new Promise((_,rj)=>setTimeout(()=>rj(new Error('TIMEOUT')),8000))
        ]);
      }catch(e){
        toast('서버 최신 재고 확인 실패. 새로고침 후 다시 취소해주세요.','error');
        return false;
      }
      if(!Array.isArray(serverItems)){
        toast('서버 최신 재고 확인 실패. 새로고침 후 다시 취소해주세요.','error');
        return false;
      }
      items=serverItems.map(i=>({...i,
        colorStockSiheung:i.colorStockSiheung?{...i.colorStockSiheung}:i.colorStockSiheung,
        colorStockPyeongtaek:i.colorStockPyeongtaek?{...i.colorStockPyeongtaek}:i.colorStockPyeongtaek
      }));
    } else {
      items=DB.get('items',[]);
    }
    const rollbackNow=new Date().toISOString();
    const orderWh=order.warehouse||'시흥';
    // 서버에서 로그 id 배치 발급 (forEach 진입 전, 실패 시 throw)
    let _logIds=[];
    const _items=(order.drawerItems||order.items||[]);
    // [2026-07-24 Codex-3차 atomicity] mutation 전에 전수 warehouse 검증
    _assertOrderableWarehouses(_items, orderWh, items);
    if(_items.length>0) _logIds=await _serverGetLogIds(_items.length);
    _items.forEach(oi=>{
      const iIdx=items.findIndex(i=>i.id===oi.itemId);
      if(iIdx===-1)return;
      if(_isInventoryLineDeducted(oi,items[iIdx],order)){
        if(items[iIdx].stockSiheung===undefined)items[iIdx].stockSiheung=items[iIdx].currentStock||0;
        if(items[iIdx].stockPyeongtaek===undefined)items[iIdx].stockPyeongtaek=0;
        const wh=_orderableWh(oi.warehouse, orderWh);
        const whKey=getWhKey(wh);
        const cwKey=getColorWhKey(wh);
        let oiColor=items[iIdx].noColor?'':(oi.color||order.sharedColor||'');
        if(oiColor&&typeof normalizeStockColor==='function')oiColor=normalizeStockColor(oiColor);
        const restoreQty=_deductedQtyForLine(oi);
        let before, afterVal;
        if(oiColor){
          if(!items[iIdx][cwKey])items[iIdx][cwKey]={};
          before=typeof getColorStock==='function'?getColorStock(items[iIdx][cwKey],oiColor):(items[iIdx][cwKey][oiColor]||0);
          afterVal=before+restoreQty;
          if(typeof setColorStock==='function')setColorStock(items[iIdx][cwKey],oiColor,afterVal);
          else items[iIdx][cwKey][oiColor]=afterVal;
          items[iIdx][whKey]=typeof sumColorStockMap==='function'?sumColorStockMap(items[iIdx][cwKey]):Object.values(items[iIdx][cwKey]).reduce((s,v)=>s+(v||0),0);
        } else {
          before=items[iIdx][whKey];
          afterVal=before+restoreQty;
          items[iIdx][whKey]=afterVal;
        }
        items[iIdx].currentStock=(items[iIdx].stockSiheung||0)+(items[iIdx].stockPyeongtaek||0);
        const logs3=DB.get('logs',[]);
        logs3.push({id:_logIds.shift(),itemId:oi.itemId,type:'취소롤백',qty:restoreQty,beforeStock:before,afterStock:afterVal,warehouse:wh,color:oiColor||'',memo:`발주 #${orderId} 취소`,orderId,createdBy:currentUser?currentUser.id:'',createdAt:rollbackNow});
        DB.set('logs',logs3);
        oi.inventoryTracked=true;
        oi.inventoryDeducted=false;
      }
    });
    await DB.set('items',items);
  }

  // 발주서 상태 취소로 변경
  const cancelNow=new Date().toISOString();
  orders[idx].status='취소';
  orders[idx].cancelReason=cancelReason||'';
  orders[idx].cancelledAt=cancelNow;
  orders[idx].updatedAt=cancelNow;
  orders[idx].stockDeducted=false;
  addStatusHistory(idx, orders, '취소', cancelReason||'');
  // [2026-07-09] 유케이 사고 재발 방지: 저장 완료 확인
  try {
    await DB.set('orders',orders);
  } catch (e) {
    toast('취소 저장 실패. 페이지를 새로고침한 후 다시 시도해주세요.','error');
    return false;
  }

  // 관련 발주 필요 목록도 취소 처리
  const prs=DB.get('purchase_requests',[]);
  prs.forEach(p=>{if(p.orderId===orderId&&p.status==='대기'){p.status='취소';p.updatedAt=new Date().toISOString();}});
  DB.set('purchase_requests',prs);

  // [2026-08-04] cancel audit log — 스냅샷 diff 대조용 + 감사 추적
  // 실패해도 취소 자체는 성공 처리 (로그 실패로 취소 롤백 X)
  try{
    if(window._FS&&typeof window._FS.collectionAdd==='function'){
      const _eventId='cancel_'+orderId+'_'+Date.now();
      const _auditWrite=window._FS.collectionAdd('hanger_orders_cancel_log',_eventId,{
        id:_eventId,
        type:'발주취소',
        orderId:orderId,
        orderNum:order.orderNum||'',
        reason:cancelReason||'',
        actor:{
          userId:currentUser?currentUser.id:'',
          userName:currentUser?(currentUser.name||''):'',
          role:(typeof isAdmin==='function'&&isAdmin())?'admin':'user'
        },
        orderSnapshot:{
          deliveryTo:order.deliveryTo||'',
          shipDate:order.shipDate||'',
          totalAmount:Number(order.totalAmount)||0,
          status:order.status||''
        },
        at:(typeof firebase!=='undefined'&&firebase.firestore&&firebase.firestore.FieldValue)
          ? firebase.firestore.FieldValue.serverTimestamp()
          : new Date().toISOString()
      });
      // 취소 저장은 이미 완료된 상태이므로, 감사 로그 지연이 UI를 무기한 대기시키지 않게 한다.
      let _auditTimer;
      try{
        await Promise.race([
          _auditWrite,
          new Promise((_,reject)=>{
            _auditTimer=setTimeout(()=>reject(new Error('감사 로그 저장 타임아웃')),5000);
          })
        ]);
      }finally{
        if(_auditTimer)clearTimeout(_auditTimer);
      }
    }
  }catch(logErr){
    console.warn('[cancel audit log 실패]',logErr&&logErr.message);
  }

  return true;
  }finally{
    if(_cancelLockAcquired&&typeof window._releaseServerCancelLock==='function'){
      try{ await window._releaseServerCancelLock(orderId); }catch(_e){}
    }
  }
  });
}

// ══════════════════════════════════════════════════
// 발주 취소 되돌리기 — cancelOrder()의 역순
// 권한: 관리자 OR 발주자 본인
// 재고 마이너스 허용 (차단하지 않음, 결과만 toast로 안내)
// ══════════════════════════════════════════════════
async function uncancelOrder(orderId){
  return _withOrderLock(orderId, 'uncancel', async () => {
  const orders=DB.get('orders',[]);
  const idx=orders.findIndex(o=>o.id===orderId);
  if(idx===-1){toast('발주서를 찾을 수 없습니다.','error');return false;}
  const order=orders[idx];
  if(order.status!=='취소'){toast('취소된 발주서가 아닙니다.','error');return false;}

  // 권한: 관리자 OR 본인
  const isOwner=currentUser && order.createdBy===currentUser.id;
  if(!isAdmin() && !isOwner){toast('권한이 없습니다.','error');return false;}

  // 직전 상태 추적 (statusHistory 역방향 스캔, '취소' 이전 status 찾기)
  let prevStatus='발주대기';
  if(Array.isArray(order.statusHistory)){
    for(let i=order.statusHistory.length-1;i>=0;i--){
      const s=order.statusHistory[i].status;
      if(s && s!=='취소'){prevStatus=s;break;}
    }
  }

  // 재고 재차감 (stockDeducted가 false인 정상 케이스만)
  const shortages=[]; // {name, color, deficit}
  let restoredAnyInventory=!!order.stockDeducted;
  if(!order.stockDeducted){
    const items=DB.get('items',[]);
    const restoreNow=new Date().toISOString();
    const orderWh=order.warehouse||'시흥';
    // 서버에서 로그 id 배치 발급 (forEach 진입 전, 실패 시 throw)
    let _logIds=[];
    const _items=(order.drawerItems||order.items||[]);
    // [2026-07-24 Codex-3차 atomicity] mutation 전에 전수 warehouse 검증
    _assertOrderableWarehouses(_items, orderWh, items);
    if(_items.length>0) _logIds=await _serverGetLogIds(_items.length);
    _items.forEach(oi=>{
      const iIdx=items.findIndex(i=>i.id===oi.itemId);
      if(iIdx===-1)return;
      if(_tracksInventoryLine(oi,items[iIdx])){
        if(items[iIdx].stockSiheung===undefined)items[iIdx].stockSiheung=items[iIdx].currentStock||0;
        if(items[iIdx].stockPyeongtaek===undefined)items[iIdx].stockPyeongtaek=0;
        const wh=_orderableWh(oi.warehouse, orderWh);
        const whKey=getWhKey(wh);
        const cwKey=getColorWhKey(wh);
        let oiColor=items[iIdx].noColor?'':(oi.color||order.sharedColor||'');
        if(oiColor&&typeof normalizeStockColor==='function')oiColor=normalizeStockColor(oiColor);
        const redeductQty=_deductedQtyForLine(oi);
        let before, afterVal;
        if(oiColor){
          if(!items[iIdx][cwKey])items[iIdx][cwKey]={};
          before=typeof getColorStock==='function'?getColorStock(items[iIdx][cwKey],oiColor):(items[iIdx][cwKey][oiColor]||0);
          afterVal=before-redeductQty;
          if(typeof setColorStock==='function')setColorStock(items[iIdx][cwKey],oiColor,afterVal);
          else items[iIdx][cwKey][oiColor]=afterVal;
          items[iIdx][whKey]=typeof sumColorStockMap==='function'?sumColorStockMap(items[iIdx][cwKey]):Object.values(items[iIdx][cwKey]).reduce((s,v)=>s+(v||0),0);
        } else {
          before=items[iIdx][whKey]||0;
          afterVal=before-redeductQty;
          items[iIdx][whKey]=afterVal;
        }
        items[iIdx].currentStock=(items[iIdx].stockSiheung||0)+(items[iIdx].stockPyeongtaek||0);
        if(afterVal<0){
          shortages.push({name:items[iIdx].name||('#'+oi.itemId),color:oiColor||'-',deficit:-afterVal});
        }
        const logs3=DB.get('logs',[]);
        logs3.push({id:_logIds.shift(),itemId:oi.itemId,type:'취소되돌림',qty:-redeductQty,beforeStock:before,afterStock:afterVal,warehouse:wh,color:oiColor||'',memo:`발주 #${orderId} 취소 되돌림`,orderId,createdBy:currentUser?currentUser.id:'',createdAt:restoreNow});
        DB.set('logs',logs3);
        oi.inventoryTracked=true;
        oi.inventoryDeducted=true;
        restoredAnyInventory=true;
      }
    });
    await DB.set('items',items);
  }

  // 발주서 상태 복원
  const restoreNow2=new Date().toISOString();
  orders[idx].status=prevStatus;
  delete orders[idx].cancelReason;
  delete orders[idx].cancelledAt;
  orders[idx].stockDeducted=restoredAnyInventory;
  orders[idx].updatedAt=restoreNow2;
  // [2026-08-27] 취소 되돌림 감사 로그: prevStatus='발주확정' 복원 시 note에 명시.
  //   getSettlementDate는 정책 A(최초 확정일 채택)라 정산 기준일은 원래 확정 이벤트로 유지 — 안전.
  addStatusHistory(idx, orders, prevStatus, prevStatus==='발주확정'?'취소 되돌림(복원, 재확정 아님)':'취소 되돌림');
  // [2026-07-09] 유케이 사고 재발 방지: 저장 완료 확인
  try {
    await DB.set('orders',orders);
  } catch (e) {
    toast('되돌리기 저장 실패. 페이지를 새로고침한 후 다시 시도해주세요.','error');
    return false;
  }

  // 관련 발주필요(PR) 복원
  const prs=DB.get('purchase_requests',[]);
  prs.forEach(p=>{if(p.orderId===orderId&&p.status==='취소'){p.status='대기';p.updatedAt=new Date().toISOString();}});
  DB.set('purchase_requests',prs);

  // 결과 toast
  if(shortages.length>0){
    const msg=shortages.slice(0,3).map(s=>`${s.name}${s.color!=='-'?'('+s.color+')':''} -${s.deficit}`).join(', ');
    const more=shortages.length>3?` 외 ${shortages.length-3}건`:'';
    toast(`복원 완료. 단, 재고 부족: ${msg}${more}`, 'warning');
  } else {
    toast('취소가 되돌려졌습니다. 재고가 다시 차감되었습니다.','success');
  }
  return true;
  });
}

function openOrderCancelModal(orderId){
  _cancelTargetOrderId=orderId;
  const input=document.getElementById('cancel-reason-input');
  const err=document.getElementById('cancel-reason-error');
  if(input)input.value='';
  if(err)err.style.display='none';
  const confirmBtn=document.getElementById('order-cancel-confirm-btn');
  if(confirmBtn){
    confirmBtn.onclick=async ()=>{
      const reason=(input?input.value:'').trim();
      if(!reason){if(err)err.style.display='block';return;}
      if(err)err.style.display='none';
      closeModal('order-cancel-modal');
      try{
        if(await cancelOrder(_cancelTargetOrderId,reason)){
          toast('발주서가 취소되었습니다. 재고가 복구되었습니다.','success');
          renderOrders();
        }
      }catch(_e){ toast(((_e&&_e.message)||'취소 실패. 다시 시도해주세요.'),'error'); }
    };
  }
  openModal('order-cancel-modal');
}

// ══════════════════════════════════════════════════
// [기능1] 발주확정 최종 확인 — 실제 발주서 미리보기
// ══════════════════════════════════════════════════
function openOrderConfirmModal(targetStatus){
  // 역할별 버튼 텍스트 분기
  const _targetStatus=targetStatus||(isAdmin()?'발주확정':'발주대기');
  const _lbl=isAdmin()?(_targetStatus==='발주대기'?'발주 넣기':'출고확정'):'발주 넣기';
  const _sl=document.getElementById('order-submit-label');if(_sl)_sl.textContent=_lbl;
  const _tl=document.getElementById('order-confirm-modal-title');if(_tl)_tl.textContent=_lbl+' 최종 확인';
  const _ol=document.getElementById('order-confirm-ok-label');if(_ol)_ol.textContent=_lbl;

  // 1) 기존 검증 로직 (저장은 아직 안 함)
  // 콘솔 우회 방어 — 발주자는 자기 deliveryName으로 강제, 관리자는 폼 값 유지
  const _delivEl1=document.getElementById('o-delivery-to');
  let deliveryTo;
  if(isAdmin()){
    deliveryTo=(_delivEl1?_delivEl1.value:'').trim();
  } else {
    const _forceDeliv1=(currentUser&&currentUser.deliveryName)?currentUser.deliveryName:'';
    if(_delivEl1) _delivEl1.value=_forceDeliv1;
    deliveryTo=_forceDeliv1;
  }
  const address=document.getElementById('o-address').value.trim();
  syncDateParts('o-date'); syncDateParts('o-ship-date');
  const orderDate=document.getElementById('o-date').value;
  const shipDate=document.getElementById('o-ship-date').value;
  if(!deliveryTo){toast('납품처를 입력해주세요.','error');return;}
  if(!orderDate||!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)){toast('발주일을 입력해주세요.','error');return;}
  if(!shipDate||!/^\d{4}-\d{2}-\d{2}$/.test(shipDate)){toast('출고일을 입력해주세요.','error');return;}
  const whVal=document.getElementById('o-warehouse')?.value||'';
  if(!whVal){toast('출고 창고를 선택해주세요. (시흥 또는 평택)','error');return;}
  // [2026-07-15] 색상 필수 조건부 — 색상 있는 상부자재 or 옷봉에 수량 입력이 있을 때만
  // (noColor 품목만 있으면 색상 검증 skip)
  const hasColoredUpperItems = Array.from(document.querySelectorAll('.upper-qty'))
    .some(inp => {
      if((parseInt(inp.value)||0) <= 0) return false;
      const mat = inp.dataset.mat || '';
      const noColor = (typeof window._isUpperNoColor==='function') ? window._isUpperNoColor(mat) : false;
      return !noColor;
    })
    || (typeof rodEntries !== 'undefined' && rodEntries.length > 0);
  if (hasColoredUpperItems) {
    const ucCheck=document.getElementById('upper-common-color');
    if(!ucCheck||!ucCheck.value){toast('상부자재 색상을 선택해주세요.','error');return;}
  }
  const hasShelfOrCorner = (typeof shelfRowEntries !== 'undefined' && shelfRowEntries.length > 0) ||
                           (typeof cornerEntries !== 'undefined' && cornerEntries.length > 0);
  const dbItemsForVal=DB.get('items',[]);
  const hasSharedColorItem = Array.from(document.querySelectorAll('.drawer-qty')).some(inp=>{
    if((parseInt(inp.value)||0)<1)return false;
    const itemId=parseInt(inp.dataset.itemId);
    const dbItem=dbItemsForVal.find(i=>i.id===itemId);
    const ownColor=document.querySelector(`.item-color-select[data-item-id="${itemId}"]`);
    return !!dbItem&&!dbItem.noColor&&!ownColor;
  });
  if (hasShelfOrCorner || hasSharedColorItem) {
    const scCheck=document.getElementById('shared-color-sel');
    if(!scCheck||!scCheck.value){toast('선반/코너선반/서랍/옵션 색상을 선택해주세요.','error');return;}
  }
  const colorMissingItems=[];
  document.querySelectorAll('.drawer-qty').forEach(inp=>{
    const qty=parseInt(inp.value)||0;if(qty<1)return;
    const itemId=parseInt(inp.dataset.itemId);
    const dbItem=dbItemsForVal.find(i=>i.id===itemId);
    if(!dbItem||(!dbItem.hasColor&&!(dbItem.colorOptions&&dbItem.colorOptions.length>0)))return;
    const colorSel=document.querySelector(`.item-color-select[data-item-id="${itemId}"]`);
    if(!colorSel||!colorSel.value)colorMissingItems.push(dbItem.name);
  });
  if(colorMissingItems.length>0){toast(colorMissingItems.map(n=>n+' 색상을 선택해주세요').join(' / '),'error');return;}

  // 2) 부족 품목 집계 (경고 표시용)
  const shortageList=[];
  const shortageDemand=new Map();
  const addShortageDemand=(item,qty,color)=>{
    if(!item||!isTrackStock(item)||qty<1)return;
    const normalized=item.noColor?'':(color||'');
    const key=String(item.id)+'|'+normalized;
    const row=shortageDemand.get(key)||{item,qty:0,color:normalized};
    row.qty+=qty;
    shortageDemand.set(key,row);
  };
  document.querySelectorAll('.drawer-qty').forEach(inp=>{
    const qty=parseInt(inp.value)||0;
    const itemId=parseInt(inp.dataset.itemId);
    const dbItem=dbItemsForVal.find(i=>i.id===itemId);
    const ownColor=document.querySelector(`.item-color-select[data-item-id="${itemId}"]`);
    addShortageDemand(dbItem,qty,ownColor?ownColor.value:((document.getElementById('shared-color-sel')||{}).value||''));
    document.querySelectorAll(`.drawer-extra-color-row[data-item-id="${itemId}"]`).forEach(tr=>{
      const extraQty=parseInt((tr.querySelector('.drawer-extra-qty')||{}).value)||0;
      const extraColor=(tr.querySelector('.drawer-extra-color-sel')||{}).value||'';
      addShortageDemand(dbItem,extraQty,extraColor);
    });
  });
  shortageDemand.forEach(({item,qty,color})=>{
    const stock=getWarehouseStock(item,whVal,color);
    const shortage=calcShortage(qty,stock);
    if(shortage>0)shortageList.push({name:(item.name||'?')+(color?' ('+color+')':''),shortage});
  });

  // 3) 폼에서 임시 발주서 객체 빌드 (저장 X, 미리보기 전용)
  const previewOrder=_buildPreviewOrderFromForm();
  if(!previewOrder){toast('한 개 이상의 품목을 입력해주세요.','error');return;}

  // 4) renderOrderDocument로 실제 발주서 HTML 생성 + 부족/안내 박스 부착
  const docHtml=(typeof renderOrderDocument==='function')?renderOrderDocument(previewOrder):'<p>미리보기를 생성할 수 없습니다.</p>';
  const shortageHtml=shortageList.length>0
    ?`<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:var(--r-sm);padding:10px 14px;margin-top:12px">
        <p style="font-size:12px;font-weight:700;color:#dc2626;margin-bottom:6px"><i class="fas fa-triangle-exclamation"></i> 재고 부족 품목</p>
        ${shortageList.map(s=>`<p style="font-size:13px;font-weight:700;color:#991b1b;margin-bottom:2px">• ${s.name} — 부족 ${s.shortage}개</p>`).join('')}
      </div>`
    :`<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:var(--r-sm);padding:8px 14px;margin-top:12px"><p style="font-size:12px;font-weight:700;color:#15803d"><i class="fas fa-circle-check"></i> 부족 품목 없음</p></div>`;
  const noticeHtml=`<div style="margin-top:8px;padding:8px 12px;background:${isAdmin()?'#fffbeb':'#f0fdf4'};border:1px solid ${isAdmin()?'#fde68a':'#bbf7d0'};border-radius:var(--r-sm);font-size:12px;color:${isAdmin()?'#92400e':'#15803d'}">
      <i class="fas fa-info-circle"></i> 발주 넣기 시 서랍장 현재고가 즉시 차감됩니다.
    </div>`;
  const body=document.getElementById('order-confirm-body');
  body.innerHTML=`<div style="max-height:65vh;overflow-y:auto;padding:4px">${docHtml}${shortageHtml}${noticeHtml}</div>`;

  const okBtn=document.getElementById('order-confirm-ok-btn');
  if(okBtn){
    // [2026-09-02 S1 dedup] rapid 연타로 발주 중복 생성 방지 (스테이징 adversarial S1)
    //   각 openOrderConfirmModal 호출마다 fresh closure → 재열면 자동 리셋
    let _submitting=false;
    okBtn.onclick=()=>{
      if(_submitting) return;
      _submitting=true;
      closeModal('order-confirm-modal');
      submitOrder(_targetStatus);
    };
  }
  openModal('order-confirm-modal');
}

// ── 폼 입력값 → 미리보기용 발주서 객체 빌드 (저장 X) ──
// renderOrderDocument 가 기대하는 필드 구성만 담는다.
function _buildPreviewOrderFromForm(){
  // 상부 자재
  const ucColorEl=document.getElementById('upper-common-color');
  const upperCommonColor=ucColorEl?ucColorEl.value:'화이트';
  const upperMaterials=[];
  document.querySelectorAll('.upper-qty').forEach(inp=>{
    const mat=inp.dataset.mat, val=parseInt(inp.value)||0;
    if(val>0){
      const isFixed=(typeof UPPER_FIXED!=='undefined'&&UPPER_FIXED.includes)?UPPER_FIXED.includes(mat):false;
      const noteEl=isFixed?(inp.closest('tr')&&inp.closest('tr').querySelector('.upper-note')):null;
      const note=noteEl?noteEl.value.trim():'';
      // noColor 품목은 색상 없이 저장
      const _matNoColor=(typeof window._isUpperNoColor==='function')?window._isUpperNoColor(mat):false;
      const rowColor=_matNoColor?'':upperCommonColor;
      const colorKey={'화이트':'white','블랙':'black','실버':'silver','샴페인골드':'champagne'}[rowColor]||'white';
      const unitPrice=(typeof getActivePriceForItem==='function')?getActivePriceForItem(mat):null;
      const supply=(unitPrice!==null&&unitPrice!==undefined)?unitPrice*val:null;
      const vatAmt=supply!==null?Math.round(supply*0.1):null;
      const row={name:mat,color:rowColor,qty:val,note,unitPrice,amount:supply,vatAmount:vatAmt,white:0,black:0,silver:0,champagne:0};
      if(!_matNoColor)row[colorKey]=val;
      try{
        const splitsRaw=inp.dataset.splits;
        if(splitsRaw){
          const splits=JSON.parse(splitsRaw);
          if(Array.isArray(splits)&&splits.length>0){
            const sum=splits.reduce((a,s)=>a+(s.qty||0),0);
            if(sum===val)row.lengthSplits=splits;
          }
        }
      }catch{/* lengthSplits JSON 파싱 실패 시 분할 없이 그대로 진행 (의도된 동작) */}
      upperMaterials.push(row);
    }
    // [2026-08-03 fix] 상부 추가 색상 서브행도 미리보기에 반영 (총액 일치)
    const _previewUpperExtras=(typeof _upperExtraRows==='function')?_upperExtraRows(mat):[];
    _previewUpperExtras.forEach(exTr=>{
      const eq=parseInt((exTr.querySelector('.upper-extra-qty')||{}).value)||0;
      const ec=(exTr.querySelector('.upper-extra-color-sel')||{}).value||'';
      if(eq>0 && ec){
        const eKey={'화이트':'white','블랙':'black','실버':'silver','샴페인골드':'champagne'}[ec]||'white';
        const mainTr=inp.closest('tr');
        const eUnit=(typeof getOrderLinePrice==='function')
          ? getOrderLinePrice(mainTr,getActivePriceForItem(mat))
          : ((typeof getActivePriceForItem==='function')?getActivePriceForItem(mat):null);
        const eSupply=(eUnit!=null)?eUnit*eq:null;
        const eVat=eSupply!==null?Math.round(eSupply*0.1):null;
        const existingRow=upperMaterials.find(r=>r.name===mat&&r.color===ec);
        if(existingRow){
          existingRow.qty+=eq;
          existingRow[eKey]=existingRow.qty;
          existingRow.amount=eUnit!=null?eUnit*existingRow.qty:null;
          existingRow.vatAmount=existingRow.amount!==null?Math.round(existingRow.amount*0.1):null;
          return;
        }
        const eRow={name:mat,color:ec,qty:eq,note:'',unitPrice:eUnit,amount:eSupply,vatAmount:eVat,white:0,black:0,silver:0,champagne:0};
        eRow[eKey]=eq;
        upperMaterials.push(eRow);
      }
    });
  });

  // 옷봉
  const rod2400Required=(typeof rodEntries!=='undefined'&&rodEntries.length>0)?calcRod2400(rodEntries,upperCommonColor):0;
  const rodItems=(typeof rodEntries!=='undefined'&&rodEntries.length>0)?[...rodEntries]:[];
  const rodTotalLen=(typeof rodEntries!=='undefined')?rodEntries.reduce((s,e)=>s+parseInt(e.size)*e.qty,0):0;

  // 선반/코너선반
  const scEl=document.getElementById('shared-color-sel');
  const sharedColorVal=scEl?scEl.value:'';
  const shelfItems=[];
  const shelfWithColor=(typeof shelfRowEntries!=='undefined'?shelfRowEntries:[]).map(e=>{
    const price=(typeof getShelfPrice==='function')?getShelfPrice(e.size):0;
    const supply=price*e.qty;
    const color=e.color||sharedColorVal;
    return {...e,color,unitPrice:price,amount:supply,vatAmount:Math.round(supply*0.1)};
  });
  const cornerWithColor=(typeof cornerEntries!=='undefined'?cornerEntries:[]).map(e=>{
    const price=(typeof getCornerShelfPrice==='function')?getCornerShelfPrice(e.width,e.height):0;
    const supply=price*e.qty;
    const color=e.color||sharedColorVal;
    return {...e,color,unitPrice:price,amount:supply,vatAmount:Math.round(supply*0.1)};
  });
  if(shelfWithColor.length>0)shelfItems.push({name:'선반',entries:shelfWithColor});
  if(cornerWithColor.length>0)shelfItems.push({name:'코너선반',entries:cornerWithColor});

  // 서랍/옵션
  const drawerItems=[];
  document.querySelectorAll('.drawer-qty').forEach(inp=>{
    if(inp.disabled)return;
    const qty=parseInt(inp.value)||0;
    if(qty>0){
      const itemId=parseInt(inp.dataset.itemId);
      const itemColorEl=document.querySelector(`.item-color-select[data-item-id="${itemId}"]`);
      const sharedColorEl=document.getElementById('shared-color-sel');
      const color=itemColorEl?itemColorEl.value:(sharedColorEl?sharedColorEl.value:'');
      const dbItem=(typeof getItems==='function'?getItems():DB.get('items',[])).find(i=>i.id===itemId);
      const itemName=dbItem?dbItem.name:(inp.dataset.itemName||'');
      const tr=inp.closest('tr');
      const hSel=tr?tr.querySelector('.drawer-handle-select'):null;
      const handleOpt=hSel?hSel.value:'basic';
      const noteInp=tr?tr.querySelector('.item-note-input'):null;
      const itemNote=noteInp?noteInp.value.trim():'';
      const basePrice=(typeof getActivePriceForItem==='function')?getActivePriceForItem(itemName):null;
      const unitPrice=(basePrice!==null&&basePrice!==undefined)?basePrice:null;
      const supply=(unitPrice!==null)?unitPrice*qty:null;
      const vatAmt=supply!==null?Math.round(supply*0.1):null;
      drawerItems.push({itemId,itemName,requiredQty:qty,color,handleOption:handleOpt,displayName:itemName,note:itemNote,unitPrice,amount:supply,vatAmount:vatAmt});
    }
    // [2026-08-03 fix] 서랍 추가 색상 서브행도 미리보기에 반영 (총액 일치)
    const iidPrev=parseInt(inp.dataset.itemId);
    document.querySelectorAll(`.drawer-extra-color-row[data-item-id="${iidPrev}"]`).forEach(exTr=>{
      const eq=parseInt((exTr.querySelector('.drawer-extra-qty')||{}).value)||0;
      const ec=(exTr.querySelector('.drawer-extra-color-sel')||{}).value||'';
      if(eq>0 && ec){
        const dbItemE=(typeof getItems==='function'?getItems():DB.get('items',[])).find(i=>i.id===iidPrev);
        const eName=dbItemE?dbItemE.name:(inp.dataset.itemName||'');
        const mainTr=inp.closest('tr');
        const eBase=(typeof getOrderLinePrice==='function')
          ? getOrderLinePrice(mainTr,getActivePriceForItem(eName))
          : ((typeof getActivePriceForItem==='function')?getActivePriceForItem(eName):null);
        const eSupply=(eBase!=null)?eBase*eq:null;
        const eVat=eSupply!==null?Math.round(eSupply*0.1):null;
        const existingRow=drawerItems.find(r=>String(r.itemId)===String(iidPrev)&&r.color===ec);
        if(existingRow){
          existingRow.requiredQty+=eq;
          existingRow.amount=eBase!=null?eBase*existingRow.requiredQty:null;
          existingRow.vatAmount=existingRow.amount!==null?Math.round(existingRow.amount*0.1):null;
        }else{
          drawerItems.push({itemId:iidPrev,itemName:eName,requiredQty:eq,color:ec,handleOption:'basic',displayName:eName,note:'',unitPrice:eBase,amount:eSupply,vatAmount:eVat});
        }
      }
    });
  });

  const drawerMemo=(document.getElementById('o-drawer-memo')?.value||'').trim();
  const etcMemo=(document.getElementById('o-etc-memo')?.value||'').trim();
  if(!upperMaterials.length&&!rodItems.length&&!shelfItems.length&&!drawerItems.length&&!drawerMemo&&!etcMemo){
    return null;
  }

  // 콘솔 우회 방어 — 발주자는 자기 deliveryName으로 강제, 관리자는 폼 값 유지
  const _delivEl2=document.getElementById('o-delivery-to');
  let deliveryTo;
  if(isAdmin()){
    deliveryTo=(_delivEl2?_delivEl2.value:'').trim();
  } else {
    const _forceDeliv2=(currentUser&&currentUser.deliveryName)?currentUser.deliveryName:'';
    if(_delivEl2) _delivEl2.value=_forceDeliv2;
    deliveryTo=_forceDeliv2;
  }
  const address=document.getElementById('o-address').value.trim();
  const orderDate=document.getElementById('o-date').value;
  const shipDate=document.getElementById('o-ship-date').value;
  const note=(document.getElementById('o-note')?.value||'').trim();
  const warehouse=document.getElementById('o-warehouse')?.value||'시흥';
  return {
    id:'preview',
    orderNum:'(미리보기)',
    deliveryTo,address,orderDate,shipDate,note,warehouse,
    upperMaterials,upperCommonColor,
    rodItems,rod2400Required,rodTotalLen,
    shelfItems,drawerItems,drawerMemo,etcMemo,
    sharedColor:sharedColorVal
  };
}

// ══════════════════════════════════════════════════
// [기능2] 발주서 잠금 기능
// ══════════════════════════════════════════════════
async function toggleOrderLock(orderId){
  if(!isAdmin()){toast('관리자만 확정/해제할 수 있습니다.','error');return;}
  return _withOrderLock(orderId, 'lock', async () => {
  // [2026-08-27] 완전 원자화: Firestore transaction으로 check+write 하나로 묶음
  //   기존: 서버 fetch → confirm → refetch(CAS) → DB.set (별도 단계, race window)
  //   신규: transactToggleOrderLock — 서버 tx로 updatedAt/isLocked 검증+상태 갱신 원자적
  //   다른 관리자·탭·PC 동시 조작 완전 방어.
  let orders;
  try{
    orders=typeof window._FS.getAllOrders==='function'
      ? await window._FS.getAllOrders({fromServer:true})
      : await window._FS.get('orders',{fromServer:true});
  }catch(e){
    console.error('[toggleOrderLock] 서버 최신 발주 조회 실패:',e&&e.message);
    toast('서버 발주 상태 확인 실패. 새로고침 후 다시 시도해주세요.','error');return;
  }
  if(!Array.isArray(orders)){toast('서버 최신 발주를 불러오지 못했습니다.','error');return;}
  const idx=orders.findIndex(o=>o.id===orderId);
  if(idx===-1){toast('발주서를 찾을 수 없습니다.','error');return;}
  const order=orders[idx];
  const now=new Date().toISOString();
  const _snapshotUpdatedAt=order.updatedAt||'';
  const _snapshotIsLocked=isOrderLockedState(order);
  if(_snapshotIsLocked&&!confirm('확정을 해제하면 이 발주가 정산·원장에서 사라집니다.\n계속 진행하시겠습니까?'))return;

  // 확정/해제 값 준비
  const _nextIsLocked = !_snapshotIsLocked;
  const _nextStatus = _nextIsLocked ? '발주확정' : '발주대기';
  const _historyNote = _nextIsLocked ? '관리자 확정' : '확정 해제';
  const _historyEntry = {
    status: _nextStatus,
    changedBy: currentUser?currentUser.id:'',
    changedByName: currentUser?currentUser.name:'',
    changedAt: now,
    note: _historyNote,
  };

  // 원자적 트랜잭션 실행. 실패 시 사유별 토스트.
  let committedOrder;
  try{
    if(typeof window._FS.transactToggleOrderLock!=='function'){
      throw new Error('원자 트랜잭션 함수 미로드');
    }
    committedOrder = await window._FS.transactToggleOrderLock({
      orderNum: order.orderNum,
      expectedUpdatedAt: _snapshotUpdatedAt,
      expectedIsLocked: _snapshotIsLocked,
      nextStatus: _nextStatus,
      nextIsLocked: _nextIsLocked,
      newStatusHistoryEntry: _historyEntry,
      now,
    });
  }catch(e){
    const msg = e && e.message || '';
    if(msg==='CAS_MISS_NOT_FOUND'){
      toast('발주서가 사라졌습니다(다른 관리자가 삭제·취소했을 수 있음). 새로고침 후 확인해주세요.','warning');return;
    }
    if(msg==='CAS_MISS_UPDATED' || msg==='CAS_MISS_LOCKED'){
      toast('다른 관리자가 이 발주 상태를 이미 변경했습니다. 새로고침 후 다시 시도해주세요.','warning');return;
    }
    console.error('[toggleOrderLock] transaction 실패:', msg);
    toast('상태 저장 실패. 페이지를 새로고침한 후 다시 시도해주세요.','error');return;
  }

  // 로컬 mem 반영 (서버가 이미 커밋한 최신 문서로 덮음)
  orders[idx] = committedOrder;
  try{
    if(window._mem && Array.isArray(window._mem.orders)){
      const _mIdx = window._mem.orders.findIndex(o=>o.id===orderId);
      if(_mIdx>-1) window._mem.orders[_mIdx] = committedOrder;
    }
  }catch(_e){}

  if(_nextIsLocked){
    toast('발주가 확정되었습니다.','success');
    // 거래명세서 자동 발급 (best-effort, 실패해도 발주확정은 유지)
    if(window.LumaneInvoice && typeof window.LumaneInvoice.autoCreateForOrder==='function'){
      window.LumaneInvoice.autoCreateForOrder(committedOrder,{reason:'lock'}).catch(e=>console.warn('[Invoice 자동발급]',e&&e.message));
    }
  } else {
    toast('확정이 해제되었습니다.','warning');
    // [2026-08-03] 확정 해제 후에도 발주는 살아있음(발주대기) → 명세서 재발급.
    if(window.LumaneInvoice && typeof window.LumaneInvoice.autoCreateForOrder==='function'){
      window.LumaneInvoice.autoCreateForOrder(committedOrder,{reason:'unlock',forceUnsend:true}).catch(e=>console.warn('[Invoice 재발급]',e&&e.message));
    }
  }
  openOrderDetail(orderId);
  if(currentView==='orders')renderOrders();
  else if(currentView==='dashboard')renderDashboard();
  });
}


function renderOrderListSubTabs(){
  const allOrders=getOrders().filter(o=>!isAdmin()?(!o.createdBy||o.createdBy===currentUser.id):true);
  const activeCnt=allOrders.filter(o=>o.status!=='취소'&&o.status!=='보관').length;
  const cancelledCnt=allOrders.filter(o=>o.status==='취소').length;
  const archivedCnt=allOrders.filter(o=>o.status==='보관').length;
  const tabs=[
    {id:'active',label:'진행중',count:activeCnt,color:'var(--primary)'},
    {id:'cancelled',label:'취소',count:cancelledCnt,color:'#ef4444'},
    {id:'archived',label:'보관',count:archivedCnt,color:'#6b7280'},
  ];
  return`<div style="display:flex;gap:0;margin-bottom:4px;border-bottom:1px solid var(--border)">
    ${tabs.map(t=>{
      const active=orderListSubTab===t.id;
      return`<button class="btn btn-ghost order-list-sub-tab" data-sub-tab="${t.id}" style="border-radius:0;border-bottom:2px solid ${active?t.color:'transparent'};color:${active?t.color:'var(--text-2)'};font-weight:${active?'700':'400'};padding:7px 14px;font-size:13px">
        ${t.label}${t.count>0?`<span style="margin-left:5px;background:${active?t.color+'18':'var(--bg-2)'};color:${active?t.color:'var(--text-3)'};border-radius:20px;padding:1px 7px;font-size:11px;font-weight:700">${t.count}</span>`:''}
      </button>`;
    }).join('')}
  </div>`;
}


function renderOrdersTabBar(){
  const tabs=[
    {id:'list',label:'발주서 목록',icon:'fa-file-invoice'},
    {id:'order-hist',label:'발주 이력',icon:'fa-clock-rotate-left'},
    ...(isAdmin()?[
      {id:'inv-hist',label:'재고 변동',icon:'fa-boxes-stacked'},
      {id:'orderer-stats',label:'발주자별 현황',icon:'fa-users'},
    ]:[]),
  ];
  return`<div style="display:flex;border-bottom:2px solid var(--border);margin-bottom:20px;flex-wrap:wrap;gap:0">
    ${tabs.map(t=>`<button class="btn btn-ghost order-main-tab" data-order-tab="${t.id}" style="border-radius:0;border-bottom:2px solid ${orderTab===t.id?'var(--primary-light)':'transparent'};color:${orderTab===t.id?'var(--primary)':'var(--text-2)'};font-weight:${orderTab===t.id?'700':'400'};padding:8px 16px"><i class="fas ${t.icon}" style="margin-right:6px"></i>${t.label}</button>`).join('')}
  </div>`;
}


function renderOrders(){
  // 탭 분기
  if(orderTab==='order-hist'){renderOrdersWithTab();renderOrderHistTab();return;}
  if(orderTab==='inv-hist'){renderOrdersWithTab();renderInvHistTab();return;}
  if(orderTab==='orderer-stats'){renderOrdersWithTab();renderOrdererStatsTab();return;}

  // 입력 중 포커스 유지: renderOrders가 #content를 통째로 다시 그려 입력칸이 새로 생성되므로,
  // 현재 포커스된 필터 입력칸 id와 커서 위치를 저장해 두고 렌더 후 복원한다(연속 타이핑 가능).
  const _focusId=(document.activeElement&&document.activeElement.id)||'';
  let _focusCaret=null;
  try{ if(document.activeElement&&typeof document.activeElement.selectionStart==='number') _focusCaret=document.activeElement.selectionStart; }catch(_e){}

  const orders=getOrders().filter(o=>{
    if(!isAdmin()&&o.createdBy&&o.createdBy!==currentUser.id)return false;
    // 서브탭 기준 필터
    if(orderListSubTab==='cancelled'){if(o.status!=='취소')return false;}
    else if(orderListSubTab==='archived'){if(o.status!=='보관')return false;}
    else{
      // active 탭: 취소/보관 제외
      if(o.status==='취소')return false;
      if(o.status==='보관'&&!orderShowArchived)return false;
      if(o.status==='임시저장'&&!orderShowDraft)return false;
    }
    if(orderFilterShortage){const hasS=(o.drawerItems||o.items||[]).some(i=>i.shortageQty>0);if(!hasS)return false;}
    if(orderFilterSite){const dTo=o.deliveryTo||o.siteName||'';if(!dTo.includes(orderFilterSite))return false;}
    if(orderFilterNum){const num=o.orderNum||('#'+o.id);if(!num.includes(orderFilterNum))return false;}
    if(orderFilterAddr){const addr=o.address||o.customerName||'';if(!addr.includes(orderFilterAddr))return false;}
    if(orderFilterStatus&&o.status!==orderFilterStatus)return false;
    const rowLocked=isOrderLockedState(o);
    if(orderFilterLocked==='locked'&&!rowLocked)return false;
    if(orderFilterLocked==='unlocked'&&rowLocked)return false;
    // 시공일 기준 필터 (shipDate)
    if(orderFilterDateFrom&&(o.shipDate||'').slice(0,10)<orderFilterDateFrom)return false;
    if(orderFilterDateTo&&(o.shipDate||'').slice(0,10)>orderFilterDateTo)return false;
    // 지역 필터
    if(orderFilterRegion){const firstWord=(o.address||'').split(' ')[0]||'';if(firstWord!==orderFilterRegion)return false;}
    // 금액 필터
    if(orderFilterMinAmount){const amt=parseInt(String(o.totalAmount||'0').replace(/[^0-9]/g,''))||0;if(amt<parseInt(orderFilterMinAmount))return false;}
    if(orderFilterMaxAmount){const amt=parseInt(String(o.totalAmount||'0').replace(/[^0-9]/g,''))||0;if(amt>parseInt(orderFilterMaxAmount))return false;}
    // 크기 필터 (자 단위, 1자≈303mm)
    if(orderFilterMinSize){const sz=Math.round((o.rodTotalLen||0)/303);if(sz<parseInt(orderFilterMinSize))return false;}
    if(orderFilterMaxSize){const sz=Math.round((o.rodTotalLen||0)/303);if(sz>parseInt(orderFilterMaxSize))return false;}
    return true;
  }).sort(orderRecentSort);

  let rows='';
  if(orders.length===0){
    rows='<div class="empty"><i class="fas fa-file-invoice"></i><p>등록된 발주서가 없습니다.</p>'+(isAdmin()?'':'<button class="btn btn-primary" style="margin-top:12px" id="empty-order-btn">첫 번째 발주서 등록</button>')+'</div>';
  }else{
    // 발주자 거래명세서 버튼 표시용: 전송된(sentToCustomer=true) 활성 invoice만 모음
    // C1 fix: 캐시 비어있으면 _FS에서 비동기 페치 후 캐시 채우고 재렌더 (영구 누락 방지)
    const _invList=(typeof DB!=='undefined'&&typeof DB.get==='function'?DB.get('invoices',[]):[]);
    if(_invList.length===0&&!window._invoicesFetchInflight&&window._FS&&typeof window._FS.get==='function'){
      window._invoicesFetchInflight=true;
      window._FS.get('invoices').then(a=>{
        window._invoicesFetchInflight=false;
        if(Array.isArray(a)&&a.length>0){
          // 서버 조회값은 캐시만 채운다. DB.set()은 전체 invoices 문서를 다시 써서
          // 조회와 저장 사이에 반영된 다른 관리자의 변경을 덮어쓸 수 있다.
          window._mem=window._mem||{};
          window._mem.invoices=a;
          if(typeof renderOrders==='function')renderOrders();
        }
      }).catch(()=>{window._invoicesFetchInflight=false;});
    }
    // [2026-08-03 B8] 검토 대기 명세서 orderNum 추적 → 목록 뱃지로 표시
    const _needsReviewOrderNums=new Set();
    _invList.forEach(i=>{
      if(i&&!i.cancelled&&i.needsManualReview&&i.orderNum)_needsReviewOrderNums.add(i.orderNum);
    });
    rows=`<div class="table-wrap"><table><thead><tr><th>납품처</th><th>시공주소</th><th>발주번호</th><th>발주일</th><th>출고일</th><th class="td-center">상태</th><th class="td-center">등록일</th>${orderListSubTab==='cancelled'?'<th>취소 사유</th>':''}${(isAdmin()||orderListSubTab==='cancelled')?'<th class="td-center">관리</th>':''}</tr></thead><tbody>
    ${orders.map(o=>{
      // H5 보강 (Codex): 납품처/주소/orderNum escape — 저장된 XSS 차단
      const _e=(typeof escapeHtml==='function'?escapeHtml:(s=>String(s||'')));
      const dTo=_e(o.deliveryTo||o.siteName||'-');
      const addr=_e(o.address||o.customerName||'-');
      const orderNumEsc=_e(o.orderNum||('#'+o.id));
      const statusBadge=orderStatusBadge(o.status);
      const rowLocked=isOrderLockedState(o);
      const lockBadge=rowLocked
        ?'<span class="badge badge-locked" style="margin-left:4px"><i class="fas fa-lock"></i></span>'
        :(o.status==='발주대기'?'<span class="badge" style="margin-left:4px;background:#fefce8;color:#a16207;border:1px solid #fde047"><i class="fas fa-lock-open"></i></span>':'');
      const cancelBtn=isAdmin()&&orderListSubTab==='active'?`<button class="btn btn-ghost btn-xs order-cancel-btn" data-order-id="${o.id}" style="color:var(--danger);white-space:nowrap"><i class="fas fa-ban"></i> 발주 취소</button>`:'';
      const uncancelBtn=orderListSubTab==='cancelled'&&(isAdmin()||(currentUser&&o.createdBy===currentUser.id))?`<button class="btn btn-ghost btn-xs order-uncancel-btn" data-order-id="${o.id}" style="color:#16a34a;white-space:nowrap"><i class="fas fa-rotate-left"></i> 취소 되돌리기</button>`:'';
      const reorderBtn=`<button class="btn btn-outline btn-xs reorder-btn" data-order-id="${o.id}" title="이 발주서로 재발주" style="border:1.5px solid #0ea5e9;color:#0369a1;font-weight:700;white-space:nowrap"><i class="fas fa-rotate-right"></i> 재발주</button>`;
      // [2026-08-31] 정책 변경: 출고확정만으로 발주자한테 명세서 버튼 노출 (sentToCustomer 무관)
      //   발주대기 상태는 아직 출고확정 전 → 발주자한테 명세서 안 뜸 (관리자만)
      const _statusOK=(o.status==='출고완료'||o.status==='발주확정'||o.status==='발주대기');
      const _isOrdererVisible=(o.status==='출고완료'||o.status==='발주확정'); // 발주자 노출 = 출고확정 이후만
      // [2026-09-01] legacy fallback — settlement/query.js:_canViewSettlementOrder와 동일 로직
      const _isOwnerRow = (()=>{
        if (!currentUser) return false;
        if (o.createdBy) return o.createdBy === currentUser.id;
        const deliveryName = String(currentUser.deliveryName || currentUser.name || '').trim();
        const orderDelivery = String(o.deliveryTo || o.siteName || '').trim();
        return !!deliveryName && orderDelivery === deliveryName;
      })();
      const _canSeeInv=isAdmin()?_statusOK:(_isOrdererVisible && _isOwnerRow);
      // [2026-08-03 B8] 관리자에게 검토 대기 명세서 뱃지 표시
      const _needsReview=isAdmin()&&_needsReviewOrderNums.has(o.orderNum);
      const reviewBadge=_needsReview?'<span class="badge" style="margin-left:3px;background:#fef3c7;color:#92400e;border:1px solid #fde68a;font-size:10px;padding:2px 6px" title="수기 편집 명세서에 최신 발주 내용 반영 대기. 명세서 열어 확인·저장 필요"><i class="fas fa-exclamation-triangle"></i> 검토</span>':'';
      const invoiceBtn=_canSeeInv?`<button class="btn btn-outline btn-xs invoice-btn" data-order-id="${o.id}" style="border:1.5px solid #7c3aed;color:#7c3aed;font-weight:700;white-space:nowrap"><i class="fas fa-file-invoice"></i> 거래명세서</button>${reviewBadge}`:'';
      // M1 fix: escapeHtml로 XSS 차단 (title 속성 + 텍스트 노드 양쪽)
      const _esc=(typeof escapeHtml==='function'?escapeHtml:(s=>String(s||'')));
      const cancelReasonCell=orderListSubTab==='cancelled'?`<td class="td-muted" style="font-size:12px;color:#dc2626;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(o.cancelReason||'')}">${_esc(o.cancelReason||'-')}</td>`:'';
      // [2026-08-27] 출고일 셀: 확정 시 statusHistory 발주확정 changedAt(KST), 미확정이면 발주자 shipDate, 둘 다 없으면 '-'
      const _shipDateForCell=(typeof getSettlementDate==='function')?getSettlementDate(o):(o.shipDate||'');
      const _shipCell=_shipDateForCell?fmt(_shipDateForCell):'-';
      return `<tr class="order-row" data-order-id="${o.id}" style="cursor:pointer" title="클릭하여 상세 보기"><td class="td-name">${dTo}</td><td class="td-muted" style="font-size:12px">${addr}</td><td style="font-size:12px;font-weight:600;color:#0f172a">${orderNumEsc}${lockBadge}</td><td class="td-muted">${fmt(o.orderDate)}</td><td class="td-muted">${_shipCell}</td><td class="td-center">${statusBadge}</td><td class="td-center td-muted">${fmt(o.createdAt)}</td>${cancelReasonCell}<td class="td-center">${cancelBtn} ${uncancelBtn} ${reorderBtn} ${invoiceBtn}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  }
  // 지역 드롭다운: 모든 발주서의 주소에서 첫 단어(시/도) 추출
  const allOrdersForRegion=getOrders().filter(o=>o.address);
  const regions=[...new Set(allOrdersForRegion.map(o=>(o.address||'').split(' ')[0]).filter(Boolean))].sort();
  const regionOpts=regions.map(r=>`<option value="${r}"${orderFilterRegion===r?' selected':''}>${r}</option>`).join('');
  // 전체 건수 (필터 적용 전 현재 서브탭 기준)
  const totalCountForTab=getOrders().filter(o=>{
    if(!isAdmin()&&o.createdBy&&o.createdBy!==currentUser.id)return false;
    if(orderListSubTab==='cancelled'){return o.status==='취소';}
    if(orderListSubTab==='archived'){return o.status==='보관';}
    return o.status!=='취소'&&(o.status!=='보관'||orderShowArchived)&&(o.status!=='임시저장'||orderShowDraft);
  }).length;
  const labelStyle='font-size:12px;font-weight:600;color:var(--text-2);display:block;margin-bottom:5px';
  document.getElementById('content').innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;gap:12px;flex-wrap:wrap">
      <div><div class="section-title">발주서 목록</div><div class="section-sub">${isAdmin()?'전체 발주서를 확인합니다.':'발주서를 작성하고 서랍장 부족 수량을 자동 계산합니다.'}</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-primary" id="new-order-btn"><i class="fas fa-plus"></i> ${isAdmin()?'대리 발주서 작성':'새 발주서'}</button>
        <button class="btn btn-outline btn-sm" onclick="downloadOrderListExcel()" style="border:1.5px solid #15803d;color:#15803d;font-weight:700"><i class="fas fa-file-excel"></i> 목록 엑셀</button>
      </div>
    </div>
    ${renderOrdersTabBar()}
    ${renderOrderListSubTabs()}
    <!-- 검색 필터 카드 -->
    <div class="card" style="margin-bottom:14px;padding:${orderFilterOpen?'16px 20px':'10px 20px'}">
      <div id="order-filter-header" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;${orderFilterOpen?'margin-bottom:14px':''}" onclick="orderFilterOpen=!orderFilterOpen;renderOrders()">
        <span style="font-size:14px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:6px">
          <i class="fas fa-sliders-h" style="color:var(--primary-light)"></i>검색 필터
          ${(()=>{const activeCount=[orderFilterNum,orderFilterSite,orderFilterRegion,orderFilterDateFrom,orderFilterDateTo,orderFilterMinAmount,orderFilterMaxAmount,orderFilterMinSize,orderFilterMaxSize].filter(v=>v).length+(orderFilterShortage?1:0);return activeCount>0?`<span style="background:var(--primary-light);color:#fff;font-size:11px;font-weight:700;border-radius:99px;padding:1px 7px">${activeCount}</span>`:''})()}
        </span>
        <div style="display:flex;align-items:center;gap:8px">
          ${orderFilterOpen?`<button id="order-filter-reset-btn" style="display:flex;align-items:center;gap:5px;background:none;border:1px solid var(--border);border-radius:var(--r-sm);padding:5px 12px;font-size:13px;color:var(--text-2);cursor:pointer;transition:background .15s" onclick="event.stopPropagation()" onmouseover="this.style.background='#f1f5f9'" onmouseout="this.style.background='none'"><i class="fas fa-rotate-left"></i> 초기화</button>`:''}
          <i class="fas fa-chevron-${orderFilterOpen?'up':'down'}" style="color:var(--text-3);font-size:13px"></i>
        </div>
      </div>
      <div style="display:${orderFilterOpen?'grid':'none'};grid-template-columns:1fr 1fr;gap:12px 16px">
        <div>
          <label style="${labelStyle}">발주번호</label>
          <input class="form-input" placeholder="발주번호 검색 (예: 20260601)" id="order-filter-num" value="${orderFilterNum}" style="width:100%"/>
        </div>
        <div>
          <label style="${labelStyle}">업체명</label>
          <div style="display:flex;gap:6px">
            <input class="form-input" placeholder="업체명 입력 후 🔍 또는 Enter" id="order-search-input" value="${orderFilterSite}" style="flex:1;min-width:0"/>
            <button type="button" id="order-search-btn" class="btn btn-primary" style="padding:0 14px;white-space:nowrap"><i class="fas fa-search"></i></button>
          </div>
        </div>
        <div>
          <label style="${labelStyle}">지역</label>
          <select class="form-input" id="order-filter-region" style="width:100%">
            <option value="">📍 전체 지역</option>
            ${regionOpts}
          </select>
        </div>
        <div>
          <label style="${labelStyle}">시공일 (이후)</label>
          <input type="date" class="form-input" id="order-filter-from" value="${orderFilterDateFrom}" style="width:100%"/>
        </div>
        <div>
          <label style="${labelStyle}">시공일 (이전)</label>
          <input type="date" class="form-input" id="order-filter-to" value="${orderFilterDateTo}" style="width:100%"/>
        </div>
        <div>
          <label style="${labelStyle}">최소 금액 (원)</label>
          <input type="number" class="form-input" placeholder="예: 100000" id="order-filter-min-amount" value="${orderFilterMinAmount}" style="width:100%"/>
        </div>
        <div>
          <label style="${labelStyle}">최대 금액 (원)</label>
          <input type="number" class="form-input" placeholder="예: 500000" id="order-filter-max-amount" value="${orderFilterMaxAmount}" style="width:100%"/>
        </div>
        <div>
          <label style="${labelStyle}">최소 크기 (자)</label>
          <input type="number" class="form-input" placeholder="예: 2" id="order-filter-min-size" value="${orderFilterMinSize}" style="width:100%"/>
        </div>
        <div>
          <label style="${labelStyle}">최대 크기 (자)</label>
          <input type="number" class="form-input" placeholder="예: 10" id="order-filter-max-size" value="${orderFilterMaxSize}" style="width:100%"/>
        </div>
      </div>
      <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <span style="font-size:13px;color:var(--text-3)">검색 결과: <strong style="color:var(--primary-light)">${orders.length}건</strong> / 전체 ${totalCountForTab}건</span>
        <div style="display:flex;gap:14px">
          <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text-2);cursor:pointer"><input type="checkbox" id="order-show-archived" ${orderShowArchived?'checked':''}> 보관 포함</label>
          <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:#dc2626;cursor:pointer;font-weight:600"><input type="checkbox" id="order-filter-shortage" ${orderFilterShortage?'checked':''}> 재고 부족만</label>
        </div>
      </div>
    </div>


    <div class="card">${rows}</div>`;
  {const nb2=document.getElementById('new-order-btn');if(nb2)nb2.addEventListener('click',openOrderModal);}
  const orderNumInput=document.getElementById('order-filter-num');
  if(orderNumInput)_imeSafeSearchInput(orderNumInput, v=>{orderFilterNum=v;renderOrders();}, {focusFlagKey:'_orderNumFilterFocused'});
  // 한글 IME 호환: 자동 검색 제거 → Enter 또는 blur(포커스 잃을 때) 검색
  (function(){
    const _si = document.getElementById('order-search-input');
    if (!_si) return;
    _si.placeholder = '업체명 입력 후 Enter';
    const _commit = () => {
      if (orderFilterSite === _si.value) return;
      orderFilterSite = _si.value;
      renderOrders();
      const ni = document.getElementById('order-search-input');
      if (ni) { ni.focus(); const p = ni.value.length; try { ni.setSelectionRange(p, p); } catch(_) {} }
    };
    _si.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); _commit(); } });
    _si.addEventListener('blur', _commit);
    const _btn = document.getElementById('order-search-btn');
    if (_btn) _btn.addEventListener('click', _commit);
  })();
  document.getElementById('order-filter-region').addEventListener('change',e=>{orderFilterRegion=e.target.value;renderOrders();});
  document.getElementById('order-filter-from').addEventListener('change',e=>{orderFilterDateFrom=e.target.value;renderOrders();});
  document.getElementById('order-filter-to').addEventListener('change',e=>{orderFilterDateTo=e.target.value;renderOrders();});
  document.getElementById('order-filter-min-amount').addEventListener('input',e=>{orderFilterMinAmount=e.target.value;renderOrders();});
  document.getElementById('order-filter-max-amount').addEventListener('input',e=>{orderFilterMaxAmount=e.target.value;renderOrders();});
  document.getElementById('order-filter-min-size').addEventListener('input',e=>{orderFilterMinSize=e.target.value;renderOrders();});
  document.getElementById('order-filter-max-size').addEventListener('input',e=>{orderFilterMaxSize=e.target.value;renderOrders();});
  const archiveChk=document.getElementById('order-show-archived');
  if(archiveChk)archiveChk.addEventListener('change',e=>{orderShowArchived=e.target.checked;renderOrders();});
  const shortageChk=document.getElementById('order-filter-shortage');
  if(shortageChk)shortageChk.addEventListener('change',e=>{orderFilterShortage=e.target.checked;renderOrders();});
  const resetBtn=document.getElementById('order-filter-reset-btn');
  if(resetBtn)resetBtn.addEventListener('click',()=>{
    orderFilterNum='';orderFilterSite='';orderFilterRegion='';orderFilterDateFrom='';orderFilterDateTo='';
    orderFilterMinAmount='';orderFilterMaxAmount='';orderFilterMinSize='';orderFilterMaxSize='';
    orderFilterShortage=false;orderShowArchived=false;
    renderOrders();
  });
  const eb=document.getElementById('empty-order-btn');
  if(eb)eb.addEventListener('click',openOrderModal);
  // 메인 탭 클릭
  document.querySelectorAll('.order-main-tab').forEach(btn=>{
    btn.addEventListener('click',()=>{orderTab=btn.dataset.orderTab;renderOrders();});
  });
  // 서브탭 클릭
  document.querySelectorAll('.order-list-sub-tab').forEach(btn=>{
    btn.addEventListener('click',()=>{orderListSubTab=btn.dataset.subTab;renderOrders();});
  });
  // 거래명세서 버튼 클릭 (컨테이너 단일 이벤트 위임 — 핸들러 누적 차단)
  if(!document._invoiceBtnDelegated){
    document._invoiceBtnDelegated=true;
    document.addEventListener('click',e=>{
      const btn=e.target.closest && e.target.closest('.invoice-btn');
      if(!btn)return;
      e.stopPropagation();
      const oid=parseInt(btn.dataset.orderId);
      const order=getOrders().find(o=>o.id===oid);
      if(!order){toast('발주서를 찾을 수 없습니다.','error');return;}
      if(!window.LumaneInvoice){toast('거래명세서 모듈 로드 실패. 새로고침 후 다시 시도하세요.','error');return;}
      window.LumaneInvoice.openFromOrder(order);
    });
  }

  // 렌더 후 포커스·커서 복원 — 필터 입력칸 연속 타이핑 시 한 글자마다 포커스 풀리는 문제 방지
  // INPUT만 대상(버튼·select 제외), preventScroll로 긴 목록에서 스크롤 점프 방지
  if(_focusId){
    const _fel=document.getElementById(_focusId);
    if(_fel&&_fel.tagName==='INPUT'){
      try{ _fel.focus({preventScroll:true}); }catch(_e){ _fel.focus(); }
      try{ if(_focusCaret!=null&&typeof _fel.setSelectionRange==='function') _fel.setSelectionRange(_focusCaret,_focusCaret); }catch(_e){}
    }
  }
}


// 이력 탭 공통 헤더 렌더
function renderOrdersWithTab(){
  document.getElementById('content').innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;gap:12px;flex-wrap:wrap">
      <div><div class="section-title">발주서 목록</div><div class="section-sub">발주 이력 및 통계를 조회합니다.</div></div>
    </div>
    ${renderOrdersTabBar()}
    <div class="filter-bar" id="hist-filter-bar" style="flex-wrap:wrap;gap:8px"></div>
    <div id="hist-content"></div>`;
  document.querySelectorAll('.order-main-tab').forEach(btn=>{
    btn.addEventListener('click',()=>{orderTab=btn.dataset.orderTab;renderOrders();});
  });
}


// 발주 이력 탭
function renderOrderHistTab(){
  const fb=document.getElementById('hist-filter-bar');
  const c=document.getElementById('hist-content');
  if(!fb||!c)return;
  fb.innerHTML=`
    <input class="form-input" placeholder="납품처 검색" id="hist-site-input" value="${histSite}" style="max-width:180px"/>
    <input class="form-input" type="date" id="hist-from-input" value="${histFrom}"/>
    <span style="color:var(--text-3)">~</span>
    <input class="form-input" type="date" id="hist-to-input" value="${histTo}"/>
    <button class="btn btn-outline btn-sm" id="hist-reset-btn">초기화</button>`;
  _imeSafeSearchInput(document.getElementById('hist-site-input'), v=>{histSite=v;renderOrderHistTab();}, {focusFlagKey:'_histSiteFocused'});
  document.getElementById('hist-from-input').addEventListener('input',e=>{histFrom=e.target.value;renderOrderHistTab();});
  document.getElementById('hist-to-input').addEventListener('input',e=>{histTo=e.target.value;renderOrderHistTab();});
  document.getElementById('hist-reset-btn').addEventListener('click',()=>{histSite='';histFrom='';histTo='';renderOrderHistTab();});
  let orders=getOrders().filter(o=>isAdmin()||(o.createdBy===currentUser.id)||!o.createdBy).sort(orderRecentSort);
  if(histSite)orders=orders.filter(o=>(o.siteName||o.deliveryTo||'').includes(histSite));
  if(histFrom)orders=orders.filter(o=>o.orderDate>=histFrom);
  if(histTo)orders=orders.filter(o=>o.orderDate<=histTo);
  let tbl='';
  if(orders.length===0){tbl='<div class="empty"><i class="fas fa-file-invoice"></i><p>이력이 없습니다.</p></div>';}
  else{
    tbl=`<div class="table-wrap"><table><thead><tr><th>#</th><th>납품처</th><th>시공주소</th><th>발주일</th><th class="td-center">상태</th><th class="td-center">품목 수</th><th class="td-center">부족 발생</th><th class="td-center">등록일시</th><th class="td-center"></th></tr></thead><tbody>
    ${orders.map(o=>{const hasS=o.items&&o.items.some(i=>i.shortageQty>0);
      const dTo=o.deliveryTo||o.siteName||'-';const addr=o.address||o.customerName||'-';
      return`<tr><td class="td-muted" style="font-size:12px;font-weight:600">${o.orderNum||('#'+o.id)}</td><td class="td-name">${dTo}</td><td class="td-muted" style="font-size:12px">${addr}</td><td class="td-muted">${fmt(o.orderDate)}</td><td class="td-center">${orderStatusBadge(o.status)}</td><td class="td-center">${(()=>{const dC=(o.items||o.drawerItems||[]).length;const uC=(o.upperMaterials||[]).filter(m=>(m.qty||0)>0).length;const sC=(o.shelfItems||[]).reduce((s,si)=>s+((si.entries||[]).length>0?1:0),0);const rC=(o.rodItems||[]).length>0?1:0;return dC+uC+sC+rC;})()}</td><td class="td-center">${hasS?'<span class="badge badge-red">있음</span>':'<span class="badge badge-done">없음</span>'}</td><td class="td-center td-muted">${fmtDt(o.createdAt)}</td><td class="td-center"><button class="btn btn-ghost btn-xs order-detail-btn" data-order-id="${o.id}"><i class="fas fa-eye"></i></button></td></tr>`;
    }).join('')}</tbody></table></div>`;
  }
  c.innerHTML=`<div class="card"><div class="card-header"><h3>발주 이력 <span style="font-weight:400;color:var(--text-3)">(${orders.length}건)</span></h3></div>${tbl}</div>`;
}


// 재고 변동 탭
function renderInvHistTab(){
  const fb=document.getElementById('hist-filter-bar');
  const c=document.getElementById('hist-content');
  if(!fb||!c)return;
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
  _imeSafeSearchInput(document.getElementById('hist-item-input'), v=>{histItem=v;renderInvHistTab();}, {focusFlagKey:'_histItemFocused'});
  document.getElementById('hist-type-select').addEventListener('change',e=>{histType=e.target.value;renderInvHistTab();});
  document.getElementById('hist-from-input').addEventListener('input',e=>{histFrom=e.target.value;renderInvHistTab();});
  document.getElementById('hist-to-input').addEventListener('input',e=>{histTo=e.target.value;renderInvHistTab();});
  document.getElementById('hist-reset-btn').addEventListener('click',()=>{histItem='';histType='';histFrom='';histTo='';renderInvHistTab();});
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


// 발주자별 현황 탭
function renderOrdererStatsTab(){
  const fb=document.getElementById('hist-filter-bar');
  const c=document.getElementById('hist-content');
  if(!fb||!c)return;
  fb.innerHTML='';
  const accounts=DB.get('accounts',[]).filter(a=>a.role!=='admin');
  const orders=getOrders().filter(o=>o.status!=='취소'&&o.status!=='보관');
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
    const rawAmt=o.totalAmount||0;
    const amt=typeof rawAmt==='number'?rawAmt:parseInt((rawAmt+'').replace(/[^0-9]/g,'')||'0');
    statsMap[uid].amount+=amt||0;
    if(!statsMap[uid].lastDate||o.orderDate>statsMap[uid].lastDate)statsMap[uid].lastDate=o.orderDate;
  });
  const statsList=Object.values(statsMap);
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
      <td class="td-center">${s.waiting>0?`<span class="badge badge-pending">${s.waiting}</span>`:'<span style="color:var(--text-3)">0</span>'}</td>
      <td class="td-center">${s.confirmed>0?`<span class="badge badge-locked">${s.confirmed}</span>`:'<span style="color:var(--text-3)">0</span>'}</td>
      <td class="td-center">${s.shipped>0?`<span class="badge badge-done">${s.shipped}</span>`:'<span style="color:var(--text-3)">0</span>'}</td>
      <td class="td-center" style="font-weight:700">${s.amount>0?s.amount.toLocaleString()+'원':'-'}</td>
      <td class="td-center td-muted">${s.lastDate?fmt(s.lastDate):'-'}</td>
    </tr>`).join('')}</tbody></table></div>`;
  }
  c.innerHTML=`<div class="card"><div class="card-header"><h3>발주자별 현황</h3></div>${tbl}</div>`;
}


function openOrderDetail(orderId){
  const order=getOrders().find(o=>o.id===orderId);if(!order)return;
  const hasShortage=order.items&&order.items.some(i=>i.shortageQty>0);
  const prs=getPRs().filter(p=>p.orderId===orderId);

  // 기본 정보
  const dTo=order.deliveryTo||order.siteName||'-';
  const addr=order.address||order.customerName||'-';

  // 구역 A: 상부 자재
  let upperHtml='';
  if(order.upperMaterials&&order.upperMaterials.length>0){
    upperHtml=`<div class="det-section" style="margin-bottom:14px">
      <div class="det-section-head det-head-blue">
        <i class="fas fa-layer-group"></i> 상부 자재
      </div>
      <div class="det-section-body">
        <table class="det-tbl">
          <thead><tr><th>품목</th><th class="td-center">색상</th><th class="td-center">수량</th><th style="text-align:left">비고</th></tr></thead>
          <tbody>${order.upperMaterials.map(r=>{
            // XSS 방어: r.name/color/note는 사용자 입력이 저장된 값 (신규 상부자재 이후)
            const _nameE=(typeof _escHtml==='function')?_escHtml(compatUpperName(r.name)):compatUpperName(r.name);
            const _noteE=(typeof _escHtml==='function')?_escHtml(r.note||''):(r.note||'');
            // 신형: color 프로퍼티 명시적 있음 (typeof === 'string') → color='' 도 noColor 신형으로 인정
            // 레거시(color 프로퍼티 미존재)는 white/black/silver/champagne 카운터 분기로
            if(r.qty && typeof r.color==='string'){
              const _colorE=(typeof _escHtml==='function')?_escHtml(r.color):r.color;
              const colorCell=_colorE?`<span class="det-color-badge">${_colorE}</span>`:'<span style="color:var(--text-3);font-size:11px">-</span>';
              return `<tr><td class="dn">${_nameE}</td><td class="td-center">${colorCell}</td><td class="dnum">${r.qty}</td><td style="font-size:12px;color:#374151">${_noteE}</td></tr>`;
            }
            // 구형: white/black/silver/champagne (color 프로퍼티 미존재)
            const colorMap={white:'화이트',black:'블랙',silver:'실버',champagne:'샴페인골드'};
            return ['white','black','silver','champagne'].filter(c=>r[c]>0).map(c=>`<tr><td class="dn">${_nameE}</td><td class="td-center"><span class="det-color-badge">${colorMap[c]}</span></td><td class="dnum">${r[c]}</td><td style="font-size:12px;color:#374151">${_noteE}</td></tr>`).join('');
          }).join('')}</tbody>
        </table>
      </div>
    </div>`;
  }

  // 옷봉
  let rodHtml='';
  if(order.rodItems&&order.rodItems.length>0){
    // [2026-08-03] 색상 컬럼. r.color 없으면 상부 공통색(upperCommonColor) 폴백
    const _fallbackColor=order.upperCommonColor||'';
    const rows=order.rodItems.map(e=>{
      const c=e.color||_fallbackColor||'-';
      return `<tr>
      <td class="dnum">${e.size}mm</td>
      <td class="dnum">${e.qty}개</td>
      <td class="dnum">${c}</td>
    </tr>`;
    }).join('');
    rodHtml=`<div class="det-section" style="margin-bottom:14px">
      <div class="det-section-head det-head-blue">
        <i class="fas fa-minus"></i> 옷봉
      </div>
      <div class="det-section-body">
        <table class="det-tbl">
          <thead><tr><th>절단 규격</th><th>수량</th><th>색상</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="det-rod-result">
          총 요청 길이: <strong>${(order.rodTotalLen||0).toLocaleString()}mm</strong>
          &nbsp;&nbsp;|&nbsp;&nbsp;
          <span style="font-size:15px;font-weight:800">옷봉 2400 필요: ${order.rod2400Required||0}개</span>
        </div>
      </div>
    </div>`;
  }

  // 구역 B: 선반/코너선반
  let shelfHtml='';
  if(order.shelfItems&&order.shelfItems.length>0){
    let shelfSections='';
    order.shelfItems.forEach(item=>{
      if(item.name==='선반'&&item.entries&&item.entries.length>0){
        // 선반: entries 배열 [{size, qty, color}]
        const rows=item.entries.map(e=>
          `<tr><td class="dnum">${e.size}</td><td class="dnum">${e.qty}개</td><td style="text-align:center"><span class="det-color-badge">${e.color}</span></td></tr>`
        ).join('');
        shelfSections+=`<div style="margin-bottom:12px">
          <p style="font-size:12px;font-weight:800;color:#374151;margin-bottom:6px;padding:3px 0;border-bottom:1px solid #e5e7eb">선반</p>
          <table class="det-tbl">
            <thead><tr><th>규격</th><th>수량</th><th>색상</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>`;
      } else if(item.name==='선반'){
        // 구형식 하위 호환: colorData 또는 text
        if(item.colorData){
          let colorRows=Object.entries(item.colorData).filter(([,v])=>v).map(([c,v])=>
            `<tr><td><span class="badge badge-gray" style="font-size:11px">${c}</span></td><td style="font-size:12px;white-space:pre-wrap;padding:4px 8px">${v}</td></tr>`
          ).join('');
          shelfSections+=`<div style="margin-bottom:10px"><p style="font-size:12px;font-weight:700;margin-bottom:4px">선반</p>
            <table style="width:100%;font-size:13px;border-collapse:collapse">
              <thead><tr><th style="padding:4px 8px;background:#f8fafc;font-size:11px">색상</th><th style="padding:4px 8px;background:#f8fafc;font-size:11px">규격 × 수량</th></tr></thead>
              <tbody>${colorRows}</tbody>
            </table></div>`;
        } else if(item.text){
          shelfSections+=`<div style="margin-bottom:10px"><p style="font-size:12px;font-weight:700;margin-bottom:4px">선반</p>
            <div style="padding:6px 10px;background:var(--bg);border-radius:4px;font-size:12px;white-space:pre-wrap">${item.text}</div></div>`;
        }
      } else if(item.name==='코너선반'&&item.entries&&item.entries.length>0){
        const rows=item.entries.map(e=>
          `<tr><td class="dnum">${e.width}</td><td class="dnum">${e.height}</td><td class="dnum">${e.qty}개</td><td style="text-align:center"><span class="det-color-badge">${e.color}</span></td></tr>`
        ).join('');
        shelfSections+=`<div>
          <p style="font-size:12px;font-weight:800;color:#374151;margin-bottom:6px;padding:3px 0;border-bottom:1px solid #e5e7eb">코너선반</p>
          <table class="det-tbl">
            <thead><tr><th>가로</th><th>세로</th><th>수량</th><th>색상</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>`;
      } else if(item.entries&&item.entries.length>0){
        // 구형식 하위 호환
        const rows=item.entries.map(e=>
          `<tr><td style="font-size:12px;padding-left:8px">${e.size||''}</td><td class="td-center"><span class="badge badge-gray">${e.color}</span></td><td class="td-center">${e.qty}</td></tr>`
        ).join('');
        shelfSections+=`<div style="margin-bottom:10px"><p style="font-size:12px;font-weight:700;margin-bottom:4px">${item.name}</p>
          <table><thead><tr><th>규격</th><th class="td-center">색상</th><th class="td-center">수량</th></tr></thead><tbody>${rows}</tbody></table></div>`;
      }
    });
    if(shelfSections){
      shelfHtml=`<div class="det-section" style="margin-bottom:14px">
        <div class="det-section-head det-head-amber">
          <i class="fas fa-border-all"></i> 선반 / 코너선반
        </div>
        <div class="det-section-body" style="padding:12px 14px">
          ${shelfSections}
        </div>
      </div>`;
    }
  }

  // 구역 C: 서랍
  let drawerHtml='';
  const drawerRows=(order.drawerItems||order.items||[]);
  if(drawerRows.length>0||order.drawerMemo){
    let drRows='';
    drawerRows.forEach(oi=>{
      const it=getItem(oi.itemId);if(!it)return;
      const colorBadge=oi.color?`<span class="badge badge-gray" style="font-size:11px">${oi.color}</span>`:'<span class="td-muted">-</span>';
      const cbadge=oi.color?`<span class="det-color-badge">${oi.color}</span>`:'<span style="color:#9ca3af;font-size:12px">-</span>';
      drRows+=`<tr>
        <td class="dn">${it.name} ${drawerBadge(it)}</td>
        <td class="dnum">${oi.requiredQty}개</td>
        <td style="text-align:center">${cbadge}</td>
        <td class="dmuted">${_tracksInventoryLine(oi,it)?oi.currentStockSnapshot:'-'}</td>
        <td style="text-align:center">${_tracksInventoryLine(oi,it)?(oi.shortageQty>0?`<span class="det-shortage-num">▼ ${oi.shortageQty}</span>`:'<span class="det-ok">✓ 충분</span>'):'<span style="color:#9ca3af;font-size:12px">-</span>'}</td>
      </tr>`;
    });
    drawerHtml=`<div class="det-section" style="margin-bottom:14px">
      <div class="det-section-head det-head-indigo">
        <i class="fas fa-boxes-stacked"></i> 서랍 / 옵션
      </div>
      <div class="det-section-body">
        ${drRows?`<table class="det-tbl">
          <thead><tr><th>품목명</th><th>수량</th><th>색상</th><th>당시재고</th><th>부족</th></tr></thead>
          <tbody>${drRows}</tbody>
        </table>`:''}
        ${order.drawerMemo?`<div class="det-memo">${order.drawerMemo}</div>`:''}
      </div>
    </div>`;
  }

  // 기타
  let etcHtml='';
  if(order.etcMemo){
    etcHtml=`<div class="det-section" style="margin-bottom:14px">
      <div class="det-section-head det-head-gray">
        <i class="fas fa-pen-to-square"></i> 기타 메모
      </div>
      <div class="det-memo" style="font-size:14px;color:#000;font-weight:700;line-height:2;padding:16px 18px">${order.etcMemo}</div>
    </div>`;
  }

  // 발주 필요 목록
  let prsHtml='';
  if(prs.length>0){
    prsHtml=`<div class="det-section" style="margin-bottom:4px">
      <div class="det-section-head det-head-red">
        <i class="fas fa-triangle-exclamation"></i> 서랍장 발주 필요
      </div>
      <div class="det-section-body">
        <table class="det-tbl">
          <thead><tr><th>품목명</th><th>구분</th><th>부족 수량</th><th>상태</th></tr></thead>
          <tbody>${prs.map(pr=>{
            const it=getItem(pr.itemId);
            const statusStyle=pr.status==='발주완료'
              ?'background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0'
              :'background:#fefce8;color:#92400e;border:1px solid #fde68a';
            return`<tr>
              <td class="dn">${it?it.name:'?'}</td>
              <td style="text-align:center">${it?drawerBadge(it):'-'}</td>
              <td style="text-align:center"><span class="det-shortage-num">${pr.shortageQty}</span></td>
              <td style="text-align:center"><span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;${statusStyle}">${pr.status}</span></td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  document.getElementById('order-detail-body').innerHTML=`
    <div style="display:flex;gap:8px;align-items:center;padding:10px 14px;border-bottom:1px solid #e5e7eb;background:#f8fafc">
      <span style="font-size:13px;font-weight:800;color:#374151">${order.orderNum||('#'+order.id)}</span>
      ${orderStatusBadge(order.status)}
        ${isOrderLockedState(order)
          ?'<span class="badge badge-locked"><i class="fas fa-lock"></i> 확정</span>'
          :(order.status==='발주대기'?'<span class="badge" style="background:#fefce8;color:#a16207;border:1px solid #fde047"><i class="fas fa-lock-open"></i> 미확정</span>':'')}
      ${hasShortage?'<span style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;padding:2px 8px;border-radius:20px;font-size:12px;font-weight:700">⚠ 부족</span>':''}
    </div>
    <div class="doc-detail-wrap">${renderOrderDocument(order)}</div>
    ${renderStatusTimeline(order)}`;
  window._currentPrintOrder=order;
  const excelBtn=document.getElementById('excel-order-btn');
  if(excelBtn){excelBtn.onclick=()=>downloadOrderExcel(order).catch(e=>{console.error(e);toast('엑셀 생성 중 오류가 발생했습니다.','error');});}
  const printBtn=document.getElementById('print-order-btn');
  if(printBtn){printBtn.onclick=()=>printOrder(order);}
  const pdfBtn=document.getElementById('pdf-order-btn');
  if(pdfBtn){pdfBtn.onclick=()=>savePdfOrder(order);}
  const imgBtn=document.getElementById('img-order-btn');
  if(imgBtn){imgBtn.onclick=()=>saveImageOrder(order);}
  const editBtn=document.getElementById('edit-order-btn');
  if(editBtn){
    const isOrderer=!isAdmin();
    // 수정 불가 조건 정리
    // - isLocked=true → 관리자/발주자 모두 수정 불가 (발주 확정 상태)
    // - 발주자이고 발주대기 이상 상태 → 발주자는 수정 불가
    // - 출고준비/출고완료/취소 → 관리자도 수정 불가
    const noEditStatuses=['출고준비','출고완료','취소','active'];
    const ordererBlockStatuses=['발주확정','출고준비','출고완료','active']; // 발주대기는 관리자 미확정 상태이므로 수정 허용
    if(isOrderLockedState(order)){
      editBtn.disabled=true;
      editBtn.style.opacity='0.4';
      editBtn.title='발주 확정된 발주서입니다. 확정 해제 후 수정 가능합니다.';
      editBtn.onclick=()=>toast('발주 확정된 발주서입니다. 확정 해제 후 수정 가능합니다.','error');
    }else if(isOrderer&&ordererBlockStatuses.includes(order.status)){
      editBtn.disabled=true;
      editBtn.style.opacity='0.4';
      editBtn.title='발주 넣기 후에는 수정할 수 없습니다.';
      editBtn.onclick=()=>toast('발주 넣기 후에는 수정할 수 없습니다.','error');
    }else if(!isOrderer&&noEditStatuses.includes(order.status)){
      editBtn.disabled=true;
      editBtn.style.opacity='0.4';
      editBtn.title='출고 이후 상태는 수정할 수 없습니다.';
      editBtn.onclick=()=>toast('출고 이후 상태는 수정할 수 없습니다.','error');
    }else{
      editBtn.disabled=false;
      editBtn.style.opacity='';
      editBtn.title='';
      editBtn.onclick=()=>openEditOrder(order.id);
    }
  }
  const copyBtn=document.getElementById('copy-order-btn');
  if(copyBtn){
    if(isAdmin()){copyBtn.style.display='none';}
    else{copyBtn.style.display='';copyBtn.onclick=()=>copyOrder(order.id);}
  }
  // 발주 취소 버튼 (상세 모달)
  const detailCancelBtn=document.getElementById('detail-cancel-order-btn');
  if(detailCancelBtn){
    const cancellableByAdmin=['발주대기','발주확정','출고준비'];
    const canAdminCancel=isAdmin()&&cancellableByAdmin.includes(order.status);
    const canOrdererCancel=!isAdmin()&&order.status==='발주대기'&&(!order.createdBy||order.createdBy===currentUser.id);
    if(canAdminCancel||canOrdererCancel){
      detailCancelBtn.style.display='';
      detailCancelBtn.onclick=()=>{closeModal('order-detail-modal');openOrderCancelModal(order.id);}
    }else{
      detailCancelBtn.style.display='none';
    }
  }
  // 거래명세서 버튼 (관리자 또는 본인 발주서 + 출고확정 이후, 발주자는 읽기 전용)
  {
    const existingInvBtn=document.getElementById('detail-invoice-btn');
    if(existingInvBtn)existingInvBtn.remove();
    // [2026-09-01] legacy fallback — settlement/query.js:_canViewSettlementOrder와 동일 로직
    const _isOwner = (()=>{
      if (!currentUser) return false;
      if (order.createdBy) return order.createdBy === currentUser.id;
      const deliveryName = String(currentUser.deliveryName || currentUser.name || '').trim();
      const orderDelivery = String(order.deliveryTo || order.siteName || '').trim();
      return !!deliveryName && orderDelivery === deliveryName;
    })();
    // 발주자에게는 sentToCustomer=true 인 활성 invoice가 있을 때만 노출
    // C1 fix: 캐시 비어있으면 비동기 페치 트리거 (영구 누락 방지)
    const _invList=(typeof DB!=='undefined'&&typeof DB.get==='function'?DB.get('invoices',[]):[]);
    if(_invList.length===0&&!window._invoicesFetchInflight&&window._FS&&typeof window._FS.get==='function'){
      window._invoicesFetchInflight=true;
      window._FS.get('invoices').then(a=>{
        window._invoicesFetchInflight=false;
        if(Array.isArray(a)&&a.length>0){
          // 조회 결과는 로컬 캐시에만 반영한다. 원격 재저장 금지.
          window._mem=window._mem||{};
          window._mem.invoices=a;
          // L3 보강 (Codex): 현재 상세 모달이 열려있고 같은 발주서면 버튼 재렌더
          try{
            const _modalOpen=document.getElementById('order-detail-modal');
            if(_modalOpen&&_modalOpen.offsetParent!==null&&typeof openOrderDetail==='function'){
              const _isStillSame=document.getElementById('detail-order-num')?.textContent===order.orderNum;
              if(_isStillSame)openOrderDetail(order.id);
            }
          }catch(_e){}
        }
      }).catch(()=>{window._invoicesFetchInflight=false;});
    }
    // [2026-08-31] 정책 변경: 출고확정만으로 발주자 명세서 버튼 노출 (sentToCustomer 무관)
    //   발주대기는 관리자만 (발주자한테는 출고확정 후에만)
    const _statusOK=(order.status==='출고완료'||order.status==='발주확정'||order.status==='발주대기');
    const _isOrdererVisibleDetail=(order.status==='출고완료'||order.status==='발주확정');
    const _canSeeInvDetail=isAdmin()?_statusOK:(_isOwner && _isOrdererVisibleDetail);
    if(_canSeeInvDetail){
      const leftBtns=document.querySelector('#order-detail-modal .modal-footer > div');
      if(leftBtns){
        const invBtn=document.createElement('button');
        invBtn.id='detail-invoice-btn';
        invBtn.className='btn btn-outline btn-sm';
        invBtn.style.cssText='border:1.5px solid #7c3aed;color:#7c3aed;font-weight:700';
        invBtn.innerHTML='<i class="fas fa-file-invoice"></i> 거래명세서';
        invBtn.onclick=()=>{
          closeModal('order-detail-modal');
          if(!window.LumaneInvoice){toast('거래명세서 모듈 로드 실패. 새로고침 후 다시 시도하세요.','error');return;}
          window.LumaneInvoice.openFromOrder(order);
        };
        leftBtns.appendChild(invBtn);
      }
    }
  }
  // 잠금/잠금해제 버튼 (관리자만)
  const lockBtn=document.getElementById('lock-order-btn');
  if(lockBtn&&isAdmin()){
    lockBtn.style.display='';
    if(isOrderLockedState(order)){
      lockBtn.innerHTML='<i class="fas fa-lock"></i> 확정 해제';
      lockBtn.style.cssText='border:1.5px solid #15803d;color:#15803d;font-weight:700';
    }else{
      lockBtn.innerHTML='<i class="fas fa-lock-open"></i> 출고 확정';
      lockBtn.style.cssText='border:1.5px solid #1d4ed8;color:#1d4ed8;font-weight:700';
    }
    lockBtn.onclick=()=>toggleOrderLock(order.id);
  }else if(lockBtn){lockBtn.style.display='none';}
  // 상태 변경 버튼 렌더링
  const statusBtnsEl=document.getElementById('status-change-btns');
  if(statusBtnsEl&&isAdmin()){
    const nexts=nextStatuses(order.status);
    const btnColors={'발주대기':'#a16207','발주확정':'#1d4ed8','출고준비':'#c2410c','출고완료':'#15803d','취소':'#dc2626','보관':'#7c3aed','임시저장':'#64748b'};
    const btnLabels={'발주확정':'출고확정'};
    const hiddenStatuses=['발주확정','출고준비','취소','보관'];
    const visibleNexts=nexts.filter(s=>!hiddenStatuses.includes(s));
    statusBtnsEl.innerHTML=visibleNexts.map(s=>`<button class="btn btn-outline btn-sm status-change-btn" data-order-id="${order.id}" data-new-status="${s}" style="border:1.5px solid ${btnColors[s]||'#888'};color:${btnColors[s]||'#888'};font-weight:700;font-size:11px">${btnLabels[s]||s}</button>`).join('');
  }else if(statusBtnsEl){statusBtnsEl.innerHTML='';}
  openModal('order-detail-modal');
  // 모달 높이를 내용에 맞게 조정 (빈 공간 제거)
  requestAnimationFrame(()=>{
    const modal=document.querySelector('#order-detail-modal .modal');
    const body=document.getElementById('order-detail-body');
    if(modal&&body){
      modal.style.height='auto';
      modal.style.maxHeight='92vh';
    }
  });
}

// ── 발주 수정 기능 ──

// ── 서랍/옵션 복원 전용 함수 (itemId 우선, name fallback) ──
function restoreDrawerItemsToModal(order){
  const savedItems=order.drawerItems||order.items||[];
  if(!savedItems.length)return;

  // DB items — id↔name 양방향 맵
  const dbItems=DB.get('items',[]);
  const idToName={};
  dbItems.forEach(i=>{ idToName[i.id]=i.name; });

  // DOM drawer-body — itemId→inp, itemName→inp 양방향 맵
  const idToInp={};
  const nameToInp={};
  document.querySelectorAll('.drawer-qty').forEach(inp=>{
    const id=inp.dataset.itemId;
    const nm=inp.dataset.itemName;
    if(id)idToInp[id]=inp;
    if(nm)nameToInp[nm]=inp;
  });
  if(!Object.keys(idToInp).length)return; // 아직 렌더 안됨

  // [2026-08-03] itemId 별 그룹핑 — 같은 품목에 여러 색상 entry 있을 수 있음 (관리자 대리발주)
  const _byItemId={};
  savedItems.forEach(oi=>{
    if(!oi.requiredQty||oi.requiredQty<1)return;
    const key=String(oi.itemId||oi.itemName||oi.displayName||'');
    if(!_byItemId[key]) _byItemId[key]=[];
    _byItemId[key].push(oi);
  });
  // [2026-08-03 fix] 서브행 항상 복원 (발주자 편집 시에도 데이터 손실 방지)
  const _isAdmDrawerRestore=true;
  const _shdC=(document.getElementById('shared-color-sel')||{}).value||'';

  Object.entries(_byItemId).forEach(([_key, group])=>{
    // 메인: 공통색과 매칭되는 entry 우선, 없으면 첫 개
    // [문제3 fix] _isMain 우선, 없으면 색상 매칭, 없으면 첫번째
    let mainEntry=group.find(e=>e._isMain===true);
    if(!mainEntry) mainEntry=group.find(e=>e.color===_shdC);
    if(!mainEntry) mainEntry=group[0];
    const extras=group.filter(e=>e!==mainEntry);
    const oi=mainEntry;

    let inp=null;
    // 1순위: itemId 직접 매칭
    if(oi.itemId)inp=idToInp[String(oi.itemId)]||null;
    // 2순위: 저장 itemId → DB 품목명 → DOM name 매칭
    if(!inp&&oi.itemId){
      const nm=idToName[oi.itemId];
      if(nm)inp=nameToInp[nm]||null;
    }
    // 3순위: oi에 itemName 또는 displayName 필드로 name 매칭
    if(!inp&&(oi.itemName||oi.displayName))inp=nameToInp[oi.itemName||oi.displayName]||null;

    if(!inp)return;

    // 수량 복원
    inp.value=oi.requiredQty;
    inp.dispatchEvent(new Event('input')); // 부족수량 표시 갱신

    // 색상 복원 (hasColor 품목 — 인출식 바지걸이 등)
    if(oi.color){
      const domId=inp.dataset.itemId;
      const domName=inp.dataset.itemName;
      // dataset 직접 비교: 특수문자와 CSS.escape 미지원 구형 브라우저 모두 대응
      let sel=Array.from(document.querySelectorAll('.item-color-select')).find(el=>String(el.dataset.itemId)===String(domId));
      if(!sel&&domName)sel=Array.from(document.querySelectorAll('.item-color-select')).find(el=>el.dataset.itemName===domName);
      if(sel)sel.value=oi.color;
    }
    // 손잡이 옵션 복원
    if(oi.handleOption){
      const trEl=inp.closest('tr');
      const hSel=trEl?trEl.querySelector('.drawer-handle-select'):null;
      if(hSel)hSel.value=oi.handleOption;
    }
    // 실제길이 note 복원
    if(oi.note){
      const trEl2=inp.closest('tr');
      const nInp=trEl2?trEl2.querySelector('.item-note-input'):null;
      if(nInp)nInp.value=oi.note;
    }
    // 세부 구성 체크 복원
    if(oi.subTypeChecked&&oi.subTypeChecked.length){
      const domId=inp.dataset.itemId;
      document.querySelectorAll(`.subtype-row[data-parent-id="${domId}"]`).forEach(tr=>{tr.style.display='';});
      oi.subTypeChecked.forEach(stName=>{
        const chk=Array.from(document.querySelectorAll('.subtype-chk')).find(el=>
          String(el.dataset.parentId)===String(domId)&&String(el.dataset.subtypeName)===String(stName)
        );
        if(chk)chk.checked=true;
      });
    }
    // [2026-08-03] 추가 색상 서브행 복원 (관리자 대리발주 흐름에서만)
    if(_isAdmDrawerRestore && extras.length>0 && typeof _addDrawerExtraColorRow==='function'){
      const iid=inp.dataset.itemId;
      const nm=inp.dataset.itemName;
      extras.forEach(e=>{
        if(e.requiredQty>0 && e.color) _addDrawerExtraColorRow(iid, nm, e.color, e.requiredQty);
      });
    }
  });
}


// ── 복원 시점 보장: drawer-body 렌더 완료 후 1회 실행 ──
function restoreDrawerItemsWhenReady(order, retry){
  retry=retry||0;
  // 함수 진입 시점에 flag 리셋 (모달 재open 시 이전 상태 잔존 방지)
  if(retry===0 && typeof window!=='undefined') window._drawerRestoreFailed=false;
  // [2026-08-03 B3 fix] 서랍 데이터 있을 때만 실패로 판단 (없으면 복원 불필요)
  const hasDrawerData=!!(order && Array.isArray(order.drawerItems||order.items) && (order.drawerItems||order.items).length>0);
  if(retry>60){
    if(hasDrawerData){
      console.error('[restoreDrawerItemsWhenReady] drawer-body 렌더 대기 초과 — 서랍 데이터 복원 실패');
      if(typeof toast==='function') toast('⚠ 서랍/옵션 데이터 복원 실패. 저장하지 말고 새로고침 후 다시 열어주세요.','error');
      if(typeof window!=='undefined') window._drawerRestoreFailed=true;
    }
    return;
  }
  const inputs=document.querySelectorAll('.drawer-qty');
  if(inputs.length>0){
    restoreDrawerItemsToModal(order);
  } else {
    requestAnimationFrame(()=>restoreDrawerItemsWhenReady(order,retry+1));
  }
}



// ── 수정 진입 전용 재고 롤백 (서랍장 차감분만 복구) ──
async function rollbackInventoryForEdit(order){
  // stockDeducted가 true일 때만 롤백 (이중 롤백 방지)
  if(!order||!order.stockDeducted)return;
  const items=DB.get('items',[]);
  let changed=false;
  const now=new Date().toISOString();
  const drawerRows=order.drawerItems||order.items||[];
  const editWh=order.warehouse||'시흥';
  // [2026-07-24 Codex-3차 atomicity] mutation 전에 전수 warehouse 검증
  _assertOrderableWarehouses(drawerRows, editWh, items);
  // 서버에서 로그 id 배치 발급 (forEach 진입 전, 실패 시 throw)
  let _logIds=[];
  if(drawerRows.length>0) _logIds=await _serverGetLogIds(drawerRows.length);
  drawerRows.forEach(oi=>{
    const iIdx=items.findIndex(i=>i.id===oi.itemId);
    if(iIdx===-1||!_isInventoryLineDeducted(oi,items[iIdx],order))return;
    if(items[iIdx].stockSiheung===undefined)items[iIdx].stockSiheung=items[iIdx].currentStock||0;
    if(items[iIdx].stockPyeongtaek===undefined)items[iIdx].stockPyeongtaek=0;
    const wh=_orderableWh(oi.warehouse, editWh);
    const whKey=getWhKey(wh);
    const cwKey=getColorWhKey(wh);
    let oiColor=items[iIdx].noColor?'':(oi.color||order.sharedColor||'');
    if(oiColor&&typeof normalizeStockColor==='function')oiColor=normalizeStockColor(oiColor);
    const restoreQty=_deductedQtyForLine(oi);
    let before, afterVal;
    if(oiColor){
      if(!items[iIdx][cwKey])items[iIdx][cwKey]={};
      before=typeof getColorStock==='function'?getColorStock(items[iIdx][cwKey],oiColor):(items[iIdx][cwKey][oiColor]||0);
      afterVal=before+restoreQty;
      if(typeof setColorStock==='function')setColorStock(items[iIdx][cwKey],oiColor,afterVal);
      else items[iIdx][cwKey][oiColor]=afterVal;
      items[iIdx][whKey]=typeof sumColorStockMap==='function'?sumColorStockMap(items[iIdx][cwKey]):Object.values(items[iIdx][cwKey]).reduce((s,v)=>s+(v||0),0);
    } else {
      before=items[iIdx][whKey];
      afterVal=before+restoreQty;
      items[iIdx][whKey]=afterVal;
    }
    items[iIdx].currentStock=(items[iIdx].stockSiheung||0)+(items[iIdx].stockPyeongtaek||0);
    changed=true;
    const logs=DB.get('logs',[]);
    logs.push({
      id:_logIds.shift(),itemId:oi.itemId,type:'발주수정재반영',
      qty:restoreQty,beforeStock:before,afterStock:afterVal,warehouse:wh,color:oiColor||'',
      memo:`발주 #${order.id} 수정 진입 롤백`,orderId:order.id,
      createdBy:currentUser?currentUser.id:'',createdAt:now
    });
    DB.set('logs',logs);
    oi.inventoryTracked=true;
    oi.inventoryDeducted=false;
  });
  if(changed)await DB.set('items',items);
  // stockDeducted=false 표시 — 이중 롤백 방지
  const orders=DB.get('orders',[]);
  const idx=orders.findIndex(o=>o.id===order.id);
  if(idx!==-1&&orders[idx].stockDeducted){
    orders[idx].stockDeducted=false;
    await DB.set('orders',orders);
  }
}


async function openEditOrder(orderId){
  const order=getOrders().find(o=>o.id===orderId);
  if(!order){toast('발주서를 찾을 수 없습니다.','error');return;}
  if(isOrderLockedState(order)){toast('발주 확정된 발주서입니다. 관리자가 확정 해제 후 수정할 수 있습니다.','error');return;}
  if(!isAdmin()&&order.createdBy&&order.createdBy!==currentUser.id){
    toast('본인 발주서만 수정할 수 있습니다.','error');return;
  }
  const editActor=(currentUser&&(currentUser.id||currentUser.name))||'unknown';
  if(typeof window._acquireServerEditLock==='function'){
    const lockRes=await window._acquireServerEditLock(orderId,editActor);
    if(!lockRes||!lockRes.ok){
      if(lockRes&&lockRes.reason==='locked')toast('다른 사용자가 이 발주서를 수정 중입니다. 잠시 후 다시 시도해주세요.','error');
      else toast('수정 잠금 확인에 실패했습니다. 새로고침 후 다시 시도해주세요.','error');
      return;
    }
    window._activeOrderEditLock={orderId,actorId:editActor};
  }

  // ── 1단계: 재고 롤백 (입력칸과 무관하게 DB만 변경) ──
  closeModal('order-detail-modal');

  // ── 2단계: 모달 렌더링 (항상 빈 상태로 시작) ──
  // [2026-07-14] 편집 대상 order를 렌더 전에 노출 → renderUpperTable이 참조해서 items에 없는(비활성/이름변경) 신규 상부자재 라인도 렌더 (편집 시 사라짐 방지)
  window._pendingEditOrder = order;
  _openOrderModalRender(null);

  // ── 3단계: 기존 발주값 복원 (재고 롤백과 독립적으로 order 원본 참조) ──
  setTimeout(()=>{
    // 기본 정보 — 발주자는 자기 deliveryName으로 강제 + 읽기전용. 관리자는 원본 유지 + 편집 가능
    const editDelivEl=document.getElementById('o-delivery-to');
    if(isAdmin()){
      const ordererId=order.createdBy||'';
      const ordererIdEl=document.getElementById('o-orderer-id');
      const acc=DB.get('accounts',[]).find(a=>String(a.id)===String(ordererId)&&a.role==='orderer');
      proxyOrdererForOrder=acc?{id:acc.id,name:acc.name||acc.id,deliveryName:acc.deliveryName||acc.name||acc.id,email:acc.email||''}:null;
      editDelivEl.value=order.deliveryTo||order.siteName||'';
      if(ordererIdEl)ordererIdEl.value=ordererId;
      editDelivEl.readOnly=false;
      editDelivEl.tabIndex=0;
    } else {
      const editForced=(currentUser&&currentUser.deliveryName)?currentUser.deliveryName:'';
      editDelivEl.value=editForced;
      editDelivEl.readOnly=true;
      editDelivEl.tabIndex=-1;
    }
    document.getElementById('o-address').value=order.address||order.customerName||'';
    setDateValue('o-date',order.orderDate||todayStr());
    setDateValue('o-ship-date',order.shipDate||'');
    document.getElementById('o-note').value=order.note||'';
    document.getElementById('o-drawer-memo').value=order.drawerMemo||'';
    document.getElementById('o-etc-memo').value=order.etcMemo||'';
    // 창고 복원
    orderSelectWarehouse(order.warehouse||'시흥');
    // 상부자재 공통 색상 복원 + 코드 없는 품목 비활성화
    const ucEl2=document.getElementById('upper-common-color');
    if(ucEl2){
      ucEl2.value=order.upperCommonColor||(order.upperMaterials&&order.upperMaterials[0]&&order.upperMaterials[0].color)||'화이트';
      if(typeof checkUpperColorCodes==='function') checkUpperColorCodes(ucEl2.value);
    }
    // [2026-08-03] 상부자재 name별 그룹핑 — 같은 name 여러 색상 entry 지원 (main + extras)
    const _upperByNameEdit={};
    (order.upperMaterials||[]).forEach(r=>{ if(r&&r.name){(_upperByNameEdit[r.name]||=[]).push(r);} });
    const _isAdmEditRestore=true; // [2026-08-03 fix] 항상 복원
    const _ucValEdit=(document.getElementById('upper-common-color')||{}).value||'';
    Object.entries(_upperByNameEdit).forEach(([rawName, entries])=>{
      let mainEntry=entries.find(e=>e._isMain===true)||entries.find(e=>e.color===_ucValEdit)||entries[0];
      const extras=entries.filter(e=>e!==mainEntry);
      const r=mainEntry;
      const qty=r.qty||(r.white||0)+(r.black||0)+(r.silver||0)+(r.champagne||0);
      let inp=_findUpperControl(rawName,'.upper-qty');
      if(!inp){const cn=compatUpperName(rawName);if(cn!==rawName)inp=_findUpperControl(cn,'.upper-qty');}
      if(inp){inp.value=qty||'';updateUpperRowAmount(inp);}
      if(r.note){
        let nEl=_findUpperControl(rawName,'.upper-note');
        if(!nEl){const cn=compatUpperName(rawName);if(cn!==rawName)nEl=_findUpperControl(cn,'.upper-note');}
        if(nEl)nEl.value=r.note;
      }
      if(r.lengthSplits&&Array.isArray(r.lengthSplits)&&r.lengthSplits.length>0){
        const matKey=inp?.dataset?.mat||rawName;
        if(inp){inp.dataset.splits=JSON.stringify(r.lengthSplits);}
        if(typeof setRowLengthSplits==='function')setRowLengthSplits(matKey,r.lengthSplits);
      }
      if(_isAdmEditRestore && extras.length>0 && typeof _addUpperExtraColorRow==='function'){
        extras.forEach(e=>{
          const eq=e.qty||(e.white||0)+(e.black||0)+(e.silver||0)+(e.champagne||0);
          if(eq>0&&e.color) _addUpperExtraColorRow(rawName, e.color, eq);
        });
      }
    });
    // 공통 색상 + 서랍 색상별 코드 체크 (임시저장 복원과 동일 - Bug 2 수정)
    if(order.sharedColor){
      const ss=document.getElementById('shared-color-sel');
      if(ss){
        ss.value=order.sharedColor;
        if(typeof checkDrawerColorCodes==='function') checkDrawerColorCodes(order.sharedColor);
      }
    }
    // 선반/코너선반
    if(order.shelfItems&&order.shelfItems.length>0){
      order.shelfItems.forEach(si=>{
        if(si.name==='선반'&&si.entries)si.entries.forEach(e=>shelfRowEntries.push({size:e.size,qty:e.qty,color:e.color||order.sharedColor||''}));
        if(si.name==='코너선반'&&si.entries)si.entries.forEach(e=>cornerEntries.push({width:e.width,height:e.height,qty:e.qty,color:e.color||order.sharedColor||''}));
      });
      renderShelfRows();renderCornerRows();
    }
    // 옷봉
    if(order.rodItems&&order.rodItems.length>0){
      order.rodItems.forEach(r=>rodEntries.push({size:r.size,qty:r.qty,color:r.color||''}));
      renderRodRows();
    }
    // 수정 모드 표시
    document.querySelector('#order-modal .modal-title').textContent='발주서 수정 #'+orderId;
    const saveBtn=document.querySelector('#order-modal .order-modal-bottom .btn-primary');
    if(saveBtn){
      const lbl=isAdmin()?'출고확정':'발주 넣기';
      saveBtn.innerHTML=`<i class="fas fa-check"></i> <span id="order-submit-label">${lbl}</span>`;
      saveBtn.onclick=()=>submitEditOrder(orderId,isAdmin()?'발주확정':'발주대기');
    }
    const draftBtn=Array.from(document.querySelectorAll('#order-modal .order-modal-bottom .modal-footer .btn')).find(btn=>(btn.textContent||'').includes('임시저장'));
    if(draftBtn)draftBtn.onclick=()=>submitEditOrder(orderId,'임시저장');
    const pendingBtn=document.getElementById('order-pending-btn');
    if(pendingBtn){
      pendingBtn.style.display=isAdmin()?'':'none';
      pendingBtn.onclick=()=>submitEditOrder(orderId,'발주대기');
    }
    // 상부자재 금액 재계산 (수량 복원 후)
    document.querySelectorAll('.upper-qty').forEach(inp=>{if(inp.value)updateUpperRowAmount(inp);});
    recalcOrderTotal();
    // 서랍/옵션: drawer-body 렌더 완료 확인 후 복원
    restoreDrawerItemsWhenReady(order);
  },80);
}


async function submitEditOrder(orderId, saveMode){
  return _withOrderLock(orderId, 'edit', async () => {
  const orders=DB.get('orders',[]);
  const idx=orders.findIndex(o=>o.id===orderId);
  if(idx===-1){toast('발주서를 찾을 수 없습니다.','error');return;}

  // 원래 발주서 정보 보존 (id·orderNum·status·등록자·등록일 유지)
  const orig=orders[idx];
  const targetStatus=saveMode||(orig.status||'발주대기');
  window._editOverride={
    id:orig.id,
    orderNum:orig.orderNum,
    originalStatus:orig.status||'',
    status:targetStatus,
    createdBy:orig.createdBy||'',
    createdAt:orig.createdAt||new Date().toISOString(),
    deliveryTo:orig.deliveryTo||orig.siteName||'',
    address:orig.address||orig.customerName||'',
    shipDate:orig.shipDate||'',
    warehouse:orig.warehouse||'',
    statusHistory:orig.statusHistory||[]
  };

  // ── 기존 splice + DB.set 제거 (race condition 원인) ──
  // saveOrder가 _editOverride.id로 같은 자리에 교체 처리하므로 사전 삭제 불필요
  // 기존 발주 필요 목록은 saveOrder의 주문 트랜잭션 안에서 새 목록으로 교체한다.
  // 검증/ID 발급/재고 CAS가 실패해도 기존 PR이 먼저 사라지면 안 된다.
  // 모달 제목/버튼 원복
  const titleEl=document.querySelector('#order-modal .modal-title');
  if(titleEl)titleEl.textContent=isAdmin()?'대리 발주서 작성':'새 발주서 등록';
  // saveBtn onclick 초기화 (직접 함수 참조 방지)
  _resetOrderModalBtn();
  await submitOrder(targetStatus);
  if(!window._editOverride&&typeof window._releaseActiveOrderEditLock==='function'){
    await window._releaseActiveOrderEditLock();
  }
  });
}


// ── 발주 복사 기능 ──
function copyOrder(orderId){
  const order=getOrders().find(o=>o.id===orderId);
  if(!order){toast('발주서를 찾을 수 없습니다.','error');return;}
  if(!isAdmin()&&order.createdBy&&order.createdBy!==currentUser.id){toast('본인 발주서만 복사할 수 있습니다.','error');return;}
  closeModal('order-detail-modal');
  // [2026-07-14] 편집과 동일: 복사 대상 order를 렌더 전에 노출 → renderUpperTable이 items에 없는 신규 상부자재도 렌더
  window._pendingEditOrder = order;
  // openOrderModal() 대신 직접 빈 모달 렌더 — 임시저장 자동불러오기 confirm 방지
  _openOrderModalRender(null);
  setTimeout(()=>{
    // 기본 정보 — 납품처는 원본 무시하고 현재 본인 deliveryName으로 강제 덮어쓰기 + 읽기 전용
    const copyDelivEl=document.getElementById('o-delivery-to');
    const copyForced=(currentUser&&currentUser.deliveryName)?currentUser.deliveryName:'';
    copyDelivEl.value=copyForced;
    copyDelivEl.readOnly=true;
    copyDelivEl.tabIndex=-1;
    document.getElementById('o-address').value=order.address||order.customerName||'';
    setDateValue('o-date',todayStr());
    setDateValue('o-ship-date','');
    document.getElementById('o-note').value=order.note||'';
    document.getElementById('o-drawer-memo').value=order.drawerMemo||'';
    document.getElementById('o-etc-memo').value=order.etcMemo||'';
    // 복사는 출고지 선택 초기화
    orderSelectWarehouse('');
    // 공통 색상 복원
    if(order.sharedColor){const sSel=document.getElementById('shared-color-sel');if(sSel)sSel.value=order.sharedColor;}
    // 선반 복원
    if(order.shelfItems&&order.shelfItems.length>0){
      order.shelfItems.forEach(si=>{
        if(si.name==='선반'&&si.entries){si.entries.forEach(e=>{shelfRowEntries.push({size:e.size,qty:e.qty,color:e.color||order.sharedColor||''});});}
        if(si.name==='코너선반'&&si.entries){si.entries.forEach(e=>{cornerEntries.push({width:e.width,height:e.height,qty:e.qty,color:e.color||order.sharedColor||''});});}
      });
      renderShelfRows();renderCornerRows();
    }
    // 옷봉 복원
    if(order.rodItems&&order.rodItems.length>0){
      order.rodItems.forEach(r=>rodEntries.push({size:r.size,qty:r.qty,color:r.color||''}));
      renderRodRows();
    }
    // 상부 자재 복원 — DOM 직접 세팅 (_restoreDraftToModal 방식과 동일)
    const ucCopyEl=document.getElementById('upper-common-color');
    if(ucCopyEl){
      const storedColor=order.upperCommonColor||(order.upperMaterials&&order.upperMaterials[0]&&order.upperMaterials[0].color)||'화이트';
      ucCopyEl.value=storedColor;
      if(typeof checkUpperColorCodes==='function') checkUpperColorCodes(storedColor);
    }
    // [2026-08-03] name별 그룹핑 (copyOrder도 색상 서브행 지원)
    const _upperByNameCopy={};
    (order.upperMaterials||[]).forEach(r=>{ if(r&&r.name){(_upperByNameCopy[r.name]||=[]).push(r);} });
    const _isAdmCopy=true; // [2026-08-03 fix] 항상 복원
    const _ucValCopy=(document.getElementById('upper-common-color')||{}).value||'';
    Object.entries(_upperByNameCopy).forEach(([rawName, entries])=>{
      let mainEntry=entries.find(e=>e._isMain===true)||entries.find(e=>e.color===_ucValCopy)||entries[0];
      const extras=entries.filter(e=>e!==mainEntry);
      const r=mainEntry;
      const qty=r.qty||(r.white||0)+(r.black||0)+(r.silver||0)+(r.champagne||0);
      let inp=_findUpperControl(rawName,'.upper-qty');
      if(!inp){const cn=compatUpperName(rawName);if(cn!==rawName)inp=_findUpperControl(cn,'.upper-qty');}
      if(inp){inp.value=qty||'';updateUpperRowAmount(inp);}
      if(r.note){
        let nEl=_findUpperControl(rawName,'.upper-note');
        if(!nEl){const cn=compatUpperName(rawName);if(cn!==rawName)nEl=_findUpperControl(cn,'.upper-note');}
        if(nEl)nEl.value=r.note;
      }
      if(_isAdmCopy && extras.length>0 && typeof _addUpperExtraColorRow==='function'){
        extras.forEach(e=>{
          const eq=e.qty||(e.white||0)+(e.black||0)+(e.silver||0)+(e.champagne||0);
          if(eq>0&&e.color) _addUpperExtraColorRow(rawName, e.color, eq);
        });
      }
    });
    // 서랍/옵션 복원 — restoreDrawerItemsWhenReady 사용 (재시도 보장)
    restoreDrawerItemsWhenReady(order);
    document.querySelector('#order-modal .modal-title').textContent='발주서 복사 (신규 등록)';
    toast('발주 내용을 불러왔습니다. 날짜와 수량을 확인 후 저장해주세요.','success');
  },200);
}


// 최근 발주 빠른 복사 (대시보드 최근 발주 목록에서 사용)
function quickCopyLatest(){
  const orders=getOrders().filter(o=>{
    if(!isAdmin()&&o.createdBy&&o.createdBy!==currentUser.id)return false;
    return o.status!=='취소';
  }).sort(orderRecentSort);
  if(orders.length===0){toast('복사할 발주서가 없습니다.','error');return;}
  copyOrder(orders[0].id);
}
