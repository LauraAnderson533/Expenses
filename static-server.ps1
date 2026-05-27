param([int]$Port = 8124)
$root = Join-Path $PSScriptRoot 'public'
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Static server on http://localhost:$Port serving $root"
$mime = @{ '.html'='text/html'; '.js'='application/javascript'; '.json'='application/json'; '.css'='text/css'; '.svg'='image/svg+xml'; '.png'='image/png' }
while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($rel -eq '') { $rel = 'index.html' }
    $path = Join-Path $root $rel
    if (-not (Test-Path $path)) { $path = Join-Path $root 'index.html' }
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $ext = [System.IO.Path]::GetExtension($path).ToLower()
    if ($mime.ContainsKey($ext)) { $ctx.Response.ContentType = $mime[$ext] }
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $ctx.Response.Close()
  } catch { }
}
