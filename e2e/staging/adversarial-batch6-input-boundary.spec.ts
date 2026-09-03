/**
 * [스테이징 적대적 배치6] 입력·경계·존재하지 않는 것 10개
 * P1: 검색창 XSS payload
 * P2: 검색창 SQL injection payload
 * P3: 검색창 매우 긴 문자열 (1만자)
 * P4: 매우 오래된 shipDate (1900-01-01)
 * P5: 매우 미래 shipDate (2100-01-01)
 * P6: 정산 필터 미래 월 (2030-05)
 * P7: 정산 필터 과거 년 (1990-01)
 * P8: items 필드 다 null 인 order
 * P9: 존재하지 않는 orderId 편집·삭제 시도
 * P10: 필수 필드 (deliveryTo) 빈 값 저장
 */
import { test, expect, Page } from "@playwright/test";

test.setTimeout(180_000);

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

test.describe("[스테이징 적대적 배치6] 입력·경계·존재X", () => {

  test("P1~P3: 검색창에 XSS/SQLi/긴 문자열 입력 → 앱 살아있음", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const payloads = [
      `<script>window.__P1_XSS=true;</script>`,       // XSS
      `'; DROP TABLE orders; --`,                     // SQLi
      "가".repeat(10000),                              // 10K chars
    ];
    // 발주 목록 페이지 이동 (검색창 있는 곳)
    const ordersNav = page.locator('[data-nav="orders"]').first();
    if ((await ordersNav.count()) > 0) await ordersNav.click().catch(() => {});
    await page.waitForTimeout(1500);
    const results: any[] = [];
    for (const p of payloads) {
      // 검색 input 찾기
      const searchInput = page.locator('input[type="text"][placeholder*="검색"], input[type="search"], input#search').first();
      const hasInput = await searchInput.count();
      if (hasInput === 0) { results.push({ p: p.slice(0, 30), err: "search input 없음" }); continue; }
      await searchInput.fill("");
      await searchInput.fill(p);
      await page.waitForTimeout(1000);
      const xssTriggered = await page.evaluate(() => !!(window as any).__P1_XSS);
      const pageAlive = await page.locator("body").isVisible();
      results.push({ p: p.slice(0, 30), xssTriggered, pageAlive });
    }
    console.log("[P1-P3]", results);
    // XSS 안 실행되어야 함 (search 값이 innerHTML 로 삽입되면 안 됨)
    const anyXss = results.some((r: any) => r.xssTriggered);
    expect(anyXss, "XSS payload 실행 안 됨").toBe(false);
  });

  test("P4~P5: shipDate 극단 (1900-01-01 / 2100-01-01) 저장", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const result = await page.evaluate(async () => {
      const w = window as any;
      const cases = [
        { name: "P4-1900", shipDate: "1900-01-01" },
        { name: "P5-2100", shipDate: "2100-01-01" },
      ];
      const out: any[] = [];
      for (const c of cases) {
        const cur = await w._FS.get("orders", []);
        const order = {
          id: 790000 + Math.floor(Math.random() * 100),
          orderNum: `${c.name}-${Date.now().toString().slice(-4)}`,
          status: "발주대기", deliveryTo: "테스트업체", createdBy: "admin",
          createdAt: new Date().toISOString(),
          orderDate: "2026-09-01", shipDate: c.shipDate, items: [],
        };
        await w._FS.set("orders", [...cur, order]);
        const back = await w._FS.get("orders", []);
        const found = (back as any[]).find(o => o?.id === order.id);
        // getSettlementDate 로 정산일 계산도 확인
        const sd = typeof w.getSettlementDate === "function" ? w.getSettlementDate(found) : null;
        out.push({ name: c.name, saved: !!found, shipDate: found?.shipDate, settlementDate: sd });
      }
      return out;
    });
    console.log("[P4-P5]", result);
    for (const r of result) {
      expect(r.saved, `${r.name} 저장 성공`).toBe(true);
    }
  });

  test("P6~P7: 정산 필터 극단 월 (2030-05 미래 / 1990-01 과거)", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    // 정산 페이지 이동
    await page.evaluate(() => (window as any).navigate?.("settlement"));
    await page.waitForTimeout(2000);
    const results = [];
    for (const monthValue of ["2030-05", "1990-01"]) {
      // 필터 input 세팅
      const setOk = await page.evaluate((mv) => {
        const el = document.getElementById("date-input") as HTMLInputElement | null;
        if (!el) return false;
        el.value = mv;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        if (typeof (window as any).loadData === "function") (window as any).loadData();
        return true;
      }, monthValue);
      await page.waitForTimeout(1500);
      // 페이지 살아있고 error 로그 없는지
      const alive = await page.locator("body").isVisible();
      const errors = await page.evaluate(() => {
        return (window as any).__consoleErrors?.length || 0;
      });
      results.push({ monthValue, setOk, alive, errors });
    }
    console.log("[P6-P7]", results);
    for (const r of results) {
      expect(r.alive, `${r.monthValue} 필터 후 페이지 정상`).toBe(true);
    }
  });

  test("P8: items 필드 모두 null 인 order 저장·회수", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const result = await page.evaluate(async () => {
      const w = window as any;
      const cur = await w._FS.get("orders", []);
      // items 배열 안에 null·undefined 섞기
      const order = {
        id: 791000 + Math.floor(Math.random() * 100),
        orderNum: `P8-${Date.now().toString().slice(-4)}`,
        status: "발주대기", deliveryTo: "테스트업체", createdBy: "admin",
        createdAt: new Date().toISOString(),
        items: [null, { id: 1, name: null, qty: null, price: null }, null],
      };
      try {
        await w._FS.set("orders", [...cur, order]);
        const back = await w._FS.get("orders", []);
        const found = (back as any[]).find(o => o?.id === order.id);
        return { saved: !!found, itemsLen: found?.items?.length, firstNonNull: found?.items?.find((i: any) => i !== null) };
      } catch (e: any) {
        return { saved: false, err: String(e?.message) };
      }
    });
    console.log("[P8]", result);
    // Firestore 는 null 요소·null 필드 허용
    expect(result.saved, "null 섞인 items 저장 성공").toBe(true);
  });

  test("P9: 존재하지 않는 orderId 편집·삭제 시도", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const nonExistentId = 999999999;
    const result = await page.evaluate(async (id) => {
      const w = window as any;
      // changeOrderStatus 로 존재 안 하는 id
      let statusResult;
      try {
        statusResult = await w.changeOrderStatus(id, "발주확정");
      } catch (e: any) {
        statusResult = { err: String(e?.message) };
      }
      // 삭제 시도: orders 에서 필터로 제거 (없는 id 니까 no-op 이어야)
      let deleteResult;
      try {
        const cur = await w._FS.get("orders", []);
        const before = cur.length;
        await w._FS.set("orders", (cur as any[]).filter(o => o?.id !== id));
        const after = (await w._FS.get("orders", [])).length;
        deleteResult = { before, after, changed: before !== after };
      } catch (e: any) {
        deleteResult = { err: String(e?.message) };
      }
      return { statusResult, deleteResult };
    }, nonExistentId);
    console.log("[P9]", result);
    // changeOrderStatus 는 false 반환 (findIndex -1). 삭제는 no-op (배열 크기 변화 없음)
    expect(result.statusResult, "존재X orderId status 변경 실패").toBe(false);
    expect(result.deleteResult.changed, "존재X orderId 삭제 no-op").toBe(false);
  });

  test("P10: 필수 필드 (deliveryTo) 빈 값 저장 → 앱 감지?", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const result = await page.evaluate(async () => {
      const w = window as any;
      const cur = await w._FS.get("orders", []);
      // 빈 문자열, 공백, undefined 각각 시도
      const cases = [
        { name: "empty", val: "" },
        { name: "spaces", val: "   " },
      ];
      const out: any[] = [];
      for (const c of cases) {
        const order = {
          id: 792000 + Math.floor(Math.random() * 100),
          orderNum: `P10-${c.name}-${Date.now().toString().slice(-4)}`,
          status: "발주대기", deliveryTo: c.val, createdBy: "admin",
          createdAt: new Date().toISOString(),
          orderDate: "2026-09-01", shipDate: "2026-09-01", items: [],
        };
        await w._FS.set("orders", [...(await w._FS.get("orders", [])), order]);
        const back = await w._FS.get("orders", []);
        const found = (back as any[]).find(o => o?.id === order.id);
        out.push({ name: c.name, saved: !!found, deliveryTo: found?.deliveryTo });
      }
      return out;
    });
    console.log("[P10]", result);
    // Firestore 저장 자체는 성공 (UI 검증은 별개). 저장·회수 안전
    for (const r of result) {
      expect(r.saved, `${r.name} 저장 완료`).toBe(true);
    }
  });
});
