// ── 발주 관리 (상태/잠금/목록/상세/수정/복사) ──
// 의존: js/store/db.js, js/utils/uiUtils.js, js/utils.js, js/price.js, js/inventory.js


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


function changeOrderStatus(orderId, newStatus){
  const orders=DB.get('orders',[]);
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
    (order.drawerItems||order.items||[]).forEach(oi=>{
      const iIdx=dbItems.findIndex(i=>i.id===oi.itemId);
      if(iIdx===-1)return;
      if(dbItems[iIdx].category!=='서랍장')return;
      if(dbItems[iIdx].stockSiheung===undefined)dbItems[iIdx].stockSiheung=dbItems[iIdx].currentStock||0;
      if(dbItems[iIdx].stockPyeongtaek===undefined)dbItems[iIdx].stockPyeongtaek=0;
      const wh=oi.warehouse||confWh;
      const whKey=getWhKey(wh);
      const cwKey=getColorWhKey(wh);
      const oiColor=oi.color||order.sharedColor||'';
      let before, afterVal;
      if(oiColor){
        if(!dbItems[iIdx][cwKey])dbItems[iIdx][cwKey]={};
        before=dbItems[iIdx][cwKey][oiColor]||0;
        afterVal=Math.max(0,before-oi.requiredQty);
        dbItems[iIdx][cwKey][oiColor]=afterVal;
        dbItems[iIdx][whKey]=Object.values(dbItems[iIdx][cwKey]).reduce((s,v)=>s+(v||0),0);
      } else {
        before=dbItems[iIdx][whKey];
        afterVal=Math.max(0,before-oi.requiredQty);
        dbItems[iIdx][whKey]=afterVal;
      }
      dbItems[iIdx].currentStock=(dbItems[iIdx].stockSiheung||0)+(dbItems[iIdx].stockPyeongtaek||0);
      const logs=DB.get('logs',[]);
      logs.push({id:DB.nextId('logs'),itemId:oi.itemId,type:'발주차감',qty:-oi.requiredQty,beforeStock:before,afterStock:afterVal,warehouse:wh,color:oiColor||'',memo:`발주 #${orderId} 확정`,orderId,createdBy:currentUser?currentUser.id:'',createdAt:now});
      DB.set('logs',logs);
    });
    DB.set('items',dbItems);
    orders[idx].stockDeducted=true;
  }

  // 취소/보관 시 재고 롤백
  if(shouldRollback){
    const dbItems=DB.get('items',[]);
    const rollWh=order.warehouse||'시흥';
    (order.drawerItems||order.items||[]).forEach(oi=>{
      const iIdx=dbItems.findIndex(i=>i.id===oi.itemId);
      if(iIdx===-1)return;
      if(dbItems[iIdx].category!=='서랍장')return;
      if(dbItems[iIdx].stockSiheung===undefined)dbItems[iIdx].stockSiheung=dbItems[iIdx].currentStock||0;
      if(dbItems[iIdx].stockPyeongtaek===undefined)dbItems[iIdx].stockPyeongtaek=0;
      const wh=oi.warehouse||rollWh;
      const whKey=getWhKey(wh);
      const cwKey=getColorWhKey(wh);
      const oiColor=oi.color||order.sharedColor||'';
      let before, afterVal;
      if(oiColor){
        if(!dbItems[iIdx][cwKey])dbItems[iIdx][cwKey]={};
        before=dbItems[iIdx][cwKey][oiColor]||0;
        afterVal=before+oi.requiredQty;
        dbItems[iIdx][cwKey][oiColor]=afterVal;
        dbItems[iIdx][whKey]=Object.values(dbItems[iIdx][cwKey]).reduce((s,v)=>s+(v||0),0);
      } else {
        before=dbItems[iIdx][whKey];
        afterVal=before+oi.requiredQty;
        dbItems[iIdx][whKey]=afterVal;
      }
      dbItems[iIdx].currentStock=(dbItems[iIdx].stockSiheung||0)+(dbItems[iIdx].stockPyeongtaek||0);
      const logs=DB.get('logs',[]);
      logs.push({id:DB.nextId('logs'),itemId:oi.itemId,type:'취소롤백',qty:oi.requiredQty,beforeStock:before,afterStock:afterVal,warehouse:wh,color:oiColor||'',memo:`발주 #${orderId} ${newStatus}`,orderId,createdBy:currentUser?currentUser.id:'',createdAt:now});
      DB.set('logs',logs);
    });
    DB.set('items',dbItems);
    orders[idx].stockDeducted=false;
    // 관련 PR 취소
    const prs=DB.get('purchase_requests',[]);
    prs.forEach(p=>{if(p.orderId===orderId&&p.status==='대기'){p.status='취소';p.updatedAt=now;}});
    DB.set('purchase_requests',prs);
  }

  orders[idx].status=newStatus;
  orders[idx].updatedAt=now;
  addStatusHistory(idx, orders, newStatus, '');
  DB.set('orders',orders);
  const chgOrder=DB.get('orders',[]).find(o=>o.id===orderId);
  toast(`발주 ${chgOrder?(chgOrder.orderNum||('#'+orderId)):('#'+orderId)} 상태가 '${newStatus}'로 변경되었습니다.`,'success');

  // (이카운트 연동은 toggleOrderLock에서 출고확정 버튼 누를 때 처리)

  return true;
}


// ── 이카운트 판매전표 생성 (발주확정 시 호출) ─────────────────────
// 처리 대상: 상부자재 / 옷봉 / 선반 / 코너선반 / 서랍장&옵션
async function _createEcountSaleFromOrder(order){
  if(!window._FN){return;}
  const allItems=DB.get('items',[]);
  const wh=order.warehouse||'시흥';
  const whCd=getWhErpCd(wh);
  const sharedColor=order.sharedColor||'';

  // 거래처코드: 발주 올린 사람 / 담당자: 출고확정 누른 사람(현재 로그인)
  const accounts=DB.get('accounts',[]);
  const ordererAcc=accounts.find(a=>a.id===order.createdBy);
  const confirmerAcc=accounts.find(a=>a.id===(currentUser?.id));
  const custCd=ordererAcc?.bizCd||'';
  const empCd=confirmerAcc?.empCd||'';
  const custNm=order.deliveryTo||'';

  const ecountItems=[];

  // ① 상부자재
  // colorProdCdMap 키는 한글 색상명 (화이트, 블랙, 실버, 샴페인골드)
  // upperMaterials 항목: {name, white, black, silver, champagne, qty, unitPrice}
  const upperColorMap={'white':'화이트','black':'블랙','silver':'실버','champagne':'샴페인골드'};
  (order.upperMaterials||[]).forEach(r=>{
    if(!r.name)return;
    const name=compatUpperName(r.name);
    // 1차: 정확한 이름 매칭 (공백 제거)
    let dbItem=allItems.find(i=>normalizeName(i.name)===normalizeName(name));
    // 2차 fallback: 괄호·구두점까지 제거 후 완전 일치
    if(!dbItem){
      const aggName=aggressiveNormalize(name);
      dbItem=allItems.find(i=>aggressiveNormalize(i.name)===aggName);
    }
    // 3차 fallback: DB 품목명이 주문 품목명의 접두어이거나 그 반대인 경우
    if(!dbItem){
      const aggName=aggressiveNormalize(name);
      dbItem=allItems.find(i=>{
        const aggItem=aggressiveNormalize(i.name);
        return aggItem.length>=2&&(aggName.startsWith(aggItem)||aggItem.startsWith(aggName));
      });
    }
    // 4차 fallback: 원래 이름(compat 변환 전)으로 재시도
    if(!dbItem){
      dbItem=allItems.find(i=>normalizeName(i.name)===normalizeName(r.name));
    }
    if(!dbItem){
      const aggOrig=aggressiveNormalize(r.name);
      dbItem=allItems.find(i=>aggressiveNormalize(i.name)===aggOrig);
    }
    if(!dbItem){
      console.warn('[이카운트] 상부자재 품목 미매칭 (건너뜀):',r.name,'→',name);
      return;
    }

    // 공통색상이 지정된 경우 → 해당 색상으로 전체 수량 처리
    if(order.upperCommonColor){
      const qty=r.qty||r.white||r.black||r.silver||r.champagne||0;
      if(qty<=0)return;
      const colorKey=resolveColorKey(order.upperCommonColor);
      const prodCd=dbItem.colorProdCdMap?.[colorKey]||dbItem.colorProdCdMap?.[order.upperCommonColor]||dbItem.prodCd||'';
      if(!prodCd)return;
      const price=r.unitPrice??getActivePriceForItem(name)??null;
      ecountItems.push({prodCd,qty,prodNm:name,sizeNm:colorKey,price});
    } else {
      // 색상별 수량이 따로 있는 경우 → 색상별로 각각 생성
      ['white','black','silver','champagne'].forEach(engKey=>{
        const qty=r[engKey]||0;
        if(qty<=0)return;
        const korColor=upperColorMap[engKey];
        const colorKey=resolveColorKey(korColor);
        const prodCd=dbItem.colorProdCdMap?.[colorKey]||dbItem.colorProdCdMap?.[korColor]||dbItem.prodCd||'';
        if(!prodCd)return;
        const price=r.unitPrice??getActivePriceForItem(name)??null;
        ecountItems.push({prodCd,qty,prodNm:name,sizeNm:colorKey,price});
      });
    }
  });

  // ② 옷봉 2400 (색상별 코드 조회 — 이카운트 023~026)
  if((order.rodItems||[]).length>0){
    const rodQty=order.rod2400Required||0;
    if(rodQty>0){
      const rodItem=allItems.find(i=>normalizeName(i.name)==='옷봉2400');
      if(rodItem){
        // 옷봉 색상 = 상부자재 공통색상 → 주문 공통색상 순으로 결정
        const rodColor=order.upperCommonColor||sharedColor||'';
        const rodColorKey=resolveColorKey(rodColor);
        const prodCd=(rodItem.colorProdCdMap&&rodColorKey&&(rodItem.colorProdCdMap[rodColorKey]||rodItem.colorProdCdMap[rodColor]))
          ?(rodItem.colorProdCdMap[rodColorKey]||rodItem.colorProdCdMap[rodColor])
          :(rodItem.prodCd||'');
        if(prodCd){
          const price=getActivePriceForItem('옷봉 2400')??4500;
          ecountItems.push({prodCd,qty:rodQty,prodNm:'옷봉 2400',sizeNm:rodColorKey,price});
        }
      }
    }
  }

  // ③ 선반 / 코너선반
  (order.shelfItems||[]).forEach(si=>{
    const isCorner=(si.name==='코너선반');
    (si.entries||[]).forEach(e=>{
      const qty=e.qty||0;
      if(qty<=0)return;
      const color=e.color||sharedColor||'';
      let prodCd='';
      if(isCorner){
        prodCd=getCornerShelfEcountCode(e.width,e.height,color)||e.ecountCd||'';
      } else {
        prodCd=getShelfEcountCode(e.size,color)||e.ecountCd||'';
      }
      if(!prodCd)return;
      const price=e.unitPrice??(isCorner?getCornerShelfPrice(e.width,e.height):getShelfPrice(e.size));
      const sizeNm=isCorner?`${e.width}×${e.height}`:(e.size?`${e.size}mm`:'');
      ecountItems.push({prodCd,qty,prodNm:si.name,sizeNm:`${color}${sizeNm?(' '+sizeNm):''}`,price});
    });
  });

  // ④ 서랍장 / 옵션
  (order.drawerItems||order.items||[]).forEach(oi=>{
    const qty=oi.requiredQty||0;
    if(qty<=0)return;
    const item=allItems.find(i=>i.id===oi.itemId);
    if(!item)return;
    const color=oi.color||sharedColor||'';
    const colorKey=resolveColorKey(color);

    // ── 서브타입 선택된 경우: 각 서브타입을 개별 이카운트 품목으로 전송 ──
    const subtypeDefs=(typeof ITEM_SUBTYPES!=='undefined')?ITEM_SUBTYPES[item.name]:null;
    if(subtypeDefs&&oi.subTypeChecked&&oi.subTypeChecked.length>0){
      oi.subTypeChecked.forEach(stName=>{
        const stDef=subtypeDefs.find(s=>s.name===stName);
        const lookupName=stDef?.itemName||stName;
        // DB 품목 찾기 (aggressiveNormalize fallback)
        let stItem=allItems.find(i=>normalizeName(i.name)===normalizeName(lookupName));
        if(!stItem){const agg=aggressiveNormalize(lookupName);stItem=allItems.find(i=>aggressiveNormalize(i.name)===agg);}
        if(!stItem){console.warn('[이카운트] 서브타입 품목 미매칭:',stName,'→',lookupName);return;}
        const stColorKey=resolveColorKey(color);
        const stProdCd=(stItem.colorProdCdMap&&stColorKey&&(stItem.colorProdCdMap[stColorKey]||stItem.colorProdCdMap[color]))
          ?(stItem.colorProdCdMap[stColorKey]||stItem.colorProdCdMap[color])
          :(stItem.prodCd||'');
        if(!stProdCd){console.warn('[이카운트] 서브타입 코드 없음:',stName,color);return;}
        const stIsColorless=stItem.noColor||(stItem.prodCd&&!stItem.colorProdCdMap);
        const stSizeNm=stIsColorless?'':stColorKey;
        const stPrice=getActivePriceForItem(lookupName)??null;
        ecountItems.push({prodCd:stProdCd,qty,prodNm:lookupName,sizeNm:stSizeNm,price:stPrice});
      });
      // 서브타입 전송 후 부모 품목도 이어서 전송 (아래 공통 로직으로 fall-through)
    }

    // 부모 품목 전송 (서브타입 유무와 관계없이 항상 전송)
    const prodCd=(item.colorProdCdMap&&colorKey&&(item.colorProdCdMap[colorKey]||item.colorProdCdMap[color]))
      ?(item.colorProdCdMap[colorKey]||item.colorProdCdMap[color])
      :(item.prodCd||'');
    if(!prodCd)return;
    const isColorless=item.noColor||(item.prodCd&&!item.colorProdCdMap);
    const sizeNm=isColorless?'':colorKey;
    const price=oi.unitPrice??getActivePriceForItem(item.name)??null;
    ecountItems.push({prodCd,qty,prodNm:item.name,sizeNm,price});
  });

  // ── 디버그 로그 ──
  console.log('[이카운트 디버그] order.upperMaterials:', JSON.stringify(order.upperMaterials||[]));
  console.log('[이카운트 디버그] order.shelfItems:', JSON.stringify(order.shelfItems||[]));
  console.log('[이카운트 디버그] order.drawerItems:', JSON.stringify(order.drawerItems||[]));
  console.log('[이카운트 디버그] sharedColor:', sharedColor);
  console.log('[이카운트 디버그] 수집된 ecountItems:', JSON.stringify(ecountItems));

  if(ecountItems.length===0){
    console.warn('[이카운트 연동] ERP 품목코드가 설정된 품목 없음 — 전표 생성 건너뜀');
    toast('이카운트: 연동 가능한 품목코드가 없어 전표 생성을 건너뜁니다.','warning');
    return;
  }

  let ioDate='';
  if(order.orderDate&&order.orderDate!=='0000-00-00') ioDate=order.orderDate.replace(/-/g,'');

  toast('이카운트에 판매전표 생성 중...','info');
  try{
    const result=await window._FN.createSaleOrder({
      custCd,
      custNm,
      empCd,
      whCd,
      ioDate,
      remarks: order.orderNum || `발주 #${order.id}`,
      items:ecountItems
    });
    toast(result.data.message||'이카운트 판매전표 생성 완료','success');
    if(result.data.slipNos?.length){
      const latestOrders=DB.get('orders',[]);
      const oidx=latestOrders.findIndex(o=>o.id===order.id);
      if(oidx!==-1){latestOrders[oidx].ecountSlipNos=result.data.slipNos;DB.set('orders',latestOrders);}
    }
  }catch(e){
    const msg=e?.message||String(e);
    toast('이카운트 출고 연동 실패: '+msg,'error');
    console.error('[이카운트 판매전표]',e);
  }
}


// 발주 취소: 차감된 재고 롤백
function cancelOrder(orderId, cancelReason){
  const orders=DB.get('orders',[]);
  const idx=orders.findIndex(o=>o.id===orderId);
  if(idx===-1){toast('발주서를 찾을 수 없습니다.','error');return false;}
  const order=orders[idx];
  if(order.status==='cancelled'){toast('이미 취소된 발주서입니다.','error');return false;}

  // 재고 롤백: stockDeducted가 true인 경우에만
  if(order.stockDeducted){
    const items=DB.get('items',[]);
    const rollbackNow=new Date().toISOString();
    const orderWh=order.warehouse||'시흥';
    (order.drawerItems||order.items||[]).forEach(oi=>{
      const iIdx=items.findIndex(i=>i.id===oi.itemId);
      if(iIdx===-1)return;
      if(items[iIdx].category==='서랍장'){
        if(items[iIdx].stockSiheung===undefined)items[iIdx].stockSiheung=items[iIdx].currentStock||0;
        if(items[iIdx].stockPyeongtaek===undefined)items[iIdx].stockPyeongtaek=0;
        const wh=oi.warehouse||orderWh;
        const whKey=getWhKey(wh);
        const cwKey=getColorWhKey(wh);
        const oiColor=oi.color||order.sharedColor||'';
        let before, afterVal;
        if(oiColor){
          if(!items[iIdx][cwKey])items[iIdx][cwKey]={};
          before=items[iIdx][cwKey][oiColor]||0;
          afterVal=before+oi.requiredQty;
          items[iIdx][cwKey][oiColor]=afterVal;
          items[iIdx][whKey]=Object.values(items[iIdx][cwKey]).reduce((s,v)=>s+(v||0),0);
        } else {
          before=items[iIdx][whKey];
          afterVal=before+oi.requiredQty;
          items[iIdx][whKey]=afterVal;
        }
        items[iIdx].currentStock=(items[iIdx].stockSiheung||0)+(items[iIdx].stockPyeongtaek||0);
        const logs3=DB.get('logs',[]);
        logs3.push({id:DB.nextId('logs'),itemId:oi.itemId,type:'취소롤백',qty:oi.requiredQty,beforeStock:before,afterStock:afterVal,warehouse:wh,color:oiColor||'',memo:`발주 #${orderId} 취소`,orderId,createdBy:currentUser?currentUser.id:'',createdAt:rollbackNow});
        DB.set('logs',logs3);
      }
    });
    DB.set('items',items);
  }

  // 발주서 상태 취소로 변경
  const cancelNow=new Date().toISOString();
  orders[idx].status='취소';
  orders[idx].cancelReason=cancelReason||'';
  orders[idx].cancelledAt=cancelNow;
  orders[idx].updatedAt=cancelNow;
  orders[idx].stockDeducted=false;
  addStatusHistory(idx, orders, '취소', cancelReason||'');
  DB.set('orders',orders);

  // 관련 발주 필요 목록도 취소 처리
  const prs=DB.get('purchase_requests',[]);
  prs.forEach(p=>{if(p.orderId===orderId&&p.status==='대기'){p.status='취소';p.updatedAt=new Date().toISOString();}});
  DB.set('purchase_requests',prs);

  return true;
}

function openOrderCancelModal(orderId){
  _cancelTargetOrderId=orderId;
  const input=document.getElementById('cancel-reason-input');
  const err=document.getElementById('cancel-reason-error');
  if(input)input.value='';
  if(err)err.style.display='none';
  const confirmBtn=document.getElementById('order-cancel-confirm-btn');
  if(confirmBtn){
    confirmBtn.onclick=()=>{
      const reason=(input?input.value:'').trim();
      if(!reason){if(err)err.style.display='block';return;}
      if(err)err.style.display='none';
      closeModal('order-cancel-modal');
      if(cancelOrder(_cancelTargetOrderId,reason)){
        toast('발주서가 취소되었습니다. 재고가 복구되었습니다.','success');
        renderOrders();
      }
    };
  }
  openModal('order-cancel-modal');
}

// ══════════════════════════════════════════════════
// [기능1] 발주확정 최종 확인 팝업
// ══════════════════════════════════════════════════
function openOrderConfirmModal(){
  // 역할별 버튼 텍스트 분기
  const _lbl=isAdmin()?'출고확정':'발주 넣기';
  const _sl=document.getElementById('order-submit-label');if(_sl)_sl.textContent=_lbl;
  const _tl=document.getElementById('order-confirm-modal-title');if(_tl)_tl.textContent=_lbl+' 최종 확인';
  const _ol=document.getElementById('order-confirm-ok-label');if(_ol)_ol.textContent=_lbl;
  // 1) 기존 submitOrder 검증 로직만 먼저 실행 (저장은 하지 않음)
  const deliveryTo=document.getElementById('o-delivery-to').value.trim();
  const address=document.getElementById('o-address').value.trim();
  syncDateParts('o-date'); syncDateParts('o-ship-date');
  const orderDate=document.getElementById('o-date').value;
  const shipDate=document.getElementById('o-ship-date').value;
  if(!deliveryTo){toast('납품처를 입력해주세요.','error');return;}
  if(!orderDate||!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)){toast('발주일을 입력해주세요.','error');return;}
  if(!shipDate||!/^\d{4}-\d{2}-\d{2}$/.test(shipDate)){toast('출고일을 입력해주세요.','error');return;}
  const whVal=document.getElementById('o-warehouse')?.value||'';
  if(!whVal){toast('출고 창고를 선택해주세요. (시흥 또는 평택)','error');return;}
  const ucCheck=document.getElementById('upper-common-color');
  if(!ucCheck||!ucCheck.value){toast('상부자재 색상을 선택해주세요.','error');return;}
  const scCheck=document.getElementById('shared-color-sel');
  if(!scCheck||!scCheck.value){toast('선반/코너선반/서랍/옵션 색상을 선택해주세요.','error');return;}
  const dbItemsForVal=DB.get('items',[]);
  const colorMissingItems=[];
  document.querySelectorAll('.drawer-qty').forEach(inp=>{
    const qty=parseInt(inp.value)||0;if(qty<1)return;
    const itemId=parseInt(inp.dataset.itemId);
    const dbItem=dbItemsForVal.find(i=>i.id===itemId);
    if(!dbItem||!dbItem.hasColor)return;
    const colorSel=document.querySelector(`.item-color-select[data-item-id="${itemId}"]`);
    if(!colorSel||!colorSel.value)colorMissingItems.push(dbItem.name);
  });
  if(colorMissingItems.length>0){toast(colorMissingItems.map(n=>n+' 색상을 선택해주세요').join(' / '),'error');return;}

  // 2) 수량 집계
  let upperTotal=0;
  document.querySelectorAll('.upper-qty').forEach(inp=>{upperTotal+=parseInt(inp.value)||0;});
  const rod2400Count=rodEntries.length>0?calcRod2400(rodEntries):0;
  let shelfTotal=0;
  shelfRowEntries.forEach(e=>shelfTotal+=e.qty);
  cornerEntries.forEach(e=>shelfTotal+=e.qty);
  let drawerTotal=0;
  const shortageList=[];
  document.querySelectorAll('.drawer-qty').forEach(inp=>{
    const qty=parseInt(inp.value)||0;
    if(qty<1)return;
    drawerTotal+=qty;
    const stock=parseInt(inp.dataset.stock)||0;
    const isDrawer=inp.dataset.isDrawer==='true';
    if(isDrawer){
      const s=calcShortage(qty,stock);
      if(s>0)shortageList.push({name:inp.dataset.itemName||'?',shortage:s});
    }
  });
  const supplyEl=document.getElementById('order-supply-amount');
  const vatEl2=document.getElementById('order-vat-amount');
  const totalAmtEl=document.getElementById('order-total-amount');
  const supplyAmt=supplyEl?supplyEl.textContent:'0원';
  const vatAmt=vatEl2?vatEl2.textContent:'0원';
  const totalAmt=totalAmtEl?totalAmtEl.textContent:'0원';

  // 3) 팝업 본문 렌더
  const shortageHtml=shortageList.length>0
    ?`<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:var(--r-sm);padding:10px 14px;margin-top:8px">
        <p style="font-size:12px;font-weight:700;color:#dc2626;margin-bottom:6px"><i class="fas fa-triangle-exclamation"></i> 재고 부족 품목</p>
        ${shortageList.map(s=>`<p style="font-size:13px;font-weight:700;color:#991b1b;margin-bottom:2px">• ${s.name} — 부족 ${s.shortage}개</p>`).join('')}
      </div>`
    :`<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:var(--r-sm);padding:8px 14px;margin-top:8px"><p style="font-size:12px;font-weight:700;color:#15803d"><i class="fas fa-circle-check"></i> 부족 품목 없음</p></div>`;

  document.getElementById('order-confirm-body').innerHTML=`
    <div style="background:#f8fafc;border-radius:var(--r-sm);padding:12px 16px;margin-bottom:12px">
      <div style="display:grid;grid-template-columns:90px 1fr;gap:6px 8px;font-size:13px">
        <span style="color:var(--text-3);font-weight:600">납품처</span><span style="font-weight:700">${deliveryTo}</span>
        <span style="color:var(--text-3);font-weight:600">발주일</span><span>${orderDate}</span>
        <span style="color:var(--text-3);font-weight:600">출고일</span><span>${shipDate==='0000-00-00'?'미정':shipDate}</span>
        <span style="color:var(--text-3);font-weight:600">출고 창고</span><span style="font-weight:700">${document.getElementById('o-warehouse')?.value||'시흥'}</span>
        ${address?`<span style="color:var(--text-3);font-weight:600">시공주소</span><span>${address}</span>`:''}
      </div>
    </div>
    <div style="background:#eff6ff;border-radius:var(--r-sm);padding:12px 16px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:12px;font-weight:600;color:#1e40af">총 공급가액</span>
        <span style="font-size:14px;font-weight:700;color:#334155">${supplyAmt}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:6px">
        <span style="font-size:12px;font-weight:600;color:#1e40af">부가세 (10%)</span>
        <span style="font-size:14px;font-weight:700;color:#475569">${vatAmt}</span>
      </div>
      <div style="display:flex;justify-content:space-between;border-top:1.5px solid #bfdbfe;padding-top:6px">
        <span style="font-size:13px;font-weight:700;color:#1e40af">합계금액</span>
        <span style="font-size:22px;font-weight:900;color:#0f172a">${totalAmt}</span>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
      <div style="background:#fff;border:1px solid var(--border);border-radius:var(--r-sm);padding:8px 12px;text-align:center">
        <p style="font-size:10px;color:var(--text-3);font-weight:700">상부자재</p><p style="font-size:18px;font-weight:800">${upperTotal}개</p>
      </div>
      <div style="background:#fff;border:1px solid var(--border);border-radius:var(--r-sm);padding:8px 12px;text-align:center">
        <p style="font-size:10px;color:var(--text-3);font-weight:700">옷봉 2400</p><p style="font-size:18px;font-weight:800">${rod2400Count}개</p>
      </div>
      <div style="background:#fff;border:1px solid var(--border);border-radius:var(--r-sm);padding:8px 12px;text-align:center">
        <p style="font-size:10px;color:var(--text-3);font-weight:700">선반/코너선반</p><p style="font-size:18px;font-weight:800">${shelfTotal}개</p>
      </div>
      <div style="background:#fff;border:1px solid var(--border);border-radius:var(--r-sm);padding:8px 12px;text-align:center">
        <p style="font-size:10px;color:var(--text-3);font-weight:700">서랍/옵션</p><p style="font-size:18px;font-weight:800">${drawerTotal}개</p>
      </div>
    </div>
    ${shortageHtml}
    <div style="margin-top:10px;padding:8px 12px;background:${isAdmin()?'#fffbeb':'#f0fdf4'};border:1px solid ${isAdmin()?'#fde68a':'#bbf7d0'};border-radius:var(--r-sm);font-size:12px;color:${isAdmin()?'#92400e':'#15803d'}">
      <i class="fas fa-info-circle"></i> 발주 넣기 시 서랍장 현재고가 즉시 차감됩니다.
    </div>`;

  const okBtn=document.getElementById('order-confirm-ok-btn');
  if(okBtn){okBtn.onclick=()=>{closeModal('order-confirm-modal');submitOrder(isAdmin()?'발주확정':'발주대기');};}
  openModal('order-confirm-modal');
}

// ══════════════════════════════════════════════════
// [기능2] 발주서 잠금 기능
// ══════════════════════════════════════════════════
function toggleOrderLock(orderId){
  if(!isAdmin()){toast('관리자만 확정/해제할 수 있습니다.','error');return;}
  const orders=DB.get('orders',[]);
  const idx=orders.findIndex(o=>o.id===orderId);
  if(idx===-1){toast('발주서를 찾을 수 없습니다.','error');return;}
  const order=orders[idx];
  const now=new Date().toISOString();

  // 재고는 발주 넣는 시점에 이미 차감됨 — 확정/해제 시 재고 변동 없음
  if(!order.isLocked){
    // 발주 확정: status → 발주확정, 자물쇠 잠금
    orders[idx].isLocked=true;
    orders[idx].status='발주확정';
    orders[idx].updatedAt=now;
    addStatusHistory(idx, orders, '발주확정', '관리자 확정');
    DB.set('orders',orders);
    toast('발주가 확정되었습니다.','success');
    // ─── 출고확정 버튼 누를 때 이카운트 판매전표 자동 생성 ───
    if(window._FN){
      const confirmedOrder=DB.get('orders',[]).find(o=>o.id===orderId);
      if(confirmedOrder) _createEcountSaleFromOrder(confirmedOrder).catch(e=>console.error('[이카운트 출고연동]',e));
    }
  } else {
    // 확정 해제: status → 발주대기, 자물쇠 열림
    orders[idx].isLocked=false;
    orders[idx].status='발주대기';
    orders[idx].updatedAt=now;
    addStatusHistory(idx, orders, '발주대기', '확정 해제');
    DB.set('orders',orders);
    toast('확정이 해제되었습니다.','warning');
  }
  openOrderDetail(orderId);
  if(currentView==='orders')renderOrders();
  else if(currentView==='dashboard')renderDashboard();
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
    if(orderFilterLocked==='locked'&&!o.isLocked)return false;
    if(orderFilterLocked==='unlocked'&&o.isLocked)return false;
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
  }).sort((a,b)=>b.id-a.id);

  let rows='';
  if(orders.length===0){
    rows='<div class="empty"><i class="fas fa-file-invoice"></i><p>등록된 발주서가 없습니다.</p>'+(isAdmin()?'':'<button class="btn btn-primary" style="margin-top:12px" id="empty-order-btn">첫 번째 발주서 등록</button>')+'</div>';
  }else{
    rows=`<div class="table-wrap"><table><thead><tr><th>납품처</th><th>시공주소</th><th>발주번호</th><th>발주일</th><th>출고일</th><th class="td-center">상태</th><th class="td-center">등록일</th>${orderListSubTab==='cancelled'?'<th>취소 사유</th>':''}${isAdmin()?'<th class="td-center">관리</th>':''}</tr></thead><tbody>
    ${orders.map(o=>{
      const dTo=o.deliveryTo||o.siteName||'-';
      const addr=o.address||o.customerName||'-';
      const statusBadge=orderStatusBadge(o.status);
      const lockBadge=o.isLocked
        ?'<span class="badge badge-locked" style="margin-left:4px"><i class="fas fa-lock"></i></span>'
        :(o.status==='발주대기'?'<span class="badge" style="margin-left:4px;background:#fefce8;color:#a16207;border:1px solid #fde047"><i class="fas fa-lock-open"></i></span>':'');
      const cancelBtn=isAdmin()&&orderListSubTab==='active'?`<button class="btn btn-ghost btn-xs order-cancel-btn" data-order-id="${o.id}" style="color:var(--danger);white-space:nowrap"><i class="fas fa-ban"></i> 발주 취소</button>`:'';
      const reorderBtn=`<button class="btn btn-outline btn-xs reorder-btn" data-order-id="${o.id}" title="이 발주서로 재발주" style="border:1.5px solid #0ea5e9;color:#0369a1;font-weight:700;white-space:nowrap"><i class="fas fa-rotate-right"></i> 재발주</button>`;
      const cancelReasonCell=orderListSubTab==='cancelled'?`<td class="td-muted" style="font-size:12px;color:#dc2626;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${o.cancelReason||''}">${o.cancelReason||'-'}</td>`:'';
      return `<tr class="order-row" data-order-id="${o.id}" style="cursor:pointer" title="클릭하여 상세 보기"><td class="td-name">${dTo}</td><td class="td-muted" style="font-size:12px">${addr}</td><td style="font-size:12px;font-weight:600;color:#0f172a">${o.orderNum||('#'+o.id)}${lockBadge}</td><td class="td-muted">${fmt(o.orderDate)}</td><td class="td-muted">${o.shipDate?fmt(o.shipDate):'-'}</td><td class="td-center">${statusBadge}</td><td class="td-center td-muted">${fmt(o.createdAt)}</td>${cancelReasonCell}<td class="td-center">${cancelBtn} ${reorderBtn}</td></tr>`;
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
        ${!isAdmin()?'<button class="btn btn-primary" id="new-order-btn"><i class="fas fa-plus"></i> 새 발주서</button>':''}
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
          ${(()=>{const activeCount=[orderFilterSite,orderFilterRegion,orderFilterDateFrom,orderFilterDateTo,orderFilterMinAmount,orderFilterMaxAmount,orderFilterMinSize,orderFilterMaxSize].filter(v=>v).length+(orderFilterShortage?1:0);return activeCount>0?`<span style="background:var(--primary-light);color:#fff;font-size:11px;font-weight:700;border-radius:99px;padding:1px 7px">${activeCount}</span>`:''})()}
        </span>
        <div style="display:flex;align-items:center;gap:8px">
          ${orderFilterOpen?`<button id="order-filter-reset-btn" style="display:flex;align-items:center;gap:5px;background:none;border:1px solid var(--border);border-radius:var(--r-sm);padding:5px 12px;font-size:13px;color:var(--text-2);cursor:pointer;transition:background .15s" onclick="event.stopPropagation()" onmouseover="this.style.background='#f1f5f9'" onmouseout="this.style.background='none'"><i class="fas fa-rotate-left"></i> 초기화</button>`:''}
          <i class="fas fa-chevron-${orderFilterOpen?'up':'down'}" style="color:var(--text-3);font-size:13px"></i>
        </div>
      </div>
      <div style="display:${orderFilterOpen?'grid':'none'};grid-template-columns:1fr 1fr;gap:12px 16px">
        <div>
          <label style="${labelStyle}">업체명</label>
          <input class="form-input" placeholder="업체명 검색" id="order-search-input" value="${orderFilterSite}" style="width:100%"/>
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
  if(!isAdmin()){const nb2=document.getElementById('new-order-btn');if(nb2)nb2.addEventListener('click',openOrderModal);}
  document.getElementById('order-search-input').addEventListener('input',e=>{orderFilterSite=e.target.value;renderOrders();});
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
    orderFilterSite='';orderFilterRegion='';orderFilterDateFrom='';orderFilterDateTo='';
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
  document.getElementById('hist-site-input').addEventListener('input',e=>{histSite=e.target.value;renderOrderHistTab();});
  document.getElementById('hist-from-input').addEventListener('input',e=>{histFrom=e.target.value;renderOrderHistTab();});
  document.getElementById('hist-to-input').addEventListener('input',e=>{histTo=e.target.value;renderOrderHistTab();});
  document.getElementById('hist-reset-btn').addEventListener('click',()=>{histSite='';histFrom='';histTo='';renderOrderHistTab();});
  let orders=getOrders().filter(o=>isAdmin()||(o.createdBy===currentUser.id)||!o.createdBy).sort((a,b)=>b.id-a.id);
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
  document.getElementById('hist-item-input').addEventListener('input',e=>{histItem=e.target.value;renderInvHistTab();});
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
            // 신형: color+qty
            if(r.color&&r.qty){
              return `<tr><td class="dn">${compatUpperName(r.name)}</td><td class="td-center"><span class="det-color-badge">${r.color}</span></td><td class="dnum">${r.qty}</td><td style="font-size:12px;color:#374151">${r.note||''}</td></tr>`;
            }
            // 구형: white/black/silver/champagne
            const colorMap={white:'화이트',black:'블랙',silver:'실버',champagne:'샴페인골드'};
            return ['white','black','silver','champagne'].filter(c=>r[c]>0).map(c=>`<tr><td class="dn">${compatUpperName(r.name)}</td><td class="td-center"><span class="det-color-badge">${colorMap[c]}</span></td><td class="dnum">${r[c]}</td><td style="font-size:12px;color:#374151">${r.note||''}</td></tr>`).join('');
          }).join('')}</tbody>
        </table>
      </div>
    </div>`;
  }

  // 옷봉
  let rodHtml='';
  if(order.rodItems&&order.rodItems.length>0){
    const rows=order.rodItems.map(e=>`<tr>
      <td class="dnum">${e.size}mm</td>
      <td class="dnum">${e.qty}개</td>
    </tr>`).join('');
    rodHtml=`<div class="det-section" style="margin-bottom:14px">
      <div class="det-section-head det-head-blue">
        <i class="fas fa-minus"></i> 옷봉
      </div>
      <div class="det-section-body">
        <table class="det-tbl">
          <thead><tr><th>절단 규격</th><th>수량</th></tr></thead>
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
        <td class="dmuted">${it.category==='서랍장'?oi.currentStockSnapshot:'-'}</td>
        <td style="text-align:center">${it.category==='서랍장'?(oi.shortageQty>0?`<span class="det-shortage-num">▼ ${oi.shortageQty}</span>`:'<span class="det-ok">✓ 충분</span>'):'<span style="color:#9ca3af;font-size:12px">-</span>'}</td>
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
      ${order.isLocked
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
    if(order.isLocked){
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
  // 잠금/잠금해제 버튼 (관리자만)
  const lockBtn=document.getElementById('lock-order-btn');
  if(lockBtn&&isAdmin()){
    lockBtn.style.display='';
    if(order.isLocked){
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

  savedItems.forEach(oi=>{
    if(!oi.requiredQty||oi.requiredQty<1)return; // 수량 0이면 스킵

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
      let sel=document.querySelector(`.item-color-select[data-item-id="${domId}"]`);
      if(!sel&&domName)sel=document.querySelector(`.item-color-select[data-item-name="${domName}"]`);
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
        const chk=document.querySelector(`.subtype-chk[data-parent-id="${domId}"][data-subtype-name="${stName.replace(/"/g,'&quot;')}"]`);
        if(chk)chk.checked=true;
      });
    }
  });
}


// ── 복원 시점 보장: drawer-body 렌더 완료 후 1회 실행 ──
function restoreDrawerItemsWhenReady(order, retry){
  retry=retry||0;
  if(retry>30)return;
  const inputs=document.querySelectorAll('.drawer-qty');
  if(inputs.length>0){
    restoreDrawerItemsToModal(order);
  } else {
    requestAnimationFrame(()=>restoreDrawerItemsWhenReady(order,retry+1));
  }
}



// ── 수정 진입 전용 재고 롤백 (서랍장 차감분만 복구) ──
function rollbackInventoryForEdit(order){
  // stockDeducted가 true일 때만 롤백 (이중 롤백 방지)
  if(!order||!order.stockDeducted)return;
  const items=DB.get('items',[]);
  let changed=false;
  const now=new Date().toISOString();
  const drawerRows=order.drawerItems||order.items||[];
  const editWh=order.warehouse||'시흥';
  drawerRows.forEach(oi=>{
    const iIdx=items.findIndex(i=>i.id===oi.itemId);
    if(iIdx===-1||items[iIdx].category!=='서랍장')return;
    if(items[iIdx].stockSiheung===undefined)items[iIdx].stockSiheung=items[iIdx].currentStock||0;
    if(items[iIdx].stockPyeongtaek===undefined)items[iIdx].stockPyeongtaek=0;
    const wh=oi.warehouse||editWh;
    const whKey=getWhKey(wh);
    const cwKey=getColorWhKey(wh);
    const oiColor=oi.color||order.sharedColor||'';
    let before, afterVal;
    if(oiColor){
      if(!items[iIdx][cwKey])items[iIdx][cwKey]={};
      before=items[iIdx][cwKey][oiColor]||0;
      afterVal=before+(oi.requiredQty||0);
      items[iIdx][cwKey][oiColor]=afterVal;
      items[iIdx][whKey]=Object.values(items[iIdx][cwKey]).reduce((s,v)=>s+(v||0),0);
    } else {
      before=items[iIdx][whKey];
      afterVal=before+(oi.requiredQty||0);
      items[iIdx][whKey]=afterVal;
    }
    items[iIdx].currentStock=(items[iIdx].stockSiheung||0)+(items[iIdx].stockPyeongtaek||0);
    changed=true;
    const logs=DB.get('logs',[]);
    logs.push({
      id:DB.nextId('logs'),itemId:oi.itemId,type:'발주수정재반영',
      qty:oi.requiredQty||0,beforeStock:before,afterStock:afterVal,warehouse:wh,color:oiColor||'',
      memo:`발주 #${order.id} 수정 진입 롤백`,orderId:order.id,
      createdBy:currentUser?currentUser.id:'',createdAt:now
    });
    DB.set('logs',logs);
  });
  if(changed)DB.set('items',items);
  // stockDeducted=false 표시 — 이중 롤백 방지
  const orders=DB.get('orders',[]);
  const idx=orders.findIndex(o=>o.id===order.id);
  if(idx!==-1&&orders[idx].stockDeducted){
    orders[idx].stockDeducted=false;
    DB.set('orders',orders);
  }
}


function openEditOrder(orderId){
  const order=getOrders().find(o=>o.id===orderId);
  if(!order){toast('발주서를 찾을 수 없습니다.','error');return;}
  if(order.isLocked){toast('발주 확정된 발주서입니다. 관리자가 확정 해제 후 수정할 수 있습니다.','error');return;}
  if(!isAdmin()&&order.createdBy&&order.createdBy!==currentUser.id){
    toast('본인 발주서만 수정할 수 있습니다.','error');return;
  }

  // ── 1단계: 재고 롤백 (입력칸과 무관하게 DB만 변경) ──
  rollbackInventoryForEdit(order);

  closeModal('order-detail-modal');

  // ── 2단계: 모달 렌더링 (항상 빈 상태로 시작) ──
  _openOrderModalRender(null);

  // ── 3단계: 기존 발주값 복원 (재고 롤백과 독립적으로 order 원본 참조) ──
  setTimeout(()=>{
    // 기본 정보 — 발주자 계정이면 납품처 고정 (수정 시에도 동일)
    const editDelivEl=document.getElementById('o-delivery-to');
    if(!isAdmin()&&currentUser&&currentUser.deliveryName){
      editDelivEl.value=currentUser.deliveryName;
    } else {
      editDelivEl.value=order.deliveryTo||order.siteName||'';
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
    // 상부자재 수량 복원
    (order.upperMaterials||[]).forEach(r=>{
      const rawName=r.name||'';if(!rawName)return;
      const qty=r.qty||(r.white||0)+(r.black||0)+(r.silver||0)+(r.champagne||0);
      // 직접 매칭 우선 (저장명 = data-mat명), 실패 시 compat 폴백
      let inp=document.querySelector(`.upper-qty[data-mat="${rawName}"]`);
      if(!inp){const cn=compatUpperName(rawName);if(cn!==rawName)inp=document.querySelector(`.upper-qty[data-mat="${cn}"]`);}
      if(inp){inp.value=qty||'';updateUpperRowAmount(inp);}
      if(r.note){
        let nEl=document.querySelector(`.upper-note[data-mat="${rawName}"]`);
        if(!nEl){const cn=compatUpperName(rawName);if(cn!==rawName)nEl=document.querySelector(`.upper-note[data-mat="${cn}"]`);}
        if(nEl)nEl.value=r.note;
      }
    });
    // 공통 색상
    if(order.sharedColor){const ss=document.getElementById('shared-color-sel');if(ss)ss.value=order.sharedColor;}
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
      order.rodItems.forEach(r=>rodEntries.push({size:r.size,qty:r.qty}));
      renderRodRows();
    }
    // 수정 모드 표시
    document.querySelector('#order-modal .modal-title').textContent='발주서 수정 #'+orderId;
    const saveBtn=document.querySelector('#order-modal .order-modal-bottom .btn-primary');
    if(saveBtn){saveBtn.textContent='수정 저장';saveBtn.onclick=()=>submitEditOrder(orderId);}
    // 상부자재 금액 재계산 (수량 복원 후)
    document.querySelectorAll('.upper-qty').forEach(inp=>{if(inp.value)updateUpperRowAmount(inp);});
    recalcOrderTotal();
    // 서랍/옵션: drawer-body 렌더 완료 확인 후 복원
    restoreDrawerItemsWhenReady(order);
  },80);
}


function submitEditOrder(orderId){
  const orders=DB.get('orders',[]);
  const idx=orders.findIndex(o=>o.id===orderId);
  if(idx===-1){toast('발주서를 찾을 수 없습니다.','error');return;}

  // 원래 발주서 정보 보존 (id·orderNum·status·등록자·등록일 유지)
  const orig=orders[idx];
  // 임시저장이었던 경우 발주대기로 올려서 저장 (_editOverride.status도 반드시 targetStatus로 설정)
  const targetStatus=(orig.status==='임시저장')?'발주대기':(orig.status||'발주대기');
  window._editOverride={
    id:orig.id,
    orderNum:orig.orderNum,
    status:targetStatus,
    createdBy:orig.createdBy||'',
    createdAt:orig.createdAt||new Date().toISOString(),
    statusHistory:orig.statusHistory||[]
  };

  // 기존 발주 삭제 (재고 롤백은 openEditOrder 진입 시 이미 완료됨)
  orders.splice(idx,1);
  DB.set('orders',orders);
  // 기존 발주 필요 목록 제거
  const prs=DB.get('purchase_requests',[]).filter(p=>p.orderId!==orderId);
  DB.set('purchase_requests',prs);
  // 모달 제목/버튼 원복
  const titleEl=document.querySelector('#order-modal .modal-title');
  if(titleEl)titleEl.textContent='새 발주서 등록';
  // saveBtn onclick 초기화 (직접 함수 참조 방지)
  _resetOrderModalBtn();
  submitOrder(targetStatus);
}


// ── 발주 복사 기능 ──
function copyOrder(orderId){
  const order=getOrders().find(o=>o.id===orderId);
  if(!order){toast('발주서를 찾을 수 없습니다.','error');return;}
  if(!isAdmin()&&order.createdBy&&order.createdBy!==currentUser.id){toast('본인 발주서만 복사할 수 있습니다.','error');return;}
  closeModal('order-detail-modal');
  // openOrderModal() 대신 직접 빈 모달 렌더 — 임시저장 자동불러오기 confirm 방지
  _openOrderModalRender(null);
  setTimeout(()=>{
    // 기본 정보 — 발주자 계정이면 납품처 고정, 관리자만 원본 복원
    const copyDelivEl=document.getElementById('o-delivery-to');
    if(!isAdmin()&&currentUser&&currentUser.deliveryName){
      copyDelivEl.value=currentUser.deliveryName;
    } else {
      copyDelivEl.value=order.deliveryTo||order.siteName||'';
    }
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
      order.rodItems.forEach(r=>rodEntries.push({size:r.size,qty:r.qty}));
      renderRodRows();
    }
    // 상부 자재 복원 — DOM 직접 세팅 (_restoreDraftToModal 방식과 동일)
    const ucCopyEl=document.getElementById('upper-common-color');
    if(ucCopyEl){
      const storedColor=order.upperCommonColor||(order.upperMaterials&&order.upperMaterials[0]&&order.upperMaterials[0].color)||'화이트';
      ucCopyEl.value=storedColor;
      if(typeof checkUpperColorCodes==='function') checkUpperColorCodes(storedColor);
    }
    (order.upperMaterials||[]).forEach(r=>{
      const rawName=r.name||'';if(!rawName)return;
      const qty=r.qty||(r.white||0)+(r.black||0)+(r.silver||0)+(r.champagne||0);
      let inp=document.querySelector(`.upper-qty[data-mat="${rawName}"]`);
      if(!inp){const cn=compatUpperName(rawName);if(cn!==rawName)inp=document.querySelector(`.upper-qty[data-mat="${cn}"]`);}
      if(inp){inp.value=qty||'';updateUpperRowAmount(inp);}
      if(r.note){
        let nEl=document.querySelector(`.upper-note[data-mat="${rawName}"]`);
        if(!nEl){const cn=compatUpperName(rawName);if(cn!==rawName)nEl=document.querySelector(`.upper-note[data-mat="${cn}"]`);}
        if(nEl)nEl.value=r.note;
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
  }).sort((a,b)=>b.id-a.id);
  if(orders.length===0){toast('복사할 발주서가 없습니다.','error');return;}
  copyOrder(orders[0].id);
}

