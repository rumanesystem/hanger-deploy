// 입금 동기화(syncPaymentCreated) → payments.account_id 연결 확인.
// 로컬 Docker Postgres 전용 · SUPABASE_DB_URL 이 localhost 일 때만 돈다 (운영·프리뷰 DB 에는 절대 안 붙음).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import pg from "pg";

const require = createRequire(import.meta.url);
const URL_ = process.env.SUPABASE_DB_URL ?? "";
const LOCAL = /@(localhost|127\.0\.0\.1):/.test(URL_);
const TAG = `e2e_pay_${Date.now()}`;

describe.skipIf(!LOCAL)("입금 동기화 · 거래처 계정 연결", () => {
  let db, sync;
  const ids = {};
  const addUser = async (key, name, active) => {
    const r = await db.query(
      "INSERT INTO users (login_id, name, password_hash, role, active, delivery_name) VALUES ($1,$2,'x','orderer',$3,'') RETURNING id",
      [`${TAG}_${key}`, name, active],
    );
    ids[key] = r.rows[0].id;
  };
  const run = (docId, customer) => sync.syncPaymentCreated.run({
    params: { docId: `${TAG}-${docId}` },
    data: { data: () => ({ date: "2026-09-30", amount: 1000, customer, memo: "시험" }) },
  });
  const accountOf = async (docId) => {
    const r = await db.query("SELECT account_id FROM payments WHERE memo LIKE $1", [`%[fs:${TAG}-${docId}]%`]);
    return r.rows;
  };
  const cleanup = async () => {
    await db.query("DELETE FROM payments WHERE memo LIKE $1", [`%[fs:${TAG}-%`]);
    await db.query("DELETE FROM users WHERE login_id LIKE $1", [`${TAG}_%`]);
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: URL_ });
    await db.connect();
    sync = require("../lib/supabase-sync");
    await addUser("one", `${TAG}가`, true);
    await addUser("dupA", `${TAG}나`, true);
    await addUser("dupB", `${TAG}나`, true);
    await addUser("live", `${TAG}다`, true);
    await addUser("off", `${TAG}다`, false);
  });
  afterAll(async () => { await cleanup(); await db.end(); });

  it("이름이 같은 사용 중 계정이 하나면 그 계정에 연결", async () => {
    await run("one", `${TAG}가`);
    expect(await accountOf("one")).toEqual([{ account_id: ids.one }]);
  });
  it("같은 이름 사용 중 계정이 둘이면 비워 둔다", async () => {
    await run("dup", `${TAG}나`);
    expect(await accountOf("dup")).toEqual([{ account_id: null }]);
  });
  it("꺼진 계정은 빼고 판단 · 사용 중 하나에 연결", async () => {
    await run("live", `${TAG}다`);
    expect(await accountOf("live")).toEqual([{ account_id: ids.live }]);
  });
  it("맞는 계정이 없으면 비워 두고 저장은 한다", async () => {
    await run("none", `${TAG}없음`);
    expect(await accountOf("none")).toEqual([{ account_id: null }]);
  });
  it("같은 입금이 두 번 와도 한 건만", async () => {
    await run("one", `${TAG}가`);
    expect(await accountOf("one")).toHaveLength(1);
  });
});
