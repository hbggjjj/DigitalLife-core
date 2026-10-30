# bot/

| 文件 | 作用 |
|---|---|
| `service.mjs` | 收消息 → 组 Prompt → 调模型 → 落盘 → 回话。主入口。 |
| `bot.mjs` | 命令行：`daemon` 主动开口、`request` 向她申请改动、`once` 手动一次 |
| `meme_cats.json` | 表情包分类清单（由 `deploy/meme-add.sh` 维护） |
| `persona.md` | 语气参考（属于"她是谁"，改动要走申请） |
