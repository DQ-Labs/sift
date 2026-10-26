import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Router } from '../lib/router.mjs';
import { publicFile } from '../lib/routes/static.mjs';
import { sampleQuery } from '../lib/routes/samples.mjs';
import { sourcePath } from '../lib/routes/scan.mjs';
import { makeRedactor } from '../lib/logs.mjs';

test('routes match methods and decoded single-segment parameters', () => {
  const router = new Router();
  const handler = name => () => name;
  router.post('/api/handoffs/cleanup', handler('cleanup'));
  router.get('/api/handoffs/:id', handler('read'));
  router.add(['GET', 'HEAD'], '/api/handoffs/:id/files/:name', handler('file'));
  router.get('/:file', handler('static'));
  assert.equal(router.match('POST', '/api/handoffs/cleanup').handler(), 'cleanup');
  assert.deepEqual(router.match('GET', '/api/handoffs/abc').params, { id: 'abc' });
  assert.deepEqual(router.match('HEAD', '/api/handoffs/abc/files/01%20Drums.wav').params, { id: 'abc', name: '01 Drums.wav' });
  assert.equal(router.match('GET', '/api/handoffs/abc/files/a/b'), null);
  assert.equal(router.match('GET', '/api/handoffs/%E0%A4%A'), null);
  assert.equal(router.match('PUT', '/api/handoffs/abc'), null);
  assert.equal(router.match('GET', '/app.js').params.file, 'app.js');
  assert.equal(router.match('GET', '/api/handoffs/'), null);
});

test('the static route serves plain public files and nothing else', () => {
  const directory = path.resolve('public');
  for (const name of ['index.html', 'app.js', 'catalog-client.js', 'styles.css', 'favicon.svg', 'player.min.js']) {
    assert.equal(publicFile(directory, name), path.join(directory, name), name);
  }
  for (const name of ['..', '../server.mjs', '..%2Fserver.mjs', '.env', '.hidden.js', 'server.mjs', 'library.json', 'a/b.js', 'a\\b.js', 'app.js.map', 'file..js', 'C:app.js', '']) {
    assert.equal(publicFile(directory, name), null, name);
  }
});

test('sample query strings are validated with the collection defaults', () => {
  const parse = query => sampleQuery(new URLSearchParams(query));
  assert.deepEqual(parse(''), { source: '', view: 'all', q: '', type: '', bpm: '', conflicts: false, sort: 'name', page: 0, pageSize: 50 });
  assert.deepEqual(parse('source=demo&view=gems&q=dust&type=Bass&bpm=slow&conflicts=1&sort=bpm&page=3&pageSize=500'), {
    source: 'demo', view: 'gems', q: 'dust', type: 'Bass', bpm: 'slow', conflicts: true, sort: 'bpm', page: 3, pageSize: 500
  });
  for (const invalid of ['view=discover', 'type=Piano', 'bpm=quick', 'sort=random', 'page=-1', 'page=1.5', 'pageSize=0', 'pageSize=501', 'conflicts=yes', `q=${'a'.repeat(501)}`]) {
    assert.throws(() => parse(invalid), { status: 400 }, invalid);
  }
});

test('a bare drive letter means the drive root on Windows', () => {
  assert.equal(sourcePath('D:', { platform: 'win32' }), 'D:\\');
  assert.equal(sourcePath('D:\\Samples', { platform: 'win32' }), 'D:\\Samples');
  assert.equal(sourcePath('D:', { platform: 'linux' }), 'D:');
});

test('diagnostic redaction removes full paths but keeps folder names', () => {
  const redact = makeRedactor({
    folders: [{ path: 'D:\\My Samples', name: 'My Samples' }, { path: 'E:\\', name: 'E:\\' }],
    dataDirectory: 'C:\\Users\\Jo\\AppData\\Roaming\\Sift',
    home: 'C:\\Users\\Jo'
  });
  const cases = [
    ['Audio processing failed: D:\\My Samples\\Secret Pack\\kick.wav: Invalid data', 'Audio processing failed: <folder:My Samples>: Invalid data'],
    ['d:\\my samples\\x.wav: bad', '<folder:My Samples>: bad'],
    ['E:\\Field\\rain.wav: gone', '<folder:E>: gone'],
    ['C:\\Users\\Jo\\AppData\\Roaming\\Sift\\stretch-cache\\a.wav', '<data>'],
    ['C:\\Users\\Jo\\Desktop\\loop.wav: x', '<home>: x'],
    ['F:\\Other Drive\\a b.wav: missing', '<path>: missing'],
    ['\\\\studio-nas\\share\\pack\\a.wav: denied', '<path>: denied'],
    ['/home/jo/Samples/kick.wav: denied', '<path>: denied'],
    ['GET http://127.0.0.1:4317/api/samples failed', 'GET http://127.0.0.1:4317/api/samples failed']
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected);
});
