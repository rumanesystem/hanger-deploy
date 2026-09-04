/**
 * [회귀] 진행중 발주 목록에 hanger_drafts 병합 표시
 * 배경: 임시저장 완전분리(e5b11cd) 이후 목록에서 임시저장이 사라짐.
 *   → 관리자·본인이 인지·복원 가능하도록 진행중 탭에 병합 렌더 (2026-09-03).
 *
 * 검증:
 * 1) 관리자 로그인 후 hanger_drafts 에 draft 를 직접 씀
 * 2) 진행중 탭에 "임시저장" 상태 배지 + "임시-xxxxxxxx" 발주번호 뜸
 * 3) 재발주/거래명세서 버튼은 draft 행에는 없음 (오작동 방지)
 */
import { test, expect, Page } from "@playwright/test";

async function waitForAppReady(page: Page, accountId = "admin") {
  await page.waitForFunction(
    (id) => {
      const w = window as any;
      const accounts = w.DB && typeof w.DB.get === "function" ? w.DB.get("accounts", []) : [];
      return Boolean(w._booted && w._fbAuth && Array.isArray(accounts) &&
        accounts.some((a: any) => a && a.id === id));
    }, accountId, { timeout: 25_000 });
}

async function loginAsAdmin(page: Page) {
  await page.goto("/");
  await waitForAppReady(page, "admin");
  await page.locator("#tab-admin").click();
  await page.fill("#login-id", "admin");
  await page.fill("#login-pw", "123456");
  await page.locator('button[onclick="doLogin()"]').click();
  await page.waitForSelector('[data-nav="orders"]', { timeout: 15_000 });
}

test("R6-drafts: 진행중 목록에 hanger_drafts 임시저장 병합 표시", async ({ page }) => {
  await loginAsAdmin(page);

  const draftId = "test-draft-" + Date.now().toString().slice(-8);
  const marker = "DRAFT-MERGE-TEST-" + draftId.slice(-8);

  // draft 를 서버에 직접 씀
  await page.evaluate(async ({ dId, mk }) => {
    const w = window as any;
    const doc = {
      draftId: dId,
      createdBy: "admin",
      createdByName: "관리자",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: {
        deliveryTo: mk,
        address: "테스트 시공 주소",
        orderDate: "2026-09-03",
        shipDate: "2026-09-15",
        warehouse: "시흥",
      },
    };
    await w._FS.collectionAdd("hanger_drafts", dId, doc);
    // 로컬 캐시도 갱신 (booting 이후 fetch 결과 반영 흉내)
    w._mem = w._mem || {};
    w._mem.drafts = (w._mem.drafts || []).concat([doc]);
  }, { dId: draftId, mk: marker });

  // 발주 관리 화면으로 이동 후 목록 재렌더
  await page.evaluate(() => (window as any).navigate("orders"));
  await page.waitForTimeout(500);
  await page.evaluate(() => { if (typeof (window as any).renderOrders === "function") (window as any).renderOrders(); });
  await page.waitForTimeout(400);

  // 행에 임시-xxxxxx 발주번호 뜨는지
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).toContain(marker);
  expect(bodyText).toContain("임시-" + draftId.slice(0, 8));

  // 재발주 / 거래명세서 버튼은 draft 행 안에 없어야 함
  const draftRow = page.locator(`tr.order-row[data-draft-id="${draftId}"]`);
  await expect(draftRow, "draft row 렌더됨").toBeVisible();
  await expect(draftRow.locator(".reorder-btn"), "재발주 버튼 없음").toHaveCount(0);
  await expect(draftRow.locator(".invoice-btn"), "명세서 버튼 없음").toHaveCount(0);

  // 정리
  await page.evaluate(async (dId) => {
    const w = window as any;
    try { await w._FS.collectionDelete("hanger_drafts", dId); } catch (_) {}
    if (w._mem && Array.isArray(w._mem.drafts)) {
      w._mem.drafts = w._mem.drafts.filter((d: any) => d && d.draftId !== dId);
    }
  }, draftId);
});
