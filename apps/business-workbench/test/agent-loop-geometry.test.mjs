import assert from 'node:assert/strict';
import test from 'node:test';
import { agentLoopNodes as nodes, agentLoopRoutes as routes, agentLoopLabels as labels, agentLoopSize as size } from '../src/agent-loop-geometry.mjs';

const segments = route => route.points.slice(1).map((end, i) => [route.points[i], end]);
const between = (value, first, last) => value >= Math.min(first, last) && value <= Math.max(first, last);
function touches([a, b], [c, d]) {
  const verticalA = a[0] === b[0], verticalB = c[0] === d[0];
  if (verticalA === verticalB) return verticalA
    ? a[0] === c[0] && Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <= Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]))
    : a[1] === c[1] && Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <= Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0]));
  const [v, h] = verticalA ? [[a, b], [c, d]] : [[c, d], [a, b]];
  return between(v[0][0], h[0][0], h[1][0]) && between(h[0][1], v[0][1], v[1][1]);
}
const boxEdges = node => {
  const { x, y, width: w, height: h } = node;
  return [[[x, y], [x + w, y]], [[x + w, y], [x + w, y + h]], [[x + w, y + h], [x, y + h]], [[x, y + h], [x, y]]];
};

test('diagnostic routes preserve the model routing and bounded query topology', () => {
  assert.deepEqual(new Set(nodes.map(node => node.id)), new Set(['resolve','routing','simple','plan','query','review','decision','report','human']));
  assert.deepEqual(routes.map(route => `${route.from}>${route.to}`), ['resolve>routing','routing>plan','routing>simple','simple>query','plan>query','query>review','review>decision','decision>report','decision>query','decision>human','routing>human','human>routing']);
});

test('every connector stays on canvas and routes never cross or overlap', () => {
  for (const route of routes) for (const [a, b] of segments(route)) {
    assert.ok(a[0] === b[0] || a[1] === b[1], route.id);
    for (const point of [a, b]) assert.ok(point[0] >= 0 && point[0] <= size.width && point[1] >= 0 && point[1] <= size.height, route.id);
  }
  for (let i = 0; i < routes.length; i++) for (let j = i + 1; j < routes.length; j++) {
    for (const first of segments(routes[i])) for (const second of segments(routes[j])) assert.equal(touches(first, second), false, `${routes[i].id} intersects ${routes[j].id}`);
  }
});

test('routes avoid all non-endpoint node rectangles and branch captions', () => {
  for (const route of routes) for (const segment of segments(route)) {
    for (const node of nodes.filter(node => ![route.from, route.to].includes(node.id))) {
      assert.equal(boxEdges(node).some(edge => touches(segment, edge)), false, `${route.id} enters ${node.id}`);
    }
    for (const label of labels) {
      // Captions use separate lanes: require 12px clearance from every connector.
      for (const y of [label.y - 7, ...(label.secondLine ? [label.y + 19] : [])]) {
        const startX = label.anchor === 'middle' ? label.x - label.text.length * 8 : label.x;
        const endX = label.anchor === 'middle' ? label.x + label.text.length * 8 : label.x + Math.max(label.text.length, label.secondLine?.length || 0) * 16;
        const rect = { x: startX, y: y - 6, width: endX - startX, height: 12 };
        assert.equal(boxEdges(rect).some(edge => touches(segment, edge)), false, `${route.id} crosses label ${label.route}`);
      }
    }
  }
});
