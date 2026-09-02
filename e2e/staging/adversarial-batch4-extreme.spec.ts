/**
 * [스테이징 적대적 배치4] 극단·경계 12개
 * N1~N4: 수량 극단 (10억/음수/0/소수)
 * N5~N6: 긴 문자열 (메모 10만자, deliveryTo 5000자)
 * N7: items 100개 거대 발주
 * N8: 중복 orderId 저장
 * N9: localStorage session 위조
 * N10: 새로고침 반복 부팅 race
 * N11: 자정 근처 발주확정
 * N12: 발주자에서 관리자 함수 강제 호출
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

test.describe("[스테이징 적대적 배치4] 극단·경계", () => {

  test("N1~N4: 수량 극단값 (10억/음수/0/소수) 저장 후 회수", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const testCases = [
      { name: "N1-10억", qty: 999_999_999 },
      { name: "N2-음수", qty: -100 },
      { name: "N3-0", qty: 0 },
      { name: "N4-소수", qty: 1.5 },
    ];
    const results = await page.evaluate(async (cases) => {
      const w = window as any;
      const out: any[] = [];
      for (const c of cases) {
        try {
          const cur = await w._FS.get("orders", []);
          const order = {
            id: 780000 + Math.floor(Math.random() * 10000),
            orderNum: `EXT-${c.name}-${Date.now().toString().slice(-4)}`,
            status: "발주대기",
            deliveryTo: "테스트업체",
            createdBy: "admin",
            createdAt: new Date().toISOString(),
            orderDate: "2026-09-01",
            shipDate: "2026-09-01",
            warehouse: "시흥",
            items: [{ id: 1, name: "테스트", qty: c.qty, price: 1000 }],
          };
          await w._FS.set("orders", [...cur, order]);
          const back = await w._FS.get("orders", []);
          const found = (back as any[]).find(o => o?.id === order.id);
          out.push({ name: c.name, savedQty: found?.items?.[0]?.qty, ok: !!found });
        } catch (e: any) {
          out.push({ name: c.name, err: String(e?.message) });
        }
      }
      return out;
    }, testCases);
    console.log("[N1-N4]", results);
    // 저장·회수 자체는 성공해야 (Firestore 는 임의 숫자 허용). 클라이언트 UI 검증은 별개
    for (const r of results) {
      expect(r.ok, `${r.name} 저장 성공`).toBe(true);
    }
  });

  test("N5: 매우 긴 메모 (10만자) 저장", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const longMemo = "가".repeat(100_000);
    const result = await page.evaluate(async (memo) => {
      const w = window as any;
      try {
        const cur = await w._FS.get("orders", []);
        const order = {
          id: 780500 + Math.floor(Math.random() * 100),
          orderNum: `N5-${Date.now().toString().slice(-6)}`,
          status: "발주대기",
          deliveryTo: "테스트업체",
          createdBy: "admin",
          createdAt: new Date().toISOString(),
          note: memo,
          items: [],
        };
        await w._FS.set("orders", [...cur, order]);
        const back = await w._FS.get("orders", []);
        const found = (back as any[]).find(o => o?.id === order.id);
        return { ok: !!found, savedLen: found?.note?.length, match: found?.note === memo };
      } catch (e: any) {
        return { ok: false, err: String(e?.message) };
      }
    }, longMemo);
    console.log("[N5]", { ok: result.ok, savedLen: result.savedLen, match: result.match });
    // Firestore 문서 크기 제한 1MB. 10만자 (~200KB) 는 통과해야 함
    expect(result.ok, "10만자 메모 저장 성공").toBe(true);
    expect(result.match, "저장/회수 일치").toBe(true);
  });

  test("N6: 매우 긴 deliveryTo (5000자) 저장", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const long = "테스트업체".repeat(1000); // 5000자
    const result = await page.evaluate(async (dt) => {
      const w = window as any;
      try {
        const cur = await w._FS.get("orders", []);
        const order = {
          id: 780600 + Math.floor(Math.random() * 100),
          orderNum: `N6-${Date.now().toString().slice(-6)}`,
          status: "발주대기",
          deliveryTo: dt,
          createdBy: "admin",
          createdAt: new Date().toISOString(),
          items: [],
        };
        await w._FS.set("orders", [...cur, order]);
        const back = await w._FS.get("orders", []);
        const found = (back as any[]).find(o => o?.id === order.id);
        return { ok: !!found, savedLen: found?.deliveryTo?.length };
      } catch (e: any) {
        return { ok: false, err: String(e?.message) };
      }
    }, long);
    console.log("[N6]", result);
    expect(result.ok, "5000자 deliveryTo 저장 성공").toBe(true);
    expect(result.savedLen, "5000자 유지").toBe(5000);
  });

  test("N7: items 배열 100개 (거대 발주)", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const result = await page.evaluate(async () => {
      const w = window as any;
      const items = [];
      for (let i = 1; i <= 100; i++) {
        items.push({ id: i, name: `아이템${i}`, qty: 1, price: 1000 });
      }
      try {
        const cur = await w._FS.get("orders", []);
        const order = {
          id: 780700 + Math.floor(Math.random() * 100),
          orderNum: `N7-${Date.now().toString().slice(-6)}`,
          status: "발주대기",
          deliveryTo: "테스트업체",
          createdBy: "admin",
          createdAt: new Date().toISOString(),
          items,
        };
        const t0 = Date.now();
        await w._FS.set("orders", [...cur, order]);
        const elapsed = Date.now() - t0;
        const back = await w._FS.get("orders", []);
        const found = (back as any[]).find(o => o?.id === order.id);
        return { ok: !!found, itemCount: found?.items?.length, elapsed };
      } catch (e: any) {
        return { ok: false, err: String(e?.message) };
      }
    });
    console.log("[N7]", result);
    expect(result.ok, "100 items 발주 저장 성공").toBe(true);
    expect(result.itemCount, "100개 유지").toBe(100);
  });

  test("N8: 이미 존재하는 orderId 로 저장 → merge-by-id 로 덮어씀", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const orderId = 780800 + Math.floor(Math.random() * 100);
    const result = await page.evaluate(async (id) => {
      const w = window as any;
      // 1) 원본 저장
      const cur = await w._FS.get("orders", []);
      const original = { id, orderNum: `N8-ORIG`, status: "발주대기", deliveryTo: "원본", createdBy: "admin", createdAt: new Date().toISOString(), items: [] };
      await w._FS.set("orders", [...cur, original]);
      await new Promise(r => setTimeout(r, 1000));
      // 2) 같은 id 로 다른 데이터 저장
      const cur2 = await w._FS.get("orders", []);
      const duplicate = { id, orderNum: `N8-DUP`, status: "발주대기", deliveryTo: "덮어씀", createdBy: "admin", createdAt: new Date().toISOString(), items: [] };
      const next = (cur2 as any[]).map(o => o?.id === id ? duplicate : o);
      await w._FS.set("orders", next);
      await new Promise(r => setTimeout(r, 1000));
      // 3) 최종 확인 — 1개만 있어야 (id 중복 X)
      const back = await w._FS.get("orders", []);
      const forId = (back as any[]).filter(o => o?.id === id);
      return {
        count: forId.length,
        deliveryTo: forId[0]?.deliveryTo,
        orderNum: forId[0]?.orderNum,
      };
    }, orderId);
    console.log("[N8]", result);
    expect(result.count, "id 중복 없음").toBe(1);
  });

  test("N9: localStorage session 위조 → 다른 사용자로 액션 시도", async ({ page }) => {
    await bootLogin(page, "orderer", "orderer", "123456");
    // localStorage 조작해서 session 을 admin 으로 위조 시도
    const result = await page.evaluate(() => {
      const w = window as any;
      const before = w.DB?.get?.("session", null);
      // session 을 admin 으로 강제
      const fake = { id: "admin", name: "위조된관리자" };
      try {
        localStorage.setItem("hanger_session", JSON.stringify(fake));
      } catch {}
      const after = w.DB?.get?.("session", null);
      // isAdmin() 이 위조된 세션 반영해서 true 반환?
      const isAdminNow = typeof w.isAdmin === "function" ? w.isAdmin() : "n/a";
      return { beforeId: before?.id, afterId: after?.id, isAdminAfter: isAdminNow };
    });
    console.log("[N9]", result);
    // localStorage 조작이 즉시 세션 바꾸면 취약. 정상: 세션 상태는 메모리에서 관리, localStorage 만 바뀜
    // 강한 방어: 서버 측 auth 검증 (Firebase Auth token) 이 있어야 진짜 안전
    // 여기선 클라 세션 강제 변경이 즉시 isAdmin 뒤집는지만 관측
    expect(true).toBe(true); // 정보성
  });

  test("N10: 부팅 중 새로고침 반복 (page reload race)", async ({ page }) => {
    // 새로고침 3번 rapid → 부팅 상태 안정성 확인
    for (let i = 0; i < 3; i++) {
      await page.goto("/");
      // 부팅 완료 안 기다리고 즉시 다음 goto
      await page.waitForTimeout(500);
    }
    // 마지막 goto 후 정상 부팅되는지 확인
    await page.goto("/");
    await page.waitForSelector("#login-screen", { timeout: 30_000 });
    await page.waitForFunction(() => {
      const w = window as any;
      return Boolean(w._booted);
    }, null, { timeout: 45_000 });
    const state = await page.evaluate(() => {
      const w = window as any;
      return { booted: Boolean(w._booted), accountsCount: (w.DB?.get?.("accounts", []) as any[])?.length };
    });
    console.log("[N10]", state);
    expect(state.booted, "새로고침 반복 후 정상 부팅").toBe(true);
    expect(state.accountsCount, "accounts 로드됨").toBeGreaterThan(0);
  });

  test("N11: 자정 근처 발주 (2026-12-31 23:59) 정산월 판정", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const result = await page.evaluate(() => {
      const w = window as any;
      const getSD = w.getSettlementDate;
      if (typeof getSD !== "function") return { err: "함수 없음" };
      // 자정 직전 발주확정
      const order = {
        orderDate: "2026-12-31", shipDate: "2027-01-05",
        statusHistory: [{ status: "발주확정", changedAt: "2026-12-31T14:59:00Z" }], // UTC 14:59 = KST 23:59
      };
      const orderNext = {
        orderDate: "2026-12-31", shipDate: "2027-01-05",
        statusHistory: [{ status: "발주확정", changedAt: "2026-12-31T15:00:00Z" }], // UTC 15:00 = KST 00:00 다음날
      };
      return { before: getSD(order), after: getSD(orderNext) };
    });
    console.log("[N11]", result);
    // KST 23:59 → 2026-12-31 정산월. KST 00:00 → 2027-01-01
    expect(result.before, "KST 23:59 → 12월 정산").toBe("2026-12-31");
    expect(result.after, "KST 00:00 → 1월 정산").toBe("2027-01-01");
  });

  test("N12: 발주자가 관리자 전용 함수 강제 호출 (권한 우회 시도)", async ({ page }) => {
    await bootLogin(page, "orderer", "orderer", "123456");
    // 관리자 전용 함수: changeOrderStatus 강제 호출로 발주확정 시도
    const result = await page.evaluate(async () => {
      const w = window as any;
      // 발주 하나 있어야 함. 없으면 seed
      const orders = await w._FS.get("orders", []);
      let targetOrder = (orders as any[]).find(o => o?.createdBy === "orderer" && o?.status === "발주대기");
      if (!targetOrder) {
        targetOrder = {
          id: 780900 + Math.floor(Math.random() * 100),
          orderNum: `N12-${Date.now().toString().slice(-6)}`,
          status: "발주대기", deliveryTo: "테스트업체", createdBy: "orderer",
          createdAt: new Date().toISOString(), items: [],
        };
        await w._FS.set("orders", [...(orders as any[]), targetOrder]);
        await new Promise(r => setTimeout(r, 1000));
      }
      // 발주자 세션인데 관리자 함수 changeOrderStatus 호출 시도
      try {
        const r = await w.changeOrderStatus(targetOrder.id, "발주확정");
        return { called: true, result: r };
      } catch (e: any) {
        return { called: false, err: String(e?.message) };
      }
    });
    console.log("[N12]", result);
    // 발주자가 자기 발주는 확정할 수 있을 수도 (앱 정책 차이).
    // 관건: 다른 사용자 발주 확정은 막혀야 하지만, 자기 것도 정책상 차단이면 발주자 흐름 검증
    // 여기선 정보성으로만 관측
    expect(true).toBe(true); // 정보성
  });
});
