import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditDependencies } from '../../scripts/dependency-audit.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-audit-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ['src', 'scripts', 'test']) await fs.mkdir(path.join(root, dir));
  await fs.writeFile(path.join(root, 'src/package.json'), '{"scripts":{"test":"node --test"}}');
  await fs.writeFile(path.join(root, 'src/package-lock.json'), 'original');
  return root;
}
const audit = critical => ({ code: critical ? 1 : 0, stdout: JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical } } }) });

test('audit-only reports vulnerabilities without changing dependency files', async t => {
  const root = await fixture(t);
  const report = await auditDependencies({ root, runNpm: async args => { assert.equal(args[0], 'audit'); return audit(1); } });
  assert.equal(report.status, 'vulnerable');
  assert.equal(await fs.readFile(path.join(root, 'src/package-lock.json'), 'utf8'), 'original');
});

for (const failed of [false, true]) test(`candidate ${failed ? 'failed tests preserve originals' : 'passes tests before lock replacement'}`, async t => {
  const root = await fixture(t);
  let checks = 0, tested = false;
  const runNpm = async (args, cwd) => {
    if (args[0] === 'audit' && args[1] === 'fix') {
      assert.ok(args.includes('--ignore-scripts'));
      assert.ok(!args.includes('--force'));
      await fs.writeFile(path.join(cwd, 'package-lock.json'), 'corrected');
      return { code: 0 };
    }
    if (args[0] === 'audit') return audit(checks++ === 0 ? 1 : 0);
    if (args[0] === 'run') {
      assert.deepEqual(args, ['run', 'test:security', '--ignore-scripts']);
      tested = true;
      assert.equal(await fs.readFile(path.join(root, 'src/package-lock.json'), 'utf8'), 'original');
      return { code: failed ? 1 : 0, stdout: 'synthetic-private-validation-output' };
    }
    assert.equal(args[0], 'ci');
    return { code: 0 };
  };
  if (failed) await assert.rejects(auditDependencies({ root, fix: true, runNpm }), /Tests candidats/);
  else assert.equal((await auditDependencies({ root, fix: true, runNpm })).status, 'updated-rebuild-required');
  assert.ok(tested);
  assert.equal(await fs.readFile(path.join(root, 'src/package-lock.json'), 'utf8'), failed ? 'original' : 'corrected');
  if (failed) {
    const diagnostic = JSON.parse(await fs.readFile(path.join(root, '.updates/dependency-audit/failure.json'), 'utf8'));
    assert.equal(diagnostic.code, 'tests-failed');
    assert.equal(diagnostic.stage, 'validation');
    assert.equal(JSON.stringify(diagnostic).includes('synthetic-private'), false);
    const log = path.join(root, '.updates/dependency-audit/last-command.log');
    assert.match(await fs.readFile(log, 'utf8'), /synthetic-private-validation-output/);
    assert.equal((await fs.stat(log)).mode & 0o777, 0o600);
  }
  if (!failed) assert.equal(await fs.readFile(path.join(root, '.updates/dependency-audit/previous-package-lock.json'), 'utf8'), 'original');
  if (!failed) {
    const later = await auditDependencies({ root, runNpm: async () => audit(0) });
    assert.equal(later.pendingLockHash, later.auditedLockHash, 'a subsequent audit retains the pending rebuild');
  }
});

test('registry error is not treated as a clean audit and releases its lock', async t => {
  const root = await fixture(t);
  await assert.rejects(auditDependencies({ root, runNpm: async () => ({ code: 1, stdout: '{"error":{"code":"ENETUNREACH"}}' }) }), /Audit indisponible/);
  await assert.rejects(fs.stat(path.join(root, '.updates/dependency-audit/running')), { code: 'ENOENT' });
});

test('concurrent audit is refused', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, '.updates/dependency-audit/running'), { recursive: true });
  await assert.rejects(auditDependencies({ root }), /deja actif/);
});

test('unresolved advisories do not trigger installation or replace the lock', async t => {
  const root = await fixture(t);
  const runNpm = async args => {
    assert.equal(args[0], 'audit');
    return args[1] === 'fix' ? { code: 1 } : audit(1);
  };
  assert.equal((await auditDependencies({ root, fix: true, runNpm })).status, 'manual-review');
  assert.equal(await fs.readFile(path.join(root, 'src/package-lock.json'), 'utf8'), 'original');
});

test('a concurrent manual dependency change is preserved', async t => {
  const root = await fixture(t);
  let checks = 0;
  const runNpm = async (args, cwd) => {
    if (args[0] === 'audit' && args[1] === 'fix') {
      await fs.writeFile(path.join(cwd, 'package-lock.json'), 'corrected');
      return { code: 0 };
    }
    if (args[0] === 'audit') return audit(checks++ === 0 ? 1 : 0);
    if (args[0] === 'run') await fs.writeFile(path.join(root, 'src/package-lock.json'), 'manual-change');
    return { code: 0 };
  };
  await assert.rejects(auditDependencies({ root, fix: true, runNpm }), /modifiees pendant/);
  assert.equal(await fs.readFile(path.join(root, 'src/package-lock.json'), 'utf8'), 'manual-change');
});
