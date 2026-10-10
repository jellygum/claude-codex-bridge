# Invoke from a connected local computer. No shell-generated model prompt arguments.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$BridgeArgs)
$ErrorActionPreference = 'Stop'
$bridgeNode = $env:CCB_NODE_EXE
if (-not $bridgeNode) {
    $bridgeCandidate = Get-Command node -ErrorAction SilentlyContinue
    if ($bridgeCandidate) {
        $bridgeMajor = & $bridgeCandidate.Source -p 'process.versions.node.split(".")[0]'
        if ([int]$bridgeMajor -ge 18) { $bridgeNode = $bridgeCandidate.Source }
    }
}
if (-not $bridgeNode) {
    $bridgeCandidate = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $bridgeCandidate) { $bridgeNode = $bridgeCandidate }
}
if (-not $bridgeNode) { throw 'Install Node >=18 or set CCB_NODE_EXE to its executable path.' }
& $bridgeNode (Join-Path $PSScriptRoot '..\dist\cli.mjs') @BridgeArgs
exit $LASTEXITCODE
