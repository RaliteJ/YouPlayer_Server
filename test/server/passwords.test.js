import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../src/server/passwords.js';

test('hashPassword rejects missing or short passwords', async () => {
	await assert.rejects(() => hashPassword('short'), /au moins 8 caracteres/);
	await assert.rejects(() => hashPassword(null), /au moins 8 caracteres/);
});

test('hashPassword stores scrypt parameters and uses a fresh salt', async () => {
	const first = await hashPassword('password123');
	const second = await hashPassword('password123');

	assert.notEqual(first, second);
	assert.match(first, /^scrypt\$16384\$8\$1\$/);
	assert.equal(first.split('$').length, 6);
});

test('verifyPassword accepts only the matching password and valid hash shape', async () => {
	const passwordHash = await hashPassword('password123');

	assert.equal(await verifyPassword('password123', passwordHash), true);
	assert.equal(await verifyPassword('wrongpass', passwordHash), false);
	assert.equal(await verifyPassword('password123', 'not-a-hash'), false);
	assert.equal(await verifyPassword(null, passwordHash), false);
	assert.equal(await verifyPassword('password123', null), false);
});
