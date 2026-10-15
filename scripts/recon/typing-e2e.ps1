# typing-e2e.ps1 - focused textbox for SendInput verification (keep ASCII-only)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);' -Name W -Namespace VowE2E
$form = New-Object System.Windows.Forms.Form
$form.Text = 'vow typing e2e'
$form.TopMost = $true
$form.Width = 560
$form.Height = 160
$tb = New-Object System.Windows.Forms.TextBox
$tb.Multiline = $true
$tb.Dock = 'Fill'
$tb.Font = New-Object System.Drawing.Font('Consolas', 14)
$form.Controls.Add($tb)
$form.Show()
# classic foreground-lock bypass: tap ALT, then steal foreground
[VowE2E.W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[VowE2E.W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
$setfg = [VowE2E.W]::SetForegroundWindow($form.Handle)
$tb.Focus() | Out-Null
Start-Sleep -Milliseconds 800
$fgIsForm = ([VowE2E.W]::GetForegroundWindow() -eq $form.Handle)
Write-Output "setfg=$setfg fgIsForm=$fgIsForm"
$deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $deadline) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 60
}
$meta = "setfg=$setfg fgIsForm=$fgIsForm len=" + $tb.Text.Length
$meta | Out-File -FilePath 'C:\Users\xrl\Codes\web-mic\scripts\recon\typing-e2e-meta.txt' -Encoding utf8
$tb.Text | Out-File -FilePath 'C:\Users\xrl\Codes\web-mic\scripts\recon\typing-e2e-result.txt' -Encoding utf8
$form.Close()
