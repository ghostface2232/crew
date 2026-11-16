import path from 'node:path';

/**
 * Windows PowerShell's registered app identity, so a toast shows without an installed app of Crew's own.
 * PowerShell 7 cannot load the WinRT types, which is why this is Windows PowerShell 5.1.
 */
const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

// The text arrives in environment variables and is escaped as XML here, so nothing in it is ever parsed as code.
const SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
$text = @($env:CREW_TOAST_TITLE, $env:CREW_TOAST_SUBTITLE, $env:CREW_TOAST_BODY) | ForEach-Object { '<text>' + [Security.SecurityElement]::Escape($_) + '</text>' }
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'>$($text -join '')</binding></visual></toast>")
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`;

/** The command that shows a Windows toast with a title, subtitle and body, as macOS shows a notification. */
export function toastCommand(title: string, subtitle: string, body: string, env: NodeJS.ProcessEnv = process.env): { bin: string; args: string[]; env: NodeJS.ProcessEnv } {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  return {
    bin: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    env: { ...env, CREW_TOAST_TITLE: title.slice(0, 200), CREW_TOAST_SUBTITLE: subtitle.slice(0, 200), CREW_TOAST_BODY: body.slice(0, 200) },
  };
}
