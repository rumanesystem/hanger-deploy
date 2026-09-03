/**
 * [로컬 emu 회귀] 컷오프 fix 검증
 * 배경: 이전 코드 shipDate 우선 → 옛 발주 정산월 이동 회귀
 * fix: 옛 발주 orderDate 우선 (운영 기존 정책 유지)
 */
import { test, expect } from "@playwright/test";

test.setTimeout(60_000);

test("컷오프 fix: 옛 발주는 orderDate 우선, 새 발주는 statusHistory 확정일", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("#login-screen", { timeout: 20_000 });
  await page.waitForFunction(() => {
    const w = window as any;
    return Boolean(w._booted) && typeof w.getSettlementDate === "function";
  }, null, { timeout: 30_000 });

  const result = await page.evaluate(() => {
    const w = window as any;
    const getSD = w.getSettlementDate;
    const cases = [
      { name: "옛 발주 8월 + shipDate 8월", order: { orderDate: "2026-08-15", shipDate: "2026-08-20", statusHistory: [] }, expected: "2026-08-15" },
      { name: "옛 발주 8월 + shipDate 9월 (회계 안 흔들림)", order: { orderDate: "2026-08-10", shipDate: "2026-09-05", statusHistory: [] }, expected: "2026-08-10" },
      { name: "옛 발주 7월 + shipDate 8월", order: { orderDate: "2026-07-20", shipDate: "2026-08-15", statusHistory: [] }, expected: "2026-07-20" },
      { name: "옛 발주 orderDate=0000, shipDate 유효", order: { orderDate: "0000-00-00", shipDate: "2026-08-05", statusHistory: [] }, expected: "2026-08-05" },
      { name: "컷오프 정각 (2026-09-01) → 새 정책 확정일", order: { orderDate: "2026-09-01", shipDate: "2026-09-05", statusHistory: [{ status: "발주확정", changedAt: "2026-09-02T00:00:00Z" }] }, expected: "2026-09-02" },
      { name: "새 발주 재확정 → 첫 확정일 유지", order: { orderDate: "2026-09-15", shipDate: "2026-09-25", statusHistory: [{ status: "발주확정", changedAt: "2026-09-16T00:00:00Z" }, { status: "발주대기", changedAt: "2026-09-18T00:00:00Z" }, { status: "발주확정", changedAt: "2026-09-20T00:00:00Z" }] }, expected: "2026-09-16" },
      { name: "옛 발주 → orderDate 편집으로 컷오프 이후 이동 → statusHistory 첫 확정일", order: { orderDate: "2026-09-01", shipDate: "2026-08-20", statusHistory: [{ status: "발주확정", changedAt: "2026-08-19T00:00:00Z" }] }, expected: "2026-08-19" },
    ];
    return cases.map(c => ({ name: c.name, expected: c.expected, actual: getSD(c.order), match: getSD(c.order) === c.expected }));
  });

  console.log("[컷오프 fix 검증]");
  for (const r of (result as any[])) {
    console.log(`  ${r.match ? "✅" : "❌"} ${r.name}`);
    console.log(`     예상: ${r.expected} / 실제: ${r.actual}`);
  }
  for (const r of (result as any[])) {
    expect(r.match, r.name).toBe(true);
  }
});
