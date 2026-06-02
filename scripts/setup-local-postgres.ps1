$ErrorActionPreference = "Stop"

$psql = $env:PSQL_PATH
if (-not $psql) {
  $psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
}

if (-not (Test-Path -LiteralPath $psql)) {
  throw "Could not find psql.exe. Set PSQL_PATH to your local psql.exe path."
}

$superUser = if ($env:POSTGRES_SUPERUSER) { $env:POSTGRES_SUPERUSER } else { "postgres" }
$superPassword = if ($env:POSTGRES_SUPERPASS) { $env:POSTGRES_SUPERPASS } else { "postgres" }
$appUser = if ($env:MEMORY_ENGINE_DB_USER) { $env:MEMORY_ENGINE_DB_USER } else { "memory_engine" }
$appPassword = if ($env:MEMORY_ENGINE_DB_PASSWORD) { $env:MEMORY_ENGINE_DB_PASSWORD } else { "memory_engine" }
$appDb = if ($env:MEMORY_ENGINE_DB_NAME) { $env:MEMORY_ENGINE_DB_NAME } else { "memory_engine" }

$env:PGPASSWORD = $superPassword

& $psql -h localhost -U $superUser -d postgres -v ON_ERROR_STOP=1 -c @"
DO `$`$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$appUser') THEN
    CREATE ROLE $appUser LOGIN PASSWORD '$appPassword';
  END IF;
END
`$`$;
"@

$dbExists = & $psql -h localhost -U $superUser -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$appDb';"
if ($LASTEXITCODE -ne 0) {
  throw "Could not check whether database '$appDb' exists."
}

if ([string]::IsNullOrWhiteSpace($dbExists)) {
  & $psql -h localhost -U $superUser -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $appDb OWNER $appUser;"
}

Write-Host "Local Postgres ready: postgres://${appUser}:${appPassword}@localhost:5432/${appDb}"
