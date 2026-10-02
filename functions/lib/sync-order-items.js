// 통계용 품목줄(ordering.order_items)을 원본 기준으로 다시 맞춘다.
// 옛 앱 Firestore 는 읽지도 쓰지도 않는다 · 새 앱 Supabase 한쪽만 손댄다.
//
// 추가가 아니라 "지우고 다시 넣기" · 몇 번을 돌려도 원본과 같아져 중복이 생기지 않는다.
// 건드리지 않는 경우:
//   · 새 앱에서 편집된 발주 (legacy_items 보호와 같은 기준)
//   · 재고를 이미 깐 발주 (deducted_quantity 가 날아가면 취소해도 재고가 안 돌아온다)
//   · 이름을 못 찾아 만들어낸 줄이 지금보다 적을 때 (있던 품목이 사라진다)

const { buildOrderItems } = require("./legacy-items");

// 발주앱 supabase-write.mjs 와 같은 방어 · 지금은 호출부가 상수를 넘기지만
// 나중에 변수로 바뀌어도 스키마 보간이 뚫리지 않게 막아둔다.
const ALLOWED_SCHEMAS = new Set(["ordering", "ordering_preview"]);

async function syncOrderItems(pool, schema, orderId, legacyItems) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return { skipped: "발주 id 이상함", inserted: 0, missing: 0 };
  if (!ALLOWED_SCHEMAS.has(schema)) throw new Error(`허용되지 않은 schema: ${schema}`);

  const client = await pool.connect();
  try {
    // 스키마는 트랜잭션 안에서 SET LOCAL · Transaction pooler 는 트랜잭션 밖 SET 이 이어지지 않을 수 있다
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO ${schema}`);

    // 확인과 삭제 사이에 누가 편집하거나 재고를 까면 그대로 지워버리게 된다 · FOR UPDATE 로 잠근다.
    const guard = await client.query(
      `SELECT o.is_legacy, o.edited_in_new_app,
              EXISTS (SELECT 1 FROM order_items oi
                       WHERE oi.order_id = o.id AND oi.deducted_quantity > 0) AS deducted
         FROM orders o WHERE o.id = $1 FOR UPDATE`,
      [id],
    );
    const g = guard.rows[0];
    const skip = !g ? "발주 없음"
      : !g.is_legacy ? "이관 발주 아님"
      : g.edited_in_new_app ? "새 앱에서 편집됨"
      : g.deducted ? "재고 차감됨"
      : null;
    if (skip) {
      await client.query("ROLLBACK");
      return { skipped: skip, inserted: 0, missing: 0 };
    }

    const { rows, missing } = buildOrderItems(legacyItems || {});
    if (missing > 0) {
      const cur = await client.query("SELECT COUNT(*)::int AS n FROM order_items WHERE order_id = $1", [id]);
      if (rows.length < cur.rows[0].n) {
        await client.query("ROLLBACK");
        return {
          skipped: `못 옮긴 품목 ${missing}건 · 줄이 ${cur.rows[0].n}→${rows.length} 로 줄어 보존`,
          inserted: 0, missing,
        };
      }
    }

    // 이 발주 한 건의 품목줄만 · order_id 조건 없는 DELETE 는 만들지 않는다.
    await client.query("DELETE FROM order_items WHERE order_id = $1", [id]);
    // 품목이 많아도 왕복 한 번으로 넣는다 · 줄마다 보내면 커넥션을 오래 붙잡는다.
    if (rows.length > 0) {
      const vals = [];
      const params = [];
      rows.forEach((r, i) => {
        const b = i * 6;
        vals.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, 0)`);
        params.push(id, r.productId, r.quantity, r.color, r.spec, r.unitPrice);
      });
      await client.query(
        `INSERT INTO order_items (order_id, product_id, quantity, color, spec, unit_price, deducted_quantity)
         VALUES ${vals.join(", ")}`,
        params,
      );
    }

    await client.query("COMMIT");
    return { skipped: null, inserted: rows.length, missing };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* 롤백 실패는 원래 에러를 덮지 않게 삼킨다 */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { syncOrderItems };
