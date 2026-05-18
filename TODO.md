# LiveCaptionsR 优化 TODO

> 基于 2026-05-18 的项目分析报告生成。每一项均包含可验证的 **Done When** 条件，便于逐项 check 与 PR 拆分。
>
> 推荐落地顺序：P0 → P1 → P2，前 5 项零/低风险且收益最大。

---

## P0 — 高优先级（立即可改）

### [x] 1. 删除 `translation.rs` 热路径中的死代码 `_legacy_system_prompt`
- **位置**：
  - `src-tauri/src/translation.rs:1407-1422`（`translate_copilot` 相关）
  - `src-tauri/src/translation.rs:1505-1521`（`translate_openai`）
- **问题**：两处 `_legacy_system_prompt` 在每次翻译时构造但从不使用，紧接其下被 `configured_system_prompt` 覆盖。
- **行动**：
  - [x] 删除两段 `let _legacy_system_prompt = if ... { format!(...) } else { format!(...) };`
  - [x] 检查删除后 `source_lang_desc` / `target_lang_name` 是否仍被引用；若不再使用则一并清理。
- **Done When**：
  - [x] `rg "_legacy_system_prompt" src-tauri/` 无输出
  - [x] `cargo build` 通过、`cargo clippy` 无新增告警
  - [ ] 翻译功能（OpenAI / Copilot）端到端冒烟通过 *(待人工冒烟)*

---

### [x] 2. 将 `caption_running` 由 `Mutex<bool>` 改为 `AtomicBool`
- **位置**：
  - `src-tauri/src/state.rs:13`
  - `src-tauri/src/lib.rs:865-869, 968-972, 1098-1099, 1112-1116`（所有 `caption_running.lock()`，共 24 处）
- **问题**：字幕轮询线程每 20–50 ms lock 一次锁只为读 1 个 bool；同时 `.unwrap()` 在锁中毒时会 panic，违反项目规范。
- **行动**：
  - [x] `state.rs`：`caption_running: AtomicBool`，`Default` 用 `AtomicBool::new(false)`
  - [x] 全局替换：使用 `Ordering::Acquire/Release` 配对，启动入口用 `compare_exchange` 保证原子性
  - [x] 删除相关 `.lock().unwrap()` 调用
- **Done When**：
  - [x] `rg "caption_running\.lock" src-tauri/` 无输出
  - [x] `cargo test` 通过（28 项全过）
  - [ ] 启动 / 停止字幕监听往返多次仍正常 *(待人工冒烟)*

---

### [x] 3. 统一 `TranslationService` 初始化入口，复用缓存
- **位置**：
  - `src-tauri/src/lib.rs:366-374`（`save_config` 内重建）
  - `src-tauri/src/lib.rs:541-575`（`get_or_init_translation_service`）
  - `src-tauri/src/lib.rs:853-861`（`start_caption_watcher` 内重建）
  - `src-tauri/src/translation.rs:217-221`（`update_config` 被 `#[allow(dead_code)]`）
- **问题**：3 处初始化均整体替换 `Option<TranslationService>`，导致 `copilot_tokens` / `client_cache` / `translation_cache` 在每次保存设置/启动时被清空。
- **行动**：
  - [x] 启用 `TranslationService::update_config`，仅在 max_concurrent 变化时重建 semaphore，其它缓存全部保留
  - [x] `save_config` / `start_caption_watcher` 改为：若已有 service 则 `update_config`，否则 `new`
  - [x] 删除 `get_or_init_translation_service` 内多余的 `load_config_from_file()` 二次读盘（含 `get_config` 中的同款写法）
  - [x] 抽取单一函数 `ensure_translation_service(state, &config)` 复用三处
- **Done When**：
  - [x] `rg "load_config_from_file" src-tauri/` 调用点 = 2（启动 setup + 函数定义）
  - [ ] 翻译过程中调一次「保存设置」，Copilot/OpenAI 不再因 token 缓存失效而重新走 OAuth/auth 路径 *(待人工冒烟)*

---

### [x] 4. 修复 `db.rs` 每次启动无条件重跑 v5 自愈迁移
- **位置**：`src-tauri/src/db.rs:322-326`
- **问题**：即便 `user_version >= 5` 也会再跑一次 `migrate_ai_chat_schema_v5`，新装用户也会执行 7 条 `UPDATE ... WHERE ... IS NULL` 写事务。
- **行动**：
  - [x] 引入 `user_version 6`：把「legacy schema 自愈」一次性归入 v6 迁移
  - [x] 删除 322-326 行的无条件自愈块
  - [x] 为升级用户保留兼容：v6 块内仍调用 `migrate_ai_chat_schema_v5`，但只跑一次
- **Done When**：
  - [x] `cargo test`（db 相关）通过
  - [ ] 全新装环境启动后 `PRAGMA user_version` 返回 `6` *(待人工冒烟)*
  - [ ] 老库（v5）首次启动一次性升至 v6，第二次启动不再进入迁移分支 *(待人工冒烟)*

---

### [~] 5. 拆分 `App.tsx`（God Component） — 已大幅推进
- **位置**：`src/App.tsx`
- **问题**：49 `useState` + 1 `useReducer` + 51 `useRef` + 30 `useEffect`，业务边界模糊；`src/hooks/` 目录为空。
- **行动**（每个 hook 一个独立 PR，已落地的 hook 见下）：
  - [x] 新建 `src/hooks/useToasts.ts`：toast 状态机（首发模板）
  - [x] 新建 `src/hooks/useFooterLayout.ts`：footer 自适应 / `ResizeObserver`
  - [x] 新建 `src/hooks/useCardSearch.ts`：卡片搜索 + matches memo + 全局快捷键
  - [x] 新建 `src/hooks/useAutoFollowScroll.ts`：scroll container ref + auto-follow 状态机 + rAF 节流
  - [x] 新建 `src/hooks/useSessions.ts`：会话列表 + active triple + refs + 自动保存 debounce
  - [x] 新建 `src/hooks/useAIChat.ts`：聊天数据层（会话/消息/refs/存储助手 + clearChatSessionState）
  - [x] 新建 `src/hooks/useCaptionVisibility.ts`：caption 源窗口可见性 + `caption-visibility` 监听
  - [ ] 新建 `src/hooks/useCaptionStream.ts`：字幕事件订阅 + cards reducer + partial text *(待后续 PR — 与 translation 请求管理高度耦合)*
  - [x] 每个 hook 单独导出明确的 API（state + actions），refs 仅在必须时外泄并标注用途
- **Done When**：
  - [ ] `App.tsx` ≤ 800 行（当前 2640 行；P0-5 落地降幅约 230 行，待 useCaptionStream + 拆 send/streaming 进一步降低）
  - [x] `src/hooks/` 至少 6 个文件（当前 7 个）
  - [x] `npx tsc --noEmit` 通过
  - [ ] UI 行为回归通过（启动监听、翻译、聊天、Teams 切换、会话切换、自动滚动）*(待人工回归)*

---

## P1 — 中优先级（收益明确）

### [x] 6. 删除前端未使用的图标 export
- **位置**：`src/components/Icons.tsx:167, 175, 197, 205, 213`
- **行动**：
  - [x] 删除 `IconGlobe`、`IconRefreshCw`、`IconAlertCircle`、`IconSidebarClose`、`IconSidebarOpen` 五个组件
- **Done When**：
  - [x] `rg "IconGlobe|IconRefreshCw|IconAlertCircle|IconSidebarClose|IconSidebarOpen" src/` 无输出
  - [x] `npx tsc --noEmit` 通过

---

### [x] 7. 将 `textUtils.ts` / `captionProcessing.ts` 仅本地使用的导出降级为非 `export`
- **位置**：
  - `src/utils/textUtils.ts:2, 6, 35, 39, 52, 64, 77`
  - `src/utils/captionProcessing.ts:21`（`splitIntoSentences`）
- **行动**：
  - [x] 去掉以下 export 关键字：`SIMILARITY_THRESHOLD`、`levenshteinDistance`、`stripTrailingPunctuation`、`isContinuation`、`isDecimalPoint`、`findLastEOSIndex`；`endsWithEOS` 整体删除（已无引用）
  - [x] `captionProcessing.ts` 内 `splitIntoSentences` 改为非 export
- **Done When**：
  - [x] 跨文件引用搜索：只保留 `shouldOverwrite`、`getLatestCaption`、`generateId`、`isEOSPunctuation`、`calculateSimilarity`
  - [x] `npx tsc --noEmit` 通过

---

### [x] 8. 清理后端 legacy `openai_endpoints` 整条链路
- **位置**：
  - `src-tauri/src/lib.rs:139, 219, 454-476, 531`
  - `src-tauri/src/translation.rs:50-76, 106, 158, 1463, 1543, 1645, 1669, 1884, 1981, 2037, 2076`
- **问题**：前端早改用 `ai_channels + ai_models`，后端仍保留 `OpenAIEndpoint` 结构 + fallback 查找逻辑，是双轨实现。
- **行动**：
  - [x] 新增 `TranslationService::resolve_ai_model(model_id)` 在调用前从 `ai_channels + ai_models` 实时解析
  - [x] 删除 `OpenAIEndpoint` 结构、`OpenAIEndpointDTO` 结构（保留内部辅助类型 `ResolvedAIModel`，仅运行时使用）
  - [x] 给 `AIChannel` / `AIChannelDTO` 补齐 `api_key`、`base_url` 字段（OpenAI 通道凭证来源）
  - [x] 删除 `lib.rs` 转换段；从 `TranslationConfig` 移除 `openai_endpoints` 字段
  - [x] 删除 `AppConfig.openai_endpoints` 字段
- **Done When**：
  - [x] `rg "openai_endpoints|OpenAIEndpoint" src-tauri/` 无输出
  - [x] `cargo check` 通过
  - [ ] 翻译 / 摘要 / chat 对 OpenAI/Copilot 通道功能回归通过 *(待人工冒烟)*

---

### [x] 9. 减少字幕主循环中的字符串克隆
- **位置**：
  - `src-tauri/src/lib.rs:987-1011`（LiveCaptions 路径）
  - `src-tauri/src/lib.rs:1132-1149`（Teams 路径）
  - `src-tauri/src/livecaptions.rs:656-659`
- **行动**：
  - [x] LiveCaptions：`last_text: String` → `last_text_hash: u64`（用 `DefaultHasher`），消除 `text.clone()`；`livecaptions.rs` 内同步去除 `last_text/last_user` 字符串字段，仅保留两个 u64 hash
  - [x] `debug!` 中的 preview 字符串仅在 debug 启用时构造（`tracing::enabled!(Level::DEBUG)` 守卫）
  - [x] Teams：`last_caption_signature: String` → `(u64, u64)`（card hash + content hash），不再 `format!` 拼整串
- **Done When**：
  - [x] `cargo check` 通过
  - [ ] 1 分钟连续字幕场景手测 CPU 占用 ≤ 改造前 *(待人工冒烟)*

---

### [x] 10. 修正 `useEffect` 依赖不完整
- **位置**：`src/App.tsx:1246-1250`
- **行动**：
  - [x] 把依赖数组从 `[config.language]` 改为 `[config.language, i18n]`
  - [ ] 全文件用 `npx eslint --rule "react-hooks/exhaustive-deps:warn"` 扫一遍补漏 *(仓库未配置 ESLint；后续若加入再扫)*
- **Done When**：
  - [x] 已明确修复 i18n 缺失依赖

---

### [x] 11. 清理 i18n 未使用 key
- **位置**：`src/locales/en.json` 与 `src/locales/zh-CN.json`
- **确认未使用 key**：
  - `sidebar.clearAllTooltip`（line 44）
  - `settings.tabs.ai`（en.json line 69）
  - `settings.ai.title / addEndpoint / endpointName / endpointNamePlaceholder / modelPlaceholder / baseUrlPlaceholder`（en.json line 129-137）
- **行动**：
  - [x] 删除上述 key（两个语言文件保持同步），并同步更新 `settings.summary.description` 中已失效的 "AI Config" 引用
  - [ ] 添加 dev 脚本：扁平化 JSON key 与命中集做差集 *(可入后续 CI)*
- **Done When**：
  - [x] `npx tsc --noEmit` 通过
  - [ ] 删除后 UI 无 missing key 报错 *(待人工冒烟)*

---

## P2 — 低优先级（代码卫生）

### [x] 12. 整理 `App.tsx` 中 `useRef` 声明位置
- **位置**：`src/App.tsx:345-392` 与 `src/App.tsx:456-458`
- **行动**：
  - [x] 将 `activeSessionNameRef` / `activeSessionCreatedAtRef` / `stopFinalizeInFlightRef` 上提到 ref 顶置段尾部
- **Done When**：[x] ref 声明合并完成，所有 useRef 集中在 useState 后

---

### [x] 13. 修复 `panic_hook` 内的 `unwrap`（panic-in-panic 风险）
- **位置**：`src-tauri/src/lib.rs:1562-1588`
- **行动**：
  - [x] 改为 `match panic_info.location()` 解构，`None` 落到 `("<unknown>", 0, 0)`
  - [x] 同步调整 `tracing::error!` / `eprintln!` 内的取值
- **Done When**：[x] `rg "panic_info.location\(\).unwrap" src-tauri/` 无输出

---

### [x] 14. 修正 Copilot token 缓存的 `lock().unwrap()`
- **位置**：`src-tauri/src/translation.rs:777, 846`
- **行动**：
  - [x] 改为 `lock().map_err(|_| anyhow::anyhow!("Copilot token cache lock poisoned"))?`
  - [x] `SystemTime::now().duration_since(UNIX_EPOCH).unwrap()` 改为 `unwrap_or_default()`
- **Done When**：[x] `rg "copilot_tokens.lock\(\)\.unwrap" src-tauri/` 无输出

---

### [x] 15. 更新 `teams.rs` 顶部关于 `runtime_id` 的过时注释
- **位置**：`src-tauri/src/teams.rs`（文件首部 doc comment）
- **行动**：
  - [x] 注释更新为说明 `runtime_id` 用于 UIA 元素稳定标识 + 去重
- **Done When**：[x] 注释描述与代码实际行为一致

---

### [x] 16. 清理 `livecaptions.rs` 内的注释代码
- **位置**：`src-tauri/src/livecaptions.rs:650-653`
- **行动**：
  - [x] 在 P1-9 一并删除（hash 改造时把整段注释代码块也清掉了）
- **Done When**：[x] `rg "// eprintln" src-tauri/src/livecaptions.rs` 无输出

---

## 跟进项（非必做，但建议补齐）

### [ ] 17. 单元测试覆盖
- [ ] 为 `useSessions` / `useCaptionStream` / `useAIChat` 等抽出的 hook 写 React Testing Library 测试
- [ ] 为 `translation.rs` 的 `parse_provider`、`provider_cache_tag`、`proxy_cache_key` 补 `#[cfg(test)]` 用例

### [ ] 18. CI 增强（可选）
- [ ] GitHub Actions：`cargo clippy -- -D warnings` + `cargo test`
- [ ] 前端：`tsc --noEmit` + `eslint`（含 `react-hooks/exhaustive-deps`）
- [ ] 自定义脚本：i18n 未使用 key 检测 + rust 未使用依赖检测（`cargo-udeps`）

---

## 验证清单（每次 PR 合并前过一遍）

- [ ] `cd src-tauri && cargo check && cargo clippy && cargo test`
- [ ] `npx tsc --noEmit`
- [ ] `npm run tauri dev` 启动后冒烟：
  - [ ] LiveCaptions 模式启动 / 停止
  - [ ] Teams 模式选窗启动 / 停止
  - [ ] 至少 1 个翻译 provider（Google / Copilot / OpenAI）正常翻译
  - [ ] AI 摘要 + AI 聊天可正常返回结果
  - [ ] 会话切换 / 重命名 / 删除 / 自动保存
  - [ ] 切换语言（en ↔ zh-CN）UI 文案正常
