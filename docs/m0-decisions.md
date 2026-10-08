# M0 决策定稿 v1.0

> 日期：2026-09-30。用户已授权助手代为决定产品与架构设计。本文件是MVP实现的规范性决策，不是测试、合规或独立评审通过的证明。
>
> 优先级：基线不变量 → 本文件的具体决策 → M0契约数据字典 → T02可执行schema。发生冲突须修正文档，不允许实现Agent自行选择。变更须有版本、原因、受影响任务和兼容方案。

## 1. 授权边界与设计门禁

- P-01至P-12由本文件决定，不再要求用户逐项选择；商业世界观继续中性化。
- 原始v2不可核实，不再作为开发阻塞；保留“非原文差异报告”的说明，以当前v3与本文件作为新设计起点，不恢复或覆盖历史文件。
- T00设计交付及独立只读文档评审完成，无剩余阻断；实现与运行验证未执行。允许T01先建立无业务骨架，属于明确的依赖例外；T02仍等T01验证后Ready。
- 文档评审不要求运行数据库；类型/构建/兼容性/故障验证由其实现任务和阶段门禁承担。不能用未来测试要求永久阻塞当前设计任务。
- 初始授权仅含设计/文档；用户随后明确授权切换本机Node版本和安装项目依赖。不得操作Git、写入数据库或部署。CB拦截不绕过：已移除触发esbuild.exe执行的非必需dev/test工具依赖后，npm安装成功。

### 本机运行环境适配（T01）

- 用户指定以本机Node.js、SQL Server和Redis为开发环境；替换旧提案中的PostgreSQL/Drizzle假设，不改变模块化单体、单聚合事务、Outbox/Inbox、至少一次投递、幂等效果和Saga前向恢复语义。
- Workspace使用随Node.js提供的npm workspaces；应用保持TypeScript strict，API采用Fastify/Zod。SQL Server以Node驱动及平台参数化T-SQL适配器访问；Redis只经独立基础设施适配器使用。
- SQL Server通过平台自有连接/事务与参数化T-SQL仓储访问；数据库迁移采用版本化SQL。具体SQL Server版本、Node驱动、Redis客户端、隔离/RCSI及租约领取语义须在T01/T03真实环境验证，未验证前不得宣称兼容或强一致。
- 本次环境说明授权按该技术栈编写代码；不等同于运行安装命令、访问网络、操作Git或修改本机数据库的许可。遇CB拦截立即停止，不绕过。

## 2. 首发玩法（P-01至P-04）

### 2.1 房间和参与约束

- 单世界，首发模板 `trial_1`；固定4人。创建者自动加入，第四位确认参与的玩家触发 `waiting → exploring`，固定参与者集合、release、场景实例及内部随机种子。
- 只有已认证且有角色的玩家可创建/加入。每玩家最多一个未终结房间，由Query模块拥有的 `ParticipationSlot` 独立聚合及DB唯一键保证；不依赖Player投影或跨聚合事务。
- Join为持久化协调：Query在房间聚合事务预留座位（容量按confirmed+reserved），再向ParticipationSlot按playerId唯一占槽，最后Query确认参与者/释放预留。只有4人确认才开始。竞争失败/中断通过幂等前向恢复释放占用；5分钟等待deadline回收预留。`settlement_failed`保留槽。
- 创建及加入均幂等；创建后等待上限5分钟，未满4人自动取消，无奖励。waiting阶段可离开；空房立即取消。创建者离开不取消其他人的房间。
- exploring为120秒，voting为60秒；没有提前全票结束，允许最后期限前改票。探索阶段始于持久化开始时间，投票截止为探索deadline+60秒；worker延误不偷偷延长玩家时限。
- 收到命令后获取Query行锁，再读取服务端Clock；只有 `now < deadline` 才接纳。边界 `now = deadline` 已截止。数据库事务获得锁之前的客户端时间无效。
- exploring开始后不能退出成员集合/更换玩家；掉线不暂停时钟。可关闭页面，重连恢复；waiting以外的leave返回422 `QUERY_ALREADY_STARTED`。完成/取消释放参与槽，settlement_failed保留槽以防错误放行。
- 长时间失败由ops通过显式恢复计划处理；不提供“跳过奖励并完成”按钮。需要解除参与槽时，须新增记录明确效果状态和安全后续处置的终止协议，MVP不自创此协议。

### 2.2 探索与信息博弈

- 两个公开候选 `choice_1` / `choice_2`，三个探索位置 `site_1`…`site_3`。每玩家最多执行2次 `inspect`，同一位置最多一次；拒绝未知动作/位置，不提供任意目标表达式。
- 每次探索生成该玩家私有的文字证据卡和稳定cardId；结果保存在Query自身，返回可授权正文，不修改Script/Knowledge。卡片可支持/反对某候选，所有人不一定获得相同信息。
- 开始时从发布模板的至少两个受控变体中选一份，固定正确候选、各位置/玩家证据分配和内部可信标记；变体选择使用记录的服务端种子。管理员种子测试可复现，但种子和可信标记不公开。
- 每个变体必须使两个不同位置的证据组合能推理出正确候选，至少有一张可信与一张具有误导性的卡；证据是否足以推理必须以明确答案表与人工内容评审验证，而非只靠随机概率。
- 玩家可在大厅交流其推断；试炼私有卡在结算完成前不能通过script传播接口传播，因为尚无Knowledge持有凭证。任何复制到聊天的内容仅是玩家自述，不成为系统认证证据。
- 裁决后，将各玩家已探索卡片逐张生成/复用Script，再授予其Knowledge。Script创建与Knowledge授予是分开的幂等步骤；卡片实例键 `queryId+playerId+cardId`。没有探索则不授予卡片。
- 职业/阵营/存在首发只作身份选择与展示，不影响行动配额、可信度或资源；避免首发平衡层掩盖闭环问题。六职业差异化能力在单独范围变更后开发，不偷渡进任务。

### 2.3 投票与裁决

- voting中每玩家可提交/替换 `choice_1` / `choice_2` 或显式 `abstain`；没有投票视同弃权。本人当前投票可见，他人选择与票数在截止前不公开；参与列表不泄露他人是否已投票。
- 截止后按两候选有效票计数，多数胜。平票且至少一票时按模板稳定choice顺序选 `choice_1`，规则提前向玩家展示；全弃权则selectedChoice为null。
- 公开裁决展示候选票数、弃权数、selectedChoice、正确候选及已公开解释，不公开逐玩家选票或其私有证据。正确候选仅裁决后揭示；不把它伪装为信息永久真伪鉴定能力。
- worker可在now超过两个deadline时按合法迁移依次补齐探索截止和投票截止；停机期间来不及投票视为弃权，记录服务故障，不补写玩家行动。开发环境可注入Clock，不让用户指定服务端时间。

## 3. 积分、世界与身份配置（P-06、P-07）

- 初始1000积分，整数范围0…1,000,000,000；五段位下限依次0、1000、1500、2000、3000，按最高满足下限确定。资源 `resource_1` 为R1可消费账本，MVP不创建余额/预留空实现。
- 本轮至少一次有效探索或投票（包括显式弃权）获得5参与分；本人的最终候选投票等于正确候选时另得20分。未行动且未投票者0分；掉线不取消已取得的有效参与资格。
- 奖励由固定裁决计算，不随机抽奖，无首发扣分；即使多数选错，正确少数仍获得答对分。加分达到上限时记录requested/effective/clamped，实际增加值不能突破上限。
- selectedChoice正确时tension请求-2，错误时+2，全弃权+1。每种本轮至少有一位有效参与者的阵营，请求该阵营strength+1，一场每阵营至多一次。
- Board初始tension=50，六阵营strength各50，各自0…100独立强度；在Board写事务将请求delta夹到范围内，并在账本同时记录requested/effective与夹取原因。不是六项总和100的比例。
- 一场结算对Board只提交一个固定delta向量；不同房间的账本顺序由Board锁/版本控制。顺序导致夹取差异属于明确语义，账本可解释，不承诺跨房间时间全序。
- 六阵营 `faction_1`…`faction_6`、两存在 `power_1`/`power_2`、六职业 `profession_1`…`profession_6`。全部72组合合法；配置禁止发布“选择后无可用组合”的角色选项。
- 身份组合MVP创建后不变，不做重置/转职/多角色。昵称2–20 Unicode码点，NFC规范化；允许重名，用公开UUID区别，禁控制字符/双向控制符，纯文本输出。

## 4. 传播和大厅（P-05）

- 唯一公开大厅 `lobby_1`，持久成员由Social管理；角色创建后异步幂等加入。尚未加入时发送/传播返回可重试pending，不跨Player事务写Social。
- 在线定义为Redis记录存在且30秒内有成功认证心跳。在线数据只是受众策略，不是奖励持久来源；Redis不可用时公开/定向新传播503，已接纳任务继续处理持久快照。
- Social以内部传播operationId幂等创建不可变AudienceSnapshot（含actor、channel、合法成员ID集合、policyVersion、capturedAt），成员检查使用Social真实状态，在线是近似快照；同operationId重试返回同一快照，不作一次性消费。
- 传播先持久化preparing operation，再请求Social快照；“受众接纳时点”定义为快照首次持久化的时间，之前UI明确显示preparing且无收件人已确定。快照保存后Script记录引用/recipient set并继续逐目标Saga；崩溃重试同operationId恢复同一快照。Redis不可用时不建快照、operation可重试。
- Actor不能指定snapshotId/operationId读取他人数据；operationId由Script服务端创建，Social端口仅接受内部服务身份。被引用快照保留到operation终结；孤立快照7天清理。
- 公开模式面向快照内除发送者外的全部在线成员，上限100；超限整次422，不悄悄截断。定向模式最多10人，必须为同大厅在线合法成员；任何候选无权限，整次拒绝且不泄露具体原因。
- MVP无玩家屏蔽系统；提供举报和管理员禁言/停用，禁言不能通过传播绕过。收件人在发送后离线不会撤销已接纳的授予；授予前检查当前账号是否禁用/删除，被禁用目标记skipped，不无限重试。
- public/directed与是否改写正文是正交字段：`mode`、`recipientIds?`、`replacementText?`。replacementText存在即生成新Script；正文1–2000码点纯文本，保存隐藏来源链，不向玩家返回tampered等字段。
- 传播只转发已持有信息，不做所有权转移、不移除源知识。授予允许多来源，不使用“读到消息”等价于拥有知识。
- 单账号传播10次/分钟，聊天30条/分钟、正文1–500码点；超限429并给Retry-After。无收件人时422；重复幂等重试不再次计数或重新采样受众。
- 操作状态可向发起者显示total/granted/skipped/pending和安全错误键，不显示非授权收件人账户情况；终态completed允许skipped>0，partial_failed表示永久错误，必须分别解释。

## 5. 术语、配置和发布（P-08）

- 历史日志冻结当时可见文本及glossaryVersion；动态界面保存key+args，按当前术语重渲染。不能通过术语显示名反转tension的业务方向。
- 空库由幂等系统种子先创建并激活`gameplay_bootstrap_v1`（无规则，提供认证后角色/玩法服务所需的基础选项）和`glossary_bootstrap_v1`，不覆盖既有指针。无玩法清单时只开放认证、bootstrap、公开术语/静态选项，玩法写返回503 `GAMEPLAY_NOT_READY`。
- 独立激活指针 `gameplayReleaseId` 和 `glossaryReleaseId`。房间创建时固定gameplayReleaseId，开始时生成具体变体；术语即时更新。创建角色要求提交获取选项时的gameplayReleaseId，已不激活则409重新获取，避免旧选项静默创建。
- 所有新根命令读取数据库激活指针，再确认本地有该精确快照；未装载时503，不拿旧快照接纳新命令。worker/server每5秒检查指针，提示仅加速收敛。
- 在途玩法命令/事件/Saga保留原gameplayReleaseId；不能因为重试读取最新规则。认证/平台/术语激活等非玩法事件的releaseVersion显式null，不能因为没有gameplay版本无法首次bootstrap；规则仅订阅有非null版本的玩法事件。紧急停用是版本外持久化开关，覆盖所有版本，已提交效果不撤销。
- 清单及正文不可原地覆盖；仍被房间/Saga/任务引用的版本不清理。MVP保留所有已发布配置，R1再在引用安全证明后引入版本清理。
- 内容/术语由lead_planner验证发布，设计者规则由rule_admin审核并发布。纯内容/术语激活允许lead_planner；含规则变更的gameplay release需要rule_admin批准manifest checksum后，由lead_planner或admin激活。内容变更不得悄悄改规则引用。
- admin管理角色和基础设施，不自动获得planner/rule_admin/玩家数据阅读权；初始管理员可经审计授权给自己相应角色，但发布审批不能用admin身份绕过。MVP不强制双人审批，保留独立审批记录，生产升级可强制不同账号。
- ops可暂停规则派发、恢复已审核流程、重试已批准死信；不能改奖励、导出秘密或激活新配置。恢复规则必须先完整校验固定版本，记录安全审计。

## 6. 认证、管理和上线策略（P-09、P-10）

- 同源部署；不提供MVP跨源CORS。TLS生产强制，Cookie `__Host-mud_session`、Secure、HttpOnly、SameSite=Lax、Path=/、不设Domain；本地隔离测试使用单独cookie名/配置，不能把不安全选项带入生产。
- 用户名3–32 ASCII字母/数字/下划线，按小写唯一；密码12–128 Unicode码点、最多512 UTF-8字节，不裁剪/不偷偷截断，不记日志，MVP不要求邮箱/短信。密码恢复MVP不提供自助，运营只支持受控处理，不能向任何人显示原密码。
- Argon2id最低m=64MiB、t=3、p=1，运行时基准调整只能增强或另提安全变更；密码哈希单独限流/并发池，失败返回统一AUTH_INVALID_CREDENTIALS，不泄露用户名存在性。
- 玩家会话idle 24小时、absolute 7天；有管理角色会话idle 15分钟、absolute 8小时。权限提升、登录、密码/MFA变更轮换会话；注销和账号停用立即撤销会话/WS。
- 所有状态改变请求（含登录/注册/注销）校验Origin与会话绑定CSRF；匿名预会话通过GET /auth/session建立，返回csrfToken但不返回session secret；登录后重新生成。GET不承担业务写，预会话是认证技术记录。
- WS使用SameSite cookie握手，精确Origin白名单；每条消息重新校验会话/成员/权限。握手后60秒重新认证状态，失效或超过absolute立即关闭；敏感管理操作要求5分钟内密码+MFA再认证。
- 生产管理角色强制TOTP MFA，恢复码只存hash，一次性使用；不在聊天/模型里采集密钥或恢复码。首个MFA引导不得自锁：bootstrap工具创建唯一`bootstrap_pending`身份，不授予管理角色，并建立15分钟、绑定该accountId、仅允许MFA enroll/confirm/status/logout的受限HttpOnly会话；普通/admin API一律拒绝。TOTP确认后同一事务启用MFA并授予初始admin，再轮换为正常管理会话；过期未完成只能由维护模式撤销后重新引导。日志不得记录seed、恢复码或session凭证。
- 生产域名由部署环境 `PUBLIC_ORIGIN` 提供，不编造实际域名；未配置HTTPS origin拒绝生产启动。管理入口通过反向代理IP allowlist/VPN限制，属于部署门禁，不通过修改安全软件实现。
- 登录每IP 20次/5分钟、每规范化用户名5次/5分钟，失败退避最大30秒；注册每IP5次/小时；管理敏感写10次/分钟。Redis失效时认证/写限流fail-closed 503，不声称服务仍满足健康SLO。

### 保留、清理和恢复

| 数据 | MVP工程默认 | 清理安全条件 |
|---|---|---|
| 会话 | 到期/撤销后24小时删除会话secret hash | 保留脱敏安全审计，不保留凭据 |
| 成功命令receipt | 完成后7天；pending/失败流程至终结后7天 | 已删除后客户端旧key可能被视新命令；业务效果唯一键保留更久，客户端不得跨7天自动重试 |
| Outbox/delivery/Inbox | 成功交付后30天；未完成/死信不自动删除 | 事件恢复/效果去重依赖不能提前删除 |
| 集成事件归档 | 90天 | 尚被Saga/审计/证据引用则延长；不能从已删除事件假装完整重建 |
| 运行日志/trace | 14天；metrics 30天 | 脱敏、限量；错误不得含私聊/密码/证据 |
| 大厅聊天/举报 | 聊天30天，举报证据90天 | 授权举报可延长，记录保留原因；R1私聊采用独立策略 |
| 管理/安全审计 | 365天 | 审计内容最小化；不无限保存IP或用户正文 |
| 房间详细行动/内部证据 | 终结后90天 | 抽出永久结算摘要/账本引用；未完成流程不清理 |
| 积分/Board账本、授予效果键 | 游戏存续期间 | 账号删除时去标识，保留去重和总量证明 |
| 已发布配置/Script/有效Knowledge | 按业务存续保留 | 源账号删除不自动删除其他合法拥有者信息，先去除个人来源标识 |
| 数据库备份 | 每日，保留30天，加密；日志恢复点连续保留7天 | 备份不能成为无限留存例外；恢复后应用删除/禁用清单 |

- 玩家可发起账号删除/数据导出申请，由受控运营流程处理，不必首发空壳自助页面。30天内完成处置；即刻撤销会话/禁止新操作，未完成结算按固定义务收敛，删除不覆盖他人账本。
- 这些是工程默认而非法律合规结论；部署地区、未成年人政策和隐私公告必须在对公网发布前另行合规审查，但不阻塞隔离开发。
- 事件90天后重建使用业务快照+后续事件，不宣称永久Event Sourcing重建。投影重建开始记录checkpoint并缓冲增量，完成切换generation后按版本收敛；T13需验证并发写窗口。
- 恢复目标RPO≤15分钟、RTO≤4小时，为待演练目标，不是已验证承诺；无PITR/恢复演练不得上线。

## 7. 浏览器和内容（P-11）

- MVP仅zh-CN内容，契约保留locale与回退；支持Chrome/Edge/Firefox当前与上一稳定大版本，Safari当前与上一稳定大版本，包括移动Safari/Chrome。不支持IE。
- 最窄320 CSS px无横向主布局溢出；全键盘操作、可见焦点、语义标签、读屏状态通知、对比度、减少动画与可暂停日志；目标WCAG 2.2 AA主要流程，必须测试而不是声明认证。
- 所有身份名称为中性术语，用户创作纯文本，不解释HTML/Markdown。公告/规则解释由发布内容模板产生。

## 8. 事件、幂等与WS的明确选择

- 内部事件按 `source+aggregateType+aggregateId` 一个stream，聚合内事件序号独立于version，同事务分配；唯一键(streamId,sequence)、eventId、delivery(eventId,consumer)。内部消费者按delivery前驱关系处理其订阅子集，不要求过滤后数字连续。
- 前驱在归档时按source stream顺序构建；dispatcher不能把后一事件先建立前驱，先锁stream游标并归档该stream下一待归档事件。失败/DLQ阻塞该消费者该stream后继，其他stream可继续；ops不能静默跳洞。
- 租约30秒、10秒续约、每次claim递增fencingToken；完成/更新需匹配token，旧持有者不能提交平台状态。业务唯一键与Inbox仍是最后防线。DB时间负责租约，不用不同worker时钟比较租期。
- delivery最多12次自动尝试，指数退避1秒起、上限5分钟、full jitter；到上限DLQ。重放保留原eventId/效果键，记录replayAttempt及审核人，不创造新业务事实。
- Inbox与一个目标写事务原子，唯一(consumer,eventId)。必须写多目标时先持久化流程计划并Outbox拆分，再逐target处理；重建投影使用(consumer,generation,eventId)去重，不能复用在线Inbox。
- 根预算用于规则产生的可选派生链，不计入四人结算与传播必须完成步骤；固定域内因果链仍记录depth。规则效果派生事件消耗预留预算，重试不重复消耗；预算耗尽不能阻止结算确认。
- 规则效果发生后的事件保持ruleOrigin和根预算引用；必需流程与可选规则派生采用不同派发策略，不能把整场结算event count拿去扣规则预算。规则phase不同也不能重复执行同ruleVersion+eventId。
- 写幂等key 16–128可见ASCII字符；摘要为规范化schema输入+操作+actor，排除trace/传输时间；相同key/content返回原operation，不重做授权外副作用。每次重试仍检查账号是否可用和资源可见性。
- MVP业务写全部走HTTP，WS只用于授权刷新提示/快照订阅/心跳；取消双传输写入口，减少CSRF/幂等重复实现。WS schemaVersion从1开始，首发只有v1，产生v2时才实现当前/上一版兼容。
- WS公开流独立于内部event stream，范围是room公开状态、本人知识/操作、公开Board；MVP不建立持久WS消息日志。通知携带资源version，客户端去重，缺口/重连统一重新获取HTTP快照；不从内部event_store直接拉历史给玩家。
- 快照含serverTime、resourceVersion、nextCursor（适用）。房间快照必须读Query权威状态，不依赖可能落后的榜单投影；知识读取Script授权数据；写后投影滞后用pending而非假失败。
- WS heartbeat每10秒，30秒超时，单消息≤16KiB，队列≤100条或256KiB，超限关闭并要求快照恢复；每账号最多3连接。WS逐消息限频30条/分钟（心跳独立最多每5秒一次）。

## 9. 最低HTTP闭环与运维API

基线原路由缺少创建/退出、聊天、榜单、举报和恢复接口，本轮补齐；所有路径在/api/v1下。

| 接口 | 最低请求语义 | 授权/成功响应 |
|---|---|---|
| POST /query | templateId=trial_1、gameplayReleaseId | 玩家，201 QuerySnapshot（含自己加入）；等待超时已持久化 |
| POST /query/:id/leave | expectedVersion | 当前成员，仅waiting，200结果 |
| GET /leaderboard | cursor、limit≤50 | 已认证玩家，公开昵称/积分/段位，不公开账号 |
| GET /notifications | cursor、limit≤50 | Rules读侧仅本人，持久安全messageKey/args/createdAt，WS只是刷新提示 |
| GET /channel/:id/messages | cursor、limit≤50 | 合法成员，纯文本分页 |
| POST /channel/:id/messages | text | 合法成员，201 messageId/createdAt |
| POST /reports | targetType(message/script/player)、targetId、reasonCode、text≤500 | 玩家，202本人reportId；不因此获得目标读取权 |
| POST /admin/sagas/:id/retry | expectedVersion、reason | ops，202；只重新尝试固定步骤，不改payload |
| GET /admin/sagas | status、cursor | ops，仅脱敏诊断 |
| POST /admin/rules/dispatch-state | paused:boolean、reason、expectedVersion | ops，200持久开关/审计 |
| GET /admin/reports | cursor | ops/授权moderator，证据受权限控制 |
| POST /admin/moderation/:accountId | action=mute/unmute/disable、reason、until? | admin或显式moderator能力，200审计结果；无任意资源编辑 |
| POST /auth/mfa/enroll、/confirm、/reauthenticate | 认证因子经直接HTTPS输入，不由模型代收 | 管理身份，仅本人；未验证enroll不标MFA enabled |

- HTTP字段camelCase、UUID、不透明签名cursor，默认分页20、上限50。未知字段拒绝，不strip后悄悄接纳。
- 房间GET公开摘要仅对已认证玩家；私有行动/本人投票只返回给参与者；不参与者不能用queryId看私有卡。私有资源不存在/无权限统一404，管理能力不足403。
- Gameplay release新建/开始/角色操作使用精确版本校验；活跃房间内部命令优先其固定版本，不用客户端覆盖。
- 写请求需幂等头（包括创建/聊天/举报/管理派发）；登录/注册使用认证专用receipt/轮换流程，客户端只对明确未收到结果按协议恢复，不重放过期cookie。注册成功201且不自动赋管理身份。
- Operation状态统一pending/running/completed/partial_failed/failed/cancelled；临时错误保持pending/running并给nextRetryAt，永久失败给安全messageKey，不暴露堆栈。

## 10. 可复现验收向量

| ID | 输入 | 预期 |
|---|---|---|
| G01 | 两客户端同时抢第4名 | 一次开始，满员后其余422；裁决种子/参与者只固定一次 |
| G02 | 同一玩家并发申请加入两个房间，分别在预留座位/占槽/确认时崩溃重试 | ParticipationSlot唯一键只允许一个占槽；重复步骤幂等，失败流程释放本房间预留/占槽，不跨聚合事务 |
| G03 | 120秒边界inspect | now<deadline成功，等于/超过拒绝；重试已有命令不扣第二次配额 |
| G04 | choice_1两票、choice_2两票 | selectedChoice=choice_1；票数仅截止后可见 |
| G05 | 四人未投票 | selectedChoice=null，tension请求+1；有效探索者5分，其他0 |
| G06 | 正确候选choice_2；A探索且投2，B投1，C只探索，D无行为 | A+25，B+5，C+5，D+0；多数结果独立于个人奖励 |
| G07 | tension99请求+2、某阵营100请求+1 | effective +1/+0，账本仍记requested +2/+1及效果唯一键 |
| G08 | 一玩家两张卡，创建第一Script后崩溃 | 恢复复用实例键，逐张授予，无重复Script/Knowledge来源 |
| G09 | 发布新版后旧房间投票/结算 | 用旧gameplayRelease；新建房间只接纳新版本；术语独立更新 |
| G10 | Script写preparing前后、Social快照提交后分别崩溃，再以同spreadOperationId重试；另有收件人随后下线 | 快照首次提交后同ID恢复同一收件人集合，不重新采样；Redis不可用不创建快照；按持久快照继续授予，下线不撤回、当前禁用则skipped |
| G11 | 过滤stream仅订阅序号1、3，2是其他事件 | 3前驱是1，不等待2；1进DLQ时3阻塞 |
| G12 | WS断线/提示丢失/旧resourceVersion | HTTP快照恢复授权状态，不读取内部事件；不误发第二份奖励 |
| G13 | 已有本人卡、他人卡、秘密truth字段混合ORM对象 | serializer只允许显式DTO，私有ID无权404，HTTP/WS/log均无秘密字段 |
| G14 | 两worker同规则效果重试、租约旧持有者回来 | 预算只预留一次、effect唯一、旧fencingToken平台更新拒绝 |

T02把字段/错误/事件schema及上述反例固化；T03–T08验证平台不变量，T09–T24验证业务/授权，T25–T27验证完整闭环和上线门禁。上述均为预期值，不是已运行结果。

## 11. 实现所有权与集成责任

- Query模块拥有Query（单房间聚合）、ParticipationSlot（按单playerId唯一的独立聚合）、SettlementPlan/Process。Join协调流程分别提交房间座位预留、全局ParticipationSlot和房间参与者确认，不因属于同一模块而跨聚合事务；房间预留容量限制并由持久任务清理。
- Player拥有角色/积分账本；Social拥有频道/成员/消息/受众快照/举报与禁言；Identity拥有账号禁用/会话/MFA。管理员Moderation是应用层持久化编排，不共享Social与Identity事务。
- 静态content定义属于Control，Script通过版本化定义端口创建信息实例；任何模块不直接读取Control内部表。Query裁决使用自己的固定快照，不依赖运行时修改种子配置。
- 平台scheduler只负责dueAt、租约、退避和job去重；领域模块拥有job类型/schema、handler、语义、取消/到期条件和幂等命令。持久任务只调用显式注册的模块端口，不含秘密载荷，不直接更新领域表。
- `QuerySettlementCompleted`由Query通过FinalizeSettlement在验证结算计划所有必需效果引用后发出；其内部selectedCorrect仅供Rules可靠consumer使用。Rule通知本身由Rules持久化并提供本人授权读取，WS只是提示。
- operationId来自所属业务流程；平台只聚合脱敏进度，查询返回由所属模块授权。投影由所属模块/应用读侧负责，平台不替业务模块绕过权限访问全表。
- 业务读不得仅为“CQRS”强制加入异步物化：试炼状态/私有知识用所属模块权威读取；榜单/Board dashboard可投影；UI显示模型版本。
- 后续任务的契约/schema/组合根申请由指定负责人串行合并。新增路径和安全工作明确归T09/T16/T19/T20/T24，不能留为“以后补”的未分配范围。
- 首发生产配置审核确保20并行房间最多80名在局玩家，100连接还包括大厅/多连接；压测记录“连接数”和“独立账号数”，不可混算在线人数。