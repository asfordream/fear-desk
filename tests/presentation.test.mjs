import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreChange, changeTone, compareScoreChanges} from '../lib/presentation.ts';

test('a score without a valid previous score has unknown change', () => {
  assert.equal(scoreChange({score: 81}, null), null);
  assert.equal(scoreChange({score: 81}, {score: null}), null);
  assert.equal(scoreChange({score: null}, {score: 50}), null);
});
test('zero is a valid score and zero change stays neutral', () => {
  assert.equal(scoreChange({score: 0}, {score: 0}), 0);
  assert.equal(scoreChange({score: 81}, {score: 0}), 81);
  assert.equal(changeTone(0), 'flat');
  assert.equal(changeTone(null), 'flat');
});
test('positive and negative changes have distinct directions', () => {
  assert.equal(changeTone(18), 'up');
  assert.equal(changeTone(-4), 'down');
});
test('unknown changes sort after known negative changes', () => {
  const rows = [
    {symbol:'NEW', latest:{score:90}, previous:null},
    {symbol:'DOWN', latest:{score:40}, previous:{score:45}},
    {symbol:'UP', latest:{score:60}, previous:{score:42}},
    {symbol:'FLAT', latest:{score:50}, previous:{score:50}},
  ];
  assert.deepEqual(rows.sort(compareScoreChanges).map(x=>x.symbol), ['UP','FLAT','DOWN','NEW']);
});
