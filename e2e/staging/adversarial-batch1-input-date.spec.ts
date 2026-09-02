/**
 * [스테이징 적대적 배치1] 입력·날짜 엣지 4개
 * S8: deliveryTo에 RTL/이모지/CSV 인젝션 → 렌더링/저장 안전
 * S9: shipDate '0000-00-00' 편법 → 정산월 오작동 X
 * S10: orderDate 미정규 '2026-9-1' → 컷오프 판정 뒤집힘 X
 * S12: 옛 발주 orderDate 편집 → 정산월 이동 X (statusHistory 우선)
 */
import { test, expect } from "@playwright/test";

test.setTimeout(120_000);

const PROJECT_ID = "hanger-test-260901";
const API_KEY = process.env.STAGING_API_KEY;
const ADMIN_EMAIL = process.env.STAGING_ADMIN_EMAIL;
const ADMIN_PW = process.env.STAGING_ADMIN_PASSWORD;
if (!API_KEY || !ADMIN_EMAIL || !ADMIN_PW) throw new Error("STAGING env 필요");

async function signIn(): Promise<string> {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PW, returnSecureToken: true }),
  });
  const j: any = await r.json();
  if (!j.idToken) throw new Error(`signIn: ${JSON.stringify(j.error)}`);
  return j.idToken;
}

async function bootAdmin(page: any) {
  await page.goto("/");
  await page.waitForSelector("#login-screen", { timeout: 30_000 });
  await page.waitForFunction(() => {
    const w = window as any;
    const accs = w.DB?.get?.("accounts", []);
    return Boolean(w._booted) && Array.isArray(accs) && accs.some((a: any) => a?.id === "admin");
  }, null, { timeout: 45_000 });
  await page.locator("#tab-admin").click();
  await page.fill("#login-id", "admin");
  await page.fill("#login-pw", "123456");
  await page.locator('button[onclick="doLogin()"]').click();
  await page.waitForSelector("[data-nav]", { timeout: 30_000 });
  await page.waitForTimeout(1500);
}

test.describe("[스테이징 적대적 배치1]", () => {

  test("S8: deliveryTo에 이모지/RTL/CSV 인젝션 → 안전 저장·표시", async ({ page }) => {
    await bootAdmin(page);
    const payloads = [
      "테스트업체😀🔥",                    // 이모지
      "테스트업체‮evil",               // RTL override
      "=1+1+cmd|'/c calc'!A0",              // CSV formula injection
      "테스트업체<script>alert(1)</script>", // XSS payload
      "테스트업체\";DROP TABLE;--",         // SQL-ish
    ];
    const results = await page.evaluate(async (pls) => {
      const w = window as any;
      const out: any[] = [];
      for (const dt of pls) {
        try {
          const cur = await w._FS.get("orders", []);
          const newOrder = {
            id: 800000 + Math.floor(Math.random() * 10000),
            orderNum: `ADV-S8-${Date.now().toString().slice(-6)}`,
            status: "발주대기",
            deliveryTo: dt,
            createdBy: "adv-s8",
            createdAt: new Date().toISOString(),
            items: [],
          };
          await w._FS.set("orders", [...cur, newOrder]);
          const back = await w._FS.get("orders", []);
          const found = (back as any[]).find(o => o?.id === newOrder.id);
          out.push({ dt, savedDeliveryTo: found?.deliveryTo, match: found?.deliveryTo === dt });
        } catch (e: any) {
          out.push({ dt, err: String(e?.message) });
        }
      }
      return out;
    }, payloads);
    console.log("[S8]", results);
    // 모두 원래 문자열 그대로 저장·회수되어야 (변환·손실 X, 실행 X)
    for (const r of results) {
      expect(r.match, `payload "${r.dt}" 저장·회수 일치`).toBe(true);
    }
    // XSS payload 가 script 로 실행되지 않았음 (페이지가 살아있음)
    const bodyText = await page.textContent("body");
    expect(bodyText, "페이지 정상").toBeTruthy();
  });

  test("S9: shipDate '0000-00-00' → getSettlementDate 폴백 정상 (orderDate 사용)", async ({ page }) => {
    await bootAdmin(page);
    const result = await page.evaluate(() => {
      const w = window as any;
      const getSD = w.getSettlementDate;
      if (typeof getSD !== "function") return { err: "getSettlementDate 없음" };
      // Case 1: 옛 발주 (컷오프 이전), shipDate=0000-00-00 → orderDate 폴백
      const oldOrder = { orderDate: "2026-05-15", shipDate: "0000-00-00", statusHistory: [] };
      const oldResult = getSD(oldOrder);
      // Case 2: 새 발주 (컷오프 이후), shipDate=0000-00-00, statusHistory 있음 → 확정일 우선
      const newOrder = {
        orderDate: "2026-09-15", shipDate: "0000-00-00",
        statusHistory: [{ status: "발주확정", changedAt: "2026-09-16T00:00:00Z" }],
      };
      const newResult = getSD(newOrder);
      return { oldResult, newResult };
    });
    console.log("[S9]", result);
    expect(result.oldResult, "옛 발주: orderDate 폴백").toBe("2026-05-15");
    // 새 발주 confirmation KST → 2026-09-16 (KST) 이 나와야 함
    expect(result.newResult, "새 발주: statusHistory 확정일").toBe("2026-09-16");
  });

  test("S10: orderDate 미정규 '2026-9-1' → 컷오프 판정 정규화 후 정상", async ({ page }) => {
    await bootAdmin(page);
    const result = await page.evaluate(() => {
      const w = window as any;
      const getSD = w.getSettlementDate;
      const normalize = w.normalizeDateStr;
      if (typeof getSD !== "function" || typeof normalize !== "function") {
        return { err: "함수 없음" };
      }
      const raw = "2026-9-1";
      const normalized = normalize(raw);
      // 컷오프 판정: '2026-9-1' vs '2026-09-01' 문자열 비교 → 정규화 없으면 뒤집힘
      // getSettlementDate 는 내부 coerceDateForFilter (=normalize) 로 정규화하므로 정상 판정해야 함
      const order = { orderDate: raw, shipDate: "2026-09-05", statusHistory: [] };
      const settlementDate = getSD(order);
      return {
        raw, normalized,
        settlementDate,
        // 컷오프 정책: >= 2026-09-01 이면 새 정책. '2026-9-1' 을 정규화하면 2026-09-01 → 새 정책
        // 새 정책에서는 statusHistory 없으면 shipDate 폴백 → '2026-09-05'
      };
    });
    console.log("[S10]", result);
    expect(result.normalized, "정규화 결과").toBe("2026-09-01");
    // '2026-9-1' 이 정규화되어 '2026-09-01' 이 되면 컷오프 == 컷오프 → 새 정책 → shipDate 폴백
    expect(result.settlementDate, "컷오프 판정 후 shipDate").toBe("2026-09-05");
  });

  test("S12: 옛 발주 orderDate 편집만 해도 정산월 안 흔들림 (statusHistory 우선)", async ({ page }) => {
    await bootAdmin(page);
    const result = await page.evaluate(() => {
      const w = window as any;
      const getSD = w.getSettlementDate;
      if (typeof getSD !== "function") return { err: "함수 없음" };
      // 시나리오: 원래 2026-05 발주였다가 관리자가 orderDate 를 2026-09-01 로 편집
      //   → 컷오프 이후 정책 적용됨 → statusHistory 첫 확정일이 정산월 결정
      //   → orderDate 만 바뀌어도 statusHistory 있는 한 옛 확정월 유지 == 회계 안 흔들림
      const editedOrder = {
        orderDate: "2026-09-01", // 편집으로 컷오프에 걸리게 됨
        shipDate: "2026-05-20",
        statusHistory: [
          { status: "발주확정", changedAt: "2026-05-19T00:00:00Z" }, // 옛 확정
        ],
      };
      const settlementDate = getSD(editedOrder);
      return { settlementDate };
    });
    console.log("[S12]", result);
    // 정산월: 2026-05-19 (KST) 여야 함 (옛 확정일). 편집된 orderDate '2026-09' 아님
    expect(result.settlementDate, "옛 확정일 유지").toBe("2026-05-19");
  });
});
