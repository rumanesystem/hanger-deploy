// drafts-collection.spec.ts
// hanger_drafts 컬렉션 검증 (임시저장 = 별도 컬렉션)
// - 임시저장 저장 → hanger_drafts에 생성
// - 승격 원자화 (Firestore transaction으로 draft 삭제 + order 생성)
// - 두 탭 동시 승격 DRAFT_MISSING 방어
// 대상: docker tooktak-emulator, hosting http://localhost:15050

import { test, expect, Page } from "@playwright/test";
import { resetAndSeed } from "../helpers/emu-reset";

test.setTimeout(90_000);

// [2026-09-02] 스테이징/로컬 자동 판별: env STAGING_FIRESTORE_URL 있으면 스테이징 모드
const IS_STAGING = !!process.env.STAGING_FIRESTORE_URL;
const FIRESTORE_HOST = IS_STAGING
  ? "https://firestore.googleapis.com"
  : "http://localhost:18080";
const PROJECT_ID = IS_STAGING ? "hanger-test-260901" : "tooktakproject";

async function waitForAppReady(page: Page) {
  await page.waitForSelector("#login-screen", { state: "visible", timeout: 15000 });
  await page.waitForFunction(() => {
    const w: any = window as any;
    return w.DB && typeof w.DB.get === "function" && Array.isArray(w.DB.get("accounts", []));
  }, { timeout: 15000 });
}

async function loginOrderer(page: Page) {
  await page.goto("/");
  await waitForAppReady(page);
  await page.locator("#tab-orderer").click();
  await page.fill("#login-id", "orderer");
  await page.fill("#login-pw", "123456");
  await page.locator('button[onclick="doLogin()"]').click();
  await page.waitForSelector("[data-nav]", { timeout: 15000 });
  await page.waitForFunction(() => {
    const w: any = window as any;
    return !!(w.DB && w.DB.get);
  }, { timeout: 10000 });
}

async function countDraftDocs(request: any): Promise<number> {
  const res = await request.get(`${FIRESTORE_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents/hanger_drafts`);
  if (!res.ok()) return 0;
  const j = await res.json();
  return (j.documents || []).length;
}

test.describe("hanger_drafts 컬렉션", () => {
  test.beforeEach(async () => {
    await resetAndSeed();
  });

  test("D1: 임시저장 → hanger_drafts 컬렉션에 문서 생성 (hanger_orders는 미증가)", async ({ page, request }) => {
    await loginOrderer(page);

    const before = await countDraftDocs(request);

    const savedInfo = await page.evaluate(async () => {
      const res = await (window as any).saveOrder({
        deliveryTo: "테스트업체",
        address: "테스트 주소 A",
        orderDate: "2026-08-28",
        shipDate: "",
        warehouse: "",
        note: "DRAFT_TEST_A",
        drawerItems: [],
        upperMaterials: [],
        shelfItems: [],
        rodItems: [],
      }, "임시저장");
      return { orderId: res.orderId, status: res.order?.status, draftId: res.order?.draftId };
    });

    expect(savedInfo.status).toBe("임시저장");
    expect(savedInfo.draftId).toBeTruthy();
    expect(String(savedInfo.orderId).startsWith("draft-")).toBe(true);

    const after = await countDraftDocs(request);
    expect(after - before, "hanger_drafts에 +1 문서").toBe(1);
  });

  test("D2: 승격 시 order 생성 + draft 원자 삭제 (transactOrderInventory)", async ({ page, request }) => {
    await loginOrderer(page);

    // 1. draft 저장
    const draftInfo = await page.evaluate(async () => {
      const res = await (window as any).saveOrder({
        deliveryTo: "테스트업체",
        address: "승격 테스트 주소",
        orderDate: "2026-08-28",
        shipDate: "2026-08-30",
        warehouse: "시흥",
        note: "PROMOTE_TEST",
        drawerItems: [],
        upperMaterials: [],
        shelfItems: [],
        rodItems: [],
      }, "임시저장");
      return { draftId: res.order?.draftId };
    });
    expect(draftInfo.draftId).toBeTruthy();

    const draftCountAfterSave = await countDraftDocs(request);
    expect(draftCountAfterSave, "draft 저장 후 문서 존재").toBeGreaterThan(0);

    // 2. 승격: window._promotingDraftId 세팅 후 saveOrder(발주대기)
    const promoteResult = await page.evaluate(async (draftId) => {
      (window as any)._promotingDraftId = draftId;
      (window as any)._editOverride = null;
      const res = await (window as any).saveOrder({
        deliveryTo: "테스트업체",
        address: "승격 테스트 주소",
        orderDate: "2026-08-28",
        shipDate: "2026-08-30",
        warehouse: "시흥",
        note: "PROMOTE_TEST",
        drawerItems: [],
        upperMaterials: [],
        shelfItems: [],
        rodItems: [],
      }, "발주대기");
      (window as any)._promotingDraftId = null;
      return { status: res.order?.status, orderNum: res.order?.orderNum };
    }, draftInfo.draftId!);

    expect(promoteResult.status).toBe("발주대기");
    expect(promoteResult.orderNum).toBeTruthy();

    // 3. draft 원자 삭제 검증
    const draftCountAfterPromote = await countDraftDocs(request);
    expect(draftCountAfterPromote, "승격 후 draft 문서 삭제됨").toBe(draftCountAfterSave - 1);
  });

  test("D3: 두 탭 순차 승격 시 두 번째 DRAFT_MISSING 방어", async ({ page }) => {
    await loginOrderer(page);

    // draft 저장
    const draftId = await page.evaluate(async () => {
      const res = await (window as any).saveOrder({
        deliveryTo: "테스트업체",
        address: "동시 승격 방어 테스트",
        orderDate: "2026-08-28",
        shipDate: "2026-08-30",
        warehouse: "시흥",
        note: "CONCURRENT_TEST",
        drawerItems: [],
        upperMaterials: [],
        shelfItems: [],
        rodItems: [],
      }, "임시저장");
      return res.order?.draftId;
    });
    expect(draftId).toBeTruthy();

    // 첫 번째 승격 → 성공
    const first = await page.evaluate(async (id) => {
      (window as any)._promotingDraftId = id;
      (window as any)._editOverride = null;
      try {
        const res = await (window as any).saveOrder({
          deliveryTo: "테스트업체", address: "동시 승격 방어 테스트",
          orderDate: "2026-08-28", shipDate: "2026-08-30", warehouse: "시흥", note: "CONCURRENT_TEST",
          drawerItems: [], upperMaterials: [], shelfItems: [], rodItems: [],
        }, "발주대기");
        (window as any)._promotingDraftId = null;
        return { ok: true, orderNum: res.order?.orderNum };
      } catch (e: any) {
        (window as any)._promotingDraftId = null;
        return { ok: false, msg: e?.message || String(e) };
      }
    }, draftId!);
    expect(first.ok, "첫 승격 성공").toBe(true);

    // 두 번째 승격 (같은 draftId) → DRAFT_MISSING throw
    const second = await page.evaluate(async (id) => {
      (window as any)._promotingDraftId = id;
      (window as any)._editOverride = null;
      try {
        await (window as any).saveOrder({
          deliveryTo: "테스트업체", address: "동시 승격 방어 테스트",
          orderDate: "2026-08-28", shipDate: "2026-08-30", warehouse: "시흥", note: "CONCURRENT_TEST",
          drawerItems: [], upperMaterials: [], shelfItems: [], rodItems: [],
        }, "발주대기");
        (window as any)._promotingDraftId = null;
        return { ok: true };
      } catch (e: any) {
        (window as any)._promotingDraftId = null;
        return { ok: false, msg: e?.message || String(e) };
      }
    }, draftId!);
    expect(second.ok, "두 번째 승격은 실패해야").toBe(false);
    expect(second.msg, "DRAFT_MISSING 에러").toContain("DRAFT_MISSING");
  });
});
