# M0 契约数据字典 v1.0

> 状态：设计已定稿并完成只读复核；不是T02可执行schema或实现证据。数据平台采用Supabase PostgreSQL/Redis；真实连接与迁移尚未验证。[M0决策定稿](m0-decisions.md)规范具体玩法与安全选择，本文件维护接口语义；文件名保留以兼容已有链接。
>
> 来源限制：依据当前基线与用户授权建立新设计，原始v2未逐项核对；不是已证实的旧版差异报告。首发内容与DSL见 [实现规范](mvp-content-and-rules.md)，威胁与验证责任见 [威胁模型](threat-model.md)。

## 1. 决策状态

P-01至P-12已在 [M0决策定稿](m0-decisions.md)全部决定，不再要求用户逐项审批。旧文无法核实仅限制差异报告，不阻塞当前设计开发。独立设计评审完成；依赖版本/构建/Supabase PostgreSQL真实库故障测试仍未运行；设计批准与实测证据严格分开。

### 已采用的安全不变量

- Supabase PostgreSQL是可靠业务状态来源；Redis只用于可恢复提示、缓存、在线状态和限流。
- 公开输入、配置、命令、事件及响应必须校验；请求体不能指定 actor、权限、资源增减、真伪或隐藏来源。
- 聚合写入局限于所属模块；跨聚合操作通过可恢复命令/事件，不共享业务事务。
- 效果/授予/消费/事件处理以数据库唯一键和幂等键保证重复安全，不能只靠内存判断。
- 业务成功写与成功审计、Outbox按声明的事务边界提交；失败不得留下假成功记录。
- 公开DTO由允许字段显式构建；秘密证据、密码、会话凭证不进入公开事件、日志、HTTP或WS。
- 管理预览不得有数据库/消息/任务/外部I/O副作用；生产版本不可变，激活指针变更留审计。
- 环境拦截命令/安装/联网/Git时停止，不绕过，不将未执行检查报告为通过。

### 产品/运行决策索引（已决定）

| ID | 决策 | 结论摘要 | 定稿章节 |
|---|---|---|---|
| P-01 | 房间人数 | 固定4人满员启动；等待5分钟取消 | 第2节 |
| P-02 | 探索 | inspect三位置，每玩家最多两次；私有卡 | 第2节 |
| P-03 | 投票 | 60秒可改票；平票choice_1，全弃权无选择 | 第2节 |
| P-04 | 掉线/退出 | 掉线不延时，只在waiting可离开 | 第2节 |
| P-05 | 传播 | 授权在线快照；公开100人/定向10人 | 第4节 |
| P-06 | 积分/世界 | 初始1000；参与5/答对20；固定delta、显式夹取 | 第3节 |
| P-07 | 身份组合 | 6阵营/2存在/6职业，全部72组合合法 | 第3节 |
| P-08 | 术语与历史 | gameplay/glossary独立指针；历史文本冻结 | 第5节 |
| P-09 | 首个管理员 | 维护模式受控一次性引导，无默认密码 | 第6节 |
| P-10 | 安全/保留 | 同源Cookie、管理MFA、明确工程保留期 | 第6节 |
| P-11 | 浏览器/可访问性 | 主流浏览器当前/上一版、zh-CN、320px/键盘 | 第7节 |
| P-12 | 旧文与新基线 | 原文差异未核实；新设计起点，不恢复历史 | 第1节 |

决策责任：助手按用户委托制定，2026-09-30；后续变更通过修订记录协调所有消费者，不要求不同Agent重复向用户询问已决定问题。

## 2. MVP闭环命令/事件映射

命令名是逻辑接口名，不是冻结的代码标识。命令信封公共字段：`commandId`、`actorId`（由认证上下文注入，不接受客户端赋值）、`traceId`、`idempotencyKey`（可重试写操作）、`expectedVersion`（适用时）、`payload`。服务端对每个命令做schema、权限、状态和业务校验。

| 步骤 | 命令/读取 | 聚合所有者 | 可能的持久事件/效果 | 重复/失败处理 |
|---|---|---|---|---|
| 注册/登录 | RegisterAccount / CreateSession | Identity | AccountRegistered；会话凭证只回给本人，不发集成事件 | 注册唯一约束；凭证永不日志 |
| 创建角色 | CreatePlayer | Player | PlayerCreated | 每账号唯一角色约束；并发冲突返回409 |
| 加入房间 | JoinQuery / ReserveSeat / ClaimParticipationSlot / ConfirmJoin | Query聚合+独立ParticipationSlot聚合 | ParticipantJoined仅在Query最终确认时产生 | 每步commandId/effectKey幂等；先预留座位、再唯一占槽、再确认；失败前向释放，不跨聚合事务 |
| 探索行动 | SubmitAction | Query | ActionAccepted | 校验参与、阶段、deadline、配额；拒绝不产生成功事件 |
| 截止/推进 | AdvanceQueryPhase（worker命令） | Query | PhaseChanged | 持久deadline任务、expectedVersion；旧任务安全无操作 |
| 投票 | CastVote / ReplaceVote | Query | VoteRecorded（仅内部最小载荷；截止前只本人可见） | 每参与者当前投票唯一；截止后拒绝 |
| 裁决 | ResolveQuery | Query | QueryResolved（不可变内部裁决/结算计划引用） | 只裁决一次；release版本、事实快照与随机种子固定 |
| 结算 | ApplySettlementStep（Saga命令） | Player / Script / Board 各自聚合 | 积分、逐卡创建Script与授予Knowledge、Board各自事件 | settlementId+step+target唯一；永久失败停人工处理，不回滚已成功目标 |
| 终结结算 | FinalizeSettlement | Query | QuerySettlementCompleted（Rules专用内部事件） | Query核对固定计划所有effectKey已确认后，在Query事务内完成并写Outbox；重复无第二事件 |
| 信息传播 | StartSpread / GrantSpreadRecipient | Script 每个授予目标 | SpreadStarted、recipient结果（按隐私策略裁剪） | Script先持久化preparing及spreadOperationId；Social按ID幂等创建/返回同一快照；operationId+recipientId唯一；逐目标恢复 |
| 配置发布 | ValidateRelease / ActivateRelease | Control | ReleaseActivated（仅清单ID/版本/校验摘要，不带秘密配置） | expectedVersion、防并发；审计与激活/Outbox同事务 |
| 投影/通知 | 订阅持久事件、查询读模型 | 各自投影所有者 | 投影版本推进；WS仅提示/公开DTO | Inbox原子去重；丢通知可重取快照/游标 |

说明：聚合修改与技术记录可在该写入的单一数据库事务提交。加入、结算、传播、跨域投影是持久化流程，不能在一个Inbox事务中更新多个业务聚合。事件表中的示例名应在T02按版本规则冻结。

## 3. 公开契约数据字典

以下是必须实现的语义；具体Zod字段结构/穷尽错误schema由T02机械细化，不允许改变本文件和M0决策定稿中的业务选择。

### 3.1 HTTP公共约定

- 基础路径 `/api/v1`；管理路径 `/api/v1/admin`。
- JSON字段camelCase、时间为UTC ISO-8601；整数数值用安全整数，未知字段拒绝。
- 成功写响应包括 `operationId` 或资源ID及 `aggregateVersion`；异步写返回202和可授权查询的操作状态。
- 错误包含 `code`、`messageKey`、`args`、`traceId`；details仅允许安全的字段级校验信息。
- 列表使用不透明签名cursor，默认20、上限50；cursor不构成授权。附加创建/退出/频道/举报/MFA/恢复路由见M0决策第9节。
- 写请求通过HTTP Idempotency-Key头表达重试意图；同key不同规范化请求摘要冲突。
- `bootstrap_pending`仅能建立15分钟受限enrollment会话；其权限白名单严格限于MFA enroll/confirm/status/logout，禁止普通玩家及所有admin路由。confirm须原子启用TOTP/授予首个admin并轮换会话；bootstrap工具与状态不可由公网普通注册API调用。

### 3.2 逻辑请求/响应

| 契约 | 请求字段 | 响应字段 | 不得包含 |
|---|---|---|---|
| SessionView | 无（认证上下文） | authenticated、accountId（已登录时）、expiresAt、csrfToken、mfaRequired | 密码hash、session secret、角色可由客户端编辑 |
| CreatePlayer | displayName、factionId、powerId、professionId、gameplayReleaseId | playerId、displayName、合法配置标识、aggregateVersion | 资源delta、内部审查状态 |
| JoinQuery | queryId | 202 operationId（协调中）或已确认participant状态、queryId、phase、aggregateVersion | 他人秘密知识、任意actor字段；不得将已预留误报为confirmed |
| QuerySnapshot | queryId、可选cursor | queryId、phase、deadline、当前玩家可见行动/投票状态、自己的参与信息、公开参与摘要、release公开版本 | 内部裁决事实、他人私密行动、真伪证据 |
| SubmitAction | actionType、经过schema校验的target/参数 | operationId、accepted状态、aggregateVersion | 权限、资源delta、服务端时间/随机数 |
| CastVote | choiceId（choice_1/choice_2/abstain）、expectedVersion | operationId、本人投票状态、aggregateVersion | 他人未公开投票、可伪造投票人ID |
| KnowledgeList | cursor、受限筛选 | items、nextCursor；每项含scriptId、公开内容、公开来源呈现、receivedAt、玩家可见状态 | isTruth、tampered、hiddenSource、管理员证据 |
| SpreadRequest | scriptId、mode(public/directed)、recipientIds（仅directed）、replacementText（可选） | operationId、status、total/granted/skipped/pending | 未授权recipientIds、外部指定快照、sourcePlayerId、真伪字段 |
| OperationStatus | operationId | status、safe progress、createdAt、updatedAt、可重试/拒绝的messageKey | 其他actor的操作数据、内部错误堆栈 |
| NotificationList | cursor、limit≤50 | 本人通知id、messageKey、已声明args、createdAt、nextCursor | 其他target的通知或完整rule事实快照 |
| BoardSnapshot | 无或版本游标 | boardVersion、公开数值、更新时间 | 尚未批准公开的秘密事实 |
| AdminDraft | configType枚举、key、expectedVersion、经类型校验的内容 | draftId、version、validation状态 | 任意表名、任意代码、未授权配置类型 |
| ReleasePreview | manifest版本、显式测试快照 | warnings、预计效果、拒绝原因 | 任何副作用或真实派发凭据 |

所有资源的对象级授权在服务端执行；私有资源无权/不存在统一404，管理能力不足403。一般房间列表仅公开摘要；所有玩法读请求需认证，匿名只允许认证预会话/登录/注册、静态资源、公开术语和角色选项。

### 3.3 WebSocket

客户端消息 envelope：`requestId`、`type`、`schemaVersion`、`payload`。认证来自已验证同源会话；客户端消息不包含可信actor。服务端ack包含 `requestId`、`status`、`operationId?`、安全错误契约。

MVP客户端消息类型：Subscribe、Unsubscribe、Ping。业务写全部走HTTP；WS不提供行动/投票/传播写入口。Subscribe只能引用会话授权的资源，不能由客户端任意指定内部stream。

服务端消息分为两类：

1. 授权刷新提示：明确resourceType/resourceId/resourceVersion/schemaVersion；只通知当前会话有权读取的对象。
2. 心跳/订阅ack：不作为任何业务完成证明。

MVP不建立持久WS消息历史；缺口/断线统一重新获取HTTP授权快照。内部streamId/sequence不暴露为玩家可读取的事件游标。业务状态、历史和操作结果来自HTTP，不能依赖WS在线性。

## 4. 事件分类和最低载荷规则

| 类型 | 例子 | 载荷最低要求 | 分类/限制 |
|---|---|---|---|
| Account/Identity | AccountRegistered | accountId、schemaVersion | 绝不含密码、session、认证因子 |
| Player | PlayerCreated、ScoreChanged | playerId、effectId、账本/配置引用 | 积分通过变更记录解释；无客户端delta |
| Query | ParticipantJoined、PhaseChanged、QueryResolved、QuerySettlementCompleted | queryId、phase/version、固定release；完成事件内部含selectedCorrect及固定participantIds | QueryResolved/QuerySettlementCompleted只授权Rules等内部consumer；不广播payload、不写普通日志，玩家DTO用显式公开结果 |
| Script | KnowledgeGranted、SpreadProgressed | operationId、target玩家/信息引用、效果键 | 内部事件按权限分流；公开消息只能投影 |
| Board | BoardChanged | boardVersion、变更效果引用、公开数值或投影引用 | 不携带未公开参与者秘密 |
| Control | ReleaseActivated | manifestId、releaseVersion、checksum、actor引用（审计侧） | 不把草稿/秘密内容广播给玩家 |
| 技术/投影 | ProjectionUpdated | generation、checkpoint/stream游标 | 不作为业务领域事实 |

通用事件信封：eventId、type、schemaVersion、source、aggregateId、aggregateVersion、streamId、sequence、releaseVersion、occurredAt、traceId、correlationId、causationId、rootEventId、depth、payload。玩法releaseVersion非null并沿派生传递；认证/平台/术语等非玩法事件为null，规则不得订阅其为玩法输入。派生事件保留root/correlation、causation指向直接前驱；payload独立schema。eventId唯一不等于业务效果幂等。

`QuerySettlementCompleted`由Query模块 `FinalizeSettlement` 命令发出；仅当固定结算计划所有必需积分、逐卡Script/Knowledge授予和Board目标均收到确认引用时，Query在同一事务转completed并写Outbox。payload为queryId、settlementId、gameplayReleaseId、selectedCorrect、participantIds、公开结果引用，Rules可订阅作为事实和通知受众；不发送给客户端/普通WS/公开投影，不将selectedCorrect写入普通日志。目标不完整时Query保持settling，返回可重试错误，重复Finalize不重复发事件。Saga coordinator须将计划与结果引用交给Query公开命令验证，Query不访问其他模块表。

## 5. 模块端口

| 端口 | 所有者 | 使用方/操作 | 原则 |
|---|---|---|---|
| IdentitySessionPort | Identity | Server解析会话/权限 | 由可信cookie/token适配器提供Actor，不暴露凭证给领域模块 |
| PlayerCommandPort | Player | Query Saga：applyScore(effectId, playerId, amount, reasonRef) | 目标模块校验积分范围/账本唯一键；amount只来自服务端裁决契约 |
| KnowledgeGrantPort | Script | Query/Spread Saga：grantKnowledge(effectId, playerId, scriptId, provenanceRef) | 目标模块检查来源与授权；按目标幂等 |
| SpreadAudiencePort | Social | Script以服务端spreadOperationId请求受众快照 | Social持久化operationId唯一的不可变快照；同ID重试返回同快照，不消费；首次持久化为接纳时点；Redis不可用时不建快照；不暴露任意成员表访问 |
| BoardCommandPort | Board | Query Saga：applyDelta(effectId, delta, reasonRef) | Board自身范围/速率/版本校验；不接受客户端delta |
| QueryCommandPort | Query | Server与worker的阶段/裁决/座位预留/加入确认/结算Finalize命令 | Query与ParticipationSlot是不同聚合；端口按聚合命令操作，状态机和唯一槽由Query模块持有 |
| ConfigSnapshotPort | Control | server/worker获取已激活不可变清单 | 读取固定版本；刷新提示可丢失但需轮询收敛 |
| AuditPort | Platform/Control | 管理操作和安全失败 | 成功审计与受保护写入同边界；不向玩家暴露审计内容 |
| DurableOperationPort | Platform | HTTP查询异步操作 | 按actor/权限隔离；不把内部异常返回客户端 |
| DurableSchedulerPort | Platform | 领域模块注册handler并提交dueAt/去重键/非秘密payload引用 | 平台只调度、租约、退避和派发；job schema/取消/到期/幂等语义由领域模块所有，不直接写领域表 |
| Clock/RandomPort | Kernel | Query及规则执行 | 测试可替换；随机种子/输入记录在受限审计上下文 |

端口只传公开契约类型或primitive/value objects；不得传ORM entity、SQL connection或另一个模块的领域对象。

## 6. 权限矩阵

`P`=允许，`O`=仅本人/授权范围，`A`=经审批且具备能力，`—`=禁止。此矩阵不替代对象级授权。

| 操作 | 未登录 | 玩家本人 | 其他玩家 | planner | lead_planner | rule_admin | ops | admin |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 注册/登录 | P | P | P | P | P | P | P | P |
| 查询本人会话/角色/知识 | 仅预会话 | O | — | 本人会话 | 本人会话 | 本人会话 | 本人会话 | 不隐式授予秘密读取权 |
| 查询公开Board/已公开规则/大厅内容 | — | P | P | 需独立玩家身份 | 需独立玩家身份 | 需独立玩家身份 | 需独立玩家身份 | 需独立玩家身份 |
| 加入房间/行动/投票/传播 | — | O | O | — | — | — | — | 不授予隐式玩家身份 |
| 创建/编辑配置草稿/预览 | — | — | — | P | P | 仅规则 | — | 需另授对应角色 |
| 发布术语/内容/白名单管道 | — | — | — | — | A | — | — | 需另授对应角色 |
| 审核/发布设计者规则 | — | — | — | — | — | A | — | 需另授rule_admin |
| 激活/历史激活release | — | — | — | — | 规则变更需checksum审批 | 审批规则，不隐式激活 | 紧急停用仅 | A，不能绕过规则审批 |
| 查看安全审计 | — | — | — | 自身草稿活动可见 | 授权范围 | 规则审计范围 | 运维事件范围 | A |
| DLQ查看/重放 | — | — | — | — | — | — | 授权且逐次审计 | A |
| 修改权限/建立首个管理员 | — | — | — | — | — | — | — | 受控引导，不由普通API自助 |

权限按能力组合，管理角色不相互隐式继承，不自动具有游戏玩家身份。MVP保留规则审核/激活记录，不强制不同账号双人审批；admin不能绕过rule_admin的checksum审批。所有管理角色生产强制MFA；敏感操作5分钟内再认证。

## 7. 数据分类与保留

| 类别 | 示例 | 访问 | 建议处理原则 | 精确期限 |
|---|---|---|---|---|
| 认证秘密 | 密码hash、会话secret | Identity最小范围 | hash存储；秘密不进日志/事件；会话可撤销 | 账号存续；会话结束后24小时清理 |
| 玩家私有事实 | 真伪证据、隐藏来源、知识来源 | 所属聚合/授权执行器 | 与公开DTO分离；授权读取/导出去标识 | 已终结房间90天；知识按存续引用 |
| 集成玩法事件 | 房间阶段、Board变化 | 内部授权consumer | 最小载荷、版本和因果链，不直接供玩家拉取 | 90天，活跃引用延长 |
| 管理审计 | actor、目标、版本、差异摘要 | 管理审计角色 | append-only语义，敏感值脱敏 | 365天 |
| 大厅聊天/举报 | 用户纯文本 | 频道成员/审核角色 | 纯文本、举报、权限控制 | 聊天30天，举报90天 |
| 运行诊断 | 错误/trace/任务失败 | 运维 | 结构化、限量、脱敏，无secret/完整私聊 | 日志14天，metrics30天 |
| 投影/checkpoint | 榜单/快照/游标 | 读模型授权 | 真相表快照+增量重建，不要求永久历史事件 | 按读模型生命周期 |

完整清理/备份/去标识条件见M0决策第6节。这些是工程默认，不是法律合规结论；部署地区、隐私公告及未成年人策略为对公网发布门禁，不阻塞隔离开发。R1私聊须独立审批保留策略，不复用大厅公开策略。

## 8. 技术选择与ADR清单

配套ADR依据用户委托标记Accepted（设计采用），实测和独立评审状态分别记录；Accepted不代表兼容性或安全测试通过：

- [ADR-0001 模块化单体](adr/0001-modular-monolith.md)
- [ADR-0002 Outbox语义（SQL Server实现部分由ADR-0006取代）](adr/0002-postgres-outbox-delivery.md)
- [ADR-0003 跨聚合前向恢复Saga](adr/0003-forward-recovery-sagas.md)
- [ADR-0004 不可变配置与Release](adr/0004-immutable-config-releases.md)
- [ADR-0005 会话身份与规则安全边界](adr/0005-session-and-rule-boundaries.md)
- [ADR-0006 Supabase PostgreSQL](adr/0006-supabase-postgresql.md)

| 决策 | 当前提案 | 需要的验证/记录 | 状态 |
|---|---|---|---|
| 架构 | TypeScript模块化单体；worker独立进程，共享契约 | T01依赖检查 | Accepted设计，未实测 |
| 持久层 | Supabase PostgreSQL为业务真相；平台适配器使用参数化SQL和版本化迁移，不假设ORM支持 | T03 Supabase连接/TLS/事务/迁移验证 | 用户已指定，尚未实测 |
| 消息 | PostgreSQL Outbox→归档/delivery；至少一次+幂等 | T05真实Supabase PostgreSQL故障验证 | 设计已采用，未实测 |
| 配置 | 独立gameplay/glossary激活指针和不可变版本 | T07/T20切换/旧版验证 | Accepted设计，未实测 |
| 认证 | 同源Cookie、CSRF/Origin、Argon2id、管理TOTP | T09/T20安全验证 | Accepted设计，未实测 |
| DSL | 数据AST纯解释器，不运行用户代码 | T17/T18预算/拒绝集 | Accepted设计，未实测 |
| UI | React/Vite/TanStack Query；Zustand仅局部状态按需使用 | T01精确版本及T21浏览器验证 | Accepted设计，未实测 |
| 支持矩阵 | Node.js/Supabase PostgreSQL/Redis为开发目标；兼容最低版本由T01记录 | T01锁定Node/驱动/Redis客户端精确版本并验证兼容/安全通告 | 目标已采用，数据库未实测 |

Node.js/Supabase PostgreSQL/Redis作为首发开发环境。T01/T03确认驱动、连接模式和客户端兼容，选择精确稳定依赖并生成锁文件；审核许可证/安全通告，构建验证后记录兼容清单。PostgreSQL事务/租约/排序/advisory lock语义必须在Supabase实测。

## 9. M0最小风险验证方案（不执行）

所有测试必须在授权隔离环境实施；下列是计划，不代表已运行。

1. **Outbox/Inbox原子性**：真实Supabase PostgreSQL中分别在业务提交前、提交后/确认前杀worker；检查事件和效果最终恰好一次业务影响。
2. **租约与竞争**：两个worker并发领取同delivery，注入超时与租约到期；证明不会永久丢失、业务效果唯一，并观测最老积压。
3. **Saga前向恢复**：每个目标步骤提交后崩溃，重复恢复；逐项比较积分账本、授予凭证、Board账本、Query状态。
4. **规则解释器**：构造属性链/原型/超深AST/超计算预算/未知字段等拒绝集；双worker同root竞争共享预算；断言无动态代码执行。
5. **预览零副作用**：注入所有端口均会失败的测试替身；预览路径成功给出计划但所有副作用调用数为零。
6. **授权与秘密DTO**：跨账户请求知识/操作状态，逐字段检查HTTP/WS/日志序列化；断言不存在内部字段。
7. **配置切换**：激活失败、通知丢失、worker重启、旧Saga恢复；旧操作继续用固定版本，新操作读激活版本。
8. **迁移恢复**：隔离Supabase PostgreSQL项目升级；在非生产快照验证备份恢复和投影重建。

每个验证需记录：代码/迁移版本、环境规格、步骤、输入种子、预期/实测、失败与重试、原始报告位置及评审人。不得仅以mock、单测或“本地看起来正常”替代真实故障验证。

## 10. T00交接与后续验证

- [x] 按用户委托完成P-01至P-12设计决策，制定明确验收向量。
- [x] 确定玩法、对象级授权、会话/MFA、发布和工程保留策略。
- [x] 明确旧文无法核实，不再作为新设计的前置条件。
- [x] 确定模块边界、事务协议、过滤stream前驱、WS快照恢复与版本路由。
- [x] 五份ADR采用设计；运行验证分配给后续任务。
- [ ] 独立文档评审：检查冲突、遗漏、可实现性，不要求先运行未存在的业务代码。
- [ ] T01精确版本/构建/边界检查，T03/T05等真实库验证，按各自门禁留证据。

**T00状态：Review（设计交付完成，独立评审待执行）；T01允许提前Ready建立骨架；T02仍等待T00评审和T01。没有任何运行检查被标记为通过。**
