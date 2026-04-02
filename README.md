# icloud-photo-sync

iPhone iCloud 앨범의 사진을 Cloudflare R2에 자동으로 동기화하는 Docker 기반 도구.

**흐름**: iPhone 앨범 → iCloud → icloudpd (자동 다운로드) → R2 업로드 → GitHub Actions 리빌드 트리거

## 사용법

### 1. 환경변수 설정

```bash
cp .env.example .env
# .env 파일을 편집하여 값 입력
```

### 2. iCloud 인증 (최초 1회)

```bash
docker compose run icloudpd icloudpd --username YOUR_APPLE_ID --cookie-directory /config
```

2FA 코드를 입력하면 세션 쿠키가 저장됩니다 (~90일 유효).

### 3. 실행

```bash
docker compose up -d
```

### 동작 방식

1. **icloudpd**: 설정된 iCloud 앨범에서 사진을 주기적으로 다운로드
   - HEIC → JPEG 자동 변환
   - 동영상 파일 스킵
2. **sync-to-r2**: 다운로드된 사진을 R2에 업로드
   - 이미지 메타데이터 (width, height, blur hash) 자동 생성
   - 이미 업로드된 파일은 스킵
   - 새 업로드가 있으면 GitHub Actions workflow_dispatch 트리거

## 환경변수

| 변수 | 필수 | 기본값 | 설명 |
|------|------|--------|------|
| `APPLE_ID` | O | - | iCloud 계정 이메일 |
| `ALBUM_NAME` | O | - | 동기화할 iCloud 앨범 이름 |
| `R2_BUCKET_NAME` | O | - | Cloudflare R2 버킷 이름 |
| `R2_BUCKET_PREFIX` | O | - | R2 내 업로드 경로 prefix |
| `R2_ACCESS_KEY_ID` | O | - | R2 API 액세스 키 |
| `R2_SECRET_ACCESS_KEY` | O | - | R2 API 시크릿 키 |
| `R2_ACCOUNT_ID` | O | - | Cloudflare 계정 ID |
| `GITHUB_TOKEN` | - | - | GitHub PAT (`actions:write` 권한) |
| `GITHUB_REPO` | - | - | 대상 저장소 (예: `user/repo`) |
| `GITHUB_WORKFLOW` | - | `astro.yaml` | 트리거할 워크플로우 파일명 |
| `SYNC_INTERVAL` | - | `7200` | R2 동기화 간격 (초) |
| `ICLOUD_INTERVAL` | - | `3600` | iCloud 동기화 간격 (초) |
| `TZ` | - | `Asia/Seoul` | 타임존 |

## R2 이미지 메타데이터

업로드 시 각 이미지의 S3 object metadata에 다음 값을 저장합니다:

```
width:  이미지 너비 (px)
height: 이미지 높이 (px)
blur:   base64 인코딩된 blur hash (placeholder용)
```

EXIF orientation을 고려하여 회전된 이미지의 width/height를 올바르게 처리합니다.

## iCloud 세션 관리

- 세션 쿠키는 Docker volume (`icloudpd-config`)에 저장됩니다
- 약 90일 후 만료되므로 재인증이 필요합니다
- `docker logs icloudpd`로 세션 상태를 모니터링하세요

## License

MIT
