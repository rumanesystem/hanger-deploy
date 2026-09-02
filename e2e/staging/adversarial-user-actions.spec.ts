/**
 * [스테이징 적대적 시나리오] 실사용자가 실수로 할 수 있는 4가지 행동
 * S1: 저장 버튼 3번 rapid 클릭 → 중복 발주 X
 * S4: 저장 → 뒤로가기 → 재저장 → 중복 orderNum X
 * S5: 관리자 두 탭 동시 발주확정 → 중복 invoice X
 * S6: 두 탭 items 재고 편집 → lost update X
 */
import { test, expect, Page, BrowserContext } from "@playwright/test";

test.setTimeout(240_000);

const PROJECT_ID = "hanger-test-260901";
const API_KEY = process.env.STAGING_API_KEY;
const ADMIN_EMAIL = process.env.STAGING_ADMIN_EMAIL;
const ADMIN_PW = process.env.STAGING_ADMIN_PASSWORD;
if (!API_KEY || !ADMIN_EMAIL || !ADMIN_PW) throw new Error("STAGING env 3개 필요");

async function signIn(): Promise<string> {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

async function bootAndLogin(page: Page, tab: "admin" | "orderer", id: string, pw: string) {
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

async function fillNewOrder(page: Page) {
  const ordersNav = page.locator('[data-nav="orders"]').first();
  if ((await ordersNav.count()) > 0) await ordersNav.click().catch(() => {});
  await page.waitForSelector("#new-order-btn", { timeout: 15_000 });
  await page.locator("#new-order-btn").click();
  await page.waitForSelector("#order-modal", { state: "visible", timeout: 8_000 });

  const t = new Date();
  const y = String(t.getFullYear());
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const d = String(t.getDate()).padStart(2, "0");
  await page.fill("#o-date-y", y); await page.fill("#o-date-m", m); await page.fill("#o-date-d", d);
  await page.fill("#o-ship-y", y); await page.fill("#o-ship-m", m); await page.fill("#o-ship-d", d);
  await page.selectOption("#o-warehouse", "시흥");

  const upperColorEl = page.locator("#upper-common-color");
  const upperOpts = await upperColorEl.locator("option").allTextContents();
  const validUpper = upperOpts.find((tx) => tx && tx !== "" && tx !== "색상 선택") || upperOpts[1] || "";
  if (validUpper) await upperColorEl.selectOption({ label: validUpper });
  const sharedColorEl = page.locator("#shared-color-sel");
  const sharedOpts = await sharedColorEl.locator("option").allTextContents();
  const validShared = sharedOpts.find((tx) => tx && tx !== "" && tx !== "색상 선택") || sharedOpts[1] || "";
  if (validShared) await sharedColorEl.selectOption({ label: validShared });

  await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("#drawer-body .drawer-qty"));
    const input = inputs.find((el) => {
      const st = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return !el.disabled && st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0;
    });
    if (input) {
      input.focus();
      input.value = "1";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.blur();
    }
  });
}

test.describe("[스테이징 적대적] 실사용자 행동 검증", () => {
  test("S1: 저장 버튼 3번 rapid 클릭 → 중복 발주 X", async ({ page }) => {
    await resetOrders();
    await bootAndLogin(page, "orderer", "orderer", "123456");
    await fillNewOrder(page);

    // 저장 → confirm modal 뜨면 "확인" 버튼을 rapid 3연타 (실제 사용자 답답 시나리오)
    // 첫 클릭 후 modal 이 즉시 사라질 수 있음 → 모두 force+catch 로 관대하게
    await page.locator("#order-modal .order-modal-bottom .btn-primary").first().click();
    const confirmOk = page.locator("#order-confirm-ok-btn");
    await confirmOk.waitFor({ state: "visible", timeout: 8_000 });
    await Promise.all([
      confirmOk.click({ force: true, noWaitAfter: true }).catch(() => {}),
      confirmOk.click({ force: true, noWaitAfter: true }).catch(() => {}),
      confirmOk.click({ force: true, noWaitAfter: true }).catch(() => {}),
    ]);
    await page.waitForTimeout(8_000);
    await page.waitForSelector("#order-modal", { state: "hidden", timeout: 45_000 });

    const count = await page.evaluate(() => {
      const w = window as any;
      const orders = w.DB.get("orders", []);
      const cu = w.DB.get("session", null);
      return orders.filter((o: any) => o?.createdBy === cu?.id && o?.status === "발주대기").length;
    });
    console.log(`[S1] 발주 개수: ${count}`);
    expect(count, "3연타해도 발주 1개만 생성").toBe(1);
  });

  test("S4: 저장 → 뒤로가기 → 재저장 → 중복 X", async ({ page }) => {
    await resetOrders();
    await bootAndLogin(page, "orderer", "orderer", "123456");
    await fillNewOrder(page);

    // 첫 저장
    await page.locator("#order-modal .order-modal-bottom .btn-primary").first().click();
    const confirmOk1 = page.locator("#order-confirm-ok-btn");
    await confirmOk1.waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
    if (await confirmOk1.isVisible().catch(() => false)) await confirmOk1.click();
    await page.waitForTimeout(8_000);
    await page.waitForSelector("#order-modal", { state: "hidden", timeout: 45_000 });

    const firstCount = await page.evaluate(() => {
      const w = window as any;
      const cu = w.DB.get("session", null);
      return w.DB.get("orders", []).filter((o: any) => o?.createdBy === cu?.id).length;
    });
    console.log(`[S4] 첫 저장 후: ${firstCount}`);

    // 뒤로가기 (browser back)
    await page.goBack().catch(() => {});
    await page.waitForTimeout(2000);
    // 뒤로가기 후 페이지 상태 회복 시도 → 다시 저장 버튼 있으면 클릭
    const modalVisible = await page.locator("#order-modal").isVisible().catch(() => false);
    if (modalVisible) {
      await page.locator("#order-modal .order-modal-bottom .btn-primary").first().click();
      const confirmOk2 = page.locator("#order-confirm-ok-btn");
      await confirmOk2.waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
      if (await confirmOk2.isVisible().catch(() => false)) await confirmOk2.click();
      await page.waitForTimeout(8_000);
      await page.waitForSelector("#order-modal", { state: "hidden", timeout: 45_000 }).catch(() => {});
    }

    const finalCount = await page.evaluate(() => {
      const w = window as any;
      const cu = w.DB.get("session", null);
      return w.DB.get("orders", []).filter((o: any) => o?.createdBy === cu?.id).length;
    });
    console.log(`[S4] 뒤로가기 + 재저장 후: ${finalCount}`);
    // 브라우저 뒤로가기가 새 modal 열지 않으면 1, 열고 재저장하면 2
    // 어느 쪽이든 unique orderNum 유지되어야 함
    const orderNums = await page.evaluate(() => {
      const w = window as any;
      const cu = w.DB.get("session", null);
      return w.DB.get("orders", []).filter((o: any) => o?.createdBy === cu?.id).map((o: any) => o.orderNum);
    });
    const unique = new Set(orderNums);
    console.log(`[S4] orderNum:`, orderNums);
    expect(unique.size, "orderNum 중복 없음").toBe(orderNums.length);
  });

  test("S5: 관리자 두 탭 동시 발주확정 → invoice 1개만", async ({ page, context }) => {
    await resetOrders();

    // 1) 발주자로 발주 하나 만듦
    await bootAndLogin(page, "orderer", "orderer", "123456");
    await fillNewOrder(page);
    await page.locator("#order-modal .order-modal-bottom .btn-primary").first().click();
    const confirmOk = page.locator("#order-confirm-ok-btn");
    await confirmOk.waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
    if (await confirmOk.isVisible().catch(() => false)) await confirmOk.click();
    await page.waitForTimeout(8_000);
    await page.waitForSelector("#order-modal", { state: "hidden", timeout: 45_000 });

    const orderInfo = await page.evaluate(() => {
      const w = window as any;
      const cu = w.DB.get("session", null);
      const mine = w.DB.get("orders", []).filter((o: any) => o?.createdBy === cu?.id && o?.status === "발주대기");
      const latest = mine.sort((a: any, b: any) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0];
      return { id: latest?.id, orderNum: latest?.orderNum };
    });
    expect(orderInfo.id, "발주 생성됨").toBeTruthy();

    // 2) 탭 A: 관리자로 갈아탐 (boot-splash 사라질 때까지 대기)
    await page.evaluate(() => (window as any).doLogout?.());
    await page.waitForSelector("#login-screen.active", { timeout: 15_000 });
    await page.waitForSelector("#boot-splash", { state: "hidden", timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await bootAndLogin(page, "admin", "admin", "123456");

    // 3) 탭 B: 관리자 로그인 (같은 context, 다른 페이지)
    const pageB = await context.newPage();
    await bootAndLogin(pageB, "admin", "admin", "123456");

    // 4) 양쪽 동시 발주확정
    const results = await Promise.all([
      page.evaluate(async (id) => {
        try { const r = await (window as any).changeOrderStatus(id, "발주확정"); return { ok: r === true, r }; }
        catch (e: any) { return { ok: false, err: String(e?.message) }; }
      }, orderInfo.id),
      pageB.evaluate(async (id) => {
        try { const r = await (window as any).changeOrderStatus(id, "발주확정"); return { ok: r === true, r }; }
        catch (e: any) { return { ok: false, err: String(e?.message) }; }
      }, orderInfo.id),
    ]);
    console.log("[S5] 두 탭 결과:", results);

    await page.waitForTimeout(10_000); // 실 Firebase invoice auto-create 대기

    const invCount = await page.evaluate((num) => {
      const invs = (window as any).DB.get("invoices", []);
      return invs.filter((i: any) => i?.orderNum === num && !i?.cancelled).length;
    }, orderInfo.orderNum);
    console.log(`[S5] active invoice 개수: ${invCount}`);
    expect(invCount, "invoice 1개만 생성 (중복 X)").toBe(1);

    await pageB.close();
  });

  test("S6: 두 탭 items 재고 편집 → 서버 최종값 안정", async ({ page, context }) => {
    // Items 컬렉션에서 한 항목의 stock 을 탭 A/B 에서 동시 편집
    // A: stock=100 → B: stock=200 을 동시에 → 서버 최종값 100 or 200 (하나로 수렴)
    // lost update 없이 값이 이상해지지 않아야 함
    await bootAndLogin(page, "admin", "admin", "123456");
    const pageB = await context.newPage();
    await bootAndLogin(pageB, "admin", "admin", "123456");

    // 편집 대상 item 확보 (기존 items 첫번째)
    const targetInfo = await page.evaluate(() => {
      const items = (window as any).DB.get("items", []);
      const first = Array.isArray(items) ? items[0] : null;
      return first ? { id: first.id, originalStock: first.stock || 0 } : null;
    });
    if (!targetInfo) {
      console.log("[S6] items 없음 - skip");
      test.skip();
      return;
    }
    console.log(`[S6] 대상 item id=${targetInfo.id}, 원래 stock=${targetInfo.originalStock}`);

    // 두 탭 동시 stock 편집 (다른 값으로)
    const targetStockA = 12345;
    const targetStockB = 67890;
    const results = await Promise.all([
      page.evaluate(async ({ id, s }) => {
        try {
          const w = window as any;
          const cur = await w._FS.get("items", []);
          const next = (cur as any[]).map(it => it && it.id === id ? { ...it, stock: s } : it);
          await w._FS.set("items", next);
          return { ok: true };
        } catch (e: any) { return { ok: false, err: String(e?.message) }; }
      }, { id: targetInfo.id, s: targetStockA }),
      pageB.evaluate(async ({ id, s }) => {
        try {
          const w = window as any;
          const cur = await w._FS.get("items", []);
          const next = (cur as any[]).map(it => it && it.id === id ? { ...it, stock: s } : it);
          await w._FS.set("items", next);
          return { ok: true };
        } catch (e: any) { return { ok: false, err: String(e?.message) }; }
      }, { id: targetInfo.id, s: targetStockB }),
    ]);
    console.log("[S6] 결과:", results);

    await page.waitForTimeout(3_000);

    // 서버 최종값이 A or B 둘 중 하나여야 (섞이거나 손실 X)
    const finalStock = await page.evaluate(async (id) => {
      const items = await (window as any)._FS.get("items", []);
      const found = (items as any[]).find(it => it && it.id === id);
      return found?.stock;
    }, targetInfo.id);
    console.log(`[S6] 최종 stock: ${finalStock}`);
    expect([targetStockA, targetStockB]).toContain(finalStock);

    // 원상복구
    await page.evaluate(async ({ id, s }) => {
      const w = window as any;
      const cur = await w._FS.get("items", []);
      const next = (cur as any[]).map(it => it && it.id === id ? { ...it, stock: s } : it);
      await w._FS.set("items", next);
    }, { id: targetInfo.id, s: targetInfo.originalStock });

    await pageB.close();
  });
});
