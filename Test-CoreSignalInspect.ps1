# Test-CoreSignalInspect.ps1
#
# One-shot script that searches for a known company by name on the
# multi-source company search endpoint and dumps the full first hit so
# we can see exactly which URL / ID / shorthand fields are present on
# the indexed record.
#
# This tells us:
#   - whether the search endpoint returns URL data at all (sometimes
#     search returns IDs only, requiring a follow-up /collect call)
#   - what the URL/ID fields are actually named in the schema
#   - whether the LinkedIn URL stored is the slug form, numeric form,
#     or both
#
# Usage:
#   $env:CORESIGNAL_API_KEY = '<key>'
#   .\Test-CoreSignalInspect.ps1 -CompanyName 'Gong'
#   .\Test-CoreSignalInspect.ps1 -CompanyName 'Gong.io Ltd.'
#
# Use the legal-name variant if the bare name is too ambiguous (we saw
# earlier that 'gong' as a slug returns a Croatian non-profit, so the
# search may return that too if we don't filter further).

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$CompanyName,

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

# Match on company_name with AND operator -- this is verbatim from
# CoreSignal's docs as the canonical example query.
$body = @{
    query = @{
        match = @{
            company_name = @{
                query    = $CompanyName
                operator = 'and'
            }
        }
    }
}
$bodyJson = $body | ConvertTo-Json -Depth 10 -Compress

Write-Host ""
Write-Host "Searching multi-source companies for: $CompanyName" -ForegroundColor Cyan
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
    $resp | ConvertTo-Json -Depth 8
    exit 1
}

# The search endpoint is documented to return either an array of company
# IDs (default) or an array of objects (with the right query option).
# Inspect what we actually got.

$count = 0
$firstHit = $null

if ($resp -is [Array]) {
    $count = $resp.Count
    $firstHit = $resp[0]
}
elseif ($resp.hits -and $resp.hits.hits) {
    $count = $resp.hits.hits.Count
    $firstHit = $resp.hits.hits[0]
}

Write-Host "Result count: $count" -ForegroundColor Cyan
Write-Host ""

if ($count -eq 0) {
    Write-Host "Zero hits. The match query may need adjusting, or '$CompanyName' isn't indexed." -ForegroundColor Yellow
    exit 0
}

Write-Host "First hit (raw):" -ForegroundColor Cyan
$firstHit | ConvertTo-Json -Depth 4
Write-Host ""

# Now figure out what we got. Search results often come back as just IDs.
if ($firstHit -is [int] -or $firstHit -is [long] -or ($firstHit -is [string] -and $firstHit -match '^\d+$')) {
    Write-Host "=== INTERPRETATION ===" -ForegroundColor White
    Write-Host "  Search returned ID(s) only, not full records." -ForegroundColor Cyan
    Write-Host "  CoreSignal's search by default returns numeric company IDs." -ForegroundColor Cyan
    Write-Host "  These IDs are CoreSignal's internal IDs (NOT LinkedIn IDs)." -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Now collect the full record for the first hit:" -ForegroundColor Cyan
    Write-Host "    .\Test-CoreSignal.ps1 -Identifier $firstHit -Mode collect" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  This pattern (search to get IDs -> collect to get data) is the" -ForegroundColor Green
    Write-Host "  intended flow. Two API calls but it works for cases where we" -ForegroundColor Green
    Write-Host "  can't /collect/{shorthand} directly." -ForegroundColor Green
}
else {
    Write-Host "=== INTERPRETATION ===" -ForegroundColor White
    Write-Host "  Search returned a full record object. Look at the fields above" -ForegroundColor Cyan
    Write-Host "  to see what URL / ID / shorthand fields are present and what" -ForegroundColor Cyan
    Write-Host "  values they hold for this company." -ForegroundColor Cyan
}

Write-Host ""
