/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';

/**
 * r29: chat answers reference local files in inline code (e.g. `config.py`,
 * `start.ps1`) — those spans become clickable when the named file actually
 * exists. The hub opens it in its right-side expansion area; the IDE chat
 * pane opens it in the center editor area. Fenced code blocks never become
 * chips — they are code, not file references.
 */

export interface IFileChipHost {
	readonly fileService: IFileService;
	/** Absolute project root the chip text is relative to; undefined = no project. */
	readonly resolveRoot: () => string | undefined;
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
	const root = host.resolveRoot();
	const key = `${root ?? ''}|${text}`;
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
	} else if (root) {
		candidates.push(joinRoot(root, text));
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
