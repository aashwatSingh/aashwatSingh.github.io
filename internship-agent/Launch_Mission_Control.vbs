' Launch_Mission_Control.vbs -- Mission Control with no PowerShell and no console window.
'
'   Double-click (or use the "SWE Internship Agent" desktop shortcut):
'     1. if nothing answers on http://127.0.0.1:4760, starts app_server.py hidden (window style 0);
'     2. waits up to 5 seconds for it to answer;
'     3. opens the page in your default browser.
'
'   Launch_Mission_Control.vbs /server-only   starts the server (if needed) and opens no browser.
'   install_launcher.py --startup puts that form in the Windows Startup folder.
'
' First time on a computer: install the packages once with  python -m pip install -r requirements.txt
' (Launch_Mission_Control.bat does that for you). Playwright's Chrome window still opens normally.
Option Explicit

Const PAGE_URL = "http://127.0.0.1:4760"
Const PYTHON_PREFERRED = "C:\Users\aashw\AppData\Local\Python\pythoncore-3.15-64\python.exe"

Dim sh, fso, here, serverOnly, i, up

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
serverOnly = False
If WScript.Arguments.Count > 0 Then serverOnly = (LCase(WScript.Arguments(0)) = "/server-only")

' True when something answers on the Mission Control port.
Function IsUp()
  Dim http
  IsUp = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setProxy 1                      ' direct: never through a proxy for localhost
  http.setTimeouts 400, 400, 800, 800
  http.open "GET", PAGE_URL & "/", False
  http.send
  If Err.Number = 0 Then
    If http.status = 200 Then IsUp = True
  End If
  On Error GoTo 0
End Function

' Starts app_server.py hidden with the first Python that can be launched. False if none could.
Function StartServer()
  Dim candidates, c
  StartServer = False
  sh.CurrentDirectory = here
  candidates = Array(PYTHON_PREFERRED, "pythonw.exe", "python.exe")
  For Each c In candidates
    If InStr(c, "\") = 0 Or fso.FileExists(c) Then
      Err.Clear
      On Error Resume Next
      sh.Run """" & c & """ """ & here & "\app_server.py""", 0, False
      If Err.Number = 0 Then StartServer = True
      On Error GoTo 0
      If StartServer Then Exit Function
    End If
  Next
End Function

up = IsUp()
If Not up Then
  If Not StartServer() Then
    If Not serverOnly Then MsgBox "Python was not found. Install Python, then run: python -m pip install -r requirements.txt", vbExclamation, "SWE Internship Agent"
    WScript.Quit 1
  End If
  For i = 1 To 25                      ' 25 x 200 ms = 5 seconds
    WScript.Sleep 200
    up = IsUp()
    If up Then Exit For
  Next
End If

If Not serverOnly Then
  If up Then
    sh.Run PAGE_URL, 1, False
  Else
    MsgBox "Mission Control did not answer within 5 seconds." & vbCrLf & vbCrLf & _
           "First time? Install the packages once: open a terminal in" & vbCrLf & here & vbCrLf & _
           "and run:  python -m pip install -r requirements.txt" & vbCrLf & _
           "Then use the shortcut again. To see any error, run:  python app_server.py", vbExclamation, "SWE Internship Agent"
  End If
End If
