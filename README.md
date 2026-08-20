# dsh-oc-eof-lenient

对目标 LLM provider 的模型流做 OpenCode 风格的 EOF 宽容处理（DSH `llm/stream` 中间件）。

## 安装 / 更新

安装插件到指定的 DSH profile：

```bash
dsh plugin --profile web add dsh-oc-eof-lenient
```

更新插件到最新版本：

```bash
dsh plugin --profile web update dsh-oc-eof-lenient@latest
```

## 背景

某些 OpenAI 兼容网关在已产出一整轮内容（文本或工具调用）后会直接关闭 SSE，不发送标准的
`finish_reason`/`[DONE]`。DSH 的 pi-ai 适配器将这类流归类为：

```text
TRANSPORT: Stream ended without finish_reason
```

并把整次调用当作传输失败重试；而 OpenCode 使用的 AI SDK 在同一流上把 EOF 当作正常完成，
因此同样的请求在 OpenCode 完全没问题、在 DSH 却断流。

本插件不改任何适配器源码，只挂载一个 `llm/stream` waterfall 中间件：在目标 provider 的流进入
装配器（以及 retry/replay 层）之前，把上述错误结尾改写成正常完成。

## 工作原理

- 监听 `llm/stream`（cordis waterfall 事件）。
- 逐个透传上游 chunk；收尾若命中「`finish` + `kind:error` + `code:TRANSPORT` +
  `Stream ended without finish_reason`」，且本轮已产出完整内容块：
  - 有完整工具调用块 → `finish reason: tool-calls`（agent 会照常执行工具并继续）
  - 否则 → `finish reason: stop`
  并结束本次流，不再把错误提交给 retry 层。
- 由于目标网关在实测中请求体里 `include_usage` 开与关都返回同一异常形状，本插件不做
  请求体改写，只做收尾语义修正，与 OpenCode/AI SDK 的可容忍性对齐。

## 启用方式

**在对应 provider（或模型）的配置下面写 `eofLenient: true` 即可**，支持两级：

- **provider 级**：写在 `llm-pi-ai.providers.<name>` 下，对该 provider 的全部模型生效；
- **模型级**：写在 `llm-pi-ai.providers.<name>.models[].<id>` 下，只对该模型生效，
  并覆盖 provider 级的取值（设为 `false` 可在 provider 级开启的前提下关闭单个模型）。

```yaml
llm-pi-ai:
  providers:
    my-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.example/v1
      eofLenient: true        # provider 级：该 provider 全部模型启用
      models:
        - id: my-reasoner
          eofLenient: true    # 模型级：仅该模型启用（覆盖 provider 级）
```

未写该标志的路由完全不受影响（保持 pi-ai 默认的严格终止帧要求）。

## 开发（DSH checkout + tsdown watch）

构建依赖 DSH 源码检出目录，配置优先读取当前进程环境变量，也支持项目根目录的 `.env`：

- `DSH_CHECKOUT` —— DSH 源码检出目录，必须包含 `packages/`

例如 `.env`：

```dotenv
DSH_CHECKOUT=/path/to/deepseek-harness
```

构建配置通过 Node 原生 `process.loadEnvFile` 读取 `.env`，然后把 checkout 中的 DSH 包作为源码 alias 用于类型解析；已存在的进程环境变量优先，发布产物仍保留这些包的 peer import。

```bash
pnpm build  # 标准 tsdown 构建到 lib/
pnpm dev    # tsdown watch，修改源码后自动重新构建
```

`pnpm dev` 会持续运行 watch 进程，并监听本插件源码以及通过 `DSH_CHECKOUT` 解析到的 DSH 源码依赖。构建完成后，使用 DSH 的 super-injector 工具加载或热重载插件；构建脚本本身不负责宿主进程注入。

## 配置

插件自身无必需配置。可选行为开关：

```ts
interface Config {
  requireCompletedContent: boolean // 默认 true：仅当已产出完整内容块才改写
  finishReason: 'auto' | 'stop'    // 默认 'auto'：有工具调用块则按 tool-calls 结束
}
```

## License

MIT
