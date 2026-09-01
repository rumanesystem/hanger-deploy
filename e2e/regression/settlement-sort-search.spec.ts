import { test, expect, Page } from "@playwright/test";
import { execSync } from "child_process";
import path from "path";

test.beforeAll(() => {
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

async function loginAsOrderer(page: Page) {
  await page.goto("/");
  await waitForAppReady(page, "orderer");
  await page.locator("#tab-orderer").click();
  await page.fill("#login-id", "orderer");
  await page.fill("#login-pw", "123456");
  await page.locator('button[onclick="doLogin()"]').click();
  await page.waitForSelector("[data-nav]", { timeout: 15_000 });
}

async function goToSettlement(page: Page) {
  await page.evaluate(() => (window as any).navigate("settlement"));
  await page.waitForSelector("#tbody-ordererwise", { timeout: 10_000 });
  await page.waitForSelector("#sort-toggle", { timeout: 10_000 });
}

async function openFirstCustomer(page: Page) {
  const firstCustomer = page.locator("#tbody-ordererwise tr.row-main").first();
  await expect(firstCustomer).toBeVisible();
  await firstCustomer.click();
  await page.waitForSelector(".detail-table tbody tr:not(.hidden-row):not(.search-hidden)", { timeout: 5_000 });
}

async function openCustomerWithAtLeastTwoRows(page: Page) {
  const rows = page.locator("#tbody-ordererwise tr.row-main");
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    await rows.nth(i).click();
    await page.waitForTimeout(150);
    const nums = await visibleOrderNums(page);
    if (nums.length >= 2) return nums;
    await rows.nth(i).click().catch(() => {});
  }
  return [];
}

async function visibleOrderNums(page: Page) {
  return page
    .locator(".detail-table tbody tr:not(.hidden-row):not(.search-hidden) td:first-child")
    .allTextContents()
    .then((rows) => rows.map((t) => t.trim()).filter(Boolean));
}

test.describe("정산 — 정렬 + 검색 회귀", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await goToSettlement(page);
  });

  test("R1: 탭 왕복 후 sort-toggle 상태와 실제 발주번호 순서가 일치한다", async ({ page }) => {
    // seed-ledger-print-test가 같은 거래처의 2026-07 발주를 6건 만든다.
    // 실행 시점의 현재 월과 무관하게 해당 월을 명시적으로 조회한다.
    await page.locator('#date-input').fill('2026-07');
    await page.evaluate(() => (window as any).loadData());
    await page.waitForSelector('#tbody-ordererwise tr.row-main', { timeout: 10_000 });

    const toggle = page.locator("#sort-toggle");

    await toggle.click();
    await expect(toggle).toHaveAttribute("data-order", "asc");

    await page.evaluate(() => (window as any).navigate("dashboard"));
    await page.waitForTimeout(300);
    await page.evaluate(() => (window as any).navigate("settlement"));
    await page.waitForSelector("#sort-toggle", { timeout: 10_000 });
    await page.locator('#date-input').fill('2026-07');
    await page.evaluate(() => (window as any).loadData());
    await page.waitForSelector('#tbody-ordererwise tr.row-main', { timeout: 10_000 });

    const orderAttr = await page.locator("#sort-toggle").getAttribute("data-order");
    const nums = await openCustomerWithAtLeastTwoRows(page);
    expect(nums.length, '같은 거래처의 정산 발주가 2건 이상이어야 함').toBeGreaterThanOrEqual(2);

    const first = nums[0];
    const last = nums[nums.length - 1];
    if (orderAttr === "asc") {
      expect(first.localeCompare(last)).toBeLessThanOrEqual(0);
    } else {
      expect(first.localeCompare(last)).toBeGreaterThanOrEqual(0);
    }
  });

  test("R2: 검색 활성 상태에서 정렬해도 search-hidden 상태가 유지된다", async ({ page }) => {
    // seed-ledger-print-test의 정산 데이터는 2026-07에 고정되어 있다.
    // 현재 월 기본값에 의존하면 실행 날짜에 따라 고객 행이 0건이 되어 정렬 검증 전에 실패한다.
    await page.locator('#date-input').fill('2026-07');
    await page.evaluate(() => (window as any).loadData());
    await page.waitForSelector('#tbody-ordererwise tr.row-main', { timeout: 10_000 });

    await openFirstCustomer(page);

    const search = page.locator("#quick-search");
    await search.fill("20260701");
    await page.waitForTimeout(250);

    const hiddenBefore = await page.locator(".detail-table tbody tr.search-hidden").count();
    test.skip(hiddenBefore === 0, "검색 결과를 숨길 수 있는 정산 시드 데이터 필요");

    await page.locator("#sort-toggle").click();
    await page.waitForTimeout(200);

    const hiddenAfter = await page.locator(".detail-table tbody tr.search-hidden").count();
    expect(hiddenAfter).toBe(hiddenBefore);
  });

  test("R3: admin settlement uses the order-confirmed date for its month filter", async ({ page }) => {
    // [2026-08-31] 컷오프 정책: orderDate >= '2026-09-01'인 발주만 새 정책(발주확정 시점) 적용.
    //   원 테스트는 orderDate 2026-06-30이라 컷오프 이전 → 옛 규칙(shipDate)으로 fallback되어 실패함.
    //   → 컷오프 이후 날짜로 이관 (의도: "확정월로 필터되는지" 유지)
    const result = await page.evaluate(async () => {
      const orders = (window as any).DB.get("orders", []);
      orders.push({
        id: 88001,
        orderNum: "CONFIRMED-IN-OCT-ADMIN-1",
        deliveryTo: "명세서없음관리자표시",
        address: "테스트 주소",
        orderDate: "2026-09-15",
        shipDate: "2026-11-01",
        warehouse: "시흥",
        status: "발주확정",
        statusHistory: [
          { status: "발주확정", changedAt: "2026-10-05T00:00:00.000Z" },
        ],
        createdBy: "orderer",
        totalSupply: 10000,
        totalVat: 1000,
        totalAmount: 11000,
      });
      await (window as any).DB.set("orders", orders);
      const rows = await (window as any).fetchCompletedOrders({
        range: { startDate: "2026-10-01", endDate: "2026-10-31" },
        ordererSearch: "",
        warehouse: "",
      });
      return rows.some((o: any) => o.orderNum === "CONFIRMED-IN-OCT-ADMIN-1");
    });

    expect(result).toBe(true);
  });

  test("R4: orderer settlement shows completed orders (auto-visible on 출고확정)", async ({ page }) => {
    // [2026-08-31] 정책 변경: 관리자 [전송] 버튼 없앰 → 출고확정만으로 발주자 정산 자동 노출.
    //   기존 R4: 명세서 없으면 hidden (expect false)
    //   신규 R4: 발주확정 상태면 명세서 유무와 무관하게 표시 (expect true)
    await page.evaluate(() => {
      try { (window as any).doLogout && (window as any).doLogout(); } catch (_) {}
    });
    await loginAsOrderer(page);

    const result = await page.evaluate(async () => {
      const orders = (window as any).DB.get("orders", []);
      orders.push({
        id: 88002,
        orderNum: "NO-INVOICE-ORDERER-1",
        deliveryTo: "발주자명세서미전송숨김",
        address: "테스트 주소",
        // [2026-08-31] shipDate과 filter month 일치시켜야 정책 실제 검증됨
        //   (getSettlementDate 컷오프 2026-09-01 이전 → shipDate 기준 → 7월 fixture)
        orderDate: "2026-07-15",
        shipDate: "2026-07-20",
        warehouse: "시흥",
        // [2026-08-31] legacy '출고완료' → 실무 '발주확정'으로 이관 (메모리 규칙 준수)
        status: "발주확정",
        createdBy: "orderer",
        totalSupply: 10000,
        totalVat: 1000,
        totalAmount: 11000,
      });
      await (window as any).DB.set("orders", orders);
      const rows = await (window as any).fetchCompletedOrders({
        range: { startDate: "2026-07-01", endDate: "2026-07-31" },
        ordererSearch: "",
        warehouse: "",
      });
      return rows.some((o: any) => o.orderNum === "NO-INVOICE-ORDERER-1");
    });

    expect(result).toBe(true);
  });
});
