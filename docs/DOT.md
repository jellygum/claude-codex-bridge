# dot에서 Claude / Codex 제어하기

이 포크는 원본 양방향 MCP에 작업 제어 서버 `ccb-control`과 로컬 CLI를 추가합니다. Claude/Codex의 기존 로그인과 모델 설정을 사용하며 API 키를 새로 저장하지 않습니다.

## 설치

Node 18 이상과 로그인된 Claude Code/Codex CLI가 필요합니다. Windows에서는 Codex 앱의 CLI와 Claude Code VS Code 확장에 포함된 실행 파일도 검색합니다. 사용자 지정 경로는 `CCB_CLAUDE_EXE`, `CCB_CODEX_EXE`로 지정할 수 있습니다.

```powershell
git clone https://github.com/jellygum/claude-codex-bridge.git
cd claude-codex-bridge
pnpm install --frozen-lockfile
pnpm build
node scripts/register-local.mjs
```

등록 스크립트는 이 체크아웃의 절대 경로와 실행 중인 Node를 사용합니다. 기존 설정을 백업하고 세 서버 `ccb-claude`, `ccb-codex`, `ccb-control`만 갱신합니다. `.codex`, `.agents`, `.claude`에 `dot-bridge` 스킬을 설치합니다. 체크아웃을 이동하면 다시 등록하세요. 앱에서 MCP/스킬을 다시 검색하려면 클라이언트를 새로 여세요. 전역 Node가 오래되면 Node 18 이상을 사용해야 합니다.

## dot 연결

dot 프로필의 **Computers → Your computer → Allow access**에서 PC를 연결하고 온라인 상태로 유지하세요. Codex 연결/Work Sync와 별도 권한입니다. 공식 안내: [Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps).

dot에 다음과 같이 요청할 수 있습니다:

> 연결된 PC의 dot-bridge 스킬로 `C:\projects\my-app`을 Claude에게 읽기 전용으로 검토시켜 줘. 작업 ID를 보관하고 완료되면 결과를 가져와 줘.

클라우드 환경에서 로컬 MCP가 직접 노출되지 않으면 dot이 허용된 로컬 작업에서 설치된 CLI를 호출해야 합니다. 이 포크가 dot의 클라우드 권한이나 도구 노출을 강제로 변경하지는 않습니다. 기존 데스크톱 채팅을 조작하는 대신 독립적인 Claude/Codex CLI 작업을 생성합니다.

## 작업 제어

MCP 도구: `bridge_start`, `bridge_status`, `bridge_result`, `bridge_cancel`, `bridge_list`, `bridge_doctor`.

`bridge_start` 입력 예:

```json
{
  "peer": "claude",
  "prompt": "이 프로젝트의 주요 오류 가능성을 검토하세요.",
  "workingDirectory": "C:\\projects\\my-app",
  "mode": "read-only",
  "timeoutSec": 600
}
```

CLI 예 (UTF-8 파일에 프롬프트 저장):

```powershell
.\scripts\bridge.ps1 control doctor
.\scripts\bridge.ps1 control start --peer codex --project 'C:\projects\my-app' --prompt-file 'C:\temp\prompt.txt'
.\scripts\bridge.ps1 control status JOB_ID
.\scripts\bridge.ps1 control result JOB_ID
.\scripts\bridge.ps1 control cancel JOB_ID
```

읽기 전용이 기본입니다. 구현을 요청할 때만 `--mode implement`를 사용합니다. Claude 읽기 전용은 Read/Grep/Glob만 제공하고 MCP 연결을 차단합니다. 구현은 편집 도구를 사전 허용하되 기존 CLI 권한을 따릅니다. 셸 실행 권한이 없으면 빌드/테스트가 제한될 수 있습니다. Codex는 read-only/workspace-write 샌드박스를 사용합니다. 모델 옵션을 생략하면 기존 설정을 유지합니다.

작업 ID로 조회·결과·취소를 관리합니다. 한 프로젝트에서 동시 구현을 피하세요. 취소는 해당 작업의 실행 프로세스를 중지하며 이미 작성한 파일을 되돌리지 않습니다. 실패/시간 초과를 결과에 표시하고 임의로 재시작하지 않습니다. 작업 기록은 로컬 `~/.claude-codex-bridge/jobs`에 저장되고 `CCB_STATE_DIR`로 변경할 수 있습니다. 프롬프트와 응답이 포함되므로 공유 저장소에 커밋하지 마세요.

## 검증

```powershell
pnpm build
pnpm test
pnpm exec tsc --noEmit
node scripts/smoke-test.mjs
node scripts/smoke-test.mjs --live
node scripts/smoke-test.mjs --implement
```

기본 스모크 검사는 세 MCP 서버 연결과 도구 목록을 확인합니다. `--live`는 로그인된 두 CLI에 짧은 읽기 전용 질문을 보냅니다. `--implement`는 `.bridge-state` 아래 격리된 폴더에서 실제 파일 생성을 검사합니다. 두 옵션은 계정 사용량을 소모합니다. 실제 dot에서 연결된 PC로 실행되는지는 dot에서 위 요청을 실행하여 별도로 확인해야 합니다.
