# 展示层回归检查

使用 Node.js 自带的 `node:test`，无需新增依赖。要求与项目相同的 Node 22.13+。

```sh
node --experimental-strip-types --test tests/presentation.test.mjs
npx tsc --noEmit --incremental false
```

覆盖缺失上一日、零值、变化方向、未知变化排序。UI 使用已登录的本地浏览器检查 375 / 768 / 1440 宽度、总览筛选搜索、详情历史窗口、弹窗打开与取消。

算法的课堂复算与边界探针保留在工作区 `fear-desk-qa/20260930`；本次设计重构未改计算引擎。
