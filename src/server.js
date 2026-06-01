import http from 'node:http';
import { URL } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const SERVER_NAME = 'lobehub-kie-z-image-mcp';
const SERVER_VERSION = '1.0.0';

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const KIE_BASE_URL = trimTrailingSlash(process.env.KIE_BASE_URL || 'https://api.kie.ai');
const KIE_API_KEY = process.env.KIE_API_KEY || '';
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';
const DEFAULT_ASPECT_RATIO = process.env.DEFAULT_ASPECT_RATIO || '1:1';
const DEFAULT_NSFW_CHECKER = parseBoolean(process.env.DEFAULT_NSFW_CHECKER, true);
const MAX_WAIT_MS = Number.parseInt(process.env.MAX_WAIT_MS || '180000', 10);
const POLL_INTERVAL_MS = Number.parseInt(process.env.POLL_INTERVAL_MS || '3000', 10);
const REQUEST_BODY_LIMIT = 1024 * 1024;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers':
    'authorization,content-type,mcp-protocol-version,mcp-session-id,x-api-key,x-mcp-token',
  'access-control-expose-headers': 'mcp-session-id',
};

const tools = [
  {
    name: 'generate_z_image',
    title: 'Generate Z-Image',
    description:
      'Generate an image with KIE Z-Image. By default this creates a task, polls until completion or timeout, and returns the generated image URLs.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: {
          type: 'string',
          minLength: 1,
          description: 'The text prompt describing the image to generate.',
        },
        aspect_ratio: {
          type: 'string',
          default: DEFAULT_ASPECT_RATIO,
          description:
            'Image aspect ratio. Common values include 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, and 2:3.',
        },
        nsfw_checker: {
          type: 'boolean',
          default: DEFAULT_NSFW_CHECKER,
          description: 'Whether KIE should run its NSFW checker.',
        },
        callBackUrl: {
          type: 'string',
          description: 'Optional callback URL passed through to KIE.',
        },
        wait_for_result: {
          type: 'boolean',
          default: true,
          description: 'When true, poll KIE until the image is ready or max_wait_seconds is reached.',
        },
        max_wait_seconds: {
          type: 'integer',
          minimum: 1,
          maximum: 900,
          description: 'Override the server polling timeout for this call.',
        },
        poll_interval_seconds: {
          type: 'number',
          minimum: 1,
          maximum: 30,
          description: 'Override the polling interval for this call.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'get_z_image_task',
    title: 'Get Z-Image Task',
    description:
      'Query a KIE task by task ID. Use this when generate_z_image times out before the image is ready.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: {
          type: 'string',
          minLength: 1,
          description: 'KIE task ID returned by generate_z_image.',
        },
      },
      required: ['taskId'],
    },
  },
];

const server = http.createServer(async (req, res) => {
  try {
    await routeRequest(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: 'internal_error', message: error.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`${SERVER_NAME} listening on port ${PORT}`);
});

async function routeRequest(req, res) {
  setBaseHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      name: SERVER_NAME,
      version: SERVER_VERSION,
      kieConfigured: Boolean(KIE_API_KEY),
    });
    return;
  }

  if (requestUrl.pathname !== '/mcp') {
    sendJson(res, 404, {
      error: 'not_found',
      message: 'Use POST /mcp for MCP JSON-RPC requests or GET /health for health checks.',
    });
    return;
  }

  if (req.method === 'GET') {
    if ((req.headers.accept || '').includes('text/event-stream')) {
      openSseStream(req, res);
      return;
    }

    sendJson(res, 200, {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      endpoint: '/mcp',
      tools: tools.map((tool) => tool.name),
    });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed', message: 'Use POST /mcp.' });
    return;
  }

  if (!isAuthorized(req, requestUrl)) {
    sendJson(res, 401, {
      error: 'unauthorized',
      message: 'Invalid MCP_AUTH_TOKEN.',
    });
    return;
  }

  const rawBody = await readRequestBody(req);
  let payload;

  try {
    payload = JSON.parse(rawBody || 'null');
  } catch {
    sendJson(res, 400, jsonRpcError(null, -32700, 'Parse error'));
    return;
  }

  const sessionId = req.headers['mcp-session-id'] || randomUUID();
  res.setHeader('mcp-session-id', sessionId);

  if (Array.isArray(payload)) {
    const results = [];
    for (const request of payload) {
      const response = await handleJsonRpcRequest(request);
      if (response) results.push(response);
    }

    if (results.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }

    sendJson(res, 200, results);
    return;
  }

  const response = await handleJsonRpcRequest(payload);
  if (!response) {
    res.writeHead(202);
    res.end();
    return;
  }

  sendJson(res, 200, response);
}

async function handleJsonRpcRequest(request) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return jsonRpcError(request?.id ?? null, -32600, 'Invalid Request');
  }

  const { id, method, params } = request;
  const isNotification = id === undefined;

  try {
    const result = await dispatchMethod(method, params || {});
    if (isNotification) return null;
    return { jsonrpc: '2.0', id, result };
  } catch (error) {
    if (isNotification) return null;

    if (error instanceof McpError) {
      return jsonRpcError(id, error.code, error.message, error.data);
    }

    return jsonRpcError(id, -32603, error.message || 'Internal error');
  }
}

async function dispatchMethod(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params.protocolVersion || '2025-03-26',
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
        instructions:
          'Use generate_z_image to generate images with KIE Z-Image. Use get_z_image_task to query a task later.',
      };

    case 'notifications/initialized':
      return {};

    case 'ping':
      return {};

    case 'tools/list':
      return { tools };

    case 'tools/call':
      return callTool(params);

    case 'resources/list':
      return { resources: [] };

    case 'prompts/list':
      return { prompts: [] };

    default:
      throw new McpError(-32601, `Method not found: ${method}`);
  }
}

async function callTool(params) {
  const name = params?.name;
  const args = params?.arguments || {};

  if (name === 'generate_z_image') {
    return asToolResult(await generateZImage(args));
  }

  if (name === 'get_z_image_task') {
    return asToolResult(await getZImageTask(args));
  }

  throw new McpError(-32602, `Unknown tool: ${name}`);
}

async function generateZImage(args) {
  assertKieConfigured();

  const prompt = requireString(args.prompt, 'prompt');
  const aspectRatio = requireOptionalString(args.aspect_ratio, 'aspect_ratio') || DEFAULT_ASPECT_RATIO;
  const callbackUrl = requireOptionalString(args.callBackUrl, 'callBackUrl');
  const nsfwChecker = parseBoolean(args.nsfw_checker, DEFAULT_NSFW_CHECKER);
  const waitForResult = parseBoolean(args.wait_for_result, true);
  const maxWaitMs = secondsToMs(args.max_wait_seconds, MAX_WAIT_MS);
  const pollIntervalMs = secondsToMs(args.poll_interval_seconds, POLL_INTERVAL_MS);

  const payload = {
    model: 'z-image',
    input: {
      prompt,
      aspect_ratio: aspectRatio,
      nsfw_checker: nsfwChecker,
    },
  };

  if (callbackUrl) payload.callBackUrl = callbackUrl;

  const created = await kieRequest('/api/v1/jobs/createTask', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  const taskId = created?.data?.taskId;
  if (!taskId) {
    throw new Error(`KIE did not return a taskId: ${JSON.stringify(created)}`);
  }

  if (!waitForResult) {
    return {
      taskId,
      state: 'submitted',
      message: 'Task submitted. Call get_z_image_task with this taskId to check progress.',
      kie: created,
    };
  }

  const task = await pollTask(taskId, maxWaitMs, pollIntervalMs);

  return {
    taskId,
    state: task.state,
    progress: task.progress,
    imageUrls: task.resultUrls,
    failCode: task.failCode,
    failMsg: task.failMsg,
    timedOut: task.timedOut,
    message: taskMessage(task),
    kie: task.raw,
  };
}

async function getZImageTask(args) {
  assertKieConfigured();

  const taskId = requireString(args.taskId, 'taskId');
  const task = await fetchTask(taskId);

  return {
    taskId,
    state: task.state,
    progress: task.progress,
    imageUrls: task.resultUrls,
    failCode: task.failCode,
    failMsg: task.failMsg,
    message: taskMessage(task),
    kie: task.raw,
  };
}

async function pollTask(taskId, maxWaitMs, pollIntervalMs) {
  const startedAt = Date.now();
  let task = await fetchTask(taskId);

  while (isPendingState(task.state) && Date.now() - startedAt < maxWaitMs) {
    await delay(pollIntervalMs);
    task = await fetchTask(taskId);
  }

  if (isPendingState(task.state)) {
    return {
      ...task,
      timedOut: true,
    };
  }

  return {
    ...task,
    timedOut: false,
  };
}

async function fetchTask(taskId) {
  const response = await kieRequest(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
    method: 'GET',
  });

  const data = response?.data || {};
  const resultJson = parseJsonMaybe(data.resultJson);
  const resultUrls = Array.isArray(resultJson?.resultUrls) ? resultJson.resultUrls : [];

  return {
    raw: response,
    taskId: data.taskId || taskId,
    state: data.state || 'unknown',
    progress: data.progress,
    resultUrls,
    failCode: data.failCode || '',
    failMsg: data.failMsg || '',
  };
}

async function kieRequest(path, init) {
  const response = await fetch(`${KIE_BASE_URL}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${KIE_API_KEY}`,
      'content-type': 'application/json',
      accept: 'application/json',
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  const json = parseJsonMaybe(text);

  if (!response.ok) {
    throw new Error(`KIE HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  if (!json || typeof json !== 'object') {
    throw new Error(`KIE returned non-JSON response: ${text.slice(0, 500)}`);
  }

  if (json.msg && json.msg !== 'success' && json.code && json.code !== 200) {
    throw new Error(`KIE API error ${json.code}: ${json.msg}`);
  }

  return json;
}

function asToolResult(value) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value,
  };
}

function taskMessage(task) {
  if (task.timedOut) {
    return 'The task is still running. Call get_z_image_task later with this taskId.';
  }

  if (task.state === 'success') {
    return task.resultUrls.length > 0
      ? 'Image generation completed successfully.'
      : 'Task succeeded, but no resultUrls were returned.';
  }

  if (task.state === 'fail') {
    return task.failMsg || 'Image generation failed.';
  }

  return `Task state: ${task.state}`;
}

function isPendingState(state) {
  return state === 'waiting' || state === 'queuing' || state === 'generating' || state === 'unknown';
}

function assertKieConfigured() {
  if (!KIE_API_KEY) {
    throw new Error('KIE_API_KEY is not configured on the server.');
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required and must be a non-empty string.`);
  }

  return value.trim();
}

function requireOptionalString(value, name) {
  if (value === undefined || value === null || value === '') return undefined;

  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string when provided.`);
  }

  return value.trim();
}

function secondsToMs(value, fallbackMs) {
  if (value === undefined || value === null || value === '') return fallbackMs;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Polling values must be positive numbers.');
  }

  return Math.round(parsed * 1000);
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  }

  return Boolean(value);
}

function parseJsonMaybe(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isAuthorized(req, requestUrl) {
  if (!MCP_AUTH_TOKEN) return true;

  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice('bearer '.length).trim()
    : '';

  const candidates = [
    bearerToken,
    req.headers['x-api-key'],
    req.headers['x-mcp-token'],
    requestUrl.searchParams.get('token'),
  ].filter(Boolean);

  return candidates.some((candidate) => safeEqual(String(candidate), MCP_AUTH_TOKEN));
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > REQUEST_BODY_LIMIT) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function openSseStream(req, res) {
  res.writeHead(200, {
    ...JSON_HEADERS,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });

  res.write(': connected\n\n');

  const interval = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(interval);
  });
}

function setBaseHeaders(res) {
  for (const [key, value] of Object.entries(JSON_HEADERS)) {
    res.setHeader(key, value);
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class McpError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
