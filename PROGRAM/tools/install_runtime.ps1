param(
  [ValidateSet("22.16.0")]
  [string]$Version = "22.16.0"
)

$ErrorActionPreference = "Stop"
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {}

$Root = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $Root "_runtime"
$NodeExe = Join-Path $RuntimeDir "node.exe"
$CheckScript = Join-Path $Root "tools\check_node.cjs"
$NativeArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$Architecture = switch -Regex ([string]$NativeArchitecture) {
  '^ARM64$' { 'arm64'; break }
  '^(AMD64|X64)$' { 'x64'; break }
  default { throw "Unsupported Windows architecture: $NativeArchitecture. Librarian System supports Windows x64 and ARM64." }
}
$RuntimeSha256 = @{
  x64 = "21c2d9735c80b8f86dab19305aa6a9f6f59bbc808f68de3eef09d5832e3bfbbd"
  arm64 = "31e885dcd06355f67b4be8cca86464270d83d0f5b8d4e3d4369c16ed22a5f4fa"
}
$ExpectedSha256 = $RuntimeSha256[$Architecture]
$ArchiveName = "node-v$Version-win-$Architecture.zip"
$DownloadUrl = "https://nodejs.org/dist/v$Version/$ArchiveName"
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("memory-suite-runtime-" + [Guid]::NewGuid().ToString("N"))
$ArchivePath = Join-Path $TempRoot $ArchiveName
$ExtractDir = Join-Path $TempRoot "extracted"
$StagedNode = Join-Path $RuntimeDir ("node.exe.new-" + [Guid]::NewGuid().ToString("N"))

function Test-Node22 {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [int]$Attempts = 5
  )

  for ($Attempt = 1; $Attempt -le $Attempts; $Attempt++) {
    try {
      $Ignored = & $Path --no-warnings $CheckScript 2>&1
      if ($LASTEXITCODE -eq 0) { return $true }
    } catch {}
    Start-Sleep -Milliseconds ([Math]::Min(1500, 250 * $Attempt))
  }
  return $false
}

New-Item -ItemType Directory -Path $TempRoot -Force | Out-Null
New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
try {
  Write-Host "Downloading official Node.js v$Version Windows $Architecture runtime..."
  Invoke-WebRequest -UseBasicParsing -Uri $DownloadUrl -OutFile $ArchivePath
  try { Unblock-File -LiteralPath $ArchivePath -ErrorAction SilentlyContinue } catch {}

  $ActualSha256 = (Get-FileHash -Algorithm SHA256 -Path $ArchivePath).Hash.ToLowerInvariant()
  if ($ActualSha256 -ne $ExpectedSha256) {
    throw "Runtime SHA256 mismatch. Expected $ExpectedSha256 but received $ActualSha256."
  }

  Expand-Archive -Path $ArchivePath -DestinationPath $ExtractDir -Force
  $DownloadedNode = Get-ChildItem -Path $ExtractDir -Filter node.exe -Recurse | Select-Object -First 1
  if (-not $DownloadedNode) { throw "node.exe was not found in the downloaded archive." }
  try { Unblock-File -LiteralPath $DownloadedNode.FullName -ErrorAction SilentlyContinue } catch {}
  if (-not (Test-Node22 -Path $DownloadedNode.FullName -Attempts 3)) {
    throw "The downloaded Node.js runtime could not be executed or is older than version 22."
  }

  Copy-Item -LiteralPath $DownloadedNode.FullName -Destination $StagedNode -Force
  try { Unblock-File -LiteralPath $StagedNode -ErrorAction SilentlyContinue } catch {}
  if (-not (Test-Node22 -Path $StagedNode -Attempts 5)) {
    throw "The staged Node.js runtime failed its execution check. Windows Security may be scanning or blocking it."
  }

  Move-Item -LiteralPath $StagedNode -Destination $NodeExe -Force
  try { Unblock-File -LiteralPath $NodeExe -ErrorAction SilentlyContinue } catch {}
  if (-not (Test-Node22 -Path $NodeExe -Attempts 5)) {
    throw "The installed Node.js runtime failed its final execution check."
  }

  @(
    "Node.js v$Version Windows $Architecture",
    "Source: $DownloadUrl",
    "SHA256: $ExpectedSha256",
    "InstalledAt: $([DateTime]::UtcNow.ToString('o'))"
  ) | Set-Content -LiteralPath (Join-Path $RuntimeDir "runtime-version.txt") -Encoding UTF8

  Write-Host "Installed and verified: $NodeExe"
}
catch {
  Write-Error ("Librarian System portable Node installation failed: " + $_.Exception.Message)
  exit 1
}
finally {
  Remove-Item -LiteralPath $StagedNode -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

exit 0
