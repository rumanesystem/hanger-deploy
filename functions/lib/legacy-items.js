// 옛 형식 품목(legacy_items) → 새 앱 order_items 변환.
// 출처: 발주앱 scripts/firebase-supabase-sync/{name-to-id,legacy-price,build-order-items}.mjs
// 2026-09-28 · 금액 버그 6건을 고친 뒤 이 환경(CommonJS)으로 옮긴 것.
// 원본이 바뀌면 양쪽을 같이 고쳐야 한다.

// 원본 발주앱 상품명 → 신규 앱 productId 매핑.
// scripts/migration/import-legacy-orders.mjs 에서 복사·유지보수.
// 상품 catalog 변경 시 두 파일 모두 갱신.

const NAME_TO_ID = {
  "선반바(ABS) 400": 4,
  "포스트바 2250": 2,
  "포스트바 2050": 1,
  "포스트바 2200": 2,
  "포스트바 2400": 3,
  "조절발": 8,
  "조절발 연장캡": 11,
  "조절발 연장캡 15mm": 11,
  "코너바 2200": 6,
  "코너앵글": 7,
  "옷봉캡": 16,
  "코너 옷봉캡 (단방, 양방)": 17,
  "포스트마감캡": 9,
  "포스트연결캡": 10,
  "스패너": 14,
  "벽고정 앵글": 12,
  "벽고정앵글": 12,
  "나비너트": 64,
  "나비너트볼트": 65,
  "벽고정 프레임 800": 66,
  "벽고정 프레임 1000": 67,
  "겉서랍 2단": 25, "속서랍 2단": 25,
  "겉서랍 3단": 26, "속서랍 3단": 26,
  "겉서랍 4단": 27,
  "겉서랍 5단": 28, "속서랍 5단": 28,
  "겉서랍 아일랜드": 29,
  "거울장 목대": 30, "거울장 거울문": 31,
  "이불장 목대": 32,
  "이불 긴장문": 35, "이불 반장문": 33,
  "화장대(대)": 36, "화장대 거울문": 37,
  "디바이더": 38, "화장대 디바이더": 38,
  "인출식 바지걸이": 39,
  "서랍 고정 브라켓": 13,
  "선반재단비": 68,
  "포스트조립비": 69,
  "이불장손잡이(1구)": 70,
  "속서랍 4단": 27, "속서랍 아일랜드": 81,
  "거울장": 60, "화장대세트": 62, "이불 반장": 63,
  "옷봉 2400": 15, "선반 370": 20, "선반 570": 19, "디바이더 속서랍": 38,
  "더 도어 시스템 옷봉캡": 71, "더 도어 시스템 선반바": 72, "더 도어 시스템 조절발": 73,
  "더 도어 시스템 포스트 2250 H21(앞)": 74, "더 도어 시스템 2250 H65(뒤)": 75,
  "서랍장손잡이(속서랍용)": 82, "발통": 77, "바퀴": 78, "직결볼트": 79,
};

// STATUS_MAP · WAREHOUSE_MAP 은 여기서 쓰지 않는다 (supabase-sync.js 에 있는 것이 정본).
// 옮겨오면서 딸려온 것이라 뺐다 · 세 군데에 같은 표가 있으면 한 곳만 고치는 사고가 난다.

// 원본 발주앱의 기본 단가표를 그대로 옮긴 것.
// 출처: hanger-deploy/public/발주앱/js/price.js 의 PRICE_MAP + DRAWER_OPTION_PRICES.
//
// 왜 필요한가: 이관된 발주 중에는 단가가 없어 0으로 저장된 줄이 있다.
// 원본 앱은 그런 줄을 이 표에서 찾아 계산했다. 우리 products 표의 단가는
// 원본과 다른 품목이 있어서(벽고정 프레임 800 = 원본 600 vs 우리 6000) 대신 쓸 수 없다.
// 원본 표가 바뀌면 이 파일도 같이 고쳐야 한다.

const LEGACY_PRICE = {
  // 상부자재·부속
  "포스트바 2050": 10500,
  "포스트바 2250": 11000,
  "포스트바 2200": 11000,   // 같은 물건 · 매핑표에도 둘 다 2번 상품으로 들어간다
  "포스트바 2400": 12000,
  "선반바(ABS) 400": 2100,
  "코너바 2200": 6000,
  "코너앵글": 500,
  "조절발": 1000,
  "포스트마감캡": 200,
  "옷봉 2400": 5000,
  "옷봉캡": 350,
  "코너 옷봉캡 (단방, 양방)": 500,
  "조절발 연장캡": 450,
  "인출식 바지걸이": 42000,
  "선반재단비": 1000,
  "포스트조립비": 3000,
  "벽고정 앵글": 6000,
  "벽고정 프레임 800": 600,
  "벽고정 프레임 1000": 600,
  "스패너": 2000,
  "포스트연결캡": 500,
  // 선반 (규격별)
  "선반 770": 5300,
  "선반 570": 4200,
  "선반 370": 3200,
  "선반 2400": 16000,
  "선반 비규격": 8800,
  "코너선반 780": 13000,
  "코너선반 비규격": 23000,
  // 서랍·옵션
  "겉서랍 2단": 69000,
  "속서랍 2단": 69000,
  "겉서랍 3단": 92000,
  "속서랍 3단": 92000,
  "겉서랍 4단": 139000,
  "속서랍 4단": 139000,
  "겉서랍 5단": 160000,
  "속서랍 5단": 160000,
  "겉서랍 아일랜드": 150000,
  "속서랍 아일랜드": 200000,
  "거울장": 87000,
  "거울장 목대": 87000,
  "거울장 거울문": 60000,
  "디바이더": 58000,
  "디바이더 속서랍": 58000,
  "이불장": 92000,
  "이불장 목대": 92000,
  "이불장손잡이(1구)": 0,
  "이불 반장": 80000,
  "이불 반장문": 46000,
  "이불 긴장": 255000,
  "이불 긴장문": 70000,
  "화장대세트": 180000,
  "화장대(대)": 92000,
  "화장대 디바이더": 58000,
  "화장대(디바이더 600포함)": 150000,
  "화장대 거울문": 60000,
};

// 원본의 UPPER_COMPAT · 옛 이름을 현재 이름으로 맞춘다.
const COMPAT = {
  "포스트조절발(연장캡 15mm)": "조절발 연장캡",
  "조절방 연장캡 15mm": "조절발 연장캡",
  "조절발 연장캡 15mm": "조절발 연장캡",
  "벽고정앵글": "벽고정 앵글",
};

// 이름으로 원본 단가를 찾는다 · 없으면 null (0원 상품과 구분해야 하므로 0 이 아니다).
function legacyPriceOf(name) {
  const key = COMPAT[name] ?? name;
  const v = LEGACY_PRICE[key];
  return typeof v === "number" ? v : null;
}

// 선반·코너선반은 이름이 아니라 규격으로 단가가 정해진다 (원본 getShelfPrice/getCornerShelfPrice).
// 구간은 build-order-items 의 shelfIdForSize·cornerIdForSize 와 같아야 한다.
function legacyShelfPriceOf(shelfName, w, h) {
  if (shelfName === "코너선반") {
    return (w <= 780 && h <= 585) ? LEGACY_PRICE["코너선반 780"] : LEGACY_PRICE["코너선반 비규격"];
  }
  if (w <= 400) return LEGACY_PRICE["선반 370"];
  if (w <= 600) return LEGACY_PRICE["선반 570"];
  if (w <= 800) return LEGACY_PRICE["선반 770"];
  if (w <= 1220) return LEGACY_PRICE["선반 비규격"];
  return LEGACY_PRICE["선반 2400"];
}

// 옛 형식 품목(legacy_items) → 새 형식 품목줄(order_items) 변환.
// migrate_order_items.mjs 에 있던 로직을 그대로 꺼낸 것 · poll 과 공용으로 쓴다.
// 이름을 못 찾은 줄은 버리고 missing 으로만 센다 (여기서 만들어내지 않는다).


function shelfIdForSize(w) {
  if (w <= 400) return 20;
  if (w <= 600) return 19;
  if (w <= 800) return 18;
  if (w <= 1220) return 22;
  return 21;
}
function cornerIdForSize(w, h) {
  return (w <= 780 && h <= 585) ? 23 : 24;
}
const ROD_2400_ID = 15;

// src/lib/repos/orders/shared.ts 와 같은 한도 · 두 경로가 다른 기준을 쓰면 안 된다.
const MAX_ORDER_QUANTITY = 1_000_000;
const MAX_INT4 = 2_147_483_647;

// 외부(Firestore)에서 온 값이라 한도를 넘으면 버린다 · 넘긴 채로 넣으면 INSERT 가 통째로 실패한다.
function withinLimits(r) {
  // 저장 컬럼이 INTEGER 라 정수여야 한다 · 소수가 들어가면 그 발주 전체 INSERT 가 깨진다.
  return Number.isInteger(r.quantity) && Number.isInteger(r.unitPrice)
    && r.quantity > 0 && r.quantity <= MAX_ORDER_QUANTITY
    && r.unitPrice >= 0 && r.unitPrice <= MAX_INT4
    && r.quantity * r.unitPrice <= MAX_INT4;
}

// itemIdToName · Firestore raw doc 을 넘길 때만 필요. legacy_items 에는 name 이 이미 들어 있다.
function buildOrderItems(legacy, itemIdToName = null) {
  const nameOf = (o) => o.name || (itemIdToName?.get(String(o.itemId ?? "")) ?? "") || "";
  // 원본은 amount 를 먼저 보고 없을 때만 단가×수량을 쓴다 (price.js).
  // order_items 는 단가만 저장하므로, amount 가 딱 나누어떨어질 때만 그 단가를 쓴다.
  // 1) amount 가 나누어떨어지면 그 단가 · 2) 저장된 단가 · 3) 원본 기본 단가표.
  // 3번이 있어야 이관 때 가격이 비어 0 으로 굳은 줄이 살아난다 (원본 앱도 표에서 찾아 계산한다).
  const priceOf = (o, qty) => {
    const amt = Number(o.amount);
    if (Number.isFinite(amt) && amt > 0 && qty > 0 && amt % qty === 0) return amt / qty;
    const saved = Number(o.unitPrice);
    if (Number.isFinite(saved) && saved > 0) return saved;
    const fallback = legacyPriceOf(nameOf(o));
    return fallback ?? (Number.isFinite(saved) ? saved : 0);
  };
  const rows = [];
  let missing = 0;
  // 원본 앱은 drawerItems 가 있으면 그것만 세고 items 는 보지 않는다 (price.js · drawerItems || items).
  // 둘 다 더하면 금액이 두 배가 된다 · 운영 데이터에서도 drawerItems 는 전부 items 의 사본이었다.
  const mainItems = (legacy.drawerItems?.length ? legacy.drawerItems : legacy.items) ?? [];
  for (const u of mainItems) {
    const pid = NAME_TO_ID[nameOf(u)];
    if (!pid) { missing++; continue; }
    const qty = Number(u.requiredQty ?? u.qty) || 0;
    rows.push({ productId: pid, quantity: qty, color: u.color ?? "", spec: u.spec ?? "", unitPrice: priceOf(u, qty) });
  }
  for (const u of legacy.upperMaterials ?? []) {
    const pid = NAME_TO_ID[nameOf(u)];
    if (!pid) { missing++; continue; }
    // 수량이 비어 있으면 색상별 개수에서 가져온다 · 원본 price.js 와 같은 폴백.
    let qty = Number(u.qty) || 0;
    if (!qty) for (const k of ["white", "black", "silver", "champagne"]) {
      if (Number(u[k]) > 0) { qty = Number(u[k]); break; }
    }
    rows.push({ productId: pid, quantity: qty, color: u.color ?? "", spec: "", unitPrice: priceOf(u, qty) });
  }
  // drawerItems 는 items 를 서랍 탭에도 보여주려고 복사해둔 것 · 별도 품목이 아니다.
  // 운영 데이터 확인 결과 drawerItems 의 모든 줄이 items 에도 그대로 있다 (예외 0건).
  // 여기서 또 더하면 금액이 두 배가 된다 · 원본 앱 총액(totalSupply)도 한 번만 센다.
  for (const s of legacy.shelfItems ?? []) {
    for (const e of s.entries ?? []) {
      const w = Number(e.width) || Number(String(e.size ?? "").replace(/[^\d]/g, "")) || 0;
      const h = Number(e.height) || 0;
      if (w === 0) { missing++; continue; }
      const pid = s.name === "코너선반" ? cornerIdForSize(w, h) : shelfIdForSize(w);
      const qty = Number(e.qty) || 0;
      // 선반은 이름이 아니라 규격으로 단가가 정해진다 · 이름으로는 가격표를 못 찾는다.
      const unitPrice = priceOf(e, qty) || legacyShelfPriceOf(s.name, w, h) || 0;
      rows.push({
        productId: pid, quantity: qty, color: e.color ?? "",
        spec: h > 0 ? `${w}×${h}` : String(w), unitPrice,
      });
    }
  }
  // 옷봉은 2400 짜리를 사서 필요한 길이로 잘라 쓴다.
  // 조각 하나하나를 옷봉 한 개로 세면 안 된다 · 발주 수량은 rod2400Required(필요한 2400 개수).
  // restore-legacy-rod-items.mjs 와 같은 기준 · 조각 내역은 spec 에 남긴다.
  const rodNeed = Number(legacy.rod2400Required) || 0;
  if (rodNeed > 0) {
    const valid = (legacy.rodItems ?? []).filter((r) => Number(r.size) > 0 && Number(r.qty) > 0);
    const parts = valid.map((r) => `${Number(r.size)}×${Number(r.qty)}`).join(", ");
    const totalMm = valid.reduce((s, r) => s + Number(r.size) * Number(r.qty), 0);
    rows.push({
      productId: ROD_2400_ID,
      quantity: rodNeed,
      color: valid[0]?.color ?? "",
      spec: parts ? `${parts} / 총${totalMm}mm` : "",
      // 원본은 `가격표 조회 || 4500` 인데 가격표에 '옷봉 2400': 5000 이 있어 4500 은 쓰이지 않는다.
      unitPrice: Number(legacy.rodUnitPrice) || legacyPriceOf("옷봉 2400"),
    });
  }
  const kept = rows.filter(withinLimits);
  return { rows: kept, missing: missing + (rows.length - kept.length) };
}

module.exports = { buildOrderItems, NAME_TO_ID, legacyPriceOf, legacyShelfPriceOf };