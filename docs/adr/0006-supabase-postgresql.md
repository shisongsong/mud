# ADR-0006：Supabase托管PostgreSQL作为MVP持久层

- 状态：Accepted（用户于2026-10-08明确指定Supabase；数据库连接/迁移尚未执行）
- 日期：2026-10-08
- 影响：T01、T03–T06及所有持久化模块
- Supersedes：ADR-0002中关于SQL Server/T-SQL及拒绝PostgreSQL锁语法的技术实现选择；保留其Outbox/Inbox与至少一次投递语义。

## 决策

使用用户提供的Supabase项目托管PostgreSQL作为业务状态、事件、任务和配置版本的durable source of truth。服务端通过`pg`连接池及标准PostgreSQL URI访问数据库；连接地址可提交，数据库密码只能通过本地忽略的`.env`或部署Secret注入。连接使用TLS加密；本地development/test不验证CA链以兼容Supabase Pooler证书，production仍必须验证证书链。Redis仍仅用于可恢复提示、缓存、在线状态和限流，不承载可靠事实。

保留模块化单体、单聚合事务、Command Receipt、Outbox/Inbox、至少一次投递、幂等效果和跨聚合Saga前向恢复。事务级advisory lock只用于迁移互斥和按actor/operation/idempotencyKey串行化receipt；聚合并发写仍由expectedVersion CAS及数据库约束保护。代码使用READ COMMITTED，使在advisory lock上等待的请求在锁释放后读取最新已提交receipt。

## 连接与安全

- 连接串必须从Supabase Dashboard的Connect面板复制，不能猜测pooler主机、索引、用户名或端口；保留特殊字符的密码必须进行URI百分号编码。
- 不把真实URI写入源码、测试、日志或Git。项目仓库仅提供无效占位符；生产环境须使用Supabase推荐的受限运行角色与独立migration权限，并检查连接配额。
- 直连端点需要本机网络支持Supabase当前DNS/IP配置；IPv4环境使用Dashboard提供的共享Pooler URI。当前开发机Session Pooler 5432端口未完成PostgreSQL TLS协商，Transaction Pooler 6543端口可到达TLS握手，因此本地暂按Dashboard给出的Transaction Pooler配置；应用命令和迁移均在显式事务中运行，不依赖跨事务会话状态或命名prepared statement。
- Transaction Pooler服务证书链不在运行环境默认信任库中时，从Supabase Database settings下载项目CA到被Git忽略的`.secrets/supabase-root.crt`，并在部署环境设置`DATABASE_SSL_CA_FILE=../../.secrets/supabase-root.crt`。生产环境保持`rejectUnauthorized: true`；本地开发的`rejectUnauthorized: false`仅跳过服务端身份验证，不关闭TLS加密，不能用于生产。
- 所有数据库输入参数化；PostgreSQL标识符由迁移静态定义。RLS/运行角色授权策略仍需在上线前验证；服务端Secret不得进入客户端。

## 实施和验证边界

当前代码已增加`pg`池、Postgres UnitOfWork、事务级advisory lock、Query仓储方言和PostgreSQL schema迁移。已观察到Pooler DNS/TCP可达，但尚未完成经验证TLS认证、数据库认证或迁移；没有schema变更应用。Fake测试不等于PostgreSQL集成测试。迁移前必须确认目标项目为空库或完成备份/数据迁移决定；不假设旧SQL Server schema或数据自动迁移。

T03/T04后续必须在临时或受控Supabase项目验证：TLS/DNS/直连或pooler模式、两项迁移原子性与重复运行、角色权限、bytea/UUID/timestamptz/json映射、receipt并发重试、CAS冲突、回滚和连接池限制。未通过前禁止将数据库适配标记为生产验证完成。

## 后果

- SQL Server/T-SQL适配器和依赖被移除；迁移与持久化SQL统一采用PostgreSQL语法。
- PostgreSQL advisory锁哈希存在理论碰撞，只会导致无关命令串行，不会破坏正确性；唯一receipt键与CAS仍是最终约束。
- 本机开发需要配置`DATABASE_URL`；生产若Supabase证书不受系统信任还需配置`DATABASE_SSL_CA_FILE`。缺少数据库URL时迁移命令安全失败，API启动不会自动迁移。
- 已执行的SQL Server迁移历史与数据不兼容；如存在需保留数据，需另做经验证的导出/转换/导入计划。
