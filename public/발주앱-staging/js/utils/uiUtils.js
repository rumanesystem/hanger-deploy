// UI Utilities Section
// Toast, modal, formatter, navigation utilities

function fmt(d){if(!d)return'-';if(d==='0000-00-00')return'미정';/* [2026-07-03] 옛 오염 데이터 정규화 후 표시 */if(typeof window!=='undefined'&&typeof window.normalizeDateStr==='function'){d=window.normalizeDateStr(d);}const dt=new Date(d);if(isNaN(dt.getTime()))return'-';return`${dt.getFullYear()}.${String(dt.getMonth()+1).padStart(2,'0')}.${String(dt.getDate()).padStart(2,'0')}`;}
function fmtDt(d){if(!d)return'-';const dt=new Date(d);if(isNaN(dt.getTime()))return'-';return`${String(dt.getMonth()+1).padStart(2,'0')}.${String(dt.getDate()).padStart(2,'0')} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;}
function toast(msg,type='info'){const t=document.getElementById('toast');t.textContent=msg;t.className=type;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),3000);}
function openModal(id){document.getElementById(id).classList.add('open');}
function closeModal(id){document.getElementById(id).classList.remove('open');}
function getItems(){
  const items=DB.get('items',[]);
  // 창고별 재고 필드가 있는 서랍장 품목은 currentStock을 합계로 동기화
  // [2026-07-24] 오산 창고 추가 — currentStock은 발주 계산용이라 오산 포함 X (발주 대상 아님, 재고 관리 전용)
  items.forEach(item=>{
    if(isTrackStock(item)&&item.stockSiheung!==undefined){
      item.currentStock=(item.stockSiheung||0)+(item.stockPyeongtaek||0);
    }
    // isActive 필드가 명시적으로 false인 경우에만 비활성 처리 (undefined는 활성으로 간주)
    if(item.isActive===undefined)item.isActive=true;
  });
  return items;
}
function getOrders(){return DB.get('orders',[]);}
function getPRs(){return DB.get('purchase_requests',[]);}
function getLogs(){return DB.get('logs',[]);}
function getItem(id){return getItems().find(i=>i.id===id);}
const STOCK_COLOR_ALIAS={'솔리드화이트':'솔리드','솔리드':'솔리드','화이트오크':'화이트 오크','화이트 오크':'화이트 오크'};
function normalizeStockColor(color){return STOCK_COLOR_ALIAS[color]||color;}
function stockColorAliases(color){
  const normalized=normalizeStockColor(color);
  const aliases=Object.keys(STOCK_COLOR_ALIAS).filter(k=>STOCK_COLOR_ALIAS[k]===normalized);
  if(!aliases.includes(color))aliases.push(color);
  if(!aliases.includes(normalized))aliases.push(normalized);
  return [...new Set(aliases)];
}
function getColorStock(map,color){
  if(!map||!color)return 0;
  return stockColorAliases(color).reduce((s,k)=>s+(Number(map[k])||0),0);
}
function normalizeColorStockMap(map){
  if(!map||typeof map!=='object')return{map:{},changed:false};
  let changed=false;
  const next={};
  Object.entries(map).forEach(([color,val])=>{
    const normalized=normalizeStockColor(color);
    next[normalized]=(next[normalized]||0)+(Number(val)||0);
    if(normalized!==color)changed=true;
  });
  Object.keys(map).forEach(k=>{if(map[k]!==next[k])changed=true;});
  Object.keys(next).forEach(k=>{if(map[k]!==next[k])changed=true;});
  return{map:next,changed};
}
function setColorStock(map,color,value){
  if(!map||!color)return;
  const normalized=normalizeStockColor(color);
  stockColorAliases(color).forEach(k=>{if(k!==normalized&&map[k]!==undefined)delete map[k];});
  map[normalized]=value;
}
function sumColorStockMap(map){
  const normalized=normalizeColorStockMap(map).map;
  return Object.values(normalized).reduce((s,v)=>s+(Number(v)||0),0);
}
function getColorAliasValue(map,color){
  if(!map||!color)return undefined;
  const keys=[color,normalizeStockColor(color),...stockColorAliases(color)].filter(Boolean);
  for(const key of [...new Set(keys)]){
    if(map[key]!==undefined)return map[key];
  }
  return undefined;
}
// 창고명 → DB 재고 필드명 변환 헬퍼
// [2026-07-24] 오산 창고 추가 (재고 관리 전용, 발주에는 안 나옴)
function getWhKey(wh){
  if(wh==='평택')return 'stockPyeongtaek';
  if(wh==='오산')return 'stockOsan';
  return 'stockSiheung'; // 기본: 시흥
}
// 창고명 → 이카운트 창고코드 변환 헬퍼 (오산은 이카운트 연동 안 함)
// [2026-07-24] 오산은 null 반환 — 발주 흐름에 오산 없음(격리)이지만 실수 방지 방어
function getWhErpCd(wh){
  if(wh==='평택')return '102';
  if(wh==='오산')return null;
  return '101'; // 기본: 시흥
}
// 창고별 색상별 재고 키 반환
function getColorWhKey(wh){
  if(wh==='평택')return 'colorStockPyeongtaek';
  if(wh==='오산')return 'colorStockOsan';
  return 'colorStockSiheung';
}
// 재고 추적 대상 판별 (기존 서랍장 + 가격표 가구 trackStock)
function isTrackStock(item){return !!item&&(item.category==='서랍장'||item.trackStock===true);}
// 창고별 재고 반환 헬퍼 (color 지정 시 색상별 재고, 미지정 시 창고 합계)
function getWarehouseStock(item,warehouse,color){
  if(!item||!isTrackStock(item))return 0;
  if(item.noColor)color='';
  const cwKey=getColorWhKey(warehouse||'시흥');
  if(color){
    const cMap=item[cwKey]||{};
    return getColorStock(cMap,color);
  }
  // color 미지정: 창고 전체 합계
  if(warehouse==='평택')return item.stockPyeongtaek||0;
  if(warehouse==='오산')return item.stockOsan||0;
  return item.stockSiheung||0;
}
