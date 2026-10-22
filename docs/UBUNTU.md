# Ubuntu 헤드리스 설치·검증 가이드

검토 기준: 2026-10-22, `jellygum/claude-codex-bridge` main의 `edcd2123b58dd4871125ce959090c5bb216aa053`에서 시작한 수정본.

## 검증 범위

이번 검증은 Ubuntu 24.04.3 LTS 컨테이너, Node v24.19.0, pnpm 10.29.2, TTY 없는 프로세스에서 수행했다. 사용자의 실제 Ubuntu 서버에 접속하거나 계정으로 로그인한 것은 아니다. 실제 Claude/Codex 실행 파일과 인증 정보 없이 모의 CLI를 사용했다. 최종 로컬 검증에서 111개 테스트, 빌드(publint 포함), TypeScript 검사, 포맷 검사 및 세 MCP 핸드셰이크가 통과했다.

- 소스 설치·빌드, 타입 검사, 포맷 검사, 세 MCP 서버의 `initialize`/`tools/list`를 실제 stdio로 검증한다.
- 모의 CLI로 직접 query 도구와 control의 시작·상태·결과·목록·취소, 인증 오류 전달을 검증한다.
- 실제 계정 로그인, 모델 접근 권한, 과금·사용량, 실제 CLI 버전별 옵션 수락, 실제 파일 편집·sandbox 동작은 아래 실계정 단계에서 별도로 확인해야 한다.
- CI는 Ubuntu 22.04(Node 20.19/22.12), Ubuntu 24.04(Node 24), Windows(Node 22) 조합을 선언한다. 워크플로 파일이 존재하는 것과 실행 통과는 별개다.

## 1. 준비와 설치

운영할 일반 Linux 사용자로 설치·인증·등록·실행을 통일한다. `sudo node ...`로 등록하면 root의 설정을 수정하게 된다.

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates jq
node --version
npm --version
```

Node가 없다면 [Node.js 공식 설치 안내](https://nodejs.org/en/download)로 사용자 환경에 설치한다. 새 설치에는 **Node 22.12 이상의 22.x 또는 Node 24.x**를 사용한다. 패키지 최소 범위는 `^20.19.0 || >=22.12.0`이다. 기존 README의 Node 18 안내는 소스 빌드 도구(tsdown/rolldown/Vitest)와 맞지 않아 수정했다.

```bash
npm install --global pnpm@10.29.2
pnpm --version

git clone https://github.com/jellygum/claude-codex-bridge.git
cd claude-codex-bridge
# PR 병합 전 수정본을 사용할 때:
git switch fix/ubuntu-headless
pnpm install --frozen-lockfile
pnpm test:offline
pnpm exec tsc --noEmit
pnpm fmt:check
```

`pnpm test:offline`은 build → 테스트 → MCP 핸드셰이크 순서다. 외부 CLI·계정·추론 요청이 필요 없다. 최초 패키지 설치에는 네트워크가 필요하다. 테스트는 임시 설정/작업 디렉터리를 사용한다. 사용자의 기존 로그인 설정을 등록하거나 바꾸지 않는다.

pnpm 11 대신 저장소에 고정된 10.29.2를 사용한다. pnpm 11로 실행한 첫 설치는 이 검증 환경에서 `ERR_PNPM_IGNORED_BUILDS`로 중단되었다. `pnpm` 전역 설치 권한이 없으면 동일 버전을 `npx --yes pnpm@10.29.2 <명령>`으로 실행할 수 있다. 모든 dependency 스크립트를 일괄 허용할 필요는 없다.

## 2. 설정을 보존하며 등록

설정을 쓰는 Claude/Codex 클라이언트를 먼저 종료한다. checkout은 계속 유지할 위치에 둔다.

```bash
node scripts/register-local.mjs --dry-run
node scripts/register-local.mjs
node dist/cli.mjs control doctor
```

등록 동작:

- 기본 대상: `~/.codex/config.toml`, `~/.claude.json`, `.codex/.agents/.claude` 아래 `skills/dot-bridge/SKILL.md`.
- `ccb-claude`, `ccb-codex`, `ccb-control`의 Node 및 서버 경로를 절대 경로로 등록한다.
- Codex는 TOML AST로 command/args 값만 갱신한다. 모델·다른 MCP·주석·브리지 env·기존 timeout은 유지한다. timeout이 없으면 600초를 추가한다.
- Claude는 기존 JSON 속성 및 다른 MCP, 브리지 env 등 옵션을 유지하고 type/command/args만 갱신한다. JSON 공백 정렬은 바뀔 수 있다.
- 변경 파일마다 `.before-ccb-<시간>-<UUID>.bak` 백업을 남긴다. 백업과 새 파일은 0600이며, 같은 디렉터리의 임시 파일을 rename해 **파일별** 원자적 교체를 한다. 여러 파일 전체가 하나의 트랜잭션인 것은 아니다. I/O 실패 시 출력된 백업을 확인한다.
- 설정 파일 심볼릭 링크는 유지하고 실제 대상을 갱신한다. 동일 내용으로 재등록하면 파일·백업을 추가 변경하지 않는다.
- TOML/JSON 파싱 오류는 쓰기 전에 거부한다. 브리지 서버를 inline table/루트 dotted key로 정의한 경우 명시적 `[mcp_servers.ccb-claude]` 형태로 바꾼 뒤 재시도한다. 같은 이름의 원격 URL MCP는 자동으로 대체하지 않는다.

복구는 클라이언트를 종료한 뒤 출력된 **정확한 백업 파일**을 원래 대상으로 복사한다. 등록 뒤 다른 수정이 있었다면 전체 복사 대신 차이를 검토한다. Node 버전 관리자가 기존 Node를 삭제하거나 checkout을 옮겼다면 새 위치에서 build/등록을 다시 한다.

설정 위치 옵션:

| 변수 | 의미 |
| --- | --- |
| `CODEX_HOME` | 지정한 디렉터리의 config.toml 및 skills를 사용 |
| `CLAUDE_CONFIG_DIR` | 사용자 지정 Claude 디렉터리. 설정 파일 위치를 추측하지 않도록 `CCB_CLAUDE_CONFIG_FILE`도 명시해야 함 |
| `CCB_CLAUDE_CONFIG_FILE` | 실제 Claude 사용자 MCP JSON 파일의 절대 경로 |
| `CCB_CONFIG_HOME` | 등록 대상 전체를 다른 홈 아래로 격리. 위 변수보다 우선. 인증·작업 상태를 옮기는 옵션은 아님 |

실제 설정을 건드리지 않고 등록 결과를 검사하려면:

```bash
ccb_check_dir=$(mktemp -d)
CCB_CONFIG_HOME="$ccb_check_dir" node scripts/register-local.mjs
```

## 3. 외부 CLI 설치와 헤드리스 인증 — 별도 수동 단계

이미 설치되어 있다면 버전과 로그인 상태부터 확인한다. 아래 설치·인증은 자동 테스트에서 실행하지 않았다.

```bash
# Codex CLI: Node 사용자 환경에서 설치
npm install --global @openai/codex
# Claude Code: 공식 native installer
curl -fsSL https://claude.ai/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"

codex --version
claude --version
codex login --device-auth
codex login status
claude auth login
claude auth status
```

Codex device-code 로그인이 제공되지 않으면 개인 보안 설정 또는 조직 관리자 설정에서 활성화 여부를 확인한다. 표시된 공식 URL을 브라우저가 있는 PC에서 열어 본인이 인증한다. Claude는 SSH 터미널에 표시된 로그인 URL을 로컬 PC에서 열고, 코드가 표시되면 해당 CLI 프롬프트에 입력한다. 인증 코드를 이슈·채팅에 붙이지 않는다. 이미 인증되어 있으면 불필요하게 재로그인하지 않는다.

인증은 각 CLI 공식 흐름으로 진행한다. 브리지는 토큰을 수집하거나 다른 계정으로 대체하지 않는다. API key 방식은 각 CLI의 공식 인증 안내를 따른다. 모델 호출은 계정의 사용량/과금 및 조직 정책 적용 대상이다.

## 4. SSH·MCP의 PATH 차이 해결

Ubuntu 탐색 순서는 명시적 `CCB_<PEER>_EXE` → 실행 가능한 PATH 파일 → `~/.local/bin` → `~/bin` → npm prefix의 bin → 실행 중인 Node의 디렉터리다. PATH의 상대·빈 경로는 자동 탐색에서 제외한다. npm launcher의 `/usr/bin/env node`가 동작하도록 자식 PATH 끝에 현재 Node 디렉터리를 추가한다. 기존 PATH 우선순위는 유지한다.

셸 alias/function은 실행 파일이 아니다. nvm의 다른 버전, 사용자 정의 wrapper 등은 실제 절대 경로를 지정한다.

```bash
export CCB_CLAUDE_EXE="$(command -v claude)"
export CCB_CODEX_EXE="$(command -v codex)"
node dist/cli.mjs control doctor
```

doctor의 `peers.<이름>.available`은 로컬 파일 탐색 결과이며 로그인·모델 호출 성공을 뜻하지 않는다. JS launcher를 직접 실행해야 하면 `CCB_CLAUDE_ENTRYPOINT`/`CCB_CODEX_ENTRYPOINT`에 절대 JS 파일 경로를 지정한다. ENTRYPOINT는 EXE보다 우선하고 현재 Node로 실행된다.

환경변수는 MCP를 실행하는 **클라이언트 프로세스에도** 전달되어야 한다. 위 export 후 같은 셸에서 Claude/Codex를 시작하거나, 각 `ccb-*` MCP의 env 설정에 경로를 넣는다. 등록 스크립트가 현재 셸의 인증 변수나 전체 PATH를 설정 파일에 복사하지는 않는다. 지정한 env는 재등록 시 유지한다. systemd를 사용한다면 같은 사용자, HOME, PATH, 설정 위치 및 작업 상태 경로를 서비스에 명시한다.

## 5. MCP 연결과 실제 작업

등록 뒤 두 클라이언트를 다시 시작한다.

```bash
codex mcp list
claude mcp list
# 모델 호출 없이 로컬 MCP 초기화/도구 목록만 검증
node scripts/smoke-test.mjs
```

세 서버는 stdio MCP다. 브라우저, DISPLAY, X11, VNC, 인바운드 TCP 포트가 필요 없다. `node dist/control-server.mjs`를 터미널에서 실행하고 응답이 없다고 고장으로 판단하지 않는다. MCP 클라이언트가 JSON-RPC로 초기화해야 한다. 일반 출력은 프로토콜에 쓰이고 진단 메시지는 stderr로 간다.

작업 명령 예시(절대 프로젝트 경로로 변경):

```bash
node dist/cli.mjs control start \
  --peer codex --project /home/jin/projects/demo \
  --prompt '이 프로젝트의 구조만 설명해주세요. 파일은 수정하지 마세요.'
# 출력의 id 값을 사용
node dist/cli.mjs control status JOB_ID
node dist/cli.mjs control result JOB_ID
node dist/cli.mjs control list
node dist/cli.mjs control cancel JOB_ID
```

Claude 실행은 `--peer claude`로 변경한다. 긴/여러 줄 프롬프트는 UTF-8 파일과 `--prompt-file /절대경로/task.txt`를 사용한다. 기본은 read-only이며, 파일 수정을 요청할 때만 `--mode implement`를 사용한다. `--model`을 생략하면 CLI 기존 설정을 따른다. 작업은 새 CLI 세션이며 기존 데스크톱 채팅에 연결하지 않는다.

MCP에서는 `bridge_start`에 `{ "peer": "codex", "prompt": "구조를 설명해주세요", "workingDirectory": "/home/jin/projects/demo" }`를 전달하고, 반환된 id로 `bridge_status`/`bridge_result`/`bridge_cancel`을 호출한다.

작업 상태는 기본 `~/.claude-codex-bridge/jobs`, 또는 `CCB_STATE_DIR`에 저장한다. 시작과 조회는 같은 경로를 사용해야 한다. 상대 경로는 호출자의 cwd에서 절대화한 뒤 worker에 전달한다. 운영 환경에서는 절대 경로를 권장한다. 취소는 요청 후 상태를 다시 조회한다. POSIX에서는 해당 CLI의 프로세스 그룹에 SIGTERM, 5초 뒤 SIGKILL을 보낸다. 자체적으로 새 세션/프로세스 그룹을 만드는 프로그램까지 추적하는 작업 관리자는 아니다.

백그라운드 작업은 요청 클라이언트와 분리되지만 서버 재부팅이나 systemd/logind의 사용자 세션 종료 정책까지 극복하지는 않는다. 비정상 종료 후 heartbeat가 30초 넘게 오래되면 조회에서 failed로 보고한다. 재부팅 후 자동 재실행은 하지 않는다.

## 6. 실계정 검증 체크리스트

인증이 끝난 서버에서만 다음 단계로 진행한다.

```bash
# 실제 두 CLI가 응답하는지: 각 peer에 짧은 read-only 요청
node scripts/smoke-test.mjs --live
# 실제 파일 생성까지 확인할 때만: 별도 임시 프로젝트에서 sentinel 파일 생성
node scripts/smoke-test.mjs --implement
```

- CLI 버전, OS, Node/pnpm 버전과 각 테스트의 성공/실패를 기록한다. 토큰은 기록하지 않는다.
- `--live`: 두 CLI가 sentinel 응답을 반환해야 한다. `--implement`: 별도 `.bridge-state/implement/` 프로젝트에 BRIDGE_TEST.txt 내용까지 확인한다.
- Codex implement는 `--approve-for-me`를 사용한다. 현재 공식 문서의 자동 승인 검토 + workspace-write 모드이며 `--sandbox`를 함께 전달하지 않는다. 구버전이 옵션을 거부하면 CLI를 업데이트하고 `codex exec --help`를 확인한다. sandbox 우회 옵션으로 해결하지 않는다.
- Claude control 작업은 `dontAsk`, 비어 있는 strict MCP 설정을 사용한다. read-only는 Read/Grep/Glob으로 제한한다. implement는 Edit/Write가 허용되지만 모든 셸 작업을 무조건 승인하는 모드는 아니다. 직접 query 서버의 도구 정책은 control과 같다고 가정하지 않는다.
- 클라이언트 내 MCP 도구 표시 및 실제 호출, 조직 정책, 모델 접근, Linux sandbox 커널 지원은 자동 mock 통과와 별도로 확인한다.
- ChatGPT/dot의 로컬 컴퓨터 연결 성공은 이 로컬 MCP 검증만으로 입증되지 않는다.

## 7. 문제 해결

| 증상 | 확인 사항 |
| --- | --- |
| 빌드에서 Node 기능 오류 | Node 18/초기 20/22 사용 여부와 engines 확인 |
| `CLI_NOT_FOUND`/`available: false` | MCP 프로세스 PATH, 실행 권한, 절대 EXE/ENTRYPOINT, native 설치 경로 |
| npm CLI의 `env: node: No such file` | 최신 수정본인지 확인. bridge Node 디렉터리를 자식 PATH에 추가함 |
| 등록이 inline/dotted TOML을 거부 | 브리지 항목을 명시적 테이블로 변환. 기존 파일은 그대로 유지됨 |
| authentication required | 작업과 동일한 사용자·HOME·설정 경로에서 로그인 상태 확인 |
| 작업이 계속 queued/running | 같은 CCB_STATE_DIR인지, 서버/worker가 살아 있는지 확인 |
| MCP 초기화는 성공하나 호출 실패 | CLI 설치·인증·버전 옵션·프로젝트 접근·sandbox를 순서대로 분리 확인 |
| `tsx`의 IPC `EPERM` | 테스트는 dist를 직접 사용. dev 모드 대신 `pnpm build` 후 node dist 실행 |

공식 참고 문서(2026-10-22 확인): [Codex 설치](https://developers.openai.com/codex/cli/), [Codex 헤드리스 인증](https://developers.openai.com/codex/auth/), [Codex CLI 옵션](https://developers.openai.com/codex/cli/reference/), [Claude 설치](https://code.claude.com/docs/en/setup), [Claude 인증](https://code.claude.com/docs/en/authentication), [Claude CLI 옵션](https://code.claude.com/docs/en/cli-reference).
