# Admin 开发监听设计

## 目标

执行 `npm run admin` 后监听 TypeScript 源码，文件发生变化时自动重启 Admin 服务，不再要求手动停止并重新运行命令。

## 实现

- 开发命令使用 Node 原生 `--watch` 和项目已有的 `ts-node/register`，直接执行 `src/admin/server.ts`。
- 开发模式不预先构建 `dist`，确保每次重启执行的都是最新源码。
- 原构建后运行方式保留为 `npm run admin:prod`，用于检查生产构建或稳定运行。

## 验证

启动开发命令后修改受监听的 Admin 源文件，确认进程自动重启并重新监听 8080 端口；随后恢复文件时间并运行构建与类型检查。
