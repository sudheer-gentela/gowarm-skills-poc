# Test-EnrichFromCoreSignal.ps1
#
# Calls POST /api/prospects/:id/enrich-from-coresignal on the GoWarm
# backend. Reports the response in a way that maps directly to the
# four possible outcomes (ok / auth / config / not-found) so you can
# tell at a glance what happened.
#
# Usage (PowerShell 5.1+ or PowerShell 7):
#   .\Test-EnrichFromCoreSignal.ps1 -ProspectId 322
#   .\Test-EnrichFromCoreSignal.ps1 -ProspectId 322 -Token <jwt>
#
# Token is read from -Token first, then $env:GOWARM_JWT.
#
# After a successful run, also runs a verification query helper text so
# you know exactly what to paste into psql to confirm the DB landed.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$ProspectId,

    [string]$ApiUrl = 'https://api.gowarmcrm.com',

    [string]$Token = $env:GOWARM_JWT
)

if ([string]::IsNullOrWhiteSpace($Token)) {
    Write-Host "ERROR: No JWT provided." -ForegroundColor Red
    Write-Host ""
    Write-Host "Get a JWT one of two ways:" -ForegroundColor Yellow
    Write-Host "  1. Open https://app.gowarmcrm.com in your browser, log in," -ForegroundColor Yellow
    Write-Host "     open DevTools -> Application -> Local Storage, copy the" -ForegroundColor Yellow
    Write-Host "     value of the 'token' (or similar) key." -ForegroundColor Yellow
    Write-Host "  2. Hit your auth endpoint directly with curl/psql." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Then either:" -ForegroundColor Yellow
    Write-Host "  `$env:GOWARM_JWT = '<paste>'" -ForegroundColor Yellow
    Write-Host "  .\Test-EnrichFromCoreSignal.ps1 -ProspectId $ProspectId" -ForegroundColor Yellow
    Write-Host "Or pass it inline:" -ForegroundColor Yellow
    Write-Host "  .\Test-EnrichFromCoreSignal.ps1 -ProspectId $ProspectId -Token <jwt>" -ForegroundColor Yellow
    exit 1
}

$url = "$ApiUrl/api/prospects/$ProspectId/enrich-from-coresignal"

Write-Host ""
Write-Host "POST $url" -ForegroundColor Cyan
Write-Host ""

$headers = @{
    'Authorization' = "Bearer $Token"
    'Accept'        = 'application/json'
    'Content-Type'  = 'application/json'
}

$response = $null
$httpStatus = $null
$wasError = $false

try {
    $response = Invoke-RestMethod -Method Post -Uri $url -Headers $headers -ErrorAction Stop
    $httpStatus = 200
}
catch {
    $wasError = $true
    $rawBody = $null

    # PowerShell exposes the response body on HTTP errors in different
    # places depending on version, error backend, and platform. Try each
    # in turn until we find one that has the body.

    # Method 1: $_.ErrorDetails.Message -- this is the most reliable place
    # in PS 5.1+ when the response has a JSON body. It's already been read
    # by Invoke-RestMethod and stashed here.
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        $rawBody = $_.ErrorDetails.Message
    }

    # Method 2: Read the response stream manually. Works on older versions
    # but only if the stream hasn't already been consumed by the caller.
    if (-not $rawBody -and $_.Exception.Response) {
        try {
            $resp = $_.Exception.Response
            if ($resp.GetResponseStream) {
                $stream = $resp.GetResponseStream()
                if ($stream) {
                    $stream.Position = 0 2>$null
                    $reader  = New-Object System.IO.StreamReader($stream)
                    $rawBody = $reader.ReadToEnd()
                    $reader.Close()
                }
            }
        } catch {
            # Stream might be closed/null -- fall through.
        }
    }

    # Pull the HTTP status code from whichever response object exists.
    if ($_.Exception.Response) {
        $httpStatus = [int]$_.Exception.Response.StatusCode
    } elseif ($_.Exception.PSObject.Properties['Response']) {
        $httpStatus = $_.Exception.Response.StatusCode.value__
    } else {
        $httpStatus = 0
    }

    # Try to parse the body as JSON.
    if ($rawBody) {
        try {
            $response = $rawBody | ConvertFrom-Json -ErrorAction Stop
        } catch {
            # Body wasn't JSON. Stash it as a string so we still print it.
            $response = [PSCustomObject]@{ raw_text = $rawBody }
        }
    }

    if ($httpStatus -eq 0) {
        Write-Host "Request failed with no HTTP response:" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Red
        exit 1
    }
}

$statusColor = if ($httpStatus -eq 200) { 'Green' } else { 'Yellow' }
Write-Host "HTTP $httpStatus" -ForegroundColor $statusColor
Write-Host ""

if ($null -ne $response) {
    Write-Host "Response body:" -ForegroundColor Cyan
    $response | ConvertTo-Json -Depth 6
    Write-Host ""
}

# -- Interpret the outcome -------------------------------------------------
Write-Host "=== INTERPRETATION ===" -ForegroundColor White

if ($httpStatus -eq 200 -and $response.ok -eq $true) {
    Write-Host "  SUCCESS -- enrichment ran and applied fields." -ForegroundColor Green
    Write-Host ""
    if ($response.enriched) {
        Write-Host "  Fields applied to account $($response.accountId):" -ForegroundColor Green
        $response.enriched.PSObject.Properties | ForEach-Object {
            Write-Host ("    {0,-30} {1}" -f $_.Name, $_.Value) -ForegroundColor Green
        }
    }
    Write-Host ""
    Write-Host "  Verify in psql:" -ForegroundColor Cyan
    Write-Host "    SELECT id, name, domain, industry, size, needs_domain_review," -ForegroundColor DarkGray
    Write-Host "           research_meta->'coresignal'->>'status'      AS enrich_status," -ForegroundColor DarkGray
    Write-Host "           research_meta->'coresignal'->>'enriched_at' AS enriched_at" -ForegroundColor DarkGray
    Write-Host "      FROM accounts WHERE id = $($response.accountId);" -ForegroundColor DarkGray
}
elseif ($response.reason) {
    switch ($response.reason) {
        'no_api_key' {
            Write-Host "  CONFIG -- CORESIGNAL_API_KEY is not set on the backend." -ForegroundColor Yellow
            Write-Host "  Add it as a Railway env var on the action-crm-clean service" -ForegroundColor Yellow
            Write-Host "  and wait for the auto-redeploy (~30-60s), then retry." -ForegroundColor Yellow
        }
        'auth_failed' {
            Write-Host "  AUTH FAILED -- CoreSignal rejected the API key." -ForegroundColor Yellow
            Write-Host "  Either the key is wrong (typo when pasting) or it has been" -ForegroundColor Yellow
            Write-Host "  revoked/expired. Generate a fresh key and re-set the env var." -ForegroundColor Yellow
        }
        'no_credits' {
            Write-Host "  NO CREDITS -- your CoreSignal account is out of Collect credits." -ForegroundColor Yellow
            Write-Host "  Free trial gives 200; multi-source enrichment costs 2 per call." -ForegroundColor Yellow
            Write-Host "  Top up or wait for the next billing cycle." -ForegroundColor Yellow
        }
        'rate_limited' {
            Write-Host "  RATE LIMITED -- CoreSignal throttled this request (HTTP 429)." -ForegroundColor Yellow
            Write-Host "  Wait a minute and retry." -ForegroundColor Yellow
        }
        'not_found' {
            Write-Host "  NOT FOUND -- CoreSignal had no record matching the identifier." -ForegroundColor Yellow
            Write-Host ""
            Write-Host "  Most likely cause: the linkedin_company_url stored on the" -ForegroundColor Yellow
            Write-Host "  account uses LinkedIn's numeric company ID, not the slug." -ForegroundColor Yellow
            Write-Host "  CoreSignal may only resolve URLs with the human-readable slug." -ForegroundColor Yellow
            Write-Host ""
            Write-Host "  Try one of these:" -ForegroundColor Cyan
            Write-Host "    1. UPDATE the account's linkedin_company_url to the slug form:" -ForegroundColor DarkGray
            Write-Host "       UPDATE accounts" -ForegroundColor DarkGray
            Write-Host "         SET linkedin_company_url = 'https://www.linkedin.com/company/gong-io'" -ForegroundColor DarkGray
            Write-Host "       WHERE id = $($response.accountId);" -ForegroundColor DarkGray
            Write-Host "    2. Then retry this script." -ForegroundColor DarkGray
        }
        'no_identifier_on_account' {
            Write-Host "  NO IDENTIFIER -- the account has neither linkedin_company_url" -ForegroundColor Yellow
            Write-Host "  nor a real domain (only catchall). Nothing to enrich from." -ForegroundColor Yellow
        }
        'prospect_has_no_account' {
            Write-Host "  NO ACCOUNT -- the prospect has no account_id. Created before" -ForegroundColor Yellow
            Write-Host "  the domain-resolver patch shipped, presumably." -ForegroundColor Yellow
        }
        'prospect_not_found' {
            Write-Host "  PROSPECT NOT FOUND -- no prospect with id $ProspectId in your org." -ForegroundColor Yellow
        }
        'timeout' {
            Write-Host "  TIMEOUT -- CoreSignal didn't respond within 10s. Retry." -ForegroundColor Yellow
        }
        default {
            Write-Host "  Reason: $($response.reason). See response body above." -ForegroundColor Yellow
        }
    }
}
elseif ($httpStatus -eq 401) {
    Write-Host "  UNAUTHORIZED -- your JWT was rejected by GoWarm." -ForegroundColor Red
    Write-Host "  The token may have expired. Get a fresh one and retry." -ForegroundColor Red
}
elseif ($httpStatus -eq 404) {
    Write-Host "  NOT FOUND -- the route doesn't exist. Either the deploy hasn't" -ForegroundColor Red
    Write-Host "  rolled out yet, or the path is wrong. Wait and retry." -ForegroundColor Red
}
elseif ($wasError) {
    Write-Host "  Unexpected error. See response above." -ForegroundColor Red
}

Write-Host ""
