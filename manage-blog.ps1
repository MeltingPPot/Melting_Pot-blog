$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $repoRoot

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    throw "未找到 Python。请安装 Python 3.10 或更高版本。"
}

& $python.Source "tools/blog-admin/server.py"
