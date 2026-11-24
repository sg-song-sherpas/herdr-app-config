import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { host } from 'herdr';
import { makeCx } from '../fakes/cx.mjs';
import { all } from '../fakes/element.mjs';
import Sketch from '../../mods/Sketch/main.js';

beforeEach(() => { host.reset(); localStorage.clear(); });

async function mount(shapes) {
  host.files.set('/app/data/sketch/board.json', JSON.stringify({ version: 1, shapes }));
  const cx = makeCx();
  const view = new Sketch();
  view.init({}, cx);
  await cx.settle();
  await cx.flush();
  return view;
}

for (const type of ['arrow', 'line']) {
  for (const fontSize of [undefined, 22]) {
    test(`${type} labels use the same font size as ordinary text, including board zoom (${fontSize ?? 'default'})`, async () => {
      const style = fontSize == null ? {} : { fontSize };
      const view = await mount([
        { id: 'ordinary', type: 'text', x: 0, y: 0, text: '일반 설명', ...style },
        { id: 'connection', type, points: [[0, 100], [300, 100]], text: '연결 설명', ...style },
      ]);
      for (const zoom of [1, 1.6]) {
        view.zoom = zoom;
        const tree = view.render();
        const ordinary = all(tree, e => e.kids.includes('일반 설명'))[0];
        const connection = all(tree, e => e.kids.includes('연결 설명'))[0];
        assert.ok(ordinary && connection, 'both labels are rendered');
        assert.equal(connection.props.text_size, ordinary.props.text_size);
      }
    });
  }
}
