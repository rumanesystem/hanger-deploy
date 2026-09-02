// ── 발주 등록 모달 (입력 UI, 행 렌더링, 금액 계산, 제출) ──
// 의존: js/store/db.js, js/utils/uiUtils.js, js/utils.js, js/price.js

function recalcOrderTotal(){
  let supply=0;
  document.querySelectorAll('#upper-material-body tr[data-price-row]').forEach(tr=>{
    const inp=tr.querySelector('input[type="number"]');
    if(inp&&inp.disabled)return;
    const c=tr.querySelector('.row-supply-val');
    if(c)supply+=parseInt(c.dataset.rawSupply)||0;
  });
  const rodAmtEl=document.getElementById('rod-supply-val');
  if(rodAmtEl)supply+=parseInt(rodAmtEl.dataset.rawSupply)||0;
  document.querySelectorAll('#shelf-rows tr[data-price-row]').forEach(tr=>{
    const c=tr.querySelector('.row-supply-val');
    if(c)supply+=parseInt(c.dataset.rawSupply)||0;
  });
  document.querySelectorAll('#corner-rows tr[data-price-row]').forEach(tr=>{
    const c=tr.querySelector('.row-supply-val');
    if(c)supply+=parseInt(c.dataset.rawSupply)||0;
  });
  document.querySelectorAll('#drawer-body tr[data-price-row]').forEach(tr=>{
    const inp=tr.querySelector('.drawer-qty');
    if(inp&&inp.disabled)return; // 이카운트 코드 없어서 비활성화된 행 제외
    const c=tr.querySelector('.row-supply-val');
    if(c)supply+=parseInt(c.dataset.rawSupply)||0;
  });

  const vat=Math.round(supply*0.1);
  const grand=supply+vat;

  const supEl=document.getElementById('order-supply-amount');
  const vatEl=document.getElementById('order-vat-amount');
  const totEl=document.getElementById('order-total-amount');
  if(supEl)supEl.textContent=fmtAmt(supply);
  if(vatEl)vatEl.textContent=fmtAmt(vat);
  if(totEl){totEl.textContent=fmtAmt(grand);totEl.dataset.rawTotal=grand;}
}


// 상부자재 한 행의 금액 셀 갱신 (수량 변경 시 호출)
function updateUpperRowAmount(inp){
  const mat=inp.dataset.mat;
  const qty=Math.max(0,parseInt(inp.value)||0);
  if(inp.value!==''&&parseInt(inp.value)<0)inp.value=0;
  const f=getLineFinancial(getActivePriceForItem(mat),qty);
  const tr=inp.closest('tr');
  if(!tr)return;
  const sCell=tr.querySelector('.row-supply-val');
  if(sCell){
    sCell.innerHTML=supplyAmtHtml(f.supplyAmount);
    sCell.dataset.rawSupply=f.supplyAmount!==null?f.supplyAmount:0;
  }
  recalcOrderTotal();
}


// 서랍/옵션 한 행의 금액 셀 갱신
function updateDrawerRowAmount(inp){
  const itemId=inp.dataset.itemId;
  const qty=Math.max(0,parseInt(inp.value)||0);
  if(inp.value!==''&&parseInt(inp.value)<0)inp.value=0;
  const nameSel=inp.dataset.itemName||'';
  const dbItem=getItems().find(i=>i.id===parseInt(itemId));
  const itemName=dbItem?dbItem.name:nameSel;
  const tr=inp.closest('tr');
  if(!tr)return;

  // 이카운트 코드 없어서 비활성화된 행 → 금액 0 처리
  if(inp.disabled){
    const sCell=tr.querySelector('.row-supply-val');
    if(sCell){sCell.innerHTML=supplyAmtHtml(null);sCell.dataset.rawSupply=0;}
    recalcOrderTotal();
    return;
  }

  const adjPrice=getActivePriceForItem(itemName);

  const f=getLineFinancial(adjPrice,qty);
  const sCell=tr.querySelector('.row-supply-val');
  if(sCell){
    sCell.innerHTML=supplyAmtHtml(f.supplyAmount);
    sCell.dataset.rawSupply=f.supplyAmount!==null?f.supplyAmount:0;
  }
  recalcOrderTotal();
}


// ─ 코너선반 행 렌더링 ─
function renderCornerRows(){
  const tbody=document.getElementById('corner-rows');
  if(!tbody)return;
  if(cornerEntries.length===0){
    tbody.innerHTML='<tr><td colspan="6" style="text-align:center;color:var(--text-3);font-size:12px;padding:8px">추가된 항목 없음</td></tr>';
    recalcOrderTotal();return;
  }
  tbody.innerHTML=cornerEntries.map((e,i)=>{
    const price=getCornerShelfPrice(e.width,e.height);
    const f=getLineFinancial(price,e.qty);
    return `<tr data-price-row="1">
      <td class="td-center" style="font-size:13px;font-weight:600">${e.width}</td>
      <td class="td-center" style="font-size:13px;font-weight:600">${e.height}</td>
      <td class="td-center" style="font-size:12px;color:var(--text-2)">${unitPriceHtml(price)}</td>
      <td class="td-center" style="font-size:13px">${e.qty}개</td>
      <td class="td-center row-supply-val" data-raw-supply="${f.supplyAmount||0}">${supplyAmtHtml(f.supplyAmount)}</td>
      <td class="td-center">
        <button type="button" class="btn btn-ghost btn-xs corner-remove-btn" data-idx="${i}" style="color:var(--danger)">
          <i class="fas fa-times"></i>
        </button>
      </td>
    </tr>`;
  }).join('');
  recalcOrderTotal();
}


// ─ 코너선반 행 추가 ─
function addCornerRow(){
  const w=document.getElementById('corner-width').value.trim();
  const h=document.getElementById('corner-height').value.trim();
  const q=parseInt(document.getElementById('corner-qty').value)||0;
  const sc2=document.getElementById('shared-color-sel');
  const c=sc2?sc2.value:'';
  if(!w){toast('가로 규격을 입력해주세요.','error');return;}
  if(!/^\d+$/.test(w)||parseInt(w)<1){toast('가로 규격은 양의 정수만 입력 가능합니다.','error');return;}
  if(!h){toast('세로 규격을 입력해주세요.','error');return;}
  if(!/^\d+$/.test(h)||parseInt(h)<1){toast('세로 규격은 양의 정수만 입력 가능합니다.','error');return;}
  if(q<1){toast('수량을 1 이상 입력해주세요.','error');return;}
  cornerEntries.push({width:w,height:h,qty:q,color:c});
  document.getElementById('corner-width').value='';
  document.getElementById('corner-height').value='';
  document.getElementById('corner-qty').value='';
  renderCornerRows();
  const wEl=document.getElementById('corner-width');
  if(wEl){wEl.focus();wEl.select();}
}


// ─ 옷봉 2400 필요 개수 계산 (절단 최적화) ─
function calcRod2400(entries){
  // 각 절단 규격을 개수만큼 펼침
  const pieces=[];
  entries.forEach(e=>{
    for(let i=0;i<e.qty;i++)pieces.push(parseInt(e.size));
  });
  if(pieces.length===0)return 0;
  // 내림차순 정렬 후 bin-packing (First Fit Decreasing)
  pieces.sort((a,b)=>b-a);
  const bars=[];
  pieces.forEach(p=>{
    let placed=false;
    for(let i=0;i<bars.length;i++){
      if(bars[i]+p<=2400){bars[i]+=p;placed=true;break;}
    }
    if(!placed)bars.push(p);
  });
  return bars.length;
}


// ─ 옷봉 결과 표시 ─
function updateRodResult(){
  const res=document.getElementById('rod-result');
  if(!res)return;
  if(rodEntries.length===0){res.style.display='none';
    let el=document.getElementById('rod-supply-val');
    if(!el){el=document.createElement('span');el.id='rod-supply-val';el.dataset.rawSupply=0;}
    else{el.dataset.rawSupply=0;}
    recalcOrderTotal();return;
  }
  const totalLen=rodEntries.reduce((s,e)=>s+parseInt(e.size)*e.qty,0);
  const required=calcRod2400(rodEntries);
  const rodPrice=getActivePriceForItem('옷봉 2400')||4500;
  const f=getLineFinancial(rodPrice,required);
  res.style.display='block';
  res.innerHTML=`<i class="fas fa-calculator" style="color:var(--primary-light);margin-right:6px"></i>
    총 요청 길이: <strong>${totalLen.toLocaleString()}mm</strong>
    &nbsp;·&nbsp; <span style="font-size:14px;font-weight:800;color:var(--primary)">옷봉 2400 필요: ${required}개</span>
    <span style="font-size:11px;color:var(--text-3);margin-left:6px">(FFD 절단 최적화 기준)</span>
    &nbsp;·&nbsp; <span style="font-size:13px;font-weight:700;color:#334155">공급가액 <span id="rod-supply-val" data-raw-supply="${f.supplyAmount||0}" style="font-size:14px;font-weight:800;color:#0f172a">${fmtAmt(f.supplyAmount)}</span></span>`;
  recalcOrderTotal();
}


// ─ 옷봉 행 렌더링 ─
function renderRodRows(){
  const tbody=document.getElementById('rod-rows');
  if(!tbody)return;
  if(rodEntries.length===0){
    tbody.innerHTML='<tr><td colspan="3" style="text-align:center;color:var(--text-3);font-size:12px;padding:8px">추가된 항목 없음</td></tr>';
    updateRodResult();return;
  }
  tbody.innerHTML=rodEntries.map((e,i)=>`
    <tr>
      <td class="td-center" style="font-size:13px;font-weight:600">${e.size}mm</td>
      <td class="td-center" style="font-size:13px">${e.qty}개</td>
      <td class="td-center">
        <button type="button" class="btn btn-ghost btn-xs rod-remove-btn" data-idx="${i}" style="color:var(--danger)">
          <i class="fas fa-times"></i>
        </button>
      </td>
    </tr>`).join('');
  updateRodResult();
}


// ─ 옷봉 행 추가 ─
function addRodRow(){
  const sizeVal=document.getElementById('rod-size').value.trim();
  const qtyVal=parseInt(document.getElementById('rod-qty').value)||0;
  const s=parseInt(sizeVal);
  if(!sizeVal||isNaN(s)||s<1){toast('규격을 입력해주세요.','error');return;}
  if(s>2400){toast('규격은 2400mm 이하여야 합니다.','error');return;}
  if(qtyVal<1){toast('수량을 1 이상 입력해주세요.','error');return;}
  rodEntries.push({size:String(s),qty:qtyVal});
  document.getElementById('rod-size').value='';
  document.getElementById('rod-qty').value='';
  renderRodRows();
  const rodSizeEl=document.getElementById('rod-size');
  if(rodSizeEl){rodSizeEl.focus();rodSizeEl.select();}
}


// 스텝퍼 HTML 생성
function stepperHtml(cls, dataAttrs, val=0){
  return `<div class="qty-stepper">
    <button type="button" class="stepper-minus" ${dataAttrs}>−</button>
    <input type="number" min="0" class="${cls}" ${dataAttrs} value="${val||''}"
      inputmode="numeric" pattern="[0-9]*" autocomplete="off"/>
    <button type="button" class="stepper-plus" ${dataAttrs}>+</button>
  </div>`;
}


// 상부자재 고정 품목 테이블 렌더링
function renderUpperTable(){
  const tbody=document.getElementById('upper-material-body');
  if(!tbody)return;
  const dbItems=getItems();
  const isItemActive=name=>{
    const compat=compatUpperName(name);
    const db=dbItems.find(i=>normalizeName(i.name)===normalizeName(compat)||normalizeName(i.name)===normalizeName(name));
    return !db||db.isActive!==false;
  };
  const allItems=[...UPPER_FIXED,...UPPER_EA].filter(isItemActive);
  tbody.innerHTML=allItems.map((name,gi)=>{
    const isFixed=UPPER_FIXED.includes(name);
    const price=getActivePriceForItem(name);
    const priceHtml=unitPriceHtml(price);
    const isPostBar=name.startsWith('포스트바');
    let noteCell;
    if(isPostBar){
      // 포스트바: 길이 분할 토글 버튼만 (비고 입력칸 제거)
      noteCell='<td><button type="button" class="upper-split-btn" data-mat="'+name+'" title="길이 분할" style="padding:5px 10px;font-size:12px;border:1px solid #1e40af;background:#fff;color:#1e40af;border-radius:4px;cursor:pointer;font-weight:600">📏 길이 분할 <i class="fas fa-chevron-down" style="font-size:10px;margin-left:2px"></i></button><div class="upper-split-info" data-mat="'+name+'" style="margin-top:6px"></div></td>';
    }else if(isFixed){
      // 선반바 등 고정 품목: 비고 입력칸 유지
      noteCell='<td><input type="text" class="form-input upper-note" data-mat="'+name+'" placeholder="실제길이" style="padding:4px 6px;font-size:12px;max-width:110px"/></td>';
    }else{
      noteCell='<td></td>';
    }
    let html='<tr data-price-row="1"'+((!isFixed&&gi===UPPER_FIXED.length)?' class="cat-divider-row"':'')+'>'+
      '<td class="td-name" style="font-size:13px">'+name+' <span class="unit-badge">EA</span></td>'+
      '<td>'+priceHtml+'</td>'+
      '<td class="td-center">'+stepperHtml('upper-qty','data-mat="'+name+'"')+'</td>'+
      noteCell+
      '<td class="td-center row-supply-val" data-raw-supply="0">'+supplyAmtHtml(0)+'</td>'+
    '</tr>';
    // 포스트바: 인라인 확장 행 (펼침/접힘)
    if(isPostBar){
      html+='<tr class="upper-split-expand" data-mat="'+name+'" style="display:none"><td colspan="5" style="background:#eff6ff;padding:12px 16px;border-top:1px solid #bfdbfe"><div class="split-form" data-mat="'+name+'"></div></td></tr>';
    }
    return html;
  }).join('');
  // EA 구분행 삽입 (첫 번째 UPPER_EA 행 앞에)
  const firstEAName=UPPER_EA.find(n=>allItems.includes(n));
  if(firstEAName){
    const firstEARow=tbody.querySelector(`.upper-qty[data-mat="${firstEAName}"]`)?.closest('tr');
    if(firstEARow){
      const divRow=document.createElement('tr');
      divRow.innerHTML='<td colspan="5" style="background:#f8fafc;font-size:11px;font-weight:700;color:var(--text-3);padding:4px 8px">EA 수량형</td>';
      firstEARow.before(divRow);
    }
  }
  // 수량 변경 이벤트 연결
  tbody.querySelectorAll('.upper-qty').forEach(inp=>{
    inp.addEventListener('input',()=>updateUpperRowAmount(inp));
  });
  // 길이 분할 버튼 이벤트 (인라인 토글)
  tbody.querySelectorAll('.upper-split-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const mat=btn.dataset.mat;
      toggleLengthSplitInline(mat);
    });
  });
  // 테이블 렌더 후 현재 선택된 색상으로 코드 체크 적용
  const ucCur=document.getElementById('upper-common-color');
  if(ucCur&&ucCur.value) checkUpperColorCodes(ucCur.value);
}


// ── 상부자재 공통색 선택 시: 이카운트 코드 없는 품목 행 비활성화 ──
function checkUpperColorCodes(color){
  const tbody=document.getElementById('upper-material-body');
  if(!tbody)return;
  const allItems=DB.get('items',[]);

  tbody.querySelectorAll('tr[data-price-row]').forEach(tr=>{
    const inp=tr.querySelector('.upper-qty');
    if(!inp)return;
    const matName=inp.dataset.mat||'';

    // DB 품목 찾기 (aggressiveNormalize fallback 포함)
    const mappedName=compatUpperName(matName);
    let dbItem=allItems.find(i=>normalizeName(i.name)===normalizeName(mappedName));
    if(!dbItem){
      const agg=aggressiveNormalize(mappedName);
      dbItem=allItems.find(i=>aggressiveNormalize(i.name)===agg);
    }
    if(!dbItem){
      const agg=aggressiveNormalize(mappedName);
      dbItem=allItems.find(i=>{
        const ai=aggressiveNormalize(i.name);
        return ai.length>=2&&(agg.startsWith(ai)||ai.startsWith(agg));
      });
    }

    // 기존 경고 배지 제거
    const oldBadge=tr.querySelector('.upper-no-cd-badge');
    if(oldBadge)oldBadge.remove();

    // 색상이 없거나, DB 품목 자체가 없으면 판단 불가 → 활성화 유지
    if(!color||!dbItem){
      inp.disabled=false;
      tr.style.opacity='';
      return;
    }

    // noColor 품목(스패너 등): prodCd 하나면 OK
    if(dbItem.noColor){
      const hasCd=!!(dbItem.prodCd);
      inp.disabled=!hasCd;
      tr.style.opacity=hasCd?'':'.45';
      if(!hasCd) _insertNoCdBadge(tr,'이카운트 코드 미입력');
      return;
    }

    // 색상별 코드 확인 — N/A(해당없음)는 코드 없음과 동일 처리
    const colorKey=resolveColorKey(color);
    const cd=dbItem.colorProdCdMap&&(dbItem.colorProdCdMap[colorKey]||dbItem.colorProdCdMap[color]);
    const hasCd=!!(cd&&cd!=='N/A');
    inp.disabled=!hasCd;
    tr.style.opacity=hasCd?'':'.45';
    if(!hasCd) _insertNoCdBadge(tr,color+' 코드 없음');
  });
}

// ── 서랍/옵션 공통색 선택 시: 이카운트 코드 없는 품목 행 비활성화 ──
function checkDrawerColorCodes(color){
  const drawerBody=document.getElementById('drawer-body');
  if(!drawerBody)return;
  const allItems=DB.get('items',[]);

  drawerBody.querySelectorAll('tr[data-price-row]').forEach(tr=>{
    const inp=tr.querySelector('.drawer-qty');
    if(!inp)return;
    const itemId=parseInt(inp.dataset.itemId);
    const dbItem=allItems.find(i=>i.id===itemId);

    // 기존 경고 배지 제거
    const oldBadge=tr.querySelector('.upper-no-cd-badge');
    if(oldBadge)oldBadge.remove();

    // DB 품목 없거나 색상 미선택 → 활성화 유지
    if(!color||!dbItem){
      inp.disabled=false;
      tr.style.opacity='';
      return;
    }

    // 개별 색상 선택 품목 (colorOptions 또는 hasColor) → 공통색 체크 제외, 항상 활성
    if(dbItem.colorOptions&&dbItem.colorOptions.length>0||dbItem.hasColor){
      inp.disabled=false;
      tr.style.opacity='';
      return;
    }

    // noColor 품목 → 색 무관, 항상 활성화
    if(dbItem.noColor){inp.disabled=false;tr.style.opacity='';return;}

    // colorProdCdMap 자체가 없으면 코드 미설정 품목 → 비활성화하지 않음
    const map=dbItem.colorProdCdMap;
    if(!map||Object.keys(map).length===0){inp.disabled=false;tr.style.opacity='';return;}

    // colorProdCdMap이 있는데 해당 색상 코드가 없으면 비활성화 — N/A(해당없음)도 비활성화
    const colorKey=resolveColorKey(color);
    const cd=map[colorKey]||map[color];
    const hasCd=!!(cd&&cd!=='N/A');
    inp.disabled=!hasCd;
    tr.style.opacity=hasCd?'':'.45';
    if(!hasCd) _insertNoCdBadge(tr,color+' 코드 없음');
  });
}


function _insertNoCdBadge(tr, text){
  const nameTd=tr.querySelector('.td-name')||tr.querySelector('td');
  if(!nameTd)return;
  const badge=document.createElement('span');
  badge.className='upper-no-cd-badge';
  badge.textContent=text;
  badge.style.cssText='margin-left:6px;font-size:10px;font-weight:700;color:#b45309;background:#fef3c7;border:1px solid #fcd34d;border-radius:4px;padding:1px 5px;white-space:nowrap';
  nameTd.appendChild(badge);
}


// ─ 선반 행 렌더링 ─
function renderShelfRows(){
  const tbody=document.getElementById('shelf-rows');
  if(!tbody)return;
  if(shelfRowEntries.length===0){
    tbody.innerHTML='<tr><td colspan="5" style="text-align:center;color:var(--text-3);font-size:12px;padding:8px">추가된 항목 없음</td></tr>';
    recalcOrderTotal();return;
  }
  tbody.innerHTML=shelfRowEntries.map((e,i)=>{
    const price=getShelfPrice(e.size);
    const f=getLineFinancial(price,e.qty);
    return `<tr data-price-row="1">
      <td class="td-center" style="font-size:13px;font-weight:600">${e.size}</td>
      <td class="td-center" style="font-size:12px;color:var(--text-2)">${unitPriceHtml(price)}</td>
      <td class="td-center" style="font-size:13px">${e.qty}개</td>
      <td class="td-center row-supply-val" data-raw-supply="${f.supplyAmount||0}">${supplyAmtHtml(f.supplyAmount)}</td>
      <td class="td-center">
        <button type="button" class="btn btn-ghost btn-xs shelf-row-remove-btn" data-idx="${i}" style="color:var(--danger)">
          <i class="fas fa-times"></i>
        </button>
      </td>
    </tr>`;
  }).join('');
  recalcOrderTotal();
}


// ─ 선반 행 추가 ─
function addShelfRow(){
  const s=document.getElementById('shelf-size').value.trim();
  const q=parseInt(document.getElementById('shelf-qty').value)||0;
  const sc=document.getElementById('shared-color-sel');
  const c=sc?sc.value:'';
  if(!s){toast('규격을 입력해주세요.','error');return;}
  if(!/^\d+$/.test(s)||parseInt(s)<1){toast('규격은 양의 정수만 입력 가능합니다.','error');return;}
  if(q<1){toast('수량을 1 이상 입력해주세요.','error');return;}
  shelfRowEntries.push({size:s,qty:q,color:c});
  document.getElementById('shelf-size').value='';
  document.getElementById('shelf-qty').value='';
  renderShelfRows();
  const sizeEl=document.getElementById('shelf-size');
  if(sizeEl){sizeEl.focus();sizeEl.select();}
}


// 규격선택 변경 시 직접입력 토글 (코너선반용, 하위 호환)
function onShelfSizeChange(type){
  const sizeEl=document.getElementById('shelf-size-'+type);
  const customWrap=document.getElementById('shelf-custom-wrap-'+type);
  if(customWrap)customWrap.style.display=sizeEl.value==='비규격'?'block':'none';
}


function openOrderModal(){
  if(isAdmin()){toast('관리자 계정은 발주서를 등록할 수 없습니다.','error');return;}
  _resetOrderModalBtn(); // saveBtn onclick 항상 초기화
  const myDrafts=getOrders().filter(o=>{
    if(o.status!=='임시저장')return false;
    if(!isAdmin()&&o.createdBy&&o.createdBy!==currentUser.id)return false;
    return true;
  }).sort((a,b)=>b.id-a.id);

  if(myDrafts.length>0){
    const draft=myDrafts[0];
    const label=draft.orderNum||('#'+draft.id);
    const doLoad=confirm(`임시저장된 발주서가 있습니다 [${label}].\n불러오시겠습니까?\n\n확인 → 임시저장 불러오기\n취소 → 새로 작성`);
    _openOrderModalRender(null);
    if(doLoad){
      setTimeout(()=>{
        _restoreDraftToModal(draft);
        toast(`임시저장된 발주서를 불러왔습니다 [${label}]`,'info');
      },200);
    }
  } else {
    _openOrderModalRender(null);
  }
}



// ── 발주 모달 닫기 확인 (입력 내용 있을 때 경고) ──
function confirmCloseOrderModal(){
  closeModal('order-modal');
  _resetOrderModalBtn();
}

// 발주 모달 제목/버튼 초기화
function _resetOrderModalBtn(){
  const titleEl=document.querySelector('#order-modal .modal-title');
  if(titleEl)titleEl.textContent='새 발주서 등록';
  const saveBtn=document.querySelector('#order-modal .order-modal-bottom .btn-primary');
  if(saveBtn){
    const lbl=isAdmin()?'출고확정':'발주 넣기';
    saveBtn.innerHTML=`<i class="fas fa-check"></i> <span id="order-submit-label">${lbl}</span>`;
    saveBtn.onclick=()=>openOrderConfirmModal();
  }
}


// 모달 DOM 렌더링만 담당 (initialData가 있으면 기본값으로 사용)
function _openOrderModalRender(initialData){
  // 기본 정보 초기화
  // 납품처: 발주자 계정 → deliveryName 자동 주입(있을 때만) + 수정 가능
  //         관리자 → 자유 입력
  const autoDeliveryName=(!isAdmin()&&currentUser&&currentUser.deliveryName)?currentUser.deliveryName:'';
  const delivToEl=document.getElementById('o-delivery-to');
  delivToEl.value=autoDeliveryName;
  delivToEl.readOnly=false;
  delivToEl.style.background='';
  delivToEl.style.color='';
  delivToEl.style.cursor='';
  document.getElementById('o-address').value=initialData?initialData.address||initialData.customerName||'':'';
  setDateValue('o-date',initialData?initialData.orderDate||todayStr():todayStr());
  setDateValue('o-ship-date',initialData?initialData.shipDate||'':'');
  document.getElementById('o-note').value=initialData?initialData.note||'':'';
  document.getElementById('o-drawer-memo').value=initialData?initialData.drawerMemo||'':'';
  document.getElementById('o-etc-memo').value=initialData?initialData.etcMemo||'':'';
  // 창고 선택 초기화 (기본: 출고지 선택)
  const initWh=initialData&&initialData.warehouse||'';
  orderSelectWarehouse(initWh);

  // 상태 초기화
  upperEntries=[];
  shelfRowEntries=[];
  cornerEntries=[];
  rodEntries=[];
  renderRodRows();
  // 옷봉 입력칸·결과 초기화
  const rodSizeEl=document.getElementById('rod-size');
  const rodQtyEl=document.getElementById('rod-qty');
  const rodResultEl=document.getElementById('rod-result');
  if(rodSizeEl)rodSizeEl.value='';
  if(rodQtyEl)rodQtyEl.value='';
  if(rodResultEl)rodResultEl.style.display='none';

  // ── 구역 A: 상부 자재 고정 테이블 렌더링 ──
  renderUpperTable();
  // 공통 색상 초기화 + 색상 변경 시 코드 체크 연결
  const ucEl=document.getElementById('upper-common-color');
  if(ucEl){
    ucEl.value='';
    // 기존 리스너 교체 (중복 방지)
    const newUcEl=ucEl.cloneNode(true);
    ucEl.parentNode.replaceChild(newUcEl,ucEl);
    newUcEl.addEventListener('change',e=>checkUpperColorCodes(e.target.value));
  }

  // ── 공통 색상 select 채우기 ──
  const sharedSel=document.getElementById('shared-color-sel');
  if(sharedSel){
    sharedSel.innerHTML='<option value="">색상 선택</option>'+SHELF_COLORS.map(c=>`<option value="${c}">${c}</option>`).join('');
  }

  // ── 구역 B: 선반(행 추가형) + 코너선반(행 추가형) ──
  const shelfWrap=document.getElementById('shelf-selector-wrap');
  shelfWrap.innerHTML=`
    <!-- 선반: 행 추가형 -->
    <div style="margin-bottom:14px;padding:12px;background:#fffbeb;border:1px solid #fde68a;border-radius:var(--r)">
      <p style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:8px">
        <i class="fas fa-border-all" style="margin-right:4px"></i>선반
        <span style="font-size:11px;font-weight:400;color:var(--text-3);margin-left:6px">규격 · 수량 입력 후 추가 (색상은 공통 적용)</span>
      </p>
      <div class="table-wrap" style="margin-bottom:8px">
        <table style="font-size:13px">
          <thead><tr>
            <th class="td-center" style="width:90px">규격</th>
            <th class="td-center" style="width:70px">단가</th>
            <th class="td-center" style="width:55px">수량</th>
            <th class="td-center" style="min-width:80px">공급가액</th>
            <th class="td-center" style="width:36px"></th>
          </tr></thead>
          <tbody id="shelf-rows">
            <tr><td colspan="5" style="text-align:center;color:var(--text-3);font-size:12px;padding:8px">추가된 항목 없음</td></tr>
          </tbody>
        </table>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;row-gap:8px">
        <input type="text" id="shelf-size" class="form-input" placeholder="규격 (예: 355)"
          inputmode="numeric" pattern="[0-9]*" autocomplete="off"
          style="width:100px;padding:6px 8px;font-size:13px;text-align:center"/>
        <input type="number" id="shelf-qty" class="form-input" placeholder="수량" min="1"
          inputmode="numeric" pattern="[0-9]*" autocomplete="off"
          style="width:64px;padding:6px 8px;font-size:13px;text-align:center"/>
        <button type="button" class="btn btn-primary btn-sm" onclick="addShelfRow()">
          <i class="fas fa-plus"></i> 추가
        </button>
      </div>
    </div>

    <!-- 코너선반: 행 추가형 -->
    <div style="padding:12px;background:#fffbeb;border:1px solid #fde68a;border-radius:var(--r)">
      <p style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:8px">
        <i class="fas fa-border-all" style="margin-right:4px"></i>코너선반
        <span style="font-size:11px;font-weight:400;color:var(--text-3);margin-left:6px">가로 × 세로 · 수량 입력 후 추가 (색상은 공통 적용)</span>
      </p>
      <!-- 추가된 행 -->
      <div class="table-wrap" style="margin-bottom:8px">
        <table style="font-size:13px">
          <thead><tr>
            <th class="td-center" style="width:65px">가로(mm)</th>
            <th class="td-center" style="width:65px">세로(mm)</th>
            <th class="td-center" style="width:70px">단가</th>
            <th class="td-center" style="width:45px">수량</th>
            <th class="td-center" style="min-width:80px">공급가액</th>
            <th class="td-center" style="width:36px"></th>
          </tr></thead>
          <tbody id="corner-rows">
            <tr><td colspan="6" style="text-align:center;color:var(--text-3);font-size:12px;padding:8px">추가된 항목 없음</td></tr>
          </tbody>
        </table>
      </div>
      <!-- 입력 행 -->
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <input type="text" id="corner-width" class="form-input" placeholder="가로"
          inputmode="numeric" pattern="[0-9]*" autocomplete="off"
          style="width:72px;padding:6px 8px;font-size:13px;text-align:center"/>
        <span style="color:var(--text-3);font-weight:700">×</span>
        <input type="text" id="corner-height" class="form-input" placeholder="세로"
          inputmode="numeric" pattern="[0-9]*" autocomplete="off"
          style="width:72px;padding:6px 8px;font-size:13px;text-align:center"/>
        <input type="number" id="corner-qty" class="form-input" placeholder="수량" min="1"
          inputmode="numeric" pattern="[0-9]*" autocomplete="off"
          style="width:64px;padding:6px 8px;font-size:13px;text-align:center"/>
        <button type="button" class="btn btn-primary btn-sm" onclick="addCornerRow()">
          <i class="fas fa-plus"></i> 추가
        </button>
      </div>
    </div>`;

  // ── 구역 C: 서랍/옵션 (품목·단가·수량·색상·금액) ──
  // +손잡이 별도 항목은 표시하지 않음 (손잡이 옵션은 각 서랍장 행에서 선택)
  const DRAWER_EXCLUDE=['화장대(디바이더 600포함)'];
  const drawerItems=getItems().filter(i=>i.isActive && !(i.drawerType==='handle') && ['서랍장','옵션','서비스'].includes(i.category) && !DRAWER_EXCLUDE.includes(i.name));
  const drawerBody=document.getElementById('drawer-body');
  drawerBody.innerHTML=drawerItems.map(item=>{
    const isDrawer=item.category==='서랍장';
    const hasItemColor=!!item.hasColor;
    const customColors=item.colorOptions&&item.colorOptions.length>0?item.colorOptions:null;
    const da=`data-item-id="${item.id}" data-item-name="${item.name}" data-stock="${item.currentStock}" data-is-drawer="${isDrawer}"`;
    const price=getActivePriceForItem(item.name);
    const colorSelectStyle=`border:1px solid var(--border);border-radius:4px;padding:5px 8px;font-size:12px;width:100%;min-width:80px`;
    // colorOptions 있거나 hasColor인 품목은 개별 색상 선택 (공통색 미사용)
    const needsOwnColor=!!(customColors||hasItemColor);
    const colorCell=needsOwnColor
      ?(customColors
        ?`<select class="item-color-select" data-item-id="${item.id}" data-item-name="${item.name}" style="${colorSelectStyle}">
            <option value="">색상선택</option>
            ${customColors.map(c=>`<option value="${c}">${c}</option>`).join('')}
          </select>`
        :`<select class="item-color-select" data-item-id="${item.id}" data-item-name="${item.name}" style="${colorSelectStyle}">
            <option value="">색상선택</option>
            <option value="화이트">화이트</option>
            <option value="블랙">블랙</option>
          </select>`)
      :`<span class="td-muted" style="font-size:11px">공통</span>`;
    // 손잡이 옵션 셀 (서랍장만)
    const handleCell=isDrawer
      ?`<select class="drawer-handle-select" data-item-id="${item.id}"
          style="border:1px solid var(--border);border-radius:4px;padding:5px 8px;font-size:12px;width:100%;min-width:80px">
          <option value="basic">기본형</option>
          <option value="handle">+손잡이</option>
        </select>`
      :`<span style="font-size:11px;color:var(--text-3)">-</span>`;
    // 현재고 td (서랍장만 표시 — 창고+색상 기준)
    const curStockTd=isDrawer?(()=>{
      const initWh=(document.getElementById('o-warehouse')||{}).value||'시흥';
      const initColor=(document.getElementById('shared-color-sel')||{}).value||'';
      if(!initColor){
        // 색상 미선택 시: 창고 합계 재고 표시 (전체 색상 합)
        const whKey=getWhKey(initWh);
        const total=item[whKey]||0;
        return `<td class="td-cur-stock"><span class="cur-stock-val${total===0?' zero':''}">${total}개</span></td>`;
      }
      const s=getWarehouseStock(item,initWh,initColor);
      return `<td class="td-cur-stock">
        <span class="cur-stock-val${s===0?' zero':''}">${s}개</span>
      </td>`;
    })():`<td class="td-center" style="color:var(--text-3);font-size:12px">-</td>`;
    // 차감 후 부족 td (수량 변경 시 갱신 — id 부여)
    const shortageTd=isDrawer
      ?`<td class="td-shortage" id="oshortage-${item.id}"><span class="sh-ok">부족없음</span></td>`
      :`<td class="td-center" style="color:var(--text-3);font-size:12px">-</td>`;
    // 실제길이 입력 (선반바 등 hasNote 품목)
    const noteInput=item.hasNote
      ?`<input type="text" class="item-note-input" data-item-id="${item.id}"
          placeholder="실제길이(mm)" style="border:1px solid var(--border);border-radius:4px;
          padding:4px 6px;font-size:12px;width:100%;min-width:80px" />`
      :``;
    const nameCell=noteInput
      ?`<td><span class="td-name" style="font-size:13px">${item.name}</span>
          <div style="margin-top:4px">${noteInput}</div></td>`
      :`<td><span class="td-name" style="font-size:13px">${item.name}</span></td>`;
    const mainRow=`<tr data-price-row="1">
      ${nameCell}
      <td>${unitPriceHtml(price)}</td>
      <td class="td-center">${stepperHtml('drawer-qty',da+` id="oqty-${item.id}"`)}</td>
      <td class="td-center">${colorCell}</td>
      ${curStockTd}
      ${shortageTd}
      <td class="td-center row-supply-val" data-raw-supply="0">${supplyAmtHtml(0)}</td>
    </tr>`;
    return mainRow;
  }).join('');

  // 스텝퍼 이벤트 위임 (modal-body)
  const body=document.querySelector('#order-modal .modal-body');
  body._stepperHandler && body.removeEventListener('click',body._stepperHandler);
  body._stepperHandler=e=>{
    const btn=e.target.closest('.stepper-minus,.stepper-plus');
    if(!btn)return;
    const isMinus=btn.classList.contains('stepper-minus');
    const inp=btn.parentElement.querySelector('input');
    if(!inp)return;
    if(inp.disabled)return; // 비활성화된 행은 스텝퍼도 차단
    let v=parseInt(inp.value)||0;
    v=isMinus?Math.max(0,v-1):v+1;
    inp.value=v||'';
    inp.dispatchEvent(new Event('input'));
  };
  body.addEventListener('click',body._stepperHandler);
  // 모달 열릴 때 총합계 초기화 + 초기 색상으로 코드 체크
  recalcOrderTotal();
  const _initColor=(document.getElementById('shared-color-sel')||{}).value||'';
  if(_initColor) checkDrawerColorCodes(_initColor);

  // 서랍 수량 변경 이벤트
  // 손잡이 select 변경 시 금액 즉시 갱신
  drawerBody.querySelectorAll('.drawer-handle-select').forEach(sel=>{
    sel.addEventListener('change',()=>{
      const tr=sel.closest('tr');
      const qInp=tr?tr.querySelector('.drawer-qty'):null;
      if(qInp)updateDrawerRowAmount(qInp);
    });
  });

  drawerBody.querySelectorAll('.drawer-qty').forEach(inp=>{
    inp.addEventListener('input',()=>{
      const stock=parseInt(inp.dataset.stock);
      const isDrawer=inp.dataset.isDrawer==='true';
      const val=parseInt(inp.value)||0;
      const shortageEl=document.getElementById('oshortage-'+inp.dataset.itemId);
      if(isDrawer){
        const s=calcShortage(val,stock);
        if(shortageEl)shortageEl.innerHTML=s>0
          ?`<span class="sh-label">▼ 부족</span><span class="sh-val">${s}개</span>`
          :`<span class="sh-ok">부족없음</span>`;
      }else{if(shortageEl)shortageEl.innerHTML='';}
      updateDrawerRowAmount(inp);
    });
  });

  // shared-color-sel 변경 시 선반/코너선반 color 동기화 + 서랍장 재고 갱신 + 코드 체크
  if(sharedSel){
    sharedSel.addEventListener('change',()=>{
      const newColor=sharedSel.value;
      shelfRowEntries.forEach(e=>e.color=newColor);
      cornerEntries.forEach(e=>e.color=newColor);
      renderShelfRows();renderCornerRows();
      // 창고+색상 기준으로 서랍장 재고 갱신
      const curWh=(document.getElementById('o-warehouse')||{}).value||'시흥';
      _refreshDrawerStockDisplay(curWh,newColor);
      // 이카운트 코드 없는 서랍/옵션 품목 비활성화
      checkDrawerColorCodes(newColor);
    });
  }

  openModal('order-modal');
} // end _openOrderModalRender


// draft 발주서 데이터를 열린 모달에 복원
function _restoreDraftToModal(order){
  // 기본정보 — 저장된 납품처 값 우선 복원, 없으면 본인 deliveryName fallback. 수정 가능.
  const delivToEl2=document.getElementById('o-delivery-to');
  const savedDeliv=order.deliveryTo||order.siteName||'';
  const fallback=(!isAdmin()&&currentUser&&currentUser.deliveryName)?currentUser.deliveryName:'';
  delivToEl2.value=savedDeliv||fallback;
  document.getElementById('o-address').value=order.address||order.customerName||'';
  setDateValue('o-date',order.orderDate||todayStr());
  setDateValue('o-ship-date',order.shipDate||'');
  document.getElementById('o-note').value=order.note||'';
  document.getElementById('o-drawer-memo').value=order.drawerMemo||'';
  document.getElementById('o-etc-memo').value=order.etcMemo||'';
  // 창고 선택 복원
  orderSelectWarehouse(order.warehouse||'시흥');

  // 상부 자재 복원 (고정 테이블 DOM에 수량 세팅)
  // 공통 색상 복원
  const ucRestore=document.getElementById('upper-common-color');
  if(ucRestore){
    const storedColor=order.upperCommonColor||(order.upperMaterials&&order.upperMaterials[0]&&order.upperMaterials[0].color)||'화이트';
    ucRestore.value=storedColor;
  }
  // 품목별 수량/비고 복원
  (order.upperMaterials||[]).forEach(r=>{
    const rawName=r.name||'';
    if(!rawName)return;
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
    // 길이 분할 복원 (포스트바)
    if(r.lengthSplits&&Array.isArray(r.lengthSplits)&&r.lengthSplits.length>0){
      const matKey=inp?.dataset?.mat||rawName;
      if(inp){inp.dataset.splits=JSON.stringify(r.lengthSplits);}
      if(typeof setRowLengthSplits==='function')setRowLengthSplits(matKey,r.lengthSplits);
    }
  });

  // 공통 색상 복원 + 서랍 코드 체크
  if(order.sharedColor){
    const sSel=document.getElementById('shared-color-sel');
    if(sSel){
      sSel.value=order.sharedColor;
      if(typeof checkDrawerColorCodes==='function') checkDrawerColorCodes(order.sharedColor);
    }
  }

  // 선반/코너선반 복원
  if(order.shelfItems&&order.shelfItems.length>0){
    order.shelfItems.forEach(si=>{
      if(si.name==='선반'&&si.entries){
        si.entries.forEach(e=>shelfRowEntries.push({size:e.size,qty:e.qty,color:e.color||order.sharedColor||''}));
      }
      if(si.name==='코너선반'&&si.entries){
        si.entries.forEach(e=>cornerEntries.push({width:e.width,height:e.height,qty:e.qty,color:e.color||order.sharedColor||''}));
      }
    });
    renderShelfRows();renderCornerRows();
  }

  // 옷봉 복원
  if(order.rodItems&&order.rodItems.length>0){
    order.rodItems.forEach(r=>rodEntries.push({size:r.size,qty:r.qty}));
    renderRodRows();
  }

  // 서랍/옵션 복원 (공유 함수 사용)
  restoreDrawerItemsWhenReady(order);

  // 모달 제목 표시
  const titleEl=document.querySelector('#order-modal .modal-title');
  if(titleEl)titleEl.textContent=`임시저장 불러오기 — ${order.orderNum||('#'+order.id)}`;

  // 저장 버튼: 임시저장 draft를 발주대기로 제출
  const saveBtn=document.querySelector('#order-modal .order-modal-bottom .btn-primary');
  if(saveBtn){
    saveBtn.textContent='발주 넣기';
    saveBtn.onclick=()=>{
      // 기존 draft 삭제 후 발주대기로 제출
      const allOrders=DB.get('orders',[]);
      const draftIdx=allOrders.findIndex(o=>o.id===order.id);
      if(draftIdx>-1){
        const orig=allOrders[draftIdx];
        window._editOverride={
          id:orig.id,
          orderNum:orig.orderNum,
          status:'발주대기',
          createdBy:orig.createdBy||'',
          createdAt:orig.createdAt||new Date().toISOString(),
          statusHistory:orig.statusHistory||[]
        };
        allOrders.splice(draftIdx,1);
        DB.set('orders',allOrders);
        const prs=DB.get('purchase_requests',[]).filter(p=>p.orderId!==order.id);
        DB.set('purchase_requests',prs);
      }
      const titleEl=document.querySelector('#order-modal .modal-title');
      if(titleEl)titleEl.textContent='새 발주서 등록';
      _resetOrderModalBtn();
      submitOrder('발주대기');
    };
  }
  // 복원 후 금액 재계산
  setTimeout(()=>recalcOrderTotal(),50);
}


function submitOrder(saveMode='발주확정'){
  const deliveryTo=document.getElementById('o-delivery-to').value.trim();
  const address=document.getElementById('o-address').value.trim();
  // 날짜 입력 최종 동기화 (키보드 입력 후 blur 없이 제출한 경우 대비)
  syncDateParts('o-date');
  syncDateParts('o-ship-date');
  const orderDate=document.getElementById('o-date').value;
  const shipDate=document.getElementById('o-ship-date').value;
  const note=document.getElementById('o-note').value.trim();
  const drawerMemo=document.getElementById('o-drawer-memo').value.trim();
  const etcMemo=document.getElementById('o-etc-memo').value.trim();

  // 필수 항목 일괄 검증 — 모든 오류를 수집한 뒤 첫 번째 항목으로 스크롤
  const _validationErrors=[];
  function _markRequired(el,msg){
    if(!el)return;
    el.style.border='2px solid #ef4444';
    // 클릭 또는 포커스 시 테두리 해제 (타임아웃 없음)
    const _clear=()=>{
      if(el)el.style.border='';
      el.removeEventListener('focus',_clear);
      el.removeEventListener('click',_clear);
      el.removeEventListener('change',_clear);
    };
    el.addEventListener('focus',_clear);
    el.addEventListener('click',_clear);
    el.addEventListener('change',_clear);
    _validationErrors.push({el,msg});
  }
  if(!deliveryTo) _markRequired(document.getElementById('o-delivery-to'),'납품처를 입력해주세요.');
  if(!orderDate||orderDate==='0000-00-00'||!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)){
    _markRequired(document.getElementById('o-date-y')||document.getElementById('o-date'),'발주일을 입력해주세요.');
  }
  // 임시저장이 아닐 때만 필수 검증
  if(saveMode!=='임시저장'){
    // '0000-00-00'은 미정(undecided) 상태 — 유효한 값으로 허용
    const shipUndecided=(shipDate==='0000-00-00');
    if(!shipUndecided&&(!shipDate||!/^\d{4}-\d{2}-\d{2}$/.test(shipDate))){
      _markRequired(document.getElementById('o-ship-date-y')||document.getElementById('o-ship-date'),'출고일을 입력해주세요.');
    }
    // 출고 창고 필수
    const whCheck=document.getElementById('o-warehouse')?.value||'';
    if(!whCheck){
      _markRequired(document.getElementById('o-warehouse'),'출고 창고를 선택해주세요. (시흥 또는 평택)');
    }
    // 상부자재 공통 색상 필수
    const ucCheck=document.getElementById('upper-common-color');
    if(!ucCheck||!ucCheck.value){
      _markRequired(ucCheck,'상부자재 색상을 선택해주세요.');
    }
    // 선반/서랍 공통 색상 필수
    const scCheck=document.getElementById('shared-color-sel');
    if(!scCheck||!scCheck.value){
      _markRequired(scCheck,'선반/코너선반/서랍/옵션 색상을 선택해주세요.');
    }
    // hasColor 또는 colorOptions 품목 개별 색상 필수
    const dbItemsForVal=DB.get('items',[]);
    document.querySelectorAll('.drawer-qty').forEach(inp=>{
      const qty=parseInt(inp.value)||0;
      if(qty<1)return;
      const itemId=parseInt(inp.dataset.itemId);
      const dbItem=dbItemsForVal.find(i=>i.id===itemId);
      if(!dbItem||(! dbItem.hasColor&&!(dbItem.colorOptions&&dbItem.colorOptions.length>0)))return;
      const colorSel=document.querySelector(`.item-color-select[data-item-id="${itemId}"]`);
      if(!colorSel||!colorSel.value){
        _markRequired(colorSel,dbItem.name+' 색상을 선택해주세요.');
      }
    });

    // ── 이카운트 색상 코드 없는 품목에 수량 입력 시 차단 ──
    const ucColorForVal=(document.getElementById('upper-common-color')||{}).value||'';
    const scColorForVal=(document.getElementById('shared-color-sel')||{}).value||'';

    // 상부자재 체크
    document.querySelectorAll('#upper-material-body .upper-qty').forEach(inp=>{
      const qty=parseInt(inp.value)||0;
      if(qty<1)return;
      const matName=inp.dataset.mat||'';
      const mappedName=compatUpperName(matName);
      let dbItem=dbItemsForVal.find(i=>normalizeName(i.name)===normalizeName(mappedName));
      if(!dbItem){const agg=aggressiveNormalize(mappedName);dbItem=dbItemsForVal.find(i=>aggressiveNormalize(i.name)===agg);}
      if(!dbItem){const agg=aggressiveNormalize(mappedName);dbItem=dbItemsForVal.find(i=>{const ai=aggressiveNormalize(i.name);return ai.length>=2&&(agg.startsWith(ai)||ai.startsWith(agg));});}
      if(!dbItem||dbItem.noColor)return;
      const map1=dbItem.colorProdCdMap;
      if(!map1||Object.keys(map1).length===0)return; // 코드 미입력 품목은 건너뜀
      const colorKey1=resolveColorKey(ucColorForVal);
      const hasCd1=!!(map1[colorKey1]||map1[ucColorForVal]);
      if(!hasCd1) _markRequired(inp, matName+' — '+ucColorForVal+' 색상 이카운트 코드가 없습니다. 품목 관리에서 코드를 입력해주세요.');
    });

    // 서랍/옵션 체크
    document.querySelectorAll('#drawer-body .drawer-qty').forEach(inp=>{
      const qty=parseInt(inp.value)||0;
      if(qty<1)return;
      const itemId=parseInt(inp.dataset.itemId);
      const dbItem=dbItemsForVal.find(i=>i.id===itemId);
      if(!dbItem||dbItem.hasColor||dbItem.noColor||(dbItem.colorOptions&&dbItem.colorOptions.length>0))return;
      const map2=dbItem.colorProdCdMap;
      if(!map2||Object.keys(map2).length===0)return; // 코드 미입력 품목은 건너뜀
      const usedColor=scColorForVal;
      const colorKey2=resolveColorKey(usedColor);
      const hasCd2=!!(map2[colorKey2]||map2[usedColor]);
      if(!hasCd2) _markRequired(inp, dbItem.name+' — '+usedColor+' 색상 이카운트 코드가 없습니다. 품목 관리에서 코드를 입력해주세요.');
    });
  }
  // 오류가 있으면 첫 번째 항목으로 스크롤 후 중단
  if(_validationErrors.length>0){
    const first=_validationErrors[0];
    first.el.scrollIntoView({behavior:'smooth',block:'center'});
    first.el.focus();
    toast(first.msg,'error');
    return;
  }

  // 구역 A: 상부 자재 수집 (고정 테이블 DOM에서) + 단가/금액 포함
  const ucColorEl=document.getElementById('upper-common-color');
  const upperCommonColor=ucColorEl?ucColorEl.value:'화이트';
  const upperMaterials=[];
  document.querySelectorAll('.upper-qty').forEach(inp=>{
    const mat=inp.dataset.mat, val=parseInt(inp.value)||0;
    if(val>0){
      const isFixed=UPPER_FIXED.includes(mat);
      const noteEl=isFixed?document.querySelector('.upper-note[data-mat="'+mat+'"]'):null;
      const note=noteEl?noteEl.value.trim():'';
      const colorKey={'화이트':'white','블랙':'black','실버':'silver','샴페인골드':'champagne'}[upperCommonColor]||'white';
      const unitPrice=getActivePriceForItem(mat);
      const supply=(unitPrice!==null)?unitPrice*val:null;
      const vatAmt=supply!==null?Math.round(supply*0.1):null;
      const row={name:mat,color:upperCommonColor,qty:val,note,unitPrice,amount:supply,vatAmount:vatAmt,white:0,black:0,silver:0,champagne:0};
      row[colorKey]=val;
      // 길이 분할 (포스트바만)
      try{
        const splitsRaw=inp.dataset.splits;
        if(splitsRaw){
          const splits=JSON.parse(splitsRaw);
          if(Array.isArray(splits)&&splits.length>0){
            const sum=splits.reduce((a,s)=>a+(s.qty||0),0);
            if(sum===val)row.lengthSplits=splits;
          }
        }
      }catch{}
      upperMaterials.push(row);
    }
  });

  // 구역 A-2: 옷봉 수집
  const rod2400Required=rodEntries.length>0?calcRod2400(rodEntries):0;
  const rodItems=rodEntries.length>0?[...rodEntries]:[];
  const rodTotalLen=rodEntries.reduce((s,e)=>s+parseInt(e.size)*e.qty,0);
  const rodUnitPrice=getActivePriceForItem('옷봉 2400')||4500;
  const rodAmount=rodUnitPrice*rod2400Required;
  const rodVat=Math.round(rodAmount*0.1);

  // 구역 B: 선반(행 추가형) + 코너선반(행 추가형) 수집
  const shelfItems=[];
  const scEl=document.getElementById('shared-color-sel');
  const sharedColorVal=scEl?scEl.value:'';
  const shelfWithColor=shelfRowEntries.map(e=>{
    const price=getShelfPrice(e.size);
    const supply=price*e.qty;
    const color=e.color||sharedColorVal;
    const ecountCd=getShelfEcountCode(e.size,color);
    return {...e,color,unitPrice:price,amount:supply,vatAmount:Math.round(supply*0.1),...(ecountCd?{ecountCd}:{})};
  });
  const cornerWithColor=cornerEntries.map(e=>{
    const price=getCornerShelfPrice(e.width,e.height);
    const supply=price*e.qty;
    const color=e.color||sharedColorVal;
    const ecountCd=getCornerShelfEcountCode(e.width,e.height,color);
    return {...e,color,unitPrice:price,amount:supply,vatAmount:Math.round(supply*0.1),...(ecountCd?{ecountCd}:{})};
  });
  if(shelfWithColor.length>0)shelfItems.push({name:'선반',entries:shelfWithColor});
  if(cornerWithColor.length>0)shelfItems.push({name:'코너선반',entries:cornerWithColor});

  // 구역 C: 서랍/옵션 수집
  const drawerItems=[];
  document.querySelectorAll('.drawer-qty').forEach(inp=>{
    if(inp.disabled)return; // 이카운트 코드 없어 비활성화된 행 제외
    const qty=parseInt(inp.value)||0;
    if(qty>0){
      const itemId=parseInt(inp.dataset.itemId);
      const itemColorEl=document.querySelector(`.item-color-select[data-item-id="${itemId}"]`);
      const sharedColorEl=document.getElementById('shared-color-sel');
      const color=itemColorEl?itemColorEl.value:(sharedColorEl?sharedColorEl.value:'');
      const dbItem=getItems().find(i=>i.id===itemId);
      const itemName=dbItem?dbItem.name:(inp.dataset.itemName||'');
      // 손잡이 옵션 읽기
      const tr=inp.closest('tr');
      const hSel=tr?tr.querySelector('.drawer-handle-select'):null;
      const handleOpt=hSel?hSel.value:'basic';
      const displayName=itemName;
      // 실제길이 note 수집
      const noteInp=tr?tr.querySelector('.item-note-input'):null;
      const itemNote=noteInp?noteInp.value.trim():'';
      const basePrice=getActivePriceForItem(itemName);
      const unitPrice=basePrice!==null?basePrice:null;
      const supply=(unitPrice!==null)?unitPrice*qty:null;
      const vatAmt=supply!==null?Math.round(supply*0.1):null;
      drawerItems.push({itemId,itemName:displayName,requiredQty:qty,color,handleOption:handleOpt,displayName,note:itemNote,unitPrice,amount:supply,vatAmount:vatAmt});
    }
  });

  if(!upperMaterials.length&&!rodItems.length&&!shelfItems.length&&!drawerItems.length&&!drawerMemo&&!etcMemo){
    toast('한 개 이상의 품목을 입력해주세요.','error');return;
  }

  // 총합계 (합계금액 = 공급가액 합계 + 부가세)
  const supplyEl=document.getElementById('order-supply-amount');
  const totalSupply=supplyEl?parseInt((supplyEl.textContent||'').replace(/[^0-9]/g,''))||0:0;
  const totalVatAmt=Math.round(totalSupply*0.1);
  const totalAmount=totalSupply+totalVatAmt;

  const sharedColorEl=document.getElementById('shared-color-sel');
  const sharedColor=sharedColorEl?sharedColorEl.value:'';
  const warehouse=document.getElementById('o-warehouse')?.value||'시흥';
  const{orderId,shortageCount}=saveOrder({deliveryTo,address,orderDate,shipDate,note,upperMaterials,upperCommonColor,rodItems,rod2400Required,rodTotalLen,rodAmount,rodVat,shelfItems,drawerItems,drawerMemo,etcMemo,sharedColor,totalSupply,totalVat:totalVatAmt,totalAmount,warehouse},saveMode);
  closeModal('order-modal');
  toast(saveMode==='임시저장'?'발주서가 임시저장되었습니다.':saveMode==='발주대기'?'발주가 접수되었습니다. 관리자 확정을 기다립니다.':(shortageCount>0?`출고확정 완료. 서랍장 부족 품목 ${shortageCount}개가 발주 필요 목록에 추가되었습니다.`:'발주서가 출고확정되었습니다.'),'success');
  if(currentView==='orders')renderOrders();
  else if(currentView==='dashboard')renderDashboard();
}


function renderStatusTimeline(order){
  const history=order.statusHistory||[];
  if(history.length===0)return'';
  const statusColors={
    '임시저장':'#94a3b8','발주대기':'#f59e0b','발주확정':'#3b82f6',
    '출고준비':'#8b5cf6','출고완료':'#10b981','취소':'#ef4444','보관':'#6b7280'
  };
  const items=history.map((h,i)=>{
    const color=statusColors[h.status]||'#94a3b8';
    const isLast=i===history.length-1;
    const dt=h.changedAt?fmtDt(h.changedAt):'-';
    return`<div style="display:flex;gap:12px;align-items:flex-start">
      <div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0">
        <div style="width:12px;height:12px;border-radius:50%;background:${color};margin-top:3px;flex-shrink:0;border:2px solid ${color}33"></div>
        ${!isLast?`<div style="width:2px;flex:1;background:#e5e7eb;min-height:20px;margin:2px 0"></div>`:''}
      </div>
      <div style="padding-bottom:${isLast?0:14}px;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="background:${color}18;color:${color};border:1px solid ${color}44;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:700">${h.status}</span>
          <span style="font-size:11px;color:#9ca3af">${dt}</span>
          ${h.changedByName?`<span style="font-size:11px;color:#6b7280">${h.changedByName}</span>`:''}
        </div>
        ${h.note?`<div style="font-size:12px;color:#6b7280;margin-top:3px">${h.note}</div>`:''}
      </div>
    </div>`;
  }).join('');
  return`<div style="padding:16px 20px 20px;border-top:1px solid #f1f5f9;margin-top:8px">
    <div style="font-size:13px;font-weight:700;color:#374151;margin-bottom:14px"><i class="fas fa-clock-rotate-left" style="margin-right:6px;color:#94a3b8"></i>상태 변경 이력</div>
    ${items}
  </div>`;
}

// ── 길이 분할 (포스트바) ─────────────────────────────────────
const POSTBAR_STD_LENGTH={
  '포스트바 2050':2050,
  '포스트바 2250':2250,
  '포스트바 2400':2400,
};

function getRowLengthSplits(matName){
  const inp=document.querySelector(`.upper-qty[data-mat="${matName}"]`);
  if(!inp)return [];
  try{return JSON.parse(inp.dataset.splits||'[]');}catch{return [];}
}

function setRowLengthSplits(matName,splits){
  const inp=document.querySelector(`.upper-qty[data-mat="${matName}"]`);
  if(!inp)return;
  inp.dataset.splits=JSON.stringify(splits||[]);
  // 셀 표시 갱신
  const btn=document.querySelector(`.upper-split-btn[data-mat="${matName}"]`);
  const noteEl=document.querySelector(`.upper-note[data-mat="${matName}"]`);
  const splitInfoEl=document.querySelector(`.upper-split-info[data-mat="${matName}"]`);
  const isPostBar=matName.startsWith('포스트바');
  if(splits&&splits.length>0){
    // 분할 정보 HTML
    const std=POSTBAR_STD_LENGTH[matName]||0;
    const html=splits.map(s=>{
      const isStd=Number(s.length)===std;
      return `<div style="font-size:11px;color:#0f172a;line-height:1.5">${s.length}mm × ${s.qty}개${isStd?' (정척)':''}</div>`;
    }).join('');
    // 분할 정보 표시 (분할 정보 div를 분할 버튼 앞에 삽입)
    if(splitInfoEl){
      splitInfoEl.innerHTML=html;
      splitInfoEl.style.display='block';
    }else{
      const container=isPostBar?btn?.parentNode:noteEl?.parentNode;
      if(container){
        const div=document.createElement('div');
        div.className='upper-split-info';
        div.dataset.mat=matName;
        div.style.cssText='margin-bottom:6px';
        div.innerHTML=html;
        const anchor=isPostBar?btn:noteEl;
        if(anchor)container.insertBefore(div,anchor);
      }
    }
    // 비고 입력칸 있으면 숨김 (선반바엔 없음)
    if(noteEl)noteEl.style.display='none';
  }else{
    if(splitInfoEl)splitInfoEl.style.display='none';
    if(noteEl)noteEl.style.display='';
  }
}

function toggleLengthSplitInline(matName){
  const expandRow=document.querySelector(`.upper-split-expand[data-mat="${matName}"]`);
  const btn=document.querySelector(`.upper-split-btn[data-mat="${matName}"]`);
  if(!expandRow)return;
  const isOpen=expandRow.style.display!=='none';
  if(isOpen){
    expandRow.style.display='none';
    if(btn){
      btn.style.background='#fff';
      btn.style.color='#1e40af';
      const chev=btn.querySelector('i.fa-chevron-up');
      if(chev){chev.classList.remove('fa-chevron-up');chev.classList.add('fa-chevron-down');}
    }
    return;
  }
  // 열기 — 폼 렌더
  const qtyInp=document.querySelector(`.upper-qty[data-mat="${matName}"]`);
  const totalQty=parseInt(qtyInp?.value)||0;
  if(totalQty<=0){toast('수량을 먼저 입력해주세요.','error');return;}
  const stdLen=POSTBAR_STD_LENGTH[matName]||0;
  const current=getRowLengthSplits(matName);
  let splits=current.length>0?JSON.parse(JSON.stringify(current)):[{qty:totalQty,length:stdLen}];
  const formEl=expandRow.querySelector('.split-form');
  formEl.innerHTML=`
    <div style="font-size:13px;color:#1e40af;margin-bottom:10px"><strong style="color:#0f172a">${matName}</strong> — 발주 수량 ${totalQty}개 · 정척 ${stdLen}mm</div>
    <div class="split-rows" style="display:flex;flex-direction:column;gap:6px"></div>
    <div style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap">
      <button type="button" class="btn btn-outline btn-sm split-add-btn"><i class="fas fa-plus"></i> 길이 추가</button>
      <button type="button" class="btn btn-ghost btn-sm split-reset-btn" style="color:#92400e"><i class="fas fa-rotate-left"></i> 모두 정척으로</button>
      <div class="split-summary" style="margin-left:auto;font-size:12px;font-weight:600;padding:4px 10px;border-radius:4px"></div>
    </div>`;

  function autoSave(){
    const clean=splits.filter(s=>s.qty>0&&s.length>0);
    const sum=clean.reduce((a,s)=>a+s.qty,0);
    if(clean.length===0){setRowLengthSplits(matName,[]);return;}
    if(sum!==totalQty)return;
    if(clean.length===1&&clean[0].length===stdLen){setRowLengthSplits(matName,[]);return;}
    setRowLengthSplits(matName,clean);
  }
  function renderRows(){
    const rowsEl=formEl.querySelector('.split-rows');
    rowsEl.innerHTML=splits.map((s,i)=>{
      const isStd=Number(s.length)===stdLen;
      return `<div style="display:flex;gap:8px;align-items:center" data-row-i="${i}">
        <input type="number" class="form-input split-qty" value="${s.qty}" min="1" placeholder="수량" style="width:80px;padding:6px 8px;font-size:13px"/>
        <span style="font-size:13px;color:var(--text-2)">개 ·</span>
        <input type="number" class="form-input split-len" value="${s.length}" min="1" placeholder="길이(mm)" style="width:100px;padding:6px 8px;font-size:13px"/>
        <span style="font-size:13px;color:var(--text-2)">mm${isStd?' <span style="color:#15803d;font-weight:600">(정척)</span>':''}</span>
        ${splits.length>1?'<button type="button" class="btn btn-ghost btn-xs split-del-btn" style="color:#dc2626;margin-left:auto" title="삭제"><i class="fas fa-times"></i></button>':''}
      </div>`;
    }).join('');
    rowsEl.querySelectorAll('.split-qty,.split-len').forEach(inp=>{
      inp.addEventListener('input',()=>{
        const row=inp.closest('[data-row-i]');
        const i=parseInt(row.dataset.rowI);
        if(inp.classList.contains('split-qty'))splits[i].qty=parseInt(inp.value)||0;
        else{
          splits[i].length=parseInt(inp.value)||0;
          // 정척 라벨 갱신 (input 옆 span)
          const labelSpan=row.querySelector('span:nth-of-type(2)');
          if(labelSpan){
            const isStd=Number(splits[i].length)===stdLen;
            labelSpan.innerHTML=`mm${isStd?' <span style="color:#15803d;font-weight:600">(정척)</span>':''}`;
          }
        }
        updateSummary();
        autoSave();
      });
      // 자동 정척 보충 (blur 시): 1행만 있고 길이 != 정척이면 남은 수량 자동 추가
      inp.addEventListener('blur',()=>{
        if(splits.length!==1)return;
        if(splits[0].length===stdLen)return;
        if(!splits[0].qty||!splits[0].length)return;
        const remain=totalQty-splits[0].qty;
        if(remain<=0)return;
        splits.push({qty:remain,length:stdLen});
        renderRows();
        autoSave();
      });
    });
    rowsEl.querySelectorAll('.split-del-btn').forEach(btn=>{
      btn.addEventListener('click',()=>{
        const row=btn.closest('[data-row-i]');
        const i=parseInt(row.dataset.rowI);
        splits.splice(i,1);
        renderRows();
        updateSummary();
        autoSave();
      });
    });
    updateSummary();
  }
  function updateSummary(){
    const sum=splits.reduce((a,s)=>a+(s.qty||0),0);
    const overLen=splits.some(s=>s.length>stdLen);
    const ok=sum===totalQty&&splits.every(s=>s.qty>0&&s.length>0);
    const el=formEl.querySelector('.split-summary');
    el.style.background=ok?'#dcfce7':'#fee2e2';
    el.style.color=ok?'#15803d':'#dc2626';
    el.innerHTML=`합계 ${sum}/${totalQty}개 ${ok?'✓':'✗'}${overLen?' · ⚠️ 정척 초과':''}`;
  }
  formEl.querySelector('.split-add-btn').addEventListener('click',()=>{
    const used=splits.reduce((a,s)=>a+(s.qty||0),0);
    const remain=Math.max(totalQty-used,1);
    splits.push({qty:remain,length:stdLen});
    renderRows();
    autoSave();
  });
  formEl.querySelector('.split-reset-btn').addEventListener('click',()=>{
    splits=[{qty:totalQty,length:stdLen}];
    renderRows();
    autoSave();
  });
  renderRows();

  // 펼침 표시
  expandRow.style.display='';
  if(btn){
    btn.style.background='#1e40af';
    btn.style.color='#fff';
    const chev=btn.querySelector('i.fa-chevron-down');
    if(chev){chev.classList.remove('fa-chevron-down');chev.classList.add('fa-chevron-up');}
  }
}

