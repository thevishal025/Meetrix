$ErrorActionPreference = 'Stop'
$secureKey = Read-Host 'Paste a NEW NVIDIA NIM key (rotate the exposed key first)' -AsSecureString
$keyPointer = [IntPtr]::Zero
try {
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $env:NVIDIA_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    & node (Join-Path $PSScriptRoot 'local-ai-proxy.js')
} finally {
    if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
    Remove-Item Env:NVIDIA_API_KEY -ErrorAction SilentlyContinue
    if ($secureKey) { $secureKey.Dispose() }
}
