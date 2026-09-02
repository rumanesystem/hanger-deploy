// e2e/helpers/emu-reset.ts
// Firestore·Auth 에뮬레이터 초기화 + 시드 재실행.
// 각 테스트 시작 시 호출해서 이전 테스트 오염을 없앤다.
// 대상: docker hanger-emu — host 포트 Firestore 18080, Auth 19099 (tooktak-emulator와 반드시 구분)

import { execSync, execFileSync } from "child_process";
import * as path from "path";

// [2026-07-24 Codex] hanger-emu docker 포트 매핑:
//   Firestore: host 18080 → container 8080
//   Auth:      host 19099 → container 9099
//   Hosting:   host 15050 → container 5050
// tooktak-emulator(8080/9099)와 반드시 구분 — 잘못 지우면 다른 프로젝트 데이터 손실
const PROJECT = "tooktakproject"; // hanger 발주앱의 Firebase 프로젝트 ID
const FS_HOST = "http://localhost:18080";
const AUTH_HOST = "http://localhost:19099";

export async function resetFirestore(): Promise<void> {
  const url = `${FS_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`;
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) throw new Error(`Firestore reset failed: ${res.status}`);
}

export async function resetAuth(): Promise<void> {
  const url = `${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`;
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) throw new Error(`Auth reset failed: ${res.status}`);
}

export function runSeed(): void {
  const seedPath = path.resolve(__dirname, "..", "..", "functions", "seed-emulator.js");
  // [2026-07-14] execSync → execFileSync + timeout 60s:
  //  - Windows에서 execSync는 cmd.exe 경유 → 일부 환경에서 `spawnSync cmd.exe UNKNOWN` 실패 (INV-G2/DRAFT-R1 원인)
  //  - execFileSync는 node.exe 직접 호출 → cmd.exe 우회
  //  - timeout 60s는 e2e 병렬 부하 대비 여유
  try {
    execFileSync("node", [seedPath], {
      stdio: "pipe",
      timeout: 60000,
      env: {
        ...process.env,
        FIRESTORE_EMULATOR_HOST: "localhost:18080",
        FIREBASE_AUTH_EMULATOR_HOST: "localhost:19099"
      }
    });
  } catch (e: any) {
    const stderr = (e && e.stderr) ? e.stderr.toString() : "";
    const stdout = (e && e.stdout) ? e.stdout.toString() : "";
    throw new Error(`seed-emulator.js 실행 실패\n  stderr: ${stderr}\n  stdout: ${stdout}\n  message: ${e?.message || e}`);
  }
}

// [2026-09-02] 스테이징 REST 리셋: 로컬 emu 초기화 대신 실 Firebase의 테스트 데이터 정리
async function resetStagingTestData(): Promise<void> {
  const apiKey = process.env.STAGING_API_KEY;
  if (!apiKey) throw new Error("스테이징 리셋: STAGING_API_KEY 환경변수 필요");
  const projectId = "hanger-test-260901";
  // admin 로그인해서 토큰 획득
  const adminEmail = process.env.STAGING_ADMIN_EMAIL;
  const adminPw = process.env.STAGING_ADMIN_PASSWORD;
  if (!adminEmail || !adminPw) {
    throw new Error("스테이징 리셋: STAGING_ADMIN_EMAIL / STAGING_ADMIN_PASSWORD 환경변수 필요");
  }
  const authRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password: adminPw, returnSecureToken: true }),
  });
  const authJ: any = await authRes.json();
  if (!authJ.idToken) {
    console.error("[staging reset] admin 로그인 실패:", authJ.error?.message || authRes.status);
    throw new Error("스테이징 admin 로그인 실패 — STAGING_ADMIN_EMAIL/PASSWORD 확인 필요");
  }
  const token = authJ.idToken;
  // 리셋 대상: hanger_data/orders, invoices, purchase_requests → 빈 value
  const toFV = (v: any): any => Array.isArray(v)
    ? { arrayValue: { values: v.map(toFV) } }
    : (typeof v === "string" ? { stringValue: v } : { nullValue: null });
  const write = async (key: string) => {
    // [P2 fix codex 2026-09-02] fetch response.ok 검증 + 실패 전파 (silent swallow 제거)
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/hanger_data/${key}`;
    const r = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fields: { value: toFV([]), updatedAt: toFV(new Date().toISOString()) } }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`[staging reset] hanger_data/${key} write 실패: ${r.status} ${body.substring(0, 200)}`);
    }
  };
  await Promise.all([write("orders"), write("invoices"), write("purchase_requests")]);
  // hanger_orders, hanger_drafts, hanger_invoices 개별 컬렉션도 초기화 (delete all)
  const listAndDelete = async (coll: string) => {
    // [P1 fix] pagination: nextPageToken 루프 — 페이지 크기 초과 문서 삭제 누락 방지
    // [P1 fix codex 재검토] 401/403/429 등 실패 시 silent return 금지 → throw 로 propagate
    let pageToken: string | undefined = undefined;
    let totalDeleted = 0;
    const MAX_TOTAL = 5000;
    do {
      const listUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${coll}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
      const r = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) {
        // 컬렉션 자체가 없어 404면 정상 (아무 문서도 없음)
        if (r.status === 404) return;
        throw new Error(`[staging reset] ${coll} list 실패: ${r.status}`);
      }
      const j: any = await r.json();
      const docs: any[] = j.documents || [];
      if (docs.length > 0) {
        const delResults = await Promise.all(docs.map(d => fetch(`https://firestore.googleapis.com/v1/${d.name}`, {
          method: "DELETE", headers: { Authorization: `Bearer ${token}` }
        })));
        const failures = delResults.filter(res => !res.ok && res.status !== 404);
        if (failures.length > 0) {
          throw new Error(`[staging reset] ${coll} delete 실패 ${failures.length}/${docs.length} 건 (첫 실패: ${failures[0].status})`);
        }
        totalDeleted += docs.length;
      }
      pageToken = j.nextPageToken;
      if (totalDeleted >= MAX_TOTAL) {
        console.warn(`[staging reset] ${coll} 삭제 상한(${MAX_TOTAL}) 도달 — 중단`);
        break;
      }
    } while (pageToken);
  };
  await Promise.all([
    listAndDelete("hanger_orders"),
    listAndDelete("hanger_drafts"),
    listAndDelete("hanger_invoices"),
    // 테스트 전용 items 정리 — id 999901~999905 만 (실 items 안 건드림)
    // [P1 fix codex 재검토] 실패 propagate (404는 정상 = 이미 없음)
    (async () => {
      for (const id of ["999901","999902","999903","999904","999905"]) {
        const r = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/hanger_items/${id}`, {
          method: "DELETE", headers: { Authorization: `Bearer ${token}` }
        });
        if (!r.ok && r.status !== 404) {
          throw new Error(`[staging reset] hanger_items/${id} delete 실패: ${r.status}`);
        }
      }
    })(),
  ]);
  // [2026-09-02] 청소 후 원장인쇄 테스트 시드 재적재 (settlement R1/R2 등이 요구하는 7월 발주)
  const mkOrder = (id: number, orderNum: string, deliveryTo: string, address: string, orderDate: string, shipDate: string, warehouse: string, amount: number) => {
    const supply = Math.round(amount / 1.1); const vat = amount - supply;
    return {
      id, orderNum, deliveryTo, address, orderDate, shipDate, warehouse,
      status: "발주확정", note: "seed",
      totalSupply: supply, totalVat: vat, totalAmount: amount,
      createdBy: "admin",
      createdAt: `${orderDate}T09:00:00.000Z`,
      updatedAt: `${shipDate}T09:00:00.000Z`,
      statusHistory: [
        { status: "발주대기", changedAt: `${orderDate}T09:00:00.000Z`, note: "seed" },
        { status: "발주확정", changedAt: `${shipDate}T09:00:00.000Z`, note: "" },
      ],
    };
  };
  const seedOrders = [
    mkOrder(9901, "20260701-901", "테스트업체", "서울 강남구 테스트로 101", "2026-07-01", "2026-07-03", "시흥", 354090),
    mkOrder(9902, "20260702-902", "테스트업체", "서울 강남구 테스트로 102", "2026-07-02", "2026-07-10", "시흥", 349800),
    mkOrder(9903, "20260708-903", "테스트업체", "서울 강남구 테스트로 103", "2026-07-08", "2026-07-11", "평택", 512600),
    mkOrder(9904, "20260712-904", "테스트업체", "서울 강남구 테스트로 104", "2026-07-12", "2026-07-14", "시흥", 198000),
    mkOrder(9905, "20260718-905", "테스트업체", "서울 강남구 테스트로 105", "2026-07-18", "2026-07-20", "평택", 736450),
    mkOrder(9906, "20260725-906", "테스트업체", "서울 강남구 테스트로 106", "2026-07-25", "2026-07-26", "시흥", 286000),
    mkOrder(9907, "20260728-907", "테스트업체", "경기 성남시 샘플동 201", "2026-07-28", "2026-07-29", "시흥", 429000),
    mkOrder(9908, "20260730-908", "테스트업체", "경기 성남시 샘플동 202", "2026-07-30", "2026-07-31", "평택", 220000),
  ];
  const toFV2 = (v: any): any => {
    if (v === null) return { nullValue: null };
    if (typeof v === "string") return { stringValue: v };
    if (typeof v === "boolean") return { booleanValue: v };
    if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(toFV2) } };
    if (typeof v === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toFV2(x)])) } };
    return { nullValue: null };
  };
  const patchDoc = async (coll: string, docId: string, fields: Record<string, any>) => {
    // [P1 fix codex 재검토] 실패 propagate
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${coll}/${docId}`;
    const r = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toFV2(v)])) }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`[staging reset] patchDoc ${coll}/${docId} 실패: ${r.status} ${body.substring(0, 200)}`);
    }
  };
  // hanger_data/orders 에 시드 발주 다시 심음
  await patchDoc("hanger_data", "orders", { value: seedOrders, updatedAt: new Date().toISOString() });
  // hanger_orders 컬렉션에도 개별 문서
  await Promise.all(seedOrders.map(o => patchDoc("hanger_orders", o.orderNum, o)));
}

export async function resetAndSeed(): Promise<void> {
  // 스테이징 모드면 REST로 테스트 데이터만 정리 (앱 config/accounts는 유지)
  if (process.env.STAGING_FIRESTORE_URL) {
    await resetStagingTestData();
    return;
  }
  // 로컬 emu 초기화: 도커 안 뜬 경우 loud fail (silent skip = 거짓 GREEN 위험)
  //   기존 (2026-09-01) silent-skip 방식은 regression check에서 위험 지적됨 —
  //   도커 미기동/네트워크 오류 시 명확히 실패해서 원인 즉시 파악 가능해야 함.
  await resetFirestore();
  await resetAuth();
  runSeed();
}
