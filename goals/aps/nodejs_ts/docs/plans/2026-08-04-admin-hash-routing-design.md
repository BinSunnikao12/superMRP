# Admin 独立 Hash 路由设计

## 目标

让每个 Admin 页签都有稳定地址，刷新、收藏以及浏览器前进后退后仍停留在原页签。

## 路由

- `#/mrp/workbench`：MRP 工作台
- `#/sync/monitor`：同步监控
- `#/data/overview`：数据总览
- `#/pull/logs`：运行日志
- `#/data/dictionary`：数据字典
- 旧地址 `#/pages/patient/index` 继续映射到 MRP 工作台。

## 实现

页面维护页签到 hash 的唯一映射。点击页签只修改 hash，统一由路由激活函数切换页签、面板并加载对应数据；`hashchange` 负责浏览器前进后退。空地址和未知地址使用 `history.replaceState` 规范化为工作台地址。

## 验证

分别直接打开五个地址检查激活页签，验证旧地址兼容，并验证点击运行日志后浏览器返回能够恢复工作台。
