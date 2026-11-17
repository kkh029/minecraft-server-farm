<#
  마인크래프트 서버 팜 - Windows 방화벽 규칙 등록 (한 번만 실행하면 됩니다)

  포털은 Bedrock 서버를 항상 data\slots\1 ~ 32 폴더에서 실행하고, Java 서버는 data\java\runtime 아래의
  java.exe로 실행합니다. 이 스크립트는 그 실행 파일들과 웹 포털(node.exe, TCP 8080)에 대해 미리 "허용" 규칙을
  만들어, 서버를 켤 때마다 Windows가 "액세스를 허용하시겠습니까?" 창을 띄우지 않게 합니다.

  - 관리자 권한이 필요합니다. 일반 권한으로 실행하면 권한 확인 창(UAC)을 띄웁니다.
  - 이 프로젝트의 data 폴더 아래 실행 파일에 대해 예전에 생긴 규칙(확인 창에서 만들어진 것)은 지우고 새로 만듭니다.
    확인 창에서 "취소"를 누르면 차단 규칙이 생기는데, 차단 규칙은 허용 규칙보다 우선하기 때문입니다.
  - 기본은 개인/도메인 네트워크에서만 허용합니다. 공용 네트워크도 허용하려면 -IncludePublic
  - 규칙을 지우려면 -Remove
  - 프로젝트 폴더를 옮겼다면 다시 실행하세요 (규칙은 실행 파일의 전체 경로로 동작합니다).
#>
param(
  [string]$DataDir = $(if ($env:MCF_DATA_DIR) { $env:MCF_DATA_DIR } else { Join-Path $PSScriptRoot 'data' }),
  [int]$Slots = 32,
  [int]$PortalPort = 8080,
  [string]$GamePorts = '19132-19259',
  [switch]$IncludePublic,
  [switch]$Remove,
  [switch]$PauseAtEnd
)

$ErrorActionPreference = 'Stop'
$Group = 'Minecraft Server Farm'
$DataDir = [IO.Path]::GetFullPath($DataDir)

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host '방화벽 규칙을 만들려면 관리자 권한이 필요합니다. 권한 확인 창에서 [예]를 눌러 주세요.'
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
    '-DataDir', "`"$DataDir`"", '-Slots', $Slots, '-PortalPort', $PortalPort, '-GamePorts', $GamePorts, '-PauseAtEnd')
  if ($IncludePublic) { $argList += '-IncludePublic' }
  if ($Remove) { $argList += '-Remove' }
  try {
    Start-Process powershell.exe -Verb RunAs -ArgumentList $argList -Wait
  } catch {
    Write-Host '관리자 권한을 받지 못해 아무것도 바꾸지 않았습니다.' -ForegroundColor Yellow
  }
  exit
}

function Finish([int]$code) {
  if ($PauseAtEnd) { Read-Host '엔터를 누르면 창이 닫힙니다' | Out-Null }
  exit $code
}

try {
  $prefix = $DataDir.TrimEnd('\') + '\'

  $old = @(Get-NetFirewallRule -Group $Group -ErrorAction SilentlyContinue)
  if ($old.Count) { $old | Remove-NetFirewallRule }

  # Rules Windows created from earlier "allow access?" prompts for programs inside this data folder
  # (old per-server folders, slot folders). They are replaced by the rules below.
  $prompted = @(Get-NetFirewallApplicationFilter |
    Where-Object { $_.Program -and $_.Program.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) } |
    Get-NetFirewallRule)
  if ($prompted.Count) { $prompted | Remove-NetFirewallRule }

  if ($Remove) {
    Write-Host "규칙 $($old.Count + $prompted.Count)개를 지웠습니다." -ForegroundColor Green
    Finish 0
  }

  $profiles = if ($IncludePublic) { 'Any' } else { @('Private', 'Domain') }

  for ($n = 1; $n -le $Slots; $n++) {
    $exe = Join-Path $DataDir "slots\$n\bedrock_server.exe"
    New-NetFirewallRule -DisplayName "Minecraft Server Farm - 슬롯 $n" -Group $Group -Direction Inbound `
      -Action Allow -Program $exe -Profile $profiles `
      -Description '마인크래프트 서버 팜 포털이 이 슬롯에서 실행하는 Bedrock 서버' | Out-Null
  }

  # Java Edition servers run as java.exe of the Java runtime the portal downloads from Mojang for each game version
  # (data\java\runtime\<name>). Rules for the runtimes Minecraft 1.18.2 ~ 26.x use are made in advance (a rule may
  # name a file that doesn't exist yet); if Mojang adds a new one later, the portal says so — run this script again.
  $runtimeDir = Join-Path $DataDir 'java\runtime'
  $javaRuntimes = @('java-runtime-beta', 'java-runtime-gamma', 'java-runtime-delta', 'java-runtime-epsilon')
  if (Test-Path $runtimeDir) {
    $javaRuntimes += @(Get-ChildItem $runtimeDir -Directory | Where-Object { $_.Name -notlike '*.tmp' } | ForEach-Object { $_.Name })
  }
  $javaRuntimes = @($javaRuntimes | Sort-Object -Unique)
  foreach ($name in $javaRuntimes) {
    $exe = Join-Path $runtimeDir "$name\bin\java.exe"
    New-NetFirewallRule -DisplayName "Minecraft Server Farm - Java ($name)" -Group $Group -Direction Inbound `
      -Action Allow -Program $exe -Profile $profiles `
      -Description '마인크래프트 서버 팜 포털이 실행하는 Java Edition 서버' | Out-Null
  }

  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if ($node) {
    New-NetFirewallRule -DisplayName 'Minecraft Server Farm - 웹 포털' -Group $Group -Direction Inbound `
      -Action Allow -Program $node -Protocol TCP -LocalPort $PortalPort -Profile $profiles `
      -Description '마인크래프트 서버 팜 웹 포털' | Out-Null
    # Bedrock (NetherNet) players reach the portal first on each server's TCP port; it passes the join on to BDS.
    New-NetFirewallRule -DisplayName 'Minecraft Server Farm - Bedrock 접속 중계' -Group $Group -Direction Inbound `
      -Action Allow -Program $node -Protocol TCP -LocalPort $GamePorts -Profile $profiles `
      -Description '마인크래프트 서버 팜 포털이 Bedrock 서버 접속(TCP)을 받아 서버로 넘김' | Out-Null
  }

  Write-Host ''
  Write-Host '완료했습니다.' -ForegroundColor Green
  Write-Host "  서버 슬롯 1~$Slots 허용 규칙: $DataDir\slots\<번호>\bedrock_server.exe"
  Write-Host "  Java 서버 허용 규칙 $($javaRuntimes.Count)개: $runtimeDir\<이름>\bin\java.exe"
  if ($node) { Write-Host "  웹 포털 허용 규칙: $node (TCP $PortalPort, Bedrock 접속 TCP $GamePorts)" }
  else { Write-Host '  node.exe를 찾지 못해 웹 포털 규칙은 만들지 않았습니다.' -ForegroundColor Yellow }
  Write-Host "  지운 예전 규칙: $($old.Count + $prompted.Count)개"
  Write-Host "  적용 네트워크: $(if ($IncludePublic) { '모든 네트워크' } else { '개인, 도메인' })"
  Write-Host ''
  Write-Host '이제 포털의 방화벽 안내에서 [다시 확인]을 누르세요.'
  Finish 0
} catch {
  Write-Host "실패했습니다: $($_.Exception.Message)" -ForegroundColor Red
  Finish 1
}
