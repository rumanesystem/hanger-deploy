/**
 * [회귀] 정산 목록 — 같은 정산일 발주는 발주번호 tiebreaker 로 정렬 방향 따른다
 * 배경: render.js:228-236 sort 에 orderNum tiebreaker 추가 (2026-09-03)
 *   이전 버그: 같은 날짜면 원본 배열 순서 (오래된 발주번호 위)
 *   fix: cmp === 0 이면 orderNum localeCompare, 정렬 방향 따름
 *
 * seed 스크립트 안 씀 — 테스트 안에서 직접 orders 주입 (settlement-sort-search 의
 * beforeAll seed 타임아웃 이슈 회피)
 */
import { test, expect, Page } from "@playwright/test";

async function waitForAppReady(page: Page, accountId = "admin") {
  await page.waitForFunction(
    (id) => {
      const w = window as any;
      const accounts = w.DB && typeof w.DB.get === "function" ? w.DB.get("accounts", []) : [];
      return Boolean(
        w._booted &&
          w._fbAuth &&
          Array.isArray(accounts) &&
          accounts.some((a: any) => a && a.id === id)
      );
    },
    accountId,
    { timeout: 25_000 }
  );
}

async function loginAsAdmin(page: Page) {
  await page.goto("/");
  await waitForAppReady(page, "admin");
  await page.locator("#tab-admin").click();
  await page.fill("#login-id", "admin");
  await page.fill("#login-pw", "123456");
  await page.locator('button[onclick="doLogin()"]').click();
  await page.waitForSelector('[data-nav="settlement"]', { timeout: 15_000 });
}

async function visibleOrderNums(page: Page) {
  return page
    .locator(".detail-table tbody tr:not(.hidden-row):not(.search-hidden) td:first-child")
    .allTextContents()
    .then((rows) => rows.map((t) => t.trim()).filter(Boolean));
}

test("R5-tiebreaker: 같은 정산일 → 발주번호 tiebreaker (desc 기본)", async ({ page }) => {
  await loginAsAdmin(page);

  const marker = "TIEBREAKER-R5";
  await page.evaluate((mk) => {
    const orders = (window as any).DB.get("orders", []);
    // 입력 역순 — 원본 순서 그대로면 011 이 위
    const nums = [`${mk}-011`, `${mk}-014`, `${mk}-012`, `${mk}-013`];
    nums.forEach((num, i) => {
      orders.push({
        id: 99010 + i,
        orderNum: num,
        deliveryTo: mk,
        address: "테스트 주소",
        // 컷오프 2026-09-01 이후 → statusHistory 기준 정산일
        orderDate: "2026-09-15",
        shipDate: "2026-09-15",
        warehouse: "시흥",
        status: "발주확정",
        statusHistory: [{ status: "발주확정", changedAt: "2026-09-16T00:00:00.000Z" }],
        createdBy: "orderer",
        totalSupply: 10000,
        totalVat: 1000,
        totalAmount: 11000,
      });
    });
    return (window as any).DB.set("orders", orders);
  }, marker);

  await page.evaluate(() => (window as any).navigate("settlement"));
  await page.waitForSelector("#sort-toggle", { timeout: 10_000 });
  await page.locator('#date-input').fill('2026-09');
  await page.evaluate(() => (window as any).loadData());
  await page.waitForSelector('#tbody-ordererwise tr.row-main', { timeout: 10_000 });

  // 마커 거래처 펼침
  const rows = page.locator("#tbody-ordererwise tr.row-main");
  const count = await rows.count();
  let opened = false;
  for (let i = 0; i < count; i++) {
    const txt = (await rows.nth(i).textContent()) || "";
    if (txt.includes(marker)) {
      await rows.nth(i).click();
      opened = true;
      break;
    }
  }
  expect(opened, `${marker} 거래처 렌더됨`).toBe(true);
  await page.waitForSelector(".detail-table tbody tr:not(.hidden-row):not(.search-hidden)", { timeout: 5_000 });

  // 기본 desc → 014, 013, 012, 011
  const orderAttr = await page.locator("#sort-toggle").getAttribute("data-order");
  expect(orderAttr, "기본 정렬 desc").toBe("desc");

  const numsDesc = await visibleOrderNums(page);
  const mineDesc = numsDesc.filter(n => n.includes(marker));
  expect(mineDesc, "desc: 014→013→012→011").toEqual([
    `${marker}-014`, `${marker}-013`, `${marker}-012`, `${marker}-011`,
  ]);

  // asc 토글 → 011, 012, 013, 014
  await page.locator("#sort-toggle").click();
  await page.waitForTimeout(300);
  const orderAttrAsc = await page.locator("#sort-toggle").getAttribute("data-order");
  expect(orderAttrAsc, "토글 후 asc").toBe("asc");
  const numsAsc = await visibleOrderNums(page);
  const mineAsc = numsAsc.filter(n => n.includes(marker));
  expect(mineAsc, "asc: 011→012→013→014").toEqual([
    `${marker}-011`, `${marker}-012`, `${marker}-013`, `${marker}-014`,
  ]);
});
