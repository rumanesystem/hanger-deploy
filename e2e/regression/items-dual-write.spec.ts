// items-dual-write.spec.ts
// Phase 2 검증 — flag ON 시 hanger_items 컬렉션에 개별 문서로 mirror되는지 확인
// 대상: 로컬 도커 에뮬레이터 (localhost:15050 앱, localhost:18080 Firestore)
// D1: 신규 items 추가 → hanger_items/{id} 문서 생성
// D2: items 필드 편집 → 문서 필드 갱신
// D3: items 삭제 → 문서 삭제
// D4: flag OFF → mirror 안 함 (기존 hanger_items 문서 그대로)

import { test, expect } from "@playwright/test";
import { resetAndSeed } from "../helpers/emu-reset";

test.setTimeout(60_000);

// [2026-09-02] 스테이징/로컬 자동 판별
const IS_STAGING = !!process.env.STAGING_FIRESTORE_URL;
const PROJECT_ID = IS_STAGING ? "hanger-test-260901" : "tooktakproject";
const FIRESTORE_HOST = IS_STAGING ? "https://firestore.googleapis.com" : "http://localhost:18080";

async function getDoc(request, id: string | number) {
  const url = `${FIRESTORE_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents/hanger_items/${id}`;
  // [2026-08-27] flaky 방어: 전체 e2e 병렬 실행 시 로컬 에뮬레이터 부하로 timeout 발생 → 3회 재시도
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await request.get(url, { timeout: 10000 });
      if (!res.ok()) return null;
      return res.json();
    } catch (e) {
      lastErr = e;
      if (i < 2) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function bootAsAdmin(page) {
  await page.goto("/");
  await page.waitForSelector('#login-screen.active', { state: 'visible', timeout: 15000 });
  await page.waitForTimeout(500);
  await page.locator('#tab-admin').click();
  await page.fill("#login-id", "admin");
  await page.fill("#login-pw", "123456");
  await page.locator('button[onclick="doLogin()"]').click();
  await page.waitForSelector('[data-nav]', { timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => !!(window as any)._FS?.set && !!(window as any).DB?.set);
}

async function saveItemsWithFlag(page, flagOn: boolean, mutator: (items: any[]) => any[]) {
  await page.evaluate(async ({ flag, mutatorStr }) => {
    (window as any)._itemsDocPerId_dualWrite = flag;
    const DB = (window as any).DB;
    const items = DB.get('items', []).slice();
    // eslint-disable-next-line no-new-func
    const fn = new Function('items', `return (${mutatorStr})(items);`);
    const next = fn(items);
    await DB.set('items', next);
  }, { flag: flagOn, mutatorStr: mutator.toString() });

  // mirror 큐 완료 대기 (여유)
  await page.waitForTimeout(2500);
}

test.describe('Phase 2 dual-write 검증', () => {
  test.beforeEach(async () => {
    await resetAndSeed();
  });

  test('D1: flag ON + 신규 items 추가 → hanger_items/{id} 문서 생성', async ({ page, request }) => {
    await bootAsAdmin(page);
    const testId = 999901;

    // 사전 확인: 문서 없음
    expect(await getDoc(request, testId), '테스트 시작 시 문서 없어야 함').toBeNull();

    await saveItemsWithFlag(page, true, (items) => {
      items.push({ id: 999901, name: '테스트품목-D1', category: '옵션', isActive: true, currentStock: 0 });
      return items;
    });

    const doc = await getDoc(request, testId);
    expect(doc, 'hanger_items/999901 문서 생성됨').not.toBeNull();
    expect(doc.fields.name.stringValue).toBe('테스트품목-D1');
    expect(doc.fields.category.stringValue).toBe('옵션');
  });

  test('D2: flag ON + 기존 items 필드 편집 → 문서 필드 갱신', async ({ page, request }) => {
    await bootAsAdmin(page);
    const testId = 999902;

    // 신규 하나 넣기
    await saveItemsWithFlag(page, true, (items) => {
      items.push({ id: 999902, name: '테스트품목-D2', category: '옵션', isActive: true, currentStock: 0 });
      return items;
    });
    const beforeDoc = await getDoc(request, testId);
    expect(beforeDoc, 'D2 사전 조건: 문서 존재').not.toBeNull();
    expect(beforeDoc.fields.currentStock.integerValue || beforeDoc.fields.currentStock.doubleValue).toBe('0');

    // stock만 변경
    await saveItemsWithFlag(page, true, (items) => {
      const i = items.find(x => x.id === 999902);
      if (i) i.currentStock = 25;
      return items;
    });

    const afterDoc = await getDoc(request, testId);
    expect(afterDoc.fields.currentStock.integerValue || afterDoc.fields.currentStock.doubleValue).toBe('25');
    expect(afterDoc.fields.name.stringValue).toBe('테스트품목-D2');
  });

  test('D3: flag ON + items 삭제 → 문서 삭제', async ({ page, request }) => {
    await bootAsAdmin(page);
    const testId = 999903;

    await saveItemsWithFlag(page, true, (items) => {
      items.push({ id: 999903, name: '테스트품목-D3', category: '옵션', isActive: true, currentStock: 0 });
      return items;
    });
    expect(await getDoc(request, testId), 'D3 사전 조건: 문서 존재').not.toBeNull();

    // 삭제
    await saveItemsWithFlag(page, true, (items) => items.filter(x => x.id !== 999903));

    expect(await getDoc(request, testId), '삭제 후 문서 없어야 함').toBeNull();
  });

  test('D4: flag OFF → hanger_items에 mirror 안 함 (신규 문서 안 생김)', async ({ page, request }) => {
    await bootAsAdmin(page);
    const testId = 999904;

    expect(await getDoc(request, testId), '사전 문서 없음').toBeNull();

    await saveItemsWithFlag(page, false, (items) => {
      items.push({ id: 999904, name: '테스트품목-D4', category: '옵션', isActive: true, currentStock: 0 });
      return items;
    });

    // flag OFF라 mirror 안 됨
    expect(await getDoc(request, testId), 'flag OFF 시 문서 안 생김').toBeNull();
  });
});
