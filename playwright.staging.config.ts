// Playwright — 스테이징 서버(https://hanger-test-260901.web.app) 대상 e2e 설정
// 사용: STAGING_API_KEY=xxx npx playwright test --config playwright.staging.config.ts
//   또는 .env.staging 파일에서 STAGING_API_KEY 설정 후 실행
// 주의: 실 Firebase 프로젝트 (개인 계정, hanger-test-260901) 에 접근. 실 운영 절대 무관.

import { defineConfig } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

// [P2 fix codex 재검토] .env.staging 자동 로드 (dotenv 미설치라 수동 파싱)
//   문서화된 경로: 프로젝트 루트의 .env.staging (KEY=VALUE 형식, 주석 #)
const envFile = path.resolve(__dirname, ".env.staging");
if (fs.existsSync(envFile)) {
  const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

// [P1 fix 2026-09-02] 스테이징 판별 env var 자동 세팅
//   emu-reset.ts / drafts-collection.spec / items-dual-write.spec 는 STAGING_FIRESTORE_URL 로
//   스테이징 여부 판별. config 로드 시 URL 만 자동 세팅.
//   STAGING_API_KEY 는 반드시 외부 (CLI env 또는 .env.staging) 에서 명시 필요.
if (!process.env.STAGING_FIRESTORE_URL) {
  process.env.STAGING_FIRESTORE_URL = "https://firestore.googleapis.com";
}
// [P1 fix codex 2026-09-02] STAGING_API_KEY + admin creds 3개 다 필수 (emu-reset 요구사항 일치)
const requiredEnvs = ["STAGING_API_KEY", "STAGING_ADMIN_EMAIL", "STAGING_ADMIN_PASSWORD"];
const missing = requiredEnvs.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`❌ 스테이징 e2e 필요 환경변수 미설정: ${missing.join(", ")}`);
  console.error(`   예: STAGING_API_KEY=... STAGING_ADMIN_EMAIL=... STAGING_ADMIN_PASSWORD=... npx playwright test --config playwright.staging.config.ts`);
  process.exit(1);
}

export default defineConfig({
  testDir: "./e2e",
  // 스테이징에서 돌릴 것: 전체 regression + staging/ + smoke
  testMatch: [
    "staging/**/*.spec.ts",
    "regression/**/*.spec.ts",
    "smoke.spec.ts",
  ],
  testIgnore: ["**/_*.spec.ts", "smoke-prod.spec.ts"],
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "https://hanger-test-260901.web.app",
    headless: true,
    browserName: "chromium",
    actionTimeout: 15_000,
    // 스테이징 = 실 Firebase 라 자원 요청·응답 느릴 수 있음
    navigationTimeout: 30_000,
  },
});
