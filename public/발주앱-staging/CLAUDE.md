> **[Claude에게]** 이 파일을 읽었다면 안의 모든 규칙을 작업 내내 반드시 따를 것.
> "작은 작업이라 괜찮겠지", "이번엔 예외" 같은 판단 금지.
> 규칙을 어겼을 경우 즉시 멈추고 해당 규칙부터 실행.
> 이 지침은 모든 작업에 예외 없이 적용된다.

---

# 🤖 Claude Code 프로젝트 설정

## 에이전트 팀 구성

이 프로젝트는 여러 팀의 전문 에이전트를 사용합니다. (team-orchestrator가 조율)

**디버깅팀 (코드 검사·진단)**

| 에이전트 | 역할 |
|---------|------|
| `team-orchestrator` | 헤드 에이전트 - 팀 전체 조율 |
| `html-css-js-reviewer` | HTML/CSS/JS 코드 품질 검토 |
| `web-security-auditor` | 보안 취약점 검사 |
| `code-bug-fixer` | 버그 탐지 및 수정 |
| `frontend-test-validator` | 프론트 동작 검증 |

**테스트팀 (테스트 설계·작성·실행 + 적대적 탐색)**

| 에이전트 | 역할 |
|---------|------|
| `test-designer` | 테스트 시나리오·케이스 설계 |
| `integration-test-writer` | 통합 테스트 작성 (에뮬레이터 방식) |
| `test-runner` | 테스트 실행·진단 |
| `adversarial-tester` | **"어떻게든 깨뜨리기"** — 숨은 버그·엣지 탐색 |

> ⚠️ **디버깅팀만 부르지 말 것.** 버그 탐지·검증은 **디버깅팀(코드 읽기) + 테스트팀(돌려보기·적대적)** 을 함께 쓴다.

---

## 🐛 버그 탐지 / 테스트 (오늘 업데이트 검증)

이 프로젝트는 **버그 탐지 파이프라인**이 깔려 있다 (자세히: `functions/TESTING.md`).

- **테스트 환경**: Firebase 에뮬레이터(docker `hanger-emu`, localhost). 운영 절대 X.
- **functions 통합 테스트**: 에뮬레이터 켠 상태 `cd functions && npm test` (테스트 전용 `tooktak-test`로 격리)
- **프론트 E2E**: `npm run test:e2e` (Playwright, localhost:5050)
- **트리거 발화**:
  - "오늘 바꾼 거 버그 탐지해줘" → 디버깅팀 + adversarial-tester
  - "적대적으로 테스트해줘" → adversarial-tester
  - "○○ 흐름 E2E 짜줘" → E2E spec (범위는 사용자가 정함)
  - "자동 검증해줘" → 사람 QA 직전까지 자동 게이트 (③검증→④테스트→⑤회귀→⑥최종)
- **버그→테스트 규칙**: 사람 QA·운영에서 버그 발견 시 → 재현 테스트부터(RED) → 고침(GREEN) → 회귀로 박제
- 🔴 `firestore.rules`·`firebase.json`·`.firebaserc`·`functions/.env`·`firebase-config.js` 는 임의 수정·실행 금지

---

## 에이전트 자동 실행 규칙

### 팀 전체 검토가 필요한 경우 → @team-orchestrator 사용
- 새로운 기능(HTML/CSS/JS) 완성했을 때
- Pull Request / 커밋 전 최종 검토
- 코드 전반적인 품질 점검이 필요할 때

### 개별 에이전트 사용
- 코드 스타일만 보고 싶을 때 → `@html-css-js-reviewer`
- 보안만 빠르게 확인할 때 → `@web-security-auditor`
- 버그만 잡을 때 → `@code-bug-fixer`
- 테스트만 확인할 때 → `@frontend-test-validator`

---

## 사용 방법

### 기본 사용 (VS Code 확장 채팅창)
```
@team-orchestrator 로그인 폼 새로 만들었어, 검토해줘
@code-bug-fixer 이 파일에서 오류 찾아줘
@web-security-auditor 보안 점검해줘
```

### 터미널에서 사용
```bash
# Claude Code 대화 모드 시작
claude

# 그 다음 채팅에서
> @team-orchestrator 코드 검토해줘
```

---

## 주의사항

- 기획서 분석, Supabase 연결 등 **코드 외 작업**은 `@team-orchestrator`가 직접 처리합니다 (서브 에이전트 위임 안 함 - 정상)
- 서브 에이전트 병렬 실행은 **HTML/CSS/JS 코드 관련 작업**에서 동작합니다
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 환경변수가 설정되어 있어야 합니다

---

## 환경 변수 확인

Windows PowerShell에서 확인:
```powershell
$env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
# 결과: 1 이 나와야 정상
```

설정 안 되어 있으면:
```powershell
$env:CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"
```

---

## 에이전트 파일 위치

```
C:\Users\kateb\.claude\agents\
├── team-orchestrator.md
├── html-css-js-reviewer.md
├── web-security-auditor.md
├── code-bug-fixer.md
└── frontend-test-validator.md
```

---

## ⚠️ 필수 규칙 - 반드시 따를 것

HTML/CSS/JS 코드 작업 시 → 반드시 @team-orchestrator 실행
절대 혼자 코드 검토하지 말 것
모든 코드 변경 후 팀 에이전트 검토 필수

절대 혼자 코드 검토하지 말 것
모든 코드 변경 후 팀 에이전트 검토 필수
**이 규칙을 어기면 작업 중단하고 @team-orchestrator 먼저 실행할 것**
*이 파일을 각 프로젝트 폴더 루트에 복사해서 사용하세요.*


## 작업 전 규칙 (필수)

1. 많은 부분을 수정해야 한다면 반드시 먼저 물어보고 진행할 것
2. 하나의 파일에 코드를 다 넣지 말고 기능별로 모듈화 할 것
3. 요청이 명확하지 않을 때 추론하여 실행하지 말고, 이해한 내용을 먼저 말할 것
4. 큰 업데이트나 많은 부분을 수정할 때는 `C:\Users\kateb\hanger-deploy\public\백업본` 에 백업본 만들 것
5. 추가로 코드 수정하다가 다 지워버리는 경우가 꽤 있었는데 그 전에 나한테 '한국말로 질문할것'

---

규칙:
1. 단순 질문 응답이나 코드를 건드리지 않은 경우에만 생략 가능하다.
2. 앱 업데이트 방법은 새로고침 외의 방법은 절대로 제시하지 않는다.
3. 새로 추가하거나 수정하는 기능외의 다른곳은 절대로 건들지 않는다.