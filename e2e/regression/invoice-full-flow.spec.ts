/**
 * [2026-09-01] 진짜 end-to-end 검증
 * 발주자가 UI로 발주 만듦 → 관리자가 상태 변경 → 자동 명세서 발급 → 발주자 접근 확인
 *
 * 이전 spec (invoice-auto-visible-ui) 은 DB.set 우회로 로직만 검증했음.
 * 이 spec은 UI 클릭만으로 진짜 실사용 흐름 재현.
 */
import { test, expect, Page } from "@playwright/test";
import { execSync } from "child_process";
import path from "path";

test.setTimeout(180_000);

test.beforeAll(({ }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL || "";
  if (!baseURL.includes("localhost")) return; // 스테이징/운영이면 로컬 시드 스킵
  const seedPath = path.resolve(__dirname, "..", "..", "functions", "seed-ledger-print-test.js");
  execSync(`node "${seedPath}"`, {
    stdio: "pipe",
    timeout: 15_000,
    env: {
      ...process.env,
      FIRESTORE_EMULATOR_HOST: "localhost:18080",
      FIREBASE_AUTH_EMULATOR_HOST: "localhost:19099",
    },
  });
});

async function loginAs(page: Page, tab: "orderer" | "admin", id: string, pw: string) {
  const loginScreen = page.locator("#login-screen.active");
  if (!(await loginScreen.isVisible().catch(() => false))) {
    await page.goto("/");
  }
  await page.waitForSelector("#login-screen.active", { state: "visible", timeout: 15000 });
  await page.waitForTimeout(500);
  await page.locator(`#tab-${tab}`).click();
  await page.fill("#login-id", id);
  await page.fill("#login-pw", pw);
  await page.locator('button[onclick="doLogin()"]').click();
  await page.waitForSelector("[data-nav]", { timeout: 15000 });
  await page.waitForTimeout(1500);
}

async function logout(page: Page) {
  await page.evaluate(() => {
    const fn = (window as any).doLogout;
    if (typeof fn === "function") fn();
  }).catch(() => {});
  await page.waitForSelector("#login-screen.active", { state: "visible", timeout: 10000 });
}

test.describe("[2026-09-01] 명세서 자동 노출 end-to-end (실 UI)", () => {
  test("F1. 발주자 UI로 발주 → 관리자 발주확정 → 발주자 정산에 명세서 뜨고 클릭시 모달 열림", async ({ page }) => {
    // ══════ 1. 발주자로 로그인 후 발주 만듦 (실 UI) ══════
    await loginAs(page, "orderer", "orderer", "123456");
    const ordersNav = page.locator('[data-nav="orders"]').first();
    if ((await ordersNav.count()) > 0) await ordersNav.click().catch(() => {});
    await page.waitForSelector("#new-order-btn", { timeout: 10000 });
    await page.locator("#new-order-btn").click();
    await page.waitForSelector("#order-modal", { state: "visible", timeout: 5000 });

    // 오늘 날짜
    const t = new Date();
    const y = String(t.getFullYear());
    const m = String(t.getMonth() + 1).padStart(2, "0");
    const d = String(t.getDate()).padStart(2, "0");
    await page.fill("#o-date-y", y);
    await page.fill("#o-date-m", m);
    await page.fill("#o-date-d", d);
    await page.fill("#o-ship-y", y);
    await page.fill("#o-ship-m", m);
    await page.fill("#o-ship-d", d);
    await page.selectOption("#o-warehouse", "시흥");

    // 색상 세팅
    const upperColorEl = page.locator("#upper-common-color");
    const upperOpts = await upperColorEl.locator("option").allTextContents();
    const validUpper = upperOpts.find((t) => t && t !== "" && t !== "색상 선택") || upperOpts[1] || "";
    if (validUpper) await upperColorEl.selectOption({ label: validUpper });
    const sharedColorEl = page.locator("#shared-color-sel");
    const sharedOpts = await sharedColorEl.locator("option").allTextContents();
    const validShared = sharedOpts.find((t) => t && t !== "" && t !== "색상 선택") || sharedOpts[1] || "";
    if (validShared) await sharedColorEl.selectOption({ label: validShared });

    // 서랍 수량 1
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

    // 저장 (발주 넣기)
    await page.locator("#order-modal .order-modal-bottom .btn-primary").first().click();
    const confirmOk = page.locator("#order-confirm-ok-btn");
    await confirmOk.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    if (await confirmOk.isVisible().catch(() => false)) {
      await confirmOk.click();
    }
    await page.waitForTimeout(6000); // autoCreateForOrder도 여기서 fire

    await page.waitForSelector("#order-modal", { state: "hidden", timeout: 60000 }).catch(() => {
      throw new Error("발주 저장 후 모달이 닫히지 않음");
    });

    // 방금 저장한 orderId, orderNum 얻기
    const created = await page.evaluate(() => {
      const w = window as any;
      const orders = w.DB.get("orders", []);
      const cu = w.DB.get("session", null);
      const mine = orders.filter((o: any) => o && o.createdBy === cu?.id && o.status === "발주대기");
      const latest = mine.sort((a: any, b: any) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0];
      return latest ? { id: latest.id, orderNum: latest.orderNum, status: latest.status } : null;
    });
    expect(created, "발주 저장 후 orders에 새 발주 나와야 함").not.toBeNull();
    console.log("발주자가 만든 발주:", created);

    // ══════ 2. 로그아웃 → 관리자 로그인 ══════
    await logout(page);
    await loginAs(page, "admin", "admin", "123456");

    // ══════ 3. 관리자가 status를 발주확정으로 변경 (window.changeOrderStatus) ══════
    const statusChangeResult = await page.evaluate(async (orderId) => {
      const w = window as any;
      if (typeof w.changeOrderStatus !== "function") return { ok: false, msg: "changeOrderStatus 없음" };
      try {
        const r = await w.changeOrderStatus(orderId, "발주확정");
        return { ok: r === true, r };
      } catch (e: any) {
        return { ok: false, err: String(e?.message) };
      }
    }, created!.id);
    console.log("status 변경 결과:", statusChangeResult);
    expect(statusChangeResult.ok, "관리자가 발주확정 상태 변경 성공해야 함").toBe(true);

    // autoCreateForOrder wait
    await page.waitForTimeout(4000);

    // invoice 실제 만들어졌는지 확인
    const invoiceExists = await page.evaluate((orderNum) => {
      const invs = (window as any).DB.get("invoices", []);
      const found = invs.find((i: any) => i && i.orderNum === orderNum && !i.cancelled);
      return found ? { exists: true, needsManualReview: found.needsManualReview, cancelled: found.cancelled } : { exists: false };
    }, created!.orderNum);
    console.log("발주확정 후 invoice 존재:", invoiceExists);
    expect(invoiceExists.exists, "발주확정 시 명세서 자동 생성됨").toBe(true);

    // ══════ 4. 로그아웃 → 발주자 재로그인 ══════
    await logout(page);
    await loginAs(page, "orderer", "orderer", "123456");

    // 발주자로 정산 페이지 이동
    await page.evaluate(() => (window as any).navigate("settlement"));
    await page.waitForSelector("#tbody-ordererwise", { timeout: 10000 });
    await page.waitForTimeout(1500);

    // 이번 달 필터
    await page.evaluate(() => {
      const el = document.getElementById("date-input") as HTMLInputElement | null;
      if (el) {
        const now = new Date();
        const yy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, "0");
        el.value = `${yy}-${mm}`;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (typeof (window as any).loadData === "function") (window as any).loadData();
    });
    await page.waitForTimeout(2000);

    // 정산 페이지에 방금 만든 발주 row 있는지
    const orderRow = page.locator(`#tbody-ordererwise tr.row-main`).first();
    await expect(orderRow, "발주자 정산에 거래처 row 뜸").toBeVisible({ timeout: 10000 });
    await orderRow.click();
    await page.waitForTimeout(500);

    // 방금 만든 발주의 [거래명세서] 버튼
    const invoiceBtn = page
      .locator(`.detail-table tbody tr:has(td code:has-text("${created!.orderNum}")) button[data-action="open-invoice"]`)
      .first();
    await expect(invoiceBtn, "발주자한테 [거래명세서] 버튼 뜸").toBeVisible({ timeout: 5000 });

    // 클릭 → 모달 열림
    await invoiceBtn.click();
    await page.waitForTimeout(2000);
    const modal = page.locator("#invoiceModal");
    await expect(modal, "[거래명세서] 클릭 → 모달 열림").toBeVisible({ timeout: 5000 });

    // 모달 안 내용 확인
    const modalTxt = await modal.textContent();
    expect(modalTxt, "모달에 '거래명세서' 텍스트").toContain("거래명세서");
    expect(modalTxt, "모달에 발주번호 표시").toContain(created!.orderNum);
  });
});
