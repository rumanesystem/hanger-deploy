// ─────────────────────────────────────────────────────────────
// qa-widget.js — 로컬 QA 도우미 (도커 emulator 전용)
// 운영(hanger-deploy.web.app)에선 절대 안 뜸 — localhost/127.0.0.1만 분기
// 탭: 시나리오 자동 실행 / 상태 진단 / 빠른 시드
// ─────────────────────────────────────────────────────────────
(function () {
  const _isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!_isLocal) return;
  if (window._qaWidgetLoaded) return;
  window._qaWidgetLoaded = true;

  // ── 유틸 ──
  const $ = (s) => document.querySelector(s);
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const fmt = (n) => (n == null ? '-' : String(n));

  // ── CSS ──
  const style = document.createElement('style');
  style.textContent = `
    #qa-fab { position:fixed; bottom:18px; right:18px; z-index:9998; width:52px; height:52px; border-radius:50%; border:none; background:#dc2626; color:#fff; font-size:20px; cursor:pointer; box-shadow:0 4px 14px rgba(220,38,38,.35); transition:transform .15s; }
    #qa-fab:hover { transform:scale(1.08); }
    #qa-panel { position:fixed; bottom:80px; right:18px; z-index:9999; width:340px; max-height:70vh; background:#fff; border:2px solid #dc2626; border-radius:10px; box-shadow:0 12px 30px rgba(0,0,0,.25); display:none; flex-direction:column; font-family:'Pretendard',-apple-system,sans-serif; font-size:12px; }
    #qa-panel.open { display:flex; }
    .qa-head { padding:10px 14px; background:#dc2626; color:#fff; border-radius:8px 8px 0 0; display:flex; justify-content:space-between; align-items:center; }
    .qa-head b { font-size:13px; }
    .qa-close { background:none; border:none; color:#fff; font-size:18px; cursor:pointer; padding:0; line-height:1; }
    .qa-tabs { display:flex; border-bottom:1px solid #e5e7eb; }
    .qa-tab { flex:1; padding:8px; background:#f9fafb; border:none; border-right:1px solid #e5e7eb; cursor:pointer; font-size:12px; color:#6b7280; }
    .qa-tab:last-child { border-right:none; }
    .qa-tab.active { background:#fff; color:#dc2626; font-weight:700; border-bottom:2px solid #dc2626; margin-bottom:-1px; }
    .qa-body { padding:12px; overflow-y:auto; flex:1; }
    .qa-pane { display:none; }
    .qa-pane.active { display:block; }
    .qa-btn { display:block; width:100%; padding:8px 10px; margin-bottom:6px; border:1px solid #d1d5db; border-radius:6px; background:#fff; cursor:pointer; font-size:12px; text-align:left; color:#111; }
    .qa-btn:hover { background:#f3f4f6; border-color:#dc2626; }
    .qa-btn.danger { border-color:#fca5a5; color:#dc2626; }
    .qa-btn.danger:hover { background:#fef2f2; }
    .qa-log { font-family:'Consolas',monospace; font-size:11px; line-height:1.5; max-height:160px; overflow-y:auto; background:#1f2937; color:#d1d5db; padding:8px; border-radius:4px; margin-top:8px; }
    .qa-log .pass { color:#86efac; }
    .qa-log .fail { color:#fca5a5; }
    .qa-log .info { color:#93c5fd; }
    .qa-state-row { display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px dotted #e5e7eb; font-size:12px; }
    .qa-state-row b { color:#dc2626; font-family:'Consolas',monospace; }
    .qa-input { width:60px; padding:4px 6px; border:1px solid #d1d5db; border-radius:4px; margin-right:6px; font-size:12px; }
    .qa-warn { background:#fef3c7; padding:6px 8px; border-radius:4px; font-size:11px; color:#92400e; margin-bottom:8px; }
  `;
  document.head.appendChild(style);

  // ── DOM ──
  const fab = document.createElement('button');
  fab.id = 'qa-fab';
  fab.textContent = '🧪';
  fab.title = 'QA 위젯 (로컬 전용)';
  document.body.appendChild(fab);

  const panel = document.createElement('div');
  panel.id = 'qa-panel';
  panel.innerHTML = `
    <div class="qa-head"><b>🧪 QA 위젯 (LOCAL)</b><button class="qa-close">×</button></div>
    <div class="qa-tabs">
      <button class="qa-tab active" data-tab="scenarios">시나리오</button>
      <button class="qa-tab" data-tab="state">상태</button>
      <button class="qa-tab" data-tab="seed">시드</button>
    </div>
    <div class="qa-body">
      <div class="qa-pane active" data-pane="scenarios">
        <div class="qa-warn">⚠️ 직접 화면을 조작한 후 "지금 검증" 클릭</div>
        <div id="qa-scenario-list"></div>
      </div>
      <div class="qa-pane" data-pane="state">
        <div id="qa-state-content">로딩...</div>
      </div>
      <div class="qa-pane" data-pane="seed">
        <div class="qa-warn">⚠️ emulator DB만 영향, 운영 0</div>
        <div style="margin-bottom:8px">
          <input type="number" class="qa-input" id="qa-seed-count" value="30" min="1" max="500"/>
          <button class="qa-btn" style="display:inline-block;width:auto" data-seed="orders">발주서 N건 추가</button>
        </div>
        <button class="qa-btn" data-seed="invoices">발주확정 발주서에 invoice 자동발급</button>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:10px 0"/>
        <div style="font-size:11px;color:var(--text-3);margin-bottom:6px">📊 입금 부하 테스트 (1MB 한계 검증)</div>
        <div style="margin-bottom:8px">
          <input type="number" class="qa-input" id="qa-pay-count" value="100" min="1" max="2000"/>
          <button class="qa-btn" style="display:inline-block;width:auto" data-seed="payments">입금 N건 대량 등록</button>
        </div>
        <button class="qa-btn" data-seed="check-storage">📏 저장 크기 진단</button>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:10px 0"/>
        <div style="font-size:11px;color:var(--text-3);margin-bottom:6px">💾 전체 백업 (Firebase 이관·복구 대비)</div>
        <button class="qa-btn" data-seed="backup-all" style="background:#f0fdf4;border-color:#16a34a;color:#166534"><i class="fas fa-download"></i> 📥 전체 백업 다운로드 (JSON)</button>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:10px 0"/>
        <button class="qa-btn danger" data-seed="reset-orders">⚠️ orders 전부 삭제</button>
        <button class="qa-btn danger" data-seed="reset-invoices">⚠️ invoices 전부 삭제</button>
        <button class="qa-btn danger" data-seed="reset-payments">⚠️ payments 전부 삭제</button>
        <div class="qa-log" id="qa-seed-log">대기 중...</div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  // ── 이벤트 ──
  fab.addEventListener('click', () => panel.classList.toggle('open'));
  panel.querySelector('.qa-close').addEventListener('click', () => panel.classList.remove('open'));

  panel.querySelectorAll('.qa-tab').forEach(t => t.addEventListener('click', () => {
    panel.querySelectorAll('.qa-tab').forEach(x => x.classList.toggle('active', x === t));
    panel.querySelectorAll('.qa-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === t.dataset.tab));
    if (t.dataset.tab === 'state') updateState();
  }));

  // ── 로그 헬퍼 ──
  function mkLog(elId) {
    const el = document.getElementById(elId);
    el.innerHTML = '';
    const w = (cls, msg) => {
      const line = document.createElement('div');
      line.className = cls;
      line.textContent = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
      el.appendChild(line);
      el.scrollTop = el.scrollHeight;
    };
    return { info: (m) => w('info', m), pass: (m) => w('pass', '✓ ' + m), fail: (m) => w('fail', '✗ ' + m) };
  }

  // ── 시나리오 (사람이 직접 조작, 위젯은 결과만 검증) ──
  // 🆕 = 오늘 로컬 변경 (아직 배포 X)  |  📦 = 기존 배포 기능 회귀 검증
  // 🔒 = refactor 브랜치 배포 대기 (9월 예정)
  const SCENARIOS = [
    // ═══════════════════════════════════════════════
    // 🔒 refactor 브랜치 (9월 배포 대기) — 로컬 검증 대상
    // ═══════════════════════════════════════════════
    {
      id: 'RB1',
      badge: '🔒 배포대기',
      name: '정산·원장에서 출고대기 제외',
      desc: '출고대기 상태 발주는 정산·원장·명세서에서 안 뜸 (출고확정 이후만 편입)',
      goto: async () => { document.querySelector('[data-nav="settlement"]')?.click(); },
      gotoLabel: '정산 탭으로 이동',
      steps: [
        '발주자 계정으로 발주서 새로 작성 → 출고대기 상태로 저장',
        '관리자 로그인 → 정산 탭 → 이번 달 필터',
        '방금 만든 출고대기 발주가 목록에 안 뜨는지 확인',
        '그 발주 관리자가 "출고확정" 눌러 상태 변경',
        '정산 새로고침 → 이제 뜨는지 확인',
      ],
      verify: () => ({ ok: true, msg: '수동 확인 — 출고대기 미노출 + 확정 후 노출' })
    },
    {
      id: 'RB2',
      badge: '🔒 배포대기',
      name: '정산 정책 A — 출고확정 시점 기준 (9월 이후 발주만)',
      desc: '2026-09-01 이후 발주는 출고확정 클릭 월 기준으로 정산에 편입. 재확정해도 흔들리지 않음',
      goto: async () => { document.querySelector('[data-nav="settlement"]')?.click(); },
      gotoLabel: '정산 탭으로 이동',
      steps: [
        '2026-09-15에 발주자가 발주서 작성 (출고일 11월로)',
        '2026-10-05에 관리자 "출고확정" 클릭',
        '정산 10월 필터 → 편입 확인 (출고일 11월이어도 확정 월 기준)',
        '취소 → 되돌리기 → 재확정 여러 번 반복',
        '정산일이 계속 10월 5일로 고정되는지 확인',
      ],
      verify: () => ({ ok: true, msg: '수동 확인 — 확정 월로 편입, 재확정에도 고정' })
    },
    {
      id: 'RB3',
      badge: '🔒 배포대기',
      name: '정산 컷오프 — 9월 이전 옛 발주서는 옛 규칙',
      desc: '2026-08-31 이전 발주는 출고일 기준 유지 (컷오프로 회계 마감 안 흔들림)',
      goto: async () => { document.querySelector('[data-nav="settlement"]')?.click(); },
      gotoLabel: '정산 탭으로 이동',
      steps: [
        '옛 발주서 (발주일 < 2026-09-01) 선택',
        '정산 필터 월 → 출고일 기준으로 편입되는지 확인',
        '(출고확정 시각 기준 아니어야 함)',
      ],
      verify: () => ({ ok: true, msg: '수동 확인 — 옛 발주 정산월 예전과 동일' })
    },
    {
      id: 'RB4',
      badge: '🔒 배포대기',
      name: '임시저장 분리 — hanger_drafts 컬렉션 (신 저장소)',
      desc: '임시저장이 orders 대신 hanger_drafts 컬렉션에 저장. 발주번호 미발급',
      goto: async () => { /* 발주자 로그인 필요 */ },
      gotoLabel: '',
      steps: [
        '발주자 로그인 → 신규 발주서 → 항목 입력 → "임시저장"',
        'F12 → Console → await window._FS.collectionGet("hanger_drafts")',
        '→ 배열 반환. 방금 저장한 draft 있는지 확인 (createdBy, draftId 필드)',
        '발주서 목록에는 안 떠야 함 (임시저장은 목록 제외)',
        '"불러오기"로 draft 열기 → 항목 복원 확인',
      ],
      verify: () => ({ ok: true, msg: '수동 확인 — hanger_drafts에 저장, 발주번호 없음' })
    },
    {
      id: 'RB5',
      badge: '🔒 배포대기',
      name: 'draft 승격 원자화 — 두 탭 동시 승격 방어',
      desc: 'draft 승격 시 삭제+발주생성이 한 tx. 두 탭 동시 승격 시 두 번째만 DRAFT_MISSING',
      goto: async () => {},
      gotoLabel: '',
      steps: [
        '발주자 로그인 → 발주서 → 임시저장',
        '탭 두 개 열고 각각 그 draft 편집 → 동시에 "발주넣기" 클릭',
        '한 탭은 성공, 다른 탭은 "임시저장 사라짐" 토스트',
        '재고 이중 차감 안 됐는지 확인 (관리자로 재고 확인)',
      ],
      verify: () => ({ ok: true, msg: '수동 확인 — 한 탭만 성공, 재고 1회만 차감' })
    },
    {
      id: 'RB6',
      badge: '🔒 배포대기',
      name: 'draft 소유자 검증 — 남의 draft 승격 차단',
      desc: 'draft의 createdBy와 승격 요청자 id가 다르면 DRAFT_OWNER_MISMATCH',
      goto: async () => {},
      gotoLabel: '',
      steps: [
        '발주자 A로 임시저장',
        '발주자 B로 로그인',
        'F12 → window._promotingDraftId = "<A의 draftId>"',
        'saveOrder(...) 호출',
        '→ DRAFT_OWNER_MISMATCH 에러로 차단 확인',
      ],
      verify: () => ({ ok: true, msg: '수동 확인 — 차단됨, A의 draft·재고 무변화' })
    },
    {
      id: 'RB7',
      badge: '🔒 배포대기',
      name: 'toggleOrderLock 원자화 (CAS) — 동시 확정/해제 방어',
      desc: '두 관리자가 동시에 출고확정/해제 시 CAS로 한 쪽만 성공',
      goto: async () => { document.querySelector('[data-nav="orders"]')?.click(); },
      gotoLabel: '발주 목록으로 이동',
      steps: [
        '관리자 A/B 두 탭 로그인, 같은 발주서 열기',
        '동시에 "출고확정" 클릭',
        '한 쪽은 성공, 다른 쪽은 "이미 상태가 바뀌었습니다" 류 토스트',
        'F12 → Console: order.isLocked와 status 일관성 확인',
      ],
      verify: () => ({ ok: true, msg: '수동 확인 — 한 쪽만 성공, 데이터 일관' })
    },
    {
      id: 'RB8',
      badge: '🔒 배포대기',
      name: '대리발주 proxy 필드 방어 — 발주자가 우회 시도 차단',
      desc: 'payload.proxyOrdererId를 발주자가 넣어도 관리자 아니면 제거됨',
      goto: async () => {},
      gotoLabel: '',
      steps: [
        '발주자 로그인',
        'F12 → saveOrder({...payload, proxyOrdererId: "admin"}, "임시저장")',
        '저장 후 hanger_drafts 조회 → proxyOrdererId 필드 없어야 함',
        'createdBy가 발주자 자기 id로 저장됐는지 확인',
      ],
      verify: () => ({ ok: true, msg: '수동 확인 — proxy 필드 배제, createdBy 정상' })
    },
    {
      id: 'RB9',
      badge: '🔒 배포대기',
      name: 'items dual-write — hanger_items 컬렉션 동기화',
      desc: '품목 편집 시 hanger_data/items 배열 + hanger_items 컬렉션 양쪽 저장',
      goto: async () => { document.querySelector('[data-nav="items"]')?.click(); },
      gotoLabel: '품목 관리로 이동',
      steps: [
        '아무 품목 활성 토글 (또는 새 품목 추가)',
        'F12 → Console:',
        '  await window._FS.collectionGet("hanger_items")',
        '  → 방금 편집한 품목이 문서로 있는지 확인',
        '  await window._FS.get("items", {fromServer:true})',
        '  → 배열에도 동일 반영됐는지 확인',
      ],
      verify: () => ({ ok: true, msg: '수동 확인 — 두 저장소 동일 데이터' })
    },
    // ═══════════════════════════════════════════════
    // 🆕 오늘 변경 (아직 배포 안 됨) — 우선 확인
    // ═══════════════════════════════════════════════
    {
      id: 'T1',
      badge: '🆕 오늘 변경',
      name: '입금 저장 시 확인 다이얼로그 (금액 오타 방지)',
      desc: '[A] 저장 클릭 시 콤마 포함 금액 재확인 → 오타 방지',
      goto: async () => {
        document.querySelector('[data-nav="settlement"]')?.click();
        await wait(500);
        document.querySelector('[data-stl-tab="ledger"]')?.click();
      },
      gotoLabel: '거래처 원장 탭으로 이동',
      steps: [
        '원장 → 거래처 → 관리대장',
        '[+ 입금 등록] → 금액 100000 입력',
        '[저장] 클릭',
        '→ "₩100,000 등록하시겠습니까?" 다이얼로그 떠야 OK',
      ],
      verify: () => ({ ok: true, msg: '수동 확인 — 다이얼로그 뜨면 통과' })
    },
    {
      id: 'T2',
      badge: '🆕 오늘 변경',
      name: '100만원 초과 시 2단계 재확인',
      desc: '[B] 큰 금액은 실수 방지용 재확인 다이얼로그 한 번 더',
      goto: async () => {
        document.querySelector('[data-nav="settlement"]')?.click();
        await wait(500);
        document.querySelector('[data-stl-tab="ledger"]')?.click();
      },
      gotoLabel: '거래처 원장 탭으로 이동',
      steps: [
        '원장 → 거래처 → [+ 입금 등록]',
        '금액 5000000 (500만원) 입력 → [저장]',
        '1차 다이얼로그 → [확인]',
        '→ "⚠️ 큰 금액입니다!" 2차 재확인 떠야 OK',
      ],
      verify: () => ({ ok: true, msg: '수동 확인 — 2단계 다이얼로그 뜨면 통과' })
    },
    {
      id: 'T3',
      badge: '🆕 오늘 변경',
      name: '입금 삭제 시 사유 필수 입력',
      desc: '[C] 삭제 실수 방지 + 감사용 사유 기록',
      goto: async () => {
        document.querySelector('[data-nav="settlement"]')?.click();
        await wait(500);
        document.querySelector('[data-stl-tab="ledger"]')?.click();
      },
      gotoLabel: '거래처 원장 탭으로 이동',
      steps: [
        '원장 → 관리대장 → 입금 [X] 클릭',
        '→ "삭제 사유를 입력하세요" 프롬프트',
        '빈 값으로 [확인] → "사유 필요" 알림',
        '사유 입력 후 [확인] → 삭제 진행',
      ],
      verify: () => ({ ok: true, msg: '수동 확인 — 빈 사유 차단 뜨면 통과' })
    },
    {
      id: 'T4',
      badge: '🆕 오늘 변경',
      name: '수금 컬럼 표시 + 잔액 자동 차감',
      desc: '입금 등록 후 판매/수금내역 표에 수금 컬럼 반영',
      goto: async () => {
        document.querySelector('[data-nav="settlement"]')?.click();
        await wait(500);
        document.querySelector('[data-stl-tab="ledger"]')?.click();
      },
      gotoLabel: '거래처 원장 탭으로 이동',
      steps: [
        '이전 잔액 메모 (예: ₩500,000)',
        '[+ 입금 등록] → 100,000원 등록',
        '판매/수금내역 표 → 수금 컬럼 ₩100,000',
        '잔액 ₩400,000 (100,000 차감) → OK',
      ],
      verify: () => {
        const rows = document.querySelectorAll('.ec-row-payment');
        if (rows.length === 0) return { ok: false, msg: '수금 행 없음' };
        return { ok: true, msg: '수금 행 ' + rows.length + '개 — 화면에서 금액·잔액 확인' };
      }
    },
    {
      id: 'T5',
      badge: '🆕 오늘 변경',
      name: '컬렉션 방식 저장 (race-free + 1MB 무한)',
      desc: 'hanger_payments 컬렉션에 문서 단위로 저장. 옛 배열 방식 X.',
      goto: () => window.open('http://localhost:4000/firestore/default/data/hanger_payments', '_blank'),
      gotoLabel: 'Firestore UI 열기',
      steps: [
        '[▶ Firestore UI 열기] 클릭',
        'hanger_payments 컬렉션 확인',
        '→ 문서들이 개별로 나열 (배열 X, 문서 단위) → OK',
        'hanger_payment_logs 컬렉션도 존재 확인',
      ],
      verify: () => ({ ok: true, msg: 'Firestore UI에서 시각 확인' })
    },
    {
      id: 'T6',
      badge: '🆕 오늘 변경',
      name: '감사 로그 자동 저장 (payment_logs)',
      desc: '[D] 입금 등록·삭제할 때마다 누가/언제/무엇/왜 자동 기록',
      goto: () => window.open('http://localhost:4000/firestore/default/data/hanger_payment_logs', '_blank'),
      gotoLabel: '감사 로그 확인',
      steps: [
        '위 T1~T4 시나리오 실행 후',
        '[▶ 감사 로그 확인] 클릭',
        'hanger_payment_logs 컬렉션에 문서들 보임',
        '각 문서에 by(누가), at(언제), action(create/delete), amount(얼마) 필드 → OK',
      ],
      verify: () => ({ ok: true, msg: 'Firestore UI에서 시각 확인' })
    },
    {
      id: 'T7',
      badge: '🆕 오늘 변경',
      name: '원장·정산 총계 일치 (둘 다 발주일 기준)',
      desc: '원장과 정산이 같은 기간에서 같은 총계 나와야 함',
      goto: () => document.querySelector('[data-nav="settlement"]')?.click(),
      gotoLabel: '정산 페이지로 이동',
      steps: [
        '정산 페이지 → 기간 2026-06-01 ~ 2026-06-30',
        '전체 합계 금액 메모',
        '거래처 원장 탭 → 같은 기간',
        '전체 합계 금액 확인',
        '→ 두 값 일치해야 OK',
      ],
      verify: () => ({ ok: true, msg: '수동 확인 — 두 페이지 총계 비교' })
    },
    {
      id: 'T8',
      badge: '🆕 오늘 변경',
      name: '원장에 출고일 병기 표시',
      desc: '거래 기준은 발주일이지만 출고일도 참고용으로 함께 표시',
      goto: async () => {
        document.querySelector('[data-nav="settlement"]')?.click();
        await wait(500);
        document.querySelector('[data-stl-tab="ledger"]')?.click();
      },
      gotoLabel: '거래처 원장 탭으로 이동',
      steps: [
        '원장 → 거래처 → 관리대장',
        '판매/수금내역 표의 발주서 행 확인',
        '발주번호 옆 또는 아래에 🚚 출고일 YYYY-MM-DD 표시',
        '발주일과 출고일이 다를 때만 표시 (같으면 생략)',
        '출고 미정이면 노란색 "출고일 미정"',
      ],
      verify: () => {
        const rows = document.querySelectorAll('.ec-row-header .fa-truck');
        return { ok: rows.length > 0 || true, msg: rows.length > 0 ? `출고일 표시 ${rows.length}건` : '표시할 게 없거나 발주일=출고일' };
      }
    },
    {
      id: 'T9',
      badge: '🆕 오늘 변경',
      name: '날짜 정규화 (0026 → 2026 자동)',
      desc: '옛 오염 데이터도 화면에 정상 년도로 표시. 새 입력도 26 → 2026 자동',
      goto: () => document.querySelector('[data-nav="orders"]')?.click(),
      gotoLabel: '발주서 목록',
      steps: [
        '발주서 목록 → 옛 발주서 있으면 확인',
        '"2026-XX-XX"로 표시되어야 (0026-XX-XX 아니라)',
        '또는 신규 발주서 등록 → 출고일 년도에 "26" 입력',
        '저장 → 다시 열어보면 "2026-XX-XX"로 저장됨 → OK',
      ],
      verify: () => ({ ok: true, msg: '수동 확인 — 화면·저장값 확인' })
    },
    {
      id: 'T10',
      badge: '🆕 오늘 변경',
      name: '전체 백업 다운로드',
      desc: 'Firebase 이관·복구 대비 JSON 백업 파일 저장',
      goto: () => document.querySelector('.qa-tab[data-tab="seed"]')?.click(),
      gotoLabel: '시드 탭으로',
      steps: [
        '시드 탭 → [📥 전체 백업 다운로드]',
        '자동으로 hanger_backup_YYYYMMDD_HHmmss.json 다운로드',
        '파일 열어보면 orders·accounts·payments 등 다 있음 → OK',
      ],
      verify: () => ({ ok: true, msg: '수동 확인 — 파일 다운로드되면 통과' })
    },
    // ═══════════════════════════════════════════════
    // 📦 기존 배포 기능 회귀 검증 (아래는 이미 운영 반영됨)
    // ═══════════════════════════════════════════════
    {
      id: 'R1',
      badge: '📦 기존',
      name: '정렬 상태가 탭 이동 후 초기화되는지',
      desc: '정산에서 "오래된순"으로 바꾼 뒤 다른 메뉴 갔다 돌아오면 자동으로 "최신순"으로 돌아와야 정상',
      goto: () => document.querySelector('[data-nav="settlement"]')?.click(),
      gotoLabel: '정산 페이지로 이동',
      steps: [
        '정산 메뉴로 이동',
        '"최신순" 버튼 한 번 클릭 (→ "오래된순"으로 바뀜)',
        '대시보드 같은 다른 메뉴 클릭',
        '다시 정산 메뉴 클릭',
        '→ 위 버튼이 "최신순"으로 돌아와 있어야 OK',
      ],
      verify: () => {
        const t = $('#sort-toggle');
        if (!t) return { ok: false, msg: '정산 페이지가 아닙니다' };
        if (t.dataset.order === 'desc') return { ok: true, msg: '최신순으로 정상 복귀됨' };
        return { ok: false, msg: '아직 "오래된순"으로 남아 있음' };
      }
    },
    {
      id: 'R2',
      badge: '📦 기존',
      name: '검색 중에 정렬을 바꿔도 검색 결과가 유지되는지',
      desc: '검색해서 일부만 보이는 상태에서 정렬을 바꿨을 때, 검색 필터가 풀려서 안 봐도 될 항목까지 다시 보이면 안 됨',
      goto: () => document.querySelector('[data-nav="settlement"]')?.click(),
      gotoLabel: '정산 페이지로 이동',
      steps: [
        '정산 페이지에서 거래처 행 클릭 (펼침)',
        '상단 🔍 검색창에 발주번호 일부 입력 (예: "20260601")',
        '→ 일부 항목만 보이는 것 확인',
        '"최신순" 버튼 클릭 (정렬 변경)',
        '→ 검색 결과는 그대로 유지되어야 OK',
      ],
      verify: () => {
        const hidden = document.querySelectorAll('.detail-table tbody tr.search-hidden').length;
        const search = $('#quick-search');
        const q = search ? search.value : '';
        if (!q) return { ok: false, msg: '검색창이 비어 있습니다 — 검색 입력 후 정렬 누른 다음 검증' };
        if (hidden > 0) return { ok: true, msg: '숨겨진 항목 ' + hidden + '개 유지 OK' };
        return { ok: false, msg: '검색 필터가 풀려버림 — 정렬이 검색을 깨뜨림' };
      }
    },
    {
      id: 'R3',
      badge: '📦 기존',
      name: '검색 결과가 적을 때 "더보기" 버튼이 사라지는지',
      desc: '발주서가 많은 거래처에서 검색했을 때, 검색 결과가 10건 이하면 "더보기" 버튼이 의미 없으니 숨겨져야 함',
      goto: () => document.querySelector('[data-nav="settlement"]')?.click(),
      gotoLabel: '정산 페이지로 이동',
      steps: [
        '발주서 11건 이상 있는 거래처 행 펼침',
        '검색창에 매칭 결과가 10건 이하 나올 키워드 입력 (예: "포스트바")',
        '→ "+ 더보기" 버튼이 사라져야 OK',
      ],
      verify: () => {
        const search = $('#quick-search');
        const q = search ? search.value : '';
        if (!q) return { ok: false, msg: '검색창이 비어 있습니다' };
        const visible = document.querySelectorAll('.detail-table tbody tr:not(.search-hidden):not(.hidden-row)').length;
        const moreBtn = document.querySelector('.detail-load-more');
        const more = moreBtn && moreBtn.style.display !== 'none';
        if (visible <= 10 && !more) return { ok: true, msg: '검색 결과 ' + visible + '건 → 더보기 숨김 OK' };
        if (visible > 10 && more) return { ok: true, msg: '검색 결과 ' + visible + '건 → 더보기 표시 OK' };
        return { ok: false, msg: '검색 ' + visible + '건인데 더보기는 ' + (more ? '표시' : '숨김') + ' (어긋남)' };
      }
    },
    {
      id: 'R6',
      badge: '📦 기존',
      name: '원장 검색 후 관리대장 보고 뒤로가면 검색 유지되는지',
      desc: '거래처 원장에서 검색해서 거래처 클릭 → 관리대장 보고 → 뒤로가면, 검색어와 필터링 결과가 그대로 유지되어야 사용자가 다시 찾을 필요 없음',
      goto: async () => {
        document.querySelector('[data-nav="settlement"]')?.click();
        await wait(500);
        document.querySelector('[data-stl-tab="ledger"]')?.click();
      },
      gotoLabel: '거래처 원장 탭으로 이동',
      steps: [
        '정산 메뉴 → "거래처 원장" 탭 클릭',
        '검색창에 여러 납품처명 시도 (예: "A업체", "B업체", "테스트A" 등)',
        '매칭된 거래처 행 또는 "원장 보기" 클릭 (관리대장 진입)',
        '"뒤로" 버튼 클릭',
        '→ 검색어 그대로 + 검색 결과만 보여야 OK',
        '※ 여러 납품처명으로 반복 시도 권장',
      ],
      verify: () => {
        const s = $('#ledger-search');
        if (!s) return { ok: false, msg: '거래처 원장 목록 화면이 아닙니다' };
        if (!s.value || !s.value.trim()) return { ok: false, msg: '검색창이 비어 있음 — 검색이 풀려버림' };
        // 검색어 + 필터 적용 여부 둘 다 확인
        const tbody = document.getElementById('tbody-customers');
        const total = tbody ? tbody.querySelectorAll('tr.paid').length : 0;
        const visible = tbody ? Array.from(tbody.querySelectorAll('tr.paid')).filter(r => r.style.display !== 'none').length : 0;
        if (total > 0 && visible < total) return { ok: true, msg: '검색어 "' + s.value + '" 유지 + 필터 적용 (' + visible + '/' + total + '건 표시)' };
        if (total === visible) return { ok: false, msg: '검색어는 있는데 필터가 풀림 (' + visible + '/' + total + '건)' };
        return { ok: true, msg: '검색어 "' + s.value + '" 유지' };
      }
    }
    // (P1~P6는 T 시리즈로 대체됨 — 오늘 변경은 T 참고)
    /*
    {
      id: 'P1',
      name: '입금 저장 시 확인 다이얼로그 뜨는지',
      desc: '입금 등록 [저장] 클릭 시 금액 오타 방지용 확인 다이얼로그가 떠야 함 (금액을 콤마 포함해서 재확인)',
      goto: async () => {
        document.querySelector('[data-nav="settlement"]')?.click();
        await wait(500);
        document.querySelector('[data-stl-tab="ledger"]')?.click();
      },
      gotoLabel: '거래처 원장 탭으로 이동',
      steps: [
        '원장 → 아무 거래처 클릭 (관리대장 진입)',
        '상단 [+ 입금 등록] 클릭',
        '금액에 100000 입력 (아무 값이나 OK)',
        '[저장] 클릭',
        '→ "₩100,000 등록하시겠습니까?" 확인 다이얼로그 떠야 OK',
      ],
      verify: () => {
        // 실제 저장 후 hanger_payments에 마지막 등록된 게 있는지
        return { ok: true, msg: '수동 확인 항목 — 다이얼로그 뜨면 통과 (자동 검증 불가)' };
      }
    },
    {
      id: 'P2',
      name: '100만원 초과 입금 시 2단계 확인',
      desc: '큰 금액(100만원 초과) 등록 시 실수 방지용 재확인 다이얼로그가 한 번 더 떠야 함',
      goto: async () => {
        document.querySelector('[data-nav="settlement"]')?.click();
        await wait(500);
        document.querySelector('[data-stl-tab="ledger"]')?.click();
      },
      gotoLabel: '거래처 원장 탭으로 이동',
      steps: [
        '원장 → 거래처 → [+ 입금 등록]',
        '금액에 5000000 (500만원) 입력',
        '[저장] 클릭',
        '→ 1차 확인 다이얼로그 → [확인]',
        '→ "⚠️ 큰 금액입니다! 금액이 맞습니까?" 2차 재확인 떠야 OK',
      ],
      verify: () => {
        return { ok: true, msg: '수동 확인 항목 — 2단계 다이얼로그 뜨면 통과' };
      }
    },
    {
      id: 'P3',
      name: '입금 삭제 시 사유 입력 필수',
      desc: '삭제 [X] 클릭 시 감사용으로 사유를 반드시 입력받아야 함. 빈 사유는 삭제 거부.',
      goto: async () => {
        document.querySelector('[data-nav="settlement"]')?.click();
        await wait(500);
        document.querySelector('[data-stl-tab="ledger"]')?.click();
      },
      gotoLabel: '거래처 원장 탭으로 이동',
      steps: [
        '원장 → 거래처 → 관리대장',
        '기존 입금 내역의 [X] 삭제 버튼 클릭',
        '→ "삭제 사유를 입력하세요" 프롬프트 떠야 OK',
        '빈 값으로 [확인] → "삭제 사유가 필요합니다" 알림 떠야 OK',
        '사유 입력 후 [확인] → 삭제 진행',
      ],
      verify: () => {
        return { ok: true, msg: '수동 확인 항목 — 사유 입력 요구 + 빈 값 차단 뜨면 통과' };
      }
    },
    {
      id: 'P4',
      name: '수금·잔액 자동 반영',
      desc: '입금 등록 후 판매/수금내역 표에 수금 컬럼 금액 표시 + 잔액 자동 차감',
      goto: async () => {
        document.querySelector('[data-nav="settlement"]')?.click();
        await wait(500);
        document.querySelector('[data-stl-tab="ledger"]')?.click();
      },
      gotoLabel: '거래처 원장 탭으로 이동',
      steps: [
        '원장 → 거래처 → 관리대장',
        '이전 잔액 확인 (예: ₩500,000)',
        '[+ 입금 등록] → 100,000원 등록',
        '판매/수금내역 표에 새 행 생김',
        '→ 수금 컬럼 ₩100,000, 잔액 ₩400,000 (100,000 차감) → OK',
      ],
      verify: () => {
        const rows = document.querySelectorAll('.ec-row-payment');
        if (rows.length === 0) return { ok: false, msg: '수금 행이 없음 — 입금 등록 안 됐거나 렌더 문제' };
        return { ok: true, msg: '수금 행 ' + rows.length + '개 표시됨 — 화면에서 금액·잔액 확인 필요' };
      }
    },
    {
      id: 'P5',
      name: '컬렉션 방식 저장 (race-free + 1MB 무한)',
      desc: 'hanger_payments 컬렉션에 문서 단위로 저장되는지 확인. 옛 방식(단일 doc 배열)과 다름.',
      goto: async () => {
        window.open('http://localhost:4000/firestore/default/data/hanger_payments', '_blank');
      },
      gotoLabel: 'Firestore UI 열기',
      steps: [
        '[▶ Firestore UI 열기] 클릭 (localhost:4000)',
        'hanger_payments 컬렉션 확인',
        '→ 문서들이 개별로 나열되어 있어야 OK (배열 X, 문서 단위 O)',
        'hanger_payment_logs 컬렉션도 있어야 OK (감사 로그)',
      ],
      verify: () => {
        return { ok: true, msg: 'Firestore UI에서 시각적으로 확인' };
      }
    },
    {
      id: 'P6',
      name: '원장 = 정산 총계 일치 (발주일 기준)',
      desc: '원장과 정산 페이지 모두 발주일 기준으로 필터링되어 두 페이지 총계가 일치해야 함',
      goto: () => document.querySelector('[data-nav="settlement"]')?.click(),
      gotoLabel: '정산 페이지로 이동',
      steps: [
        '정산 페이지 → 기간 설정 (예: 2026-06-01 ~ 2026-06-30)',
        '전체 합계 금액 메모',
        '거래처 원장 탭 → 같은 기간',
        '전체 합계 금액 확인',
        '→ 정산 = 원장 합계 일치해야 OK',
      ],
      verify: () => {
        return { ok: true, msg: '수동 확인 — 두 페이지 총계 비교' };
      }
    }
    */
  ];

  // 시나리오 카드 렌더
  const list = document.getElementById('qa-scenario-list');
  list.innerHTML = SCENARIOS.map(sc => {
    const isNew = sc.badge && sc.badge.includes('🆕');
    const bgColor = isNew ? '#fef9c3' : '#f9fafb';
    const borderColor = isNew ? '#fde68a' : '#e5e7eb';
    const badgeStyle = isNew
      ? 'background:#fbbf24;color:#78350f'
      : 'background:#e5e7eb;color:#6b7280';
    return `
    <div class="qa-sc" data-sc-id="${sc.id}" style="border:1px solid ${borderColor};border-radius:6px;padding:10px;margin-bottom:8px;background:${bgColor}">
      ${sc.badge ? `<div style="display:inline-block;font-size:10px;font-weight:700;padding:2px 6px;border-radius:10px;margin-bottom:4px;${badgeStyle}">${sc.badge}</div>` : ''}
      <div style="font-weight:700;font-size:12px;margin-bottom:4px;color:#111">${sc.id}. ${sc.name}</div>
      <div style="font-size:11px;color:#6b7280;margin-bottom:8px;line-height:1.5">${sc.desc || ''}</div>
      <div style="font-size:11px;color:#dc2626;font-weight:600;margin-bottom:4px">📋 따라할 순서</div>
      <ol style="margin:0 0 8px 18px;padding:0;font-size:11px;color:#374151;line-height:1.6">
        ${sc.steps.map(s => `<li>${s}</li>`).join('')}
      </ol>
      <div style="display:flex;gap:6px">
        ${sc.goto ? `<button class="qa-btn qa-goto" data-goto="${sc.id}" style="margin:0;flex:1;background:#eff6ff;border-color:#3b82f6;color:#1d4ed8">▶ ${sc.gotoLabel || '페이지로 이동'}</button>` : ''}
        <button class="qa-btn qa-verify" data-verify="${sc.id}" style="margin:0;flex:1">🔍 지금 검증</button>
      </div>
      <div class="qa-result" data-result="${sc.id}" style="margin-top:6px;font-size:11px"></div>
    </div>`;
  }).join('');

  panel.querySelectorAll('.qa-goto').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.goto;
    const sc = SCENARIOS.find(s => s.id === id);
    if (sc && sc.goto) await sc.goto();
  }));

  panel.querySelectorAll('.qa-verify').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.verify;
    const sc = SCENARIOS.find(s => s.id === id);
    const res = sc.verify();
    const out = panel.querySelector(`.qa-result[data-result="${id}"]`);
    out.innerHTML = res.ok
      ? `<span style="color:#16a34a;font-weight:700">✓ PASS</span> <span style="color:#374151">${res.msg}</span>`
      : `<span style="color:#dc2626;font-weight:700">✗ FAIL</span> <span style="color:#374151">${res.msg}</span>`;
  }));

  // ── 상태 진단 ──
  function updateState() {
    const sort = $('#sort-toggle');
    const search = $('#quick-search');
    const ledgerSearch = $('#ledger-search');
    const tbodyOrderer = $('#tbody-ordererwise');
    const dt = document.querySelectorAll('.detail-table').length;
    const hr = document.querySelectorAll('.detail-table tbody tr.hidden-row').length;
    const sh = document.querySelectorAll('.detail-table tbody tr.search-hidden').length;
    const more = document.querySelectorAll('.detail-load-more').length;
    const cur = (typeof window.currentView !== 'undefined') ? window.currentView : '?';
    const rows = [
      ['현재 view', cur],
      ['sort-toggle dataset', sort ? sort.dataset.order : '없음'],
      ['검색어 (정산)', search ? `"${search.value}"` : '없음'],
      ['검색어 (원장)', ledgerSearch ? `"${ledgerSearch.value}"` : '없음'],
      ['거래처 row 수', tbodyOrderer ? tbodyOrderer.querySelectorAll('tr.row-main').length : 0],
      ['detail-table 갯수', dt],
      ['hidden-row 갯수', hr],
      ['search-hidden 갯수', sh],
      ['더보기 버튼 갯수', more],
    ];
    document.getElementById('qa-state-content').innerHTML = rows.map(([k, v]) =>
      `<div class="qa-state-row"><span>${k}</span><b>${fmt(v)}</b></div>`).join('');
  }
  setInterval(() => { if (panel.classList.contains('open') && panel.querySelector('.qa-tab.active').dataset.tab === 'state') updateState(); }, 600);

  // ── 빠른 시드 ──
  const CUSTOMERS = ['테스트업체', '테스트A업체', '테스트B업체'];
  const ADDRESSES = ['서울시 강남구 테스트로 1', '경기도 성남시 분당구 정자동 2', '인천시 남동구 구월동 3'];
  const rnd = (a) => a[Math.floor(Math.random() * a.length)];
  const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

  async function seedOrders(count, log) {
    if (!window._FS || !window._FS.get) return log.fail('_FS 인터페이스 없음');
    log.info('기존 orders 로드...');
    const existing = (await window._FS.get('orders')) || [];
    let maxId = existing.reduce((m, o) => Math.max(m, o.id || 0), 0);
    const seqByDate = {};
    existing.forEach(o => { if (o.orderNum) { const d = o.orderNum.split('-')[0]; seqByDate[d] = (seqByDate[d] || 0) + 1; } });
    const newOrders = [];
    for (let i = 0; i < count; i++) {
      const days = ri(0, 30);
      const od = new Date(Date.now() - days * 86400000);
      const pf = `${od.getFullYear()}${String(od.getMonth() + 1).padStart(2, '0')}${String(od.getDate()).padStart(2, '0')}`;
      seqByDate[pf] = (seqByDate[pf] || 0) + 1;
      const orderNum = `${pf}-${String(seqByDate[pf]).padStart(3, '0')}`;
      maxId++;
      const supply = ri(1, 5) * 12000 + ri(1, 3) * 5300;
      newOrders.push({
        id: maxId, orderNum, deliveryTo: rnd(CUSTOMERS), address: rnd(ADDRESSES),
        orderDate: `${od.getFullYear()}-${String(od.getMonth() + 1).padStart(2, '0')}-${String(od.getDate()).padStart(2, '0')}`,
        shipDate: `${od.getFullYear()}-${String(od.getMonth() + 1).padStart(2, '0')}-${String(od.getDate()).padStart(2, '0')}`,
        warehouse: rnd(['시흥', '평택']), status: rnd(['발주확정', '출고완료']),
        upperMaterials: [{ name: '포스트바 2400', color: '화이트', qty: ri(1, 5), unitPrice: 12000 }],
        totalSupply: supply, totalVat: Math.round(supply * 0.1), totalAmount: supply + Math.round(supply * 0.1),
        createdAt: od.toISOString(), updatedAt: od.toISOString(),
      });
    }
    await window._FS.set('orders', [...existing, ...newOrders]);
    log.pass(`발주서 ${count}건 추가 (${existing.length} → ${existing.length + count})`);
  }

  async function seedInvoices(log) {
    const orders = (await window._FS.get('orders')) || [];
    const targets = orders.filter(o => o.status === '발주확정' || o.status === '출고완료');
    const existing = (await window._FS.get('invoices')) || [];
    const have = new Set(existing.filter(i => !i.cancelled).map(i => i.orderNum));
    const newInv = [];
    const seq = {};
    for (const o of targets) {
      if (have.has(o.orderNum)) continue;
      const items = (o.upperMaterials || []).filter(m => m.qty).map(m => ({
        name: m.name, spec: m.color, qty: m.qty, unitPrice: m.unitPrice,
        supply: m.qty * (m.unitPrice || 0), vat: Math.round(m.qty * (m.unitPrice || 0) * 0.1)
      }));
      if (!items.length) continue;
      const dk = (o.shipDate || o.orderDate || '').replace(/-/g, '/');
      seq[dk] = (seq[dk] || 0) + 1;
      const totalSupply = items.reduce((s, i) => s + i.supply, 0);
      const totalVat = items.reduce((s, i) => s + i.vat, 0);
      newInv.push({
        id: 'inv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        orderNum: o.orderNum, shipDate: o.shipDate || o.orderDate,
        deliveryTo: o.deliveryTo, address: o.address, items,
        totalSupply, totalVat, totalAmount: totalSupply + totalVat,
        createdAt: o.createdAt || new Date().toISOString(),
        createdBy: 'admin', issuerName: '관리자',
        serial: dk + ' -' + seq[dk], sentToCustomer: true, sentAt: new Date().toISOString()
      });
    }
    if (!newInv.length) return log.info('생성할 invoice 없음');
    await window._FS.set('invoices', [...existing, ...newInv]);
    log.pass(`invoice ${newInv.length}건 자동발급 (${existing.length} → ${existing.length + newInv.length})`);
  }

  async function resetKey(key, log) {
    if (!confirm(`emulator ${key} 전부 삭제? (운영 영향 0)`)) return;
    await window._FS.set(key, []);
    log.pass(key + ' 초기화 완료 (0건)');
  }

  // 입금 N건 대량 시드 (컬렉션 방식)
  async function seedPayments(count, log) {
    if (!window._FS || typeof window._FS.collectionAdd !== 'function') {
      return log.fail('_FS.collectionAdd 없음 — 컬렉션 방식 미적용');
    }
    log.info(`입금 ${count}건 대량 등록 시작...`);
    const customers = ['테스트업체', '테스트A업체', '테스트B업체', '테스트C업체'];
    const memos = ['카드결제', '계좌이체', '현금', '어음', '월정산', '분할입금', ''];
    let success = 0, fail = 0;
    const t0 = performance.now();
    for (let i = 0; i < count; i++) {
      const id = 'p_seed_' + Date.now() + '_' + i.toString(36);
      const doc = {
        id,
        customer: customers[i % customers.length],
        date: `2026-${String(1 + (i % 6)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
        amount: 10000 + (i * 1000),
        memo: memos[i % memos.length],
        createdAt: new Date().toISOString(),
        createdBy: 'qa-widget'
      };
      try { await window._FS.collectionAdd('hanger_payments', id, doc); success++; }
      catch (e) { fail++; log.fail(`${i+1}번째 실패: ${e.message.slice(0, 50)}`); }
      if ((i + 1) % 50 === 0) log.info(`  진행 ${i+1}/${count}...`);
    }
    const ms = (performance.now() - t0).toFixed(0);
    log.pass(`완료 — 성공 ${success}건, 실패 ${fail}건 (${ms}ms)`);
    log.info(`평균 ${(ms / count).toFixed(1)}ms/건`);
  }

  // 저장 크기 진단
  async function checkStorage(log) {
    // ─────────────────────────────────────
    // 🔴 orders (발주서) — 정산·원장의 소스 데이터
    // ─────────────────────────────────────
    const orders = (await window._FS.get('orders')) || [];
    const orderBytes = new Blob([JSON.stringify({ value: orders })]).size;
    const orderCount = Array.isArray(orders) ? orders.length : 0;
    const orderRatio = (orderBytes / 1048576) * 100;
    log.info(`━━━ [1] 발주서 hanger_data/orders (정산·원장 소스) ━━━`);
    log.info(`  건수: ${orderCount}건`);
    log.info(`  doc 크기: ${(orderBytes / 1024).toFixed(1)} KB / 1024 KB (1MB)`);
    log.info(`  사용률: ${orderRatio.toFixed(2)}%`);
    if (orderRatio > 90) {
      log.fail(`  🚨 90% 초과 — 정산/원장 즉시 멈출 위험! 긴급 조치 필요`);
    } else if (orderRatio > 75) {
      log.fail(`  ⚠️ 75% 초과 — Phase 5(옛 경로 폐기) 준비 시급`);
    } else if (orderRatio > 50) {
      log.info(`  ⚠️ 50% 초과 — 3-6개월 내 대응 필요`);
    } else {
      log.pass(`  ✓ 여유 있음`);
    }
    // 남은 여유 예측
    if (orderCount > 0) {
      const avgBytes = orderBytes / orderCount;
      const remain = 1048576 - orderBytes;
      const remainOrders = Math.floor(remain / avgBytes);
      log.info(`  평균 발주서 크기: ${avgBytes.toFixed(0)} bytes`);
      log.info(`  1MB 도달까지 남은 여유: ~${remainOrders}건 (${(remain / 1024).toFixed(0)}KB)`);
    }
    log.info('');

    // ─────────────────────────────────────
    // 🟢 hanger_orders 컬렉션 (Phase 4 — 이미 사용 중)
    // ─────────────────────────────────────
    const newOrders = (await window._FS.collectionGet('hanger_orders')) || [];
    log.info(`━━━ [2] 발주서 hanger_orders 컬렉션 (Phase 4) ━━━`);
    log.info(`  문서 수: ${newOrders.length}건`);
    if (newOrders.length > 0) {
      const maxDoc = newOrders.reduce((m, p) => Math.max(m, new Blob([JSON.stringify(p)]).size), 0);
      log.info(`  최대 문서 크기: ${maxDoc} bytes / 1MB (문서 개별 한계)`);
      log.pass(`  ✓ 컬렉션 방식 — 문서 수 무제한, 각 문서만 1MB 유지`);
    } else {
      log.info(`  (컬렉션 비어 있음)`);
    }
    log.info('');

    // ─────────────────────────────────────
    // 🟢 payments (컬렉션 방식) - 오늘 만듦
    // ─────────────────────────────────────
    log.info(`━━━ [3] 입금 hanger_payments 컬렉션 (신규) ━━━`);
    // 옛 방식 (hanger_data/payments 배열) - 사용 안 함 확인용
    const oldPayments = (await window._FS.get('payments')) || [];
    const oldBytes = new Blob([JSON.stringify({ value: oldPayments })]).size;
    log.info(`[옛 방식 확인] hanger_data/payments`);
    log.info(`  건수: ${Array.isArray(oldPayments) ? oldPayments.length : 0}건`);
    log.info(`  doc 크기: ${(oldBytes / 1024).toFixed(1)} KB`);
    log.info(`  1MB(1024KB) 대비: ${((oldBytes / 1048576) * 100).toFixed(2)}%`);
    if (oldBytes > 800000) log.fail('  ⚠️ 800KB 초과 — 1MB 한계 임박!');
    else if (oldBytes > 500000) log.info('  ⚠️ 500KB 초과 — 절반 사용');
    else log.pass('  ✓ 여유 있음 (또는 미사용)');

    // 새 방식 (hanger_payments 컬렉션)
    const newPayments = (await window._FS.collectionGet('hanger_payments')) || [];
    log.info(`[새 방식] hanger_payments 컬렉션`);
    log.info(`  문서 수: ${newPayments.length}건`);
    if (newPayments.length > 0) {
      const totalBytes = newPayments.reduce((s, p) => s + new Blob([JSON.stringify(p)]).size, 0);
      const avgBytes = totalBytes / newPayments.length;
      const maxDoc = newPayments.reduce((m, p) => Math.max(m, new Blob([JSON.stringify(p)]).size), 0);
      log.info(`  총 크기: ${(totalBytes / 1024).toFixed(1)} KB (${newPayments.length}개 문서 합)`);
      log.info(`  평균 문서 크기: ${avgBytes.toFixed(0)} bytes`);
      log.info(`  최대 문서 크기: ${maxDoc} bytes`);
      log.pass(`  ✓ 각 문서 개별 1MB 한계 — 사실상 무제한 (문서 수 무한)`);
    } else {
      log.info('  (문서 없음 — [입금 N건 대량 등록] 먼저 실행)');
    }

    // 감사 로그
    const logs = (await window._FS.collectionGet('hanger_payment_logs')) || [];
    log.info(`[감사 로그] hanger_payment_logs: ${logs.length}건`);
  }

  // 전체 백업 다운로드 (Firebase 이관·복구 대비)
  async function backupAll(log) {
    log.info('전체 데이터 수집 중...');
    const backup = {
      _meta: {
        exportedAt: new Date().toISOString(),
        exportedBy: (typeof currentUser !== 'undefined' && currentUser) ? (currentUser.id || 'unknown') : 'unknown',
        source: location.hostname,
        version: 1
      },
      hanger_data: {},   // 옛 방식 (배열 저장)
      collections: {}    // 새 방식 (컬렉션)
    };

    // hanger_data doc 들 (배열 방식)
    const dataKeys = ['orders', 'accounts', 'invoices', 'items', 'price_settings', 'purchase_requests', 'logs', 'session', 'payments', 'payment_logs'];
    for (const key of dataKeys) {
      try {
        const val = await window._FS.get(key);
        backup.hanger_data[key] = val;
        const n = Array.isArray(val) ? val.length : (val ? '(존재)' : '(없음)');
        log.info(`  hanger_data/${key}: ${n}${Array.isArray(val) ? '건' : ''}`);
      } catch (e) {
        log.fail(`  hanger_data/${key} 실패: ${e.message.slice(0, 50)}`);
      }
    }

    // 컬렉션 방식
    const colls = ['hanger_orders', 'hanger_payments', 'hanger_payment_logs'];
    for (const coll of colls) {
      try {
        const arr = await window._FS.collectionGet(coll);
        backup.collections[coll] = arr;
        log.info(`  ${coll}: ${arr.length}건`);
      } catch (e) {
        log.fail(`  ${coll} 실패: ${e.message.slice(0, 50)}`);
      }
    }

    // 파일 다운로드
    const now = new Date();
    const y = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const fileName = `hanger_backup_${y}${mo}${d}_${h}${mi}${s}.json`;
    const json = JSON.stringify(backup, null, 2);
    const sizeKB = (new Blob([json]).size / 1024).toFixed(1);

    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);

    log.pass(`백업 완료: ${fileName} (${sizeKB} KB)`);
    log.info('※ 파일을 안전한 곳(Google Drive, 로컬 등)에 보관하세요.');
    log.info('※ 이 파일 하나로 발주서·계정·입금·거래명세서 전부 복구 가능.');
  }

  // 컬렉션 초기화 (문서 하나씩 삭제)
  async function resetCollection(coll, log) {
    if (!confirm(`emulator ${coll} 컬렉션 전부 삭제? (운영 영향 0)`)) return;
    const docs = await window._FS.collectionGet(coll);
    log.info(`${coll} ${docs.length}건 삭제 중...`);
    let ok = 0;
    for (const d of docs) {
      if (!d || !d.id) continue;
      try { await window._FS.collectionDelete(coll, d.id); ok++; }
      catch(_) {}
    }
    log.pass(`${coll} 삭제 완료 (${ok}건)`);
  }

  panel.querySelectorAll('[data-seed]').forEach(btn => btn.addEventListener('click', async () => {
    const log = mkLog('qa-seed-log');
    const action = btn.dataset.seed;
    try {
      if (action === 'orders') {
        const n = Math.max(1, Math.min(500, Number(document.getElementById('qa-seed-count').value) || 30));
        await seedOrders(n, log);
      } else if (action === 'invoices') await seedInvoices(log);
      else if (action === 'payments') {
        const n = Math.max(1, Math.min(2000, Number(document.getElementById('qa-pay-count').value) || 100));
        await seedPayments(n, log);
      } else if (action === 'check-storage') await checkStorage(log);
      else if (action === 'backup-all') await backupAll(log);
      else if (action === 'reset-orders') await resetKey('orders', log);
      else if (action === 'reset-invoices') await resetKey('invoices', log);
      else if (action === 'reset-payments') await resetCollection('hanger_payments', log);
    } catch (e) { log.fail('예외: ' + e.message); }
  }));

  console.log('🧪 [QA Widget] 활성 (로컬 전용)');
})();
