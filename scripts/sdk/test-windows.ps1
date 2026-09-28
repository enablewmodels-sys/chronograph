$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-Location (Join-Path $PSScriptRoot '../..')
$Fixture = Join-Path $PWD '.work/windows-fixture'
$Token = Join-Path $Fixture 'admin.token'
$Config = Join-Path $Fixture 'fixture.json'
$LinuxRoot = (& wsl.exe -d Ubuntu-24.04 -- wslpath -a "$PWD").Trim()
$env:SDK_PYTHON = 'python'
$env:SDK_FIXTURE_CONFIG = $Config
$env:SDK_REPORT_NAME = 'windows-conformance'
$Process = Start-Process wsl.exe -ArgumentList @('-d','Ubuntu-24.04','--','bash',"$LinuxRoot/scripts/sdk/windows-fixture.sh","$LinuxRoot/.work/windows-fixture") -PassThru -RedirectStandardOutput "$Fixture/server.stdout" -RedirectStandardError "$Fixture/server.stderr"
try {
  $Ready = $false
  for ($Attempt = 0; $Attempt -lt 90; $Attempt++) {
    if ($Process.HasExited) { throw 'WSL test fixture exited; inspect its private local log.' }
    try {
      if ((Test-Path $Token) -and (Invoke-WebRequest 'http://127.0.0.1:18092/healthz' -TimeoutSec 2).StatusCode -eq 200) { $Ready=$true; break }
    } catch { }
    Start-Sleep -Seconds 1
  }
  if (-not $Ready) { throw 'WSL test fixture did not become ready.' }
  @{url='http://127.0.0.1:18092'; tokenFile=$Token; kind='community'} | ConvertTo-Json | Set-Content $Config
  node scripts/sdk/conformance.mjs
} finally {
  # This distribution belongs exclusively to this disposable Actions job.
  & wsl.exe --terminate Ubuntu-24.04
  if (-not $Process.HasExited) { $Process.WaitForExit(10000) | Out-Null }
  Remove-Item $Token,$Config -Force -ErrorAction SilentlyContinue
}
