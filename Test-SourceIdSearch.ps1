# Test-SourceIdSearch.ps1
#
# Confirms that CoreSignal's multi-source search index supports
# searching by source_id (which we just discovered holds the LinkedIn
# numeric company ID). One probe, one search credit.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$LinkedInId,

    [string]$ApiKey = $env:CORESIGNAL_API_KEY
)

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    Write-Host "ERROR: No CoreSignal API key. Set `$env:CORESIGNAL_API_KEY first." -ForegroundColor Red
    exit 1
}

$searchUrl = 'https://api.coresignal.com/cdapi/v2/company_multi_source/search/es_dsl'
$headers = @{
    'apikey'       = $ApiKey
    'accept'       = 'application/json'
    'Content-Type' = 'application/json'
}

# source_id is stored as a string in the index, even when it looks numeric.
# Use term match (exact, no analysis).
$body = @{
    query = @{
        term = @{
            source_id = $LinkedInId
        }
    }
}
$bodyJson = $body | ConvertTo-Json -Depth 10 -Compress

Write-Host ""
Write-Host "Searching multi-source by source_id = '$LinkedInId'" -ForegroundColor Cyan
Write-Host "Body: $bodyJson" -ForegroundColor DarkGray
Write-Host ""

$resp = $null
$httpCode = $null
try {
    $resp = Invoke-RestMethod -Method Post -Uri $searchUrl -Headers $headers -Body $bodyJson -ErrorAction Stop
    $httpCode = 200
}
catch {
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        try   { $resp = $_.ErrorDetails.Message | ConvertFrom-Json }
        catch { $resp = [PSCustomObject]@{ raw_text = $_.ErrorDetails.Message } }
    }
    if ($_.Exception.Response) { $httpCode = [int]$_.Exception.Response.StatusCode }
}

$color = if ($httpCode -eq 200) { 'Green' } else { 'Red' }
Write-Host "HTTP $httpCode" -ForegroundColor $color
Write-Host ""

if ($httpCode -ne 200) {
    Write-Host "Response:" -ForegroundColor Yellow
    $resp | ConvertTo-Json -Depth 6
    exit 1
}

$count = if ($resp -is [Array]) { $resp.Count } else { 0 }
Write-Host "Hit count: $count" -ForegroundColor Cyan

if ($count -gt 0) {
    Write-Host "Hits: $($resp -join ', ')" -ForegroundColor Green
    Write-Host ""
    Write-Host "SUCCESS -- source_id is searchable. We can wire this in." -ForegroundColor Green
    Write-Host "Now collect the first hit to confirm it is the right company:" -ForegroundColor Cyan
    Write-Host "  .\Test-CoreSignal.ps1 -Identifier $($resp[0]) -Mode collect" -ForegroundColor DarkGray
}
else {
    Write-Host "Zero hits. source_id either is not the right field name OR the" -ForegroundColor Yellow
    Write-Host "value '$LinkedInId' is not stored as a string. Try term query" -ForegroundColor Yellow
    Write-Host "with source_id.exact instead." -ForegroundColor Yellow
}
Write-Host ""
