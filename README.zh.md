# dsh-effort-lab

一个 DeepSeek Harness 插件：把「这句提示词技巧 / 这个推理档位到底有没有用」变成
一份能读出数字的 JSONL 日志。

它把**单个会话**武装成 A/B 实验，把提示词变体作为系统提示词的最后一段注入，可选地
连带扫推理档位，并在每轮结束时记一行：输入/输出/推理/缓存 token、耗时、子 agent
派生数、压缩与裁剪次数，以及可选的人工打分。

纯 Host 插件、零依赖 ESM：没有 client bundle，没有构建步骤，不 import 任何
`@deepseek-ai/*`。

## 为什么不能靠肉眼比两次回答

两件事让截图成为糟糕的仪器：

- **token 账目不可见。** 「它想得更久了」是关于 `reasoningTokens` 的判断，adapter
  报了，但没有任何逐轮视图呈现它。
- **提示词变体不是免费的。** 系统提示词一变，从该点起的前缀缓存复用就作废，所以
  「更快」可能只是「命中了缓存」。`cache%` 列把这件事显式化，而不是让它污染结论。

推理档位是真实请求参数，因此档位对比对缓存无污染；提示词变体对比则有。插件两者
都记，并把这一点写进报表。

## 安装

```bash
# GitHub，默认分支或固定 tag
dsh plugin --profile desktop add github:flyer103/dsh-effort-lab
dsh plugin --profile desktop add github:flyer103/dsh-effort-lab#v0.1.0

# 本地 checkout（记为 link: 依赖）
cd /path/to/dsh-effort-lab
dsh plugin --profile desktop add "$(pwd)"
node scripts/install.mjs --profile desktop     # 同上，带校验

# 用 `npm pack` 打出的 tarball
dsh plugin --profile desktop add /absolute/path/flyer103-dsh-effort-lab-0.1.0.tgz
```

用你实际在跑的 profile：Desktop 应用用 `desktop`，web profile 用 `web`。装完重启
DSH，让 profile 重新加载 bundle。`add` 会把 bundle 追加进 profile 的
`dsh.profile.bundles`；不要手改 profile 的 `cordis.patch.yml`。重复执行是安全的。

本包未发布到 npm，上面 GitHub、本地 checkout、tarball 三种是受支持的安装方式。

卸载：`dsh plugin --profile desktop remove @flyer103/dsh-effort-lab`，然后重启。
`~/.dsh/effort-lab/records.jsonl` 的日志保留不动。

## 使用

```
/effort-lab start my-sweep     # 武装本会话
/effort-lab report             # 汇总日志里所有轮次
/effort-lab rate 4             # 给上一轮打 1-5 分
/effort-lab stop               # 解除武装，并恢复被轮转的档位
```

完整语法与语义见 [docs/CONTRACT.md](docs/CONTRACT.md)。

## 记录什么

字段级 schema 见 [docs/CONTRACT.md](docs/CONTRACT.md)。概括：每轮记录实际生效的
变体与档位、`steps`、各 token 桶的合计（附带 `usageSteps`，让「没上报」与「真的是
0」可区分）、`wallMs`、`subagents`、`compactions`、`prunes`，以及 `end` 结束原因。

## 局限

- 提示词变体对比在每个块边界都要付缓存代价；档位轴不需要。问耗时优先用档位轴。
- 档位 id 不做预校验——模型不支持的档位会在请求时失败，该轮按失败记录。
- 「效果」只来自你手写的 `rate`。
- 重启 DSH 会解除所有会话的武装；已写记录保留。
- 单个本地文件，跨进程无锁。

设计、分期与对抗性推演：[docs/DESIGN.md](docs/DESIGN.md)。
使用说明：[docs/USAGE.md](docs/USAGE.md)。
在 DSH `0.2.2-rc.3` 上验证；仅到单元测试级别，验证边界见 `docs/DESIGN.md`。

## 许可证

MIT
