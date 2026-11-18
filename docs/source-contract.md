# 多机构联合领取契约

POST /single-source 接受 collectionId、sourceId、version，按某一来源的明确版本领取原文并返回 scope=single-source-only。它保留 source-version 记录及原文，不推断跨来源兼容性。各机构的版本号仅能在其来源内解释，不是全局发布顺序。

POST /joint-acquisitions 接受 collectionId、entry（联合目录入口）与 requestBudget，按下列规则给出联合切面。

/catalog 给出 participants 的来源标识与目录地址；每份目录有 source、complete、versions，版本包含 href 和 requires。requires 的键是另一来源，值为允许的版本集合；没有列出的来源不附加限制。所有参与方都必须被选择，且每个选中版本的全部限制都成立，环状关系本身合法。versions 列表从旧到新，只表示本来源偏好，不授权跨来源排序。请求预算计数所有实际来源请求，包括元数据、正文与重验证；不得在预算外偷偷穷举。

每个目录返回 ETag，数据版本原文不可变，但目录声明的候选和资格可能变化。联合发表前，需要以条件请求或等价可核对证据确认本轮所用目录仍有效；任一条件失败则不能把旧候选发表为当前切面。保存先前单方原文不等于拥有新的联合声明。可以重新规划，但不能超过 requestBudget。

新增 POST /joint-acquisitions，字段 collectionId、entry（联合目录入口）、requestBudget；成功处理返回200或201，state 为 committed、unconfirmed 或 incompatible。committed 仅用于兼容且来源有效性完整的切面；incompatible 需要完整有效的候选目录排除所有组合；目录缺失、预算不足或有效性尚未确认只能 unconfirmed。返回值说明 selection、依据及未决原因，资料索引中每个 source-version 使用 source、version、payload 并附目录与原文出处，联合状态应与已发表资料一致。算法、搜索次序、内部状态结构与如何利用历史收件由实现选择；不强制特定候选作为演示结果。

实现说明：本服务按目录列出的新旧顺序反向尝试，优先较新的可兼容版本，但不会把版本号字符串或发布时间当作跨来源顺序；环状 requires 作为同时成立的约束求解，不因成环判为坏目录。目录 complete 仅在显式为 true 时视为完整；缺少 complete 或目录不可观察都归入 unconfirmed 的未决原因。领取到的正文若在目录中仍被列出但已不可取（例如退出保留期），会将其候选排除后在同一预算内重新规划；无法重新确认时报告未确认而不是断言不存在组合。发表前对联合目录和每个所用目录发条件请求（If-None-Match）；304 或相同 ETag 视为仍有效，不同 ETag 视为目录资格已变，本轮只报 unconfirmed。已到达但内容不合契约的目录同样计入未决，而不是静默忽略。

本地 complete 来源存在一套兼容版本；incompatible 来源完整声明只剩互不相容的候选；partial 来源有一方目录不可观察；racing 来源会撤回先前目录资格。测试核对约束是否成立，不按时间戳替来源决定兼容性。所有数据为本地合成资料，不调用实际机构。
