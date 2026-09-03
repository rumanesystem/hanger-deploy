/**
 * [코드 커버리지] cutoff fix 관련 함수 실측 커버리지
 * 목적: getSettlementDate + orders.js 출고일 셀 로직이 test 로 몇 % 밟는지 객관 측정
 */
import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

test.setTimeout(120_000);
test("커버리지: getSettlementDate + orders.js 출고일 셀 로직", async ({ page }) => {
  // Chromium 만 지원. 기본 브라우저 chromium.
  await page.coverage.startJSCoverage();

  await page.goto("/");
  await page.waitForSelector("#login-screen", { timeout: 20_000 });
  await page.waitForFunction(() => {
    const w = window as any;
    return Boolean(w._booted) && typeof w.getSettlementDate === "function";
  }, null, { timeout: 30_000 });

  // getSettlementDate 다양한 케이스 호출 (모든 branch 밟기)
  await page.evaluate(() => {
    const w = window as any;
    const getSD = w.getSettlementDate;
    const cases = [
      null,
      undefined,
      {},
      { orderDate: "2026-08-15", shipDate: "2026-08-20", statusHistory: [] },
      { orderDate: "2026-08-15", shipDate: "0000-00-00", statusHistory: [] },
      { orderDate: "2026-08-10", shipDate: "2026-09-05", statusHistory: [] },
      { orderDate: "0000-00-00", shipDate: "2026-08-05", statusHistory: [] },
      { orderDate: "", shipDate: "", statusHistory: [] },
      { orderDate: "2026-09-01", shipDate: "2026-09-05", statusHistory: [{ status: "발주확정", changedAt: "2026-09-02T00:00:00Z" }] },
      { orderDate: "2026-09-15", shipDate: "2026-09-20", statusHistory: [] },
      { orderDate: "2026-09-15", shipDate: "0000-00-00", statusHistory: [] },
      { orderDate: "2026-09-15", shipDate: "2026-09-25", statusHistory: [{ status: "발주확정", changedAt: "2026-09-16T00:00:00Z" }, { status: "발주대기", changedAt: "2026-09-18T00:00:00Z" }, { status: "발주확정", changedAt: "2026-09-20T00:00:00Z" }] },
      { orderDate: "2026-09-01", shipDate: "2026-08-20", statusHistory: [{ status: "발주확정", changedAt: "2026-08-19T00:00:00Z" }] },
      { orderDate: "2026-09-15", shipDate: null, statusHistory: null },
      // [100% coverage] defensive branch #1: statusHistory 안에 발주확정 아닌 이벤트 있음 → continue 밟음
      { orderDate: "2026-09-15", shipDate: "2026-09-20", statusHistory: [{ status: "발주대기", changedAt: "2026-09-16T00:00:00Z" }, { status: "발주확정", changedAt: "2026-09-17T00:00:00Z" }] },
      // [100% coverage] defensive branch #2: orderDate=0000 + statusHistory 없음 + shipDate 무효 → 마지막 ternary "? ''" 밟음
      { orderDate: "0000-00-00", shipDate: "0000-00-00", statusHistory: [] },
    ];
    return cases.map(c => getSD(c));
  });

  // orders.js 출고일 셀 로직 직접 트리거 (renderer 강제 호출)
  await page.evaluate(() => {
    const w = window as any;
    // renderOrdersList 존재하면 강제 호출
    if (typeof w.renderOrdersList === "function") { try { w.renderOrdersList(); } catch(e) {} }
    if (typeof w.renderOrders === "function") { try { w.renderOrders(); } catch(e) {} }
  });

  const coverage = await page.coverage.stopJSCoverage();

  // 관심 파일 필터
  const targets = [
    { name: "dateUtils.js", pattern: "utils/dateUtils.js" },
    { name: "orders.js", pattern: "/js/orders.js" },
  ];

  const report: any = {};
  for (const t of targets) {
    const entry = coverage.find(e => e.url && e.url.includes(t.pattern));
    if (!entry) { report[t.name] = { err: "url 미매치" }; continue; }
    const totalBytes = entry.source ? entry.source.length : 0;
    const usedBytes = entry.functions?.reduce((sum, fn) =>
      sum + fn.ranges.filter(r => r.count > 0).reduce((s, r) => s + (r.endOffset - r.startOffset), 0), 0) || 0;
    const pct = totalBytes > 0 ? (usedBytes / totalBytes * 100).toFixed(1) : "?";
    report[t.name] = { totalBytes, usedBytes, pct: pct + "%" };
  }

  console.log("[커버리지 리포트]");
  console.log(JSON.stringify(report, null, 2));

  // dateUtils.js: getSettlementDate 미실행 branch 정확히 표시
  const dateUtilsEntry = coverage.find(e => e.url && e.url.includes("utils/dateUtils.js"));
  if (dateUtilsEntry && dateUtilsEntry.source) {
    const gsdFn = dateUtilsEntry.functions?.find(f => f.functionName === "getSettlementDate");
    if (gsdFn) {
      const executed = gsdFn.ranges.filter(r => r.count > 0);
      const notExecuted = gsdFn.ranges.filter(r => r.count === 0);
      console.log(`\n[getSettlementDate branch] 실행 ${executed.length} / 미실행 ${notExecuted.length}`);
      console.log(`\n=== 미실행 코드 (배포 후 실 실행되면 검증 안 된 부분) ===`);
      const src = dateUtilsEntry.source;
      notExecuted.forEach((r, idx) => {
        const snippet = src.substring(r.startOffset, r.endOffset).slice(0, 200).replace(/\n/g, " ");
        console.log(`  [${idx + 1}] offset ${r.startOffset}-${r.endOffset} (${r.endOffset - r.startOffset} bytes)`);
        console.log(`      "${snippet}"`);
      });
    }
  }

  // [Codex P2] getSettlementDate 함수 branch 실행률 실제 assert (dateUtils.js 로드 확인만으로는 부족)
  expect(dateUtilsEntry, "dateUtils.js 로드됨").toBeTruthy();
  if (dateUtilsEntry) {
    const gsdFn = dateUtilsEntry.functions?.find(f => f.functionName === "getSettlementDate");
    expect(gsdFn, "getSettlementDate 함수 커버리지 데이터 존재").toBeTruthy();
    if (gsdFn) {
      const executed = gsdFn.ranges.filter(r => r.count > 0).length;
      const total = gsdFn.ranges.length;
      const pct = total > 0 ? executed / total * 100 : 0;
      console.log(`[assert] getSettlementDate branch: ${executed}/${total} = ${pct.toFixed(1)}%`);
      expect(pct, `getSettlementDate branch coverage 100%`).toBe(100);
    }
  }
});
