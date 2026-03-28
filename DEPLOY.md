# Deploy

이 프로젝트는 `server.js` 기반 Node 웹 서비스로 배포합니다. `Vercel`의 `/api` 함수가 아니라, `Railway` 또는 `Render`에서 루트 앱 전체를 실행하는 구성이 기준입니다.

## Local

```bash
npm install
npm start
```

- 기본 포트: `3001`
- 헬스체크: `GET /health`

## Railway

- 저장소 루트를 서비스 루트로 사용
- `railway.json` 자동 감지
- Start Command: `npm start`
- Health Check Path: `/health`
- Node 버전은 `package.json`의 `engines.node`(`20.x`) 사용

배포 후 확인:

```text
GET /health -> 200
GET /api/video-stream?videoId=<youtube id> -> 200 또는 실제 실패 메시지
```

## Render

- Blueprint 사용 시 루트의 `render.yaml` 사용
- 수동 생성 시에도 동일하게:
  - Runtime: `Node`
  - Build Command: `npm install`
  - Start Command: `npm start`
  - Health Check Path: `/health`

## Notes

- YouTube 분석 경로는 `server.js`의 `/api/video-stream?videoId=...` 가 담당합니다.
- 모바일 브라우저 대응을 위해 `<video>`는 `playsinline` / `webkit-playsinline` 속성을 사용합니다.
- 플랫폼별로 YouTube 서버 응답이 달라질 수 있으므로, Railway/Render에서 먼저 `/health`와 YouTube `videoId`를 순서대로 검증하는 것이 좋습니다.
