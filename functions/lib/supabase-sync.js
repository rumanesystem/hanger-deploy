// Firestore hanger_orders → Supabase ordering.orders 실시간 sync
// pg 직접 연결 (Transaction pooler) · PostgREST 우회 · Vercel 앱과 동일 방식.
const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions");
const { Pool } = require("pg");
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
async function q(sql, params) {
  const client = await pool().connect();
  try {
    await client.query(`SET search_path TO ${TARGET_SCHEMA}, public`);
    return await client.query(sql, params);
  } finally { client.release(); }
}

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
async function lookupUserId(origId) {
  if (!origId) return ADMIN_USER_ID;
  const r = await q("SELECT id FROM users WHERE login_id=$1 LIMIT 1", [`hanger_${origId}`]);
  return r.rows[0]?.id ?? ADMIN_USER_ID;
}
async function upsertOrder(row, origCreatedBy) {
  const createdBy = await lookupUserId(origCreatedBy);
  // 우리 앱에서 편집된 발주는 legacy_items 덮어쓰기 X (원본 앱 무관 · 우리 편집 유지).
  // 존재 여부 + 편집 여부 확인 후 · 편집됨이면 status·ship_date만 갱신하는 별도 경로 사용.
  const existing = await q("SELECT id, edited_in_new_app FROM orders WHERE order_no=$1", [row.order_no]);
  if (existing.rows[0]?.edited_in_new_app === true) {
    // 편집됨 · legacy_items 안 건드림 · status·ship_date만 원본 흐름 반영 (원한다면 이것도 skip 가능).
    await q(
      `UPDATE orders SET status=$1, ship_date=$2 WHERE id=$3`,
      [row.status, row.ship_date, existing.rows[0].id],
    );
    return { id: existing.rows[0].id, skippedItems: true };
  }
  const r = await q(
    `INSERT INTO orders (order_no, delivery_to, address, warehouse, status, requested_date, ship_date, memo, created_by, created_at, is_legacy, legacy_items, legacy_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11::jsonb,$12)
     ON CONFLICT (order_no) DO UPDATE SET status=EXCLUDED.status, ship_date=EXCLUDED.ship_date, legacy_items=EXCLUDED.legacy_items
     RETURNING id`,
    [row.order_no, row.delivery_to, row.address, row.warehouse, row.status, row.requested_date, row.ship_date, row.memo, createdBy, row.created_at, JSON.stringify(row.legacy_items), LEGACY_SOURCE],
  );
  return { id: r.rows[0]?.id };
}
async function handleOrder(kind, event) {
  const docId = event.params.docId;
  const data = kind === "update" ? event.data?.after?.data() : event.data?.data();
  if (!data) { logger.warn(`[sync-${kind}] 데이터 없음`, { docId }); return; }
  const row = transformOrder(docId, data);
  if (row.skip) { logger.info(`[sync-${kind}] skip`, { docId, reason: row.reason }); return; }
  try {
    const r = await upsertOrder(row, data.createdBy);
    logger.info(`[sync-${kind}] ${kind === "update" ? "갱신" : "저장"} 완료`, { docId, orderNo: row.order_no, supabaseId: r?.id });
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
async function insertPayment(row, origCreatedBy) {
  const createdBy = await lookupUserId(origCreatedBy);
  const exists = await q("SELECT id FROM payments WHERE memo LIKE $1 LIMIT 1", [`%[fs:${row._docId}]%`]);
  if (exists.rowCount > 0) return { id: exists.rows[0].id, inserted: false };
  const r = await q(
    `INSERT INTO payments (customer, paid_on, amount, memo, created_by, created_at, is_legacy)
     VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id`,
    [row.customer, row.paid_on, row.amount, row.memo, createdBy, row.created_at],
  );
  return { id: r.rows[0]?.id, inserted: true };
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
      const r = await insertPayment(row, data.createdBy);
      logger.info(r.inserted ? "[sync-pay] 저장 완료" : "[sync-pay] 이미 존재 · skip", { docId, supabaseId: r.id });
    } catch (e) { logger.error("[sync-pay] 저장 실패", { docId, error: e.message }); }
  }
);

async function syncOneInvoice(inv) {
  const orderNum = inv.orderNum, serial = inv.serial;
  if (!orderNum || !serial) return "failed";
  const orderR = await q("SELECT id FROM orders WHERE order_no=$1 LIMIT 1", [orderNum]);
  const order = orderR.rows[0];
  if (!order) return "failed";
  const row = {
    order_id: order.id, serial,
    supply_amount: Math.round(Number(inv.totalSupply) || 0),
    vat_amount: Math.round(Number(inv.totalVat) || 0),
    total_amount: Math.round(Number(inv.totalAmount) || 0),
    sent: false, cancelled: inv.cancelled === true,
    cancelled_at: inv.cancelledAt || null,
    issued_at: inv.createdAt || new Date().toISOString(),
    items_json: JSON.stringify(inv.items || []),
  };
  const existR = await q("SELECT id FROM invoices WHERE serial=$1 LIMIT 1", [serial]);
  const existing = existR.rows[0];
  if (existing) {
    await q(
      `UPDATE invoices SET order_id=$1, supply_amount=$2, vat_amount=$3, total_amount=$4,
        sent=$5, cancelled=$6, cancelled_at=$7, issued_at=$8, items_json=$9::jsonb WHERE id=$10`,
      [row.order_id, row.supply_amount, row.vat_amount, row.total_amount, row.sent, row.cancelled, row.cancelled_at, row.issued_at, row.items_json, existing.id],
    );
    return "updated";
  }
  await q(
    `INSERT INTO invoices (order_id, serial, supply_amount, vat_amount, total_amount, sent, cancelled, cancelled_at, issued_at, items_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [row.order_id, row.serial, row.supply_amount, row.vat_amount, row.total_amount, row.sent, row.cancelled, row.cancelled_at, row.issued_at, row.items_json],
  );
  return "inserted";
}
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
