# MEETRIX local AI proxy

The extension does not contain or store the NVIDIA API key. `local-ai-proxy.js` listens only on `127.0.0.1` and sends summary and caption-review requests to NVIDIA NIM. The proxy process reads `NVIDIA_API_KEY` from its environment.

## Start on Windows

1. Revoke the key that was pasted into chat and create a new NVIDIA NIM key.
2. Open PowerShell in this folder and run:

   ```powershell
   .\start-ai-proxy.ps1
   ```

3. Enter the replacement key at the hidden prompt. Keep the PowerShell window open during meetings. The script clears the environment variable when the proxy stops.
4. Reload the MEETRIX extension. Its Transcript tab should show **Local proxy ready**.

The key is not written to a project file or Chrome extension storage. The proxy binds to loopback and accepts requests only from a Chrome extension origin. Anyone with access to the same Windows account or administrator-level access to this computer may still inspect a running process; this local setup protects the key from being bundled into or read from the extension package, but cannot hide it from the machine owner. For separation from the user's computer, host the proxy on a secured server and keep the key in that server's secret manager.

Caption text is sent to NVIDIA when MEETRIX requests an AI summary and correction. If the local proxy or NVIDIA service is unavailable, MEETRIX keeps the original captions and uses its local summary fallback.
