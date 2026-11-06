# Install the spacehub client on Windows, the Windows twin of install-cli.sh:
# puts `spacehub` and `git-remote-quirq` (plus git-remote-spacehub, for older
# clones) on your PATH. Needs Node 22+ and git. Run it from PowerShell:
#   irm https://raw.githubusercontent.com/quirq-ai/space-hub/main/scripts/install-cli.ps1 | iex
#   scripts\install-cli.ps1                    (from a checkout; npm's global prefix)
#   scripts\install-cli.ps1 -Prefix C:\tools\spacehub
# Run it again any time to update; the saved login stays.
param([string]$Prefix)

$ErrorActionPreference = 'Stop'

# throw, not exit: piped into iex, exit would close the person's PowerShell window.
function Fail($message) {
  throw "install-cli: $message"
}

# Run a program and stop if it fails (a native command's exit code does not
# stop the script on its own).
function Invoke-Checked($exe, [string[]]$arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { Fail "$exe $($arguments -join ' ') failed (exit $LASTEXITCODE)" }
}

# npm.cmd, not npm: under the default execution policy PowerShell refuses npm.ps1.
foreach ($tool in 'node', 'npm.cmd', 'git') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Fail "$tool is not installed (needs Node 22 or newer, and git)" }
}
# Parsed here, not with node -p: Windows PowerShell 5.1 drops inner quotes from native arguments.
$nodeMajor = [int](((& node --version) | Out-String).Trim().TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { Fail "needs Node 22 or newer (this is Node $nodeMajor)" }

# From a checkout, install that checkout; piped into iex, fetch the latest source.
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("spacehub-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot '..\cli\package.json'))) {
    $root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
  } else {
    $root = Join-Path $tmp 'space-hub'
    Invoke-Checked 'git' @('clone', '-q', '--depth', '1', 'https://github.com/quirq-ai/space-hub', $root)
  }

  Push-Location (Join-Path $root 'cli')
  try {
    Invoke-Checked 'npm.cmd' @('install', '--no-audit', '--no-fund', '--silent')
    Invoke-Checked 'npm.cmd' @('run', 'build', '--silent')
    $tarball = ((& npm.cmd pack --silent --pack-destination $tmp) | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $tarball) { Fail 'npm pack failed' }
    $global = @('install', '--global', '--no-audit', '--no-fund')
    if ($Prefix) { $global += @('--prefix', $Prefix) }
    Invoke-Checked 'npm.cmd' ($global + (Join-Path $tmp $tarball))
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# Where npm put spacehub: on Windows, straight into the prefix (no bin folder).
if ($Prefix) { $bin = $Prefix } else { $bin = ((& npm.cmd prefix --global) | Out-String).Trim() }
# npm masks path parts that look like secrets (a GUID prints as ***), which
# GetFullPath rejects; then keep what npm printed.
try { $bin = [IO.Path]::GetFullPath($bin).TrimEnd('\') } catch { }

Write-Host ''
$found = Get-Command spacehub -CommandType ExternalScript, Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($found -and ((Split-Path $found.Source -Parent).TrimEnd('\') -ieq $bin)) {
  Write-Host "Installed: $($found.Source)"
} else {
  if ($found) {
    Write-Host "Installed spacehub in $bin, but PowerShell finds $($found.Source) first."
  } else {
    Write-Host "Installed spacehub in $bin, which is not on your PATH yet."
  }
  Write-Host 'Put it on PATH for new windows and this one:'
  Write-Host "  [Environment]::SetEnvironmentVariable('Path', '$bin;' + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')"
  Write-Host "  `$env:Path = '$bin;' + `$env:Path"
}

# The `spacehub` command is spacehub.ps1 in PowerShell, which a Restricted
# execution policy refuses (spacehub.cmd works either way).
$policy = Get-ExecutionPolicy
if ($policy -eq 'Restricted' -or $policy -eq 'AllSigned') {
  Write-Host ''
  Write-Host "Note: PowerShell's execution policy is $policy, so it won't run spacehub.ps1. Either allow"
  Write-Host 'local scripts for your account, or type spacehub.cmd instead of spacehub:'
  Write-Host '  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned'
}
Write-Host ''
Write-Host 'Next: spacehub auth login --builder <name>   (server: wss://hub.quirq.dev; another with --server <url>)'
Write-Host 'Check the setup any time: spacehub doctor'
