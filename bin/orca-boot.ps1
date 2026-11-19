#Requires -Version 7.0
param(
  [switch]$Open,
  [switch]$Automation,
  [string]$Model = 'deepseek-v4.1-flash'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$orca = 'orca'

function Get-Status {
  try { return (& $orca status --json 2>$null | ConvertFrom-Json) } catch { return $null }
}

Write-Host "OrcaBot 仓库: $root" -ForegroundColor Cyan

$status = Get-Status
if (-not $status -or -not $status.result.app.running) {
  if ($Open) {
    Write-Host 'Orca 未运行，正在启动…' -ForegroundColor Yellow
    & $orca open
    $deadline = (Get-Date).AddSeconds(60)
    do {
      Start-Sleep -Seconds 3
      $status = Get-Status
    } until (($status -and $status.result.runtime.reachable) -or (Get-Date) -gt $deadline)
  }
  if (-not $status -or -not $status.result.app.running) {
    Write-Host 'Orca 仍未运行。请先打开 Orca，或加 -Open 重试。' -ForegroundColor Red
    exit 1
  }
}

if (-not $status.result.runtime.reachable) {
  Write-Host 'Orca 运行时未就绪，请稍后重试。' -ForegroundColor Red
  exit 1
}

Write-Host '注册仓库到 Orca…' -ForegroundColor Cyan
& $orca repo add --path $root

$selector = "path:$($root -replace '\\', '/')"

Write-Host '启动 OrcaBot 终端…' -ForegroundColor Cyan
& $orca terminal create --worktree $selector --title 'OrcaBot' --command 'codebuddy --agent orca-bot'

if ($Automation) {
  Write-Host '创建 OrcaBot Tick 自动化（每小时，默认禁用）…' -ForegroundColor Cyan
  $prompt = '读取 CODEBUDDY.md 与 .codebuddy/agents/orca-bot.md，运行 node bin/orca-bot.mjs tick，审核结果并按任务简报格式汇报。没有待办任务时直接说明。'
  & $orca automations create --name 'OrcaBot Tick' --trigger hourly --prompt $prompt --provider codebuddy --workspace $selector --timezone 'Asia/Shanghai' --extra-agent-args="--model $Model" --disabled
}

Write-Host '完成。在 Orca 的 OrcaBot 终端里直接对话即可。' -ForegroundColor Green
