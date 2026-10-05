import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "crypto";
import { promisify } from "util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = {
	N: 16384,
	r: 8,
	p: 1,
	maxmem: 64 * 1024 * 1024
};

export async function hashPassword(password) {
	if (typeof password !== "string" || password.length < 8) {
		throw new Error("Le mot de passe doit contenir au moins 8 caracteres");
	}

	const salt = randomBytes(16);
	const derivedKey = await scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
	return [
		"scrypt",
		SCRYPT_OPTIONS.N,
		SCRYPT_OPTIONS.r,
		SCRYPT_OPTIONS.p,
		salt.toString("base64"),
		Buffer.from(derivedKey).toString("base64")
	].join("$");
}

export async function verifyPassword(password, passwordHash) {
	if (typeof password !== "string" || typeof passwordHash !== "string") {
		return false;
	}

	const [algorithm, n, r, p, saltBase64, hashBase64] = passwordHash.split("$");
	if (algorithm !== "scrypt" || !saltBase64 || !hashBase64) {
		return false;
	}

	const salt = Buffer.from(saltBase64, "base64");
	const expected = Buffer.from(hashBase64, "base64");
	const actual = await scrypt(password, salt, expected.length, {
		N: Number(n),
		r: Number(r),
		p: Number(p),
		maxmem: SCRYPT_OPTIONS.maxmem
	});

	return expected.length === actual.length && timingSafeEqual(expected, actual);
}
