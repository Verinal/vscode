/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { isWindows } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IVibeAIReadRange } from '../../../../platform/vibeAI/common/vibeAI.js';
import { VibeAIToolCard } from './vibeAIToolCard.js';

const $ = DOM.$;

/**
 * Phase 149: manages the Worked section's step list (Cursor agent-mode
 * parity) — completed read-only steps are consolidated for DISPLAY while
 * the persisted records keep every individual call:
 *
 * 1. Same-file read merge — repeated `read_file` calls of one path fold
 *    into the FIRST row, its header range widening to the union (the
 *    duplicates' elements detach; their card objects stay alive so the
 *    turn's persistence still captures them).
 * 2. Scan kind groups — from {@link SCAN_GROUP_MIN} completed calls on,
 *    `list_files` / `grep` / `search_codebase` fold into one expandable
 *    count row ("Listed 3 directories", "Searched 2 times").
 * 3. Read budget — more than {@link READ_GROUP_MAX} distinct-file read
 *    rows fold into one "Read N files" group row.
 *
 * Never grouped: pending cards, mutating cards, failed cards (dropped
 * earlier), and every non-card step (thinking rows, narration bodies,
 * steered bubbles, approval / questions cards). The regroup is
 * idempotent — previous group shells flatten before every pass — and
 * runs on every completed read-only result plus once on history restore.
 */

/** Completed scan calls of one kind fold into a group row from this many on. */
const SCAN_GROUP_MIN = 2;
/** Distinct-file read rows fold into one "Read N files" group beyond this count. */
const READ_GROUP_MAX = 6;

/** The read-only scan kinds that fold into count group rows. */
const SCAN_KINDS = new Set(['list_files', 'grep', 'search_codebase']);

const GROUP_ICONS: Record<string, string> = {
	read_file: 'codicon-file',
	list_files: 'codicon-folder',
	grep: 'codicon-search',
	search_codebase: 'codicon-search',
};

export interface IWorkedActivityCounts {
	readonly reads: number;
	readonly lists: number;
	readonly searches: number;
}

interface IWorkedEntry {
	readonly el: HTMLElement;
	readonly id: string | undefined;
	readonly card: VibeAIToolCard | undefined;
	readonly groupable: boolean;
}

/** The tool-call id a card element carries (dataset → data-vibe-tool-id). */
function toolIdOf(element: HTMLElement): string | undefined {
	return element.dataset.vibeToolId;
}

/** Only completed read-only steps participate in the grouping. */
function isGroupable(card: VibeAIToolCard): boolean {
	const snap = card.snapshot();
	if (!snap.status || snap.status === 'error') {
		return false;
	}
	return snap.name === 'read_file' || SCAN_KINDS.has(snap.name);
}

/** Normalizes a path for the same-file comparison (separators; case on Windows). */
function normalizePath(path: string): string {
	const normalized = path.replace(/\\/g, '/');
	return isWindows ? normalized.toLowerCase() : normalized;
}

/** The raw path argument of a file tool call. */
function readPathOf(card: VibeAIToolCard): string | undefined {
	const args = card.snapshot().args;
	if (args && typeof args === 'object') {
		const path = String((args as Record<string, unknown>)['path'] ?? '');
		return path.length > 0 ? path : undefined;
	}
	return undefined;
}

/** The call's requested line range (args only; the resolved range wins when present). */
function argsReadRange(card: VibeAIToolCard): IVibeAIReadRange | undefined {
	const args = card.snapshot().args;
	if (args && typeof args === 'object') {
		const record = args as Record<string, unknown>;
		const asLine = (value: unknown): number | undefined => {
			const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
			return Number.isInteger(n) && n > 0 ? n : undefined;
		};
		const start = asLine(record['start_line']);
		const end = asLine(record['end_line']);
		if (start !== undefined && end !== undefined && end >= start) {
			return { start, end };
		}
	}
	return undefined;
}

/** The range a card contributes to the union: its display range (widened
 *  by previous passes) or its requested args range, whichever is wider. */
function displayRange(card: VibeAIToolCard): IVibeAIReadRange | undefined {
	return unionReadRanges(card.displayRead, argsReadRange(card));
}

/** Union of two read ranges (min start / max end; the first symbol wins). */
function unionReadRanges(a: IVibeAIReadRange | undefined, b: IVibeAIReadRange | undefined): IVibeAIReadRange | undefined {
	if (!a) {
		return b;
	}
	if (!b) {
		return a;
	}
	return {
		start: Math.min(a.start, b.start),
		end: Math.max(a.end, b.end),
		symbol: a.symbol ?? b.symbol,
	};
}

/** Flattens the group shells of a previous pass (the regroup is idempotent). */
function flattenWorkedGroups(container: HTMLElement): void {
	for (const shell of Array.from(container.querySelectorAll(':scope > details.vibe-ai-worked-group')) as HTMLElement[]) {
		const body = shell.querySelector(':scope > .vibe-ai-worked-group-body');
		if (body) {
			while (body.firstChild) {
				container.insertBefore(body.firstChild, shell);
			}
		}
		shell.remove();
	}
}

function groupLabel(kind: string, count: number): string {
	switch (kind) {
		case 'read_file':
			return localize('vibeAIChat.workedGroup.reads', "Read {0} files", count);
		case 'list_files':
			return localize('vibeAIChat.workedGroup.lists', "Listed {0} directories", count);
		default:
			return localize('vibeAIChat.workedGroup.searches', "Searched {0} times", count);
	}
}

function buildGroupShell(kind: string, memberElements: HTMLElement[]): HTMLElement {
	const shell = $('details.vibe-ai-worked-group');
	const summary = DOM.append(shell, $('summary'));
	const chevron = DOM.append(summary, $('span.codicon.codicon-chevron-right.vibe-ai-worked-group-chevron'));
	chevron.setAttribute('aria-hidden', 'true');
	const icon = DOM.append(summary, $(`span.codicon.${GROUP_ICONS[kind] ?? 'codicon-symbol-file'}.vibe-ai-worked-group-icon`));
	icon.setAttribute('aria-hidden', 'true');
	const label = DOM.append(summary, $('span.vibe-ai-worked-group-label'));
	label.textContent = groupLabel(kind, memberElements.length);
	const body = DOM.append(shell, $('div.vibe-ai-worked-group-body'));
	for (const el of memberElements) {
		body.appendChild(el);
	}
	return shell;
}

/**
 * Regroups the Worked steps container (see the module doc). `cardById`
 * maps the tool-call ids the card elements carry to their cards — the
 * live state's map or the restore path's per-turn map. Absorbed
 * duplicates keep their card objects (persistence stays lossless); only
 * their elements leave the DOM.
 */
export function regroupWorkedSteps(container: HTMLElement, cardById: Map<string, VibeAIToolCard>): void {
	flattenWorkedGroups(container);

	// Classify the current children: groupable read-only cards vs fixed
	// elements (everything else keeps its position).
	const entries: IWorkedEntry[] = (Array.from(container.children) as HTMLElement[]).map(el => {
		const id = toolIdOf(el);
		const card = id !== undefined ? cardById.get(id) : undefined;
		return { el, id, card, groupable: card !== undefined && isGroupable(card) };
	});

	// --- same-file read merge: a later duplicate of an already-seen path
	// detaches, its range unions into the first row's display.
	const absorbed = new Set<string>();
	const readReps = new Map<string, { entry: IWorkedEntry; range: IVibeAIReadRange | undefined }>();
	for (const entry of entries) {
		if (!entry.groupable || !entry.card || entry.id === undefined) {
			continue;
		}
		if (entry.card.snapshot().name !== 'read_file') {
			continue;
		}
		const path = readPathOf(entry.card);
		if (!path) {
			continue;
		}
		const key = normalizePath(path);
		const rep = readReps.get(key);
		if (rep) {
			rep.range = unionReadRanges(rep.range, displayRange(entry.card));
			absorbed.add(entry.id);
			entry.el.remove();
		} else {
			readReps.set(key, { entry, range: displayRange(entry.card) });
		}
	}
	for (const rep of readReps.values()) {
		if (rep.range) {
			rep.entry.card!.widenReadRange(rep.range);
		}
	}

	// --- count groups over the kept rows (post-merge, arrival order kept)
	const kept = entries.filter(entry => entry.groupable && entry.id !== undefined && !absorbed.has(entry.id));
	const keptByKind = new Map<string, IWorkedEntry[]>();
	for (const entry of kept) {
		const kind = entry.card!.snapshot().name;
		const members = keptByKind.get(kind);
		if (members) {
			members.push(entry);
		} else {
			keptByKind.set(kind, [entry]);
		}
	}
	const kindByFirstId = new Map<string, string>();
	const groupedIds = new Set<string>();
	for (const [kind, members] of keptByKind) {
		const shouldGroup = SCAN_KINDS.has(kind)
			? members.length >= SCAN_GROUP_MIN
			: kind === 'read_file' && members.length > READ_GROUP_MAX;
		if (!shouldGroup) {
			continue;
		}
		kindByFirstId.set(members[0].id!, kind);
		for (const member of members) {
			groupedIds.add(member.id!);
		}
	}

	// --- rebuild: fixed elements stay, each group row lands at its first
	// member's position, ungrouped cards pass through.
	const sequence: HTMLElement[] = [];
	for (const entry of entries) {
		if (!entry.groupable || entry.id === undefined || absorbed.has(entry.id)) {
			sequence.push(entry.el);
			continue;
		}
		if (groupedIds.has(entry.id)) {
			const kind = kindByFirstId.get(entry.id);
			if (kind !== undefined) {
				const members = keptByKind.get(kind) ?? [];
				sequence.push(buildGroupShell(kind, members.map(member => member.el)));
			}
			continue;
		}
		sequence.push(entry.el);
	}
	DOM.clearNode(container);
	for (const el of sequence) {
		container.appendChild(el);
	}
}

/**
 * Counts the completed read-only activity the container currently shows
 * (post-merge: a merged file counts once) — the settled summary's data.
 */
export function summarizeWorkedActivity(container: HTMLElement, cardById: Map<string, VibeAIToolCard>): IWorkedActivityCounts {
	let reads = 0;
	let lists = 0;
	let searches = 0;
	const seenReadPaths = new Set<string>();
	for (const el of Array.from(container.querySelectorAll('details.vibe-ai-tool-card')) as HTMLElement[]) {
		const id = toolIdOf(el);
		const card = id !== undefined ? cardById.get(id) : undefined;
		if (!card) {
			continue;
		}
		const snap = card.snapshot();
		if (!snap.status || snap.status === 'error') {
			continue;
		}
		if (snap.name === 'read_file') {
			const path = readPathOf(card);
			const key = path !== undefined ? normalizePath(path) : undefined;
			if (key !== undefined && seenReadPaths.has(key)) {
				continue;
			}
			if (key !== undefined) {
				seenReadPaths.add(key);
			}
			reads++;
		} else if (snap.name === 'list_files') {
			lists++;
		} else if (snap.name === 'grep' || snap.name === 'search_codebase') {
			searches++;
		}
	}
	return { reads, lists, searches };
}

/** The "Read 5 files · Searched 2 times" segments of the settled label. */
export function workedCountsSegments(counts: IWorkedActivityCounts): string[] {
	const segments: string[] = [];
	if (counts.reads > 0) {
		segments.push(counts.reads === 1
			? localize('vibeAIChat.workedSummary.readOne', "Read {0} file", counts.reads)
			: localize('vibeAIChat.workedSummary.readMany', "Read {0} files", counts.reads));
	}
	if (counts.lists > 0) {
		segments.push(counts.lists === 1
			? localize('vibeAIChat.workedSummary.listOne', "Listed {0} directory", counts.lists)
			: localize('vibeAIChat.workedSummary.listMany', "Listed {0} directories", counts.lists));
	}
	if (counts.searches > 0) {
		segments.push(counts.searches === 1
			? localize('vibeAIChat.workedSummary.searchOne', "Searched {0} time", counts.searches)
			: localize('vibeAIChat.workedSummary.searchMany', "Searched {0} times", counts.searches));
	}
	return segments;
}
