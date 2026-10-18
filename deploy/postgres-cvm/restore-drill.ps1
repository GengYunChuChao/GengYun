<#
耕云 · 本机（Windows）恢复演练：备份 → 隔离库恢复 → 五条判据逐条判定
===========================================================================
口径来源：deploy/postgres-cvm/restore-drill.sh（Linux/CVM 版）。本脚本是它的
Windows 等价实现：**同样的五条判据、同样的退出码语义、同样的"演练库只在
drill/restore 命名空间内重建"约束**；差别只在进程与权限模型（Windows 没有
root/runuser/systemd，走 TCP + 口令文件，不切换到系统用户）。

五条判据（与 shell 版逐项同口径）：
  1/5 dump sha256 与清单一致；
  2/5 pg_restore --exit-on-error 退出 0，且完整输出里没有 ERROR: 行；
  3/5 schema_migrations 版本集合与清单一致；
  4/5 基本表数量、视图数量与清单一致；
  5/5 清单列出的关键表逐表行数一致（MISSING 也必须一致）。
（附：判据 1b restore_toc_entries，与 shell 版一样作为 dump 可读性的补充读数。）

退出码：
  0 = 五条全 PASS；
  1 = 有 FAIL（含恢复过程失败）；
  2 = 恢复成功但缺清单 ⇒ 行数/版本判据未执行，证据不完整，不算通过。

安全默认（fail-closed）：
  * 目标库名必须含 drill 或 restore，且不得等于源库、不得是系统库；
  * 目标库默认先 DROP 再 CREATE；-NoRecreate **只用于负控制**——它让脚本把
    dump 恢复进一个**非空**目标库，用来证明"判据 2 会变红"，不是正常用法；
  * 口令只从文件读（-OwnerPasswordFile 的第一条非空行），不落命令行、不打印；
  * 端口必须落在 Windows 保留段之外：保留段（netsh interface ipv4 show
    excludedportrange protocol=tcp）被占用时客户端一律"拒绝连接"，本机实测踩过，
    故做成硬门禁，不提供静默跳过；
  * 本脚本不碰源库结构：只读源库（pg_dump），写只发生在目标库与 -WorkDir。

用法（PowerShell 5.1 与 PowerShell 7 均可；本文件为 UTF-8 带 BOM，5.1 需要 BOM
才能正确解码中文）：
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\restore-drill.ps1 `
    -PgBin E:\GengYunCommander\.pg17\pgsql\bin `
    -Database gengyun -Port 55631 `
    -WorkDir E:\GengYunCommander\.pg17\tmp\drill-pg\work `
    -OwnerPasswordFile E:\GengYunCommander\.pg17\tmp\drill-owner.pw

复跑既有 dump（不再备份；清单取 <DumpFile>.manifest.txt，与 shell 版同约定）：
  ... -DumpFile <路径>.dump

已证明 / 未证明（与 shell 版同样克制）：
  证明：该 dump 能在同主版本 PG17 上完整重建 schema + 数据 + 属主/授权，且
        迁移版本、表/视图数量、关键表行数与清单逐项一致。
  未证明：CVM 上的 systemd/runuser/Unix socket 路径、异地或全新集群灾备（需先重建
        角色）、PITR（无 WAL 归档）、逐用户删除清单重放、RPO/RTO 指标；
        **也不证明生产可用或"数据库已验收"**。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PgBin,
    [string]$OwnerUser = 'gengyun_cvm_owner',
    [string]$OwnerPasswordFile = '',
    [Parameter(Mandatory = $true)][string]$Database,
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$WorkDir,
    [string]$PgHost = '127.0.0.1',
    [string]$TargetDatabase = '',
    [string]$DumpFile = '',
    [switch]$Keep,
    [switch]$NoRecreate,
    [switch]$NoManifest
)

$ErrorActionPreference = 'Stop'
$ScriptName = 'restore-drill.ps1'
$script:PassCount = 0
$script:FailCount = 0
$script:Incomplete = $false
$script:Report = New-Object System.Collections.Generic.List[string]
$script:TargetCreated = $false
$script:Manifest = ''

# 关键表：与 backup-postgres.sh 的 KEY_TABLES 逐行一致（清单缺项也算证据不完整）。
$KeyTables = @(
    'public.users'
    'public.sessions'
    'public.admin_accounts'
    'public.admin_sessions'
    'public.idempotency_keys'
    'public.consent_records'
    'public.privacy_epochs'
    'public.crops'
    'public.regions'
    'public.single_profiles'
    'public.sources'
    'public.source_versions'
    'public.knowledge_versions'
    'catalog_ops.operations'
    'staging_intake.batches'
    'staging_intake.operations'
    'knowledge_staging.workbook_batches'
    'knowledge_staging.workbook_rows'
)

function Write-Log {
    param([string]$Message)
    Write-Output ("[{0}] {1}" -f $ScriptName, $Message)
}

function Write-Warn {
    param([string]$Message)
    Write-Output ("[{0}][WARN] {1}" -f $ScriptName, $Message)
}

function Stop-Fail {
    param([string]$Message)
    Write-Output ("[{0}][ERROR] {1}" -f $ScriptName, $Message)
    exit 1
}

function Report-Line {
    param(
        [string]$Status,
        [string]$Name,
        [string]$Expected,
        [string]$Actual
    )
    if ($Status -eq 'PASS') { $script:PassCount++ } else { $script:FailCount++ }
    $line = "{0} {1} 期望={2} 实际={3}" -f $Status, $Name.PadRight(40), $Expected, $Actual
    $script:Report.Add($line)
    Write-Output $line
}

<#
  统一的外部进程调用：经 cmd.exe 重定向，把 stdout+stderr 合并写进日志文件，
  再返回退出码。不用 Start-Process：本机环境变量里同时存在 NO_PROXY/no_proxy
  等大小写重复键时，Windows PowerShell 5.1 的 Start-Process 会直接抛
  ArgumentException（"字典中的关键字…"），cmd 重定向没有这个问题。
#>
function Invoke-Tool {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$LogPath = ''
    )
    $quoted = @()
    foreach ($a in $Arguments) { $quoted += ('"' + $a + '"') }
    $inner = '"' + $Exe + '" ' + ($quoted -join ' ')
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ([string]::IsNullOrEmpty($LogPath)) {
            $out = & cmd.exe /c $inner 2>&1
            $rc = $LASTEXITCODE
            return [pscustomobject]@{
                ExitCode = $rc
                Output   = (($out | ForEach-Object { "$_" }) -join "`n")
            }
        }
        $cmdline = $inner + ' > "' + $LogPath + '" 2>&1'
        & cmd.exe /c $cmdline | Out-Null
        $rc = $LASTEXITCODE
        return [pscustomobject]@{ ExitCode = $rc; Output = '' }
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Get-Scalar {
    param([string]$Sql, [string]$Db)
    $res = Invoke-Tool -Exe $script:Psql -Arguments @(
        '-X', '-q', '-v', 'ON_ERROR_STOP=1',
        '-h', $PgHost, '-p', "$Port", '-U', $OwnerUser, '-d', $Db, '-tAc', $Sql
    )
    if ($res.ExitCode -ne 0) {
        Stop-Fail ("查询失败（数据库 {0}）：{1}`n{2}" -f $Db, $Sql, $res.Output)
    }
    return $res.Output.Trim()
}

function Get-ManifestValue {
    param([string]$ManifestPath, [string]$Key)
    foreach ($line in [System.IO.File]::ReadAllLines($ManifestPath)) {
        if ($line.StartsWith($Key + '=', [System.StringComparison]::Ordinal)) {
            return $line.Substring($Key.Length + 1)
        }
    }
    return ''
}

function Get-ExcludedPortRanges {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $raw = & netsh.exe interface ipv4 show excludedportrange protocol=tcp 2>&1
        $rc = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    $ranges = @()
    if ($rc -ne 0) { return $ranges }
    foreach ($line in @($raw)) {
        if ("$line" -match '^\s*(\d+)\s+(\d+)\s*\*?\s*$') {
            $ranges += [pscustomobject]@{ Start = [int]$Matches[1]; End = [int]$Matches[2] }
        }
    }
    return $ranges
}

# ---------------------------------------------------------------------------
# 0. 前置校验（任一不满足即停，不"带病演练"）
# ---------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $PgBin -PathType Container)) {
    Stop-Fail "-PgBin 不是目录：$PgBin"
}
$PG = (Resolve-Path -LiteralPath $PgBin).Path
$script:Psql = Join-Path $PG 'psql.exe'
$pgDump = Join-Path $PG 'pg_dump.exe'
$pgRestore = Join-Path $PG 'pg_restore.exe'
$createdb = Join-Path $PG 'createdb.exe'
$dropdb = Join-Path $PG 'dropdb.exe'
foreach ($exe in @($script:Psql, $pgDump, $pgRestore, $createdb, $dropdb)) {
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
        Stop-Fail "-PgBin 下缺少可执行文件：$exe"
    }
}

if ($Port -lt 1 -or $Port -gt 65535) {
    Stop-Fail "-Port 越界：$Port"
}
$excluded = Get-ExcludedPortRanges
$inExcluded = $false
foreach ($r in $excluded) {
    if ($Port -ge $r.Start -and $Port -le $r.End) {
        Stop-Fail ("-Port {0} 落在 Windows 保留段 {1}-{2}（netsh interface ipv4 show excludedportrange protocol=tcp）：客户端会一律拒绝连接。请换端口。" -f $Port, $r.Start, $r.End)
    }
    $inExcluded = $inExcluded -or ($Port -ge $r.Start -and $Port -le $r.End)
}
if ($excluded.Count -eq 0) {
    Write-Warn "未读到 Windows 保留端口段（netsh 无输出或失败）；端口可用性无法机械核对，继续但请自行确认。"
}

$systemDbs = @('postgres', 'template0', 'template1')
if ($systemDbs -contains $Database.ToLowerInvariant()) {
    Stop-Fail "-Database 不能是系统库：$Database"
}
if ([string]::IsNullOrEmpty($TargetDatabase)) {
    $TargetDatabase = $Database + '_restore_drill'
}
if ($TargetDatabase -eq $Database) {
    Stop-Fail "-TargetDatabase 不得等于 -Database（$Database）：演练必须在隔离库进行。"
}
if ($systemDbs -contains $TargetDatabase.ToLowerInvariant()) {
    Stop-Fail "-TargetDatabase 不能是系统库：$TargetDatabase"
}
if ($TargetDatabase -notmatch '(?i)(drill|restore)') {
    Stop-Fail "-TargetDatabase 名字必须含 drill 或 restore（当前：$TargetDatabase）：脚本只允许在演练命名空间内建/删库。"
}

$WorkDir = $WorkDir.TrimEnd('\')
if (-not [System.IO.Path]::IsPathRooted($WorkDir)) {
    Stop-Fail "-WorkDir 必须是绝对路径：$WorkDir"
}
if ($WorkDir.Length -le 3) {
    Stop-Fail "-WorkDir 不能是盘符根目录：$WorkDir"
}
if (-not (Test-Path -LiteralPath $WorkDir -PathType Container)) {
    New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
}
$probe = Join-Path $WorkDir ('.restore-drill-probe-' + [Guid]::NewGuid().ToString('N'))
try {
    [System.IO.File]::WriteAllText($probe, 'probe')
} catch {
    Stop-Fail "-WorkDir 不可写：$WorkDir（$($_.Exception.Message)）"
} finally {
    if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force }
}

$pgPassHad = -not [string]::IsNullOrEmpty($env:PGPASSWORD)
if (-not [string]::IsNullOrEmpty($OwnerPasswordFile)) {
    if (-not (Test-Path -LiteralPath $OwnerPasswordFile -PathType Leaf)) {
        Stop-Fail "-OwnerPasswordFile 不存在：$OwnerPasswordFile"
    }
    $secret = ''
    foreach ($line in [System.IO.File]::ReadAllLines($OwnerPasswordFile)) {
        if ($line.Trim().Length -gt 0) { $secret = $line.Trim(); break }
    }
    if ([string]::IsNullOrEmpty($secret)) {
        Stop-Fail "-OwnerPasswordFile 里没有非空行：$OwnerPasswordFile"
    }
    $env:PGPASSWORD = $secret
    $secret = $null
    Write-Log "口令来源：文件（-OwnerPasswordFile；内容不打印、不进命令行）"
} else {
    if ($pgPassHad) {
        Write-Log "口令来源：环境变量 PGPASSWORD（未用 -OwnerPasswordFile）"
    } else {
        Write-Warn "未提供 -OwnerPasswordFile 且 PGPASSWORD 为空：只能依赖 pg_hba 的 trust/peer 规则；口令类认证会失败。"
    }
}

$dumpVersionText = (& cmd.exe /c ('"' + $pgDump + '" --version')) -join ''
$pgDumpVersion = ($dumpVersionText -split '\s+')[-1]
Write-Log ("pg_dump 版本：{0}" -f $dumpVersionText.Trim())
Write-Log ("源库：{0}（{1}:{2}，属主角色 {3}）" -f $Database, $PgHost, $Port, $OwnerUser)
Write-Log ("演练目标库：{0}；工作目录：{1}" -f $TargetDatabase, $WorkDir)

$serverVersion = Get-Scalar -Sql 'SHOW server_version' -Db $Database
if ($serverVersion -notmatch '^17\.') {
    Stop-Fail "源库不是 PG17（SHOW server_version = $serverVersion）：本演练只在同主版本上判定。"
}
Write-Log ("源库 server_version={0}" -f $serverVersion)

# ---------------------------------------------------------------------------
# 1. 备份（除非给了 -DumpFile）+ 清单
# ---------------------------------------------------------------------------
if (-not [string]::IsNullOrEmpty($DumpFile)) {
    if (-not (Test-Path -LiteralPath $DumpFile -PathType Leaf)) {
        Stop-Fail "-DumpFile 不存在：$DumpFile"
    }
    $DumpFile = (Resolve-Path -LiteralPath $DumpFile).Path
    $script:Manifest = $DumpFile + '.manifest.txt'
    Write-Log ("复用既有 dump（跳过备份步骤）：{0}" -f $DumpFile)
} else {
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    $DumpFile = Join-Path $WorkDir ("gengyun-{0}-{1}.dump" -f $Database, $stamp)
    $script:Manifest = $DumpFile + '.manifest.txt'

    $tmpDump = $DumpFile + '.partial'
    Write-Log ("备份中：{0} → {1}" -f $Database, $DumpFile)
    $dump = Invoke-Tool -Exe $pgDump -Arguments @(
        '-h', $PgHost, '-p', "$Port", '-U', $OwnerUser, '-d', $Database,
        '-Fc', '-Z', '6', '--lock-wait-timeout=60s', '-f', $tmpDump
    ) -LogPath ($tmpDump + '.log')
    if ($dump.ExitCode -ne 0) {
        $why = (Get-Content -LiteralPath ($tmpDump + '.log') -Encoding UTF8) -join "`n"
        Stop-Fail ("pg_dump 退出码 {0}：{1}" -f $dump.ExitCode, $why)
    }
    if (-not (Test-Path -LiteralPath $tmpDump -PathType Leaf) -or (Get-Item -LiteralPath $tmpDump).Length -le 0) {
        Stop-Fail "pg_dump 产出为空文件，视为失败：$tmpDump"
    }
    Move-Item -LiteralPath $tmpDump -Destination $DumpFile -Force
    Remove-Item -LiteralPath ($tmpDump + '.log') -Force -ErrorAction SilentlyContinue

    $listLog = $DumpFile + '.list.log'
    $list = Invoke-Tool -Exe $pgRestore -Arguments @('--list', $DumpFile) -LogPath $listLog
    if ($list.ExitCode -ne 0) {
        Stop-Fail "pg_restore --list 无法读取 $DumpFile：备份文件不可用，不得据此声称已备份。"
    }
    $tocEntries = 0
    foreach ($line in Get-Content -LiteralPath $listLog -Encoding UTF8) {
        if ($line.Contains(';')) { $tocEntries++ }
    }
    Remove-Item -LiteralPath $listLog -Force -ErrorAction SilentlyContinue

    $sha = (Get-FileHash -LiteralPath $DumpFile -Algorithm SHA256).Hash.ToLowerInvariant()
    $bytes = (Get-Item -LiteralPath $DumpFile).Length
    Write-Log ("备份完成：sha256={0} bytes={1} toc_entries={2}" -f $sha, $bytes, $tocEntries)

    $migrations = Get-Scalar -Sql 'SELECT COALESCE(string_agg(version, $$,$$ ORDER BY version), $$$$) FROM schema_migrations' -Db $Database
    $baseTableCount = Get-Scalar -Sql "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'BASE TABLE'" -Db $Database
    $viewCount = Get-Scalar -Sql "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'VIEW'" -Db $Database

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('format=pg_dump-custom-v1')
    $lines.Add('backup_utc=' + $stamp)
    $lines.Add('database=' + $Database)
    $lines.Add('server_version=' + $serverVersion)
    $lines.Add('pg_dump_version=' + $pgDumpVersion)
    $lines.Add('platform=windows')
    $lines.Add('host=' + $PgHost)
    $lines.Add('port=' + $Port)
    $lines.Add('restore_toc_entries=' + $tocEntries)
    $lines.Add('dump_bytes=' + $bytes)
    $lines.Add('dump_sha256=' + $sha)
    $lines.Add('migration_versions=' + $migrations)
    $lines.Add('base_table_count=' + $baseTableCount)
    $lines.Add('view_count=' + $viewCount)
    foreach ($t in $KeyTables) {
        if ($t -notmatch '^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$') {
            Stop-Fail "关键表名不合规（拒绝拼进 SQL）：$t"
        }
        $exists = Get-Scalar -Sql ("SELECT to_regclass('" + $t + "') IS NOT NULL") -Db $Database
        if ($exists -eq 't') {
            $count = Get-Scalar -Sql ("SELECT count(*) FROM " + $t) -Db $Database
            $lines.Add('rows:' + $t + '=' + $count)
        } else {
            $lines.Add('rows:' + $t + '=MISSING')
        }
    }
    [System.IO.File]::WriteAllText($script:Manifest, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    Write-Log ("清单已写：{0}（{1} 行）" -f $script:Manifest, $lines.Count)
}

$manifestUsable = (-not $NoManifest) -and (Test-Path -LiteralPath $script:Manifest -PathType Leaf)
if (-not $manifestUsable) {
    $script:Incomplete = $true
    if ($NoManifest) {
        Write-Warn "-NoManifest：本次判定不使用清单 ⇒ 判据 1/3/4/5 与 1b 不执行，证据不完整（退出码 2）。"
    } else {
        Write-Warn ("找不到清单 {0}：判据 1/3/4/5 与 1b 不执行 ⇒ 证据不完整（退出码 2）。" -f $script:Manifest)
    }
}

# ---------------------------------------------------------------------------
# 2. 判据 1：dump sha256（恢复之前判定，与 shell 版同序）
# ---------------------------------------------------------------------------
if ($manifestUsable) {
    $expectedSha = Get-ManifestValue -ManifestPath $script:Manifest -Key 'dump_sha256'
    $actualSha = (Get-FileHash -LiteralPath $DumpFile -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not [string]::IsNullOrEmpty($expectedSha) -and $expectedSha -eq $actualSha) {
        Report-Line -Status 'PASS' -Name '判据1/5 dump_sha256' -Expected ($expectedSha.Substring(0, 16) + '…') -Actual ($actualSha.Substring(0, 16) + '…')
    } else {
        if ([string]::IsNullOrEmpty($expectedSha)) { $expectedSha = '（清单缺失）' }
        Report-Line -Status 'FAIL' -Name '判据1/5 dump_sha256' -Expected $expectedSha -Actual ($actualSha.Substring(0, 16) + '…')
    }

    $expectedToc = Get-ManifestValue -ManifestPath $script:Manifest -Key 'restore_toc_entries'
    if (-not [string]::IsNullOrEmpty($expectedToc)) {
        $tocLog = Join-Path $WorkDir ('toc-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '.log')
        $tocResult = Invoke-Tool -Exe $pgRestore -Arguments @('--list', $DumpFile) -LogPath $tocLog
        $actualToc = 0
        if ($tocResult.ExitCode -eq 0 -and (Test-Path -LiteralPath $tocLog)) {
            foreach ($line in Get-Content -LiteralPath $tocLog -Encoding UTF8) {
                if ($line.Contains(';')) { $actualToc++ }
            }
        } else {
            $actualToc = 'list-failed'
        }
        Remove-Item -LiteralPath $tocLog -Force -ErrorAction SilentlyContinue
        if ("$actualToc" -eq $expectedToc) {
            Report-Line -Status 'PASS' -Name '判据1b/5 restore_toc_entries' -Expected $expectedToc -Actual "$actualToc"
        } else {
            Report-Line -Status 'FAIL' -Name '判据1b/5 restore_toc_entries' -Expected $expectedToc -Actual "$actualToc"
        }
    }
}

# ---------------------------------------------------------------------------
# 3. 重建演练目标库（只在 drill/restore 命名空间内）
# ---------------------------------------------------------------------------
$targetQuoted = $TargetDatabase.Replace("'", "''")
if ($NoRecreate) {
    Write-Warn "-NoRecreate（负控制）：不 DROP/不 CREATE 目标库；目标库若已有同名对象，判据 2 必须变红。"
    $exists = Get-Scalar -Sql ("SELECT 1 FROM pg_database WHERE datname = '" + $targetQuoted + "'") -Db 'postgres'
    if ($exists -ne '1') {
        Stop-Fail "-NoRecreate 要求目标库已存在：$TargetDatabase"
    }
} else {
    Write-Log ("重建演练目标库：{0}" -f $TargetDatabase)
    Get-Scalar -Sql ("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '" + $targetQuoted + "' AND pid <> pg_backend_pid()") -Db 'postgres' | Out-Null
    $dropLog = Join-Path $WorkDir 'dropdb.log'
    $drop = Invoke-Tool -Exe $dropdb -Arguments @('-h', $PgHost, '-p', "$Port", '-U', $OwnerUser, '--if-exists', $TargetDatabase) -LogPath $dropLog
    if ($drop.ExitCode -ne 0) {
        $why = (Get-Content -LiteralPath $dropLog -Encoding UTF8) -join "`n"
        Stop-Fail ("dropdb 失败（{0}）：{1}" -f $drop.ExitCode, $why)
    }
    $createLog = Join-Path $WorkDir 'createdb.log'
    $create = Invoke-Tool -Exe $createdb -Arguments @('-h', $PgHost, '-p', "$Port", '-U', $OwnerUser, '-O', $OwnerUser, '-E', 'UTF8', '-T', 'template0', $TargetDatabase) -LogPath $createLog
    if ($create.ExitCode -ne 0) {
        $why = (Get-Content -LiteralPath $createLog -Encoding UTF8) -join "`n"
        Stop-Fail ("createdb 失败（{0}）：{1}" -f $create.ExitCode, $why)
    }
    $script:TargetCreated = $true
    Remove-Item -LiteralPath $dropLog -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $createLog -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# 4. 判据 2：恢复（--exit-on-error；完整输出保留到日志，不吞 stderr）
# ---------------------------------------------------------------------------
$restoreLog = Join-Path $WorkDir ('restore-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '.log')
Write-Log ("恢复中：{0} → {1}（完整输出写入 {2}）" -f $DumpFile, $TargetDatabase, $restoreLog)
$restore = Invoke-Tool -Exe $pgRestore -Arguments @(
    '-h', $PgHost, '-p', "$Port", '-U', $OwnerUser, '-d', $TargetDatabase,
    '--exit-on-error', '--no-password', $DumpFile
) -LogPath $restoreLog

$logLines = @()
if (Test-Path -LiteralPath $restoreLog) {
    $logLines = Get-Content -LiteralPath $restoreLog -Encoding UTF8
}
$fatalLines = @()
$noticeCount = 0
foreach ($line in $logLines) {
    if ($line -cmatch '^(pg_restore: error:|ERROR:)') { $fatalLines += $line }
    if ($line -cmatch '^(pg_restore: )?(WARNING|NOTICE):') { $noticeCount++ }
}

$criterion2Ok = ($restore.ExitCode -eq 0 -and $fatalLines.Count -eq 0)
if ($criterion2Ok) {
    Report-Line -Status 'PASS' -Name '判据2/5 pg_restore --exit-on-error' -Expected 'exit=0 且无 ERROR:' -Actual ("exit=0；非致命 WARNING/NOTICE {0} 行" -f $noticeCount)
} else {
    Report-Line -Status 'FAIL' -Name '判据2/5 pg_restore --exit-on-error' -Expected 'exit=0 且无 ERROR:' -Actual ("exit={0}；致命 error 行={1}" -f $restore.ExitCode, $fatalLines.Count)
    Write-Output ("[{0}] pg_restore 失败，前几条致命错误：" -f $ScriptName)
    $shown = 0
    foreach ($line in $fatalLines) {
        if ($shown -ge 5) { break }
        Write-Output ('         ' + $line)
        $shown++
    }
    if ($fatalLines.Count -eq 0) {
        Write-Output '         （未匹配到 ERROR: 行，请直接看日志）'
    }
    $joined = $fatalLines -join "`n"
    if ($joined -match 'already exists') {
        Write-Output ("[{0}] 判读：目标库不是空的（对象已存在）。正常路径下脚本会先 DROP 再建；只有在 -NoRecreate 负控制里才会看到它。这不是 dump 的问题。" -f $ScriptName)
    } elseif ($joined -match 'does not exist') {
        Write-Output ("[{0}] 判读：缺角色或缺对象（如 role … does not exist）⇒ 目标集群尚未完成角色引导；本 dump 不含角色定义。" -f $ScriptName)
    } else {
        Write-Output ("[{0}] 判读：既非对象已存在也非对象不存在，属真实失败，请人工看日志定位。" -f $ScriptName)
    }
}

# ---------------------------------------------------------------------------
# 5. 判据 3/4/5：内容判定（只在恢复成功且有清单时执行，与 shell 版同条件）
# ---------------------------------------------------------------------------
if (-not $criterion2Ok) {
    Write-Log "恢复未成功：判据 3/4/5 跳过（与 shell 版同条件），结论已是【未通过】。"
} elseif (-not $manifestUsable) {
    $script:Incomplete = $true
    Write-Warn "缺清单：判据 3/4/5 未执行 ⇒ 证据不完整。"
} else {
    $expectedMigrations = Get-ManifestValue -ManifestPath $script:Manifest -Key 'migration_versions'
    $hasLedger = Get-Scalar -Sql "SELECT to_regclass('public.schema_migrations') IS NOT NULL" -Db $TargetDatabase
    if ($hasLedger -eq 't') {
        $actualMigrations = Get-Scalar -Sql 'SELECT COALESCE(string_agg(version, $$,$$ ORDER BY version), $$$$) FROM schema_migrations' -Db $TargetDatabase
    } else {
        $actualMigrations = 'schema_migrations-missing'
    }
    if ($expectedMigrations -eq $actualMigrations) {
        Report-Line -Status 'PASS' -Name '判据3/5 migration_versions' -Expected $expectedMigrations -Actual $actualMigrations
    } else {
        Report-Line -Status 'FAIL' -Name '判据3/5 migration_versions' -Expected $expectedMigrations -Actual $actualMigrations
    }

    $expectedTables = Get-ManifestValue -ManifestPath $script:Manifest -Key 'base_table_count'
    $actualTables = Get-Scalar -Sql "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'BASE TABLE'" -Db $TargetDatabase
    if ($expectedTables -eq $actualTables) {
        Report-Line -Status 'PASS' -Name '判据4/5 base_table_count' -Expected $expectedTables -Actual $actualTables
    } else {
        Report-Line -Status 'FAIL' -Name '判据4/5 base_table_count' -Expected $expectedTables -Actual $actualTables
    }

    $expectedViews = Get-ManifestValue -ManifestPath $script:Manifest -Key 'view_count'
    $actualViews = Get-Scalar -Sql "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'VIEW'" -Db $TargetDatabase
    if ($expectedViews -eq $actualViews) {
        Report-Line -Status 'PASS' -Name '判据4/5 view_count' -Expected $expectedViews -Actual $actualViews
    } else {
        Report-Line -Status 'FAIL' -Name '判据4/5 view_count' -Expected $expectedViews -Actual $actualViews
    }

    $rowLines = New-Object System.Collections.Generic.List[string]
    foreach ($line in [System.IO.File]::ReadAllLines($script:Manifest)) {
        if ($line.StartsWith('rows:', [System.StringComparison]::Ordinal)) { $rowLines.Add($line) }
    }
    if ($rowLines.Count -eq 0) {
        $script:Incomplete = $true
        Write-Warn "清单里没有 rows: 行 ⇒ 判据 5 未执行，证据不完整。"
    }
    foreach ($line in $rowLines) {
        $body = $line.Substring(5)
        $idx = $body.IndexOf('=')
        if ($idx -lt 1) {
            Report-Line -Status 'FAIL' -Name ('判据5/5 ' + $line) -Expected '格式合法' -Actual '无法解析'
            continue
        }
        $tbl = $body.Substring(0, $idx)
        $expectedRows = $body.Substring($idx + 1)
        if ($tbl -notmatch '^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$') {
            Report-Line -Status 'FAIL' -Name ('判据5/5 rows:' + $tbl) -Expected '表名合法' -Actual '不合规（拒绝拼 SQL）'
            continue
        }
        if ($expectedRows -ne 'MISSING' -and $expectedRows -notmatch '^\d+$') {
            Report-Line -Status 'FAIL' -Name ('判据5/5 rows:' + $tbl) -Expected $expectedRows -Actual '清单值不是非负整数'
            continue
        }
        $tblExists = Get-Scalar -Sql ("SELECT to_regclass('" + $tbl + "') IS NOT NULL") -Db $TargetDatabase
        if ($tblExists -eq 't') {
            $actualRows = Get-Scalar -Sql ("SELECT count(*) FROM " + $tbl) -Db $TargetDatabase
        } else {
            $actualRows = 'MISSING'
        }
        if ($expectedRows -eq $actualRows) {
            Report-Line -Status 'PASS' -Name ('判据5/5 rows:' + $tbl) -Expected $expectedRows -Actual $actualRows
        } else {
            Report-Line -Status 'FAIL' -Name ('判据5/5 rows:' + $tbl) -Expected $expectedRows -Actual $actualRows
        }
    }
}

# ---------------------------------------------------------------------------
# 6. 清理与结论
# ---------------------------------------------------------------------------
if ($script:TargetCreated -and -not $Keep) {
    Write-Log ("删除演练目标库：{0}" -f $TargetDatabase)
    Get-Scalar -Sql ("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '" + $targetQuoted + "' AND pid <> pg_backend_pid()") -Db 'postgres' | Out-Null
    $dropLog = Join-Path $WorkDir 'dropdb-final.log'
    $drop = Invoke-Tool -Exe $dropdb -Arguments @('-h', $PgHost, '-p', "$Port", '-U', $OwnerUser, '--if-exists', $TargetDatabase) -LogPath $dropLog
    if ($drop.ExitCode -ne 0) {
        Write-Warn ("dropdb 收尾失败（{0}）：{1}" -f $drop.ExitCode, ((Get-Content -LiteralPath $dropLog -Encoding UTF8) -join "`n"))
    }
    Remove-Item -LiteralPath $dropLog -Force -ErrorAction SilentlyContinue
} elseif ($script:TargetCreated -and $Keep) {
    Write-Log ("按 -Keep 保留演练目标库：{0}（人工核对后再 dropdb）" -f $TargetDatabase)
}

Write-Output ''
Write-Output '===== 恢复演练判定 ====='
foreach ($l in $script:Report) { Write-Output $l }
Write-Output ("PASS={0} FAIL={1}" -f $script:PassCount, $script:FailCount)
Write-Output ("dump={0}" -f $DumpFile)
Write-Output ("manifest={0}" -f $script:Manifest)

if ($script:FailCount -gt 0) {
    Write-Output ''
    Write-Output ("[{0}] 结论：恢复演练【未通过】。该备份不足以声称可恢复，禁止据此宣称已有可用备份。" -f $ScriptName)
    exit 1
}
if ($script:Incomplete) {
    Write-Output ''
    Write-Output ("[{0}] 结论：恢复本身成功，但缺清单，行数/迁移版本判据未执行 ⇒ 证据不完整，不算演练通过。" -f $ScriptName)
    exit 2
}
Write-Output ''
Write-Output ("[{0}] 结论：恢复演练【通过】。" -f $ScriptName)
Write-Output '  本次证明了：该 dump 可在同主版本 PG17 上完整重建 schema+数据+属主/授权，'
Write-Output '              迁移版本、基本表/视图数量与清单列出的关键表行数逐项一致。'
Write-Output '  本次未证明：异地或全新集群灾备（需先重建角色）、PITR（无 WAL 归档）、'
Write-Output '              逐用户删除清单重放、RPO/RTO 指标、CVM 上 systemd/runuser 路径。'
Write-Output '  仍不得据此宣布数据库已验收或整项完成。'
exit 0
