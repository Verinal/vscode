/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVibeAICodeChange, IVibeAIModelRouting, IVibeAIPlan, IVibeAIReadRange, IVibeAIMessage } from '../../../../platform/vibeAI/common/vibeAI.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

/**
 * One agent tool call of a persisted turn (Phase 45): everything the tool
 * card needs to re-render losslessly from history — name/args summary,
 * result text, status and the recorded code change (whose full old/new
 * contents are kept so checkpoint rollback keeps working after a reload).
 */
export interface IVibeAIPersistedToolCall {
	readonly id?: string;
	readonly name: string;
	readonly args?: unknown;
	readonly result?: string;
	/** run_terminal raw command output (Phase 58: output preview). */
	readonly output?: string;
	readonly status?: string;
	readonly codeChange?: IVibeAICodeChange;
	/** read_file actual line range (Phase 63: args-summary range). */
	readonly read?: IVibeAIReadRange;
	/** Live write_file preview accumulated during streaming. */
	readonly streamText?: string;
}

/**
 * Phase 58: one interleaved narration segment of a persisted turn — a
 * character range of `answer` (offsets into the full turn text) plus the
 * ids of the mutating tool calls rendered right below it. Splits the turn
 * text at each "text delta after tool activity" boundary so the restored
 * view interleaves the explanation between the tool cards (live parity;
 * the backend round_end carries no split payload — the event order is
 * the split signal).
 */
export interface IVibeAIPersistedTurnSegment {
	readonly textStart: number;
	readonly textEnd: number;
	readonly toolIds: string[];
}

/**
 * Phase 60: one block of a persisted turn's chronological timeline — the
 * agent's run order (thinking → narration → tools → thinking → …) as a
 * flat node sequence. A contiguous run of one event type becomes one
 * node: `thinking` = a "Thought for Xs" block, `text` = a narration body,
 * `tools` = the run's mutating cards + read-only "Worked" section.
 * `start`/`end` slice `turn.thinking` (`thinking`) or `turn.answer`
 * (`text`) — offsets, never copies, so the clip and size guards stay
 * intact. Multiple nodes per kind render multiple blocks per turn in run
 * order; the backend round_end carries no split payload, so the event
 * type switches are the run boundaries. Phase 102: the final answer
 * never renders inside a Thought block — text nodes render outside (the
 * final one as the answer body); a legacy `hostsAnswer` flag saved by
 * pre-102 sessions is ignored on restore.
 */
export interface IVibeAITurnTimelineNode {
	readonly kind: 'thinking' | 'text' | 'tools';
	/** thinking/text: character range into turn.thinking / turn.answer. */
	readonly start?: number;
	readonly end?: number;
	/** thinking/tools: the block's own duration ("Thought/Worked for Xs"). */
	readonly durationMs?: number;
	/** tools: tool call ids of this run, in arrival order. */
	readonly toolIds?: string[];
}

/**
 * One completed Q&A turn of a persisted conversation (Phase 45): the user
 * text plus every artifact needed to re-render the assistant turn with
 * full parity to the live view — thinking process, tool cards, answer,
 * checkpoint footer data and the recorded file changes.
 */
export interface IVibeAIPersistedTurn {
	readonly userText: string;
	readonly thinking?: string;
	readonly thinkingDurationMs?: number;
	/**
	 * Phase 61: the turn-level Worked block's total duration — the ONE
	 * "Worked for Xs" collapsible covering the whole turn's activity
	 * (thinking runs, tool cards, narration). Optional: sessions saved
	 * before Phase 61 predate the field and the restore falls back to the
	 * sum of the timeline nodes' own durations.
	 */
	readonly workDurationMs?: number;
	readonly tools?: IVibeAIPersistedToolCall[];
	readonly answer: string;
	readonly turnStartedAt?: number;
	readonly contextCompressed?: boolean;
	readonly outputTruncated?: boolean;
	/**
	 * Phase 103: the agent loop exhausted its rounds/segments or the
	 * context window (the turn ends with the backend's forced summary) —
	 * the restore renders the note + Continue chip (Cursor-parity loop
	 * continuation). Optional — sessions saved before Phase 103 predate
	 * the field.
	 */
	readonly limitReached?: boolean;
	/**
	 * Phase 70: the model the Auto router picked for this turn (Cursor-
	 * parity underlying-model display). Optional — sessions saved before
	 * Phase 70 predate the field and restore without the note.
	 */
	readonly routedModel?: IVibeAIModelRouting;
	readonly error?: string;
	/**
	 * Phase 97: the turn was interrupted by the next send (the streamed
	 * progress stays; the restore renders the interruption note). Optional
	 * — sessions saved before Phase 97 predate the field.
	 */
	readonly interrupted?: boolean;
	/**
	 * Phase 113: steers injected DURING this turn (the `steered` echoes,
	 * in arrival order) — the restored Worked shell renders their bubbles
	 * at the end of the steps. Optional — sessions saved before Phase 113
	 * predate the field.
	 */
	readonly steered?: string[];
	/**
	 * Phase 113: steers this turn ended with (queued but never injected) —
	 * the restore renders the "not delivered" note; the messages themselves
	 * ride the session's `messages` (steered marker) so the next turn
	 * carries them. Optional — sessions saved before Phase 113 predate it.
	 */
	readonly steeredPending?: string[];
	readonly turnChanges?: IVibeAICodeChange[];
	/** Set once a checkpoint rollback reverted this turn's file changes. */
	readonly rolledBack?: boolean;
	/**
	 * Phase 88: set once the user confirmed (Keep) this turn's file
	 * changes — restore skips the turn when re-picking the docked review
	 * bar (the bar never resurrects for a kept turn). Optional — sessions
	 * saved before Phase 88 predate the field.
	 */
	readonly kept?: boolean;
	/**
	 * Phase 58: interleaved narration — character offsets into `answer`
	 * splitting it at each mutating-tool boundary, with the tool ids
	 * rendering below each segment. Optional — sessions saved before
	 * Phase 58 predate the field and restore as one merged body (old
	 * layout: every card above the whole answer).
	 */
	readonly segments?: IVibeAIPersistedTurnSegment[];
	/**
	 * Phase 60: the turn's chronological timeline — thinking, narration
	 * and tool runs as flat nodes (see {@link IVibeAITurnTimelineNode}).
	 * Optional — sessions saved before Phase 60 predate the field and
	 * restore via the older segments / merged layouts.
	 */
	readonly timeline?: IVibeAITurnTimelineNode[];
	/**
	 * Phase 71: the plan this turn produced (Plan mode) + its lifecycle —
	 * `planStatus` is 'executed' after the execute phase finished,
	 * 'cancelled' when the user declined (never 'awaiting'/'executing' in
	 * practice — those are live states only, kept for typing parity with
	 * the pane's card status). `planResults` is the plan_done roll-up
	 * (done/failed step ids) for the restored card's per-step states.
	 */
	readonly plan?: IVibeAIPlan;
	readonly planStatus?: 'awaiting' | 'executing' | 'executed' | 'cancelled';
	readonly planResults?: { stepsDone: number[]; stepsFailed: number[] };
}

/**
 * A persisted chat conversation. Phase 45: alongside the plain message
 * pairs (which feed the next request's history) the completed turns are
 * stored with their per-turn artifacts so history restores with full
 * parity to the live conversation.
 */
export interface IVibeAIChatSession {
	readonly id: string;
	readonly title: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly messages: IVibeAIMessage[];
	/**
	 * Per-turn artifacts (Phase 45): thinking, tool cards, file changes.
	 * Optional — sessions saved before Phase 45 predate the field and
	 * restore as plain pairs.
	 */
	readonly turns?: IVibeAIPersistedTurn[];
	/**
	 * Custom context-window length (Phase 41, 100K–1M tokens) chosen in
	 * the chat pane's context usage panel. Optional — sessions saved
	 * before Phase 41 predate the setting.
	 */
	readonly contextLimit?: number;
	/**
	 * Phase 49: pinned sessions float to the top of the history dropdown
	 * in their own group. Optional — sessions saved before Phase 49
	 * predate the flag.
	 */
	readonly pinned?: boolean;
	/**
	 * Phase 93: the conversation's own composer mode (ask/agent/plan) —
	 * per session so restored tabs keep the mode they were saved with.
	 * Optional — sessions saved before Phase 93 predate the field and
	 * restore as the default ask.
	 */
	readonly mode?: 'ask' | 'agent' | 'plan';
	/**
	 * Phase 116: Side Chat (Cursor parity @ side chats) — 'side' marks a
	 * side-chat session created with `/side <question>` (an Ask-only
	 * thread whose parent conversation rides the request as a hidden
	 * reference). Optional — sessions saved before Phase 116 predate the
	 * field and restore as 'main'.
	 */
	readonly kind?: 'main' | 'side';
	/**
	 * Phase 116: the side chat's parent session id — the thread `/side`
	 * was opened from. Absent for mains and for side chats opened from
	 * a fresh (empty) tab.
	 */
	readonly parentSessionId?: string;
	/**
	 * Phase 120: the session goal (Cursor parity: a long-lived objective
	 * the conversation works towards, set via `/goal`) — carried on every
	 * request of the session. Optional — sessions saved before Phase 120
	 * predate the field.
	 */
	readonly goal?: string;
	/**
	 * Phase 120: the mark_goal_complete confirmation (the goal banner's
	 * done state). Optional — sessions saved before Phase 120 predate it.
	 */
	readonly goalComplete?: boolean;
}

/**
 * Phase 101: one open conversation's recorded scroll position — `top`
 * is the thread holder's scrollTop; `atBottom` mirrors the follow-latest
 * threshold, so a tab parked near the bottom restores pinned to it (a
 * stale exact offset would leave the stream chase off — block heights
 * drift between windows).
 */
export interface IVibeAIChatScrollPos {
	readonly top: number;
	readonly atBottom: boolean;
}

/**
 * Phase 79: the chat pane's open-tab strip state — the session ids of
 * every non-empty open conversation in tab order plus the active one —
 * persisted alongside the sessions so the open tabs and the current
 * conversation restore on the next window start (Cursor-parity chat
 * restore). Empty conversations are never recorded (the store doesn't
 * keep zero-message sessions either). Phase 101: the open tabs'
 * recorded scroll positions ride along (keyed by session id — stable
 * across restarts, unlike conversation ids) so the tabs come back where
 * their threads were left on the next window start / project re-open.
 */
export interface IVibeAIChatOpenState {
	readonly openIds: string[];
	readonly activeId: string | undefined;
	readonly scrollTops?: Record<string, IVibeAIChatScrollPos>;
}

/**
 * Phase 123: one cross-session search hit — the matched conversation
 * plus where the match lives. `kind` splits title matches (session
 * level) from message matches (a prompt or a final answer);
 * `turnIndex` is the 0-based Q&A turn ordinal the hit lands on — the
 * alignment the thread renders with (the k-th non-steered prompt ↔ the
 * k-th user row, the k-th answer ↔ the k-th assistant row) — and -1
 * marks a session-level hit that opens at the latest turn. `snippet`
 * trims the matched text to one line around the match.
 */
export interface IVibeAIChatSearchHit {
	readonly sessionId: string;
	readonly sessionTitle: string;
	readonly kind: 'title' | 'user' | 'assistant';
	readonly turnIndex: number;
	readonly snippet: string;
}

const STORAGE_KEY = 'vibeAI.chat.sessions';
/** Phase 79: the open-tab strip state (which sessions are open + active). */
const OPEN_STATE_KEY = 'vibeAI.chat.openState';
const MAX_SESSIONS = 25;
const TITLE_MAX_CHARS = 48;
/** Per-tool result text clip for persistence — rendering only needs the tail. */
const TOOL_RESULT_MAX_CHARS = 4000;
/**
 * Storage size guard (Phase 45): when the serialized sessions exceed this,
 * the per-turn artifacts are dropped and only the plain message pairs are
 * kept — history must never break on storage errors.
 */
const MAX_STORED_JSON_CHARS = 4_000_000;

function sessionTitle(messages: IVibeAIMessage[]): string {
	const firstUser = messages.find(m => m.role === 'user');
	const raw = (firstUser?.content ?? '').trim().replace(/\s+/g, ' ');
	if (raw.length === 0) {
		return 'New Chat';
	}
	return raw.length > TITLE_MAX_CHARS ? `${raw.substring(0, TITLE_MAX_CHARS)}…` : raw;
}

/** Clips a persisted tool text to TOOL_RESULT_MAX_CHARS (rendering only needs the tail). */
function clipText(text: string | undefined): string | undefined {
	// Defense in depth: a non-string (e.g. the backend's raw `{ summary }`
	// tool-result object slipping through) used to throw
	// "text.substring is not a function" inside save() on turn finish,
	// which aborted finishStreaming and left the input's stop button
	// stuck in the streaming state.
	if (typeof text !== 'string') {
		return undefined;
	}
	if (text.length <= TOOL_RESULT_MAX_CHARS) {
		return text;
	}
	return `${text.substring(0, TOOL_RESULT_MAX_CHARS)}…`;
}

/**
 * Phase 123: a one-line snippet around the first case-insensitive match
 * (multi-line message text collapses to spaces); without a match the
 * head of the text stands in (ellipsis-clipped).
 */
export function searchHitSnippet(text: string, needle: string, radius = 40): string {
	const flat = text.replace(/\s+/g, ' ');
	const index = flat.toLowerCase().indexOf(needle);
	if (index === -1) {
		return flat.length > 2 * radius ? `${flat.slice(0, 2 * radius)}…` : flat;
	}
	const start = Math.max(0, index - radius);
	const end = Math.min(flat.length, index + needle.length + radius);
	return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

/**
 * Phase 123: searches one conversation's content (prompts + final
 * answers) with a case-insensitive `includes` match — the traversal the
 * cross-session search and the pane's "This chat" scope share. Turn
 * ordinals follow the alignment the thread renders with: the k-th
 * non-steered prompt ↔ the k-th user row (Phase 61; steered prompts
 * ride inside their turn's Worked shell — they match but land
 * session-level), and plain-pair threads without turns render every
 * message as a row.
 */
export function searchConversationContent(
	sessionId: string,
	sessionTitle: string,
	messages: ReadonlyArray<{ readonly role: string; readonly content: string; readonly steered?: boolean }>,
	turnAnswers: ReadonlyArray<string> | undefined,
	needle: string,
): IVibeAIChatSearchHit[] {
	const hits: IVibeAIChatSearchHit[] = [];
	const hasTurns = !!turnAnswers && turnAnswers.length > 0;
	let userOrdinal = 0;
	for (const message of messages) {
		if (message.role !== 'user') {
			continue;
		}
		const isTurn = !hasTurns || !message.steered;
		if (message.content.toLowerCase().includes(needle)) {
			hits.push({
				sessionId,
				sessionTitle,
				kind: 'user',
				turnIndex: isTurn ? userOrdinal : -1,
				snippet: searchHitSnippet(message.content, needle),
			});
		}
		if (isTurn) {
			userOrdinal++;
		}
	}
	if (hasTurns) {
		turnAnswers.forEach((answer, index) => {
			if (answer.toLowerCase().includes(needle)) {
				hits.push({ sessionId, sessionTitle, kind: 'assistant', turnIndex: index, snippet: searchHitSnippet(answer, needle) });
			}
		});
	} else {
		let assistantOrdinal = 0;
		for (const message of messages) {
			if (message.role !== 'assistant') {
				continue;
			}
			if (message.content.toLowerCase().includes(needle)) {
				hits.push({ sessionId, sessionTitle, kind: 'assistant', turnIndex: assistantOrdinal, snippet: searchHitSnippet(message.content, needle) });
			}
			assistantOrdinal++;
		}
	}
	return hits;
}

/**
 * Persists chat conversations in workspace state so the History action can
 * reload past conversations (Cursor-parity chat history).
 */
export class VibeAIChatSessionStore {

	constructor(private readonly storageService: IStorageService) { }

	list(): IVibeAIChatSession[] {
		try {
			const raw = this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
			const sessions = raw ? JSON.parse(raw) as IVibeAIChatSession[] : [];
			return Array.isArray(sessions) ? sessions : [];
		} catch {
			return [];
		}
	}

	/**
	 * Upserts the conversation as the current session (same id = same
	 * conversation, updated in place). Call after every user turn and again
	 * when the assistant answer finishes.
	 */
	save(sessionId: string, messages: IVibeAIMessage[], contextLimit?: number, turns?: IVibeAIPersistedTurn[], mode?: 'ask' | 'agent' | 'plan', side?: { kind?: 'main' | 'side'; parentSessionId?: string }): void {
		if (messages.length === 0) {
			return;
		}
		const now = Date.now();
		const previous = this.list().find(s => s.id === sessionId);
		const sessions = this.list().filter(s => s.id !== sessionId);
		const session: IVibeAIChatSession = {
			id: sessionId,
			title: sessionTitle(messages),
			// The conversation's creation time sticks across saves.
			createdAt: previous?.createdAt ?? now,
			updatedAt: now,
			// Phase 49: the pinned flag sticks across saves too.
			pinned: previous?.pinned,
			// Phase 61: images (data URLs) ride along with user messages so
			// the restored thread shows the sent thumbnails.
			messages: messages.map(m => ({
				role: m.role,
				content: m.content,
				...(m.images && m.images.length > 0 ? { images: m.images } : {}),
			})),
		};
		// Phase 45: the completed turns go along with their artifacts
		// (thinking, tool cards, file changes) — bulk tool output is clipped.
		if (turns && turns.length > 0) {
			(session as { turns?: IVibeAIPersistedTurn[] }).turns = turns.map(turn => this.clipTurn(turn));
		}
		// Phase 41: the per-session context limit sticks across saves —
		// keep the previously saved value when the caller doesn't pass one.
		const limit = contextLimit ?? previous?.contextLimit;
		if (limit !== undefined) {
			(session as { contextLimit?: number }).contextLimit = limit;
		}
		// Phase 93: the conversation's own composer mode (ask/agent/plan)
		// sticks across saves — keep the previously saved value when the
		// caller doesn't pass one.
		const sessionMode = mode ?? previous?.mode;
		if (sessionMode !== undefined) {
			(session as { mode?: 'ask' | 'agent' | 'plan' }).mode = sessionMode;
		}
		// Phase 116: Side Chat metadata — applied on this save and sticks
		// across saves (like pinned / contextLimit / mode) so later saves
		// keep the session's side identity.
		const kind = side?.kind ?? previous?.kind;
		if (kind !== undefined) {
			(session as { kind?: 'main' | 'side' }).kind = kind;
		}
		const parentSessionId = side?.parentSessionId ?? previous?.parentSessionId;
		if (parentSessionId !== undefined) {
			(session as { parentSessionId?: string }).parentSessionId = parentSessionId;
		}
		// Phase 120: the session goal sticks across saves (like side meta)
		// — turn-finish saves never drop it; the done state rides along.
		// The goal's authoritative writer is setGoal() (explicit set /
		// done / clear); this stick only preserves the stored value.
		if (previous?.goal) {
			(session as { goal?: string }).goal = previous.goal;
			if (previous.goalComplete) {
				(session as { goalComplete?: boolean }).goalComplete = true;
			}
		}
		sessions.unshift(session);
		this.write(sessions.slice(0, MAX_SESSIONS));
	}

	/** Clips bulky tool output before persisting (codeChange contents stay whole — rollback needs them). */
	private clipTurn(turn: IVibeAIPersistedTurn): IVibeAIPersistedTurn {
		return {
			...turn,
			tools: turn.tools?.map(tool => ({
				...tool,
				result: clipText(tool.result),
				output: clipText(tool.output),
				streamText: clipText(tool.streamText),
			})),
		};
	}

	/** Removes the given conversation (Cursor-parity per-history delete). */
	delete(sessionId: string): void {
		this.write(this.list().filter(s => s.id !== sessionId));
	}

	/**
	 * Phase 49: toggles the pinned flag of the given conversation without
	 * touching its timestamps (Cursor-parity history pin).
	 */
	setPinned(sessionId: string, pinned: boolean): void {
		const sessions = this.list();
		const session = sessions.find(s => s.id === sessionId);
		if (!session) {
			return;
		}
		(session as { pinned?: boolean }).pinned = pinned;
		this.write(sessions);
	}

	/**
	 * Phase 120: sets / updates / clears the given conversation's session
	 * goal without touching its other fields (like setPinned — a targeted
	 * mutation; Cursor-parity per-session goal). A non-empty goal sets it
	 * (complete=false resets the done state — a replaced goal is active
	 * again); complete=true flips the done state (the mark_goal_complete
	 * confirmation). An empty goal clears both (the goal never sticks
	 * back). A session not in the store (a fresh tab with no turn yet)
	 * no-ops — the goal rides the first turn-finish save instead, which
	 * re-applies it right after.
	 */
	setGoal(sessionId: string, goal: string | undefined, complete?: boolean): void {
		const sessions = this.list();
		const session = sessions.find(s => s.id === sessionId);
		if (!session) {
			return;
		}
		const target = session as { goal?: string; goalComplete?: boolean };
		const text = (goal ?? '').trim();
		if (text.length === 0) {
			delete target.goal;
			delete target.goalComplete;
		} else {
			target.goal = text;
			if (complete) {
				target.goalComplete = true;
			} else {
				delete target.goalComplete;
			}
		}
		this.write(sessions);
	}

	clear(): void {
		this.storageService.remove(STORAGE_KEY, StorageScope.WORKSPACE);
		// Phase 79: cleared history leaves no open-tab ghosts behind.
		this.storageService.remove(OPEN_STATE_KEY, StorageScope.WORKSPACE);
	}

	/**
	 * Phase 123: cross-session content search — one query across every
	 * stored session's title + prompts + final answers, case-insensitive
	 * `includes` (the sessions live in the frontend's workspace storage —
	 * no backend index, zero new dependencies). Hits carry the
	 * conversation and the turn ordinal to land on; the pane renders and
	 * jumps (see renderHistorySearchHits / openSearchHit).
	 */
	searchContent(query: string): IVibeAIChatSearchHit[] {
		const needle = query.trim().toLowerCase();
		if (needle.length === 0) {
			return [];
		}
		const hits: IVibeAIChatSearchHit[] = [];
		for (const session of this.list()) {
			if (session.title.toLowerCase().includes(needle)) {
				hits.push({ sessionId: session.id, sessionTitle: session.title, kind: 'title', turnIndex: -1, snippet: session.title });
			}
			hits.push(...searchConversationContent(session.id, session.title, session.messages, session.turns?.map(turn => turn.answer), needle));
		}
		return hits;
	}

	/**
	 * Phase 79: reads the persisted open-tab strip state. Defensive: a
	 * missing/corrupt payload restores as "nothing open" (fresh chat).
	 * Phase 101: the scroll-position map is sanitized too — only entries
	 * with a finite top and a boolean atBottom survive; a corrupt one
	 * restores without positions rather than breaking the open strip.
	 */
	getOpenState(): IVibeAIChatOpenState {
		try {
			const raw = this.storageService.get(OPEN_STATE_KEY, StorageScope.WORKSPACE);
			const state = raw ? JSON.parse(raw) as IVibeAIChatOpenState : undefined;
			if (!state || !Array.isArray(state.openIds)) {
				return { openIds: [], activeId: undefined };
			}
			const scrollTops: Record<string, IVibeAIChatScrollPos> = {};
			if (state.scrollTops && typeof state.scrollTops === 'object') {
				for (const [id, pos] of Object.entries(state.scrollTops)) {
					if (id.length > 0 && pos && typeof pos === 'object'
						&& typeof pos.top === 'number' && Number.isFinite(pos.top)
						&& typeof pos.atBottom === 'boolean') {
						scrollTops[id] = { top: pos.top, atBottom: pos.atBottom };
					}
				}
			}
			return {
				openIds: state.openIds.filter(id => typeof id === 'string' && id.length > 0),
				activeId: typeof state.activeId === 'string' && state.activeId.length > 0 ? state.activeId : undefined,
				scrollTops,
			};
		} catch {
			return { openIds: [], activeId: undefined };
		}
	}

	/**
	 * Phase 79: persists the open-tab strip state — called on every
	 * tab-strip mutation (new/close/switch tab, history open, first turn
	 * finished) so the last state survives a window close.
	 */
	saveOpenState(state: IVibeAIChatOpenState): void {
		try {
			this.storageService.store(
				OPEN_STATE_KEY,
				JSON.stringify(state),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE,
			);
		} catch {
			// Persistence is best-effort — never break the chat on storage errors.
		}
	}

	private write(sessions: IVibeAIChatSession[]): void {
		try {
			let raw = JSON.stringify(sessions);
			// Phase 45 size guard: when the per-turn artifacts push the
			// payload over the limit, fall back to the plain message pairs
			// (pre-Phase 45 behavior) instead of breaking persistence.
			if (raw.length > MAX_STORED_JSON_CHARS) {
				raw = JSON.stringify(sessions.map(session => {
					const slim: IVibeAIChatSession = { ...session };
					delete (slim as { turns?: IVibeAIPersistedTurn[] }).turns;
					return slim;
				}));
			}
			// Phase 61: last-resort guard — base64 image payloads are the
			// bulkiest data in the store; when the payload is STILL over
			// the limit, strip them from every message (the text history
			// survives; thumbnails are lost from restored threads only).
			// Phase 113: the steered marker survives (it drives the
			// turn↔user-message alignment on restore).
			if (raw.length > MAX_STORED_JSON_CHARS) {
				raw = JSON.stringify(sessions.map(session => ({
					...session,
					messages: session.messages.map(m => (m.steered ? { role: m.role, content: m.content, steered: true } : { role: m.role, content: m.content })),
				})));
			}
			this.storageService.store(
				STORAGE_KEY,
				raw,
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE,
			);
		} catch {
			// Persistence is best-effort — never break the chat on storage errors.
		}
	}
}
