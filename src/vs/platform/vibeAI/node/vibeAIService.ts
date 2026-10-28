/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { timeout } from '../../../base/common/async.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { IVibeAICustomizeCreateData, IVibeAICustomizeItem, IVibeAICustomizeResult, IVibeAIChatRequest, IVibeAICompletionRequest, IVibeAIContextUsage, IVibeAIContextUsageRequest, IVibeAIExecutePlanRequest, IVibeAIInlineEditRequest, IVibeAIModelProvider, IVibeAIPlan, IVibeAIPlanStep, IVibeAIQuestion, IVibeAIService, IVibeAISkill, IVibeAIStreamData, IVibeAISubagent, VIBE_AI_DEFAULT_BACKEND_URL, VibeAICustomizeKind, VibeAICustomizeScope } from '../common/vibeAI.js';
import { ChildProcess, spawn } from 'child_process';
import * as os from 'os';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { FileAccess } from '../../../base/common/network.js';
import { dirname, isAbsolute, join, normalize } from '../../../base/common/path.js';

/**
 * Resolve a possibly-relative `backendRoot` (portable distribution: the
 * same product.json must work on any machine) to an absolute directory.
 * Absolute values pass through untouched. Relative values are matched
 * against candidate anchors and the first one that actually contains
 * the backend — Phase 147: the compiled `VulcanBackend.exe`, or the dev
 * checkout's `app/main.py` — wins:
 * 1. the app root (backend shipped inside the fork checkout),
 * 2. its parent (dev checkout: `backend/` sits next to `vscode/`),
 * 3. the exe directory (packaged portable layout).
 */
export function resolveBackendRootPath(configured: string, appRoot: string, execPath: string): string {
	if (!configured || isAbsolute(configured)) {
		return configured;
	}
	const candidates = [join(appRoot, configured), join(dirname(appRoot), configured), join(dirname(execPath), configured)];
	for (const candidate of candidates) {
		if (existsSync(join(candidate, 'app', 'main.py')) || existsSync(join(candidate, BACKEND_EXE_NAME))) {
			return normalize(candidate);
		}
	}
	// Nothing found: return the app-root candidate so the caller's
	// "backend root not found" warning names a concrete path.
	return normalize(candidates[0]);
}

/**
 * Compiled backend executable shipped by the packaging pipeline (Phase 147):
 * the Nuitka-compiled `launcher.py`, staged flat into `{backendRoot}`. Its
 * presence switches the editor to exe spawn (no Python/venv provisioning at
 * all); a dev checkout without the exe keeps the venv + uvicorn path below.
 */
const BACKEND_EXE_NAME = 'VulcanBackend.exe';

/**
 * First-run provisioning constants: the Python 3.12 release the editor
 * auto-installs when no usable (3.10+) interpreter exists - winget id
 * Python.Python.3.12 / the matching python.org Windows installer.
 */
const PYTHON_INSTALL_VERSION = '3.12.8';
const PYTHON_INSTALL_CORE = '3.12';

/**
 * Extract the python.exe path from `reg query ...InstallPath /ve` output.
 * reg prints the default value as: "(Default)    REG_SZ    C:\...\Python312\"
 * - anything else (REG_BINARY, empty or missing output) yields undefined.
 */
export function findPythonInRegistryOutput(output: string | null): string | undefined {
	if (!output) {
		return undefined;
	}
	for (const line of output.split(/\r?\n/)) {
		const match = /REG_SZ\s+(.+?)\s*$/.exec(line);
		if (match) {
			return join(match[1].replace(/\\$/, ''), 'python.exe');
		}
	}
	return undefined;
}

/**
 * Node (main process) implementation of the {@link IVibeAIService}.
 *
 * Performs the HTTP requests against the local VibeCoding backend
 * (FastAPI) and parses the SSE stream into {@link IVibeAIStreamData}
 * events. Running in the main process means the requests bypass the
 * CORS restrictions of the browser layer.
 */
export class VibeAIService extends Disposable implements IVibeAIService {

	declare readonly _serviceBrand: undefined;

	private readonly _onStreamData = this._register(new Emitter<IVibeAIStreamData>());
	readonly onStreamData = this._onStreamData.event;

	private readonly activeStreams = new Map<string, AbortController>();

	// Cursor-style backend ownership: the editor is the entry point and owns
	// its local AI backend as a child of its process tree (spawn/reuse, killed on quit).
	private backendChild: ChildProcess | null = null;

	constructor(
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService
	) {
		super();
		// Fire-and-forget: startup must never block on the backend coming up.
		this._ensureBackend();
	}

	get backendUrl(): string {
		return this.productService.vibeAI?.backendUrl ?? process.env['VIBE_BACKEND_URL'] ?? VIBE_AI_DEFAULT_BACKEND_URL;
	}

	/**
	 * Root directory of the local VibeCoding backend: the compiled
	 * `VulcanBackend.exe` (packaged product, Phase 147) or `app/main.py` +
	 * `venv/` (dev checkout). Configured via product.json `vibeAI.backendRoot`,
	 * with an environment override for local development.
	 */
	get backendRoot(): string {
		// The launcher (start-fork.bat) exports an absolute VIBE_BACKEND_ROOT
		// for this machine, so it wins over the product.json default; a
		// relative product value is resolved against the app root (see
		// resolveBackendRootPath) for portable distributions.
		const configured = process.env['VIBE_BACKEND_ROOT'] ?? this.productService.vibeAI?.backendRoot ?? '';
		return resolveBackendRootPath(configured, dirname(FileAccess.asFileUri('').fsPath), process.execPath);
	}

	/**
	 * Cursor-style backend ownership (the editor is the entry point): make
	 * sure a healthy backend is listening on `backendUrl`. One that is already
	 * running (started manually) is reused, never duplicated; otherwise a
	 * local uvicorn instance is spawned from `backendRoot` as a child of this
	 * process and killed again on app quit ("follows the editor's lifecycle").
	 * Set `VIBE_BACKEND_SPAWN=0` to skip spawning (editor without backend).
	 */
	private async _ensureBackend(): Promise<void> {
		if (process.env['VIBE_BACKEND_SPAWN'] === '0') {
			this.logService.info('[VibeAI] VIBE_BACKEND_SPAWN=0, not spawning backend');
			return;
		}
		if (await this.healthCheck()) {
			this.logService.info(`[VibeAI] backend already running at ${this.backendUrl}, reusing it`);
			return;
		}

		const root = this.backendRoot;
		const backendExe = root ? join(root, BACKEND_EXE_NAME) : '';
		// Dual-path backend (Phase 147): the packaged product ships the
		// Nuitka-compiled exe (zero Python provisioning); a dev checkout
		// keeps the venv + `python -m uvicorn` spawn (--reload workflows).
		if (!root || (!existsSync(backendExe) && !existsSync(join(root, 'app', 'main.py')))) {
			this.logService.warn(`[VibeAI] backend root not found (${root || 'unset'}), not spawning backend`);
			return;
		}

		let host = '127.0.0.1';
		let port = '80';
		try {
			const url = new URL(this.backendUrl);
			host = url.hostname || host;
			port = url.port || port;
		} catch (error) {
			this.logService.warn(`[VibeAI] invalid backend URL (${this.backendUrl}), not spawning backend`, error);
			return;
		}

		let command: string;
		let args: string[];
		if (existsSync(backendExe)) {
			command = backendExe;
			args = ['--host', host, '--port', port];
		} else {
			// First-run provisioning: when the venv is missing or broken the
			// editor builds it itself (auto-installing Python 3.10+ when even
			// that is missing) so a colleague only ever double-clicks the app.
			const python = await this.ensureVenvPython(root);
			if (!python) {
				this.logService.warn('[VibeAI] backend venv unavailable, not spawning backend');
				return;
			}
			command = python;
			args = ['-m', 'uvicorn', 'app.main:app', '--host', host, '--port', port];
		}

		this.logService.info(`[VibeAI] spawning local backend (${existsSync(backendExe) ? BACKEND_EXE_NAME : 'uvicorn app.main:app'} --host ${host} --port ${port})`);
		const child = spawn(command, args, {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true
		});
		this.backendChild = child;
		child.stdout?.on('data', (chunk: Buffer) => this.logService.debug(`[VibeAI backend] ${String(chunk).trim()}`));
		child.stderr?.on('data', (chunk: Buffer) => this.logService.debug(`[VibeAI backend] ${String(chunk).trim()}`));
		child.on('error', error => {
			this.logService.error('[VibeAI] backend spawn failed', error);
			if (this.backendChild === child) {
				this.backendChild = null;
			}
		});
		child.on('exit', code => {
			this.logService.warn(`[VibeAI] backend process exited (code ${code})`);
			if (this.backendChild === child) {
				this.backendChild = null;
			}
		});

		// Readiness: uvicorn plus the app's imports (chromadb, ...) can take a
		// while - poll /health in the background, never block startup.
		for (let attempt = 0; attempt < 120; attempt++) {
			await timeout(500);
			if (child.exitCode !== null) {
				this.logService.error(`[VibeAI] backend exited during startup (code ${child.exitCode})`);
				return;
			}
			if (await this.healthCheck()) {
				this.logService.info(`[VibeAI] local backend ready at ${this.backendUrl} (pid ${child.pid})`);
				return;
			}
		}
		this.logService.warn('[VibeAI] backend did not become healthy within 60s');
	}

	/**
	 * First-run backend bootstrap (portable distribution): the editor itself
	 * provisions the backend environment so a colleague only ever double-
	 * clicks the app - no launcher script, no manual Python install. Returns
	 * the venv interpreter to spawn uvicorn with, or null when provisioning
	 * failed (logged and surfaced via popup).
	 */
	private async ensureVenvPython(root: string): Promise<string | null> {
		const venvPython = join(root, 'venv', 'Scripts', 'python.exe');
		if (existsSync(venvPython) && await this.venvImportsCleanly(venvPython)) {
			return venvPython;
		}
		// A venv bakes in the absolute path of the base python that created
		// it - one copied from another machine exists but fails the import
		// probe, so it is rebuilt from scratch either way.
		const hostPython = await this.findHostPython() ?? await this.installPython();
		if (!hostPython) {
			return null;
		}
		this.showBackendPopup('正在配置後端環境，首次啟動需下載依賴，請稍候……');
		if (!await this.buildVenv(root, hostPython, venvPython)) {
			this.showBackendPopup('後端環境配置失敗，請重新啟動軟件重試。', true);
			return null;
		}
		this.showBackendPopup('後端環境配置完成。');
		return venvPython;
	}

	/**
	 * The venv must import the backend's server dependencies cleanly - the
	 * probe catches a venv copied from another machine (its baked-in base
	 * python path broke) as well as a half-finished first install.
	 */
	private async venvImportsCleanly(venvPython: string): Promise<boolean> {
		return this.processSucceeds(venvPython, ['-c', 'import fastapi, uvicorn']);
	}

	/**
	 * Locate a usable Python 3.10+: `where` hits first (the first hit may be
	 * the Microsoft Store stub, which fails the version probe), then the
	 * known per-user install locations.
	 */
	private async findHostPython(): Promise<string | null> {
		const candidates: string[] = [];
		for (const executable of ['python', 'py']) {
			const where = await this.captureProcessOutput('where', [executable]);
			if (where) {
				candidates.push(...where.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0));
			}
		}
		const localAppData = process.env['LOCALAPPDATA'];
		if (localAppData) {
			for (const version of ['Python312', 'Python313']) {
				candidates.push(join(localAppData, 'Programs', 'Python', version, 'python.exe'));
			}
		}
		for (const candidate of candidates) {
			if (await this.isPythonAtLeast310(candidate)) {
				return candidate;
			}
		}
		return null;
	}

	/**
	 * The candidate must really run AND be 3.10+ - the Microsoft Store
	 * python stub exits with an error instead of executing, so a plain
	 * existsSync/where check is not enough.
	 */
	private async isPythonAtLeast310(pythonPath: string): Promise<boolean> {
		return this.processSucceeds(pythonPath, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)']);
	}

	/**
	 * Install Python 3.12 automatically when no usable 3.10+ exists: winget
	 * first (cleanest), then the official python.org installer fetched over
	 * HTTPS. Per-user install (InstallAllUsers=0) - no admin rights needed;
	 * PrependPath=1 makes future launches find it on PATH. Success is judged
	 * by locating and version-probing the interpreter afterwards, not by the
	 * installer exit code (3010 = reboot required still counts).
	 */
	private async installPython(): Promise<string | null> {
		this.showBackendPopup('沒有檢測到 Python 環境，正在幫你下載安裝，請稍候……');
		this.logService.info('[VibeAI] no Python 3.10+ found, installing Python automatically');
		const wingetOk = await this.processSucceeds('winget', [
			'install', '-e', '--id', `Python.Python.${PYTHON_INSTALL_CORE}`,
			'--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'
		]);
		if (!wingetOk) {
			this.logService.info('[VibeAI] winget unavailable or failed, falling back to the python.org installer');
			const installer = join(process.env['TEMP'] ?? os.tmpdir(), `python-${PYTHON_INSTALL_VERSION}-amd64.exe`);
			if (!await this.downloadPythonInstaller(installer) || !await this.runPythonInstaller(installer)) {
				return this.pythonInstallFailed();
			}
		}
		const located = await this.locateInstalledPython();
		if (!located) {
			return this.pythonInstallFailed();
		}
		this.logService.info(`[VibeAI] Python ready at ${located}`);
		return located;
	}

	private pythonInstallFailed(): null {
		this.showBackendPopup('Python 自動安裝失敗，請手動安裝 Python 3.10 以上版本後重試。', true);
		return null;
	}

	private async downloadPythonInstaller(target: string): Promise<boolean> {
		const url = `https://www.python.org/ftp/python/${PYTHON_INSTALL_VERSION}/python-${PYTHON_INSTALL_VERSION}-amd64.exe`;
		try {
			const response = await fetch(url);
			if (!response.ok) {
				this.logService.error(`[VibeAI] python.org installer download failed: HTTP ${response.status}`);
				return false;
			}
			writeFileSync(target, Buffer.from(await response.arrayBuffer()));
			return true;
		} catch (error) {
			this.logService.error('[VibeAI] python.org installer download failed', error);
			return false;
		}
	}

	private async runPythonInstaller(installer: string): Promise<boolean> {
		if (!existsSync(installer)) {
			return false;
		}
		this.logService.info('[VibeAI] installing Python per-user (quiet, no admin rights needed)');
		return this.waitForProcessExit(installer, ['/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_test=0']);
	}

	/**
	 * Find the interpreter the installer just laid down: the known per-user
	 * locations first, then the PEP 514 registry records (HKCU for per-user
	 * installs, HKLM for machine-wide ones).
	 */
	private async locateInstalledPython(): Promise<string | null> {
		const localAppData = process.env['LOCALAPPDATA'];
		if (localAppData) {
			for (const version of ['Python312', 'Python313']) {
				const candidate = join(localAppData, 'Programs', 'Python', version, 'python.exe');
				if (existsSync(candidate) && await this.isPythonAtLeast310(candidate)) {
					return candidate;
				}
			}
		}
		for (const hive of ['HKCU', 'HKLM']) {
			const output = await this.captureProcessOutput('reg', ['query', `${hive}\\Software\\Python\\PythonCore\\${PYTHON_INSTALL_CORE}\\InstallPath`, '/ve']);
			const candidate = findPythonInRegistryOutput(output);
			if (candidate && await this.isPythonAtLeast310(candidate)) {
				return candidate;
			}
		}
		return null;
	}

	/**
	 * Create the venv and install the pinned backend dependencies into it.
	 * A leftover broken venv (copied from another machine) is removed first
	 * - `python -m venv` would otherwise "succeed" while keeping the broken
	 * interpreter in place.
	 */
	private async buildVenv(root: string, hostPython: string, venvPython: string): Promise<boolean> {
		const venvDir = join(root, 'venv');
		if (existsSync(venvDir)) {
			try {
				rmSync(venvDir, { recursive: true, force: true });
			} catch (error) {
				this.logService.error('[VibeAI] failed to remove the broken backend venv', error);
				return false;
			}
		}
		if (!await this.processSucceeds(hostPython, ['-m', 'venv', venvDir])) {
			this.logService.error('[VibeAI] backend venv creation failed');
			return false;
		}
		// Upgrading pip is best-effort: the bundled pip is good enough.
		await this.processSucceeds(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip', '-q']);
		if (!await this.processSucceeds(venvPython, ['-m', 'pip', 'install', '-q', '-r', join(root, 'requirements.txt')])) {
			this.logService.error('[VibeAI] backend dependency installation failed');
			return false;
		}
		return true;
	}

	/**
	 * First-run progress popups. Chinese text is safe here (unlike in batch
	 * files): the string reaches PowerShell as native UTF-16 on the command
	 * line, no codepage is involved.
	 */
	private showBackendPopup(message: string, warning = false): void {
		const text = message.replace(/'/g, "''");
		spawn('powershell', [
			'-NoProfile', '-Command',
			`Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${text}', 'Vulcan', 'OK', '${warning ? 'Warning' : 'Information'}')`
		], { windowsHide: true, stdio: 'ignore' }).on('error', error => {
			this.logService.warn('[VibeAI] failed to show the popup', error);
		});
	}

	private async processSucceeds(command: string, args: string[]): Promise<boolean> {
		return new Promise(resolve => {
			let settled = false;
			const done = (value: boolean) => {
				if (!settled) {
					settled = true;
					resolve(value);
				}
			};
			const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
			child.on('error', () => done(false));
			child.on('close', code => done(code === 0));
		});
	}

	/**
	 * Runs the given program to completion - the exit CODE is ignored on
	 * purpose (the Python installer returns 3010 when a reboot is required,
	 * which still means the interpreter landed on disk).
	 */
	private async waitForProcessExit(command: string, args: string[]): Promise<boolean> {
		return new Promise(resolve => {
			let settled = false;
			const done = (value: boolean) => {
				if (!settled) {
					settled = true;
					resolve(value);
				}
			};
			const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
			child.on('error', error => {
				this.logService.error(`[VibeAI] ${command} failed to start`, error);
				done(false);
			});
			child.on('close', () => done(true));
		});
	}

	private async captureProcessOutput(command: string, args: string[]): Promise<string | null> {
		return new Promise(resolve => {
			let settled = false;
			const done = (value: string | null) => {
				if (!settled) {
					settled = true;
					resolve(value);
				}
			};
			const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
			let output = '';
			child.stdout?.on('data', (chunk: Buffer) => { output += String(chunk); });
			child.on('error', () => done(null));
			// 'close' (not 'exit'): stdio may still hold buffered output when
			// the process dies, and the reg-query parse needs every line.
			child.on('close', code => done(code === 0 ? output : null));
		});
	}

	override dispose(): void {
		if (this.backendChild?.pid) {
			// Tree-kill: uvicorn may own grandchildren, and child.kill() on
			// Windows only takes down the direct process.
			spawn('taskkill', ['/PID', String(this.backendChild.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
			this.backendChild = null;
		}
		super.dispose();
	}

	async healthCheck(): Promise<boolean> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 2500);
		try {
			const response = await fetch(`${this.backendUrl}/health`, { signal: controller.signal });
			return response.ok;
		} catch (error) {
			this.logService.debug('[VibeAI] health check failed', error);
			return false;
		} finally {
			clearTimeout(timeout);
		}
	}

	async chatStream(requestId: string, request: IVibeAIChatRequest): Promise<void> {
		// Note: the backend route is registered as `/api/chat/` (trailing slash,
		// `@router.post("/")` under prefix `/api/chat`) — calling it without the
		// slash would trigger an HTTP 307 redirect first.
		return this.doStream(requestId, `${this.backendUrl}/api/chat/`, request);
	}

	async agentStream(requestId: string, request: IVibeAIChatRequest): Promise<void> {
		return this.doStream(requestId, `${this.backendUrl}/api/chat/agent`, request);
	}

	/**
	 * Phase 71 (Plan mode): the research phase — read-only exploration
	 * followed by a structured plan (`POST /api/chat/agent/plan`).
	 */
	async planStream(requestId: string, request: IVibeAIChatRequest): Promise<void> {
		return this.doStream(requestId, `${this.backendUrl}/api/chat/agent/plan`, request);
	}

	/**
	 * Phase 71 (Plan mode): the execute phase of a user-approved plan
	 * (`POST /api/chat/agent/execute`).
	 */
	async executePlanStream(requestId: string, request: IVibeAIExecutePlanRequest): Promise<void> {
		return this.doStream(requestId, `${this.backendUrl}/api/chat/agent/execute`, request);
	}

	cancel(requestId: string): void {
		this.activeStreams.get(requestId)?.abort();
	}

	/**
	 * Tests a custom model provider's connectivity with a 1-token ping
	 * (Settings → Models "Test" button). Runs directly against the
	 * provider's OpenAI-compatible endpoint — no backend involvement —
	 * and resolves to '' on success or a human-readable error message.
	 */
	async testModel(provider: IVibeAIModelProvider): Promise<string> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15000);
		try {
			const base = provider.baseUrl.replace(/\/+$/, '');
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (provider.apiKey) {
				headers['Authorization'] = `Bearer ${provider.apiKey}`;
			}
			const response = await fetch(`${base}/chat/completions`, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					model: provider.model,
					messages: [{ role: 'user', content: 'ping' }],
					max_tokens: 1,
					stream: false,
				}),
				signal: controller.signal,
			});
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				return `HTTP ${response.status}${text ? ` — ${text.substring(0, 160)}` : ''}`;
			}
			return '';
		} catch (error) {
			if (controller.signal.aborted) {
				return 'Timed out after 15s';
			}
			return String(error);
		} finally {
			clearTimeout(timeout);
		}
	}

	/**
	 * Scans a custom provider for the models it exposes (`GET {baseUrl}/models`,
	 * Settings → Models "Scan models" action). Runs directly against the
	 * provider's OpenAI-compatible endpoint — no backend involvement — and
	 * resolves to the de-duplicated, sorted model ids the provider reports.
	 */
	async discoverModels(baseUrl: string, apiKey?: string): Promise<string[]> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15000);
		try {
			const base = baseUrl.replace(/\/+$/, '');
			const headers: Record<string, string> = {};
			if (apiKey) {
				headers['Authorization'] = `Bearer ${apiKey}`;
			}
			const response = await fetch(`${base}/models`, {
				headers,
				signal: controller.signal,
			});
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				throw new Error(`HTTP ${response.status}${text ? ` — ${text.substring(0, 160)}` : ''}`);
			}
			// OpenAI-compatible shape: `{ "data": [{ "id": "gpt-4o" }, ...] }`.
			// Some servers answer with a bare `models` array instead.
			const body = await response.json() as { data?: unknown; models?: unknown };
			const entries: unknown[] = Array.isArray(body.data)
				? body.data
				: Array.isArray(body.models)
					? body.models
					: [];
			const ids = entries
				.map((entry: unknown) => typeof entry === 'string' ? entry : (entry as { id?: unknown })?.id)
				.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
			this.logService.debug(`[VibeAI] discovered ${ids.length} models at ${base}/models`);
			return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
		} catch (error) {
			if (controller.signal.aborted) {
				throw new Error('Timed out after 15s');
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}

	async restoreFile(path: string, content: string, workspaceRoot?: string): Promise<boolean> {
		// The files router registers `@router.put("/")` under prefix `/api/files`
		// — the URL needs the trailing slash to avoid an HTTP 307 redirect.
		// Phase 107: relative paths resolve against `project_root` (the
		// editor's opened folder) when given.
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);
		try {
			const response = await fetch(`${this.backendUrl}/api/files/`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path, content, project_root: workspaceRoot }),
				signal: controller.signal
			});
			return response.ok;
		} catch (error) {
			this.logService.error('[VibeAI] restore file failed', error);
			return false;
		} finally {
			clearTimeout(timeout);
		}
	}

	async deleteFile(path: string, workspaceRoot?: string): Promise<boolean> {
		// The files router registers `@router.delete("/{path:path}")` under
		// prefix `/api/files` — the path param arrives percent-decoded, so
		// encodeURIComponent keeps nested paths intact (uvicorn unquotes
		// the raw path). Relative paths resolve against `project_root`
		// server-side when given (Phase 107, same as PUT), otherwise the
		// backend's default root.
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);
		const rootQuery = workspaceRoot ? `?project_root=${encodeURIComponent(workspaceRoot)}` : '';
		try {
			const response = await fetch(`${this.backendUrl}/api/files/${encodeURIComponent(path)}${rootQuery}`, {
				method: 'DELETE',
				signal: controller.signal
			});
			return response.ok;
		} catch (error) {
			this.logService.error('[VibeAI] delete file failed', error);
			return false;
		} finally {
			clearTimeout(timeout);
		}
	}

	async resolveApproval(id: string, approved: boolean): Promise<boolean> {
		// Phase 92: resolves the command approval gate the agent loop waits
		// on (Run / Skip card). Unknown/already-decided ids resolve to false
		// (idempotent) — the card keeps its buttons disabled either way.
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);
		try {
			const response = await fetch(`${this.backendUrl}/api/chat/agent/approvals/resolve`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id, approved }),
				signal: controller.signal
			});
			if (!response.ok) {
				return false;
			}
			const data = await response.json() as { resolved?: boolean };
			return data.resolved === true;
		} catch (error) {
			this.logService.error('[VibeAI] resolve approval failed', error);
			return false;
		} finally {
			clearTimeout(timeout);
		}
	}

	async steer(sessionId: string, content: string, mode?: 'steer' | 'queue'): Promise<boolean> {
		// Phase 113: queues a mid-turn steer (Cursor's "send now") for the
		// running Agent turn — the backend's loop injects it at the next
		// tool boundary and the `steered` event confirms it. Phase 114:
		// mode=queue rides the queue instead — never injected mid-turn,
		// the done event reports it as pending_queue and the pane
		// auto-resumes it as a new turn. 404 (no running turn for the
		// session — the gate closed when the turn ended) resolves to false
		// silently, like a decided approval; the pane keeps the text.
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);
		try {
			const response = await fetch(`${this.backendUrl}/api/chat/agent/steer`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ session_id: sessionId, content, mode: mode ?? 'steer' }),
				signal: controller.signal
			});
			if (!response.ok) {
				this.logService.debug(`[VibeAI] steer request failed: HTTP ${response.status}`);
				return false;
			}
			const data = await response.json() as { success?: boolean };
			return data.success === true;
		} catch (error) {
			this.logService.error('[VibeAI] steer failed', error);
			return false;
		} finally {
			clearTimeout(timeout);
		}
	}

	async complete(request: IVibeAICompletionRequest): Promise<string | null> {
		// `@router.post("")` under prefix `/api/completion` — unlike the chat
		// and files routes above, this URL has NO trailing slash.
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);
		try {
			const response = await fetch(`${this.backendUrl}/api/completion`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					prefix: request.prefix,
					suffix: request.suffix ?? '',
					language: request.language,
					max_tokens: request.maxTokens ?? 60,
					// Custom-model routing: Tab completion goes to the editor's
					// resolved model provider (backend 400s 沒有模型可用
					// without one — surfaces as null and skips silently).
					provider: request.provider
				}),
				signal: controller.signal
			});
			if (!response.ok) {
				this.logService.debug(`[VibeAI] completion request failed: HTTP ${response.status}`);
				return null;
			}
			const payload = await response.json() as { data?: { completion?: string } };
			return payload?.data?.completion ?? null;
		} catch (error) {
			this.logService.debug('[VibeAI] completion failed', error);
			return null;
		} finally {
			clearTimeout(timeout);
		}
	}

	async inlineEdit(request: IVibeAIInlineEditRequest): Promise<string | null> {
		// `@router.post("/edit")` under prefix `/api/chat` — the URL has no
		// trailing slash. Rewrites can take a while (large max_tokens), hence
		// the generous timeout.
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 60000);
		try {
			const response = await fetch(`${this.backendUrl}/api/chat/edit`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					instruction: request.instruction,
					code: request.code,
					language: request.language,
					// Custom-model routing: Ctrl+K goes to the editor's
					// resolved model provider (gated in the widget).
					provider: request.provider
				}),
				signal: controller.signal
			});
			if (!response.ok) {
				this.logService.warn(`[VibeAI] inline edit request failed: HTTP ${response.status}`);
				return null;
			}
			const payload = await response.json() as { data?: { code?: string } };
			return payload?.data?.code ?? null;
		} catch (error) {
			this.logService.error('[VibeAI] inline edit failed', error);
			return null;
		} finally {
			clearTimeout(timeout);
		}
	}

	async contextUsage(request: IVibeAIContextUsageRequest): Promise<IVibeAIContextUsage> {
		// `@router.post("/agent/context-usage")` under prefix `/api/chat` —
		// token usage breakdown for the context usage panel (Phase 41).
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);
		try {
			const response = await fetch(`${this.backendUrl}/api/chat/agent/context-usage`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					messages: request.messages,
					input: request.input ?? '',
					context: request.context,
					contextLimit: request.contextLimit,
					// Ask-mode estimate: read-only tool subset + Ask system prompt.
					readonly: request.readonly,
					// Phase 116: Side Chat — the parent-thread reference (the
					// `parent` breakdown row; same assembly as the actual
					// injection, estimate ≡ sent).
					parent_context: request.parentContext,
					// Phase 120: the session goal (the same objective the
					// turns actually send) — the `goal` breakdown row is
					// assembled by the same function as the injection
					// (estimate = sent).
					goal: request.goal,
					// Phase 107: the editor's opened folder (rules / skills /
					// MCP are estimated against it).
					project_root: request.workspaceRoot
				}),
				signal: controller.signal
			});
			if (!response.ok) {
				throw new Error(`VibeAI backend context usage request failed (HTTP ${response.status})`);
			}
			return await response.json() as IVibeAIContextUsage;
		} finally {
			clearTimeout(timeout);
		}
	}

	async listSkills(workspaceRoot?: string): Promise<IVibeAISkill[]> {
		// `@router.get("/agent/skills")` under prefix `/api/chat` —
		// workspace skills for the chat input `/` completion menu (Phase 78).
		// Phase 107: lists the opened folder's skills when root is given.
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);
		const rootQuery = workspaceRoot ? `?project_root=${encodeURIComponent(workspaceRoot)}` : '';
		try {
			const response = await fetch(`${this.backendUrl}/api/chat/agent/skills${rootQuery}`, {
				signal: controller.signal
			});
			if (!response.ok) {
				throw new Error(`VibeAI backend skills request failed (HTTP ${response.status})`);
			}
			const data = await response.json() as { skills?: IVibeAISkill[] };
			return Array.isArray(data.skills) ? data.skills : [];
		} finally {
			clearTimeout(timeout);
		}
	}

	async listSubagents(workspaceRoot?: string): Promise<IVibeAISubagent[]> {
		// `@router.get("/agent/subagents")` under prefix `/api/chat` —
		// workspace file-defined subagents for the chat input `/` completion
		// menu (Phase 127). Phase 107: lists the opened folder's agents.
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);
		const rootQuery = workspaceRoot ? `?project_root=${encodeURIComponent(workspaceRoot)}` : '';
		try {
			const response = await fetch(`${this.backendUrl}/api/chat/agent/subagents${rootQuery}`, {
				signal: controller.signal
			});
			if (!response.ok) {
				throw new Error(`VibeAI backend subagents request failed (HTTP ${response.status})`);
			}
			const data = await response.json() as { subagents?: IVibeAISubagent[] };
			return Array.isArray(data.subagents) ? data.subagents : [];
		} finally {
			clearTimeout(timeout);
		}
	}

	async customizeList(kind: VibeAICustomizeKind, workspaceRoot?: string): Promise<IVibeAICustomizeItem[]> {
		// `@router.get("/{kind}")` under prefix `/api/customize` — the merged
		// dual-scope list for the Settings → Rules / Skills / MCP pages
		// (Phase 142). Phase 107: the opened folder's project layer.
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);
		const rootQuery = workspaceRoot ? `?project_root=${encodeURIComponent(workspaceRoot)}` : '';
		try {
			const response = await fetch(`${this.backendUrl}/api/customize/${kind}${rootQuery}`, {
				signal: controller.signal
			});
			if (!response.ok) {
				throw new Error(`VibeAI backend customize request failed (HTTP ${response.status})`);
			}
			const data = await response.json() as { items?: IVibeAICustomizeItem[] };
			return Array.isArray(data.items) ? data.items : [];
		} finally {
			clearTimeout(timeout);
		}
	}

	async customizeCreate(kind: VibeAICustomizeKind, data: IVibeAICustomizeCreateData, workspaceRoot?: string): Promise<IVibeAICustomizeResult> {
		// `@router.post("/{kind}")` under prefix `/api/customize` (Phase 142).
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);
		const rootQuery = workspaceRoot ? `?project_root=${encodeURIComponent(workspaceRoot)}` : '';
		try {
			const response = await fetch(`${this.backendUrl}/api/customize/${kind}${rootQuery}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(data),
				signal: controller.signal
			});
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				return { ok: false, error: `HTTP ${response.status}${text ? ` — ${text.substring(0, 160)}` : ''}` };
			}
			return await response.json() as IVibeAICustomizeResult;
		} catch (error) {
			if (controller.signal.aborted) {
				return { ok: false, error: 'Timed out after 10s' };
			}
			return { ok: false, error: String(error) };
		} finally {
			clearTimeout(timeout);
		}
	}

	async customizeDelete(kind: VibeAICustomizeKind, name: string, scope: VibeAICustomizeScope, workspaceRoot?: string): Promise<IVibeAICustomizeResult> {
		// `@router.delete("/{kind}")` — name + scope pick the entry and the
		// layer (the row's own origin, Phase 142).
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);
		const query = new URLSearchParams();
		if (workspaceRoot) {
			query.set('project_root', workspaceRoot);
		}
		query.set('name', name);
		query.set('scope', scope);
		try {
			const response = await fetch(`${this.backendUrl}/api/customize/${kind}?${query.toString()}`, {
				method: 'DELETE',
				signal: controller.signal
			});
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				return { ok: false, error: `HTTP ${response.status}${text ? ` — ${text.substring(0, 160)}` : ''}` };
			}
			return await response.json() as IVibeAICustomizeResult;
		} catch (error) {
			if (controller.signal.aborted) {
				return { ok: false, error: 'Timed out after 10s' };
			}
			return { ok: false, error: String(error) };
		} finally {
			clearTimeout(timeout);
		}
	}

	async customizeToggle(kind: VibeAICustomizeKind, name: string, scope: VibeAICustomizeScope, workspaceRoot?: string): Promise<IVibeAICustomizeResult> {
		// `@router.post("/{kind}/toggle")` — MCP servers only; the backend
		// flips `disabled` in the scope's mcp.json and hot-reloads (Phase 142).
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);
		const rootQuery = workspaceRoot ? `?project_root=${encodeURIComponent(workspaceRoot)}` : '';
		try {
			const response = await fetch(`${this.backendUrl}/api/customize/${kind}/toggle${rootQuery}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, scope }),
				signal: controller.signal
			});
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				return { ok: false, error: `HTTP ${response.status}${text ? ` — ${text.substring(0, 160)}` : ''}` };
			}
			return await response.json() as IVibeAICustomizeResult;
		} catch (error) {
			if (controller.signal.aborted) {
				return { ok: false, error: 'Timed out after 10s' };
			}
			return { ok: false, error: String(error) };
		} finally {
			clearTimeout(timeout);
		}
	}

	async reloadMcp(workspaceRoot?: string): Promise<IVibeAICustomizeResult> {
		// `@router.post("/agent/mcp/reload")` under prefix `/api/chat` —
		// rebuilds the connection table and reconnects after mcp.json
		// changes (Phase 142); statuses come back as items.
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);
		try {
			const response = await fetch(`${this.backendUrl}/api/chat/agent/mcp/reload`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ project_root: workspaceRoot }),
				signal: controller.signal
			});
			if (!response.ok) {
				const text = await response.text().catch(() => '');
				return { ok: false, error: `HTTP ${response.status}${text ? ` — ${text.substring(0, 160)}` : ''}` };
			}
			return await response.json() as IVibeAICustomizeResult;
		} catch (error) {
			if (controller.signal.aborted) {
				return { ok: false, error: 'Timed out after 10s' };
			}
			return { ok: false, error: String(error) };
		} finally {
			clearTimeout(timeout);
		}
	}

	private async doStream(requestId: string, url: string, request: IVibeAIChatRequest | IVibeAIExecutePlanRequest): Promise<void> {
		// A new stream with the same request id cancels the previous one
		this.activeStreams.get(requestId)?.abort();

		// Phase 71: the execute request carries the plan (the chat request
		// carries the Auto-routing fields) — narrow per field group.
		const chat = request as IVibeAIChatRequest;
		const execute = request as IVibeAIExecutePlanRequest;
		const controller = new AbortController();
		this.activeStreams.set(requestId, controller);
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					messages: request.messages,
					stream: true,
					model: request.model,
					context: request.context,
					// Custom-model routing (Settings → Models): provider
					// override {baseUrl, apiKey, model} for OpenAI-compatible
					// endpoints other than the backend's default model.
					provider: request.provider,
					// Phase 41: custom context-window length (100K–1M) — the
					// backend compresses (crops) the history to fit before
					// running the agent loop.
					contextLimit: request.contextLimit,
					// Phase 70 Auto routing: the pseudo-model 'auto' plus the
					// non-disabled Settings → Models pool (resolved provider
					// overrides + tier hints) and the Optimize For mode — the
					// backend's router picks one per turn and falls back down
					// the list on provider failures.
					autoPool: chat.autoPool,
					autoMode: chat.autoMode,
					// Phase 71 Plan mode execute phase: the user-approved plan.
					plan: execute.plan,
					// Phase 113: the conversation's session id — the Agent
					// endpoint opens its steer gate on it so mid-turn sends
					// can queue as steers; the chat/plan/execute endpoints
					// ignore it (backward compatible).
					session_id: chat.sessionId,
					// Phase 116: Side Chat — side_of (the parent session id,
					// log/event marker) + parent_context (the frontend-capped
					// parent-thread reference; the backend re-clamps and
					// injects it as a hidden <parent_thread reference>
					// system-prompt block). Main-thread turns omit both.
					side_of: chat.sideOf,
					parent_context: chat.parentContext,
					// Phase 120: the session goal (Cursor parity: give the
					// agent a long-lived objective to work towards until
					// it's fully complete) — carried on every turn of the
					// conversation that set it via /goal; the backend
					// injects it as the hidden <session goal> block and
					// mark_goal_complete confirms completion. Absent = zero
					// change (backward compatible).
					goal: chat.goal,
					// Phase 139: terminal permission mode (Cursor parity:
					// review_all | high_risk | trusted) — gates the
					// agent's terminal commands per turn. Absent = the
					// backend's default (high_risk).
					permission_mode: chat.permissionMode,
					// Phase 107: the editor's opened folder — the backend
					// rebinds its tools / RAG index / rules / skills to it.
					project_root: request.workspaceRoot
				}),
				signal: controller.signal
			});
			if (!response.ok || !response.body) {
				// FastAPI errors carry a JSON `detail` (e.g. 400 沒有模型
				// 可用 when no custom model is configured) — surface it so
				// the pane shows the actionable message, not the bare status.
				let detail = '';
				try {
					const body = await response.json() as { detail?: unknown };
					if (typeof body?.detail === 'string' && body.detail.length > 0) {
						detail = body.detail;
					}
				} catch {
					// Non-JSON error body — fall back to the status line.
				}
				const message = detail.length > 0
					? detail
					: `VibeAI backend request failed (HTTP ${response.status})`;
				this.logService.warn(`[VibeAI] ${message}`);
				// Phase 154: an HTTP 5xx from the backend (crash, bad
				// gateway) is worth a Retry — the turn re-rides as-is.
				// 4xx responses are actionable config errors (e.g. 400
				// 沒有模型可用) where re-sending cannot help, so they
				// keep no button.
				this._onStreamData.fire({ requestId, type: 'error', message, retryable: response.status >= 500 });
				this._onStreamData.fire({ requestId, type: 'done' });
				return;
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder('utf-8');
			let buffer = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });

				let separatorIndex: number;
				while ((separatorIndex = buffer.indexOf('\n\n')) >= 0) {
					const frame = buffer.substring(0, separatorIndex);
					buffer = buffer.substring(separatorIndex + 2);
					this.handleSSEFrame(requestId, frame);
				}
			}
			buffer += decoder.decode();
			if (buffer.trim().length > 0) {
				this.handleSSEFrame(requestId, buffer);
			}
			this._onStreamData.fire({ requestId, type: 'done' });
		} catch (error) {
			if (controller.signal.aborted) {
				this._onStreamData.fire({ requestId, type: 'done' });
			} else {
				this.logService.error('[VibeAI] stream failed', error);
				// Phase 154: transport-level interruptions (timeout, flaky
				// network, the backend connection dropping mid-stream —
				// undici's "TypeError: terminated" / "fetch failed",
				// ECONNRESET, socket hang up) are all "the answer got cut
				// off" — fire the error WITH `retryable: true` so the pane
				// renders its Phase 134 Retry button and the turn can be
				// re-sent instead of retyped (normalizeEvent keeps the
				// backend's own SSE classification for in-band errors).
				this._onStreamData.fire({ requestId, type: 'error', message: String(error), retryable: true });
				this._onStreamData.fire({ requestId, type: 'done' });
			}
		} finally {
			this.activeStreams.delete(requestId);
		}
	}

	private handleSSEFrame(requestId: string, frame: string): void {
		for (const line of frame.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('data: ')) {
				continue;
			}
			const payload = trimmed.substring('data: '.length).trim();
			if (payload === '[DONE]') {
				// Terminal SSE marker — `doStream` fires the done event exactly
				// once when the response body ends, so nothing to emit here.
				continue;
			}
			try {
				const event = JSON.parse(payload);
				for (const data of this.normalizeEvent(requestId, event)) {
					this._onStreamData.fire(data);
				}
			} catch {
				this.logService.debug(`[VibeAI] failed to parse SSE payload: ${payload}`);
			}
		}
	}

	/**
	 * Phase 71: defensive plan normalization — the backend's plan object
	 * (`{summary, steps}`) must carry a non-empty steps array of
	 * `{id, title}` objects; anything else returns undefined so the pane
	 * renders the retry note instead of a broken card.
	 */
	private normalizePlan(plan: unknown): IVibeAIPlan | undefined {
		if (!plan || typeof plan !== 'object' || !Array.isArray((plan as { steps?: unknown }).steps)) {
			return undefined;
		}
		const steps: IVibeAIPlanStep[] = [];
		for (const step of (plan as { steps: unknown[] }).steps) {
			if (!step || typeof step !== 'object') {
				continue;
			}
			const candidate = step as { id?: unknown; title?: unknown; detail?: unknown; files?: unknown };
			if (typeof candidate.title !== 'string' || candidate.title.length === 0) {
				continue;
			}
			steps.push({
				id: typeof candidate.id === 'number' ? candidate.id : steps.length + 1,
				title: candidate.title,
				detail: typeof candidate.detail === 'string' ? candidate.detail : undefined,
				files: Array.isArray(candidate.files) ? candidate.files.filter((file): file is string => typeof file === 'string') : undefined,
			});
		}
		if (steps.length === 0) {
			return undefined;
		}
		const summary = (plan as { summary?: unknown }).summary;
		return {
			summary: typeof summary === 'string' && summary.length > 0 ? summary : undefined,
			steps,
		};
	}

	private normalizeEvent(requestId: string, event: any): IVibeAIStreamData[] {
		// Backend error payload: { "error": string, "retryable"?: boolean }
		if (typeof event?.error === 'string') {
			return [{ requestId, type: 'error', message: event.error, retryable: event.retryable === true }];
		}

		// POST /api/chat: OpenAI-compatible chat chunk
		// (Thinking models emit `reasoning` deltas in addition to `content`)
		const delta = event?.choices?.[0]?.delta;
		if (delta || event?.choices) {
			const result: IVibeAIStreamData[] = [];
			if (typeof delta?.reasoning === 'string' && delta.reasoning.length > 0) {
				result.push({ requestId, type: 'thinking', text: delta.reasoning });
			}
			if (typeof delta?.content === 'string' && delta.content.length > 0) {
				result.push({ requestId, type: 'text', text: delta.content });
			}
			return result;
		}

		// POST /api/chat/agent: typed agent events
		switch (event?.type) {
			case 'thinking':
				return [{ requestId, type: 'thinking', text: event.content ?? '', raw: event }];
			case 'text':
				return [{ requestId, type: 'text', text: event.content ?? '', raw: event }];
			case 'tool_start':
				return [{ requestId, type: 'tool_start', tool: { id: event.id, name: event.name, arguments: event.arguments }, raw: event }];
			case 'tool_result': {
				// The backend sends `result` as a `{ summary: string }` object
				// (orchestrator._summarize_tool_result) while the type contract
				// (vibeAI.ts) declares `string`. Normalize to the plain text the
				// tool card header and the persisted record expect — a non-string
				// used to crash clipText ("text.substring is not a function") on
				// turn finish, which aborted finishStreaming and left the input's
				// stop button stuck in the streaming state.
				const rawResult = event.result;
				const result = typeof rawResult === 'string'
					? rawResult
					: (rawResult && typeof rawResult === 'object' && typeof rawResult.summary === 'string' ? rawResult.summary : undefined);
				// Phase 58: run_terminal results carry the raw command output
				// (stdout + stderr) for the card's collapsible output preview.
				const output = rawResult && typeof rawResult === 'object' && typeof rawResult.output === 'string'
					? rawResult.output
					: undefined;
				// Phase 63: read_file results carry the actual line range read
				// (start/end + total/symbol) for the card's args summary.
				const read = rawResult && typeof rawResult === 'object'
					&& rawResult.read && typeof rawResult.read === 'object'
					? rawResult.read
					: undefined;
				// Phase 137: needs-console commands (interactive REPLs, dev
				// servers, ssh…) can't run in the sandboxed executor — the
				// backend handed them off: the pane runs it in the editor's
				// integrated terminal (ITerminalService).
				const editorTerminal = rawResult && typeof rawResult === 'object'
					&& (rawResult as { editor_terminal?: unknown }).editor_terminal === true;
				return [{ requestId, type: 'tool_result', tool: { id: event.id, name: event.name, arguments: event.arguments, result, status: event.status, codeChange: event.code_change, output, read, editorTerminal }, raw: event }];
			}
			case 'file_delta':
				// `id` ties streaming write content to its pending tool card.
				return [{
					requestId,
					type: 'file_delta',
					filePath: event.path,
					delta: event.delta,
					tool: typeof event.id === 'string' && event.id.length > 0 ? { id: event.id } : undefined,
					raw: event
				}];
			case 'context_compressed':
				// Phase 41: the backend cropped the conversation history to
				// fit the context limit before running the agent loop.
				return [{
					requestId,
					type: 'context_compressed',
					before: event.before,
					after: event.after,
					contextLimit: event.limit,
					raw: event
				}];
			case 'output_truncated':
				// Phase 51: the round hit its per-round output token budget
				// (finish_reason=length) — the pane renders a truncation note.
				return [{ requestId, type: 'output_truncated', raw: event }];
			case 'limit_reached':
				// Phase 103: the agent loop exhausted its rounds/segments or
				// the context window — the turn ends with the backend's
				// forced summary; the pane renders a note + Continue chip
				// (Cursor parity) wired to a follow-up send.
				return [{
					requestId,
					type: 'limit_reached',
					limitReached: {
						rounds: typeof event.rounds === 'number' ? event.rounds : 0,
						segments: typeof event.segments === 'number' ? event.segments : 0,
						reason: typeof event.reason === 'string' ? event.reason : 'rounds',
					},
					raw: event
				}];
			case 'retry':
				// Phase 134: the backend is retrying the LLM call after a
				// transient failure (auto retry with exponential backoff) —
				// the pane renders a transient Retrying chip.
				return [{
					requestId,
					type: 'retry',
					retry: {
						attempt: typeof event.attempt === 'number' ? event.attempt : 0,
						max: typeof event.max === 'number' ? event.max : 0,
						delay: typeof event.delay === 'number' ? event.delay : 0,
						reason: typeof event.reason === 'string' ? event.reason : undefined,
					},
					raw: event
				}];
			case 'model_routed':
				// Phase 70: the Auto router picked this model for the turn
				// (intent+complexity routing over the Settings → Models pool;
				// emitted again on every fallback switch).
				return [{
					requestId,
					type: 'model_routed',
					modelRouted: {
						model: typeof event.model === 'string' ? event.model : '',
						name: typeof event.name === 'string' && event.name.length > 0 ? event.name : event.model,
						tier: typeof event.tier === 'string' ? event.tier : '',
						mode: typeof event.mode === 'string' ? event.mode : '',
						reason: typeof event.reason === 'string' ? event.reason : '',
					},
					raw: event
				}];
			case 'plan':
				// Phase 71 Plan mode: the research phase's structured plan.
				// A null/invalid plan = the backend failed to produce one —
				// still emitted so the pane can render the retry note.
				return [{
					requestId,
					type: 'plan',
					plan: this.normalizePlan(event?.plan),
					raw: event
				}];
			case 'agent_questions':
				// Phase 121: the model asked clarifying questions without
				// stopping work (ask_questions) — the pane renders a
				// question card per event; answers go out via steer() and
				// inject at the next tool boundary (the loop never waits).
				return [{
					requestId,
					type: 'agent_questions',
					questions: {
						id: typeof event.id === 'string' ? event.id : '',
						items: Array.isArray(event.questions)
							? event.questions
								.map((item: unknown): IVibeAIQuestion | null => {
									const raw = (item ?? {}) as { question?: unknown; options?: unknown };
									const question = typeof raw.question === 'string' ? raw.question : '';
									if (question.length === 0) {
										return null;
									}
									const options = Array.isArray(raw.options)
										? raw.options.filter((o: unknown): o is string => typeof o === 'string' && o.length > 0)
										: undefined;
									return { question, options: options && options.length > 0 ? options : undefined };
								})
								.filter((q: IVibeAIQuestion | null): q is IVibeAIQuestion => q !== null)
							: [],
					},
					raw: event
				}];
			case 'approval_request':
				// Phase 92: the backend intercepted a terminal command and
				// parked it at the approval gate — the pane renders the
				// Run / Skip card (Cursor-parity command approval).
				return [{
					requestId,
					type: 'approval_request',
					approval: {
						id: typeof event.id === 'string' ? event.id : '',
						command: typeof event.command === 'string' ? event.command : '',
						reason: typeof event.reason === 'string' ? event.reason : '',
					},
					raw: event
				}];
			case 'approval_resolved':
				// Phase 92: the gate decided (user click / timeout) — the
				// card folds to its decided state.
				return [{
					requestId,
					type: 'approval_resolved',
					approval: {
						id: typeof event.id === 'string' ? event.id : '',
						command: '',
						reason: '',
						approved: event.approved === true,
						timedOut: event.timed_out === true,
					},
					raw: event
				}];
			case 'plan_start':
				// Phase 71: the execute phase kicked off for the approved
				// plan (steps count + the plan again for the progress card).
				return [{
					requestId,
					type: 'plan_start',
					plan: this.normalizePlan(event?.plan),
					raw: event
				}];
			case 'plan_step_start':
				// Phase 71: one plan step began (its agent events follow).
				return [{
					requestId,
					type: 'plan_step_start',
					planStep: {
						step: typeof event.step === 'number' ? event.step : 0,
						title: typeof event.title === 'string' ? event.title : undefined,
						index: typeof event.index === 'number' ? event.index : undefined,
						total: typeof event.total === 'number' ? event.total : undefined,
					},
					raw: event
				}];
			case 'plan_step_done':
				// Phase 71: one plan step finished (status done /
				// done_with_errors + failed tool count).
				return [{
					requestId,
					type: 'plan_step_done',
					planStep: {
						step: typeof event.step === 'number' ? event.step : 0,
						title: typeof event.title === 'string' ? event.title : undefined,
						rounds: typeof event.rounds === 'number' ? event.rounds : undefined,
						failedTools: typeof event.failedTools === 'number' ? event.failedTools : undefined,
						status: typeof event.status === 'string' ? event.status : undefined,
					},
					raw: event
				}];
			case 'plan_done':
				// Phase 71: the whole plan executed — done/failed step ids.
				return [{
					requestId,
					type: 'plan_done',
					planSummary: {
						steps: typeof event.steps === 'number' ? event.steps : 0,
						stepsDone: Array.isArray(event.stepsDone) ? event.stepsDone.filter((s: unknown): s is number => typeof s === 'number') : [],
						stepsFailed: Array.isArray(event.stepsFailed) ? event.stepsFailed.filter((s: unknown): s is number => typeof s === 'number') : [],
					},
					raw: event
				}];
			case '_round_end':
				// Phase 89: the backend's explicit final-result marker rides
				// on the round boundary — final=true = this round's text is
				// THE answer (no tool_calls follow); the pane folds the
				// Worked shell on it instead of guessing from the length.
				// Phase 90: the marker precedes the answer text (the backend
				// holds post-tool rounds' text until the boundary), so the
				// pane's fold lands before any answer text renders.
				return [{ requestId, type: 'round_end', final: event.final === true, raw: event }];
			case 'steered':
				// Phase 113: the backend injected a queued mid-turn steer
				// (role=user) at the tool boundary — the pane renders the
				// thread's Steered bubble with the content.
				return [{
					requestId,
					type: 'steered',
					steered: typeof event.content === 'string' ? event.content : '',
					raw: event
				}];
			case 'goal_complete':
				// Phase 120: the model declared the session goal complete
				// (mark_goal_complete; the event follows the tool_result) —
				// the pane flips the goal banner to its done state
				// (idempotent on repeated declarations).
				return [{ requestId, type: 'goal_complete', goalComplete: true, raw: event }];
			case 'turn_state':
				// Phase 150: the backend turn state machine's explicit
				// lifecycle announcement (Cursor-parity event-driven
				// design) — the pane stores it on the stream state so
				// guards read backend state instead of inferred flags.
				// `final` rides the existing field (terminal states).
				return [{
					requestId,
					type: 'turn_state',
					turnState: typeof event.state === 'string' ? event.state : undefined,
					final: event.final === true,
					raw: event
				}];
			case 'done':
				// Phase 113: steers queued but never injected (the turn
				// ended without a tool boundary to drain them) ride the
				// done event's pending_steer — the pane preserves them as
				// steered history entries with a "not delivered" note.
				return [{
					requestId,
					type: 'done',
					rounds: event.rounds,
					pendingSteer: Array.isArray(event.pending_steer)
						? event.pending_steer.filter((s: unknown): s is string => typeof s === 'string')
						: undefined,
					// Phase 114: queue-mode messages the turn ended with —
					// the pane merges them into its queue and auto-resumes
					// the first as a NEW agent turn (the rest ride later
					// turn ends until the queue empties).
					pendingQueue: Array.isArray(event.pending_queue)
						? event.pending_queue.filter((s: unknown): s is string => typeof s === 'string')
						: undefined,
					raw: event
				}];
			default:
				return [{ requestId, type: 'unknown', raw: event }];
		}
	}
}

