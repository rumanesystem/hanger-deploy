/**
 * 이카운트 ERP 연동 Firebase Cloud Functions
 * 프로젝트: tooktakproject
 * v2 — SESSION_ID URL 파라미터 방식으로 통일 (2026-03-27)
 *
 * 확인된 설정:
 *   COM_CODE = 670811  /  ZONE = AA
 *   테스트 서버: https://sboapiAA.ecount.com  → https://sboapiaa.ecount.com
 *   실서버:      https://oapiAA.ecount.com    → https://oapiaa.ecount.com
 *
 *   ※ 현재는 테스트 서버 사용 (테스트 인증키 갱신: 2026-04-14)
 *      실서버 인증키 발급 후 BASE_URL 을 PROD_URL 로 교체하면 됨
 */

const { onCall, HttpsError, onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentDeleted } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions");
const admin  = require("firebase-admin");
const axios  = require("axios");
const crypto = require("crypto");

admin.initializeApp();


// 이카운트 관련 Cloud Functions 제거됨 (2026-06-11):
// - ECOUNT 설정, ecountLogin
// - testEcountConnection, getEcountProducts, createEcountSaleOrder, updateEcountPrice

// ─── 아이디 → 이메일 조회 (로그인 전 미인증 호출용) ──────────
// 발주앱 로그인 시 아이디로 이메일 매핑. admin SDK가 보안 룰 우회.
// 보안 경계: 이메일만 반환. role/name/비번/납품처 등 일체 미포함.
exports.getEmailById = onCall(
  { region: "asia-northeast3", invoker: "public" },
  async (request) => {
    const { id } = request.data || {};
    if (!id || typeof id !== "string") {
      throw new HttpsError("invalid-argument", "아이디(id)가 필요합니다.");
    }
    try {
      const doc = await admin.firestore()
        .collection("hanger_data").doc("accounts").get();
      if (!doc.exists) {
        throw new HttpsError("not-found", "계정 데이터가 없습니다.");
      }
      const accounts = doc.data().value;
      if (!Array.isArray(accounts)) {
        throw new HttpsError("not-found", "계정 데이터 형식 오류.");
      }
      const found = accounts.find(a => a && a.id === id);
      if (!found || !found.email) {
        throw new HttpsError("not-found", "해당 아이디의 계정을 찾을 수 없습니다.");
      }
      logger.info(`[getEmailById] id=${id} → 이메일 조회 성공`);
      return { success: true, email: found.email };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      logger.error("[getEmailById] 오류:", e.message);
      throw new HttpsError("internal", `이메일 조회 오류: ${e.message}`);
    }
  }
);

// ─── 4-bis. 서버 단일 ID 발급 (다중 PC 동시 저장 시 번호 충돌 방지) ──
// 호출: window._FN.getNextIds({ counts: { orders: 1, order_items: N, purchase_requests: N, logs: N } })
// 응답: { success: true, ids: { orders: [42], order_items: [200,201,...], ... } }
// 규칙: 로그인 필수 / 허용 컬렉션 화이트리스트 / 컬렉션당 1회 트랜잭션으로 원자적 증가
exports.getNextIds = onCall(
  { region: "asia-northeast3", invoker: "public" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
    }
    const counts = (request.data && request.data.counts) || {};
    const ALLOWED = new Set(["orders", "order_items", "purchase_requests", "logs"]);
    const MAX_PER = 100;
    const keys = Object.keys(counts);
    if (keys.length === 0) {
      throw new HttpsError("invalid-argument", "counts가 비어 있습니다.");
    }
    for (const k of keys) {
      if (!ALLOWED.has(k)) {
        throw new HttpsError("permission-denied", `허용되지 않은 컬렉션: ${k}`);
      }
      const n = counts[k];
      if (!Number.isInteger(n) || n < 1 || n > MAX_PER) {
        throw new HttpsError("invalid-argument", `잘못된 개수 (${k}=${n}, 1-${MAX_PER})`);
      }
    }
    try {
      const db = admin.firestore();
      const result = {};
      await Promise.all(keys.map(async (k) => {
        const ref = db.collection("hanger_data").doc("_seq_" + k);
        const ids = await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          let cur = 0;
          if (snap.exists) {
            const v = snap.data() && snap.data().value;
            if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
              cur = Math.floor(v);
            } else {
              throw new HttpsError(
                "failed-precondition",
                `_seq_${k} 값 형식 오류 (admin 확인 필요)`
              );
            }
          }
          const newVal = cur + counts[k];
          tx.set(
            ref,
            { value: newVal, updatedAt: new Date().toISOString() },
            { merge: true }
          );
          return Array.from({ length: counts[k] }, (_, i) => cur + 1 + i);
        });
        result[k] = ids;
      }));
      logger.info(
        `[getNextIds] uid=${request.auth.uid} counts=${JSON.stringify(counts)} ` +
        `firstIds=${JSON.stringify(Object.fromEntries(keys.map(k => [k, result[k][0]])))}`
      );
      return { success: true, ids: result };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      logger.error("[getNextIds] 오류:", e.message);
      throw new HttpsError("internal", `ID 발급 오류: ${e.message}`);
    }
  }
);

// ─── 5. Firestore 정기 백업 — GCS Export 방식 (매일 KST 00:00) ───────────────
// [2026-08-05] 옛 in-Firestore 백업(1MiB 한계) 폐지, Google Cloud Storage 로 이전.
// Firestore Admin `exportDocuments` API 를 호출해 지정 버킷으로 전체 컬렉션을 통째 export.
// 원본 데이터는 read-only 로 접근 — 어떤 컬렉션도 삭제·수정하지 않음.
// 보관 정책: GCS 버킷 Lifecycle 규칙(30일) 이 자동 처리 (버킷 설정에서 관리).
// 복원 경로: 전체 장애 복구 전용. 전체 import는 동일 ID의 현재 문서를 덮어쓰므로
// 운영 DB에 바로 실행하지 않는다. 단일 발주는 hanger_orders_deleted_recovery를 사용한다.
// 옛 `_backups*` 컬렉션 문서들은 읽기 전용 유물로 그대로 보존 (지우지 않음).
const BACKUP_GCS_BUCKET = process.env.BACKUP_GCS_BUCKET || 'tooktakproject-firestore-backups';

exports.dailyFirestoreBackup = onSchedule(
  {
    schedule: "0 15 * * *",
    timeZone: "UTC",
    region: "asia-northeast3",
    // export 완료(LRO)까지 대기하려면 넉넉한 타임아웃 필요. v2 스케줄 함수 최대 = 540s.
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async () => {
    const db = admin.firestore();

    // 오늘 날짜 (KST = UTC+9). cold start로 UTC 14:59에 진입해도 KST 자정 이후 폴더로 찍히도록
    // schedule은 15:00 UTC (=KST 00:00) 고정이라 실제 KST 다음 날짜가 정상.
    const now = new Date();
    now.setHours(now.getHours() + 9);
    const dateStr = now.toISOString().slice(0, 10); // "YYYY-MM-DD"

    const projectId = (admin.app().options && admin.app().options.projectId)
      || process.env.GCLOUD_PROJECT
      || process.env.GCP_PROJECT
      || null;
    if (!projectId) {
      // 실행 환경에서 projectId 를 못 얻으면 엉뚱한 프로젝트에 export 하는 것보다 실패가 안전.
      const msg = 'projectId 확인 불가 (admin.options / GCLOUD_PROJECT / GCP_PROJECT 모두 미설정)';
      logger.error("[dailyFirestoreBackup] " + msg);
      await _sendSlackWithCooldown(
        db,
        'backupExportFailed',
        `:x: *일일 백업 실패* (${dateStr})\n• 대상: gs://${BACKUP_GCS_BUCKET}/${dateStr}\n• 오류: ${msg}\n• 이 알림은 24h 내 최초 1회만 발송 (cooldown)`
      );
      throw new Error(msg);
    }
    // 폴더명 충돌 방지: 같은 날 재실행 시 각기 다른 sub-path 사용.
    // 형식: gs://bucket/YYYY-MM-DD/<HHMMSS>-<random8>/
    const nowTs = new Date();
    nowTs.setHours(nowTs.getHours() + 9);
    const hhmmss = nowTs.toISOString().slice(11, 19).replace(/:/g, '');
    const rand8 = crypto.randomBytes(4).toString('hex');
    const runToken = `${hhmmss}-${rand8}`;
    const outputUriPrefix = `gs://${BACKUP_GCS_BUCKET}/${dateStr}/${runToken}`;
    const opsAuditRef = db.collection('hanger_backup_ops').doc(dateStr);

    // ── 날짜별 중복 실행 잠금 (트랜잭션) ────────────────────────────────
    // 같은 KST 하루 안에 두 번 이상 트리거되면 두 번째부터는 스킵.
    // 이전 실행이 실패/스킵으로 남았고 24h 지났으면 재시도 허용.
    // 트랜잭션 재시도 가능성이 있어 acquiredLock/snapshotTime 은 매 시도마다 초기화.
    let acquiredLock = false;
    let snapshotTime = null;
    try {
      await db.runTransaction(async (tx) => {
        acquiredLock = false;
        snapshotTime = null;
        const snap = await tx.get(opsAuditRef);
        if (snap.exists) {
          const cur = snap.data() || {};
          const status = cur.status;
          const startedMs = cur.startedAt && cur.startedAt.toMillis ? cur.startedAt.toMillis() : 0;
          const staleMs = Date.now() - startedMs;
          if (status === 'completed') return;
          if ((status === 'started' || status === 'awaiting_verify')
              && staleMs < 24 * 60 * 60 * 1000) return;
          if (status === 'skipped_already_in_progress' && staleMs < 60 * 60 * 1000) return;
        }
        // Firestore 규격에 맞춘 실제 export 기준 시각을 감사 문서에도 그대로 남긴다.
        // 과거 시점 + 분 단위 정렬을 보장하기 위해 현재 분에서 2분을 뺀다.
        const alignedMs = Math.floor(Date.now() / 60000) * 60000 - 2 * 60000;
        snapshotTime = new Date(alignedMs);
        tx.set(opsAuditRef, {
          dateStr,
          outputUriPrefix,
          runToken,
          status: 'started',
          snapshotTime: admin.firestore.Timestamp.fromDate(snapshotTime),
          startedAt: admin.firestore.FieldValue.serverTimestamp(),
          // 같은 날짜의 실패 실행을 수동 재시도할 때 옛 상태가 섞이지 않게 정리한다.
          operationName: admin.firestore.FieldValue.delete(),
          completedAt: admin.firestore.FieldValue.delete(),
          failedAt: admin.firestore.FieldValue.delete(),
          errorMessage: admin.firestore.FieldValue.delete(),
          waitLimitExceededAt: admin.firestore.FieldValue.delete(),
          finalOutputUriPrefix: admin.firestore.FieldValue.delete(),
          verifiedBy: admin.firestore.FieldValue.delete(),
          lastVerifyFailedAt: admin.firestore.FieldValue.delete(),
          lastVerifyError: admin.firestore.FieldValue.delete(),
        }, { merge: true });
        acquiredLock = true;
      });
    } catch (e) {
      logger.error("[dailyFirestoreBackup] 잠금 트랜잭션 실패:", e.message);
      throw e;
    }
    if (!acquiredLock) {
      logger.info(`[dailyFirestoreBackup] ${dateStr} 이미 처리됨(완료/진행) — 스킵`);
      return;
    }

    let operationName = null;
    try {
      // firebase-admin 이 내부적으로 쓰는 @google-cloud/firestore v1 Admin 클라이언트 이용.
      // collectionIds 미지정 → 모든 컬렉션 export.
      const { v1 } = require('@google-cloud/firestore');
      const client = new v1.FirestoreAdminClient();

      let operation;
      try {
        // snapshotTime 사용 조건: Firestore Point-in-Time Recovery(PITR) 활성화 필수 (유료).
        // 현재 PITR 미활성 → snapshotTime 미전달. export 는 실행 시점의 "현재" 스냅샷으로 진행.
        // 트레이드오프: 수 분 window 안에 write 가 섞이면 완벽 일관성은 아님. 일일 자정 백업 규모상 실용상 무해.
        // PITR 활성 시 아래 BACKUP_USE_PITR=1 환경변수로 켤 것.
        const exportReq = {
          name: `projects/${projectId}/databases/(default)`,
          outputUriPrefix,
        };
        if (snapshotTime && process.env.BACKUP_USE_PITR === '1') {
          exportReq.snapshotTime = {
            seconds: Math.floor(snapshotTime.getTime() / 1000),
            nanos: 0,
          };
        }
        [operation] = await client.exportDocuments(exportReq);
      } catch (e) {
        // 서버측 이미 진행 중 응답도 방어 (잠금 우회 재실행이 서버까지 도달한 케이스).
        // code=9(FAILED_PRECONDITION)만으로 동시 실행이라고 단정하면 다른 설정 오류까지
        // 조용히 숨길 수 있다. 실제 동시 실행 문구가 있을 때만 별도 로그를 남긴다.
        const alreadyInProgress = e
          && /already in progress|another (?:export )?operation/i.test(e.message || '');
        if (alreadyInProgress) {
          logger.warn(`[dailyFirestoreBackup] 서버측 이미 export 진행 중 — 이번 실행 실패 처리: ${e.message}`);
        }
        // 동시 실행을 포함해 시작하지 못한 모든 오류는 outer catch에서 failed+Slack 처리한다.
        throw e;
      }

      operationName = operation.name;
      logger.info(`[dailyFirestoreBackup] GCS export 시작 → ${outputUriPrefix} (op=${operationName})`);
      // operation 이름 추가 기록 (started 상태는 위 트랜잭션에서 이미 세팅됨).
      await opsAuditRef.set({
        operationName,
      }, { merge: true });

      // 실제 완료까지 대기 — export가 폴더 생성·파일 write 끝낼 때까지.
      // 함수 타임아웃(540s) 안전 여유로 480s 안에 완료 안 되면 verify 함수에 넘긴다.
      // 대부분(현재 데이터 규모 ≈수 MB)은 30~60s 안에 끝나므로 실무상 여기서 완료 확인됨.
      const WAIT_LIMIT_MS = 480 * 1000;
      const timeoutBox = { timedOut: false };
      let timeoutId;
      const timeoutSentinel = new Promise((resolve) => {
        timeoutId = setTimeout(() => { timeoutBox.timedOut = true; resolve(['__TIMEOUT__']); }, WAIT_LIMIT_MS);
      });
      let response;
      try {
        [response] = await Promise.race([operation.promise(), timeoutSentinel]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }

      if (timeoutBox.timedOut) {
        // 함수 타임아웃 안이지만 wait 한계 초과 → export 는 GCP 에서 계속 진행 중.
        // verifyBackupOperations 가 나중에 실제 상태 확인해 completed/failed 로 갱신한다.
        logger.warn(`[dailyFirestoreBackup] export 대기 한계 초과(${WAIT_LIMIT_MS}ms) — 진행 중 상태로 남김 (verify 함수가 후속 확인)`);
        await opsAuditRef.set({
          status: 'awaiting_verify',
          waitLimitExceededAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        // 실패 cooldown 해제 안 함 — 실제 완료 확인은 verify 함수에서.
        return;
      }

      logger.info(`[dailyFirestoreBackup] GCS export 완료 → ${response && response.outputUriPrefix || outputUriPrefix}`);
      await opsAuditRef.set({
        status: 'completed',
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        finalOutputUriPrefix: (response && response.outputUriPrefix) || outputUriPrefix,
      }, { merge: true });
      // 실제 완료 확인 후에만 이전 실패 cooldown 해제.
      await _clearAlertKey(db, 'backupExportFailed');
    } catch (e) {
      logger.error("[dailyFirestoreBackup] GCS export 실패:", e.message);
      // 감사 기록 (실패도 남긴다).
      try {
        await opsAuditRef.set({
          dateStr,
          outputUriPrefix,
          operationName,
          status: 'failed',
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          errorMessage: e.message || String(e),
        }, { merge: true });
      } catch (_e) {}
      await _sendSlackWithCooldown(
        db,
        'backupExportFailed',
        `:x: *일일 백업 실패* (${dateStr})\n• 대상: gs://${BACKUP_GCS_BUCKET}/${dateStr}\n• 오퍼레이션: ${operationName || '(시작 전)'}\n• 오류: ${e.message}\n• GCP 로그(dailyFirestoreBackup) 확인 필요\n• 이 알림은 24h 내 최초 1회만 발송 (cooldown)`
      );
      throw e;
    }
  }
);

// ─── 5-b. 백업 완료 검증 (매시 30분) ───────────────────────────────────────
// dailyFirestoreBackup 이 wait 한계 초과로 'awaiting_verify' 로 남긴 op 이나,
// 예상 밖으로 'started' 로 오래 남아있는 op 를 GCP Operation API 로 실제 상태 조회.
// 완료 확인 시 → status='completed', 실패 확인 시 → 'failed' + Slack 알림.
exports.verifyBackupOperations = onSchedule(
  { schedule: "30 * * * *", timeZone: "UTC", region: "asia-northeast3", timeoutSeconds: 300 },
  async () => {
    const db = admin.firestore();
    const { v1 } = require('@google-cloud/firestore');
    const client = new v1.FirestoreAdminClient();

    // 최근 48시간 이내 미완료 op를 확인한다. 오래된 좀비나 operationName 유실도
    // 로그에만 묻지 않고 상태를 종료한 뒤 Slack으로 알린다.
    const cutoffMs = Date.now() - 48 * 60 * 60 * 1000;
    const missingOperationCutoffMs = Date.now() - 15 * 60 * 1000;

    const inflightStatuses = ['started', 'awaiting_verify'];
    const snap = await db.collection('hanger_backup_ops')
      .where('status', 'in', inflightStatuses)
      .get();
    if (snap.empty) return;

    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const startedMs = data.startedAt && data.startedAt.toMillis ? data.startedAt.toMillis() : 0;
      if (!startedMs) {
        const errMsg = 'startedAt 누락/형식 오류 — 백업 상태 추적 불가';
        logger.error(`[verifyBackupOperations] ${doc.id} ${errMsg}`);
        await doc.ref.set({
          status: 'failed',
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          errorMessage: errMsg,
          verifiedBy: 'verifyBackupOperations',
        }, { merge: true });
        await _sendSlackWithCooldown(
          db,
          'backupExportFailed',
          `:x: *일일 백업 상태 오염* (${doc.id})\n• 오류: ${errMsg}\n• hanger_backup_ops 문서 확인 필요`
        );
        continue;
      }
      if (startedMs && startedMs < cutoffMs) {
        const errMsg = `48h 초과 미완료 백업 (op=${data.operationName || 'unknown'})`;
        logger.error(`[verifyBackupOperations] ${doc.id} ${errMsg}`);
        await doc.ref.set({
          status: 'failed',
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          errorMessage: errMsg,
          verifiedBy: 'verifyBackupOperations',
        }, { merge: true });
        await _sendSlackWithCooldown(
          db,
          'backupExportFailed',
          `:x: *일일 백업 장기 미완료* (${doc.id})\n• 오류: ${errMsg}\n• GCP 로그 확인 필요`
        );
        continue;
      }
      if (!data.operationName) {
        // export 시작 직전의 정상 짧은 구간은 기다리고, 15분 넘으면 추적 불가 실패로 확정한다.
        if (startedMs > missingOperationCutoffMs) continue;
        const errMsg = '15분 이상 operationName 없이 started 상태 — export 시작 여부 확인 불가';
        logger.error(`[verifyBackupOperations] ${doc.id} ${errMsg}`);
        await doc.ref.set({
          status: 'failed',
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
          errorMessage: errMsg,
          verifiedBy: 'verifyBackupOperations',
        }, { merge: true });
        await _sendSlackWithCooldown(
          db,
          'backupExportFailed',
          `:x: *일일 백업 추적 실패* (${doc.id})\n• 오류: ${errMsg}\n• GCP Import/Export 작업 목록 확인 필요`
        );
        continue;
      }

      try {
        const [op] = await client.operationsClient.getOperation({ name: data.operationName });
        if (!op || !op.done) {
          logger.info(`[verifyBackupOperations] ${doc.id} 아직 진행 중 (op=${data.operationName})`);
          continue;
        }
        // 완료됨 — 성공/실패 판정
        if (op.error) {
          const errMsg = op.error.message || `code=${op.error.code}`;
          logger.error(`[verifyBackupOperations] ${doc.id} 백업 실패 확정: ${errMsg}`);
          await doc.ref.set({
            status: 'failed',
            failedAt: admin.firestore.FieldValue.serverTimestamp(),
            errorMessage: errMsg,
            verifiedBy: 'verifyBackupOperations',
          }, { merge: true });
          await _sendSlackWithCooldown(
            db,
            'backupExportFailed',
            `:x: *일일 백업 실패 (verify)* (${doc.id})\n• 오퍼레이션: ${data.operationName}\n• 오류: ${errMsg}\n• GCP 로그 확인 필요\n• 이 알림은 24h 내 최초 1회만 발송 (cooldown)`
          );
        } else {
          logger.info(`[verifyBackupOperations] ${doc.id} 백업 완료 확정 (op=${data.operationName})`);
          await doc.ref.set({
            status: 'completed',
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
            // 요청 시점에 기록한 prefix가 복원 가능한 정확한 경로다.
            finalOutputUriPrefix: data.outputUriPrefix,
            verifiedBy: 'verifyBackupOperations',
          }, { merge: true });
          await _clearAlertKey(db, 'backupExportFailed');
        }
      } catch (e) {
        logger.error(`[verifyBackupOperations] ${doc.id} 확인 실패: ${e.message}`);
        await doc.ref.set({
          lastVerifyFailedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastVerifyError: String(e.message || e).slice(0, 500),
        }, { merge: true });
        await _sendSlackWithCooldown(
          db,
          'backupVerifyFailed',
          `:warning: *백업 완료 여부 확인 실패* (${doc.id})\n• 오퍼레이션: ${data.operationName}\n• 오류: ${e.message}\n• 다음 매시 검증에서 재시도`
        );
      }
    }
  }
);


// monitorOutboundIp + notifySlackIpChanged 제거됨 (2026-06-11) — 이카운트 연동 종료
// hourlyOrdersDiffCheck (옛/새 DB 차집합) 제거됨 (2026-08-04) — Phase 5로 옛 DB write 중단, 스냅샷 diff로 대체

// ─── 발주서 스냅샷 diff (사라진 orderNum 감지) ───
// 3시간마다 hanger_orders 스냅샷 → 직전 스냅샷과 대조 → 사라진 orderNum 슬랙 알림.
// 정상 취소는 doc이 삭제되지 않고 status='취소' 로만 마킹되므로 diff에 안 잡힌다.
// 스냅샷에서 빠졌다 = 실제로 doc이 사라짐 = 사고. hanger_orders_cancel_log 와 교차 조회로 사유 확인.
// Slack 알림 함수. return { sent: true/false } 로 성공 여부 알림.
async function notifySlackOrdersMissing(result) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) { logger.warn("[notifySlackOrdersMissing] SLACK_WEBHOOK_URL 미설정 — 스킵"); return { sent: false, reason: 'no_webhook' }; }
  const missingLines = result.missing.slice(0, 30).map(m => {
    const restoreLink = _buildRestoreUrl(m.docId) || '(복원 URL/HMAC 키 미설정)';
    return `  → ${m.orderNum || '(orderNum없음)'} (docId: ${m.docId})\n     복원: ${restoreLink}`;
  }).join('\n');
  const lines = [
    `:rotating_light: *사라진 발주서 감지* (${result.checkedAt})`,
    `• 직전 스냅샷: ${result.prevAt} (${result.prevCount}건)`,
    `• 현재:        ${result.checkedAt} (${result.currentCount}건)`,
    `• 사라진 doc: ${result.missing.length}건`,
    missingLines,
    result.missing.length > 30 ? `  (표시 30건 초과, 나머지는 GCP 로그)` : '',
    `• 즉시 확인 필요 — 링크는 미리보기 후 복원 실행`
  ].filter(Boolean);
  try {
    await axios.post(url, {
      text: lines.join("\n"),
      unfurl_links: false,
      unfurl_media: false
    }, { timeout: 10000 });
    logger.info("[notifySlackOrdersMissing] 슬랙 알림 발송 완료");
    return { sent: true };
  } catch (e) {
    logger.error("[notifySlackOrdersMissing] 슬랙 발송 실패:", e.message);
    return { sent: false, reason: 'post_failed', error: e.message };
  }
}

// Slack cooldown: transaction으로 짧은 발송 예약을 잡고, 실제 전송 성공 뒤에만 lastSentAt 확정.
// 실패 시 예약을 해제해 다음 실행에서 즉시 재시도할 수 있다.
async function _sendSlackWithCooldown(db, alertKey, text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    logger.warn(`[cooldown] ${alertKey} webhook 미설정 — cooldown 기록 안 함`);
    return { sent: false, reason: 'no_webhook' };
  }
  const stateRef = db.collection("hanger_orders_snapshot_alerts").doc(alertKey);
  const token = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const nowMs = Date.now();
  let reserved = false;
  try {
    await db.runTransaction(async tx => {
      reserved = false;
      const snap = await tx.get(stateRef);
      const data = snap.exists ? (snap.data() || {}) : {};
      const lastSentMs = data.lastSentAt ? new Date(data.lastSentAt).getTime() : 0;
      const pendingMs = data.pendingAt ? new Date(data.pendingAt).getTime() : 0;
      if (lastSentMs > 0 && nowMs - lastSentMs >= 0 && nowMs - lastSentMs < 24 * 60 * 60 * 1000) return;
      if (pendingMs > 0 && nowMs - pendingMs >= 0 && nowMs - pendingMs < 2 * 60 * 1000) return;
      tx.set(stateRef, { pendingAt: new Date(nowMs).toISOString(), pendingToken: token }, { merge: true });
      reserved = true;
    });
  } catch (e) {
    logger.warn(`[cooldown] ${alertKey} 예약 실패 — 알림 진행 안 함:`, e.message);
    return { sent: false, reason: 'reservation_failed' };
  }
  if (!reserved) return { sent: false, reason: 'suppressed', suppressed: true };

  try {
    await axios.post(url, { text }, { timeout: 10000 });
    await db.runTransaction(async tx => {
      const snap = await tx.get(stateRef);
      const data = snap.exists ? (snap.data() || {}) : {};
      if (data.pendingToken !== token) return;
      tx.set(stateRef, {
        lastSentAt: new Date().toISOString(),
        pendingAt: admin.firestore.FieldValue.delete(),
        pendingToken: admin.firestore.FieldValue.delete()
      }, { merge: true });
    });
    return { sent: true };
  } catch (e) {
    logger.error(`[cooldown] ${alertKey} Slack 실패:`, e.message);
    try {
      await db.runTransaction(async tx => {
        const snap = await tx.get(stateRef);
        const data = snap.exists ? (snap.data() || {}) : {};
        if (data.pendingToken === token) tx.delete(stateRef);
      });
    } catch (_e) {}
    return { sent: false, reason: 'post_failed' };
  }
}

// 정상 복구 시 상태를 지워 같은 장애가 재발하면 즉시 다시 알린다.
async function _clearAlertKey(db, alertKey) {
  try {
    await db.collection("hanger_orders_snapshot_alerts").doc(alertKey).delete();
  } catch (e) {
    logger.warn(`[cooldown] ${alertKey} clear 실패:`, e.message);
  }
}

async function _runOrdersSnapshotDiff(triggerLabel) {
  const db = admin.firestore();
  const now = new Date().toISOString();
  const latestRef = db.collection("hanger_orders_snapshots").doc("latest");
  const runlockRef = db.collection("hanger_orders_snapshots").doc("_runlock");

  // 스케줄 중복 실행 방어. 확인+획득을 transaction으로 묶어 동시 진입을 막는다.
  let shouldSkip = false;
  let futureLockAt = '';
  try {
    await db.runTransaction(async tx => {
      shouldSkip = false;
      futureLockAt = '';
      const lockDoc = await tx.get(runlockRef);
      const lockData = lockDoc.exists ? (lockDoc.data() || {}) : {};
      const lastStart = Number.isFinite(Number(lockData.startedAtMs))
        ? Number(lockData.startedAtMs)
        : (lockData.startedAt ? new Date(lockData.startedAt).getTime() : 0);
      const delta = Date.now() - lastStart;
      if (!isNaN(lastStart) && lastStart > 0 && delta >= 0 && delta < 5 * 60 * 1000) {
        shouldSkip = true;
        return;
      }
      if (delta < 0) futureLockAt = lockData.startedAt || String(lockData.startedAtMs);
      tx.set(runlockRef, { startedAt: now, startedAtMs: Date.now(), trigger: triggerLabel });
    });
  } catch (e) {
    logger.error(`[snapshotDiff ${triggerLabel}] runlock transaction 실패 — fail-closed:`, e.message);
    throw e;
  }
  if (shouldSkip) {
    logger.warn(`[snapshotDiff ${triggerLabel}] 최근 5분 이내 실행 감지 — skip (중복 방어)`);
    return;
  }
  if (futureLockAt) {
    logger.warn(`[snapshotDiff ${triggerLabel}] runlock 미래 시각 (${futureLockAt}) — 무시하고 진행`);
    await _sendSlackWithCooldown(
      db,
      'clockSkewAt',
      `:warning: *snapshotDiff runlock 미래 시각 감지 (인프라 이상)* (${now})\n• 저장 시각: ${futureLockAt}\n• 현재 시각: ${now}\n• 진행은 계속됨 (wedge 방지). 서버 시계·runlock doc 확인 필요.\n• 이 알림은 24h 내 최초 1회만 발송 (cooldown)`
    );
  } else {
    await _clearAlertKey(db, 'clockSkewAt');
  }

  // 현재 hanger_orders 스캔
  let currentDocs = [];
  try {
    const snap = await db.collection("hanger_orders").get();
    snap.docs.forEach(d => {
      const data = d.data() || {};
      const raw = data.orderNum;
      const on = (typeof raw === 'string' || typeof raw === 'number') ? String(raw) : '';
      currentDocs.push({ docId: d.id, orderNum: on });
    });
  } catch (e) {
    logger.error(`[snapshotOrdersDiff ${triggerLabel}] hanger_orders 스캔 실패:`, e.message);
    await _sendSlackWithCooldown(
      db,
      'ordersScanFailAt',
      `:warning: *snapshotDiff hanger_orders 스캔 실패* (${now})\n• latest는 갱신하지 않음\n• 오류: ${e.message}`
    );
    throw e; // latest 오염 방지 + 실행 실패를 모니터링에 노출
  }
  await _clearAlertKey(db, 'ordersScanFailAt');
  const currentDocIds = new Set(currentDocs.map(d => d.docId));

  // 직전 스냅샷 읽기 — 실패/오염 시 fail-closed (latest 절대 덮어쓰지 않음)
  let prevDocs = null;
  let prevAt = '(첫 실행)';
  let latestExists = false;
  try {
    const prevDoc = await latestRef.get();
    latestExists = prevDoc.exists;
    if (prevDoc.exists) {
      const data = prevDoc.data() || {};
      prevAt = data.at || '(unknown)';
      // 스키마 심층 검증: 항목 하나라도 불량/중복이거나 count가 다르면 fail-closed.
      const docsArray = Array.isArray(data.docs) ? data.docs : null;
      const entriesValid = !!docsArray && docsArray.every(x =>
        x && typeof x.docId === 'string' && x.docId.length > 0 && typeof x.orderNum === 'string'
      );
      const ids = docsArray ? docsArray.map(x => x && x.docId) : [];
      const uniqueIds = new Set(ids);
      const countValid = !!docsArray && Number(data.count) === docsArray.length;
      const schemaValid = data.schemaVersion === 2 && entriesValid && countValid && uniqueIds.size === ids.length;
      if (schemaValid) {
        prevDocs = docsArray;
        // 스키마·읽기 정상 → 이전 알림 cooldown 자동 해제 (수동 조치 후 재발 즉시 알림)
        await _clearAlertKey(db, 'schemaCorruptionAt');
        await _clearAlertKey(db, 'readFailAt');
      } else {
        // 스키마 위반 → fail-closed. latest 덮어쓰지 말고 admin 수동 확인 요청.
        logger.error(`[snapshotDiff ${triggerLabel}] latest 스키마 오염 — fail-closed (자동 재작성 X)`);
        await _sendSlackWithCooldown(
          db,
          'schemaCorruptionAt',
          `:warning: *snapshotDiff latest 스키마 오염 (fail-closed)* (${now})\n• 자동 재작성 중단 — 사고 은폐 방지\n• 배열/항목/count/중복/schemaVersion 중 하나가 잘못됨\n• Firestore 콘솔에서 hanger_orders_snapshots/latest 확인 후 수동 조치 필요\n• 이 알림은 24h 내 최초 1회만 발송 (cooldown)`
        );
        return;
      }
    }
  } catch (e) {
    // 읽기 자체 실패 → fail-closed (latest 안 덮어씀, 다음 실행에서 재시도)
    logger.error(`[snapshotDiff ${triggerLabel}] latest 읽기 실패 — fail-closed 종료:`, e.message);
    await _sendSlackWithCooldown(
      db,
      'readFailAt',
      `:warning: *snapshotDiff latest 읽기 실패 (fail-closed)* (${now})\n• 이번 window skip. 다음 실행 시 재시도.\n• 오류: ${e.message}\n• 이 알림은 24h 내 최초 1회만 발송 (cooldown)`
    );
    throw e;
  }

  // diff 계산 + Slack 알림
  if (prevDocs && prevDocs.length > 0) {
    const missingDocs = prevDocs.filter(x => !currentDocIds.has(x.docId));
    if (missingDocs.length > 0) {
      const missingDisplay = missingDocs.map(x => ({ docId: x.docId, orderNum: x.orderNum || '' }));
      logger.warn(`[snapshotDiff ${triggerLabel}] ⚠️ 사라진 doc ${missingDocs.length}건`, missingDisplay.slice(0, 20));

      const slackResult = await notifySlackOrdersMissing({
        missing: missingDisplay,
        prevAt,
        checkedAt: now,
        prevCount: prevDocs.length,
        currentCount: currentDocs.length,
        trigger: triggerLabel
      });

      // Slack 실패 시 latest 갱신 금지 → 다음 실행에서 다시 알림 기회
      if (!slackResult.sent) {
        logger.error(`[snapshotDiff ${triggerLabel}] Slack 실패 (${slackResult.reason}) — latest 갱신 skip, 다음 실행에서 재알림`);
        return;
      }
    } else {
      logger.info(`[snapshotDiff ${triggerLabel}] 정상: 직전 ${prevDocs.length}건 → 현재 ${currentDocs.length}건 (사라진 것 없음)`);
    }
  } else if (!latestExists) {
    logger.info(`[snapshotDiff ${triggerLabel}] 첫 실행 — 스냅샷만 저장`);
  }

  // 스냅샷 저장 — read 성공 + (missing 없음 OR Slack 성공) 일 때만 도달
  try {
    await latestRef.set({
      docs: currentDocs,
      count: currentDocs.length,
      at: now,
      trigger: triggerLabel,
      schemaVersion: 2
    });
  } catch (e) {
    logger.error(`[snapshotOrdersDiff ${triggerLabel}] latest 저장 실패:`, e.message);
    throw e;
  }
}

// 3시간마다 (0시·3시·6시·…·21시) KST
exports.snapshotOrdersDiff = onSchedule(
  { schedule: "0 */3 * * *", timeZone: "Asia/Seoul", region: "asia-northeast3" },
  async () => _runOrdersSnapshotDiff("3h")
);

// M3 보강 (Codex): invoices 무결성 검사
// - id 중복 / orderNum 없음 / 같은 orderNum 활성 invoice 다중 / 고아 invoice 검출
async function _runInvoicesIntegrityCheck(triggerLabel) {
  try {
    const db = admin.firestore();
    const invDoc = await db.collection("hanger_data").doc("invoices").get();
    const rawInvoices = invDoc.exists ? invDoc.data().value : [];
    if (!Array.isArray(rawInvoices)) {
      await _sendSlackWithCooldown(
        db,
        'invoiceSchemaAt',
        `:warning: *거래명세서 스키마 오류* (${new Date().toISOString()})\n• hanger_data/invoices.value가 배열이 아님\n• 무결성 검사를 fail-closed로 종료`
      );
      throw new Error('hanger_data/invoices.value 스키마 오류 — 배열이 아님');
    }
    await _clearAlertKey(db, 'invoiceSchemaAt');
    const arr = rawInvoices;
    // [2026-08-04] Phase 5 이후 hanger_data/orders 배열 얼어붙음 → 새 컬렉션 hanger_orders 사용
    // docId 를 fallback 으로 사용 (규약: hanger_orders docId == orderNum, 필드 누락 방어)
    const ordSnap = await db.collection("hanger_orders").get();
    const orderNums = new Set();
    const orderNumMismatch = [];
    ordSnap.docs.forEach(d => {
      const data = d.data() || {};
      const canonical = String(d.id); // Phase 5 규약의 기준값
      orderNums.add(canonical);
      if (data.orderNum !== undefined && data.orderNum !== null && String(data.orderNum) !== canonical) {
        orderNumMismatch.push(`${canonical}≠${String(data.orderNum)}`);
      }
    });

    const idCount = {};
    const activeByOrderNum = {};
    const noOrderNum = [];
    const orphan = []; // invoice.orderNum이 orders에 없음

    arr.forEach(inv => {
      if (!inv) return;
      if (inv.id) idCount[inv.id] = (idCount[inv.id] || 0) + 1;
      if (!inv.orderNum) { noOrderNum.push(inv.id || '(no id)'); return; }
      const invOrderNum = String(inv.orderNum);
      if (!inv.cancelled) {
        activeByOrderNum[invOrderNum] = (activeByOrderNum[invOrderNum] || 0) + 1;
      }
      if (!orderNums.has(invOrderNum)) orphan.push(invOrderNum);
    });

    const dupIds = Object.entries(idCount).filter(([, c]) => c > 1).map(([id, c]) => id + '×' + c);
    const multiActive = Object.entries(activeByOrderNum).filter(([, c]) => c > 1).map(([n, c]) => n + '×' + c);

    const now = new Date().toISOString();
    const result = {
      total: arr.length,
      dupIdsCount: dupIds.length,
      dupIds: dupIds.slice(0, 20),
      noOrderNumCount: noOrderNum.length,
      noOrderNum: noOrderNum.slice(0, 20),
      multiActiveCount: multiActive.length,
      multiActive: multiActive.slice(0, 20),
      orphanCount: orphan.length,
      orphan: [...new Set(orphan)].slice(0, 20),
      orderNumMismatchCount: orderNumMismatch.length,
      orderNumMismatch: orderNumMismatch.slice(0, 20),
      checkedAt: now,
      trigger: triggerLabel
    };

    await db.collection("hanger_data").doc("invoices_diff_monitor").set({
      value: result,
      updatedAt: now
    });

    const anyIssue = dupIds.length || noOrderNum.length || multiActive.length || orphan.length || orderNumMismatch.length;
    if (anyIssue) {
      logger.warn(`[invoices 검증 ${triggerLabel}] ⚠️ 이슈 감지`, result);
      const url = process.env.SLACK_WEBHOOK_URL;
      if (url) {
        const lines = [
          `⚠️ *거래명세서 무결성 이슈* (${now})`,
          `• 총 invoice: ${arr.length}건`,
          `• id 중복: ${dupIds.length}건${dupIds.length ? ` → ${dupIds.slice(0, 5).join(', ')}` : ''}`,
          `• orderNum 누락: ${noOrderNum.length}건`,
          `• 동일 orderNum 활성 invoice 다중: ${multiActive.length}건${multiActive.length ? ` → ${multiActive.slice(0, 5).join(', ')}` : ''}`,
          `• 고아 invoice (orders에 없음): ${orphan.length}건`,
          `• order docId/필드 불일치: ${orderNumMismatch.length}건${orderNumMismatch.length ? ` → ${orderNumMismatch.slice(0, 5).join(', ')}` : ''}`
        ];
        try { await axios.post(url, { text: lines.join("\n") }, { timeout: 10000 }); }
        catch (e) { logger.error("[invoices 슬랙] 발송 실패:", e.message); throw e; }
      }
    } else {
      logger.info(`[invoices 검증 ${triggerLabel}] 정상: ${arr.length}건`);
    }
  } catch (e) {
    logger.error(`[invoicesIntegrityCheck ${triggerLabel}] 오류:`, e.message);
    throw e;
  }
}

exports.hourlyInvoicesIntegrityCheck = onSchedule(
  { schedule: "30 8-17 * * *", timeZone: "Asia/Seoul", region: "asia-northeast3" },
  async () => _runInvoicesIntegrityCheck("hourly")
);

// ─── iter2: 실시간 삭제 감지 (onDocumentDeleted) ────────────────
// hanger_orders/{docId} 삭제 즉시 슬랙 알림 + 서버측 audit log 기록.
// 스냅샷 diff(3시간 주기)의 사각지대를 보완.
// 참고: 문서를 update 로 status='취소' 처리하는 경우엔 발동 X (delete 만).
const RESTORE_LINK_TTL_MS = 24 * 60 * 60 * 1000;

function _restoreSecret() {
  return process.env.RESTORE_API_TOKEN || '';
}

function _restoreSignature(action, docId, date, expiresAt, contentHash = '') {
  const secret = _restoreSecret();
  if (!secret) return '';
  const payload = [action, String(docId), String(date || ''), String(contentHash || ''), String(expiresAt)].join('\n');
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function _safeSignatureEqual(actual, expected) {
  if (!actual || !expected || !/^[a-f0-9]{64}$/i.test(actual)) return false;
  const a = Buffer.from(String(actual).toLowerCase(), 'hex');
  const b = Buffer.from(String(expected).toLowerCase(), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function _validRestoreSignature(action, docId, date, expiresAt, signature, contentHash = '') {
  const exp = Number(expiresAt);
  if (!Number.isSafeInteger(exp) || exp < Date.now()) return false;
  const expected = _restoreSignature(action, docId, date, exp, contentHash);
  return _safeSignatureEqual(signature, expected);
}

function _buildRestoreUrl(docId) {
  const baseUrl = process.env.RESTORE_BASE_URL;
  if (!baseUrl || !_restoreSecret()) return null;
  try {
    const expiresAt = Date.now() + RESTORE_LINK_TTL_MS;
    const url = new URL(baseUrl);
    url.searchParams.set('docId', String(docId));
    url.searchParams.set('exp', String(expiresAt));
    url.searchParams.set('sig', _restoreSignature('preview', docId, '', expiresAt));
    return url.toString();
  } catch (e) {
    logger.error('[restoreOrder] RESTORE_BASE_URL 형식 오류:', e.message);
    return null;
  }
}

function _eventKey(eventId) {
  return crypto.createHash('sha256').update(String(eventId)).digest('hex').slice(0, 32);
}

function _canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (typeof value.toMillis === 'function') return JSON.stringify({ __timestampMs: value.toMillis() });
  if (Array.isArray(value)) return '[' + value.map(_canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .filter(key => value[key] !== undefined)
    .map(key => JSON.stringify(key) + ':' + _canonicalJson(value[key]))
    .join(',') + '}';
}

function _recoveryIntegrity(docId, eventId, deletedAtMs, snapshot) {
  const secret = _restoreSecret();
  if (!secret) return '';
  const snapshotHash = crypto.createHash('sha256').update(_canonicalJson(snapshot)).digest('hex');
  return crypto.createHmac('sha256', secret)
    .update([String(docId), String(eventId), String(deletedAtMs), snapshotHash].join('\n'))
    .digest('hex');
}

function _snapshotHash(snapshot) {
  return crypto.createHash('sha256').update(_canonicalJson(snapshot)).digest('hex');
}

function _timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

async function _recordOrderAlertFailure(db, {
  docId,
  orderNum,
  eventId,
  eventHash,
  detectedAt,
  error,
  failureType = 'SLACK_SEND_FAILED',
  restoreLinkAvailable = false
}) {
  try {
    await db.collection('hanger_orders_alert_failures').doc(`${docId}_${eventHash}`).set({
      docId,
      orderNum,
      eventId,
      detectedAt,
      failedAt: new Date().toISOString(),
      failureType,
      errorMessage: String(error && error.message || error || '').slice(0, 500),
      resolved: false,
      resolvedAt: null,
      resolvedBy: null,
      restoreLinkAvailable: !!restoreLinkAvailable
    }, { merge: true });
    logger.warn(`[onOrderDeleted] 알림 실패 기록됨: hanger_orders_alert_failures/${docId}_${eventHash}`);
    return true;
  } catch (recordErr) {
    logger.error('[onOrderDeleted] 알림 실패 기록도 실패:', recordErr.message);
    return false;
  }
}

exports.onOrderDeleted = onDocumentDeleted(
  { document: "hanger_orders/{docId}", region: "asia-northeast3" },
  async (event) => {
    const docId = event.params.docId;
    const before = (event.data && event.data.data()) || {};
    const eventId = String(event.id || `${docId}:${event.time || ''}`);
    const eventHash = _eventKey(eventId);
    const now = event.time || new Date().toISOString();
    const deletedAtMs = new Date(now).getTime() || Date.now();
    const orderNum = before.orderNum ? String(before.orderNum) : '';
    const db = admin.firestore();
    const logId = `delete_trigger_${eventHash}`;
    const auditRef = db.collection("hanger_orders_cancel_log").doc(logId);
    const recoveryRef = db.collection("hanger_orders_deleted_recovery").doc(docId);
    logger.warn(`[onOrderDeleted] 삭제 감지: hanger_orders/${docId} (orderNum=${orderNum}, event=${eventHash})`);

    // event.id 기반 audit로 중복 배송을 멱등적으로 처리한다.
    // 삭제 이벤트가 역순으로 도착해도 최근 복구 스냅샷을 예전 것으로 덮지 않는다.
    await db.runTransaction(async tx => {
      const auditSnap = await tx.get(auditRef);
      const recoverySnap = await tx.get(recoveryRef);
      if (!auditSnap.exists) {
        tx.create(auditRef, {
          id: logId,
          eventId,
          type: '삭제감지(서버트리거)',
          orderId: docId,
          orderNum,
          source: 'onDocumentDeleted',
          recoveryRef: `hanger_orders_deleted_recovery/${docId}`,
          detectedAt: now,
          slackSent: false,
          at: admin.firestore.FieldValue.serverTimestamp()
        });
      }
      const previous = recoverySnap.exists ? (recoverySnap.data() || {}) : {};
      if (!recoverySnap.exists || deletedAtMs >= Number(previous.deletedAtMs || 0)) {
        tx.set(recoveryRef, {
          docId,
          orderNum,
          eventId,
          deletedSnapshot: before,
          deletedAt: now,
          deletedAtMs,
          integrityVersion: 1,
          integrity: _recoveryIntegrity(docId, eventId, deletedAtMs, before),
          capturedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    });

    const restoreUrl = _buildRestoreUrl(docId);
    const url = process.env.SLACK_WEBHOOK_URL;
    if (!url) {
      const configError = new Error('SLACK_WEBHOOK_URL 미설정');
      logger.error('[onOrderDeleted] Slack 발송 불가:', configError.message);
      await _recordOrderAlertFailure(db, {
        docId, orderNum, eventId, eventHash, detectedAt: now,
        error: configError,
        failureType: 'SLACK_WEBHOOK_MISSING',
        restoreLinkAvailable: !!restoreUrl
      });
      return;
    }

    // Slack 발송도 짧은 lease로 중복을 줄이고, 실패 시 retry가 다시 잡을 수 있게 한다.
    const alertToken = crypto.randomUUID();
    let alertState = 'send';
    await db.runTransaction(async tx => {
      const snap = await tx.get(auditRef);
      const data = snap.exists ? (snap.data() || {}) : {};
      if (data.slackSent === true) { alertState = 'done'; return; }
      const pendingMs = _timestampMillis(data.slackPendingAtMs || data.slackPendingAt);
      if (pendingMs > 0 && Date.now() - pendingMs >= 0 && Date.now() - pendingMs < 2 * 60 * 1000) {
        alertState = 'pending';
        return;
      }
      tx.set(auditRef, {
        slackPendingAtMs: Date.now(),
        slackPendingToken: alertToken
      }, { merge: true });
    });
    if (alertState === 'done') return;
    if (alertState === 'pending') {
      logger.info('[onOrderDeleted] Slack 발송이 다른 invocation에서 진행 중 — 중복 실행 종료');
      return;
    }

    const lines = [
      `:rotating_light: *발주서 실시간 삭제 감지* (${now})`,
      `• docId: ${docId}`,
      `• orderNum: ${orderNum || '(없음)'}`,
      `• 삭제 시각: ${now}`,
      restoreUrl
        ? `• 복원 링크: ${restoreUrl}\n  (만료형 서명, 미리보기 후 확인)`
        : `• 복원 링크: RESTORE_BASE_URL/HMAC 키 미설정 — 수동 복원 필요`,
      `• 서버측 audit log: hanger_orders_cancel_log 에 기록됨`
    ].filter(Boolean);
    try {
      await axios.post(url, {
        text: lines.join("\n"),
        unfurl_links: false,
        unfurl_media: false
      }, { timeout: 10000 });
    } catch (e) {
      logger.error('[onOrderDeleted] 슬랙 발송 실패:', e.message);
      try {
        await db.runTransaction(async tx => {
          const snap = await tx.get(auditRef);
          const data = snap.exists ? (snap.data() || {}) : {};
          if (data.slackPendingToken === alertToken) {
            tx.set(auditRef, {
              slackPendingAtMs: admin.firestore.FieldValue.delete(),
              slackPendingToken: admin.firestore.FieldValue.delete(),
              slackLastError: String(e.message || '').slice(0, 500)
            }, { merge: true });
          }
        });
      } catch (clearErr) {
        logger.warn('[onOrderDeleted] Slack pending 상태 정리 실패:', clearErr.message);
      }
      await _recordOrderAlertFailure(db, {
        docId, orderNum, eventId, eventHash, detectedAt: now,
        error: e,
        failureType: 'SLACK_SEND_FAILED',
        restoreLinkAvailable: !!restoreUrl
      });
      return;
    }

    // Slack 전송 성공과 audit 상태 저장은 분리한다. 상태 저장 실패를
    // Slack 전송 실패로 오인해 관리자 배지를 띄우지 않기 위함이다.
    try {
      await db.runTransaction(async tx => {
        const snap = await tx.get(auditRef);
        const data = snap.exists ? (snap.data() || {}) : {};
        if (data.slackPendingToken !== alertToken) return;
        tx.set(auditRef, {
          slackSent: true,
          slackSentAt: admin.firestore.FieldValue.serverTimestamp(),
          slackPendingAtMs: admin.firestore.FieldValue.delete(),
          slackPendingToken: admin.firestore.FieldValue.delete()
        }, { merge: true });
      });
      logger.info("[onOrderDeleted] 슬랙 알림 완료");
    } catch (auditStateErr) {
      logger.error('[onOrderDeleted] Slack은 전송됐으나 audit 상태 갱신 실패:', auditStateErr.message);
    }
  }
);

// ─── iter2: 발주서 복원 함수 (HTTP endpoint, 슬랙 링크용) ─────────
// GET은 만료형 preview HMAC, POST는 docId+date에 바인딩된 execute HMAC를 사용한다.
// 복원 원본은 삭제 시점의 정확한 스냅샷을 우선하고, 없으면 30일 백업을 검색한다.
async function _findBackupWithDoc(db, docId, explicitDate) {
  const recoveryDoc = await db.collection("hanger_orders_deleted_recovery").doc(docId).get();
  if (recoveryDoc.exists) {
    const recovery = recoveryDoc.data() || {};
    const snapshot = recovery.deletedSnapshot;
    const expectedIntegrity = _recoveryIntegrity(docId, recovery.eventId, recovery.deletedAtMs, snapshot);
    const integrityValid = recovery.integrityVersion === 1
      && _safeSignatureEqual(String(recovery.integrity || ''), expectedIntegrity);
    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) && integrityValid) {
      return {
        found: true,
        date: recovery.deletedAt || 'delete-trigger',
        source: `hanger_orders_deleted_recovery/${docId}`,
        target: { docId, data: snapshot }
      };
    }
    logger.error(`[restoreOrder] 삭제 복구 스냅샷 오염/무결성 실패: ${docId}`);
  }
  if (explicitDate) {
    const doc = await db.collection("_backups_hanger_orders").doc(explicitDate).get();
    if (!doc.exists) return { found: false, reason: `${explicitDate} 백업 doc 없음` };
    const docs = Array.isArray((doc.data() || {}).docs) ? doc.data().docs : [];
    const target = docs.find(d => d && d.docId === docId);
    return target && target.data && typeof target.data === 'object'
      ? { found: true, date: explicitDate, source: `_backups_hanger_orders/${explicitDate}`, target }
      : { found: false, reason: `${explicitDate} 백업에 docId=${docId} 없음` };
  }
  // 보관 정책상 최대 30일치만 존재한다. documentId desc query는 일부
  // Firestore 에뮬레이터에서 지원되지 않으므로 작은 목록을 읽고 메모리에서 정렬한다.
  const snap = await db.collection("_backups_hanger_orders").get();
  const recentDocs = snap.docs.sort((a, b) => b.id.localeCompare(a.id)).slice(0, 30);
  for (const doc of recentDocs) {
    const docs = Array.isArray((doc.data() || {}).docs) ? doc.data().docs : [];
    const target = docs.find(d => d && d.docId === docId);
    if (target && target.data && typeof target.data === 'object') {
      return { found: true, date: doc.id, source: `_backups_hanger_orders/${doc.id}`, target };
    }
  }
  return { found: false, reason: `최근 30일 백업에 docId=${docId} 없음` };
}

function _htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 복원 성공 시 슬랙 알림 (파괴적 작업 감지·감사 목적)
async function _notifyRestoreSuccess(docId, orderNum, date, actorIp) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return { sent: false, reason: 'no_webhook' };
  try {
    await axios.post(url, {
      text: `:white_check_mark: *발주서 복원 완료* (${new Date().toISOString()})\n• docId: ${docId}\n• orderNum: ${orderNum || '(없음)'}\n• 백업 날짜: ${date}\n• 요청 IP: ${actorIp}\n• hanger_orders_cancel_log 에 이벤트 기록됨`
    }, { timeout: 10000 });
    return { sent: true };
  } catch (e) {
    logger.warn("[restoreOrder] 성공 알림 발송 실패:", e.message);
    return { sent: false, reason: 'post_failed', error: e.message };
  }
}

// 인증 실패·비정상 요청 로깅 (brute force 감지 흔적)
function _logAuthAttempt(kind, req, extra) {
  const ip = req.ip || req.headers['x-forwarded-for'] || '(unknown)';
  const ua = req.headers['user-agent'] || '(no-ua)';
  logger.warn(`[restoreOrder] ${kind} ip=${ip} ua=${ua} ${extra || ''}`);
}

exports.restoreOrder = onRequest(
  { region: "asia-northeast3", invoker: "public" },
  async (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    // Slack unfurl 방지: X-Robots-Tag + Cache-Control
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");

    if (!_restoreSecret()) {
      logger.error('[restoreOrder] RESTORE_API_TOKEN 미설정');
      res.status(500).send('<h1>500</h1><p>RESTORE_API_TOKEN 환경변수 미설정. functions/.env 확인.</p>');
      return;
    }

    if (req.method !== 'GET' && req.method !== 'POST') {
      res.set('Allow', 'GET, POST');
      res.status(405).send('<h1>405</h1><p>GET 미리보기와 POST 복원만 허용됩니다.</p>');
      return;
    }

    // 실행(POST) vs 미리보기(GET)
    const isExecute = req.method === 'POST';
    const params = isExecute ? (req.body || {}) : (req.query || {});
    const docId = String(params.docId || '');
    const explicitDate = params.date ? String(params.date) : '';
    const expiresAt = String(params.exp || '');
    const signature = String(params.sig || '');
    const signedContentHash = isExecute ? String(params.hash || '') : '';
    if (!docId || docId.length > 200 || docId.includes('/')) {
      res.status(400).send('<h1>400</h1><p>docId 파라미터 필요.</p>');
      return;
    }
    const signatureAction = isExecute ? 'execute' : 'preview';
    if (!_validRestoreSignature(signatureAction, docId, explicitDate, expiresAt, signature, signedContentHash)) {
      _logAuthAttempt('AUTH_FAIL', req, `method=${req.method} docId=${docId}`);
      res.status(401).send('<h1>401 인증 실패</h1><p>서명이 잘못되었거나 만료되었습니다.</p>');
      return;
    }

    try {
      const db = admin.firestore();
      const result = await _findBackupWithDoc(db, docId, explicitDate);
      if (!result.found) {
        _logAuthAttempt('BACKUP_MISS', req, `docId=${docId} date=${explicitDate}`);
        res.status(404).send(`<h1>404 백업 없음</h1><p>${_htmlEscape(result.reason)}</p>`);
        return;
      }
      if (isExecute) {
        const actualContentHash = _snapshotHash(result.target.data);
        if (String(result.date) !== explicitDate || !_safeSignatureEqual(signedContentHash, actualContentHash)) {
          _logAuthAttempt('SOURCE_CHANGED', req, `docId=${docId}`);
          res.status(409).send('<h1>409 복원 원본 변경</h1><p>미리보기 후 복원 원본이 바뀌었습니다. 새 링크로 다시 확인해주세요.</p>');
          return;
        }
      }

      const currentRef = db.collection("hanger_orders").doc(docId);
      const currentDoc = await currentRef.get();
      const alreadyExists = currentDoc.exists;

      // 덮어쓰기 절대 금지 — 옛 데이터로 오늘 수정본 파괴 방지
      if (alreadyExists) {
        _logAuthAttempt('OVERWRITE_REFUSED', req, `docId=${docId}`);
        res.status(409).send(`<!doctype html><html><head><meta charset="utf-8"><title>409 이미 존재</title></head><body style="font-family:sans-serif;max-width:600px;margin:20px auto;padding:0 20px">
<h1 style="color:#c00">409 이미 존재</h1>
<p><b>docId</b>: ${_htmlEscape(docId)} — hanger_orders 에 doc이 이미 있음.</p>
<p>복원 API는 <b>덮어쓰기 금지</b> — 옛 백업으로 오늘 수정본을 파괴할 위험.</p>
<p>정말 덮으려면: Firestore 콘솔에서 해당 doc 을 먼저 삭제 후 다시 이 링크 요청.</p>
</body></html>`);
        return;
      }

      // GET = 미리보기, POST = 실행
      if (!isExecute) {
        const dataJson = _htmlEscape(JSON.stringify(result.target.data, null, 2));
        const executeExp = Date.now() + 15 * 60 * 1000;
        const contentHash = _snapshotHash(result.target.data);
        const executeSig = _restoreSignature('execute', docId, result.date, executeExp, contentHash);
        res.send(`<!doctype html><html><head><meta charset="utf-8"><title>발주서 복원 미리보기</title></head><body style="font-family:sans-serif;max-width:800px;margin:20px auto;padding:0 20px">
<h1>발주서 복원 미리보기</h1>
<table style="border-collapse:collapse">
<tr><td style="padding:4px 8px"><b>docId</b></td><td>${_htmlEscape(docId)}</td></tr>
<tr><td style="padding:4px 8px"><b>orderNum</b></td><td>${_htmlEscape(result.target.data.orderNum || '(없음)')}</td></tr>
<tr><td style="padding:4px 8px"><b>복원 원본</b></td><td>${_htmlEscape(result.source || result.date)}</td></tr>
<tr><td style="padding:4px 8px"><b>현재 상태</b></td><td><span style="color:#080">✓ 없음 (복원 안전)</span></td></tr>
</table>
<h2>백업 내용</h2>
<pre style="max-height:500px;overflow:auto;background:#f5f5f5;padding:10px;border:1px solid #ddd">${dataJson}</pre>
<form method="POST" action="${_htmlEscape(req.path || '/')}" style="margin:20px 0">
  <input type="hidden" name="docId" value="${_htmlEscape(docId)}">
  <input type="hidden" name="date" value="${_htmlEscape(result.date)}">
  <input type="hidden" name="hash" value="${contentHash}">
  <input type="hidden" name="exp" value="${executeExp}">
  <input type="hidden" name="sig" value="${executeSig}">
  <button type="submit" style="background:#c00;color:#fff;padding:12px 24px;border:0;border-radius:4px;font-weight:bold;font-size:1em;cursor:pointer">복원 실행</button>
</form>
<p style="color:#666;font-size:0.9em">GET 은 미리보기만, 실제 복원은 15분 만료 POST 서명과 버튼 클릭으로만 실행됩니다.</p>
</body></html>`);
        return;
      }

      const orderNum = result.target.data.orderNum ? String(result.target.data.orderNum) : '';
      const logId = `restore_${_eventKey(`${docId}:${Date.now()}:${crypto.randomUUID()}`)}`;
      const logRef = db.collection("hanger_orders_cancel_log").doc(logId);
      const actorIp = req.ip || req.headers['x-forwarded-for'] || '(unknown)';
      // 발주서 create와 audit log create를 하나의 transaction으로 묶어
      // "복원은 됐지만 로그 실패로 500" 상태를 만들지 않는다.
      try {
        await db.runTransaction(async tx => {
          const existing = await tx.get(currentRef);
          if (existing.exists) {
            const err = new Error('RESTORE_ALREADY_EXISTS');
            err.restoreAlreadyExists = true;
            throw err;
          }
          tx.create(currentRef, result.target.data);
          tx.create(logRef, {
            id: logId,
            type: '복원',
            orderId: docId,
            orderNum,
            source: result.source || `_backups_hanger_orders/${result.date}`,
            actor: 'restore_api',
            actorIp,
            slackSent: false,
            at: admin.firestore.FieldValue.serverTimestamp(),
            restoredAt: new Date().toISOString()
          });
        });
      } catch (restoreErr) {
        if (restoreErr && restoreErr.restoreAlreadyExists) {
          _logAuthAttempt('OVERWRITE_REFUSED_TOCTOU', req, `docId=${docId}`);
          res.status(409).send(`<h1>409 이미 존재 (race)</h1><p>미리보기와 실행 사이에 doc 이 생성됨. 새 요청 필요.</p>`);
          return;
        }
        throw restoreErr;
      }
      logger.info(`[restoreOrder] 복원 성공: ${docId} (백업=${result.date}, ip=${actorIp})`);
      // 성공 시 Slack 알림 (감사 흔적)
      const slackResult = await _notifyRestoreSuccess(docId, orderNum, result.date, actorIp);
      try {
        await logRef.set({
          slackSent: !!slackResult.sent,
          slackNotifiedAt: slackResult.sent ? admin.firestore.FieldValue.serverTimestamp() : null,
          slackError: slackResult.sent ? admin.firestore.FieldValue.delete() : String(slackResult.reason || 'unknown')
        }, { merge: true });
      } catch (logUpdateErr) {
        logger.warn('[restoreOrder] Slack 상태 audit 갱신 실패:', logUpdateErr.message);
      }

      res.send(`<!doctype html><html><head><meta charset="utf-8"><title>복원 완료</title></head><body style="font-family:sans-serif;max-width:600px;margin:20px auto;padding:0 20px">
<h1 style="color:#080">✓ 복원 완료</h1>
<p><b>docId</b>: ${_htmlEscape(docId)}</p>
<p><b>orderNum</b>: ${_htmlEscape(orderNum || '(없음)')}</p>
<p><b>복원 원본</b>: ${_htmlEscape(result.source || result.date)}</p>
<p><code>hanger_orders_cancel_log</code> 에 복원 이벤트 기록됨.</p>
<p>Slack 알림: ${slackResult.sent ? '발송 완료' : '발송 실패 (audit log에 상태 저장됨)'}</p>
</body></html>`);
    } catch (e) {
      logger.error("[restoreOrder] 오류:", e.message, e.stack);
      res.status(500).send(`<h1>500 복원 실패</h1><p>${_htmlEscape(e.message)}</p>`);
    }
  }
);


// ── Supabase 실시간 sync (원본 앱 무접촉 · 별개 함수 파일)
const supabaseSync = require("./lib/supabase-sync");
exports.syncOrderCreated = supabaseSync.syncOrderCreated;
exports.syncOrderUpdated = supabaseSync.syncOrderUpdated;
exports.syncPaymentCreated = supabaseSync.syncPaymentCreated;
exports.syncInvoicesDoc = supabaseSync.syncInvoicesDoc;
