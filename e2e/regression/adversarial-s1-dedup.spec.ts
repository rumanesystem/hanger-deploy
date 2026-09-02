/**
 * [로컬 emu 회귀] S1: 확인 버튼 rapid 3연타 → 발주 1개만
 * 배경: 스테이징 adversarial test 에서 7개 중복 생성 발견 → orders.js:736 dedup 추가
 */
import { test, expect } from "@playwright/test";
import { resetAndSeed } from "../helpers/emu-reset";

test.setTimeout(120_000);

test("S1: 확인 버튼 rapid 3연타 해도 발주 1개만 생성", async ({ page }) => {
  await resetAndSeed();
  await page.goto("/");
  await page.waitForSelector("#login-screen", { timeout: 20_000 });
  await page.waitForFunction(() => {
    const w = window as any;
    const accs = w.DB?.get?.("accounts", []);
    return Boolean(w._booted) && Array.isArray(accs) && accs.some((a: any) => a?.id === "orderer");
  }, null, { timeout: 30_000 });
  await page.locator("#tab-orderer").click();
  await page.fill("#login-id", "orderer");
  await page.fill("#login-pw", "123456");
  await page.locator('button[onclick="doLogin()"]').click();
  await page.waitForSelector("[data-nav]", { timeout: 20_000 });
  await page.waitForTimeout(1500);

  const ordersNav = page.locator('[data-nav="orders"]').first();
  if ((await ordersNav.count()) > 0) await ordersNav.click().catch(() => {});
  await page.waitForSelector("#new-order-btn", { timeout: 10_000 });
  await page.locator("#new-order-btn").click();
  await page.waitForSelector("#order-modal", { state: "visible", timeout: 5_000 });

  const t = new Date();
  const y = String(t.getFullYear());
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const d = String(t.getDate()).padStart(2, "0");
  await page.fill("#o-date-y", y); await page.fill("#o-date-m", m); await page.fill("#o-date-d", d);
  await page.fill("#o-ship-y", y); await page.fill("#o-ship-m", m); await page.fill("#o-ship-d", d);
  await page.selectOption("#o-warehouse", "시흥");

  const upperColorEl = page.locator("#upper-common-color");
  const upperOpts = await upperColorEl.locator("option").allTextContents();
  const validUpper = upperOpts.find(tx => tx && tx !== "" && tx !== "색상 선택") || upperOpts[1] || "";
  if (validUpper) await upperColorEl.selectOption({ label: validUpper });
  const sharedColorEl = page.locator("#shared-color-sel");
  const sharedOpts = await sharedColorEl.locator("option").allTextContents();
  const validShared = sharedOpts.find(tx => tx && tx !== "" && tx !== "색상 선택") || sharedOpts[1] || "";
  if (validShared) await sharedColorEl.selectOption({ label: validShared });

  await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("#drawer-body .drawer-qty"));
    const input = inputs.find(el => {
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

  // 저장 → confirm modal → 확인 rapid 3연타
  await page.locator("#order-modal .order-modal-bottom .btn-primary").first().click();
  const confirmOk = page.locator("#order-confirm-ok-btn");
  await confirmOk.waitFor({ state: "visible", timeout: 5_000 });
  await Promise.all([
    confirmOk.click({ force: true, noWaitAfter: true }).catch(() => {}),
    confirmOk.click({ force: true, noWaitAfter: true }).catch(() => {}),
    confirmOk.click({ force: true, noWaitAfter: true }).catch(() => {}),
  ]);
  await page.waitForSelector("#order-modal", { state: "hidden", timeout: 20_000 });
  await page.waitForTimeout(1500);

  const count = await page.evaluate(() => {
    const w = window as any;
    const orders = w.DB.get("orders", []);
    const cu = w.DB.get("session", null);
    return orders.filter((o: any) => o?.createdBy === cu?.id && o?.status === "발주대기").length;
  });
  console.log(`[S1 local] 발주 개수: ${count}`);
  expect(count, "3연타해도 발주 1개만 생성").toBe(1);
});
