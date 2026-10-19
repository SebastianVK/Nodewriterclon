' Detiene el servidor de StoryGraph que corre oculto en segundo plano
' (mata el proceso que escucha en el puerto 5175 y su árbol de hijos)
Option Explicit

Dim shell, oExec, line, fields, i, pid, pids
Set shell = CreateObject("WScript.Shell")

Set oExec = shell.Exec("netstat -ano")
pids = ""
Do While Not oExec.StdOut.AtEndOfStream
  line = Trim(oExec.StdOut.ReadLine)
  If InStr(line, "LISTENING") > 0 And InStr(line, ":5175") > 0 Then
    fields = Split(line, " ")
    For i = UBound(fields) To 0 Step -1
      If fields(i) <> "" Then
        If IsNumeric(fields(i)) Then pids = pids & "," & fields(i)
        Exit For
      End If
    Next
  End If
Loop

If pids = "" Then
  MsgBox "No había ningún servidor en el puerto 5175.", vbInformation, "StoryGraph"
Else
  pids = Mid(pids, 2)
  shell.Run "cmd /c for %p in (" & Replace(pids, ",", " ") & ") do taskkill /PID %p /T /F", 0, True
  WScript.Sleep 500
  MsgBox "Servidor detenido (pids: " & pids & ").", vbInformation, "StoryGraph"
End If
