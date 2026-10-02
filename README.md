# cmh-hub-app

CmhHub(Shopware 플러그인)에 딸린 데스크톱 앱. 서버 `/admin` 을 크롬 모양 탭 + VS Code 식 split view 로 연다.

- 계획 정본: `E:\Kang\project\.plan\CmhHub\cmh-hub-app\PLAN.md`
- 왜 로컬 앱인가: `cmh-internal-docs/docs/guide/cmh-hub-app-architecture.md`

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm dev          # apps/desktop 을 빌드하고 Electron 창을 띄운다
pnpm dist:win     # Windows 설치 파일(nsis · x64)
```

- `packages/contracts` — 셸 ↔ main ↔ 서버가 주고받는 JSON 타입 한 곳(서버 CmhHub PHP 와 같은 이름)
- `apps/desktop` — Electron main · preload · 셸 페이지(탭 스트립 · sash · 덮개)
