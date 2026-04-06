/**
 * pi-copilot-usage
 *
 * A pi extension that uses the GitHub Copilot agents SDK (@github/copilot-sdk)
 * to surface your GitHub Copilot Pro plan usage directly inside pi.
 *
 * Features:
 *  - /copilot          – full usage dashboard: quota + sessions overview
 *  - /copilot-quota    – focused quota / premium-requests panel
 *  - /copilot-sessions – browse all sessions; select one to inspect details
 *  - /copilot-models   – model list with billing multipliers
 *  - copilot_usage     – LLM-callable tool that returns structured usage JSON
 *  - Footer status     – live premium-interactions remaining indicator
 *
 * Quota data comes from the GitHub API (/copilot_internal/user via `gh`).
 * Session data comes from the Copilot agents SDK (CopilotClient.listSessions()).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { CopilotClient } from "@github/copilot-sdk";
import type {
	GetAuthStatusResponse,
	GetStatusResponse,
	ModelInfo,
	SessionMetadata,
} from "@github/copilot-sdk";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QuotaSnapshot {
	quota_id: string;
	entitlement: number;
	remaining: number;
	quota_remaining: number;
	overage_count: number;
	overage_permitted: boolean;
	percent_remaining: number;
	unlimited: boolean;
	timestamp_utc: string;
}

interface CopilotUserInfo {
	login: string;
	copilot_plan: string;
	access_type_sku: string;
	quota_reset_date_utc: string;
	quota_snapshots: Record<string, QuotaSnapshot>;
	endpoints: Record<string, string>;
}

interface SessionSummary {
	sessionId: string;
	startTime: string;
	modifiedTime: string;
	durationMinutes: number;
	isActive: boolean;
	summary?: string;
	repository?: string;
	branch?: string;
	cwd?: string;
}

interface UsageStats {
	// Plan / quota
	login?: string;
	copilotPlan?: string;
	cliVersion?: string;
	quotaResetDate?: string;
	quotaSnapshots?: Record<string, QuotaSnapshot>;
	// Models
	models?: Array<{ id: string; name: string; multiplier: number; free: boolean }>;
	// Session counts
	fetchedAt: string;
	total: number;
	today: number;
	thisWeek: number;
	thisMonth: number;
	byRepository: Record<string, number>;
	byDirectory: Record<string, number>;
	avgDurationMinutes: number;
	activeSessions: number;
	recentSessions: SessionSummary[];
}

// Shared shape returned by fetchAll — used to type the TTL cache (fix #3)
interface FetchResult {
	sessions: SessionMetadata[];
	userInfo?: CopilotUserInfo;
	status?: GetStatusResponse;
	auth?: GetAuthStatusResponse;
	models?: ModelInfo[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_MIN = 60_000;
const ACTIVE_THRESHOLD_MS = 15 * MS_PER_MIN;

function startOfDay(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function startOfWeek(d: Date): Date {
	const s = startOfDay(d);
	s.setDate(s.getDate() - s.getDay());
	return s;
}
function startOfMonth(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), 1);
}
function shortPath(cwd: string): string {
	const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
	return parts.length > 2 ? parts.slice(-2).join("/") : cwd;
}
function fmtDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function fmtTime(iso: string): string {
	return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtDuration(minutes: number): string {
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function bar(label: string, width = 40): string {
	return `── ${label} ${"─".repeat(Math.max(0, width - label.length - 4))}`;
}
function pad(s: string, n: number): string {
	return s.padEnd(n);
}

/**
 * Progress bar showing `percent` filled.
 * Uses a plain space for empty cells — block chars like ░ render wider
 * than █ in most terminal fonts, making the bar look inaccurate.
 * Width 30 gives ~3.3% resolution per cell.
 */
function progressBar(percent: number, width = 30): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	const empty = width - filled;
	return `|${"█".repeat(filled)}${" ".repeat(empty)}| ${clamped.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// GitHub API – quota data
// ---------------------------------------------------------------------------

async function fetchCopilotUserInfo(): Promise<CopilotUserInfo> {
	const { stdout } = await execFileAsync("gh", ["api", "/copilot_internal/user"]);
	return JSON.parse(stdout) as CopilotUserInfo;
}

// ---------------------------------------------------------------------------
// Stats computation
// ---------------------------------------------------------------------------

function computeStats(
	sessions: SessionMetadata[],
	userInfo?: CopilotUserInfo,
	status?: GetStatusResponse,
	auth?: GetAuthStatusResponse,
	models?: ModelInfo[],
): UsageStats {
	const now = new Date();
	const todayStart = startOfDay(now).getTime();
	const weekStart = startOfWeek(now).getTime();
	const monthStart = startOfMonth(now).getTime();

	let today = 0, thisWeek = 0, thisMonth = 0, activeSessions = 0, totalDurationMs = 0;
	const byRepository: Record<string, number> = {};
	const byDirectory: Record<string, number> = {};

	const sorted = [...sessions].sort((a, b) => b.modifiedTime.getTime() - a.modifiedTime.getTime());

	for (const s of sessions) {
		const start = s.startTime.getTime();
		if (start >= todayStart) today++;
		if (start >= weekStart) thisWeek++;
		if (start >= monthStart) thisMonth++;
		totalDurationMs += Math.max(0, s.modifiedTime.getTime() - s.startTime.getTime());
		if (now.getTime() - s.modifiedTime.getTime() < ACTIVE_THRESHOLD_MS) activeSessions++;
		if (s.context?.repository) {
			const r = s.context.repository;
			byRepository[r] = (byRepository[r] ?? 0) + 1;
		}
		if (s.context?.cwd) {
			const d = shortPath(s.context.cwd);
			byDirectory[d] = (byDirectory[d] ?? 0) + 1;
		}
	}

	const recentSessions: SessionSummary[] = sorted.slice(0, 20).map((s) => ({
		sessionId: s.sessionId,
		startTime: s.startTime.toISOString(),
		modifiedTime: s.modifiedTime.toISOString(),
		durationMinutes: Math.round(Math.max(0, s.modifiedTime.getTime() - s.startTime.getTime()) / MS_PER_MIN),
		isActive: now.getTime() - s.modifiedTime.getTime() < ACTIVE_THRESHOLD_MS,
		summary: s.summary,
		repository: s.context?.repository,
		branch: s.context?.branch,
		cwd: s.context?.cwd,
	}));

	const modelList = models?.map((m) => ({
		id: m.id,
		name: (m as { name?: string }).name ?? m.id,
		multiplier: m.billing?.multiplier ?? 0,
		free: (m.billing?.multiplier ?? 0) === 0,
	}));

	return {
		login: auth?.login ?? userInfo?.login,
		copilotPlan: userInfo?.copilot_plan ?? "unknown",
		cliVersion: status?.version,
		quotaResetDate: userInfo?.quota_reset_date_utc,
		quotaSnapshots: userInfo?.quota_snapshots,
		models: modelList,
		fetchedAt: now.toISOString(),
		total: sessions.length,
		today,
		thisWeek,
		thisMonth,
		byRepository,
		byDirectory,
		avgDurationMinutes: sessions.length > 0 ? Math.round(totalDurationMs / sessions.length / MS_PER_MIN) : 0,
		activeSessions,
		recentSessions,
	};
}

// ---------------------------------------------------------------------------
// TUI line formatters
// ---------------------------------------------------------------------------

function quotaLines(stats: UsageStats): string[] {
	const lines: string[] = [];
	const snap = stats.quotaSnapshots ?? {};
	const resetDate = stats.quotaResetDate ? fmtDate(stats.quotaResetDate) : "unknown";

	lines.push(bar("Copilot Pro Plan Quota"));
	if (stats.login) lines.push(`  User         ${stats.login}`);
	if (stats.copilotPlan) lines.push(`  Plan         ${stats.copilotPlan}`);
	if (stats.cliVersion) lines.push(`  CLI          v${stats.cliVersion}`);
	lines.push(`  Resets       ${resetDate}`);
	lines.push(`  Fetched      ${fmtDate(stats.fetchedAt)} at ${fmtTime(stats.fetchedAt)}`);
	lines.push("");

	// Premium interactions (the metered bucket for premium models)
	const pi = snap["premium_interactions"];
	if (pi) {
		const used = pi.entitlement - pi.remaining;
		const pctUsed = 100 - pi.percent_remaining;
		lines.push(bar("Premium interactions  (metered)"));
		lines.push(`  Entitlement  ${pi.entitlement} requests / month`);
		lines.push(`  Used         ${used}  (${pctUsed.toFixed(1)}%)`);
		lines.push(`  Remaining    ${pi.remaining}  (${pi.percent_remaining.toFixed(1)}%)`);
		lines.push(`  Overage      ${pi.overage_permitted ? `allowed (${pi.overage_count} so far)` : "not permitted"}`);
		lines.push(`               ${progressBar(100 - pi.percent_remaining)}  ${pi.remaining} left`);
		lines.push("");
	}

	// Chat
	const chat = snap["chat"];
	if (chat) {
		lines.push(bar("Chat"));
		lines.push(`  ${chat.unlimited ? "✓ Unlimited" : `${chat.remaining} remaining`}`);
	}

	// Completions (inline code)
	const completions = snap["completions"];
	if (completions) {
		lines.push(bar("Completions (inline)"));
		lines.push(`  ${completions.unlimited ? "✓ Unlimited" : `${completions.remaining} remaining`}`);
	}

	// Any other quota buckets
	for (const [key, q] of Object.entries(snap)) {
		if (["premium_interactions", "chat", "completions"].includes(key)) continue;
		lines.push("");
		lines.push(bar(key));
		lines.push(`  ${q.unlimited ? "✓ Unlimited" : `${q.remaining} / ${q.entitlement} remaining`}`);
	}

	return lines;
}

function modelLines(stats: UsageStats): string[] {
	const lines: string[] = [];
	const models = stats.models ?? [];
	const free = models.filter((m) => m.free);
	const premium = models.filter((m) => !m.free).sort((a, b) => a.multiplier - b.multiplier);

	lines.push(bar("Model billing  (premium-interaction cost per request)"));
	lines.push("");
	lines.push(bar("Free  (0 premium interactions)"));
	if (free.length === 0) {
		lines.push("  (none)");
	} else {
		for (const m of free) {
			lines.push(`  ${pad(m.id, 32)} ${m.name}`);
		}
	}
	lines.push("");
	lines.push(bar("Premium  (counted against your 300/month quota)"));
	for (const m of premium) {
		const cost = m.multiplier === 1 ? "1×" : `${m.multiplier}×`;
		lines.push(`  ${pad(m.id, 32)} ${pad(cost, 6)} ${m.name}`);
	}
	return lines;
}

function overviewLines(stats: UsageStats): string[] {
	const lines: string[] = [];
	const snap = stats.quotaSnapshots;

	// ── Quota summary at the top ─────────────────────────────────────────────
	if (snap) {
		lines.push(bar("Copilot Pro Plan Quota"));
		if (stats.login) lines.push(`  User         ${stats.login}`);
		if (stats.copilotPlan) lines.push(`  Plan         ${stats.copilotPlan}`);
		if (stats.quotaResetDate) lines.push(`  Resets       ${fmtDate(stats.quotaResetDate)}`);
		lines.push("");

		const pi = snap["premium_interactions"];
		if (pi) {
			const used = pi.entitlement - pi.remaining;
			lines.push(`  Premium interactions: ${used} used / ${pi.entitlement} total`);
			lines.push(`  ${progressBar(100 - pi.percent_remaining)}  ${pi.remaining} left`);
		}
		const chat = snap["chat"];
		if (chat) lines.push(`  Chat: ${chat.unlimited ? "✓ unlimited" : `${chat.remaining} remaining`}`);
		const comp = snap["completions"];
		if (comp) lines.push(`  Completions: ${comp.unlimited ? "✓ unlimited" : `${comp.remaining} remaining`}`);
	}

	// ── Session overview ─────────────────────────────────────────────────────
	lines.push("");
	lines.push(bar("Session counts (Copilot CLI)"));
	if (stats.cliVersion) lines.push(`  CLI          v${stats.cliVersion}`);
	lines.push(`  ${pad("Total", 12)} ${stats.total}`);
	lines.push(`  ${pad("Today", 12)} ${stats.today}`);
	lines.push(`  ${pad("This week", 12)} ${stats.thisWeek}`);
	lines.push(`  ${pad("This month", 12)} ${stats.thisMonth}`);
	lines.push(`  ${pad("Active now", 12)} ${stats.activeSessions}`);
	lines.push(`  ${pad("Avg duration", 12)} ${fmtDuration(stats.avgDurationMinutes)}`);

	const topRepos = Object.entries(stats.byRepository).sort(([, a], [, b]) => b - a).slice(0, 5);
	if (topRepos.length > 0) {
		lines.push("");
		lines.push(bar("Top repositories"));
		for (const [repo, count] of topRepos) {
			lines.push(`  ${pad(repo, 32)} ${count}×`);
		}
	}

	const topDirs = Object.entries(stats.byDirectory).sort(([, a], [, b]) => b - a).slice(0, 5);
	if (topDirs.length > 0) {
		lines.push("");
		lines.push(bar("Top directories"));
		for (const [dir, count] of topDirs) {
			lines.push(`  ${pad(dir, 32)} ${count}×`);
		}
	}

	lines.push("");
	lines.push(bar("Recent sessions"));
	for (const s of stats.recentSessions.slice(0, 10)) {
		const active = s.isActive ? "🟢 " : "   ";
		const when = `${fmtDate(s.modifiedTime)} ${fmtTime(s.modifiedTime)}`;
		const dur = fmtDuration(s.durationMinutes);
		const repo = s.repository ? ` [${s.repository}]` : s.cwd ? ` [${shortPath(s.cwd)}]` : "";
		const summary = s.summary ? `  ${s.summary.slice(0, 48)}` : "";
		lines.push(`${active}${when}  (${dur})${repo}${summary}`);
	}

	return lines;
}

// Expects a pre-sorted array — caller owns the sort order (fix #2: was sorted internally too)
function sessionListLines(sessions: SessionMetadata[]): string[] {
	const now = Date.now();
	return sessions.map((s) => {
		const active = now - s.modifiedTime.getTime() < ACTIVE_THRESHOLD_MS ? "🟢 " : "   ";
		const when = `${fmtDate(s.modifiedTime.toISOString())} ${fmtTime(s.modifiedTime.toISOString())}`;
		const dur = fmtDuration(Math.round(Math.max(0, s.modifiedTime.getTime() - s.startTime.getTime()) / MS_PER_MIN));
		const repo = s.context?.repository ?? (s.context?.cwd ? shortPath(s.context.cwd) : "");
		const label = repo ? ` [${repo}]` : "";
		const summary = s.summary ? `  ${s.summary.slice(0, 45)}…` : "";
		return `${active}${when}  (${dur})${label}${summary}`;
	});
}

function sessionDetailLines(s: SessionMetadata): string[] {
	const lines: string[] = [];
	const dur = fmtDuration(Math.round(Math.max(0, s.modifiedTime.getTime() - s.startTime.getTime()) / MS_PER_MIN));
	lines.push(bar("Session details"));
	lines.push(`  ID           ${s.sessionId}`);
	lines.push(`  Started      ${fmtDate(s.startTime.toISOString())} ${fmtTime(s.startTime.toISOString())}`);
	lines.push(`  Last active  ${fmtDate(s.modifiedTime.toISOString())} ${fmtTime(s.modifiedTime.toISOString())}`);
	lines.push(`  Duration     ${dur}`);
	lines.push(`  Remote       ${s.isRemote}`);
	if (s.context) {
		lines.push("");
		lines.push(bar("Context"));
		if (s.context.repository) lines.push(`  Repository   ${s.context.repository}`);
		if (s.context.branch) lines.push(`  Branch       ${s.context.branch}`);
		if (s.context.gitRoot) lines.push(`  Git root     ${s.context.gitRoot}`);
		if (s.context.cwd) lines.push(`  Directory    ${s.context.cwd}`);
	}
	if (s.summary) {
		lines.push("");
		lines.push(bar("Summary"));
		const words = s.summary.split(" ");
		let line = "  ";
		for (const w of words) {
			if (line.length + w.length > 62) { lines.push(line); line = "  "; }
			line += w + " ";
		}
		if (line.trim()) lines.push(line);
	}
	return lines;
}

function statusLabel(stats: UsageStats): string {
	const pi = stats.quotaSnapshots?.["premium_interactions"];
	if (!pi) return `🟢 Copilot: ${stats.total} sessions`;
	const pct = pi.percent_remaining;
	const icon = pct > 25 ? "🟢" : pct > 10 ? "🟡" : "🔴";
	return `${icon} Copilot: ${pi.remaining}/${pi.entitlement} premium left`;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 60_000; // refresh footer every 60s

export default function (pi: ExtensionAPI) {
	// fix #5: promise-singleton so concurrent callers share one CopilotClient.start()
	let clientPromise: Promise<CopilotClient> | null = null;
	// fix #3: TTL cache — avoids redundant full API round-trips on repeat commands
	let fetchCache: { data: FetchResult; ts: number } | null = null;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let isPolling = false; // guard against re-entrant polling calls
	// Store only the one function we need — not the whole ExtensionContext
	let setStatus: ((id: string, text: string) => void) | null = null;

	// fix #5: returns the shared in-flight promise; no second start() on concurrent callers
	function getClient(): Promise<CopilotClient> {
		if (!clientPromise) {
			clientPromise = (async () => {
				const c = new CopilotClient({ logLevel: "none" });
				await c.start();
				return c;
			})();
		}
		return clientPromise;
	}

	// fix #4: always calls stop() on the old client instead of just nulling it
	async function stopClient(): Promise<void> {
		if (!clientPromise) return;
		const p = clientPromise;
		clientPromise = null;
		fetchCache = null; // stale data after client reset
		try { await (await p).stop(); } catch { /* swallow on shutdown */ }
	}

	/** Fetch all data sources in parallel; userInfo failures are non-fatal. */
	async function fetchAll(): Promise<FetchResult> {
		const c = await getClient();
		const [sessions, status, auth, models, userInfo] = await Promise.all([
			c.listSessions(),
			c.getStatus().catch(() => undefined),
			c.getAuthStatus().catch(() => undefined),
			c.listModels().catch(() => undefined),
			fetchCopilotUserInfo().catch(() => undefined),
		]);
		return { sessions, userInfo, status, auth, models };
	}

	// fix #3: cached wrapper — returns fresh data at most every 30 s
	const FETCH_CACHE_TTL_MS = 30_000;
	async function fetchAllCached(): Promise<FetchResult> {
		if (fetchCache && Date.now() - fetchCache.ts < FETCH_CACHE_TTL_MS) return fetchCache.data;
		const data = await fetchAll();
		fetchCache = { data, ts: Date.now() };
		return data;
	}

	/**
	 * Lightweight quota-only fetch (no SDK needed, just gh CLI).
	 * Uses recursive setTimeout so the next poll only schedules *after*
	 * this one completes — prevents overlapping gh processes.
	 */
	async function refreshQuotaStatus(): Promise<void> {
		if (isPolling || !setStatus) return; // already running or shut down
		isPolling = true;
		try {
			const userInfo = await fetchCopilotUserInfo();
			const pi_q = userInfo.quota_snapshots?.["premium_interactions"];
			if (pi_q && setStatus) {
				const pct = pi_q.percent_remaining;
				const icon = pct > 25 ? "🟢" : pct > 10 ? "🟡" : "🔴";
				setStatus("copilot-usage", `${icon} Copilot: ${pi_q.remaining}/${pi_q.entitlement} premium left`);
			}
		} catch {
			// Silently ignore – will retry next cycle
		} finally {
			isPolling = false;
			// Schedule next poll only after this one fully completes
			if (setStatus !== null) {
				pollTimer = setTimeout(refreshQuotaStatus, POLL_INTERVAL_MS);
			}
		}
	}

	// fix #6: delay first fetch by 3 s to avoid blocking session startup
	function startPolling(fn: (id: string, text: string) => void): void {
		stopPolling();
		setStatus = fn;
		// Delay the first gh call so it doesn't slow down session startup;
		// subsequent calls chain via setTimeout inside refreshQuotaStatus finally block
		pollTimer = setTimeout(refreshQuotaStatus, 3_000);
	}

	function stopPolling(): void {
		setStatus = null; // signals refreshQuotaStatus not to reschedule
		if (pollTimer) {
			clearTimeout(pollTimer);
			pollTimer = null;
		}
		fetchCache = null; // invalidate cached data on session end (fix #3)
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("copilot-usage", "🔄 Copilot: loading…");
		startPolling(ctx.ui.setStatus.bind(ctx.ui));
	});

	pi.on("session_shutdown", async () => {
		stopPolling();
		await stopClient();
	});

	// ── /copilot – full overview ───────────────────────────────────────────────

	pi.registerCommand("copilot", {
		description: "Show GitHub Copilot usage dashboard (quota + sessions)",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("copilot-usage", "🔄 Copilot: fetching…");
			try {
				const { sessions, userInfo, status, auth, models } = await fetchAllCached();
				const stats = computeStats(sessions, userInfo, status, auth, models);
				ctx.ui.setStatus("copilot-usage", statusLabel(stats));
				await ctx.ui.select("GitHub Copilot Usage", overviewLines(stats));
			} catch (err) {
				await stopClient(); // fix #4: stop + clear cache; don't orphan old client
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.setStatus("copilot-usage", "🔴 Copilot: error");
				ctx.ui.notify(`Copilot error: ${msg}`, "error");
			}
		},
	});

	// ── /copilot-quota – focused quota panel ──────────────────────────────────

	pi.registerCommand("copilot-quota", {
		description: "Show Copilot Pro plan quota (premium interactions remaining)",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("copilot-usage", "🔄 Copilot: fetching quota…");
			try {
				// fix #3: use shared cache — no separate listModels/getStatus calls
				const { userInfo, status, auth, models } = await fetchAllCached();
				const stats = computeStats([], userInfo, status, auth, models);
				ctx.ui.setStatus("copilot-usage", statusLabel(stats));
				// Combine quota + model billing in one view
				const lines = [
					...quotaLines(stats),
					"",
					...modelLines(stats),
				];
				await ctx.ui.select("Copilot Pro Quota", lines);
			} catch (err) {
				await stopClient(); // fix #4
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.setStatus("copilot-usage", "🔴 Copilot: error");
				ctx.ui.notify(`Copilot error: ${msg}`, "error");
			}
		},
	});

	// ── /copilot-sessions – session browser ───────────────────────────────────

	pi.registerCommand("copilot-sessions", {
		description: "Browse GitHub Copilot sessions",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("copilot-usage", "🔄 Copilot: fetching sessions…");
			try {
				const { sessions } = await fetchAllCached(); // fix #3
				if (sessions.length === 0) {
					ctx.ui.notify("No Copilot sessions found.", "info");
					ctx.ui.setStatus("copilot-usage", "⚫ Copilot: 0 sessions");
					return;
				}
				ctx.ui.setStatus("copilot-usage", `🟢 Copilot: ${sessions.length} sessions`);

				// fix #2: sort once here and pass to sessionListLines (was sorted twice)
				const sorted = [...sessions].sort((a, b) => b.modifiedTime.getTime() - a.modifiedTime.getTime());
				const lines = sessionListLines(sorted);
				const chosen = await ctx.ui.select(
					`Copilot sessions (${sessions.length} total – pick one for details)`,
					lines,
				);
				if (!chosen) return;
				const idx = lines.indexOf(chosen);
				if (idx < 0 || idx >= sorted.length) return;
				await ctx.ui.select(`Session detail – ${sorted[idx].sessionId.slice(0, 12)}…`, sessionDetailLines(sorted[idx]));
			} catch (err) {
				await stopClient(); // fix #4
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.setStatus("copilot-usage", "🔴 Copilot: error");
				ctx.ui.notify(`Copilot error: ${msg}`, "error");
			}
		},
	});

	// ── /copilot-models – model billing table ─────────────────────────────────

	pi.registerCommand("copilot-models", {
		description: "Show Copilot model list with premium-interaction costs",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("copilot-usage", "🔄 Copilot: fetching models…");
			try {
				const { auth, models } = await fetchAllCached(); // fix #3
				const stats = computeStats([], undefined, undefined, auth, models);
				ctx.ui.setStatus("copilot-usage", `🟢 Copilot: ${(models ?? []).length} models`);
				await ctx.ui.select("Copilot Models & Billing", modelLines(stats));
			} catch (err) {
				await stopClient(); // fix #4
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.setStatus("copilot-usage", "🔴 Copilot: error");
				ctx.ui.notify(`Copilot error: ${msg}`, "error");
			}
		},
	});

	// ── copilot_usage tool – LLM-callable ─────────────────────────────────────

	pi.registerTool({
		name: "copilot_usage",
		label: "Copilot Usage",
		description:
			"Fetch GitHub Copilot Pro plan usage: premium-interaction quota remaining, " +
			"session counts by period, top repositories, model billing multipliers, and recent sessions.",
		promptSnippet: "Fetch GitHub Copilot Pro quota and session usage statistics",
		parameters: Type.Object({
			period: Type.Optional(StringEnum(["today", "week", "month", "all"] as const)),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Fetching Copilot usage data…" }], details: {} });

			const { sessions: rawSessions, userInfo, status, auth, models } = await fetchAllCached();

			// fix #1: filter by period BEFORE calling computeStats — single call instead of two
			const period = params.period ?? "all";
			const now = new Date();
			const cutoff =
				period === "today" ? startOfDay(now) :
				period === "week"  ? startOfWeek(now) :
				period === "month" ? startOfMonth(now) : null;
			const sessions = cutoff ? rawSessions.filter((s) => s.startTime >= cutoff) : rawSessions;
			const result = computeStats(sessions, userInfo, status, auth, models);

			const text = JSON.stringify(result, null, 2);
			return {
				content: [{ type: "text", text }],
				details: { stats: result },
			};
		},
	});
}
