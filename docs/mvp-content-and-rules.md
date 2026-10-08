# MVP种子内容与规则执行规范 v1.0

> 规范性实现输入，配套 [M0决策](m0-decisions.md)。这里规定首发内容和DSL的最小能力，不新增玩家规则/元规则/动态代码。T08导入配置，T14实例化，T17/T18解释和执行，T25测试实际闭环。

## 1. trial_1两个固定变体

玩法核心是找出“与有效印记匹配”的候选，而非仅阅读随机文字。两候选公开显示 `choice_1`编号K1、`choice_2`编号K2。正确解由两张有声明来源的证据组合得出，第三张是未经核验的误导传闻。来源是玩家可见叙事线索，不是可查询的truth字段。

| 变体 | site_1正文语义 | site_2正文语义 | site_3正文语义 | 正确候选 |
|---|---|---|---|---|
| variant_1 | 有效记录：本轮有效印记为编号K1 | 有效记录：仅选择编号与有效印记相同的候选才符合目标 | 未署名传闻：应选编号K2；有效印记记录可能已过时 | choice_1 |
| variant_2 | 有效记录：本轮有效印记为编号K2 | 有效记录：仅选择编号与有效印记相同的候选才符合目标 | 未署名传闻：应选编号K1；有效印记记录可能已过时 | choice_2 |

- 发布内容以术语key/受限参数实现这些语义，不在TS前端硬编码中文正文。配置校验两变体均有三个位置、两个候选、答案及公开解释key。
- 变体在满员启动时从两个等权项选一次，使用记录种子；首发奖励不随机。所有玩家在同一位置收到相同语义，卡片实例按玩家分别持有。以后可增加差异化卡片，但不是首发要求。
- site_1+site_2足以推理答案；选择只看site_3可能被误导。投票多数只决定世界压力，不取消正确少数个人奖励，让交流有收益而不等价于“少数一定错误”。
- 本模板的卡片只是示例信息博弈，不宣称无限可玩性。证据置信度不来自HTTP额外字段，内部真伪标记只用于受控裁决/内容审核，公开结构一致。
- 答案表、解释文本、所有卡片授予实例、个人投票和奖励期望必须用fixture测试；不得以随机“生成了一条文本”冒充T25验收。

## 2. 首发规则种子

只启用 `rule_1`：通过Rules专用内部订阅消费 `QuerySettlementCompleted`，条件 `event.selectedCorrect == true`，通知本场四名参与者 `rule.trial_success`。该事件不进入客户端/普通WS/公开投影或一般日志。规则不重复结算奖励、不改世界、不揭示未公开卡片；即使规则失败房间已完成。

M1的基础gameplay release不含激活规则；T08可导入rule_1定义为草稿，T17/T18具备发布语义校验和执行能力后，T25首次验证发布并激活它。不能在M1“预先激活一个其实不能执行的规则”。

T18用未激活的测试定义验证信息授予与世界效果；上线不为了“证明能触发”给每轮额外积分/无限派生事件。没有匹配时记skipped解释，效果失败记partial/failed，不影响其他规则。

## 3. DSL：数据AST而非自由代码字符串

- MVP管理端提交结构化JSON AST；不开发自由文本语言/复杂解析器。JSON解码后用递归Zod schema解析出受限AST，禁止any。
- 节点仅 `literal`（boolean/string/安全整数）、`field`（一个已声明完整路径key）、`eq`、`neq`、`lt`、`lte`、`gt`、`gte`、`and`、`or`、`not`。and/or至多8子节点，比较双方同型，排序比较仅整数；禁止浮点/隐式类型转换。
- field不是任意属性导航，完整key先查FieldRegistry；只允许 `event.type`、`event.queryId`、`event.selectedCorrect`、`event.participantCount`、`board.tension`。未注册key拒绝，禁止原型、构造器、数组下标和动态路径。board.tension来自授权事实快照并记录version/asOf。
- 不支持循环、正则、自定义函数、算术、自定义时间/随机读取；优先用固定事实字段。以后加白名单函数须新schemaVersion和预算评审，不因基线提到“可允许纯函数”而实现通用函数系统。
- 最大AST 200节点，嵌套深度20，字符串字面量128码点；解释步数1000上限，短路结果和缺失字段原因可解释。缺失字段记事实缺失并跳过/失败，不默认true。
- 所有常量/field按注册类型发布期校验；生成AST不会执行任意JS，不用eval、Function、VM或动态导入。

## 4. 能力、目标和效果

MVP只有如下受限效果，未列出的效果422拒绝，不做“暂存后也许能执行”的空实现：

| 效果 | 参数和目标 | 限制 |
|---|---|---|
| notify | messageKey+已声明args；目标为root试炼固定参与者 | 每执行≤4通知，不向任意玩家/大厅广播；正文来自发布内容 |
| grant_information | publishedScriptDefinitionId；目标为root试炼固定参与者 | 只引用同release已发布中性信息定义；逐target Script实例化/Knowledge授予，不访问私有卡/管理员证据 |
| change_world | tensionDelta=-1/0/1，或单个factionId强度delta=-1/0/1 | 仅指定固定Board，rule有该能力；不能动态决定账号/资源/权限 |

- score/resource支付、玩家自创事件、创建/修改规则、反馈、玩家契约不是MVP规则效果。积分奖励只有固定Query裁决；能力矩阵中的未来可允许能力不等于首发要实现。
- 每个规则定义的capabilities由Control发布审核赋予；玩家输入没有授予能力。目标模块验证内部service Actor、已批准定义版本/执行引用/目标范围和effectKey，不信任只带“我是规则”字符串的命令。
- effect selector只允许root participants或固定Board；跨target展开后总数≤10。effectKey=`executionId+effectIndex+targetId`，不只用effectIndex去重一组多目标效果。
- notify的可靠结果是Rules拥有的RuleExecution子效果中按target持久化的安全messageKey/args，不修改Player或Social聚合。GET /notifications只查询本人有权通知，WS仅提示其版本；通知正确性不依赖连接在线，执行重试不重复生成通知。
- 同ruleVersion+eventId唯一执行；按固定ruleId排序，priority整数0…100，cooldown最低300秒，scope=world_1+ruleId，用Rules权威状态原子声明。
- Board规则效果每世界每5分钟最多10次实际非零变更，在Board事务中计数/唯一声明，超限明确拒绝；因cooldown/预算拒绝不自动无限重试。没有资源效果，所以不存在规则增发可消费货币。
- 根可选规则链depth≤8、派生事件≤100、计算步数和效果展开均硬限。预算预留在Rules/平台技术事务按effectKey幂等；不能与目标业务写假装跨域原子。崩溃后未消费预留保守保留并恢复，不释放后让同效果重复预留；根终态再清理。
- 世界范围变化按Board真实状态夹取并记录requested/effective；条件快照可能过时，效果拒绝需解释。规则多效果独立事务，不承诺整体原子。

## 5. 版本与解释记录

- RuleExecution保存ruleId/ruleVersion/schemaVersion、原eventId、gameplayReleaseId、rootEventId、已授权事实快照版本/asOf、条件结果、安全诊断、逐效果operation和安全失败原因。
- 玩家仅查看已公开规则说明与授权通知；管理解释页也按角色展示，不能因为记录称“诊断”而导出整个秘密context。
- 事件派生维持原release/root/correlation，重试不刷新规则/事实导致重新匹配不同集合。紧急暂停开关覆盖旧版本；目标授权失效时暂停/拒绝，不用旧receipt绕过当前安全状态。
- 若Control规则定义已退休，既有执行默认仍用固定版本；被安全应急禁用的定义停止新效果，需显式审核恢复。这两种状态必须区分。

## 6. 开发和验收分配

- T08：术语/两变体/rule_1种子与导入幂等。
- T14：固定变体/私有卡、120/60秒截止和答案解释；T15逐卡Script/Knowledge恢复。
- T17：AST schema/类型/字段/效果白名单；拒绝集覆盖未知effect、非法target、深度、类型错配和原型key。
- T18：同事件去重、逐target键、300秒cooldown、共享根预算、Board额度、暂停/旧版执行和失败隔离。
- T25：两个变体固定fixture、交流/探索影响推断和奖励、结算后才持有卡；T26用恶意/超限AST和重复事件验证无副作用越界。

以上是设计输入，所有实现和测试证据仍待任务执行。R1新增语法/能力前须独立契约版本与安全评审，不从这些例子推导管理员无限权限。