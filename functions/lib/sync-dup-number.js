// 옛 앱 → 새 앱 동기화 · 발주·명세서 저장 (번호 겹침 처리 포함).
// 옛 앱과 새 앱은 발주번호·명세서 번호를 따로 센다 → 같은 번호가 나올 수 있다.
// 새 앱이 이미 쓴 번호면 옛 앱 것은 "번호 (1버전)" 으로 따로 저장한다 (새 앱 것을 덮어쓰거나 옛 앱 것을 버리지 않게).

const DUP_MARK = " (1버전)";
// sync-order-items.js 와 같은 방어 · 스키마 이름이 SQL 에 그대로 들어가므로 허용 목록만
const ALLOWED_SCHEMAS = new Set(["ordering", "ordering_preview"]);

// 한 트랜잭션 안에서 스키마 지정 → 잠금 → 작업.
// search_path 는 트랜잭션 안에서 SET LOCAL 로 건다 (Transaction pooler 는 트랜잭션 밖 SET 이 다음 문장에 안 이어질 수 있음).
// 잠금은 새 앱 채번과 같은 키 · 번호를 고르는 사이 새 앱이 같은 번호를 만들지 못하게.
//   발주번호: pg_advisory_xact_lock(72111)            · 발주앱 src/lib/repos/orders/create.ts
//   명세서:   pg_advisory_xact_lock(72112, YYYYMMDD) · 발주앱 src/lib/repos/invoices/serial.ts
async function inTx(pool, schema, lock, work) {
  if (!ALLOWED_SCHEMAS.has(schema)) throw new Error(`허용되지 않은 schema: ${schema}`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO ${schema}`);
    if (lock) await client.query(lock.sql, lock.params);
    const out = await work(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* 원래 에러를 덮지 않게 */ }
    throw e;
  } finally { client.release(); }
}

// 저장할 발주번호 · ① 이미 "(1버전)" 으로 저장된 옛 앱 발주가 있으면 그것 ② 같은 번호가 없거나 옛 앱 발주면 그 번호 ③ 새 앱 발주가 쓰고 있으면 "(1버전)"
async function pickOrderNo(client, orderNo) {
  const marked = orderNo + DUP_MARK;
  const r = await client.query("SELECT order_no, is_legacy FROM orders WHERE order_no = ANY($1::text[])", [[orderNo, marked]]);
  const legacy = new Map(r.rows.map((x) => [x.order_no, x.is_legacy]));
  if (legacy.get(marked) === true) return marked;
  if (!legacy.has(orderNo) || legacy.get(orderNo) === true) return orderNo;
  return marked;
}

// 옛 앱 발주 저장 · 새 앱 발주(is_legacy=false)는 절대 고치지 않는다.
// row = supabase-sync.js transformOrder 결과 · 돌려주는 값 { id, skippedItems, orderNo(실제 저장된 번호) }
async function saveLegacyOrder(pool, schema, row, createdBy, source) {
  return inTx(pool, schema, { sql: "SELECT pg_advisory_xact_lock(72111)", params: [] }, async (client) => {
    const orderNo = await pickOrderNo(client, row.order_no);
    // CASE 로 편집됨(edited_in_new_app=true)이면 legacy_items 원본 보존 · 아니면 갱신.
    const r = await client.query(
      `INSERT INTO orders (order_no, delivery_to, address, warehouse, status, requested_date, ship_date, memo, created_by, created_at, is_legacy, legacy_items, legacy_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11::jsonb,$12)
       ON CONFLICT (order_no) DO UPDATE SET
         status=EXCLUDED.status,
         ship_date=EXCLUDED.ship_date,
         legacy_items = CASE WHEN orders.edited_in_new_app THEN orders.legacy_items ELSE EXCLUDED.legacy_items END
       WHERE orders.is_legacy
       RETURNING id, edited_in_new_app`,
      [orderNo, row.delivery_to, row.address, row.warehouse, row.status, row.requested_date, row.ship_date, row.memo, createdBy, row.created_at, JSON.stringify(row.legacy_items), source],
    );
    if (!r.rows[0]) throw new Error(`발주번호 ${orderNo} 를 새 앱 발주가 쓰고 있어 저장하지 않음`);
    return { id: r.rows[0].id, skippedItems: r.rows[0].edited_in_new_app === true, orderNo };
  });
}

// 명세서 번호 고르기 · 같은 번호(또는 "(1버전)")의 명세서가 같은 옛 앱 발주에 붙어 있으면 같은 명세서로 보고 갱신,
// 다른 발주에 붙어 있으면 다른 명세서(새 앱 것 등)로 보고 "(1버전)" 으로 새로 넣는다. → { serial, existingId }
async function pickInvoiceSerial(client, serial, orderId) {
  const marked = serial + DUP_MARK;
  const r = await client.query("SELECT id, serial, order_id FROM invoices WHERE serial = ANY($1::text[])", [[serial, marked]]);
  const by = new Map(r.rows.map((x) => [x.serial, x]));
  const same = (x) => x && String(x.order_id) === String(orderId);
  if (same(by.get(serial))) return { serial, existingId: by.get(serial).id };
  if (same(by.get(marked))) return { serial: marked, existingId: by.get(marked).id };
  if (!by.has(serial)) return { serial, existingId: null };
  if (!by.has(marked)) return { serial: marked, existingId: null };
  throw new Error(`명세서 번호 ${serial} · ${marked} 모두 다른 발주가 쓰고 있어 저장하지 않음`);
}

// 명세서 번호 "YYYY/MM/DD -N" 의 날짜 → 새 앱과 같은 잠금 키 · 모양이 다르면 잠그지 않는다
function serialLock(serial) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2}) -/.exec(String(serial));
  return m ? { sql: "SELECT pg_advisory_xact_lock(72112, $1)", params: [Number(m[1] + m[2] + m[3])] } : null;
}

// 옛 앱 명세서 1건 저장 · 옛 앱 발주(번호 그대로 또는 "(1버전)")에만 붙인다 → "inserted" | "updated" | "failed"
async function saveLegacyInvoice(pool, schema, inv) {
  const orderNum = inv.orderNum, serial = inv.serial;
  if (!orderNum || !serial) return "failed";
  return inTx(pool, schema, serialLock(serial), async (client) => {
    const o = await client.query(
      "SELECT id FROM orders WHERE order_no = ANY($1::text[]) AND is_legacy ORDER BY order_no LIMIT 1",
      [[orderNum, orderNum + DUP_MARK]],
    );
    const orderId = o.rows[0]?.id;
    if (!orderId) return "failed";
    const pick = await pickInvoiceSerial(client, serial, orderId);
    const v = [orderId, Math.round(Number(inv.totalSupply) || 0), Math.round(Number(inv.totalVat) || 0),
      Math.round(Number(inv.totalAmount) || 0), false, inv.cancelled === true, inv.cancelledAt || null,
      inv.createdAt || new Date().toISOString(), JSON.stringify(inv.items || [])];
    if (pick.existingId) {
      // 취소된 명세서는 되살리지 않는다 · 새 앱에서 취소한 것(발주 취소·출고확정 되돌림·발주 수정)이 옛 앱 원본(미취소)으로 덮이면
      // 활성 명세서가 둘이 되거나 취소한 금액이 정산에 다시 잡힌다. 옛 앱도 취소를 되돌리지 않는다(재발급은 새 번호).
      await client.query(
        `UPDATE invoices SET order_id=$1, supply_amount=$2, vat_amount=$3, total_amount=$4,
          sent=$5, cancelled = invoices.cancelled OR $6, cancelled_at = COALESCE(invoices.cancelled_at, $7),
          issued_at=$8, items_json=$9::jsonb WHERE id=$10`,
        [...v, pick.existingId],
      );
      return "updated";
    }
    await client.query(
      `INSERT INTO invoices (order_id, supply_amount, vat_amount, total_amount, sent, cancelled, cancelled_at, issued_at, items_json, serial)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [...v, pick.serial],
    );
    return "inserted";
  });
}

module.exports = { DUP_MARK, inTx, saveLegacyOrder, saveLegacyInvoice, pickOrderNo, pickInvoiceSerial };
