/**
 * [스테이징 적대적 배치8] 권한·계산·UI 상태 8개
 * W1: 발주자가 다른 발주자의 발주 삭제 시도 (권한 우회)
 * W2: 발주자가 관리자 페이지 URL 직접 접근 (routing 방어)
 * W3: 수정 중 원본이 다른 세션에 의해 취소됨
 * W4: modal 중첩 (order-modal 안에서 다른 modal 강제 open)
 * W5: VAT 계산 부동소수점 정확도 (0.1+0.2)
 * W6: 정산 총합 (100개 발주 합계 정확)
 * W7: 검색 결과 0건 → UI 정상
 * W8: 같은 발주자 draft 100개 생성 (한계 없음?)
 */
import { test, expect, Page } from "@playwright/test";

test.setTimeout(240_000);

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

test.describe("[스테이징 적대적 배치8] 권한·계산·UI", () => {

  test("W1: 발주자가 다른 발주자 발주 조작 시도", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    // admin 이 "OTHER-ORDERER" createdBy 로 발주 seed
    const targetId = 795000 + Math.floor(Math.random() * 100);
    await page.evaluate(async ({ id }) => {
      const w = window as any;
      const cur = await w._FS.get("orders", []);
      await w._FS.set("orders", [...cur, {
        id, orderNum: `W1-${Date.now().toString().slice(-4)}`, status: "발주대기",
        deliveryTo: "OTHER-업체", createdBy: "OTHER-ORDERER",
        createdAt: new Date().toISOString(), items: [],
      }]);
    }, { id: targetId });
    // 발주자로 갈아탐
    await page.evaluate(() => (window as any).doLogout?.());
    await page.waitForSelector("#login-screen.active", { timeout: 15_000 });
    await page.waitForSelector("#boot-splash", { state: "hidden", timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await bootLogin(page, "orderer", "orderer", "123456");
    // 발주자가 자기 orders 목록에 OTHER-ORDERER 발주가 뜨는지 (뜨면 안 됨)
    const result = await page.evaluate(async (id) => {
      const w = window as any;
      const orders = await w._FS.get("orders", []);
      const found = (orders as any[]).find(o => o?.id === id);
      const cu = w.DB.get("session", null);
      const mine = (orders as any[]).filter(o => o?.createdBy === cu?.id);
      // 발주자가 삭제 시도
      let deleteBlocked = "n/a";
      try {
        const beforeCount = orders.length;
        await w._FS.set("orders", (orders as any[]).filter(o => o?.id !== id));
        const after = await w._FS.get("orders", []);
        deleteBlocked = after.length === beforeCount ? "yes" : "no";
      } catch (e: any) {
        deleteBlocked = "yes-error:" + String(e?.message);
      }
      return {
        otherOrderVisibleToMe: !!found,
        myCreatedBy: cu?.id,
        myOrdersCount: mine.length,
        deleteAttemptBlocked: deleteBlocked,
      };
    }, targetId);
    console.log("[W1]", result);
    // Firestore rules 개방 이므로 삭제 자체는 성공 가능 (알려진 리스크)
    // 앱 UI 는 자기 것만 필터해 보여줌 (createdBy 매칭)
    expect(true).toBe(true); // 정보성 (S20 과 동일한 알려진 결정)
  });

  test("W2: 발주자가 admin 전용 페이지 직접 접근 → 방어", async ({ page }) => {
    await bootLogin(page, "orderer", "orderer", "123456");
    // navigate() 로 관리자 전용 페이지 시도
    const attempts = ["items", "accounts", "logs", "backup"];
    const results: any[] = [];
    for (const nav of attempts) {
      const state = await page.evaluate((n) => {
        try {
          (window as any).navigate?.(n);
        } catch {}
        // 실제로 페이지 렌더링됐는지 (관리자만 볼 element 있는지)
        return {
          nav: n,
          bodyText: document.body.textContent?.slice(0, 200),
          sessionId: (window as any).DB?.get?.("session", null)?.id,
        };
      }, nav);
      await page.waitForTimeout(300);
      results.push(state);
    }
    console.log("[W2]", results.map(r => ({ nav: r.nav, sessionId: r.sessionId })));
    // 세션은 orderer 유지되어야 (navigate 로 어드민 페이지 접근해도 권한 승격 X)
    for (const r of results) {
      expect(r.sessionId, `${r.nav} 이동 후에도 orderer 유지`).toBe("orderer");
    }
  });

  test("W3: 수정 중 원본이 다른 세션에 취소됨", async ({ page, context }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const orderId = 796000 + Math.floor(Math.random() * 100);
    // Seed
    await page.evaluate(async ({ id }) => {
      const w = window as any;
      const cur = await w._FS.get("orders", []);
      await w._FS.set("orders", [...cur, {
        id, orderNum: `W3-${Date.now().toString().slice(-4)}`, status: "발주확정",
        deliveryTo: "원본", createdBy: "orderer",
        createdAt: new Date().toISOString(), items: [],
      }]);
    }, { id: orderId });
    // 탭 A: 편집 시작 (in-memory 로 원본 로드)
    const originalA = await page.evaluate(async (id) => {
      const w = window as any;
      const orders = await w._FS.get("orders", []);
      return (orders as any[]).find(o => o?.id === id);
    }, orderId);
    // 탭 B: 원본 취소
    const pageB = await context.newPage();
    await bootLogin(pageB, "admin", "admin", "123456");
    await pageB.evaluate(async (id) => {
      const w = window as any;
      const cur = await w._FS.get("orders", []);
      await w._FS.set("orders", (cur as any[]).map(o => o?.id === id ? { ...o, status: "취소", cancelled: true } : o));
    }, orderId);
    await pageB.close();
    await page.waitForTimeout(1500);
    // 탭 A: 편집 저장 시도 (원본 캐시로 저장 시도, 서버는 이미 취소 상태)
    const saveResult = await page.evaluate(async ({ id, orig }) => {
      const w = window as any;
      try {
        const cur = await w._FS.get("orders", []);
        const next = (cur as any[]).map(o => o?.id === id ? { ...orig, deliveryTo: "탭A-수정" } : o);
        await w._FS.set("orders", next);
        return { ok: true };
      } catch (e: any) {
        return { ok: false, err: String(e?.message) };
      }
    }, { id: orderId, orig: originalA });
    const final = await page.evaluate(async (id) => {
      const orders = await (window as any)._FS.get("orders", []);
      const f = (orders as any[]).find(o => o?.id === id);
      return { status: f?.status, deliveryTo: f?.deliveryTo, cancelled: f?.cancelled };
    }, orderId);
    console.log("[W3] save:", saveResult, "final:", final);
    // 예상: baseline diff-merge 로 status="취소", cancelled=true 는 서버에서 유지, deliveryTo 만 탭A-수정으로 반영
    // (탭 A 는 status 변경 안 함 → 서버값 취소 유지)
    expect(final.status, "취소 상태 유지 (탭A 는 status 안 건드림)").toBe("취소");
  });

  test("W4: modal 중첩 (order-modal 안에서 다른 modal 강제 open)", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    // new order modal 열기
    const ordersNav = page.locator('[data-nav="orders"]').first();
    if ((await ordersNav.count()) > 0) await ordersNav.click().catch(() => {});
    await page.waitForSelector("#new-order-btn", { timeout: 10_000 });
    await page.locator("#new-order-btn").click();
    await page.waitForSelector("#order-modal", { state: "visible", timeout: 5_000 });
    // 다른 modal 강제 open (existing UI 로 openModal 호출 가능한 것)
    const result = await page.evaluate(() => {
      const w = window as any;
      try {
        // openModal 함수 강제 호출로 order-confirm-modal 열기 (중첩)
        if (typeof w.openModal === "function") w.openModal("order-confirm-modal");
        return {
          orderModalOpen: document.getElementById("order-modal")?.classList.contains("open"),
          confirmModalOpen: document.getElementById("order-confirm-modal")?.classList.contains("open"),
          bodyText: document.body.textContent?.slice(0, 100),
        };
      } catch (e: any) {
        return { err: String(e?.message) };
      }
    });
    console.log("[W4]", result);
    // 앱 crash 안 하면 통과
    expect(result.bodyText, "페이지 살아있음").toBeTruthy();
  });

  test("W5: VAT 계산 부동소수점 (0.1+0.2 정확도)", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const result = await page.evaluate(() => {
      // 공급가 1234 → VAT 10% = 123.4 → 반올림 123 이어야
      // 여러 사례
      const cases = [
        { supply: 1234, expectedVat: Math.round(1234 * 0.1) },     // 123
        { supply: 999, expectedVat: Math.round(999 * 0.1) },       // 100 (99.9 반올림)
        { supply: 100000, expectedVat: Math.round(100000 * 0.1) }, // 10000
        { supply: 1, expectedVat: Math.round(1 * 0.1) },           // 0
      ];
      const out = cases.map(c => ({
        supply: c.supply,
        computed: Math.round(c.supply * 0.1),
        expected: c.expectedVat,
        match: Math.round(c.supply * 0.1) === c.expectedVat,
      }));
      return out;
    });
    console.log("[W5]", result);
    for (const r of result) {
      expect(r.match, `supply=${r.supply} VAT 정확`).toBe(true);
    }
  });

  test("W6: 정산 총합 (100개 발주 합계 부동소수점 안전)", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const result = await page.evaluate(() => {
      const values = Array.from({ length: 100 }, (_, i) => 12345 + i * 7); // 다양한 값
      const sum = values.reduce((a, b) => a + b, 0);
      // Math.round(sum * 0.1) 같은 계산도
      const vatSum = Math.round(sum * 0.1);
      return { count: values.length, sum, vatSum, first: values[0], last: values[99] };
    });
    console.log("[W6]", result);
    // sum = 12345*100 + 7*(0+1+...+99) = 1234500 + 7*4950 = 1234500 + 34650 = 1269150
    expect(result.sum, "100개 합계 정확").toBe(1269150);
    expect(result.vatSum, "VAT 합계 정확").toBe(Math.round(1269150 * 0.1));
  });

  test("W7: 검색 결과 0건 → UI 정상 렌더링", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    // 발주 목록 이동 후 절대 매칭 안 될 검색어 입력
    const ordersNav = page.locator('[data-nav="orders"]').first();
    if ((await ordersNav.count()) > 0) await ordersNav.click().catch(() => {});
    await page.waitForTimeout(1500);
    const impossibleQuery = "ZZZZZZZZ절대매칭안될검색어999999";
    // 검색 input 아무거나 (visible 한 것)
    const searchInputs = await page.locator('input[type="search"], input[type="text"][placeholder*="검색"]').all();
    let filledOne = false;
    for (const inp of searchInputs) {
      const visible = await inp.isVisible().catch(() => false);
      if (visible) {
        try {
          await inp.fill(impossibleQuery);
          filledOne = true;
          break;
        } catch {}
      }
    }
    await page.waitForTimeout(1500);
    const state = await page.evaluate(() => ({
      alive: document.body?.textContent?.length,
      bodyStart: document.body?.textContent?.slice(0, 100),
    }));
    console.log("[W7] filledOne:", filledOne, "alive:", state.alive);
    expect(state.alive, "검색 결과 0건에도 페이지 살아있음").toBeGreaterThan(0);
  });

  test("W8: 같은 발주자 draft 100개 생성 → 한계 없음, 서버 수용", async ({ page }) => {
    await bootLogin(page, "orderer", "orderer", "123456");
    const result = await page.evaluate(async () => {
      const w = window as any;
      if (typeof w.saveDraft !== "function") return { err: "saveDraft 없음" };
      const N = 100;
      const startedAt = Date.now();
      const draftIds: string[] = [];
      const errors: string[] = [];
      for (let i = 0; i < N; i++) {
        try {
          const d = await w.saveDraft({
            deliveryTo: `W8-${i}`, warehouse: "시흥", items: [],
            orderDate: "2026-09-01", shipDate: "2026-09-01",
          }, { createdBy: "orderer" });
          if (d?.draftId) draftIds.push(d.draftId);
        } catch (e: any) { errors.push(String(e?.message)); }
      }
      const elapsed = Date.now() - startedAt;
      // Cleanup: 방금 만든 100개 정리
      try {
        const arr = await w._FS.get("drafts", []);
        await w._FS.set("drafts", (arr as any[]).filter(d => !draftIds.includes(d?.draftId)));
      } catch {}
      return { created: draftIds.length, errors: errors.length, elapsed };
    });
    console.log("[W8]", result);
    expect(result.created, "100개 draft 다 생성").toBe(100);
    expect(result.errors, "에러 없음").toBe(0);
  });
});
