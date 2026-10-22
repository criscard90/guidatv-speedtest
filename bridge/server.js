const http = require('http');
const WebSocket = require('ws');
const { spawn, execFile } = require('child_process');
const path = require('path');
const { createGitHubTokenEnv, createSdkAgent } = require('./cline-sdk');

// Configuration
const PORT = process.env.PORT || 3000;
// GitHub token: env var first, otherwise the token sent by the app via 'auth'
let activeToken = process.env.GITHUB_TOKEN || null;
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const GITHUB_OWNER = process.env.GITHUB_OWNER || '';

// Cline CLI integration (headless agent runs)
const CLINE_BIN = process.env.CLINE_BIN || process.execPath;
const CLINE_ENTRY = path.join(__dirname, 'node_modules', 'cline', 'bin', 'cline');
// Default to the repo root (parent of bridge/) so the agent operates on the project
const CLINE_CWD = process.env.CLINE_CWD || path.resolve(__dirname, '..');
const CLINE_PROVIDER = process.env.CLINE_PROVIDER || 'cline';
const CLINE_MODEL = process.env.CLINE_MODEL || '';
const CLINE_API_KEY = process.env.CLINE_API_KEY || '';
const CLINE_THINKING = process.env.CLINE_THINKING || '';
const CLINE_RUNTIME = process.env.CLINE_RUNTIME || 'cli';
// Keep only recent turns when replaying conversation context (costs input tokens)
const MAX_HISTORY_MESSAGES = parseInt(process.env.CLINE_MAX_HISTORY || '20', 10);
const CLINE_MODELS_CACHE_MS = 6 * 60 * 60 * 1000;

// Per-client auth state and Cline task tracking
const authedClients = new Set();
const clientTokens = new Map();
const conversations = new Map();   // clientId -> [{ role, content }]
const runningTasks = new Map();    // clientId -> ChildProcess
const runningAgents = new Map();   // clientId -> { agent, cancelled }
let clineAuthProcess = null;
let clineModelsCache = { expiresAt: 0, models: null };
const partials = new Map();        // clientId -> streamed-so-far text
const stoppedClients = new Set();  // clientId with an intentional stop

// In-memory storage for connected clients and state
const clients = new Map();
const codespaces = new Map();
const messageQueue = [];
let serverState = {
    connected: false,
    authenticated: false,
    version: '1.0.0',
    bridgeUrl: `http://localhost:${PORT}`,
    status: 'disconnected'
};

// GitHub REST API helper
async function githubRequest(path, options = {}) {
    const token = options.token || activeToken;
    if (!token) {
        throw new Error('No GitHub token: set GITHUB_TOKEN env var or authenticate from the app');
    }
    const url = new URL(path, 'https://api.github.com');
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers
    };

    const response = await fetch(url.toString(), {
        method: options.method || 'GET',
        headers: headers,
        body: options.body
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`GitHub API error ${response.status}: ${error}`);
    }

    // Some endpoints (e.g. DELETE) answer with an empty or non-JSON body
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

// Get list of codespaces for the authenticated user
async function listMyCodespaces() {
    const data = await githubRequest('/user/codespaces');
    // GET /user/codespaces returns { total_count, codespaces } (defensively also accept a bare array)
    const items = Array.isArray(data) ? data : (data && data.codespaces) || [];
    return items.map((cs) => ({
        id: cs.id,
        name: cs.name,
        repository: cs.repository,
        container_opened_at: cs.container_opened_at,
        status: cs.status,
        state: cs.state,
        url: cs.url,
        web_url: cs.web_url,
        ssh_url: cs.ssh_url,
        model: cs.model,
        region: cs.region
    }));
}

// Get a specific codespace
async function getCodespace(name) {
    const data = await githubRequest(`/user/codespaces/${encodeURIComponent(name)}`);
    return {
        id: data.id,
        name: data.name,
        repository: data.repository,
        container_opened_at: data.container_opened_at,
        status: data.status,
        state: data.state,
        url: data.url,
        web_url: data.web_url,
        ssh_url: data.ssh_url,
        model: data.model,
        region: data.region
    };
}

// Create a new codespace in a repository (the repository comes from the path)
async function createCodespace(repo, options = {}) {
    const [owner, repoName] = String(repo).split('/');
    if (!owner || !repoName) {
        throw new Error(`Invalid repository "${repo}": expected owner/repo`);
    }
    const data = await githubRequest(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/codespaces`,
        {
            method: 'POST',
            body: JSON.stringify({
                display_name: options.displayName,
                ref: options.ref,
                machine: options.machine,
                location: options.location
            })
        }
    );
    return {
        id: data.id,
        name: data.name,
        repository: data.repository,
        container_opened_at: data.container_opened_at,
        status: data.status,
        state: data.state,
        url: data.url,
        web_url: data.web_url,
        ssh_url: data.ssh_url,
        model: data.model,
        region: data.region
    };
}

// Start a codespace
async function startCodespace(name) {
    const data = await githubRequest(`/user/codespaces/${encodeURIComponent(name)}/start`, {
        method: 'POST'
    });
    return {
        id: data.id,
        name: data.name,
        state: data.state,
        status: data.status
    };
}

// Stop a codespace
async function stopCodespace(name) {
    const data = await githubRequest(`/user/codespaces/${encodeURIComponent(name)}/stop`, {
        method: 'POST'
    });
    return {
        id: data.id,
        name: data.name,
        state: data.state,
        status: data.status
    };
}

// Restart a codespace
async function restartCodespace(name) {
    const data = await githubRequest(`/user/codespaces/${encodeURIComponent(name)}/restart`, {
        method: 'POST'
    });
    return {
        id: data.id,
        name: data.name,
        state: data.state,
        status: data.status
    };
}

// Delete a codespace (DELETE /user/codespaces/{name} → 202 Accepted, empty JSON body)
async function deleteCodespace(name) {
    await githubRequest(`/user/codespaces/${encodeURIComponent(name)}`, {
        method: 'DELETE'
    });
    return {
        id: null,
        name: name,
        state: 'deleted',
        status: 'ended'
    };
}

// Broadcast state to all connected clients
function broadcastState() {
    const state = {
        type: 'status',
        payload: serverState
    };
    const json = JSON.stringify(state);
    for (const [id, client] of clients.entries()) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(json);
        }
    }
}
// Handle WebSocket connection
function handleWebSocketConnection(ws, request) {
    const clientId = Math.random().toString(36).substring(2);
    clients.set(clientId, ws);

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            Promise.resolve(handleMessage(clientId, message)).catch((e) => {
                console.error('Message handling error:', e);
                sendTo(clientId, { type: 'error', payload: { error: `Internal error: ${e.message}` } });
            });
        } catch (e) {
            ws.send(JSON.stringify({
                type: 'error',
                payload: { error: 'Invalid message format' }
            }));
        }
    });

    ws.on('close', () => {
        clients.delete(clientId);
        authedClients.delete(clientId);
        clientTokens.delete(clientId);
        conversations.delete(clientId);
        partials.delete(clientId);
        stoppedClients.delete(clientId);
        stopCline(clientId);
        console.log(`Client ${clientId} disconnected`);
        broadcastState();
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        clients.delete(clientId);
    });

    // Send connection confirmation
    ws.send(JSON.stringify({
        type: 'status',
        payload: {
            ...serverState,
            status: 'connecting'
        }
    }));

    console.log(`Client ${clientId} connected`);
}

function requireAuth(clientId) {
    if (authedClients.has(clientId)) return true;
    sendTo(clientId, {
        type: 'error',
        payload: { error: 'Not authenticated: send an auth message with a valid GitHub token first' }
    });
    return false;
}

// Validate the client token against GitHub before trusting it. Only then is the
// client considered authenticated (and allowed to run commands / the agent).
async function handleAuth(clientId, message) {
    const clientToken = message.payload && message.payload.token;
    try {
        if (clientToken) {
            const user = await fetchUser(clientToken);
            activeToken = clientToken;
            clientTokens.set(clientId, clientToken);
            authedClients.add(clientId);
            serverState.authenticated = true;
            serverState.connected = true;
            serverState.status = 'authenticated';
            broadcastState();
            sendTo(clientId, {
                type: 'auth_success',
                payload: { bridgeState: serverState, login: user.login }
            });
        } else if (activeToken) {
            // Bridge already has a token (env var): accept the client without one
            clientTokens.set(clientId, activeToken);
            authedClients.add(clientId);
            serverState.authenticated = true;
            serverState.connected = true;
            serverState.status = 'authenticated';
            broadcastState();
            sendTo(clientId, {
                type: 'auth_success',
                payload: { bridgeState: serverState }
            });
        } else {
            sendTo(clientId, {
                type: 'auth_error',
                payload: { error: 'No GitHub token: configure GITHUB_TOKEN or authenticate from the app' }
            });
        }
    } catch (e) {
        sendTo(clientId, {
            type: 'auth_error',
            payload: { error: `Token non valido: ${e.message}` }
        });
    }
}

function handleChatMessage(clientId, message) {
    const payload = message.payload || {};
    const msgObj = payload.message || {};
    const text = (typeof msgObj.content === 'string' && msgObj.content) || payload.text || '';
    if (!text.trim()) {
        sendTo(clientId, { type: 'error', payload: { error: 'Messaggio vuoto' } });
        return;
    }
    const providerId = payload.providerId || (payload.provider === 'openrouter' ? 'openai-compatible' : '');
    const model = payload.model;
    const apiKey = payload.apiKey;
    const baseUrl = payload.baseUrl || '';
    const conversationId = typeof payload.conversationId === 'string' && payload.conversationId.trim()
        ? payload.conversationId.trim()
        : 'default';
    if (typeof providerId !== 'string' || !providerId.trim()) {
        sendTo(clientId, { type: 'error', payload: { error: 'Provider ID missing: configure it in the app Settings.' } });
        return;
    }
    if (typeof model !== 'string' || !model.trim()) {
        sendTo(clientId, { type: 'error', payload: { error: 'Model ID missing: configure it in the app Settings.' } });
        return;
    }
    if (apiKey != null && typeof apiKey !== 'string') {
        sendTo(clientId, { type: 'error', payload: { error: 'Provider API key must be a string.' } });
        return;
    }
    if (CLINE_RUNTIME !== 'cli' && (typeof apiKey !== 'string' || !apiKey.trim())) {
        sendTo(clientId, { type: 'error', payload: { error: 'Provider API key missing: configure it in the app Settings.' } });
        return;
    }
    if (typeof baseUrl !== 'string') {
        sendTo(clientId, { type: 'error', payload: { error: 'Base URL must be a string.' } });
        return;
    }
    if (baseUrl.trim()) {
        let parsedBaseUrl;
        try {
            parsedBaseUrl = new URL(baseUrl);
        } catch {
            sendTo(clientId, { type: 'error', payload: { error: 'Base URL must be a valid HTTP or HTTPS URL.' } });
            return;
        }
        if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) {
            sendTo(clientId, { type: 'error', payload: { error: 'Base URL must use HTTP or HTTPS.' } });
            return;
        }
    }
    if (CLINE_RUNTIME === 'cli' && baseUrl.trim()) {
        sendTo(clientId, {
            type: 'error',
            payload: { error: 'Custom base URLs are supported by the SDK runtime, not CLINE_RUNTIME=cli.' }
        });
        return;
    }
    if (CLINE_RUNTIME === 'cli') {
        runClineCli(clientId, conversationId, text.trim(), {
            provider: providerId.trim(),
            model: model.trim(),
            apiKey: typeof apiKey === 'string' ? apiKey.trim() : ''
        });
    } else if (CLINE_RUNTIME === 'sdk') {
        runClineSdk(clientId, conversationId, text.trim(), {
            providerId: providerId.trim(),
            model: model.trim(),
            apiKey: apiKey.trim(),
            baseUrl: baseUrl.trim()
        });
    } else {
        sendTo(clientId, {
            type: 'error',
            payload: { error: `Unsupported CLINE_RUNTIME "${sanitizeErrorText(CLINE_RUNTIME)}"; use "cli" or "sdk".` }
        });
    }
}

async function getFreeClineModels() {
    if (clineModelsCache.expiresAt > Date.now() && clineModelsCache.models) {
        return clineModelsCache.models;
    }
    const { fetchLiveProviderModels } = await import('@cline/llms');
    const providerModels = await fetchLiveProviderModels(
        'https://models.dev/api.json',
        fetch,
        { includeClineCloudModels: false }
    );
    const models = normalizeFreeClineModels(providerModels.cline || {});
    if (!models.length) throw new Error('Cline returned no free models in its current catalog.');
    clineModelsCache = { expiresAt: Date.now() + CLINE_MODELS_CACHE_MS, models };
    return models;
}

function normalizeFreeClineModels(providerModels) {
    return Object.entries(providerModels)
        .map(([id, model]) => ({
            id,
            name: typeof model.name === 'string' && model.name.trim() ? model.name : id,
            description: typeof model.description === 'string' ? model.description : ''
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
}

async function sendFreeClineModels(clientId) {
    try {
        const models = await getFreeClineModels();
        sendTo(clientId, { type: 'cline_models', payload: { models } });
    } catch (error) {
        const detail = sanitizeErrorText(error && error.message ? error.message : error);
        console.error('Failed to load Cline free-model catalog:', detail);
        sendTo(clientId, { type: 'cline_models_error', payload: { error: detail } });
    }
}

function cleanClineAuthOutput(text) {
    return sanitizeErrorText(String(text).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ''));
}

function startClineAuth(clientId) {
    if (clineAuthProcess && clineAuthProcess.exitCode == null && !clineAuthProcess.killed) {
        sendTo(clientId, {
            type: 'cline_auth_event',
            payload: { state: 'error', text: 'A Cline sign-in is already in progress.' }
        });
        return;
    }

    sendTo(clientId, {
        type: 'cline_auth_event',
        payload: { state: 'started', text: 'Starting Cline sign-in…' }
    });

    let child;
    try {
        child = spawnCline(['auth', 'cline'], {
            cwd: CLINE_CWD,
            stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (error) {
        sendTo(clientId, {
            type: 'cline_auth_event',
            payload: { state: 'error', text: `Unable to start Cline sign-in: ${sanitizeErrorText(error.message)}` }
        });
        return;
    }

    clineAuthProcess = child;
    const buffers = { stdout: '', stderr: '' };
    let spawnFailed = false;
    const forwardOutput = (stream, data, flush = false) => {
        buffers[stream] += data;
        let newline;
        while ((newline = buffers[stream].indexOf('\n')) >= 0) {
            const line = buffers[stream].slice(0, newline).replace(/\r$/, '');
            buffers[stream] = buffers[stream].slice(newline + 1);
            const text = cleanClineAuthOutput(line);
            if (text) {
                sendTo(clientId, { type: 'cline_auth_event', payload: { state: 'output', text } });
            }
        }
        if (flush && buffers[stream].trim()) {
            const text = cleanClineAuthOutput(buffers[stream]);
            buffers[stream] = '';
            if (text) {
                sendTo(clientId, { type: 'cline_auth_event', payload: { state: 'output', text } });
            }
        }
    };
    child.stdout.on('data', data => forwardOutput('stdout', data.toString()));
    child.stderr.on('data', data => forwardOutput('stderr', data.toString()));
    child.on('error', error => {
        spawnFailed = true;
        sendTo(clientId, {
            type: 'cline_auth_event',
            payload: { state: 'error', text: `Cline sign-in failed: ${sanitizeErrorText(error.message)}` }
        });
    });
    child.on('close', code => {
        forwardOutput('stdout', '', true);
        forwardOutput('stderr', '', true);
        if (clineAuthProcess === child) {
            clineAuthProcess = null;
        }
        if (spawnFailed) return;
        const succeeded = code === 0;
        sendTo(clientId, {
            type: 'cline_auth_event',
            payload: {
                state: succeeded ? 'completed' : 'error',
                text: succeeded
                    ? 'Cline sign-in completed.'
                    : `Cline sign-in exited with code ${code}.`
            }
        });
    });
}

function execFileAsync(file, args, options) {
    return new Promise((resolve, reject) => {
        execFile(file, args, options, (error, stdout, stderr) => {
            if (error) {
                error.stderr = stderr;
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}

function parseGitStatus(output) {
    const lines = output.split(/\r?\n/).filter(Boolean);
    const branchLine = lines.find((line) => line.startsWith('## ')) || '';
    const branchTracking = branchLine.slice(3);
    return {
        branch: branchTracking.split('...')[0] || 'HEAD',
        tracking: branchTracking.includes('...') ? branchTracking.slice(branchTracking.indexOf('...') + 3) : '',
        changes: lines.filter((line) => !line.startsWith('## '))
    };
}

function isGitHubNotFound(error) {
    return /GitHub API error 404:/.test(error.message || '');
}

async function getPagesStatus(clientId, owner, repo) {
    const token = clientTokens.get(clientId);
    const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pages`;
    try {
        const page = await githubRequest(repoPath, { token });
        let lastBuild = null;
        try {
            lastBuild = await githubRequest(`${repoPath}/builds/latest`, { token });
        } catch (error) {
            if (!isGitHubNotFound(error)) throw error;
        }
        return {
            enabled: true,
            status: page.status || 'unknown',
            url: page.html_url || '',
            buildStatus: lastBuild?.status || '',
            buildUpdatedAt: lastBuild?.updated_at || lastBuild?.created_at || ''
        };
    } catch (error) {
        if (isGitHubNotFound(error)) {
            return { enabled: false };
        }
        return { enabled: null, error: sanitizeErrorText(error.message) };
    }
}

async function handleSourceControlRequest(clientId, payload = {}) {
    const repository = typeof payload.repository === 'string' ? payload.repository.trim() : '';
    const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
    if (!match) {
        sendTo(clientId, {
            type: 'source_control_error',
            payload: { repository, error: 'Repository must use the owner/repository format.' }
        });
        return;
    }

    try {
        const [statusOutput, lastCommitAt, pages] = await Promise.all([
            execFileAsync('git', ['status', '--short', '--branch', '--untracked-files=normal'], {
                cwd: CLINE_CWD,
                maxBuffer: 1024 * 1024
            }),
            execFileAsync('git', ['log', '-1', '--format=%cI'], {
                cwd: CLINE_CWD,
                maxBuffer: 64 * 1024
            }),
            getPagesStatus(clientId, match[1], match[2])
        ]);
        sendTo(clientId, {
            type: 'source_control_result',
            payload: {
                repository,
                git: { ...parseGitStatus(statusOutput), lastCommitAt: lastCommitAt.trim() },
                pages,
                checkedAt: new Date().toISOString()
            }
        });
    } catch (error) {
        sendTo(clientId, {
            type: 'source_control_error',
            payload: { repository, error: sanitizeErrorText(error.message) }
        });
    }
}

async function handleMessage(clientId, message) {
    switch (message.type) {
        case 'connect':
            // Connection already handled via WebSocket
            break;

        case 'auth':
            await handleAuth(clientId, message);
            break;

        case 'ping':
            sendTo(clientId, { type: 'pong' });
            break;

        case 'chat_message':
            if (!requireAuth(clientId)) break;
            handleChatMessage(clientId, message);
            break;

        case 'cline_models_request':
            if (!requireAuth(clientId)) break;
            await sendFreeClineModels(clientId);
            break;

        case 'cline_auth_start':
            if (!requireAuth(clientId)) break;
            startClineAuth(clientId);
            break;

        case 'source_control_request':
            if (!requireAuth(clientId)) break;
            await handleSourceControlRequest(clientId, message.payload);
            break;

        case 'chat_stop':
            stoppedClients.add(clientId);
            stopCline(clientId);
            break;

        case 'command':
            if (!requireAuth(clientId)) break;
            handleCommand(clientId, message.payload && message.payload.command);
            break;

        case 'action_approve':
            if (!requireAuth(clientId)) break;
            handleActionApprove(clientId, message.payload && message.payload.actionId);
            break;

        case 'action_deny':
            if (!requireAuth(clientId)) break;
            handleActionDeny(clientId, message.payload && message.payload.actionId);
            break;

        default:
            console.log(`Unhandled message type: ${message.type}`);
    }
}

function handleCommand(clientId, command) {
    console.log(`Executing command: ${command}`);

    // Send command to output channel
    // In a real app, this would use child_process or a terminal API
    const output = `Command executed: ${command}\n`;
    sendTo(clientId, {
        type: 'chat_stream',
        payload: { text: output }
    });

    sendTo(clientId, {
        type: 'chat_message',
        payload: {
            role: 'user',
            text: command,
            timestamp: Date.now()
        }
    });

    // Add simulated response
    setTimeout(() => {
        const response = `Output for: ${command}\n[This would be the actual command output]`;
        sendTo(clientId, {
            type: 'chat_stream',
            payload: { text: response }
        });

        sendTo(clientId, {
            type: 'chat_message',
            payload: {
                role: 'assistant',
                text: response,
                timestamp: Date.now()
            }
        });
    }, 1000);
}

function handleActionApprove(clientId, actionId) {
    console.log(`Action approved: ${actionId}`);
    sendTo(clientId, {
        type: 'action_approved',
        payload: { actionId }
    });
}

function handleActionDeny(clientId, actionId) {
    console.log(`Action denied: ${actionId}`);
    sendTo(clientId, {
        type: 'action_denied',
        payload: { actionId }
    });
}

function wsFor(clientId) {
    const client = clients.get(clientId);
    if (!client) {
        throw new Error(`Client ${clientId} not found`);
    }
    return client;
}

function sendTo(clientId, obj) {
    const client = clients.get(clientId);
    if (client && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(obj));
    }
}

function msgId() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function conversationKey(clientId, conversationId) {
    return JSON.stringify([clientId, conversationId]);
}

function sanitizeErrorText(value) {
    return String(value)
        .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
        .replace(/\bsk-or-v1-[a-zA-Z0-9_-]+\b/g, '[REDACTED]')
        .replace(/(api[_-]?key["'\s:=]+)[^\s,"'}]+/gi, '$1[REDACTED]')
        .trim()
        .slice(0, 1200);
}

function formatClineError(errorEvent) {
    const details = [];
    const addDetail = (label, value) => {
        if (typeof value === 'string' && value.trim()) {
            details.push(`${label}: ${sanitizeErrorText(value)}`);
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            details.push(`${label}: ${value}`);
        } else if (value && typeof value === 'object') {
            for (const key of ['message', 'text', 'code', 'status', 'statusCode', 'details', 'reason']) {
                addDetail(key, value[key]);
            }
        }
    };

    for (const key of ['text', 'message', 'error', 'details', 'reason', 'code', 'status', 'statusCode']) {
        addDetail(key, errorEvent[key]);
    }
    if (details.length) return [...new Set(details)].join(' — ').slice(0, 1600);

    const fields = Object.keys(errorEvent).filter((key) => key !== 'type');
    return fields.length
        ? `Cline reported an error without a readable message (fields: ${fields.join(', ')}). Check bridge logs.`
        : 'Cline reported an error without details. Check bridge logs.';
}

// Validate a GitHub token by calling the API; returns the user on success
async function fetchUser(token) {
    const response = await fetch('https://api.github.com/user', {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });
    if (!response.ok) {
        throw new Error(`GitHub API ${response.status}`);
    }
    return response.json();
}

function buildClineArgs(config = {}) {
    const args = ['--json', '--auto-approve', 'true'];
    const provider = config.provider || CLINE_PROVIDER;
    const model = config.model || CLINE_MODEL;
    const apiKey = config.apiKey || CLINE_API_KEY;
    if (config.configDir) args.push('--config', config.configDir);
    if (provider) args.push('-P', provider);
    if (model) args.push('-m', model);
    if (apiKey) args.push('-k', apiKey);
    if (CLINE_THINKING) args.push('--thinking', CLINE_THINKING);
    return args;
}

function spawnCline(args, options) {
    const commandArgs = process.env.CLINE_BIN ? args : [CLINE_ENTRY, ...args];
    return spawn(CLINE_BIN, commandArgs, options);
}

function formatToolActivity(toolCall) {
    const name = typeof toolCall.toolName === 'string' ? toolCall.toolName : 'agent tool';
    const input = toolCall.input && typeof toolCall.input === 'object'
        ? toolCall.input
        : {};
    const target = [input.path, input.filePath, input.file]
        .find((value) => typeof value === 'string' && value.trim());
    const suffix = target ? `: ${sanitizeErrorText(target)}` : '';
    const labels = {
        read_file: `Reading file${suffix}`,
        write_file: `Creating or editing file${suffix}`,
        search_codebase: `Searching code${input.query ? `: ${sanitizeErrorText(input.query)}` : ''}`,
        run_command: `Running command${input.command ? `: ${sanitizeErrorText(input.command)}` : ''}`
    };
    return labels[name] || `${sanitizeErrorText(name.replace(/[_-]+/g, ' '))}${suffix}`;
}

function sendAgentToolActivity(clientId, toolCall, status, isError = false) {
    if (!toolCall || typeof toolCall.toolCallId !== 'string') return;
    sendTo(clientId, {
        type: 'agent_tool_activity',
        payload: {
            id: toolCall.toolCallId,
            text: formatToolActivity(toolCall),
            status,
            isError
        }
    });
}

async function runClineSdk(clientId, conversationId, userText, config) {
    stopCline(clientId);

    const contextKey = conversationKey(clientId, conversationId);
    const history = conversations.get(contextKey) || [];
    const task = { agent: null, cancelled: false };
    runningAgents.set(clientId, task);
    partials.set(clientId, '');

    try {
        const agent = await createSdkAgent({
            apiKey: config.apiKey,
            conversationId: contextKey,
            cwd: CLINE_CWD,
            history: history.slice(-MAX_HISTORY_MESSAGES),
            model: config.model,
            providerId: config.providerId,
            baseUrl: config.baseUrl,
            githubToken: clientTokens.get(clientId) || activeToken
        });
        task.agent = agent;
        if (task.cancelled) {
            agent.abort();
            stoppedClients.delete(clientId);
            return;
        }

        const unsubscribe = agent.subscribe((event) => {
            if (runningAgents.get(clientId) !== task) return;
            if (event.type === 'assistant-text-delta' && event.text) {
                partials.set(clientId, (partials.get(clientId) || '') + event.text);
                sendTo(clientId, { type: 'chat_stream', payload: { text: event.text } });
            } else if (
                event.type === 'assistant-reasoning-delta' &&
                event.text &&
                !event.redacted
            ) {
                sendTo(clientId, {
                    type: 'agent_reasoning_delta',
                    payload: { text: event.text }
                });
            } else if (event.type === 'tool-started') {
                sendAgentToolActivity(clientId, event.toolCall, 'started');
            } else if (event.type === 'tool-finished') {
                const resultPart = event.message.content.find((part) => part.type === 'tool-result');
                sendAgentToolActivity(
                    clientId,
                    event.toolCall,
                    resultPart?.isError ? 'failed' : 'completed',
                    resultPart?.isError === true
                );
            }
        });

        try {
            const result = await agent.run(userText);
            const wasStopped = stoppedClients.delete(clientId);
            if (task.cancelled && !wasStopped) return;

            const partial = partials.get(clientId) || '';
            if (result.status === 'completed' && result.outputText.trim()) {
                conversations.set(contextKey, [
                    ...history,
                    { role: 'user', content: userText },
                    { role: 'assistant', content: result.outputText }
                ]);
                sendTo(clientId, {
                    type: 'chat_message',
                    payload: {
                        message: {
                            id: msgId(),
                            role: 'assistant',
                            content: result.outputText,
                            timestamp: Date.now()
                        }
                    }
                });
            } else if (wasStopped || result.status === 'aborted') {
                const response = partial || '(Stopped)';
                conversations.set(contextKey, [
                    ...history,
                    { role: 'user', content: userText },
                    { role: 'assistant', content: response }
                ]);
                sendTo(clientId, {
                    type: 'chat_message',
                    payload: {
                        message: { id: msgId(), role: 'assistant', content: response, timestamp: Date.now() }
                    }
                });
            } else {
                const detail = result.error?.message || agent.snapshot().lastError;
                throw new Error(detail || `Cline SDK run ended with status ${result.status} without output.`);
            }
        } finally {
            unsubscribe();
        }
    } catch (error) {
        const wasStopped = stoppedClients.delete(clientId);
        if (!task.cancelled || wasStopped) {
            const detail = sanitizeErrorText(error && error.message ? error.message : error);
            console.error('Cline SDK error:', detail);
            sendTo(clientId, { type: 'error', payload: { error: `Cline SDK: ${detail}` } });
        }
    } finally {
        if (runningAgents.get(clientId) === task) {
            runningAgents.delete(clientId);
            partials.delete(clientId);
        }
    }
}

// Run a single Cline task for a client. Each turn is a fresh session that
// replays recent conversation context in the prompt, working around the broken
// `--id` resume in --json mode (cline/cline#10856). Streams NDJSON events back
// to the app as chat_stream / chat_message / error bridge messages.
function runClineCli(clientId, conversationId, userText, config) {
    stopCline(clientId);

    const contextKey = conversationKey(clientId, conversationId);
    const history = conversations.get(contextKey) || [];
    const recent = history.slice(-MAX_HISTORY_MESSAGES);
    const transcript = recent
        .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
        .join('\n\n');
    const prompt = transcript
        ? `${transcript}\n\nUser: ${userText}\n\nAssistant:`
        : userText;

    const args = buildClineArgs(config);
    args.push(prompt); // positional prompt

    let child;
    try {
        child = spawnCline(args, {
            cwd: CLINE_CWD,
            env: createGitHubTokenEnv(clientTokens.get(clientId) || activeToken),
            stdio: ['pipe', 'pipe', 'pipe']
        });
    } catch (e) {
        sendTo(clientId, { type: 'error', payload: { error: `Unable to start Cline: ${e.message}` } });
        return;
    }
    runningTasks.set(clientId, child);
    partials.set(clientId, '');
    // Close stdin so --json doesn't wait for piped input; the prompt is positional
    try { child.stdin.end(); } catch (e) { /* ignore */ }

    let stdoutBuf = '';
    let stderrBuf = '';
    let finalText = null;
    let spawnError = false;

    child.stdout.on('data', (d) => {
        stdoutBuf += d.toString();
        let nl;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
            const line = stdoutBuf.slice(0, nl).trim();
            stdoutBuf = stdoutBuf.slice(nl + 1);
            if (!line) continue;
            let evt;
            try { evt = JSON.parse(line); } catch (e) { continue; }
            handleClineEvent(clientId, evt);
            if (evt.type === 'run_result' && typeof evt.text === 'string') {
                finalText = evt.text;
            } else if (
                evt.type === 'agent_event' && evt.event &&
                evt.event.type === 'done' && finalText == null &&
                typeof evt.event.text === 'string'
            ) {
                finalText = evt.event.text;
            }
        }
    });

    child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

    child.on('error', (err) => {
        spawnError = true;
        runningTasks.delete(clientId);
        sendTo(clientId, { type: 'error', payload: { error: `Cline: ${err.message}` } });
    });

    child.on('close', (code) => {
        runningTasks.delete(clientId);
        const wasStopped = stoppedClients.delete(clientId);
        const partial = partials.get(clientId) || '';
        partials.delete(clientId);

        // Flush any trailing stdout without a newline
        if (stdoutBuf.trim()) {
            try { handleClineEvent(clientId, JSON.parse(stdoutBuf.trim())); } catch (e) { /* ignore */ }
        }
        if (spawnError) return;

        let errMessage = null;
        if (finalText == null && stderrBuf.trim()) {
            const lastLine = stderrBuf.trim().split('\n').pop();
            try {
                const parsed = JSON.parse(lastLine);
                if (parsed.type === 'error') errMessage = parsed.message;
            } catch (e) { /* not JSON */ }
            if (!errMessage) errMessage = stderrBuf.trim().slice(0, 500);
        }

        if (finalText != null) {
            conversations.set(contextKey, [
                ...history,
                { role: 'user', content: userText },
                { role: 'assistant', content: finalText }
            ]);
            sendTo(clientId, {
                type: 'chat_message',
                payload: { message: { id: msgId(), role: 'assistant', content: finalText, timestamp: Date.now() } }
            });
        } else if (wasStopped) {
            conversations.set(contextKey, [
                ...history,
                { role: 'user', content: userText },
                { role: 'assistant', content: partial || '(interrotto)' }
            ]);
            sendTo(clientId, {
                type: 'chat_message',
                payload: { message: { id: msgId(), role: 'assistant', content: partial || '(interrotto)', timestamp: Date.now() } }
            });
        } else if (errMessage) {
            sendTo(clientId, { type: 'error', payload: { error: errMessage } });
        } else {
            sendTo(clientId, { type: 'error', payload: { error: `Cline exited without output (code ${code})` } });
        }
    });
}

function handleClineEvent(clientId, evt) {
    if (evt.type !== 'agent_event' || !evt.event) return;
    const e = evt.event;
    if (e.type === 'content_start' || e.type === 'content_update' || e.type === 'assistant-text-delta') {
        const delta = extractDelta(e);
        if (delta) {
            partials.set(clientId, (partials.get(clientId) || '') + delta);
            sendTo(clientId, { type: 'chat_stream', payload: { text: delta } });
        }
    } else if (
        (e.type === 'assistant-reasoning-delta' || e.type === 'reasoning-delta') &&
        !e.redacted
    ) {
        const delta = extractDelta(e);
        if (delta) sendTo(clientId, { type: 'agent_reasoning_delta', payload: { text: delta } });
    } else if (e.type === 'tool-started' || e.type === 'tool-start') {
        sendAgentToolActivity(clientId, e.toolCall || e, 'started');
    } else if (e.type === 'tool-finished' || e.type === 'tool-finish') {
        sendAgentToolActivity(
            clientId,
            e.toolCall || e,
            e.isError ? 'failed' : 'completed',
            e.isError === true
        );
    } else if (e.type === 'error') {
        const error = formatClineError(e);
        console.error('Cline agent error:', error);
        sendTo(clientId, { type: 'error', payload: { error } });
    }
    // other event types (iteration_*, usage, notice, done) are ignored for now
}

function extractDelta(e) {
    if (typeof e.text === 'string') return e.text;
    if (typeof e.content === 'string') return e.content;
    if (typeof e.delta === 'string') return e.delta;
    if (typeof e.value === 'string') return e.value;
    if (typeof e.chunk === 'string') return e.chunk;
    return '';
}

function stopCline(clientId) {
    const agentTask = runningAgents.get(clientId);
    if (agentTask) {
        agentTask.cancelled = true;
        if (agentTask.agent) agentTask.agent.abort();
        runningAgents.delete(clientId);
    }
    const child = runningTasks.get(clientId);
    if (child) {
        try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
        runningTasks.delete(clientId);
    }
}

// Create HTTP server
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Cline Agent Mobile Bridge Server');
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, request) => {
    handleWebSocketConnection(ws, request);
});

// Start server
server.listen(PORT, () => {
    console.log(`Bridge server listening on port ${PORT}`);
    console.log(`GITHUB_TOKEN: ${activeToken ? 'Configured' : 'Not configured (set env var or authenticate from the app)'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down');
    wss.close(() => {
        server.close(() => {
            process.exit(0);
        });
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down');
    wss.close(() => {
        server.close(() => {
            process.exit(0);
        });
    });
});

module.exports = {
    server,
    wss,
    listMyCodespaces,
    getCodespace,
    createCodespace,
    startCodespace,
    stopCodespace,
    restartCodespace,
    deleteCodespace,
    broadcastState,
    serverState,
    // Cline integration + auth helpers (exposed for tests)
    buildClineArgs,
    createSdkAgent,
    conversationKey,
    extractDelta,
    formatClineError,
    formatToolActivity,
    getFreeClineModels,
    normalizeFreeClineModels,
    parseGitStatus,
    fetchUser,
    handleMessage,
    toSdkMessages: require('./cline-sdk').toSdkMessages
};
