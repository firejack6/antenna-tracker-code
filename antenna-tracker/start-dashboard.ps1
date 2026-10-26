param([int]$Port = 8765, [switch]$NoBrowser, [switch]$SkipWifi, [string]$WifiInterface = '')
$ErrorActionPreference = 'Stop'
if (-not $SkipWifi) {
    $wifiProfilePath = $null
    try {
        $networkConfig = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'src\network_config.h')
        if ($networkConfig -match 'WIFI_ACCESS_POINT\s*=\s*true\s*;') {
            $ssidMatch = [regex]::Match($networkConfig, 'WIFI_SSID\[\]\s*=\s*("(?:[^"\\]|\\.)*")')
            $passwordMatch = [regex]::Match($networkConfig, 'WIFI_PASSWORD\[\]\s*=\s*("(?:[^"\\]|\\.)*")')
            if (-not $ssidMatch.Success -or -not $passwordMatch.Success) { throw 'Cannot read Wi-Fi credentials from src/network_config.h.' }
            $wifiSsid = ConvertFrom-Json $ssidMatch.Groups[1].Value
            $wifiPassword = ConvertFrom-Json $passwordMatch.Groups[1].Value
            $ssidXml = [System.Security.SecurityElement]::Escape($wifiSsid)
            $passwordXml = [System.Security.SecurityElement]::Escape($wifiPassword)
            $ssidHex = ([BitConverter]::ToString([Text.Encoding]::UTF8.GetBytes($wifiSsid))).Replace('-', '')
            $wifiProfile = @"
<?xml version="1.0" encoding="UTF-8"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>$ssidXml</name>
  <SSIDConfig><SSID><hex>$ssidHex</hex><name>$ssidXml</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType><connectionMode>manual</connectionMode>
  <MSM><security>
    <authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>
    <sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>$passwordXml</keyMaterial></sharedKey>
  </security></MSM>
</WLANProfile>
"@
            $wifiProfilePath = [IO.Path]::GetTempFileName()
            [IO.File]::WriteAllText($wifiProfilePath, $wifiProfile, [Text.UTF8Encoding]::new($false))
            $wifiInterfaceArgs = @()
            if ($WifiInterface) { $wifiInterfaceArgs += "interface=$WifiInterface" }
            Write-Host "Connecting Windows Wi-Fi to $wifiSsid..."
            & netsh wlan add profile "filename=$wifiProfilePath" 'user=current' @wifiInterfaceArgs
            if ($LASTEXITCODE -ne 0) {
                Write-Host 'Profile could not be updated; trying the existing Windows profile.'
            }
            & netsh wlan connect "name=$wifiSsid" "ssid=$wifiSsid" @wifiInterfaceArgs
            if ($LASTEXITCODE -ne 0) { throw 'Windows could not request the hotspot connection.' }
            $addressMatch = [regex]::Match($networkConfig, 'WIFI_AP_ADDRESS\[4\]\s*=\s*\{([^}]+)\}')
            $maskMatch = [regex]::Match($networkConfig, 'WIFI_AP_NETMASK\[4\]\s*=\s*\{([^}]+)\}')
            if (-not $addressMatch.Success -or -not $maskMatch.Success) { throw 'Cannot read hotspot subnet from src/network_config.h.' }
            $hotspotAddress = @($addressMatch.Groups[1].Value.Split(',') | ForEach-Object { [byte]$_.Trim() })
            $hotspotMask = @($maskMatch.Groups[1].Value.Split(',') | ForEach-Object { [byte]$_.Trim() })
            Write-Host 'Waiting up to 30 seconds for a hotspot Wi-Fi address...'
            $wifiReady = $false
            for ($attempt = 0; $attempt -lt 30; $attempt++) {
                foreach ($adapter in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
                    if ($adapter.NetworkInterfaceType -ne [Net.NetworkInformation.NetworkInterfaceType]::Wireless80211 -or
                        $adapter.OperationalStatus -ne [Net.NetworkInformation.OperationalStatus]::Up -or
                        ($WifiInterface -and $adapter.Name -ne $WifiInterface)) { continue }
                    foreach ($unicast in $adapter.GetIPProperties().UnicastAddresses) {
                        if ($unicast.Address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { continue }
                        $localBytes = $unicast.Address.GetAddressBytes()
                        $sameSubnet = $true
                        for ($octet = 0; $octet -lt 4; $octet++) {
                            if (($localBytes[$octet] -band $hotspotMask[$octet]) -ne
                                ($hotspotAddress[$octet] -band $hotspotMask[$octet])) { $sameSubnet = $false }
                        }
                        if ($sameSubnet) { $wifiReady = $true; Write-Host "Hotspot Wi-Fi ready: $($unicast.Address)"; break }
                    }
                    if ($wifiReady) { break }
                }
                if ($wifiReady) { break }
                if ($attempt -gt 0 -and $attempt % 5 -eq 0) {
                    & netsh wlan connect "name=$wifiSsid" "ssid=$wifiSsid" @wifiInterfaceArgs
                }
                Start-Sleep -Seconds 1
            }
            if (-not $wifiReady) { throw 'Windows did not obtain a hotspot Wi-Fi address within 30 seconds.' }
        }
    } catch {
        Write-Warning "Wi-Fi setup: $($_.Exception.Message) Join the hotspot manually; dashboard will still start."
    } finally {
        if ($wifiProfilePath) { Remove-Item -LiteralPath $wifiProfilePath -Force -ErrorAction SilentlyContinue }
    }
}
$dashboardUrl = "http://127.0.0.1:$Port"
$existingDashboard = $null
try {
    $existingDashboard = Invoke-RestMethod -Uri "$dashboardUrl/api/state?since=2147483647" -TimeoutSec 2
} catch {
    # No dashboard on this port; start one below.
}
if ($null -ne $existingDashboard -and
    $null -ne $existingDashboard.PSObject.Properties['status'] -and
    $null -ne $existingDashboard.PSObject.Properties['servo_inhibit']) {
    Write-Host "Dashboard already running: $dashboardUrl"
    if (-not $NoBrowser) { Start-Process $dashboardUrl }
    exit 0
}
$dashboardPython = Join-Path $env:USERPROFILE '.platformio\penv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $dashboardPython)) {
    $dashboardPython = (Get-Command python -ErrorAction Stop).Source
}
$dashboardArgs = @((Join-Path $PSScriptRoot 'dashboard\relay.py'), '--port', "$Port")
if ($NoBrowser) { $dashboardArgs += '--no-browser' }
& $dashboardPython @dashboardArgs
exit $LASTEXITCODE
