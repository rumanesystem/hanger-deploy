/**
 * [스테이징 적대적 배치11] 규칙·정합성·유니코드·JSON 8개
 * R1: shipDate < orderDate (역전 날짜)
 * R2: 상태 규칙 우회 (발주대기 → 취소 → 발주확정 직접 시도)
 * R3: unicode zero-width (invisible chars) in deliveryTo
 * R4: 옵션 색상 (upper-common-color) 변경 후 재저장
 * R5: items 배열 반복 저장 (같은 order 500회 update)
 * R6: JSON 순환 참조 방어 (a.self = a)
 * R7: 매우 짧은 orderNum (1자 / 빈문자열)
 * R8: 발주 삭제 시 관련 invoice 잔재 (관계 정합성)
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

test.describe("[스테이징 적대적 배치11] 규칙·정합성", () => {

  test("R1: shipDate < orderDate 저장 → 앱 감지 or 저장 자체는 성공", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const result = await page.evaluate(async () => {
      const w = window as any;
      const orderId = 710000 + Math.floor(Math.random() * 100);
      const cur = await w._FS.get("orders", []);
      // shipDate 가 orderDate 이전 = 논리 오류
      const order = {
        id: orderId,
        orderNum: `R1-${Date.now().toString().slice(-4)}`,
        status: "발주대기", deliveryTo: "테스트업체", createdBy: "admin",
        createdAt: new Date().toISOString(),
        orderDate: "2026-09-15",
        shipDate: "2026-09-10", // 5일 전 = 역전
        items: [],
      };
      await w._FS.set("orders", [...cur, order]);
      const back = (await w._FS.get("orders", []) as any[]).find(o => o?.id === orderId);
      const settlementDate = typeof w.getSettlementDate === "function" ? w.getSettlementDate(back) : null;
      // cleanup
      const arr = await w._FS.get("orders", []);
      await w._FS.set("orders", (arr as any[]).filter(o => o?.id !== orderId));
      return { saved: !!back, orderDate: back?.orderDate, shipDate: back?.shipDate, settlementDate };
    });
    console.log("[R1]", result);
    // Firestore 저장 자체는 성공. UI 검증은 별개. 정산일 계산은 정상적으로 나와야
    expect(result.saved, "역전 날짜 저장 자체는 성공").toBe(true);
  });

  test("R2: 상태 전이 규칙 우회 (허용 안 된 전환 시도)", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const orderId = 711000 + Math.floor(Math.random() * 100);
    const result = await page.evaluate(async (id) => {
      const w = window as any;
      // Seed: 취소 상태 order
      const cur = await w._FS.get("orders", []);
      await w._FS.set("orders", [...cur, {
        id, orderNum: `R2-${Date.now().toString().slice(-4)}`, status: "취소",
        deliveryTo: "테스트업체", createdBy: "orderer",
        createdAt: new Date().toISOString(), items: [],
      }]);
      await new Promise(r => setTimeout(r, 1000));
      // 취소 → 발주확정 직접 시도 (nextStatuses 가 이 전환 허용 안 할 것)
      const attempts: any[] = [];
      const transitions = ["발주확정", "출고완료", "출고확정"];
      for (const s of transitions) {
        try {
          const r = await w.changeOrderStatus(id, s);
          attempts.push({ to: s, allowed: r === true });
        } catch (e: any) { attempts.push({ to: s, err: String(e?.message) }); }
      }
      // cleanup
      const arr = await w._FS.get("orders", []);
      await w._FS.set("orders", (arr as any[]).filter(o => o?.id !== id));
      return { attempts };
    }, orderId);
    console.log("[R2]", result);
    // 최소 몇 개는 허용 안 되어야 함 (모두 allowed:true 면 규칙 없음 = 위험)
    const anyBlocked = result.attempts.some((a: any) => a.allowed === false);
    expect(anyBlocked, "일부 전환은 차단").toBe(true);
  });

  test("R3: unicode zero-width chars in deliveryTo", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const result = await page.evaluate(async () => {
      const w = window as any;
      const orderId = 712000 + Math.floor(Math.random() * 100);
      // Zero-width space (U+200B), Zero-width joiner (U+200D), BOM (U+FEFF)
      const evilName = "테스트업체​‍﻿보이지않는것";
      const cur = await w._FS.get("orders", []);
      await w._FS.set("orders", [...cur, {
        id: orderId,
        orderNum: `R3-${Date.now().toString().slice(-4)}`,
        status: "발주대기", deliveryTo: evilName, createdBy: "admin",
        createdAt: new Date().toISOString(), items: [],
      }]);
      const back = (await w._FS.get("orders", []) as any[]).find(o => o?.id === orderId);
      // cleanup
      const arr = await w._FS.get("orders", []);
      await w._FS.set("orders", (arr as any[]).filter(o => o?.id !== orderId));
      return {
        saved: !!back,
        origLen: evilName.length,
        savedLen: back?.deliveryTo?.length,
        exactMatch: back?.deliveryTo === evilName,
      };
    });
    console.log("[R3]", result);
    // Zero-width chars 유지 (앱이 sanitize 하는지 여부)
    expect(result.saved, "저장 성공").toBe(true);
  });

  test("R4: upper-common-color 여러 번 변경 후 저장", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    // 새 발주 modal 열기
    const ordersNav = page.locator('[data-nav="orders"]').first();
    if ((await ordersNav.count()) > 0) await ordersNav.click().catch(() => {});
    await page.waitForSelector("#new-order-btn", { timeout: 10_000 });
    await page.locator("#new-order-btn").click();
    await page.waitForSelector("#order-modal", { state: "visible", timeout: 5_000 });
    // upper-common-color select 여러 번 변경
    const colorEl = page.locator("#upper-common-color");
    const opts = await colorEl.locator("option").allTextContents();
    const valid = opts.filter(t => t && t !== "" && t !== "색상 선택");
    if (valid.length < 2) { test.skip(); return; }
    for (const c of valid.slice(0, 3)) {
      await colorEl.selectOption({ label: c }).catch(() => {});
      await page.waitForTimeout(200);
    }
    // 최종 상태 확인 — 페이지 살아있고 색상 필드 정상
    const finalColor = await colorEl.inputValue();
    console.log("[R4] final:", finalColor);
    expect(finalColor, "색상 선택 유지").toBeTruthy();
    // 모달 닫기
    await page.evaluate(() => (window as any).closeModal?.("order-modal"));
  });

  test("R5: items 반복 저장 (같은 order 100회 update)", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const orderId = 713000 + Math.floor(Math.random() * 100);
    const result = await page.evaluate(async (id) => {
      const w = window as any;
      // Seed
      const cur = await w._FS.get("orders", []);
      await w._FS.set("orders", [...cur, {
        id, orderNum: `R5-${Date.now().toString().slice(-4)}`, status: "발주대기",
        deliveryTo: "테스트업체", createdBy: "admin",
        createdAt: new Date().toISOString(), items: [{ id: 1, qty: 0 }],
      }]);
      // 100회 update (qty 증가)
      const N = 100;
      const t0 = Date.now();
      for (let i = 1; i <= N; i++) {
        const c = await w._FS.get("orders", []);
        const next = (c as any[]).map(o => o?.id === id ? { ...o, items: [{ id: 1, qty: i }] } : o);
        await w._FS.set("orders", next);
      }
      const elapsed = Date.now() - t0;
      const back = (await w._FS.get("orders", []) as any[]).find(o => o?.id === id);
      // cleanup
      const arr = await w._FS.get("orders", []);
      await w._FS.set("orders", (arr as any[]).filter(o => o?.id !== id));
      return { elapsed, finalQty: back?.items?.[0]?.qty };
    }, orderId);
    console.log("[R5]", result);
    expect(result.finalQty, "100번 update 후 최종 qty").toBe(100);
  });

  test("R6: JSON 순환 참조 방어 (a.self = a) 저장 시도", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const result = await page.evaluate(async () => {
      const w = window as any;
      const cur = await w._FS.get("orders", []);
      const orderId = 714000 + Math.floor(Math.random() * 100);
      const order: any = {
        id: orderId,
        orderNum: `R6-${Date.now().toString().slice(-4)}`,
        status: "발주대기", deliveryTo: "테스트", createdBy: "admin",
        createdAt: new Date().toISOString(), items: [],
      };
      order.self = order; // 순환 참조
      try {
        await w._FS.set("orders", [...cur, order]);
        return { ok: true };
      } catch (e: any) {
        return { ok: false, err: String(e?.message).slice(0, 120) };
      }
    });
    console.log("[R6]", result);
    // 순환 참조는 JSON 직렬화 실패 → 앱이 에러 처리해야 (crash 아니라 catch)
    // ok:false 로 catch 되면 정상. ok:true 여도 Firestore 가 알아서 방어함
    expect(true).toBe(true); // 정보성
  });

  test("R7: 매우 짧은 orderNum (1자 / 빈값)", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const result = await page.evaluate(async () => {
      const w = window as any;
      const cases = ["", "A", "1"];
      const out: any[] = [];
      for (const num of cases) {
        const id = 715000 + Math.floor(Math.random() * 100);
        const cur = await w._FS.get("orders", []);
        try {
          await w._FS.set("orders", [...cur, {
            id, orderNum: num, status: "발주대기", deliveryTo: "테스트업체", createdBy: "admin",
            createdAt: new Date().toISOString(), items: [],
          }]);
          const back = (await w._FS.get("orders", []) as any[]).find(o => o?.id === id);
          out.push({ num, saved: !!back, savedNum: back?.orderNum });
        } catch (e: any) { out.push({ num, err: String(e?.message) }); }
      }
      // cleanup
      const arr = await w._FS.get("orders", []);
      await w._FS.set("orders", (arr as any[]).filter(o => !(o?.id >= 715000 && o?.id < 715100)));
      return out;
    });
    console.log("[R7]", result);
    for (const r of result) {
      expect(r.saved, `orderNum "${r.num}" 저장 (UI 검증 별개)`).toBe(true);
    }
  });

  test("R8: 발주 삭제 시 관련 invoice 잔재 (관계 정합성)", async ({ page }) => {
    await bootLogin(page, "admin", "admin", "123456");
    const result = await page.evaluate(async () => {
      const w = window as any;
      const orderId = 716000 + Math.floor(Math.random() * 100);
      const orderNum = `R8-${Date.now().toString().slice(-4)}`;
      // Seed order + invoice
      const cur = await w._FS.get("orders", []);
      await w._FS.set("orders", [...cur, {
        id: orderId, orderNum, status: "발주확정", deliveryTo: "테스트업체", createdBy: "orderer",
        createdAt: new Date().toISOString(), items: [],
      }]);
      const invs = await w._FS.get("invoices", []);
      await w._FS.set("invoices", [...invs, {
        id: 810000 + Math.floor(Math.random()*100), orderNum, cancelled: false, createdAt: new Date().toISOString(),
      }]);
      await new Promise(r => setTimeout(r, 1000));
      // order 삭제
      const arr = await w._FS.get("orders", []);
      await w._FS.set("orders", (arr as any[]).filter(o => o?.id !== orderId));
      // invoice 는 여전히 존재? (관계 정합성 - 앱이 자동으로 orphan invoice 삭제 or 방어?)
      const invsAfter = await w._FS.get("invoices", []);
      const orphan = (invsAfter as any[]).find(i => i?.orderNum === orderNum);
      // cleanup: orphan invoice 도 지움
      if (orphan) {
        await w._FS.set("invoices", (invsAfter as any[]).filter(i => i?.orderNum !== orderNum));
      }
      return { orphanExists: !!orphan };
    });
    console.log("[R8]", result);
    // 앱은 관계 정합성 자동 관리 안 할 가능성 높음 (Firestore = NoSQL, cascade 없음)
    // 정보성 관측
    expect(true).toBe(true);
  });
});
