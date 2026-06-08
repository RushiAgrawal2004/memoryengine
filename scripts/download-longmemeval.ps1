param(
  [string]$OutDir = "eval/datasets"
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$files = @(
  "longmemeval_s_cleaned.json",
  "longmemeval_oracle.json"
)

foreach ($file in $files) {
  $url = "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/$file"
  $target = Join-Path $OutDir $file
  Write-Host "Downloading $file -> $target"
  Invoke-WebRequest -Uri $url -OutFile $target
}

Write-Host "LongMemEval datasets downloaded to $OutDir"
