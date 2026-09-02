# AGENTS.md — Firebase 기반 ERP 시작 제안


## 추천 기반 스택

| 레이어 | 추천 | 한 줄 이유 |
|---|---|---|
| 언어 | **TypeScript** | 실수를 컴파일러가 잡아줌. 코드가 곧 문서 |
| 프레임워크 | **Next.js (App Router)** | 규칙이 명확해 AI가 일관되게 생성, 학습데이터 풍부 |
| 스타일 | **Tailwind CSS** | 빠르고 일관. 디자인 값은 한 곳에서 관리(`DESIGN.md` 참고) |
| UI 컴포넌트 | **shadcn/ui** | 코드를 repo에 복붙 → 인수 후 자유 수정 |
| DB | **Firebase Firestore** | 기존 발주앱과 동일 백엔드. 데이터 공유 가능 |
| 인증 | **Firebase Auth** | 기존 발주앱 계정 그대로 사용 가능 |
| 스토리지 | **Firebase Storage** | 파일 업로드 (영수증·증빙 등) |
| 서버 함수 | **Firebase Cloud Functions** | 정산 자동화·배치 작업·이메일 발송 |
| 서버 데이터/캐시 | **TanStack Query** | Firestore 쿼리 결과 캐시·재요청·낙관적 업데이트 |
| 폼 | **React Hook Form + Zod** | ERP=폼 많음. Zod로 검증+타입 한 벌 |
| 표/그리드 | **TanStack Table** | 정렬·필터·페이지네이션 표준 |
| 호스팅 | **Vercel** 또는 **Firebase Hosting** | git push = 자동 배포 |

추가 라이브러리는 **필요하면**.

---

## 추천 폴더 구조 (출발점)

```
src/
├── app/                # 화면(Next 라우트). 폴더 = URL
├── components/ui/      # shadcn 컴포넌트
├── features/           # 도메인별로 묶기 (정산/원장/입금…) — 인수 시 찾기 쉬움
├── lib/
│   ├── firebase.ts     # Firebase 초기화 (Client SDK)
│   ├── firebase-admin.ts  # Firebase Admin SDK (서버사이드용)
│   ├── schemas/        # zod 스키마 (발주서·입금 등)
│   └── queries/        # TanStack Query 훅 (useOrders, usePayments…)
└── hooks/              # 공용 훅
firestore/
├── rules              # Firestore Security Rules
└── indexes.json       # 복합 인덱스 정의
functions/             # Cloud Functions (배치·자동화)
```

핵심 한 가지만: **같이 바뀌는 건 같이 둔다.** 한 도메인의 화면·훅·스키마를 한 폴더에. 그래야 나중에 어디 뭐가 있는지 바로 보인다.

---

## 처음에 잡아두면 좋은 토대 (나중에 바꾸기 어려운 것들)

Firebase는 NoSQL이라 스키마가 유연하지만, ERP라서 컬렉션 구조만 처음에 신경 쓰면 충분하다.

- **DB는 Firestore** — 기존 발주앱과 동일. 컬렉션은 발주서 1건 = 문서 1개 구조 권장 (배열 통째 저장 금지)
- **컬렉션 구조는 `COLLECTIONS.md`로 문서화** — Firestore는 스키마 자유라 문서화 안 하면 인수 시 추적 불가
- **권한은 Firestore Security Rules** — 앱 코드와 별개로 DB가 마지막 안전망
- **금액은 정수(원 단위)** — 소수점은 반올림 오차. 표시할 때만 콤마
- **모든 문서에 `createdAt`/`updatedAt`**은 기본으로 — `serverTimestamp()` 사용. "누가 언제" 추적이 ERP 생명
- **타임존은 항상 KST 표시**, 저장은 ISO 8601 UTC

---

## Firebase 특화 베스트 프랙티스

- **Client SDK vs Admin SDK 구분** — 사용자가 접근할 데이터는 Client SDK + Rules, 관리자 자동화는 Cloud Functions + Admin SDK
- **쿼리는 항상 인덱스 정의** — 복합 쿼리 시 `firestore/indexes.json`에 등록 (인덱스 없는 쿼리는 운영 중에 에러 발생)
- **Real-time vs 1회 조회 구분** — `onSnapshot`은 비용 폭증 위험. 정산 화면은 1회 `getDocs`로 충분
- **읽기 횟수 절약** — 페이지네이션·필터링은 Firestore 쿼리에서 처리(클라이언트 필터링 X)
- **계정 관리는 Firebase Auth + Firestore 'accounts' 컬렉션 매핑** — 기존 발주앱과 동일 패턴
- **이전 운영 데이터 백업** — `dailyFirestoreBackup` Cloud Function 같은 정기 백업 필수
