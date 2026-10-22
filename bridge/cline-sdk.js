const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SEARCH_RESULTS = 50;
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', '.cline']);

function toSdkMessages(history) {
    return history.map((message, index) => ({
        id: `history-${index}`,
        role: message.role,
        content: [{ type: 'text', text: message.content }],
        createdAt: index + 1
    }));
}

function resolveWorkspacePath(cwd, requestedPath) {
    if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
        throw new Error('A non-empty workspace-relative path is required.');
    }

    const workspace = path.resolve(cwd);
    const resolved = path.resolve(workspace, requestedPath);
    const relative = path.relative(workspace, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Path must stay inside the current repository.');
    }
    return resolved;
}

function createGitHubTokenEnv(token, baseEnv = process.env) {
    if (typeof token !== 'string' || !token.trim()) return baseEnv;
    return {
        ...baseEnv,
        GH_TOKEN: token,
        GITHUB_TOKEN: token
    };
}

function createRepositoryTools(cwd, githubToken) {
    const workspace = path.resolve(cwd);
    const ensureInsideWorkspace = (target) => {
        const relative = path.relative(workspace, target);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error('Path must stay inside the current repository.');
        }
    };
    const readFile = {
        name: 'read_file',
        description: 'Read a UTF-8 text file in the current repository.',
        inputSchema: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Repository-relative file path.' } },
            required: ['path'],
            additionalProperties: false
        },
        async execute(input) {
            const target = resolveWorkspacePath(workspace, input.path);
            const realTarget = await fs.promises.realpath(target);
            ensureInsideWorkspace(realTarget);
            const info = await fs.promises.stat(realTarget);
            if (info.size > MAX_FILE_BYTES) {
                throw new Error(`File exceeds the ${MAX_FILE_BYTES}-byte read limit.`);
            }
            return (await fs.promises.readFile(realTarget, 'utf8'));
        }
    };
    const searchCodebase = {
        name: 'search_codebase',
        description: 'Search repository text files for a literal query and return matching paths and lines.',
        inputSchema: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Literal text to find.' } },
            required: ['query'],
            additionalProperties: false
        },
        async execute(input) {
            if (typeof input.query !== 'string' || !input.query.trim()) {
                throw new Error('Search query must not be empty.');
            }
            const query = input.query.toLowerCase();
            const matches = [];
            const pending = [workspace];
            let inspected = 0;
            while (pending.length && matches.length < MAX_SEARCH_RESULTS && inspected < 5000) {
                const directory = pending.pop();
                const entries = await fs.promises.readdir(directory, { withFileTypes: true });
                for (const entry of entries) {
                    const target = path.join(directory, entry.name);
                    ensureInsideWorkspace(target);
                    if (entry.isDirectory()) {
                        if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) {
                            pending.push(target);
                        }
                        continue;
                    }
                    if (!entry.isFile()) continue;
                    inspected += 1;
                    const realTarget = await fs.promises.realpath(target);
                    ensureInsideWorkspace(realTarget);
                    const info = await fs.promises.stat(realTarget);
                    if (info.size > MAX_FILE_BYTES) continue;
                    const content = await fs.promises.readFile(realTarget, 'utf8');
                    const lines = content.split(/\r?\n/);
                    for (let index = 0; index < lines.length; index += 1) {
                        if (lines[index].toLowerCase().includes(query)) {
                            const file = path.relative(workspace, target).split(path.sep).join('/');
                            matches.push(`${file}:${index + 1}: ${lines[index].slice(0, 500)}`);
                            if (matches.length >= MAX_SEARCH_RESULTS) break;
                        }
                    }
                    if (matches.length >= MAX_SEARCH_RESULTS) break;
                }
            }
            return matches.length ? matches.join('\n') : 'No matches found.';
        }
    };
    const writeFile = {
        name: 'write_file',
        description: 'Create or replace a UTF-8 text file inside the current repository.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Repository-relative file path.' },
                content: { type: 'string', description: 'Complete file contents.' }
            },
            required: ['path', 'content'],
            additionalProperties: false
        },
        async execute(input) {
            if (typeof input.content !== 'string') throw new Error('File content must be text.');
            const target = resolveWorkspacePath(workspace, input.path);
            await ensureWorkspaceParent(path.dirname(target));
            const realParent = await fs.promises.realpath(path.dirname(target));
            ensureInsideWorkspace(realParent);
            try {
                const realTarget = await fs.promises.realpath(target);
                ensureInsideWorkspace(realTarget);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            await fs.promises.writeFile(target, input.content, 'utf8');
            return `Wrote ${path.relative(workspace, target).split(path.sep).join('/')}.`;
        }
    };

    async function ensureWorkspaceParent(parent) {
        const relative = path.relative(workspace, parent);
        let current = workspace;
        for (const segment of relative.split(path.sep).filter(Boolean)) {
            current = path.join(current, segment);
            try {
                const info = await fs.promises.lstat(current);
                if (info.isSymbolicLink() || !info.isDirectory()) {
                    throw new Error('File path cannot traverse symlinks or non-directory parents.');
                }
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
                await fs.promises.mkdir(current);
            }
        }
    }

    const runCommand = {
        name: 'run_command',
        description: 'Run a shell command in the current repository. Commands are automatically approved.',
        inputSchema: {
            type: 'object',
            properties: { command: { type: 'string', description: 'Shell command to execute.' } },
            required: ['command'],
            additionalProperties: false
        },
        async execute(input, context) {
            if (typeof input.command !== 'string' || !input.command.trim()) {
                throw new Error('Command must not be empty.');
            }
            try {
                const { stdout, stderr } = await execAsync(input.command, {
                    cwd: workspace,
                    shell: '/bin/bash',
                    env: createGitHubTokenEnv(githubToken),
                    timeout: 60_000,
                    maxBuffer: 1024 * 1024,
                    signal: context.signal
                });
                return truncateOutput([stdout, stderr].filter(Boolean).join('\n'));
            } catch (error) {
                if (context.signal.aborted) throw error;
                const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
                return truncateOutput(`Command failed (exit ${error.code ?? 'unknown'}):\n${output}`);
            }
        }
    };
    return [readFile, searchCodebase, writeFile, runCommand];
}

async function createSdkAgent({
    apiKey,
    baseUrl,
    conversationId,
    cwd,
    history,
    githubToken,
    model,
    providerId
}) {
    const { Agent } = await import('@cline/agents');
    const tools = createRepositoryTools(cwd, githubToken);
    const toolPolicies = Object.fromEntries(
        tools.map((tool) => [tool.name, { enabled: true, autoApprove: true }])
    );

    return new Agent({
        clientName: 'cline-agent-mobile',
        providerId,
        modelId: model,
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
        conversationId,
        systemPrompt:
            'You are Cline, an autonomous coding agent working in the current repository. ' +
            'Use the available tools to inspect and change the project when asked. ' +
            'Report accurately what you did and any remaining limitations.',
        tools,
        toolPolicies,
        initialMessages: toSdkMessages(history),
        maxIterations: 20
    });
}

function truncateOutput(output) {
    const limit = 20_000;
    return output.length > limit ? `${output.slice(0, limit)}\n[Output truncated]` : output;
}

const execAsync = require('util').promisify(require('child_process').exec);
const fs = require('fs');
const path = require('path');

module.exports = {
    OPENROUTER_BASE_URL,
    createGitHubTokenEnv,
    createSdkAgent,
    createRepositoryTools,
    resolveWorkspacePath,
    toSdkMessages
};
