# Test-CoreSignal.ps1
#
# Tests CoreSignal's multi-source company enrichment endpoint directly
# (bypassing the GoWarm backend) to figure out which identifier formats
# work and which return 404.
#
# Usage:
#   $env:CORESIGNAL_API_KEY = '<your key>'
#   .\Test-CoreSignal.ps1 -Identifier 'gong-io'
#   .\Test-CoreSignal.ps1 -Identifier '10454372'
#   .\Test-CoreSignal.ps1 -Identifier 'gong.io' -Mode website
#
# -Mode auto (default) routes:
#   - all-numeric          -> /collect/{id}
#   - looks like a domain  -> /enrich?website={domain}    (has a dot AND a TLD)
#   - everything else      -> /collect/{shorthand}
#
# Pass -Mode collect or -Mode website to force one or the other when
# auto-detection guesses wrong (e.g. a domain-shaped shorthand).
#
# Always shows: HTTP status, full URL hit, the first ~80 lines of
# response, and a one-line interpretation.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Identifier,

    [string]$ApiKey = $env:CORESIGNAL_API_KEY,

    [ValidateSet('auto','collect','website')]
    [string]$Mode = 'auto',

    [switch]$Raw
)

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    Write-Host "ERROR: No CoreSignal API key provided." -ForegroundColor Red
    Write-Host ""
    Write-Host "Set it once in this shell:" -ForegroundColor Yellow
    Write-Host "  `$env:CORESIGNAL_API_KEY = '<your key>'" -ForegroundColor Yellow
    Write-Host "Or pass inline:" -ForegroundColor Yellow
    Write-Host "  .\Test-CoreSignal.ps1 -Identifier '$Identifier' -ApiKey '<key>'" -ForegroundColor Yellow
    exit 1
}

# Pick endpoint
$base = 'https://api.coresignal.com/cdapi/v2/company_multi_source'

$resolvedMode = $Mode
if ($Mode -eq 'auto') {
    if ($Identifier -match '^\d+$') {
        $resolvedMode = 'collect'
    }
    elseif ($Identifier -match '^[A-Za-z0-9-]+\.[A-Za-z]{2,}(\.[A-Za-z]{2,})?$') {
        # Looks like a domain (has a TLD), e.g. gong.io, sa.global, example.co.uk
        $resolvedMode = 'website'
    }
    else {
        $resolvedMode = 'collect'
    }
}

if ($resolvedMode -eq 'website') {
    $url = "$base/enrich?website=$([uri]::EscapeDataString($Identifier))"
}
else {
    $url = "$base/collect/$([uri]::EscapeDataString($Identifier))"
}

Write-Host ""
Write-Host "Identifier: $Identifier" -ForegroundColor Cyan
Write-Host "Mode:       $resolvedMode (auto-detected)" -ForegroundColor Cyan
Write-Host "URL:        $url" -ForegroundColor Cyan
Write-Host ""

$headers = @{
    'apikey' = $ApiKey
    'accept' = 'application/json'
}

$response  = $null
$httpStatus = $null

try {
    $response  = Invoke-RestMethod -Method Get -Uri $url -Headers $headers -ErrorAction Stop
    $httpStatus = 200
}
catch {
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        try {
            $response = $_.ErrorDetails.Message | ConvertFrom-Json
        } catch {
            $response = [PSCustomObject]@{ raw_text = $_.ErrorDetails.Message }
        }
    }
    if ($_.Exception.Response) {
        $httpStatus = [int]$_.Exception.Response.StatusCode
    } else {
        Write-Host "Network error:" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
        exit 1
    }
}

$statusColor = if ($httpStatus -eq 200) { 'Green' } else { 'Yellow' }
Write-Host "HTTP $httpStatus" -ForegroundColor $statusColor
Write-Host ""

if ($null -ne $response) {
    if ($Raw) {
        Write-Host "Full response:" -ForegroundColor Cyan
        $response | ConvertTo-Json -Depth 12
    }
    else {
        Write-Host "Response (key fields only):" -ForegroundColor Cyan
        $compact = [PSCustomObject]@{
            company_name      = $response.company_name
            company_legal_name = $response.company_legal_name
            websites_main     = $response.websites_main
            industry          = $response.industry
            size_range        = $response.size_range
            employees_count   = $response.employees_count
            hq_country        = $response.hq_country
            hq_city           = $response.hq_city
            founded_year      = $response.founded_year
            linkedin_url      = $response.linkedin_url
            company_id        = $response.company_id
            shorthand_name    = $response.shorthand_name
            description       = if ($response.description_enriched) { $response.description_enriched.Substring(0, [Math]::Min(120, $response.description_enriched.Length)) + '...' } else { $null }
        }
        $compact | Format-List
        Write-Host "(re-run with -Raw to see the full ~300-field response)" -ForegroundColor DarkGray
    }
    Write-Host ""
}

Write-Host "=== INTERPRETATION ===" -ForegroundColor White
switch ($httpStatus) {
    200 {
        Write-Host "  SUCCESS -- the identifier '$Identifier' resolved." -ForegroundColor Green
        Write-Host "  Use this same form in accounts.linkedin_company_url and the" -ForegroundColor Green
        Write-Host "  backend's enrich-from-coresignal call will work." -ForegroundColor Green
    }
    404 {
        Write-Host "  NOT FOUND -- CoreSignal has no record matching '$Identifier'." -ForegroundColor Yellow
        if ($resolvedMode -eq 'collect' -and $Identifier -match '^\d+$') {
            Write-Host ""
            Write-Host "  This was a numeric LinkedIn company ID. Two possibilities:" -ForegroundColor Yellow
            Write-Host "    (a) CoreSignal's /collect doesn't accept numeric IDs in this slot." -ForegroundColor Yellow
            Write-Host "        Try the slug form (visit linkedin.com/company/$Identifier" -ForegroundColor Yellow
            Write-Host "        in your browser, copy the slug from the redirected URL)." -ForegroundColor Yellow
            Write-Host "    (b) CoreSignal genuinely has no record for this company." -ForegroundColor Yellow
        }
        elseif ($resolvedMode -eq 'collect') {
            Write-Host ""
            Write-Host "  Try the same identifier as -Mode website if it looks domain-y," -ForegroundColor Yellow
            Write-Host "  or double-check the slug spelling against linkedin.com." -ForegroundColor Yellow
        }
        else {
            Write-Host "  Try -Mode collect with the LinkedIn slug for this company," -ForegroundColor Yellow
            Write-Host "  or check that CoreSignal covers this domain at all." -ForegroundColor Yellow
        }
    }
    400 {
        Write-Host "  BAD REQUEST -- CoreSignal rejected the request shape." -ForegroundColor Yellow
        Write-Host "  See response body above for their detail message." -ForegroundColor Yellow
    }
    401 { Write-Host "  AUTH FAILED -- API key is wrong or revoked." -ForegroundColor Red }
    402 { Write-Host "  NO CREDITS -- account out of Collect credits." -ForegroundColor Yellow }
    429 { Write-Host "  RATE LIMITED -- wait a bit and retry." -ForegroundColor Yellow }
    default {
        Write-Host "  UNEXPECTED STATUS $httpStatus -- check response above." -ForegroundColor Red
    }
}
Write-Host ""
