# OpenClaw 异步多 Agent 协作系统架构说明 (两层架构版)

## 1. 系统目标

本系统的核心目标是实现**"异步委托"**与**"结果导向"**的自动化工作流。
人类只需下达高层目标，系统将自动完成任务拆解、环境隔离、代码编写、本地测试与结果汇报。整个过程无需人类全程"盯盘"，只需在最终环节进行验收（Approve）。

---

## 2. 角色分工（两层架构）

系统采用精简的**两层架构**，避免过度设计，确保高效流转：

### 2.1 调度层：PM Agent（主）

- **定位**：人类的唯一对接人，系统的调度中枢。
- **职责**：
  - **正向对齐**：接到任务后，主动向人类提问，确认理解无误后再开始执行。
  - **动态创建子 Agent**：根据任务类型，通过 OpenClaw `sessions_spawn` API 按需创建对应的 Skill Agent Session。
  - **反向过滤**：接收 Skill Agent 的状态反馈，过滤并整理后，再向人类请示。
  - **状态管理**：维护全局任务队列，处理异常重试与最终汇报。

### 2.2 执行层：Skill Agent（子）

- **定位**：由 PM Agent 按需创建、用完即销毁的无状态执行单元，每个子 Agent 携带对应的 SOUL.md 角色定义。
- **职责**：
  - **Coder Agent**：在隔离的 Docker 容器中拉取代码、阅读规范、编写代码、运行本地构建与测试。
  - **Research Agent**：负责信息收集与调研。
  - **Reviewer Agent**：从第一性原理出发，质问实现方案的合理性与边界情况，而非死板地对照规范。

---

## 3. PM Agent 的 Spawn 能力（核心机制）

PM Agent 动态创建子 Agent 是整个系统能够运转的基础能力，需要在此单独说明。

### 3.1 创建方式

PM Agent 通过调用 OpenClaw 的 **`sessions_spawn` API** 来创建新的子 Agent Session。每次 Spawn 时，PM Agent 需要传入以下参数：

- **SOUL.md**：子 Agent 的角色定义文件，决定它是 Coder、Reviewer 还是 Research Agent。
- **任务上下文**：包括 Linear Issue 内容、当前 `task_queue.json` 中该任务的状态、以及 PM 对该子 Agent 的具体指令。
- **环境配置**：Docker 镜像、Volume 挂载路径（代码目录、日志目录）、环境变量（GitHub Token、Notion API Key 等）。

### 3.2 子 Agent 的生命周期

子 Agent 是**按需创建、任务完成即销毁**的临时实体：

1. **创建时机**：PM Agent 判断需要执行某类任务时（如"需要写代码"），立即 Spawn 对应类型的子 Agent。
2. **并行创建**：同一个 Issue 的 Coder 和 Research Agent 可以同时被创建并行工作；不同 Issue 的子 Agent 也可以同时运行，互不干扰。
3. **销毁时机**：子 Agent 完成任务并将最终状态写入 `task_queue.json` 后，PM Agent 调用 OpenClaw API 关闭该 Session，释放资源。

### 3.3 PM 与子 Agent 的通信协议

PM Agent 与子 Agent 之间**不通过直接消息回调通信**，而是采用**共享状态文件**作为通信媒介：

- **PM → 子 Agent**：PM 通过 Spawn 时传入的初始指令下达任务，子 Agent 启动后读取指令并开始执行。
- **子 Agent → PM**：子 Agent 将执行状态（进行中、已完成、遇到问题、需要人类决策）写入 `task_queue.json` 对应的任务条目中。PM Agent 定期轮询该文件，感知子 Agent 的状态变化。
- **异常上报**：若子 Agent 遇到无法自行解决的问题，在 `task_queue.json` 中将状态标记为 `BLOCKED`，并写入阻塞原因。PM Agent 发现 `BLOCKED` 状态后，向人类发起请示。

这一设计使 PM Agent 与子 Agent 完全解耦：子 Agent 崩溃不会影响 PM Agent；PM Agent 重启后只需读取状态文件，即可恢复对所有子 Agent 的感知。

---

## 4. 核心工作流

以一个完整的 Issue 为例，端到端流程如下：

1. **触发**：人类在 OpenClaw Web UI 中向 PM Agent 粘贴 Linear Issue 链接，触发任务。
2. **对齐**：PM Agent 读取 Notion 知识库，判断是否需要提问。有疑问则向人类确认，无疑问则直接进入下一步。
3. **Spawn Coder**：PM Agent 创建 Coder Agent Session，传入 Issue 上下文和 Coder SOUL.md，Coder 开始在 Docker 容器中工作。
4. **（可选）Spawn Research**：若 Coder 在执行中发现需要调研，PM Agent 同步创建 Research Agent，调研结果写回共享状态文件供 Coder 读取。
5. **Coder 完成**：Coder 将代码提交到 `feature/{issue_id}` 分支，状态更新为 `CODING_DONE`，Session 关闭。
6. **Spawn Reviewer**：PM Agent 感知到 `CODING_DONE`，创建 Reviewer Agent Session，传入代码 diff 和 Reviewer SOUL.md。
7. **质问与修改**：Reviewer 质问 → Coder 分级响应 → 最多三轮，详见第 5 章。
8. **汇报**：所有子 Agent 完成，PM Agent 在 Web UI 中向人类汇报结果。
9. **Approve**：人类回复 `[Approve]`，PM Agent 执行完整闭环动作（提交 PR、更新 Linear、归档知识库）。

---

## 5. 关键工程机制

### 5.1 状态持久化与无状态调度

- **剥离状态管理**：PM Agent 不依赖上下文记忆追踪任务，而是将所有任务状态持久化到 `task_queue.json` 文件中。PM Agent 变为无状态调度器，每次唤醒只负责读取状态、执行动作并更新状态。
- **心跳检测与断点续跑**：Skill Agent 定期向状态文件写入心跳。PM Agent 监控心跳，若发现容器崩溃则自动重新派生。Skill Agent 在关键步骤写入 Checkpoint，确保崩溃后能从断点继续执行。

### 5.2 知识库驱动的认知飞轮

- **沉淀对齐结论**：人类与 PM Agent 的每一次对齐结论，都会自动写入 Notion 知识库。
- **持续进化**：知识库作为系统的长期记忆，随着项目推进不断丰富。未来的 Agent 在冷启动时读取知识库，将越来越懂项目，需要向人类确认的问题越来越少，最终实现高度自主。

### 5.3 人类主动触发机制（非自动轮询）

本系统**不采用 Cron 定时轮询 Linear** 的方式自动触发任务，原因如下：

- Linear Issue 之间存在依赖关系，自动轮询无法感知"这个 Issue 现在是否适合执行"。
- 任务的优先级与上下文判断属于人类的决策范畴，不应由系统自行决定。

**触发方式**：人类在 OpenClaw Web UI 中打开 PM Agent 的对话界面，手动粘贴 Linear Issue 链接或描述任务目标，由 PM Agent 接管后续所有流程。这保证了每一个任务的启动都是经过人类有意识确认的。

### 5.4 可观测性与人类介入机制

系统的每一个 Skill Agent 都运行在独立的 OpenClaw Session 中，人类可以随时介入：

- **查阅状态**：通过 OpenClaw Web UI，人类可以实时查看任意 Skill Agent 的当前工作状态、已执行的步骤与输出。
- **直接介入**：如果发现某个 Skill Agent 走偏，人类可以直接在该 Session 中发送消息，向 Agent 提供即时指导或纠偏，无需通过 PM Agent 中转。
- **旁观模式**：在不介入的情况下，人类可以以"只读"方式观察 Agent 的完整工作过程，用于学习和审计。

这一机制保证了系统在"自主执行"与"人类可控"之间的平衡。

### 5.5 工作日志持久化

Skill Agent 所在的 Docker 容器是**临时的**，容器销毁后其内部状态随之消失。为保证可回溯性，系统采用以下方案：

- **实时写日志到宿主机**：每个 Skill Agent 在执行过程中，将关键操作（拉取代码、运行命令、遇到错误、做出决策）实时追加写入宿主机上的日志文件，路径格式为 `logs/{issue_id}/{agent_type}_{timestamp}.log`。
- **日志挂载方式**：通过 Docker Volume 将宿主机日志目录挂载进容器，Agent 直接写文件即可，无需网络传输。
- **日志用途**：事后复盘 Agent 的决策过程；调试异常行为；作为知识库沉淀的原始素材。

### 5.6 Reviewer 结论的流转与沉淀

Reviewer Agent 完成质问后，其结论需经过明确的流转路径，而非简单地"生成清单了事"：

1. **结论交付 PM**：Reviewer 将质问结论（包括"已确认合理"的部分和"存在疑问"的部分）写入 `task_queue.json`，PM Agent 读取后处理。
2. **PM 分级处理**：
   - 若疑问属于**技术实现细节**，PM 重新 Spawn Coder，传入 Reviewer 的问题清单，无需打扰人类。
   - 若疑问涉及**产品决策或架构方向**，PM 整理后向人类请示。
3. **结论写入知识库**：无论是"合理"的确认还是"修改"的决策，Reviewer 的质问结论都应由 PM Agent 摘要后写入 Notion 知识库，作为未来同类任务的参考依据。

### 5.7 Approve 后的完整闭环动作

人类回复 `[Approve]` 后，PM Agent 将依次执行以下动作，完成完整的交付闭环：

1. **提交 PR**：将 Coder Agent 在 `feature/{issue_id}` 分支上的代码提交为 Pull Request，PR 描述中自动关联 Linear Issue 编号。
2. **更新 Linear Issue 状态**：将对应 Issue 的状态从 `In Progress` 更新为 `In Review`（或根据团队规范调整）。
3. **关联分支**：在 Linear Issue 中记录对应的 GitHub 分支和 PR 链接，保证代码与需求的可追溯性。
4. **知识库归档**：将本次任务的对齐结论、Reviewer 质问摘要、最终决策一并写入 Notion，完成本次任务的知识沉淀。
5. **通知人类**：在 OpenClaw Web UI 中发送完成通知，附上 PR 链接，等待人类在 GitHub 上完成最终 Code Review 并合并。

---

## 6. 设计决策与边界约定

本章记录在架构设计过程中针对潜在问题所做出的明确决策，避免实现阶段出现歧义。

### 6.1 PM Agent 对齐的触发条件

PM Agent 在接到任务后**不强制对齐**，而是先查询 Notion 知识库，判断当前任务是否已有足够的上下文支撑。对齐的触发逻辑如下：

- **优先读知识库**：PM Agent 冷启动时首先检索 Notion，查找与当前 Issue 相关的历史决策、规范约定和对齐结论。
- **有疑问才提问**：只有在知识库中找不到足够信息、或任务本身存在明显歧义时，PM Agent 才主动向人类提问。
- **不过度打扰**：对于描述清晰、知识库中有充分上下文的任务，PM Agent 应直接进入执行阶段，不产生无意义的确认噪音。

这一设计依赖 Agent 自身的判断能力，而非硬性规则。随着知识库不断丰富，PM Agent 需要提问的频率将自然降低。

### 6.2 Reviewer Agent 的轮次上限

Reviewer 与 Coder 之间的质问-修改循环**最多进行三轮**。具体规则如下：

- **第一轮**：Reviewer 完成初次质问，Coder 根据问题清单分级处理（见 6.4）。
- **第二轮**：Reviewer 针对修改结果进行复查，重点确认必须修改项是否已解决。
- **第三轮**：若仍有未解决的疑问，Reviewer 将剩余问题连同自身判断一并上报 PM Agent，由 PM 决定是打回人类决策还是直接放行。
- **三轮后强制结束**：无论结论如何，三轮后 Reviewer 不再发起新一轮质问，避免无限循环。

### 6.3 知识库写入的质量控制

知识库的写入采用**"草稿先行，确认后提交"**的两步流程，防止错误信息污染知识库：

1. **PM 起草文档**：每次对齐结束后，PM Agent 先将本次讨论的结论整理成一份结构化草稿，展示给人类确认。
2. **人类确认后提交**：人类确认草稿内容准确无误后，PM Agent 才将其正式写入 Notion 知识库。
3. **增量补充模式**：对于较小的对齐结论（如一个参数的命名规范），PM Agent 同样先起草补充内容，询问人类是否追加到已有文档，经确认后再更新。

这一机制确保知识库中的每一条记录都经过人类背书，质量可信。

### 6.4 Coder 对 Reviewer 问题的分级响应

Reviewer 的质问结论交付 Coder 后，Coder 需要对每个问题进行**显式分级标注**，而非笼统地"全部修改"或"全部忽略"：

| 级别 | 标注 | 含义 | Coder 的处理方式 |
|---|---|---|---|
| P0 | `[必须修改]` | 存在正确性错误、安全漏洞或严重违反规范 | 必须修改，不得跳过 |
| P1 | `[建议修改]` | 存在可优化空间，但不影响功能正确性 | Coder 自行判断，可修改或保留并注明理由 |
| P2 | `[已知晓]` | Reviewer 的质问已理解，但当前实现是有意为之 | Coder 注明决策原因，无需修改 |

所有 P0 问题修改完毕后，Coder 将分级结果连同修改说明写入 `task_queue.json`，PM Agent 感知后重新 Spawn Reviewer 进行下一轮复查（如未超过三轮上限）。

### 6.5 并发容器的资源策略

多个 Skill Agent 并行执行是本系统的核心价值，**不设置并发数量上限**。资源不足时的处理策略如下：

- **Agent 自主感知**：若 Skill Agent 在执行 `pnpm build` 等高负载操作时遭遇 OOM 或超时，应识别出"当前失败原因是资源不足"，而非盲目重试。
- **上报而非重试**：Agent 将资源不足的判断结果写入 `task_queue.json`（状态标记为 `BLOCKED_RESOURCE`），PM Agent 向人类反馈："当前有 N 个任务并行，服务器内存不足，建议升级至更高配置后继续。"
- **升级优先于限流**：并发带来的时间收益远大于升级服务器的成本，因此系统不通过限流来规避资源问题，而是通过扩容来匹配并发需求。
