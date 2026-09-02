// ── 엑셀 다운로드 / 발주서 문서 / 프린트 ──

// XSS 방지: 사용자 자유 입력 필드를 innerHTML에 주입하기 전 escape
function _escHtml(s){
  if(s===null||s===undefined)return '';
  return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function xlsxDownload(wb, filename){
  if(typeof XLSX==='undefined'){toast('엑셀 라이브러리를 불러오는 중입니다. 잠시 후 다시 시도해주세요.','error');return;}
  XLSX.writeFile(wb, filename, {bookType:'xlsx',type:'binary'});
}
function xlsxDate(){return new Date().toISOString().slice(0,10);}

// ── 단건 발주서 엑셀 다운로드 ──
async function downloadOrderExcel(order){
  if(!order){toast('발주 데이터가 없습니다.','error');return;}
  if(typeof ExcelJS==='undefined'){toast('엑셀 라이브러리를 불러오는 중입니다. 잠시 후 다시 시도해주세요.','error');return;}

  const dTo  = order.deliveryTo||order.siteName||'-';
  const addr = order.address||order.customerName||'-';
  const dbItems = DB.get('items',[]);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('발주서');
  ws.columns=[{width:21},{width:19},{width:13},{width:13},{width:50}];

  // ARGB 색상 (FF + RRGGBB)
  const NAVY='FF1e3a5f', WHITE='FFFFFFFF', ALT='FFF8FAFC';
  const SEC_HDR='FFe8ecf1', TH_BG='FFd0d8e0', LBL_BG='FFf1f5f9';
  const BDR='FFb0bec5', DARK='FF0F172A';
  const WON='#,##0"원"';
  const RH=27; // 통일 행 높이 (위아래 여백 확대)
  let R=1;

  // ── 헬퍼 ──
  function gc(row,col,val){
    const c=ws.getCell(row,col);
    if(val!==undefined) c.value=(val===null?'':val);
    return c;
  }
  function st(c,o){
    c.fill={type:'pattern',pattern:'solid',fgColor:{argb:o.bg||WHITE}};
    c.font={name:'맑은 고딕',size:o.sz||13,bold:!!o.bold,italic:!!o.italic,color:{argb:o.fc||DARK}};
    c.alignment={horizontal:o.h||'left',vertical:'center',wrapText:!!o.wrap};
    const bs=o.thick?'medium':'thin', bc={argb:o.bc||BDR};
    c.border={top:{style:bs,color:bc},bottom:{style:bs,color:bc},left:{style:bs,color:bc},right:{style:bs,color:bc}};
  }
  function fr(row,o){for(let c=1;c<=5;c++)st(gc(row,c),o);}
  function mg(r1,c1,r2,c2){ws.mergeCells(r1,c1,r2,c2);}
  function rh(row,h){ws.getRow(row).height=h||RH;}

  function wRow(val,o,h){fr(R,o);gc(R,1,val);mg(R,1,R,5);rh(R,h);R++;}
  function secRow(txt){wRow('  '+txt,{bg:SEC_HDR,bold:true});}
  function clrRow(nm){wRow('  색상 : '+nm,{bg:NAVY,fc:WHITE,bold:true});}
  function thRow(a,b,c,d,e){
    [a,b,c,d,e].forEach((t,i)=>st(gc(R,i+1,t||''),{bg:TH_BG,bold:true,h:'center'}));
    rh(R);R++;
  }
  function calcSup(u,q,s){
    if(s!==undefined&&s!==null)return s;
    if(u!==null&&u!==undefined)return u*q;
    return null;
  }
  function dataRow(name,qty,unitP,sup,note,alt){
    const bg=alt?ALT:WHITE;
    st(gc(R,1,name||''),{bg,h:'left'});
    st(gc(R,2,qty||''),{bg,h:'center'});
    const c3=gc(R,3,unitP!==null&&unitP!==undefined?unitP:'미정');
    st(c3,{bg,h:'right'}); if(typeof unitP==='number')c3.numFmt=WON;
    const c4=gc(R,4,sup!==null&&sup!==undefined?sup:'미정');
    st(c4,{bg,h:'right'}); if(typeof sup==='number')c4.numFmt=WON;
    st(gc(R,5,note||''),{bg,h:'left'});
    rh(R);R++;
  }

  // ── [A] 제목 ──
  fr(R,{bg:NAVY,fc:WHITE,sz:28,bold:true,h:'center',thick:true});
  gc(R,1,'발  주  서'); mg(R,1,R,5); rh(R,45.5); R++;

  // ── [B] 기본 정보 ──
  const lb={bg:LBL_BG,bold:true,h:'center'};
  const vl={bg:WHITE,h:'left'};
  const em={bg:WHITE};

  // 발주번호
  fr(R,em);
  st(gc(R,1,'발주번호'),lb); st(gc(R,2,order.orderNum||('#'+order.id)),vl); mg(R,2,R,3);
  rh(R); R++;
  // 납품처 / 발주일
  fr(R,em);
  st(gc(R,1,'납품처'),lb); st(gc(R,2,dTo),vl); mg(R,2,R,3);
  st(gc(R,4,'발  주  일'),lb); st(gc(R,5,(window.normalizeDateStr?window.normalizeDateStr(order.orderDate):order.orderDate)||'-'),vl);
  rh(R); R++;
  // 시공주소 / 출고일
  fr(R,em);
  st(gc(R,1,'시공주소'),lb); st(gc(R,2,addr),{...vl,wrap:true}); mg(R,2,R,3);
  st(gc(R,4,'출  고  일'),lb); st(gc(R,5,order.shipDate==='0000-00-00'?'미정':((window.normalizeDateStr?window.normalizeDateStr(order.shipDate):order.shipDate)||'-')),vl);
  rh(R); R++;
  // 비고(선택)
  if(order.note){
    fr(R,em);
    st(gc(R,1,'비고'),lb); st(gc(R,2,order.note),{...vl,wrap:true}); mg(R,2,R,5);
    rh(R); R++;
  }

  // ── [C] 상부 자재 ──
  const upperMats=order.upperMaterials||[];
  const hasRod=(order.rodItems||[]).length>0;
  if(upperMats.length>0||hasRod){
    secRow('■  상부 자재');
    thRow('품목','수량','단가','공급가액','비고(실사이즈)');
    const cmap=new Map(), cord=[];
    const cn={white:'화이트',black:'블랙',silver:'실버',champagne:'샴페인골드'};
    upperMats.forEach(r2=>{
      let color=r2.color||'',qty=r2.qty||0;
      // [2026-07-14] noColor는 명시적 r2.color === '' (color 프로퍼티 존재)만 판정 — 레거시(color 미존재)는 색상 fallback
      const _isNoColor = qty>0 && typeof r2.color==='string' && r2.color==='';
      if(!_isNoColor && (!color||!qty)){for(const k of ['white','black','silver','champagne']){if(r2[k]>0){color=cn[k];qty=r2[k];break;}}}
      if(!color)color = _isNoColor ? '색상없음' : '기타';
      if(!cmap.has(color)){cmap.set(color,[]);cord.push(color);}
      cmap.get(color).push({...r2,_qty:qty});
    });
    if(hasRod){
      const rodsByColor=new Map();
      (order.rodItems||[]).forEach(ri=>{
        if(!ri||!(Number(ri.size)>0)||!(Number(ri.qty)>0))return;
        const rc=ri.color||order.upperCommonColor||'기타';
        if(!rodsByColor.has(rc))rodsByColor.set(rc,[]);
        rodsByColor.get(rc).push(ri);
      });
      rodsByColor.forEach((entries,rc)=>{
        if(!cmap.has(rc)){cmap.set(rc,[]);cord.push(rc);}
        cmap.get(rc).push({_isRod:true,_entries:entries});
      });
    }
    cord.forEach(clr=>{
      clrRow(clr); let alt=false;
      cmap.get(clr).forEach(r2=>{
        if(r2._isRod){
          const entries=r2._entries||[];
          const rs=entries.map(ri=>`${ri.size}×${ri.qty}`).join(', ');
          const ru=order.rodUnitPrice!==null&&order.rodUnitPrice!==undefined&&order.rodUnitPrice!==''&&Number.isFinite(Number(order.rodUnitPrice))?Number(order.rodUnitPrice):(getActivePriceForItem('옷봉 2400')||4500);
          const rq=(typeof calcRod2400==='function')?calcRod2400(entries,clr):(order.rod2400Required||0);
          const totalLen=entries.reduce((sum,ri)=>sum+(Number(ri.size)||0)*(Number(ri.qty)||0),0);
          dataRow('옷봉 2400',rq+'개',ru,calcSup(ru,rq,null),`절단: ${rs} / 총 ${totalLen.toLocaleString()}mm`,alt);
        }else{
          const n=typeof compatUpperName==='function'?compatUpperName(r2.name):r2.name;
          const qty=r2._qty||r2.qty||0, up=r2.unitPrice!==undefined?r2.unitPrice:getActivePriceForItem(n);
          dataRow(n,qty+'개',up,calcSup(up,qty,r2.amount),r2.note||'',alt);
        }
        alt=!alt;
      });
    });
  }

  // ── [D] 선반 / 코너선반 ──
  if((order.shelfItems||[]).length>0){
    secRow('■  선반 / 코너선반');
    thRow('품목/규격','수량','단가','공급가액','');
    order.shelfItems.forEach(item=>{
      fr(R,{bg:WHITE,bold:true,h:'left'}); gc(R,1,'  '+item.name); mg(R,1,R,5); rh(R,16); R++;
      let alt=false;
      (item.entries||[]).forEach(e=>{
        const spec=item.name==='코너선반'?`${e.width} × ${e.height}`:e.size;
        const up=e.unitPrice!==undefined?e.unitPrice:(item.name==='코너선반'?getCornerShelfPrice(e.width,e.height):getShelfPrice(e.size));
        const color=e.color||order.sharedColor||'';
        dataRow('    '+spec+(color?` [${color}]`:''),e.qty+'개',up,calcSup(up,e.qty,e.amount),'',alt); alt=!alt;
      });
    });
  }

  // ── [E] 서랍 / 옵션 ──
  const dRows=order.drawerItems||order.items||[];
  if(dRows.length>0||order.drawerMemo){
    secRow('■  서랍 / 옵션');
    thRow('품목명','수량','단가','공급가액','');
    let alt=false;
    dRows.forEach(oi=>{
      const it=dbItems.find(i=>i.id===oi.itemId);
      const iName=it?it.name:'?';
      const up=oi.unitPrice!==undefined?oi.unitPrice:getActivePriceForItem(iName);
      const color=(it&&it.noColor)?'':(oi.color||order.sharedColor||'');
      dataRow(iName+(color?` [${color}]`:''),(oi.requiredQty||0)+'개',up,calcSup(up,oi.requiredQty||0,oi.amount),'',alt); alt=!alt;
    });
    if(order.drawerMemo){
      fr(R,{bg:'FFFFFBEB',fc:'FF92400E',sz:9,italic:true,wrap:true});
      gc(R,1,order.drawerMemo); mg(R,1,R,5); rh(R); R++;
    }
  }

  // ── [F] 기타 ──
  if(order.etcMemo){
    secRow('■  기타');
    fr(R,{bg:WHITE,wrap:true}); gc(R,1,order.etcMemo); mg(R,1,R,5); rh(R,40); R++;
  }

  // ── [G] 합계 ──
  const fin=getOrderFinancialSummary(order);
  const tSup=fin.totalSupply||0, tVat=fin.totalVat||Math.round(tSup*0.1), tTot=tSup+tVat;

  // 총 공급가액
  fr(R,{bg:WHITE}); st(gc(R,1,'총 공급가액'),{bg:WHITE,h:'left'}); mg(R,1,R,4);
  const cS=gc(R,5,tSup); st(cS,{bg:WHITE,bold:true,h:'right'}); cS.numFmt=WON; rh(R,22); R++;
  // 부가세
  fr(R,{bg:WHITE}); st(gc(R,1,'부가세 (10%)'),{bg:WHITE,h:'left'}); mg(R,1,R,4);
  const cV=gc(R,5,tVat); st(cV,{bg:WHITE,bold:true,h:'right'}); cV.numFmt=WON; rh(R,22); R++;
  // 합계금액
  fr(R,{bg:NAVY,fc:WHITE,bold:true,thick:true});
  st(gc(R,1,'합  계  금  액'),{bg:NAVY,fc:WHITE,sz:12,bold:true,thick:true}); mg(R,1,R,4);
  const cT=gc(R,5,tTot); st(cT,{bg:NAVY,fc:WHITE,sz:12,bold:true,h:'right',thick:true}); cT.numFmt=WON; rh(R,26); R++;

  // ── 파일 다운로드 ──
  const safeName=dTo.replace(/[\\/:*?"<>|]/g,'');
  const buf=await wb.xlsx.writeBuffer();
  const blob=new Blob([buf],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url;
  a.download=`발주서_${order.orderNum||order.id}_${safeName}_${xlsxDate()}.xlsx`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}


// ── 발주 목록 엑셀 다운로드 ──
function downloadOrderListExcel(){
  if(typeof XLSX==='undefined'){toast('엑셀 라이브러리를 불러오는 중입니다. 잠시 후 다시 시도해주세요.','error');return;}
  const dbItems=DB.get('items',[]);
  const accounts=DB.get('accounts',[]);
  const orders=getOrders().filter(o=>{
    if(!isAdmin()&&o.createdBy&&o.createdBy!==currentUser.id)return false;
    if(o.status==='취소')return false;
    if(o.status==='보관'&&!orderShowArchived)return false;
    if(orderFilterShortage){const hasS=(o.drawerItems||o.items||[]).some(i=>i.shortageQty>0);if(!hasS)return false;}
    if(orderFilterSite){const dTo=o.deliveryTo||o.siteName||'';if(!dTo.includes(orderFilterSite))return false;}
    return true;
  }).sort((a,b)=>b.id-a.id);

  if(orders.length===0){toast('다운로드할 발주 내역이 없습니다.','error');return;}

  const header=['발주번호','발주일','납품처','시공주소','상태','총 품목 수','총 수량','비고','작성자'];
  const rows=orders.map(o=>{
    const creator=accounts.find(a=>a.id===o.createdBy);
    const drawerRows=o.drawerItems||o.items||[];
    const totalQty=drawerRows.reduce((s,i)=>s+(i.requiredQty||0),0);
    const totalCount=drawerRows.length;
    return [
      o.orderNum||('#'+o.id),
      o.orderDate||'-',
      o.deliveryTo||o.siteName||'-',
      o.address||o.customerName||'-',
      o.status||'-',
      totalCount,
      totalQty,
      o.note||'',
      creator?creator.name:(o.createdBy||'-'),
    ];
  });

  const wb=XLSX.utils.book_new();
  const ws=XLSX.utils.aoa_to_sheet([header,...rows]);

  // 헤더 행 스타일 적용
  const sTH={font:{name:'맑은 고딕',sz:10,bold:true,color:{rgb:'0F172A'}},
    fill:{patternType:'solid',fgColor:{rgb:'DBEAFE'}},
    alignment:{horizontal:'center',vertical:'center'},
    border:{top:{style:'medium',color:{rgb:'1D4ED8'}},
            bottom:{style:'medium',color:{rgb:'1D4ED8'}},
            left:{style:'thin',color:{rgb:'93C5FD'}},
            right:{style:'thin',color:{rgb:'93C5FD'}}}};
  const sAlt={font:{name:'맑은 고딕',sz:10},
    fill:{patternType:'solid',fgColor:{rgb:'F8FAFC'}},
    alignment:{horizontal:'left',vertical:'center'},
    border:{top:{style:'thin',color:{rgb:'CBD5E1'}},
            bottom:{style:'thin',color:{rgb:'CBD5E1'}},
            left:{style:'thin',color:{rgb:'CBD5E1'}},
            right:{style:'thin',color:{rgb:'CBD5E1'}}}};
  const sNorm={...sAlt, fill:{patternType:'solid',fgColor:{rgb:'FFFFFF'}}};
  header.forEach((_,c)=>{
    const a=XLSX.utils.encode_cell({r:0,c});
    if(ws[a]) ws[a].s=sTH;
  });
  rows.forEach((_,ri)=>{
    const sRow=ri%2===0?sNorm:sAlt;
    header.forEach((_,c)=>{
      const a=XLSX.utils.encode_cell({r:ri+1,c});
      if(ws[a]) ws[a].s=sRow;
    });
  });

  ws['!cols']=[{wch:16},{wch:12},{wch:18},{wch:22},{wch:10},{wch:9},{wch:9},{wch:20},{wch:12}];
  ws['!rows']=[{hpt:20},...rows.map(()=>({hpt:18}))];
  ws['!pageSetup']={paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0};
  XLSX.utils.book_append_sheet(wb, ws, '발주 목록');
  xlsxDownload(wb, `발주목록_${xlsxDate()}.xlsx`);
}

// ── 재고 현황 엑셀 다운로드 ──
function downloadInventoryExcel(){
  if(typeof XLSX==='undefined'){toast('엑셀 라이브러리를 불러오는 중입니다. 잠시 후 다시 시도해주세요.','error');return;}
  const categoryOrder={'서랍장':0,'옵션':1,'상부자재':2,'옷봉':3,'선반':4,'코너선반':5};
  const items=getItems()
    .filter(i=>i.isActive&&isTrackStock(i)&&i.drawerType!=='handle')
    .sort((a,b)=>(categoryOrder[a.category]??99)-(categoryOrder[b.category]??99)||a.name.localeCompare(b.name,'ko'));
  if(items.length===0){toast('재고 품목이 없습니다.','error');return;}
  // [2026-07-24 Codex-Medium-6] 창고별(시흥/평택/오산) + 발주가능(시흥+평택) + 물리합계 구분 출력
  const header=['품목명','구분','세부유형','시흥','평택','오산*','발주가능(시흥+평택)','물리합계','상태'];
  const rows=items.map(i=>{
    const s=(i.stockSiheung!==undefined?i.stockSiheung:i.currentStock)||0;
    const p=i.stockPyeongtaek||0;
    const o=i.stockOsan||0;
    const orderable=s+p;
    const physical=orderable+o;
    const status=orderable===0?'재고없음':orderable<=3?'부족':'정상';
    return[i.name,i.category||'-',i.drawerType||'-',s,p,o,orderable,physical,status];
  });
  const wb=XLSX.utils.book_new();
  const ws=XLSX.utils.aoa_to_sheet([header,...rows]);
  const sTH={font:{name:'맑은 고딕',sz:10,bold:true},fill:{patternType:'solid',fgColor:{rgb:'DBEAFE'}},
    alignment:{horizontal:'center',vertical:'center'},
    border:{top:{style:'medium',color:{rgb:'1D4ED8'}},bottom:{style:'medium',color:{rgb:'1D4ED8'}},
            left:{style:'thin',color:{rgb:'93C5FD'}},right:{style:'thin',color:{rgb:'93C5FD'}}}};
  header.forEach((_,c)=>{const a=XLSX.utils.encode_cell({r:0,c});if(ws[a])ws[a].s=sTH;});
  rows.forEach((row,ri)=>{
    // 상태 판정은 발주가능(index 6) 기준
    const bg=row[6]===0?'FEF2F2':row[6]<=3?'FFFBEB':'FFFFFF';
    const s={font:{name:'맑은 고딕',sz:10},fill:{patternType:'solid',fgColor:{rgb:bg}},
      alignment:{horizontal:'left',vertical:'center'},
      border:{top:{style:'thin',color:{rgb:'CBD5E1'}},bottom:{style:'thin',color:{rgb:'CBD5E1'}},
              left:{style:'thin',color:{rgb:'CBD5E1'}},right:{style:'thin',color:{rgb:'CBD5E1'}}}};
    header.forEach((_,c)=>{const a=XLSX.utils.encode_cell({r:ri+1,c});if(ws[a])ws[a].s=s;});
  });
  ws['!cols']=[{wch:22},{wch:10},{wch:12},{wch:8},{wch:8},{wch:8},{wch:16},{wch:10},{wch:8}];
  ws['!rows']=[{hpt:20},...rows.map(()=>({hpt:18}))];
  XLSX.utils.book_append_sheet(wb,ws,'재고 현황');
  xlsxDownload(wb,`재고현황_${xlsxDate()}.xlsx`);
}

// ── 발주서 문서 HTML 생성 (상세보기 + 인쇄 공유) ──
function renderOrderDocument(order){
  // 자유 입력 필드는 모두 _escHtml로 감싸 XSS 방지
  const dTo=_escHtml(order.deliveryTo||order.siteName||'-');
  const addr=_escHtml(order.address||order.customerName||'-');
  const dbItems=DB.get('items',[]);

  // 공통: 행 금액 표시 헬퍼
  function docColorRow(color,cols){
    if(!color)return '';
    const map={
      '화이트':'background:#334155;color:#f8fafc',
      '블랙':'background:#111827;color:#f9fafb',
      '실버':'background:#475569;color:#f1f5f9',
      '샴페인골드':'background:#78350f;color:#fef3c7'
    };
    const st=map[color]||'background:#1e3a5f;color:#e0f2fe';
    return `<tr><td colspan="${cols}" style="${st};font-weight:800;font-size:12px;padding:6px 12px;border:1px solid #888;letter-spacing:.05em">색상 : ${color}</td></tr>`;
  }
  function rowAmt(supply,vat){
    const s=(supply!==null&&supply!==undefined)?supply.toLocaleString('ko-KR')+'원':'미정';
    const v=(vat!==null&&vat!==undefined)?vat.toLocaleString('ko-KR')+'원':'미정';
    return {s,v};
  }

  // 상부 자재
  let upperRows='';
  if((order.upperMaterials&&order.upperMaterials.length>0)||(order.rodItems&&order.rodItems.length>0)){
    order.upperMaterials.forEach(r=>{
      const n=typeof compatUpperName==='function'?compatUpperName(r.name):r.name;
      let color=r.color||''; let qty=r.qty||0;
      if(!color||!qty){
        const cm={white:'화이트',black:'블랙',silver:'실버',champagne:'샴페인골드'};
        for(const k of ['white','black','silver','champagne']){if(r[k]>0){color=cm[k];qty=r[k];break;}}
      }
      const up=r.unitPrice!==undefined?r.unitPrice:getActivePriceForItem(n);
      const upStr=up!==null&&up!==undefined?up.toLocaleString('ko-KR')+'원':'미정';
      // 길이 분할: 분할별로 행 분리 출력 (포스트바)
      const splits=Array.isArray(r.lengthSplits)?r.lengthSplits:null;
      if(splits&&splits.length>0){
        splits.forEach(sp=>{
          const sQty=sp.qty||0;
          const sSupply=up!==null?up*sQty:null;
          const sVat=sSupply!==null?Math.round(sSupply*0.1):null;
          const {s:sStr}=rowAmt(sSupply,sVat);
          const stdLen={'포스트바 2050':2050,'포스트바 2250':2250,'포스트바 2400':2400}[n]||0;
          const isStd=Number(sp.length)===stdLen;
          const noteHtml=`<span style="font-size:13px;font-weight:800;color:#111">실제길이: ${sp.length}mm${isStd?' (정척)':''}</span>`;
          upperRows+=`<tr><td class="doc-name">${_escHtml(n)}${color?' ['+_escHtml(color)+']':''}</td><td class="doc-num">${sQty}개</td><td class="doc-note" style="text-align:right">${upStr}</td><td class="doc-note" style="text-align:right;font-weight:700">${sStr}</td><td class="doc-note doc-note-bigo" style="text-align:center">${noteHtml}</td></tr>`;
          upperRows+=`<tr class="doc-mobile-note-row"><td colspan="4">실제길이: ${sp.length}mm${isStd?' (정척)':''}</td></tr>`;
        });
      }else{
        const supply=r.amount!==undefined?r.amount:(up!==null?up*qty:null);
        const vat=supply!==null?Math.round(supply*0.1):null;
        const {s,v}=rowAmt(supply,vat);
        const noteDisp=r.note?`<span style="font-size:13px;font-weight:800;color:#111">실제길이: ${_escHtml(r.note)}mm</span>`:'';
        upperRows+=`<tr><td class="doc-name">${_escHtml(n)}${color?' ['+_escHtml(color)+']':''}</td><td class="doc-num">${qty}개</td><td class="doc-note" style="text-align:right">${upStr}</td><td class="doc-note" style="text-align:right;font-weight:700">${s}</td><td class="doc-note doc-note-bigo${noteDisp?'':' doc-note-empty'}" style="text-align:center">${noteDisp}</td></tr>`;
        if(r.note) upperRows+=`<tr class="doc-mobile-note-row"><td colspan="4">실제길이: ${_escHtml(r.note)}mm</td></tr>`;
      }
    });
    if(order.rodItems&&order.rodItems.length>0){
      const rodUp=order.rodUnitPrice!==null&&order.rodUnitPrice!==undefined&&order.rodUnitPrice!==''&&Number.isFinite(Number(order.rodUnitPrice))?Number(order.rodUnitPrice):(getActivePriceForItem('옷봉 2400')||4500);
      const rodsByColor={};
      order.rodItems.forEach(e=>{
        const color=e.color||order.upperCommonColor||'';
        (rodsByColor[color]||=[]).push(e);
      });
      Object.entries(rodsByColor).forEach(([color,entries])=>{
        const qty=(typeof calcRod2400==='function')?calcRod2400(entries,color):(order.rod2400Required||0);
        const rodSizes=entries.map(e=>`${e.size}×${e.qty}`).join(', ');
        const totalLen=entries.reduce((sum,e)=>sum+(parseInt(e.size,10)||0)*(Number(e.qty)||0),0);
        const noteStr=`${rodSizes} / 총${totalLen.toLocaleString()}mm`;
        const rodSupply=rodUp*qty;
        const {s}=rowAmt(rodSupply,Math.round(rodSupply*0.1));
        upperRows+=`<tr><td class="doc-name">옷봉 2400${color?' ['+_escHtml(color)+']':''}</td><td class="doc-num">${qty}개</td><td class="doc-note" style="text-align:right">${rodUp.toLocaleString()}원</td><td class="doc-note" style="text-align:right;font-weight:700">${s}</td><td class="doc-note doc-note-bigo" style="font-size:12px;font-weight:700;color:#111">${noteStr}</td></tr>`;
      });
    }
  }
  const upperSection=upperRows?`
    <div class="doc-section">
      <div class="doc-sec-title">상부 자재</div>
      <table class="doc-table">
        <thead><tr>
          <th class="doc-th-name">품목</th>
          <th class="doc-th-color">수량</th>
          <th class="doc-th-note" style="text-align:right">단가</th>
          <th class="doc-th-note" style="text-align:right">공급가액</th>
          <th class="doc-th-note" style="text-align:center;min-width:90px">비고</th>
        </tr></thead>
        <tbody>${docColorRow(order.upperCommonColor,5)}${upperRows}</tbody>
      </table>
    </div>`:'' ;

  // 선반 / 코너선반
  let shelfRows='';
  if(order.shelfItems&&order.shelfItems.length>0){
    order.shelfItems.forEach(item=>{
      shelfRows+=`<tr class="doc-sub-header"><td colspan="4">${_escHtml(item.name)}</td></tr>`;
      if(item.entries){
        item.entries.forEach(e=>{
          const spec=item.name==='코너선반'?`${e.width} × ${e.height}`:e.size;
          const up=e.unitPrice!==undefined?e.unitPrice:(item.name==='코너선반'?getCornerShelfPrice(e.width,e.height):getShelfPrice(e.size));
          const supply=e.amount!==undefined?e.amount:(up*e.qty);
          const vat=Math.round(supply*0.1);
          const {s,v}=rowAmt(supply,vat);
          const upStr=up!==null?up.toLocaleString('ko-KR')+'원':'미정';
          const color=e.color||order.sharedColor||'';
          shelfRows+=`<tr><td class="doc-name" style="padding-left:12px">${_escHtml(spec)}${color?' ['+_escHtml(color)+']':''}</td><td class="doc-num">${e.qty}개</td><td class="doc-note" style="text-align:right">${upStr}</td><td class="doc-note" style="text-align:right;font-weight:700">${s}</td></tr>`;
        });
      }
    });
  }
  const shelfSection=shelfRows?`
    <div class="doc-section">
      <div class="doc-sec-title">선반 / 코너선반</div>
      <table class="doc-table">
        <thead><tr>
          <th class="doc-th-name">품목/규격</th>
          <th class="doc-th-color">수량</th>
          <th class="doc-th-note" style="text-align:right">단가</th>
          <th class="doc-th-note" style="text-align:right">공급가액</th>
        </tr></thead>
        <tbody>${docColorRow(order.sharedColor,4)}${shelfRows}</tbody>
      </table>
    </div>`:'';

  // 서랍 / 옵션
  const dRows=(order.drawerItems||order.items||[]);
  let drawerRows='';
  dRows.forEach(oi=>{
    const it=dbItems.find(i=>i.id===oi.itemId);
    const dispColor=oi.color||order.sharedColor||'';
    const iName=it?it.name:'?';
    const up=oi.unitPrice!==undefined?oi.unitPrice:getActivePriceForItem(iName);
    const supply=oi.amount!==undefined?oi.amount:(up!==null?up*(oi.requiredQty||0):null);
    const vat=supply!==null?Math.round(supply*0.1):null;
    const {s,v}=rowAmt(supply,vat);
    const upStr=up!==null&&up!==undefined?up.toLocaleString('ko-KR')+'원':'미정';
    drawerRows+=`<tr><td class="doc-name">${_escHtml(iName)}${dispColor?' ['+_escHtml(dispColor)+']':''}</td><td class="doc-num">${oi.requiredQty}개</td><td class="doc-note" style="text-align:right">${upStr}</td><td class="doc-note" style="text-align:right;font-weight:700">${s}</td></tr>`;
  });
  if(order.drawerMemo) drawerRows+=`<tr><td colspan="4" class="doc-note" style="color:#555;font-style:italic">${_escHtml(order.drawerMemo)}</td></tr>`;
  const drawerSection=(drawerRows)?`
    <div class="doc-section">
      <div class="doc-sec-title">서랍 / 옵션</div>
      <table class="doc-table">
        <thead><tr>
          <th class="doc-th-name">품목명</th>
          <th class="doc-th-color">수량</th>
          <th class="doc-th-note" style="text-align:right">단가</th>
          <th class="doc-th-note" style="text-align:right">공급가액</th>
        </tr></thead>
        <tbody>${docColorRow(order.sharedColor,4)}${drawerRows}</tbody>
      </table>
    </div>`:'';

  const etcRow=order.etcMemo?`<div class="doc-section"><div class="doc-sec-title">기타</div><p class="doc-etc">${_escHtml(order.etcMemo)}</p></div>`:'';

  // 총합계 summary (공통 함수 활용)
  const fin=getOrderFinancialSummary(order);
  const summarySection=`
    <div class="doc-section" style="margin-top:8px">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr>
          <td style="padding:7px 12px;background:#f1f5f9;font-weight:700;color:#334155;width:50%">총 공급가액</td>
          <td style="padding:7px 12px;text-align:right;font-weight:700;color:#334155">${fin.totalSupply.toLocaleString('ko-KR')}원</td>
        </tr>
        <tr>
          <td style="padding:7px 12px;background:#f1f5f9;font-weight:700;color:#475569">부가세 (10%)</td>
          <td style="padding:7px 12px;text-align:right;font-weight:700;color:#475569">${fin.totalVat.toLocaleString('ko-KR')}원</td>
        </tr>
        <tr style="background:#1e3a5f">
          <td style="padding:9px 12px;font-weight:800;color:#fff;font-size:14px">합계금액</td>
          <td style="padding:9px 12px;text-align:right;font-weight:900;color:#fff;font-size:16px">${fin.grandTotal.toLocaleString('ko-KR')}원</td>
        </tr>
      </table>
    </div>`;

  return `<div class="doc-wrap">
    <div class="doc-header">
      <div class="doc-title">발 주 서</div>
    </div>
    <table class="doc-info-table">
      <tbody>
        <tr>
          <td class="doc-info-label">발주번호</td>
          <td class="doc-info-val" colspan="3" style="font-weight:700;letter-spacing:.04em">${order.orderNum||('#'+order.id)}</td>
        </tr>
        <tr>
          <td class="doc-info-label">납품처</td>
          <td class="doc-info-val">${dTo}</td>
          <td class="doc-info-label">발주일</td>
          <td class="doc-info-val">${(window.normalizeDateStr?window.normalizeDateStr(order.orderDate):order.orderDate)||'-'}</td>
        </tr>
        <tr>
          <td class="doc-info-label">시공주소</td>
          <td class="doc-info-val">${addr}</td>
          <td class="doc-info-label">출고일</td>
          <td class="doc-info-val">${order.shipDate==='0000-00-00'?'미정':((window.normalizeDateStr?window.normalizeDateStr(order.shipDate):order.shipDate)||'-')}</td>
        </tr>
        <tr>
          <td class="doc-info-label">출고 창고</td>
          <td class="doc-info-val" colspan="3"><span style="font-weight:700;color:${order.warehouse==='평택'?'#065f46':'#1e40af'}">${order.warehouse||'시흥'}</span></td>
        </tr>
        ${order.note?`<tr><td class="doc-info-label">비고</td><td class="doc-info-val" colspan="3">${_escHtml(order.note)}</td></tr>`:''}
        ${order.cancelReason?`<tr><td class="doc-info-label" style="color:#dc2626;font-weight:700">취소 사유</td><td class="doc-info-val" colspan="3" style="color:#dc2626">${_escHtml(order.cancelReason)}</td></tr>`:''}
      </tbody>
    </table>
    ${upperSection}${shelfSection}${drawerSection}${etcRow}${summarySection}
  </div>`;
}

function _showImageOverlay(dataURL,onClose,fileName){
  const overlay=document.createElement('div');
  overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;overflow-y:auto;padding:16px;box-sizing:border-box;';
  overlay.innerHTML=`
    <div style="width:100%;max-width:700px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:8px">
        <a id="__img_overlay_dl__" href="${dataURL}" download="${fileName||'발주서.png'}" style="background:#7c3aed;color:#fff;border:none;border-radius:8px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;text-decoration:none;white-space:nowrap"><i class="fas fa-download"></i> 저장</a>
        <span style="color:#fff;font-size:13px;flex:1;text-align:center">또는 이미지 꾹 눌러 저장</span>
        <button id="__img_overlay_close__" style="background:#374151;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap">닫기</button>
      </div>
      <img src="${dataURL}" style="width:100%;border-radius:8px;display:block;"/>
    </div>`;
  document.body.appendChild(overlay);
  const close=()=>{document.body.removeChild(overlay);if(onClose)onClose();};
  overlay.querySelector('#__img_overlay_close__').onclick=close;
}

function saveImageOrder(order){
  const baseName=(order.orderNum||(order.deliveryTo||order.siteName||'발주서')+'_'+((order.orderDate||'').replaceAll('-','')));
  const fileName=baseName+'.png';
  const imgBtn=document.getElementById('img-order-btn');
  if(imgBtn){imgBtn.disabled=true;imgBtn.innerHTML='<i class="fas fa-spinner fa-spin"></i> 이미지 생성 중...';}
  const resetBtn=()=>{if(imgBtn){imgBtn.disabled=false;imgBtn.innerHTML='<i class="fas fa-image"></i> 이미지 저장';}};

  const loadScript=(src,isLoaded)=>new Promise((res,rej)=>{
    if(isLoaded&&isLoaded()){res();return;}
    if(document.querySelector(`script[src="${src}"]`)){
      const t=setInterval(()=>{if(isLoaded&&isLoaded()){clearInterval(t);res();}},50);
      setTimeout(()=>{clearInterval(t);rej(new Error('script load timeout'));},10000);
      return;
    }
    const s=document.createElement('script');s.src=src;s.onload=res;s.onerror=rej;document.head.appendChild(s);
  });

  // 이전 렌더 wrap 잔여물 제거 (비정상 종료 대비)
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
    return html2canvas(wrap,{
      scale:2,
      useCORS:true,
      allowTaint:false,
      backgroundColor:'#ffffff',
      logging:false,
      width:794,
      windowWidth:794,
    }).then(canvas=>{
      document.body.removeChild(wrap);
      return canvas;
    });
  })
  .then(canvas=>{
    // toBlob 방식으로 메모리 효율화 (data URL 대비 삼성브라우저 crash 방지)
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

function savePdfOrder(order){
  const fileName=(order.orderNum||(order.deliveryTo||order.siteName||'발주서')+'_'+((order.orderDate||'').replaceAll('-','')))+'.pdf';
  const pdfBtn=document.getElementById('pdf-order-btn');
  if(pdfBtn){pdfBtn.disabled=true;pdfBtn.innerHTML='<i class="fas fa-spinner fa-spin"></i> PDF 생성 중...';}
  const resetBtn=()=>{if(pdfBtn){pdfBtn.disabled=false;pdfBtn.innerHTML='<i class="fas fa-file-pdf"></i> PDF 저장';}};

  const loadScript=(src,isLoaded)=>new Promise((res,rej)=>{
    if(isLoaded&&isLoaded()){res();return;}
    if(document.querySelector(`script[src="${src}"]`)){
      const t=setInterval(()=>{if(isLoaded&&isLoaded()){clearInterval(t);res();}},50);
      setTimeout(()=>{clearInterval(t);rej(new Error('script load timeout'));},10000);
      return;
    }
    const s=document.createElement('script');s.src=src;s.onload=res;s.onerror=rej;document.head.appendChild(s);
  });

  // html2canvas + jsPDF 로드
  loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',()=>!!window.html2canvas)
  .then(()=>loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',()=>!!window.jspdf))
  .then(()=>{
    // 화면 밖 794px 컨테이너 — CSS가 현재 DOM에 그대로 적용됨
    const wrap=document.createElement('div');
    wrap.id='__pdf_render_wrap__';
    wrap.style.cssText='position:fixed;left:-10000px;top:0;width:794px;background:#fff;z-index:99999;box-sizing:border-box;padding:24px 32px;';
    wrap.innerHTML=renderOrderDocument(order);
    document.body.appendChild(wrap);

    // 2 프레임 대기 (레이아웃 완전 계산 후 캡처)
    return new Promise(res=>requestAnimationFrame(()=>requestAnimationFrame(()=>res(wrap))));
  })
  .then(wrap=>{
    return html2canvas(wrap,{
      scale:2,
      useCORS:true,
      allowTaint:false,
      backgroundColor:'#ffffff',
      logging:false,
      width:794,
      windowWidth:794,
    }).then(canvas=>{
      document.body.removeChild(wrap);
      return canvas;
    });
  })
  .then(canvas=>{
    const {jsPDF}=window.jspdf;
    const pdf=new jsPDF({unit:'mm',format:'a4',orientation:'portrait'});
    const pdfW=pdf.internal.pageSize.getWidth();   // 210mm
    const pdfH=pdf.internal.pageSize.getHeight();  // 297mm
    const imgW=canvas.width;
    const imgH=canvas.height;

    // 항상 한 페이지에 맞춤: 폭 기준 비율 → 높이가 넘으면 전체 축소
    const scaledH=imgH*(pdfW/imgW);
    if(scaledH<=pdfH){
      // 자연스럽게 한 페이지에 들어올 때
      pdf.addImage(canvas,'JPEG',0,0,pdfW,scaledH,undefined,'FAST');
    } else {
      // 세로가 A4를 넘을 때 → 전체 축소하여 한 페이지에 강제 맞춤
      const ratio=pdfH/scaledH;
      const finalW=pdfW*ratio;
      const offsetX=(pdfW-finalW)/2;
      pdf.addImage(canvas,'JPEG',offsetX,0,finalW,pdfH,undefined,'FAST');
    }

    pdf.save(fileName);
    resetBtn();
    toast('PDF가 다운로드되었습니다.','success');
  })
  .catch(err=>{
    console.error('PDF 생성 오류:',err);
    resetBtn();
    toast('PDF 생성 중 오류가 발생했습니다.','error');
  });
}

function _printOrderNewWindow(order){
  const docHtml=renderOrderDocument(order);
  // 현재 페이지의 스타일 수집 — @media print 규칙 제외
  // (원본의 @media print에 body>*:not(#print-area){display:none}이 있어 새 창에서 내용이 숨겨지는 문제 방지)
  const styles=[...document.styleSheets].map(ss=>{
    try{
      return [...ss.cssRules]
        .filter(r=>!(r instanceof CSSMediaRule&&r.conditionText&&r.conditionText.includes('print')))
        .map(r=>r.cssText).join('\n');
    }catch(e){
      // 동일 origin 스타일시트만 @import 폴백 허용 (CSS injection 방지)
      try{const u=new URL(ss.href);if(u.origin===location.origin)return `@import url("${u.href}");`;}catch{}
      return '';
    }
  }).join('\n');
  const isMobile=/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const win=window.open('','_blank',isMobile?undefined:'width=800,height=1000');
  if(!win){toast('팝업이 차단됐습니다. 브라우저 설정에서 팝업 허용 후 다시 시도해주세요.','error');return;}
  win.document.write(`<!DOCTYPE html><html lang="ko"><head>
    <meta charset="UTF-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>발주서 인쇄</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css"/>
    <style>
      ${styles}
      body{margin:0;padding:16px;background:#fff}
      .doc-wrap{max-width:700px;margin:0 auto}
      @media print{
        body{padding:0}
        .no-print{display:none!important}
        @page{size:A4;margin:10mm 12mm}
        *{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
      }
    </style>
  </head><body>
    <div class="no-print" style="text-align:center;padding:12px 0 8px">
      <button onclick="window.print()" style="background:#1e3a5f;color:#fff;border:none;border-radius:6px;padding:10px 28px;font-size:15px;font-weight:700;cursor:pointer">🖨 인쇄</button>
    </div>
    <div class="doc-detail-wrap">${docHtml}</div>
    <script>window.onload=function(){setTimeout(function(){window.print();},400);};<\/script>
  </body></html>`);
  win.document.close();
}

function printOrder(order){
  // 모바일(Android/iOS): sessionStorage에 렌더링된 HTML 저장 후 print.html로 이동
  // — window.open()은 PWA 독립 실행 모드에서 차단될 수 있어 location.href 방식 사용
  if(/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)){
    try{
      sessionStorage.setItem('__print_doc__',renderOrderDocument(order));
      window.location.href='print.html';
    }catch(e){
      console.error('인쇄 이동 오류:',e);
      toast('인쇄 준비 중 오류가 발생했습니다.','error');
    }
    return;
  }

  const printBtn=document.getElementById('print-order-btn');
  if(printBtn){printBtn.disabled=true;printBtn.innerHTML='<i class="fas fa-spinner fa-spin"></i> 준비 중...';}
  const resetBtn=()=>{if(printBtn){printBtn.disabled=false;printBtn.innerHTML='<i class="fas fa-print"></i> 인쇄';}};

  try{
    const printArea=document.getElementById('print-area');
    if(!printArea){toast('인쇄 영역을 찾을 수 없습니다.','error');resetBtn();return;}

    const inner=document.createElement('div');
    inner.style.cssText='width:100%;max-width:794px;padding:24px 32px;box-sizing:border-box;background:#fff;margin:0 auto;';
    inner.innerHTML=renderOrderDocument(order);
    printArea.innerHTML='';
    printArea.appendChild(inner);

    // body 자식 요소들의 원래 인라인 display 값 저장
    const snapshot=[...document.body.children].map(el=>({el,display:el.style.display}));

    const setupPrint=()=>{
      // cssText에 !important는 Chrome에서 무시되므로 setProperty('important')를 사용
      snapshot.forEach(({el})=>{
        if(el!==printArea) el.style.setProperty('display','none','important');
      });
      printArea.style.setProperty('display','block','important');
      printArea.style.setProperty('position','static','important');
      printArea.style.setProperty('width','100%','important');
      printArea.style.setProperty('background','#fff','important');
      printArea.style.setProperty('-webkit-print-color-adjust','exact','important');
      printArea.style.setProperty('print-color-adjust','exact','important');
    };

    const cleanup=()=>{
      // setProperty('important')로 설정된 스타일은 removeProperty로만 제거 가능
      snapshot.forEach(({el,display})=>{
        el.style.removeProperty('display');
        if(display) el.style.setProperty('display',display);
      });
      ['display','position','width','background','-webkit-print-color-adjust','print-color-adjust']
        .forEach(p=>printArea.style.removeProperty(p));
      printArea.innerHTML='';
      window.removeEventListener('afterprint',cleanup);
      resetBtn();
    };

    window.addEventListener('afterprint',cleanup);

    // afterprint 미지원 브라우저(구형 Android WebView) 폴백
    if(!('onafterprint' in window)){
      const mql=window.matchMedia('print');
      const mqlCleanup=(e)=>{if(!e.matches){cleanup();mql.removeEventListener('change',mqlCleanup);}};
      mql.addEventListener('change',mqlCleanup);
    }

    setupPrint();
    window.print();
  }catch(err){
    console.error('인쇄 준비 오류:',err);
    resetBtn();
    toast('인쇄 준비 중 오류가 발생했습니다.','error');
  }
}
