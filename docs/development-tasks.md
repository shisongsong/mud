# Agent开发任务与交付协议

> 以 [baseline.md](../baseline.md) 和 [M0决策定稿](m0-decisions.md)为准；[数据字典](m0-contract-draft.md)供T02生成可执行契约。用户已授权Node切换、npm依赖安装及本地Git初始化；尚未授权数据库写入或部署。安全拦截不得绕过。

## 1. 执行与完成定义

协调者一次分配一个Ready任务，提供任务ID、允许目录、前置交付与契约版本。默认依赖Done且适用契约冻结才能Ready；仅允许本文件明文记录的门禁例外。

状态：Backlog → Ready → InProgress → Review → Done；歧义/权限/环境/依赖问题转Blocked。实现Agent不能把未评审或未验证任务标Done。

当前：T00 Done（独立只读文档复核未发现阻断，不代表实现验证）；T01 Done（Node 24.10、依赖锁定、格式/边界/类型/构建/测试均通过；SQL Server/Redis服务连通和真实事务语义归T03验证）；T02 InProgress；T03 InProgress（platform及Query/ParticipationSlot表首批已落，领域迁移需真实SQL Server验证）；T04 InProgress（先行UnitOfWork/receipt实现，真实SQL Server语义待验）；T14 InProgress（纯状态机、SQL repository、同事务幂等创建命令和依赖注入HTTP路由已实现首批；尚无真实库、Identity认证接线和Join Saga）。旧文差异无法核实不再阻塞新设计。

实现任务含代码、适用单元/集成测试、错误处理、可观测性和文档；不允许TODO、固定成功值或mock代替验收。T00为设计任务，只需独立文档评审，不要求不存在的代码/数据库测试；兼容性实测归T01、故障实测归T03–T08及后续任务。验证责任不能以“未实测”永久阻塞设计定稿。

每项估算0.5–2开发日；超过2日先拆子任务，不是工期承诺。不同时编辑公共契约/schema/锁文件/根配置/组合根。

### 交接报告

```text
任务ID / 状态 / 负责人：
前置交付和契约版本：
修改目录与文件：
交付物与公开接口：
验收条目与测试证据：
未执行的验证及原因：
契约/迁移/运行方式变化：
剩余风险、阻塞与后续任务：
评审者及结论：
```

## 2. M0：契约与决策

### T00 产品闭环、风险与架构契约（Review；设计已交付）
- 依赖：无；目录：docs，经评审可更新基线中的明确决策。
- 交付：[M0决策定稿](m0-decisions.md)、[数据字典](m0-contract-draft.md)、[威胁模型](threat-model.md)、[首发内容与规则规范](mvp-content-and-rules.md)；五份ADR已采用设计，独立评审/运行验证未执行。
- 交付内容：玩法状态/案例、HTTP/WS/事件数据字典、模块端口、权限矩阵、保留期、技术支持目标和版本验证责任；ADR涵盖单体、可靠交付、前向恢复、发布、认证和规则安全。精确版本实测归T01。
- 决定：行动/投票/掉线/退出、公开受众、初始化管理员、奖励/世界delta、角色组合。
- 旧文：无法逐项核实，不是差异报告；用户授权以v3.1为新设计起点，不再恢复旧文或重复询问已决定项。
- 评审任务：另一Agent只读上述文件和ADR，检查一致性/可实现性/安全/遗漏，输出阻断与非阻断问题；不得执行命令、联网或修改实现。协调者处理评审后标Done，不冒充独立评审已通过。
- 验收：四玩家每一步映射命令/事件/聚合/公开DTO，列失败/重复/权限案例；无隐藏字段泄露或跨聚合事务。
- 非目标：业务实现、安装依赖、自动生成管理员密码。

### T01 工程骨架与检查体系（Done；0.5–1日）
- 依赖：T00设计交付完成（明确例外：不必等独立评审Done，限无业务骨架）；目录：根配置、apps/packages骨架、CI；独占锁文件。
- 版本责任：确认本机Node.js/SQL Server/Redis版本，选择兼容的Node驱动和Redis客户端、锁定依赖与工具链；不预设PostgreSQL/Drizzle。遵循CB策略，不执行被拦截二进制。
- 已落文件骨架：npm workspace根配置、strict TS配置、Fastify API最小存活端点/测试、Zod环境schema（SQL Server/Redis连接参数）。已切换本终端至Node.js 24.10.0/npm 11.6.1。
- 工具链：删除tsx/Vitest，不包含esbuild/Vite依赖；dev使用Node 24原生TypeScript/watch，test使用node:test，生产构建使用tsc。
- 验收记录：npm install成功并生成package-lock；typecheck/build成功，node:test 1/1通过，Node原生TS源码测试1/1通过，npm audit报告0漏洞。此处仅验证骨架，不代表数据库连接或业务闭环。
- 数据库边界：驱动/客户端模块在Node 24可加载，但未连接本机SQL Server/Redis；真实服务版本、连接及SQL语义验证交由T03，未声称通过。
- 剩余环境提示：npm用户配置中`msvs_version`/`python`旧字段仍产生无害弃用警告，不影响安装或检查。
- 成果不含业务空壳页面/默认管理员密码；环境不允许运行时标Review或Blocked并列未验证项，不能Done。
- 验收：骨架构建；禁止内部导入/环的反例测试；无秘密和本机绝对路径依赖。

### T02 Zod契约与Kernel（InProgress；1–2日）
- 依赖：T00/T01；目录：contracts/kernel。
- 交付：事件信封、MVP HTTP/WS/错误、公开端口、Actor/幂等、Clock/ID/随机源。
- 已实现首批：strict Zod HTTP/事件/错误/操作状态/WS schema、内部可信Actor与命令元数据、16–128 ASCII幂等键、规范化输入SHA-256摘要（含循环/非法JSON/64层深度限制）、Clock/UUID/密码学随机源端口；MVP角色/Query/传播/聊天/举报/分页/MFA/管理请求及角色/Query快照/榜单/通知/Board/管理响应schema均已覆盖，WS schema明确无业务写类型。
- 验证：API/契约/Kernel/Query/平台迁移、receipt、Query repository、创建命令和注入式HTTP路由合计38项测试通过；格式、production typecheck/build、边界规则正反例3项及3模块扫描通过。receipt/repository/命令集成仅fake验证；真实数据库事务、Identity认证上下文接线和剩余领域路由仍待实现。
- 补齐：Query创建/leave、排行榜、可靠通知、聊天/举报、MFA再认证、Saga重试、moderation、规则派发状态接口；按M0 G01–G14生成契约反例。WS只订阅/提示/心跳，不新增业务写消息。
- Query纯领域首批已实现：创建者自动入waiting、四人满员固定场景后进入exploring、waiting leave/超时取消、每人两次不同地点私有inspect、固定120/60秒deadline、expectedVersion投票替换、平票choice_1/全弃权null；授权view不返回truth或参与者内部ID。延迟worker跨越多个deadline时每次只推进一个phase，防止跳过voting；过期房间不能leave。SQL Server repository已支持聚合创建/读取/乐观版本保存，读回恢复场景随机种子及私有证据；创建命令与receipt共用一个UoW事务，同Key重放同响应、异请求冲突。POST /queries已通过依赖注入路由实现，缺少trusted Actor会401、严格校验请求及幂等键；生产组合根尚未接入Identity和数据库服务，因此默认app仍只开放health。
- 验收：拒绝伪造actor/权限/真伪/delta字段；公开DTO无秘密；无any和领域框架依赖。
- 冻结点：后端/UI按审查契约并行；变更须协调者审批。

### T03 数据Schema与迁移（1–2日）
- 依赖：T02；目录：platform数据库、迁移、数据库文档。
- 交付：MVP表、CHECK/FK/唯一键/索引、version、账本/授予/任务/交付去重、隔离测试工具及所有权。
- 已先行交付的平台基础：可事务化的迁移器、SQL Server `sp_getapplock` 跨进程互斥、迁移历史/顺序保护；首个SQL Server migration建立命令receipt、Outbox stream/event、delivery（租约/fencingToken/前驱）、Inbox generation去重及审计表。通过 `npm run db:migrate --workspace=@mud/api` 显式运行；连接凭据仅从环境变量读取，缺少用户名/密码会安全失败，不会在API启动时自动改库。
- 验证：迁移器4项测试通过，覆盖一次性应用、迁移历史缺口/乱序、事务失败不落历史和迁移ID校验；Query repository增加fake测试覆盖聚合创建/重载、版本CAS和UTF-8种子二进制存储；整体格式/类型/构建与38项测试通过。尚未对本机SQL Server执行迁移，T-SQL及并发锁/事务语义未宣称通过。
- 并行例外：先行platform通用持久层后，已追加Query/ParticipationSlot首批表；其余领域schema继续受契约门禁约束。
- 已新增Query/ParticipationSlot schema：房间版本/阶段约束、已确认玩家唯一占用槽、Join预留过期索引、每人每地点唯一/最多两次行动、私有卡和投票表；仅写入migration文件，未在SQL Server执行。
- 补齐：Social按spreadOperationId幂等受众快照/举报/禁言记录、Identity禁用/MFA凭据/bootstrap_pending会话状态、初始release种子、发布checksum审批、投影generation；不建R1资源空表。
- 验收：空库迁移及bootstrap gameplay/glossary种子幂等激活、重复运行不覆盖已激活版本；NULL作用域、重复效果、负资源、越界世界值、并发版本冲突的真实库测试；不建R2空表。
- 独占schema：模块需要变更时由本任务负责人追加迁移。

## 3. M1：可靠平台

### T04 事务、命令幂等和审计（InProgress；1日）
- 依赖：T03；目录：platform事务/幂等/审计。
- 交付：UnitOfWork、receipt、expectedVersion、事务内成功审计与失败安全审计端口。
- 已实现首批：SQL Server SERIALIZABLE UnitOfWork；receipt按actorScope+operation+key获取事务级sp_getapplock，同摘要重放已存响应、异摘要冲突；业务handler和成功receipt共用事务，失败回滚。4项测试验证重放/冲突/失败原子性/输入校验（transaction fake）。
- 限制：认证可用性/对象授权必须在调用receipt前重验；真实SQL Server锁竞争、唯一键和rollback集成测试未执行。该通用逻辑先行开发，T03数据库验证门禁仍保留。
- 验收：同key复用、不同内容409、并发一次提交；业务+receipt+Outbox+审计一起回滚；日志无凭证。

### T05 持久化事件交付（1–2日）
- 依赖：T04；目录：platform消息、worker基础。
- 交付：Outbox租约、归档/delivery、Inbox原子消费、退避、DLQ、顺序缺口、显式回放。
- 定稿协议：stream归档游标、订阅子集前驱、fencingToken/30秒租约/10秒续租；DLQ阻塞同consumer同stream后继，重放不换eventId，具体参数见M0决策第8节。
- 验收：归档/消费前后崩溃、重复、租约过期、回滚、乱序无丢失/重复效果；新消费者不自动回放；真实库故障注入，不能只有内存EventBus测试。

### T06 持久任务与Saga恢复（1–2日）
- 依赖：T05；目录：platform任务/Saga、worker注册。
- 交付：通用层只实现dueAt、租约、退避、job去重、handler注册与调用；领域模块持有job类型/schema、handler命令、取消/到期语义及幂等规则；Saga实例/步骤状态、逐target效果键、前向恢复/永久失败处理。
- 验收：重启恢复逾期任务；完成后重试不重做；平台不能接受未注册handler/写领域表；领域handler可验证schema、取消/到期语义及幂等；保留版本/步骤结果；不恢复旧积分覆盖新变更。

### T07 配置版本、发布和纯预览（1–2日）
- 依赖：T04/T05；目录：modules/control。
- 交付：草稿并发、不可变版本、manifest、依赖校验、激活/历史激活、审计、快照、纯预览。
- 定稿协议：gameplay/glossary独立激活指针，含规则manifest checksum审批；新命令版本精确匹配，不带旧快照接纳新操作。
- 分阶段能力：空库种子幂等激活无规则`gameplay_bootstrap_v1`与`glossary_bootstrap_v1`且不覆盖现存指针；缺玩法清单时玩法写503 `GAMEPLAY_NOT_READY`。M1发布术语/内容/固定管道基础清单；规则草稿可存储但激活规则清单必须安装T17语义校验器后才能通过，未安装时明确拒绝，不用“稍后再验证”占位。T17可在T07后并行，T25负责首发完整规则发布。
- 验收：无效依赖拒绝；激活/Outbox/审计原子；失败保留旧版；预览零写/通知/任务/外部I/O。

### T08 术语、模板与种子（1日）
- 依赖：T07；目录：control术语、content。
- 交付：作用域/locale回退、name/description/metadata接口、受限模板、限频告警、幂等种子。
- 内容输入：导入trial_1两个可推理变体；rule_1仅草稿种子，T17/T18后由T25验证激活。不能随机生成不可解卡片或未能执行的活跃规则；AST schema由T02/T17共同遵循。
- 验收：优先级/回退全排列、缺失key、XSS安全、种子不覆盖已发布内容、中性ID。

M1门禁：T01–T08评审通过，可靠交付/任务恢复/失败发布/零副作用有证据；禁止各业务模块再临时自建消息和幂等系统。

## 4. M2：后端闭环

### T09 身份、会话与授权（1–2日）
- 依赖：T04/T08；目录：identity、server认证。
- 交付：注册/登录/注销/会话、Argon2id、Cookie/CSRF/Origin、权限来源、限流、受控管理员初始化。bootstrap创建无admin权限的bootstrap_pending身份及15分钟受限HttpOnly enrollment会话；只允许MFA enroll/confirm/status/logout；确认时原子启用TOTP、授予admin并轮换会话，逾期仅维护模式可撤销重开。
- 子任务拆分：T09a账号/预会话/CSRF/会话轮换；T09b管理TOTP/恢复码/再认证/受控bootstrap/禁用撤销；共享Identity schema由T03负责人合并，不在一次2日估算内掩盖额外安全工作。bootstrap_pending会话仅可调用enroll/confirm/status/logout，不能调用普通玩家/admin API；TOTP确认与初始admin授予原子提交并轮换会话。
- 验收：会话轮换/到期/注销、账号枚举防护、越权/CSRF拒绝；bootstrap_pending过期/越权路由拒绝、MFA确认原子激活admin并轮换会话；无URL凭证/默认管理员密码。

### T10 玩家、角色与积分账本（1–2日）
- 依赖：T09/T05/T08；目录：player。
- 交付：单账号角色、组合验证、version、积分账本、结算公开端口/事件。
- 按定稿：72组合纯展示，初始1000，rank阈值/积分上限/夹取账本；角色事件驱动Social成员加入。
- 验收：并发创建一次，非法组合拒绝，重复结算无重复积分，段位边界正确。

### T11 信息与知识（1–2日）
- 依赖：T09/T05/T08；目录：script核心。
- 交付：Script、每玩家知识、授予凭证、授权查询、秘密/公开DTO、获得事件。
- 验收：无权限不可查，多来源保留，重复授予幂等，公开响应/日志/WS无真伪/隐藏来源。

### T12 可恢复传播（1–2日）
- 依赖：T11/T06；成员接口按T02，最终联调等待T16。
- 目录：script传播。
- 交付：公开/定向/篡改流程、授权受众快照、逐接收者状态、进度与恢复。
- 定稿：public/directed+replacementText正交；Script先持久化preparing operation并由服务端生成spreadOperationId，再向Social请求按该ID幂等创建/返回同一快照；崩溃重试不得重新采样。快照由Social生成，客户端不能指定；skipped目标、总量/权限拒绝、Redis不可用行为有集成测试。
- 验收：伪造来源拒绝；篡改新信息；处理一半后重启最终正确；重复不多授予；公开结构一致。

### T13 世界与投影（1日）
- 依赖：T05/T08；目录：board、platform公共投影机制。
- 交付：0–100值、变更账本、投影/checkpoint/重建，Player资料与榜单适配经其负责人审查。
- 验收：重复不变数值、越界拒绝、顺序缺口处理、重建与正常结果一致。

### T14 试炼状态机与裁决（InProgress；1–2日）
- 依赖：T10/T06/T08；目录：query状态机。
- 交付：房间/成员/行动/投票、deadline、固定release/随机种子、不可变裁决和计划。
- 子任务：T14a房间/创建/退出/独立ParticipationSlot协调/超时；T14b探索卡/匿名投票/变体与确定性裁决。Join必须持久化执行预留房间座位→独立占槽→确认成员，不跨聚合事务；只有四位确认才开始，恢复/超时可释放预留。执行M0 G01–G06、G09；源信息卡留Query，不能行动事务改Knowledge。
- 当前交付是可测试的纯Query状态机；持久化适配器/Join Saga协调/HTTP端点与内容种子尚未完成，不表示T14子任务完成。
- 验收：四人探索/投票；同一玩家并发加入两房间及每个Join步骤崩溃/重试不双占、可安全释放预留；重复/平票/缺席/退出/逾期符合T00；重启不重抽。

### T15 结算Saga（1–2日）
- 依赖：T10/T11/T13/T14；目录：query结算、组合根适配由负责人合并。
- 交付：逐玩家积分/信息、Board delta、固定计划effect确认引用、pending/failed/retry；Saga将完整effectKey/结果引用提交Query，Query不得访问其他模块表；全目标确认后FinalizeSettlement由Query校验并事务性完成/Outbox发布仅供Rules的QuerySettlementCompleted。内部payload的selectedCorrect不得进入客户端、普通WS、公开投影或一般日志。
- 补齐：每张已探索卡先幂等创建/复用Script，再单独授予Knowledge，步骤键包含cardId；0奖励目标仍有确认结果，不凭是否有账本猜完成。
- 验收：每步骤后崩溃均可恢复；并发无重复奖励；永久失败可定位，不提前completed；不读写其他模块内部表。

### T16 大厅与受众（1日）
- 依赖：T09/T10/T05；目录：social。
- 交付：频道/成员/纯文本消息/限频、传播受众端口。
- 子任务：T16a事件驱动大厅成员/消息；T16b按Script提供的spreadOperationId幂等持久受众快照/在线适配，同ID重试返回同快照、不消费；T16c举报、Social禁言与Identity禁用公开命令协调。禁用不允许Social直接写Identity表。
- 验收：非成员不可读发、输入不执行、受众符合T00、隐藏信息不泄露。

M2门禁：T09–T16完成，公开端口四玩家闭环、传播/世界变化、故障恢复全部有证据；不需前端也能验证业务。

## 5. M3：规则与界面

### T17 安全DSL和效果能力（1–2日）
- 依赖：T02/T07，可与M2并行；目录：rules DSL/声明。
- 交付：AST解析/类型、字段/纯函数白名单、预算、能力矩阵、设计者schema。
- 明确范围：结构化JSON AST、比较/布尔/注册字段；不开发自由文本DSL或通用函数库。首发三种效果和目标/冷却/额度详见内容与规则规范，不实现积分增发或支付效果。
- 验收：拒绝原型访问/任意属性/动态代码/未知事件效果/过大AST，无eval/Function，固定输入确定。

### T18 持久规则执行和预算（1–2日）
- 依赖：T17/T05/T06/T15；目录：rules执行，worker组合负责人合并。
- 交付：版本/事实快照、execution、逐效果命令、共享预算/cooldown、去重、失败隔离/停用。
- notify可靠结果由RuleExecution子效果保存，提供仅本人授权GET /notifications；WS不承载唯一消息，重试按execution/effect/target去重。不跨事务批量修改所有Player。
- 验收：循环终止，两worker不越根预算，partial重试无重复，单规则失败隔离，不访问其他模块表。

### T19 HTTP/WS接入（1–2日）
- 依赖：T09–T16，规则通知等待T18；目录：server。
- 交付：MVP路由/OpenAPI/错误/幂等、消息授权/ack/心跳/背压、序列和快照恢复。
- 具体选择：HTTP所有写，WS只提示resourceVersion/订阅/Ping；缺口/重连读HTTP快照，不建立持久WS历史，不暴露内部event_store给玩家。
- 验收：契约一致，过期/Origin/IDOR拒绝，断线恢复，通知丢失不丢业务，HTTP/WS同服务。

### T20 管理API与热更新（1–2日）
- 依赖：T07/T08/T09/T18；目录：server管理、control接入。
- 交付：草稿/验证/预览/发布/历史激活、审计/DLQ授权重放、版本提示/收敛。
- 补齐：管理MFA再认证接入、checksum审批、ops Saga只重试固定payload、举报处理/禁言/账号禁用公开命令、全版本规则派发暂停；按功能拆子任务，不能用通用任意表编辑API。
- 验收：角色越权矩阵、必需步骤不可关、Redis提示丢失恢复、旧试炼/Saga固定旧版、重放审计。

### T21 玩家UI共享层（1日）
- 依赖：T02/T08，可先契约测试服务；目录：player-web共享。
- 交付：布局/路由、术语hooks、会话/查询、WS客户端、OperationStatus/日志/指令、移动与键盘。
- 可靠通知从GET /notifications获取，仅本人可见；WS刷新丢失/重连后重新获取，LogStream不冒充通知的持久存储。
- 验收：系统文本术语化，缺失可见，pending/重连明确，滚动可暂停，不存长效token。

### T22 登录、角色、大厅/世界UI（1–2日）
- 依赖：T21，真实联调等待T19；目录：对应player-web页面。
- 交付：认证/三步角色/频道/房间列表/角色/世界/榜单。
- 验收：过期恢复、合法组合、术语热更新、移动可用，不用前端按钮代替服务端授权。

### T23 试炼、知识/传播UI（1–2日）
- 依赖：T21/T19/T12/T15；目录：对应player-web页面。
- 交付：deadline/行动/投票/结算状态/知识详情/传播弹窗与进度。
- 验收：四上下文，重复点击无重复效果，断线恢复，无内部秘密，指令/按钮一致。

### T24 管理UI（1–2日）
- 依赖：T20；目录：admin-web。
- 交付：登录、术语/内容/规则编辑、校验/预览/发布/历史、审计/DLQ/应急状态。
- 补齐：MFA设置/再认证、规则审批与激活差异、报告审核、Saga pending/恢复界面；大于2日拆T24a配置发布/T24b安全运维，不省略权限测试。
- 验收：schema错误定位、草稿冲突、预览和真实执行区分、敏感确认、权限一致。

M3门禁：T17–T24真实后端联调，规则循环/安全输入/术语热更新/旧房间版本保持有自动测试。

## 6. M4：验证与上线准备

### T25 内容与四玩家E2E（1–2日）
- 依赖：M3；目录：content、tests/e2e、验收报告。
- 交付：首发试炼/信息/规则、四玩家与管理员发布/传播验证。
- 验收：MVP条目映射测试ID；不同探索投票影响结果，不固定成功；种子幂等/中性文本。

### T26 故障、安全与负载（1–2日）
- 依赖：T25；目录：tests、验证报告。
- 交付：重复/乱序/worker崩溃/Redis断开/DB暂时错误、CSRF/Origin/IDOR/XSS/秘密测试；100连接20房间15分钟结果。
- 验收：正确性无损，跨worker预算，SLO百分位/积压恢复原始证据，pending而非虚假成功。
- 限制：仅授权隔离环境压测，不对生产/未知目标执行。

### T27 运维、备份恢复与评审（1日）
- 依赖：T26；目录：docs运维/验收，部署配置需许可。
- 交付：初始化/发布/升级/回退/DLQ/Saga/告警/保留期/恢复手册与演练，未完成项。
- 验收：新环境恢复并验证账本/知识/版本；所有MVP条目有证据或未通过说明；协调者决定发布。

## 7. R1：MVP之后

| ID | 任务 | 依赖 | 交付与专项验收 |
|---|---|---|---|
| R01 | R1契约与资源协议 | T27 | 私聊/交易/契约/同意/反馈，resource_1预留/扣除/释放和去重；迁移负责人合并 |
| R02 | 私聊 | R01 | 授权/限频/保留/恢复，第三人不能读收 |
| R03 | 信息交换交易 | R01/T11 | 双方持有和同意、双边授予流程；超时/重复/半完成恢复，暂不复杂货币市场 |
| R04 | 资源预留和契约执行 | R01/T10/T18 | 双人定额、预留/扣除/释放Saga，并发契约不超支/资源守恒 |
| R05 | 玩家规则审核/同意 | R04/T20 | 模板/审核/逐人同意/撤销/到期，不能增发/改世界/冒充系统，升级重新同意 |
| R06 | 信息嵌入规则 | R05/T11 | 引用ruleId+version，独立接受，阅读不激活，篡改不继承授权 |
| R07 | 即时和延迟反馈 | R01/T18 | 滞回/cooldown/作用域、持久任务；并发一次、重启恢复、取消/版本策略 |
| R08 | 涌现记录与UI | R05/R07 | 结构化证据/公开投影/审核，不泄密可追溯，不宣称自动识别策略 |
| R09 | R1门禁 | R02–R08 | 守恒/撤销/延迟/私聊/契约故障E2E，评审通过发布 |

实施前每项拆为0.5–2日子任务：契约→后端→UI→故障验证，不同时扩展多类玩家规则。

## 8. R2：R1之后

| ID | 任务 | 依赖 | 交付与专项验收 |
|---|---|---|---|
| E01 | R2契约/统计定义 | R09 | 组织/仪式/策略、元规则窗口、识别候选/审批、评估集 |
| E02 | 组织/仪式/策略模板 | E01/R05 | 有限能力/成员权限/到期，模板组合预算，无权限泄漏 |
| E03 | 赛季与元规则 | E01/R07 | 分母/最小样本/去重、待审批变更与生效；重复切换/回滚/权限测试 |
| E04 | 确定性识别 | E01/R08 | 计数/fingerprint/算法/证据/审核，合成集召回与误报，失败不影响玩法 |
| E05 | 可视化管道/依赖图 | E01/T24 | 白名单拖拽/依赖/必需步骤，不能关授权/幂等，旧Saga不受影响 |
| E06 | 多语言和质量门禁 | E02–E05 | locale编辑/回退、R2 E2E/SLO回归/隐私评审 |

## 9. 并行与所有权

```text
T00 → T01 → T02 → T03 → T04
                          ├→ T05 → T06
                          └→ T07 → T08
T09后：Player(T10)、Script(T11)、Board(T13)、Social(T16)可并行
Query(T14)等Player；结算(T15)等Player/Script/Board/Query
DSL(T17)可先并行；执行(T18)等结算与平台
UI(T21)按冻结契约先行；真实联调等T19/T20
M3 → T25 → T26 → T27 → R1 → R2
```

依赖例外仅T01无业务骨架；不代表M1业务验证已通过。T00独立评审与T01可并行，但T02前二者需达到Done。新增P决策已定稿，不是等待用户确认的阻塞。

建议角色：协调/契约、平台、分模块领域、玩家UI、管理UI、测试评审。一人可多角色，但不得并行改共享文件。

公共契约/schema/锁文件/根配置/server和worker组合根指定单负责人。模块Agent提供变更申请/注册代码由负责人合并。接口变更先说明兼容/事件版本/迁移/影响任务，再通知所有消费者。

## 10. 可直接交给Agent的模板

```text
任务：<ID和标题>
允许目录：<对应目录>
前置交付与冻结契约：<链接/版本>

先阅读baseline.md、docs/development-tasks.md及相关ADR。
只实现当前任务，不扩展后续版本，不改安全/事务/版本不变量。
实现交付物及全部验收项，提供真实测试证据。
共享契约/schema/锁文件/组合根变更交协调者，不跨范围修改。
只在获准工作区操作；命令、安装、网络、Git和部署遵循环境许可。
安全拦截即停，不绕过；未运行验证如实标记。
按交接报告返回，未经评审不自称Done。
```

计划版本：v1.1 · 日期：2026-09-30