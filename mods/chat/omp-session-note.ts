// omp's counterpart of the SessionStart hook Claude Code and Codex run (session-note.sh): an omp
// extension the installer puts in ~/.omp/agent/extensions (bin/shepherdr add_omp_note), with this
// folder's session-note.sh named in NOTE. Inside Herdr only ($HC_TERMINAL_ID): the first time the
// agent starts a turn it runs session-note.sh once and adds what it says (how the chat's reactions
// travel, an Assistant's settings, the space's Reactions) to the system prompt, the same words every
// turn so the prompt cache holds. Outside Herdr, or when the script says nothing, it adds nothing.
import { spawnSync } from "node:child_process";

const NOTE = "{app}/mods/chat/session-note.sh";

let note: string | null | undefined;

function read(): string | null {
	if (!process.env.HC_TERMINAL_ID) return null;
	const r = spawnSync("sh", [NOTE], { encoding: "utf8", timeout: 10000 });
	if (r.status !== 0 || !r.stdout) return null;
	try {
		const words = JSON.parse(r.stdout)?.hookSpecificOutput?.additionalContext;
		return typeof words === "string" && words.trim() ? words.trim() : null;
	} catch {
		return null;
	}
}

export default function (pi: any) {
	pi.on("before_agent_start", async (event: any) => {
		try {
			if (note === undefined) note = read();
			if (!note) return undefined;
			const base = event?.systemPrompt;
			const blocks = typeof base === "string" ? [base] : Array.isArray(base) && base.every((b: unknown) => typeof b === "string") ? base : null;
			if (!blocks) return undefined;
			return { systemPrompt: [...blocks, `<herdr-session-note>\n${note}\n</herdr-session-note>`] };
		} catch {
			return undefined;
		}
	});
}
