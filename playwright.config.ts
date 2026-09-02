import { defineConfig } from "@playwright/test";

/**
 * E2E — 로컬 Firebase 에뮬레이터(안전 환경) 전용. 운영에는 절대 돌리지 않는다.
 * 대상: 에뮬레이터 hosting(http://localhost:15050). 에뮬레이터(docker hanger-emu)가 떠 있어야 한다.
 * [2026-07-09] 포트 5050→15050: 툭탁 에뮬레이터와 충돌 회피
 */
// 언더바 시작 파일(_promo-*, _audit-*, _check-* 등)은 opt-in 전용 — 머신 종속·수동 실행용
// 기본: 제외. opt-in: RUN_OPTIN=1 환경변수 (Windows: `set RUN_OPTIN=1 && npx playwright test e2e/_promo-landing.spec.ts`)
const RUN_OPTIN = process.env.RUN_OPTIN === "1";

export default defineConfig({
  testDir: "./e2e",
  // [P1 fix codex 2026-09-02] staging/ 폴더는 스테이징 전용 config로만 실행 — 로컬 기본 러너에서 제외
  //   staging spec top-level에 STAGING_API_KEY 검증 throw가 있어서 로컬 collection도 중단됨
  ...(RUN_OPTIN
    ? { testIgnore: ["e2e/staging/**"] }
    : { testIgnore: ["**/_*.spec.ts", "e2e/staging/**"] }),
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:15050",
    headless: true,
    browserName: "chromium",
    actionTimeout: 10_000,
  },
});
