# 跨机构资料领取的兼容版本切面与完整性声明

这是面向资料接收人员的 Node.js 收件服务。支持原始资料领取、内容校验、人工摘要登记和按出处回查，也支持按来源声明的兼容关系联合领取一套可共同交付的版本切面。不会自动把来源正文转成领域记录；人工收件仍然可用。

## 本地运行

运行环境为 Node.js 22（最低 22.22.1），使用运行时内置模块，没有第三方运行依赖。package.json 与 package-lock.json 声明相同的兼容范围；平台 Linux 基线使用 Node.js 22.23.4，独立 Dockerfile 仍固定 22.22.1 镜像摘要。启动与测试不执行依赖下载。执行以下命令启动真实收件与来源服务：

```sh
npm start
```

默认收件地址为本机 4310 端口，授权资料源为本机 4311 端口。PORT、SOURCE_PORT、ARCHIVE_DIR 可分别调整端口和资料目录；.local 为本地持久化内容，不纳入版本。停止进程后重新启动会继续读取原有收件。

## 检查与使用

```sh
npm run build
npm test
npm run demo
```

build 对所有源码做语法检查，test 检查收件能力、来源服务与联合领取。demo 从临时空目录启动两个真实 HTTP 服务，先做一次原始领取，再对同一来源做一次联合领取，输出收件、资料索引与联合状态，然后关闭并清理临时状态；不重播预先保存的日志。它没有固定等待，不超过来源请求本身的超时。

```sh
npm run acceptance:structured
npm run acceptance:partial
```

这两项检查分别读取完整与不完整来源样本，核对 docs/source-contract.md 中的联合记录与出处关系。structured 要求完整目录下给出 committed 切面且约束成立、请求不超预算；partial 要求缺件只报 unconfirmed、完整目录互斥时才是 incompatible、目录资格变化后不发表旧切面。完整支持范围及接口见 docs/service-api.md 和 docs/source-contract.md。

## 可复现环境

```sh
docker build --network=none -t local-receiver .
docker run --rm --network=none local-receiver npm test
docker run --rm --network=none local-receiver npm run demo
```

Dockerfile 固定 Linux Node 镜像摘要，容器仅需内部回环网络。镜像构建不安装额外依赖，也不读取真实账户、用户数据或公共网站；首次拉取基础镜像属于环境准备，不属于正式运行。脚本输出规模受小型本地资料控制，正常完整运行可以在九十秒内观察。

/single-source 按明确版本领取单方原文并标注 source-version，不推断跨来源兼容性；/joint-acquisitions 按各来源声明的 requires 关系选出一套同时成立的版本，并在发表前以条件请求确认目录仍有效。只有兼容关系成立且本轮来源有效性都能核对时才标为 committed；目录缺件、预算不足或有效性未确认都是 unconfirmed，只有完整目录排除全部组合才是 incompatible。
