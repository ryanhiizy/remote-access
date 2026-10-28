#Requires -RunAsAdministrator
<#
  Windows host layer for remote-access: keeps WSL running and adds Windows OpenSSH
  on port 2222 as an out-of-band way in when WSL is down. Safe to rerun.
  Run in Administrator PowerShell as the user who owns the WSL distro:
    .\setup.ps1 -MacPublicKey 'ssh-ed25519 AAAA... you@mac'
  -LockAtLogon locks the screen after an automatic sign-in (Sysinternals Autologon).
#>
param(
  [Parameter(Mandatory)][string]$MacPublicKey,
  [ValidatePattern('^[\w.-]+$')][string]$Distro = 'Ubuntu',
  [switch]$LockAtLogon
)
$ErrorActionPreference = 'Stop'
$key = $MacPublicKey.Trim()
if ($key -notmatch '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+( [^\r\n]*)?$') {
  throw 'MacPublicKey must be a single OpenSSH public key line (for example ~/.ssh/id_ed25519.pub on the Mac).'
}
$port = 2222  # Never 22: under mirrored networking WSL's sshd owns that port.

# WSL stops idle distros, taking WSL's sshd with them. A hidden console holding a
# process open keeps the distro up. RestartCount only covers launch failures, so a
# 5-minute repeat (ignored while running) restarts it after something kills WSL,
# such as Restart Manager during an Office update.
# $env:USERDOMAIN reads WORKGROUP over SSH, which does not resolve to the account.
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless wsl.exe -d $Distro --exec /bin/sleep infinity"
$trigger = @(
  New-ScheduledTaskTrigger -AtLogOn -User $user
  New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
Register-ScheduledTask -TaskName 'WSL keep-alive' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

# With Autologon, update restarts and crash reboots sign in unattended so keep-alive runs.
# Lock right after, but only while AutoAdminLogon is on, so manual sign-ins stay unlocked.
if ($LockAtLogon) {
  $lock = "if ((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon').AutoAdminLogon -eq '1') { rundll32.exe user32.dll,LockWorkStation }"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($lock))
  $lockAction = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless powershell.exe -NoProfile -NonInteractive -EncodedCommand $encoded"
  $lockSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
  Register-ScheduledTask -TaskName 'Lock after auto sign-in' -Action $lockAction -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $user) `
    -Principal $principal -Settings $lockSettings -Force | Out-Null
}

# OpenSSH Server.
$capability = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
if ($capability.State -ne 'Installed') { Add-WindowsCapability -Online -Name $capability.Name | Out-Null }
$ssh = "$env:ProgramData\ssh"
$config = "$ssh\sshd_config"
New-Item -ItemType Directory -Force $ssh | Out-Null
# sshd copies its default config on first start, which would listen on 22; copy it ourselves.
if (-not (Test-Path $config)) { Copy-Item "$env:WINDIR\System32\OpenSSH\sshd_config_default" $config }
$lines = Get-Content $config | Where-Object { $_ -notmatch '^\s*#?\s*(Port|PasswordAuthentication)\s' }
Set-Content $config -Value (@("Port $port", 'PasswordAuthentication no') + $lines) -Encoding ascii

function Add-Key($file) {
  $existing = @(if (Test-Path $file) { Get-Content $file })
  if ($existing -notcontains $key) { Set-Content $file -Value ($existing + $key) -Encoding ascii }
}
# Administrators use this file; sshd ignores it unless only Administrators and SYSTEM can access it.
$adminKeys = "$ssh\administrators_authorized_keys"
Add-Key $adminKeys
icacls $adminKeys /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null
if ($LASTEXITCODE) { throw "icacls failed on $adminKeys" }
New-Item -ItemType Directory -Force "$env:USERPROFILE\.ssh" | Out-Null
Add-Key "$env:USERPROFILE\.ssh\authorized_keys"

if (-not (Test-Path 'HKLM:\SOFTWARE\OpenSSH')) { New-Item 'HKLM:\SOFTWARE\OpenSSH' | Out-Null }
New-ItemProperty 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -PropertyType String -Force `
  -Value "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" | Out-Null

# Tailscale addresses only.
Remove-NetFirewallRule -Name 'remote-access-sshd' -ErrorAction SilentlyContinue
New-NetFirewallRule -Name 'remote-access-sshd' -DisplayName "OpenSSH Server $port (Tailscale)" -Direction Inbound `
  -Protocol TCP -LocalPort $port -RemoteAddress '100.64.0.0/10' -Action Allow -Profile Any | Out-Null

& "$env:WINDIR\System32\OpenSSH\sshd.exe" -t
if ($LASTEXITCODE) { throw "sshd rejected $config" }
Set-Service sshd -StartupType Automatic
Restart-Service sshd
Start-Sleep -Seconds 1
$ids = @((Get-Process sshd).Id)
$ports = @(Get-NetTCPConnection -State Listen | Where-Object { $ids -contains $_.OwningProcess } | ForEach-Object LocalPort | Sort-Object -Unique)
if ($ports -contains 22) { Stop-Service sshd; throw 'Windows sshd listened on 22, which WSL needs; stopped it. Check sshd_config.' }
if ($ports -notcontains $port) { throw "Windows sshd is not listening on $port." }

$wslconfig = "$env:USERPROFILE\.wslconfig"
$text = if (Test-Path $wslconfig) { Get-Content $wslconfig -Raw } else { '' }
foreach ($setting in 'networkingMode=mirrored', 'swap=0') {
  $pattern = '(?mi)^\s*' + [regex]::Escape($setting).Replace('=', '\s*=\s*') + '\s*$'
  if ($text -notmatch $pattern) { Write-Warning "$wslconfig lacks $setting under [wsl2]; add it, then run wsl --shutdown." }
}
"WSL keep-alive task: $Distro. Windows sshd: port $port, keys only, Tailscale only."
if ($LockAtLogon) { "Lock after auto sign-in task: registered." }
