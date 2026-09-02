// ── 발주 등록 모달 (입력 UI, 행 렌더링, 금액 계산, 제출) ──
// 의존: js/store/db.js, js/utils/uiUtils.js, js/utils.js, js/price.js
let rodUnitPriceOverride=null;

function recalcOrderTotal(){
  let supply=0;
  document.querySelectorAll('#upper-material-body tr[data-price-row]').forEach(tr=>{
    const inp=tr.querySelector('input[type="number"]');
    if(inp&&inp.disabled)return;
    const c=tr.querySelector('.row-supply-val');
    if(c)supply+=parseInt(c.dataset.rawSupply)||0;
  });
  // [2026-08-03] 상부자재 "추가 색상" 서브행 금액 반영 (관리자 대리발주)
  document.querySelectorAll('.upper-extra-color-row').forEach(exRow=>{
    const qtyInp=exRow.querySelector('.upper-extra-qty');
    const mat=exRow.dataset.mat;
    const q=parseInt((qtyInp||{}).value)||0;
    if(q<=0)return;
    const mainRow=_findUpperMainRow(mat);
    const mainInp=mainRow?mainRow.querySelector('.upper-qty'):null;
    const unitPrice=mainInp?getOrderLinePrice(mainRow,getActivePriceForItem(mat)):null;
    if(unitPrice!=null) supply+=unitPrice*q;
  });
  // [2026-08-03] 서랍/옵션 "추가 색상" 서브행 금액 반영 (관리자 대리발주)
  document.querySelectorAll('.drawer-extra-color-row').forEach(exRow=>{
    const qtyInp=exRow.querySelector('.drawer-extra-qty');
    const itemId=exRow.dataset.itemId;
    const itemName=exRow.dataset.itemName;
    const q=parseInt((qtyInp||{}).value)||0;
    if(q<=0)return;
    const mainRow=document.querySelector(`tr[data-drawer-main="${itemId}"]`);
    const unitPrice=mainRow?getOrderLinePrice(mainRow,getActivePriceForItem(itemName)):null;
    if(unitPrice!=null) supply+=unitPrice*q;
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

function orderUnitPriceHtml(price, opts={}){
  if(!isAdmin())return unitPriceHtml(price);
  const val=(price===null||price===undefined)?'':price;
  const kind=opts.kind||'';
  const idx=opts.idx!==undefined?` data-entry-idx="${opts.idx}"`:'';
  return `<input type="number" class="form-input order-line-price no-spinner" data-price-kind="${kind}"${idx} value="${val}" min="0" placeholder="미정" style="width:96px;text-align:right;padding:5px 7px;font-size:12px;font-weight:700"/>`;
}

function getOrderLinePrice(tr,fallbackPrice){
  const priceInp=tr?tr.querySelector('.order-line-price'):null;
  if(!priceInp)return fallbackPrice;
  const raw=String(priceInp.value||'').trim();
  if(raw==='')return null;
  const n=parseInt(raw,10);
  return isNaN(n)||n<0?null:n;
}

function updateShelfOrCornerRowAmount(priceInp){
  const tr=priceInp.closest('tr');
  if(!tr)return;
  const kind=priceInp.dataset.priceKind;
  const idx=parseInt(priceInp.dataset.entryIdx);
  const price=getOrderLinePrice(tr,null);
  const entry=kind==='corner'?cornerEntries[idx]:shelfRowEntries[idx];
  if(entry)entry.unitPriceOverride=price;
  const qty=entry?(parseInt(entry.qty)||0):0;
  const f=getLineFinancial(price,qty);
  const sCell=tr.querySelector('.row-supply-val');
  if(sCell){
    sCell.innerHTML=supplyAmtHtml(f.supplyAmount);
    sCell.dataset.rawSupply=f.supplyAmount!==null?f.supplyAmount:0;
  }
  recalcOrderTotal();
}

function bindOrderLinePriceInputs(root=document){
  if(!isAdmin())return;
  root.querySelectorAll('.order-line-price').forEach(inp=>{
    if(inp._orderPriceBound)return;
    inp._orderPriceBound=true;
    inp.addEventListener('input',()=>{
      if(inp.value!==''&&parseInt(inp.value)<0)inp.value=0;
      const kind=inp.dataset.priceKind;
      if(kind==='upper'){
        const qty=inp.closest('tr')?.querySelector('.upper-qty');
        if(qty)updateUpperRowAmount(qty);
      }else if(kind==='drawer'){
        const qty=inp.closest('tr')?.querySelector('.drawer-qty');
        if(qty)updateDrawerRowAmount(qty);
      }else if(kind==='shelf'||kind==='corner'){
        updateShelfOrCornerRowAmount(inp);
      }
    });
  });
}


// 상부자재 한 행의 금액 셀 갱신 (수량 변경 시 호출)
function updateUpperRowAmount(inp){
  const mat=inp.dataset.mat;
  const qty=Math.max(0,parseInt(inp.value)||0);
  if(inp.value!==''&&parseInt(inp.value)<0)inp.value=0;
  const tr=inp.closest('tr');
  if(!tr)return;
  const f=getLineFinancial(getOrderLinePrice(tr,getActivePriceForItem(mat)),qty);
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

  const adjPrice=getOrderLinePrice(tr,getActivePriceForItem(itemName));

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
  const _isAdmU=(typeof isAdmin==='function')&&isAdmin();
  const _colspan=_isAdmU?7:6;
  if(cornerEntries.length===0){
    tbody.innerHTML=`<tr><td colspan="${_colspan}" style="text-align:center;color:var(--text-3);font-size:12px;padding:8px">추가된 항목 없음</td></tr>`;
    recalcOrderTotal();return;
  }
  const COLOR_OPTS=['화이트','블랙','실버','샴페인골드'];
  const _sharedC=(document.getElementById('shared-color-sel')||{}).value||'';
  tbody.innerHTML=cornerEntries.map((e,i)=>{
    const price=e.unitPriceOverride!==undefined?e.unitPriceOverride:getCornerShelfPrice(e.width,e.height);
    const f=getLineFinancial(price,e.qty);
    let colorTd='';
    if(_isAdmU){
      const cc=e.color||'';
      const commonLabel=_sharedC?`공통색(${_sharedC})`:'공통색 사용';
      const opts=[`<option value="" ${cc===''?'selected':''}>${commonLabel}</option>`]
        .concat(COLOR_OPTS.map(c=>`<option value="${c}" ${cc===c?'selected':''}>${c}</option>`))
        .join('');
      colorTd=`<td class="td-center"><select class="form-input corner-color-sel" data-idx="${i}" style="width:100%;max-width:140px;padding:3px 22px 3px 6px;font-size:12px">${opts}</select></td>`;
    }
    return `<tr data-price-row="1">
      <td class="td-center" style="font-size:13px;font-weight:600">${e.width}</td>
      <td class="td-center" style="font-size:13px;font-weight:600">${e.height}</td>
      <td class="td-center" style="font-size:12px;color:var(--text-2)">${orderUnitPriceHtml(price,{kind:'corner',idx:i})}</td>
      <td class="td-center" style="font-size:13px">${e.qty}개</td>${colorTd}
      <td class="td-center row-supply-val" data-raw-supply="${f.supplyAmount||0}">${supplyAmtHtml(f.supplyAmount)}</td>
      <td class="td-center">
        <button type="button" class="btn btn-ghost btn-xs corner-remove-btn" data-idx="${i}" style="color:var(--danger)">
          <i class="fas fa-times"></i>
        </button>
      </td>
    </tr>`;
  }).join('');
  if(_isAdmU){
    tbody.querySelectorAll('.corner-color-sel').forEach(sel=>{
      sel.addEventListener('change',ev=>{
        const idx=parseInt(ev.target.dataset.idx);
        if(!isNaN(idx)&&cornerEntries[idx]) cornerEntries[idx].color=ev.target.value||'';
      });
    });
  }
  bindOrderLinePriceInputs(tbody);
  recalcOrderTotal();
}


// ─ 코너선반 행 추가 ─
function addCornerRow(){
  const w=document.getElementById('corner-width').value.trim();
  const h=document.getElementById('corner-height').value.trim();
  const q=parseInt(document.getElementById('corner-qty').value)||0;
  const _isAdmU=(typeof isAdmin==='function')&&isAdmin();
  // 관리자면 corner-color-input(대리발주 개별색), 아니면 shared-color-sel(공통색)
  const c=_isAdmU
    ? ((document.getElementById('corner-color-input')||{}).value||'')
    : ((document.getElementById('shared-color-sel')||{}).value||'');
  if(!w){toast('가로 규격을 입력해주세요.','error');return;}
  if(!/^\d+$/.test(w)||parseInt(w)<1){toast('가로 규격은 양의 정수만 입력 가능합니다.','error');return;}
  if(!h){toast('세로 규격을 입력해주세요.','error');return;}
  if(!/^\d+$/.test(h)||parseInt(h)<1){toast('세로 규격은 양의 정수만 입력 가능합니다.','error');return;}
  if(q<1){toast('수량을 1 이상 입력해주세요.','error');return;}
  cornerEntries.push({width:w,height:h,qty:q,color:c});
  document.getElementById('corner-width').value='';
  document.getElementById('corner-height').value='';
  document.getElementById('corner-qty').value='';
  const cci=document.getElementById('corner-color-input');
  if(cci) cci.value='';
  renderCornerRows();
  const wEl=document.getElementById('corner-width');
  if(wEl){wEl.focus();wEl.select();}
}


// ─ 옷봉 2400 필요 개수 계산 (절단 최적화) ─
function calcRod2400(entries, fallbackColor){
  // 서로 다른 색상의 봉은 한 자재에서 절단할 수 없으므로 색상별 FFD 합계를 사용한다.
  const groups={};
  (entries||[]).forEach(e=>{
    const size=parseInt(e&&e.size,10),qty=parseInt(e&&e.qty,10);
    if(size<1||qty<1)return;
    const color=String(e.color||fallbackColor||'').trim();
    if(!groups[color])groups[color]=[];
    for(let i=0;i<qty;i++)groups[color].push(size);
  });
  return Object.values(groups).reduce((total,pieces)=>{
    pieces.sort((a,b)=>b-a);
    const bars=[];
    pieces.forEach(p=>{
      let placed=false;
      for(let i=0;i<bars.length;i++){
        if(bars[i]+p<=2400){bars[i]+=p;placed=true;break;}
      }
      if(!placed)bars.push(p);
    });
    return total+bars.length;
  },0);
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
  const required=calcRod2400(rodEntries,(document.getElementById('upper-common-color')||{}).value||'');
  const rodPrice=rodUnitPriceOverride!==null&&rodUnitPriceOverride!==undefined?rodUnitPriceOverride:(getActivePriceForItem('옷봉 2400')||4500);
  const f=getLineFinancial(rodPrice,required);
  const priceHtml=isAdmin()?`<input type="number" id="rod-unit-price-input" class="form-input no-spinner" value="${rodPrice}" min="0" style="width:96px;text-align:right;padding:4px 7px;font-size:12px;font-weight:700"/>`:unitPriceHtml(rodPrice);
  res.style.display='block';
  res.innerHTML=`<i class="fas fa-calculator" style="color:var(--primary-light);margin-right:6px"></i>
    총 요청 길이: <strong>${totalLen.toLocaleString()}mm</strong>
    &nbsp;·&nbsp; <span style="font-size:14px;font-weight:800;color:var(--primary)">옷봉 2400 필요: ${required}개</span>
    <span style="font-size:11px;color:var(--text-3);margin-left:6px">(FFD 절단 최적화 기준)</span>
    &nbsp;·&nbsp; <span style="font-size:13px;font-weight:700;color:#334155">단가 ${priceHtml}</span>
    &nbsp;·&nbsp; <span style="font-size:13px;font-weight:700;color:#334155">공급가액 <span id="rod-supply-val" data-raw-supply="${f.supplyAmount||0}" style="font-size:14px;font-weight:800;color:#0f172a">${fmtAmt(f.supplyAmount)}</span></span>`;
  const rodPriceInp=document.getElementById('rod-unit-price-input');
  if(rodPriceInp){
    rodPriceInp.addEventListener('input',()=>{
      if(rodPriceInp.value!==''&&parseInt(rodPriceInp.value)<0)rodPriceInp.value=0;
      const raw=String(rodPriceInp.value||'').trim();
      rodUnitPriceOverride=raw===''?null:(parseInt(raw,10)||0);
      const f2=getLineFinancial(rodUnitPriceOverride,required);
      const amt=document.getElementById('rod-supply-val');
      if(amt){amt.dataset.rawSupply=f2.supplyAmount!==null?f2.supplyAmount:0;amt.textContent=fmtAmt(f2.supplyAmount);}
      recalcOrderTotal();
    });
  }
  recalcOrderTotal();
}


// ─ 옷봉 행 렌더링 ─
// [2026-08-03] 색상 컬럼 추가 (관리자 대리발주 전용). 발주자 화면엔 안 뜸.
function renderRodRows(){
  const tbody=document.getElementById('rod-rows');
  if(!tbody)return;
  const _isAdminUser=(typeof isAdmin==='function')&&isAdmin();
  const _colspan=_isAdminUser?4:3;
  if(rodEntries.length===0){
    tbody.innerHTML=`<tr><td colspan="${_colspan}" style="text-align:center;color:var(--text-3);font-size:12px;padding:8px">추가된 항목 없음</td></tr>`;
    updateRodResult();return;
  }
  const ROD_COLOR_OPTS=['화이트','블랙','실버','샴페인골드'];
  const _ucCommon=(document.getElementById('upper-common-color')||{}).value||'';
  tbody.innerHTML=rodEntries.map((e,i)=>{
    const curColor=e.color||'';
    let colorTd='';
    if(_isAdminUser){
      const commonLabel=_ucCommon?`공통색(${_ucCommon})`:'공통색 사용';
      const opts=[`<option value="" ${curColor===''?'selected':''}>${commonLabel}</option>`]
        .concat(ROD_COLOR_OPTS.map(c=>`<option value="${c}" ${curColor===c?'selected':''}>${c}</option>`))
        .join('');
      colorTd=`
      <td class="td-center">
        <select class="form-input rod-color-sel" data-idx="${i}" style="width:100%;max-width:140px;padding:3px 22px 3px 6px;font-size:12px">${opts}</select>
      </td>`;
    }
    return `
    <tr>
      <td class="td-center" style="font-size:13px;font-weight:600">${e.size}mm</td>
      <td class="td-center" style="font-size:13px">${e.qty}개</td>${colorTd}
      <td class="td-center">
        <button type="button" class="btn btn-ghost btn-xs rod-remove-btn" data-idx="${i}" style="color:var(--danger)">
          <i class="fas fa-times"></i>
        </button>
      </td>
    </tr>`;
  }).join('');
  if(_isAdminUser){
    tbody.querySelectorAll('.rod-color-sel').forEach(sel=>{
      sel.addEventListener('change', e=>{
        const idx=parseInt(e.target.dataset.idx);
        if(!isNaN(idx)&&rodEntries[idx]){
          rodEntries[idx].color=e.target.value||'';
        }
      });
    });
  }
  updateRodResult();
}


// ─ 옷봉 행 추가 ─
// [2026-08-03] 색상 입력 필드 (rod-color-input) 값도 함께 저장. 빈값이면 공통색 폴백.
function addRodRow(){
  const sizeVal=document.getElementById('rod-size').value.trim();
  const qtyVal=parseInt(document.getElementById('rod-qty').value)||0;
  const colorVal=(document.getElementById('rod-color-input')||{}).value||'';
  const s=parseInt(sizeVal);
  if(!sizeVal||isNaN(s)||s<1){toast('규격을 입력해주세요.','error');return;}
  if(s>2400){toast('규격은 2400mm 이하여야 합니다.','error');return;}
  if(qtyVal<1){toast('수량을 1 이상 입력해주세요.','error');return;}
  rodEntries.push({size:String(s),qty:qtyVal,color:colorVal});
  document.getElementById('rod-size').value='';
  document.getElementById('rod-qty').value='';
  const rodColorInp=document.getElementById('rod-color-input');
  if(rodColorInp) rodColorInp.value='';
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
  const _isAdmU=(typeof isAdmin==='function')&&isAdmin();
  const _colCount=_isAdmU?6:5;
  const dbItems=getItems();
  const isItemActive=name=>{
    const compat=compatUpperName(name);
    const db=dbItems.find(i=>normalizeName(i.name)===normalizeName(compat)||normalizeName(i.name)===normalizeName(name));
    return !db||db.isActive!==false;
  };
  // items 마스터의 category='상부자재' 신규 품목 자동 병합
  // 이중 정규화: compatUpperName(별칭) + normalizeName(공백·특수문자) 통과 후 비교
  // (UPPER_COMPAT은 저장명↔마스터명 매핑, normalizeName은 '코너앵글'='코너 앵글' 등 취급)
  const _canonUpper=n=>{
    const c=(typeof compatUpperName==='function')?compatUpperName(n):n;
    return (typeof normalizeName==='function')?normalizeName(c):c;
  };
  const _fixedCanonSet=new Set([...UPPER_FIXED,...UPPER_EA].map(_canonUpper));
  const _editSrc=window._pendingEditOrder||window._editOverride||null;
  // noColor 조회 맵 — 렌더링·저장·검증에서 공용
  // key는 canonical 이름(_canonUpper 통과)으로 저장 → 별칭·공백 변형 매칭 통일
  const _upperNoColorMap=new Map(
    dbItems.filter(i=>i.category==='상부자재').map(i=>[_canonUpper(i.name),!!i.noColor])
  );
  const _upperMasterCanonSet=new Set(
    dbItems.filter(i=>i.category==='상부자재').map(i=>_canonUpper(i.name))
  );
  if(_editSrc&&Array.isArray(_editSrc.upperMaterials)){
    _editSrc.upperMaterials.forEach(r=>{
      const canon=r&&r.name?_canonUpper(r.name):'';
      if(r&&r.color===''&&canon&&!_upperMasterCanonSet.has(canon)){
        _upperNoColorMap.set(canon,true);
      }
    });
  }
  const _isUpperNoColor=n=>_upperNoColorMap.get(_canonUpper(n))===true;
  window._isUpperNoColor=_isUpperNoColor; // submitOrder·미리보기에서 참조
  window._canonUpper=_canonUpper; // _isUpperNoColor에서 참조 시 필요
  const _seenUpperItems=new Set();
  const upperFromItems=dbItems
    .filter(i=>i.category==='상부자재'&&i.isActive!==false)
    .map(i=>i.name)
    .filter(name=>{
      const c=_canonUpper(name);
      if(_fixedCanonSet.has(c)||_seenUpperItems.has(c))return false;
      _seenUpperItems.add(c);
      return true;
    });
  // 편집 모드: 원본 발주서에 있던 이름이 items에서 이름변경/비활성됐어도 렌더 (라인 사라짐 방지)
  // openEditOrder는 _editOverride 세팅 전에 renderUpperTable 호출 → _pendingEditOrder를 우선 참조
  const _activeAll=[...UPPER_FIXED,...UPPER_EA,...upperFromItems].filter(isItemActive);
  // canonical 비교 — 별칭(예: '선반바(ABS) 400' ↔ '선반바 400') 중복 렌더 방지
  const _activeCanonSet=new Set(_activeAll.map(_canonUpper));
  // canonical 기준 중복 제거 — 같은 name의 upperMaterials 여러 개(색상별)가 같은 mat tr을 반복 렌더하는 사고 방지
  const _editingNames=[];
  if(_editSrc&&Array.isArray(_editSrc.upperMaterials)){
    const _seenEdit=new Set();
    _editSrc.upperMaterials.forEach(r=>{
      const n=(typeof compatUpperName==='function')?compatUpperName(r.name||''):(r.name||'');
      if(!n)return;
      const c=_canonUpper(n);
      if(_activeCanonSet.has(c))return;
      if(_seenEdit.has(c))return;
      _seenEdit.add(c);
      _editingNames.push(n);
    });
  }
  const allItems=[..._activeAll,..._editingNames];
  const COLOR_OPTS=['화이트','블랙','실버','샴페인골드'];
  const _ucCommon=(document.getElementById('upper-common-color')||{}).value||'';
  tbody.innerHTML=allItems.map((name,gi)=>{
    const isFixed=UPPER_FIXED.includes(name);
    const price=getActivePriceForItem(name);
    const priceHtml=orderUnitPriceHtml(price,{kind:'upper'});
    // 길이 분할 UI는 표준 길이가 정의된 포스트바에만 노출 (신규 포스트바 변형은 일반 EA 방식)
    const isPostBar=name.startsWith('포스트바')&&(typeof POSTBAR_STD_LENGTH!=='undefined')&&(POSTBAR_STD_LENGTH[name]>0);
    // XSS 방어: name은 items 마스터(관리자 입력)에서 올 수 있어 innerHTML/속성 삽입 전 escape 필수
    const nameE=(typeof _escHtml==='function')?_escHtml(name):name;
    let noteCell;
    if(isPostBar){
      // 포스트바: 길이 분할 토글 버튼만 (비고 입력칸 제거)
      noteCell='<td><button type="button" class="upper-split-btn" data-mat="'+nameE+'" title="길이 분할" style="padding:5px 10px;font-size:12px;border:1px solid #1e40af;background:#fff;color:#1e40af;border-radius:4px;cursor:pointer;font-weight:600">📏 길이 분할 <i class="fas fa-chevron-down" style="font-size:10px;margin-left:2px"></i></button><div class="upper-split-info" data-mat="'+nameE+'" style="margin-top:6px"></div></td>';
    }else if(isFixed){
      // 선반바 등 고정 품목: 비고 입력칸 유지
      noteCell='<td><input type="text" class="form-input upper-note" data-mat="'+nameE+'" placeholder="실제길이" style="padding:4px 6px;font-size:12px;max-width:110px"/></td>';
    }else{
      noteCell='<td></td>';
    }
    // 관리자일 때 "+ 색 추가" 버튼 td (개별 색상 서브행 확장) — noColor 품목은 색상 무관하므로 빈 셀
    let colorTd='';
    if(_isAdmU){
      colorTd=_isUpperNoColor(name)
        ?'<td class="td-center" style="color:var(--text-3);font-size:11px">-</td>'
        :'<td class="td-center"><button type="button" class="btn upper-add-color-btn" data-mat="'+nameE+'" style="padding:3px 8px;font-size:11px;border:1px solid #3b82f6;background:#eff6ff;color:#1d4ed8;border-radius:4px;font-weight:600;white-space:nowrap"><i class="fas fa-plus"></i> 색 추가</button></td>';
    }
    let html='<tr data-price-row="1" data-upper-main="'+nameE+'"'+((!isFixed&&gi===UPPER_FIXED.length)?' class="cat-divider-row"':'')+'>'+
      '<td class="td-name" style="font-size:13px">'+nameE+' <span class="unit-badge">EA</span></td>'+
      '<td>'+priceHtml+'</td>'+
      '<td class="td-center">'+stepperHtml('upper-qty','data-mat="'+nameE+'"')+'</td>'+
      colorTd+
      noteCell+
      '<td class="td-center row-supply-val" data-raw-supply="0">'+supplyAmtHtml(0)+'</td>'+
    '</tr>';
    // 포스트바: 인라인 확장 행 (펼침/접힘)
    if(isPostBar){
      html+='<tr class="upper-split-expand" data-mat="'+nameE+'" style="display:none"><td colspan="'+_colCount+'" style="background:#eff6ff;padding:12px 16px;border-top:1px solid #bfdbfe"><div class="split-form" data-mat="'+nameE+'"></div></td></tr>';
    }
    return html;
  }).join('');
  // [2026-08-03] "+ 색 추가" 버튼 리스너
  if(_isAdmU){
    tbody.querySelectorAll('.upper-add-color-btn').forEach(btn=>{
      btn.addEventListener('click',()=>{
        _addUpperExtraColorRow(btn.dataset.mat);
      });
    });
  }
  // EA 구분행 삽입 (첫 번째 UPPER_EA 행 앞에)
  const firstEAName=UPPER_EA.find(n=>allItems.includes(n));
  if(firstEAName){
    const firstEAEsc=(typeof CSS!=='undefined'&&CSS.escape)?CSS.escape(firstEAName):firstEAName;
    const firstEARow=tbody.querySelector(`.upper-qty[data-mat="${firstEAEsc}"]`)?.closest('tr');
    if(firstEARow){
      const divRow=document.createElement('tr');
      divRow.innerHTML='<td colspan="'+_colCount+'" style="background:#f8fafc;font-size:11px;font-weight:700;color:var(--text-3);padding:4px 8px">EA 수량형</td>';
      firstEARow.before(divRow);
    }
  }
  // 수량 변경 이벤트 연결
  tbody.querySelectorAll('.upper-qty').forEach(inp=>{
    inp.addEventListener('input',()=>updateUpperRowAmount(inp));
  });
  bindOrderLinePriceInputs(tbody);
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


// [2026-08-03] 상부자재 다른 색 추가 서브행 (관리자 대리발주 전용)
// main 행 아래 <tr class="upper-extra-color-row" data-mat="X"> 로 삽입.
// 저장 시 각 서브행 = 별개 upperMaterials 엔트리로.
function _findUpperMainRow(matName){
  return Array.from(document.querySelectorAll('tr[data-upper-main]'))
    .find(tr=>tr.dataset.upperMain===String(matName))||null;
}

function _findUpperControl(matName, selector){
  const row=_findUpperMainRow(matName);
  return row?row.querySelector(selector):null;
}

function _upperExtraRows(matName){
  return Array.from(document.querySelectorAll('.upper-extra-color-row'))
    .filter(tr=>tr.dataset.mat===String(matName));
}

function _addUpperExtraColorRow(matName, presetColor, presetQty){
  const tbody=document.getElementById('upper-material-body');
  if(!tbody) return;
  const mainRow=_findUpperMainRow(matName);
  if(!mainRow) return;
  const COLOR_OPTS=['화이트','블랙','실버','샴페인골드'];
  const ucCommon=(document.getElementById('upper-common-color')||{}).value||'';
  const usedColors=new Set(_upperExtraRows(matName)
    .map(tr=>(tr.querySelector('.upper-extra-color-sel')||{}).value).filter(Boolean));
  let availOpts=COLOR_OPTS.filter(c=>c!==ucCommon&&(!usedColors.has(c)||c===presetColor));
  if(presetColor&&!availOpts.includes(presetColor))availOpts=[presetColor,...availOpts];
  const initColor=presetColor||availOpts[0]||'블랙';
  const initQty=presetQty!=null?presetQty:1;
  const _colCount=mainRow.children.length;
  const opts=availOpts.map(c=>`<option value="${c}" ${c===initColor?'selected':''}>${c}</option>`).join('');
  const extra=document.createElement('tr');
  extra.className='upper-extra-color-row';
  extra.dataset.mat=matName;
  // XSS 방어: matName은 items 마스터에서 올 수 있어 innerHTML/속성 삽입 전 escape
  const matNameE=(typeof _escHtml==='function')?_escHtml(matName):matName;
  extra.innerHTML=`
    <td colspan="2" style="text-align:right;color:#3730a3;background:#f9fafb;padding-right:8px;font-size:12px">└ 추가 색상:</td>
    <td class="td-center" style="background:#f9fafb">${stepperHtml('upper-extra-qty no-spinner','data-mat="'+matNameE+'"',initQty)}</td>
    <td class="td-center" style="background:#f9fafb"><select class="form-input upper-extra-color-sel" data-mat="${matNameE}" style="width:100%;max-width:130px;padding:3px 22px 3px 6px;font-size:12px">${opts}</select></td>
    <td colspan="${Math.max(1,_colCount-4)}" style="background:#f9fafb"><button type="button" class="btn upper-extra-del-btn" style="padding:3px 8px;font-size:11px;border:1px solid #fca5a5;background:#fee2e2;color:#dc2626;border-radius:4px;font-weight:600;cursor:pointer">× 삭제</button></td>`;
  // main row 및 이미 있는 extra 행들 아래에 삽입
  let anchor=mainRow;
  let sibling=anchor.nextElementSibling;
  while(sibling && sibling.classList && (sibling.classList.contains('upper-extra-color-row')||sibling.classList.contains('upper-split-expand')) && sibling.dataset.mat===matName){
    anchor=sibling;
    sibling=anchor.nextElementSibling;
  }
  anchor.parentNode.insertBefore(extra, anchor.nextSibling);
  if(!(typeof isAdmin==='function'&&isAdmin())){
    extra.style.display='none';
    extra.querySelectorAll('input,select,button').forEach(el=>{el.disabled=true;});
  }
  extra.querySelector('.upper-extra-del-btn').addEventListener('click',()=>{
    extra.remove();
    recalcOrderTotal();
  });
  extra.querySelector('.upper-extra-qty').addEventListener('input',()=>recalcOrderTotal());
  extra.querySelector('.upper-extra-color-sel').addEventListener('change',()=>recalcOrderTotal());
  if(typeof window._applyExtraRowLockForOrderer==='function') window._applyExtraRowLockForOrderer();
  recalcOrderTotal();
}


// [2026-08-03] 서랍/옵션 추가 색상 서브행 (관리자 대리발주 전용)
function _addDrawerExtraColorRow(itemId, itemName, presetColor, presetQty){
  const drawerBody=document.getElementById('drawer-body');
  if(!drawerBody) return;
  const mainRow=drawerBody.querySelector(`tr[data-drawer-main="${itemId}"]`);
  if(!mainRow) return;
  const dbItem=(typeof getItems==='function'?getItems():[]).find(i=>String(i.id)===String(itemId));
  const COLOR_OPTS=(dbItem&&Array.isArray(dbItem.colorOptions)&&dbItem.colorOptions.length)
    ? dbItem.colorOptions.slice()
    : ['화이트','블랙','실버','샴페인골드'];
  const shC=(document.getElementById('shared-color-sel')||{}).value||'';
  const ownColor=(mainRow.querySelector('.item-color-select')||{}).value||'';
  const mainColor=ownColor||shC;
  const usedColors=new Set(Array.from(drawerBody.querySelectorAll('.drawer-extra-color-row'))
    .filter(tr=>tr.dataset.itemId===String(itemId))
    .map(tr=>(tr.querySelector('.drawer-extra-color-sel')||{}).value).filter(Boolean));
  let availOpts=COLOR_OPTS.filter(c=>c!==mainColor&&(!usedColors.has(c)||c===presetColor));
  if(presetColor&&!availOpts.includes(presetColor))availOpts=[presetColor,...availOpts];
  const initColor=presetColor||availOpts[0]||'블랙';
  const initQty=presetQty!=null?presetQty:1;
  const _colCount=mainRow.children.length;
  const opts=availOpts.map(c=>`<option value="${c}" ${c===initColor?'selected':''}>${c}</option>`).join('');
  const extra=document.createElement('tr');
  extra.className='drawer-extra-color-row';
  extra.dataset.itemId=itemId;
  extra.dataset.itemName=itemName;
  extra.innerHTML=`
    <td colspan="2" style="text-align:right;color:#3730a3;background:#f9fafb;padding-right:8px;font-size:12px">└ 추가 색상:</td>
    <td class="td-center" style="background:#f9fafb">${stepperHtml('drawer-extra-qty no-spinner','data-item-id="'+itemId+'"',initQty)}</td>
    <td class="td-center" style="background:#f9fafb"><select class="form-input drawer-extra-color-sel" data-item-id="${itemId}" style="width:100%;max-width:130px;padding:3px 22px 3px 6px;font-size:12px">${opts}</select></td>
    <td colspan="${Math.max(1,_colCount-4)}" style="background:#f9fafb"><button type="button" class="btn drawer-extra-del-btn" style="padding:3px 8px;font-size:11px;border:1px solid #fca5a5;background:#fee2e2;color:#dc2626;border-radius:4px;font-weight:600;cursor:pointer">× 삭제</button></td>`;
  // 이미 있는 extra 아래에 삽입
  let anchor=mainRow;
  let sibling=anchor.nextElementSibling;
  while(sibling && sibling.classList && sibling.classList.contains('drawer-extra-color-row') && sibling.dataset.itemId===String(itemId)){
    anchor=sibling;
    sibling=anchor.nextElementSibling;
  }
  anchor.parentNode.insertBefore(extra, anchor.nextSibling);
  if(!(typeof isAdmin==='function'&&isAdmin())){
    extra.style.display='none';
    extra.querySelectorAll('input,select,button').forEach(el=>{el.disabled=true;});
  }
  extra.querySelector('.drawer-extra-del-btn').addEventListener('click',()=>{
    extra.remove();
    recalcOrderTotal();
  });
  extra.querySelector('.drawer-extra-qty').addEventListener('input',()=>recalcOrderTotal());
  extra.querySelector('.drawer-extra-color-sel').addEventListener('change',()=>recalcOrderTotal());
  if(typeof window._applyExtraRowLockForOrderer==='function') window._applyExtraRowLockForOrderer();
  recalcOrderTotal();
}


// ── [2026-06-29] 이카운트 검증 제거 — 모든 행 항상 활성 유지 ──
function checkUpperColorCodes(color){
  const tbody=document.getElementById('upper-material-body');
  if(!tbody)return;
  tbody.querySelectorAll('tr[data-price-row]').forEach(tr=>{
    const inp=tr.querySelector('.upper-qty');
    if(inp) inp.disabled=false;
    tr.style.opacity='';
    const oldBadge=tr.querySelector('.upper-no-cd-badge');
    if(oldBadge) oldBadge.remove();
  });
}

// ── [2026-06-29] 이카운트 검증 제거 — 모든 행 항상 활성 유지 ──
function checkDrawerColorCodes(color){
  const drawerBody=document.getElementById('drawer-body');
  if(!drawerBody)return;
  drawerBody.querySelectorAll('tr[data-price-row]').forEach(tr=>{
    const inp=tr.querySelector('.drawer-qty');
    if(inp) inp.disabled=false;
    tr.style.opacity='';
    const oldBadge=tr.querySelector('.upper-no-cd-badge');
    if(oldBadge) oldBadge.remove();
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
  const _isAdmU=(typeof isAdmin==='function')&&isAdmin();
  const _colspan=_isAdmU?6:5;
  if(shelfRowEntries.length===0){
    tbody.innerHTML=`<tr><td colspan="${_colspan}" style="text-align:center;color:var(--text-3);font-size:12px;padding:8px">추가된 항목 없음</td></tr>`;
    recalcOrderTotal();return;
  }
  const COLOR_OPTS=['화이트','블랙','실버','샴페인골드'];
  const _sharedC=(document.getElementById('shared-color-sel')||{}).value||'';
  tbody.innerHTML=shelfRowEntries.map((e,i)=>{
    const price=e.unitPriceOverride!==undefined?e.unitPriceOverride:getShelfPrice(e.size);
    const f=getLineFinancial(price,e.qty);
    let colorTd='';
    if(_isAdmU){
      const cc=e.color||'';
      const commonLabel=_sharedC?`공통색(${_sharedC})`:'공통색 사용';
      const opts=[`<option value="" ${cc===''?'selected':''}>${commonLabel}</option>`]
        .concat(COLOR_OPTS.map(c=>`<option value="${c}" ${cc===c?'selected':''}>${c}</option>`))
        .join('');
      colorTd=`<td class="td-center"><select class="form-input shelf-color-sel" data-idx="${i}" style="width:100%;max-width:140px;padding:3px 22px 3px 6px;font-size:12px">${opts}</select></td>`;
    }
    return `<tr data-price-row="1">
      <td class="td-center" style="font-size:13px;font-weight:600">${e.size}</td>
      <td class="td-center" style="font-size:12px;color:var(--text-2)">${orderUnitPriceHtml(price,{kind:'shelf',idx:i})}</td>
      <td class="td-center" style="font-size:13px">${e.qty}개</td>${colorTd}
      <td class="td-center row-supply-val" data-raw-supply="${f.supplyAmount||0}">${supplyAmtHtml(f.supplyAmount)}</td>
      <td class="td-center">
        <button type="button" class="btn btn-ghost btn-xs shelf-row-remove-btn" data-idx="${i}" style="color:var(--danger)">
          <i class="fas fa-times"></i>
        </button>
      </td>
    </tr>`;
  }).join('');
  if(_isAdmU){
    tbody.querySelectorAll('.shelf-color-sel').forEach(sel=>{
      sel.addEventListener('change',ev=>{
        const idx=parseInt(ev.target.dataset.idx);
        if(!isNaN(idx)&&shelfRowEntries[idx]) shelfRowEntries[idx].color=ev.target.value||'';
      });
    });
  }
  bindOrderLinePriceInputs(tbody);
  recalcOrderTotal();
}


// ─ 선반 행 추가 ─
function addShelfRow(){
  const s=document.getElementById('shelf-size').value.trim();
  const q=parseInt(document.getElementById('shelf-qty').value)||0;
  const _isAdmU=(typeof isAdmin==='function')&&isAdmin();
  const c=_isAdmU
    ? ((document.getElementById('shelf-color-input')||{}).value||'')
    : ((document.getElementById('shared-color-sel')||{}).value||'');
  if(!s){toast('규격을 입력해주세요.','error');return;}
  if(!/^\d+$/.test(s)||parseInt(s)<1){toast('규격은 양의 정수만 입력 가능합니다.','error');return;}
  if(q<1){toast('수량을 1 이상 입력해주세요.','error');return;}
  shelfRowEntries.push({size:s,qty:q,color:c});
  document.getElementById('shelf-size').value='';
  document.getElementById('shelf-qty').value='';
  const sci=document.getElementById('shelf-color-input');
  if(sci) sci.value='';
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


let proxyOrdererForOrder=null;

function _ordererAccountsForPicker(){
  return DB.get('accounts',[])
    .filter(a=>a&&a.role==='orderer')
    .sort((a,b)=>String(a.deliveryName||a.name||a.id||'').localeCompare(String(b.deliveryName||b.name||b.id||''),'ko'));
}

function openOrdererPickerModal(){
  if(!isAdmin())return;
  const search=document.getElementById('orderer-picker-search');
  if(search)search.value='';
  renderOrdererPickerList();
  openModal('orderer-picker-modal');
  setTimeout(()=>{const s=document.getElementById('orderer-picker-search');if(s)s.focus();},50);
}

function closeOrdererPickerModal(){
  closeModal('orderer-picker-modal');
}

function renderOrdererPickerList(){
  const listEl=document.getElementById('orderer-picker-list');
  if(!listEl)return;
  const q=(document.getElementById('orderer-picker-search')?.value||'').trim().toLowerCase();
  const esc=typeof escapeHtml==='function'?escapeHtml:(s=>String(s||''));
  const rows=_ordererAccountsForPicker().filter(a=>{
    const hay=[a.id,a.name,a.deliveryName,a.email].map(v=>String(v||'').toLowerCase()).join(' ');
    return !q||hay.includes(q);
  });
  if(rows.length===0){
    listEl.innerHTML='<div class="empty" style="padding:20px"><i class="fas fa-building"></i><p>검색된 발주 업체가 없습니다.</p></div>';
    return;
  }
  listEl.innerHTML=rows.map(a=>{
    const title=a.deliveryName||a.name||a.id;
    const sub=[a.id,a.email].filter(Boolean).join(' · ');
    return `<button type="button" class="btn btn-outline orderer-pick-row" data-orderer-id="${esc(a.id)}" style="display:block;width:100%;text-align:left;padding:12px 14px;border-radius:10px;line-height:1.35">
      <div style="font-size:15px;font-weight:800;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</div>
      <div style="font-size:12px;color:#64748b;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(sub||'-')}</div>
    </button>`;
  }).join('');
  listEl.querySelectorAll('.orderer-pick-row').forEach(btn=>{
    btn.addEventListener('click',()=>selectOrdererForOrder(btn.dataset.ordererId));
  });
}

function selectOrdererForOrder(ordererId){
  const acc=_ordererAccountsForPicker().find(a=>String(a.id)===String(ordererId));
  if(!acc){toast('업체 정보를 찾을 수 없습니다.','error');return;}
  proxyOrdererForOrder={id:acc.id,name:acc.name||acc.id,deliveryName:acc.deliveryName||acc.name||acc.id,email:acc.email||''};
  const delivToEl=document.getElementById('o-delivery-to');
  const ordererIdEl=document.getElementById('o-orderer-id');
  if(delivToEl)delivToEl.value=proxyOrdererForOrder.deliveryName;
  if(ordererIdEl)ordererIdEl.value=proxyOrdererForOrder.id;
  closeOrdererPickerModal();
  toast(proxyOrdererForOrder.deliveryName+' 업체로 선택했습니다.','success');
}

async function openOrderModal(){
  proxyOrdererForOrder=null;
  // [2026-07-14] 편집 흐름 잔재 정리 — 신규 발주 진입 시 이전 편집 order의 이름이 UI에 남지 않도록
  window._pendingEditOrder=null;
  // [P1-A stale fix 2026-08-27] 신규 모달 진입 시 draft 승격 상태 정리 (검증 실패 잔재 방지)
  window._promotingDraftId=null;
  window._promotingLegacyDraftId=null;
  _resetOrderModalBtn(); // saveBtn onclick 항상 초기화
  if(!isAdmin()){
    // [2026-08-28] draft 조회: hanger_drafts 컬렉션에서 자기 것만
    //   마이그레이션 전 기존 orders 임시저장도 병합 (배포 후 마이그레이션 1회 실행 시까지)
    let myDrafts = [];
    try{
      const _drafts = await getDrafts(currentUser?currentUser.id:null);
      const _newDrafts = (_drafts||[]).map(d => ({
        ...(d.payload||{}),
        id: d.draftId,
        draftId: d.draftId,
        orderNum: '',
        status: '임시저장',
        createdBy: d.createdBy||'',
        createdAt: d.createdAt||'',
        updatedAt: d.updatedAt||'',
      }));
      const _legacyDrafts = getOrders().filter(o=>o.status==='임시저장' && (!o.createdBy||!currentUser||o.createdBy===currentUser.id));
      myDrafts = [..._newDrafts, ..._legacyDrafts].sort((a,b)=>{
        const at = a.updatedAt||a.createdAt||'';
        const bt = b.updatedAt||b.createdAt||'';
        return String(bt).localeCompare(String(at));
      });
    }catch(e){
      console.warn('[openOrderModal] getDrafts 실패:', e&&e.message);
      myDrafts = getOrders().filter(o=>o.status==='임시저장' && (!o.createdBy||!currentUser||o.createdBy===currentUser.id));
    }

    if(myDrafts.length>0){
      const draft=myDrafts[0];
      const label=draft.orderNum||draft.draftId||('#'+draft.id);
      const doLoad=confirm(`임시저장된 발주서가 있습니다 [${label}].\n불러오시겠습니까?\n\n확인 → 임시저장 불러오기\n취소 → 새로 작성`);
      if(doLoad)window._pendingEditOrder=draft;
      _openOrderModalRender(null);
      if(doLoad){
        setTimeout(()=>{
          _restoreDraftToModal(draft);
          toast(`임시저장된 발주서를 불러왔습니다 [${label}]`,'info');
        },200);
      }
      return;
    }
  }
  _openOrderModalRender(null);
}



// ── 발주 모달 닫기 확인 (입력 내용 있을 때 경고) ──
function confirmCloseOrderModal(){
  closeModal('order-modal');
  _resetOrderModalBtn();
  window._editOverride=null; // 수정 모달 취소 시 정리 (다음 신규 등록에 누수 방지)
  // [P1-A stale fix 2026-08-27] 모달 닫기 시 draft/legacy 승격 상태 정리
  //   검증 실패 early return 후 사용자가 모달 닫고 무관한 발주 저장하면 stale draftId가
  //   무관한 draft를 삭제할 위험 → 여기서 확실히 초기화.
  window._promotingDraftId=null;
  window._promotingLegacyDraftId=null;
  if(typeof window._releaseActiveOrderEditLock==='function'){
    window._releaseActiveOrderEditLock().catch(()=>{});
  }
}

// 발주 모달 제목/버튼 초기화
function _resetOrderModalBtn(){
  const titleEl=document.querySelector('#order-modal .modal-title');
  if(titleEl)titleEl.textContent=isAdmin()?'대리 발주서 작성':'새 발주서 등록';
  const saveBtn=document.querySelector('#order-modal .order-modal-bottom .btn-primary');
  if(saveBtn){
    const lbl=isAdmin()?'출고확정':'발주 넣기';
    saveBtn.innerHTML=`<i class="fas fa-check"></i> <span id="order-submit-label">${lbl}</span>`;
    saveBtn.onclick=()=>openOrderConfirmModal();
  }
  const pendingBtn=document.getElementById('order-pending-btn');
  if(pendingBtn)pendingBtn.style.display=isAdmin()?'':'none';
}


// 모달 DOM 렌더링만 담당 (initialData가 있으면 기본값으로 사용)
function _openOrderModalRender(initialData){
  // 기본 정보 초기화
  // 납품처: 관리자/일반 사용자 모두 currentUser.deliveryName 강제 + 읽기 전용
  //         (이카운트 코드 등 다른 필드는 별개)
  // [2026-06-29] fallback: deliveryName 없으면 name 사용 (신규 계정 안전망)
  const autoDeliveryName=isAdmin()?'':((currentUser&&(currentUser.deliveryName||currentUser.name))||'');
  const delivToEl=document.getElementById('o-delivery-to');
  delivToEl.value=autoDeliveryName;
  delivToEl.readOnly=true;
  delivToEl.tabIndex=-1;
  const ordererIdEl=document.getElementById('o-orderer-id');
  const ordererPickBtn=document.getElementById('o-orderer-pick-btn');
  if(ordererIdEl)ordererIdEl.value='';
  if(ordererPickBtn)ordererPickBtn.style.display=isAdmin()?'':'none';
  if(isAdmin()){
    delivToEl.placeholder='발주 업체를 선택해주세요';
    delivToEl.readOnly=false;
    delivToEl.tabIndex=0;
    delivToEl.classList.remove('input-locked');
    delivToEl.onclick=()=>openOrdererPickerModal();
  }else{
    delivToEl.placeholder='자동 입력됨';
    delivToEl.readOnly=true;
    delivToEl.tabIndex=-1;
    delivToEl.classList.add('input-locked');
    delivToEl.onclick=null;
  }
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
  rodUnitPriceOverride=null;
  // [2026-08-03] 옷봉 색상 UI 는 관리자(대리발주) 전용 — DOM 요소 표시/숨김 토글
  const _isAdm=(typeof isAdmin==='function')&&isAdmin();
  document.querySelectorAll('.per-row-color-only-admin').forEach(el=>{
    el.style.display=_isAdm?'':'none';
  });
  // [2026-08-03 문제1 fix] 발주자 편집 시: 서브행은 표시하되 잠금 (삭제·수정 불가)
  // 발주자에게 "관리자가 추가한 색상" 존재를 알리고 실수로 화이트 줄여 서브행만 남는 사고 방지
  window._applyExtraRowLockForOrderer=function(){
    const isOrdererView=!( (typeof isAdmin==='function')&&isAdmin() );
    document.querySelectorAll('.upper-extra-color-row, .drawer-extra-color-row').forEach(row=>{
      row.querySelectorAll('input,select,button').forEach(el=>{
        if(isOrdererView){
          if(el.classList.contains('upper-extra-del-btn') || el.classList.contains('drawer-extra-del-btn')){
            el.style.display='none';
          } else {
            el.disabled=true;
          }
        }
      });
      if(isOrdererView){
        const label=row.querySelector('td:first-child');
        if(label && !label.querySelector('.orderer-locked-badge')){
          const badge=document.createElement('span');
          badge.className='orderer-locked-badge';
          badge.textContent=' (관리자 추가)';
          badge.style.cssText='font-size:10px;color:#6b7280;margin-left:4px';
          label.appendChild(badge);
        }
      }
    });
  };
  // [2026-08-03 fix] 색상 입력 select 값 리셋 (이전 세션 값 잔존 방지)
  ['rod-color-input','shelf-color-input','corner-color-input'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.value='';
  });
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
    newUcEl.addEventListener('change',e=>{
      checkUpperColorCodes(e.target.value);
      // 상부 입력값은 DOM에만 있으므로 테이블 전체 재렌더 시 수량·분할·추가색이 사라진다.
      if(typeof renderRodRows==='function') renderRodRows();
      recalcOrderTotal();
    });
  }

  // ── 공통 색상 select 채우기 ──
  const sharedSel=document.getElementById('shared-color-sel');
  if(sharedSel){
    sharedSel.innerHTML='<option value="">색상 선택</option>'+SHELF_COLORS.map(c=>`<option value="${c}">${c}</option>`).join('');
    // [2026-08-03] 선반 공통색 라벨 갱신 위해 선반·코너 재렌더
    const newSharedSel=sharedSel.cloneNode(true);
    sharedSel.parentNode.replaceChild(newSharedSel,sharedSel);
    newSharedSel.addEventListener('change',()=>{
      if(typeof renderShelfRows==='function') renderShelfRows();
      if(typeof renderCornerRows==='function') renderCornerRows();
    });
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
            <th class="td-center per-row-color-only-admin" style="width:100px">색상</th>
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
        <select id="shelf-color-input" class="form-input per-row-color-only-admin" style="width:130px;padding:6px 24px 6px 8px;font-size:13px">
          <option value="">공통색 사용</option>
          <option value="화이트">화이트</option>
          <option value="블랙">블랙</option>
          <option value="실버">실버</option>
          <option value="샴페인골드">샴페인골드</option>
        </select>
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
            <th class="td-center per-row-color-only-admin" style="width:100px">색상</th>
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
        <select id="corner-color-input" class="form-input per-row-color-only-admin" style="width:130px;padding:6px 24px 6px 8px;font-size:13px">
          <option value="">공통색 사용</option>
          <option value="화이트">화이트</option>
          <option value="블랙">블랙</option>
          <option value="실버">실버</option>
          <option value="샴페인골드">샴페인골드</option>
        </select>
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
    const tracksStock=isTrackStock(item);
    const hasItemColor=!!item.hasColor;
    const customColors=item.colorOptions&&item.colorOptions.length>0?item.colorOptions:null;
    const da=`data-item-id="${item.id}" data-item-name="${item.name}" data-stock="${item.currentStock}" data-tracks-stock="${tracksStock}"`;
    const price=getActivePriceForItem(item.name);
    const priceHtml=orderUnitPriceHtml(price,{kind:'drawer'});
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
    // 현재고 td (모든 재고 추적 품목 — 창고+색상 기준)
    const curStockTd=tracksStock?(()=>{
      const initWh=(document.getElementById('o-warehouse')||{}).value||'시흥';
      const initColor=needsOwnColor||item.noColor?'':((document.getElementById('shared-color-sel')||{}).value||'');
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
    const shortageTd=tracksStock
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
    // [2026-08-03] 관리자 대리발주: 공통색 쓰는 서랍/옵션 품목에 [+ 색 추가] 버튼
    const _isAdmDrawer=(typeof isAdmin==='function')&&isAdmin();
    const addColorBtnCell=_isAdmDrawer
      ?`<div style="margin-top:4px"><button type="button" class="btn drawer-add-color-btn" data-item-id="${item.id}" data-item-name="${item.name}" style="padding:2px 6px;font-size:10px;border:1px solid #3b82f6;background:#eff6ff;color:#1d4ed8;border-radius:4px;font-weight:600;cursor:pointer;white-space:nowrap"><i class="fas fa-plus"></i> 색 추가</button></div>`
      :'';
    const mainRow=`<tr data-price-row="1" data-drawer-main="${item.id}">
      ${nameCell}
      <td>${priceHtml}</td>
      <td class="td-center">${stepperHtml('drawer-qty',da+` id="oqty-${item.id}"`)}</td>
      <td class="td-center">${colorCell}${addColorBtnCell}</td>
      ${curStockTd}
      ${shortageTd}
      <td class="td-center row-supply-val" data-raw-supply="0">${supplyAmtHtml(0)}</td>
    </tr>`;
    return mainRow;
  }).join('');
  // [2026-08-03] "+ 색 추가" 버튼 이벤트 (서랍/옵션)
  drawerBody.querySelectorAll('.drawer-add-color-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      _addDrawerExtraColorRow(btn.dataset.itemId, btn.dataset.itemName);
    });
  });

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
      const tracksStock=inp.dataset.tracksStock==='true';
      const val=parseInt(inp.value)||0;
      const shortageEl=document.getElementById('oshortage-'+inp.dataset.itemId);
      if(tracksStock){
        const s=calcShortage(val,stock);
        if(shortageEl)shortageEl.innerHTML=s>0
          ?`<span class="sh-label">▼ 부족</span><span class="sh-val">${s}개</span>`
          :`<span class="sh-ok">부족없음</span>`;
      }else{if(shortageEl)shortageEl.innerHTML='';}
      updateDrawerRowAmount(inp);
    });
  });
  bindOrderLinePriceInputs(drawerBody);

  // 개별 색상 옵션 변경 시 해당 품목의 현재고·부족량 즉시 갱신
  drawerBody.querySelectorAll('.item-color-select').forEach(sel=>{
    sel.addEventListener('change',()=>{
      const curWh=(document.getElementById('o-warehouse')||{}).value||'시흥';
      const sharedColor=(document.getElementById('shared-color-sel')||{}).value||'';
      _refreshDrawerStockDisplay(curWh,sharedColor);
    });
  });

  // shared-color-sel 변경 시 선반/코너선반 color 동기화 + 서랍장 재고 갱신 + 코드 체크
  // [2026-08-03] 관리자 대리발주에서는 행마다 개별 색상이 있을 수 있음 → 명시 지정된 값은 보존.
  //   기존 e.color==='' (공통색 사용) 인 항목만 갱신 대상. save 시 || sharedColorVal 폴백으로 처리되므로
  //   e.color 재할당 없이 재렌더만 해도 충분.
  if(sharedSel){
    sharedSel.addEventListener('change',()=>{
      const newColor=sharedSel.value;
      renderShelfRows();renderCornerRows();
      // 창고+색상 기준으로 서랍장 재고 갱신
      const curWh=(document.getElementById('o-warehouse')||{}).value||'시흥';
      _refreshDrawerStockDisplay(curWh,newColor);
      // 이카운트 코드 없는 서랍/옵션 품목 비활성화
      checkDrawerColorCodes(newColor);
    });
  }

  _refreshDrawerStockDisplay((document.getElementById('o-warehouse')||{}).value||'시흥',(document.getElementById('shared-color-sel')||{}).value||'');
  openModal('order-modal');
} // end _openOrderModalRender


// draft 발주서 데이터를 열린 모달에 복원
function _restoreDraftToModal(order){
  // 기본정보
  const delivToEl2=document.getElementById('o-delivery-to');
  const ordererIdEl2=document.getElementById('o-orderer-id');
  if(isAdmin()){
    const ordererId=order.createdBy||'';
    const acc=DB.get('accounts',[]).find(a=>String(a.id)===String(ordererId)&&a.role==='orderer');
    proxyOrdererForOrder=acc?{id:acc.id,name:acc.name||acc.id,deliveryName:acc.deliveryName||acc.name||acc.id,email:acc.email||''}:null;
    delivToEl2.value=order.deliveryTo||order.siteName||(proxyOrdererForOrder&&proxyOrdererForOrder.deliveryName)||'';
    if(ordererIdEl2)ordererIdEl2.value=ordererId;
    delivToEl2.readOnly=false;
    delivToEl2.tabIndex=0;
  }else{
    // 발주자는 자기 deliveryName으로 강제
    const forcedDeliv=(currentUser&&(currentUser.deliveryName||currentUser.name))||'';
    delivToEl2.value=forcedDeliv;
    if(ordererIdEl2)ordererIdEl2.value='';
    delivToEl2.readOnly=true;
    delivToEl2.tabIndex=-1;
  }
  document.getElementById('o-address').value=order.address||order.customerName||'';
  // [2026-08-28] draft 복원 시 발주일=오늘 (실제 발주하는 날 = 발주일)
  //   draftId 있으면 hanger_drafts에서 온 것 → 오늘로 리셋. 옛 orders 임시저장은 원래 값 유지.
  //   shipDate(예정 출고일)는 발주자 의도값이므로 그대로 유지.
  const _isDraftRestore = !!order.draftId;
  setDateValue('o-date', _isDraftRestore ? todayStr() : (order.orderDate||todayStr()));
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
    // [2026-07-14] 상부자재 색상별 코드 체크 (편집 복원과 동일 - Bug 3 수정)
    if(typeof checkUpperColorCodes==='function') checkUpperColorCodes(storedColor);
  }
  // 품목별 수량/비고 복원
  // [2026-08-03] 상부자재는 같은 name 에 여러 색상 entry 있을 수 있음 (main + extras).
  //   → name 별로 그룹화 후 첫 entry = main, 나머지 = extra 서브행 생성.
  const _upperByName={};
  (order.upperMaterials||[]).forEach(r=>{
    if(!r||!r.name) return;
    if(!_upperByName[r.name]) _upperByName[r.name]=[];
    _upperByName[r.name].push(r);
  });
  // [2026-08-03 fix] 서브행은 데이터 보존 목적으로 항상 복원 (관리자 여부 무관).
  // 관리자만 새 서브행 추가·편집 가능하지만, 이미 저장된 서브행은 발주자 편집 시에도 유지되어야 함.
  const _isAdmForRestore=true;
  const _ucVal=(document.getElementById('upper-common-color')||{}).value||'';
  Object.entries(_upperByName).forEach(([rawName, entries])=>{
    // 메인 entry: 공통색과 매칭되는 것 우선, 없으면 첫 번째
    // [문제3 fix] _isMain 우선, 없으면 색상 매칭, 없으면 첫번째
    let mainEntry=entries.find(e=>e._isMain===true);
    if(!mainEntry) mainEntry=entries.find(e=>e.color===_ucVal);
    if(!mainEntry) mainEntry=entries[0];
    const mainQty=mainEntry.qty||(mainEntry.white||0)+(mainEntry.black||0)+(mainEntry.silver||0)+(mainEntry.champagne||0);
    let inp=_findUpperControl(rawName,'.upper-qty');
    if(!inp){const cn=compatUpperName(rawName);if(cn!==rawName)inp=_findUpperControl(cn,'.upper-qty');}
    if(inp){inp.value=mainQty||'';updateUpperRowAmount(inp);}
    if(mainEntry.note){
      let nEl=_findUpperControl(rawName,'.upper-note');
      if(!nEl){const cn=compatUpperName(rawName);if(cn!==rawName)nEl=_findUpperControl(cn,'.upper-note');}
      if(nEl)nEl.value=mainEntry.note;
    }
    if(mainEntry.lengthSplits&&Array.isArray(mainEntry.lengthSplits)&&mainEntry.lengthSplits.length>0){
      const matKey=inp?.dataset?.mat||rawName;
      if(inp){inp.dataset.splits=JSON.stringify(mainEntry.lengthSplits);}
      if(typeof setRowLengthSplits==='function')setRowLengthSplits(matKey,mainEntry.lengthSplits);
    }
    // 나머지 entry = 추가 색상 서브행 (관리자 대리발주 흐름에서만)
    if(_isAdmForRestore){
      entries.filter(e=>e!==mainEntry).forEach(e=>{
        const eq=e.qty||(e.white||0)+(e.black||0)+(e.silver||0)+(e.champagne||0);
        if(eq>0&&e.color) _addUpperExtraColorRow(rawName, e.color, eq);
      });
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
    order.rodItems.forEach(r=>rodEntries.push({size:r.size,qty:r.qty,color:r.color||''}));
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
    saveBtn.onclick=async ()=>{
      // [Phase 3 2026-08-27] draft 승격: flag ON이면 hanger_drafts에서 삭제 + 신규 order 생성
      //   기존: orders에서 splice + _editOverride로 원본 id/orderNum 재사용
      //   신규: draft 삭제 → _editOverride 없이 신규 order로 저장 (오늘 날짜 orderNum 부여)
      const isDraftFlow = !!order.draftId;
      if(isDraftFlow){
        // [P1-A 2026-08-27] draft 삭제를 submitOrder 성공 후로 이동:
        //   기존: draft 먼저 삭제 → submitOrder 검증 실패(단순 return) → rollback 안 탐 → 유실
        //   신규: submitOrder 성공 시점에 draft 삭제. 검증 실패 return 시 draft 그대로 유지.
        window._promotingDraftId = order.draftId;
        window._editOverride = null; // 신규 order로 진행 → 오늘 날짜 orderNum·발주일 자동 할당
      } else {
        // 기존 흐름: legacy orders 임시저장 승격
        // [P1-3 fix 2026-08-27] splice + DB.set을 saveOrder 성공 후로 이동:
        //   기존: splice 먼저 → submitOrder 검증 실패 return → 원본 유실
        //   신규: _editOverride만 세팅 → saveOrder 성공 후 splice + PR 정리
        const allOrders=DB.get('orders',[]);
        const draftIdx=allOrders.findIndex(o=>o.id===order.id);
        if(draftIdx>-1){
          const orig=allOrders[draftIdx];
          window._editOverride={
            id:orig.id,
            orderNum:orig.orderNum,
            originalStatus:orig.status||'',
            status:'발주대기',
            createdBy:orig.createdBy||'',
            createdAt:orig.createdAt||new Date().toISOString(),
            statusHistory:orig.statusHistory||[]
          };
          window._promotingLegacyDraftId=orig.id;
        }
      }
      const titleEl=document.querySelector('#order-modal .modal-title');
      if(titleEl)titleEl.textContent=isAdmin()?'대리 발주서 작성':'새 발주서 등록';
      _resetOrderModalBtn();
      submitOrder('발주대기');
    };
  }
  // 복원 후 금액 재계산
  setTimeout(()=>recalcOrderTotal(),50);
}


async function submitOrder(saveMode='발주확정'){
  // race condition 1차 방어: 같은 발주서(수정) 또는 새 발주(new) 동시 저장 차단
  const _lockKey = (window._editOverride&&window._editOverride.id) ? window._editOverride.id : 'new';
  return _withOrderLock(_lockKey, 'save', async () => {
  // 콘솔 우회 방어 — 발주자는 자기 deliveryName으로 강제, 관리자는 폼 값 유지 (수정 시 원본 보존)
  const _delivEl=document.getElementById('o-delivery-to');
  const _ordererIdEl=document.getElementById('o-orderer-id');
  let deliveryTo;
  let proxyOrdererId='';
  let proxyOrdererName='';
  if(isAdmin()){
    deliveryTo=(_delivEl?_delivEl.value:'').trim();
    proxyOrdererId=(_ordererIdEl?_ordererIdEl.value:'').trim();
    if(!proxyOrdererId&&proxyOrdererForOrder&&proxyOrdererForOrder.id)proxyOrdererId=proxyOrdererForOrder.id;
    if(!proxyOrdererId&&window._editOverride&&window._editOverride.createdBy)proxyOrdererId=window._editOverride.createdBy;
    const proxyAcc=DB.get('accounts',[]).find(a=>String(a.id)===String(proxyOrdererId)&&a.role==='orderer');
    if(proxyAcc){
      proxyOrdererName=proxyAcc.name||proxyAcc.id;
      deliveryTo=proxyAcc.deliveryName||proxyAcc.name||proxyAcc.id;
      if(_delivEl)_delivEl.value=deliveryTo;
    }
    if(!deliveryTo&&window._editOverride&&window._editOverride.deliveryTo){
      deliveryTo=window._editOverride.deliveryTo;
      if(_delivEl)_delivEl.value=deliveryTo;
    }
  } else {
    // [2026-06-29] fallback: deliveryName 없으면 name 사용 (신규 계정 안전망)
    const _forceDeliv=(currentUser&&(currentUser.deliveryName||currentUser.name))||'';
    if(_delivEl) _delivEl.value=_forceDeliv;
    deliveryTo=_forceDeliv;
  }
  let address=document.getElementById('o-address').value.trim();
  if(!address&&window._editOverride&&window._editOverride.address){
    address=window._editOverride.address;
    const addrEl=document.getElementById('o-address');
    if(addrEl)addrEl.value=address;
  }
  // 날짜 입력 최종 동기화 (키보드 입력 후 blur 없이 제출한 경우 대비)
  syncDateParts('o-date');
  syncDateParts('o-ship-date');
  const orderDate=document.getElementById('o-date').value;
  let shipDate=document.getElementById('o-ship-date').value;
  if((!shipDate||!/^\d{4}-\d{2}-\d{2}$/.test(shipDate))&&window._editOverride&&window._editOverride.shipDate){
    shipDate=window._editOverride.shipDate;
    if(typeof setDateValue==='function')setDateValue('o-ship-date',shipDate);
  }
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
  if(isAdmin()&&!proxyOrdererId) _markRequired(document.getElementById('o-delivery-to'),'발주 업체를 선택해주세요.');
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
    const whEl=document.getElementById('o-warehouse');
    if(whEl&&!whEl.value&&window._editOverride&&window._editOverride.warehouse)whEl.value=window._editOverride.warehouse;
    const whCheck=whEl?.value||'';
    if(!whCheck){
      _markRequired(document.getElementById('o-warehouse'),'출고 창고를 선택해주세요. (시흥 또는 평택)');
    }
    // [2026-07-15] 색상 필수 조건부 — 해당 카테고리에 수량 입력한 품목이 있을 때만 색상 필수
    // [H1] 옷봉(rodEntries)도 상부자재 색상 사용 — 옷봉만 발주 시 색상 검증 skip 방지
    // 상부자재 색상: 색상 있는 상부자재 or 옷봉에 항목이 있을 때 (noColor 품목만 있으면 색상 검증 skip)
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
      if(!ucCheck||!ucCheck.value){
        _markRequired(ucCheck,'상부자재 색상을 선택해주세요.');
      }
    }
    const dbItemsForVal=DB.get('items',[]);
    // 공통 색상은 선반·코너선반 또는 개별 색상 선택기가 없는 색상 품목에만 필수
    const hasShelfOrCorner = shelfRowEntries.length > 0 || cornerEntries.length > 0;
    const hasSharedColorItem = Array.from(document.querySelectorAll('.drawer-qty')).some(inp=>{
      if((parseInt(inp.value)||0)<1)return false;
      const itemId=parseInt(inp.dataset.itemId);
      const dbItem=dbItemsForVal.find(i=>i.id===itemId);
      const ownColor=document.querySelector(`.item-color-select[data-item-id="${itemId}"]`);
      return !!dbItem&&!dbItem.noColor&&!ownColor;
    });
    if (hasShelfOrCorner || hasSharedColorItem) {
      const scCheck=document.getElementById('shared-color-sel');
      if(!scCheck||!scCheck.value){
        _markRequired(scCheck,'선반/코너선반/서랍/옵션 색상을 선택해주세요.');
      }
    }
    // hasColor 또는 colorOptions 품목 개별 색상 필수
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

    // ── [2026-06-29] 이카운트 색상 코드 검증 제거 (이카운트 미사용) ──
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
  const COLOR_KEY_MAP={'화이트':'white','블랙':'black','실버':'silver','샴페인골드':'champagne'};
  document.querySelectorAll('.upper-qty').forEach(inp=>{
    const mat=inp.dataset.mat, val=parseInt(inp.value)||0;
    const isFixed=UPPER_FIXED.includes(mat);
    const noteEl=isFixed?(inp.closest('tr')&&inp.closest('tr').querySelector('.upper-note')):null;
    const note=noteEl?noteEl.value.trim():'';
    const unitPrice=getOrderLinePrice(inp.closest('tr'),getActivePriceForItem(mat));
    // 메인 행 (공통색 수량) — val>0 일 때만
    if(val>0){
      // noColor 품목(예: 나비너트)은 색상 없이 저장 — 공통 색상 강제 매핑 X
      const _matNoColor=(typeof window._isUpperNoColor==='function')?window._isUpperNoColor(mat):false;
      const rowColor=_matNoColor?'':upperCommonColor;
      const colorKey=COLOR_KEY_MAP[rowColor]||'white';
      const supply=(unitPrice!==null)?unitPrice*val:null;
      const vatAmt=supply!==null?Math.round(supply*0.1):null;
      // [2026-08-03 문제3 fix] _isMain:true → 복원 시 확실한 메인 판단
      const row={name:mat,color:rowColor,qty:val,note,unitPrice,amount:supply,vatAmount:vatAmt,_isMain:true,white:0,black:0,silver:0,champagne:0};
      if(!_matNoColor)row[colorKey]=val; // noColor는 색상 카운트도 안 함
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
    // [2026-08-03] 이 품목의 "추가 색상" 서브행 수집 (관리자 대리발주 전용)
    // 같은 색 서브행 여러 개면 합쳐서 하나로 push (중복 방지)
    {
      const _byColorExtra={};
      _upperExtraRows(mat).forEach(extraTr=>{
        const eq=parseInt((extraTr.querySelector('.upper-extra-qty')||{}).value)||0;
        const ec=(extraTr.querySelector('.upper-extra-color-sel')||{}).value||'';
        if(eq>0 && ec) _byColorExtra[ec]=(_byColorExtra[ec]||0)+eq;
      });
      Object.entries(_byColorExtra).forEach(([ec, eq])=>{
        const existingRow=upperMaterials.find(r=>r.name===mat&&r.color===ec);
        if(existingRow){
          existingRow.qty+=eq;
          existingRow[COLOR_KEY_MAP[ec]||'white']=existingRow.qty;
          existingRow.amount=unitPrice!==null?unitPrice*existingRow.qty:null;
          existingRow.vatAmount=existingRow.amount!==null?Math.round(existingRow.amount*0.1):null;
          return;
        }
        const eKey=COLOR_KEY_MAP[ec]||'white';
        const eSupply=(unitPrice!==null)?unitPrice*eq:null;
        const eVat=eSupply!==null?Math.round(eSupply*0.1):null;
        const extraRow={name:mat,color:ec,qty:eq,note,unitPrice,amount:eSupply,vatAmount:eVat,white:0,black:0,silver:0,champagne:0};
        extraRow[eKey]=eq;
        upperMaterials.push(extraRow);
      });
    }
  });

  // 구역 A-2: 옷봉 수집
  const rod2400Required=rodEntries.length>0?calcRod2400(rodEntries,upperCommonColor):0;
  const rodItems=rodEntries.length>0?[...rodEntries]:[];
  const rodTotalLen=rodEntries.reduce((s,e)=>s+parseInt(e.size)*e.qty,0);
  const rodUnitPrice=rodUnitPriceOverride!==null&&rodUnitPriceOverride!==undefined?rodUnitPriceOverride:(getActivePriceForItem('옷봉 2400')||4500);
  const rodAmount=rodUnitPrice*rod2400Required;
  const rodVat=Math.round(rodAmount*0.1);

  // 구역 B: 선반(행 추가형) + 코너선반(행 추가형) 수집
  const shelfItems=[];
  const scEl=document.getElementById('shared-color-sel');
  const sharedColorVal=scEl?scEl.value:'';
  const shelfWithColor=shelfRowEntries.map(e=>{
    const price=e.unitPriceOverride!==undefined?e.unitPriceOverride:getShelfPrice(e.size);
    const supply=price!==null&&price!==undefined?price*e.qty:null;
    const color=e.color||sharedColorVal;
    const ecountCd=getShelfEcountCode(e.size,color);
    return {...e,color,unitPrice:price,amount:supply,vatAmount:supply!==null?Math.round(supply*0.1):null,...(ecountCd?{ecountCd}:{})};
  });
  const cornerWithColor=cornerEntries.map(e=>{
    const price=e.unitPriceOverride!==undefined?e.unitPriceOverride:getCornerShelfPrice(e.width,e.height);
    const supply=price!==null&&price!==undefined?price*e.qty:null;
    const color=e.color||sharedColorVal;
    const ecountCd=getCornerShelfEcountCode(e.width,e.height,color);
    return {...e,color,unitPrice:price,amount:supply,vatAmount:supply!==null?Math.round(supply*0.1):null,...(ecountCd?{ecountCd}:{})};
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
      const dbItem=getItems().find(i=>i.id===itemId);
      const color=dbItem&&dbItem.noColor?'':(itemColorEl?itemColorEl.value:(sharedColorEl?sharedColorEl.value:''));
      const itemName=dbItem?dbItem.name:(inp.dataset.itemName||'');
      // 손잡이 옵션 읽기
      const tr=inp.closest('tr');
      const hSel=tr?tr.querySelector('.drawer-handle-select'):null;
      const handleOpt=hSel?hSel.value:'basic';
      const displayName=itemName;
      // 실제길이 note 수집
      const noteInp=tr?tr.querySelector('.item-note-input'):null;
      const itemNote=noteInp?noteInp.value.trim():'';
      const basePrice=getOrderLinePrice(tr,getActivePriceForItem(itemName));
      const unitPrice=basePrice!==null?basePrice:null;
      const supply=(unitPrice!==null)?unitPrice*qty:null;
      const vatAmt=supply!==null?Math.round(supply*0.1):null;
      drawerItems.push({itemId,itemName:displayName,requiredQty:qty,color,handleOption:handleOpt,displayName,note:itemNote,unitPrice,amount:supply,vatAmount:vatAmt,_isMain:true});
    }
    // [2026-08-03] 이 서랍 품목의 "추가 색상" 서브행 수집 (관리자 대리발주 전용).
    // 같은 색 서브행 여러 개면 합쳐서 하나로 push.
    {
      const iid=parseInt(inp.dataset.itemId);
      const _byColorD={};
      document.querySelectorAll(`.drawer-extra-color-row[data-item-id="${iid}"]`).forEach(extraTr=>{
        const eq=parseInt((extraTr.querySelector('.drawer-extra-qty')||{}).value)||0;
        const ec=(extraTr.querySelector('.drawer-extra-color-sel')||{}).value||'';
        if(eq>0 && ec) _byColorD[ec]=(_byColorD[ec]||0)+eq;
      });
      Object.entries(_byColorD).forEach(([ec, eq])=>{
        const dbItem=getItems().find(i=>i.id===iid);
        const itemName=dbItem?dbItem.name:(inp.dataset.itemName||'');
        const tr=inp.closest('tr');
        const hSel=tr?tr.querySelector('.drawer-handle-select'):null;
        const handleOpt=hSel?hSel.value:'basic';
        const basePrice=getOrderLinePrice(tr,getActivePriceForItem(itemName));
        const unitPrice=basePrice!==null?basePrice:null;
        const supply=(unitPrice!==null)?unitPrice*eq:null;
        const vatAmt=supply!==null?Math.round(supply*0.1):null;
        const existingRow=drawerItems.find(r=>String(r.itemId)===String(iid)&&r.color===ec);
        if(existingRow){
          existingRow.requiredQty+=eq;
          existingRow.amount=unitPrice!==null?unitPrice*existingRow.requiredQty:null;
          existingRow.vatAmount=existingRow.amount!==null?Math.round(existingRow.amount*0.1):null;
          return;
        }
        drawerItems.push({itemId:iid,itemName,requiredQty:eq,color:ec,handleOption:handleOpt,displayName:itemName,note:'',unitPrice,amount:supply,vatAmount:vatAmt});
      });
    }
  });

  if(saveMode!=='임시저장'&&!upperMaterials.length&&!rodItems.length&&!shelfItems.length&&!drawerItems.length&&!drawerMemo&&!etcMemo){
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
  // [2026-08-03 B3 fix] 서랍 복원 실패한 상태에서 저장하면 서랍 데이터 소실 → 저장 차단
  if(window._drawerRestoreFailed===true){
    toast('⚠ 서랍/옵션 복원이 실패한 상태입니다. 저장 취소됨. 새로고침 후 다시 시도해주세요.','error');
    return;
  }
  // [2026-08-03 문제2 fix] 관리자: 공통색과 같은 서브행이 있으면 병합 경고 (임시저장 제외)
  const _isAdmWarn=(typeof isAdmin==='function')&&isAdmin();
  if(_isAdmWarn && saveMode!=='임시저장'){
    const _ucWarn=(document.getElementById('upper-common-color')||{}).value||'';
    const _shWarn=(document.getElementById('shared-color-sel')||{}).value||'';
    let _mergeConflict=false, _conflictNames=[];
    document.querySelectorAll('.upper-extra-color-row').forEach(row=>{
      const c=(row.querySelector('.upper-extra-color-sel')||{}).value;
      if(c && c===_ucWarn){ _mergeConflict=true; _conflictNames.push('상부('+row.dataset.mat+')'); }
    });
    document.querySelectorAll('.drawer-extra-color-row').forEach(row=>{
      const c=(row.querySelector('.drawer-extra-color-sel')||{}).value;
      if(c && c===_shWarn){ _mergeConflict=true; _conflictNames.push('서랍('+row.dataset.itemName+')'); }
    });
    if(_mergeConflict){
      const proceed=confirm('⚠ 공통색과 같은 색상의 서브행이 있어 저장 시 합쳐집니다.\n\n대상: '+_conflictNames.join(', ')+'\n\n계속 저장할까요?');
      if(!proceed) return;
    }
  }
  let orderId, shortageCount, savedOrder;
  try{
    // [P1-B 2026-08-27] draft 승격이면 saveOrder 진입 전 draft 존재 재확인
    //   두 탭 순차 승격 방어. 없으면 다른 탭이 이미 처리 → abort (재고 이중 차감 방지).
    if(window._promotingDraftId && typeof getDraft==='function'){
      try{
        const _stillExists = await getDraft(window._promotingDraftId);
        if(!_stillExists){
          toast('이 임시저장은 다른 곳에서 이미 처리되었습니다. 새로고침 후 확인해주세요.','warning');
          window._promotingDraftId=null;
          return;
        }
      }catch(_chkErr){
        console.warn('[draft 승격] 존재 재확인 실패:', _chkErr&&_chkErr.message);
        toast('임시저장 상태 확인 실패. 새로고침 후 다시 시도해주세요.','error');
        window._promotingDraftId=null;
        return;
      }
    }
    ({orderId,shortageCount,order:savedOrder}=await saveOrder({deliveryTo,address,orderDate,shipDate,note,upperMaterials,upperCommonColor,rodItems,rod2400Required,rodTotalLen,rodUnitPrice,rodAmount,rodVat,shelfItems,drawerItems,drawerMemo,etcMemo,sharedColor,totalSupply,totalVat:totalVatAmt,totalAmount,warehouse,proxyOrdererId,proxyOrdererName,proxyCreatedByAdmin:isAdmin()},saveMode));
  }catch(_e){
    // saveOrder 실패: draft/legacy 원본 그대로 유지. 그냥 에러 토스트.
    window._promotingDraftId=null;
    // [P1-3 팀 지적 fix 2026-08-27] legacy는 _editOverride가 catch에서 유지되므로
    //   _promotingLegacyDraftId도 함께 유지 → 재시도 성공 시 PR 정리 일관성 확보.
    //   모달 닫기·새 발주 진입 시 stale은 openOrderModal/confirmCloseOrderModal에서 정리됨.
    // [flag ON 원자화 2026-08-28] transaction 안에서 draft 사라지면 DRAFT_MISSING throw
    const _msg = (_e && _e.message) || '';
    if(_msg.includes('DRAFT_MISSING')){
      toast('이 임시저장은 다른 곳에서 이미 처리되었습니다. 새로고침 후 확인해주세요.','warning');
    } else {
      toast((_msg || '발주 저장 실패. 다시 시도해주세요.'),'error');
    }
    return;
  }
  // [flag ON 원자화 완결 2026-08-28] draft 삭제는 saveOrder 내부 transaction에서 원자 처리됨.
  //   여기서는 성공 후 플래그 정리만 (기존 사후 deleteDraft 완전 제거 → 3단계 분리 사라짐).
  if(window._promotingDraftId){
    window._promotingDraftId=null;
  }
  // [P1-1 코덱스 지적 fix 2026-08-28] legacy 승격 후처리에서 PR 삭제 제거
  //   기존: saveOrder가 방금 새 PR 생성한 뒤 후처리가 같은 orderId PR 전부 삭제 → 발주필요 유실
  //   신규: saveOrder의 원자적 PR 교체(db.js:transactOrderInventory)에 맡김. 후처리 없음.
  //   플래그만 정리.
  if(window._promotingLegacyDraftId){
    window._promotingLegacyDraftId=null;
  }
  const shouldCreateInvoice=savedOrder&&(savedOrder.status==='발주대기'||savedOrder.status==='발주확정'||savedOrder.status==='출고완료');
  if(shouldCreateInvoice&&window.LumaneInvoice&&typeof window.LumaneInvoice.autoCreateForOrder==='function'){
    window.LumaneInvoice.autoCreateForOrder(savedOrder,{reason:'order-save'}).catch(e=>console.warn('[주문 저장 후 명세서 자동생성 실패]',e&&e.message));
  }
  closeModal('order-modal');
  toast(saveMode==='임시저장'?'발주서가 임시저장되었습니다.':saveMode==='발주대기'?'발주가 접수되었습니다. 관리자 확정을 기다립니다.':saveMode==='발주확정'?'발주서가 발주확정되었습니다.':(shortageCount>0?`출고확정 완료. 서랍장 부족 품목 ${shortageCount}개가 발주 필요 목록에 추가되었습니다.`:'발주서가 출고확정되었습니다.'),'success');
  if(currentView==='orders')renderOrders();
  else if(currentView==='dashboard')renderDashboard();
  });
}


function renderStatusTimeline(order){
  const history=order.statusHistory||[];
  if(history.length===0)return'';
  const statusColors={
    '임시저장':'#94a3b8','발주대기':'#f59e0b','발주확정':'#3b82f6',
    '출고준비':'#8b5cf6','출고완료':'#10b981','취소':'#ef4444','보관':'#6b7280'
  };
  // [2026-08-27] XSS 방어: h.note, h.changedByName 사용자 입력 유래 → escape 필수
  //   목록 셀은 이미 escape됐는데 이 타임라인만 누락되어 있었음 (patch 회귀)
  const _esc=(typeof escapeHtml==='function'?escapeHtml:(s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))));
  const items=history.map((h,i)=>{
    const color=statusColors[h.status]||'#94a3b8';
    const isLast=i===history.length-1;
    const dt=h.changedAt?fmtDt(h.changedAt):'-';
    const nameEsc=h.changedByName?_esc(h.changedByName):'';
    const noteEsc=h.note?_esc(h.note):'';
    return`<div style="display:flex;gap:12px;align-items:flex-start">
      <div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0">
        <div style="width:12px;height:12px;border-radius:50%;background:${color};margin-top:3px;flex-shrink:0;border:2px solid ${color}33"></div>
        ${!isLast?`<div style="width:2px;flex:1;background:#e5e7eb;min-height:20px;margin:2px 0"></div>`:''}
      </div>
      <div style="padding-bottom:${isLast?0:14}px;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="background:${color}18;color:${color};border:1px solid ${color}44;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:700">${_esc(h.status)}</span>
          <span style="font-size:11px;color:#9ca3af">${dt}</span>
          ${nameEsc?`<span style="font-size:11px;color:#6b7280">${nameEsc}</span>`:''}
        </div>
        ${noteEsc?`<div style="font-size:12px;color:#6b7280;margin-top:3px">${noteEsc}</div>`:''}
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
  const inp=_findUpperControl(matName,'.upper-qty');
  if(!inp)return [];
  try{return JSON.parse(inp.dataset.splits||'[]');}catch{return [];}
}

function setRowLengthSplits(matName,splits){
  const inp=_findUpperControl(matName,'.upper-qty');
  if(!inp)return;
  inp.dataset.splits=JSON.stringify(splits||[]);
  // 셀 표시 갱신 — matName에 특수문자(따옴표·백슬래시) 포함 시 selector 파싱 실패 방어
  const matEsc=(typeof CSS!=='undefined'&&CSS.escape)?CSS.escape(matName):matName;
  const btn=document.querySelector(`.upper-split-btn[data-mat="${matEsc}"]`);
  const noteEl=_findUpperControl(matName,'.upper-note');
  const splitInfoEl=document.querySelector(`.upper-split-info[data-mat="${matEsc}"]`);
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
  // matName selector 안전화 (특수문자 방어)
  const matEsc=(typeof CSS!=='undefined'&&CSS.escape)?CSS.escape(matName):matName;
  const expandRow=document.querySelector(`.upper-split-expand[data-mat="${matEsc}"]`);
  const btn=document.querySelector(`.upper-split-btn[data-mat="${matEsc}"]`);
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
  const qtyInp=_findUpperControl(matName,'.upper-qty');
  const totalQty=parseInt(qtyInp?.value)||0;
  if(totalQty<=0){toast('수량을 먼저 입력해주세요.','error');return;}
  const stdLen=POSTBAR_STD_LENGTH[matName]||0;
  const current=getRowLengthSplits(matName);
  let splits=current.length>0?JSON.parse(JSON.stringify(current)):[{qty:totalQty,length:stdLen}];
  const formEl=expandRow.querySelector('.split-form');
  // XSS 방어: matName은 items 마스터에서 올 수 있어 escape
  const _matNameE=(typeof _escHtml==='function')?_escHtml(matName):matName;
  formEl.innerHTML=`
    <div style="font-size:13px;color:#1e40af;margin-bottom:10px"><strong style="color:#0f172a">${_matNameE}</strong> — 발주 수량 ${totalQty}개 · 정척 ${stdLen}mm</div>
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
        <input type="number" class="form-input split-len" value="${s.length}" min="1" placeholder="길이(mm)" style="width:130px;padding:6px 24px 6px 8px;font-size:13px"/>
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
