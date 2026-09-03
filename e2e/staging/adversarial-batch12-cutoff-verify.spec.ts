/**
 * [스테이징 컷오프 정책 검증] 2026-09-01 기준 정책 정확성
 * 배포 전 마지막 확인: 신규 발주 (orderDate >= 2026-09-01) 는 새 정책,
 * 옛 발주 (orderDate < 2026-09-01) 는 옛 정책 유지
 *
 * K1: 옛 발주 (2026-08-15) → 옛 규칙 (shipDate → orderDate)
 * K2: 컷오프 정각 (2026-09-01) → 새 규칙 (statusHistory 첫 확정일)
 * K3: 컷오프 이후 (2026-09-15) → 새 규칙
 * K4: 옛 발주 shipDate=0000-00-00 → orderDate 폴백
 * K5: 새 발주 statusHistory 없음 → shipDate 폴백
 * K6: 새 발주 재확정 (취소→되돌리기) → 첫 확정일 유지 (회계 안전)
 * K7: 관리자 orderDate 편집 (옛→새 이동) → statusHistory 있으면 옛 정산월 유지
 */
import { test, expect, Page } from "@playwright/test";

test.setTimeout(120_000);

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

test.describe("[스테이징 컷오프 정책 검증]", () => {

  test("K1~K7: getSettlementDate 정책 전수 검증", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const result = await page.evaluate(() => {
      const w = window as any;
      const getSD = w.getSettlementDate;
      if (typeof getSD !== "function") return { err: "getSettlementDate 없음" };

      const cases = [
        {
          name: "K1 옛 발주 (2026-08-15) → 옛 규칙 shipDate 우선",
          order: { orderDate: "2026-08-15", shipDate: "2026-08-20", statusHistory: [] },
          expected: "2026-08-20",
        },
        {
          name: "K1b 옛 발주, shipDate=0000-00-00 → orderDate 폴백",
          order: { orderDate: "2026-08-15", shipDate: "0000-00-00", statusHistory: [] },
          expected: "2026-08-15",
        },
        {
          name: "K2 컷오프 정각 (2026-09-01), statusHistory 확정일 있음 → 확정일",
          order: {
            orderDate: "2026-09-01", shipDate: "2026-09-05",
            statusHistory: [{ status: "발주확정", changedAt: "2026-09-02T00:00:00Z" }],
          },
          expected: "2026-09-02",
        },
        {
          name: "K3 컷오프 이후 (2026-09-15), 확정일 있음 → 확정일",
          order: {
            orderDate: "2026-09-15", shipDate: "2026-09-20",
            statusHistory: [{ status: "발주확정", changedAt: "2026-09-16T00:00:00Z" }],
          },
          expected: "2026-09-16",
        },
        {
          name: "K5 새 발주, statusHistory 없음 → shipDate 폴백",
          order: { orderDate: "2026-09-15", shipDate: "2026-09-20", statusHistory: [] },
          expected: "2026-09-20",
        },
        {
          name: "K6 새 발주 재확정: 여러 확정 이력 → 첫 확정일 (재확정 무관)",
          order: {
            orderDate: "2026-09-15", shipDate: "2026-09-25",
            statusHistory: [
              { status: "발주확정", changedAt: "2026-09-16T00:00:00Z" }, // 첫 확정
              { status: "발주대기", changedAt: "2026-09-18T00:00:00Z" }, // 취소·되돌리기
              { status: "발주확정", changedAt: "2026-09-20T00:00:00Z" }, // 재확정
            ],
          },
          expected: "2026-09-16",
        },
        {
          name: "K7 옛 발주였다가 orderDate 편집으로 컷오프 이후로 이동 → statusHistory 첫 확정일 우선",
          order: {
            orderDate: "2026-09-01", // 편집됨
            shipDate: "2026-08-20",  // 원래 옛 shipDate
            statusHistory: [{ status: "발주확정", changedAt: "2026-08-19T00:00:00Z" }], // 옛 확정
          },
          expected: "2026-08-19", // 옛 확정일 유지 → 회계 안 흔들림
        },
      ];

      return cases.map(c => {
        const actual = getSD(c.order);
        return { name: c.name, expected: c.expected, actual, match: actual === c.expected };
      });
    });

    console.log("[Cutoff 정책 전수 검증]");
    for (const r of (result as any[])) {
      console.log(`  ${r.match ? "✅" : "❌"} ${r.name}`);
      console.log(`     예상: ${r.expected} / 실제: ${r.actual}`);
    }
    for (const r of (result as any[])) {
      expect(r.match, r.name).toBe(true);
    }
  });

  test("실 발주 저장 → getSettlementDate 반영 (end-to-end)", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const orderId = 720000 + Math.floor(Math.random() * 100);
    const result = await page.evaluate(async (id) => {
      const w = window as any;
      // 실제 저장 → 회수 → getSettlementDate
      const cur = await w._FS.get("orders", []);
      const newOrder = {
        id, orderNum: `K-e2e-${Date.now().toString().slice(-4)}`, status: "발주확정",
        deliveryTo: "테스트업체", createdBy: "orderer",
        createdAt: new Date().toISOString(),
        orderDate: "2026-09-15", // 새 정책 대상
        shipDate: "2026-09-20",
        statusHistory: [{ status: "발주확정", changedAt: "2026-09-16T00:00:00Z" }],
        items: [],
      };
      await w._FS.set("orders", [...cur, newOrder]);
      const back = (await w._FS.get("orders", []) as any[]).find(o => o?.id === id);
      const sd = w.getSettlementDate(back);
      // cleanup
      const arr = await w._FS.get("orders", []);
      await w._FS.set("orders", (arr as any[]).filter(o => o?.id !== id));
      return { saved: !!back, settlementDate: sd };
    }, orderId);
    console.log("[E2E 저장·회수·정산일]", result);
    expect(result.settlementDate, "실 저장 후 회수 정산일 정확").toBe("2026-09-16");
  });
});
