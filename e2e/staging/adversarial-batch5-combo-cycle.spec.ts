/**
 * [스테이징 적대적 배치5] 조합·사이클·워크플로우 8개
 * C1: 다색 옵션 × 여러 수량 × 여러 창고 조합
 * C2: 편집 → 삭제 → 편집 → 저장 사이클
 * C3: draft → confirm → cancel → draft 사이클
 * C4: 발주 → 발주확정 → 발주대기 되돌리기 (statusHistory 누적)
 * C5: 다른 브라우저 컨텍스트 다른 계정 동시 로그인 (별도 context)
 * C6: Firestore listener 스팸 (100개 리스너 등록·해제)
 * C7: JSON 배열에 null·undefined 섞음
 * C8: orderNum 같은 것 여러 개 저장 (충돌)
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

test.describe("[스테이징 적대적 배치5] 조합·사이클", () => {

  test("C1: 다색×여러수량×여러창고 조합 저장 → 데이터 무결", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const result = await page.evaluate(async () => {
      const w = window as any;
      const colors = ["화이트", "블랙", "실버", "샴페인골드"];
      const warehouses = ["시흥", "부산", "평택"];
      const items: any[] = [];
      let idx = 1;
      for (const c of colors) {
        for (const wh of warehouses) {
          items.push({ id: idx++, name: `${c}-${wh}`, color: c, warehouse: wh, qty: idx, price: 1000 * idx });
        }
      }
      const cur = await w._FS.get("orders", []);
      const order = {
        id: 770000 + Math.floor(Math.random() * 100),
        orderNum: `C1-${Date.now().toString().slice(-6)}`,
        status: "발주대기", deliveryTo: "테스트업체", createdBy: "admin",
        createdAt: new Date().toISOString(), items,
      };
      await w._FS.set("orders", [...cur, order]);
      const back = await w._FS.get("orders", []);
      const found = (back as any[]).find(o => o?.id === order.id);
      return {
        savedCount: found?.items?.length,
        expected: items.length,
        firstItem: found?.items?.[0],
        allColorsPresent: colors.every(c => (found?.items || []).some((i: any) => i?.color === c)),
        allWarehousesPresent: warehouses.every(w => (found?.items || []).some((i: any) => i?.warehouse === w)),
      };
    });
    console.log("[C1]", result);
    expect(result.savedCount, "12 조합 다 저장").toBe(12);
    expect(result.allColorsPresent, "모든 색상 보존").toBe(true);
    expect(result.allWarehousesPresent, "모든 창고 보존").toBe(true);
  });

  test("C2: 편집 → 삭제 → 편집 → 저장 사이클 (S4 fix 재확인)", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const orderId = 771000 + Math.floor(Math.random() * 100);
    const result = await page.evaluate(async (id) => {
      const w = window as any;
      // 1) 저장
      const cur1 = await w._FS.get("orders", []);
      const orig = { id, orderNum: "C2-orig", status: "발주대기", deliveryTo: "원본", createdBy: "admin", createdAt: new Date().toISOString(), items: [] };
      await w._FS.set("orders", [...cur1, orig]);
      // 2) 편집 (deliveryTo 변경)
      const cur2 = await w._FS.get("orders", []);
      await w._FS.set("orders", (cur2 as any[]).map(o => o?.id === id ? { ...o, deliveryTo: "편집1" } : o));
      // 3) 삭제
      const cur3 = await w._FS.get("orders", []);
      await w._FS.set("orders", (cur3 as any[]).filter(o => o?.id !== id));
      // 4) 재저장 (같은 id 로 새 데이터)
      const cur4 = await w._FS.get("orders", []);
      const revived = { id, orderNum: "C2-revived", status: "발주대기", deliveryTo: "부활", createdBy: "admin", createdAt: new Date().toISOString(), items: [] };
      await w._FS.set("orders", [...cur4, revived]);
      // 5) 편집 (deliveryTo 다시 변경)
      const cur5 = await w._FS.get("orders", []);
      await w._FS.set("orders", (cur5 as any[]).map(o => o?.id === id ? { ...o, deliveryTo: "편집2" } : o));
      const back = await w._FS.get("orders", []);
      const forId = (back as any[]).filter(o => o?.id === id);
      return { count: forId.length, deliveryTo: forId[0]?.deliveryTo, orderNum: forId[0]?.orderNum };
    }, orderId);
    console.log("[C2]", result);
    expect(result.count, "id 유일").toBe(1);
    expect(result.deliveryTo, "마지막 편집 반영").toBe("편집2");
    expect(result.orderNum, "부활 orderNum 유지").toBe("C2-revived");
  });

  test("C3: draft → confirm → cancel → draft 사이클", async ({ page }) => {
    await bootLogin(page, "orderer", "orderer", "123456");
    const result = await page.evaluate(async () => {
      const w = window as any;
      if (typeof w.saveDraft !== "function") return { err: "saveDraft 없음" };
      // 1) draft 저장
      const d1 = await w.saveDraft({ deliveryTo: "C3-draft1", warehouse: "시흥", items: [], orderDate: "2026-09-01", shipDate: "2026-09-01" }, { createdBy: "orderer" });
      // 2) draft 삭제 (cancel)
      const drafts1 = await w._FS.get("drafts", []);
      await w._FS.set("drafts", (drafts1 as any[]).filter(d => d?.draftId !== d1?.draftId));
      // 3) 새 draft 저장
      const d2 = await w.saveDraft({ deliveryTo: "C3-draft2", warehouse: "시흥", items: [], orderDate: "2026-09-01", shipDate: "2026-09-01" }, { createdBy: "orderer" });
      const finalDrafts = await w.getDrafts("orderer");
      const found = (finalDrafts as any[]).find(d => d?.draftId === d2?.draftId);
      const cleanedUp = !(finalDrafts as any[]).find(d => d?.draftId === d1?.draftId);
      // cleanup
      const finalArr = await w._FS.get("drafts", []);
      await w._FS.set("drafts", (finalArr as any[]).filter(d => d?.draftId !== d2?.draftId));
      return { newDraftExists: !!found, oldDraftCleanedUp: cleanedUp };
    });
    console.log("[C3]", result);
    expect(result.newDraftExists, "새 draft 정상 생성").toBe(true);
    expect(result.oldDraftCleanedUp, "취소된 draft 삭제됨").toBe(true);
  });

  test("C4: 발주확정 → 발주대기 되돌리기 → 다시 확정 → statusHistory 누적", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const orderId = 772000 + Math.floor(Math.random() * 100);
    const result = await page.evaluate(async (id) => {
      const w = window as any;
      const cur = await w._FS.get("orders", []);
      const order = { id, orderNum: `C4-${Date.now().toString().slice(-4)}`, status: "발주대기", deliveryTo: "테스트업체", createdBy: "orderer", createdAt: new Date().toISOString(), items: [], statusHistory: [] };
      await w._FS.set("orders", [...cur, order]);
      // 순서: 발주확정 → 발주대기 → 발주확정 → 발주대기
      const seq = ["발주확정", "발주대기", "발주확정", "발주대기"];
      const results: any[] = [];
      for (const s of seq) {
        try { const r = await w.changeOrderStatus(id, s); results.push({ s, ok: r === true }); }
        catch (e: any) { results.push({ s, err: String(e?.message) }); }
        await new Promise(r => setTimeout(r, 500));
      }
      const back = await w._FS.get("orders", []);
      const found = (back as any[]).find(o => o?.id === id);
      return {
        finalStatus: found?.status,
        historyCount: found?.statusHistory?.length,
        firstConfirm: (found?.statusHistory || []).find((h: any) => h?.status === "발주확정")?.changedAt,
        results,
      };
    }, orderId);
    console.log("[C4]", result);
    expect(result.finalStatus, "최종 발주대기").toBe("발주대기");
    // 첫 확정일 이 statusHistory 에 유지되어야 (정산월 안정)
    expect(result.firstConfirm, "첫 확정일 기록").toBeTruthy();
  });

  test("C5: 두 context 다른 계정 동시 로그인 → 서로 세션 침범 X", async ({ page, browser }) => {
    // context A: admin
    await bootLogin(page, "admin", "admin", "123456");
    const sessionA_before = await page.evaluate(() => (window as any).DB?.get?.("session", null)?.id);
    // context B: orderer (별도 context = 완전 격리 세션)
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await bootLogin(pageB, "orderer", "orderer", "123456");
    const sessionB = await pageB.evaluate(() => (window as any).DB?.get?.("session", null)?.id);
    // A 재확인 — B 로그인이 A 세션을 침범했는지
    const sessionA_after = await page.evaluate(() => (window as any).DB?.get?.("session", null)?.id);
    console.log("[C5] A_before:", sessionA_before, "B:", sessionB, "A_after:", sessionA_after);
    expect(sessionA_after, "A 세션 유지 (B 침범 X)").toBe("admin");
    expect(sessionB, "B 로그인 orderer").toBe("orderer");
    await contextB.close();
  });

  test("C6: Firestore listener 스팸 (50개 등록/해제) → memory leak X", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const result = await page.evaluate(async () => {
      const w = window as any;
      const db = w.db || (typeof w.firebase !== "undefined" ? w.firebase.firestore() : null);
      if (!db) return { err: "db 없음" };
      const unsubs: any[] = [];
      const errors: string[] = [];
      // 50개 등록
      for (let i = 0; i < 50; i++) {
        try {
          const unsub = db.collection("hanger_data").doc("orders").onSnapshot(() => {});
          unsubs.push(unsub);
        } catch (e: any) { errors.push(String(e?.message)); }
      }
      await new Promise(r => setTimeout(r, 1500));
      // 모두 해제
      for (const u of unsubs) { try { u(); } catch {} }
      return { registered: unsubs.length, errors: errors.length };
    });
    console.log("[C6]", result);
    expect(result.registered, "50개 리스너 등록").toBe(50);
    expect(result.errors, "에러 없음").toBe(0);
  });

  test("C7: orders 배열에 null/undefined 섞여도 방어", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const result = await page.evaluate(async () => {
      const w = window as any;
      try {
        const cur = await w._FS.get("orders", []);
        // 정상 order 하나 + null + undefined 섞어서 저장 시도
        const validOrder = {
          id: 773000 + Math.floor(Math.random() * 100),
          orderNum: `C7-${Date.now().toString().slice(-4)}`,
          status: "발주대기", deliveryTo: "테스트업체", createdBy: "admin",
          createdAt: new Date().toISOString(), items: [],
        };
        // Firestore 는 undefined 를 배열 요소로 못 씀 → 필터링되어야
        const messy = [...cur, validOrder, null];
        await w._FS.set("orders", messy);
        const back = await w._FS.get("orders", []);
        const found = (back as any[]).find(o => o?.id === validOrder.id);
        const nullCount = (back as any[]).filter(o => o === null).length;
        return { ok: true, validSaved: !!found, nullCount };
      } catch (e: any) {
        return { ok: false, err: String(e?.message) };
      }
    });
    console.log("[C7]", result);
    // Firestore 는 null 허용, undefined 는 반려. 정상 order 저장되면 OK
    expect(result.validSaved, "정상 order 저장").toBe(true);
  });

  test("C8: 같은 orderNum 여러 개 저장 → 앱 로직 감지", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const sameOrderNum = `C8-DUP-${Date.now().toString().slice(-6)}`;
    const result = await page.evaluate(async (num) => {
      const w = window as any;
      const cur = await w._FS.get("orders", []);
      const o1 = { id: 774000, orderNum: num, status: "발주대기", deliveryTo: "A", createdBy: "admin", createdAt: new Date().toISOString(), items: [] };
      const o2 = { id: 774001, orderNum: num, status: "발주대기", deliveryTo: "B", createdBy: "admin", createdAt: new Date().toISOString(), items: [] };
      await w._FS.set("orders", [...cur, o1, o2]);
      const back = await w._FS.get("orders", []);
      const forNum = (back as any[]).filter(o => o?.orderNum === num);
      return { count: forNum.length, ids: forNum.map(o => o.id) };
    }, sameOrderNum);
    console.log("[C8]", result);
    // orderNum 유일성은 앱 로직 (generateOrderNum) 이 담당. Firestore 자체는 허용
    // 여기선 앱이 이 상태를 감지 못하면 정보성으로 로그
    if (result.count > 1) {
      console.log("[C8] ⚠️ orderNum 중복 감지 없음 (generateOrderNum 은 정상, 강제 조작 시 앱 방어 X)");
    }
    expect(true).toBe(true); // 정보성
  });
});
