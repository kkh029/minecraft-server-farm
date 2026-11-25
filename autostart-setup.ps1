# 로그인(부팅) 시 포털 자동 실행 작업 등록/해제.  등록: .\autostart-setup.ps1   해제: .\autostart-setup.ps1 -Remove
param([switch]$Remove)
$name = 'MinecraftServerFarm'
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; Write-Host "해제됨"; exit }
$root = $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$cmd  = "Set-Location -LiteralPath '$root'; & '$node' server\index.js *>> '$root\data\portal.log'"
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$cmd`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "등록됨: $name (부팅 30초 후 숨김 창으로 실행, 로그: data\portal.log)"
