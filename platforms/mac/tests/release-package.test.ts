import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleOf, bundleProblem, pickAssets, type Release } from '../server/releaseUpdate';

test('the standalone bundle is found from the server root; a checkout has none', () => {
  assert.equal(bundleOf('/Applications/Vibrato.app/Contents/Resources/app'), '/Applications/Vibrato.app');
  assert.equal(bundleOf('/Users/me/Apps/Vibrato.app/Contents/Resources/app/dist/server'), '/Users/me/Apps/Vibrato.app');
  assert.equal(bundleOf('/Users/me/Desktop/Dev/vibrato'), null);
});

test('translocated or mounted copies cannot update themselves', () => {
  assert.equal(bundleProblem('/Applications/Vibrato.app'), null);
  assert.ok(bundleProblem('/private/var/folders/x/AppTranslocation/ABC/d/Vibrato.app'));
  assert.ok(bundleProblem('/Volumes/Vibrato 1.0.12/Vibrato.app'));
});

test('the zip for this architecture and the checksum list are picked from the release', () => {
  const asset = (name: string) => ({ name, browser_download_url: `https://example.test/${name}`, size: 1 });
  const release: Release = { tag_name: 'v1.0.12', assets: [asset('Vibrato-1.0.12-arm64.dmg'), asset('Vibrato-1.0.12-arm64-mac.zip'), asset('SHA256SUMS.txt')] };
  assert.equal(pickAssets(release, 'arm64').zip?.name, 'Vibrato-1.0.12-arm64-mac.zip');
  assert.equal(pickAssets(release, 'arm64').sums?.name, 'SHA256SUMS.txt');
  assert.equal(pickAssets(release, 'x64').zip, null);
});
