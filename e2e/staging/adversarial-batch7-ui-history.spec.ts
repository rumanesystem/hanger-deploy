/**
 * [스테이징 적대적 배치7] UI·히스토리·window 조작 4개
 * U1: 재고 조정 rapid 클릭 (같은 item 여러 번 조정)
 * U2: 발주 삭제 → 복원 → 삭제 → 복원 극단 사이클 (S4 재확인)
 * U3: 브라우저 뒤로가기·앞으로가기 반복 (히스토리 스팸)
 * U4: window.opener / postMessage 조작 시도
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

test.describe("[스테이징 적대적 배치7] UI·히스토리·window", () => {

  test("U1: 재고 조정 rapid 5회 같은 item → 최종값 예상대로 (조정 20씩 5번=+100)", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    // 대상 item 확보
    const target = await page.evaluate(() => {
      const items = (window as any).DB.get("items", []);
      const first = Array.isArray(items) ? items[0] : null;
      return first ? { id: first.id, origStock: first.stock || 0 } : null;
    });
    if (!target) { test.skip(); return; }
    console.log(`[U1] target id=${target.id}, origStock=${target.origStock}`);

    // 순차 rapid: stock 을 20씩 5번 증가 (writes 큐잉 직렬화 확인)
    const result = await page.evaluate(async (t) => {
      const w = window as any;
      const target = 20;
      const N = 5;
      const results: any[] = [];
      for (let i = 0; i < N; i++) {
        try {
          const cur = await w._FS.get("items", []);
          const next = (cur as any[]).map(it => it?.id === t.id ? { ...it, stock: (it.stock || 0) + target } : it);
          await w._FS.set("items", next);
          results.push({ i, ok: true });
        } catch (e: any) { results.push({ i, err: String(e?.message) }); }
      }
      await new Promise(r => setTimeout(r, 1500));
      const final = (await w._FS.get("items", []) as any[]).find(i => i?.id === t.id);
      return { results, finalStock: final?.stock, expected: t.origStock + target * N };
    }, target);
    console.log("[U1]", result);
    expect(result.finalStock, "rapid 5회 조정 최종값 정확").toBe(result.expected);
    // 원상복구
    await page.evaluate(async (t) => {
      const w = window as any;
      const cur = await w._FS.get("items", []);
      const next = (cur as any[]).map(it => it?.id === t.id ? { ...it, stock: t.origStock } : it);
      await w._FS.set("items", next);
    }, target);
  });

  test("U2: 발주 삭제→복원 극단 사이클 5회 (S4 재확인)", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const orderId = 793000 + Math.floor(Math.random() * 100);
    const result = await page.evaluate(async (id) => {
      const w = window as any;
      // 원본 저장
      const cur0 = await w._FS.get("orders", []);
      const orig = { id, orderNum: `U2-${Date.now().toString().slice(-4)}`, status: "발주대기",
        deliveryTo: "테스트업체", createdBy: "admin", createdAt: new Date().toISOString(), items: [] };
      await w._FS.set("orders", [...cur0, orig]);
      // 삭제→복원 5회
      const N = 5;
      for (let i = 0; i < N; i++) {
        // 삭제
        const c1 = await w._FS.get("orders", []);
        await w._FS.set("orders", (c1 as any[]).filter(o => o?.id !== id));
        // 복원
        const c2 = await w._FS.get("orders", []);
        await w._FS.set("orders", [...c2, { ...orig, deliveryTo: `복원${i}` }]);
      }
      const back = await w._FS.get("orders", []);
      const forId = (back as any[]).filter(o => o?.id === id);
      return { count: forId.length, deliveryTo: forId[0]?.deliveryTo };
    }, orderId);
    console.log("[U2]", result);
    expect(result.count, "id 유일").toBe(1);
    expect(result.deliveryTo, "마지막 복원값").toBe("복원4");
  });

  test("U3: 뒤로가기·앞으로가기 반복 (10회 왕복) → 앱 crash X", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    // navigate 로 여러 페이지 이동해서 history 만듦
    for (const nav of ["orders", "settlement", "items", "orders", "settlement"]) {
      await page.evaluate((n) => (window as any).navigate?.(n), nav);
      await page.waitForTimeout(500);
    }
    // 뒤로가기·앞으로가기 10회
    for (let i = 0; i < 10; i++) {
      await page.goBack().catch(() => {});
      await page.waitForTimeout(300);
    }
    for (let i = 0; i < 10; i++) {
      await page.goForward().catch(() => {});
      await page.waitForTimeout(300);
    }
    // 페이지 살아있고 세션 유지
    const state = await page.evaluate(() => {
      const w = window as any;
      return {
        booted: Boolean(w._booted),
        sessionId: w.DB?.get?.("session", null)?.id,
      };
    });
    console.log("[U3]", state);
    expect(state.booted, "부팅 상태 유지").toBe(true);
    expect(state.sessionId, "세션 유지 (admin)").toBe("admin");
  });

  test("U4: window.opener / postMessage 조작 시도 → 앱 방어", async ({ page, context }) => {
    await bootLogin(page, "admin", "admin", "123456");
    // 1) window.opener 조작: 앱이 window.opener 를 신뢰하면 위험
    const openerResult = await page.evaluate(() => {
      // 가짜 opener 세팅 시도
      try {
        // opener 는 read-only 인 경우가 많음
        (window as any).opener = { location: { href: "https://evil.example.com" } };
        return { openerHref: (window as any).opener?.location?.href };
      } catch (e: any) {
        return { err: String(e?.message) };
      }
    });
    console.log("[U4 opener]", openerResult);

    // 2) postMessage 스팸: 앱이 message listener 등록해서 위험 페이로드 처리하는지
    const messageResult = await page.evaluate(() => {
      const received: any[] = [];
      const listener = (e: MessageEvent) => received.push({ data: e.data, origin: e.origin });
      window.addEventListener("message", listener);
      // 앱한테 위험한 메시지 여러 개 보내기
      const payloads = [
        { type: "auth", user: "attacker" },
        { type: "changeStatus", orderId: 999, newStatus: "발주확정" },
        { type: "logout" },
        "<script>alert(1)</script>",
        { __proto__: { admin: true } },
      ];
      for (const p of payloads) {
        window.postMessage(p, "*");
      }
      return new Promise(resolve => setTimeout(() => {
        window.removeEventListener("message", listener);
        // 세션·상태가 변조됐는지
        const w = window as any;
        resolve({
          receivedCount: received.length,
          sessionId: w.DB?.get?.("session", null)?.id,
          isAdmin: typeof w.isAdmin === "function" ? w.isAdmin() : "n/a",
        });
      }, 1000));
    });
    console.log("[U4 message]", messageResult);
    // 앱이 postMessage 로 세션 조작을 받지 않아야 (sessionId 는 admin 그대로)
    expect((messageResult as any).sessionId, "postMessage 로 세션 침범 X").toBe("admin");
  });
});
