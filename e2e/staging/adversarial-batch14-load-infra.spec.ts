/**
 * [스테이징 부하·infra 검증] 배포 전 최종 스트레스
 * X1: 5 사용자 동시 발주 저장 (multi-context) → 5개 다 정확히 저장
 * X2: 네트워크 slow-3G throttle 상태 저장·회수 → 실패 X, 정합성 유지
 */
import { test, expect, Page } from "@playwright/test";

test.setTimeout(300_000);

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

test.describe("[스테이징 부하·infra]", () => {

  test("X1: 5 사용자 (5 context) 동시 발주 저장 → 5개 다 land, id 유일", async ({ browser }) => {
    const N = 5;
    // 5 context 병렬 생성 (완전 격리된 세션)
    const contexts = await Promise.all(Array.from({ length: N }, () => browser.newContext()));
    const pages = await Promise.all(contexts.map(c => c.newPage()));

    // 모두 admin 로그인 (스테이징 accounts 는 admin/orderer 만 있음)
    await Promise.all(pages.map(p => bootLogin(p, "admin", "admin", "123456")));

    // 각 context 에서 발주 하나씩 병렬 저장 (REST 로)
    const results = await Promise.all(pages.map(async (page, idx) => {
      return await page.evaluate(async (i) => {
        const w = window as any;
        try {
          const orderId = 740000 + Math.floor(Math.random() * 10000) + i;
          const cur = await w._FS.get("orders", []);
          const order = {
            id: orderId,
            orderNum: `X1-${i}-${Date.now().toString().slice(-4)}`,
            status: "발주대기",
            deliveryTo: `X1-user-${i}`,
            createdBy: "admin",
            createdAt: new Date().toISOString(),
            orderDate: "2026-09-03",
            shipDate: "2026-09-03",
            items: [],
          };
          await w._FS.set("orders", [...cur, order]);
          return { i, ok: true, orderId, orderNum: order.orderNum };
        } catch (e: any) {
          return { i, ok: false, err: String(e?.message) };
        }
      }, idx);
    }));

    console.log("[X1] 5 사용자 병렬 저장 결과:", results);
    await pages[0].waitForTimeout(3000);

    // 최종 확인: 5개 다 서버에 있고 id 유일
    const finalCheck = await pages[0].evaluate(async () => {
      const w = window as any;
      const orders = await w._FS.get("orders", []);
      const x1 = (orders as any[]).filter(o => o?.orderNum?.startsWith("X1-"));
      return {
        count: x1.length,
        uniqueIds: new Set(x1.map(o => o.id)).size,
        uniqueNums: new Set(x1.map(o => o.orderNum)).size,
      };
    });
    console.log("[X1] 서버 최종:", finalCheck);

    // Cleanup
    await pages[0].evaluate(async () => {
      const w = window as any;
      const orders = await w._FS.get("orders", []);
      await w._FS.set("orders", (orders as any[]).filter(o => !o?.orderNum?.startsWith("X1-")));
    });
    for (const ctx of contexts) await ctx.close();

    const successCount = results.filter(r => r.ok).length;
    expect(successCount, "5 사용자 모두 저장 성공").toBe(N);
    expect(finalCheck.count, "5개 다 서버에 land").toBe(N);
    expect(finalCheck.uniqueIds, "id 중복 없음").toBe(N);
  });

  test("X2: 네트워크 지연 (400ms) 시 저장·회수 정합성", async ({ page }) => {
    // Playwright route 로 firestore.googleapis.com 400ms 지연 삽입
    await page.route("**/firestore.googleapis.com/**", async route => {
      await new Promise(r => setTimeout(r, 400));
      await route.continue();
    });

    await bootLogin(page, "admin", "admin", "123456");

    // 저장 3회 순차 (부하 아닌 infra 지연 시나리오)
    const result = await page.evaluate(async () => {
      const w = window as any;
      const results: any[] = [];
      for (let i = 0; i < 3; i++) {
        try {
          const cur = await w._FS.get("orders", []);
          const order = {
            id: 745000 + i,
            orderNum: `X2-${i}-${Date.now().toString().slice(-4)}`,
            status: "발주대기",
            deliveryTo: `X2-slow`,
            createdBy: "admin",
            createdAt: new Date().toISOString(),
            orderDate: "2026-09-03",
            shipDate: "2026-09-03",
            items: [],
          };
          const t0 = Date.now();
          await w._FS.set("orders", [...cur, order]);
          results.push({ i, ok: true, elapsed: Date.now() - t0 });
        } catch (e: any) {
          results.push({ i, ok: false, err: String(e?.message) });
        }
      }
      // 최종 확인
      const orders = await w._FS.get("orders", []);
      const x2 = (orders as any[]).filter(o => o?.orderNum?.startsWith("X2-"));
      // cleanup
      await w._FS.set("orders", (orders as any[]).filter(o => !o?.orderNum?.startsWith("X2-")));
      return { results, savedCount: x2.length };
    });
    console.log("[X2] slow-net 결과:", result);
    const successCount = result.results.filter((r: any) => r.ok).length;
    expect(successCount, "지연 상황에서도 3회 다 저장 성공").toBe(3);
    expect(result.savedCount, "3개 다 서버에 land").toBe(3);
  });
});
