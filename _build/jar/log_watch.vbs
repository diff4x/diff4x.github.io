Option Explicit

' ============================================================
' 0. 基础对象
' ============================================================
Dim fso, shell, WMI
Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
Set WMI   = GetObject("winmgmts:\\.\root\cimv2")

' ============================================================
' 1. 路径初始化
' ============================================================
Dim logFile, hashFile

logFile  = Replace(WScript.ScriptFullName, "log_watch.vbs", "err.log")
hashFile = Replace(WScript.ScriptFullName, "log_watch.vbs", "err.hash")

' ============================================================
' 2. 参数解析
' ============================================================
Dim targetPID, vscodePath, targetHtml, flag
targetPID = 0
vscodePath = ""
targetHtml = ""
flag = False

If WScript.Arguments.Count >= 1 Then
    On Error Resume Next
    targetPID = CLng(WScript.Arguments(0))
    On Error GoTo 0
End If

If WScript.Arguments.Count >= 3 Then
    vscodePath = WScript.Arguments(1)
    targetHtml = WScript.Arguments(2)
    flag = True
End If

If targetPID <= 0 Then WScript.Quit

' ============================================================
' 3. 文件特征指纹计算 (大小 + 修改时间)
' ============================================================
Function GetFileFingerprint(path)
    On Error Resume Next
    Dim f
    Set f = fso.GetFile(path)
    ' 组合 Size 和 DateLastModified 作为唯一性校验
    GetFileFingerprint = f.Size & "|" & f.DateLastModified
End Function

' ============================================================
' 4. PID 进程检测器
' ============================================================
Function IsProcessRunning(pid)
    On Error Resume Next
    Dim colProcesses
    Set colProcesses = WMI.ExecQuery("Select * From Win32_Process Where ProcessId = " & pid)
    IsProcessRunning = (colProcesses.Count > 0)
End Function

' ============================================================
' 5. 等待目标 Java 进程结束
' ============================================================
Do While IsProcessRunning(targetPID)
    WScript.Sleep 500
Loop

' ============================================================
' 6. Java 已结束，开始指纹比对
' ============================================================
If fso.FileExists(logFile) Then
    ' 跳过空文件
    If fso.GetFile(logFile).Size > 0 Then
        
        Dim currentFingerprint, prevFingerprint
        currentFingerprint = GetFileFingerprint(logFile)
        prevFingerprint = ""

        If fso.FileExists(hashFile) Then
            On Error Resume Next
            prevFingerprint = Trim(fso.OpenTextFile(hashFile, 1).ReadAll())
            On Error GoTo 0
        End If

        ' ====================================================
        ' 检测到新错误 (指纹不一致)
        ' ====================================================
        If currentFingerprint <> "" And currentFingerprint <> prevFingerprint Then
            
            ' 写入新指纹
            Dim f
            Set f = fso.OpenTextFile(hashFile, 2, True)
            f.Write currentFingerprint
            f.Close

            ' 弹出记事本
            shell.Run "notepad.exe """ & logFile & """", 1, False
            WScript.Quit
        End If
    End If
End If

' ============================================================
' 7. 回退逻辑
'    没有新错误时，自动打开 HTML
' ============================================================
If flag Then
    If fso.FileExists(targetHtml) Then
        If fso.FileExists(vscodePath) Then
            shell.Run """" & vscodePath & """ """ & targetHtml & """", 1, False
        End If
    End If
End If