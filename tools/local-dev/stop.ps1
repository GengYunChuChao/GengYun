$ErrorActionPreference='Stop'
$taskRoot=$PSScriptRoot
$taskSettings=Get-Content (Join-Path $taskRoot 'settings.json') -Raw | ConvertFrom-Json
$taskPrivate=Join-Path $taskRoot 'private'
if((Test-Path -LiteralPath $taskPrivate) -and ((Get-Item -LiteralPath $taskPrivate).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Private directory must not be a link'}
$taskPidFile=Join-Path $taskPrivate 'api.pid'
if(Test-Path -LiteralPath $taskPidFile){
 $taskPid=[int](Get-Content $taskPidFile)
 $taskInfo=Get-CimInstance Win32_Process -Filter "ProcessId=$taskPid"
 if($taskInfo){
  if(-not $taskInfo.CommandLine.Contains((Join-Path $taskRoot 'api.mjs'))){throw 'PID belongs to another process; refusing stop'}
  Stop-Process -Id $taskPid
 }
 Remove-Item -LiteralPath $taskPidFile
}
$taskData=Join-Path $taskPrivate 'pg-data'
if(Test-Path -LiteralPath (Join-Path $taskData 'PG_VERSION')){
 $taskResolved=(Resolve-Path -LiteralPath $taskData).Path
 if($taskResolved -ne (Join-Path $taskRoot 'private\pg-data')){throw 'Unexpected PG directory'}
 $taskBin=$taskSettings.postgresBin
 & "$taskBin\pg_ctl.exe" -D $taskData status *> $null
 if($LASTEXITCODE -eq 0){
  $taskProcess=Start-Process -FilePath "$taskBin\pg_ctl.exe" -ArgumentList ('-D "'+$taskData+'" -m fast -w stop') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskPrivate 'pg-stop.log') -RedirectStandardError (Join-Path $taskPrivate 'pg-stop-error.log')
  # PS5 redirected processes need an open handle before waiting to retain ExitCode.
 $null=$taskProcess.Handle
 $taskProcess.WaitForExit()
  if($taskProcess.ExitCode -ne 0){throw 'Local PG stop failed'}
 }
}
Write-Output 'Local API and owned PostgreSQL stopped; data retained.'
