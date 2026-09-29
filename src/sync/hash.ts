import { sha256 } from '@noble/hashes/sha2.js';
import { toHex } from '../ssh/buffer';

/** SHA-256 hex digest; native WebCrypto when available, pure JS otherwise. */
export async function hashHex(data: Uint8Array): Promise<string> {
	const subtle = typeof crypto === 'undefined' ? undefined : crypto.subtle;
	if (subtle) {
		try {
			return toHex(new Uint8Array(await subtle.digest('SHA-256', data as BufferSource)));
		} catch {
			/* fall through */
		}
	}
	return toHex(sha256(data));
}
