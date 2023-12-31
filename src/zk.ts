import { EncryptionAlgorithm, PrivateInput, Proof, PublicInput, ZKOperator } from "./types"
import { CONFIG } from "./config"
import { getCounterForChunk } from "./utils"

/**
 * Generate ZK proof for CHACHA20-CTR encryption.
 * Circuit proves that the ciphertext is a
 * valid encryption of the given plaintext.
 * The plaintext can be partially redacted.
 * 
 * @param privateInput private input to the circuit
 * will include the key, iv, and counter 
 * @param pub public input to the circuit,
 * will include the ciphertext and redacted plaintext
 * @param zkParams ZK params -- verification key and circuit wasm
 */
export async function generateProof(
	alg: EncryptionAlgorithm,
	{
		key,
		iv,
		offset,
	}: PrivateInput,
	{ ciphertext }: PublicInput,
	operator: ZKOperator
): Promise<Proof> {
	const {
		keySizeBytes,
		ivSizeBytes,
		bitsPerWord,
		chunkSize,
		isLittleEndian,
		uint8ArrayToBits,
		bitsToUint8Array
	} = CONFIG[alg]
	if(key.length !== keySizeBytes) {
		throw new Error(`key must be ${keySizeBytes} bytes`)
	}
	if(iv.length !== ivSizeBytes) {
		throw new Error(`iv must be ${ivSizeBytes} bytes`)
	}

	const startCounter = getCounterForChunk(alg, offset)
	const ciphertextArray = padCiphertextToChunkSize(
		alg,
		ciphertext,
	)
	const { proof, publicSignals } = await operator.groth16FullProve(
		{
			key: uint8ArrayToBits(key),
			nonce: uint8ArrayToBits(iv),
			counter: serialiseCounter(),
			in: uint8ArrayToBits(ciphertextArray),
		},
	)

	const totalBits = chunkSize * bitsPerWord

	return {
		algorithm: alg,
		proofJson: JSON.stringify(proof),
		plaintext: bitsToUint8Array(
			publicSignals
				.slice(0, totalBits)
				.map((x) => +x)
		)
	}

	function serialiseCounter() {
		const counterArr = new Uint8Array(4)
		const counterView = new DataView(counterArr.buffer)
		counterView.setUint32(0, startCounter, isLittleEndian)

		const counterBits = uint8ArrayToBits(counterArr)
			.flat()
		return counterBits
	}
}

/**
 * Verify a ZK proof for CHACHA20-CTR encryption.
 * 
 * @param proofs JSON proof generated by "generateProof"
 * @param publicInput 
 * @param zkey 
 */
export async function verifyProof(
	{ algorithm, proofJson, plaintext }: Proof,
	{ ciphertext }: PublicInput,
	operator: ZKOperator
): Promise<void> {
	const {
		uint8ArrayToBits,
	} = CONFIG[algorithm]
	const ciphertextArray = padCiphertextToChunkSize(
		algorithm,
		ciphertext
	)
	if(ciphertextArray.length !== plaintext.length) {
		throw new Error(`ciphertext and plaintext must be the same length`)
	}
	// serialise to array of numbers for the ZK circuit
	const pubInputs = [
		...uint8ArrayToBits(plaintext),
		...uint8ArrayToBits(ciphertextArray),
	].flat()
	const verified = await operator.groth16Verify(
		pubInputs,
		JSON.parse(proofJson),
	)

	if(!verified) {
		throw new Error('invalid proof')
	}
}

function padCiphertextToChunkSize(
	alg: EncryptionAlgorithm,
	ciphertext: Uint8Array
) {
	const {
		chunkSize,
		bitsPerWord,
	} = CONFIG[alg]

	const expectedSizeBytes = (chunkSize * bitsPerWord) / 8
	if(ciphertext.length > expectedSizeBytes) {
		throw new Error(`ciphertext must be <= ${expectedSizeBytes}b`)
	}

	if(ciphertext.length < expectedSizeBytes) {
		const arr = new Uint8Array(expectedSizeBytes).fill(0)
		arr.set(ciphertext)

		ciphertext = arr
	}

	return ciphertext
}