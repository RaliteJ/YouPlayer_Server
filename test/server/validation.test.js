import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
	requireYoutubeApiKey,
	resolveStoredFile,
	sanitizeTrackInput,
	validateLocalArtwork,
	validateLocalUploadMetadata,
	validateAdminPasswordResetPayload,
	validateCreateUserPayload,
	validatePlaylistMutationPayload,
	validatePlaybackCollection
} from '../../src/server/validation.js';

test('local upload metadata keeps a chosen title, artist and validated image', () => {
	const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
	const cover = `data:image/png;base64,${bytes.toString('base64')}`;
	assert.deepEqual(validateLocalUploadMetadata({ title: '  Mon titre  ', artist: '  Artiste  ', albumCoverURL: cover }, 'original.mp3'), {
		title: 'Mon titre', artist: 'Artiste', albumCoverURL: cover
	});
	assert.equal(sanitizeTrackInput({ type: 'local', url: 'audio.mp3', title: 'Mon titre', albumCoverURL: cover }).albumCoverURL, cover);
	assert.equal(validateLocalUploadMetadata({}, 'original.mp3').title, 'original');
	assert.throws(() => validateLocalArtwork('data:image/svg+xml;base64,PHN2Zz4='), /Image invalide/);
	assert.throws(() => validateLocalArtwork('data:image/png;base64,AAAA'), /Image invalide/);
	assert.throws(() => validateLocalArtwork(`data:image/png;base64,${Buffer.alloc(129 * 1024).toString('base64')}`), /trop volumineuse/);
	assert.throws(() => validateLocalUploadMetadata({ title: ' ' }, 'original.mp3'), /Titre invalide/);
});

test('validateCreateUserPayload normalizes pseudo and role', () => {
	assert.deepEqual(validateCreateUserPayload({
		pseudo: ' Admin ',
		password: 'password123',
		role: 'admin',
		displayName: 'Admin User'
	}), {
		pseudo: 'admin',
		password: 'password123',
		role: 'admin',
		displayName: 'Admin User'
	});

	assert.throws(() => validateCreateUserPayload({
		pseudo: '',
		password: 'password123'
	}), /Pseudo requis/);
});

test('password reset validation requires strong enough password fields', () => {
	assert.deepEqual(validateAdminPasswordResetPayload({ newPassword: 'newpass123' }), {
		newPassword: 'newpass123'
	});
	assert.throws(() => validateAdminPasswordResetPayload({ newPassword: 'short' }), /8 caracteres/);
});

test('sanitizeTrackInput accepts safe local filenames only', () => {
	assert.deepEqual(sanitizeTrackInput({
		type: 'local',
		title: 'Local Track',
		url: 'abc123.mp3'
	}), {
		type: 'local',
		title: 'Local Track',
		artist: '',
		album: '',
		albumCoverURL: '',
		trackNumber: 0,
		url: 'abc123.mp3'
	});

	assert.throws(() => sanitizeTrackInput({
		type: 'local',
		title: 'Bad Local',
		url: '../secret.mp3'
	}), /fichier local invalide/);
});

test('sanitizeTrackInput canonicalizes YouTube links and rejects invalid links', () => {
	assert.deepEqual(sanitizeTrackInput({
		type: 'youtube',
		title: 'Video',
		url: 'https://youtu.be/abc123XYZ00?t=1'
	}), {
		type: 'youtube',
		title: 'Video',
		artist: '',
		album: '',
		albumCoverURL: '',
		trackNumber: 0,
		id: 'abc123XYZ00',
		url: 'https://www.youtube.com/watch?v=abc123XYZ00',
		thumbnail: ''
	});

	assert.throws(() => sanitizeTrackInput({
		type: 'youtube',
		title: 'Nope',
		url: 'https://example.com/video'
	}), /YouTube invalide/);
});

test('playback collections validate every public track and reject local or oversized input', () => {
	const song = { type: 'spotify', title: 'Track', url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', __queueId: 'untrusted' };
	assert.equal(validatePlaybackCollection([song], 0)[0].__queueId, undefined);
	for (const [items, index] of [[[], 0], [[song], -1], [[song], 1], [[song], '0'], [Array(5001).fill(song), 0]]) {
		assert.throws(() => validatePlaybackCollection(items, index), /Collection/);
	}
	assert.throws(() => validatePlaybackCollection([song, { type: 'local', url: 'private.mp3' }], 0), /local direct/);
});

test('validatePlaylistMutationPayload validates playlist and song together', () => {
	assert.deepEqual(validatePlaylistMutationPayload({
		arg: {
			playlist: 'mix',
			song: {
				type: 'spotify',
				title: 'Track',
				url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'
			}
		}
	}).playlist, 'mix.json');

	assert.throws(() => validatePlaylistMutationPayload({
		arg: {
			playlist: '../mix.json',
			song: {
				type: 'local',
				url: 'abc123.mp3'
			}
		}
	}), /playlist invalide/);
});

test('resolveStoredFile keeps local files under the configured directory', () => {
	const root = '/tmp/youplayer-local';
	assert.equal(resolveStoredFile(root, 'abc123.mp3'), path.join(root, 'abc123.mp3'));
	assert.throws(() => resolveStoredFile(root, '../outside.mp3'), /fichier local invalide/);
});

test('requireYoutubeApiKey reports a service configuration error', () => {
	assert.equal(requireYoutubeApiKey('abc'), 'abc');
	assert.throws(() => requireYoutubeApiKey(''), (err) => {
		assert.equal(err.statusCode, 503);
		return /YouTube/.test(err.message);
	});
});
