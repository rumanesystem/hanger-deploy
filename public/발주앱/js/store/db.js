// DB/State/Firestore Section
// 재고, 발주서, 로그 관리 관련 데이터베이스 함수

// ── IndexedDB 3중 백업 (orders 전용) ──────────────────────────
// ── 메모리 미러 (window._mem) — 진실 소스는 Firestore, 로컬은 세션 캐시·폴백만 ──
if(!window._mem) window._mem={};
if(!window._memBaseline) window._memBaseline={};

function _deepCopyMem(value){
  if(value===undefined)return undefined;
  try{return JSON.parse(JSON.stringify(value));}
  catch(_e){
    if(Array.isArray(value))return value.map(_deepCopyMem);
    if(value&&typeof value==='object'){
      const out={};
      Object.keys(value).forEach(k=>{out[k]=_deepCopyMem(value[k]);});
      return out;
    }
    return value;
  }
}
// _IDB: 더 이상 사용 안 함 (기존 IndexedDB 데이터 삭제·마이그레이션 코드 미포함 — 영향 회피). 호출부 보존용 no-op.
const _IDB={ save(){}, loadAll(){return Promise.resolve([]);} };

function _cleanForFirestore(value){
  if(value===undefined) return undefined;
  if(value===null) return null;
  if(Array.isArray(value)){
    return value.map(v=>{
      const cleaned=_cleanForFirestore(v);
      return cleaned===undefined?null:cleaned;
    });
  }
  if(value instanceof Date) return value;
  if(typeof value==='object'){
    const out={};
    Object.keys(value).forEach(key=>{
      const cleaned=_cleanForFirestore(value[key]);
      if(cleaned!==undefined) out[key]=cleaned;
    });
    return out;
  }
  return value;
}

// ── DB: localStorage + sessionStorage + IndexedDB + Firestore 4중 보호 ──
// 보호 키(orders 등 배열): get 시 빈 경우 백업에서 복원,
//                          set 시 절대 줄어들지 않도록 병합 후 모든 저장소에 동기화
const DB={
  // 발주서가 사라지면 안 되는 키 목록
  // H3 보강 (Codex): invoices도 통째 덮어쓰기 방어 대상에 포함
  // [2026-07-14] items는 _GUARD에서 제외: _mergeById가 stock/isActive/noColor 저장 못 함 (Codex P1 지적)
  // items 방어는 syncFromServer(라인 300+)의 빈값/현저감소 로컬 유지로만 처리
  _GUARD:new Set(['orders','purchase_requests','accounts','logs','session','invoices']),

  get(k,d=[]){
    try{
      const val=(window._mem&&Object.prototype.hasOwnProperty.call(window._mem,k))?window._mem[k]:null;
      if(k==='items'&&Array.isArray(val)){
        try{return JSON.parse(JSON.stringify(val));}catch{return val.map(i=>({...i}));}
      }
      return val!==null&&val!==undefined?val:d;
    }catch{return d;}
  },

  set(k,v){
    // ── (핫픽스 A 20260610) orders 한정: 서버 최신본 강제 재조회 + 병합 게이트 ──
    // 6/8 사고: stale 캐시(DB.get) → DB.set 시 서버 통째 덮어쓰기로 발주서 손실.
    // orders 만 서버 재조회(3초 타임아웃) + _mergeById 후 set 진행. 실패 시 저장 차단 + 토스트.
    // 호출처가 await 안 해도 토스트로 알림, 메모리 미러 미반영 → 새로고침 시 서버값으로 자가 복구.
    if(k==='items' && Array.isArray(v) && window._FS && !window._itemsInitLock){
      const self=this;
      const prev=(window._mem&&Array.isArray(window._mem[k]))?window._mem[k]:[];
      return (async()=>{
        try{
          const server=await Promise.race([
            window._FS.get('items'),
            new Promise((_,rj)=>setTimeout(()=>rj(new Error('TIMEOUT')),10000))
          ]);
          if(server===null||server===undefined){
            throw new Error('[안전망] items 서버 재조회 실패(null) — fail-closed, 저장 차단');
          }
          if(!Array.isArray(server)){
            throw new Error('[안전망] items 서버 응답 비배열 — fail-closed, 저장 차단');
          }
          const merged=_mergeItemsByLocalChanges(server,prev,v);
          return self._setInternal(k,merged);
        }catch(e){
          console.error('[안전망] items 저장 차단 — 서버 재조회 실패:',e&&e.message);
          if(typeof toast==='function')toast('서버 연결 확인 필요. 재고/품목 저장이 차단되었습니다.','error');
          throw e;
        }
      })();
    }

    if(k==='orders' && Array.isArray(v) && window._FS){
      const self=this;
      return (async()=>{
        try{
          // [Phase 5 2026-07-31] 옛 경로(hanger_data/orders 단일 배열) 사용 중단.
          // 옛 문서가 1MB 한계 초과(1065KB) — 신규 저장 실패 위험 대응.
          // baseline·write 모두 새 경로(hanger_orders 컬렉션) 사용. 옛 문서는 읽기 전용 유물로 보존.
          if(typeof window._FS.getAllOrders!=='function' || typeof window._FS.upsertOrder!=='function'){
            throw new Error('[Phase 5] _FS.getAllOrders/upsertOrder 미구현 — 저장 차단');
          }
          const server=await Promise.race([
            window._FS.getAllOrders({fromServer:true}),
            new Promise((_,rj)=>setTimeout(()=>rj(new Error('TIMEOUT')),10000))
          ]);
          if(!Array.isArray(server)){
            throw new Error('[Phase 5] 새 경로 orders 응답 비배열 — 저장 차단');
          }
          const serverArr=server;
          const merged=_mergeById(serverArr, v);
          // [Phase 5 롤백 보호] upsert 실패 시 _mem 복원용 이전 스냅샷 보관
          const _memPrev = Array.isArray(window._mem&&window._mem['orders'])
            ? window._mem['orders'].slice()
            : null;
          const result=self._setInternal(k, merged,{skipRemote:true});
          // 변경분만 새 경로 단건 upsert. 실패 시 throw (best-effort 아님).
          const serverById=new Map((serverArr||[]).map(o=>[o.id,o]));
          const changed=merged.filter(m=>{
            if(!m||!m.orderNum) return false;
            const prev=serverById.get(m.id);
            if(!prev) return true;
            return (prev.updatedAt||'')!==(m.updatedAt||'');
          });
          if(changed.length>0){
            const results=await Promise.allSettled(changed.map(o=>window._FS.upsertOrder(_cleanForFirestore(o))));
            const failed=results.filter(r=>r.status==='rejected');
            if(failed.length>0){
              // _mem 롤백 — 사용자엔 저장 실패 뜨는데 유령 발주가 로컬에 남으면 다음 저장 baseline 꼬임 방지
              if(_memPrev){ window._mem['orders']=_memPrev; }
              throw new Error('[Phase 5] hanger_orders 저장 실패: '+failed.length+'/'+changed.length);
            }
          }
          return result;
        }catch(e){
          console.error('[핫픽스A] orders 저장 차단 — 서버 재조회 실패:', e&&e.message);
          if(typeof toast==='function') toast('서버 연결 확인 필요. 재시도 하세요.','error');
          throw e;
        }
      })();
    }
    return this._setInternal(k,v);
  },

  _setInternal(k,v,opts={}){
    let toStore=v;

    // [2026-08-25] _FS.set 트랜잭션이 diff/merge 담당하는 컬렉션은 union 스킵
    //   union이 앞에서 돌면 로컬 삭제가 무효화되어 트랜잭션이 삭제 반영 못함.
    //   session·orders 등은 아래 union 로직 유지 (별도 방어).
    const _TX_KEYS = new Set(['items','purchase_requests','accounts','invoices','logs']);

    // ── 보호 키: 항상 병합 (절대 줄어들지 않음) ──
    if(this._GUARD.has(k)&&Array.isArray(v)&&!_TX_KEYS.has(k)){
      try{
        const existing=(window._mem&&Array.isArray(window._mem[k]))?window._mem[k]:[];
        if(Array.isArray(existing)&&existing.length>0){
          toStore=_mergeById(existing,v);
          if(toStore.length<existing.length){
            // 예외 상황: 병합 후에도 줄어들면 기존 유지
            console.error(`[DB 보호] ${k} 데이터 감소 차단: ${existing.length}→${toStore.length}, 기존 유지`);
            toStore=existing;
          }
        }
      }catch(e){console.warn('[DB 병합 오류]',e.message);}
    }

    // 메모리 미러에 저장 (세션 캐시)
    window._mem[k]=toStore;

    // Firestore에 저장 — items는 initData 마이그레이션 중 잠금 (race condition 방지)
    if(window._FS && !(opts&&opts.skipRemote) && !(k==='items' && window._itemsInitLock)){
      // 큐 실행 시점에 직전 write의 committed baseline을 읽도록 _FS에 위임한다.
      const syncPromise=window._FS.set(k,toStore).catch(e=>console.warn('[Firestore sync 실패]',k,e.message));
      if(k==='items')return syncPromise;
    }
  },

  nextId(k){const n=(this.get('_seq_'+k,0))+1;this.set('_seq_'+k,n);return n;},

  // ── Firestore migrations 문서 (1회성 마이그 플래그 — 기기 무관 전역 1회) ──
  getMig(flag){
    try{
      const m=(window._mem&&window._mem['_migrations'])||{};
      if(m[flag]) return true;
      // 서버 migrations에 없으면: 기존 localStorage sh_<flag> 1회 승계 (원본 삭제 안 함 — 읽기만)
      try{
        if(localStorage.getItem('sh_'+flag)){
          if(!window._mem['_migrations']||typeof window._mem['_migrations']!=='object') window._mem['_migrations']={};
          window._mem['_migrations'][flag]=true;
          if(window._FS) window._FS.set('_migrations',window._mem['_migrations']).catch(e=>console.warn('[migrations 승계 write 실패]',flag,e&&e.message));
          return true;
        }
      }catch(_e){}
      return false;
    }catch{return false;}
  },
  setMig(flag){
    try{
      if(!window._mem) window._mem={};
      const m=(window._mem['_migrations']&&typeof window._mem['_migrations']==='object')?window._mem['_migrations']:{};
      m[flag]=true;
      window._mem['_migrations']=m;
      if(window._FS) window._FS.set('_migrations',m).catch(e=>console.warn('[migrations write 실패]',flag,e&&e.message));
    }catch(e){console.warn('[setMig 오류]',e&&e.message);}
  },

  // (구) IndexedDB 긴급 복원 — window._mem+Firestore 체계로 불필요. 호출부 보존용 no-op
  async restoreFromIDB(){ return; }
};

// ── 배열 ID 기준 병합 (로컬 + Firestore 유니언, 같은 ID면 Firestore 우선) ──
function _mergeById(local, remote){
  const ERP_FIELDS=['colorProdCdMap','prodCd','subTypeProdCdMap','damperProdCd','nonStdProdCd','empCd','bizCd'];
  const result=new Map();
  (local||[]).forEach(item=>{ if(item&&item.id!=null) result.set(item.id, item); });
  (remote||[]).forEach(remoteItem=>{
    if(!remoteItem||remoteItem.id==null) return;
    const localItem=result.get(remoteItem.id);
    if(!localItem){ result.set(remoteItem.id, remoteItem); return; }
    // (핫픽스 C 20260611) updatedAt 비교 — 더 최신값을 base로 채택, 옛값에서 ERP/필드 보강
    // Codex 보강 (Critical-2): updatedAt 동률/누락 시 첫 번째 인자(local) 우선
    // orders 호출 흐름: _mergeById(서버, 호출자) — 서버를 local로 전달
    //   → 동률/누락 시 서버(local) 우선 = stale 호출자 배열이 서버를 못 덮음
    const lu=localItem.updatedAt||'';
    const ru=remoteItem.updatedAt||'';
    const localIsNewer = !ru || lu >= ru;
    const base = localIsNewer ? localItem : remoteItem;
    const other = localIsNewer ? remoteItem : localItem;
    const merged={...base};
    ERP_FIELDS.forEach(f=>{
      const bv=base[f], ov=other[f];
      if(!bv && ov) { merged[f]=ov; return; }
      if(bv && ov && typeof bv==='object' && typeof ov==='object'){
        const bCount=Object.keys(bv).filter(k=>bv[k]&&bv[k]!=='N/A').length;
        const oCount=Object.keys(ov).filter(k=>ov[k]&&ov[k]!=='N/A').length;
        if(oCount>bCount) merged[f]=ov;
      }
    });
    result.set(remoteItem.id, merged);
  });
  return [...result.values()].sort((a,b)=>(a.id||0)-(b.id||0));
}
// (핫픽스 C 20260611) watchData / shipping에서 호출하기 위해 글로벌 노출
window._mergeById = _mergeById;

function _stableJson(v){
  try{return JSON.stringify(v);}catch{return String(v);}
}
function _mergeItemsByLocalChanges(serverItems,prevItems,nextItems){
  const serverById=new Map((serverItems||[]).filter(i=>i&&i.id!=null).map(i=>[i.id,i]));
  const prevById=new Map((prevItems||[]).filter(i=>i&&i.id!=null).map(i=>[i.id,i]));
  const result=new Map();
  (serverItems||[]).forEach(item=>{if(item&&item.id!=null)result.set(item.id,{...item});});
  (nextItems||[]).forEach(next=>{
    if(!next||next.id==null)return;
    const server=serverById.get(next.id);
    const prev=prevById.get(next.id);
    if(!server){
      result.set(next.id,{...next});
      return;
    }
    if(!prev){
      result.set(next.id,{...server,...next});
      return;
    }
    const merged={...server};
    const keys=new Set([...Object.keys(prev),...Object.keys(next)]);
    keys.forEach(key=>{
      if(_stableJson(prev[key])===_stableJson(next[key]))return;
      if(Object.prototype.hasOwnProperty.call(next,key))merged[key]=next[key];
      else delete merged[key];
    });
    result.set(next.id,merged);
  });
  return [...result.values()].sort((a,b)=>(a.id||0)-(b.id||0));
}
window._mergeItemsByLocalChanges=_mergeItemsByLocalChanges;

// ── Firestore → 메모리(window._mem) 서버우선 동기화 (앱 시작 1회) ──
// 서버=진실. getAll 성공 시 서버값 채택. 서버 미수신 시에만 로컬 폴백(읽기).
// 로컬→서버 역업로드 전면 폐지(다중PC 섞임 차단). 로컬 sh_* 삭제 0(안전망).
// (B) _GUARD 키 한정: 서버가 빈값/기존의 절반 미만이면 그 키만 로컬 유지(+경고). 역업로드 여전히 0.
// Codex 3차 보강: 로그인 성공 후 인증 상태로 데이터 재로드 (중복 방지 플래그)
// 비로그인 부트에서 syncFromServer 실패해도(rules 차단), 인증 성공 후 한 번 보장
// Codex 4차 보강:
//   - 플래그를 성공 후에 set (실패 시 다음 호출이 재시도)
//   - 동시 호출 race: inflight Promise 캐싱으로 직렬화
//   - 성공 후 attachWatchers 호출 (인증 후 onSnapshot 부착 → rules read 제한 대비)
async function _postLoginResync(){
  if(window._postLoginResynced) return;
  if(window._postLoginResyncInflight) return window._postLoginResyncInflight;
  window._postLoginResyncInflight = (async()=>{
    try{
      await syncFromServer();
      window._postLoginResynced = true;   // 성공 후에만 플래그
      if(typeof attachWatchers === 'function') attachWatchers();
    }catch(e){
      console.warn('[_postLoginResync 실패]', e&&e.message);
    }finally{
      window._postLoginResyncInflight = null;
    }
  })();
  return window._postLoginResyncInflight;
}
window._postLoginResync=_postLoginResync;

async function syncFromServer(){
  if(!window._FS){
    console.warn('[Firestore] 미초기화 → 로컬 폴백으로 계속합니다.');
    _loadLocalFallback();
    return;
  }
  try{
    const data=await window._FS.getAll();
    const _GUARD_KEYS=['orders','purchase_requests','accounts','logs'];
    // items는 라인 300 분기에서 별도 방어 (else 진입 안 하므로 _GUARD_KEYS에 넣어도 무효)
    const _SHRINK_RATIO=0.5;  // 서버가 기존의 50% 미만이면 사고로 간주 (개발자 조정 가능 상수)
    for(const [k,v] of Object.entries(data)){
      if(k==='items' && Array.isArray(v)){
        // [2026-07-14] 서버 items 빈값/현저감소 시 로컬 유지 (신규 품목 사라짐 방어)
        const _prevItems=Array.isArray(window._mem[k])?window._mem[k]:null;
        const _vEmpty=v.length===0;
        const _vShrunk=_prevItems&&_prevItems.length>0&&v.length<_prevItems.length*_SHRINK_RATIO;
        if(_prevItems&&_prevItems.length>0&&(_vEmpty||_vShrunk)){
          console.warn(`[안전망] 서버 items 비정상(${_vEmpty?'빈값':'현저감소 '+v.length+'<'+_prevItems.length}) → 로컬 유지`);
          continue;
        }
        // items: 서버값 자체의 동명 중복만 정리 (입력=서버값, 로컬 병합 아님)
        const byName=new Map();
        v.forEach(i=>{
          if(!byName.has(i.name)){byName.set(i.name,i);return;}
          const prev=byName.get(i.name);
          const ps=Object.keys(prev.colorProdCdMap||{}).length+(prev.prodCd?10:0);
          const cs=Object.keys(i.colorProdCdMap||{}).length+(i.prodCd?10:0);
          if(cs>ps){
            const winner={...i};
            if(prev.colorProdCdMap)winner.colorProdCdMap=Object.assign({},prev.colorProdCdMap,winner.colorProdCdMap||{});
            const pt=prev.isActiveUpdatedAt||'';
            const ct=winner.isActiveUpdatedAt||'';
            if(pt>ct){winner.isActive=prev.isActive;winner.isActiveUpdatedAt=pt;}
            else if(!pt&&!ct&&prev.isActive===false){winner.isActive=false;}
            byName.set(i.name,winner);
          } else {
            if(i.colorProdCdMap)prev.colorProdCdMap=Object.assign({},i.colorProdCdMap,prev.colorProdCdMap||{});
            const pt=prev.isActiveUpdatedAt||'';
            const ct=i.isActiveUpdatedAt||'';
            if(ct>pt){prev.isActive=i.isActive;prev.isActiveUpdatedAt=ct;}
          }
        });
        window._mem[k]=[...byName.values()].sort((a,b)=>(a.id||0)-(b.id||0));
      } else {
        // (B 빈값가드) _GUARD 키 + 서버 빈값/현저감소 → 그 키만 로컬 유지. _FS.set 호출 0(섞임0).
        if(_GUARD_KEYS.includes(k)){
          const _prevArr=Array.isArray(window._mem[k])?window._mem[k]:null;
          const _vEmpty=!Array.isArray(v)||v.length===0;
          const _vShrunk=Array.isArray(v)&&_prevArr&&_prevArr.length>0&&v.length<_prevArr.length*_SHRINK_RATIO;
          if(_prevArr&&_prevArr.length>0&&(_vEmpty||_vShrunk)){
            console.warn(`[안전망] 서버 ${k} 비정상(${_vEmpty?'빈값':'현저감소 '+v.length+'<'+_prevArr.length}) → 로컬 유지(역업로드 안 함)`);
            continue;
          }
        }
        // 정상: 서버값 그대로 채택 (서버 우선, 역업로드 없음)
        window._mem[k]=v;
      }
    }
    console.log(`[서버우선 동기화 완료] ${Object.keys(data).length}개 키 서버값 채택 (역업로드 0)`);
    // (Phase 3a 읽기 전환 20260611) 발주서를 hanger_orders 컬렉션에서 다시 로드 (옛 데이터 덮어쓰기)
    // 안전망: 새 컬렉션이 옛 데이터의 80% 미만이면 옛 데이터 유지 (롤백 보호)
    if(window._FS && window._FS.PHASE3_READ_FROM_NEW && typeof window._FS.getAllOrders === 'function'){
      try{
        const newOrders = await window._FS.getAllOrders();
        const oldLen = Array.isArray(window._mem['orders']) ? window._mem['orders'].length : 0;
        if(Array.isArray(newOrders) && newOrders.length >= Math.max(1, oldLen * 0.95)){
          window._mem['orders'] = newOrders;
          console.log(`[Phase 3a] 발주서 hanger_orders에서 ${newOrders.length}건 로드 (옛: ${oldLen}건)`);
        } else {
          console.warn(`[Phase 3a 안전망] hanger_orders가 옛 곳의 95% 미만 (${newOrders?.length||0} < ${Math.floor(oldLen*0.95)}) → 옛 데이터 유지`);
        }
      } catch(e){
        console.warn('[Phase 3a] hanger_orders 로드 실패, 옛 데이터 유지:', e&&e.message);
      }
    }
    // 이후 로컬 diff는 이 클라이언트가 마지막으로 서버에서 받은 상태를 기준으로 계산한다.
    window._memBaseline=_deepCopyMem(window._mem);
  }catch(e){
    console.warn('[Firestore 수신 실패] 로컬 폴백으로 계속합니다.',e&&e.message);
    _loadLocalFallback();
  }
}

// ── 로컬 폴백: 서버 미수신 시에만 localStorage sh_* → window._mem (읽기 단방향, _FS.set 0, 삭제 0) ──
function _loadLocalFallback(){
  try{
    for(const lk of Object.keys(localStorage)){
      if(lk.indexOf('sh_')!==0) continue;
      const k=lk.slice(3);
      try{ const raw=localStorage.getItem(lk); if(raw!=null) window._mem[k]=JSON.parse(raw); }catch(_e){}
    }
    console.warn('[로컬 폴백] localStorage sh_* → 메모리 적재 (서버 복구 시 서버값이 덮어씀)');
  }catch(e){ console.warn('[로컬 폴백 실패]',e&&e.message); }
}

// ── 마이그레이션 캐시 로드 (Firestore _migrations → window._mem) ──
async function loadMigrationsCache(){
  try{
    if(!window._FS) return;
    const m=await window._FS.get('_migrations');
    if(m&&typeof m==='object'){ window._mem['_migrations']=m; }
    else if(!window._mem['_migrations']){ window._mem['_migrations']={}; }
  }catch(e){ console.warn('[migrations 로드 실패]',e&&e.message); if(!window._mem['_migrations'])window._mem['_migrations']={}; }
}

// ── 사용자 환경설정 로드 (인증 사용자별 Firestore user_prefs_<uid>) ──
async function loadUserPrefs(){
  try{
    if(!window._FS||!window._fbAuth||!window._fbAuth.currentUser) return;
    const uid=window._fbAuth.currentUser.uid;
    const p=await window._FS.get('user_prefs_'+uid);
    window._mem['_userPrefs']=(p&&typeof p==='object')?p:{};
  }catch(e){ console.warn('[userPrefs 로드 실패]',e&&e.message); if(!window._mem['_userPrefs'])window._mem['_userPrefs']={}; }
}

function getUserPref(key,def){
  try{
    const p=window._mem&&window._mem['_userPrefs'];
    return (p&&p[key]!==undefined)?p[key]:def;
  }catch{return def;}
}

function setUserPref(key,val){
  try{
    if(!window._mem) window._mem={};
    const p=(window._mem['_userPrefs']&&typeof window._mem['_userPrefs']==='object')?window._mem['_userPrefs']:{};
    p[key]=val;
    window._mem['_userPrefs']=p;
    if(window._FS&&window._fbAuth&&window._fbAuth.currentUser){
      const uid=window._fbAuth.currentUser.uid;
      window._FS.set('user_prefs_'+uid,p).catch(e=>console.warn('[userPref write 실패]',key,e&&e.message));
    }
  }catch(e){console.warn('[setUserPref 오류]',e&&e.message);}
}

// ── (7단계) 레거시 localStorage 미정리 — 안전망으로 sh_* 원본 그대로 보존.
//    이번 작업은 "읽기 출처를 로컬→서버로 전환"이며 데이터 삭제가 아님.
//    절대 localStorage/sessionStorage 삭제·clear 금지. 호출부 보존용 no-op.
async function migrateLegacyLocalOnce(){ return; }

const DEFAULT_ACCOUNTS=[];
let currentUser=null;

function initAccounts(){
  if(DB.get('accounts',[]).length===0) DB.set('accounts',DEFAULT_ACCOUNTS);
}

// 현재 로그인 탭 ('orderer' | 'admin')
let loginTab='orderer';

function setLoginTab(tab){
  loginTab=tab;
  const isAdmin=tab==='admin';
  // 탭 버튼 스타일
  document.getElementById('tab-orderer').style.background=isAdmin?'#fff':'var(--primary-light)';
  document.getElementById('tab-orderer').style.color=isAdmin?'var(--text-3)':'#fff';
  document.getElementById('tab-admin').style.background=isAdmin?'#0f172a':'#fff';
  document.getElementById('tab-admin').style.color=isAdmin?'#fff':'var(--text-3)';
  // 버튼 텍스트
  document.getElementById('login-btn-text').textContent=isAdmin?'관리자 로그인':'발주자 로그인';
  // 하단 영역
  document.getElementById('orderer-footer').style.display=isAdmin?'none':'block';
  document.getElementById('admin-footer').style.display=isAdmin?'block':'none';
  // 관리자 탭: 관리자 계정 존재 여부에 따라 안내문 변경
  if(isAdmin){
    const msg=document.getElementById('admin-footer-msg');
    msg.innerHTML='<button onclick="showAdminSetup()" style="background:none;border:none;color:var(--primary-light);font-size:12px;font-weight:700;cursor:pointer;padding:0">관리자 계정 생성</button>';
  }
  document.getElementById('login-error').style.display='none';
  document.getElementById('login-id').value='';
  document.getElementById('login-pw').value='';
  document.getElementById('login-id').focus();
}

// ── 로컬/스테이징 전용 테스트 계정 전환기 ─────────────────────────────
// 운영 안전장치:
// 1) localhost/127.0.0.1/스테이징(hanger-test-260901.web.app) 에서만 버튼 생성
// 2) 함수 실행 시에도 다시 한 번 검사
// [2026-09-03] 스테이징 도메인 추가 (사용자 QA 편의). 운영(hanger-deploy) 은 계속 차단.
function isLocalTestHost_(){
  const h=location.hostname;
  if(h==='localhost'||h==='127.0.0.1'||h==='[::1]')return true;
  if(h==='hanger-test-260901.web.app'||h==='hanger-test-260901.firebaseapp.com')return true;
  return false;
}

const LOCAL_TEST_SWITCH_ACCOUNTS=[
  {id:'admin',email:'admin@local.test',label:'관리자',password:'123456',role:'admin',color:'#4f35f5'},
];

function localTestEsc_(s){
  return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function getLocalTestSwitchAccounts_(){
  const accounts=(typeof DB!=='undefined'&&typeof DB.get==='function')?DB.get('accounts',[]):[];
  const orderers=accounts
    .filter(a=>a&&a.role==='orderer')
    .sort((a,b)=>String(a.deliveryName||a.name||a.id||'').localeCompare(String(b.deliveryName||b.name||b.id||''),'ko'))
    .map(a=>({
      id:a.id,
      email:a.email||'',
      label:a.deliveryName||a.name||a.id,
      password:'123456',
      role:'orderer',
    }));
  return [...LOCAL_TEST_SWITCH_ACCOUNTS, ...orderers];
}

function initLocalTestAccountSwitcher(){
  if(!isLocalTestHost_())return;
  if(document.getElementById('local-test-account-switcher'))return;

  const style=document.createElement('style');
  style.id='local-test-account-switcher-style';
  style.textContent=`
    #local-test-account-switcher{position:fixed;left:12px;bottom:14px;z-index:99998;border:0;border-radius:9px;background:#17213a;color:#fff;padding:10px 14px;font-size:13px;font-weight:800;box-shadow:0 10px 28px rgba(15,23,42,.28);cursor:pointer}
    #local-test-account-switcher:hover{filter:brightness(1.08)}
    #local-test-account-modal{position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.42);display:none;align-items:center;justify-content:flex-start;padding-left:20px}
    #local-test-account-modal.active{display:flex}
    .local-test-account-card{width:min(330px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;background:#fff;border-radius:18px;box-shadow:0 22px 60px rgba(15,23,42,.32);padding:22px}
    .local-test-account-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
    .local-test-account-title{font-size:18px;font-weight:900;color:#111827}
    .local-test-account-close{border:0;background:none;color:#94a3b8;font-size:28px;line-height:1;cursor:pointer}
    .local-test-account-help{font-size:12px;line-height:1.5;color:#64748b;margin-bottom:14px}
    .local-test-account-list{display:flex;flex-direction:column;gap:10px}
    .local-test-account-item{width:100%;border:0;border-radius:12px;background:#079968;color:#fff;text-align:left;padding:13px 15px;font-size:18px;font-weight:900;cursor:pointer;line-height:1.2}
    .local-test-account-item small{display:block;margin-top:4px;font-size:12px;font-weight:800;opacity:.86}
    .local-test-account-item:hover{filter:brightness(1.06)}
  `;
  document.head.appendChild(style);

  const btn=document.createElement('button');
  btn.id='local-test-account-switcher';
  btn.type='button';
  btn.innerHTML='<i class="fas fa-sync-alt"></i> 계정 전환';
  btn.onclick=openLocalTestAccountSwitcher;
  document.body.appendChild(btn);

  const modal=document.createElement('div');
  modal.id='local-test-account-modal';
  modal.innerHTML=`
    <div class="local-test-account-card">
      <div class="local-test-account-head">
        <div class="local-test-account-title">테스트 계정 전환</div>
        <button type="button" class="local-test-account-close" onclick="closeLocalTestAccountSwitcher()">×</button>
      </div>
      <div class="local-test-account-help">로컬 전용. 로그아웃·로그인 자동 처리. 새로고침 없이 바로 적용.</div>
      <div id="local-test-account-list" class="local-test-account-list"></div>
    </div>
  `;
  modal.addEventListener('click',e=>{if(e.target===modal)closeLocalTestAccountSwitcher();});
  document.body.appendChild(modal);
  renderLocalTestAccountList();
}

async function openLocalTestAccountSwitcher(){
  if(!isLocalTestHost_())return;
  if(typeof syncFromServer==='function'){
    try{await syncFromServer();}catch(_e){}
  }
  renderLocalTestAccountList();
  document.getElementById('local-test-account-modal')?.classList.add('active');
}

function closeLocalTestAccountSwitcher(){
  document.getElementById('local-test-account-modal')?.classList.remove('active');
}

function renderLocalTestAccountList(){
  if(!isLocalTestHost_())return;
  const list=document.getElementById('local-test-account-list');
  if(!list)return;
  const accounts=DB.get('accounts',[]);
  list.innerHTML=getLocalTestSwitchAccounts_().map(acc=>{
    const real=accounts.find(a=>a.id===acc.id);
    const name=real?(real.deliveryName||real.name||acc.label):acc.label;
    const bg=acc.color||'#079968';
    return `<button type="button" class="local-test-account-item" style="background:${bg}" onclick="switchLocalTestAccount('${acc.id}')">
      ${localTestEsc_(acc.label)} <small>${localTestEsc_(acc.id)}${real?' · '+localTestEsc_(name):' · 계정 없음'}</small>
    </button>`;
  }).join('');
}

async function switchLocalTestAccount(id){
  if(!isLocalTestHost_())return;
  const cfg=getLocalTestSwitchAccounts_().find(a=>a.id===id);
  if(!cfg){toast('테스트 계정을 찾을 수 없습니다.','error');return;}
  const accounts=DB.get('accounts',[]);
  const acc=accounts.find(a=>a.id===cfg.id);
  const loginId=acc?cfg.id:(cfg.role==='orderer'?cfg.email:cfg.id);
  try{
    setLoginTab(((acc&&acc.role)||cfg.role)==='admin'?'admin':'orderer');
    document.getElementById('login-id').value=loginId;
    document.getElementById('login-pw').value=cfg.password;
    const rememberEl=document.getElementById('remember-id');
    const autoEl=document.getElementById('auto-login');
    if(rememberEl)rememberEl.checked=false;
    if(autoEl)autoEl.checked=false;
    closeLocalTestAccountSwitcher();
    await doLogin();
  }catch(e){
    console.warn('[로컬 계정 전환 실패]',e);
    toast('계정 전환 중 오류가 발생했습니다.','error');
  }
}

window.initLocalTestAccountSwitcher=initLocalTestAccountSwitcher;
window.openLocalTestAccountSwitcher=openLocalTestAccountSwitcher;
window.closeLocalTestAccountSwitcher=closeLocalTestAccountSwitcher;
window.switchLocalTestAccount=switchLocalTestAccount;

async function doLogin(){
  const id=document.getElementById('login-id').value.trim();
  const pw=document.getElementById('login-pw').value;
  const err=document.getElementById('login-error');
  err.style.display='none';

  let accounts=DB.get('accounts',[]);
  const isEmail=id.includes('@');
  let found=isEmail ? accounts.find(a=>a.email===id) : accounts.find(a=>a.id===id);
  // 아이디로 로그인인데 로컬에 없으면 Firestore에서 최신 accounts 받아 재시도 (다른 기기에서 만든 새 계정 대응)
  // 아이디 로그인인데 로컬에 없으면 Cloud Function 으로 이메일만 조회 (Firestore 직접 read 안 함)
  if(!found&&!isEmail&&window._FN?.getEmailById){
    try{
      const res=await window._FN.getEmailById({ id });
      if(res&&res.data&&res.data.email){
        found={email:res.data.email};
      }
    }catch(e){
      if(e&&e.code==='functions/not-found'){
        err.style.display='block';err.textContent='아이디 또는 비밀번호가 올바르지 않습니다.';return;
      }
      console.warn('[getEmailById 실패]',e.message);
    }
  }
  if(!found&&!isEmail){err.style.display='block';err.textContent='아이디 또는 비밀번호가 올바르지 않습니다.';return;}
  if(!window._fbAuth){err.style.display='block';err.textContent='서버 연결 중입니다. 잠시 후 다시 시도해주세요.';return;}

  // Firebase Auth 로그인
  const loginEmail=found?.email||id;
  try{
    await window._fbAuth.signInWithEmailAndPassword(loginEmail,pw);
  }catch(e){
    if(e.code==='auth/wrong-password'||e.code==='auth/invalid-credential'){
      err.style.display='block';err.textContent='아이디 또는 비밀번호가 올바르지 않습니다.';
    }else if(e.code==='auth/user-not-found'||e.code==='auth/invalid-email'){
      err.style.display='block';err.textContent='계정 초기 설정이 필요합니다. 비밀번호 찾기를 이용해주세요.';
    }else if(e.code==='auth/too-many-requests'){
      err.style.display='block';err.textContent='로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.';
    }else{
      err.style.display='block';err.textContent='로그인 중 오류가 발생했습니다.';
      console.warn('[Firebase Auth 로그인 실패]',e.code,e.message);
    }
    return;
  }

  // Codex 3차 보강: 인증 상태로 서버 데이터 재로드 (비로그인 부트에서 read 차단됐을 가능성)
  // 중복 방지: _postLoginResynced 플래그
  await _postLoginResync();

  // ── Auth 성공 후: 이메일만 가진 임시 found 면 실제 계정(id/role/name) 재조회 ──
  if(found&&!found.id&&found.email){
    let acc=DB.get('accounts',[]);
    let real=acc.find(a=>a.email===found.email);
    if(!real&&window._FS){
      try{
        const remote=await window._FS.get('accounts');
        if(Array.isArray(remote)&&remote.length>0){
          const merged=_mergeById(acc,remote);
          window._mem['accounts']=merged;
          acc=merged;
          real=acc.find(a=>a.email===found.email);
        }
      }catch(e){console.warn('[로그인 후 accounts 재조회 실패]',e.message);}
    }
    if(real) found=real;
  }
  // ── 안전장치1 ──
  if(found&&!found.id&&!(isEmail)){
    err.style.display='block';err.textContent='계정 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.';return;
  }

  // 이메일 로그인인데 발주앱 계정 없으면 자동 생성 (일반 권한)
  if(isEmail&&!found){
    if(loginTab==='admin'){err.style.display='block';err.textContent='관리자 계정만 이 화면에서 로그인할 수 있습니다.';return;}
    const base=id.split('@')[0];
    const newId=accounts.find(a=>a.id===base)?`${base}_${Date.now()}`:base;
    // 납품처(deliveryName)는 비워두고 사용자가 직접 설정하게 함 (개인정보 수정에서 변경 가능)
    found={id:newId,name:base,deliveryName:'',email:id,role:'orderer',empCd:'',bizCd:''};
    accounts.push(found);
    DB.set('accounts',accounts);
  }

  if(loginTab==='admin'&&found.role!=='admin'){
    err.style.display='block';err.textContent='관리자 계정만 이 화면에서 로그인할 수 있습니다.';return;
  }
  if(loginTab==='orderer'&&found.role==='admin'){
    err.style.display='block';err.textContent='관리자 계정은 관리자 로그인 탭을 사용해주세요.';return;
  }

  // 아이디 저장 / 자동로그인 처리
  const rememberEl=document.getElementById('remember-id');
  const autoEl=document.getElementById('auto-login');
  const doRemember=rememberEl&&rememberEl.checked;
  const doAuto=autoEl&&autoEl.checked;

  if(doRemember||doAuto){
    localStorage.setItem('sh_saved_login_id', id);
    localStorage.setItem('sh_remember_id','1');
  } else {
    localStorage.removeItem('sh_saved_login_id');
    localStorage.removeItem('sh_remember_id');
  }
  if(doAuto){
    localStorage.setItem('sh_auto_login','1');
    localStorage.setItem('sh_auto_login_user_id', id);
  } else {
    localStorage.removeItem('sh_auto_login');
    localStorage.removeItem('sh_auto_login_user_id');
  }

  currentUser={id:found.id,name:found.name,deliveryName:found.deliveryName||'',role:found.role};
  DB.set('session',currentUser);
  showApp();
}

// 최초 관리자 계정 생성 화면 (관리자 계정이 없을 때만)
function showAdminSetup(){
  document.getElementById('login-screen').classList.remove('active');
  document.getElementById('admin-setup-screen').classList.add('active');
}

function togglePw(btn){
  const inp=btn.previousElementSibling;
  if(!inp)return;
  const show=inp.type==='password';
  inp.type=show?'text':'password';
  btn.innerHTML=show?'<i class="fas fa-eye-slash"></i>':'<i class="fas fa-eye"></i>';
  btn.title=show?'비밀번호 숨기기':'비밀번호 표시';
}
function wrapPwToggle(id){
  const inp=document.getElementById(id);
  if(!inp||inp.dataset.pwWrapped)return;
  inp.dataset.pwWrapped='1';
  const wrap=document.createElement('div');
  wrap.className='pw-wrap';
  inp.parentNode.insertBefore(wrap,inp);
  wrap.appendChild(inp);
  const btn=document.createElement('button');
  btn.type='button';
  btn.className='pw-toggle';
  btn.innerHTML='<i class="fas fa-eye"></i>';
  btn.title='비밀번호 표시';
  btn.onclick=function(){togglePw(this);};
  wrap.appendChild(btn);
}

function doLogout(){
  // Firebase Auth 로그아웃
  if(window._fbAuth){window._fbAuth.signOut().catch(()=>{});}
  currentUser=null;
  DB.set('session',null);
  if(window.LumaneAlertFailures&&typeof window.LumaneAlertFailures.syncForCurrentUser==='function'){
    window.LumaneAlertFailures.syncForCurrentUser();
  }
  sessionStorage.removeItem('sh_tab_session');
  // 자동로그인 해제 (아이디 저장은 유지)
  localStorage.removeItem('sh_auto_login');
  localStorage.removeItem('sh_auto_login_user_id');
  document.getElementById('app').classList.remove('active');
  document.getElementById('login-screen').classList.add('active');
  // 저장된 아이디 복원, 비밀번호는 항상 비움
  const savedId=localStorage.getItem('sh_saved_login_id');
  const idEl=document.getElementById('login-id');
  if(idEl) idEl.value=savedId||'';
  document.getElementById('login-pw').value='';
}

function isAdmin(){return currentUser&&currentUser.role==='admin';}

function requireAdmin(){
  if(!isAdmin()){toast('관리자만 접근할 수 있습니다.','error');navigate('dashboard');return false;}
  return true;
}

function showApp(){
  document.getElementById('login-screen').classList.remove('active');
  document.getElementById('app').classList.add('active');
  if(window.LumaneAlertFailures&&typeof window.LumaneAlertFailures.syncForCurrentUser==='function'){
    window.LumaneAlertFailures.syncForCurrentUser();
  }
  const roleEl=document.getElementById('topbar-role');
  roleEl.textContent=isAdmin()?'관리자':'발주자';
  roleEl.className='topbar-role '+(isAdmin()?'role-admin':'role-orderer');
  {const _ui=document.getElementById('sb-user-info');_ui.textContent='';const _s=document.createElement('strong');_s.textContent=currentUser.name;_ui.appendChild(_s);_ui.appendChild(document.createTextNode(isAdmin()?'관리자':'발주자'));}
  document.getElementById('topbar-date').textContent=new Date().toLocaleDateString('ko-KR',{year:'numeric',month:'long',day:'numeric',weekday:'short'});
  // 프로필 초기화
  const initial=currentUser.name.charAt(0);
  const avatarEl=document.getElementById('profile-avatar');
  const nameEl=document.getElementById('profile-name');
  const ddName=document.getElementById('dd-name');
  const ddRole=document.getElementById('dd-role');
  const ddId=document.getElementById('dd-id');
  if(avatarEl)avatarEl.textContent=initial;
  if(nameEl)nameEl.textContent=currentUser.name;
  if(ddName)ddName.textContent=currentUser.name;
  if(ddRole)ddRole.textContent=isAdmin()?'관리자':'발주자';
  if(ddId)ddId.textContent='아이디: '+currentUser.id;
  initDateInputs();
  renderNav();
  const _savedView=(typeof getUserPref==='function')?getUserPref('lastView',''):'';
  const _hashView=location.hash.slice(1);
  const _ADMIN_VIEWS=new Set(['items','inventory','price-settings','accounts','purchase-requests','logs','shortage-view']);
  const _raw=_hashView||_savedView||'dashboard';
  const _restoreView=(!isAdmin()&&_ADMIN_VIEWS.has(_raw))?'dashboard':_raw;
  navigate(_restoreView,{addHistory:false});
  setupDateInput('o-date');
  setupDateInput('o-ship-date');
  // 비밀번호 보기 토글 초기화
  ['login-pw','reg-pw','reg-pw2','setup-pw','setup-pw2','profile-pw','profile-pw2','acc-pw'].forEach(wrapPwToggle);
}

document.getElementById('login-pw').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
document.getElementById('login-id').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('login-pw').focus();});

// 최초 관리자 계정 생성 처리
async function doAdminSetup(){
  const id=document.getElementById('setup-id').value.trim();
  const name=document.getElementById('setup-name').value.trim();
  const email=document.getElementById('setup-email').value.trim();
  const pw=document.getElementById('setup-pw').value;
  const pw2=document.getElementById('setup-pw2').value;
  const errEl=document.getElementById('setup-error');
  errEl.style.display='none';
  if(!id){errEl.style.display='block';errEl.textContent='아이디를 입력해주세요.';return;}
  if(id.length<4){errEl.style.display='block';errEl.textContent='아이디는 4자 이상이어야 합니다.';return;}
  if(!name){errEl.style.display='block';errEl.textContent='이름을 입력해주세요.';return;}
  if(!email){errEl.style.display='block';errEl.textContent='이메일을 입력해주세요.';return;}
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){errEl.style.display='block';errEl.textContent='올바른 이메일 형식이 아닙니다.';return;}
  if(!pw||pw.length<6){errEl.style.display='block';errEl.textContent='비밀번호는 6자 이상이어야 합니다.';return;}
  if(pw!==pw2){errEl.style.display='block';errEl.textContent='비밀번호가 일치하지 않습니다.';return;}
  // 관리자 계정 중복 확인
  const accounts=DB.get('accounts',[]);
  if(accounts.find(a=>a.id===id)){errEl.style.display='block';errEl.textContent='이미 사용 중인 아이디입니다.';return;}
  if(accounts.find(a=>a.email&&a.email===email)){errEl.style.display='block';errEl.textContent='이미 가입된 이메일입니다.';return;}
  if(!window._fbAuth){errEl.style.display='block';errEl.textContent='서버 연결 중입니다. 잠시 후 다시 시도해주세요.';return;}
  // Firebase Auth 등록
  try{
    await window._fbAuth.createUserWithEmailAndPassword(email,pw);
  }catch(e){
    errEl.style.display='block';
    if(e.code==='auth/email-already-in-use'){
      errEl.textContent='이미 가입된 이메일입니다.';
    }else{
      errEl.textContent='계정 생성 중 오류가 발생했습니다.';
      console.warn('[Firebase Auth 관리자 등록 실패]',e.code,e.message);
    }
    return;
  }
  // pw 필드 없이 저장
  try{
    accounts.push({id,name,email,role:'admin'});
    DB.set('accounts',accounts);
  }catch(e){
    if(window._fbAuth.currentUser)await window._fbAuth.currentUser.delete().catch(()=>{});
    errEl.style.display='block';errEl.textContent='계정 저장 중 오류가 발생했습니다. 다시 시도해주세요.';
    return;
  }
  // 생성 후 자동 로그인
  currentUser={id,name,role:'admin'};
  DB.set('session',currentUser);
  document.getElementById('admin-setup-screen').classList.remove('active');
  showApp();
  toast(name+'님, 관리자 계정이 생성되었습니다.','success');
}
document.getElementById('setup-pw2').addEventListener('keydown',e=>{if(e.key==='Enter')doAdminSetup();});

// 회원가입
function showRegister(){
  document.getElementById('login-screen').classList.remove('active');
  document.getElementById('register-screen').classList.add('active');
  ['reg-delivery-name','reg-id','reg-email','reg-pw','reg-pw2'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('reg-error').style.display='none';
  document.getElementById('reg-success').style.display='none';
}
function showLoginScreen(){
  document.getElementById('register-screen').classList.remove('active');
  document.getElementById('admin-setup-screen').classList.remove('active');
  const fpScreen=document.getElementById('forgot-password-screen');
  if(fpScreen) fpScreen.classList.remove('active');
  document.getElementById('login-screen').classList.add('active');
  setLoginTab('orderer');
}
async function doRegister(){
  const deliveryName=document.getElementById('reg-delivery-name').value.trim();
  const id         =document.getElementById('reg-id').value.trim();
  const email      =document.getElementById('reg-email').value.trim();
  const pw         =document.getElementById('reg-pw').value;
  const pw2        =document.getElementById('reg-pw2').value;
  const errEl      =document.getElementById('reg-error');
  errEl.style.display='none';
  if(!deliveryName){errEl.style.display='block';errEl.textContent='납품처 이름을 입력해주세요.';return;}
  if(!id){errEl.style.display='block';errEl.textContent='아이디를 입력해주세요.';return;}
  if(id.length<4){errEl.style.display='block';errEl.textContent='아이디는 4자 이상이어야 합니다.';return;}
  if(!email){errEl.style.display='block';errEl.textContent='이메일을 입력해주세요.';return;}
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){errEl.style.display='block';errEl.textContent='올바른 이메일 형식이 아닙니다.';return;}
  if(!pw){errEl.style.display='block';errEl.textContent='비밀번호를 입력해주세요.';return;}
  if(pw.length<6){errEl.style.display='block';errEl.textContent='비밀번호는 6자 이상이어야 합니다.';return;}
  if(pw!==pw2){errEl.style.display='block';errEl.textContent='비밀번호가 일치하지 않습니다.';return;}
  const accounts=DB.get('accounts',[]);
  if(accounts.find(a=>a.id===id)){errEl.style.display='block';errEl.textContent='이미 사용 중인 아이디입니다.';return;}
  if(accounts.find(a=>a.email&&a.email===email)){errEl.style.display='block';errEl.textContent='이미 가입된 이메일입니다.';return;}
  if(!window._fbAuth){errEl.style.display='block';errEl.textContent='서버 연결 중입니다. 잠시 후 다시 시도해주세요.';return;}
  // Firebase Auth 등록 (주 인증)
  try{
    await window._fbAuth.createUserWithEmailAndPassword(email,pw);
  }catch(e){
    errEl.style.display='block';
    if(e.code==='auth/email-already-in-use'){
      errEl.textContent='이미 가입된 이메일입니다.';
    }else{
      errEl.textContent='가입 중 오류가 발생했습니다.';
      console.warn('[Firebase Auth 가입 실패]',e.code,e.message);
    }
    return;
  }
  // pw 필드 없이 계정 저장
  try{
    accounts.push({id,name:deliveryName,deliveryName,email,role:'orderer'});
    DB.set('accounts',accounts);
  }catch(e){
    if(window._fbAuth.currentUser)await window._fbAuth.currentUser.delete().catch(()=>{});
    errEl.style.display='block';errEl.textContent='계정 저장 중 오류가 발생했습니다. 다시 시도해주세요.';
    return;
  }
  currentUser={id,name:deliveryName,deliveryName,role:'orderer'};
  DB.set('session',currentUser);
  document.getElementById('register-screen').classList.remove('active');
  showApp();
  toast(deliveryName+'님, 가입을 환영합니다!','success');
}
document.getElementById('reg-pw2').addEventListener('keydown',e=>{if(e.key==='Enter')doRegister();});

// 비밀번호 찾기
function showForgotPassword(){
  document.getElementById('login-screen').classList.remove('active');
  const fpScreen=document.getElementById('forgot-password-screen');
  if(fpScreen){
    fpScreen.classList.add('active');
    const emailEl=document.getElementById('forgot-email');
    if(emailEl) emailEl.value='';
    const errEl=document.getElementById('forgot-error');
    const okEl=document.getElementById('forgot-success');
    if(errEl) errEl.style.display='none';
    if(okEl) okEl.style.display='none';
    setTimeout(()=>{ if(emailEl) emailEl.focus(); },100);
  }
}
async function doForgotPassword(){
  const emailEl=document.getElementById('forgot-email');
  const errEl=document.getElementById('forgot-error');
  const okEl=document.getElementById('forgot-success');
  if(!emailEl||!errEl||!okEl) return;
  errEl.style.display='none';
  okEl.style.display='none';
  const email=emailEl.value.trim();
  if(!email){ errEl.style.display='block'; errEl.textContent='이메일을 입력해주세요.'; return; }
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ errEl.style.display='block'; errEl.textContent='올바른 이메일 형식이 아닙니다.'; return; }
  if(!window._fbAuth){ errEl.style.display='block'; errEl.textContent='서버 연결 중입니다. 잠시 후 다시 시도해주세요.'; return; }
  try{
    await window._fbAuth.sendPasswordResetEmail(email);
    okEl.style.display='block';
    okEl.textContent='재설정 링크를 보냈습니다. 이메일을 확인해주세요.';
    emailEl.value='';
  } catch(e){
    errEl.style.display='block';
    if(e.code==='auth/user-not-found'){
      errEl.textContent='해당 이메일로 가입된 계정이 없습니다.';
    } else if(e.code==='auth/invalid-email'){
      errEl.textContent='올바른 이메일 형식이 아닙니다.';
    } else if(e.code==='auth/too-many-requests'){
      errEl.textContent='요청이 너무 많습니다. 잠시 후 다시 시도해주세요.';
    } else {
      errEl.textContent='오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
      console.warn('[비밀번호 찾기 오류]', e.code, e.message);
    }
  }
}

// 품목 초기 데이터
const DEFAULT_ITEMS=[
  // 서랍장 (재고 관리 대상)
  {name:'겉서랍 2단',       category:'서랍장',drawerType:'outer',currentStock:0},
  {name:'속서랍 2단',       category:'서랍장',drawerType:'inner',currentStock:0},
  {name:'겉서랍 3단',       category:'서랍장',drawerType:'outer',currentStock:0},
  {name:'속서랍 3단',       category:'서랍장',drawerType:'inner',currentStock:0},
  {name:'겉서랍 4단',       category:'서랍장',drawerType:'outer',currentStock:0},
  {name:'속서랍 4단',       category:'서랍장',drawerType:'inner',currentStock:0},
  {name:'겉서랍 5단',       category:'서랍장',drawerType:'outer',currentStock:0},
  {name:'속서랍 5단',       category:'서랍장',drawerType:'inner',currentStock:0},
  {name:'겉서랍 아일랜드',  category:'서랍장',drawerType:'outer',currentStock:0},
  {name:'속서랍 아일랜드',  category:'서랍장',drawerType:'inner',currentStock:0},
  // 옵션 (활성 품목은 재고 관리 대상)
  {name:'거울장',              category:'옵션',currentStock:0},
  {name:'디바이더',            category:'옵션',currentStock:0},
  {name:'이불장',              category:'옵션',currentStock:0},
  {name:'화장대세트',          category:'옵션',currentStock:0},
  {name:'인출식 바지걸이',     category:'옵션',currentStock:0,hasColor:true,colorOptions:['화이트','블랙']},
  {name:'선반재단비',          category:'서비스',currentStock:0},
  {name:'포스트조립비',        category:'서비스',currentStock:0},
];

function initData(){
  initAccounts();
  if(DB.get('items',[]).length===0){
    DB.set('items',DEFAULT_ITEMS.map((it,i)=>({
      id:i+1,
      ...it,
      ...(it.category==='옵션'?{
        trackStock:true,
        stockSiheung:0,stockPyeongtaek:0,stockOsan:0,
        colorStockSiheung:{},colorStockPyeongtaek:{},colorStockOsan:{}
      }:{}),
      isActive:true,
      createdAt:new Date().toISOString()
    })));
    DB.set('_seq_items',DEFAULT_ITEMS.length);
    DB.set('orders',[]);
    DB.set('purchase_requests',[]);
    DB.set('logs',[]);
  } else {
    // items Firestore write 잠금 — 마이그레이션 중 중간 상태가 Firestore에 올라가지 않도록
    const _itemsInitBase=DB.get('items',[]);
    window._itemsInitLock = true;
    // 마이그레이션: 선반바(ABS) 400이 서랍/옵션 목록에 잘못 들어간 경우만 제거 (상부자재는 유지)
    {const _items=DB.get('items',[]);const _before=_items.length;
    const _cleaned=_items.filter(i=>i.name!=='선반바(ABS) 400'||i.category==='상부자재');
    if(_cleaned.length<_before)DB.set('items',_cleaned);}
    // 기존 DB 마이그레이션: 인출식 바지걸이 보정
    let items=DB.get('items',[]);
    const target=items.find(i=>i.name==='인출식 바지걸이');
    if(!target){
      // 없으면 추가
      const newId=Math.max(0,...items.map(i=>i.id||0))+1;
      items.push({id:newId,name:'인출식 바지걸이',category:'옵션',currentStock:0,hasColor:true,colorOptions:['화이트','블랙'],isActive:true,createdAt:new Date().toISOString()});
      DB.set('items',items);
    } else {
      // 있으면 속성 보정
      let changed=false;
      if(target.category!=='옵션'){target.category='옵션';changed=true;}
      if(!target.hasColor){target.hasColor=true;changed=true;}
      if(!target.colorOptions){target.colorOptions=['화이트','블랙'];changed=true;}
      if(changed)DB.set('items',items);
    }
    // 마이그레이션: 선반재단비, 포스트조립비 없으면 추가
    {
      let _items=DB.get('items',[]);
      let _changed=false;
      const _svcItems=[
        {name:'선반재단비',category:'서비스',currentStock:0},
        {name:'포스트조립비',category:'서비스',currentStock:0},
      ];
      _svcItems.forEach(svc=>{
        if(!_items.find(i=>i.name===svc.name)){
          const newId=Math.max(0,..._items.map(i=>i.id||0))+1;
          _items.push({id:newId,...svc,isActive:true,createdAt:new Date().toISOString()});
          _changed=true;
        }
      });
      if(_changed)DB.set('items',_items);
    }
    // 마이그레이션: 창고별 재고(stockSiheung / stockPyeongtaek) 필드 추가
    {
      let _items=DB.get('items',[]);
      let _changed=false;
      _items.forEach(item=>{
        if(isTrackStock(item)){
          if(item.stockSiheung===undefined){item.stockSiheung=item.currentStock||0;_changed=true;}
          if(item.stockPyeongtaek===undefined){item.stockPyeongtaek=0;_changed=true;}
        }
      });
      if(_changed)DB.set('items',_items);
    }
    // 마이그레이션: 가격표 가구 전체 재고 추적 확장 (멱등 — 기존 값 절대 미덮어쓰기)
    try{
    {
      const _EXCLUDE=['선반재단비','포스트조립비','인출식 바지걸이'];
      // 재고칸 제거 대상 (재고표 미사용 품목 — trackStock 부여 안 함 + 기존 true는 정리)
      const _NOTRACK=['거울장 목대','거울장 거울문','이불장','이불 반장','이불 긴장','이불장손잡이(1구)','디바이더 속서랍','2단서랍 비규격','3단서랍 비규격','4단서랍 비규격'];
      // 실재고 존재 여부 (둘 다 빈/0이면 정리 안전)
      const _hasStock=it=>{
        const a=it.colorStockSiheung||{},b=it.colorStockPyeongtaek||{};
        const sum=k=>Object.values(k).reduce((s,v)=>s+(Number(v)||0),0);
        return sum(a)>0||sum(b)>0||(Number(it.stockSiheung)||0)>0||(Number(it.stockPyeongtaek)||0)>0;
      };
      let _items2=DB.get('items',[]);
      let _chg2=false;
      _items2.forEach(item=>{
        // 제거 대상: 실재고 없을 때만 trackStock=false 정리 (재부여 차단), 실재고 있으면 미접촉
        if(_NOTRACK.includes(item.name)){
          if(item.category==='서랍장')return;
          if(item.trackStock===true&&!_hasStock(item)){item.trackStock=false;_chg2=true;}
          return;
        }
        if(item.category==='서랍장')return;
        if(_EXCLUDE.includes(item.name))return;
        if(!DRAWER_OPTION_PRICES.hasOwnProperty(item.name))return;
        if(item.trackStock!==true){item.trackStock=true;_chg2=true;}
        if(item.stockSiheung===undefined){item.stockSiheung=0;_chg2=true;}
        if(item.stockPyeongtaek===undefined){item.stockPyeongtaek=0;_chg2=true;}
        if(item.colorStockSiheung===undefined){item.colorStockSiheung={};_chg2=true;}
        if(item.colorStockPyeongtaek===undefined){item.colorStockPyeongtaek={};_chg2=true;}
      });
      if(_chg2)DB.set('items',_items2);
    }
    }catch(_e){console.warn('[가구재고확장 마이그레이션 실패 — 안전 스킵]',_e&&_e.message);}
    // 재고 구조 전면 개편 v2: 겉서랍/속서랍 체계 (idempotent — 플래그 불필요)
    // 단가 설정 v2 초기화: 겉서랍/속서랍 단가 자동 세팅 (1회만 실행)
    if(!DB.getMig('price_init_v2')){
      const dp=getDefaultPrices();
      if(dp&&dp.length>0){
        DB.set('price_settings',dp);
        DB.setMig('price_init_v2');
      }
    }
    // 단가 설정 v3: 인출식 바지걸이·선반재단비·포스트조립비 항목 추가 (없으면 추가)
    {
      const ps=DB.get('price_settings',[]);
      const newItems=[
        {name:'인출식 바지걸이',category:'서랍/옵션',price:39000},
        {name:'선반재단비',category:'서랍/옵션',price:1000},
        {name:'포스트조립비',category:'서랍/옵션',price:3000},
      ];
      let changed=false;
      newItems.forEach(item=>{
        if(!ps.find(p=>p.name===item.name)){
          ps.push(item);
          changed=true;
        }
      });
      if(changed)DB.set('price_settings',ps);
    }
    // 마이그레이션: 공간박스 항목 추가 (없으면 추가)
    {
      let _items=DB.get('items',[]);
      if(!_items.find(i=>i.name==='공간박스')){
        const newId=Math.max(0,..._items.map(i=>i.id||0))+1;
        _items.push({id:newId,name:'공간박스',category:'옵션',currentStock:0,isActive:false,createdAt:new Date().toISOString()});
        DB.set('items',_items);
      }
    }
    // 마이그레이션: 상부자재 품목 추가/보정 (이카운트 연동용)
    {
      let _items=DB.get('items',[]);
      let _changed=false;
      // 없으면 추가
      const upperItems=[
        {name:'포스트 2050', colorProdCdMap:{'실버':'00032'}},
        {name:'스패너',      colorProdCdMap:{}, prodCd:'00059', noColor:true},
      ];
      upperItems.forEach(ui=>{
        const existing=_items.find(i=>i.name===ui.name);
        if(!existing){
          const newId=Math.max(0,..._items.map(i=>i.id||0))+1;
          _items.push({id:newId, name:ui.name, category:'상부자재', currentStock:0, isActive:true, createdAt:new Date().toISOString(), ...ui});
          _changed=true;
        } else {
          // 이미 있으면 누락 필드만 보정 (기존 colorProdCdMap 유지)
          if(ui.noColor&&!existing.noColor){existing.noColor=true;_changed=true;}
          if(ui.prodCd&&!existing.prodCd){
            // colorProdCdMap['실버']에 넣은 코드가 있으면 prodCd로 옮기기
            existing.prodCd=existing.colorProdCdMap?.['실버']||ui.prodCd;
            _changed=true;
          }
        }
      });
      if(_changed) DB.set('items',_items);
    }
    // 마이그레이션: 서랍장 비규격 3종 + 손잡이 추가 (없으면 추가, 발주서 미노출)
    {
      let _items=DB.get('items',[]);
      let _changed=false;
      const newItems=[
        {name:'2단서랍 비규격', category:'서랍장', drawerType:'outer', colorOptions:['화이트오크']},
        {name:'3단서랍 비규격', category:'서랍장', drawerType:'outer', colorOptions:['솔리드화이트','화이트오크']},
        {name:'4단서랍 비규격', category:'서랍장', drawerType:'outer', colorOptions:['화이트오크']},
        {name:'서랍장손잡이(속서랍용)', category:'옵션', colorOptions:['실버','블랙','골드']},
      ];
      newItems.forEach(ni=>{
        const existing=_items.find(i=>i.name===ni.name);
        if(!existing){
          const newId=Math.max(0,..._items.map(i=>i.id||0))+1;
          _items.push({id:newId,...ni,currentStock:0,isActive:false,createdAt:new Date().toISOString()});
          _changed=true;
        } else if(!existing.colorOptions){
          // 이미 있지만 colorOptions 없으면 업데이트
          existing.colorOptions=ni.colorOptions;
          _changed=true;
        }
      });
      if(_changed)DB.set('items',_items);
    }
    // 마이그레이션: 이불장 → 이불 반장/긴장 분리
    {
      let _items=DB.get('items',[]);
      let _changed=false;
      const SHELF_C=['화이트 오크','솔리드','메이플','다크월넛','진그레이','스톤그레이','민트그린'];
      // 이불장 비활성화
      const ibulIdx=_items.findIndex(i=>i.name==='이불장');
      if(ibulIdx!==-1&&_items[ibulIdx].isActive!==false){
        _items[ibulIdx].isActive=false;
        _changed=true;
      }
      // 이불 반장/긴장 추가
      [{name:'이불 반장',price:80000},{name:'이불 긴장',price:220000}].forEach(ni=>{
        if(!_items.find(i=>i.name===ni.name)){
          const newId=Math.max(0,..._items.map(i=>i.id||0))+1;
          _items.push({id:newId,name:ni.name,category:'옵션',currentStock:0,isActive:true,colorOptions:SHELF_C,createdAt:new Date().toISOString()});
          _changed=true;
        }
      });
      if(_changed)DB.set('items',_items);
      // price_settings에 누락 시 추가 (기존 가격은 보존 — UI 변경값 유지)
      let _ps=DB.get('price_settings',[]);
      let _psChanged=false;
      [{name:'이불 반장',price:80000},{name:'이불 긴장',price:255000}].forEach(ni=>{
        const existing=_ps.find(p=>p.name===ni.name);
        if(!existing){
          _ps.push({name:ni.name,category:'서랍/옵션',price:ni.price});
          _psChanged=true;
        }
      });
      if(_psChanged)DB.set('price_settings',_ps);
    }
    // 마이그레이션: 품목 마스터 items → price_settings 동기화 (누락된 항목 추가)
    {
      const _items=DB.get('items',[]);
      const _ps=DB.get('price_settings',[]);
      let _changed=false;
      _items.forEach(item=>{
        if(!item.name)return;
        const already=_ps.find(p=>(p.name||'').replace(/\s+/g,'').trim()===(item.name||'').replace(/\s+/g,'').trim());
        if(already){
          // price_settings에 있는데 null이면 DRAWER_OPTION_PRICES로 복원 시도
          if((already.price===null||already.price===undefined)){
            const dp=DRAWER_OPTION_PRICES&&DRAWER_OPTION_PRICES[item.name];
            if(dp!==undefined&&dp!==null){already.price=dp;_changed=true;}
          }
          return;
        }
        // 없으면 추가
        const dp=DRAWER_OPTION_PRICES&&DRAWER_OPTION_PRICES[item.name];
        const cat=(item.category==='서랍장'||item.category==='옵션'||item.category==='서비스')?'서랍/옵션':item.category;
        _ps.push({name:item.name,category:cat,price:dp!==undefined?dp:null});
        _changed=true;
      });
      if(_changed)DB.set('price_settings',_ps);
    }
    // 마이그레이션: 서브타입 품목 추가 (거울장 목대, 화장대(대), 이불장 부자재 등)
    {
      let _items=DB.get('items',[]);
      let _changed=false;
      const subtypeItems=[
        {name:'거울장 목대',             category:'옵션',isSubtype:true,
          colorProdCdMap:{'솔리드화이트':'117','화이트오크':'118','메이플':'119','다크월넛':'120','진그레이':'121','스톤그레이':'122'}},
        {name:'거울장 거울문',            category:'옵션',isSubtype:true,
          colorProdCdMap:{'블랙':'249','실버':'250','골드':'00004'}},
        {name:'화장대(대)',               category:'옵션',isSubtype:true,
          colorProdCdMap:{'솔리드화이트':'143','화이트오크':'144','메이플':'145','다크월넛':'146','진그레이':'147','스톤그레이':'148'}},
        {name:'화장대 디바이더',          category:'옵션',isSubtype:true,
          colorProdCdMap:{'솔리드화이트':'135','화이트오크':'136','메이플':'137','다크월넛':'138','진그레이':'139','스톤그레이':'140'}},
        {name:'화장대(디바이더 600포함)', category:'옵션',isSubtype:true,
          colorProdCdMap:{'솔리드화이트':'129','화이트오크':'130','메이플':'131','다크월넛':'132','진그레이':'133','스톤그레이':'134','민트그린':'00019'}},
        {name:'화장대 거울문',            category:'옵션',isSubtype:true,
          colorProdCdMap:{'실버':'141','블랙':'142'}},
        {name:'디바이더 속서랍',          category:'옵션',isSubtype:true,
          colorProdCdMap:{'솔리드화이트':'241','스톤그레이':'242','민트그린':'243'}},
        {name:'이불장 목대',              category:'옵션',isSubtype:true,
          colorProdCdMap:{'솔리드화이트':'191','화이트오크':'192','메이플':'193','다크월넛':'194','진그레이':'195','스톤그레이':'196'}},
        {name:'이불장손잡이(1구)',         category:'옵션',isSubtype:true,noColor:true,prodCd:'00014'},
        {name:'이불 긴장문',              category:'옵션',isSubtype:true,
          colorProdCdMap:{'솔리드화이트':'179','화이트오크':'180','메이플':'181','다크월넛':'182','진그레이':'183','스톤그레이':'184'}},
        {name:'이불 반장문',              category:'옵션',isSubtype:true,
          colorProdCdMap:{'솔리드화이트':'185','화이트오크':'186','메이플':'187','다크월넛':'188','진그레이':'189','스톤그레이':'190','민트그린':'00022'}},
      ];
      subtypeItems.forEach(si=>{
        const existing=_items.find(i=>i.name===si.name);
        if(!existing){
          const newId=Math.max(0,..._items.map(i=>i.id||0))+1;
          _items.push({id:newId,...si,currentStock:0,isActive:true,createdAt:new Date().toISOString()});
          _changed=true;
        } else {
          if(!existing.isSubtype){existing.isSubtype=true;_changed=true;}
          if(si.colorProdCdMap&&!existing.colorProdCdMap){existing.colorProdCdMap=si.colorProdCdMap;_changed=true;}
          if(si.noColor&&!existing.noColor){existing.noColor=true;_changed=true;}
          if(si.prodCd&&!existing.prodCd){existing.prodCd=si.prodCd;_changed=true;}
        }
      });
      // 이불 긴장/반장 이카운트 코드 보정
      const ibulCodes={
        '이불 긴장':{colorProdCdMap:{'솔리드화이트':'167','화이트오크':'168','메이플':'169','다크월넛':'170','진그레이':'171','스톤그레이':'172'}},
        '이불 반장':{colorProdCdMap:{'솔리드화이트':'173','화이트오크':'174','메이플':'175','다크월넛':'176','진그레이':'177','스톤그레이':'178','민트그린':'00021'}},
      };
      Object.entries(ibulCodes).forEach(([nm,data])=>{
        const it=_items.find(i=>i.name===nm);
        if(it&&!it.colorProdCdMap){it.colorProdCdMap=data.colorProdCdMap;_changed=true;}
      });
      if(_changed)DB.set('items',_items);
    }
    // 마이그레이션: 중복 품목 제거 (같은 이름 2개↑ → 데이터 많은 쪽 유지, 발주서 itemId 자동 교체)
    if(!DB.getMig('dedup_items_v1')){
      let _items=DB.get('items',[]);
      const nameMap=new Map();
      _items.forEach(item=>{
        const existing=nameMap.get(item.name);
        if(!existing){nameMap.set(item.name,item);}
        else{
          const existScore=(existing.colorProdCdMap?2:0)+(existing.isSubtype?1:0);
          const newScore=(item.colorProdCdMap?2:0)+(item.isSubtype?1:0);
          if(newScore>existScore)nameMap.set(item.name,item);
        }
      });
      const keepIds=new Set([...nameMap.values()].map(i=>i.id));
      const idRemap=new Map();
      _items.forEach(item=>{if(!keepIds.has(item.id)){const kept=nameMap.get(item.name);if(kept)idRemap.set(item.id,kept.id);}});
      if(idRemap.size>0){
        const _oi=DB.get('order_items',[]);let _oiC=false;
        _oi.forEach(oi=>{if(idRemap.has(oi.itemId)){oi.itemId=idRemap.get(oi.itemId);_oiC=true;}});
        if(_oiC)DB.set('order_items',_oi);
        const _logs=DB.get('logs',[]);let _lC=false;
        _logs.forEach(l=>{if(idRemap.has(l.itemId)){l.itemId=idRemap.get(l.itemId);_lC=true;}});
        if(_lC)DB.set('logs',_logs);
        const _prs=DB.get('purchase_requests',[]);let _pC=false;
        _prs.forEach(pr=>{if(idRemap.has(pr.itemId)){pr.itemId=idRemap.get(pr.itemId);_pC=true;}});
        if(_pC)DB.set('purchase_requests',_prs);
        _items=_items.filter(i=>keepIds.has(i.id));
        DB.set('items',_items);
      }
      DB.setMig('dedup_items_v1');
    }
    // 중복 품목 제거 v2 — ERP 코드 합친 후 하나만 남김
    if(!DB.getMig('dedup_items_v2')){
      let _items=DB.get('items',[]);
      const byName=new Map();
      _items.forEach(i=>{ if(!byName.has(i.name)) byName.set(i.name,[]); byName.get(i.name).push(i); });
      const keepIds=new Set();
      const idRemap=new Map();
      byName.forEach((group)=>{
        if(group.length===1){ keepIds.add(group[0].id); return; }
        // ERP 코드 많은 순 정렬
        group.sort((a,b)=>{
          const ac=Object.keys(a.colorProdCdMap||{}).length+(a.prodCd?10:0);
          const bc=Object.keys(b.colorProdCdMap||{}).length+(b.prodCd?10:0);
          return bc-ac;
        });
        const winner=group[0];
        // 나머지 ERP 코드를 winner에 병합
        group.slice(1).forEach(dup=>{
          if(dup.colorProdCdMap) winner.colorProdCdMap=Object.assign({},dup.colorProdCdMap,winner.colorProdCdMap||{});
          if(dup.prodCd&&!winner.prodCd) winner.prodCd=dup.prodCd;
          if(dup.subTypeProdCdMap) winner.subTypeProdCdMap=Object.assign({},dup.subTypeProdCdMap,winner.subTypeProdCdMap||{});
          idRemap.set(dup.id, winner.id);
        });
        keepIds.add(winner.id);
      });
      if(idRemap.size>0){
        ['order_items','logs','purchase_requests'].forEach(key=>{
          const arr=DB.get(key,[]); let changed=false;
          arr.forEach(r=>{ if(idRemap.has(r.itemId)){r.itemId=idRemap.get(r.itemId);changed=true;} });
          if(changed) DB.set(key,arr);
        });
        DB.set('items',_items.filter(i=>keepIds.has(i.id)));
      }
      DB.setMig('dedup_items_v2');
    }
    // 마이그레이션: 상부자재·선반·코너선반·옷봉 품목을 items DB에 통합
    if(!DB.getMig('upper_items_v2')){
      let _items=DB.get('items',[]);
      let _changed=false;
      const now=new Date().toISOString();
      const nextId=()=>Math.max(0,..._items.map(i=>i.id||0))+1;

      // 구버전 이름 → 정규화 이름 (DB에서 이름 교체)
      const _renameMap={
        '포스트 2050':'포스트바 2050','포스트 2250':'포스트바 2250','포스트 2400':'포스트바 2400',
        '선반바 400':'선반바(ABS) 400',
        '옷봉캡(단방)':'옷봉캡','옷봉캡(양방)':'옷봉캡',
        '코너옷봉캡':'코너 옷봉캡 (단방, 양방)','코너옷봉캡(단방)':'코너 옷봉캡 (단방, 양방)','코너옷봉캡(양방)':'코너 옷봉캡 (단방, 양방)',
        '조절방 연장캡 15mm':'조절발 연장캡','포스트조절발(연장캡 15mm)':'조절발 연장캡','벽고정앵글':'벽고정 앵글',
      };
      _items.forEach(item=>{
        if(_renameMap[item.name]){
          // 이미 정규화 이름이 있으면 스킵 (중복 방지)
          if(!_items.find(i=>i.name===_renameMap[item.name]&&i.id!==item.id)){
            item.name=_renameMap[item.name];_changed=true;
          }
        }
      });

      // 추가할 품목 정의
      const toAdd=[
        // 상부자재 (포스트바 계열 - 색상 있음)
        {name:'포스트바 2050',category:'상부자재'},
        {name:'포스트바 2250',category:'상부자재'},
        {name:'포스트바 2400',category:'상부자재'},
        {name:'선반바(ABS) 400',category:'상부자재'},
        // 상부자재 (단색/단일코드 계열)
        {name:'코너바 2200',category:'상부자재'},
        {name:'코너앵글',category:'상부자재'},
        {name:'조절발',category:'상부자재'},
        {name:'포스트마감캡',category:'상부자재'},
        {name:'옷봉캡',category:'상부자재'},
        {name:'코너 옷봉캡 (단방, 양방)',category:'상부자재'},
        {name:'포스트연결캡',category:'상부자재'},
        {name:'조절발 연장캡',category:'상부자재'},
        {name:'벽고정 앵글',category:'상부자재'},
        {name:'벽고정 프레임 800',category:'상부자재',noColor:true},
        {name:'벽고정 프레임 1000',category:'상부자재',noColor:true},
        {name:'스패너',category:'상부자재',noColor:true},
        // 옷봉
        {name:'옷봉 2400',category:'옷봉'},
        // 선반
        {name:'선반 370',category:'선반'},
        {name:'선반 570',category:'선반'},
        {name:'선반 770',category:'선반'},
        {name:'선반 2400',category:'선반'},
        {name:'선반 비규격',category:'선반'},
        // 코너선반
        {name:'코너선반 780',category:'코너선반'},
        {name:'코너선반 비규격',category:'코너선반'},
      ];
      toAdd.forEach(ni=>{
        if(!_items.find(i=>i.name===ni.name)){
          _items.push({id:nextId(),currentStock:0,isActive:true,createdAt:now,...ni});
          _changed=true;
        }
      });
      if(_changed)DB.set('items',_items);
      DB.setMig('upper_items_v2');
    }
    // 조절발 연장캡 15mm → 조절발 연장캡 이름 변경 (1회성 — 이름 변경은 구조 변경)
    if(!DB.getMig('rename_ext_cap_v1')){
      let _items=DB.get('items',[]);
      const old=_items.find(i=>i.name==='조절발 연장캡 15mm');
      if(old){old.name='조절발 연장캡';DB.set('items',_items);}
      DB.setMig('rename_ext_cap_v1');
    }
    // 잘못된 선반 품목 제거 v1 (1회성)
    if(!DB.getMig('clean_shelf_items_v1')){
      let _items=DB.get('items',[]);
      const removeNames=['비규격 선반','비규격 코너선반','코너선반'];
      const filtered=_items.filter(i=>!removeNames.includes(i.name));
      if(filtered.length<_items.length)DB.set('items',filtered);
      DB.setMig('clean_shelf_items_v1');
    }
    // 잘못된 선반 품목 제거 v2 — Firestore에서 재유입된 구버전 중복 이름 재정리
    if(!DB.getMig('clean_shelf_items_v2')){
      let _items=DB.get('items',[]);
      const removeNames=['비규격 선반','비규격 코너선반','코너선반'];
      const filtered=_items.filter(i=>!removeNames.includes(i.name));
      if(filtered.length<_items.length){DB.set('items',filtered);console.log('[cleanup v2] 구버전 선반 중복 제거');}
      DB.setMig('clean_shelf_items_v2');
    }
    // ── 필드 보정 (매번 실행 — Firestore 덮어써도 자동 복구) ──
    {
      let _items=DB.get('items',[]);
      let _changed=false;
      // noColor 제거 대상 (색상별 코드 입력 가능해야 하는 품목)
      const shouldHaveColor=['옷봉캡','코너 옷봉캡 (단방, 양방)','조절발','포스트마감캡',
                             '포스트연결캡','조절발 연장캡','코너앵글'];
      shouldHaveColor.forEach(nm=>{
        const it=_items.find(i=>i.name===nm);
        if(it&&it.noColor){it.noColor=false;_changed=true;}
      });
      // colorOptions 보정 (ERP 모달에서 올바른 색상 행 표시용)
      // 디바이더 속서랍 colorOptions 제거 + colorProdCdMap 보정 (공통색 기준 활성/비활성 처리)
      {
        const it=_items.find(i=>i.name==='디바이더 속서랍');
        if(it){
          if(it.colorOptions){delete it.colorOptions;_changed=true;}
          // colorProdCdMap 비어있으면 기본값 세팅 (없으면 비활성화 로직이 동작 안 함)
          if(!it.colorProdCdMap||Object.keys(it.colorProdCdMap).length===0){
            it.colorProdCdMap={'솔리드화이트':'241','스톤그레이':'242','민트그린':'243'};
            _changed=true;
          }
        }
      }
      const colorOptionsMap={
        '거울장 거울문':    ['골드','블랙','실버'],
        '화장대 거울문':    ['실버','블랙'],
      };
      Object.entries(colorOptionsMap).forEach(([nm,opts])=>{
        const it=_items.find(i=>i.name===nm);
        if(!it)return;
        const same=it.colorOptions&&it.colorOptions.length===opts.length&&opts.every((v,i2)=>it.colorOptions[i2]===v);
        if(!same){it.colorOptions=opts;_changed=true;}
      });
      if(_changed)DB.set('items',_items);
    }
    // ── 중복 품목 제거 v3 (이름 기준 — 매번 실행하여 중복 즉시 제거) ──
    {
      let _items=DB.get('items',[]);
      const byName=new Map();
      _items.forEach(i=>{
        if(!byName.has(i.name))byName.set(i.name,[]);
        byName.get(i.name).push(i);
      });
      let hasDup=false;
      byName.forEach(group=>{if(group.length>1)hasDup=true;});
      if(hasDup){
        const keepIds=new Set();
        const idRemap=new Map();
        byName.forEach(group=>{
          if(group.length===1){keepIds.add(group[0].id);return;}
          // ERP 코드 많은 순 정렬 후 winner 선정
          group.sort((a,b)=>{
            const as=Object.keys(a.colorProdCdMap||{}).length+(a.prodCd?10:0)+(a.isActive?5:0);
            const bs=Object.keys(b.colorProdCdMap||{}).length+(b.prodCd?10:0)+(b.isActive?5:0);
            return bs-as;
          });
          const winner=group[0];
          group.slice(1).forEach(dup=>{
            if(dup.colorProdCdMap)winner.colorProdCdMap=Object.assign({},dup.colorProdCdMap,winner.colorProdCdMap||{});
            if(dup.prodCd&&!winner.prodCd)winner.prodCd=dup.prodCd;
            idRemap.set(dup.id,winner.id);
          });
          keepIds.add(winner.id);
        });
        if(idRemap.size>0){
          ['order_items','logs','purchase_requests'].forEach(key=>{
            const arr=DB.get(key,[]);let changed=false;
            arr.forEach(r=>{if(idRemap.has(r.itemId)){r.itemId=idRemap.get(r.itemId);changed=true;}});
            if(changed)DB.set(key,arr);
          });
        }
        const deduped=_items.filter(i=>keepIds.has(i.id));
        DB.set('items',deduped);
        console.log(`[dedup v3] ${_items.length}→${deduped.length}개`);
      }
    }
    // ── 누락 품목 복구 (매번 실행 — 삭제된 품목 자동 복원) ──
    {
      let _items=DB.get('items',[]);
      let _changed=false;
      const _ensure=(spec)=>{
        if(_items.find(i=>i.name===spec.name))return;
        const newId=Math.max(0,..._items.map(i=>i.id||0))+1;
        _items.push({id:newId,currentStock:0,isActive:true,createdAt:new Date().toISOString(),...spec});
        _changed=true;
      };
      // 서랍장 기본 품목
      [{name:'겉서랍 2단',category:'서랍장',drawerType:'outer'},{name:'속서랍 2단',category:'서랍장',drawerType:'inner'},
       {name:'겉서랍 3단',category:'서랍장',drawerType:'outer'},{name:'속서랍 3단',category:'서랍장',drawerType:'inner'},
       {name:'겉서랍 4단',category:'서랍장',drawerType:'outer'},{name:'속서랍 4단',category:'서랍장',drawerType:'inner'},
       {name:'겉서랍 5단',category:'서랍장',drawerType:'outer'},{name:'속서랍 5단',category:'서랍장',drawerType:'inner'},
       {name:'겉서랍 아일랜드',category:'서랍장',drawerType:'outer'},{name:'속서랍 아일랜드',category:'서랍장',drawerType:'inner'}
      ].forEach(_ensure);
      // 옵션/서비스 기본 품목
      [{name:'거울장',category:'옵션'},{name:'디바이더',category:'옵션'},{name:'이불장',category:'옵션'},
       {name:'화장대세트',category:'옵션'},{name:'공간박스',category:'옵션'},
       {name:'인출식 바지걸이',category:'옵션',hasColor:true,colorOptions:['화이트','블랙']},
       {name:'이불 반장',category:'옵션',colorOptions:['화이트 오크','솔리드','메이플','다크월넛','진그레이','스톤그레이','민트그린']},
       {name:'이불 긴장',category:'옵션',colorOptions:['화이트 오크','솔리드','메이플','다크월넛','진그레이','스톤그레이','민트그린']},
       {name:'선반재단비',category:'서비스'},{name:'포스트조립비',category:'서비스'},
       {name:'2단서랍 비규격',category:'서랍장',drawerType:'outer',colorOptions:['화이트오크']},
       {name:'3단서랍 비규격',category:'서랍장',drawerType:'outer',colorOptions:['솔리드화이트','화이트오크']},
       {name:'4단서랍 비규격',category:'서랍장',drawerType:'outer',colorOptions:['화이트오크']},
      ].forEach(_ensure);
      // 서브타입 품목
      [{name:'거울장 목대',category:'옵션',isSubtype:true},
       {name:'거울장 거울문',category:'옵션',isSubtype:true,colorOptions:['골드','블랙','실버']},
       {name:'화장대(대)',category:'옵션',isSubtype:true},
       {name:'화장대 디바이더',category:'옵션',isSubtype:true},
       {name:'화장대(디바이더 600포함)',category:'옵션',isSubtype:true},
       {name:'화장대 거울문',category:'옵션',isSubtype:true,colorOptions:['실버','블랙']},
       {name:'디바이더 속서랍',category:'옵션',isSubtype:true},
       {name:'이불장 목대',category:'옵션',isSubtype:true},
       {name:'이불장손잡이(1구)',category:'옵션',isSubtype:true,noColor:true},
       {name:'이불 긴장문',category:'옵션',isSubtype:true},
       {name:'이불 반장문',category:'옵션',isSubtype:true},
      ].forEach(_ensure);
      // 상부자재
      [{name:'포스트바 2050',category:'상부자재'},{name:'포스트바 2250',category:'상부자재'},
       {name:'포스트바 2400',category:'상부자재'},{name:'선반바(ABS) 400',category:'상부자재'},
       {name:'코너바 2200',category:'상부자재'},{name:'코너앵글',category:'상부자재'},
       {name:'조절발',category:'상부자재'},{name:'포스트마감캡',category:'상부자재'},
       {name:'옷봉캡',category:'상부자재'},{name:'코너 옷봉캡 (단방, 양방)',category:'상부자재'},
       {name:'포스트연결캡',category:'상부자재'},{name:'조절발 연장캡',category:'상부자재'},
       {name:'벽고정 앵글',category:'상부자재'},{name:'벽고정 프레임 800',category:'상부자재',noColor:true},
       {name:'벽고정 프레임 1000',category:'상부자재',noColor:true},{name:'스패너',category:'상부자재',noColor:true},
      ].forEach(_ensure);
      // 옷봉/선반/코너선반
      [{name:'옷봉 2400',category:'옷봉'},
       {name:'선반 370',category:'선반'},{name:'선반 570',category:'선반'},
       {name:'선반 770',category:'선반'},{name:'선반 2400',category:'선반'},{name:'선반 비규격',category:'선반'},
       {name:'코너선반 780',category:'코너선반'},{name:'코너선반 비규격',category:'코너선반'},
      ].forEach(_ensure);
      // localStorage만 업데이트 (Firestore 직접 쓰기 금지 — syncFromServer 역업로드로 처리)
      if(_changed){DB.set('items',_items);console.log('[복구] 누락 품목 추가됨');}
    }
    // 활성 옵션 전체를 재고 관리 대상으로 전환.
    // 기존 재고 값은 보존하고, 없는 창고/색상 필드만 0/빈 객체로 초기화한다.
    {
      const _items=DB.get('items',[]);
      const _OPTION_STOCK_EXCLUDE=['이불장손잡이(1구)'];
      let _changed=false;
      _items.forEach(item=>{
        if(item.category!=='옵션'||item.isActive===false)return;
        if(_OPTION_STOCK_EXCLUDE.includes(item.name)){
          if(item.trackStock!==false){item.trackStock=false;_changed=true;}
          return;
        }
        if(item.trackStock!==true){item.trackStock=true;_changed=true;}
        if(item.stockSiheung===undefined){item.stockSiheung=0;_changed=true;}
        if(item.stockPyeongtaek===undefined){item.stockPyeongtaek=0;_changed=true;}
        if(item.stockOsan===undefined){item.stockOsan=0;_changed=true;}
        if(item.colorStockSiheung===undefined){item.colorStockSiheung={};_changed=true;}
        if(item.colorStockPyeongtaek===undefined){item.colorStockPyeongtaek={};_changed=true;}
        if(item.colorStockOsan===undefined){item.colorStockOsan={};_changed=true;}
        const orderable=(item.stockSiheung||0)+(item.stockPyeongtaek||0);
        if(item.currentStock!==orderable){item.currentStock=orderable;_changed=true;}
      });
      if(_changed){
        DB.set('items',_items);
        console.log('[옵션 재고 관리 활성화] 활성 옵션 trackStock=true');
      }
    }
    // ── 모든 마이그레이션 완료 — 잠금 해제 후 items Firestore 최종 1회 동기화 ──
    window._itemsInitLock = false;
    {
      const _finalItems=DB.get('items',[]);
      if(window._FS&&_finalItems.length>0){
        // 안전 가드: 서버 최신값에 부팅 마이그레이션으로 바뀐 필드만 반영한다.
        // 재고/품목 전체를 직접 set하지 않아, 운영 재고가 로컬 부팅값으로 덮이는 사고를 막는다.
        window._FS.get('items').then(remote=>{
          if(!Array.isArray(remote)){
            throw new Error('items 서버 응답 비배열');
          }
          const merged=_mergeItemsByLocalChanges(remote,_itemsInitBase,_finalItems);
          window._mem['items']=merged;
          window._FS.set('items',merged).catch(e=>console.warn('[items 최종 동기화 실패]',e.message));
          console.log(`[items 최종 동기화] 서버 최신값 기준 ${merged.length}개 병합 → Firestore`);
        }).catch(e=>console.warn('[items 동기화 조회 실패]',e.message));
      }
    }
  }
}

// 테스트용 재고 시드 (색상별로 다른 수량 — 이미 데이터 있으면 스킵)
async function _seedDemoStock(){
  const items=DB.get('items',[]);
  const drawerItems=items.filter(i=>i.category==='서랍장'&&i.isActive);
  if(!drawerItems.length)return;
  // 이미 어느 창고든 재고가 하나라도 있으면 스킵
  // 오산-only 재고도 실제 재고이므로 데모 시흥 재고로 덮으면 안 된다.
  if(drawerItems.some(i=>
    (i.stockSiheung||0)>0||(i.stockPyeongtaek||0)>0||(i.stockOsan||0)>0||
    Object.keys(i.colorStockSiheung||{}).length>0||
    Object.keys(i.colorStockPyeongtaek||{}).length>0||
    Object.keys(i.colorStockOsan||{}).length>0
  ))return;
  // 색상별 기본 재고 (시흥 창고, 품목마다 조금씩 다르게)
  const colorSeeds=[
    {color:'화이트 오크', base:8},
    {color:'솔리드',      base:5},
    {color:'메이플',      base:3},
    {color:'다크월넛',    base:4},
    {color:'진그레이',    base:2},
    {color:'스톤그레이',  base:1},
    {color:'민트그린',    base:0},
  ];
  let changed=false;
  drawerItems.forEach((item,idx)=>{
    const iIdx=items.findIndex(i=>i.id===item.id);
    if(iIdx===-1)return;
    const map={};
    colorSeeds.forEach(({color,base})=>{
      // 품목마다 약간씩 다르게 분산
      map[color]=Math.max(0,base+(idx%3===0?1:idx%3===1?-1:0));
    });
    items[iIdx].colorStockSiheung=map;
    items[iIdx].stockSiheung=Object.values(map).reduce((s,v)=>s+v,0);
    if(items[iIdx].stockPyeongtaek===undefined)items[iIdx].stockPyeongtaek=0;
    items[iIdx].currentStock=items[iIdx].stockSiheung+items[iIdx].stockPyeongtaek;
    changed=true;
  });
  if(changed)await DB.set('items',items);
}

// 핵심 로직
function calcShortage(req,cur){return Math.max(req-cur,0);}

// 발주번호 생성: YYYYMMDD-NNN
// 날짜별 순번을 Firestore 트랜잭션으로 "서버에서 원자적으로" 발급한다.
// → 여러 발주자가 동시에 발주해도 같은 번호가 절대 안 나옴(중복 차단).
// 🔴 로컬 계산/폴백 금지: 서버에서만 발급, 실패 시 throw로 저장 중단(중복 만드느니 막는다).
async function generateOrderNum(dateStr){
  const d=(dateStr||todayStr()).replace(/-/g,''); // YYYYMMDD
  let fs=null;
  try{ fs=firebase.app('hanger').firestore(); }catch(_e){ try{ fs=firebase.firestore(); }catch(_e2){ fs=null; } }
  if(!fs) throw new Error('서버에 연결할 수 없습니다. 새로고침 후 다시 시도해주세요.');
  const ref=fs.collection('hanger_data').doc('orderseq_'+d);

  // 카운터 문서가 아직 없으면(그날 첫 발주) 기존 발주서의 그날 최대 순번부터 시작
  // → 전환 시점에 구방식(로컬 계산) 번호와 충돌 방지. 반드시 서버값 기준(캐시 아님).
  let seedMax=0;
  let pre;
  try{ pre=await ref.get({source:'server'}); }
  catch(_e){ console.warn('[발주번호] 카운터 조회 실패',_e&&_e.message); throw new Error('서버 연결을 확인해주세요. 발주번호를 발급하지 못했습니다.'); }
  if(!pre.exists){
    try{
      const os=await fs.collection('hanger_data').doc('orders').get({source:'server'});
      const arr=(os.exists&&Array.isArray(os.data().value))?os.data().value:[];
      seedMax=arr.reduce((mx,o)=>{
        if(o&&typeof o.orderNum==='string'&&o.orderNum.indexOf(d)===0){
          const s=parseInt((o.orderNum.split('-')[1]||'0'),10)||0;
          if(s>mx) mx=s;
        }
        return mx;
      },0);
    }catch(_e){ console.warn('[발주번호] 시드용 orders 조회 실패',_e&&_e.message); throw new Error('서버 연결을 확인해주세요. 발주번호를 발급하지 못했습니다.'); }
  }

  // 트랜잭션으로 원자적 증가 — 동시 발주 시 Firestore가 자동 직렬화 → 중복 없음
  let seqNum;
  try{
    await fs.runTransaction(async(tx)=>{
      const snap=await tx.get(ref);
      const cur=(snap.exists&&typeof snap.data().value==='number')?snap.data().value:seedMax;
      seqNum=cur+1;
      tx.set(ref,{value:seqNum, updatedAt:new Date().toISOString()});
    });
  }catch(_e){ console.warn('[발주번호] 트랜잭션 실패',_e&&_e.message); throw new Error('발주번호 발급에 실패했습니다(서버 혼잡). 잠시 후 다시 시도해주세요.'); }
  if(!seqNum||seqNum<1) throw new Error('발주번호 발급 오류 — 다시 시도해주세요.');
  return d+'-'+String(seqNum).padStart(3,'0');
}

// ── 공용: 서버에서 logs id 배치 발급 (saveOrder 외 5개 함수 공통) ──
async function _serverGetLogIds(count){
  if(!count||count<1) return [];
  if(!window._FN||typeof window._FN.getNextIds!=='function'){
    throw new Error('서버 함수가 준비되지 않았습니다. 새로고침 후 다시 시도해주세요.');
  }
  let _r;
  try{ _r=await window._FN.getNextIds({counts:{logs:count}}); }
  catch(_e){ throw new Error('서버에서 로그 번호를 받지 못했습니다. 다시 시도해주세요. ('+((_e&&_e.message)||'')+')'); }
  const arr=_r&&_r.data&&_r.data.ids&&_r.data.ids.logs;
  if(!Array.isArray(arr)||arr.length<count){ throw new Error('서버 로그 번호 응답 부족 — 다시 시도해주세요.'); }
  return arr;
}

// [2026-07-31 라운드3] PC간 동시 취소 방지 (A4)
// localStorage 락은 브라우저 격리라 PC-A / PC-B 동시 취소 클릭 시 무의미.
// Firestore transaction으로 `hanger_data/cancel_locks` 문서에 orderId 마커를 얹어,
// 다른 PC의 tx가 이미 커밋된 마커를 보고 abort하게 한다.
// 크래시로 마커가 남으면 30초 후 stale로 간주해 새 tx가 덮어씀.
async function _acquireServerCancelLock(orderId, actorId){
  let fs=null;
  try{ fs=firebase.app('hanger').firestore(); }catch(_e){ try{ fs=firebase.firestore(); }catch(_e2){ fs=null; } }
  if(!fs) return {ok:false,reason:'no-firestore'};
  const ref=fs.collection('hanger_data').doc('cancel_locks');
  // 자기 락 stale 임계 (실제 취소 작업 90초 안 넘음, 넘으면 재시도 요구)
  const STALE_MS=90000;
  // 남의 락 GC 임계: 5분 초과 시에만 정리 (활성 취소 침범 절대 금지). 팀 검토 3 HIGH 방어(2차).
  const GC_MS=300000;
  try{
    await fs.runTransaction(async(tx)=>{
      const snap=await tx.get(ref);
      const map=(snap.exists&&snap.data()&&snap.data().value)?{...snap.data().value}:{};
      const nowMs=(new Date()).getTime();
      // 안전 GC: 5분 넘게 방치된 것만 정리. 90초 stale이라도 다른 PC가 아직 진행 중일 여지 남김.
      for(const k of Object.keys(map)){
        const v=map[k];
        if(!v||typeof v.at!=='number'||(nowMs-v.at)>=GC_MS){ delete map[k]; }
      }
      const cur=map[orderId];
      // 자기 orderId 락 확인: 5분 이내지만 90초 넘어 만료된 상태면 재획득 허용 (원 소유자만의 판단)
      if(cur){
        if(typeof cur.at==='number'&&(nowMs-cur.at)<STALE_MS){
          const e=new Error('LOCKED_BY_OTHER');
          e.holder=cur.by||'';
          throw e;
        }
      }
      map[orderId]={by:actorId||'',at:nowMs};
      tx.set(ref,{value:map,updatedAt:new Date().toISOString()});
    });
    return {ok:true};
  }catch(e){
    if(e&&e.message==='LOCKED_BY_OTHER'){
      return {ok:false,reason:'locked',holder:e.holder||''};
    }
    return {ok:false,reason:'tx-error',err:(e&&e.message)||String(e)};
  }
}
async function _releaseServerCancelLock(orderId){
  let fs=null;
  try{ fs=firebase.app('hanger').firestore(); }catch(_e){ try{ fs=firebase.firestore(); }catch(_e2){ fs=null; } }
  if(!fs) return;
  const ref=fs.collection('hanger_data').doc('cancel_locks');
  try{
    await fs.runTransaction(async(tx)=>{
      const snap=await tx.get(ref);
      if(!snap.exists) return;
      const map=snap.data().value||{};
      if(map[orderId]){ delete map[orderId]; tx.set(ref,{value:map,updatedAt:new Date().toISOString()}); }
    });
  }catch(_e){ /* 락 해제 실패는 30초 만료로 자연 회수됨 */ }
}
if(typeof window!=='undefined'){
  window._acquireServerCancelLock=_acquireServerCancelLock;
  window._releaseServerCancelLock=_releaseServerCancelLock;
}

// [2026-07-31 라운드4 SAVE-RACE] saveOrder도 PC간 격리 필요.
// 재고 차감이 있는 저장(발주대기/발주확정/출고완료)만 락 걸어 이중 차감 방지.
// 임시저장은 재고 안 건드리므로 락 불필요.
// 단일 글로벌 락으로 시작 — 두 PC 동시 발주는 흔치 않고, baseline 이 이미 방어망이라 순차 처리로 충분.
async function _acquireServerSaveLock(actorId){
  let fs=null;
  try{ fs=firebase.app('hanger').firestore(); }catch(_e){ try{ fs=firebase.firestore(); }catch(_e2){ fs=null; } }
  if(!fs) return {ok:false,reason:'no-firestore'};
  const ref=fs.collection('hanger_data').doc('save_locks');
  const STALE_MS=60000;
  const GC_MS=300000;
  try{
    await fs.runTransaction(async(tx)=>{
      const snap=await tx.get(ref);
      const map=(snap.exists&&snap.data()&&snap.data().value)?{...snap.data().value}:{};
      const nowMs=(new Date()).getTime();
      for(const k of Object.keys(map)){
        const v=map[k];
        if(!v||typeof v.at!=='number'||(nowMs-v.at)>=GC_MS){ delete map[k]; }
      }
      const cur=map['global'];
      if(cur&&typeof cur.at==='number'&&(nowMs-cur.at)<STALE_MS){
        const e=new Error('SAVE_LOCKED_BY_OTHER');
        e.holder=cur.by||'';
        throw e;
      }
      map['global']={by:actorId||'',at:nowMs};
      tx.set(ref,{value:map,updatedAt:new Date().toISOString()});
    });
    return {ok:true};
  }catch(e){
    if(e&&e.message==='SAVE_LOCKED_BY_OTHER'){
      return {ok:false,reason:'locked',holder:e.holder||''};
    }
    return {ok:false,reason:'tx-error',err:(e&&e.message)||String(e)};
  }
}
async function _releaseServerSaveLock(){
  let fs=null;
  try{ fs=firebase.app('hanger').firestore(); }catch(_e){ try{ fs=firebase.firestore(); }catch(_e2){ fs=null; } }
  if(!fs) return;
  const ref=fs.collection('hanger_data').doc('save_locks');
  try{
    await fs.runTransaction(async(tx)=>{
      const snap=await tx.get(ref);
      if(!snap.exists) return;
      const map=snap.data().value||{};
      if(map['global']){ delete map['global']; tx.set(ref,{value:map,updatedAt:new Date().toISOString()}); }
    });
  }catch(_e){ /* 만료로 자연 회수 */ }
}
if(typeof window!=='undefined'){
  window._acquireServerSaveLock=_acquireServerSaveLock;
  window._releaseServerSaveLock=_releaseServerSaveLock;
}

// [2026-07-31] Same-order edit lock.
// Prevent admin/orderer from editing the same order at the same time on different PCs.
async function _acquireServerEditLock(orderId, actorId){
  let fs=null;
  try{ fs=firebase.app('hanger').firestore(); }catch(_e){ try{ fs=firebase.firestore(); }catch(_e2){ fs=null; } }
  if(!fs) return {ok:true,reason:'no-firestore'};
  const ref=fs.collection('hanger_data').doc('edit_locks');
  const STALE_MS=10*60*1000;
  try{
    await fs.runTransaction(async(tx)=>{
      const snap=await tx.get(ref);
      const map=(snap.exists&&snap.data()&&snap.data().value)?{...snap.data().value}:{};
      const nowMs=(new Date()).getTime();
      for(const k of Object.keys(map)){
        const v=map[k];
        if(!v||typeof v.at!=='number'||(nowMs-v.at)>=STALE_MS){ delete map[k]; }
      }
      const key=String(orderId);
      const cur=map[key];
      if(cur&&cur.by&&cur.by!==actorId&&typeof cur.at==='number'&&(nowMs-cur.at)<STALE_MS){
        const e=new Error('EDIT_LOCKED_BY_OTHER');
        e.holder=cur.by||'';
        throw e;
      }
      map[key]={by:actorId||'',at:nowMs};
      tx.set(ref,{value:map,updatedAt:new Date().toISOString()});
    });
    return {ok:true};
  }catch(e){
    if(e&&e.message==='EDIT_LOCKED_BY_OTHER'){
      return {ok:false,reason:'locked',holder:e.holder||''};
    }
    return {ok:false,reason:'tx-error',err:(e&&e.message)||String(e)};
  }
}

async function _releaseServerEditLock(orderId, actorId){
  let fs=null;
  try{ fs=firebase.app('hanger').firestore(); }catch(_e){ try{ fs=firebase.firestore(); }catch(_e2){ fs=null; } }
  if(!fs) return;
  const ref=fs.collection('hanger_data').doc('edit_locks');
  try{
    await fs.runTransaction(async(tx)=>{
      const snap=await tx.get(ref);
      if(!snap.exists) return;
      const map={...(snap.data().value||{})};
      const key=String(orderId);
      const cur=map[key];
      if(cur&&(!actorId||!cur.by||cur.by===actorId)){
        delete map[key];
        tx.set(ref,{value:map,updatedAt:new Date().toISOString()});
      }
    });
  }catch(_e){ /* stale timeout will recover */ }
}

async function _releaseActiveOrderEditLock(){
  const lock=(typeof window!=='undefined')?window._activeOrderEditLock:null;
  if(!lock||!lock.orderId) return;
  window._activeOrderEditLock=null;
  await _releaseServerEditLock(lock.orderId,lock.actorId||'');
}

if(typeof window!=='undefined'){
  window._acquireServerEditLock=_acquireServerEditLock;
  window._releaseServerEditLock=_releaseServerEditLock;
  window._releaseActiveOrderEditLock=_releaseActiveOrderEditLock;
}

// [2026-07-31] 더블클릭·병렬 저장 방지 (신규 발주가 두 번 차감되는 사고 차단)
// 편집 경로는 _withOrderLock으로 이미 보호되지만, 신규 저장은 orderId가 없어 잠금 대상이 없다.
// 함수 진입 즉시 in-flight 플래그를 세워, 첫 호출이 끝나기 전 두 번째 호출은 즉시 튕긴다.
let _saveOrderInFlight=false;
async function saveOrder(payload, saveMode='발주확정'){
  if(_saveOrderInFlight){
    throw new Error('저장이 진행 중입니다. 완료 후 다시 시도해주세요.');
  }
  _saveOrderInFlight=true;
  let _saveLockAcquired=false;
  try{
  // [2026-08-28] 임시저장 = 항상 hanger_drafts 컬렉션으로 저장 (발주번호·상태이력·재고 미포함)
  //   편집(_editOverride) 흐름은 orders에서 진행 (임시저장 편집=완료 발주 편집과 무관)
  //   대리 임시저장(관리자가 발주자 대신) 시 owner = payload.proxyOrdererId (발주자)
  //   호출부는 {orderId, shortageCount, order:{status:'임시저장'}} 형태 기대 → 그 형태로 감싸기.
  if(saveMode==='임시저장' && !window._editOverride){
    // [코덱스 P1-1 재fix 2026-08-28] payload가 frozen/Proxy여도 delete가 조용히 실패하지 않도록
    //   새 객체 복사 + 관리자 아닐 때 proxy 필드 완전 배제 (source payload는 안 건드림)
    const _isAdmin = !!(currentUser && currentUser.role === 'admin');
    const _cleanPayload = _isAdmin
      ? {...payload}
      : (()=>{ const {proxyOrdererId, proxyOrdererName, proxyCreatedByAdmin, ...rest} = payload; return rest; })();
    const _draftOwner = (_isAdmin && _cleanPayload.proxyOrdererId) || (currentUser?currentUser.id:'');
    const _draft = await saveDraft(_cleanPayload, {createdBy: _draftOwner});
    return { orderId: _draft.draftId, shortageCount: 0, order: { ..._cleanPayload, id: _draft.draftId, draftId: _draft.draftId, status: '임시저장', createdAt: _draft.createdAt, updatedAt: _draft.updatedAt, createdBy: _draftOwner } };
  }
  // [2026-07-31 라운드4 SAVE-RACE] 재고 차감 모드면 PC간 서버 락 획득.
  // 임시저장은 재고 안 건드리므로 락 없음. baseline과 함께 이중 방어.
  const _requestedSaveMode=(window._editOverride&&window._editOverride.status)||saveMode||'발주확정';
  const _isDeductMode=(_requestedSaveMode==='발주대기'||_requestedSaveMode==='발주확정'||_requestedSaveMode==='출고완료');
  if(_isDeductMode&&typeof window._acquireServerSaveLock==='function'){
    const _actorSave=(typeof currentUser!=='undefined'&&currentUser)?currentUser.id:'';
    const _lockRes=await window._acquireServerSaveLock(_actorSave);
    if(!_lockRes||!_lockRes.ok){
      if(_lockRes&&_lockRes.reason==='locked'){
        throw new Error('다른 사용자가 저장 중입니다. 잠시 후 다시 시도해주세요.');
      }
      throw new Error('저장 잠금 획득 실패. 새로고침 후 다시 시도해주세요.');
    }
    _saveLockAcquired=true;
  }
  // payload: {deliveryTo, address, orderDate, shipDate, note, warehouse,
  //           upperMaterials:[{name,white,black,silver,note}],
  //           shelfItems:[{name,white,maple,walnut,gray}],
  //           drawerItems:[{itemId,requiredQty}],
  //           drawerMemo, etcMemo}
  let dbItems=DB.get('items',[]);
  const orders=DB.get('orders',[]).map(o=>o&&typeof o==='object'?{...o}:o);
  const prs=DB.get('purchase_requests',[]).map(p=>p&&typeof p==='object'?{...p}:p);
  const newPrs=[];
  const stockLogs=[];
  // 수정 모드: _editOverride로 원래 id/orderNum/status/등록자/등록일 유지
  // [2026-07-15 Critical 1] _editOverride 클리어를 저장 성공 후로 이동 — 실패 시 재시도가 편집 모드 유지되도록 (중복 발주서 생성 방지)
  const _eo=window._editOverride||null;
  const _matchesEditOrder=o=>!!(o&&(
    String(o.id)===String(_eo&&_eo.id) ||
    (_eo&&_eo.orderNum&&o.orderNum===_eo.orderNum)
  ));
  let _originalOrderForEdit=_eo?orders.find(_matchesEditOrder):null;
  // _eo.status는 이번 저장의 목표 상태다. 동시 수정 비교에는 편집 시작 당시 상태를 써야 한다.
  const _editBaselineStatus=(_eo&&_eo.originalStatus)||(_originalOrderForEdit&&_originalOrderForEdit.status);

  // [2026-07-31] 대리발주 권한 우회 차단 (A6 강화)
  // id 뿐 아니라 name/email/flag 등 어떤 proxy 관련 필드라도 있으면 관리자 요구.
  // 콘솔에서 saveOrder({proxyOrdererName:'X'}) 처럼 id만 비운 우회 차단.
  if(payload){
    const _proxyKeys=['proxyOrdererId','proxyOrdererName','proxyOrdererEmail','proxyOrdererDeliveryName','proxyCreatedByAdmin','proxyOrderer'];
    const _hasProxy=_proxyKeys.some(k=>{
      const v=payload[k];
      return v!==undefined&&v!==null&&v!==''&&v!==false;
    });
    if(_hasProxy){
      if(typeof isAdmin!=='function' || !isAdmin()){
        throw new Error('대리 발주는 관리자만 등록할 수 있습니다.');
      }
    }
  }

  // [2026-07-24 Codex-재검토-Critical-2] warehouse 검증을 서버 ID 발급 전에 수행
  // - 임시저장만 빈 창고 허용 (선택 미완료 상태)
  // - 발주대기·발주확정 등 재고 차감 모드는 반드시 시흥|평택 강제
  // - 오산은 재고 관리 전용, 발주 대상 절대 아님
  const _preWarehouse=payload.warehouse||'';
  const _preSaveMode=_eo?(_eo.status||saveMode):saveMode;
  if(_preSaveMode!=='임시저장'){
    if(!_preWarehouse){
      throw new Error('발주 창고를 선택해주세요. (시흥 또는 평택)');
    }
    if(_preWarehouse!=='시흥'&&_preWarehouse!=='평택'){
      throw new Error('발주 창고는 시흥 또는 평택만 가능합니다. (입력: '+_preWarehouse+')');
    }
  } else if(_preWarehouse&&_preWarehouse!=='시흥'&&_preWarehouse!=='평택'){
    // 임시저장이라도 오산 등 잘못된 값은 거부
    throw new Error('발주 창고는 시흥 또는 평택만 가능합니다. (입력: '+_preWarehouse+')');
  }

  // ── 서버 단일 ID 발급 (PC간 번호 충돌 방지) ──
  // [2026-07-31 라운드2] CAS 강화:
  //  ② 편집 모드에서 서버 orders 재조회 → _originalOrderForEdit 최신화, 이미 취소면 throw (A5)
  //  ③ 관련 item 전체(=색상 지도 통째)를 baseline으로 비교 → 다른 색상 동시 변경도 감지 (A2)
  //  ④ 통과 시 serverItems를 반환 → downstream mutation의 시작점을 로컬 stale이 아닌 서버 최신값으로 (A1·A3)
  async function _assertFreshBeforeOrderSave(){
    if(!window._FS||typeof window._FS.get!=='function')return null;
    // DB.set은 호환성 때문에 fire-and-forget이다. 같은 클라이언트의 직전 컬렉션
    // 저장이 CAS 도중 완료되면 외부 재고 변경으로 보이므로 먼저 모두 완료시킨다.
    if(typeof window._FS.awaitPendingWrites==='function'){
      try{
        await window._FS.awaitPendingWrites(['items','purchase_requests','logs']);
      }catch(e){
        throw new Error('이전 데이터 저장 완료를 확인하지 못했습니다. 다시 시도해주세요. ('+((e&&e.message)||'')+')');
      }
    }
    // A5: 편집 모드면 서버 orders 재조회
    if(_eo){
      let serverOrders;
      try{
        // [Phase 5] 옛 hanger_data/orders 는 얼어붙음 → 새 컬렉션에서 조회
        const _fetcher = (typeof window._FS.getAllOrders==='function')
          ? window._FS.getAllOrders({fromServer:true})
          : window._FS.get('orders',{fromServer:true});
        serverOrders=await Promise.race([
          _fetcher,
          new Promise((_,rj)=>setTimeout(()=>rj(new Error('TIMEOUT')),8000))
        ]);
      }catch(e){
        throw new Error('서버 발주 상태 확인 실패. 새로고침 후 다시 저장해주세요. ('+((e&&e.message)||'')+')');
      }
      if(!Array.isArray(serverOrders)){
        throw new Error('서버 발주 상태 확인 실패. 새로고침 후 다시 저장해주세요.');
      }
      const serverOrder=serverOrders.find(_matchesEditOrder);
      if(!serverOrder){
        throw new Error('발주서를 찾을 수 없습니다. 이미 삭제되었을 수 있습니다. 새로고침 후 확인해주세요.');
      }
      if(serverOrder.status==='취소'||serverOrder.status==='cancelled'){
        throw new Error('이 발주서는 이미 취소되었습니다. 새로고침 후 확인해주세요.');
      }
      // [2026-08-03 B9] 두 관리자 편집 race — 로컬 편집 폼 status 와 서버 status 가 다르면 abort.
      // 예: A가 편집 폼 열어놓은 사이 B가 확정 해제 → A 저장 시 A의 stale status 로 덮어쓰는 것 차단.
      if(_editBaselineStatus && serverOrder.status && _editBaselineStatus!==serverOrder.status){
        throw new Error('다른 관리자가 발주 상태를 변경했습니다 (현재: '+serverOrder.status+'). 새로고침 후 다시 시도해주세요.');
      }
      // stockDeducted 상태가 로컬(stale)과 서버가 다르면 이중 롤백 위험 → 서버 값으로 갱신
      _originalOrderForEdit=serverOrder;
    }
    const deductModes=new Set(['발주대기','발주확정','출고완료']);
    // A2: item 단위(색상 지도 통째) baseline 수집
    const itemIdsToCheck=new Set();
    function _collect(oi,order,mode){
      if(!oi||!oi.itemId)return;
      const item=dbItems.find(i=>i.id===oi.itemId);
      if(!item||!isTrackStock(item))return;
      if(mode==='new'&&!deductModes.has(_preSaveMode))return;
      if(mode==='old'){
        const deducted=(typeof oi.inventoryDeducted==='boolean')
          ? oi.inventoryDeducted
          : !!(order&&order.stockDeducted&&item.category==='서랍장');
        if(!deducted)return;
      }
      itemIdsToCheck.add(oi.itemId);
    }
    (payload.drawerItems||[]).forEach(oi=>_collect(oi,null,'new'));
    if(_originalOrderForEdit&&_originalOrderForEdit.stockDeducted){
      (_originalOrderForEdit.drawerItems||_originalOrderForEdit.items||[]).forEach(oi=>_collect(oi,_originalOrderForEdit,'old'));
    }
    let serverItems;
    try{
      serverItems=await Promise.race([
        window._FS.get('items',{fromServer:true}),
        new Promise((_,rj)=>setTimeout(()=>rj(new Error('TIMEOUT')),8000))
      ]);
    }catch(e){
      throw new Error('서버 최신 재고 확인 실패. 새로고침 후 다시 저장해주세요. ('+((e&&e.message)||'')+')');
    }
    if(!Array.isArray(serverItems)){
      throw new Error('서버 최신 재고 확인 실패. 새로고침 후 다시 저장해주세요.');
    }
    // A2: 대상 item마다 (창고 수량 + 색상 지도) 지문 비교.
    // 대상이 없는 임시저장도 아래 transaction이 items 전체 CAS를 수행하므로,
    // 방금 읽은 서버 배열을 mutation/baseline으로 사용해야 한다.
    // 오산 재고는 발주 대상 아님 → 지문 제외 (다른 관리자가 오산 조정만 해도 튕기는 것 방지)
    // 색상 지도의 키 순서는 Firestore doc마다 다를 수 있어 정렬 후 문자열화 (M1 오탐 방지)
    function _stable(obj){
      if(!obj||typeof obj!=='object')return JSON.stringify(obj);
      const keys=Object.keys(obj).sort();
      return '{'+keys.map(k=>JSON.stringify(k)+':'+JSON.stringify(obj[k])).join(',')+'}';
    }
    function _fingerprint(item){
      if(!item)return null;
      return _stable({
        sh:item.stockSiheung||0,
        py:item.stockPyeongtaek||0,
        cs:_stable(item.colorStockSiheung||{}),
        cp:_stable(item.colorStockPyeongtaek||{})
      });
    }
    for(const id of itemIdsToCheck){
      const local=dbItems.find(i=>i&&i.id===id);
      const server=serverItems.find(i=>i&&i.id===id);
      if(!server){
        throw new Error('서버 품목 정보를 다시 확인해야 합니다. 새로고침 후 다시 저장해주세요. ('+((local&&local.name)||id)+')');
      }
      if(_fingerprint(local)!==_fingerprint(server)){
        throw new Error('저장 중 재고가 변경되었습니다. 새로고침 후 다시 저장해주세요. ('+(server.name||local&&local.name||id)+')');
      }
    }
    return serverItems;
  }
  const _freshServerItems=await _assertFreshBeforeOrderSave();
  // A1·A3: baseline 통과 시 서버 최신 items를 mutation 시작점으로 교체.
  // 3-way merge와 동일하게 로컬 unsaved 편집이 있다면 사라질 수 있지만,
  // items 편집은 별도 UI라 saveOrder 흐름과 겹치는 실무 케이스 극히 낮음.
  if(_freshServerItems){
    // 참조로 다루는 dbItems를 서버 스냅샷으로 교체 (얕은 복사로 원본 서버 응답 보호)
    dbItems=_freshServerItems.map(i=>({...i,
      colorStockSiheung:i.colorStockSiheung?{...i.colorStockSiheung}:i.colorStockSiheung,
      colorStockPyeongtaek:i.colorStockPyeongtaek?{...i.colorStockPyeongtaek}:i.colorStockPyeongtaek
    }));
  }
  // transaction에서 바로 전 서버 상태와 비교할 기준. 이후 계산에서는 이 복사본을 변경하지 않는다.
  const _itemsBeforeOrderMutation=JSON.parse(JSON.stringify(dbItems));

  const _drawerCount=Array.isArray(payload.drawerItems)?payload.drawerItems.length:0;
  const _editRollbackCount=(_originalOrderForEdit&&_originalOrderForEdit.stockDeducted)
    ? ((_originalOrderForEdit.drawerItems||_originalOrderForEdit.items||[]).length)
    : 0;
  const _idCounts={};
  if(!_eo) _idCounts.orders=1;
  if(_drawerCount>0){ _idCounts.order_items=_drawerCount; _idCounts.purchase_requests=_drawerCount; }
  if((_drawerCount+_editRollbackCount)>0) _idCounts.logs=_drawerCount+_editRollbackCount;
  let _srvIds={};
  if(Object.keys(_idCounts).length>0){
    if(!window._FN||typeof window._FN.getNextIds!=='function'){
      throw new Error('서버 함수가 준비되지 않았습니다. 새로고침 후 다시 시도해주세요.');
    }
    let _r;
    try{ _r=await window._FN.getNextIds({counts:_idCounts}); }
    catch(_e){ throw new Error('서버에서 발주서 번호를 받지 못했습니다. 다시 시도해주세요. ('+((_e&&_e.message)||'')+')'); }
    if(!_r||!_r.data||!_r.data.ids){ throw new Error('서버 응답 형식 오류 — 다시 시도해주세요.'); }
    _srvIds=_r.data.ids;
  }
  function _popId(name){
    const arr=_srvIds[name];
    const v=Array.isArray(arr)?arr.shift():undefined;
    if(v===undefined||v===null){ throw new Error('서버 발급 '+name+' 번호가 부족합니다. 다시 시도해주세요.'); }
    return v;
  }
  const orderId=_eo?_eo.id:_popId('orders'),now=new Date().toISOString();
  const orderNum=_eo?_eo.orderNum:await generateOrderNum(payload.orderDate||todayStr());
  const requestedSaveMode=saveMode;
  const effectiveSaveMode=_eo?(_eo.status||requestedSaveMode):requestedSaveMode;
  const savedDrawerItems=[];let shortageCount=0;
  // 임시저장은 창고 미선택 허용, 차감 시에는 시흥 기본값 사용 (검증은 함수 상단에서 완료)
  const warehouse=payload.warehouse||'';

  function _dbLegacyTracksInventoryLine(oi,item){
    if(oi&&typeof oi.inventoryTracked==='boolean')return oi.inventoryTracked;
    // 과거 데이터 fallback은 서랍장만. 옵션은 이번에 새로 추적되므로
    // 표식 없는 과거 옵션을 임의 롤백하면 허위 재고가 생긴다.
    return !!item&&item.category==='\uC11C\uB78D\uC7A5';
  }
  function _dbLineDeducted(oi,item,order){
    if(oi&&typeof oi.inventoryDeducted==='boolean')return oi.inventoryDeducted;
    return !!(order&&order.stockDeducted&&_dbLegacyTracksInventoryLine(oi,item));
  }
  function _dbDeductedQty(oi){
    if(oi&&Number.isFinite(Number(oi.inventoryDeductedQty)))return Math.max(0,Number(oi.inventoryDeductedQty));
    const requested=Math.max(0,Number(oi&&oi.requiredQty)||0);
    if(oi&&Number.isFinite(Number(oi.shortageQty)))return Math.max(0,requested-Math.max(0,Number(oi.shortageQty)));
    if(oi&&Number.isFinite(Number(oi.currentStockSnapshot)))return Math.min(requested,Math.max(0,Number(oi.currentStockSnapshot)));
    return requested;
  }
  function _applyStockDeltaForOrderLine(item,wh,color,qtyDelta,logType,memo,orderIdForLog,nowForLog){
    if(!item||!qtyDelta)return 0;
    if(item.stockSiheung===undefined)item.stockSiheung=item.currentStock||0;
    if(item.stockPyeongtaek===undefined)item.stockPyeongtaek=0;
    const whKey=getWhKey(wh);
    const cwKey=getColorWhKey(wh);
    let before, afterVal;
    if(color){
      if(!item[cwKey])item[cwKey]={};
      before=typeof getColorStock==='function'?getColorStock(item[cwKey],color):(item[cwKey][color]||0);
      afterVal=Math.max(0,before+qtyDelta);
      if(typeof setColorStock==='function')setColorStock(item[cwKey],color,afterVal);
      else item[cwKey][color]=afterVal;
      item[whKey]=typeof sumColorStockMap==='function'?sumColorStockMap(item[cwKey]):Object.values(item[cwKey]).reduce((s,v)=>s+(v||0),0);
    } else {
      before=item[whKey]||0;
      afterVal=Math.max(0,before+qtyDelta);
      item[whKey]=afterVal;
    }
    item.currentStock=(item.stockSiheung||0)+(item.stockPyeongtaek||0);
    stockLogs.push({
      id:_popId('logs'),itemId:item.id,type:logType,qty:afterVal-before,
      beforeStock:before,afterStock:afterVal,warehouse:wh,color:color||'',
      memo,orderId:orderIdForLog,createdBy:currentUser?currentUser.id:'',createdAt:nowForLog
    });
    return afterVal-before;
  }

  // [2026-07-31 Codex] 수정 저장 시점에만 기존 차감분을 되돌린 뒤 새 주문분을 다시 차감한다.
  // 수정 모달을 열기만 하고 닫는 경우에는 재고를 건드리지 않는다.
  if(_originalOrderForEdit&&_originalOrderForEdit.stockDeducted){
    const oldRows=_originalOrderForEdit.drawerItems||_originalOrderForEdit.items||[];
    const oldWh=_originalOrderForEdit.warehouse||warehouse||'시흥';
    oldRows.forEach(oi=>{
      const item=dbItems.find(i=>i.id===oi.itemId);
      if(!item||!_dbLineDeducted(oi,item,_originalOrderForEdit))return;
      const wh=(oi.warehouse==='시흥'||oi.warehouse==='평택')?oi.warehouse:oldWh;
      let oldColor=item.noColor?'':(oi.color||_originalOrderForEdit.sharedColor||'');
      if(oldColor&&typeof normalizeStockColor==='function')oldColor=normalizeStockColor(oldColor);
      _applyStockDeltaForOrderLine(
        item,wh,oldColor,_dbDeductedQty(oi),
        '발주수정반환',
        `발주 #${_originalOrderForEdit.id} 수정 저장 전 기존 차감분 반환`,
        _originalOrderForEdit.id,now
      );
      oi.inventoryDeducted=false;
    });
  }

  // 서랍장 항목 재고 비교 · 차감 · 발주 필요 목록 생성
  (payload.drawerItems||[]).forEach((drawerItem)=>{
    const {itemId,requiredQty}=drawerItem;
    if(!requiredQty||requiredQty<1)return;
    const item=dbItems.find(i=>i.id===itemId);if(!item)return;
    // 마이그레이션 보정
    if(item.stockSiheung===undefined)item.stockSiheung=item.currentStock||0;
    if(item.stockPyeongtaek===undefined)item.stockPyeongtaek=0;
    let orderColor=item.noColor?'':(drawerItem.color||payload.sharedColor||'');
    if(orderColor&&typeof normalizeStockColor==='function')orderColor=normalizeStockColor(orderColor);
    const whStock=getWarehouseStock(item,warehouse,orderColor);
    const inventoryTracked=isTrackStock(item);
    const inventoryDeducted=inventoryTracked&&(effectiveSaveMode==='발주대기'||effectiveSaveMode==='발주확정'||effectiveSaveMode==='출고완료');
    const shortage=inventoryTracked?calcShortage(requiredQty,whStock):0;
    const savedLine={id:_popId('order_items'),orderId,itemId,requiredQty,color:orderColor,currentStockSnapshot:whStock,shortageQty:shortage,warehouse,inventoryTracked,inventoryDeducted,inventoryDeductedQty:0,createdAt:now,handleOption:drawerItem.handleOption||'basic',displayName:drawerItem.displayName||'',note:drawerItem.note||'',unitPrice:drawerItem.unitPrice,amount:drawerItem.amount,vatAmount:drawerItem.vatAmount,subTypeChecked:drawerItem.subTypeChecked||[]};
    savedDrawerItems.push(savedLine);
    if(shortage>0){
      // [2026-07-24 Codex-재검토-Critical-1] color 저장 — 다른 색상 입고에 오인 자동완료 방지
      const newPr={id:_popId('purchase_requests'),orderId,itemId,requiredQty,color:orderColor||'',currentStockSnapshot:whStock,shortageQty:shortage,warehouse,status:'대기',createdAt:now,updatedAt:now};
      prs.push(newPr);
      newPrs.push(newPr);
      shortageCount++;
    }
    // 서랍장 실재고 차감 — 발주대기·발주확정 모두 발주 넣는 시점에 즉시 차감 (임시저장은 미차감)
    if(inventoryDeducted){
      const applied=_applyStockDeltaForOrderLine(item,warehouse,orderColor,-requiredQty,'발주차감',`발주 #${orderId}`,orderId,now);
      savedLine.inventoryDeductedQty=Math.abs(applied);
    }
  });
  const orderDoc={
    id:orderId,
    // 기본 정보
    deliveryTo:payload.deliveryTo||'',
    address:payload.address||'',
    orderDate:payload.orderDate||'',
    shipDate:payload.shipDate||'',
    warehouse,
    note:payload.note||'',
    // 구역별 입력값
    upperMaterials:payload.upperMaterials||[],
    upperCommonColor:payload.upperCommonColor||'화이트',
    rodItems:payload.rodItems||[],
    rod2400Required:payload.rod2400Required||0,
    rodTotalLen:payload.rodTotalLen||0,
    rodUnitPrice:payload.rodUnitPrice,
    rodAmount:payload.rodAmount,
    rodVat:payload.rodVat,
    shelfItems:payload.shelfItems||[],
    sharedColor:payload.sharedColor||'',
    drawerItems:savedDrawerItems,
    drawerMemo:payload.drawerMemo||'',
    etcMemo:payload.etcMemo||'',
    // 금액
    totalSupply:payload.totalSupply||0,
    totalVat:payload.totalVat||0,
    totalAmount:payload.totalAmount||0,
    // 메타
    createdAt:_eo?(_eo.createdAt||now):now,updatedAt:now,
    orderNum,
    status:effectiveSaveMode,
    isLocked:_eo?(_eo.isLocked===true||effectiveSaveMode==='발주확정'):(effectiveSaveMode==='발주확정'),
    stockDeducted:savedDrawerItems.some(oi=>oi.inventoryDeducted===true),
    createdBy:_eo?(_eo.createdBy||currentUser?.id||''):(payload.proxyOrdererId||currentUser?.id||''),  // 발주서 소유 업체 ID
    proxyCreatedByAdmin:!!payload.proxyCreatedByAdmin,
    proxyAdminId:payload.proxyCreatedByAdmin&&currentUser?currentUser.id:'',
    proxyAdminName:payload.proxyCreatedByAdmin&&currentUser?currentUser.name:'',
    proxyOrdererName:payload.proxyOrdererName||'',
    // [2026-08-27] 편집 저장 시 상태 변화 감지해 statusHistory에 append
    //   기존: _eo.statusHistory를 그대로 재사용 → 임시저장→즉시확정 시 확정 이벤트 누락
    //        → getSettlementDate가 shipDate 폴백 → shipDate=0000-00-00이면 정산·원장에서 사라짐
    //   fix: _originalOrderForEdit.status와 effectiveSaveMode 비교, 다르면 새 이벤트 append
    statusHistory:(()=>{
      const _mkEntry=(note)=>({status:effectiveSaveMode,changedBy:currentUser?currentUser.id:'',changedByName:currentUser?currentUser.name:'',changedAt:now,note});
      if(!_eo) return [_mkEntry('발주서 등록')];
      const _base=Array.isArray(_eo.statusHistory)?_eo.statusHistory.slice():[];
      const _origStatus=(_originalOrderForEdit&&_originalOrderForEdit.status)||_eo.status||'';
      if(_origStatus!==effectiveSaveMode) _base.push(_mkEntry('발주서 수정(상태변경)'));
      return _base.length?_base:[_mkEntry('발주서 수정')];
    })(),
    // 하위 호환
    items:savedDrawerItems,
    siteName:payload.deliveryTo||'',
    customerName:payload.address||'',
  };
  orderDoc._expectedPreviousUpdatedAt=_originalOrderForEdit?(_originalOrderForEdit.updatedAt||''):undefined;
  // 수정 모드: 기존 발주서를 같은 자리에 교체 (splice + push 분리 시 race condition 방지)
  // 신규 모드: 끝에 push
  if(_eo){
    const _existingIdx=orders.findIndex(o=>o.id===orderDoc.id);
    if(_existingIdx!==-1) orders[_existingIdx]=orderDoc;
    else orders.push(orderDoc);
  } else {
    orders.push(orderDoc);
  }
  // 재고와 발주서를 원자적으로 커밋한다. 한쪽 write만 성공하는 부분 실패를 차단한다.
  if(!window._FS||typeof window._FS.transactOrderInventory!=='function'){
    throw new Error('원자 저장 기능을 불러오지 못했습니다. 새로고침 후 다시 시도해주세요.');
  }
  // [2026-08-28] draft 승격 시 draftId를 tx로 전달 → 원자 삭제
  //   window._promotingDraftId는 order-modal.js의 draft 승격 흐름에서만 세팅됨.
  //   신규 저장·편집은 draftId 없음 → 기존 동작 유지.
  // [코덱스 P1-2 fix 2026-08-28] draft 소유자 검증
  //   기본: currentUser.id (발주자 자기 draft 승격)
  //   관리자 대리 승격 대비: payload.proxyOrdererId 우선 (미래 확장 방어)
  await window._FS.transactOrderInventory({
    order:orderDoc,
    items:dbItems,
    expectedItems:_itemsBeforeOrderMutation,
    purchaseRequests:newPrs,
    replacePurchaseRequestsForOrderId:_eo?orderDoc.id:null,
    stockLogs,
    draftId: window._promotingDraftId || null,
    draftOwnerExpected: payload.proxyOrdererId || (currentUser?currentUser.id:null),
  });
  delete orderDoc._expectedPreviousUpdatedAt;
  // [2026-08-03] 편집 저장이면 발주 수정 이력 로그. 뭐 바뀌었는지 요약 텍스트로.
  if(_originalOrderForEdit){
    try{
      const _diffs=[];
      const _fmt=v=>v==null?'':String(v);
      const _fields=[
        ['deliveryTo','납품처'],['address','시공주소'],['orderDate','발주일'],
        ['shipDate','출고일'],['warehouse','창고'],['note','비고'],['sharedColor','공통색상'],
        ['upperCommonColor','상부색상'],['totalSupply','공급가액'],['totalVat','부가세'],
        ['totalAmount','합계']
      ];
      _fields.forEach(([k,label])=>{
        const b=_fmt(_originalOrderForEdit[k]), a=_fmt(orderDoc[k]);
        if(b!==a) _diffs.push(`${label}: ${b||'-'} → ${a||'-'}`);
      });
      // 서랍/선반/상부/옷봉 항목 개수 비교
      const _cntBefore=[
        (_originalOrderForEdit.drawerItems||_originalOrderForEdit.items||[]).length,
        (_originalOrderForEdit.shelfItems||[]).reduce((s,x)=>s+((x.entries||[]).length),0),
        (_originalOrderForEdit.upperMaterials||[]).filter(x=>(x.qty||0)>0).length,
        (_originalOrderForEdit.rodItems||[]).length
      ];
      const _cntAfter=[
        (orderDoc.drawerItems||[]).length,
        (orderDoc.shelfItems||[]).reduce((s,x)=>s+((x.entries||[]).length),0),
        (orderDoc.upperMaterials||[]).filter(x=>(x.qty||0)>0).length,
        (orderDoc.rodItems||[]).length
      ];
      const _labels=['서랍','선반','상부','옷봉'];
      _labels.forEach((lb,i)=>{
        if(_cntBefore[i]!==_cntAfter[i]) _diffs.push(`${lb} 항목: ${_cntBefore[i]}개 → ${_cntAfter[i]}개`);
      });
      // 개수·총액이 같아도 품목/색상/규격/수량이 바뀌면 감사 로그를 남긴다.
      const _itemGroups=[
        ['서랍',_originalOrderForEdit.drawerItems||_originalOrderForEdit.items||[],orderDoc.drawerItems||[]],
        ['선반',_originalOrderForEdit.shelfItems||[],orderDoc.shelfItems||[]],
        ['상부',_originalOrderForEdit.upperMaterials||[],orderDoc.upperMaterials||[]],
        ['옷봉',_originalOrderForEdit.rodItems||[],orderDoc.rodItems||[]]
      ];
      _itemGroups.forEach(([label,beforeItems,afterItems],i)=>{
        if(_cntBefore[i]===_cntAfter[i]&&JSON.stringify(beforeItems)!==JSON.stringify(afterItems)){
          _diffs.push(`${label} 품목 구성 변경`);
        }
      });
      if(_diffs.length>0){
        if(!window._FS||typeof window._FS.collectionAdd!=='function'){
          throw new Error('발주 수정 로그 저장 기능을 불러오지 못했습니다.');
        }
        const _logIds=await _serverGetLogIds(1);
        const _auditSnapshot=o=>({
          deliveryTo:o.deliveryTo||'',address:o.address||'',orderDate:o.orderDate||'',shipDate:o.shipDate||'',
          warehouse:o.warehouse||'',note:o.note||'',sharedColor:o.sharedColor||'',upperCommonColor:o.upperCommonColor||'',
          totalSupply:Number(o.totalSupply)||0,totalVat:Number(o.totalVat)||0,totalAmount:Number(o.totalAmount)||0,
          drawerItems:o.drawerItems||o.items||[],shelfItems:o.shelfItems||[],upperMaterials:o.upperMaterials||[],rodItems:o.rodItems||[]
        });
        const _eventId='orderedit_'+String(_logIds[0]);
        await window._FS.collectionAdd('hanger_order_edit_logs',_eventId,{
          id:_eventId,
          type:'발주수정',
          orderId:orderId,
          orderNum:orderDoc.orderNum||'',
          memo:_diffs.join(' / '),
          createdBy:currentUser?currentUser.id:'',
          createdAt:(typeof firebase!=='undefined'&&firebase.firestore&&firebase.firestore.FieldValue)
            ? firebase.firestore.FieldValue.serverTimestamp()
            : new Date().toISOString(),
          before:_auditSnapshot(_originalOrderForEdit),
          after:_auditSnapshot(orderDoc)
        });
      }
    }catch(logErr){
      // [2026-08-03 B7] 로그 실패 silent → 사용자 알림. 발주는 저장 성공했지만 감사 이력만 실패.
      console.warn('[발주수정 로그 실패]',logErr&&logErr.message);
      if(typeof toast==='function'){
        toast('⚠ 발주 수정은 저장됐지만 감사 이력 저장은 실패했습니다. 관리자에게 알려주세요. ('+((logErr&&logErr.message)||'')+')','warning');
      }
    }
  }
  // [2026-07-15 Critical 1] 저장 성공 후에만 _editOverride 클리어 — 실패 시 편집 모드 유지
  if(_eo) window._editOverride=null;
  return{orderId,shortageCount,order:orderDoc};
  }finally{
    _saveOrderInFlight=false;
    if(_saveLockAcquired&&typeof window._releaseServerSaveLock==='function'){
      try{ await window._releaseServerSaveLock(); }catch(_e){}
    }
  }
}

// ══════════════════════════════════════════════════
// [2026-08-28] 임시저장 = hanger_drafts 컬렉션 (완전 분리)
// 발주번호·statusHistory·isLocked·재고차감 없음. 미완성 초안 전용.
// 승격은 transactOrderInventory에 draftId 전달 → draft 삭제 + order 생성 원자적.
// ══════════════════════════════════════════════════
function _newDraftId(){
  const t=Date.now().toString(36);
  const r=Math.random().toString(36).slice(2,8);
  return `draft-${t}-${r}`;
}

async function saveDraft(payload, opts={}){
  if(!window._FS||typeof window._FS.collectionAdd!=='function'){
    throw new Error('draft 저장 기능 미로드');
  }
  const now=new Date().toISOString();
  const draftId=opts.draftId||_newDraftId();
  const doc={
    draftId,
    createdBy: opts.createdBy||(currentUser?currentUser.id:''),
    createdByName: currentUser?currentUser.name:'',
    createdAt: opts.createdAt||now,
    updatedAt: now,
    payload: JSON.parse(JSON.stringify(payload||{})),
  };
  await window._FS.collectionAdd('hanger_drafts', draftId, doc);
  return doc;
}

async function getDrafts(byUserId){
  if(!window._FS||typeof window._FS.collectionGet!=='function') return [];
  const arr=await window._FS.collectionGet('hanger_drafts');
  if(!Array.isArray(arr)) return [];
  return byUserId ? arr.filter(d=>d&&d.createdBy===byUserId) : arr;
}

async function getDraft(draftId){
  const arr=await getDrafts();
  return arr.find(d=>d&&d.draftId===draftId)||null;
}

async function deleteDraft(draftId){
  if(!window._FS||typeof window._FS.collectionDelete!=='function'){
    throw new Error('draft 삭제 기능 미로드');
  }
  await window._FS.collectionDelete('hanger_drafts', draftId);
}

if(typeof window!=='undefined'){
  window.saveDraft=saveDraft;
  window.getDrafts=getDrafts;
  window.getDraft=getDraft;
  window.deleteDraft=deleteDraft;
}

// [2026-07-24 Codex] localhost/127.0.0.1/스테이징 에서만 DB를 window에 노출 (E2E·QA 편의)
// [2026-09-03] 스테이징 도메인 추가 (계정 전환 버튼 + test 동일 정책). 운영 계속 차단.
if(typeof window!=='undefined'){
  const _h=(location&&location.hostname)||'';
  const _allow=(_h==='localhost'||_h==='127.0.0.1'||_h==='[::1]'||_h==='hanger-test-260901.web.app'||_h==='hanger-test-260901.firebaseapp.com');
  if(_allow) window.DB=DB;
}
