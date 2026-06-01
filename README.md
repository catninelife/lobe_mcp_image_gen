# LobeHub KIE Z-Image MCP

Docker-ready Streamable HTTP MCP server for using KIE `z-image` from LobeHub custom MCP skills.

It exposes two MCP tools:

- `generate_z_image`: create a KIE Z-Image task and, by default, wait for image URLs.
- `get_z_image_task`: query a previously submitted task by `taskId`.

## 1. Push To GitHub

Create an empty GitHub repository first. If possible, do not create the GitHub README during repository creation because this local project already has one.

Then run these commands in PowerShell:

```powershell
cd D:\Scripts\Lobehub
git init
git add .
git commit -m "Add KIE Z-Image MCP server"
git branch -M main
git remote add origin https://github.com/your-username/your-repo.git
git push -u origin main
```

For this repository, the remote is:

```powershell
git remote add origin https://github.com/catninelife/lobe_mcp_image_gen.git
```

If `git push` says `fetch first`, it means GitHub already has an initial commit. Merge it first, then push again:

```powershell
git fetch origin
git merge origin/main --allow-unrelated-histories --no-edit
git push -u origin main
```

Do not upload `.env`. This project already ignores `.env` in `.gitignore`.

## 2. Deploy On Zeabur

1. Open Zeabur.
2. Create a new project.
3. Choose deploy from GitHub.
4. Select this repository.
5. Use Docker deployment. Zeabur will build the included `Dockerfile`.
6. Add these environment variables in Zeabur:

```env
KIE_API_KEY=your_kie_api_key
MCP_AUTH_TOKEN=your_private_lobehub_token
PORT=3000
```

Optional variables:

```env
KIE_BASE_URL=https://api.kie.ai
DEFAULT_ASPECT_RATIO=1:1
DEFAULT_NSFW_CHECKER=true
MAX_WAIT_MS=180000
POLL_INTERVAL_MS=3000
```

After deployment, your MCP endpoint is:

```text
https://your-zeabur-domain/mcp
```

Health check:

```text
https://your-zeabur-domain/health
```

It should return something like:

```json
{
  "status": "ok",
  "name": "lobehub-kie-z-image-mcp",
  "version": "1.0.0",
  "kieConfigured": true
}
```

If `kieConfigured` is `false`, `KIE_API_KEY` is missing or not applied in Zeabur.

## 3. Add To LobeHub

In LobeHub custom MCP skill settings:

- MCP type: `Streamable HTTP`
- MCP name: `kie-z-image`
- Streamable HTTP Endpoint URL: `https://your-zeabur-domain/mcp`
- Auth type: choose `API Key`.
- API Key: use the same value as Zeabur `MCP_AUTH_TOKEN`.
- Skill description: `Generate images with KIE Z-Image instead of Google Nano Banana.`
- Skill avatar: optional.

If LobeHub's API Key mode does not send a bearer token, add an advanced HTTP header:

```text
x-api-key: your_private_lobehub_token
```

Then click the LobeHub connection test button.

Common errors:

- `401`: the API key is wrong or not being sent. Use the `x-api-key` header above.
- `404`: the endpoint URL is wrong. It must end with `/mcp`.
- `kieConfigured:false` on `/health`: Zeabur does not have `KIE_API_KEY` configured.

## Local Run

```bash
cp .env.example .env
npm start
```

Or with Docker:

```bash
docker build -t lobehub-kie-z-image-mcp .
docker run --rm -p 3000:3000 \
  -e KIE_API_KEY=your_kie_api_key \
  -e MCP_AUTH_TOKEN=your_private_lobehub_token \
  lobehub-kie-z-image-mcp
```

Then use:

```text
http://localhost:3000/mcp
```

## Tool Notes

`generate_z_image` accepts:

- `prompt` required.
- `aspect_ratio` optional, default `1:1`.
- `nsfw_checker` optional, default `true`.
- `wait_for_result` optional, default `true`.
- `max_wait_seconds` optional per-call timeout.
- `poll_interval_seconds` optional per-call polling interval.
- `callBackUrl` optional KIE callback URL.

If a call times out while KIE is still generating, the response includes `taskId`. Call `get_z_image_task` later with that ID.

KIE-generated URLs may expire, so save results you want to keep.
