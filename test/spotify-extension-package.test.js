import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('bundled Chrome extension contains a complete MV3 runtime without private files', () => {
    const archive = fileURLToPath(new URL('../src/downloads/youplayer-spotify-bridge-chromium.zip', import.meta.url));
    const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n');
    const read = name => execFileSync('unzip', ['-p', archive, name], { encoding: 'utf8' });
    const manifest = JSON.parse(read('manifest.json'));
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.background, { service_worker: 'background.js', type: 'module' });
    assert.equal(manifest.browser_specific_settings, undefined);
    assert.equal(manifest.minimum_chrome_version, '111');
    assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
    assert.ok(!manifest.host_permissions.includes('https://*/*'));
    for (const name of entries) {
        assert.match(name, /^(?:[\w-]+\.(?:js|css|html|json)|icons\/youplayer(?:\.svg|-(?:48|128)\.png))$/);
        if (!name.endsWith('.js')) continue;
        for (const [, imported] of read(name).matchAll(/from\s+["']\.\/([^"']+)["']/g)) {
            assert.ok(entries.includes(imported), `${name} requires ${imported}`);
        }
    }
    for (const name of [manifest.background.service_worker, manifest.action.default_popup,
        ...manifest.content_scripts.flatMap(script => script.js), ...Object.values(manifest.icons)]) {
        assert.ok(entries.includes(name), `manifest requires ${name}`);
    }
    for (const name of Object.values(manifest.icons)) {
        assert.equal(execFileSync('unzip', ['-p', archive, name]).subarray(1, 4).toString(), 'PNG');
    }
});
