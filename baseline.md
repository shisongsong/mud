# 文字多人游戏项目 — 开发基线 v3.1

> 用户已授权助手作出MVP设计决策。具体决策见 [docs/m0-decisions.md](docs/m0-decisions.md)，数据字典见 [docs/m0-contract-draft.md](docs/m0-contract-draft.md)，任务见 [docs/development-tasks.md](docs/development-tasks.md)，修订说明见 [docs/review-v2-v3.md](docs/review-v2-v3.md)。
>
> 原始旧文未逐项核实，不能视为原文差异报告；以本版作为新设计起点。设计采用不代表依赖兼容、运行测试、独立评审或法律合规已验证。
>
> 状态：T00设计交付与只读复核完成；T01已建立Node.js/Fastify骨架。2026-10-08按用户指定将durable database改为Supabase PostgreSQL；适配器与迁移尚未连接远程数据库验证。

## 1. 产品目标与范围

### 1.1 核心体验

浏览器中的多人文字游戏：玩家阅读信息、作出行动、参与交流；信息可以传播、篡改和交易；玩家行为改变世界状态。通过有限、可组合的规则形成不同策略，而不是预设唯一解。

“涌现”是可观察的系统结果，不是承诺自动生成无限玩法。规则执行、记录、审核和安全限制必须先于模式识别与元规则。

### 1.2 分期范围

| 版本 | 必须交付 | 不在本期 |
|---|---|---|
| MVP | 注册登录、单账号单角色、六阵营/两存在/六职业的配置选择、公开大厅、四人试炼（探索→投票→结算）、知识库、公开/定向/篡改传播、积分和世界状态、设计者规则、术语/内容/规则的后台发布、事件可靠性、审计 | 交易、公会、玩家规则、嵌入规则、反馈配置、元规则、自动模式识别、可视化Saga编辑器 |
| R1 | 私聊、信息交换交易、玩家契约及信息嵌入规则、安全审核、即时/延迟反馈、涌现时间线 | 任意自定义代码、无限规则递归 |
| R2 | 组织/仪式/策略模板、元规则、模式识别、可视化管道编辑与依赖图、多语言管理 | 未经评估的自动经济系统重写 |

R1/R2不得拖累MVP门禁。MVP预留接口和数据契约，不实现空壳页面冒充完成。

### 1.3 首个可玩闭环

四个已认证玩家创建角色 → 加入同一房间 → 探索 → 投票 → 服务端裁决 → 异步结算 → 收到各自授权的信息和积分 → 世界面板更新 → 玩家传播信息 → 后台修改术语后已有页面更新。

## 2. 架构原则

1. 采用模块化单体，首版不拆微服务；领域边界优先于技术分层。
2. Supabase托管PostgreSQL是业务状态、任务、事件、配置版本的持久化真相来源；Redis不承担可靠消息的唯一存储。
3. 一个业务事务只修改一个领域聚合，可同时写该操作的Outbox、命令幂等记录、审计等技术记录。投影和配置发布有明确的独立事务边界。
4. 跨聚合用公开命令与持久化事件实现最终一致，不共享事务、不跨模块读写内部表。
5. 领域规则在聚合/领域服务中；Pipeline仅编排，不能绕过授权、不变量和幂等。
6. 设计者规则是受限数据；身份授权、资源守恒、系统不变量不是可编辑玩法规则。
7. 内容、术语、规则版本不可变；发布改变激活指针，不覆盖历史。
8. 输入、配置、集成事件、公开响应均校验；不向客户端直接返回ORM对象。
9. 玩家可见系统文本来自术语/内容；昵称、聊天和玩家创作是用户输入，不属于术语。
10. 跨边界操作可追溯、可重试；不承诺端到端exactly-once。
11. 架构变更先更新本文与ADR，再改实现；显示名变更不必修改基线。

## 3. 技术栈与结构

### 3.1 选型

| 部分 | 决策 |
|---|---|
| 工程 | npm workspaces（随Node.js提供）、TypeScript strict、统一ESLint/格式配置 |
| 运行时 | Node.js 24 LTS；M0验证兼容性并锁定具体版本 |
| 后端 | Fastify、受控WebSocket接入、Zod |
| 数据 | Supabase托管PostgreSQL；通过参数化PostgreSQL仓储与版本化SQL迁移访问，连接凭据经`DATABASE_URL` Secret提供 |
| Redis | 本机Redis，用于在线状态、限流、缓存及可丢失的刷新提示；精确版本由T01探测/确认 |
| 前端 | React、Vite、React Router、TanStack Query、Zustand、Tailwind；M0锁定相互兼容的稳定版本 |
| 测试 | Node.js `node:test`（当前）、Supabase PostgreSQL/Redis集成测试、Playwright E2E |
| 观测 | 结构化日志、OpenTelemetry trace/metrics、关联ID |

不强制引入ORM。PostgreSQL存储适配器拥有参数化SQL、连接池与事务实现；迁移为审核过的版本化SQL。禁止拼接用户输入构建SQL；领域模块只能经平台事务/仓储端口访问所属表。事务隔离、advisory lock、租约领取及并发语义须通过Supabase PostgreSQL集成测试确定。数据库技术决策见[ADR-0006](docs/adr/0006-supabase-postgresql.md)。

### 3.2 目录与依赖

```text
apps/server/               HTTP、WS、认证接入与组合根
apps/worker/               Outbox、消费者、持久化任务、Saga恢复
apps/player-web/           玩家应用
apps/admin-web/            管理应用
packages/contracts/       Zod契约、公开DTO、命令/事件版本
packages/kernel/          ID、Clock、事务端口、事件信封、追踪等少量共享机制
packages/platform/        数据库、可靠交付、锁、会话、可观测性实现
packages/modules/identity/
packages/modules/player/
packages/modules/script/
packages/modules/query/
packages/modules/board/
packages/modules/social/
packages/modules/rules/
packages/modules/control/ 内容、术语、发布、权限、审计的配置面
packages/content/         中性种子配置，仅首次部署/测试导入
tests/integration/
tests/e2e/
docs/adr/
```

模块内部按domain/application/infrastructure/interfaces划分，仅公开入口和契约可跨模块引用。领域层不依赖Fastify、ORM、Redis或其他模块内部类型。组合根注入端口实现，不通过ORM关联导航访问其他模块。

依赖：应用 → 模块公开接口/契约；模块 → kernel/contracts；基础设施实现端口。静态检查禁止环和内部路径导入。不实现自动扫描式ModuleLoader，使用显式注册。

管理API初期与玩家API共用server进程，但路由、授权和公开DTO隔离；worker独立部署，仍为同一代码库。未来只有负载或组织边界明确要求时才拆服务。

## 4. 领域边界与一致性

| 模块 | 聚合与职责 | 禁止事项 |
|---|---|---|
| Identity | Account、Session；账号、会话、权限来源 | 客户端自行声明管理员角色 |
| Player | Player；角色、积分/资源账本、天赋 | 同事务修改知识库 |
| Script | Script、每玩家Knowledge、SpreadOperation/Trade流程状态 | 信任客户端真伪标记或绕过持有权 |
| Query | Query；房间、阶段、行动、投票、不可变裁决 | 同事务修改所有参与者积分 |
| Board | BoardState；世界数值、赛季状态 | 同步扫描全体知识做写入前置 |
| Social | Channel、Message、后续Organization | 用聊天接口绕过信息传播授权 |
| Rules | RuleExecution、FeedbackState、后续PlayerRule/Consent | 直接改其他模块表、取代业务不变量 |
| Control | 配置版本、Release、激活指针、管理审计 | 编辑玩家运行时状态 |

Control管理发布后的不可变定义；Rules管理执行与玩家授权状态。审计是技术/配置职责，不是所有模块必须依赖的业务聚合。

### 4.1 命令和并发

- 命令含commandId、actor、traceId、适用时的expectedVersion；actor来自会话，不能信任请求体。
- 聚合有version；使用乐观锁，领取任务/阶段切换按需要使用受控行锁。
- 可重试写请求要求Idempotency-Key，按actor+操作+key唯一；保存请求摘要与结果，同key不同内容返回409。
- 公开ID使用UUID；若内部使用BIGINT，不用JavaScript number承载。
- 注入Clock和随机源；时间、裁决、随机奖励由服务端产生并记录。

### 4.2 可靠事件协议

事件信封：eventId、type、schemaVersion、source、aggregateId、aggregateVersion、streamId、sequence、releaseVersion、occurredAt、traceId、correlationId、causationId、rootEventId、depth、payload。中性英文命名，公开WS消息不等于内部集成事件。玩法releaseVersion指固定gameplayReleaseId，沿派生传递；认证/平台/术语等非玩法事件显式null，不作为玩法规则输入，避免首次引导依赖尚未存在的玩法版本。

1. 聚合变更、命令幂等结果、Outbox同事务提交；领域内瞬态事件不必全部持久化。
2. dispatcher租约领取Outbox，将事件写event_store，并为当时注册的每个订阅者建立delivery。归档、delivery插入、Outbox完成标记在一个平台事务提交。
3. event_store按eventId唯一，delivery按eventId+consumer唯一。新消费者不会自动收到历史事件；需显式申请回放。
4. 消费者在同一事务写Inbox、业务变更/投影及本地Outbox；失败一起回滚，不能提前独立提交Inbox。
5. 外部I/O不能与Inbox假装原子提交；通过本地Outbox或幂等适配器处理。
6. delivery按退避+抖动重试，超限进入dead_letter；支持授权重放、审计、告警。
7. 崩溃后租约过期可重新领取。需顺序的消费者按聚合sequence处理；缺口等待/告警/回放，不静默越过。每种流单独分配连续sequence，不能假设每次聚合version都有公开事件。

订阅过滤后sequence可能不连续：MVP选delivery前驱关系，归档按source stream游标推进，不能把未订阅事件当丢失。租约带fencingToken防止旧worker提交平台状态。投影按原eventId去重；重建使用独立generation/checkpoint，不能因已有Inbox跳过回放。跨多个目标的处理器只持久化流程计划，再逐target派发命令，不在一个Inbox事务更新多个聚合。

语义：至少一次交付+幂等业务效果。Redis Pub/Sub仅提示变化，丢失由轮询/版本检查恢复。内存EventBus只做进程内非可靠提示，不承担跨模块业务交付。

event_store是集成事件归档，不采用Event Sourcing，业务表仍是真相来源。不归档密码、会话凭证或不必要的私聊全文；事件按权限分类、脱敏、留存。

### 4.3 CQRS

使用独立读侧投影，不要求所有查询做物化视图。投影有Inbox/checkpoint/重建能力；资料、世界摘要、榜单、历史和涌现时间线由事件更新。

写响应含operationId/aggregateVersion；UI显示pending并查询操作状态，不假设写后立即读到新投影。延迟SLO仅针对明确健康负载。

## 5. 试炼、传播与Saga

### 5.1 试炼状态机

```text
waiting → exploring → voting → judging → settling → completed
    └→ cancelled                 └→ settlement_failed（可恢复）
```

迁移检查合法前态、deadline和version。trial_1固定四人满员启动、等待5分钟取消；每玩家一个未终结房间由Query拥有的独立ParticipationSlot聚合及唯一键保证。Join通过持久协调依次预留Query房间座位、占用ParticipationSlot、确认Query成员，不跨聚合事务；中断按幂等前向恢复或释放预留。持久任务按绝对deadline推进，重启补齐逾期任务；内存计时器不作为正确性基础。平台scheduler只处理dueAt、租约、退避和去重，领域模块定义任务schema、handler、取消/到期条件及幂等命令。

行动验证会话、资格、阶段、目标、配额和deadline。inspect三位置，每人两次且不重复位置，结果存Query私有卡。截止前可改票，choice_1/choice_2/abstain，平票choice_1、全弃权无选择；截止前仅本人投票可见。掉线不延时，仅waiting允许退出，now=deadline已截止；详见M0决策及验收向量。

裁决生成不可变结果与结算计划，固定releaseVersion和随机种子，重试不重新抽奖。

### 5.2 结算Saga

跨模块“多个Pipe”不构成数据库事务。Saga保存定义版本、实例状态、逐步骤幂等键、命令ID、结果与重试时间。

默认前向恢复：验证裁决 → 逐玩家积分账本 → 逐卡创建/复用Script → 逐玩家信息授予 → Board变更 → 确认全部结果 → Query完成。每步仅改一个聚合，效果键settlementId+step+target；Script创建与Knowledge授予不可合成跨聚合事务。全部固定计划目标有确认引用后，Saga调用Query `FinalizeSettlement`；Query核验计划并在自身事务中转completed、写Outbox `QuerySettlementCompleted`。该内部事件仅供Rules可靠消费，含selectedCorrect等敏感裁决事实，不进入客户端、普通WS、公开投影或一般日志。

暂时错误重试；永久错误停在人工处理，不静默跳过。已发出的奖励不能“恢复旧积分/删除全部知识”。未来确需撤销时，使用关联原账本的逆向记录；信息只撤销本次授予凭证，不能删除其他来源已取得的知识。

Rules异步订阅`QuerySettlementCompleted`，不进入结算关键路径，不同步递归执行。规则效果失败不改变已完成裁决。

### 5.3 信息传播

传播是跨Script和多个Knowledge的可恢复流程，不是Local Pipeline单事务。

Script先持久化preparing operation并生成operationId → Social按operationId幂等创建/返回同一不可变受众快照 → Script保存快照引用及逐目标计划 → 改写时幂等创建新Script → 逐接收者幂等授予 → 记录统计 → 提示查询公开DTO。快照第一次持久化是受众接纳时点；崩溃重试取回同一快照，不重新采样。operationId+recipientId唯一；计划、新Script和多份Knowledge不可放在同一业务事务。

定向传播与聊天私信不同。禁止指定未授权收件人、读隐藏内容或伪造来源。大厅在线为认证心跳30秒内；公开上限100收件人、定向最多10人，超限整次拒绝。已接纳快照不因下线撤回；禁用/删除目标记skipped。MVP无玩家屏蔽；禁言不能通过传播绕过。

玩家DTO永不含isTruth、tampered、hiddenSource、内部判定/管理员证据。`QuerySettlementCompleted`是Query在FinalizeSettlement验证所有结算目标后事务性写Outbox的内部事件，selectedCorrect仅供授权Rules consumer；不得进入客户端、普通WS、公开投影或一般日志。未知真伪与篡改信息使用相同公开结构，不承诺统计意义不可辨别。验证能力只显示设计允许且授权的证据。

### 5.4 Pipeline

Local Pipeline只编排一个聚合的命令流程，事务由应用服务管理。Pipe没有跨模块表访问能力。

配置只引用白名单Pipe及schemaVersion；发布验证依赖和必需步骤。授权、幂等、审计等强制步骤不可关闭。先固定后端编排，R2再开放可视化编辑。

运行记录runId、定义版本、traceId、结果及限额诊断；回滚后失败日志用独立技术事务记录，禁止存机密输入。

## 6. 规则引擎与安全边界

### 6.1 受限DSL

解析器构建AST，禁止eval、Function、VM、动态模块导入。仅允许已声明字段、字面量、布尔/比较和白名单纯函数；禁止原型访问、任意属性链、网络/文件/时间读取、不受限循环。

发布前校验Zod结构、AST类型、字段白名单、效果能力和预算。执行使用受控事实快照，不将全部玩家秘密或ORM对象注入上下文。

MVP采用结构化JSON AST，不开发自由文本通用语言；只支持字面量、注册字段、布尔与同型比较。首发效果限notify、grant_information、受限change_world，不开放规则积分增发/资源支付/创建规则。详细字段、预算、cooldown、目标与首发双变体见 [内容与规则规范](docs/mvp-content-and-rules.md)。能力表表示长期权限上限，未列为首发实现的能力不能当已交付。

条件求值记录事件、事实版本及asOf；效果命令在目标模块重新验证当前不变量。最终一致可导致条件曾成立而效果被拒绝，必须记录原因。

### 6.2 执行与预算

- 同优先级按ruleId排序；固定ruleVersion、事实快照，执行可解释。
- 每个匹配规则建RuleExecution；逐效果以executionId+effectIndex幂等。
- 默认预算：因果深度≤8、根事件派生事件≤100、单规则效果≤10、AST≤200节点、解释器计算步骤≤1000；可配置值不得超过服务端硬上限。
- 根预算用持久化计数/原子预留跨worker共享，不仅在内存计数；超限停止派生并告警。
- 预算限制可选规则派生链，不阻止结算/传播必需步骤；预留按effectKey去重，重试不重复计费。
- 同规则/同事件只执行一次，支持cooldown、递归环检测和紧急停用。
- 一规则失败不阻断其他规则；效果独立重试。多效果不宣称全局原子，区分pending/partial/completed/failed。

### 6.3 能力与玩家规则

| 能力 | 设计者发布规则 | 玩家规则（R1） |
|---|---|---|
| 授予信息/资源、修改世界 | 限事件/目标/数值/速率，目标模块授权 | 不可凭空增发或修改世界 |
| 通知 | 授权受众、术语key/发布内容 | 仅同意参与者、限频 |
| 资源支付 | 正式账本命令 | 已同意契约且预留额度 |
| 触发事件 | 白名单玩法事件 | 模板声明事件，不冒充系统 |
| 创建/修改/禁用规则 | Control审核发布，不直接作为普通效果执行 | 禁止 |

玩家只使用白名单模板参数，不开放管理员同等DSL/效果权限。

状态：draft → pending_review → approved → awaiting_consent → active → suspended/expired/revoked。审核不等于参与者同意。

逐参与者同意ruleId+version，记录时间、额度、撤销条件；阅读或“相信”信息不自动生效。嵌入信息引用不可变ruleId+version，接受信息与接受规则独立；升级必须重新同意。

付费契约先完成可恢复资源预留协议，禁止负余额和无额度支付。R1先支持双人定额契约，再扩其他模板。

### 6.4 反馈与元规则

反馈定义scope/stateKey/阈值/cooldown/滞回/enabled/version；原子声明触发并建幂等任务。延迟任务持久化dueAt、去重键、取消条件、版本，不能靠setTimeout。

tension固定为压力值：0低压力、100高压力。不得仅把术语改成方向相反的“稳定度”；稳定度显示100−tension并定义独立key。阵营力量为各自0–100独立强度，不是六项和为100的占比；需要比例须另定义。

元规则在R2定义窗口、分母、最小样本、活跃玩家、去重和触发一次约束；结果先产生待审批配置变更，不自动提升权限或改变系统不变量。赛季切换有状态机和生效版本。

### 6.5 涌现记录

R1先记录可追溯规则使用和策略标签。R2做确定性序列统计，不引入不透明的“自动理解策略”：固定窗口、算法版本、patternFingerprint、证据eventId、样本数、去重和阈值。公开展示不泄露秘密信息/私聊。

检测结果为候选，经审核或预发布安全策略确认；检测失败不影响游戏。固定合成事件集评估召回/误报，不只验证“产生了一条记录”。

## 7. 数据模型与迁移

本文只列逻辑数据与不变量，M0/T03产出由平台适配器管理的PostgreSQL schema与版本化迁移，不重复多份CREATE TABLE。

| 分组 | 逻辑表 |
|---|---|
| 身份 | accounts、sessions、account_roles、mfa_credentials、mfa_recovery_codes、bootstrap_state |
| 玩家 | players、player_resource_ledger、resource_reservations（R1） |
| 信息 | scripts、knowledge_entries、knowledge_grants、spread_operations、spread_recipients、trades（R1） |
| 试炼 | queries、query_participants、query_participation_slots、query_actions、query_evidence_cards、query_votes、settlement_plans |
| 世界 | board_states、board_change_ledger、season_transitions（R2） |
| 社交 | channels、channel_members、messages、audience_snapshots、reports、channel_mutes、organizations（R2） |
| 配置 | config_versions、release_manifests、release_approvals、active_releases（gameplay/glossary）、scheduled_releases |
| 规则运行 | rule_executions、rule_effects（含可靠通知）、rule_cooldowns、rule_dispatch_state、causal_budgets、feedback_states（R1）、player_rules/consents（R1）、emergence_records/evidence（R1/R2） |
| 技术 | command_receipts、outbox、event_store、event_deliveries、inbox、dead_letters、durable_jobs、saga_instances、saga_steps、pipeline_runs、audit_logs |
| 投影 | player_profiles、board_dashboard、query_history、leaderboard、emergence_timeline（R1） |

- 日期时间以UTC存储/序列化，PostgreSQL列类型与驱动映射需在T03明确；资源用整数或明确精度numeric，不用浮点做账。
- version/CHECK/NOT NULL/唯一键属于正确性；每账号一角色（MVP）。
- 初始1000分，范围0…1,000,000,000；参与+5、正确投票另+20，明确记录上限夹取。段位积分不是可消费货币；resource_1仅R1实现。
- profession_1…6、faction_1…6、power_1…2、rank_1…5；首发72组合均合法，仅展示身份，不附加能力；段位下限0/1000/1500/2000/3000。
- 世界值有0–100约束；账本、投票、授予凭证、Saga子效果有数据库去重键。
- 术语唯一键scopeId非空（global为空字符串），避免依赖不同数据库对NULL唯一索引的差异。
- 同模块使用FK；跨模块仅ID引用，通过接口/事件验证修复，不跨边界级联删除。
- 秘密事实与公开投影分离；日志和事件导出按权限脱敏。
- 验证空库升级、已有版本升级、投影重建、留存清理、备份恢复；生产默认前向迁移，破坏性迁移审批。

## 8. 配置、术语与控制面

### 8.1 发布协议

类型：glossary/content/rule/pipeline/feedback/meta_rule。版本含schemaVersion/checksum/状态/创建者，发布后不可变。ReleaseManifest引用精确版本；验证后在Control事务写审计、激活指针、Outbox。

draft → validated → published → retired；published不等于active。历史激活是回滚配置，不覆盖历史，也不自动撤销已发生玩法效果。草稿使用expectedVersion防覆盖。

空库先幂等激活无规则`gameplay_bootstrap_v1`与`glossary_bootstrap_v1`；缺少玩法清单时仅允许认证/bootstrap/公开静态读取，玩法写返回503 `GAMEPLAY_NOT_READY`。gameplayReleaseId/glossaryReleaseId独立指针。server/worker校验清单后原子换快照，失败保留旧版并告警，每5秒检查指针。新根命令需数据库当前指针对应精确快照，未加载时503，不用旧版接纳新命令。

新试炼固定releaseVersion（内容/规则/管道），在途Saga固定定义版本；术语可独立立即更新。在途事件按原始版本路由，不混用新旧规则；延迟任务默认执行创建时版本，撤销/退役需明确策略。

### 8.2 术语与内容

查找：指定season → 指定pack → global；先在请求locale查完整作用域链，再同链回退默认zh-CN；缺失显示key并限频告警。scope/scopeId由合法配置和会话上下文决定。

后端getName/getShort/getDescription/getMetadata；前端useTerm/useTermDescription/useTermMetadata，禁止传递未声明的field参数。

内容支持声明的{{term_key}}与受限参数，不执行任意表达式。用户输入纯文本呈现；模板/元数据校验防脚本与任意样式注入。

历史叙事保存当时文本/版本，不因术语更新改写历史；当前UI/动态内容存key+参数，可重新渲染。WS系统消息用messageKey+args；用户聊天用纯文本。

种子只初始化未存在配置，重复部署不覆盖管理员已发布结果。上线后变更只能走授权配置接口。

### 8.3 权限、审计、沙箱

planner编辑草稿/预览；lead_planner发布并激活内容/术语/允许管道；rule_admin发布规则并批准含规则变化清单checksum，激活不能绕过审批。ops观测/授权重试/停用；admin管理权限，不隐式拥有玩家秘密或规则审批能力。生产管理身份强制MFA和敏感再认证；首个管理员通过唯一bootstrap_pending身份及15分钟受限HttpOnly会话完成enroll/confirm/status/logout，其他路由均拒绝；确认TOTP时原子启用MFA、授予admin并轮换会话。MVP记录审批但不强制不同账号双人审批。dev不能动态上传代码。

敏感发布、回滚、审核、重放、停用记录actor/目标/版本/差异摘要/traceId/来源/时间；失败授权记录安全审计。成功业务写与成功审计同事务，敏感值脱敏。

预览只用纯计算与内存模拟端口，不注入真实数据库写、通知、发布、任务队列。报告显示输入快照/规则版本/预计命令/拒绝原因；拒绝副作用的测试替身验证零写入和零外部I/O。

## 9. HTTP、WebSocket与安全

### 9.1 通用契约

HTTP统一/api/v1，管理/api/v1/admin。错误为code/messageKey/args/traceId/details（仅安全校验信息）。400格式、401认证、403权限、404不可见/不存在、409并发/幂等冲突、422业务拒绝、429限流、503暂不可用。

cursor分页、固定上限；写返回资源或202+operationId。OpenAPI从契约生成或做一致性验证。事件/消息带schemaVersion，公开WS至少兼容当前与上一版本。

### 9.2 MVP路由（相对于/api/v1）

```text
POST /auth/register  POST /auth/login  POST /auth/logout  GET /auth/session
GET /player/me  POST /player/create  GET /board/state
GET /script/knowledge  GET /script/:id  POST /script/spread
GET /query/list  POST /query/join  GET /query/:id
POST /query/:id/action  POST /query/:id/vote
POST /query  POST /query/:id/leave  GET /leaderboard
GET /notifications
GET /channel/:id/messages  POST /channel/:id/messages  POST /reports
GET /operations/:id  GET /glossary  GET /content/character-options
GET /rules（仅可公开定义，不含秘密条件/证据）
GET /admin/:configType  POST /admin/:configType/:key/draft
POST /admin/releases/validate  POST /admin/releases/preview
POST /admin/releases/publish  POST /admin/releases/:id/activate
GET /admin/audit  GET /admin/dead-letters
POST /admin/dead-letters/:id/replay
GET /admin/sagas  POST /admin/sagas/:id/retry
POST /admin/rules/dispatch-state  GET /admin/reports
POST /admin/moderation/:accountId
POST /auth/mfa/enroll  POST /auth/mfa/confirm  POST /auth/reauthenticate
```

configType为枚举，不是表名。M0决定路由语义，T02固定可执行schema；R1再增交易/玩家规则/同意/反馈/涌现接口。MVP所有业务写走HTTP，WS没有双写入口。

### 9.3 认证与传输

默认同源部署，TLS、HttpOnly安全会话Cookie、SameSite、状态改变请求CSRF防护、Origin验证。Argon2id密码哈希；登录注册限流、会话轮换/到期/注销，管理员更严限流。禁止localStorage长效token、URL凭证。

WS握手验证会话与Origin；逐消息验证会话、成员、授权、大小/配额。requestId/type/schemaVersion/payload仅用于Subscribe/Unsubscribe/Ping，ack关联requestId；WS不提交行动/投票/传播。

心跳、退避+抖动、有界队列/背压；MVP不持久化WS历史，通知resourceVersion可丢失，缺口/重连统一HTTP授权快照。内部事件游标不直接给玩家使用。业务完成不依赖在线通知，无跨房间全局顺序承诺。

聊天限频/长度/纯文本转义/举报/保留策略；定向消息与知识防IDOR；禁止客户端提交isTruth、createdBy、资源delta、角色权限等服务端字段。

## 10. 玩家与管理界面

MVP页面：login/register/character-create/lobby/query/:id/knowledge/character/board/rank/settings。社交、涌现随R1/R2交付，不提前暴露空入口。

终端风格：背景#0a0e14、文字#c5c8c6、青色#00d4aa、警告#ffb454、错误#ff5555；等宽字体+中文回退。桌面三栏，移动抽屉/底部导航；键盘可用、焦点可见、颜色非唯一信号、减少动画、日志自动滚动可暂停。

共享组件：TermText/LogStream/CommandInput/PlayerCard/InfoCard/VotePanel/SpreadDialog/OperationStatus。按钮与指令调用同一应用操作，不维护两套业务规则。

MVP指令：/join、/action、/vote、/spread、/who、/help；白名单语法、术语化错误。退出权限按房间阶段定义。

管理MVP：登录、总览、术语、内容、设计者规则、发布校验/预览/历史激活、审计、死信。先结构化表单/受控JSON，再R2可视化。

## 11. 运维与质量

- readiness依赖数据库，liveness检测进程；worker心跳与租约指标。
- traceId贯穿请求/命令/Outbox/消费/Saga/规则；correlation/causation表达长流程，traceId不作幂等键。
- 指标：交付积压/最老年龄、DLQ、Saga pending、任务逾期、预算超限、WS丢弃、投影延迟、配置分歧。
- 分别定义审计/事件/聊天/运行日志保留期，不无限存储；备份恢复演练为上线门禁。
- 锁文件、数据库最小权限、秘密环境注入、日志脱敏、非root镜像、生产TLS。
- 执行命令、安装、联网、Git、部署须符合环境许可；安全软件拦截即停止报告，不尝试绕过。

### 11.1 负载与SLO

MVP：单世界100在线连接、20并行四人房间。基准4 vCPU/8GB、数据库/Redis同测试网络、持续15分钟，排除客户端公网延迟。

健康状态：投影延迟p95<1s/p99<3s；普通HTTP p95<300ms（不含密码哈希、发布、异步完成）；结算p95<5s。故障/积压时pending并告警，不承诺同延迟。归档参数和原始结果，不达标不能声称通过。

### 11.2 测试

领域单元、契约、真实库事务/唯一键/并发、故障注入、四玩家+管理员E2E、边界和秘密泄露检查。每个Pipe单测、每个运行时模块集成测试；纯mock不替代数据库测试；随机固定种子、时间用Clock，不靠长sleep。

## 12. 阶段与门禁

| 阶段 | 成果 | 前置 | 门禁 |
|---|---|---|---|
| M0 | 玩法/契约语义、威胁模型、ADR、验证责任 | 无 | 独立文档审查与风险计划明确；精确版本/兼容实测由T01承担 |
| M1 | 工程、数据库、可靠事件、任务、配置发布 | M0 | 并发/重复/崩溃恢复/无副作用预览测试 |
| M2 | 身份、玩家、信息、世界、四人试炼/结算 | M1 | 后端闭环与故障恢复 |
| M3 | 安全设计者规则、API/WS、管理与玩家UI | M2；UI可基于冻结契约先并行 | 热更新/秘密DTO/旧版本保持测试 |
| M4 | 内容、E2E、压测、安全、恢复演练 | M3 | MVP验收有可复现证据 |
| R1 | 交易/私聊、契约/嵌入规则、反馈/涌现记录 | MVP通过 | 资源守恒/同意/任务恢复 |
| R2 | 组织/元规则/识别/可视化 | R1 | 统计质量/权限/发布兼容性 |

不预先承诺固定总工期。M0后逐任务估算，优先0.5–2开发日，超出拆分；以门禁证据而非文件数量计进度。

## 13. MVP验收

- [ ] 安装、类型/边界检查、构建、单元和真实库集成测试可复现，锁文件确定。
- [ ] 空库迁移、种子幂等、已有版本升级通过；测试不连接生产库。
- [ ] 四独立会话完成角色/探索/投票/结算；平票/未投票/掉线/逾期符合模板。
- [ ] 结算重复/并发无重复奖励或world delta；中途杀worker恢复。
- [ ] 公开/定向/篡改传播正确，HTTP/WS不泄露真伪/隐藏来源/他人知识。
- [ ] 交付重复/租约过期/事务失败/顺序缺口/DLQ重放有真实库测试。
- [ ] 规则效果有授权/幂等/解释，循环预算跨worker生效，失败隔离。
- [ ] 无效/越权发布拒绝，旧房间/Saga用旧版本，新房间用新版本，失败保留旧快照。
- [ ] 术语发布后已有UI/动态内容更新，断线或Redis提示丢失可恢复。
- [ ] 管理写与审计一致，预览无数据库/消息/任务/外部I/O副作用。
- [ ] 认证/CSRF/Origin/IDOR/过期/限流/转义安全测试通过。
- [ ] 系统UI文本来自术语，缺失key可见/告警；用户输入/测试数据不误报。
- [ ] 目标负载SLO及备份恢复演练完成，故障pending明确，最小运行手册齐备。
- [ ] 无依赖环、跨内部表访问、动态代码执行；无预设世界观专名。

R1/R2专项验收见任务清单，不得算作MVP已经完成。

## 14. Agent约束

1. 先读本文与任务，只实现一个Ready任务，不自行扩版。
2. strict、禁止any；边界含metadata/payload用unknown+校验。
3. 仅修改分配目录；公共契约/schema/锁文件/根配置指定负责人处理。
4. 领域规则不放前端/Pipe；跨模块仅公开端口/持久化事件。
5. 输入/配置/事件/响应校验；业务写走声明的事务边界。
6. 系统UI文本不硬编码；用户输入不是术语；秘密不进公开DTO。
7. 禁止动态代码、任意玩家效果；不得绕过账本、同意、授权。
8. 交付单元/集成/故障证据；环境阻止运行时如实“未验证”，不虚报。
9. 无用户授权不安装/联网/运行终端/自动提交；许可后建议逐任务提交feat(context): 描述。
10. 完成填写状态、文件、契约变更、测试证据、风险；评审后才Done。
11. 基线歧义先登记阻塞，不偷偷改安全/事务/权限；普通实现细节记录后决策。
12. 不修改安全产品配置、不绕过拦截、不访问无关工作区/秘密。

## 15. 文档维护

本文维护边界/不变量/门禁；任务文档维护依赖/负责人/状态/证据；docs/adr记录边界、数据兼容、安全取舍。M0契约审查后接口/schema细节以契约为准，但不能违背本文不变量。范围修改同步本文/ADR/任务，避免互相矛盾。

版本：v3.1 · 日期：2026-09-30 · 范围：MVP → R1 → R2