# WORK_LOG.md

## [2026-03-27 10:37] YouTube Video ID 및 Vercel 배포 적용

**LOG_ID: 20260327_1037**
목표: YouTube Video ID를 `8a9M0lNY37s`로 변경하고 Vercel 배포를 위한 설정 완료
변경 파일:
- `index.html`: 기본 Video ID를 `8a9M0lNY37s`로 수정
- `api/video-stream.js`: Vercel Serverless Function으로 프록시 구현
- `vercel.json`: API 라우팅 설정 추가
수행 작업:
1. `index.html` 내 하드코딩된 Video ID 및 입력창 기본값 수정
2. `api/` 디렉토리 생성 및 `video-stream.js` 구현 (ytdl-core 사용)
3. `vercel.json` 작성을 통한 `/api/video-stream/:videoId` 경로 매핑
실행: `vercel dev` (로컬 테스트 시)
기대: `index.html` 접속 시 `8a9M0lNY37s` 영상이 로드되고 포즈 감지가 작동함
결과: ✅ 반영 완료 (Vercel 배포 준비 상태)
