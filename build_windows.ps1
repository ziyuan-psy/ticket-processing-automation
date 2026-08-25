$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if (-not (Test-Path -LiteralPath $python)) {
    $python = "python"
}

if (Test-Path -LiteralPath $bundledNode) {
    $node = $bundledNode
} else {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
}

& $python -c "import PyInstaller" 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller is not installed. Install it with: $python -m pip install pyinstaller"
}

$dist = Join-Path $repo "dist"
$build = Join-Path $repo "build"
$name = "TicketProcessingAutomation"

Remove-Item -LiteralPath (Join-Path $dist $name) -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $build $name) -Recurse -Force -ErrorAction SilentlyContinue

& $python -m PyInstaller `
    --noconfirm `
    --onedir `
    --windowed `
    --name $name `
    --add-data "scripts;scripts" `
    --add-data "README.md;." `
    --add-data "docs;docs" `
    (Join-Path $repo "app_ui.py")

$appDir = Join-Path $dist $name
$runtimeDir = Join-Path $appDir "runtime"
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
Copy-Item -LiteralPath $node -Destination (Join-Path $runtimeDir "node.exe") -Force

$launcher = Join-Path $appDir "launch.bat"
Set-Content -LiteralPath $launcher -Encoding ASCII -Value "@echo off`r`nstart """" ""%~dp0$name.exe""`r`n"

$zipPath = Join-Path $dist "$name.zip"
Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
& tar -a -cf $zipPath -C $appDir .

Write-Host "Built: $appDir"
Write-Host "Zip:   $zipPath"
