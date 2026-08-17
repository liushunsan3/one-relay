# 路由代理托盘（由 supervisor.js 拉起，请勿直接运行）
# 菜单命令 -> stdout 按行发给 supervisor：open / restart / quit
# supervisor -> 命令文件 tray-cmd-<tag>.txt：notify:消息 / quit
# 心跳文件 heartbeat-<tag>.txt 超 30 秒未更新（supervisor 已死）-> 图标消失自动退出
param([int]$Port = 3099)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:Port = $Port
$script:Tag = if ($Port -eq 3099) { 'main' } else { "$Port" }
$script:CmdFile = Join-Path $PSScriptRoot "tray-cmd-$($script:Tag).txt"
$script:HeartFile = Join-Path $PSScriptRoot "heartbeat-$($script:Tag).txt"

# stdout 写出器（AutoFlush，供 supervisor 按行读取）
$script:sw = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput())
$script:sw.AutoFlush = $true
function Send-Cmd([string]$c) { $script:sw.WriteLine($c) }

# 生成图标：深蓝圆底 + 白色「路」字
$bmp = New-Object System.Drawing.Bitmap(32, 32)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(41, 98, 185))
$g.FillEllipse($brush, 1, 1, 30, 30)
$font = New-Object System.Drawing.Font('Microsoft YaHei', 12, [System.Drawing.FontStyle]::Bold)
$g.DrawString('路', $font, [System.Drawing.Brushes]::White, 6, 6)
$g.Dispose()
$script:icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
$bmp.Dispose()

$script:ni = New-Object System.Windows.Forms.NotifyIcon
$script:ni.Icon = $script:icon
$script:ni.Text = "路由代理（端口 $Port）运行中"
$script:ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenu
$miOpen = New-Object System.Windows.Forms.MenuItem('打开管理面板')
$miOpen.add_Click({ Send-Cmd 'open' })
$miRestart = New-Object System.Windows.Forms.MenuItem('重启服务')
$miRestart.add_Click({ Send-Cmd 'restart' })
$miQuit = New-Object System.Windows.Forms.MenuItem('退出')
$miQuit.add_Click({ Send-Cmd 'quit' })
[void]$menu.MenuItems.Add($miOpen)
[void]$menu.MenuItems.Add($miRestart)
[void]$menu.MenuItems.Add((New-Object System.Windows.Forms.MenuItem('-')))
[void]$menu.MenuItems.Add($miQuit)
$script:ni.ContextMenu = $menu
$script:ni.add_DoubleClick({ Send-Cmd 'open' })
$script:ni.add_BalloonTipClicked({ Send-Cmd 'open' })

# 轮询：命令文件 + 心跳检测
$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 600
$script:timer.Add_Tick({
  # 心跳：supervisor 死了不残留僵尸托盘（图标消失本身就是异常信号）
  try {
    if (Test-Path $script:HeartFile) {
      $beat = [long](Get-Content $script:HeartFile -Raw).Trim()
      $beatTime = [DateTimeOffset]::FromUnixTimeMilliseconds($beat).LocalDateTime
      if (((Get-Date) - $beatTime).TotalSeconds -gt 30) {
        $script:ni.Visible = $false
        [Environment]::Exit(0)
      }
    }
  } catch {}
  # 命令文件
  try {
    if ((Test-Path $script:CmdFile) -and (Get-Item $script:CmdFile).Length -gt 0) {
      $lines = Get-Content $script:CmdFile -Encoding UTF8
      Set-Content -Path $script:CmdFile -Value '' -Encoding UTF8
      foreach ($l in $lines) {
        if (-not $l) { continue }
        if ($l -eq 'quit') {
          $script:ni.Visible = $false
          [Environment]::Exit(0)
        } elseif ($l.StartsWith('notify:')) {
          $script:ni.ShowBalloonTip(4000, '路由代理', $l.Substring(7), [System.Windows.Forms.ToolTipIcon]::Info)
        }
      }
    }
  } catch {}
})
$script:timer.Start()

[System.Windows.Forms.Application]::Run()
