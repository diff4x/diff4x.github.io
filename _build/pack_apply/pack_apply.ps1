<#
 pack_apply.ps1 —— 独立版 AI 协作双向按层级打包与一键回填工具（WinForms 目录树复选框）
 目录位置：_build/pack_apply/（与 CLI.bat 完全解耦，零外部依赖，兼容 Windows PowerShell 5.1）

 功能：
   1. [打包给 AI (Pack)]
      - 带复选框目录树（TreeView），父子联动勾选、实时关键词筛选、保留跨筛选勾选状态。
      - 支持场景预设（_build/pack_apply/presets.json）、一键勾选 Git 改动文件、窗口或图标拖放自动勾选。
      - 硬隔离隐私：自动拦截 .git、_build/secrets、_build/backup、html/__*.html、shadow* 及 .gitignore 忽略文件。
      - 自动按仓库相对层级打包至 _build/backup/ai_pack_YYYYMMDD_HHmmss.zip，并在资源管理器中选中。
   2. [回填 AI 补丁 (Apply)]
      - 自动列出系统「下载」目录最新 .zip，也支持浏览选择或直接拖放 .zip 到窗口 / pack_apply.bat。
      - 目录树复选框预览每个条目状态：[覆盖] / [新增] / [说明-默认跳过] / [敏感-需手动确认] / [拦截]。
      - 防 Zip Slip 路径穿越，硬拦截 .git/，软保护 _build/secrets/。
      - 回填前按原相对层级自动备份至 _build/backup/ai_apply_YYYYMMDD_HHmmss/（含回滚清单）。
      - 自动守卫编码：.bat/.cmd 强制 UTF-8 无 BOM + CRLF；.ps1 强制 UTF-8 BOM + CRLF；其余原样写入。
      - 支持 [从备份回滚...] 一键还原被覆盖文件并清理当时新增文件。
#>
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$DropPaths = @()
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

[System.Windows.Forms.Application]::EnableVisualStyles()

$Script:ToolDir     = $PSScriptRoot
$Script:BuildDir    = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Script:Root        = [IO.Path]::GetFullPath((Join-Path $Script:BuildDir '..'))
$Script:RootPrefix  = $Script:Root.TrimEnd('\') + '\'
$Script:PresetsPath = Join-Path $Script:ToolDir 'presets.json'
$Script:BackupRoot  = Join-Path $Script:BuildDir 'backup'
$Script:Utf8NoBom   = New-Object System.Text.UTF8Encoding($false)
$Script:Utf8Bom     = New-Object System.Text.UTF8Encoding($true)

# 默认视图隐藏的大体积/产物目录（勾选「显示更多目录」可浏览其中非私密内容）
$Script:DefaultHiddenDirs = @(
    'gallery', 'video', 'audio', 'ebook', 'html',
    'src/third', 'src/wasm', 'src/js/data', 'src/js/source-map', 'src/css/source-map',
    '_build/esbuild', '_build/libwebp', '_build/woff2_split', '_build/server'
)
# 默认视图中即使位于隐藏目录也强制白名单可见的常用文件
$Script:AlwaysShowFiles = @(
    'src/third/pdfjs/web/viewer.mjs',
    'src/third/bibi/presets/default.js',
    '_build/server/sws.toml',
    '_build/server/sws-sim.toml'
)
# 打包阶段硬拦截的目录前缀（永远不允许误传给 AI）
$Script:HardBlockedPackPrefixes = @(
    '.git/', '_build/secrets/', '_build/backup/', 'node_modules/', '_build/rs/target/'
)
# 打包阶段默认排除的产物扩展名或路径模式
$Script:DefaultExcludedPackRegex = '^(src/js/[^/]+\.js|src/css/[^/]+\.css|sw\.js|src/js/data/shadow.*|html/__.*\.html|.*\.map|.*\.exe|.*\.dll|.*\.jar|.*\.wasm|.*\.zip|.*\.png|.*\.jpg|.*\.jpeg|.*\.webp|.*\.gif|.*\.mp3|.*\.mp4|.*\.mkv|.*\.pdf|.*\.epub|.*\.woff2?)$'

# ------------------------------------------------------------------ 通用工具函数
function Format-ByteSize([int64]$bytes) {
    if ($bytes -lt 1024) { return "$bytes B" }
    if ($bytes -lt 1048576) { return ('{0:N1} KB' -f ($bytes / 1024.0)) }
    return ('{0:N2} MB' -f ($bytes / 1048576.0))
}

function Get-RelPath([string]$fullPath) {
    $norm = [IO.Path]::GetFullPath($fullPath)
    if (-not $norm.StartsWith($Script:RootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        return $null
    }
    return $norm.Substring($Script:RootPrefix.Length).Replace('\', '/')
}

function Resolve-SafeTarget([string]$relEntry) {
    if ([string]::IsNullOrWhiteSpace($relEntry)) { return $null }
    $clean = $relEntry.Replace('\', '/').Trim()
    if ($clean.StartsWith('/') -or $clean -match '^[A-Za-z]:') { return $null }
    if ($clean -match '[\x00-\x1F\x7F:*?"<>|]') { return $null }
    $segs = $clean.Split('/')
    foreach ($seg in $segs) {
        if ($seg -eq '' -or $seg -eq '.' -or $seg -eq '..') { return $null }
    }
    $full = [IO.Path]::GetFullPath((Join-Path $Script:Root ($clean.Replace('/', '\'))))
    if (-not $full.StartsWith($Script:RootPrefix, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    return @{ Rel = $clean; Full = $full }
}

function Test-HardPrivateRel([string]$rel) {
    $low = $rel.ToLowerInvariant()
    foreach ($pfx in $Script:HardBlockedPackPrefixes) {
        if ($low.StartsWith($pfx)) { return $true }
    }
    if ($low -match '^html/__.*\.html$') { return $true }
    if ($low -match '^src/js/data/shadow') { return $true }
    if ($low -match '(^|/)protocol\.key$' -or $low -match '(^|/)credentials\.json$') { return $true }
    return $false
}

function Get-GitIgnoredSet([string[]]$relPaths) {
    $set = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    if ($null -eq $relPaths -or $relPaths.Count -eq 0) { return ,$set }
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'git'
        $psi.Arguments = 'check-ignore --no-index --stdin'
        $psi.WorkingDirectory = $Script:Root
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = $Script:Utf8NoBom

        $proc = [System.Diagnostics.Process]::Start($psi)
        $sw = New-Object System.IO.StreamWriter($proc.StandardInput.BaseStream, $Script:Utf8NoBom)
        foreach ($p in $relPaths) { $sw.WriteLine($p) }
        $sw.Flush()
        $sw.Close()

        $outText = $proc.StandardOutput.ReadToEnd()
        $proc.WaitForExit(5000) | Out-Null
        foreach ($line in ($outText -split "`r?`n")) {
            $t = $line.Trim().Trim('"').Replace('\', '/')
            if ($t) { [void]$set.Add($t) }
        }
    } catch { }
    return ,$set
}

function Get-GitModifiedFiles {
    $list = New-Object System.Collections.Generic.List[string]
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'git'
        $psi.Arguments = '-c core.quotepath=false status --porcelain'
        $psi.WorkingDirectory = $Script:Root
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = $Script:Utf8NoBom
        $proc = [System.Diagnostics.Process]::Start($psi)
        $outText = $proc.StandardOutput.ReadToEnd()
        $proc.WaitForExit(5000) | Out-Null
        foreach ($line in ($outText -split "`r?`n")) {
            if ($line.Length -lt 4) { continue }
            $status = $line.Substring(0, 2)
            if ($status -match 'D') { continue }
            $p = $line.Substring(3).Trim()
            if ($p -match ' -> ') { $p = ($p -split ' -> ')[-1].Trim() }
            $p = $p.Trim('"').Replace('\', '/')
            if ($p -and -not (Test-HardPrivateRel $p)) {
                $full = Join-Path $Script:Root ($p.Replace('/', '\'))
                if (Test-Path -LiteralPath $full -PathType Leaf) {
                    $list.Add($p)
                }
            }
        }
    } catch { }
    return ,($list.ToArray())
}

function Load-PresetsConfig {
    $fallback = @{
        skipApplyDocRegex = '^(APPLY_AND_VERIFY|UPGRADE_.*|PATCH_NOTES|README_PATCH)\.md$'
        presets = @()
    }
    if (-not (Test-Path -LiteralPath $Script:PresetsPath -PathType Leaf)) { return $fallback }
    try {
        $raw = [IO.File]::ReadAllText($Script:PresetsPath, $Script:Utf8NoBom)
        $obj = $raw | ConvertFrom-Json
        if ($null -eq $obj) { return $fallback }
        return @{
            skipApplyDocRegex = $(if ($obj.PSObject.Properties['skipApplyDocRegex'] -and $obj.skipApplyDocRegex) { [string]$obj.skipApplyDocRegex } else { $fallback.skipApplyDocRegex })
            presets = $(if ($obj.PSObject.Properties['presets'] -and $obj.presets) { @($obj.presets) } else { @() })
        }
    } catch {
        return $fallback
    }
}

function Scan-RepoFiles([bool]$includeHiddenDirs) {
    $files = New-Object System.Collections.Generic.List[hashtable]
    $alwaysSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($f in $Script:AlwaysShowFiles) { [void]$alwaysSet.Add($f) }

    $queue = New-Object System.Collections.Generic.Queue[string]
    $queue.Enqueue($Script:Root)

    while ($queue.Count -gt 0) {
        $dir = $queue.Dequeue()
        $subDirs = @()
        try { $subDirs = [IO.Directory]::GetDirectories($dir) } catch { continue }
        foreach ($sd in $subDirs) {
            $relDir = (Get-RelPath $sd)
            if (-not $relDir) { continue }
            $relDirSlash = $relDir + '/'
            if (Test-HardPrivateRel $relDirSlash) { continue }
            $skipSub = $false
            if (-not $includeHiddenDirs) {
                foreach ($hd in $Script:DefaultHiddenDirs) {
                    if ($relDir -ieq $hd) {
                        # 仅当白名单文件位于此目录下时仍需向下探测
                        $hasWhite = $false
                        foreach ($wf in $Script:AlwaysShowFiles) {
                            if ($wf.StartsWith($relDirSlash, [StringComparison]::OrdinalIgnoreCase)) { $hasWhite = $true; break }
                        }
                        if (-not $hasWhite) { $skipSub = $true }
                        break
                    }
                }
            }
            if (-not $skipSub) { $queue.Enqueue($sd) }
        }

        $subFiles = @()
        try { $subFiles = [IO.Directory]::GetFiles($dir) } catch { continue }
        foreach ($sf in $subFiles) {
            $rel = Get-RelPath $sf
            if (-not $rel) { continue }
            if (Test-HardPrivateRel $rel) { continue }

            $inAlways = $alwaysSet.Contains($rel)
            if (-not $includeHiddenDirs -and -not $inAlways) {
                $inHidden = $false
                foreach ($hd in $Script:DefaultHiddenDirs) {
                    if ($rel.StartsWith($hd + '/', [StringComparison]::OrdinalIgnoreCase)) { $inHidden = $true; break }
                }
                if ($inHidden) { continue }
                if ($rel -imatch $Script:DefaultExcludedPackRegex) { continue }
            }

            $fi = New-Object System.IO.FileInfo($sf)
            $files.Add(@{ Rel = $rel; Full = $sf; Size = [int64]$fi.Length })
        }
    }

    # 用 git check-ignore 过滤 .gitignore 私有文件（oov_report.txt 除外，允许用户手动调优同义词时勾选）
    $allRels = @()
    foreach ($f in $files) { $allRels += $f.Rel }
    $ignored = Get-GitIgnoredSet $allRels

    $filtered = New-Object System.Collections.Generic.List[hashtable]
    foreach ($f in $files) {
        if ($ignored.Contains($f.Rel) -and $f.Rel -ine '_build/synonyms/oov_report.txt') {
            continue
        }
        $filtered.Add($f)
    }
    return ,$filtered
}

function Resolve-PresetPaths($preset, [System.Collections.Generic.List[hashtable]]$allRepoFiles) {
    $matched = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    if ($preset.PSObject.Properties['paths'] -and $preset.paths) {
        foreach ($p in @($preset.paths)) {
            $rel = ([string]$p).Replace('\', '/').TrimStart('/')
            if (Test-HardPrivateRel $rel) { continue }
            $full = Join-Path $Script:Root ($rel.Replace('/', '\'))
            if (Test-Path -LiteralPath $full -PathType Leaf) {
                [void]$matched.Add($rel)
            }
        }
    }
    if ($preset.PSObject.Properties['globs'] -and $preset.globs) {
        foreach ($g in @($preset.globs)) {
            $pat = '^' + ([regex]::Escape(([string]$g).Replace('\', '/')).Replace('\*\*', '.*').Replace('\*', '[^/]*').Replace('\?', '.')) + '$'
            foreach ($f in $allRepoFiles) {
                if ($f.Rel -imatch $pat) { [void]$matched.Add($f.Rel) }
            }
        }
    }
    return ,$matched
}

function Write-FileWithEncodingGuard([string]$targetFull, [byte[]]$rawBytes, [bool]$fixWinEncoding) {
    $parent = Split-Path -Parent $targetFull
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        [void][IO.Directory]::CreateDirectory($parent)
    }
    $ext = ([IO.Path]::GetExtension($targetFull)).ToLowerInvariant()
    $bytesToWrite = $rawBytes
    if ($fixWinEncoding -and ($ext -eq '.bat' -or $ext -eq '.cmd' -or $ext -eq '.ps1')) {
        # 去除可能存在的 UTF-8 BOM 后统一转为 CRLF
        $startIdx = 0
        if ($rawBytes.Length -ge 3 -and $rawBytes[0] -eq 0xEF -and $rawBytes[1] -eq 0xBB -and $rawBytes[2] -eq 0xBF) {
            $startIdx = 3
        }
        $text = $Script:Utf8NoBom.GetString($rawBytes, $startIdx, $rawBytes.Length - $startIdx)
        $text = ($text -replace "`r`n", "`n" -replace "`r", "`n") -replace "`n", "`r`n"
        if ($ext -eq '.ps1') {
            $body = $Script:Utf8NoBom.GetBytes($text)
            $bytesToWrite = New-Object byte[] ($body.Length + 3)
            $bytesToWrite[0] = 0xEF; $bytesToWrite[1] = 0xBB; $bytesToWrite[2] = 0xBF
            [System.Buffer]::BlockCopy($body, 0, $bytesToWrite, 3, $body.Length)
        } else {
            $bytesToWrite = $Script:Utf8NoBom.GetBytes($text)
        }
    }
    $tmp = $targetFull + '.aisync.tmp'
    [IO.File]::WriteAllBytes($tmp, $bytesToWrite)
    if (Test-Path -LiteralPath $targetFull -PathType Leaf) {
        [IO.File]::Copy($tmp, $targetFull, $true)
        [IO.File]::Delete($tmp)
    } else {
        [IO.File]::Move($tmp, $targetFull)
    }
}

# ------------------------------------------------------------------ 三态目录树复选框（未选 / 全选打勾 / 部分选中填色不打勾 / 禁止）
$Script:STATE_UNCHECKED = 0
$Script:STATE_CHECKED   = 1
$Script:STATE_PARTIAL   = 2
$Script:STATE_BLOCKED   = 3

$Script:UiDisposables = New-Object System.Collections.Generic.List[System.IDisposable]

function New-TriStateCheckImageList {
    $il = New-Object System.Windows.Forms.ImageList
    $il.ImageSize = New-Object System.Drawing.Size(16, 16)
    $il.ColorDepth = [System.Windows.Forms.ColorDepth]::Depth32Bit
    $il.TransparentColor = [System.Drawing.Color]::Transparent
    $Script:UiDisposables.Add($il)

    # ==============================================================
    # Fluent / Windows 风格配色
    # ==============================================================
    $cBlue       = [System.Drawing.Color]::FromArgb(0, 120, 212)      # Windows 蓝
    $cBlueHover  = [System.Drawing.Color]::FromArgb(0, 103, 192)
    $cBlueLight  = [System.Drawing.Color]::FromArgb(232, 244, 253)    # 部分选中底色

    $cBorder     = [System.Drawing.Color]::FromArgb(125, 125, 125)   # 未选边框
    $cBorderSoft = [System.Drawing.Color]::FromArgb(150, 150, 150)

    $cDisabledBg = [System.Drawing.Color]::FromArgb(242, 242, 242)
    $cDisabledBd = [System.Drawing.Color]::FromArgb(190, 190, 190)
    $cDisabledFg = [System.Drawing.Color]::FromArgb(150, 150, 150)

    for ($mode = 0; $mode -le 3; $mode++) {

        $bmp = New-Object System.Drawing.Bitmap(
            16,
            16,
            [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
        )

        $g = [System.Drawing.Graphics]::FromImage($bmp)

        try {
            $g.Clear([System.Drawing.Color]::Transparent)

            # 小尺寸 checkbox 不建议使用过度抗锯齿。
            # 这样边框会更加清晰。
            $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

            # ------------------------------------------------------
            # checkbox 几何尺寸
            #
            # 16x16 图标中使用 13x13 的主体，
            # 四周各留约 1~2px 呼吸空间。
            # ------------------------------------------------------
            $x = 1.5
            $y = 1.5
            $w = 13
            $h = 13

            switch ($mode) {

                # ==================================================
                # 0 - 未选
                # ==================================================
                0 {
                    $bg = New-Object System.Drawing.SolidBrush(
                        [System.Drawing.Color]::White
                    )

                    $bd = New-Object System.Drawing.Pen(
                        $cBorder,
                        [float]1
                    )

                    try {
                        $g.FillRectangle($bg, $x, $y, $w, $h)
                        $g.DrawRectangle($bd, $x, $y, $w - 1, $h - 1)
                    }
                    finally {
                        $bg.Dispose()
                        $bd.Dispose()
                    }
                }

                # ==================================================
                # 1 - 全选
                #
                # 蓝色实心 + 白色对勾
                # ==================================================
                1 {
                    $bg = New-Object System.Drawing.SolidBrush(
                        $cBlue
                    )

                    $ck = New-Object System.Drawing.Pen(
                        [System.Drawing.Color]::White,
                        [float]2
                    )

                    $ck.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
                    $ck.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
                    $ck.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

                    try {
                        $g.FillRectangle($bg, $x, $y, $w, $h)

                        # 更紧凑、更容易辨认的 ✓
                        $pts = [System.Drawing.PointF[]]@(
                            (New-Object System.Drawing.PointF(
                                [float]4.0,
                                [float]8.0
                            )),
                            (New-Object System.Drawing.PointF(
                                [float]6.5,
                                [float]10.3
                            )),
                            (New-Object System.Drawing.PointF(
                                [float]11.5,
                                [float]5.2
                            ))
                        )

                        $g.DrawLines($ck, $pts)
                    }
                    finally {
                        $bg.Dispose()
                        $ck.Dispose()
                    }
                }

                # ==================================================
                # 2 - 部分选中
                #
                # 浅蓝底 + 蓝色横杠
                #
                # 不使用“实心蓝块”。
                # 横杠是三态 checkbox 最容易理解的视觉符号。
                # ==================================================
                2 {
                    $bg = New-Object System.Drawing.SolidBrush(
                        $cBlueLight
                    )

                    $bd = New-Object System.Drawing.Pen(
                        $cBlue,
                        [float]1
                    )

                    $dash = New-Object System.Drawing.Pen(
                        $cBlue,
                        [float]2
                    )

                    $dash.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
                    $dash.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round

                    try {
                        $g.FillRectangle($bg, $x, $y, $w, $h)
                        $g.DrawRectangle($bd, $x, $y, $w - 1, $h - 1)

                        # 中间横杠
                        $g.DrawLine(
                            $dash,
                            [float]4.2,
                            [float]8,
                            [float]11.2,
                            [float]8
                        )
                    }
                    finally {
                        $bg.Dispose()
                        $bd.Dispose()
                        $dash.Dispose()
                    }
                }

                # ==================================================
                # 3 - 禁止 / 不可选
                #
                # 灰底 + 灰框 + 灰色横杠
                #
                # 不使用红色，避免让“禁止”看起来像错误。
                # ==================================================
                3 {
                    $bg = New-Object System.Drawing.SolidBrush(
                        $cDisabledBg
                    )

                    $bd = New-Object System.Drawing.Pen(
                        $cDisabledBd,
                        [float]1
                    )

                    $mark = New-Object System.Drawing.Pen(
                        $cDisabledFg,
                        [float]1.5
                    )

                    $mark.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
                    $mark.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round

                    try {
                        $g.FillRectangle($bg, $x, $y, $w, $h)
                        $g.DrawRectangle($bd, $x, $y, $w - 1, $h - 1)

                        $g.DrawLine(
                            $mark,
                            [float]4.5,
                            [float]8,
                            [float]10.5,
                            [float]8
                        )
                    }
                    finally {
                        $bg.Dispose()
                        $bd.Dispose()
                        $mark.Dispose()
                    }
                }
            }
        }
        finally {
            $g.Dispose()
        }

        [void]$il.Images.Add($bmp)
        $Script:UiDisposables.Add($bmp)
    }

    return $il
}

function Get-FolderAggregateState([System.Windows.Forms.TreeNode]$dirNode) {
    $hasEnabled = $false
    $hasChecked = $false
    $hasUnchecked = $false
    $hasPartial = $false
    foreach ($c in $dirNode.Nodes) {
        if ($c.Tag -and $c.Tag.Blocked) { continue }
        $hasEnabled = $true
        $st = $c.StateImageIndex
        if ($st -eq $Script:STATE_PARTIAL) { $hasPartial = $true }
        elseif ($st -eq $Script:STATE_CHECKED) { $hasChecked = $true }
        else { $hasUnchecked = $true }
    }
    if (-not $hasEnabled) { return $Script:STATE_UNCHECKED }
    if ($hasPartial -or ($hasChecked -and $hasUnchecked)) { return $Script:STATE_PARTIAL }
    if ($hasChecked) { return $Script:STATE_CHECKED }
    return $Script:STATE_UNCHECKED
}

function Set-SubtreeState([System.Windows.Forms.TreeNode]$node, [int]$targetState, [System.Collections.Generic.HashSet[string]]$checkedSet) {
    if ($node.Tag -and $node.Tag.Blocked) {
        $node.StateImageIndex = $Script:STATE_BLOCKED
        return
    }
    if ($node.Tag -and $node.Tag.IsFile) {
        $node.StateImageIndex = $targetState
        if ($null -ne $checkedSet) {
            if ($targetState -eq $Script:STATE_CHECKED) { [void]$checkedSet.Add($node.Tag.Rel) }
            else { [void]$checkedSet.Remove($node.Tag.Rel) }
        }
        return
    }
    foreach ($child in $node.Nodes) {
        if ($child.Tag -and $child.Tag.Blocked) { continue }
        Set-SubtreeState $child $targetState $checkedSet
    }
    $node.StateImageIndex = Get-FolderAggregateState $node
}

function Update-ParentNodesState([System.Windows.Forms.TreeNode]$node) {
    $parent = $node.Parent
    while ($null -ne $parent) {
        $parent.StateImageIndex = Get-FolderAggregateState $parent
        $parent = $parent.Parent
    }
}

function Toggle-TreeNodeState(
    [System.Windows.Forms.TreeNode]$node,
    [System.Collections.Generic.HashSet[string]]$checkedSet,
    [scriptblock]$onChanged
) {
    if ($null -eq $node -or ($node.Tag -and $node.Tag.Blocked)) { return }
    # 当前为全选 -> 改为未选；当前为未选或部分选中 -> 改为全选
    $nextState = $(if ($node.StateImageIndex -eq $Script:STATE_CHECKED) { $Script:STATE_UNCHECKED } else { $Script:STATE_CHECKED })
    Set-SubtreeState $node $nextState $checkedSet
    Update-ParentNodesState $node
    if ($null -ne $onChanged) { & $onChanged }
}

function Bind-TriStateTreeEvents(
    [System.Windows.Forms.TreeView]$tv,
    [System.Collections.Generic.HashSet[string]]$checkedSet,
    [scriptblock]$onChanged
) {
    $tv.CheckBoxes = $false
    $tv.StateImageList = New-TriStateCheckImageList
    $tv.ItemHeight = 20
    $tv.Tag = @{
        CheckedSet = $checkedSet
        OnChanged  = $onChanged
        LastClick  = [DateTime]::MinValue
    }

    $tv.Add_MouseDown({
        param($s, $e)
        if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
        $ht = $s.HitTest($e.Location)
        if ($null -ne $ht.Node -and $ht.Location -eq [System.Windows.Forms.TreeViewHitTestLocations]::StateImage) {
            $ctx = $s.Tag
            $ctx.LastClick = [DateTime]::UtcNow
            $s.SelectedNode = $ht.Node
            Toggle-TreeNodeState $ht.Node $ctx.CheckedSet $ctx.OnChanged
        }
    })

    # 防止快速连点目录复选框时触发 WinForms 默认双击展开/折叠
    $guardExpand = {
        param($s, $e)
        $ctx = $s.Tag
        if ($null -ne $ctx -and (([DateTime]::UtcNow - $ctx.LastClick).TotalMilliseconds -lt 380)) {
            $e.Cancel = $true
        }
    }
    $tv.Add_BeforeExpand($guardExpand)
    $tv.Add_BeforeCollapse($guardExpand)

    $tv.Add_KeyDown({
        param($s, $e)
        if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Space -and $null -ne $s.SelectedNode) {
            $e.Handled = $true
            $e.SuppressKeyPress = $true
            $ctx = $s.Tag
            Toggle-TreeNodeState $s.SelectedNode $ctx.CheckedSet $ctx.OnChanged
        }
    })
}

function Populate-TreeViewFromItems(
    [System.Windows.Forms.TreeView]$tv,
    [System.Collections.IList]$items,
    [System.Collections.Generic.HashSet[string]]$checkedSet,
    [bool]$expandAll
) {
    $tv.BeginUpdate()
    try {
        $tv.Nodes.Clear()
        $dirMap = @{}

        # 排序：按路径目录优先，字母序
        $sorted = @($items | Sort-Object { $_.Rel })
        foreach ($it in $sorted) {
            $rel = [string]$it.Rel
            $parts = $rel.Split('/')
            $parentCol = $tv.Nodes
            $accPath = ''

            for ($i = 0; $i -lt ($parts.Length - 1); $i++) {
                $seg = $parts[$i]
                $accPath = $(if ($accPath) { $accPath + '/' + $seg } else { $seg })
                if (-not $dirMap.ContainsKey($accPath)) {
                    $dn = New-Object System.Windows.Forms.TreeNode("$seg")
                    $dn.Tag = @{ IsFile = $false; Rel = $accPath; Blocked = $false }
                    $dn.ForeColor = [System.Drawing.Color]::FromArgb(30, 64, 175)
                    $dn.StateImageIndex = $Script:STATE_UNCHECKED
                    [void]$parentCol.Add($dn)
                    $dirMap[$accPath] = $dn
                }
                $parentCol = $dirMap[$accPath].Nodes
            }

            $fileName = $parts[$parts.Length - 1]
            $label = $(if ($it.ContainsKey('Label')) { $it.Label } else { "$fileName  ($(Format-ByteSize $it.Size))" })
            $fn = New-Object System.Windows.Forms.TreeNode($label)
            $isBlocked = [bool]($it.ContainsKey('Blocked') -and $it.Blocked)
            $fn.Tag = @{
                IsFile  = $true
                Rel     = $rel
                Size    = [int64]$it.Size
                Blocked = $isBlocked
                Status  = $(if ($it.ContainsKey('Status')) { $it.Status } else { '' })
            }
            if ($it.ContainsKey('Color') -and $null -ne $it.Color) {
                $fn.ForeColor = $it.Color
            }
            if ($isBlocked) {
                $fn.StateImageIndex = $Script:STATE_BLOCKED
            } elseif ($null -ne $checkedSet -and $checkedSet.Contains($rel)) {
                $fn.StateImageIndex = $Script:STATE_CHECKED
            } else {
                $fn.StateImageIndex = $Script:STATE_UNCHECKED
            }
            [void]$parentCol.Add($fn)
        }

        # 自底向上同步全部目录节点三态（0=未选，1=全选打勾，2=部分选中填色不打勾）
        function Sync-FolderTriState([System.Windows.Forms.TreeNodeCollection]$nodes) {
            foreach ($n in $nodes) {
                if ($n.Nodes.Count -gt 0) {
                    Sync-FolderTriState $n.Nodes
                    $n.StateImageIndex = Get-FolderAggregateState $n
                }
            }
        }
        Sync-FolderTriState $tv.Nodes

        if ($expandAll) {
            $tv.ExpandAll()
        } else {
            # 默认展开第一层目录
            foreach ($n in $tv.Nodes) { $n.Expand() }
        }
        if ($tv.Nodes.Count -gt 0) { $tv.Nodes[0].EnsureVisible() }
    } finally {
        $tv.EndUpdate()
    }
}

# ------------------------------------------------------------------ 主窗口构建
$cfg = Load-PresetsConfig
$Script:AllPackFiles = Scan-RepoFiles $false
$Script:PackFileMap = @{}
foreach ($f in $Script:AllPackFiles) { $Script:PackFileMap[$f.Rel.ToLowerInvariant()] = $f }
$Script:PackChecked = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

$Script:ApplyZipPath = ''
$Script:ApplyEntries = New-Object System.Collections.Generic.List[hashtable]
$Script:ApplyChecked = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

$form = New-Object System.Windows.Forms.Form
$form.Text = "AI 协作同步工具 — 按层级打包 & 一键回填  [$($Script:Root)]"
$form.Size = New-Object System.Drawing.Size(920, 680)
$form.MinimumSize = New-Object System.Drawing.Size(760, 520)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5)
$form.AllowDrop = $true

$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Dock = 'Fill'
$form.Controls.Add($tabs)

# ==================================================================
# TAB 1: 打包给 AI (Pack)
# ==================================================================
$tabPack = New-Object System.Windows.Forms.TabPage('📦 打包给 AI (Pack)')
$tabPack.Padding = New-Object System.Windows.Forms.Padding(8)
$tabs.TabPages.Add($tabPack)

$packTop = New-Object System.Windows.Forms.Panel
$packTop.Dock = 'Top'
$packTop.Height = 76
$tabPack.Controls.Add($packTop)

# Row 1: 预设 & Git 改动
$lblPreset = New-Object System.Windows.Forms.Label
$lblPreset.Text = '场景预设:'
$lblPreset.Location = New-Object System.Drawing.Point(2, 8)
$lblPreset.AutoSize = $true
$packTop.Controls.Add($lblPreset)

$cmbPreset = New-Object System.Windows.Forms.ComboBox
$cmbPreset.DropDownStyle = 'DropDownList'
$cmbPreset.Location = New-Object System.Drawing.Point(72, 4)
$cmbPreset.Width = 280
foreach ($pr in $cfg.presets) { [void]$cmbPreset.Items.Add([string]$pr.name) }
if ($cmbPreset.Items.Count -gt 0) { $cmbPreset.SelectedIndex = 0 }
$packTop.Controls.Add($cmbPreset)

$btnPresetOnly = New-Object System.Windows.Forms.Button
$btnPresetOnly.Text = '仅选此预设'
$btnPresetOnly.Location = New-Object System.Drawing.Point(360, 3)
$btnPresetOnly.Size = New-Object System.Drawing.Size(88, 26)
$packTop.Controls.Add($btnPresetOnly)

$btnPresetAdd = New-Object System.Windows.Forms.Button
$btnPresetAdd.Text = '累加勾选'
$btnPresetAdd.Location = New-Object System.Drawing.Point(454, 3)
$btnPresetAdd.Size = New-Object System.Drawing.Size(78, 26)
$packTop.Controls.Add($btnPresetAdd)

$btnGitMod = New-Object System.Windows.Forms.Button
$btnGitMod.Text = '勾选 Git 改动'
$btnGitMod.Location = New-Object System.Drawing.Point(540, 3)
$btnGitMod.Size = New-Object System.Drawing.Size(102, 26)
$packTop.Controls.Add($btnGitMod)

$chkMoreDirs = New-Object System.Windows.Forms.CheckBox
$chkMoreDirs.Text = '显示更多目录 (html/third等)'
$chkMoreDirs.Location = New-Object System.Drawing.Point(652, 6)
$chkMoreDirs.AutoSize = $true
$packTop.Controls.Add($chkMoreDirs)

# Row 2: 搜索过滤 + 展开/折叠/清空
$lblFilter = New-Object System.Windows.Forms.Label
$lblFilter.Text = '搜索过滤:'
$lblFilter.Location = New-Object System.Drawing.Point(2, 44)
$lblFilter.AutoSize = $true
$packTop.Controls.Add($lblFilter)

$txtFilter = New-Object System.Windows.Forms.TextBox
$txtFilter.Location = New-Object System.Drawing.Point(72, 40)
$txtFilter.Width = 280
$packTop.Controls.Add($txtFilter)

$btnClearFilter = New-Object System.Windows.Forms.Button
$btnClearFilter.Text = '清空过滤'
$btnClearFilter.Location = New-Object System.Drawing.Point(360, 39)
$btnClearFilter.Size = New-Object System.Drawing.Size(74, 26)
$packTop.Controls.Add($btnClearFilter)

$btnExpandPack = New-Object System.Windows.Forms.Button
$btnExpandPack.Text = '全部展开'
$btnExpandPack.Location = New-Object System.Drawing.Point(442, 39)
$btnExpandPack.Size = New-Object System.Drawing.Size(74, 26)
$packTop.Controls.Add($btnExpandPack)

$btnCollapsePack = New-Object System.Windows.Forms.Button
$btnCollapsePack.Text = '全部折叠'
$btnCollapsePack.Location = New-Object System.Drawing.Point(522, 39)
$btnCollapsePack.Size = New-Object System.Drawing.Size(74, 26)
$packTop.Controls.Add($btnCollapsePack)

$btnClearChecks = New-Object System.Windows.Forms.Button
$btnClearChecks.Text = '清空已选'
$btnClearChecks.Location = New-Object System.Drawing.Point(602, 39)
$btnClearChecks.Size = New-Object System.Drawing.Size(74, 26)
$packTop.Controls.Add($btnClearChecks)

$btnRefreshPack = New-Object System.Windows.Forms.Button
$btnRefreshPack.Text = '刷新目录'
$btnRefreshPack.Location = New-Object System.Drawing.Point(682, 39)
$btnRefreshPack.Size = New-Object System.Drawing.Size(74, 26)
$packTop.Controls.Add($btnRefreshPack)

# Bottom bar
$packBottom = New-Object System.Windows.Forms.Panel
$packBottom.Dock = 'Bottom'
$packBottom.Height = 46
$tabPack.Controls.Add($packBottom)

$lblPackStatus = New-Object System.Windows.Forms.Label
$lblPackStatus.Text = '已选 0 个文件 (0 B)  |  支持直接把仓库文件/文件夹拖进本窗口'
$lblPackStatus.Location = New-Object System.Drawing.Point(4, 14)
$lblPackStatus.AutoSize = $true
$packBottom.Controls.Add($lblPackStatus)

$btnDoPack = New-Object System.Windows.Forms.Button
$btnDoPack.Text = '📦 按原层级打包 ZIP'
$btnDoPack.Anchor = 'Top, Right'
$btnDoPack.Size = New-Object System.Drawing.Size(170, 32)
$btnDoPack.Location = New-Object System.Drawing.Point(($packBottom.Width - 174), 8)
$btnDoPack.BackColor = [System.Drawing.Color]::FromArgb(37, 99, 235)
$btnDoPack.ForeColor = [System.Drawing.Color]::White
$btnDoPack.FlatStyle = 'Flat'
$packBottom.Controls.Add($btnDoPack)

# Center TreeView
$tvPack = New-Object System.Windows.Forms.TreeView
$tvPack.Dock = 'Fill'
$tvPack.HideSelection = $false
$tvPack.ShowLines = $true
$tvPack.ShowPlusMinus = $true
$tvPack.ShowRootLines = $true
$tvPack.Font = New-Object System.Drawing.Font('Consolas', 10)
$tabPack.Controls.Add($tvPack)
$tvPack.BringToFront()

# ==================================================================
# TAB 2: 回填 AI 补丁包 (Apply)
# ==================================================================
$tabApply = New-Object System.Windows.Forms.TabPage('📥 回填 AI 补丁包 (Apply)')
$tabApply.Padding = New-Object System.Windows.Forms.Padding(8)
$tabs.TabPages.Add($tabApply)

$applyTop = New-Object System.Windows.Forms.Panel
$applyTop.Dock = 'Top'
$applyTop.Height = 78
$tabApply.Controls.Add($applyTop)

$lblZip = New-Object System.Windows.Forms.Label
$lblZip.Text = '补丁 ZIP:'
$lblZip.Location = New-Object System.Drawing.Point(2, 8)
$lblZip.AutoSize = $true
$applyTop.Controls.Add($lblZip)

$cmbDownloads = New-Object System.Windows.Forms.ComboBox
$cmbDownloads.DropDownStyle = 'DropDown'
$cmbDownloads.Location = New-Object System.Drawing.Point(72, 4)
$cmbDownloads.Width = 540
$cmbDownloads.Anchor = 'Top, Left, Right'
$applyTop.Controls.Add($cmbDownloads)

$btnBrowseZip = New-Object System.Windows.Forms.Button
$btnBrowseZip.Text = '浏览...'
$btnBrowseZip.Location = New-Object System.Drawing.Point(620, 3)
$btnBrowseZip.Size = New-Object System.Drawing.Size(74, 26)
$btnBrowseZip.Anchor = 'Top, Right'
$applyTop.Controls.Add($btnBrowseZip)

$btnReloadZip = New-Object System.Windows.Forms.Button
$btnReloadZip.Text = '刷新下载'
$btnReloadZip.Location = New-Object System.Drawing.Point(700, 3)
$btnReloadZip.Size = New-Object System.Drawing.Size(78, 26)
$btnReloadZip.Anchor = 'Top, Right'
$applyTop.Controls.Add($btnReloadZip)

$chkAutoBackup = New-Object System.Windows.Forms.CheckBox
$chkAutoBackup.Text = '覆盖前按层级备份 (可回滚)'
$chkAutoBackup.Checked = $true
$chkAutoBackup.Location = New-Object System.Drawing.Point(4, 42)
$chkAutoBackup.AutoSize = $true
$applyTop.Controls.Add($chkAutoBackup)

$chkFixEncoding = New-Object System.Windows.Forms.CheckBox
$chkFixEncoding.Text = '自动守卫 .bat/.ps1 编码与 CRLF'
$chkFixEncoding.Checked = $true
$chkFixEncoding.Location = New-Object System.Drawing.Point(215, 42)
$chkFixEncoding.AutoSize = $true
$applyTop.Controls.Add($chkFixEncoding)

$btnRollback = New-Object System.Windows.Forms.Button
$btnRollback.Text = '↩ 从备份回滚...'
$btnRollback.Location = New-Object System.Drawing.Point(665, 38)
$btnRollback.Size = New-Object System.Drawing.Size(113, 27)
$btnRollback.Anchor = 'Top, Right'
$applyTop.Controls.Add($btnRollback)

$applyBottom = New-Object System.Windows.Forms.Panel
$applyBottom.Dock = 'Bottom'
$applyBottom.Height = 46
$tabApply.Controls.Add($applyBottom)

$lblApplyStatus = New-Object System.Windows.Forms.Label
$lblApplyStatus.Text = '请选择或直接拖入 AI 返回的 .zip 压缩包'
$lblApplyStatus.Location = New-Object System.Drawing.Point(4, 14)
$lblApplyStatus.AutoSize = $true
$applyBottom.Controls.Add($lblApplyStatus)

$btnDoApply = New-Object System.Windows.Forms.Button
$btnDoApply.Text = '✅ 一键按层级回填选中'
$btnDoApply.Anchor = 'Top, Right'
$btnDoApply.Size = New-Object System.Drawing.Size(186, 32)
$btnDoApply.Location = New-Object System.Drawing.Point(($applyBottom.Width - 190), 8)
$btnDoApply.BackColor = [System.Drawing.Color]::FromArgb(22, 163, 74)
$btnDoApply.ForeColor = [System.Drawing.Color]::White
$btnDoApply.FlatStyle = 'Flat'
$btnDoApply.Enabled = $false
$applyBottom.Controls.Add($btnDoApply)

$tvApply = New-Object System.Windows.Forms.TreeView
$tvApply.Dock = 'Fill'
$tvApply.HideSelection = $false
$tvApply.ShowLines = $true
$tvApply.ShowPlusMinus = $true
$tvApply.ShowRootLines = $true
$tvApply.Font = New-Object System.Drawing.Font('Consolas', 10)
$tabApply.Controls.Add($tvApply)
$tvApply.BringToFront()

# ------------------------------------------------------------------ Pack 逻辑函数
function Update-PackStatus {
    $cnt = 0
    [int64]$total = 0
    foreach ($rel in $Script:PackChecked) {
        $k = $rel.ToLowerInvariant()
        if ($Script:PackFileMap.ContainsKey($k)) {
            $cnt++
            $total += $Script:PackFileMap[$k].Size
        } else {
            $full = Join-Path $Script:Root ($rel.Replace('/', '\'))
            if (Test-Path -LiteralPath $full -PathType Leaf) {
                $cnt++
                $total += (New-Object System.IO.FileInfo($full)).Length
            }
        }
    }
    $lblPackStatus.Text = ("已选 {0} 个文件 ({1})  |  总候选 {2} 个文件" -f $cnt, (Format-ByteSize $total), $Script:AllPackFiles.Count)
    $btnDoPack.Enabled = ($cnt -gt 0)
}

function Refresh-PackTree([bool]$rescan = $false) {
    if ($rescan) {
        $Script:AllPackFiles = Scan-RepoFiles ([bool]$chkMoreDirs.Checked)
        $Script:PackFileMap = @{}
        foreach ($f in $Script:AllPackFiles) { $Script:PackFileMap[$f.Rel.ToLowerInvariant()] = $f }
    }
    $kw = $txtFilter.Text.Trim()
    $display = New-Object System.Collections.Generic.List[hashtable]
    foreach ($f in $Script:AllPackFiles) {
        if (-not $kw -or $f.Rel.IndexOf($kw, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $display.Add($f)
        }
    }
    Populate-TreeViewFromItems $tvPack $display $Script:PackChecked ([bool]($kw.Length -gt 0))
    Update-PackStatus
}

function Invoke-PackZip {
    if ($Script:PackChecked.Count -eq 0) {
        [System.Windows.Forms.MessageBox]::Show('请先在目录树中勾选至少一个文件。', '提示', 'OK', 'Information') | Out-Null
        return
    }
    if (-not (Test-Path -LiteralPath $Script:BackupRoot -PathType Container)) {
        [void][IO.Directory]::CreateDirectory($Script:BackupRoot)
    }
    $stamp = [DateTime]::Now.ToString('yyyyMMdd_HHmmss')
    $zipOut = Join-Path $Script:BackupRoot ("ai_pack_{0}.zip" -f $stamp)

    $paths = @($Script:PackChecked | Sort-Object)
    $packed = 0
    $skipped = 0
    $zip = [System.IO.Compression.ZipFile]::Open($zipOut, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($rel in $paths) {
            if (Test-HardPrivateRel $rel) { $skipped++; continue }
            $full = Join-Path $Script:Root ($rel.Replace('/', '\'))
            if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { $skipped++; continue }
            [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip, $full, $rel.Replace('\', '/'), [System.IO.Compression.CompressionLevel]::Optimal
            )
            $packed++
        }
    } finally {
        $zip.Dispose()
    }

    if ($packed -eq 0) {
        if (Test-Path -LiteralPath $zipOut) { Remove-Item -LiteralPath $zipOut -Force -ErrorAction SilentlyContinue }
        [System.Windows.Forms.MessageBox]::Show('没有可打包的有效文件。', '提示', 'OK', 'Warning') | Out-Null
        return
    }

    $zipSize = Format-ByteSize ((New-Object System.IO.FileInfo($zipOut)).Length)
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('/select,"{0}"' -f $zipOut)
    [System.Windows.Forms.MessageBox]::Show(
        ("打包完成！`r`n`r`n文件数: {0} 个（跳过 {1} 个）`r`n压缩包体积: {2}`r`n路径: {3}`r`n`r`n已在资源管理器中选中，直接拖给 AI 即可。" -f $packed, $skipped, $zipSize, $zipOut),
        '打包成功', 'OK', 'Information'
    ) | Out-Null
}

# ------------------------------------------------------------------ Apply 逻辑函数
function Refresh-DownloadsCombo {
    $prev = $cmbDownloads.Text
    $cmbDownloads.Items.Clear()
    $dlDir = Join-Path $env:USERPROFILE 'Downloads'
    if (Test-Path -LiteralPath $dlDir -PathType Container) {
        $zips = @(Get-ChildItem -LiteralPath $dlDir -Filter '*.zip' -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 20)
        foreach ($z in $zips) { [void]$cmbDownloads.Items.Add($z.FullName) }
    }
    if ($prev -and (Test-Path -LiteralPath $prev -PathType Leaf)) {
        $cmbDownloads.Text = $prev
    } elseif ($cmbDownloads.Items.Count -gt 0) {
        $cmbDownloads.SelectedIndex = 0
    }
}

function Update-ApplyStatus {
    $ov = 0; $add = 0; $sens = 0
    foreach ($it in $Script:ApplyEntries) {
        if ($it.Blocked -or -not $Script:ApplyChecked.Contains($it.Rel)) { continue }
        if ($it.IsSecret) { $sens++ }
        if ($it.Exists) { $ov++ } else { $add++ }
    }
    $sel = $ov + $add
    $lblApplyStatus.Text = ("共 {0} 项 | 已选 {1} 项（覆盖 {2}，新增 {3}{4}）" -f `
        $Script:ApplyEntries.Count, $sel, $ov, $add, $(if ($sens -gt 0) { "，含敏感 $sens" } else { '' }))
    $btnDoApply.Enabled = ($sel -gt 0)
}

function Load-ApplyZip([string]$zipPath) {
    $Script:ApplyZipPath = ''
    $Script:ApplyEntries.Clear()
    $Script:ApplyChecked.Clear()
    $tvApply.Nodes.Clear()
    $btnDoApply.Enabled = $false

    if ([string]::IsNullOrWhiteSpace($zipPath) -or -not (Test-Path -LiteralPath $zipPath -PathType Leaf)) {
        $lblApplyStatus.Text = '找不到指定的 .zip 文件'
        return
    }

    $skipDocRe = $cfg.skipApplyDocRegex
    try {
        $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
        try {
            foreach ($entry in $zip.Entries) {
                $rawName = $entry.FullName
                if ([string]::IsNullOrEmpty($rawName) -or $rawName.EndsWith('/') -or $rawName.EndsWith('\')) { continue }

                $resolved = Resolve-SafeTarget $rawName
                if ($null -eq $resolved) {
                    $Script:ApplyEntries.Add(@{
                        Rel      = $rawName.Replace('\', '/')
                        RawName  = $rawName
                        Full     = ''
                        Size     = [int64]$entry.Length
                        Exists   = $false
                        Blocked  = $true
                        IsSecret = $false
                        Status   = 'blocked'
                        Label    = "[禁止-非法路径] $rawName"
                        Color    = [System.Drawing.Color]::Red
                    })
                    continue
                }

                $rel = $resolved.Rel
                $full = $resolved.Full
                $low = $rel.ToLowerInvariant()

                if ($low.StartsWith('.git/')) {
                    $Script:ApplyEntries.Add(@{
                        Rel      = $rel
                        RawName  = $rawName
                        Full     = $full
                        Size     = [int64]$entry.Length
                        Exists   = $false
                        Blocked  = $true
                        IsSecret = $true
                        Status   = 'blocked'
                        Label    = "[禁止-.git] $($rel.Split('/')[-1])"
                        Color    = [System.Drawing.Color]::Red
                    })
                    continue
                }

                $exists = Test-Path -LiteralPath $full -PathType Leaf
                $isSecret = $low.StartsWith('_build/secrets/')
                $isSkipDoc = ($rel -notmatch '/') -and ($rel -imatch $skipDocRe)
                $fileName = $rel.Split('/')[-1]
                $sizeStr = Format-ByteSize ([int64]$entry.Length)

                if ($isSecret) {
                    $label = "[敏感-默认不选] $fileName  ($sizeStr)"
                    $color = [System.Drawing.Color]::DarkRed
                } elseif ($isSkipDoc) {
                    $label = "[说明-默认跳过] $fileName  ($sizeStr)"
                    $color = [System.Drawing.Color]::Gray
                } elseif ($exists) {
                    $label = "[覆盖] $fileName  ($sizeStr)"
                    $color = [System.Drawing.Color]::FromArgb(180, 83, 9)
                    [void]$Script:ApplyChecked.Add($rel)
                } else {
                    $label = "[新增] $fileName  ($sizeStr)"
                    $color = [System.Drawing.Color]::FromArgb(21, 128, 61)
                    [void]$Script:ApplyChecked.Add($rel)
                }

                $Script:ApplyEntries.Add(@{
                    Rel      = $rel
                    RawName  = $rawName
                    Full     = $full
                    Size     = [int64]$entry.Length
                    Exists   = $exists
                    Blocked  = $false
                    IsSecret = $isSecret
                    Status   = $(if ($exists) { 'overwrite' } else { 'new' })
                    Label    = $label
                    Color    = $color
                })
            }
        } finally {
            $zip.Dispose()
        }
    } catch {
        [System.Windows.Forms.MessageBox]::Show("读取 ZIP 失败：`r`n$($_.Exception.Message)", '错误', 'OK', 'Error') | Out-Null
        return
    }

    $Script:ApplyZipPath = $zipPath
    Populate-TreeViewFromItems $tvApply $Script:ApplyEntries $Script:ApplyChecked $true
    Update-ApplyStatus
}

function Invoke-ApplyZip {
    if (-not $Script:ApplyZipPath -or $Script:ApplyChecked.Count -eq 0) { return }

    $targets = New-Object System.Collections.Generic.List[hashtable]
    $secretHits = New-Object System.Collections.Generic.List[string]
    foreach ($it in $Script:ApplyEntries) {
        if ($it.Blocked -or -not $Script:ApplyChecked.Contains($it.Rel)) { continue }
        $targets.Add($it)
        if ($it.IsSecret) { $secretHits.Add($it.Rel) }
    }
    if ($targets.Count -eq 0) { return }

    if ($secretHits.Count -gt 0) {
        $ans = [System.Windows.Forms.MessageBox]::Show(
            ("所选条目包含敏感目录文件：`r`n  - " + ($secretHits -join "`r`n  - ") + "`r`n`r`n确定要覆盖/写入这些敏感文件吗？"),
            '敏感目录确认', 'YesNo', 'Warning'
        )
        if ($ans -ne 'Yes') { return }
    }

    $ovCount = @($targets | Where-Object { $_.Exists }).Count
    $newCount = $targets.Count - $ovCount
    $confirmMsg = "即将按原层级写入 $($targets.Count) 个文件（覆盖 $ovCount 个，新增 $newCount 个）。"
    if ($chkAutoBackup.Checked) { $confirmMsg += "`r`n覆盖前将自动备份旧文件到 _build\backup\ai_apply_...。" }
    $confirmMsg += "`r`n`r`n是否继续？"
    if ([System.Windows.Forms.MessageBox]::Show($confirmMsg, '确认回填', 'YesNo', 'Question') -ne 'Yes') {
        return
    }

    $backupDir = ''
    $manifestOverwritten = New-Object System.Collections.Generic.List[string]
    $manifestCreated = New-Object System.Collections.Generic.List[string]
    if ($chkAutoBackup.Checked) {
        $backupDir = Join-Path $Script:BackupRoot ('ai_apply_' + [DateTime]::Now.ToString('yyyyMMdd_HHmmss'))
        [void][IO.Directory]::CreateDirectory($backupDir)
    }

    $zip = [System.IO.Compression.ZipFile]::OpenRead($Script:ApplyZipPath)
    try {
        $entryMap = @{}
        foreach ($e in $zip.Entries) { $entryMap[$e.FullName] = $e }

        foreach ($t in $targets) {
            $e = $entryMap[$t.RawName]
            if ($null -eq $e) { continue }

            if ($t.Exists) {
                $manifestOverwritten.Add($t.Rel)
                if ($backupDir) {
                    $bakFile = Join-Path $backupDir ($t.Rel.Replace('/', '\'))
                    $bakParent = Split-Path -Parent $bakFile
                    if (-not (Test-Path -LiteralPath $bakParent -PathType Container)) {
                        [void][IO.Directory]::CreateDirectory($bakParent)
                    }
                    [IO.File]::Copy($t.Full, $bakFile, $true)
                }
            } else {
                $manifestCreated.Add($t.Rel)
            }

            $ms = New-Object System.IO.MemoryStream
            $stream = $e.Open()
            try {
                $stream.CopyTo($ms)
                [byte[]]$rawBytes = $ms.ToArray()
            } finally {
                $stream.Dispose()
                $ms.Dispose()
            }
            Write-FileWithEncodingGuard $t.Full $rawBytes ([bool]$chkFixEncoding.Checked)
        }
    } finally {
        $zip.Dispose()
    }

    if ($backupDir) {
        $manifest = [ordered]@{
            appliedAt   = [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')
            sourceZip   = $Script:ApplyZipPath
            overwritten = $manifestOverwritten.ToArray()
            created     = $manifestCreated.ToArray()
        }
        [IO.File]::WriteAllText((Join-Path $backupDir '_manifest.json'), ($manifest | ConvertTo-Json -Depth 4), $Script:Utf8NoBom)
    }

    Refresh-PackTree $true
    Load-ApplyZip $Script:ApplyZipPath

    $doneMsg = "回填完成！覆盖 $ovCount 个，新增 $newCount 个。"
    if ($backupDir) { $doneMsg += "`r`n备份目录：$backupDir" }
    [System.Windows.Forms.MessageBox]::Show($doneMsg, '回填成功', 'OK', 'Information') | Out-Null

}

function Invoke-RollbackFromBackup {
    if (-not (Test-Path -LiteralPath $Script:BackupRoot -PathType Container)) {
        [System.Windows.Forms.MessageBox]::Show('暂无回填备份记录。', '提示', 'OK', 'Information') | Out-Null
        return
    }
    $dirs = @(Get-ChildItem -LiteralPath $Script:BackupRoot -Directory -Filter 'ai_apply_*' | Sort-Object Name -Descending)
    if ($dirs.Count -eq 0) {
        [System.Windows.Forms.MessageBox]::Show('暂无 ai_apply_* 备份目录。', '提示', 'OK', 'Information') | Out-Null
        return
    }

    $dlg = New-Object System.Windows.Forms.Form
    $dlg.Text = '选择要回滚的备份快照'
    $dlg.Size = New-Object System.Drawing.Size(520, 320)
    $dlg.StartPosition = 'CenterParent'
    $dlg.Font = $form.Font

    $lb = New-Object System.Windows.Forms.ListBox
    $lb.Dock = 'Fill'
    foreach ($d in $dirs) { [void]$lb.Items.Add($d.Name) }
    $lb.SelectedIndex = 0
    $dlg.Controls.Add($lb)

    $pnl = New-Object System.Windows.Forms.Panel
    $pnl.Dock = 'Bottom'
    $pnl.Height = 42
    $dlg.Controls.Add($pnl)

    $okBtn = New-Object System.Windows.Forms.Button
    $okBtn.Text = '执行回滚'
    $okBtn.DialogResult = 'OK'
    $okBtn.Location = New-Object System.Drawing.Point(300, 8)
    $okBtn.Size = New-Object System.Drawing.Size(92, 26)
    $pnl.Controls.Add($okBtn)

    $cancelBtn = New-Object System.Windows.Forms.Button
    $cancelBtn.Text = '取消'
    $cancelBtn.DialogResult = 'Cancel'
    $cancelBtn.Location = New-Object System.Drawing.Point(400, 8)
    $cancelBtn.Size = New-Object System.Drawing.Size(92, 26)
    $pnl.Controls.Add($cancelBtn)

    $dlg.AcceptButton = $okBtn
    $dlg.CancelButton = $cancelBtn
    if ($dlg.ShowDialog($form) -ne 'OK' -or -not $lb.SelectedItem) { return }

    $chosenDir = Join-Path $Script:BackupRoot ([string]$lb.SelectedItem)
    $mfPath = Join-Path $chosenDir '_manifest.json'
    if (-not (Test-Path -LiteralPath $mfPath -PathType Leaf)) {
        [System.Windows.Forms.MessageBox]::Show('该备份目录缺少 _manifest.json，无法自动回滚。', '错误', 'OK', 'Error') | Out-Null
        return
    }
    $mf = ([IO.File]::ReadAllText($mfPath, $Script:Utf8NoBom)) | ConvertFrom-Json
    $ovList = $(if ($mf.PSObject.Properties['overwritten'] -and $mf.overwritten) { @($mf.overwritten) } else { @() })
    $crList = $(if ($mf.PSObject.Properties['created'] -and $mf.created) { @($mf.created) } else { @() })

    $ans = [System.Windows.Forms.MessageBox]::Show(
        ("确定回滚快照 [$($lb.SelectedItem)]？`r`n将还原 $($ovList.Count) 个被覆盖文件，并删除 $($crList.Count) 个当时新增的文件。"),
        '确认回滚', 'YesNo', 'Warning'
    )
    if ($ans -ne 'Yes') { return }

    $restored = 0; $removed = 0
    foreach ($rel in $ovList) {
        $resolved = Resolve-SafeTarget ([string]$rel)
        if ($null -eq $resolved) { continue }
        $srcBak = Join-Path $chosenDir ($resolved.Rel.Replace('/', '\'))
        if (Test-Path -LiteralPath $srcBak -PathType Leaf) {
            $p = Split-Path -Parent $resolved.Full
            if (-not (Test-Path -LiteralPath $p -PathType Container)) { [void][IO.Directory]::CreateDirectory($p) }
            [IO.File]::Copy($srcBak, $resolved.Full, $true)
            $restored++
        }
    }
    foreach ($rel in $crList) {
        $resolved = Resolve-SafeTarget ([string]$rel)
        if ($null -eq $resolved) { continue }
        if (Test-Path -LiteralPath $resolved.Full -PathType Leaf) {
            [IO.File]::Delete($resolved.Full)
            $removed++
        }
    }
    Refresh-PackTree $true
    [System.Windows.Forms.MessageBox]::Show("回滚完成：已还原 $restored 个文件，清理新增 $removed 个文件。", '回滚成功', 'OK', 'Information') | Out-Null
}

# ------------------------------------------------------------------ 拖放处理（同时支持启动参数与窗口拖放）
function Handle-DroppedPaths([string[]]$paths) {
    if ($null -eq $paths -or $paths.Count -eq 0) { return }
    # 若拖入单个 .zip，自动切换到 Apply 标签页并加载预览
    if ($paths.Count -eq 1 -and (Test-Path -LiteralPath $paths[0] -PathType Leaf) -and $paths[0].EndsWith('.zip', [StringComparison]::OrdinalIgnoreCase)) {
        $tabs.SelectedTab = $tabApply
        $cmbDownloads.Text = [IO.Path]::GetFullPath($paths[0])
        Load-ApplyZip ([IO.Path]::GetFullPath($paths[0]))
        return
    }

    # 否则将拖入的仓库内文件/文件夹加入 Pack 勾选集
    $added = 0; $blocked = 0; $outside = 0
    $needMoreDirs = $false
    foreach ($p in $paths) {
        if (-not (Test-Path -LiteralPath $p)) { continue }
        $full = [IO.Path]::GetFullPath($p)
        if (-not $full.StartsWith($Script:RootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            $outside++
            continue
        }
        $candidates = @()
        if (Test-Path -LiteralPath $full -PathType Container) {
            $candidates = @(Get-ChildItem -LiteralPath $full -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
        } else {
            $candidates = @($full)
        }
        foreach ($cf in $candidates) {
            $rel = Get-RelPath $cf
            if (-not $rel) { continue }
            if (Test-HardPrivateRel $rel) { $blocked++; continue }
            [void]$Script:PackChecked.Add($rel)
            if (-not $Script:PackFileMap.ContainsKey($rel.ToLowerInvariant())) { $needMoreDirs = $true }
            $added++
        }
    }

    $tabs.SelectedTab = $tabPack
    if ($needMoreDirs -and -not $chkMoreDirs.Checked) {
        $chkMoreDirs.Checked = $true
    } else {
        Refresh-PackTree $false
    }
    if ($blocked -gt 0 -or $outside -gt 0) {
        [System.Windows.Forms.MessageBox]::Show(
            "已勾选 $added 个文件。`r`n已拦截敏感文件: $blocked 个，忽略仓库外路径: $outside 个。",
            '拖放结果', 'OK', 'Information'
        ) | Out-Null
    }
}

# ------------------------------------------------------------------ 绑定事件
Bind-TriStateTreeEvents $tvPack  $Script:PackChecked  { Update-PackStatus }
Bind-TriStateTreeEvents $tvApply $Script:ApplyChecked { Update-ApplyStatus }

$btnPresetOnly.Add_Click({
    if ($cmbPreset.SelectedIndex -lt 0 -or $cmbPreset.SelectedIndex -ge $cfg.presets.Count) { return }
    $Script:PackChecked.Clear()
    $matched = Resolve-PresetPaths $cfg.presets[$cmbPreset.SelectedIndex] $Script:AllPackFiles
    foreach ($r in $matched) { [void]$Script:PackChecked.Add($r) }
    Refresh-PackTree $false
})

$btnPresetAdd.Add_Click({
    if ($cmbPreset.SelectedIndex -lt 0 -or $cmbPreset.SelectedIndex -ge $cfg.presets.Count) { return }
    $matched = Resolve-PresetPaths $cfg.presets[$cmbPreset.SelectedIndex] $Script:AllPackFiles
    foreach ($r in $matched) { [void]$Script:PackChecked.Add($r) }
    Refresh-PackTree $false
})

$btnGitMod.Add_Click({
    $mods = Get-GitModifiedFiles
    if ($mods.Count -eq 0) {
        [System.Windows.Forms.MessageBox]::Show('当前 Git 工作区没有可打包的非私密改动文件。', '提示', 'OK', 'Information') | Out-Null
        return
    }
    $needMore = $false
    foreach ($m in $mods) {
        [void]$Script:PackChecked.Add($m)
        if (-not $Script:PackFileMap.ContainsKey($m.ToLowerInvariant())) { $needMore = $true }
    }
    if ($needMore -and -not $chkMoreDirs.Checked) { $chkMoreDirs.Checked = $true }
    else { Refresh-PackTree $false }
})

$chkMoreDirs.Add_CheckedChanged({ Refresh-PackTree $true })
$txtFilter.Add_TextChanged({ Refresh-PackTree $false })
$btnClearFilter.Add_Click({ $txtFilter.Text = '' })
$btnExpandPack.Add_Click({ $tvPack.ExpandAll() })
$btnCollapsePack.Add_Click({ $tvPack.CollapseAll() })
$btnClearChecks.Add_Click({ $Script:PackChecked.Clear(); Refresh-PackTree $false })
$btnRefreshPack.Add_Click({ Refresh-PackTree $true })
$btnDoPack.Add_Click({ Invoke-PackZip })

$cmbDownloads.Add_SelectedIndexChanged({
    if ($cmbDownloads.SelectedItem) { Load-ApplyZip ([string]$cmbDownloads.SelectedItem) }
})
$btnReloadZip.Add_Click({
    Refresh-DownloadsCombo
    if ($cmbDownloads.Text) { Load-ApplyZip $cmbDownloads.Text }
})
$btnBrowseZip.Add_Click({
    $ofd = New-Object System.Windows.Forms.OpenFileDialog
    $ofd.Filter = 'ZIP 压缩包 (*.zip)|*.zip|所有文件 (*.*)|*.*'
    $ofd.InitialDirectory = Join-Path $env:USERPROFILE 'Downloads'
    if ($ofd.ShowDialog($form) -eq 'OK') {
        $cmbDownloads.Text = $ofd.FileName
        Load-ApplyZip $ofd.FileName
    }
})
$btnDoApply.Add_Click({ Invoke-ApplyZip })
$btnRollback.Add_Click({ Invoke-RollbackFromBackup })

$form.Add_DragEnter({
    param($s, $e)
    if ($e.Data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
        $e.Effect = [System.Windows.Forms.DragDropEffects]::Copy
    }
})
$form.Add_DragDrop({
    param($s, $e)
    if ($e.Data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
        $arr = @($e.Data.GetData([System.Windows.Forms.DataFormats]::FileDrop))
        Handle-DroppedPaths $arr
    }
})

# ------------------------------------------------------------------ 初始化并显示窗口
Refresh-PackTree $false
Refresh-DownloadsCombo
$form.Add_FormClosed({
    foreach ($d in $Script:UiDisposables) {
        try { $d.Dispose() } catch { }
    }
    $Script:UiDisposables.Clear()
})
if ($DropPaths -and $DropPaths.Count -gt 0) {
    $form.Add_Shown({ Handle-DroppedPaths $DropPaths })
}
[void]$form.ShowDialog()
