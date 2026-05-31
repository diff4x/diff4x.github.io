<# :
@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

echo ===================================================
echo        VTT 英中双语字幕自动化翻译引擎 (V2 实时保存版)
echo ===================================================
echo.
echo [系统提示] 支持断点续传，已翻译过的段落将瞬间跳过。
echo [系统提示] 开启【实时落盘】模式，随时关闭不丢进度！
echo [系统提示] 进度条将在后台静默推进，请耐心等待...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$code = (Get-Content '%~f0' -Raw -Encoding UTF8) -replace '(?s).*<# ---PS--- #>'; Invoke-Command -ScriptBlock ([ScriptBlock]::Create($code))"

echo.
echo ===================================================
echo [完成] 所有 .vtt 文件双语化处理完毕！
echo ===================================================
pause
exit /b
#>

<# ---PS--- #>
# 兼容旧版本 Windows 的 TLS 协议
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$files = Get-ChildItem -Path ".\" -Filter "*.vtt"

if ($files.Count -eq 0) {
    Write-Host "[警告] 当前目录下没有找到任何 .vtt 文件！" -ForegroundColor Red
    return
}

foreach ($file in $files) {
    Write-Host "正在处理: $($file.Name) ..." -ForegroundColor Cyan
    $content = [System.IO.File]::ReadAllText($file.FullName)
    
    # 统一换行符
    $content = $content -replace "`r`n", "`n" -replace "`r", "`n"
    
    # 按空行拆分区块 (VTT 规范)
    $blocks = $content -split "`n`n+"
    $newBlocks = @()
    
    $totalBlocks = $blocks.Count
    $currentBlock = 0
    $translatedCount = 0
    
    foreach ($block in $blocks) {
        $currentBlock++
        if ([string]::IsNullOrWhiteSpace($block)) { continue }
        
        # 召唤顶部进度条
        Write-Progress -Activity "双语字幕生成中: $($file.Name)" -Status "处理区块 $currentBlock / $totalBlocks (已跳过或完成)" -PercentComplete (($currentBlock / $totalBlocks) * 100)
        
        $lines = $block -split "`n"
        $isCue = $false
        $cueIndex = -1
        
        # 定位时间轴所在行
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match "-->") {
                $isCue = $true
                $cueIndex = $i
                break
            }
        }
        
        if ($isCue -and $cueIndex -lt ($lines.Count - 1)) {
            $textLines = $lines[($cueIndex + 1)..($lines.Count - 1)]
            $originalText = $textLines -join "`n"
            
            # 过滤全空块
            if ([string]::IsNullOrWhiteSpace($originalText)) {
                $newBlocks += $block
                continue
            }
            
            # 🌟 核心防御：断点续传。如果已经包含中文字符，瞬间跳过，不用等！
            if ($originalText -match '\p{IsCJKUnifiedIdeographs}') {
                $newBlocks += $block
                continue
            }
            
            # 组装网络请求
            $encoded = [Uri]::EscapeDataString($originalText)
            $url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=$encoded"
            
            $retry = 3
            $translated = ""
            while ($retry -gt 0) {
                try {
                    $response = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 10
                    foreach ($arr in $response[0]) {
                        $translated += $arr[0]
                    }
                    break
                } catch {
                    $retry--
                    Start-Sleep -Seconds 1
                }
            }
            
            if ($translated -ne "") {
                # 无缝拼装
                $newBlock = $lines[0..$cueIndex] -join "`n"
                $newBlock += "`n" + $originalText + "`n" + $translated.Trim()
                $newBlocks += $newBlock
                $translatedCount++
            } else {
                $newBlocks += $block
                Write-Host "`n[网络波动] 第 $currentBlock 区块翻译超时，保留原文。" -ForegroundColor Yellow
            }
            
            # 🌟 高级架构：毫秒级实时落盘 (翻译一句，存一句)
            # 即使你现在立刻强杀 CMD 进程，进度也已经保存在硬盘里了
            $pendingBlocks = @()
            if ($currentBlock -lt $totalBlocks) {
                $pendingBlocks = $blocks[$currentBlock..($totalBlocks-1)]
            }
            $realTimeContent = ($newBlocks + $pendingBlocks) -join "`r`n`r`n"
            [System.IO.File]::WriteAllText($file.FullName, $realTimeContent, $utf8NoBom)
            
            # 限流节流阀：防封控
            Start-Sleep -Milliseconds 150
        } else {
            # 头部描述或格式不符的块，原样保留
            $newBlocks += $block
        }
    }
    
    # 销毁进度条
    Write-Progress -Activity "双语字幕生成中: $($file.Name)" -Completed
    Write-Host "  -> 本次运行新增 $translatedCount 条中文翻译！" -ForegroundColor Green
}