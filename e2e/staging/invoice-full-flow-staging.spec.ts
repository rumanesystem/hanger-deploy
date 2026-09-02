/**
 * [스테이징 전용] 명세서 자동 노출 진짜 end-to-end
 * 대상: https://hanger-test-260901.web.app (개인 계정, 실 운영 완전 격리)
 *
 * 로컬 emu 시드 없이 REST API로 스테이징 프로젝트에 직접 시드 → UI 클릭
 * 시나리오: 발주자 UI로 발주 만듦 → 관리자 발주확정 → 발주자 정산에 명세서 뜸 → 클릭 → 모달 열림
 */
import { test, expect, Page } from "@playwright/test";

test.setTimeout(240_000);

const PROJECT_ID = "hanger-test-260901";
const API_KEY = process.env.STAGING_API_KEY;
if (!API_KEY) throw new Error("STAGING_API_KEY 환경변수 필요");

async function signIn(email: string, password: string): Promise<string> {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const j: any = await r.json();
  if (j.error) throw new Error(`SignIn 실패: ${JSON.stringify(j.error)}`);
  return j.idToken;
}

function toFV(v: any): any {
  if (v === null) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFV) } };
  if (typeof v === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFV(x)])) } };
  return { nullValue: null };
}

async function writeDoc(collectionId: string, docId: string, data: Record<string, any>, idToken: string) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collectionId}/${docId}`;
  const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toFV(v)]));
  const r = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ fields }),
  });
  const j: any = await r.json();
  if (j.error) throw new Error(`Firestore 실패 ${collectionId}/${docId}: ${JSON.stringify(j.error)}`);
}

test.beforeAll(async () => {
  // 스테이징 DB 리셋 (테스트 실행 전 깨끗한 상태) — orders/invoices 비움
  // [Reviewer P1 fix] fallback 제거 → loud fail (파일 자체 self-contained, 14행과 동일 정책)
  const adminEmail = process.env.STAGING_ADMIN_EMAIL;
  const adminPw = process.env.STAGING_ADMIN_PASSWORD;
  if (!adminEmail || !adminPw) throw new Error("STAGING_ADMIN_EMAIL / STAGING_ADMIN_PASSWORD 환경변수 필요");
  const token = await signIn(adminEmail, adminPw);
  await writeDoc("hanger_data", "orders", { value: [], updatedAt: new Date().toISOString() }, token);
  await writeDoc("hanger_data", "invoices", { value: [], updatedAt: new Date().toISOString() }, token);
  await writeDoc("hanger_data", "purchase_requests", { value: [], updatedAt: new Date().toISOString() }, token);
});

async function waitForBoot(page: Page, accountId: string) {
  await page.waitForFunction(
    (id) => {
      const w = window as any;
      const accs = w.DB && typeof w.DB.get === "function" ? w.DB.get("accounts", []) : [];
      return Boolean(w._booted && w._fbAuth && Array.isArray(accs) && accs.some((a: any) => a && a.id === id));
    },
    accountId,
    { timeout: 30_000 }
  );
}

async function loginAs(page: Page, tab: "admin" | "orderer", id: string, pw: string) {
  await page.goto("/");
  await page.waitForSelector("#login-screen", { timeout: 20_000 });
  await waitForBoot(page, id);
  await page.waitForTimeout(1000); // 스테이징: 초기 fetch 여유
  await page.locator(`#tab-${tab}`).click();
  await page.fill("#login-id", id);
  await page.fill("#login-pw", pw);
  await page.locator('button[onclick="doLogin()"]').click();
  await page.waitForSelector("[data-nav]", { timeout: 45_000 });
  await page.waitForTimeout(3000);
}

async function logout(page: Page) {
  await page.evaluate(() => {
    const fn = (window as any).doLogout;
    if (typeof fn === "function") fn();
  }).catch(() => {});
  await page.waitForSelector("#login-screen.active", { state: "visible", timeout: 15_000 });
}

test.describe("[스테이징] 명세서 자동 노출 end-to-end", () => {
  test("F1-staging. 발주자 UI로 발주 → 관리자 발주확정 → 발주자 정산에 명세서 뜸 → 클릭 → 모달 열림", async ({ page }) => {
    // 1) 발주자 UI로 발주 만듦
    await loginAs(page, "orderer", "orderer", "123456");
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

    await page.locator("#order-modal .order-modal-bottom .btn-primary").first().click();
    const confirmOk = page.locator("#order-confirm-ok-btn");
    await confirmOk.waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
    if (await confirmOk.isVisible().catch(() => false)) {
      await confirmOk.click();
    }
    await page.waitForTimeout(8_000); // 스테이징 = 실 Firebase 라 자원 요청 느림, autoCreateForOrder 대기
    await page.waitForSelector("#order-modal", { state: "hidden", timeout: 45_000 });

    const created = await page.evaluate(() => {
      const w = window as any;
      const orders = w.DB.get("orders", []);
      const cu = w.DB.get("session", null);
      const mine = orders.filter((o: any) => o && o.createdBy === cu?.id && o.status === "발주대기");
      const latest = mine.sort((a: any, b: any) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0];
      return latest ? { id: latest.id, orderNum: latest.orderNum, status: latest.status } : null;
    });
    expect(created, "발주 저장 후 orders에 새 발주 나와야 함").not.toBeNull();
    console.log("[스테이징] 발주자가 만든 발주:", created);

    // 2) 관리자로 갈아탐 → 발주확정 상태 변경
    await logout(page);
    await loginAs(page, "admin", "admin", "123456");

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
    console.log("[스테이징] status 변경:", statusChangeResult);
    expect(statusChangeResult.ok, "관리자가 발주확정 상태 변경 성공").toBe(true);

    await page.waitForTimeout(5_000); // autoCreateForOrder 실 Firebase 대기

    const invoiceExists = await page.evaluate((orderNum) => {
      const invs = (window as any).DB.get("invoices", []);
      const found = invs.find((i: any) => i && i.orderNum === orderNum && !i.cancelled);
      return found ? { exists: true, needsManualReview: !!found.needsManualReview } : { exists: false };
    }, created!.orderNum);
    console.log("[스테이징] invoice 존재:", invoiceExists);
    expect(invoiceExists.exists, "발주확정 시 명세서 자동 생성됨").toBe(true);

    // 3) 발주자로 다시 갈아탐 → 정산 페이지 → [거래명세서] 클릭
    await logout(page);
    await loginAs(page, "orderer", "orderer", "123456");
    await page.evaluate(() => (window as any).navigate("settlement"));
    await page.waitForSelector("#tbody-ordererwise", { timeout: 15_000 });
    await page.waitForTimeout(2_000);

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
    await page.waitForTimeout(3_000);

    const orderRow = page.locator(`#tbody-ordererwise tr.row-main`).first();
    await expect(orderRow, "발주자 정산에 거래처 row 뜸").toBeVisible({ timeout: 15_000 });
    await orderRow.click();
    await page.waitForTimeout(800);

    const invoiceBtn = page
      .locator(`.detail-table tbody tr:has(td code:has-text("${created!.orderNum}")) button[data-action="open-invoice"]`)
      .first();
    await expect(invoiceBtn, "발주자한테 [거래명세서] 버튼 뜸").toBeVisible({ timeout: 8_000 });
    await invoiceBtn.click();
    await page.waitForTimeout(3_000);
    const modal = page.locator("#invoiceModal");
    await expect(modal, "[거래명세서] 클릭 → 모달 열림").toBeVisible({ timeout: 8_000 });

    const modalTxt = await modal.textContent();
    expect(modalTxt, "모달에 '거래명세서' 텍스트").toContain("거래명세서");
    expect(modalTxt, "모달에 발주번호 표시").toContain(created!.orderNum);
  });
});
