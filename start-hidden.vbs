' One-Relay launcher: locate node.js, then start supervisor with hidden window.
' Node lookup order: bundled -> common install dirs -> PATH
Dim fso, sh, here, nodeExe, candidates, c
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)

nodeExe = ""
candidates = Array( _
  here & "\node\node.exe", _
  here & "\nodejs\node.exe", _
  "C:\Program Files\nodejs\node.exe", _
  "C:\Program Files (x86)\nodejs\node.exe" _
)
For Each c In candidates
  If fso.FileExists(c) Then
    nodeExe = c
    Exit For
  End If
Next

If nodeExe <> "" Then
  sh.Run """" & nodeExe & """ """ & here & "\supervisor.js""", 0, False
Else
  Err.Clear
  On Error Resume Next
  sh.Run "node """ & here & "\supervisor.js""", 0, False
  If Err.Number <> 0 Then
    MsgBox "Node.js not found." & vbCrLf & "Please install it from https://nodejs.org and try again.", 16, "One-Relay"
  End If
End If
