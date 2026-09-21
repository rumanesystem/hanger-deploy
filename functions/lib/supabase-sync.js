// Firestore hanger_orders → Supabase ordering.orders 실시간 sync
// 원본 발주앱 로직·설정 · 완전 미접촉. SDK 대신 fetch (Node 20 호환).
const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions");

const ADMIN_USER_ID = 1;
const LEGACY_SOURCE = "hanger-deploy@sync-live";
const TARGET_SCHEMA = "ordering";
const STATUS_MAP = { "발주대기": "신규발주", "발주확정": "출고확정", "취소": "취소" };
const WAREHOUSE_MAP = { "시흥": "시흥", "평택": "평택" };

// Supabase PostgREST · Accept-Profile(읽기)/Content-Profile(쓰기)로 스키마 지정.
async function sbFetch(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const isRead = method === "GET" || method === "HEAD";
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...(isRead ? { "Accept-Profile": TARGET_SCHEMA } : { "Content-Profile": TARGET_SCHEMA }),
    ...(options.headers || {}),
  };
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: options.body });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) { const err = new Error(`Supabase ${res.status} ${path}: ${text}`); err.status = res.status; err.body = body; throw err; }
  return body;
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
    is_legacy: true, legacy_source: LEGACY_SOURCE,
    legacy_items: {
      items: data.items ?? [], drawerItems: data.drawerItems ?? [], upperMaterials: data.upperMaterials ?? [],
      shelfItems: data.shelfItems ?? [], rodItems: data.rodItems ?? [], totalSupply: data.totalSupply ?? 0,
      totalVat: data.totalVat ?? 0, totalAmount: data.totalAmount ?? 0, sharedColor: data.sharedColor ?? "",
      upperCommonColor: data.upperCommonColor ?? "", statusHistory: data.statusHistory ?? [],
      drawerMemo: data.drawerMemo ?? "", etcMemo: data.etcMemo ?? "", firestoreDocId: docId,
    },
  };
}

async function lookupUserId(origId) {
  if (!origId) return ADMIN_USER_ID;
  const rows = await sbFetch(`users?select=id&login_id=eq.${encodeURIComponent(`hanger_${origId}`)}&limit=1`);
  return rows?.[0]?.id ?? ADMIN_USER_ID;
}

async function upsertOrder(row, origCreatedBy) {
  row.created_by = await lookupUserId(origCreatedBy);
  const rows = await sbFetch("orders?on_conflict=order_no", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(row),
  });
  return rows?.[0];
}

async function handleOrder(kind, event) {
  const docId = event.params.docId;
  const data = kind === "update" ? event.data?.after?.data() : event.data?.data();
  if (!data) { logger.warn(`[sync-${kind}] 데이터 없음`, { docId }); return; }
  const row = transformOrder(docId, data);
  if (row.skip) { logger.info(`[sync-${kind}] skip`, { docId, reason: row.reason }); return; }
  try {
    const result = await upsertOrder(row, data.createdBy);
    logger.info(`[sync-${kind}] ${kind === "update" ? "갱신" : "저장"} 완료`, { docId, orderNo: row.order_no, supabaseId: result?.id });
  } catch (e) {
    logger.error(`[sync-${kind}] 실패`, { docId, orderNo: row.order_no, error: e.message });
  }
}

exports.syncOrderCreated = onDocumentCreated(
  { document: "hanger_orders/{docId}", region: "asia-northeast3" },
  (event) => handleOrder("create", event)
);
exports.syncOrderUpdated = onDocumentUpdated(
  { document: "hanger_orders/{docId}", region: "asia-northeast3" },
  (event) => handleOrder("update", event)
);

function transformPayment(docId, data) {
  const paidOn = validDate(data.date);
  const amount = Number(data.amount ?? 0);
  const customer = String(data.customer ?? "").trim();
  if (!paidOn || !amount || amount <= 0 || !customer) return null;
  return {
    customer, paid_on: paidOn, amount, memo: `${data.memo ?? ""} [fs:${docId}]`.trim(),
    created_at: tsToIso(data.createdAt) || new Date().toISOString(),
    is_legacy: true, _docId: docId,
  };
}

async function insertPayment(row, origCreatedBy) {
  row.created_by = await lookupUserId(origCreatedBy);
  // PostgREST like: * = SQL % 와일드카드. Firestore doc id를 memo 접미로 중복 방지.
  const pattern = encodeURIComponent(`*[fs:${row._docId}]*`);
  const existing = await sbFetch(`payments?select=id&memo=like.${pattern}&limit=1`);
  if (existing && existing.length > 0) return { id: existing[0].id, inserted: false };
  const insertRow = { ...row };
  delete insertRow._docId;
  const rows = await sbFetch("payments", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(insertRow),
  });
  return { id: rows?.[0]?.id, inserted: true };
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
      const result = await insertPayment(row, data.createdBy);
      logger.info(result.inserted ? "[sync-pay] 저장 완료" : "[sync-pay] 이미 존재 · skip", { docId, supabaseId: result.id });
    } catch (e) {
      logger.error("[sync-pay] 저장 실패", { docId, error: e.message });
    }
  }
);

async function syncOneInvoice(inv) {
  const orderNum = inv.orderNum, serial = inv.serial;
  if (!orderNum || !serial) return "failed";
  const orderRows = await sbFetch(`orders?select=id&order_no=eq.${encodeURIComponent(orderNum)}&limit=1`);
  const order = orderRows?.[0];
  if (!order) return "failed";
  const row = {
    order_id: order.id, serial,
    supply_amount: Math.round(Number(inv.totalSupply) || 0),
    vat_amount: Math.round(Number(inv.totalVat) || 0),
    total_amount: Math.round(Number(inv.totalAmount) || 0),
    sent: false, cancelled: inv.cancelled === true,
    cancelled_at: inv.cancelledAt || null,
    issued_at: inv.createdAt || new Date().toISOString(),
    items_json: inv.items || [],
  };
  const existRows = await sbFetch(`invoices?select=id&serial=eq.${encodeURIComponent(serial)}&limit=1`);
  const existing = existRows?.[0];
  if (existing) { await sbFetch(`invoices?id=eq.${existing.id}`, { method: "PATCH", body: JSON.stringify(row) }); return "updated"; }
  await sbFetch("invoices", { method: "POST", body: JSON.stringify(row) });
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
