import test from 'node:test';
import assert from 'node:assert/strict';
import {calculate} from '../lib/engine.ts';
const bars=Array.from({length:350},(_,i)=>{const close=100+Math.sin(i*.7)*5+i*.05;return {date:new Date(Date.UTC(2025,0,1+i)).toISOString().slice(0,10),open:close,high:close+1,low:close-1,close,rawClose:close,volume:i%20===0?10000:1000,factor:1};});
test('下一次财报/清除登记不抹掉过去事件修正',()=>{const first={date:bars[310].date,knownAt:bars[305].date},second={date:bars[340].date,knownAt:bars[330].date};const original=calculate(bars,bars,first),multiple=calculate(bars,bars,[first,second]),cleared=calculate(bars,bars,[first,{date:null,knownAt:bars[330].date}]);for(let i=0;i<330;i++){assert.deepEqual(multiple[i],original[i]);assert.deepEqual(cleared[i],original[i]);}assert.equal(cleared[340].earnings,'财报日期未接入');});
test('尚未知晓的事件不提前应用',()=>{const baseline=calculate(bars,bars),events=calculate(bars,bars,[{date:bars[310].date,knownAt:bars[309].date}]);for(let i=0;i<309;i++)assert.deepEqual(events[i],baseline[i]);assert.match(events[309].earnings,/已/);});
