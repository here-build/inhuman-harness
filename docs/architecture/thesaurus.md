# Тезаурус и архитектурные концепции

Единый нормативный словарь `inhuman-harness-public`. Все новые спецификации, схемы БД, пакеты и рефакторинги обязаны использовать перечисленные ниже термины и границы ответственности.

---

## 1. Контуры развертывания (`Deployment Contours`)

Один и тот же реактивный рантайм (`@inhuman.tools/model`, `@inhuman.tools/harness-model`, `@inhuman.tools/turn`, `@inhuman.tools/policy`) работает в двух симметричных контурах без условных веток `if (isServer)` в бизнес-логике:

| Термин | Определение | Реализация хранилища и конфигов |
| --- | --- | --- |
| **`Local Contour`** | Однопользовательская локальная инсталляция (CLI / Desktop Web / TUI) | `kernel_id = 'local'`; SQLite WAL (`harness.db`, `better-sqlite3`); активен `KernelReflector` (двусторонняя синхронизация с `~/.harness/*.json` и `.scm` на диске); `FsBlobBucket`; `FsStateStore` (`plugin-state/*.json`); по умолчанию включен локальный FS/shell `inhuman`-плагин (`plugin-local-env`). |
| **`Server Contour`** | Мульти-тенантная серверная инсталляция (переносимый сервер в этом репо и облачный хост `../kley`) | Множество `kernel_id` в общих Node-процессах; **трехбазовая изоляция** (`Product DB(s)` / `Dedicated Agent DB` / `Dedicated Secrets DB`); `KernelReflector` отсутствует; `.scm` и конфиги живут в БД (`scm_resources`); `DbStateStore` (`plugin_state_logs`); `S3BlobBucket` / CAS; выгрузка неактивных сущностей из RAM по `Symbol.asyncDispose`. |

---

## 2. Топология трех БД в `Server Contour`

- **`Product DB(s)`** — продуктовые базы хост-приложения (например, управляющая БД `../kley` и per-team базы `t_<md5>` для пользовательских таблиц команд). Хранят бизнес-данные продукта, но **не** хранят внутреннее состояние ядра агента. Агент обращается к ним исключительно через инструменты проектных плагинов.
- **`Dedicated Agent DB` (`postgres-agent`)** — выделенная мульти-тенантная база PostgreSQL для всех ядер, проектов и агентных сессий всех пользователей системы (изолирована от `Product DB` и `Secrets DB`, допускает вынос на отдельный хост и включение `wal_level = logical` для ElectricSQL). Все строки партиционируются по `kernel_id` и непрозрачному `project_id`.
- **`Dedicated Secrets DB` (`postgres-secrets`)** — изолированное хранилище учетных данных провайдеров и OAuth-токенов MCP с конвертным шифрованием (`AES-256-GCM`, AAD включает `tenantId` / `kernelId` / `connectionId`) и отдельным контуром ротации KEK.

---

## 3. Базовые сущности и плоскости состояния

- **`Kernel` (`KernelRoot` / `KernelDaemon`)** — верхнеуровневый владелец конфигурации пользователя/тенанта: подключения к провайдерам моделей, глобальный KV, дефолтные политики разрешений и компактности, каталог активных `inhuman`-плагинов и реестр проектов. Идентифицируется явным `kernel_id` (концепт `'singleton'` упраздняется).
- **`Project` (`ProjectRoot` / `ProjectDaemon`)** — **переиспользуемое расширение (оверлей) конфигурации ядра**, а не «локальная папка». Имеет непрозрачный `project_id`, название/метаданные, оверлей настроек ядра (`defaultPermissionMode`, `authorizationJson`, `lastUsedConnectionModel`, `kvs`, `bots`, `commands`, `actions`, `botsRoster`), карту включенных плагинов (`enabledPlugins`) и **`pluginConfigs: Record<pluginName, JsonObject>`** — стартовую конфигурацию для всех `inhuman`-плагинов, которым требуются проектные параметры (для локального CLI — `{ cwd }`, для серверной ВМ — ссылка на песочницу/ВМ, для `../kley` — идентификатор логической базы/таблицы или команды в трекере).
- **`Session` (`SessionRoot` / `SessionDaemon`)** — долговечная беседа или воркер-выполнение в рамках `(kernel_id, project_id, session_id)`.
- **`Turn` (`SessionTurn`) и `Round` (`CompletionJob` -> `ReACTChunk`)** — единица выполнения запроса и граница принятия решения о продолжении цикла агента; обеспечивается incarnation fencing, журналом идемпотентности эффектов (`session_effects`) и чистой функцией политики `decideRound` ([спецификация цикла](../react-round-lifecycle.md)).
- **`DocumentContainer`, `@model`, `@state`, `@column` (`@inhuman.tools/model`)** — чистый реактивный граф на нативных декораторах MobX Stage 3 без Yjs/CRDT. Сериализуется в нормализованные строки узлов (`scope_nodes`, `session_nodes`) и проецируемые реляционные колонки (`@column`). На клиентских репликах контейнер работает в строгом режиме `readOnly` — любые мутации идут только через JSON-RPC к авторитету сервера.
- **`ScopePlane`, `UpdateLaneHub`, `LiveShape`** — двухплоскостной движок синхронизации:
  1. *Плоскость индекса и управления (`Roster & Control Plane`)*: оконные/фильтрованные подписки (`active_sessions`, `recent_sessions`, `child_sessions`, `pending_asks`, `kernel_meta`) через локальный `UpdateLaneHub` или ElectricSQL `/v1/shape`.
  2. *Плоскость траектории сессии (`Session Trajectory Plane`)*: ленивая гидратация активной сессии и инкрементальные патчи/дельты узлов.
- **`KernelReflector`** — адаптер локального диска (`packages/harness/src/server/daemon/kernel/fs-reflection/reflectKernel.ts`), отражающий `KernelRoot` и `.scm` в `~/.harness/*.json`. **Сохраняется в `Local Contour` и полностью отключается в `Server Contour`**, где источником истины выступают таблицы `kernel_state` и `scm_resources`.

---

## 4. Двухуровневая модель расширений и Well-Known политики

### 4.1. `inhuman`-плагины vs пользовательские расширения

- **`inhuman`-Plugin (`Runtime Behavior Plugin`)** — системный/платформенный плагин рантайма, который берет формат `AgentPlugin` (`plugin.json`) лишь как базовую обертку, а реальную семантику задает через `extensions["tools.inhuman"]` (Scheme `abi`, `bots` с `hook/round` и гардами, `states`-редьюсеры, программный API `InhumanPlugin`: инструменты, контекстные заметки, `envCapabilities`) и существенно меняет поведение цикла агента (`tasks`, `goal`, `fusion`, `offload-tingle`, `file-runtime`, плагины окружения `local-env` / `vfs-env` / `sandbox-env`).
  - В `Server Contour` доступны **только общие хостовые `inhuman`-плагины**, установленные на сервере. Пользователи и тенанты могут включать/отключать их и настраивать через `Project.pluginConfigs`, но не могут загружать произвольный плагинный код.
- **`User Extension` (Пользовательское расширение)** — динамические данные без исполнения произвольного host JS: навыки (`SKILL.md`), удаленные HTTP/SSE MCP-серверы (с токенами в `Secrets DB`), slash-команды и декларативные `.prompt`-рецепты. Разрешены в обоих контурах.

### 4.2. `FS + shell` как стандартное расширение (`Well-Known Tool Convention`) и `WorkspaceEnvPort`

- Работа с файловой системой и `shell` (`read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `glob`, `fff_search`, `shell`, `job_stop`) переносится из безусловного `SYSTEM_ENTRIES` ядра в стандартный `inhuman`-плагин окружения (`plugin-local-env` для локальной машины, `plugin-vfs` / `plugin-sandbox-env` для сервера, либо полное отключение).
- При этом имена и контракты этих инструментов закрепляются как **Well-Known Convention** в `@inhuman.tools/policy` и `@inhuman.tools/turn`:
  - таксономия классов риска (`CLASS_IDS`: `workspace-write`, `protected-file`, `envelope-read`, `envelope-write`, `destroy-catastrophic` и др.), `peelShellCwd`, Tirith-анализ и LLM-классификаторы продолжают работать единообразно для любого плагина, реализующего стандартные `FS + shell` вызовы;
  - точки перехвата Scheme-гардов (`point: "shell" | "read" | "write" | "edit"`) и правила удержания/сжатия истории в контексте (`stamp.ts`) остаются универсальными.
- **`WorkspaceEnvPort`** — инвертированный порт плагина окружения для политики и admission (`logicalRoot`, опциональные `resolveCanonicalPath`, `admitWriteSnap`), исключающий прямые вызовы хостового `node:fs` в конвейере политик (`real-path.ts`, `write-admit.ts`).

---

## 5. Протокол жизненного цикла и выгрузки из RAM

- **`Disposable` (`Symbol.dispose`)** — синхронное освобождение локальных ресурсов (`DisposableClass` в `@inhuman.tools/harness-commons`).
- **`AsyncDisposable` (`Symbol.asyncDispose`)** — обязательный контракт архивации и детерминированного вытеснения сущностей сервера (`KernelDaemon`, `ProjectDaemon`, `SessionDaemon`, активные плагинные биндинги `ActivatedProjectPlugin`). Вызов `await entity[Symbol.asyncDispose]()` обязан дождаться парковки активных операций, сброса несохраненного состояния в `Agent DB` и закрытия внешних дескрипторов/песочниц до удаления ссылки из реестра в памяти.

---

## 6. Kill-List: устаревшие и запрещенные понятия

Следующие термины относятся к выведенному или незавершенному состоянию и **не должны** использоваться при проектировании новых модулей (допустимы лишь в явных записях о легаси-миграции):

| Устаревшее понятие | Чем заменено (канон) |
| --- | --- |
| `Yjs` / `Y.Doc` / `y-websocket` / `y-protocols` | `DocumentContainer` + `UpdateLaneHub` / ElectricSQL + `LiveShape` |
| `@here.build/plexus` / `PlexusModel` / `*Plexus` обертки | `Model` и `DocumentContainer<KernelRoot \| ProjectRoot \| SessionRoot>` (примечание: имя пакета `@inhuman.tools/plexus-expectations` сохраняется временно для PEW-движка задач) |
| `kernel_state.id = 'singleton'` | Явный `kernel_id` во всех таблицах хранения и шинах подписок |
| `Project = realpath(workspacePath)` | `Project` с непрозрачным `project_id`, `enabledPlugins` и типизированным `pluginConfigs` |
| Старая 10-табличная схема `packages/scope-plane/src/schema.ts` (`overviews`, `roster`, `generations`) | Каноническая схема `@inhuman.tools/harness-contract/schema` (`kernel_state`, `projects`, `scope_nodes`, `sessions`, `pending_asks`, `session_turns`, `session_nodes`, `session_effects`, `session_blobs`, `scm_resources`, `plugin_state_logs`) |
| `permission_mode = 'ask'` (дрейф дефолта SQLite/Postgres) | Канонический enum `'manual' \| 'auto' \| 'yolo'` с дефолтом `'manual'` |
