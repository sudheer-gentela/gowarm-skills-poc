# Test-CoreSignalSearch.ps1
#
# Tests CoreSignal's Multi-source Company /search/es_dsl endpoint against
# a LinkedIn URL or numeric company ID, trying several Elasticsearch DSL
# query shapes to find which (if any) returns the right company.
#
# This exists because /collect/{id} 404s on numeric LinkedIn IDs (we tested),
# so we want to know whether the search endpoint can resolve them instead.
#
# Usage:
#   $env:CORESIGNAL_API_KEY = '<key>'
#   .\Test-CoreSignalSearch.ps1 -LinkedInUrl 'https://www.linkedin.com/company/10454372'
#   .\Test-CoreSignalSearch.ps1 -LinkedInId '10454372'
#   .\Test-CoreSignalSearch.ps1 -Slug 'gong-io'
#
# Each call hits the search endpoint and runs ONE query at a time so you can
# see exactly which query shape works and at what credit cost. Use -All
# to run every probe in one go.
#
# IMPORTANT: search endpoint costs Search credits (not Collect credits).
# Each probe is 1 search request. Running with -All hits ~6 probes.

[CmdletBinding(DefaultParameterSetName = 'Url')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Url')]
    [string]$LinkedInUrl,

    [Parameter(Mandatory = $true, ParameterSetName = 'Id')]
    [string]$LinkedInId,

    [Parameter(Mandatory = $true, ParameterSetName = 'Slug')]
    [string]$Slug,

    [string]$ApiKey = $env:CORESIGNAL_API_KEY,

    [switch]$All,

    [switch]$Raw
)

if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    Write-Host "ERROR: No CoreSignal API key. Set `$env:CORESIGNAL_API_KEY first." -ForegroundColor Red
    exit 1
}

# Normalize the inputs so every probe operates on the same canonical pieces.
$id = $null
$url = $null
$slug = $null

if ($PSCmdlet.ParameterSetName -eq 'Url') {
    $url = $LinkedInUrl
    if ($LinkedInUrl -match '/company/(\d+)') {
        $id = $matches[1]
    }
    elseif ($LinkedInUrl -match '/company/([A-Za-z0-9._-]+)') {
        $slug = $matches[1]
    }
}
elseif ($PSCmdlet.ParameterSetName -eq 'Id') {
    $id = $LinkedInId
    $url = "https://www.linkedin.com/company/$LinkedInId"
}
else {
    $slug = $Slug
    $url = "https://www.linkedin.com/company/$Slug"
}

Write-Host ""
Write-Host "Inputs:" -ForegroundColor Cyan
Write-Host "  url:  $url"
Write-Host "  id:   $id"
Write-Host "  slug: $slug"
Write-Host ""

$searchUrl = 'https://api.coresignal.com/cdapi/v2/company_multi_source/search/es_dsl'
$headers = @{
    'apikey'       = $ApiKey
    'accept'       = 'application/json'
    'Content-Type' = 'application/json'
}

# -----------------------------------------------------------------------------
# Build the probes. Each probe is { name, body, requires } where requires
# tells us which inputs it needs (id / url / slug). We only run probes
# whose requirements are satisfied by what the user passed in.
# -----------------------------------------------------------------------------
$probes = @()

if ($id) {
    # Probe 1: term match on a hypothetical numeric id field.
    # Field name guess; if CoreSignal indexes the LinkedIn numeric ID as
    # a separate field, this is what it'd most plausibly be called.
    $probes += @{
        name     = "term: professional_network_company_id = $id"
        body     = @{
            query = @{
                term = @{
                    professional_network_company_id = $id
                }
            }
        }
    }

    # Probe 2: same field name with .exact subfield (CoreSignal uses
    # multifields with .exact for keyword variants of text fields).
    $probes += @{
        name     = "term: professional_network_company_id.exact = $id"
        body     = @{
            query = @{
                term = @{
                    'professional_network_company_id.exact' = $id
                }
            }
        }
    }
}

if ($url) {
    # Probe 3: match_phrase on professional_network_url (the field name
    # we've seen on response shapes elsewhere in CoreSignal docs).
    $probes += @{
        name     = "match_phrase: professional_network_url = '$url'"
        body     = @{
            query = @{
                match_phrase = @{
                    professional_network_url = $url
                }
            }
        }
    }

    # Probe 4: term on professional_network_url.exact.
    $probes += @{
        name     = "term: professional_network_url.exact = '$url'"
        body     = @{
            query = @{
                term = @{
                    'professional_network_url.exact' = $url
                }
            }
        }
    }

    # Probe 5: query_string with the full URL as a phrase across any URL field.
    # Looser than the above two -- uses Lucene's query parser which is more
    # forgiving about field schemas.
    $probes += @{
        name     = "query_string: '$url' on professional_network_url"
        body     = @{
            query = @{
                query_string = @{
                    query           = "`"$url`""
                    default_field   = 'professional_network_url'
                    default_operator = 'and'
                }
            }
        }
    }
}

if ($slug) {
    # Probe 6: term on shorthand_name field (CoreSignal exposes this as a
    # response field; it's plausibly indexed).
    $probes += @{
        name     = "term: shorthand_name = '$slug'"
        body     = @{
            query = @{
                term = @{
                    shorthand_name = $slug
                }
            }
        }
    }
}

# Pagination: the search endpoint rejects body.size; it uses its own
# default page size (typically 10-100). For our "is there any hit?"
# question that's fine.

# Determine which probes to run.
$probesToRun = if ($All) { $probes } else { @($probes[0]) }

if (-not $All -and $probes.Count -gt 1) {
    Write-Host "Running probe 1 of $($probes.Count). Pass -All to run them all." -ForegroundColor DarkGray
    Write-Host ""
}

$probeIndex = 0
$successes = @()

foreach ($probe in $probesToRun) {
    $probeIndex++
    Write-Host "-- Probe $probeIndex" -ForegroundColor Cyan
    Write-Host "  $($probe.name)" -ForegroundColor Cyan

    $bodyJson = $probe.body | ConvertTo-Json -Depth 12 -Compress
    Write-Host "  body: $bodyJson" -ForegroundColor DarkGray

    $resp     = $null
    $httpCode = $null
    try {
        $resp     = Invoke-RestMethod -Method Post -Uri $searchUrl -Headers $headers -Body $bodyJson -ErrorAction Stop
        $httpCode = 200
    }
    catch {
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            try { $resp = $_.ErrorDetails.Message | ConvertFrom-Json }
            catch { $resp = [PSCustomObject]@{ raw_text = $_.ErrorDetails.Message } }
        }
        if ($_.Exception.Response) {
            $httpCode = [int]$_.Exception.Response.StatusCode
        }
    }

    $color = if ($httpCode -eq 200) { 'Green' } else { 'Yellow' }
    Write-Host "  HTTP $httpCode" -ForegroundColor $color

    if ($httpCode -eq 200) {
        # The search endpoint typically returns either an array of IDs
        # or an array of objects depending on options. Cope with both.
        $hitCount = 0
        if ($resp -is [Array]) {
            $hitCount = $resp.Count
        }
        elseif ($resp.hits -and $resp.hits.hits) {
            $hitCount = $resp.hits.hits.Count
        }
        elseif ($resp -is [System.Collections.IEnumerable]) {
            $hitCount = (@($resp)).Count
        }

        Write-Host "  hits: $hitCount" -ForegroundColor Green

        if ($hitCount -gt 0) {
            $successes += $probe.name
            $first = if ($resp -is [Array]) { $resp[0] } elseif ($resp.hits) { $resp.hits.hits[0] } else { $resp }
            Write-Host "  first hit:" -ForegroundColor Green
            $first | Format-List | Out-String | ForEach-Object { $_.TrimEnd() } | Where-Object { $_ } | ForEach-Object { Write-Host "    $_" }
        }
        else {
            Write-Host "  (zero hits -- this query shape is wrong or company isn't indexed by it)" -ForegroundColor DarkGray
        }
    }
    else {
        Write-Host "  response:" -ForegroundColor Yellow
        ($resp | ConvertTo-Json -Depth 6) -split "`n" | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    }
    Write-Host ""
}

Write-Host "=== SUMMARY ===" -ForegroundColor White
if ($successes.Count -gt 0) {
    Write-Host "  Probes that returned hits:" -ForegroundColor Green
    foreach ($s in $successes) { Write-Host "    - $s" -ForegroundColor Green }
    Write-Host ""
    Write-Host "  Use the matching field/syntax in coreSignalProvider.js for" -ForegroundColor Green
    Write-Host "  the numeric-LinkedIn-URL fallback path." -ForegroundColor Green
}
else {
    Write-Host "  No probe returned hits." -ForegroundColor Yellow
    if (-not $All) {
        Write-Host "  Re-run with -All to try all probes." -ForegroundColor Yellow
    }
    else {
        Write-Host "  None of the field-name guesses worked. Options:" -ForegroundColor Yellow
        Write-Host "    1. Check CoreSignal docs / dashboard for the exact field name." -ForegroundColor Yellow
        Write-Host "    2. CoreSignal genuinely doesn't index this company under any" -ForegroundColor Yellow
        Write-Host "       URL/ID variant -- fall back to server-side LinkedIn redirect" -ForegroundColor Yellow
        Write-Host "       resolution (Option B from our discussion)." -ForegroundColor Yellow
    }
}
Write-Host ""
