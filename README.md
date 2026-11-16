# 跨机构资料领取的兼容版本切面与完整性声明

这是面向资料接收人员的 Node.js 收件服务。当前版本支持原始资料领取、内容校验、人工摘要登记、按出处回查、按明确版本的单方领取，以及按来源声明的兼容关系进行联合领取。联合领取只按契约中的限制选择版本，不推断领域语义，也不把来源正文自动转成领域记录。

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

build 对所有源码做语法检查，test 检查单方与联合领取、来源服务与目录变化。demo 从临时空目录启动两个真实 HTTP 服务，领取实际来源，输出收件与资料索引，然后关闭并清理临时状态；不重播预先保存的日志。它没有固定等待，不超过来源请求本身的超时。

```sh
npm run acceptance:structured
npm run acceptance:partial
```

这两项检查分别读取完整与不完整来源样本，核对 docs/source-contract.md 中的联合选择、出处关系与三种状态。它们通过时说明联合领取满足契约；完整支持范围及接口见 docs/service-api.md 和 docs/source-contract.md。

## 可复现环境

```sh
docker build --network=none -t local-receiver .
docker run --rm --network=none local-receiver npm test
docker run --rm --network=none local-receiver npm run demo
```

Dockerfile 固定 Linux Node 镜像摘要，容器仅需内部回环网络。镜像构建不安装额外依赖，也不读取真实账户、用户数据或公共网站；首次拉取基础镜像属于环境准备，不属于正式运行。脚本输出规模受小型本地资料控制，正常完整运行可以在九十秒内观察。

当前支持按明确版本的 /single-source 领取，以及 /joint-acquisitions 联合选择与完整性声明；来源契约与检查区分兼容、已证无解、未观察完整和目录有效性变化。
