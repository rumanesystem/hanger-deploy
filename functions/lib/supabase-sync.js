// Firestore hanger_orders → Supabase ordering.orders 실시간 sync
// pg 직접 연결 (Transaction pooler) · PostgREST 우회 · Vercel 앱과 동일 방식.
const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions");
const { Pool } = require("pg");
const { syncOrderItems } = require("./sync-order-items");
const { insertPayment } = require("./sync-payment-insert");
const { inTx, saveLegacyOrder, saveLegacyInvoice } = require("./sync-dup-number");
const ADMIN_USER_ID = 1;
const LEGACY_SOURCE = "hanger-deploy@sync-live";
const TARGET_SCHEMA = "ordering";
const STATUS_MAP = { "발주대기": "신규발주", "발주확정": "출고확정", "취소": "취소" };
const WAREHOUSE_MAP = { "시흥": "시흥", "평택": "평택" };

let _pool = null;
function pool() {
  if (_pool) return _pool;
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL not set");
  _pool = new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
  return _pool;
}
// 한 문장 실행 · 스키마는 트랜잭션 안에서 SET LOCAL 로 건다 (Transaction pooler 는 트랜잭션 밖 SET 이
// 다음 문장에 안 이어지거나 다른 접속에 남을 수 있음 → 공용 DB 의 다른 스키마 표를 볼 위험).
const q = (sql, params) => inTx(pool(), TARGET_SCHEMA, null, (c) => c.query(sql, params));

function tsToIso(v) {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (v._seconds != null) return new Date(v._seconds * 1000).toISOString();
  if (v.toDate) return v.toDate().toISOString();
  return null;
}
function validDate(s) {
  if (!s || typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s) || s === "0000-00-00") return null;
  return s;
}

function transformOrder(docId, data) {
  const orderNo = data.orderNum || docId;
  const status = STATUS_MAP[data.status];
  const warehouse = WAREHOUSE_MAP[data.warehouse];
  if (!status || !warehouse) return { skip: true, reason: `매핑 실패 · status=${data.status} warehouse=${data.warehouse}` };
  return {
    order_no: orderNo, delivery_to: data.deliveryTo || data.siteName || "", address: data.address || "",
    warehouse, status, requested_date: validDate(data.orderDate) || "2020-01-01",
    ship_date: validDate(data.shipDate), memo: data.note || "",
    created_at: tsToIso(data.createdAt) || new Date().toISOString(),
    legacy_items: {
      // Firestore items의 이름 필드는 displayName · legacy body는 name을 읽으므로 매핑 필요.
      items: (data.items ?? []).map((it) => ({ ...it, name: it.displayName ?? it.name ?? "", qty: it.requiredQty ?? it.qty ?? 0 })),
      drawerItems: (data.drawerItems ?? []).map((it) => ({ ...it, name: it.displayName ?? it.name ?? "", qty: it.requiredQty ?? it.qty ?? 0 })),
      upperMaterials: (data.upperMaterials ?? []).map((u) => ({ ...u, name: u.displayName ?? u.name ?? "" })),
      shelfItems: (data.shelfItems ?? []).map((s) => ({ ...s, name: s.displayName ?? s.name ?? "" })),
      rodItems: data.rodItems ?? [],
      rod2400Required: data.rod2400Required ?? 0, rodTotalLen: data.rodTotalLen ?? 0,
      rodUnitPrice: data.rodUnitPrice ?? 0, rodAmount: data.rodAmount ?? 0,
      totalSupply: data.totalSupply ?? 0,
      totalVat: data.totalVat ?? 0, totalAmount: data.totalAmount ?? 0, sharedColor: data.sharedColor ?? "",
      upperCommonColor: data.upperCommonColor ?? "", statusHistory: data.statusHistory ?? [],
      drawerMemo: data.drawerMemo ?? "", etcMemo: data.etcMemo ?? "", firestoreDocId: docId,
    },
  };
}
// 발주 주인 찾기 · ① hanger_<원본id> 계정 → ② 납품처명과 일치하는 활성 발주자(정확히 1명일 때만) → ③ 관리자.
// 동명이인이면 붙이지 않고 관리자로 둬 오배정을 막는다 · 이름으로 붙인 건은 로그로 사후 확인.
async function lookupUserId(origId, deliveryTo) {
  if (origId) {
    const r = await q("SELECT id FROM users WHERE login_id=$1 LIMIT 1", [`hanger_${origId}`]);
    if (r.rows[0]) return r.rows[0].id;
  }
  const name = (deliveryTo ?? "").trim();
  if (name) {
    const r2 = await q("SELECT id FROM users WHERE role='orderer' AND active = TRUE AND (delivery_name = $1 OR name = $1)", [name]);
    if (r2.rowCount === 1) { logger.info("[sync] 납품처명으로 소유자 연결", { deliveryTo: name, userId: r2.rows[0].id }); return r2.rows[0].id; }
    if (r2.rowCount > 1) logger.warn("[sync] 납품처명 중복 · 관리자 소유 유지", { deliveryTo: name, n: r2.rowCount });
  }
  return ADMIN_USER_ID;
}
// 저장·번호 겹침 처리는 sync-dup-number.js · 새 앱이 같은 번호를 이미 썼으면 "번호 (1버전)" 으로 저장된다.
async function upsertOrder(row, origCreatedBy) {
  const createdBy = await lookupUserId(origCreatedBy, row.delivery_to);
  return saveLegacyOrder(pool(), TARGET_SCHEMA, row, createdBy, LEGACY_SOURCE);
}
async function handleOrder(kind, event) {
  const docId = event.params.docId;
  const data = kind === "update" ? event.data?.after?.data() : event.data?.data();
  if (!data) { logger.warn(`[sync-${kind}] 데이터 없음`, { docId }); return; }
  const row = transformOrder(docId, data);
  if (row.skip) { logger.info(`[sync-${kind}] skip`, { docId, reason: row.reason }); return; }
  try {
    const r = await upsertOrder(row, data.createdBy);
    if (r.orderNo !== row.order_no) logger.warn(`[sync-${kind}] 새 앱과 발주번호 겹침 · "${r.orderNo}" 로 저장`, { docId, orderNo: row.order_no });
    logger.info(`[sync-${kind}] ${kind === "update" ? "갱신" : "저장"} 완료`, { docId, orderNo: r.orderNo, supabaseId: r?.id });
    // 통계용 품목줄도 맞춘다 · 여기서 실패해도 발주는 이미 들어갔으므로 발주 동기화를 실패로 만들지 않는다.
    if (r?.id && !r.skippedItems) {
      try {
        const it = await syncOrderItems(pool(), TARGET_SCHEMA, r.id, row.legacy_items);
        logger.info(`[sync-${kind}] 품목`, { orderNo: row.order_no, ...it });
      } catch (e) {
        logger.error(`[sync-${kind}] 품목 실패`, { orderNo: row.order_no, error: e.message });
      }
    }
  } catch (e) {
    logger.error(`[sync-${kind}] 실패`, { docId, orderNo: row.order_no, error: e.message });
  }
}
exports.syncOrderCreated = onDocumentCreated({ document: "hanger_orders/{docId}", region: "asia-northeast3" }, (event) => handleOrder("create", event));
exports.syncOrderUpdated = onDocumentUpdated({ document: "hanger_orders/{docId}", region: "asia-northeast3" }, (event) => handleOrder("update", event));

function transformPayment(docId, data) {
  const paidOn = validDate(data.date);
  const amount = Number(data.amount ?? 0);
  const customer = String(data.customer ?? "").trim();
  if (!paidOn || !amount || amount <= 0 || !customer) return null;
  return {
    customer, paid_on: paidOn, amount, memo: `${data.memo ?? ""} [fs:${docId}]`.trim(),
    created_at: tsToIso(data.createdAt) || new Date().toISOString(), _docId: docId,
  };
}
exports.syncPaymentCreated = onDocumentCreated(
  { document: "hanger_payments/{docId}", secrets: [], region: "asia-northeast3" },
  async (event) => {
    const docId = event.params.docId;
    const data = event.data?.data();
    if (!data) { logger.warn("[sync-pay] 데이터 없음", { docId }); return; }
    const row = transformPayment(docId, data);
    if (!row) { logger.info("[sync-pay] skip · 필수값 없음", { docId }); return; }
    try {
      // 같은 입금 신호가 겹쳐 와도(트리거는 다시 보낼 수 있음) "있나 확인 → 넣기" 사이에 끼어들지 못하게 입금별로 잠근다
      const lock = { sql: "SELECT pg_advisory_xact_lock(hashtext($1))", params: [`sync-pay:${docId}`] };
      // 등록자 찾기는 잠그기 전에 (트랜잭션 안에서 접속을 하나 더 쓰면 동시에 몰릴 때 접속이 모자랄 수 있음)
      const createdBy = await lookupUserId(data.createdBy);
      const r = await inTx(pool(), TARGET_SCHEMA, lock, (c) => insertPayment((s, p) => c.query(s, p), async () => createdBy, row, data.createdBy));
      logger.info(r.inserted ? "[sync-pay] 저장 완료" : "[sync-pay] 이미 존재 · skip", { docId, supabaseId: r.id });
    } catch (e) { logger.error("[sync-pay] 저장 실패", { docId, error: e.message }); }
  }
);

// 옛 앱 발주에만 붙이고 · 다른 발주가 같은 명세서 번호를 쓰고 있으면 "번호 (1버전)" 으로 저장 (sync-dup-number.js)
const syncOneInvoice = (inv) => saveLegacyInvoice(pool(), TARGET_SCHEMA, inv);
exports.syncInvoicesDoc = onDocumentWritten(
  { document: "hanger_data/invoices", region: "asia-northeast3", timeoutSeconds: 300 },
  async (event) => {
    const after = event.data?.after?.data();
    if (!after) { logger.info("[sync-inv] after 없음 · skip"); return; }
    const invoices = after.value || [];
    logger.info(`[sync-inv] 트리거 · ${invoices.length}건 처리 시작`);
    const c = { inserted: 0, updated: 0, failed: 0 };
    for (const inv of invoices) {
      try { c[await syncOneInvoice(inv)]++; }
      catch (e) { c.failed++; logger.error("[sync-inv] 항목 실패", { orderNum: inv.orderNum, serial: inv.serial, error: e.message }); }
    }
    logger.info(`[sync-inv] 완료 · 신규=${c.inserted} 갱신=${c.updated} 실패=${c.failed}`);
  }
);
