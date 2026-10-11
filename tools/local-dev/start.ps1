$ErrorActionPreference='Stop'
$taskRoot=$PSScriptRoot
$taskSettings=Get-Content (Join-Path $taskRoot 'settings.json') -Raw | ConvertFrom-Json
$taskNode=$taskSettings.nodePath
$taskBin=$taskSettings.postgresBin
$taskPrivate=Join-Path $taskRoot 'private'
if((Test-Path -LiteralPath $taskPrivate) -and ((Get-Item -LiteralPath $taskPrivate).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Private directory must not be a link'}
New-Item -ItemType Directory -Path $taskPrivate -Force | Out-Null
$taskSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls $taskPrivate /inheritance:r /grant:r "*$($taskSid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Private directory ACL failed'}
$taskConfig=Join-Path $taskPrivate 'config.json'
if(-not(Test-Path -LiteralPath $taskConfig)){
 function New-LocalRandomPassword {
  $taskBytes=New-Object byte[] 24
  $taskGenerator=[Security.Cryptography.RandomNumberGenerator]::Create()
  try {$taskGenerator.GetBytes($taskBytes);return [BitConverter]::ToString($taskBytes).Replace('-','').ToLowerInvariant()}
  finally {$taskGenerator.Dispose()}
 }
 $taskValues=@{ownerPassword=New-LocalRandomPassword;runtimePassword=New-LocalRandomPassword}
 [IO.File]::WriteAllText($taskConfig,($taskValues|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
}
$taskValues=Get-Content -LiteralPath $taskConfig -Raw | ConvertFrom-Json
$taskData=Join-Path $taskPrivate 'pg-data'
if((Test-Path -LiteralPath $taskData) -and ((Get-Item -LiteralPath $taskData).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'PG directory must not be a link'}
if(-not(Test-Path -LiteralPath (Join-Path $taskData 'PG_VERSION'))){
 $taskPasswordFile=Join-Path $taskPrivate 'init-password.txt'
 try {
  [IO.File]::WriteAllText($taskPasswordFile,$taskValues.ownerPassword,[Text.UTF8Encoding]::new($false))
  & "$taskBin\initdb.exe" -D $taskData -U gengyun_local_owner -A scram-sha-256 --pwfile=$taskPasswordFile --encoding=UTF8 --locale=C > (Join-Path $taskPrivate 'init.log') 2>&1
  if($LASTEXITCODE -ne 0){throw 'Local initdb failed'}
 } finally {Remove-Item -LiteralPath $taskPasswordFile -ErrorAction SilentlyContinue}
}
& "$taskBin\pg_ctl.exe" -D $taskData status *> $null
$taskRunning=$LASTEXITCODE -eq 0
if(-not $taskRunning){
 if(Get-NetTCPConnection -State Listen -LocalPort $taskSettings.pgPort -ErrorAction SilentlyContinue){throw 'Port 55436 belongs to another service'}
 $taskArgs='-D "'+$taskData+'" -l "'+(Join-Path $taskPrivate 'pg.log')+'" -o "-h 127.0.0.1 -p '+$taskSettings.pgPort+'" -w start'
 $taskProcess=Start-Process -FilePath "$taskBin\pg_ctl.exe" -ArgumentList $taskArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskPrivate 'pg-start.log') -RedirectStandardError (Join-Path $taskPrivate 'pg-start-error.log')
 $taskProcess.WaitForExit()
 if($taskProcess.ExitCode -ne 0){throw 'Local PG startup failed'}
}
& $taskNode (Join-Path $taskRoot 'database.mjs')
if($LASTEXITCODE -ne 0){throw 'Database preparation failed'}
$taskApi=Join-Path $taskRoot 'api.mjs'
$taskPidFile=Join-Path $taskPrivate 'api.pid'
$taskExisting=$false
if(Test-Path -LiteralPath $taskPidFile){
 $taskPid=[int](Get-Content $taskPidFile)
 $taskInfo=Get-CimInstance Win32_Process -Filter "ProcessId=$taskPid"
 $taskExisting=$taskInfo -and $taskInfo.CommandLine.Contains($taskApi)
}
if(-not $taskExisting){
 if(Get-NetTCPConnection -State Listen -LocalPort $taskSettings.apiPort -ErrorAction SilentlyContinue){throw 'Port 3100 belongs to another service'}
 $taskProcess=Start-Process -FilePath $taskNode -ArgumentList ('"'+$taskApi+'"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskPrivate 'api.log') -RedirectStandardError (Join-Path $taskPrivate 'api-error.log')
 [IO.File]::WriteAllText($taskPidFile,[string]$taskProcess.Id)
}
$taskHealthy=$false
for($taskTry=0;$taskTry -lt 30;$taskTry++){
 try {$taskResponse=Invoke-RestMethod ('http://127.0.0.1:'+$taskSettings.apiPort+'/health');if($taskResponse.status -eq 'ok' -and $taskResponse.checks.database.status -eq 'ok'){$taskHealthy=$true;break}} catch {}
 Start-Sleep -Milliseconds 200
}
if(-not $taskHealthy){throw 'Local health check failed; inspect private logs locally'}
Write-Output ('READY: API http://127.0.0.1:'+$taskSettings.apiPort+'; PG 127.0.0.1:'+$taskSettings.pgPort+'; synthetic WeChat identity.')
Write-Output ('WeChat import directory: '+(Join-Path $taskRoot 'wechat'))
