param([Parameter(Mandatory=$true)][string]$RuntimeRoot,[Parameter(Mandatory=$true)][string]$PostgresBin,[int]$PgPort=55488,[int]$ApiPort=3128)
$ErrorActionPreference = 'Stop'
$runtimePath = [IO.Path]::GetFullPath($RuntimeRoot)
if (Test-Path -LiteralPath $runtimePath) { throw 'Refuse existing runtime directory; every run starts fresh.' }
if ($PgPort -eq $ApiPort -or $PgPort -lt 1024 -or $PgPort -gt 65535 -or $ApiPort -lt 1024 -or $ApiPort -gt 65535) { throw 'Invalid separate loopback ports' }
foreach ($testPort in @($PgPort,$ApiPort)) { if (Get-NetTCPConnection -LocalPort $testPort -State Listen -ErrorAction SilentlyContinue) { throw 'Port occupied' } }
foreach ($binary in @('initdb.exe','pg_ctl.exe','postgres.exe')) { if (!(Test-Path -LiteralPath (Join-Path $PostgresBin $binary))) { throw 'Existing PostgreSQL binaries required' } }
& (Join-Path $PostgresBin 'postgres.exe') --version
New-Item -ItemType Directory -Path (Join-Path $runtimePath 'private') -Force | Out-Null
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.WindowsIdentity]::GetCurrent().Name,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
Set-Acl -LiteralPath (Join-Path $runtimePath 'private') -AclObject $acl
function TestPassword { $bytes = New-Object byte[] 24; [Security.Cryptography.RandomNumberGenerator]::Fill($bytes); return [Convert]::ToHexString($bytes).ToLowerInvariant() }
$settings = @{ownerPassword=(TestPassword);runtimePassword=(TestPassword);owner='gy_i07_owner_20261011';runtime='gy_i07_runtime_20261011';database='gy_i07_test_consumer';pgPort=$PgPort;apiPort=$ApiPort}
$settings | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $runtimePath 'private/config.json')
$settings.ownerPassword | Set-Content -Encoding ASCII -LiteralPath (Join-Path $runtimePath 'private/owner-password')
$passwordPath = Join-Path $runtimePath 'private/owner-password'
& (Join-Path $PostgresBin 'initdb.exe') -D (Join-Path $runtimePath 'data') -U $settings.owner --pwfile=$passwordPath -A scram-sha-256 --encoding=UTF8 --locale=C
if ($LASTEXITCODE) { throw 'Fresh initdb failed' }
@"
listen_addresses = '127.0.0.1'
port = $PgPort
password_encryption = 'scram-sha-256'
logging_collector = off
log_statement = 'none'
log_min_error_statement = 'panic'
"@ | Add-Content -Encoding UTF8 -LiteralPath (Join-Path $runtimePath 'data/postgresql.conf')
& (Join-Path $PostgresBin 'pg_ctl.exe') -D (Join-Path $runtimePath 'data') -l (Join-Path $runtimePath 'postgres.log') -w start
if ($LASTEXITCODE) { throw 'Own PostgreSQL startup failed' }
Write-Output 'Fresh test-only cluster ready on loopback; credentials not printed.'
