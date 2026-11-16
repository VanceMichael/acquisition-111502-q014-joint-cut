# 收件服务接口

人工资料接收保持兼容。POST /intakes 的 JSON 字段为 collectionId、sourceKey、revision、mediaType、contentBase64；返回 receiptId、sha256、byteLength 和轻量 summary。相同资料集、来源键与修订对应同一收件，字节不同返回 409。GET /receipts/{receiptId} 可读元数据，GET /receipts/{receiptId}/body 返回原字节。

POST /acquisitions 接受 collectionId、entry 和可选 options，entry 是授权来源完整地址。当前只领取入口的原始内容并登记收件，返回 collectionId 和 receiptIds。自动解释沿用此入口，所有自动取得的依赖也应保留真实原文收件，不用人工造 records 代替自动接入。来源访问只限启动时冻结的 origin，不能访问其他主机或执行交付件。

GET /collections 返回资料集列表，GET /collections/{collectionId} 返回 collectionId、receiptIds、records、issues。结构化 records 的每项包含 kind、key、value、provenance；key 由各来源身份语义决定，不要求特定内部编码。provenance 是含 receiptId 与 location 的数组，location 可采用字节区间、原行列、JSON Pointer 等可复查定位。issues 每项包含 reason、location，至少能说明原因、受影响范围和已有来源依据，不能用静默丢弃表示未知。缺失资料不等于来源明确删除。

POST /collections/{collectionId}/records 可录入人工确认记录，必须附本资料集的真实收件出处。自动接入不能依赖操作者事先写入答案。该接口目前采用同键不可变约定；新增版本、历史记录与当前视图如何协调，应与来源语义相符，不能覆盖已归档原文。来源契约中的值是查询视图契约，不限定解析器、状态机或索引的内部实现。

本地 provider 是独立 HTTP 来源，fixtures 为合成的公开样本，不包含真实个人或机构凭据。fixtures/descriptor.json 说明来源入口与接入选项。多数资料源用 /deliveries 声明 deliveryId、revision、roots 和 resources；roots 是需处理的独立入口，resources 是同包可领取资源，不是公网搜索指令。文件可用 GET、HEAD 与单段 Range 读取；ETag 表示返回字节的身份。SOURCE_STAGE=partial 启动不完整交付状态，完整状态是默认值。来源服务不接受写操作。

## 联合领取

POST /joint-acquisitions 的字段为 collectionId、entry（联合目录入口）和 requestBudget。requestBudget 计数本轮所有实际来源请求：联合目录、各参与方目录、正文，以及发表前的复验请求；不会在预算之外另行穷举。成功处理返回 200 或 201，state 为：

- committed：所选每个版本的全部 requires 限制都成立，且本轮使用的联合目录与各方目录都已复验有效。仅此状态写入 source-version 记录。
- incompatible：参与方目录都完整声明候选（complete 为 true），本轮目录复验有效，且按声明的兼容关系确实不存在任何组合。
- unconfirmed：目录缺失或不可解析、候选列表不完整、正文未能取得、请求预算用尽、或目录有效性尚未确认。unconfirmed 只说明还有未观察或未确认的部分，不能读作组合不存在。

返回值包含 selection（compatible 以外通常为 null；规划过程中曾定位到的候选会附在 selection 或 pending 中）、basis、pending、unconfirmedSources、requestsUsed 和 requestBudget。basis 说明本轮联合目录与各来源目录的地址、ETag 依据及复验结论（validity 为 confirmed 或 unconfirmed），并给出这些目录原文的 receiptId。pending 每项含 reason、location 与说明，指出仍未确认的范围；时间上先跳过的新版正文列在 skippedVersions 中。

选择规则：每份来源目录的 versions 顺序表示该来源自己的偏好（旧到新），实现优先采用各来源都较新的可行组合；参与者顺序只作为确定性的搜索次序，不按版本号大小或发布时间跨来源对齐。requires 构成的关系图允许出现环，环状约束本身不视为坏目录。若某候选正文在本轮已退出保留期（例如 404/410），会把它排除后重新搜索，并记录被跳过的版本；不会因此断言整体无解。

发表时会为联合目录、各来源目录与每份正文各自登记真实原文收件。资料索引中每个 source-version 记录的 value 含 source、version、payload，provenance 同时指向该版本所在目录的条目位置与正文原文；collection.joint 保存已发表切面的 state、selection、basis、skippedVersions 与发表请求计数。联合发表后，资料索引中的 source-version 视图即本次切面；早先单方领取或上一次联合发表留下的同类记录被这个视图替换，但它们的原文收件仍可按 receiptId 回查，其他人工记录不受影响。复验失败或预算耗尽的那次尝试只记在 collection.jointAttempt，并把未决原因写入 collection.issues；它不会把旧候选当作当前切面发表，也不会覆盖已发表且与记录一致的 joint 状态。

联合目录中的参与者、目录地址与版本地址都必须落在启动时冻结的授权 origin 内；越界地址返回 400，不发送请求。缺少 collectionId、entry 或非整数 requestBudget 时返回 400。
