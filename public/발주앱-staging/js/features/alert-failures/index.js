// ============================================================
// features/alert-failures/index.js — 알림 실패 배지 + 목록 UI
// 서버(onOrderDeleted)가 슬랙 알림 실패 시 hanger_orders_alert_failures 에 기록.
// 관리자만 보이는 상단 배지 + 클릭 시 목록 모달.
// ============================================================

(function() {
  'use strict';

  let _unsubscribe = null;
  let _lastFailures = [];

  function _isAdmin() {
    return typeof isAdmin === 'function' && isAdmin();
  }

  function _firestore() {
    if (typeof firebase === 'undefined' || !firebase.firestore) return null;
    try { return firebase.app('hanger').firestore(); }
    catch (_namedAppError) {
      try { return firebase.firestore(); }
      catch (_defaultAppError) { return null; }
    }
  }

  function _renderBadge(count) {
    const badge = document.getElementById('alert-failure-badge');
    if (!badge) return;
    if (!_isAdmin() || count === 0) {
      badge.style.display = 'none';
      return;
    }
    badge.style.display = 'inline-flex';
    // 구독 실패 상태(#666, '?')에서 정상 상태로 복귀 시 원래 색·title 재설정
    badge.style.background = '#dc2626';
    badge.title = '발주서 삭제 알림 실패 (미처리)';
    const countSpan = badge.querySelector('.alert-failure-count');
    if (countSpan) countSpan.textContent = String(count);
  }

  function _hideBadge() {
    const badge = document.getElementById('alert-failure-badge');
    if (!badge) return;
    badge.style.display = 'none';
    badge.style.background = '#dc2626';
    badge.title = '발주서 삭제 알림 실패 (미처리)';
    const countSpan = badge.querySelector('.alert-failure-count');
    if (countSpan) countSpan.textContent = '0';
  }

  function _renderModal() {
    const list = document.getElementById('alert-failure-list');
    if (!list) return;
    if (_lastFailures.length === 0) {
      list.innerHTML = '<div style="padding:20px;text-align:center;color:#666">미처리 실패 없음</div>';
      return;
    }
    list.innerHTML = _lastFailures.map(f => {
      const t = f.failedAt ? new Date(f.failedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '';
      const err = String(f.errorMessage || '알 수 없음').slice(0, 200);
      return `
        <div class="alert-failure-item" style="padding:12px;border-bottom:1px solid #eee">
          <div style="display:flex;justify-content:space-between;align-items:start;gap:10px">
            <div style="flex:1">
              <div style="font-weight:700;color:#c00">발주서 삭제 알림 실패</div>
              <div style="font-size:13px;color:#333;margin-top:4px">
                orderNum: <b>${_esc(f.orderNum || '(없음)')}</b> / docId: ${_esc(f.docId || '')}
              </div>
              <div style="font-size:12px;color:#666;margin-top:2px">실패 시각: ${t}</div>
              <div style="font-size:12px;color:#c00;margin-top:2px">오류: ${_esc(err)}</div>
            </div>
            <button class="btn alert-failure-resolve-btn" data-doc-id="${_esc(f._docId || '')}" style="background:#16a34a;color:#fff;border:0;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px;white-space:nowrap">
              해결
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  function _esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function _resolveOne(docId) {
    if (!_isAdmin()) {
      if (typeof toast === 'function') toast('관리자만 처리할 수 있습니다.', 'error');
      return;
    }
    // 부분 업데이트만 필요 (기존 감사 필드 유지) → collectionAdd(.set) 대신 update 직접 호출
    const db = _firestore();
    if (!db) {
      alert('저장 기능 미초기화. 새로고침 후 다시 시도.');
      return;
    }
    if (!confirm('이 실패를 해결 완료로 표시할까요?')) return;
    try {
      const userId = (typeof currentUser !== 'undefined' && currentUser) ? currentUser.id : '';
      await db.collection('hanger_orders_alert_failures').doc(docId).update({
        resolved: true,
        resolvedAt: new Date().toISOString(),
        resolvedBy: userId
      });
      if (typeof toast === 'function') toast('해결 처리됨', 'success');
    } catch (e) {
      alert('해결 처리 실패: ' + (e && e.message));
    }
  }

  function _openModal() {
    const modal = document.getElementById('alert-failure-modal');
    if (!modal) return;
    _renderModal();
    modal.style.display = 'flex';
  }

  function _closeModal() {
    const modal = document.getElementById('alert-failure-modal');
    if (modal) modal.style.display = 'none';
  }

  // Firestore 실시간 구독 (resolved=false 만)
  function _subscribe() {
    if (!_isAdmin()) {
      _stop();
      return;
    }
    const db = _firestore();
    if (!db) return;
    if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
    try {
      _unsubscribe = db.collection('hanger_orders_alert_failures')
        .where('resolved', '==', false)
        .onSnapshot(snap => {
          _lastFailures = snap.docs.map(d => ({ ...d.data(), _docId: d.id }));
          _renderBadge(_lastFailures.length);
          _renderModal();
        }, err => {
          console.warn('[alert-failures] 구독 오류:', err && err.message);
          // 구독 실패 → 배지에 "?" 표시 (관리자 오인 방지)
          const badge = document.getElementById('alert-failure-badge');
          if (_isAdmin() && badge) {
            badge.style.display = 'inline-flex';
            badge.title = '알림 실패 목록 구독 실패 — 새로고침 필요';
            badge.style.background = '#666';
            const countSpan = badge.querySelector('.alert-failure-count');
            if (countSpan) countSpan.textContent = '?';
          }
        });
    } catch (e) {
      console.warn('[alert-failures] 초기화 실패:', e && e.message);
    }
  }

  function _stop() {
    if (_unsubscribe) {
      _unsubscribe();
      _unsubscribe = null;
    }
    _lastFailures = [];
    _hideBadge();
    _closeModal();
  }

  function _syncForCurrentUser() {
    if (_isAdmin()) _subscribe();
    else _stop();
  }

  function _init() {
    // 이벤트 위임: 해결 버튼
    document.addEventListener('click', function(e) {
      const btn = e.target && e.target.closest && e.target.closest('.alert-failure-resolve-btn');
      if (btn && btn.dataset.docId) {
        _resolveOne(btn.dataset.docId);
        return;
      }
      const badge = e.target && e.target.closest && e.target.closest('#alert-failure-badge');
      if (badge) { _openModal(); return; }
      const closeBtn = e.target && e.target.closest && e.target.closest('#alert-failure-modal-close');
      if (closeBtn) { _closeModal(); return; }
    });
    _syncForCurrentUser();
  }

  // window 노출
  window.LumaneAlertFailures = {
    subscribe: _subscribe,
    syncForCurrentUser: _syncForCurrentUser,
    stop: _stop,
    open: _openModal,
    close: _closeModal
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
