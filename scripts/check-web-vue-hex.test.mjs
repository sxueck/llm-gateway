import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findVueHex } from './check-web-vue-hex.mjs';

test('warns on Vue hex colors but not named slots', () => {
  assert.deepEqual(findVueHex('<template #add>\n<div style="color: #fff; background: #aabbcc" />\n</template>', 'views/Test.vue'), [
    { line: 2, value: '#fff' },
    { line: 2, value: '#aabbcc' },
  ]);
});

test('exempts only the Dashboard chart palette block', () => {
  const source = "const COLOR_PALETTE = [\n  '#006241',\n]\nconst other = '#abcdef'";
  assert.deepEqual(findVueHex(source, 'views/DashboardView.vue'), [{ line: 4, value: '#abcdef' }]);
  assert.equal(findVueHex(source, 'views/Other.vue').length, 2);
});
