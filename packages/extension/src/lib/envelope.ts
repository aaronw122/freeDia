import type { Envelope, ForwardedRpc } from "freedia/protocol";

export function toEnvelope(
	chatId: string,
	rpc: ForwardedRpc,
): Envelope<ForwardedRpc> {
	return { chatId, rpc };
}
