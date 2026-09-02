// ── 단가 / 금액 계산 ──
// 상수, 단가 조회, 금액 계산 순수 함수 모음
// 의존: js/store/db.js (DB), js/utils/uiUtils.js (없음)

// ── 상부자재 품목 목록 ──
const UPPER_FIXED = [
  '포스트바 2050','포스트바 2250','포스트바 2400',
  '선반바(ABS) 400',
];
const UPPER_EA = [
  '코너바 2200',
  '코너앵글','조절발','포스트마감캡',
  '옷봉캡','코너 옷봉캡 (단방, 양방)',
  '포스트연결캡','조절발 연장캡 15mm',
  '벽고정앵글','스패너',
];

// 포스트바 구버전 이름 호환 매핑
// (발주서 저장명 → 품목 마스터 등록명)
const UPPER_COMPAT={
  // UPPER_FIXED: 발주서는 "포스트바 XXXX" / 품목 마스터는 "포스트 XXXX"
  '포스트바 2050':'포스트 2050',
  '포스트바 2250':'포스트 2250',
  '포스트바 2400':'포스트 2400',
  // 선반바: 발주서는 "(ABS)" 포함 / 품목 마스터는 없음
  '선반바(ABS) 400':'선반바 400',
  // 구버전 포스트바 이름
  '포스트바 2000':'포스트 2050',
  '포스트바 2100':'포스트 2050',
  '포스트바 2150':'포스트 2050',
  '포스트바 2300':'포스트 2250',
  '포스트바 2200':'포스트 2250',
  // 옷봉캡 계열
  '옷봉캡':'옷봉캡',
  '옷봉캡(단방)':'옷봉캡',
  '옷봉캡(양방)':'옷봉캡',
  '코너 옷봉캡 (단방, 양방)':'코너옷봉캡',
  '코너 옷봉캡(단방)':'코너옷봉캡',
  '코너 옷봉캡(양방)':'코너옷봉캡',
  '포스트조절발(연장캡 15mm)':'조절발 연장캡 15mm',
  '조절방 연장캡 15mm':'조절발 연장캡 15mm',
  '인출식 바지걸이':'인출식 바지걸이',
};
function compatUpperName(n){return UPPER_COMPAT[n]||n;}

// ── 단가 맵 ──
const PRICE_MAP = {
  '포스트바 2050': 9500,
  '포스트바 2250': 10000,
  '포스트바 2400': 10500,
  '선반바(ABS) 400': 2000,
  '코너바 2200': 5800,
  '코너앵글': 400,
  '조절발': 900,
  '포스트마감캡': 200,
  '옷봉 2400': 4500,
  '옷봉캡': 350,
  '코너 옷봉캡 (단방, 양방)': 500,
  '조절발 연장캡 15mm': 400,
  '인출식 바지걸이': 39000,
  '선반재단비': 1000,
  '포스트조립비': 3000,
  '벽고정앵글': 600,
  '스패너': 2000,
  '포스트연결캡': 500,
  '선반 770': 4600,
  '선반 570': 3600,
  '선반 370': 2700,
  '선반 2400': 13500,
  '선반 비규격': 7500,
  '코너선반 780': 11000,
  '코너선반 비규격': 20000,
};

// 서랍/옵션 단가
const DRAWER_OPTION_PRICES = {
  "겉서랍 2단": 60000,
  "속서랍 2단": 60000,
  "겉서랍 3단": 80000,
  "속서랍 3단": 80000,
  "겉서랍 4단": 120000,
  "속서랍 4단": 120000,
  "겉서랍 아일랜드": 13000,
  "속서랍 아일랜드": 63000,
  "거울장": 125000,
  "디바이더": 50000,
  "이불장": 80000,
  "이불 반장": 80000,
  "이불 긴장": 220000,
  "화장대세트": 180000,
  "인출식 바지걸이": 39000,
  "선반재단비": 1000,
  "포스트조립비": 3000,
  "공간박스": null,
};

// 단가 관리 UI 표시 라벨
const PRICE_DISPLAY_LABEL = {
  '선반 370':        '선반  370mm ~ 400mm',
  '선반 570':        '선반  570mm ~ 600mm',
  '선반 770':        '선반  770mm ~ 800mm',
  '선반 비규격':     '선반  비규격 (800mm 초과 ~ 1200mm 이하)',
  '선반 2400':       '선반  1200mm 이상 ~ 2400mm 이하',
  '코너선반 780':    '코너선반  780×585mm 이하',
  '코너선반 비규격': '코너선반  780×585mm 초과 (비규격)',
};
const PRICE_HIDDEN = new Set(['2단서랍장+손잡이','3단서랍장+손잡이','4단서랍장+손잡이']);

// 상부자재 색상
const UPPER_COLORS=['화이트','블랙','실버','샴페인골드'];
const UPPER_COLOR_KEYS={'화이트':'white','블랙':'black','실버':'silver','샴페인골드':'champagne'};

// 선반/코너선반 색상
const SHELF_COLORS = ['화이트 오크','솔리드','메이플','다크월넛','진그레이','스톤그레이','민트그린'];
const SHELF_SIZES  = {'코너선반': []};

// ── 단가 조회 함수 ──

function normalizeName(name){
  return String(name||'').replace(/\s+/g,'').trim();
}

// 괄호·구두점·공백 전부 제거 — 이름 형식 차이가 있어도 매칭되도록
function aggressiveNormalize(name){
  return String(name||'').replace(/[\s\(\)\[\]\.,·\-（）,、]/g,'').trim();
}

// 앱 색상명 → colorProdCdMap/이카운트 조회용 키 변환
// 앱: 샴페인골드  /  이카운트·DB 입력: 골드  → 동일 취급
const COLOR_KEY_ALIAS={'샴페인골드':'골드'};
function resolveColorKey(color){
  return COLOR_KEY_ALIAS[color]||color;
}

function findPriceInMap(map, name){
  const normalized=normalizeName(name);
  for(const [key,value] of Object.entries(map)){
    if(normalizeName(key)===normalized)return value;
  }
  return undefined;
}

function getUnitPrice(name){
  const normalized=normalizeName(name);
  if(!normalized)return null;
  const drawerPrice=findPriceInMap(DRAWER_OPTION_PRICES,name);
  if(drawerPrice!==undefined)return drawerPrice;
  const directPrice=findPriceInMap(PRICE_MAP,name);
  if(directPrice!==undefined)return directPrice;
  const shelfPrice=findPriceInMap(PRICE_MAP,'선반 '+name);
  if(shelfPrice!==undefined)return shelfPrice;
  if(/^\d+$/.test(normalized))return PRICE_MAP['선반 비규격'];
  return null;
}

function getDefaultPrices(){
  const all=[];
  const upperItems=[...UPPER_FIXED,...UPPER_EA];
  upperItems.forEach(n=>all.push({name:n,category:'상부자재',price:PRICE_MAP[n]??null}));
  all.push({name:'옷봉 2400',category:'옷봉',price:PRICE_MAP['옷봉 2400']??null});
  ['선반 770','선반 570','선반 370','선반 2400','선반 비규격'].forEach(n=>all.push({name:n,category:'선반',price:PRICE_MAP[n]??null}));
  ['코너선반 780','코너선반 비규격'].forEach(n=>all.push({name:n,category:'코너선반',price:PRICE_MAP[n]??null}));
  Object.entries(DRAWER_OPTION_PRICES).forEach(([n,p])=>all.push({name:n,category:'서랍/옵션',price:p}));
  return all;
}

function getPriceSettings(){
  let ps=DB.get('price_settings',null);
  if(!ps||!Array.isArray(ps)||ps.length===0){
    ps=getDefaultPrices();
    DB.set('price_settings',ps);
  }
  return ps;
}

function getUnitPriceFromSettings(name){
  const n=normalizeName(name);
  if(!n)return null;
  const ps=DB.get('price_settings',null);
  if(ps&&Array.isArray(ps)){
    const found=ps.find(p=>normalizeName(p.name)===n);
    if(found!==undefined)return found.price;
  }
  return getUnitPrice(name);
}

function getActivePriceForItem(name){
  return getUnitPriceFromSettings(name);
}

function getCornerShelfPrice(w, h){
  const wi=parseInt(w)||0;
  const hi=parseInt(h)||0;
  return (wi<=780&&hi<=585)
    ? (getUnitPriceFromSettings('코너선반 780')??11000)
    : (getUnitPriceFromSettings('코너선반 비규격')??20000);
}

function getShelfPrice(size){
  const mm=parseInt(size);
  if(isNaN(mm)) return getUnitPriceFromSettings('선반 비규격')??7500;
  if(mm<370)           return getUnitPriceFromSettings('선반 370')??2700;
  if(mm>=370&&mm<=400) return getUnitPriceFromSettings('선반 370')??2700;
  if(mm>=570&&mm<=600) return getUnitPriceFromSettings('선반 570')??3600;
  if(mm>=770&&mm<=800) return getUnitPriceFromSettings('선반 770')??4600;
  if(mm>800&&mm<=1200) return getUnitPriceFromSettings('선반 비규격')??7500;
  if(mm>1200)          return getUnitPriceFromSettings('선반 2400')??13500;
  return getUnitPriceFromSettings('선반 비규격')??7500;
}

// ── 선반 사이즈 → 이카운트 품목코드 매핑 ──
// 색상 키는 앱 내부 표기 그대로 사용 (주문서에 저장된 값과 동일하게 맞춤)
// 이카운트 PROD_CD 기준 (2024 fetch 결과)
const SHELF_ECOUNT_CODES = {
  '선반 370':     {'솔리드':'051','화이트 오크':'052','메이플':'053','다크월넛':'054','진그레이':'055','스톤그레이':'056','민트그린':'00027'},
  '선반 470':     {'솔리드':'211','화이트 오크':'212','메이플':'213','다크월넛':'214','진그레이':'215','스톤그레이':'216'},
  '선반 570':     {'솔리드':'057','화이트 오크':'058','메이플':'059','다크월넛':'060','진그레이':'061','스톤그레이':'062','민트그린':'00026'},
  '선반 670':     {'솔리드':'217','화이트 오크':'218','메이플':'219','다크월넛':'220','진그레이':'221','스톤그레이':'222'},
  '선반 770':     {'솔리드':'063','화이트 오크':'064','메이플':'065','다크월넛':'066','진그레이':'067','스톤그레이':'068','민트그린':'00025'},
  '선반 900':     {'솔리드':'223','화이트 오크':'224','메이플':'225','다크월넛':'226','진그레이':'227','스톤그레이':'228'},
  '비규격 선반':  {'솔리드':'069','화이트 오크':'070','메이플':'071','다크월넛':'072','진그레이':'073','스톤그레이':'074'},
  '선반 2400':    {'솔리드':'075','화이트 오크':'076','메이플':'077','다크월넛':'078','진그레이':'079','스톤그레이':'080','민트그린':'00024'},
};
const CORNER_SHELF_ECOUNT_CODES = {
  '코너선반':        {'솔리드':'081','화이트 오크':'082','메이플':'083','다크월넛':'084','진그레이':'085','스톤그레이':'086','민트그린':'00023'},
  '비규격 코너선반': {'솔리드':'087','화이트 오크':'088','메이플':'089','다크월넛':'090','진그레이':'091','스톤그레이':'092','민트그린':'00028'},
};

function getShelfEcountCode(size,color){
  const mm=parseInt(size);
  if(isNaN(mm))return null;
  let key;
  if(mm>=370&&mm<=435)       key='선반 370';
  else if(mm>435&&mm<=520)   key='선반 470';
  else if(mm>520&&mm<=620)   key='선반 570';
  else if(mm>620&&mm<=720)   key='선반 670';
  else if(mm>720&&mm<=835)   key='선반 770';
  else if(mm>835&&mm<=1000)  key='선반 900';
  else if(mm>1000&&mm<=1200) key='비규격 선반';
  else if(mm>1200)           key='선반 2400';
  else return null;
  return SHELF_ECOUNT_CODES[key]?.[color]||null;
}

function getCornerShelfEcountCode(w,h,color){
  const wi=parseInt(w)||0,hi=parseInt(h)||0;
  const key=(wi<=780&&hi<=585)?'코너선반':'비규격 코너선반';
  return CORNER_SHELF_ECOUNT_CODES[key]?.[color]||null;
}

// ── 금액 계산 함수 ──

function fmtAmt(v){
  if(v===null||v===undefined||isNaN(v))return '-';
  return Number(v).toLocaleString('ko-KR')+'원';
}

function getVatAmount(supply){
  if(supply===null||supply===undefined||isNaN(supply))return null;
  return Math.round(supply*0.1);
}

function getLineFinancial(unitPrice, qty){
  if(unitPrice===null||unitPrice===undefined){
    return {unitPrice:null,supplyAmount:null,vatAmount:null,totalAmount:null};
  }
  const supply=unitPrice*(qty||0);
  const vat=getVatAmount(supply);
  return {unitPrice,supplyAmount:supply,vatAmount:vat,totalAmount:supply+vat};
}

function getOrderFinancialSummary(order){
  const dbItems=DB.get('items',[]);
  let totalSupply=0;
  (order.upperMaterials||[]).forEach(r=>{
    let qty=r.qty||0;
    if(!qty){for(const k of ['white','black','silver','champagne'])if(r[k]>0){qty=r[k];break;}}
    const supply=(r.amount!==undefined&&r.amount!==null)?r.amount
      :(r.unitPrice!==undefined&&r.unitPrice!==null)?r.unitPrice*qty:null;
    if(supply!==null&&!isNaN(supply)){totalSupply+=supply;}
    else{const p=getActivePriceForItem(compatUpperName(r.name||''));if(p!==null)totalSupply+=p*qty;}
  });
  if((order.rodItems||[]).length>0){
    const rodPrice=getActivePriceForItem('옷봉 2400')||4500;
    totalSupply+=rodPrice*(order.rod2400Required||0);
  }
  (order.shelfItems||[]).forEach(si=>{
    (si.entries||[]).forEach(e=>{
      const supply=(e.amount!==undefined&&e.amount!==null)?e.amount:null;
      if(supply!==null){totalSupply+=supply;}
      else{
        const price=si.name==='코너선반'?getCornerShelfPrice(e.width,e.height):getShelfPrice(e.size);
        totalSupply+=price*(e.qty||0);
      }
    });
  });
  (order.drawerItems||order.items||[]).forEach(di=>{
    const qty=di.requiredQty||0;
    const supply=(di.amount!==undefined&&di.amount!==null)?di.amount
      :(di.unitPrice!==undefined&&di.unitPrice!==null)?di.unitPrice*qty:null;
    if(supply!==null&&!isNaN(supply)){totalSupply+=supply;}
    else{const it=dbItems.find(i=>i.id===di.itemId);if(it){const p=getActivePriceForItem(it.name);if(p!==null)totalSupply+=p*qty;}}
  });
  const vat=Math.round(totalSupply*0.1);
  return {totalSupply,totalVat:vat,grandTotal:totalSupply+vat};
}

// ── 금액 HTML 헬퍼 ──

function supplyAmtHtml(v){
  if(v===null||v===undefined)return '<span style="color:var(--text-3);font-size:12px">미정</span>';
  return `<span style="color:#0f172a;font-weight:800;font-size:14px">${fmtAmt(v)}</span>`;
}
function vatAmtHtml(v){
  if(v===null||v===undefined)return '<span style="color:var(--text-3);font-size:12px">미정</span>';
  return `<span style="color:#475569;font-weight:700;font-size:13px">${fmtAmt(v)}</span>`;
}
function amtHtml(v){
  if(v===null||v===undefined)return '<span style="color:var(--text-3);font-size:12px">미정</span>';
  return `<span style="color:#0f172a;font-weight:800;font-size:15px">${fmtAmt(v)}</span>`;
}
function unitPriceHtml(price){
  if(price===null||price===undefined)return '<span class="unit-price-text" style="color:var(--text-3)">미정</span>';
  return `<span class="unit-price-text" style="color:var(--text-2)">${price.toLocaleString('ko-KR')}원</span>`;
}
