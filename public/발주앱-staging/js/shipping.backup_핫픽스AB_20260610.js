// ── 출고 현황 (관리자 전용) ──────────────────────────────────────────────
// 창고 직원 피킹용: 출고 대상 발주서의 품목을 구역별로 합산해 보여준다.
// 의존: window._FS(Firestore 직접), currentUser(db.js), orderStatusBadge(utils.js), fmt/toast(uiUtils), isAdmin(db.js)
//
// 🔴🔴 데이터 규칙 (절대) — 읽기·쓰기 모두 서버만. 캐시·로컬 폴백 일절 금지.
//   - 읽기: Firestore를 {source:'server'}로 직접 조회(_fetchOrdersFromServer). _FS.get은 persistence
//     캐시값을 줄 수 있어 사용 금지. getOrders()/DB.get/_mem/localStorage 금지. fromCache면 거부.
//   - 서버 미수신/실패({source:'server'}가 throw) 시 렌더 중단 + 새로고침 안내. 캐시/이전/로컬로 채우지 않는다.
//   - 쓰기(출고완료): _serverCompleteShip()가 서버소스 조회→갱신→Firestore 직접 set(에러 catch)→
//     서버소스 재조회로 실제 반영 검증한 뒤에만 성공 처리 및 _mem 동기화.
//     changeOrderStatus(=_mem DB.get/DB.set 경유)와 _FS.set(에러 삼킴)은 사용하지 않는다.
//     ※ 출고준비/출고완료 전환은 재고차감·이카운트 부수효과 없음(상태+이력만). 발주확정은 단일 쓰기로
//       출고완료 처리하되 출고준비 이력을 함께 남긴다. (향후 이 전환에 부수효과 추가 시 함께 갱신)
//   - 한계: orders 전체 배열을 통째로 read-modify-write(앱 전역 데이터 모델). get-set 사이 타 기기
//     동시수정분 유실 가능성은 앱 공통 한계 — 경쟁 창을 행위당 1회로 최소화. 근본 해결=트랜잭션/문서분리(별도 과제).
// ───────────────────────────────────────────────────────────────────────
(function(){
  'use strict';

  let shipWarehouse = '시흥';     // '시흥' | '평택'
  let shipDateFilter = 'today';   // 'today' | 'tomorrow' | 'week' | 'undecided'
  const shipChecked = new Set();  // 품목별 임시 체크 (미저장 — 새로고침 시 사라짐, 의도된 동작)
  let _renderSeq = 0;             // 렌더 시퀀스 토큰 — 비동기 결과가 최신 렌더만 DOM 반영(연타 race 방지)

  const TARGET_STATUS = ['발주확정','출고준비']; // 출고 대상 구간

  // ── 헬퍼 ──
  function _esc(s){
    return String(s==null?'':s).replace(/[&<>"']/g,function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function _ymd(d){
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  }
  function _dateRange(filter){
    const base=new Date(); base.setHours(0,0,0,0);
    if(filter==='today')   return {from:_ymd(base), to:_ymd(base)};
    if(filter==='tomorrow'){const t=new Date(base); t.setDate(t.getDate()+1); return {from:_ymd(t), to:_ymd(t)};}
    if(filter==='week'){
      const day=(base.getDay()+6)%7;               // 월=0 … 일=6
      const mon=new Date(base); mon.setDate(mon.getDate()-day);
      const sun=new Date(mon);  sun.setDate(sun.getDate()+6);
      return {from:_ymd(mon), to:_ymd(sun)};
    }
    return null; // undecided
  }

  // index.html에서 'hanger' 이름으로 초기화된 Firestore 인스턴스 핸들
  function _firestore(){
    if(!(window.firebase && firebase.apps && firebase.apps.length)) return null;
    try{ return firebase.app('hanger').firestore(); }catch(e){}
    try{ return firebase.firestore(); }catch(e){}
    return null;
  }

  // ── 서버 직접 읽기 (캐시 금지) ──
  // enablePersistence가 켜져 있어 _FS.get()은 캐시값을 줄 수 있으므로 사용하지 않는다.
  // {source:'server'}로 서버에서만 읽고(오프라인/서버불가 시 throw=폴백 없음), fromCache면 방어적으로 거부.
  async function _fetchOrdersFromServer(){
    const fs=_firestore();
    if(!fs) throw new Error('NO_FS');
    const snap=await fs.collection('hanger_data').doc('orders').get({source:'server'});
    if(snap.metadata && snap.metadata.fromCache) throw new Error('FROM_CACHE'); // 서버값이 아니면 거부
    if(!snap.exists) throw new Error('NO_DATA'); // 문서없음 → 폴백 금지, 에러 처리
    const orders=snap.data().value;
    if(orders==null) throw new Error('NO_DATA');
    return Array.isArray(orders) ? orders : [];
  }

  function _filterOrders(orders){
    let list=orders.filter(function(o){
      return o && TARGET_STATUS.indexOf(o.status)!==-1 && (o.warehouse||'시흥')===shipWarehouse;
    });
    if(shipDateFilter==='undecided'){
      list=list.filter(function(o){ return o.shipDate==='0000-00-00' || !o.shipDate; });
    } else {
      const r=_dateRange(shipDateFilter);
      list=list.filter(function(o){ return o.shipDate && o.shipDate!=='0000-00-00' && o.shipDate>=r.from && o.shipDate<=r.to; });
    }
    return list.sort(function(a,b){ return (a.shipDate||'').localeCompare(b.shipDate||''); });
  }

  // ── 구역별 품목 합산 ──
  function _aggregate(orders){
    const upper=new Map(), rod=new Map(), shelf=new Map(), drawer=new Map();
    function add(map,key,label,qty,o){
      if(!map.has(key)) map.set(key,{label:label, qty:0, rows:[]});
      const g=map.get(key);
      g.qty+=qty;
      g.rows.push({id:o.id, deliveryTo:o.deliveryTo||o.siteName||'-', qty:qty, shipDate:o.shipDate});
    }
    orders.forEach(function(o){
      (o.upperMaterials||[]).forEach(function(r){
        const q=Number(r.qty)||0; if(q<=0) return;
        const color=r.color||o.upperCommonColor||'';
        add(upper,'U|'+r.name+'|'+color, (r.name||'-')+(color?' · '+color:''), q, o);
      });
      (o.rodItems||[]).forEach(function(r){
        const q=Number(r.qty)||0; if(q<=0) return;
        const mm=parseInt(r.size,10); if(!mm) return;
        add(rod,'R|'+mm, mm+'mm', q, o);
      });
      (o.shelfItems||[]).forEach(function(si){
        (si.entries||[]).forEach(function(e){
          const q=Number(e.qty)||0; if(q<=0) return;
          const color=e.color||o.sharedColor||'';
          const spec=(si.name==='코너선반') ? ((e.width||'?')+'x'+(e.height||'?')) : (e.size||'?');
          add(shelf,'S|'+si.name+'|'+spec+'|'+color, si.name+' '+spec+(color?' · '+color:''), q, o);
        });
      });
      (o.drawerItems||o.items||[]).forEach(function(di){
        const q=Number(di.requiredQty)||0; if(q<=0) return;
        const color=di.color||o.sharedColor||'';
        add(drawer,'D|'+di.itemId+'|'+color, (di.displayName||di.itemName||'-')+(color?' · '+color:''), q, o);
      });
    });
    return {upper:upper, rod:rod, shelf:shelf, drawer:drawer};
  }

  // ── 렌더 ──
  function _filterBarHtml(){
    function tab(g,val,cur,label){
      return '<button class="ship-tab'+(cur===val?' active':'')+'" data-'+g+'="'+val+'">'+label+'</button>';
    }
    return ''+
      '<div class="ship-filter">'+
        '<div class="ship-tabs">'+
          tab('wh','시흥',shipWarehouse,'시흥')+tab('wh','평택',shipWarehouse,'평택')+
        '</div>'+
        '<div class="ship-tabs ship-tabs-date">'+
          tab('date','today',shipDateFilter,'오늘')+tab('date','tomorrow',shipDateFilter,'내일')+
          tab('date','week',shipDateFilter,'이번주')+tab('date','undecided',shipDateFilter,'미정')+
        '</div>'+
      '</div>';
  }

  function _sectionHtml(title, icon, map){
    if(!map || map.size===0) return '';
    let rows='';
    map.forEach(function(g,key){
      const done=shipChecked.has(key);
      rows+=''+
        '<div class="ship-row'+(done?' done':'')+'">'+
          '<button class="ship-check" data-check="'+_esc(key)+'" aria-label="체크"><i class="fas fa-check"></i></button>'+
          '<div class="ship-row-main">'+
            '<div class="ship-row-label">'+_esc(g.label)+'</div>'+
            '<button class="ship-detail-toggle" data-toggle="1">상세 '+g.rows.length+'건 <i class="fas fa-chevron-down"></i></button>'+
          '</div>'+
          '<div class="ship-row-qty">'+g.qty+'<span>개</span></div>'+
        '</div>'+
        '<div class="ship-detail" hidden>'+
          g.rows.map(function(r){
            return '<div class="ship-detail-row"><span class="ship-d-name">'+_esc(r.deliveryTo)+'</span>'+
                   '<span class="ship-d-meta">'+_esc(fmt(r.shipDate))+' · '+r.qty+'개</span></div>';
          }).join('')+
        '</div>';
    });
    return ''+
      '<div class="card ship-section">'+
        '<div class="card-header"><h3><i class="fas '+icon+'" style="margin-right:6px;color:var(--primary-light)"></i>'+title+
          ' <span class="ship-sec-count">'+map.size+'종</span></h3></div>'+
        '<div class="ship-rows">'+rows+'</div>'+
      '</div>';
  }

  function _ordersCardHtml(orders){
    if(!orders.length) return '';
    const rows=orders.map(function(o){
      const dTo=_esc(o.deliveryTo||o.siteName||'-');
      const addr=_esc(o.address||'');
      // 상태 뱃지는 앱 표준(orderStatusBadge)으로 통일 — 발주서 목록·상세와 동일 표기/스타일
      const badge=(typeof orderStatusBadge==='function')?orderStatusBadge(o.status):_esc(o.status||'');
      return ''+
        '<div class="ship-order-row">'+
          '<div class="ship-order-info">'+
            '<div class="ship-order-name">'+dTo+' '+badge+'</div>'+
            '<div class="ship-order-meta">'+_esc(fmt(o.shipDate))+(addr?' · '+addr:'')+'</div>'+
          '</div>'+
          '<button class="btn ship-complete-btn" data-ship-complete="'+_esc(String(o.id))+'"><i class="fas fa-truck-fast"></i> 출고완료</button>'+
        '</div>';
    }).join('');
    return ''+
      '<div class="card ship-section">'+
        '<div class="card-header"><h3><i class="fas fa-list-check" style="margin-right:6px;color:var(--primary-light)"></i>발주서별 출고 완료 처리 <span class="ship-sec-count">'+orders.length+'건</span></h3></div>'+
        '<div class="ship-order-list">'+rows+'</div>'+
      '</div>';
  }

  function _errorHtml(){
    return ''+
      '<div class="section-title">출고 현황</div>'+
      '<div class="empty"><i class="fas fa-cloud-arrow-down"></i>'+
        '<p>서버에서 데이터를 불러오지 못했습니다.<br>새로고침해 주세요.</p>'+
        '<button class="btn btn-primary" style="margin-top:14px" onclick="location.reload()"><i class="fas fa-rotate-right"></i> 새로고침</button>'+
      '</div>';
  }

  function _viewHtml(agg, orders){
    const sections=
      _sectionHtml('상부자재','fa-layer-group',agg.upper)+
      _sectionHtml('옷봉 (절단규격)','fa-minus',agg.rod)+
      _sectionHtml('선반 / 코너선반','fa-border-all',agg.shelf)+
      _sectionHtml('서랍 · 옵션','fa-boxes-stacked',agg.drawer);
    let body;
    if(orders.length){
      // 합산 품목이 없어도(메모만 있는 발주서 등) 발주서별 출고완료 카드는 항상 표시
      const noItemsNote='<div class="card ship-section" style="padding:14px 16px;color:var(--text-3);font-size:14px">합산할 품목이 없습니다. 아래 발주서에서 출고 완료를 처리하세요.</div>';
      body=(sections||noItemsNote)+_ordersCardHtml(orders);
    } else {
      body='<div class="empty"><i class="fas fa-truck-ramp-box"></i><p>이 조건에 출고할 발주서가 없습니다.</p></div>';
    }
    return ''+
      '<div class="section-title">출고 현황</div>'+
      '<div class="section-sub">서버 기준 출고 대상 품목입니다. 창고에서 품목을 꺼내며 체크하세요. (체크는 임시 표시)</div>'+
      _filterBarHtml()+
      '<div class="ship-body">'+body+'</div>';
  }

  // ── 이벤트 ──
  function _onClick(e){
    const whBtn=e.target.closest('[data-wh]');
    if(whBtn){ shipWarehouse=whBtn.dataset.wh; renderShippingView(); return; }
    const dateBtn=e.target.closest('[data-date]');
    if(dateBtn){ shipDateFilter=dateBtn.dataset.date; renderShippingView(); return; }
    const chk=e.target.closest('[data-check]');
    if(chk){
      const key=chk.dataset.check, row=chk.closest('.ship-row');
      if(shipChecked.has(key)){ shipChecked.delete(key); row&&row.classList.remove('done'); }
      else { shipChecked.add(key); row&&row.classList.add('done'); }
      return;
    }
    const tog=e.target.closest('[data-toggle]');
    if(tog){
      const detail=tog.closest('.ship-row') && tog.closest('.ship-row').nextElementSibling;
      if(detail && detail.classList.contains('ship-detail')){
        detail.hidden=!detail.hidden;
        tog.classList.toggle('open',!detail.hidden);
      }
      return;
    }
    const done=e.target.closest('[data-ship-complete]');
    if(done){
      const id=done.dataset.shipComplete; // 문자열 그대로 — 숫자/문자 id 모두 안전 처리
      if(id) handleShipComplete(id);
      return;
    }
  }

  function _histEntry(status, note){
    return {
      status:status,
      changedBy:(typeof currentUser!=='undefined'&&currentUser)?currentUser.id:'',
      changedByName:(typeof currentUser!=='undefined'&&currentUser)?currentUser.name:'',
      changedAt:new Date().toISOString(),
      note:note||''
    };
  }

  // 서버 직접 "출고완료" 처리 — 로컬(_mem) 안 거침.
  //  ① 서버소스 조회 → ② 해당 발주서만 출고완료로 갱신(단일 쓰기, 발주확정은 출고준비 이력 동반)
  //  → ③ Firestore에 직접 set(에러 catch) → ④ 서버소스 재조회로 "실제 반영" 검증 → ⑤ 검증 성공 시에만 _mem 동기화 + ok.
  // 반환: {ok:true} | {ok:false, reason:'nofs'|'notfound'|'invalid'|'writefail', cur:현재상태}
  async function _serverCompleteShip(orderId){
    const fs=_firestore();
    if(!fs) return {ok:false, reason:'nofs'};
    const orders=await _fetchOrdersFromServer(); // 서버 최신(서버소스, 실패 시 throw → 호출부 catch)
    const idx=orders.findIndex(function(x){ return x && String(x.id)===String(orderId); });
    if(idx===-1) return {ok:false, reason:'notfound'};
    const cur=orders[idx].status;
    if(cur!=='발주확정' && cur!=='출고준비') return {ok:false, reason:'invalid', cur:cur};
    if(!Array.isArray(orders[idx].statusHistory)) orders[idx].statusHistory=[];
    // 발주확정 → 출고완료 직접 전환은 nextStatuses상 불가하나, 여기선 단일 쓰기로 처리하고
    // 실제 거친 단계를 이력에 보존(출고준비 자동 경유). 경쟁 창을 1회로 줄여 동시수정 위험 최소화.
    if(cur==='발주확정') orders[idx].statusHistory.push(_histEntry('출고준비','출고완료 처리 중 자동 경유'));
    orders[idx].statusHistory.push(_histEntry('출고완료',''));
    orders[idx].status='출고완료';
    orders[idx].updatedAt=new Date().toISOString();

    // ③ Firestore에 직접 기록 — _FS.set은 에러를 삼키므로 직접 set+catch로 실패를 잡는다
    try{
      await fs.collection('hanger_data').doc('orders').set({value:orders, updatedAt:new Date().toISOString()});
    }catch(e){ return {ok:false, reason:'writefail'}; }

    // ④ 실제 서버 반영 검증 — 서버소스 재조회해서 상태가 출고완료인지 확인
    let verify;
    try{ verify=await _fetchOrdersFromServer(); }
    catch(e){ return {ok:false, reason:'writefail'}; }
    const vo=verify.find(function(x){ return x && String(x.id)===String(orderId); });
    if(!vo || vo.status!=='출고완료') return {ok:false, reason:'writefail'};

    if(window._mem) window._mem['orders']=verify; // 검증된 서버값으로만 미러 동기화
    return {ok:true};
  }

  async function handleShipComplete(orderId){
    if(!window.confirm('이 발주서를 출고완료 처리할까요?')) return;
    let r;
    try{ r=await _serverCompleteShip(orderId); }
    catch(e){ toast('서버 연결 실패 — 새로고침 후 다시 시도하세요.','error'); renderShippingView(); return; }
    if(r.ok) toast('출고완료 처리되었습니다.','success');
    else if(r.reason==='notfound') toast('발주서를 찾을 수 없습니다.','error');
    else if(r.reason==='nofs')     toast('서버에 연결할 수 없습니다. 새로고침해 주세요.','error');
    else if(r.reason==='invalid')  toast('출고 대상 상태가 아닙니다 (현재: '+(r.cur||'?')+').','error');
    else if(r.reason==='writefail')toast('서버 저장이 확인되지 않았습니다. 새로고침 후 상태를 확인해 주세요.','error');
    else toast('출고완료 처리에 실패했습니다.','error');
    renderShippingView(); // 항상 서버 재조회로 현재 상태 반영
  }

  async function renderShippingView(){
    const el=document.getElementById('content');
    if(!el) return;
    // fail-closed: isAdmin이 함수가 아니거나 관리자가 아니면 무조건 차단
    if(typeof isAdmin!=='function' || !isAdmin()){
      el.innerHTML='<div class="empty"><i class="fas fa-lock"></i><p>관리자만 접근할 수 있습니다.</p></div>';
      return;
    }
    el.innerHTML='<div class="loading"><div class="spinner"></div>서버에서 불러오는 중...</div>';
    const seq=++_renderSeq;
    let orders;
    try{ orders=await _fetchOrdersFromServer(); }
    catch(e){ if(seq===_renderSeq) el.innerHTML=_errorHtml(); return; }
    if(seq!==_renderSeq) return; // 더 최신 렌더가 시작됨 → 이 결과는 버린다(연타 race 방지)
    const filtered=_filterOrders(orders);
    const agg=_aggregate(filtered);
    el.innerHTML=_viewHtml(agg, filtered);
    if(!el._shipBound){ el.addEventListener('click',_onClick); el._shipBound=true; }
  }

  // 전역 노출 (app.js navigate에서 호출)
  window.renderShippingView=renderShippingView;
})();
