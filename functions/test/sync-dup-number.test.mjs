// 옛 앱 → 새 앱 동기화 · 번호 겹침 처리 (sync-dup-number.js) 확인.
// 로컬 Docker Postgres 전용 · SUPABASE_DB_URL 이 localhost 일 때만 돈다 (운영·프리뷰 DB 에는 절대 안 붙음).
// DB 에 ordering 스키마로 발주앱 표가 있어야 한다 (시험용 복사본). 시험 데이터는 끝나면 지운다.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import pg from "pg";

const require = createRequire(import.meta.url);
const URL_ = process.env.SUPABASE_DB_URL ?? "";
const LOCAL = /@(localhost|127\.0\.0\.1):/.test(URL_);
const DAY = "29990101";               // 시험용 날짜 (실제 데이터와 안 겹치게)
const SDAY = "2999/01/01";
const M = " (1버전)";

describe.skipIf(!LOCAL)("옛 앱 동기화 · 새 앱과 번호가 겹칠 때", () => {
  let db, pool, dup, adminId;
  const legacyRow = (no, status = "신규발주") => ({
    order_no: no, delivery_to: "옛앱 거래처", address: "옛앱 주소", warehouse: "시흥", status,
    requested_date: "2999-01-01", ship_date: null, memo: "", created_at: new Date().toISOString(),
    legacy_items: { items: [], firestoreDocId: no },
  });
  const save = (row) => dup.saveLegacyOrder(pool, "ordering", row, adminId, "test@sync");
  const order = async (no) => (await db.query(
    "SELECT id, order_no, is_legacy, status, delivery_to, legacy_items IS NULL AS items_null FROM orders WHERE order_no=$1", [no])).rows[0];
  const newAppOrder = async (no) => (await db.query(
    `INSERT INTO orders (order_no, delivery_to, address, warehouse, status, requested_date, created_by)
     VALUES ($1, '새앱 거래처', '새앱 주소', '시흥', '신규발주', '2999-01-01', $2) RETURNING id`, [no, adminId])).rows[0].id;
  const cleanup = async () => {
    await db.query(`DELETE FROM invoices WHERE serial LIKE '${SDAY} -%'`);
    await db.query(`DELETE FROM orders WHERE order_no LIKE '${DAY}-%'`);
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: URL_ });
    await db.connect();
    await db.query("SET search_path TO ordering");
    pool = new pg.Pool({ connectionString: URL_, max: 4 });
    dup = require("../lib/sync-dup-number");
    adminId = (await db.query("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1")).rows[0].id;
    await cleanup();
  });
  afterAll(async () => { await cleanup(); await pool.end(); await db.end(); });

  it("새 앱이 이미 쓴 번호 → 옛 앱 발주는 '(1버전)' 으로 저장 · 새 앱 발주는 그대로", async () => {
    await newAppOrder(`${DAY}-001`);
    const r = await save(legacyRow(`${DAY}-001`));
    expect(r.orderNo).toBe(`${DAY}-001${M}`);
    expect(await order(`${DAY}-001`)).toMatchObject({ is_legacy: false, status: "신규발주", delivery_to: "새앱 거래처", items_null: true });
    expect(await order(`${DAY}-001${M}`)).toMatchObject({ is_legacy: true, delivery_to: "옛앱 거래처" });
  });

  it("옛 앱에서 그 발주를 다시 고쳐도 '(1버전)' 발주만 갱신 · 세 번째 줄이 생기지 않음", async () => {
    const r = await save(legacyRow(`${DAY}-001`, "출고확정"));
    expect(r.orderNo).toBe(`${DAY}-001${M}`);
    expect((await order(`${DAY}-001${M}`)).status).toBe("출고확정");
    expect((await order(`${DAY}-001`)).status).toBe("신규발주");
    expect((await db.query(`SELECT count(*)::int n FROM orders WHERE order_no LIKE '${DAY}-001%'`)).rows[0].n).toBe(2);
  });

  it("겹치지 않으면 번호 그대로 · 다시 오면 같은 줄 갱신", async () => {
    const a = await save(legacyRow(`${DAY}-002`));
    expect(a.orderNo).toBe(`${DAY}-002`);
    const b = await save(legacyRow(`${DAY}-002`, "취소"));
    expect(b.id).toBe(a.id);
    expect((await order(`${DAY}-002`)).status).toBe("취소");
  });

  it("같은 옛 앱 발주가 동시에 두 번 와도 한 줄만", async () => {
    const [a, b] = await Promise.all([save(legacyRow(`${DAY}-003`)), save(legacyRow(`${DAY}-003`))]);
    expect(a.id).toBe(b.id);
    expect((await db.query(`SELECT count(*)::int n FROM orders WHERE order_no LIKE '${DAY}-003%'`)).rows[0].n).toBe(1);
  });

  it("명세서 번호가 새 앱 명세서와 겹침 → '(1버전)' 으로 따로 저장 · 새 앱 명세서는 그대로", async () => {
    const newId = await newAppOrder(`${DAY}-010`);
    await db.query(
      `INSERT INTO invoices (order_id, serial, supply_amount, vat_amount, total_amount, items_json) VALUES ($1, $2, 100, 10, 110, '[]')`,
      [newId, `${SDAY} -1`]);
    await save(legacyRow(`${DAY}-002`));   // 옛 앱 발주 (위에서 만든 것)
    const inv = { orderNum: `${DAY}-002`, serial: `${SDAY} -1`, totalSupply: 5000, totalVat: 500, totalAmount: 5500, items: [] };
    expect(await dup.saveLegacyInvoice(pool, "ordering", inv)).toBe("inserted");
    const rows = (await db.query(`SELECT serial, order_id, total_amount FROM invoices WHERE serial LIKE '${SDAY} -1%' ORDER BY serial`)).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ serial: `${SDAY} -1`, total_amount: 110 });
    expect(String(rows[0].order_id)).toBe(String(newId));
    expect(rows[1]).toMatchObject({ serial: `${SDAY} -1${M}`, total_amount: 5500 });
    // 다시 와도 '(1버전)' 명세서만 갱신
    expect(await dup.saveLegacyInvoice(pool, "ordering", { ...inv, totalAmount: 6600 })).toBe("updated");
    const again = (await db.query(`SELECT serial, total_amount FROM invoices WHERE serial LIKE '${SDAY} -1%' ORDER BY serial`)).rows;
    expect(again).toEqual([{ serial: `${SDAY} -1`, total_amount: 110 }, { serial: `${SDAY} -1${M}`, total_amount: 6600 }]);
  });

  it("실제 동기화 진입점(syncOrderCreated)으로 와도 '(1버전)' 으로 저장되고 새 앱 발주는 그대로", async () => {
    await newAppOrder(`${DAY}-020`);
    const sync = require("../lib/supabase-sync");
    await sync.syncOrderCreated.run({
      params: { docId: `${DAY}-020` },
      data: { data: () => ({ orderNum: `${DAY}-020`, status: "발주대기", warehouse: "시흥", deliveryTo: "옛앱 거래처", orderDate: "2999-01-01", items: [] }) },
    });
    expect(await order(`${DAY}-020`)).toMatchObject({ is_legacy: false, delivery_to: "새앱 거래처", items_null: true });
    expect(await order(`${DAY}-020${M}`)).toMatchObject({ is_legacy: true, status: "신규발주", delivery_to: "옛앱 거래처" });
  });

  it("새 앱에서 취소한 명세서는 옛 앱이 다시 보내도 되살아나지 않는다", async () => {
    await save(legacyRow(`${DAY}-030`));
    await save(legacyRow(`${DAY}-031`));
    const inv = { orderNum: `${DAY}-030`, serial: `${SDAY} -8`, totalAmount: 100, cancelled: false };
    expect(await dup.saveLegacyInvoice(pool, "ordering", inv)).toBe("inserted");
    await db.query("UPDATE invoices SET cancelled=TRUE WHERE serial=$1", [`${SDAY} -8`]);   // 새 앱 발주 취소와 같은 동작
    expect(await dup.saveLegacyInvoice(pool, "ordering", { ...inv, totalAmount: 200 })).toBe("updated");
    expect((await db.query("SELECT cancelled, total_amount FROM invoices WHERE serial=$1", [`${SDAY} -8`])).rows[0])
      .toEqual({ cancelled: true, total_amount: 200 });
    // 옛 앱에서 취소해 오면 취소된다
    expect(await dup.saveLegacyInvoice(pool, "ordering", { orderNum: `${DAY}-031`, serial: `${SDAY} -9`, totalAmount: 1 })).toBe("inserted");
    expect(await dup.saveLegacyInvoice(pool, "ordering", { orderNum: `${DAY}-031`, serial: `${SDAY} -9`, totalAmount: 1, cancelled: true, cancelledAt: "2999-01-02T00:00:00Z" })).toBe("updated");
    expect((await db.query("SELECT cancelled FROM invoices WHERE serial=$1", [`${SDAY} -9`])).rows[0].cancelled).toBe(true);
  });

  it("같은 입금 신호가 동시에 두 번 와도 입금은 한 줄", async () => {
    const sync = require("../lib/supabase-sync");
    const docId = `${DAY}-pay-${Date.now()}`;
    const ev = { params: { docId }, data: { data: () => ({ date: "2999-01-01", amount: 1234, customer: "시험 거래처 없음", memo: "동시" }) } };
    await Promise.all([sync.syncPaymentCreated.run(ev), sync.syncPaymentCreated.run(ev), sync.syncPaymentCreated.run(ev)]);
    const n = (await db.query("SELECT count(*)::int n FROM payments WHERE memo LIKE $1", [`%[fs:${docId}]%`])).rows[0].n;
    await db.query("DELETE FROM payments WHERE memo LIKE $1", [`%[fs:${docId}]%`]);
    expect(n).toBe(1);
  });

  it("옛 앱 명세서는 옛 앱 발주에만 붙는다 · '(1버전)' 발주도 찾아감 · 새 앱 발주에는 안 붙음", async () => {
    // 번호 001 은 새 앱 발주 · 옛 앱 001 은 '(1버전)' → 옛 앱 명세서는 '(1버전)' 발주에 붙어야 한다
    expect(await dup.saveLegacyInvoice(pool, "ordering", { orderNum: `${DAY}-001`, serial: `${SDAY} -5`, totalAmount: 1 })).toBe("inserted");
    const r = (await db.query(`SELECT o.order_no FROM invoices i JOIN orders o ON o.id=i.order_id WHERE i.serial=$1`, [`${SDAY} -5`])).rows[0];
    expect(r.order_no).toBe(`${DAY}-001${M}`);
    // 새 앱 발주(010)뿐인 번호 → 붙이지 않음
    expect(await dup.saveLegacyInvoice(pool, "ordering", { orderNum: `${DAY}-010`, serial: `${SDAY} -6`, totalAmount: 1 })).toBe("failed");
    expect((await db.query("SELECT count(*)::int n FROM invoices WHERE serial=$1", [`${SDAY} -6`])).rows[0].n).toBe(0);
  });
});
