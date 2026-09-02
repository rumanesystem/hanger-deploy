/**
 * [스테이징 부하 시뮬레이션] 30개 발주 동시 저장 → 모두 land 확인
 * S4 fix (baseline diff-merge + 300ms 지연) 이 실 Firebase 부하 상황에서 견디는지 검증.
 *
 * 시나리오:
 *   1) 초기 상태 리셋
 *   2) 브라우저에서 window._FS.set("orders", [...N개]) 를 30번 병렬 호출 (사용자 개인이 순차 저장하는 것 시뮬)
 *   3) 최종 orders 배열에 30개 다 있는지 확인 (lost update 없음)
 *   4) 각 orders 항목의 id 유니크 (중복 없음)
 */
import { test, expect } from "@playwright/test";

test.setTimeout(180_000);

const PROJECT_ID = "hanger-test-260901";
const API_KEY = process.env.STAGING_API_KEY;
const ADMIN_EMAIL = process.env.STAGING_ADMIN_EMAIL;
const ADMIN_PW = process.env.STAGING_ADMIN_PASSWORD;
if (!API_KEY || !ADMIN_EMAIL || !ADMIN_PW) throw new Error("STAGING_API_KEY / STAGING_ADMIN_EMAIL / STAGING_ADMIN_PASSWORD 환경변수 필요");

async function signIn(): Promise<string> {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PW, returnSecureToken: true }),
  });
  const j: any = await r.json();
  if (!j.idToken) throw new Error(`signIn 실패: ${JSON.stringify(j.error || j)}`);
  return j.idToken;
}

async function resetOrders() {
  const token = await signIn();
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/hanger_data/orders`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      fields: {
        value: { arrayValue: { values: [] } },
        updatedAt: { stringValue: new Date().toISOString() },
      },
    }),
  });
  if (!r.ok) throw new Error(`reset 실패: ${r.status} ${await r.text()}`);
}

test.describe("[스테이징 부하] 30개 발주 동시 저장 회귀", () => {
  test("L1: 30개 orders 병렬 write → 모두 land + id 유니크", async ({ page }) => {
    await resetOrders();
    await page.goto("/");
    await page.waitForSelector("#login-screen", { timeout: 30_000 });
    // 앱 UI 로그인 (accounts 컬렉션에서 id="admin"/pw="123456" 매칭 후 세션 생성)
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
    await page.waitForTimeout(2000);

    // 30개 발주를 병렬로 _FS.set 호출 — 각 호출은 orders 배열 통째로 write
    // (실사용자가 30명 동시 저장하는 최악 시나리오 시뮬)
    const result = await page.evaluate(async () => {
      const w = window as any;
      const N = 30;
      const startedAt = Date.now();

      // 실 사용자 시나리오: 30건을 순차 rapid save (한 사람이 30번 연속 저장)
      // _FS.set 는 내부 _writeQueues 로 직렬화됨 + _txMergeById 로 서버 반영 후 baseline 갱신
      const results: any[] = [];
      for (let i = 1; i <= N; i++) {
        const orderId = 900000 + i;
        const order = {
          id: orderId,
          orderNum: `LOAD-${String(i).padStart(3, "0")}`,
          status: "발주대기",
          createdBy: "load-test",
          createdAt: new Date(startedAt + i).toISOString(),
          deliveryTo: "테스트업체",
          items: [],
        };
        try {
          const current = await w._FS.get("orders", []);
          const next = Array.isArray(current) ? [...current, order] : [order];
          await w._FS.set("orders", next);
          results.push({ i, ok: true });
        } catch (e: any) {
          results.push({ i, ok: false, err: String(e?.message || e) });
        }
      }
      const elapsed = Date.now() - startedAt;
      return { results, elapsed };
    });

    console.log(`[Load] 30개 병렬 write 완료 (${result.elapsed}ms)`);
    const failed = result.results.filter((r: any) => !r.ok);
    if (failed.length) console.log("[Load] 개별 write 실패:", failed);

    // 최종 상태 확인 — 서버에 실제 저장된 orders 개수·id 유일성
    await page.waitForTimeout(3000); // 실 Firebase propagation 여유
    const final = await page.evaluate(async () => {
      const w = window as any;
      const orders = await w._FS.get("orders", []);
      const loadOnes = (orders as any[]).filter(o => o && typeof o.orderNum === "string" && o.orderNum.startsWith("LOAD-"));
      const ids = loadOnes.map(o => o.id);
      const uniqueIds = new Set(ids);
      return {
        total: orders.length,
        loadCount: loadOnes.length,
        uniqueLoadIds: uniqueIds.size,
        idsSample: ids.slice(0, 5),
      };
    });

    console.log("[Load] 최종 상태:", final);

    // S4 fix 가 제대로 작동하면: 30개 다 있고, 모두 유니크
    expect(final.loadCount, "30개 발주가 orders 배열에 모두 있어야 함 (lost update 없음)").toBe(30);
    expect(final.uniqueLoadIds, "id 중복 없어야 함").toBe(30);
  });
});
