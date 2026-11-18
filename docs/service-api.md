# 收件服务接口

人工资料接收保持兼容。POST /intakes 的 JSON 字段为 collectionId、sourceKey、revision、mediaType、contentBase64；返回 receiptId、sha256、byteLength 和轻量 summary。相同资料集、来源键与修订对应同一收件，字节不同返回 409。GET /receipts/{receiptId} 可读元数据，GET /receipts/{receiptId}/body 返回原字节。

POST /acquisitions 接受 collectionId、entry 和可选 options，entry 是授权来源完整地址。当前只领取入口的原始内容并登记收件，返回 collectionId 和 receiptIds。自动解释沿用此入口，所有自动取得的依赖也应保留真实原文收件，不用人工造 records 代替自动接入。来源访问只限启动时冻结的 origin，不能访问其他主机或执行交付件。

GET /collections 返回资料集列表，GET /collections/{collectionId} 返回 collectionId、receiptIds、records、issues 与 joint。结构化 records 的每项包含 kind、key、value、provenance；key 由各来源身份语义决定，不要求特定内部编码。provenance 是含 receiptId 与 location 的数组，location 可采用字节区间、原行列、JSON Pointer 等可复查定位。issues 每项包含 reason、location，至少能说明原因、受影响范围和已有来源依据，不能用静默丢弃表示未知。缺失资料不等于来源明确删除。joint 是本轮联合领取的状态与依据，未被联合领取过的资料集为 null。

POST /joint-acquisitions 接受 collectionId、entry（联合目录入口）和 requestBudget，返回 200/201，state 为 committed、unconfirmed 或 incompatible，并附 selection、catalogs、unresolved 和 requests（used/budget）。committed 表示选出的每个版本都满足目录声明的全部 requires，且索引与每个所用目录在发表前经条件请求确认仍是本轮读到的版本；此时资料集里写入每个来源的 source-version 记录，value 含 source、version、payload，并带目录与原文两个出处。unconfirmed 表示兼容组合尚未确认：目录不可观察、声明不完整、预算不足以取完正文或重验证、或发表前索引/目录已变动。incompatible 只在所有参与方目录完整可观察、且完整搜索排除全部声明组合时给出；它仍需本轮目录有效性可核对。每轮结果替换该资料集当前的 joint 视图和同键的 source-version 记录；历史收件仍可按 receiptId 回查，先前的单方原文不会被当成联合声明。

POST /collections/{collectionId}/records 可录入人工确认记录，必须附本资料集的真实收件出处。自动接入不能依赖操作者事先写入答案。该接口目前采用同键不可变约定；新增版本、历史记录与当前视图如何协调，应与来源语义相符，不能覆盖已归档原文。来源契约中的值是查询视图契约，不限定解析器、状态机或索引的内部实现。

本地 provider 是独立 HTTP 来源，fixtures 为合成的公开样本，不包含真实个人或机构凭据。fixtures/descriptor.json 说明来源入口与接入选项。多数资料源用 /deliveries 声明 deliveryId、revision、roots 和 resources；roots 是需处理的独立入口，resources 是同包可领取资源，不是公网搜索指令。文件可用 GET、HEAD 与单段 Range 读取；ETag 表示返回字节的身份。SOURCE_STAGE=partial 启动不完整交付状态，完整状态是默认值。来源服务不接受写操作。
