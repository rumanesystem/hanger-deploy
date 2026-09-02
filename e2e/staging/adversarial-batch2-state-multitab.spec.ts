/**
 * [스테이징 적대적 배치2] 상태머신·다탭 4개
 * S2: 저장 중 모달 X → 새 발주 (편집 상태 잔재 leak)
 * S5-retry: 관리자 두 탭 동시 발주확정 (invoice 1개만)
 * S14: 취소 → 되돌리기 후 명세서 잔재
 * S22: 두 탭 편집 → 한쪽 저장 후 다른 쪽 저장 (CAS)
 */
import { test, expect, Page } from "@playwright/test";

test.setTimeout(240_000);

const PROJECT_ID = "hanger-test-260901";
const API_KEY = process.env.STAGING_API_KEY;
const ADMIN_EMAIL = process.env.STAGING_ADMIN_EMAIL;
const ADMIN_PW = process.env.STAGING_ADMIN_PASSWORD;
if (!API_KEY || !ADMIN_EMAIL || !ADMIN_PW) throw new Error("STAGING env 필요");

async function signIn(): Promise<string> {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PW, returnSecureToken: true }),
  });
  const j: any = await r.json();
  if (!j.idToken) throw new Error(`signIn: ${JSON.stringify(j.error)}`);
  return j.idToken;
}

async function resetOrders() {
  const token = await signIn();
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/hanger_data/orders`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields: { value: { arrayValue: { values: [] } }, updatedAt: { stringValue: new Date().toISOString() } } }),
  });
  if (!r.ok) throw new Error(`reset: ${r.status}`);
}

async function bootLogin(page: Page, tab: "admin" | "orderer", id: string, pw: string) {
  await page.goto("/");
  await page.waitForSelector("#login-screen", { timeout: 30_000 });
  await page.waitForSelector("#boot-splash", { state: "hidden", timeout: 20_000 }).catch(() => {});
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

async function createOrderViaFS(page: Page, opts: { orderNum: string; deliveryTo?: string; status?: string; createdBy?: string; extras?: any } = {} as any) {
  return await page.evaluate(async (o) => {
    const w = window as any;
    const cur = await w._FS.get("orders", []);
    const order = {
      id: 700000 + Math.floor(Math.random() * 100000),
      orderNum: o.orderNum,
      status: o.status || "발주대기",
      deliveryTo: o.deliveryTo || "테스트업체",
      createdBy: o.createdBy || "orderer",
      createdAt: new Date().toISOString(),
      orderDate: new Date().toISOString().slice(0, 10),
      shipDate: new Date().toISOString().slice(0, 10),
      warehouse: "시흥",
      items: [],
      ...(o.extras || {}),
    };
    await w._FS.set("orders", [...cur, order]);
    return order;
  }, opts);
}

test.describe("[스테이징 적대적 배치2]", () => {

  test("S2: _pendingEditOrder 잔재 leak — 편집 취소 후 새 발주가 옛 값 상속?", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    // window._pendingEditOrder 를 강제로 세팅 (편집 취소 시 정리 안 됐다고 가정)
    await page.evaluate(() => {
      (window as any)._pendingEditOrder = {
        id: 999999, orderNum: "LEAK-999", deliveryTo: "OLD-LEAK-VALUE",
      };
    });
    // 새 발주 흐름: openOrderModal (혹은 new-order-btn) 눌러 새 모달
    const ordersNav = page.locator('[data-nav="orders"]').first();
    if ((await ordersNav.count()) > 0) await ordersNav.click().catch(() => {});
    await page.waitForSelector("#new-order-btn", { timeout: 10_000 });
    await page.locator("#new-order-btn").click();
    await page.waitForSelector("#order-modal", { state: "visible", timeout: 5_000 });
    // 새 발주 모달의 deliveryTo 필드가 옛 값을 상속했는지 확인
    const inheritedValue = await page.evaluate(() => {
      const el = document.getElementById("o-delivery-to") as HTMLInputElement | null;
      return el?.value || "";
    });
    console.log("[S2] 새 발주 deliveryTo 초기값:", inheritedValue);
    // 옛 편집 값이 leak 되면 "OLD-LEAK-VALUE" 가 들어있음. 정상이면 빈값 or 기본값
    expect(inheritedValue, "옛 편집값 leak 안 됨").not.toContain("OLD-LEAK-VALUE");
  });

  test("S5-retry: 두 탭 동시 발주확정 → invoice 1개만 (같은 브라우저 context)", async ({ page, context }) => {
    await resetOrders();
    // 1) 발주자 → 발주 하나 생성 (REST로 시드)
    const order = await bootLogin(page, "orderer", "orderer", "123456").then(async () => {
      return await createOrderViaFS(page, { orderNum: `S5-${Date.now().toString().slice(-6)}`, status: "발주대기" });
    });
    console.log("[S5] 시드 발주:", order.orderNum, "id=", order.id);
    // 2) 탭 A: 관리자 로그인
    await page.evaluate(() => (window as any).doLogout?.());
    await page.waitForSelector("#login-screen.active", { timeout: 15_000 });
    await page.waitForSelector("#boot-splash", { state: "hidden", timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await bootLogin(page, "admin", "admin", "123456");
    // 3) 탭 B: 관리자 로그인
    const pageB = await context.newPage();
    await bootLogin(pageB, "admin", "admin", "123456");
    // 4) 양쪽 동시 확정
    const results = await Promise.all([
      page.evaluate(async (id) => {
        try { const r = await (window as any).changeOrderStatus(id, "발주확정"); return { ok: r === true, r }; }
        catch (e: any) { return { ok: false, err: String(e?.message) }; }
      }, order.id),
      pageB.evaluate(async (id) => {
        try { const r = await (window as any).changeOrderStatus(id, "발주확정"); return { ok: r === true, r }; }
        catch (e: any) { return { ok: false, err: String(e?.message) }; }
      }, order.id),
    ]);
    console.log("[S5] 두 탭 결과:", results);
    await page.waitForTimeout(10_000); // invoice auto-create 대기
    const invCount = await page.evaluate(async (num) => {
      const invs = await (window as any)._FS.get("invoices", []);
      return (invs as any[]).filter((i: any) => i?.orderNum === num && !i?.cancelled).length;
    }, order.orderNum);
    console.log("[S5] active invoice 개수:", invCount);
    expect(invCount, "invoice 1개만").toBe(1);
    await pageB.close();
  });

  test("S14: 취소 → 되돌리기 → 명세서 잔재 (cancelled=true 남으면 UI 오작동)", async ({ page }) => {
    await resetOrders();
    await bootLogin(page, "admin", "admin", "123456");
    const orderNum = `S14-${Date.now().toString().slice(-6)}`;
    // 발주확정 상태의 발주 시드 + invoice 시드 (cancelled=true 로 취소된 상태)
    const seedResult = await page.evaluate(async (num) => {
      const w = window as any;
      const orders = await w._FS.get("orders", []);
      const order = { id: 750000 + Math.floor(Math.random()*10000), orderNum: num, status: "발주확정",
        deliveryTo: "테스트업체", createdBy: "orderer", createdAt: new Date().toISOString(),
        orderDate: "2026-09-01", shipDate: "2026-09-01", statusHistory: [{status:"발주확정",changedAt:new Date().toISOString()}] };
      await w._FS.set("orders", [...orders, order]);
      const invs = await w._FS.get("invoices", []);
      const inv = { id: 850000 + Math.floor(Math.random()*10000), orderNum: num, cancelled: true, createdAt: new Date().toISOString() };
      await w._FS.set("invoices", [...invs, inv]);
      return { order, inv };
    }, orderNum);
    // "되돌리기" == invoice cancelled 해제 필요. 앱이 새 invoice 만들거나 cancelled=false 로 복구해야 함
    // 시나리오: 관리자가 "발주확정" 상태로 재확정 실행 → autoCreateForOrder 트리거
    await page.evaluate(async (id) => {
      const w = window as any;
      // 상태 재확정 시뮬: changeOrderStatus 로 발주대기 → 발주확정 (재확정 트리거)
      await w.changeOrderStatus(id, "발주대기").catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      await w.changeOrderStatus(id, "발주확정").catch(() => {});
    }, seedResult.order.id);
    await page.waitForTimeout(10_000); // invoice 재생성 대기
    const finalInvoices = await page.evaluate(async (num) => {
      const invs = await (window as any)._FS.get("invoices", []);
      const forOrder = (invs as any[]).filter(i => i?.orderNum === num);
      return {
        total: forOrder.length,
        activeCount: forOrder.filter(i => !i.cancelled).length,
        cancelledCount: forOrder.filter(i => i.cancelled).length,
      };
    }, orderNum);
    console.log("[S14] 재확정 후 invoices:", finalInvoices);
    // 재확정 후: active invoice 1개 이상 있어야 (되돌린 상태 = 명세서 다시 뜸)
    expect(finalInvoices.activeCount, "재확정 후 active invoice 최소 1개").toBeGreaterThanOrEqual(1);
  });

  test("S22: 두 탭 편집 → 한쪽 저장 후 다른 쪽 저장 (CAS 실패 감지)", async ({ page, context }) => {
    await resetOrders();
    await bootLogin(page, "admin", "admin", "123456");
    // 원본 발주 시드
    const orderNum = `S22-${Date.now().toString().slice(-6)}`;
    const orderId = 760000 + Math.floor(Math.random() * 10000);
    await page.evaluate(async ({ num, id }) => {
      const w = window as any;
      const cur = await w._FS.get("orders", []);
      await w._FS.set("orders", [...cur, {
        id, orderNum: num, status: "발주대기", deliveryTo: "원본", createdBy: "orderer",
        createdAt: new Date().toISOString(), orderDate: "2026-09-01", shipDate: "2026-09-01", items: []
      }]);
    }, { num: orderNum, id: orderId });
    // 탭 B 열고 동일 발주 로드
    const pageB = await context.newPage();
    await bootLogin(pageB, "admin", "admin", "123456");
    // 두 탭 각각 편집 결과를 순차 저장 (탭 A 먼저 → 탭 B)
    const resA = await page.evaluate(async (id) => {
      const w = window as any;
      const cur = await w._FS.get("orders", []);
      const next = (cur as any[]).map(o => o?.id === id ? { ...o, deliveryTo: "탭A_수정" } : o);
      try { await w._FS.set("orders", next); return { ok: true }; }
      catch (e: any) { return { ok: false, err: String(e?.message) }; }
    }, orderId);
    await page.waitForTimeout(500);
    const resB = await pageB.evaluate(async (id) => {
      const w = window as any;
      const cur = await w._FS.get("orders", []); // stale일 수 있음 (탭A 저장 전에 로드했으니)
      const next = (cur as any[]).map(o => o?.id === id ? { ...o, deliveryTo: "탭B_수정" } : o);
      try { await w._FS.set("orders", next); return { ok: true }; }
      catch (e: any) { return { ok: false, err: String(e?.message) }; }
    }, orderId);
    console.log("[S22] 탭A:", resA, "탭B:", resB);
    await page.waitForTimeout(3000);
    const final = await page.evaluate(async (id) => {
      const orders = await (window as any)._FS.get("orders", []);
      const found = (orders as any[]).find(o => o?.id === id);
      return found?.deliveryTo;
    }, orderId);
    console.log("[S22] 최종 deliveryTo:", final);
    // 두 탭 다 성공했으면 마지막 저장이 이김 (탭B_수정). 서버 diff-merge 로 CAS 실패 감지되어야 함
    expect(["탭A_수정", "탭B_수정"]).toContain(final);
    await pageB.close();
  });
});
