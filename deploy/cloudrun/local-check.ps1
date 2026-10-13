#Requires -Version 5.1
<#
.SYNOPSIS
  耕云 API 镜像的本地自检：构建镜像 → 静态检查（非 root、无 .env）→ 容器内 /health → 清理。

.DESCRIPTION
  只在本机执行，不接触任何云资源、不部署、不推送镜像。
  本机没有 Docker 时脚本明确失败（exit 2），不假装通过。

.EXAMPLE
  pwsh -File deploy/cloudrun/local-check.ps1

.EXAMPLE
  pwsh -File deploy/cloudrun/local-check.ps1 -Port 3199 -Image gengyun-api:local
#>
[CmdletBinding()]
param(
  [string]$Image = 'gengyun-api:local',
  [int]$Port = 3199,
  [int]$WaitSeconds = 40
)

$ErrorActionPreference = 'Stop'
$containerName = 'gengyun-api-check'

function Fail([string]$message, [int]$code) {
  Write-Host "[FAIL] $message" -ForegroundColor Red
  exit $code
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not (Test-Path (Join-Path $repoRoot 'package-lock.json'))) {
  Fail "找不到仓库根（缺少 package-lock.json）：$repoRoot" 2
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  $noDocker = @'
本机未找到 docker：无法在此机器验证镜像构建与容器启动。
请在装有 Docker 的机器上执行，或先安装 Docker Desktop 后重试。
「未验证」不等于「通过」，不要据此认为镜像或容器已经验证。
'@
  Fail $noDocker 2
}
& docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Fail 'docker 命令存在但守护进程不可用（docker info 失败）；请先启动 Docker。' 2
}

Write-Host "[1/4] docker build -f deploy/cloudrun/Dockerfile -t $Image .   (上下文: $repoRoot)"
& docker build -f (Join-Path $repoRoot 'deploy/cloudrun/Dockerfile') -t $Image $repoRoot
if ($LASTEXITCODE -ne 0) { Fail "docker build 失败（退出码 $LASTEXITCODE）" 1 }

$failed = $false
try {
  Write-Host '[2/4] 镜像静态检查：运行用户 uid 与 /app 下的 .env 文件'
  $lines = @(& docker run --rm --entrypoint sh $Image -c 'id -u; ls -a /app')
  if ($LASTEXITCODE -ne 0) { throw "静态检查容器启动失败（退出码 $LASTEXITCODE）" }
  $uid = ([string]$lines[0]).Trim()
  $dotenv = @($lines | Select-Object -Skip 1 | Where-Object { $_ -match '^\.env' })
  Write-Host ("       uid={0}；/app 下 .env 数量={1}" -f $uid, $dotenv.Count)
  if ($uid -eq '0') { Write-Host '       FAIL: 容器以 root 运行（期望非 root 的 node 用户，uid 1000）'; $failed = $true }
  if ($dotenv.Count -ne 0) { Write-Host ("       FAIL: 镜像内出现 .env 文件: " + ($dotenv -join ', ')); $failed = $true }
  if ($failed) { throw '镜像静态检查未通过' }

  Write-Host "[3/4] 启动容器并轮询 /health（stub 模式，端口 $Port）"
  $mapping = $Port.ToString() + ':' + $Port.ToString()
  & docker run --rm -d --name $containerName -p $mapping `
    -e APP_EXECUTION_MODE=stub -e API_HOST=0.0.0.0 -e API_PORT=$Port -e LOG_LEVEL=info $Image *> $null
  if ($LASTEXITCODE -ne 0) { throw "docker run 失败（退出码 $LASTEXITCODE）" }

  $health = $null
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $Port) -TimeoutSec 3
      break
    } catch { Start-Sleep -Milliseconds 500 }
  }
  if ($null -eq $health) {
    Write-Host '       FAIL: 轮询超时，未取得 /health 响应。容器日志：'
    & docker logs $containerName
    throw '容器 /health 未通过'
  }
  Write-Host ("       GET http://127.0.0.1:{0}/health -> status={1} execution_mode={2} database={3}" -f `
      $Port, $health.status, $health.meta.execution_mode, $health.checks.database.status)
  Write-Host ("       " + ($health | ConvertTo-Json -Compress -Depth 5))

  $ok = ($health.status -eq 'ok') -and ($health.meta.execution_mode -eq 'stub') -and ($health.checks.database.status -eq 'not_configured')
  if (-not $ok) { Write-Host '       FAIL: 期望 status=ok、execution_mode=stub、database.status=not_configured'; $failed = $true }
  Write-Host '       --- 容器 stdout/stderr 尾部 ---'
  & docker logs --tail 20 $containerName
  if ($failed) { throw '容器健康检查语义不符' }

  Write-Host '[4/4] PASS：镜像可构建、容器可启动、/health 可访问且语义正确。' -ForegroundColor Green
  Write-Host '      注意：这是本机容器验证，不替代微信云托管平台构建、VPC 到 PG 的连通或真实验收。'
  exit 0
} finally {
  & docker rm -f $containerName *> $null
}
