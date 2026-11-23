<#
 protocol_guard.ps1 —— 自定义 URL 协议（diff4x://）认证加密信封与唯一入口校验层 (v2)

 安全模型
   1. 仅接受认证加密一次性信封：diff4x://env/v1.<base64url(packet)>
      packet = [0x01] (1B) || IV (16B) || AES-256-CBC(K_enc, IV, JSON) || HMAC-SHA256(K_mac, ver||IV||CT) (32B)
      严格执行 Encrypt-then-MAC（先常量时间验签，后解密），彻底拒收明文 diff4x://1{... 请求。
   2. 密钥来源：_build/secrets/protocol.key（64 位随机 hex），由 sws.toml 在 HTTP 层彻底禁访，
      仅由 CLI.bat 启动服务器时通过 URL #__diff4x_key=<key> 注入本机 Origin 的 localStorage。
   3. 防重放与来源绑定：校验时间戳窗口（±30 秒）、Mutex 保护的一次性 nonce（90 秒滑动窗口）、
      以及 origin 白名单（仅 http://localhost:<port> 与 http://127.0.0.1:<port>）。
   4. 纵深防御：解包后仍对业务参数执行严格白/黑名单与仓库根路径落点校验，只向 CLI.bat 输出动作编号与 base64。

 用法（一般由注册表或 CLI.bat 调用）
   -Mode EnsureKey [-Rotate]  读取或生成 32 字节主密钥（hex 输出到 stdout）
   -Mode Launch <url>         注册表直接调用：验签解密校验 → 设置 G_* 环境变量 → 启动 CLI.bat __proto
   -Mode Emit                 读取 $env:CLI_RAW，校验后输出 KEY=VALUE（旧注册方式兼容入口，同样要求信封）
   -Mode Decode               解码 $env:CLI_DEC_IN（base64）并输出 UTF-8 文本
   -Mode Compose              用 CLI_BLOCK_B64/CLI_TITLE_B64/CLI_HREF_B64 组装书签参数（base64）
   -Mode WriteClipboard       把剪贴板内容原子写入目标文件（-Kind html | md）
   -Mode OpenFolder           在资源管理器中打开目录
   -Mode SelfTest             运行内置加密/验签/防重放/纵深防御自检套件
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Url = '',
    [ValidateSet('Emit', 'Launch', 'Decode', 'Compose', 'WriteClipboard', 'OpenFolder', 'EnsureKey', 'SelfTest')]
    [string]$Mode = 'Emit',
    [ValidateSet('html', 'md')][string]$Kind = 'html',
    [switch]$Rotate
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$Script:Root         = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Script:Bat          = Join-Path $PSScriptRoot 'CLI.bat'
$Script:ConfigPath   = Join-Path $PSScriptRoot 'config.properties'
$Script:KeyPath      = Join-Path $PSScriptRoot 'secrets\protocol.key'
$Script:NoncePath    = Join-Path $env:TEMP 'diff4x_proto_nonces.txt'
$Script:Utf8NoBom    = New-Object System.Text.UTF8Encoding($false)
$Script:Utf8Bom      = New-Object System.Text.UTF8Encoding($true)
$Script:MaxSkewSec   = 30
$Script:NonceKeepSec = 90

# ------------------------------------------------------------------ 编解码与密码学原语
function ConvertTo-B64([string]$s)   { [Convert]::ToBase64String($Script:Utf8NoBom.GetBytes($s)) }
function ConvertFrom-B64([string]$b) {
    if ([string]::IsNullOrEmpty($b) -or $b -notmatch '^[A-Za-z0-9+/]+={0,2}$') { throw 'bad base64' }
    $Script:Utf8NoBom.GetString([Convert]::FromBase64String($b))
}

function ConvertTo-Base64Url([byte[]]$bytes) {
    return ([Convert]::ToBase64String($bytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function ConvertFrom-Base64Url([string]$s) {
    if ([string]::IsNullOrEmpty($s) -or $s -notmatch '^[A-Za-z0-9_-]+$') { throw 'bad base64url' }
    $b64 = $s.Replace('-', '+').Replace('_', '/')
    switch ($b64.Length % 4) {
        0 { }
        2 { $b64 += '==' }
        3 { $b64 += '=' }
        default { throw 'bad base64url length' }
    }
    return ,([byte[]][Convert]::FromBase64String($b64))
}

function ConvertFrom-Hex([string]$hex) {
    if ([string]::IsNullOrEmpty($hex) -or ($hex.Length % 2) -ne 0 -or $hex -notmatch '^[0-9a-fA-F]+$') {
        throw 'bad hex'
    }
    $len = $hex.Length / 2
    $out = New-Object byte[] $len
    for ($i = 0; $i -lt $len; $i++) {
        $out[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16)
    }
    return ,([byte[]]$out)
}

function ConvertTo-Hex([byte[]]$bytes) {
    $sb = New-Object System.Text.StringBuilder ($bytes.Length * 2)
    foreach ($b in $bytes) { [void]$sb.Append($b.ToString('x2')) }
    return $sb.ToString()
}

function Get-RandomBytes([int]$count) {
    $buf = New-Object byte[] $count
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    try { $rng.GetBytes($buf) } finally { $rng.Dispose() }
    return ,([byte[]]$buf)
}

function Get-UnixNow {
    $epoch = New-Object System.DateTime(1970, 1, 1, 0, 0, 0, [System.DateTimeKind]::Utc)
    return [int64][Math]::Floor(([DateTime]::UtcNow - $epoch).TotalSeconds)
}

function Test-BytesEqual([byte[]]$a, [byte[]]$b) {
    if ($null -eq $a -or $null -eq $b -or $a.Length -ne $b.Length) { return $false }
    $diff = 0
    for ($i = 0; $i -lt $a.Length; $i++) {
        $diff = $diff -bor ($a[$i] -bxor $b[$i])
    }
    return ($diff -eq 0)
}

function Derive-SubKeys([byte[]]$masterKey) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $encLabel = $Script:Utf8NoBom.GetBytes('diff4x-proto-enc-v1')
        $macLabel = $Script:Utf8NoBom.GetBytes('diff4x-proto-mac-v1')

        $encIn = New-Object byte[] ($masterKey.Length + $encLabel.Length)
        [System.Buffer]::BlockCopy($masterKey, 0, $encIn, 0, $masterKey.Length)
        [System.Buffer]::BlockCopy($encLabel, 0, $encIn, $masterKey.Length, $encLabel.Length)

        $macIn = New-Object byte[] ($masterKey.Length + $macLabel.Length)
        [System.Buffer]::BlockCopy($masterKey, 0, $macIn, 0, $masterKey.Length)
        [System.Buffer]::BlockCopy($macLabel, 0, $macIn, $masterKey.Length, $macLabel.Length)

        return @{
            Enc = $sha.ComputeHash($encIn)
            Mac = $sha.ComputeHash($macIn)
        }
    } finally {
        $sha.Dispose()
    }
}

function Get-LocalPort {
    $port = '8000'
    if (Test-Path -LiteralPath $Script:ConfigPath -PathType Leaf) {
        foreach ($line in [IO.File]::ReadAllLines($Script:ConfigPath, $Script:Utf8NoBom)) {
            if ($line -match '^\s*port\s*=\s*(\d+)\s*$') {
                $port = $Matches[1]
                break
            }
        }
    }
    return $port
}

function Get-AllowedOrigins {
    $port = Get-LocalPort
    if ($port -eq '80') {
        return @('http://localhost', 'http://127.0.0.1', 'http://localhost:80', 'http://127.0.0.1:80')
    }
    return @(
        ("http://localhost:{0}" -f $port),
        ("http://127.0.0.1:{0}" -f $port)
    )
}

function Get-OrCreateMasterKeyHex([bool]$forceRotate) {
    $dir = Split-Path -Parent $Script:KeyPath
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $dir -Force)
    }
    if (-not $forceRotate -and (Test-Path -LiteralPath $Script:KeyPath -PathType Leaf)) {
        $existing = ([IO.File]::ReadAllText($Script:KeyPath, $Script:Utf8NoBom)).Trim().ToLowerInvariant()
        if ($existing -match '^[0-9a-f]{64}$') { return $existing }
    }
    $newHex = ConvertTo-Hex (Get-RandomBytes 32)
    $tmp = $Script:KeyPath + '.tmp'
    [IO.File]::WriteAllText($tmp, $newHex, $Script:Utf8NoBom)
    Move-Item -LiteralPath $tmp -Destination $Script:KeyPath -Force
    return $newHex
}

function Read-MasterKeyBytes {
    if (-not (Test-Path -LiteralPath $Script:KeyPath -PathType Leaf)) {
        throw 'protocol key not initialized (start server via CLI.bat [4])'
    }
    $hex = ([IO.File]::ReadAllText($Script:KeyPath, $Script:Utf8NoBom)).Trim()
    if ($hex -notmatch '^[0-9a-fA-F]{64}$') { throw 'invalid protocol key file' }
    return ,([byte[]](ConvertFrom-Hex $hex))
}

function Seal-Envelope([byte[]]$masterKey, [int]$act, [string]$paramText, [int64]$ts, [string]$nonce, [string]$origin) {
    $keys = Derive-SubKeys $masterKey
    $payloadObj = [ordered]@{
        v      = 1
        act    = $act
        p      = $paramText
        ts     = $ts
        nonce  = $nonce
        origin = $origin
    }
    $plainBytes = $Script:Utf8NoBom.GetBytes(($payloadObj | ConvertTo-Json -Compress))
    [byte[]]$iv = Get-RandomBytes 16

    $aes = [System.Security.Cryptography.Aes]::Create()
    try {
        $aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
        $aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
        $aes.KeySize = 256
        $aes.Key = $keys.Enc
        $aes.IV = $iv
        $enc = $aes.CreateEncryptor()
        try {
            $ct = $enc.TransformFinalBlock($plainBytes, 0, $plainBytes.Length)
        } finally { $enc.Dispose() }
    } finally { $aes.Dispose() }

    $body = New-Object byte[] (1 + 16 + $ct.Length)
    $body[0] = 1
    [System.Buffer]::BlockCopy($iv, 0, $body, 1, 16)
    [System.Buffer]::BlockCopy($ct, 0, $body, 17, $ct.Length)

    $hmac = [System.Security.Cryptography.HMACSHA256]::new([byte[]]$keys.Mac)
    try { $tag = $hmac.ComputeHash($body) } finally { $hmac.Dispose() }

    $packet = New-Object byte[] ($body.Length + 32)
    [System.Buffer]::BlockCopy($body, 0, $packet, 0, $body.Length)
    [System.Buffer]::BlockCopy($tag, 0, $packet, $body.Length, 32)
    return 'diff4x://env/v1.' + (ConvertTo-Base64Url $packet)
}

function Assert-NonceFresh([string]$nonce, [int64]$nowSec, [string]$storeFile) {
    $mtx = New-Object System.Threading.Mutex($false, 'Local\diff4x_proto_nonce_v1')
    $acquired = $false
    try {
        try {
            $acquired = $mtx.WaitOne(3000)
        } catch [System.Threading.AbandonedMutexException] {
            $acquired = $true
        }
        if (-not $acquired) { throw 'nonce lock timeout' }

        $kept = New-Object System.Collections.Generic.List[string]
        if (Test-Path -LiteralPath $storeFile -PathType Leaf) {
            foreach ($line in [IO.File]::ReadAllLines($storeFile, $Script:Utf8NoBom)) {
                $sp = $line.Split(' ')
                if ($sp.Length -ne 2) { continue }
                $oldNonce = $sp[0]
                [int64]$oldTs = 0
                if (-not [int64]::TryParse($sp[1], [ref]$oldTs)) { continue }
                if (($nowSec - $oldTs) -le $Script:NonceKeepSec) {
                    if ($oldNonce -ceq $nonce) { throw 'replayed nonce' }
                    $kept.Add($line)
                }
            }
        }
        $kept.Add(('{0} {1}' -f $nonce, $nowSec))
        $tmp = $storeFile + '.tmp'
        [IO.File]::WriteAllLines($tmp, $kept.ToArray(), $Script:Utf8NoBom)
        Move-Item -LiteralPath $tmp -Destination $storeFile -Force
    } finally {
        if ($acquired) { $mtx.ReleaseMutex() }
        $mtx.Dispose()
    }
}

function Open-Envelope([string]$rawUrl, [byte[]]$masterKey, [string]$nonceFile) {
    if ([string]::IsNullOrEmpty($rawUrl) -or $rawUrl.Length -gt 8192) { throw 'empty or too long' }
    if ($rawUrl -match '[\x00-\x1F\x7F]') { throw 'control characters' }

    # 强制仅接受认证加密信封，彻底拒收明文 diff4x://1{...
    $m = [regex]::Match($rawUrl, '^[A-Za-z][A-Za-z0-9+.\-]*://env/v1\.(?<tok>[A-Za-z0-9_-]+)/?$')
    if (-not $m.Success) { throw 'plaintext or malformed protocol url rejected' }

    [byte[]]$packet = ConvertFrom-Base64Url $m.Groups['tok'].Value
    # 最短: 1(ver) + 16(iv) + 16(min 1 block ct) + 32(hmac) = 65 字节
    if ($packet.Length -lt 65) { throw 'envelope too short' }
    if ($packet[0] -ne 1) { throw 'unsupported envelope version' }

    $bodyLen = $packet.Length - 32
    $ctLen = $bodyLen - 17
    if (($ctLen % 16) -ne 0) { throw 'invalid ciphertext alignment' }

    $body = New-Object byte[] $bodyLen
    $tag  = New-Object byte[] 32
    [System.Buffer]::BlockCopy($packet, 0, $body, 0, $bodyLen)
    [System.Buffer]::BlockCopy($packet, $bodyLen, $tag, 0, 32)

    $keys = Derive-SubKeys $masterKey

    # Encrypt-then-MAC：严格先常量时间验签，再解密
    $hmac = [System.Security.Cryptography.HMACSHA256]::new([byte[]]$keys.Mac)
    try { $expectedTag = $hmac.ComputeHash($body) } finally { $hmac.Dispose() }
    if (-not (Test-BytesEqual $tag $expectedTag)) { throw 'mac verification failed' }

    $iv = New-Object byte[] 16
    $ct = New-Object byte[] $ctLen
    [System.Buffer]::BlockCopy($body, 1, $iv, 0, 16)
    [System.Buffer]::BlockCopy($body, 17, $ct, 0, $ctLen)

    $aes = [System.Security.Cryptography.Aes]::Create()
    try {
        $aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
        $aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
        $aes.KeySize = 256
        $aes.Key = $keys.Enc
        $aes.IV = $iv
        $dec = $aes.CreateDecryptor()
        try {
            $plainBytes = $dec.TransformFinalBlock($ct, 0, $ct.Length)
        } finally { $dec.Dispose() }
    } finally { $aes.Dispose() }

    $jsonStr = $Script:Utf8NoBom.GetString($plainBytes)
    $obj = $jsonStr | ConvertFrom-Json
    if ($null -eq $obj) { throw 'invalid json payload' }

    foreach ($reqProp in @('v', 'act', 'p', 'ts', 'nonce', 'origin')) {
        if ($null -eq $obj.PSObject.Properties[$reqProp]) { throw ('missing field: ' + $reqProp) }
    }
    if ([int]$obj.v -ne 1) { throw 'bad payload version' }

    $nowSec = Get-UnixNow
    $ts = [int64]$obj.ts
    if ([Math]::Abs($nowSec - $ts) -gt $Script:MaxSkewSec) { throw 'envelope expired' }

    $origin = ([string]$obj.origin).Trim().ToLowerInvariant()
    $allowed = @(Get-AllowedOrigins)
    if ($allowed -notcontains $origin) { throw ('origin not allowed: ' + $origin) }

    $nonce = [string]$obj.nonce
    if ($nonce -notmatch '^[0-9a-f]{32}$') { throw 'bad nonce format' }
    Assert-NonceFresh $nonce $nowSec $nonceFile

    return @{
        Act   = [int]$obj.act
        Param = [string]$obj.p
    }
}

# ------------------------------------------------------------------ 业务参数校验（纵深防御）
function Test-Title([string]$t) {
    if ([string]::IsNullOrWhiteSpace($t) -or $t.Length -gt 150) { return $false }
    if ($t -match '[\x00-\x1F\x7F\\/:*?"<>|%!^$`]') { return $false }
    if ($t.StartsWith('.') -or $t.EndsWith('.') -or $t.EndsWith(' ')) { return $false }
    return $true
}

function Test-RelPath([string]$p, [string]$ext) {
    if ([string]::IsNullOrWhiteSpace($p) -or $p.Length -gt 260) { return $false }
    if ($p -notmatch '^[\p{L}\p{N}\p{M} _.\-/(),·+]+$') { return $false }
    if ($p -match '(^|/)\.\.?(/|$)') { return $false }
    if ($ext -and -not $p.EndsWith($ext, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    return $true
}

function Test-Block([string]$b)   { $b -match '^[A-Za-z0-9_-]{1,32}$' }
function Test-Http([string]$u)    { ($u.Length -le 2000) -and ($u -match '^https?://[^\s<>"]+$') }
function Test-BmTitle([string]$t) { ($t.Length -le 300) -and ($t -notmatch '[\x00-\x1F\x7F<>|]') }

function Resolve-UnderRoot([string]$base, [string]$rel) {
    $full = [IO.Path]::GetFullPath((Join-Path $base $rel))
    $b = [IO.Path]::GetFullPath($base).TrimEnd('\') + '\'
    if (-not $full.StartsWith($b, [StringComparison]::OrdinalIgnoreCase)) { throw 'path escapes root' }
    return $full
}

function Validate-ActionPayload([int]$act, [string]$p, [bool]$CheckFs) {
    if ($act -lt 1 -or $act -gt 9) { throw 'unknown action' }
    if ($p -match '[\x00-\x1F\x7F]') { throw 'control characters in param' }

    $out = [ordered]@{ ACTION = [string]$act }
    switch ($act) {
        1 {
            if (-not (Test-Title $p)) { throw 'bad title' }
            if ($CheckFs -and -not (Test-Path -LiteralPath (Resolve-UnderRoot (Join-Path $Script:Root 'html') ($p + '.html')) -PathType Leaf)) { throw 'page not found' }
            $out['P_B64'] = ConvertTo-B64 $p
        }
        2 {
            $parts = $p.Split([char[]]@('}'), 3)
            if ($parts.Count -ne 3) { throw 'bad bookmark format' }
            $blk = $parts[0]; $ttl = $parts[1]; $href = $parts[2]
            if (-not (Test-Block $blk)) { throw 'bad block' }
            if (-not (Test-Http $href)) { throw 'href must be http(s)' }
            if ($ttl -eq '') { $ttl = $href }
            if (-not (Test-BmTitle $ttl)) { throw 'bad bookmark title' }
            $out['BLOCK_B64']  = ConvertTo-B64 $blk
            $out['TITLE_B64']  = ConvertTo-B64 $ttl
            $out['HREF_B64']   = ConvertTo-B64 $href
            $out['NEED_TITLE'] = $(if ($ttl -ceq $href -and $blk -ne 'del') { '1' } else { '0' })
        }
        5 {
            if (-not (Test-Title $p)) { throw 'bad title' }
            if ($CheckFs -and -not (Test-Path -LiteralPath (Resolve-UnderRoot (Join-Path $Script:Root 'html') ($p + '.html')) -PathType Leaf)) { throw 'page not found' }
            $out['P_B64'] = ConvertTo-B64 $p
        }
        7 {
            if ($p -notmatch '^[0-9]{1,7}$') { throw 'bad line number' }
            $out['LINE'] = $p
        }
        9 {
            $rel = $p.TrimStart('/')
            if (-not (Test-RelPath $rel '.md')) { throw 'bad md path' }
            $out['P_B64'] = ConvertTo-B64 $rel
        }
        default {
            if ($p -ne '') { throw 'unexpected parameters' }
        }
    }
    return $out
}

function Parse-Request([string]$raw, [bool]$CheckFs) {
    [byte[]]$masterKey = Read-MasterKeyBytes
    $opened = Open-Envelope $raw $masterKey $Script:NoncePath
    return Validate-ActionPayload $opened.Act $opened.Param $CheckFs
}

function Get-FileTarget([string]$kind, [string]$b64) {
    $v = ConvertFrom-B64 $b64
    if ($kind -eq 'html') {
        if (-not (Test-Title $v)) { throw 'bad title' }
        $t = Resolve-UnderRoot (Join-Path $Script:Root 'html') ($v + '.html')
        if (-not (Test-Path -LiteralPath $t -PathType Leaf)) { throw 'page not found' }
        return $t
    }
    if (-not (Test-RelPath $v '.md')) { throw 'bad md path' }
    $t = Resolve-UnderRoot $Script:Root ($v -replace '/', '\')
    if (-not (Test-Path -LiteralPath (Split-Path -Parent $t) -PathType Container)) { throw 'directory not found' }
    return $t
}

# ------------------------------------------------------------------ 自检套件
function Invoke-SelfTest {
    [byte[]]$testKey = Get-RandomBytes 32
    $testNonceFile = Join-Path $env:TEMP ('diff4x_selftest_nonces_' + [Guid]::NewGuid().ToString('N') + '.txt')
    $goodOrigin = (Get-AllowedOrigins)[0]
    $now = Get-UnixNow
    $state = @{ Fail = 0 }

    function Assert-Accept([string]$name, [string]$u) {
        try {
            $o = Open-Envelope $u $testKey $testNonceFile
            [void](Validate-ActionPayload $o.Act $o.Param $false)
            Write-Host "PASS  accept  $name"
        } catch {
            Write-Host "FAIL  accept  $name  ($($_.Exception.Message))"
            $state.Fail++
        }
    }
    function Assert-Reject([string]$name, [string]$u) {
        try {
            $o = Open-Envelope $u $testKey $testNonceFile
            [void](Validate-ActionPayload $o.Act $o.Param $false)
            Write-Host "FAIL  reject  $name"
            $state.Fail++
        } catch {
            Write-Host "PASS  reject  $name  ($($_.Exception.Message))"
        }
    }

    try {
        # 0. 校验 Get-UnixNow 与 UTC 纪元零时区偏差，以及 Hex 密钥编解码往返
        $dtoNow = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        if ([Math]::Abs($now - $dtoNow) -gt 2) {
            Write-Host "FAIL  utc-clock  Get-UnixNow=$now vs UtcNow=$dtoNow"
            $state.Fail++
        } else {
            Write-Host "PASS  utc-clock  now=$now"
        }
        [byte[]]$rtKey = ConvertFrom-Hex (ConvertTo-Hex $testKey)
        if (-not (Test-BytesEqual $testKey $rtKey)) {
            Write-Host "FAIL  hex-roundtrip"
            $state.Fail++
        } else {
            Write-Host "PASS  hex-roundtrip"
        }

        # 1. 合法认证加密信封（含重放拦截与尾斜杠兼容）
        $u1 = Seal-Envelope $testKey 1 '变量,函数' $now (ConvertTo-Hex (Get-RandomBytes 16)) $goodOrigin
        Assert-Accept 'act1-edit' $u1
        Assert-Reject 'act1-replay' $u1

        $u2 = (Seal-Envelope $testKey 2 'a}Title}https://example.com/x?a=1&b=2' $now (ConvertTo-Hex (Get-RandomBytes 16)) $goodOrigin) + '/'
        Assert-Accept 'act2-bookmark-trailing-slash' $u2

        Assert-Accept 'act3-root' (Seal-Envelope $testKey 3 '' $now (ConvertTo-Hex (Get-RandomBytes 16)) $goodOrigin)
        Assert-Reject 'act3-with-param' (Seal-Envelope $testKey 3 '/Dropbox/any' $now (ConvertTo-Hex (Get-RandomBytes 16)) $goodOrigin)
        Assert-Accept 'act4-menu' (Seal-Envelope $testKey 4 '' $now (ConvertTo-Hex (Get-RandomBytes 16)) $goodOrigin)
        Assert-Accept 'act9-md'   (Seal-Envelope $testKey 9 'README.md' $now (ConvertTo-Hex (Get-RandomBytes 16)) $goodOrigin)

        # 2. 彻底拒收旧版明文协议
        Assert-Reject 'plaintext-act1' 'diff4x://1{README'
        Assert-Reject 'plaintext-act4' 'diff4x://4'
        Assert-Reject 'plaintext-act6' 'diff4x://6'

        # 3. 篡改密文 / MAC 必须失败
        $uTamper = Seal-Envelope $testKey 4 '' $now (ConvertTo-Hex (Get-RandomBytes 16)) $goodOrigin
        $tok = $uTamper.Split('.')[1]
        [byte[]]$rawPkt = ConvertFrom-Base64Url $tok
        $rawPkt[20] = $rawPkt[20] -bxor 0x01
        Assert-Reject 'tampered-ct' ('diff4x://env/v1.' + (ConvertTo-Base64Url $rawPkt))

        # 4. 过期时间戳与未来时间戳
        Assert-Reject 'expired-ts' (Seal-Envelope $testKey 4 '' ($now - 45) (ConvertTo-Hex (Get-RandomBytes 16)) $goodOrigin)
        Assert-Reject 'future-ts'  (Seal-Envelope $testKey 4 '' ($now + 45) (ConvertTo-Hex (Get-RandomBytes 16)) $goodOrigin)

        # 5. 非法 Origin（线上站 / 9000 仿真 / DNS Rebinding）
        Assert-Reject 'bad-origin-online'  (Seal-Envelope $testKey 4 '' $now (ConvertTo-Hex (Get-RandomBytes 16)) 'https://diff4x.github.io')
        Assert-Reject 'bad-origin-sim9000' (Seal-Envelope $testKey 4 '' $now (ConvertTo-Hex (Get-RandomBytes 16)) 'http://localhost:9000')
        Assert-Reject 'bad-origin-rebind'  (Seal-Envelope $testKey 4 '' $now (ConvertTo-Hex (Get-RandomBytes 16)) 'http://evil.com:8000')

        # 6. 纵深防御：合法信封内嵌非法业务参数仍须拦截
        Assert-Reject 'signed-path-traversal' (Seal-Envelope $testKey 9 '../secret.md' $now (ConvertTo-Hex (Get-RandomBytes 16)) $goodOrigin)
        Assert-Reject 'signed-js-href'        (Seal-Envelope $testKey 2 'a}t}javascript:alert(1)' $now (ConvertTo-Hex (Get-RandomBytes 16)) $goodOrigin)
        Assert-Reject 'signed-bad-line'       (Seal-Envelope $testKey 7 '12;calc' $now (ConvertTo-Hex (Get-RandomBytes 16)) $goodOrigin)
    } finally {
        if (Test-Path -LiteralPath $testNonceFile) {
            Remove-Item -LiteralPath $testNonceFile -Force -ErrorAction SilentlyContinue
        }
    }

    if ($state.Fail -gt 0) { Write-Host "SelfTest: $($state.Fail) 项失败"; exit 1 }
    Write-Host 'SelfTest: 全部通过'
}

# ------------------------------------------------------------------ 模式分发
try {
    switch ($Mode) {
        'SelfTest' { Invoke-SelfTest; return }

        'EnsureKey' {
            [Console]::OutputEncoding = $Script:Utf8NoBom
            [Console]::Out.Write((Get-OrCreateMasterKeyHex ([bool]$Rotate)))
        }

        'Emit' {
            $r = Parse-Request $env:CLI_RAW $true
            foreach ($k in $r.Keys) { Write-Output ('{0}={1}' -f $k, $r[$k]) }
            Write-Output 'OK=1'
        }

        'Launch' {
            $r = Parse-Request $Url $true
            foreach ($k in $r.Keys) { Set-Item -LiteralPath ('Env:G_' + $k) -Value ([string]$r[$k]) }
            $env:G_OK = '1'
            $proc = Start-Process -FilePath $env:ComSpec -ArgumentList ('/d /c ""{0}" __proto"' -f $Script:Bat) -Wait -PassThru -NoNewWindow
            exit $proc.ExitCode
        }

        'Decode' {
            [Console]::OutputEncoding = $Script:Utf8NoBom
            [Console]::Out.Write((ConvertFrom-B64 $env:CLI_DEC_IN))
        }

        'Compose' {
            $blk  = ConvertFrom-B64 $env:CLI_BLOCK_B64
            $ttl  = ConvertFrom-B64 $env:CLI_TITLE_B64
            $href = ConvertFrom-B64 $env:CLI_HREF_B64
            if ($env:G_NEED_TITLE -eq '1') { $ttl = [string]$env:CLI_TITLE3 }
            if (-not (Test-Block $blk) -or -not (Test-Http $href) -or -not (Test-BmTitle $ttl)) { throw 'invalid bookmark fields' }
            Write-Output (ConvertTo-B64 ($blk + '|' + $ttl + '|' + $href))
        }

        'WriteClipboard' {
            Add-Type -AssemblyName System.Windows.Forms
            $target = Get-FileTarget $Kind $env:CLI_DEC_IN
            $txt = [Windows.Forms.Clipboard]::GetText()
            if ([string]::IsNullOrEmpty($txt)) { Write-Host '[ERROR] 剪贴板为空，已放弃写入'; exit 3 }
            $enc = $(if ($Kind -eq 'html') { $Script:Utf8Bom } else { $Script:Utf8NoBom })
            $tmp = $target + '.tmp'
            [IO.File]::WriteAllText($tmp, $txt, $enc)
            Move-Item -LiteralPath $tmp -Destination $target -Force
            [Windows.Forms.Clipboard]::Clear()
        }

        'OpenFolder' {
            if (-not (Test-Path -LiteralPath $Script:Root -PathType Container)) { throw 'root folder not found' }
            Start-Process -FilePath 'explorer.exe' -ArgumentList ('"{0}"' -f $Script:Root)
        }
    }
}
catch {
    $errMsg = $_.Exception.Message
    [Console]::Error.WriteLine('[protocol_guard] 已拒绝: ' + $errMsg)
    try {
        $logPath = Join-Path $env:TEMP 'diff4x_proto_reject.log'
        $stamp = [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')
        [IO.File]::AppendAllText($logPath, ("[{0}] Mode={1} Rejected: {2}`r`n" -f $stamp, $Mode, $errMsg), $Script:Utf8NoBom)
    } catch { }
    exit 2
}
