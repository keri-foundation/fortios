// ── proof.ts ──────────────────────────────────────────────────────────────────
//
// Boot-time crypto proof: exercises blake3 hash, Ed25519 sign/verify, and
// Locksmith password stretching via the Pyodide Web Worker.

import { LOCKSMITH_PROOF_PASSWORD, PROOF_CHALLENGE } from '../shared/constants';
import { generateId, sendToWorker } from '../runtime/keri_runtime';

export async function runProof(log: (line: string) => void): Promise<void> {
    const probe = PROOF_CHALLENGE;

    const hashId = generateId();
    const hashRes = await sendToWorker({ id: hashId, type: 'blake3_hash', data: probe });
    log(`blake3: ${hashRes.type === 'blake3_result' ? hashRes.hex : `(error: ${hashRes.type === 'error' ? hashRes.error : hashRes.type})`}`);

    const signId = generateId();
    const signRes = await sendToWorker({ id: signId, type: 'sign', message: probe });
    if (signRes.type !== 'sign_result') { log(`sign failed: ${signRes.type === 'error' ? signRes.error : signRes.type}`); return; }
    const { signature, publicKey } = signRes;
    log(`signed ok, pk: ${publicKey.slice(0, 16)}…`);

    const verifyId = generateId();
    const verifyRes = await sendToWorker({ id: verifyId, type: 'verify', message: probe, signature, publicKey });
    log(`pychloride sign+verify: ${verifyRes.type === 'verify_result' ? verifyRes.valid : false}`);

    const locksmithId = generateId();
    const locksmithRes = await sendToWorker({
        id: locksmithId,
        type: 'locksmith_stretch_password',
        password: LOCKSMITH_PROOF_PASSWORD,
    });
    log(
        `locksmith stretch: ${
            locksmithRes.type === 'locksmith_stretch_password_result'
                ? locksmithRes.passcode
                : `(error: ${locksmithRes.type === 'error' ? locksmithRes.error : locksmithRes.type})`
        }`,
    );
}
