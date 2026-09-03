/**
 * [로컬 unit] 출고일 셀 인라인 로직 검증
 * orders.js:1155 + settlement/render.js:296 에서 쓰는 display 로직을
 * 실 앱 페이지에서 직접 호출해 검증. UI 렌더링 X, 로직만.
 *
 * 목적: getSettlementDate 는 이미 cutoff-fix-orderdate.spec 에서 검증됨.
 *   이 spec 은 "출고일 셀" 별도 display 로직이 각 케이스에서 정확한 값 반환하는지.
 */
import { test, expect } from "@playwright/test";

test.setTimeout(60_000);

test("출고일 셀 display 로직 (orders.js + render.js 인라인)", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#login-screen", { timeout: 20_000 });
  await page.waitForFunction(() => {
    const w = window as any;
    return Boolean(w._booted) && typeof w._toKstDateStr === "function"
      && typeof w.coerceDateForFilter === "function";
  }, null, { timeout: 30_000 });

  const result = await page.evaluate(() => {
    const w = window as any;
    const _toKstDateStr = w._toKstDateStr;
    const coerceDateForFilter = w.coerceDateForFilter;

    // orders.js:1155 + render.js:296 과 동일한 인라인 로직 (fix 반영 상태)
    function displayShipDate(o: any): string {
      let result = '';
      const sh = Array.isArray(o.statusHistory) ? o.statusHistory : [];
      for (let i = 0; i < sh.length; i++) {
        const e = sh[i];
        if (!e || e.status !== '발주확정') continue;
        const kst = typeof _toKstDateStr === 'function' ? _toKstDateStr(e.changedAt) : null;
        if (kst) {
          result = typeof coerceDateForFilter === 'function' ? coerceDateForFilter(kst) : kst;
          break;
        }
      }
      if (!result) {
        const rawShip = typeof coerceDateForFilter === 'function' ? coerceDateForFilter(o.shipDate || '') : (o.shipDate || '');
        if (rawShip && rawShip !== '0000-00-00') result = rawShip;
      }
      return result;
    }

    const cases = [
      {
        name: "확정 시: statusHistory KST 확정일 우선",
        order: {
          shipDate: "2026-09-20",
          statusHistory: [{ status: "발주확정", changedAt: "2026-08-16T00:00:00Z" }],
        },
        expected: "2026-08-16",
      },
      {
        name: "재확정: 첫 확정일 유지",
        order: {
          shipDate: "2026-09-25",
          statusHistory: [
            { status: "발주확정", changedAt: "2026-09-16T00:00:00Z" },
            { status: "발주대기", changedAt: "2026-09-18T00:00:00Z" },
            { status: "발주확정", changedAt: "2026-09-20T00:00:00Z" },
          ],
        },
        expected: "2026-09-16",
      },
      {
        name: "발주대기 이력만 있음 (발주확정 없음) → shipDate 폴백",
        order: {
          shipDate: "2026-09-25",
          statusHistory: [{ status: "발주대기", changedAt: "2026-09-16T00:00:00Z" }],
        },
        expected: "2026-09-25",
      },
      {
        name: "미확정 (statusHistory 없음): shipDate 폴백",
        order: {
          shipDate: "2026-09-25",
          statusHistory: [],
        },
        expected: "2026-09-25",
      },
      {
        name: "미확정 + shipDate=0000-00-00: 빈 문자열",
        order: {
          shipDate: "0000-00-00",
          statusHistory: [],
        },
        expected: "",
      },
      {
        name: "미확정 + shipDate 없음: 빈 문자열",
        order: {
          statusHistory: [],
        },
        expected: "",
      },
      {
        name: "미확정 + 미정규 shipDate '26-6-15' → 정규화 후 반환",
        order: {
          shipDate: "26-6-15",
          statusHistory: [],
        },
        expected: "2026-06-15",
      },
      {
        name: "statusHistory 안에 발주확정 여러 개 + 발주대기 섞임 → 첫 발주확정만",
        order: {
          shipDate: "2026-08-20",
          statusHistory: [
            { status: "발주대기", changedAt: "2026-08-10T00:00:00Z" },
            { status: "발주확정", changedAt: "2026-08-12T00:00:00Z" }, // 첫 확정
            { status: "발주확정", changedAt: "2026-08-15T00:00:00Z" }, // 두번째 확정 무시
          ],
        },
        expected: "2026-08-12",
      },
      {
        name: "confirmAt 이 timestamp object (Firestore 타입 대응)",
        order: {
          shipDate: "2026-09-25",
          statusHistory: [{ status: "발주확정", changedAt: { seconds: 1755302400 } }],  // 2025-08-16T00:00:00Z
        },
        expected: "2025-08-16",
      },
    ];

    return cases.map(c => ({
      name: c.name,
      expected: c.expected,
      actual: displayShipDate(c.order),
      match: displayShipDate(c.order) === c.expected,
    }));
  });

  console.log("\n[출고일 셀 display 로직 unit test]");
  for (const r of (result as any[])) {
    console.log(`  ${r.match ? "✅" : "❌"} ${r.name}`);
    console.log(`     예상: "${r.expected}" / 실제: "${r.actual}"`);
  }
  for (const r of (result as any[])) {
    expect(r.match, r.name).toBe(true);
  }
});
