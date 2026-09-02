# 발주앱 작업 로그

## 최종 업데이트: 2026-04-09

---

## 이번 세션(2026-04-09) 완료 작업

### 1. 모바일 Android 인쇄 문제 해결 ✅

**최종 방식: `print.html` 전용 페이지**

- 앱에서 인쇄 버튼 클릭 → `renderOrderDocument(order)` 결과를 `sessionStorage.__print_doc__`에 저장 → `window.location.href='print.html'`
- `print.html`에서 sessionStorage 읽어 렌더링, 우측 하단 노란 FAB 인쇄 버튼 탭 → `window.print()`
- 직접 탭 제스처로 호출해야 Android 인쇄 다이얼로그 ✓ 버튼 활성화됨
- `style.css`의 `@media print { body>*:not(#print-area){display:none!important} }` 충돌 → `body>#doc-wrapper{display:block!important}`로 override

**수정 파일:**
- `public/발주앱/print.html` — 신규 생성
- `public/발주앱/js/excel-print.js` — 모바일 감지 시 print.html 라우팅

**이전 시도들 (모두 실패한 것들):**
- `window.print()` DOM 조작 방식 — Android 프린트 엔진 캡처 타이밍 문제로 blank
- `cssText='display:block!important'` — Chrome에서 `!important` 무시됨 (setProperty 사용해야 함)
- `window.open()` 새 탭 방식 — PWA standalone 모드에서 차단

---

### 2. excel-print.js 팀 에이전트 검토 후 버그 수정 ✅

| 버그 | 수정 |
|------|------|
| `cleanup()`에서 `el.style.display=display`가 `!important` 복원 실패 | `removeProperty` + `setProperty` 패턴으로 변경 |
| `beforeprint` 리스너 + 즉시 호출 이중 실행 | `beforeprint` 리스너 제거, 직접 호출만 유지 |
| `afterprint` 미지원 구형 Android WebView | `matchMedia('print')` 폴백 추가 |
| `printArea` null 체크 없음 | 명시적 null 체크 추가 |
| `@import url(${ss.href})` CSS injection 가능 | same-origin 검증 추가 |

---

### 3. 대시보드 오늘 출고 목록 추가 (관리자) ✅

- `renderDashboard()`에 `todayShipOrders` 카드 추가
- `shipDate === today`인 발주서 전체 표시 (취소/보관 제외)
- 출고완료 건은 opacity 0.5
- 파란 테두리 full-width 카드, 납품처/시공주소/창고/상태 표시

---

### 4. 발주 필요 목록 입고 시 자동 완료 ✅

- `processInventory()`에서 `type==='입고'` 시 해당 `itemId`의 `'대기'` 상태 PR 자동 `'발주완료'` 처리
- `autoCompleted: true` 플래그 포함

---

### 5. 발주자 내비에서 발주 필요 목록 제거 ✅

- `NAV_ORDERER`에서 `purchase-requests` 항목 삭제

---

### 6. "발주확정" → "출고확정" 표시 텍스트 변경 ✅

- 내부 status 값 `'발주확정'`은 유지 (기존 데이터 호환)
- 표시 텍스트만 변경:

| 파일 | 변경 위치 |
|------|---------|
| `js/utils.js` | 뱃지 텍스트 |
| `js/orders.js` | 상태 변경 버튼, 통계 테이블 헤더, 확인 팝업 |
| `js/order-modal.js` | 저장 버튼, 토스트 메시지 |
| `app.js` | 통계 테이블 헤더 |

---

## 이전 세션(2026-04-08) 완료 작업

### Firebase Auth 마이그레이션
- `doLogin()`, `doRegister()`, `doAdminSetup()`, `doLogout()` async 전환
- `signInWithEmailAndPassword`, `createUserWithEmailAndPassword`, `sendPasswordResetEmail`, `signOut` 적용
- 관리자 설정 화면에 이메일 필드 추가
- 계정 관리 모달에 이메일 필드 추가

### 즉시 버그 수정 (5건)
- `index.html:251` `<script>` 태그 누락 → iOS 설치 팝업 수정
- `app.js:345` `o.createdAt?.startsWith(today)` optional chaining
- `app.js:1216` `totalAmount` 타입 오류 수정
- 빈 click 핸들러 2개 제거
- `showRegister()`의 `reg-name` → `reg-delivery-name` 수정

### Firestore 실시간 리스너
- `index.html`에 `watchData(key, onChange)` 추가
- orders, inventory, logs에 `onSnapshot` 구독

---

## 현재 파일 구조

```
public/발주앱/
├── index.html          # 메인 HTML
├── app.js              # 메인 앱 로직
├── print.html          # 모바일 인쇄 전용 페이지 ← 신규
├── style.css
├── sw.js / service-worker.js
├── manifest.json
├── CLAUDE.md           # 팀 에이전트 설정
└── js/
    ├── core/firebase.js
    ├── store/db.js
    ├── orders.js
    ├── inventory.js
    ├── order-modal.js
    ├── price.js
    ├── excel-print.js
    ├── utils.js
    └── utils/uiUtils.js, dateUtils.js
```

---

## 알려진 미완료 이슈

| 이슈 | 설명 |
|------|------|
| `onAuthStateChanged` 미연결 | Firebase 세션 만료 감지 안 됨 |
| `deleteAccount()` Firebase Auth 미삭제 | Cloud Function 필요 |
| `navigate()` race condition | setTimeout 빠른 전환 시 이전 뷰 덮어씀 |
| `_GUARD`에 `accounts` 포함 | `deleteAccount()` 실제 삭제 안 됨 |

---

## 팀 에이전트 설정

`CLAUDE.md` 파일이 프로젝트 폴더에 있음. 코드 수정 후 반드시 `@team-orchestrator`로 검토.

---

## 기술 스택

- **인증**: Firebase Authentication (email/password)
- **DB**: Firestore + localStorage + sessionStorage + IndexedDB (4중 백업)
- **PWA**: Service Worker, Web App Manifest
- **외부 라이브러리**: FontAwesome, SheetJS, ExcelJS, html2canvas, jsPDF (CDN)
- **빌드 도구 없음** (Vanilla JS)
- **배포**: Firebase Hosting
