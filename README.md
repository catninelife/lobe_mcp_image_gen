# LobeHub KIE Z-Image MCP

Docker-ready Streamable HTTP MCP server for using KIE `z-image` from LobeHub custom MCP skills.

It exposes two MCP tools:

- `generate_z_image`: create a KIE Z-Image task and, by default, wait for image URLs.
- `get_z_image_task`: query a previously submitted task by `taskId`.

## Deploy On Zeabur

1. Push this project to GitHub.
2. In Zeabur, create a service from that GitHub repository.
3. Use Docker deployment. Zeabur will build the included `Dockerfile`.
4. Add environment variables:

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

## Add To LobeHub

In LobeHub custom MCP skill settings:

- MCP type: `Streamable HTTP`
- MCP name: `kie-z-image`
- Streamable HTTP Endpoint URL: `https://your-zeabur-domain/mcp`
- Auth type: choose `API Key` if you set `MCP_AUTH_TOKEN`; otherwise choose no auth.
- Skill description: `Generate images with KIE Z-Image instead of Google Nano Banana.`
- Skill avatar: optional.

If LobeHub's API Key mode does not send a bearer token, add an advanced HTTP header:

```text
x-api-key: your_private_lobehub_token
```

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
