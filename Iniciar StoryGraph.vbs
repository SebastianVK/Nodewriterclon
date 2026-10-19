' Iniciador rápido de StoryGraph (clon de nodewriter)
' Arranca el servidor de desarrollo OCULTO (sin ventana) en segundo plano
' y abre la app en el navegador en http://localhost:5175/
' Log del servidor: logs\dev.log   Detener: "Detener StoryGraph.vbs"
Option Explicit

Const URL = "http://localhost:5175/"

Dim shell, fso, folder
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = folder

Dim running
running = ServerUp()

If Not running Then
  If Not fso.FolderExists(folder & "\logs") Then fso.CreateFolder folder & "\logs"
  ' Estilo 0 = ventana OCULTA; la salida va a logs\dev.log
  shell.Run "cmd /c npm run dev -- --port 5175 --strictPort > logs\dev.log 2>&1", 0, False
  Dim i
  For i = 1 To 80
    WScript.Sleep 500
    If ServerUp() Then
      running = True
      Exit For
    End If
  Next
End If

If running Then
  shell.Run URL
Else
  MsgBox "No se pudo arrancar el servidor en " & URL & vbCrLf & _
         "Revisa el log: " & folder & "\logs\dev.log", _
         vbExclamation, "StoryGraph"
End If

Function ServerUp()
  ServerUp = False
  Dim http
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 500, 500, 1000, 2000
  http.Open "GET", URL, False
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 Then ServerUp = True
  End If
  Err.Clear
  On Error GoTo 0
End Function
