import type { HelperError, HelperErrorCode } from "freedia/protocol";

export const INSTALL_COMMAND = "bunx freedia install";
export const LOGIN_COMMAND = "bunx freedia login";
export const DOCTOR_COMMAND = "bunx freedia doctor";

export interface ErrorView {
	title: string;
	fix: string;
	command: string | null;
	detail: string | null;
}

const HELPER_TITLES: Record<HelperErrorCode, string> = {
	pi_missing: "freeDia's helper can't find pi",
	not_signed_in: "Not signed in",
	spawn_failed: "freeDia couldn't start this chat",
};

const HELPER_COMMANDS: Record<HelperErrorCode, string> = {
	pi_missing: INSTALL_COMMAND,
	not_signed_in: LOGIN_COMMAND,
	spawn_failed: DOCTOR_COMMAND,
};

export function helperErrorView(error: HelperError): ErrorView {
	const quoted = /`([^`]+)`/.exec(error.fix)?.[1];
	return {
		title: HELPER_TITLES[error.code],
		fix: error.fix,
		command: quoted ?? HELPER_COMMANDS[error.code],
		detail: error.message || null,
	};
}

const SIGN_IN_FIX = `Run \`${LOGIN_COMMAND}\` in Terminal to sign in, then try again.`;

export function promptErrorView(message: string): ErrorView {
	const noKey = /^No API key found for (.+?)\.?(\n|$)/.exec(message);
	if (noKey) {
		const target = noKey[1] ?? "";
		return {
			title:
				target === "the selected model"
					? "No AI account is signed in"
					: `Not signed in to ${target}`,
			fix: SIGN_IN_FIX,
			command: LOGIN_COMMAND,
			detail: null,
		};
	}
	if (message.startsWith("Agent is already processing")) {
		return {
			title: "freeDia is still answering",
			fix: "Wait for the reply to finish, or stop it, then send again.",
			command: null,
			detail: null,
		};
	}
	return {
		title: "Your message wasn't sent",
		fix: "Try sending it again.",
		command: null,
		detail: message || null,
	};
}

const QUOTA_PATTERN =
	/insufficient_quota|quota exceeded|billing|usage limit|usage_limit/i;
const RATE_LIMIT_PATTERN =
	/^429\b|rate.?limit|too many requests|overloaded|\b529\b/i;
const AUTH_PATTERN =
	/^40[13]\b|authentication_error|permission_error|invalid x-api-key|invalid api key|unauthorized/i;

export function replyErrorView(
	errorMessage: string | null,
	provider: string | null,
): ErrorView {
	const message = errorMessage ?? "";
	const who = provider ?? "The provider";
	if (QUOTA_PATTERN.test(message)) {
		return {
			title: "You've reached your usage limit",
			fix: "Try again later, or pick another model below.",
			command: null,
			detail: message || null,
		};
	}
	if (RATE_LIMIT_PATTERN.test(message)) {
		return {
			title: `${who} is rate limiting requests`,
			fix: "Wait a minute and send your message again, or pick another model below.",
			command: null,
			detail: message || null,
		};
	}
	if (AUTH_PATTERN.test(message)) {
		return {
			title: `${who} rejected freeDia's sign-in`,
			fix: SIGN_IN_FIX,
			command: LOGIN_COMMAND,
			detail: message || null,
		};
	}
	return {
		title: "The reply failed",
		fix: "Send your message again, or pick another model below.",
		command: null,
		detail: message || null,
	};
}
