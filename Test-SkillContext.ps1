# Test-SkillContext.ps1
#
# Verifies the GoWarm /api/skill-context/prospects/:id endpoint end-to-end.
# Reports which fields landed and which are still empty, so you can tell
# whether the linkedin_profiles JOIN is deployed and whether dual-write
# fields are populated.
#
# Usage (PowerShell 5.1+ or PowerShell 7):
#   .\Test-SkillContext.ps1 -ProspectId 320
#
# Requires either:
#   - an env var SKILL_RUNNER_TOKEN set in your shell, OR
#   - the -Token parameter passed in.
#
# Optionally pass -RawJson to also dump the full payload to a file.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$ProspectId,

    [string]$ApiUrl = 'https://api.gowarmcrm.com',

    [string]$Token = $env:SKILL_RUNNER_TOKEN,

    [int]$AsUser = 0,

    [switch]$RawJson
)

if ([string]::IsNullOrWhiteSpace($Token)) {
    Write-Host "ERROR: No token provided." -ForegroundColor Red
    Write-Host "Either set `$env:SKILL_RUNNER_TOKEN or pass -Token <value>." -ForegroundColor Yellow
    exit 1
}

$url = "$ApiUrl/api/skill-context/prospects/$ProspectId"
if ($AsUser -gt 0) {
    $url = "$url?as_user=$AsUser"
}

Write-Host ""
Write-Host "Fetching: $url" -ForegroundColor Cyan
Write-Host ""

try {
    $headers = @{
        'x-skill-runner-token' = $Token
        'Accept'               = 'application/json'
    }
    $payload = Invoke-RestMethod -Method Get -Uri $url -Headers $headers -ErrorAction Stop
}
catch {
    Write-Host "REQUEST FAILED" -ForegroundColor Red
    if ($_.Exception.Response) {
        $code = [int]$_.Exception.Response.StatusCode
        Write-Host ("HTTP {0}" -f $code) -ForegroundColor Red
    }
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

# Helper for a green/red bullet
function Show-Field($label, $value, [int]$indent = 2) {
    $pad = ' ' * $indent
    $present = $false
    if ($null -ne $value) {
        if ($value -is [string]) {
            $present = -not [string]::IsNullOrWhiteSpace($value)
        }
        elseif ($value -is [System.Collections.IEnumerable] -and -not ($value -is [string])) {
            $present = (@($value).Count -gt 0)
        }
        else {
            $present = $true
        }
    }
    $mark = if ($present) { '[+]' } else { '[ ]' }
    $color = if ($present) { 'Green' } else { 'DarkGray' }
    $shown = if ($null -eq $value) { '<null>' } elseif ($value -is [string] -and $value.Length -gt 80) { $value.Substring(0, 77) + '...' } elseif ($value -is [System.Collections.IEnumerable] -and -not ($value -is [string])) { ('count=' + (@($value).Count)) } else { $value }
    Write-Host ("{0}{1} {2,-22}: {3}" -f $pad, $mark, $label, $shown) -ForegroundColor $color
}

Write-Host "=== PROSPECT ===" -ForegroundColor White
Show-Field 'name'         $payload.prospect.name
Show-Field 'title'        $payload.prospect.title
Show-Field 'company'      $payload.prospect.company
Show-Field 'linkedin_url' $payload.prospect.linkedin_url
Show-Field 'headline'     $payload.prospect.headline
Show-Field 'about'        $payload.prospect.about
Show-Field 'experience'   $payload.prospect.experience
Show-Field 'education'    $payload.prospect.education
Show-Field 'seniority'    $payload.prospect.seniority_level
Show-Field 'function'     $payload.prospect.function

Write-Host ""
Write-Host "=== ACCOUNT ===" -ForegroundColor White
Show-Field 'name'         $payload.account.name
Show-Field 'industry'     $payload.account.industry
Show-Field 'size'         $payload.account.size
Show-Field 'growth_stage' $payload.account.growth_stage
Show-Field 'tech_stack'   $payload.account.tech_stack

Write-Host ""
Write-Host "=== ICP ===" -ForegroundColor White
Show-Field 'fit_score'        $payload.icp.fit_score
Show-Field 'matched_criteria' $payload.icp.matched_criteria
Show-Field 'missed_criteria'  $payload.icp.missed_criteria
Show-Field 'persona_match'    $payload.icp.persona_match

Write-Host ""
Write-Host "=== SIGNALS ===" -ForegroundColor White
Show-Field 'account_events'      $payload.signals.account_events
Show-Field 'linkedin posts'      $payload.signals.linkedin_activity.posts
Show-Field 'linkedin comments'   $payload.signals.linkedin_activity.comments
Show-Field 'linkedin reactions'  $payload.signals.linkedin_activity.reactions

Write-Host ""
Write-Host "=== JOIN HEALTH CHECK ===" -ForegroundColor White

$expCount = @($payload.prospect.experience).Count
$eduCount = @($payload.prospect.education).Count
$hasLinkedInUrl = -not [string]::IsNullOrWhiteSpace($payload.prospect.linkedin_url)
$hasHeadline    = -not [string]::IsNullOrWhiteSpace($payload.prospect.headline)
$hasAbout       = -not [string]::IsNullOrWhiteSpace($payload.prospect.about)

if ($hasLinkedInUrl -and ($hasHeadline -or $hasAbout) -and $expCount -eq 0 -and $eduCount -eq 0) {
    Write-Host "  Headline/about ARE present but experience+education are EMPTY." -ForegroundColor Yellow
    Write-Host "  -> The linkedin_profiles JOIN is most likely NOT deployed yet." -ForegroundColor Yellow
    Write-Host "     Commit + push the SkillContextService.js change and retry." -ForegroundColor Yellow
}
elseif ($expCount -gt 0 -or $eduCount -gt 0) {
    Write-Host "  Experience ($expCount) and/or education ($eduCount) populated." -ForegroundColor Green
    Write-Host "  -> JOIN is working. If title is still empty, that is a separate fix" -ForegroundColor Green
    Write-Host "     (use experience[current].title as a fallback)." -ForegroundColor Green
}
elseif (-not $hasLinkedInUrl) {
    Write-Host "  Prospect has no linkedin_url at all - JOIN cannot fire either way." -ForegroundColor DarkGray
}
else {
    Write-Host "  No headline, about, experience, or education." -ForegroundColor DarkGray
    Write-Host "  -> Either the extension never captured this prospect, or the slug" -ForegroundColor DarkGray
    Write-Host "     in linkedin_profiles does not match the prospects.linkedin_url." -ForegroundColor DarkGray
}

if ($RawJson) {
    $outFile = "skill-context-prospect-$ProspectId.json"
    $payload | ConvertTo-Json -Depth 10 | Set-Content -Path $outFile -Encoding UTF8
    Write-Host ""
    Write-Host "Full payload written to: $outFile" -ForegroundColor Cyan
}

Write-Host ""
