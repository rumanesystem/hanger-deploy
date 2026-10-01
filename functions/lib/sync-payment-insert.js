// 입금 1건 → ordering.payments 저장 · supabase-sync.js 의 입금 동기화에서 사용 (q·lookupUserId 는 그쪽 것을 넘겨받음).
const { logger } = require("firebase-functions");

// 입금 거래처 계정 · 거래처명과 일치하는 활성 발주자가 정확히 1명일 때만 (없음·동명이인 → null · 로그로 사후 확인).
// 새 앱 원장은 account_id 로 입금을 묶으므로 비어 있으면 그 입금이 잔액에서 빠진다.
async function lookupPaymentAccount(q, customer) {
  const r = await q("SELECT id FROM users WHERE role='orderer' AND active = TRUE AND (delivery_name = $1 OR name = $1)", [customer]);
  if (r.rowCount === 1) return r.rows[0].id;
  logger.warn("[sync-pay] 거래처 계정 연결 못 함 · account_id 비움", { customer, n: r.rowCount });
  return null;
}

async function insertPayment(q, lookupUserId, row, origCreatedBy) {
  const createdBy = await lookupUserId(origCreatedBy);
  const exists = await q("SELECT id FROM payments WHERE memo LIKE $1 LIMIT 1", [`%[fs:${row._docId}]%`]);
  if (exists.rowCount > 0) return { id: exists.rows[0].id, inserted: false };
  const accountId = await lookupPaymentAccount(q, row.customer);
  const r = await q(
    `INSERT INTO payments (customer, paid_on, amount, memo, created_by, created_at, is_legacy, account_id)
     VALUES ($1,$2,$3,$4,$5,$6,true,$7) RETURNING id`,
    [row.customer, row.paid_on, row.amount, row.memo, createdBy, row.created_at, accountId],
  );
  return { id: r.rows[0]?.id, inserted: true };
}

module.exports = { insertPayment, lookupPaymentAccount };
