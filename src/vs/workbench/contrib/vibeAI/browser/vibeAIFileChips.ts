/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';

/**
 * r29: chat answers reference local files in inline code (e.g. `config.py`,
 * `start.ps1`) — those spans become clickable when the named file actually
 * exists. The hub opens it in its right-side expansion area; the IDE chat
 * pane opens it in the center editor area. Fenced code blocks never become
 * chips — they are code, not file references.
 */

export interface IFileChipHost {
	readonly fileService: IFileService;
	/** Absolute project roots the chip text is relative to; undefined entries are skipped. */
	readonly resolveRoots: () => Array<string | undefined>;
	/** Open the resolved absolute file (hub right pane / IDE center editor). */
	readonly onOpen: (fsPath: string, display: string) => void;
	/** The resolved file vanished since the chip rendered (deleted or rolled back). */
	readonly onMissing?: (fsPath: string, display: string) => void;
}

/**
 * r32: resolution results are cached for a short window only. A permanent
 * cache goes stale in both directions — a file deleted after it resolved
 * (e.g. by a rollback) keeps a dead clickable chip, and a file created
 * after a failed lookup never becomes one until the app restarts.
 */
const RESOLUTION_TTL_MS = 30_000;
const resolutionCache = new Map<string, { at: number; promise: Promise<string | undefined> }>();

function joinRoot(root: string, rel: string): string {
	return `${root.replace(/[\\/]+$/, '')}/${rel.replace(/\\/g, '/')}`;
}

function looksLikePath(text: string): boolean {
	// Paths carry no whitespace (commands like `npm run compile` stay inert)
	// and no URL schemes; the existence check does the real gating.
	return text.length > 0
		&& text.length <= 300
		&& !/\s/.test(text)
		&& !text.includes('://');
}

function resolveFileChip(text: string, host: IFileChipHost): Promise<string | undefined> {
	const roots = host.resolveRoots();
	const key = `${roots.map(r => r ?? '').join('|')}|${text}`;
	const cached = resolutionCache.get(key);
	if (cached && Date.now() - cached.at < RESOLUTION_TTL_MS) {
		return cached.promise;
	}
	if (cached) {
		resolutionCache.delete(key);
	}
	const candidates: string[] = [];
	if (/^([a-zA-Z]:[\\/]|[\\/])/.test(text)) {
		candidates.push(text);
	} else {
		// Phase 255: every workspace root gets a try — a chip in a
		// multi-root workspace must not depend on which folder is first.
		for (const root of roots) {
			if (root) {
				candidates.push(joinRoot(root, text));
			}
		}
	}
	const promise = (async () => {
		for (const candidate of candidates) {
			try {
				if (await host.fileService.exists(URI.file(candidate))) {
					return candidate;
				}
			} catch {
				// unreadable location — not an openable file
			}
		}
		return undefined;
	})();
	resolutionCache.set(key, { at: Date.now(), promise });
	return promise;
}

/**
 * Phase 255: evidence references from test/tool runs — `sandbox/pw-results/
 * ….png` screenshots, `video.webm` recordings, `trace.zip` archives — open
 * differently from text sources. Images (and everything text-ish) go to the
 * editor area where the built-in preview renders screenshots; recordings go
 * to the OS (the note on the chip already says the browser plays the video);
 * archives reveal in the Explorer (trace.zip is a drag-into-trace-viewer
 * artifact, locating it is the useful move).
 */
export const FILE_CHIP_MEDIA_EXTENSIONS = new Set(['webm', 'mp4', 'mov', 'avi', 'mkv', 'm4v', 'mp3', 'wav', 'ogg', 'flac', 'm4a']);
export const FILE_CHIP_ARCHIVE_EXTENSIONS = new Set(['zip', 'gz', '7z', 'tar']);

export function openChipFileSmart(commandService: ICommandService, openerService: IOpenerService, fsPath: string): void {
	const uri = URI.file(fsPath);
	const ext = fsPath.slice(fsPath.lastIndexOf('.') + 1).toLowerCase();
	if (FILE_CHIP_MEDIA_EXTENSIONS.has(ext)) {
		void openerService.open(uri, { openExternal: true });
	} else if (FILE_CHIP_ARCHIVE_EXTENSIONS.has(ext)) {
		void commandService.executeCommand('revealInExplorer', uri);
	} else {
		// Images get the built-in preview; everything text-ish opens in the
		// editor area exactly as before.
		void commandService.executeCommand('vscode.open', uri);
	}
}

export function enhanceFileChips(container: HTMLElement, host: IFileChipHost): void {
	for (const code of Array.from(container.querySelectorAll<HTMLElement>('code'))) {
		if (code.closest('pre')) {
			continue;
		}
		const text = (code.textContent ?? '').trim();
		if (!looksLikePath(text) || code.classList.contains('vibe-ai-file-chip') || code.dataset['fileChip'] === 'pending') {
			continue;
		}
		code.dataset['fileChip'] = 'pending';
		resolveFileChip(text, host).then(fsPath => {
			if (!fsPath || !code.isConnected) {
				return;
			}
			code.classList.add('vibe-ai-file-chip');
			code.title = localize('vibeAIFileChips.open', "Open {0}", text);
			addDisposableListener(code, EventType.CLICK, e => {
				e.preventDefault();
				e.stopPropagation();
				// r32: the file may have vanished since this chip resolved
				// (deleted, or removed by a rollback) — verify before opening
				// so a dead chip says so instead of showing an empty pane.
				host.fileService.exists(URI.file(fsPath)).then(ok => {
					if (!ok) {
						code.classList.remove('vibe-ai-file-chip');
						code.removeAttribute('title');
						host.onMissing?.(fsPath, text);
						return;
					}
					host.onOpen(fsPath, text);
				});
			});
		});
	}
}
