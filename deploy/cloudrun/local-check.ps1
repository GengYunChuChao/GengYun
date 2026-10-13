#Requires -Version 5.1
<#
.SYNOPSIS
  耕云 API 镜像的本地自检。

.DESCRIPTION
  [1/4] 依赖闭包检查（**不需要 Docker**）：解析 deploy/cloudrun/Dockerfile 的 COPY 清单，把「镜像根」
        复刻到临时目录（node_modules 用 junction 指向仓库现有安装），再以容器根视角 import 入口依赖链。
        这能发现「COPY 少了 packages/** 之类 ⇒ 容器启动必然失败」的缺陷（见 PR 正文「变更 2」）。
  [2/4] 镜像静态检查（需要 Docker）：容器内运行用户不是 root、镜像内没有 .env。
  [3/4] 容器启动 + 轮询 /health（需要 Docker）。
  [4/4] 汇总。

  退出码：0 = 全部通过；1 = 有检查失败；2 = 环境不可用（找不到仓库根 / Dockerfile / 依赖未安装）；
          3 = 仅依赖闭包检查完成（本机无 Docker，镜像层仍未验证）。

.EXAMPLE
  pwsh -File deploy/cloudrun/local-check.ps1

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File deploy/cloudrun/local-check.ps1 -DockerfilePath C:\tmp\Dockerfile.before
#>
[CmdletBinding()]
param(
  [string]$Image = 'gengyun-api:local',
  [int]$Port = 3199,
  [int]$WaitSeconds = 40,
  [string]$DockerfilePath = '',
  [switch]$SkipDocker,
  [switch]$KeepStaging
)

$ErrorActionPreference = 'Stop'
$containerName = 'gengyun-api-check'
$keepStaging = $false

function Fail([string]$message, [int]$code) {
  Write-Host "[FAIL] $message" -ForegroundColor Red
  exit $code
}

function Remove-Staging([string]$path) {
  # 关键安全点：临时镜像根里有 node_modules **junction**。
  # Windows PowerShell 5.1 的 `Remove-Item -Recurse` 可能跟随 junction 删除目标内容
  # （即仓库的 node_modules）。因此先只删链接本身（cmd rmdir 不递归进目标），再删其余普通文件。
  if (-not (Test-Path -LiteralPath $path)) { return }
  $nm = Join-Path $path 'node_modules'
  if (Test-Path -LiteralPath $nm) {
    $item = Get-Item -LiteralPath $nm -Force -ErrorAction SilentlyContinue
    if ($item -and $item.LinkType) { & cmd /c rmdir "$nm" *> $null }
    else { Remove-Item -Recurse -Force -LiteralPath $nm -ErrorAction SilentlyContinue }
  }
  Remove-Item -Recurse -Force -LiteralPath $path -ErrorAction SilentlyContinue
}

function Get-CopyList([string]$path) {
  # 解析 Dockerfile 的 COPY 行：忽略 --from=（多阶段中间产物由镜像自身提供，不在仓库里）。
  $items = @()
  # 必须显式 -Encoding UTF8：本仓库的 Dockerfile 是不带 BOM 的 UTF-8，
  # Windows PowerShell 5.1 默认按 ANSI 代码页读它会毁掉整份行集（实测会丢掉 COPY 行）。
  foreach ($line in Get-Content -LiteralPath $path -Encoding UTF8) {
    $t = $line.Trim()
    if ($t -notmatch '^COPY\s+(?<rest>.+)$') { continue }
    $rest = $Matches['rest'].Trim()
    if ($rest -match '^--from=') { continue }
    $parts = @($rest -split '\s+' | Where-Object { $_ -ne '' })
    if ($parts.Count -lt 2) { continue }
    $dest = $parts[-1]
    foreach ($src in $parts[0..($parts.Count - 2)]) {
      $items += [pscustomobject]@{ Source = $src; Dest = $dest }
    }
  }
  return $items
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not (Test-Path (Join-Path $repoRoot 'package-lock.json'))) {
  Fail "找不到仓库根（缺少 package-lock.json）：$repoRoot" 2
}
if ([string]::IsNullOrWhiteSpace($DockerfilePath)) {
  $DockerfilePath = Join-Path $repoRoot 'deploy/cloudrun/Dockerfile'
}
if (-not (Test-Path -LiteralPath $DockerfilePath)) {
  Fail "找不到 Dockerfile：$DockerfilePath" 2
}

# ---------- [1/4] 依赖闭包检查（不需要 Docker） ----------
Write-Host '[1/4] 依赖闭包检查（容器根视角，不需要 Docker）'
$copyList = Get-CopyList $DockerfilePath
if ($copyList.Count -eq 0) { Fail "Dockerfile 里没有解析到任何 COPY 行：$DockerfilePath" 1 }
foreach ($item in $copyList) { Write-Host ("       COPY {0} -> {1}" -f $item.Source, $item.Dest) }

# 入口静态依赖必须都在探测清单里（server.ts 变更时提示维护者同步）。
$probeModules = @(
  'services/api/src/app.ts',
  'services/api/src/config.ts',
  'services/api/src/db/pool.ts',
  'services/api/src/db/migrate.ts'
)
$serverSrc = Get-Content -LiteralPath (Join-Path $repoRoot 'services/api/src/server.ts') -Raw -Encoding UTF8
$entryDeps = @([regex]::Matches($serverSrc, "(?m)^\s*import\b[^;\n]*?from\s*['""](\./[^'""]+)['""]") |
    ForEach-Object { 'services/api/src/' + ($_.Groups[1].Value -replace '^\./', '') })
$missingFromProbe = @($entryDeps | Where-Object { $probeModules -notcontains $_ })
if ($missingFromProbe.Count -ne 0) {
  Fail ("探测清单缺少入口依赖：{0}；请更新本脚本的 probeModules" -f ($missingFromProbe -join ', ')) 1
}

$staging = Join-Path $env:TEMP 'gengyun-image-root-check'
Remove-Staging $staging
New-Item -ItemType Directory -Force -Path $staging | Out-Null
foreach ($item in $copyList) {
  $srcPath = Join-Path $repoRoot ($item.Source -replace '/', '\')
  $destPath = Join-Path $staging ($item.Dest -replace '/', '\')
  if (-not (Test-Path -LiteralPath $srcPath)) { $keepStaging = $true; Fail ("COPY 源不存在：{0}" -f $item.Source) 1 }
  if (Test-Path -LiteralPath $srcPath -PathType Container) {
    New-Item -ItemType Directory -Force -Path $destPath | Out-Null
    Copy-Item -Path (Join-Path $srcPath '*') -Destination $destPath -Recurse -Force
  } else {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destPath) | Out-Null
    Copy-Item -LiteralPath $srcPath -Destination $destPath -Force
  }
}
# 模拟 `COPY --from=deps /app/node_modules ./node_modules`：junction 指向仓库现有安装。
$repoNodeModules = Join-Path $repoRoot 'node_modules'
if (-not (Test-Path -LiteralPath $repoNodeModules)) {
  $keepStaging = $true
  Fail '缺少 node_modules：请先在仓库根执行 npm ci 再跑本脚本' 2
}
New-Item -ItemType Junction -Path (Join-Path $staging 'node_modules') -Target $repoNodeModules | Out-Null

# 探测脚本必须位于镜像根内：只有这样 `./services/...` 才按「容器根 /app」解析（相对说明符按文件位置解析）。
$probe = @(
  "await import('./services/api/src/app.ts');"
  "await import('./services/api/src/config.ts');"
  "await import('./services/api/src/db/pool.ts');"
  "await import('./services/api/src/db/migrate.ts');"
  "console.log('IMPORT_OK');"
) -join "`n"
$probePath = Join-Path $staging '.import-probe.mjs'
[IO.File]::WriteAllText($probePath, $probe, (New-Object System.Text.UTF8Encoding($false)))

Push-Location $staging
$prevEap = $ErrorActionPreference
# Windows PowerShell 5.1：原生命令写 stderr 时 Stop 策略会把它当终止错误，
# 于是自己的 [FAIL] 与提示根本打不出来。这里临时降为 Continue 并逐行取字符串。
$ErrorActionPreference = 'Continue'
try {
  $out = @(& node $probePath 2>&1 |
      ForEach-Object { $_.ToString() } |
      Where-Object { $_ -ne 'System.Management.Automation.RemoteException' })
  $code = $LASTEXITCODE
} finally { $ErrorActionPreference = $prevEap; Pop-Location }
$out | ForEach-Object { Write-Host ("       " + $_) }
if ($code -ne 0 -or (($out -join "`n") -notmatch 'IMPORT_OK')) {
  $keepStaging = $true
  Write-Host ("[FAIL] 依赖闭包检查失败：容器根视角 import 入口失败（exit={0}）" -f $code) -ForegroundColor Red
  Write-Host ('       临时镜像根已保留，可用 node .import-probe.mjs 复现：' + $staging)
  exit 1
}
Write-Host '       IMPORT_OK：入口依赖链在容器根视角可解析（含 packages/** 的运行期 import 与顶层读取）' -ForegroundColor Green

# ---------- 需要 Docker 的步骤 ----------
$docker = Get-Command docker -ErrorAction SilentlyContinue
$dockerUsable = $false
if ($docker -and -not $SkipDocker) {
  & docker info *> $null
  $dockerUsable = ($LASTEXITCODE -eq 0)
}
if (-not $dockerUsable) {
  $reason = if ($SkipDocker) { '按 -SkipDocker 跳过' } elseif (-not $docker) { '本机未找到 docker' } else { 'docker 守护进程不可用（docker info 失败）' }
  Write-Host ("[2/4] 跳过镜像静态检查（{0}）" -f $reason)
  Write-Host ("[3/4] 跳过容器启动与 /health（{0}）" -f $reason)
  Write-Host '[4/4] 部分通过：依赖闭包检查已通过；镜像构建、容器启动与容器内 /health 未验证。' -ForegroundColor Yellow
  Write-Host '      未验证 != 通过。请在装有 Docker 的机器上重跑本脚本（或经平台流水线构建）后再判定镜像层。'
  if (-not $KeepStaging) { Remove-Staging $staging }
  exit 3
}

try {
  Write-Host "[2/4] docker build -f $DockerfilePath -t $Image .   (上下文: $repoRoot)"
  & docker build -f $DockerfilePath -t $Image $repoRoot
  if ($LASTEXITCODE -ne 0) { Fail "docker build 失败（退出码 $LASTEXITCODE）" 1 }

  Write-Host '[2/4] 镜像静态检查：运行用户 uid 与 /app 下的 .env 文件'
  $lines = @(& docker run --rm --entrypoint sh $Image -c 'id -u; ls -a /app')
  if ($LASTEXITCODE -ne 0) { Fail "静态检查容器启动失败（退出码 $LASTEXITCODE）" 1 }
  $uid = ([string]$lines[0]).Trim()
  $dotenv = @($lines | Select-Object -Skip 1 | Where-Object { $_ -match '^\.env' })
  Write-Host ("       uid={0}；/app 下 .env 数量={1}" -f $uid, $dotenv.Count)
  $failed = $false
  if ($uid -eq '0') { Write-Host '       FAIL: 容器以 root 运行（期望非 root 的 node 用户，uid 1000）'; $failed = $true }
  if ($dotenv.Count -ne 0) { Write-Host ("       FAIL: 镜像内出现 .env 文件: " + ($dotenv -join ', ')); $failed = $true }
  if ($failed) { Fail '镜像静态检查未通过' 1 }

  Write-Host "[3/4] 启动容器并轮询 /health（stub 模式，端口 $Port）"
  $mapping = $Port.ToString() + ':' + $Port.ToString()
  & docker run --rm -d --name $containerName -p $mapping `
    -e APP_EXECUTION_MODE=stub -e API_HOST=0.0.0.0 -e API_PORT=$Port -e LOG_LEVEL=info $Image *> $null
  if ($LASTEXITCODE -ne 0) { Fail "docker run 失败（退出码 $LASTEXITCODE）" 1 }

  $health = $null
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $deadline) {
    try { $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $Port) -TimeoutSec 3; break }
    catch { Start-Sleep -Milliseconds 500 }
  }
  if ($null -eq $health) {
    Write-Host '       FAIL: 轮询超时，未取得 /health 响应。容器日志：'
    & docker logs $containerName
    Fail '容器 /health 未通过' 1
  }
  Write-Host ("       GET http://127.0.0.1:{0}/health -> status={1} execution_mode={2} database={3}" -f `
      $Port, $health.status, $health.meta.execution_mode, $health.checks.database.status)
  Write-Host ("       " + ($health | ConvertTo-Json -Compress -Depth 5))
  Write-Host '       --- 容器 stdout/stderr 尾部 ---'
  & docker logs --tail 20 $containerName
  $ok = ($health.status -eq 'ok') -and ($health.meta.execution_mode -eq 'stub') -and ($health.checks.database.status -eq 'not_configured')
  if (-not $ok) { Fail '容器健康检查语义不符（期望 status=ok、execution_mode=stub、database.status=not_configured）' 1 }

  Write-Host '[4/4] PASS：依赖闭包、镜像可构建、容器可启动、/health 可访问且语义正确。' -ForegroundColor Green
  Write-Host '      注意：这是本机容器验证，不替代微信云托管平台构建、VPC 到 PG 的连通或真实验收。'
  exit 0
} finally {
  & docker rm -f $containerName *> $null
  if (-not $KeepStaging -and -not $keepStaging) { Remove-Staging $staging }
}
