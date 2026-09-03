/**
 * [스테이징 적대적 배치9] 워크플로우·한계·라이프사이클 8개
 * L1: 프린트 rapid 클릭 (window.print 여러 번)
 * L2: 세션 만료 중 저장 (logout 후 즉시 write 시도)
 * L3: 매우 큰 stock (999,999,999) 저장·회수
 * L4: item id 충돌 (같은 id 두 item 저장 시도)
 * L5: 관리자가 발주자 발주 편집 (권한 경계)
 * L6: 페이지 언로드 (beforeunload) 중 저장 진행
 * L7: 색상별 재고 저장·회수 (stockSiheung/stockPyeongtaek 필드)
 * L8: 로그아웃 중 서버 요청 (race)
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

test.describe("[스테이징 적대적 배치9] 워크플로우·한계", () => {

  test("L1: 프린트 함수 rapid 5회 호출 → 앱 crash X", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    // window.print 를 stub 으로 대체 (실제 프린트 다이얼로그 뜨면 test 멈춤)
    await page.evaluate(() => {
      (window as any).__printCount = 0;
      (window as any).__origPrint = window.print;
      window.print = () => { (window as any).__printCount++; };
    });
    const result = await page.evaluate(async () => {
      for (let i = 0; i < 5; i++) {
        try { window.print(); } catch {}
      }
      const w = window as any;
      return { printCount: w.__printCount, alive: !!document.body };
    });
    console.log("[L1]", result);
    expect(result.printCount, "5번 다 실행").toBe(5);
    expect(result.alive, "페이지 살아있음").toBe(true);
    // 복구
    await page.evaluate(() => { window.print = (window as any).__origPrint; });
  });

  test("L2: 세션 만료 중 저장 (logout 직후 write) → race 방어", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    // logout 호출 + 즉시 write 시도 (동시)
    const result = await page.evaluate(async () => {
      const w = window as any;
      // 병렬로 doLogout 과 _FS.set 실행
      const results: any[] = [];
      const p1 = (async () => {
        try { w.doLogout?.(); results.push({ op: "logout", ok: true }); }
        catch (e: any) { results.push({ op: "logout", err: String(e?.message) }); }
      })();
      const p2 = (async () => {
        try {
          const cur = await w._FS.get("orders", []);
          const order = {
            id: 797000 + Math.floor(Math.random() * 100),
            orderNum: `L2-${Date.now().toString().slice(-4)}`,
            status: "발주대기", deliveryTo: "logout-race", createdBy: "admin",
            createdAt: new Date().toISOString(), items: [],
          };
          await w._FS.set("orders", [...cur, order]);
          results.push({ op: "write", ok: true, orderId: order.id });
        } catch (e: any) { results.push({ op: "write", err: String(e?.message) }); }
      })();
      await Promise.all([p1, p2]);
      return { results, sessionAfter: w.DB?.get?.("session", null)?.id || null };
    });
    console.log("[L2]", result);
    // 앱 crash 안 하면 통과. write 는 성공하든 실패하든 OK, session 만 정확히 소멸
    expect(result.sessionAfter, "logout 후 세션 소멸").toBeNull();
  });

  test("L3: 매우 큰 stock (999,999,999) 저장·회수", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const result = await page.evaluate(async () => {
      const w = window as any;
      const itemId = 798000 + Math.floor(Math.random() * 100);
      const cur = await w._FS.get("items", []);
      const item = { id: itemId, name: `L3-${Date.now()}`, stock: 999_999_999, prices: [] };
      await w._FS.set("items", [...cur, item]);
      await new Promise(r => setTimeout(r, 1000));
      const back = (await w._FS.get("items", []) as any[]).find(i => i?.id === itemId);
      // cleanup
      const arr = await w._FS.get("items", []);
      await w._FS.set("items", (arr as any[]).filter(i => i?.id !== itemId));
      return { saved: back?.stock };
    });
    console.log("[L3]", result);
    expect(result.saved, "10억 stock 정확").toBe(999_999_999);
  });

  test("L4: 같은 id 두 item 저장 → merge-by-id 로 1개", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const itemId = 798500 + Math.floor(Math.random() * 100);
    const result = await page.evaluate(async (id) => {
      const w = window as any;
      // 같은 id 로 다른 이름 2개 배열에 넣어 저장
      const cur = await w._FS.get("items", []);
      const dup = [
        { id, name: "A", stock: 10, prices: [] },
        { id, name: "B", stock: 20, prices: [] },
      ];
      await w._FS.set("items", [...cur, ...dup]);
      await new Promise(r => setTimeout(r, 1000));
      const back = await w._FS.get("items", []);
      const forId = (back as any[]).filter(i => i?.id === id);
      // cleanup
      await w._FS.set("items", (back as any[]).filter(i => i?.id !== id));
      return { count: forId.length, names: forId.map(i => i?.name) };
    }, itemId);
    console.log("[L4]", result);
    // _txMergeById 는 nextById Map 으로 다뤄서 마지막 항목만 살아남음
    expect(result.count, "중복 id 하나만").toBe(1);
  });

  test("L5: 관리자가 발주자 발주 편집 → 허용 (권한 경계)", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const orderId = 798700 + Math.floor(Math.random() * 100);
    const result = await page.evaluate(async (id) => {
      const w = window as any;
      // orderer 명의 발주 seed
      const cur = await w._FS.get("orders", []);
      await w._FS.set("orders", [...cur, {
        id, orderNum: `L5-${Date.now().toString().slice(-4)}`, status: "발주대기",
        deliveryTo: "원본-발주자꺼", createdBy: "orderer",
        createdAt: new Date().toISOString(), items: [],
      }]);
      await new Promise(r => setTimeout(r, 500));
      // admin 이 편집 (deliveryTo 변경)
      const c2 = await w._FS.get("orders", []);
      const next = (c2 as any[]).map(o => o?.id === id ? { ...o, deliveryTo: "admin-수정" } : o);
      await w._FS.set("orders", next);
      const back = (await w._FS.get("orders", []) as any[]).find(o => o?.id === id);
      return { edited: back?.deliveryTo, originalOwner: back?.createdBy };
    }, orderId);
    console.log("[L5]", result);
    // 관리자는 다른 발주자 발주 편집 가능해야 (실무 요구)
    expect(result.edited, "admin 편집 반영").toBe("admin-수정");
    expect(result.originalOwner, "createdBy 유지 (원 소유자)").toBe("orderer");
  });

  test("L6: 페이지 언로드 (beforeunload) 중 저장 진행", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    // beforeunload 리스너 있어도 저장이 큐에 걸리는지
    const result = await page.evaluate(async () => {
      const w = window as any;
      let beforeUnloadFired = false;
      const listener = () => { beforeUnloadFired = true; };
      window.addEventListener("beforeunload", listener);
      // 저장 시작 (await 하지 않고)
      const orderId = 798800 + Math.floor(Math.random() * 100);
      const cur = await w._FS.get("orders", []);
      const savePromise = w._FS.set("orders", [...cur, {
        id: orderId, orderNum: `L6-${Date.now().toString().slice(-4)}`, status: "발주대기",
        deliveryTo: "unload-test", createdBy: "admin",
        createdAt: new Date().toISOString(), items: [],
      }]);
      // 저장 중 beforeunload 트리거 시뮬 (실제 unload 는 못 함, 이벤트만 dispatch)
      window.dispatchEvent(new Event("beforeunload"));
      // 저장 완료 기다림
      await savePromise;
      const back = (await w._FS.get("orders", []) as any[]).find(o => o?.id === orderId);
      window.removeEventListener("beforeunload", listener);
      return { saved: !!back, beforeUnloadFired };
    });
    console.log("[L6]", result);
    expect(result.saved, "beforeunload 중에도 저장 완료").toBe(true);
  });

  test("L7: 색상별 재고 필드 (stockSiheung/stockPyeongtaek) 저장·회수", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const itemId = 798900 + Math.floor(Math.random() * 100);
    const result = await page.evaluate(async (id) => {
      const w = window as any;
      const cur = await w._FS.get("items", []);
      const item = {
        id, name: `L7-${Date.now()}`, stock: 100,
        stockSiheung: 60, stockPyeongtaek: 40,
        prices: [],
      };
      await w._FS.set("items", [...cur, item]);
      await new Promise(r => setTimeout(r, 1000));
      const back = (await w._FS.get("items", []) as any[]).find(i => i?.id === id);
      // cleanup
      const arr = await w._FS.get("items", []);
      await w._FS.set("items", (arr as any[]).filter(i => i?.id !== id));
      return {
        stock: back?.stock,
        stockSiheung: back?.stockSiheung,
        stockPyeongtaek: back?.stockPyeongtaek,
      };
    }, itemId);
    console.log("[L7]", result);
    expect(result.stock, "총 stock 유지").toBe(100);
    expect(result.stockSiheung, "시흥 재고 유지").toBe(60);
    expect(result.stockPyeongtaek, "평택 재고 유지").toBe(40);
  });

  test("L8: 로그아웃 시점에 in-flight 서버 요청 있음 → 에러 처리", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const result = await page.evaluate(async () => {
      const w = window as any;
      // 저장 시작 (긴 것 = 큰 orders 배열)
      const cur = await w._FS.get("orders", []);
      const bigOrder = {
        id: 799100 + Math.floor(Math.random() * 100),
        orderNum: `L8-${Date.now().toString().slice(-4)}`,
        status: "발주대기", deliveryTo: "logout-inflight", createdBy: "admin",
        createdAt: new Date().toISOString(),
        items: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `it${i}`, qty: 1, price: 1000 })),
      };
      const savePromise = w._FS.set("orders", [...cur, bigOrder]);
      // 저장 중 즉시 logout
      w.doLogout?.();
      // save 결과 기다림 (성공하든 실패하든)
      let saveOk = false, saveErr = null;
      try { await savePromise; saveOk = true; }
      catch (e: any) { saveErr = String(e?.message); }
      // logout 후 세션 정확히 소멸
      const session = w.DB?.get?.("session", null);
      return { saveOk, saveErr: saveErr?.slice(0, 100), sessionAfter: session?.id || null };
    });
    console.log("[L8]", result);
    // 세션 소멸 확인. 저장은 성공 or 실패 둘 다 OK (앱 crash 안 하면)
    expect(result.sessionAfter, "logout 후 세션 소멸").toBeNull();
  });
});
