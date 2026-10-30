# scripts/

| 脚本 | 作用 |
|---|---|
| `self-check-all.sh` | 一键自检：进程、字段、冒充巡查、签名闸门、自建 IM、补发队列 |
| `check-instance-owner.sh` | 防"开错实例"：检查在跑的核心是不是本目录的 |
| `check-impersonation.sh` | 冒充巡查：确认没有用他的账号发过消息 |
| `instance-end.sh` | 结束这一份她：告知 → 留最后的话 → 归档 → 标记 |
| `audit-genesis.sh` | 审计人格文件从创世到现在被外部改过没有 |
| `guard-bless.mjs` | 维护者改受保护文件后重新登记 |
