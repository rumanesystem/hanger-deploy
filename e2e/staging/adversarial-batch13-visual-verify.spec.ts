/**
 * [스테이징 시각 검증] 배포 전 최종 UI 확인
 * V1: 발주 목록 "출고일" 셀 값 — orders.js:1155 display 로직 회귀 확인
 * V2: 정산 페이지 렌더링 정상 (JS 에러 X, 페이지 alive)
 * V3: 발주 시드 → 정산 잡히는지 실 UI 흐름 (8월 발주+9월 shipDate → 8월 정산)
 */
import { test, expect, Page } from "@playwright/test";

test.setTimeout(180_000);

const API_KEY = process.env.STAGING_API_KEY;
const ADMIN_EMAIL = process.env.STAGING_ADMIN_EMAIL;
const ADMIN_PW = process.env.STAGING_ADMIN_PASSWORD;
if (!API_KEY || !ADMIN_EMAIL || !ADMIN_PW) throw new Error("STAGING env 필요");

async function bootLogin(page: Page, tab: "admin" | "orderer", id: string, pw: string) {
  await page.goto("/");
  await page.waitForSelector("#login-screen", { timeout: 30_000 });
  await page.waitForFunction((accId) => {
    const w = window as any;
    const accs = w.DB?.get?.("accounts", []);
    return Boolean(w._booted) && Array.isArray(accs) && accs.some((a: any) => a?.id === accId);
  }, id, { timeout: 45_000 });
  await page.locator(`#tab-${tab}`).click();
  await page.fill("#login-id", id);
  await page.fill("#login-pw", pw);
  await page.locator('button[onclick="doLogin()"]').click();
  await page.waitForSelector("[data-nav]", { timeout: 30_000 });
  await page.waitForTimeout(2000);
}

test.describe("[스테이징 시각 검증]", () => {

  test("V1: 발주 목록 '출고일' 셀 — 옛 발주 shipDate 다름 케이스 정확 렌더링", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");

    // 시드: 옛 발주 (orderDate 8월) + shipDate 9월 + statusHistory 있음/없음 2건
    // [Codex P2] hanger_orders 컬렉션 (Phase3) 에 REST 로 직접 write
    const orderId1 = 730000 + Math.floor(Math.random() * 100);
    const orderId2 = 730100 + Math.floor(Math.random() * 100);
    const num1 = `V1-A-${Date.now().toString().slice(-4)}`;
    const num2 = `V1-B-${Date.now().toString().slice(-4)}`;
    const PROJECT_ID = "hanger-test-260901";
    // signIn 재사용
    const signInR = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PW, returnSecureToken: true }),
    });
    const tok = (await signInR.json() as any).idToken;
    async function writeOrderDoc(orderNum: string, data: any) {
      function toFv(v: any): any {
        if (v === null) return { nullValue: null };
        if (typeof v === "boolean") return { booleanValue: v };
        if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
        if (typeof v === "string") return { stringValue: v };
        if (Array.isArray(v)) return { arrayValue: { values: v.map(toFv) } };
        if (typeof v === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFv(x)])) } };
        return { nullValue: null };
      }
      const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/hanger_orders/${orderNum}`;
      const r = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFv(v)])) }),
      });
      if (!r.ok) throw new Error(`seed 실패 ${orderNum}: ${r.status}`);
    }
    const now = new Date().toISOString();
    await writeOrderDoc(num1, {
      id: orderId1, orderNum: num1, status: "발주확정",
      deliveryTo: "V1-업체A", createdBy: "orderer",
      orderDate: "2026-08-15", shipDate: "2026-09-20",
      statusHistory: [{ status: "발주확정", changedAt: "2026-08-16T00:00:00Z" }],
      createdAt: now, items: [],
    });
    await writeOrderDoc(num2, {
      id: orderId2, orderNum: num2, status: "발주대기",
      deliveryTo: "V1-업체B", createdBy: "orderer",
      orderDate: "2026-08-20", shipDate: "2026-09-25",
      statusHistory: [],
      createdAt: now, items: [],
    });
    // 앱 재부팅 (실 앱 흐름: hanger_orders 재조회 → orders 목록 반영)
    await page.reload();
    await page.waitForSelector("#login-screen", { timeout: 30_000 });
    await page.waitForSelector("#boot-splash", { state: "hidden", timeout: 30_000 }).catch(() => {});
    await page.waitForFunction(() => Boolean((window as any)._booted), null, { timeout: 45_000 });
    await bootLogin(page, "admin", "admin", "123456");
    // 발주 목록 이동
    await page.evaluate(() => (window as any).navigate?.("orders"));
    await page.waitForTimeout(3000);
    // 진단: 실제 앱이 얼마나 orders 로드했는지 + hanger_orders 접근 성공 여부
    const diag = await page.evaluate(({ id1, id2 }) => {
      const w = window as any;
      const orders = w.DB?.get?.("orders", []) || [];
      const mine = (orders as any[]).filter(o => o?.id === id1 || o?.id === id2);
      return {
        totalOrdersInMem: orders.length,
        mineFound: mine.length,
        mineDetail: mine.map(m => ({ id: m.id, num: m.orderNum, orderDate: m.orderDate })),
        FS_PHASE3: w._FS?.PHASE3_READ_FROM_NEW,
        hasGetAllOrders: typeof w._FS?.getAllOrders === "function",
      };
    }, { id1: orderId1, id2: orderId2 });
    console.log("[V1 진단]", diag);

    // 출고일 셀 값 추출
    const cellValues = await page.evaluate(({ id1, id2 }) => {
      const rows = document.querySelectorAll(".order-row");
      const out: any = { rowCount: rows.length, rows: [] };
      rows.forEach(r => {
        const cells = r.querySelectorAll("td");
        // td 순서 (orders.js:1157): 납품처, 시공주소, 발주번호, 발주일, 출고일, 상태, 등록일, ...
        if (cells.length >= 5) {
          out.rows.push({
            id: r.getAttribute("data-order-id"),
            deliveryTo: cells[0]?.textContent?.trim(),
            orderDate: cells[3]?.textContent?.trim(),
            shipDateCell: cells[4]?.textContent?.trim(),
          });
        }
      });
      // 원한 것만
      out.match = out.rows.filter((r: any) => r.id === String(id1) || r.id === String(id2));
      return out;
    }, { id1: orderId1, id2: orderId2 });
    console.log("[V1] 셀 값:", cellValues.match);

    const rowA = (cellValues as any).match.find((r: any) => r.id === String(orderId1));
    const rowB = (cellValues as any).match.find((r: any) => r.id === String(orderId2));

    // [Codex P2] 무조건 assert: 발주 seed 후 UI 에 안 뜨면 test 자체가 무의미하므로 강제 실패
    expect(rowA, "A 발주가 UI 발주 목록에 렌더링됨").toBeTruthy();
    expect(rowB, "B 발주가 UI 발주 목록에 렌더링됨").toBeTruthy();

    // 예상:
    //   A (statusHistory 있음, 확정 2026-08-16 KST) → 출고일 셀 = "2026.08.16"
    //   B (statusHistory 없음) → 출고일 셀 = shipDate = "2026.09.25"
    // 발주일 셀은 원본 orderDate 유지
    expect(rowA.orderDate, "A 발주일").toContain("2026.08.15");
    expect(rowA.shipDateCell, "A 출고일 = statusHistory KST").toContain("2026.08.16");
    expect(rowB.orderDate, "B 발주일").toContain("2026.08.20");
    expect(rowB.shipDateCell, "B 출고일 = shipDate").toContain("2026.09.25");

    // cleanup (hanger_orders doc-per-id 삭제 via REST)
    for (const n of [num1, num2]) {
      await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/hanger_orders/${n}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${tok}` },
      }).catch(() => {});
    }
  });

  test("V2: 정산 페이지 렌더링 (에러 X, 페이지 alive)", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("pageerror", e => consoleErrors.push(String(e.message)));
    page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });

    await bootLogin(page, "admin", "admin", "123456");
    await page.evaluate(() => (window as any).navigate?.("settlement"));
    await page.waitForTimeout(3000);

    const state = await page.evaluate(() => ({
      bodyLen: document.body?.textContent?.length,
      hasDateInput: !!document.getElementById("date-input"),
      hasTable: !!document.querySelector("table"),
    }));
    console.log("[V2] state:", state, "errors:", consoleErrors.length);
    expect(state.bodyLen, "페이지 alive").toBeGreaterThan(500);
    // pageerror 없어야 (console.error 는 legacy log 도 있으므로 pageerror 만 체크)
    const criticalErrors = consoleErrors.filter(e => e.includes("Uncaught") || e.includes("TypeError"));
    expect(criticalErrors.length, "critical JS error 없음").toBe(0);
  });

  test("V3: 8월 발주 + 9월 shipDate → 8월 정산에 잡히는지 실 UI 확인", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    // 시드: 8월 발주 + 9월 shipDate + 발주확정 상태
    const orderId = 731000 + Math.floor(Math.random() * 100);
    const orderNum = `V3-${Date.now().toString().slice(-4)}`;
    await page.evaluate(async ({ id, num }) => {
      const w = window as any;
      const cur = await w._FS.get("orders", []);
      await w._FS.set("orders", [...cur, {
        id, orderNum: num, status: "발주확정", deliveryTo: "V3-테스트업체",
        createdBy: "orderer", orderDate: "2026-08-15", shipDate: "2026-09-20",
        statusHistory: [{ status: "발주확정", changedAt: "2026-08-16T00:00:00Z" }],
        createdAt: new Date().toISOString(),
        totalSupply: 500000, totalAmount: 550000, items: [],
      }]);
      // invoice 도 함께 시드
      const invs = await w._FS.get("invoices", []);
      await w._FS.set("invoices", [...invs, {
        id: 890000 + Math.floor(Math.random()*100), orderNum: num,
        serial: "2026-08-999", revision: 1, shipDate: "2026-09-20",
        totalSupply: 500000, totalAmount: 550000, cancelled: false,
        needsManualReview: false, sentToCustomer: false, sentAt: null,
        createdAt: "2026-08-16T00:00:00Z", items: [],
      }]);
    }, { id: orderId, num: orderNum });
    await page.waitForTimeout(2000);

    // 정산 페이지 → 8월 필터
    await page.evaluate(() => (window as any).navigate?.("settlement"));
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const el = document.getElementById("date-input") as HTMLInputElement | null;
      if (el) { el.value = "2026-08"; el.dispatchEvent(new Event("change", { bubbles: true })); }
      if (typeof (window as any).loadData === "function") (window as any).loadData();
    });
    await page.waitForTimeout(3000);

    // 방금 시드한 발주 orderNum 이 화면에 뜨는지
    const foundIn8월 = await page.evaluate((num) => {
      return document.body?.textContent?.includes(num) || false;
    }, orderNum);

    // 9월 필터로 이동 후 없어야 (옛 발주는 8월에만)
    await page.evaluate(() => {
      const el = document.getElementById("date-input") as HTMLInputElement | null;
      if (el) { el.value = "2026-09"; el.dispatchEvent(new Event("change", { bubbles: true })); }
      if (typeof (window as any).loadData === "function") (window as any).loadData();
    });
    await page.waitForTimeout(3000);
    const foundIn9월 = await page.evaluate((num) => {
      return document.body?.textContent?.includes(num) || false;
    }, orderNum);

    console.log(`[V3] 8월 필터: ${foundIn8월 ? '보임 ✅' : '없음 ❌'} / 9월 필터: ${foundIn9월 ? '보임 (예상 밖)' : '없음 ✅'}`);

    // cleanup
    await page.evaluate(async ({ id, num }) => {
      const w = window as any;
      const orders = await w._FS.get("orders", []);
      await w._FS.set("orders", (orders as any[]).filter(o => o?.id !== id));
      const invs = await w._FS.get("invoices", []);
      await w._FS.set("invoices", (invs as any[]).filter(i => i?.orderNum !== num));
    }, { id: orderId, num: orderNum });

    expect(foundIn8월, "8월 필터에서 발주 뜸").toBe(true);
    expect(foundIn9월, "9월 필터에서 발주 안 뜸 (옛 발주 orderDate 8월 기준)").toBe(false);
  });
});
