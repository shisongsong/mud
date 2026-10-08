# ADR-0002：Outbox与至少一次交付语义（原SQL Server实现提案）

- 状态：Superseded for database technology by [ADR-0006](0006-supabase-postgresql.md); delivery semantics remain accepted, SQL Server implementation choice is historical.
- 日期：2026-09-30
- 影响：T03–T06及所有事件生产/消费模块

## 背景

领域写入需要跨进程通知worker、投影和Saga。仅进程内事件或Redis Pub/Sub无法保证进程崩溃后仍能恢复；跨服务exactly-once也不是可实现的事务承诺。

## 决策

领域聚合变更与Outbox在同一数据库事务提交。dispatcher使用经目标数据库真实并发验证的原子领取/租约更新语句，归档集成事件并为已注册消费者建立delivery；消费者在同一事务写Inbox去重及自己的单聚合修改/本地Outbox。采用至少一次投递与幂等效果。Redis只发送可丢失刷新提示。历史回放必须显式授权并使用独立投影generation/checkpoint。原文关于SQL Server/T-SQL与拒绝PostgreSQL锁语法的选择仅作历史记录；当前适配和锁方案由ADR-0006规定。

## 考虑过的方案

- 仅内存EventBus/Redis Pub/Sub：不能恢复进程崩溃后的未消费消息，不足以承载业务事实。
- 直接跨模块共享事务/表：破坏边界并扩大锁耦合，不采用。
- 持久Outbox/Inbox：与业务状态在同一持久化系统，数据库引擎由后续ADR决定。

## 后果与风险

- 消费者必须允许重复；每项业务效果需要数据库唯一键/幂等键。
- delivery、event archive、Inbox有存储和清理成本；保留期需M0确认。
- 过滤订阅可能产生sequence间隙；采用按source stream归档游标建立delivery前驱关系，不把全流sequence视为消费者连续游标；DLQ阻塞同consumer同stream后继。
- 多目标消费者只能保存计划并逐目标发命令，不得一个Inbox事务修改多个聚合。

## 验证与批准

用户2026-09-30委托助手采用至少一次Outbox/Inbox语义。数据库实现曾选SQL Server，后于2026-10-08由用户改为Supabase PostgreSQL；当前技术适配见[ADR-0006](0006-supabase-postgresql.md)。具体租约/fencingToken/归档顺序语义仍按[M0决策](../m0-decisions.md)。T05须在真实Supabase PostgreSQL验证提交/归档/消费各故障点、并发领取、租约过期、旧token、重复和顺序缺口；当前未执行，Accepted不代表实测通过。此文件路径为历史标识。
